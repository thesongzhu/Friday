//! Step-5 — the workflow EXECUTION engine (operator-authorized: orchestrates the
//! already-proven BUILT-IN tools through the existing gate, NOT imported code).
//!
//! `run_workflow` drives a [`crate::planner::WorkflowDefinition`] semi-automatically
//! (`08` §4): it AUTO-ADVANCES the planner-`AutoAdvance` (read-only, gate-safe) steps
//! and PAUSES at the first step the planner marks a checkpoint (mutating / high-risk /
//! template-policy / unclassifiable) — that step is registered but NOT executed; the
//! run goes `AwaitingCheckpoint`. [`resume_workflow`] resumes such a run after the owner
//! approves the paused step (executes it THROUGH THE GATE, then continues).
//!
//! ## Security spine (all reused, single-sourced — no new authorization path)
//! - Every executed step goes through [`crate::gate_dispatch`] — the SAME
//!   classify→authorize→execute-ONLY-on-`Allow` chokepoint `run_loop` uses. The
//!   planner's `AutoAdvance` is a PREVIEW, never a bypass: the gate is the
//!   authorization, so even an auto-advanced step is executed ONLY on a gate `Allow`,
//!   and a gate `RequiresApproval`/`Deny` pauses/fails it (the backstop).
//! - The planner only ADDS pauses: a mutating/destructive step is a checkpoint and is
//!   never dispatched here, so this engine autonomously runs ONLY read-only steps.
//! - A step's `action` is classified by `trusted_classify` (unknown ⇒ fail-closed
//!   checkpoint), so it structurally cannot smuggle a skill/plugin invocation — this
//!   engine runs registered built-in tools only (`FsToolExecutor`), the line the
//!   operator drew (workflow-exec authorized; skill/plugin-exec NOT).
//! - Sensitive reads checkpoint (`#389`/`#494`): the planner screens each step's
//!   resource, so a read of a token/secret/key/.pem resource is a
//!   `CheckpointReason::SensitiveResource` checkpoint — it PAUSES, never auto-advances.
//!   (The narrower remaining `#494` gap is the model-driven `run_loop` dispatch, which
//!   does not run the read-side gate — a separate unit; it does not affect this
//!   definition-driven engine, whose every step is planner-screened first.)
//! - Run-state moves only through `set_run_state`'s SM guard + run-completion gate
//!   (`08` §6 / #471): the run cannot reach `Done` while a side-effect step is
//!   unverified, and an executed step is completed WITH its tool receipt as evidence.
//! - Single-shot: `run_workflow` creates the run; re-invoking with the same `run_id`
//!   fails closed at `create_run` (dup PK) — no double-dispatch. RESUME after approval
//!   is [`resume_workflow`]: it only re-enters an `AwaitingCheckpoint` run, starts at the
//!   paused (`Pending`) step (already-`Verified` steps are never re-executed), and the
//!   GATE still authorizes — a mutating step executes ONLY with a valid approval, else
//!   it re-pauses (no unapproved mutating execution).
//!
//! HONEST SCOPE: this advances `workflow_runtime_run_step_acceptance` toward wired
//! (read-only auto-advance + checkpoint-pause + evidence-gated completion + gated
//! resume). The resume MECHANISM is built, but the LIVE owner-approval leg is not wired
//! (operator/Computer-Use-gated), so a mutating resume re-pauses in v1 unless a real
//! approval is supplied. NL generation + skill/plugin execution stay NO-GO; v1 NO-GO.

use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
use friday_core::{NeedsMeItem, StepStatus, WorkflowRunState};
use friday_storage::{workflow, StorageError};
use rusqlite::Connection;

use crate::planner::{plan_step, StepDisposition, WorkflowDefinition};
use crate::{gate_dispatch, GateDispatch, RawToolCall, ToolExecutor, ToolReceipt};

/// Priority of a workflow-checkpoint Needs-Me item (urgency-first ordering, `08` §1).
const WORKFLOW_CHECKPOINT_PRIORITY: u8 = 7;

/// A5: per-step-effect IDEMPOTENT dispatch — the single wrapper around the shared
/// security chokepoint [`gate_dispatch`] that ALL three workflow drivers
/// ([`advance_from`] auto-advance, [`resume_workflow`] force-dispatch, and
/// [`retry_workflow`] force-dispatch) route their step dispatch through, so the
/// retry frontier (`reopen_failed_step` → re-drive) never re-runs an
/// already-committed side effect.
///
/// It does NOT touch / re-implement the gate (the `gate_dispatch` chokepoint is
/// wrapped, never modified — the classify→authorize→execute-ONLY-on-`Allow`
/// posture, the crypto authorize, and the executor-called-exactly-once invariant
/// are all unchanged). It adds ONE thing on top:
///
/// - **Pre-dispatch SKIP (side-effect steps only):** for a step the persisted
///   `has_side_effect` flag marks a side effect, it computes the STABLE idempotency
///   key (`step_effect_idem_key(run_id, seq, action, params)` — NO attempt, so a
///   retry of the SAME effect matches; WITH the action+params digest, so a changed
///   effect at the same seq MISSES) and consults the m0029 ledger. A `Some` means
///   the SAME effect already committed → the executor is NOT called and the RECORDED
///   receipt is replayed as [`GateDispatch::Executed`]. The gate is also not consulted
///   on the skip (the effect already passed it once when it committed).
/// - **Post-dispatch RECORD (side-effect steps only):** on a real
///   [`GateDispatch::Executed`], it RECORDS the committed effect under the same key
///   BEFORE the caller's `complete_step`, so a subsequent re-drive can skip it. The
///   key PK makes a re-record of the SAME effect a benign no-op.
///
/// A read-only step (`has_side_effect == false`) is NEVER skipped and NEVER recorded
/// — re-running a read on retry is correct (skipping it would serve stale data), and
/// reads are not a double-apply hazard.
///
/// PREDICATE CAVEAT (forward-only; documented, not narrowed here on purpose): the skip
/// predicate is the persisted `has_side_effect` flag, which means "requires evidence
/// to verify" — and the engine sets it `true` not only for mutating steps but also for
/// a SENSITIVE-READ checkpoint and any `force_checkpoint` step. So in the FORWARD model
/// (where the skip could fire) such a read would be REPLAYED from its recorded receipt
/// rather than re-read — staleness, not a double-apply (benign for a read). This is
/// inert in today's engine (a committed read is `Verified` and the frontier skips it,
/// so its ledger row is never consulted), and is refined precisely when the
/// executor-carried key lands (a key-aware tool decides re-run vs dedup per its own
/// idempotency). For the same forward-only reason a SKIPPED step is still counted in
/// `executed_steps` though the executor did not run. The predicate is deliberately NOT
/// narrowed at this slice (narrowing it for zero current benefit is regression risk).
///
/// HONEST SCOPE (DARK defense-in-depth + forward-safety, NOT a live double-run fix):
/// in today's LINEAR, SYNCHRONOUS engine a committed side-effect step is
/// `complete_step`d `Verified`, and the retry frontier SKIPS `Verified` steps
/// (`reopen_failed_step` REFUSES them) — so a committed effect is ALREADY never
/// re-driven, and the SKIP branch here is REDUNDANT with that Verified-skip and is
/// not reached by normal `run_workflow`/`retry_workflow` execution. The always-active,
/// genuinely-new behavior is the RECORD (committed-effect provenance on every
/// committed side-effect). The SKIP guards a FUTURE model where commit and `Verified`
/// can diverge (a DAG frontier with a committed sibling, or an async/crash run). It
/// does NOT make the current engine exactly-once against a partially-applied EXTERNAL
/// tool — that needs the key CARRIED into `executor.execute` so a key-aware tool
/// dedupes, a deferred sub-AC (the executor signature / gate code is untouched here).
#[allow(clippy::too_many_arguments)]
fn dispatch_step_idempotent(
    conn: &Connection,
    executor: &dyn ToolExecutor,
    raw: &RawToolCall,
    run_id: &str,
    seq: usize,
    step_id: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    now_ms: i64,
) -> Result<GateDispatch, StorageError> {
    // The side-effect flag is the persisted truth (single-sourced with the
    // run-completion gate / `complete_step`). A read-only step is never a re-run
    // hazard, so it bypasses the ledger entirely (always dispatched, never recorded).
    let is_side_effect = workflow::step_has_side_effect(conn, step_id)?.unwrap_or(false);
    if !is_side_effect {
        return gate_dispatch(conn, executor, raw, secret, approve, now_ms);
    }

    let idem_key = workflow::step_effect_idem_key(run_id, seq as i64, &raw.action, &raw.params);

    // Pre-dispatch SKIP: the SAME effect already committed under this key → replay the
    // recorded receipt WITHOUT calling the executor (and without re-consulting the
    // gate — the effect already passed it when it committed). A DIFFERENT effect at the
    // same seq computes a different key and misses, so this never replays the wrong one.
    if let Some(committed) = workflow::committed_effect(conn, &idem_key)? {
        return Ok(GateDispatch::Executed(ToolReceipt {
            action: raw.action.clone(),
            summary: committed.receipt_summary,
            content: committed.receipt_content,
        }));
    }

    // Not yet committed → the real gate-mandatory dispatch (unchanged).
    let outcome = gate_dispatch(conn, executor, raw, secret, approve, now_ms)?;
    // Post-dispatch RECORD: on a real commit, record the effect under the stable key
    // BEFORE the caller's `complete_step`, so a later re-drive of the SAME effect skips
    // it. The PK makes a re-record of the same key a benign no-op.
    if let GateDispatch::Executed(receipt) = &outcome {
        workflow::record_committed_effect(
            conn,
            &idem_key,
            run_id,
            step_id,
            seq as i64,
            &raw.action,
            &receipt.summary,
            receipt.content.as_deref(),
            now_ms,
        )?;
    }
    Ok(outcome)
}

/// The Needs-Me items for PAUSED workflows (`08` §2): every `AwaitingCheckpoint` run is
/// surfaced as a cross-source action item the user must act on (approve/resume the
/// paused step). Read-only. The `reason` carries the workflow name + the exact paused
/// step (never silently dropped, `08` §2).
///
/// SCOPE: this is the workflow PRODUCER. A live Needs-Me inbox would compose these with
/// the other sources (Codex/Claude/memory/…) via [`friday_core::aggregate_needs_me`] —
/// but that cross-source aggregation entry point + the Activity inbox surface are a
/// follow-up (the surface is UI-gated; the Codex/Claude sources are login-gated). No
/// production caller composes these yet.
pub fn workflow_needs_me(conn: &Connection) -> Result<Vec<NeedsMeItem>, StorageError> {
    let runs = workflow::runs_in_state(conn, WorkflowRunState::AwaitingCheckpoint)?;
    let mut items = Vec::with_capacity(runs.len());
    for (run_id, name) in runs {
        let at = workflow::first_pending_seq(conn, &run_id)?
            .map(|s| format!(" (step s{s})"))
            .unwrap_or_default();
        items.push(NeedsMeItem {
            source: "workflow".to_string(),
            id: run_id.clone(),
            reason: format!("Checkpoint: workflow '{name}' awaiting your approval{at}"),
            priority: WORKFLOW_CHECKPOINT_PRIORITY,
            destination: format!("workflow/{run_id}"),
        });
    }
    Ok(items)
}

/// How a workflow run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkflowRunStatus {
    /// Every step auto-advanced and the run reached `Done` (completion gate satisfied).
    Completed,
    /// Paused at a step that needs a user checkpoint (the step did NOT execute).
    AwaitingCheckpoint { step_id: String, reason: String },
    /// A dispatched step was gate-denied or errored; the run is `Failed`.
    Failed { step_id: String, reason: String },
}

/// The outcome of a [`run_workflow`] invocation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowOutcome {
    pub status: WorkflowRunStatus,
    /// Steps that actually executed (gate `Allow` + executor `Ok`).
    pub executed_steps: usize,
}

/// Drive a workflow definition from the start: auto-advance gate-safe steps, pause at
/// the first checkpoint. Creates the run (single-shot), then [`advance_from`] step 0.
#[allow(clippy::too_many_arguments)]
pub fn run_workflow(
    def: &WorkflowDefinition,
    executor: &dyn ToolExecutor,
    conn: &Connection,
    run_id: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    now_ms: i64,
) -> Result<WorkflowOutcome, StorageError> {
    // Single-shot: a duplicate run_id fails closed here (no double-dispatch on re-invoke).
    workflow::create_run(conn, run_id, &def.name, now_ms)?;
    workflow::set_run_state(conn, run_id, WorkflowRunState::Running, now_ms)?;
    advance_from(def, 0, executor, conn, run_id, secret, approve, 0, now_ms)
}

/// Resume an `AwaitingCheckpoint` run after the owner approved the paused step
/// (operator-authorized). Validates the run is paused, finds the paused step, sets the
/// run Running, force-dispatches the paused step THROUGH THE GATE, then continues
/// auto-advancing to the next checkpoint / `Done`.
///
/// Resuming is the HUMAN checkpoint, but the GATE is still the authorization: a mutating
/// paused step is executed ONLY if `approve` returns a valid `CanonicalApproval` for it
/// (else it RE-pauses, never executes unapproved); a sensitive-read paused step is
/// gate-`Allow`ed (a read needs no approval — resuming is the human decision to proceed).
/// Already-Verified earlier steps are NEVER re-executed (resume starts at the paused
/// step). Resuming a run that is NOT `AwaitingCheckpoint` is a fail-closed error.
///
/// HONEST SCOPE: this is the resume MECHANISM. In v1 `approve` is deny-all (no live
/// owner-approval leg is wired — that leg is operator/Computer-Use-gated), so a mutating
/// resume re-pauses unless a real approval is supplied; tests use a minted approval.
#[allow(clippy::too_many_arguments)]
pub fn resume_workflow(
    def: &WorkflowDefinition,
    executor: &dyn ToolExecutor,
    conn: &Connection,
    run_id: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    now_ms: i64,
) -> Result<WorkflowOutcome, StorageError> {
    let state = workflow::run_state(conn, run_id)?
        .ok_or_else(|| StorageError::Unsupported(format!("workflow_run '{run_id}' not found")))?;
    if state != WorkflowRunState::AwaitingCheckpoint {
        return Err(StorageError::Unsupported(format!(
            "cannot resume workflow_run '{run_id}': state is {} (only an AwaitingCheckpoint run is resumable)",
            state.as_str()
        )));
    }
    let paused_seq = find_paused_seq(conn, run_id, def.steps.len())?;
    let step = &def.steps[paused_seq];
    let step_id = format!("{run_id}:s{paused_seq}");
    // Back to Running (a valid SM transition from AwaitingCheckpoint).
    workflow::set_run_state(conn, run_id, WorkflowRunState::Running, now_ms)?;
    // Force-dispatch the paused step through the gate. The owner approved by resuming,
    // but the GATE is the authorization — a mutating step needs `approve` to grant a
    // valid approval; otherwise it RE-pauses (never executes unapproved).
    let raw = RawToolCall {
        action: step.action.clone(),
        params: step.params.clone(),
    };
    match dispatch_step_idempotent(
        conn, executor, &raw, run_id, paused_seq, &step_id, secret, approve, now_ms,
    )? {
        GateDispatch::Executed(receipt) => {
            workflow::complete_step(conn, &step_id, Some(&receipt.summary), true, now_ms)?;
        }
        GateDispatch::RequiresApproval => {
            // No valid approval on resume → re-pause; the step does NOT execute.
            workflow::set_run_state(conn, run_id, WorkflowRunState::AwaitingCheckpoint, now_ms)?;
            return Ok(WorkflowOutcome {
                status: WorkflowRunStatus::AwaitingCheckpoint {
                    step_id,
                    reason: "gate_requires_approval (resume without a valid approval)".to_string(),
                },
                executed_steps: 0,
            });
        }
        GateDispatch::Denied(reason) => {
            workflow::set_run_state(conn, run_id, WorkflowRunState::Failed, now_ms)?;
            return Ok(WorkflowOutcome {
                status: WorkflowRunStatus::Failed {
                    step_id,
                    reason: format!("denied:{reason}"),
                },
                executed_steps: 0,
            });
        }
        GateDispatch::ExecError(e) => {
            workflow::complete_step(conn, &step_id, None, false, now_ms)?;
            workflow::set_run_state(conn, run_id, WorkflowRunState::Failed, now_ms)?;
            return Ok(WorkflowOutcome {
                status: WorkflowRunStatus::Failed {
                    step_id,
                    reason: format!("exec_error:{e}"),
                },
                executed_steps: 0,
            });
        }
        GateDispatch::Unregistered(action) => {
            workflow::set_run_state(conn, run_id, WorkflowRunState::Failed, now_ms)?;
            return Ok(WorkflowOutcome {
                status: WorkflowRunStatus::Failed {
                    step_id,
                    reason: format!("unregistered:{action}"),
                },
                executed_steps: 0,
            });
        }
    }
    // Paused step executed → continue auto-advancing the rest (count seeded at 1).
    advance_from(
        def,
        paused_seq + 1,
        executor,
        conn,
        run_id,
        secret,
        approve,
        1,
        now_ms,
    )
}

/// The SHARED per-step advance loop (used by [`run_workflow`] from 0 and
/// [`resume_workflow`] from the step after the resumed one): for each step in
/// `[start_seq, len)` plan→auto-advance-through-the-gate or pause at the first
/// checkpoint; fail on a denied/errored dispatch; reach `Done` when all are verified.
/// `executed` seeds the running count.
#[allow(clippy::too_many_arguments)]
fn advance_from(
    def: &WorkflowDefinition,
    start_seq: usize,
    executor: &dyn ToolExecutor,
    conn: &Connection,
    run_id: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    mut executed: usize,
    now_ms: i64,
) -> Result<WorkflowOutcome, StorageError> {
    for seq in start_seq..def.steps.len() {
        let step = &def.steps[seq];
        let step_id = format!("{run_id}:s{seq}");
        match plan_step(step) {
            // Checkpoint: register the step (a side-effect step needing evidence) but do
            // NOT execute it; pause the run. The executor is never called for it.
            StepDisposition::Checkpoint(reason) => {
                workflow::add_step(conn, &step_id, run_id, seq as i64, true, now_ms)?;
                workflow::set_run_state(
                    conn,
                    run_id,
                    WorkflowRunState::AwaitingCheckpoint,
                    now_ms,
                )?;
                return Ok(WorkflowOutcome {
                    status: WorkflowRunStatus::AwaitingCheckpoint {
                        step_id,
                        reason: reason.as_str().to_string(),
                    },
                    executed_steps: executed,
                });
            }
            // Auto-advance: register, then dispatch through the gate (the authorization).
            StepDisposition::AutoAdvance => {
                workflow::add_step(
                    conn,
                    &step_id,
                    run_id,
                    seq as i64,
                    step.evidence_required,
                    now_ms,
                )?;
                let raw = RawToolCall {
                    action: step.action.clone(),
                    params: step.params.clone(),
                };
                match dispatch_step_idempotent(
                    conn, executor, &raw, run_id, seq, &step_id, secret, approve, now_ms,
                )? {
                    GateDispatch::Executed(receipt) => {
                        // Complete WITH the tool receipt as evidence (`08` §6).
                        workflow::complete_step(
                            conn,
                            &step_id,
                            Some(&receipt.summary),
                            true,
                            now_ms,
                        )?;
                        executed += 1;
                    }
                    GateDispatch::ExecError(e) => {
                        workflow::complete_step(conn, &step_id, None, false, now_ms)?;
                        workflow::set_run_state(conn, run_id, WorkflowRunState::Failed, now_ms)?;
                        return Ok(WorkflowOutcome {
                            status: WorkflowRunStatus::Failed {
                                step_id,
                                reason: format!("exec_error:{e}"),
                            },
                            executed_steps: executed,
                        });
                    }
                    // The gate BACKSTOP: an auto-advanced step the gate escalates is paused,
                    // never executed (the planner preview is not the authorization).
                    GateDispatch::RequiresApproval => {
                        workflow::set_run_state(
                            conn,
                            run_id,
                            WorkflowRunState::AwaitingCheckpoint,
                            now_ms,
                        )?;
                        return Ok(WorkflowOutcome {
                            status: WorkflowRunStatus::AwaitingCheckpoint {
                                step_id,
                                reason: "gate_requires_approval".to_string(),
                            },
                            executed_steps: executed,
                        });
                    }
                    GateDispatch::Denied(reason) => {
                        workflow::set_run_state(conn, run_id, WorkflowRunState::Failed, now_ms)?;
                        return Ok(WorkflowOutcome {
                            status: WorkflowRunStatus::Failed {
                                step_id,
                                reason: format!("denied:{reason}"),
                            },
                            executed_steps: executed,
                        });
                    }
                    GateDispatch::Unregistered(action) => {
                        // Unreachable in practice (plan_step fails-closed unknown → Checkpoint
                        // before we get here), but fail-closed here too.
                        workflow::set_run_state(conn, run_id, WorkflowRunState::Failed, now_ms)?;
                        return Ok(WorkflowOutcome {
                            status: WorkflowRunStatus::Failed {
                                step_id,
                                reason: format!("unregistered:{action}"),
                            },
                            executed_steps: executed,
                        });
                    }
                }
            }
        }
    }

    // All steps verified. `set_run_state(Done)` enforces the completion gate (refuses
    // Done if any side-effect step is unverified).
    workflow::set_run_state(conn, run_id, WorkflowRunState::Done, now_ms)?;
    Ok(WorkflowOutcome {
        status: WorkflowRunStatus::Completed,
        executed_steps: executed,
    })
}

/// Find the paused step's seq for an `AwaitingCheckpoint` run: the first `Pending` step
/// (earlier steps are `Verified`; the checkpoint was `add_step`ed `Pending` and not
/// executed). Fail-closed if none is found.
fn find_paused_seq(conn: &Connection, run_id: &str, n_steps: usize) -> Result<usize, StorageError> {
    for seq in 0..n_steps {
        let step_id = format!("{run_id}:s{seq}");
        match workflow::step_status(conn, &step_id)? {
            Some(StepStatus::Pending) => return Ok(seq),
            Some(_) => continue, // Verified/etc. → already settled, skip
            None => break,       // no more added steps
        }
    }
    Err(StorageError::Unsupported(format!(
        "no paused (Pending) step found for run '{run_id}'"
    )))
}

/// Find the RETRY frontier step's seq for a `Failed` run: the first NON-`Verified`
/// registered step. This generalizes [`find_paused_seq`] (which is `Pending`-only)
/// to the real engine-produced failure states — because the engine never persists a
/// `Failed` *step* status: an exec-error on a side-effect step leaves it
/// `ProofPending`, an exec-error on a pure step leaves it `Running`, and a denied/
/// unregistered checkpoint leaves it `Pending`. Earlier steps are `Verified` (the
/// engine fails fast at the first non-passing step), so the first non-`Verified`
/// registered step IS the failure point. Fail-closed if every registered step is
/// `Verified` or none was registered (mirrors TS `WORKFLOW_NO_FAILED_NODES_TO_RETRY`).
fn find_retry_frontier_seq(
    conn: &Connection,
    run_id: &str,
    n_steps: usize,
) -> Result<usize, StorageError> {
    for seq in 0..n_steps {
        let step_id = format!("{run_id}:s{seq}");
        match workflow::step_status(conn, &step_id)? {
            Some(StepStatus::Verified) => continue, // already done — never re-driven
            Some(_) => return Ok(seq),              // first non-Verified = the frontier
            None => break,                          // no more registered steps
        }
    }
    Err(StorageError::Unsupported(format!(
        "no retryable (non-verified) step found for failed run '{run_id}' (nothing to retry)"
    )))
}

/// RETRY a `Failed` workflow run by re-driving its frontier step (operator-authorized).
/// This is the RETRY counterpart to [`resume_workflow`], mirroring its STRUCTURE
/// (manual re-dispatch of the frontier step THROUGH THE GATE, then [`advance_from`]
/// continues the rest) so it REUSES the engine's execution path and never
/// re-implements it. The only differences from resume: it prechecks the run is
/// `Failed` (not `AwaitingCheckpoint`), it reopens the frontier step
/// ([`workflow::reopen_failed_step`]: -> `Pending`, `attempt += 1`) so
/// `complete_step` accepts it again, and it transitions `Failed -> Running` (the R2
/// slice-2 core retry edge).
///
/// It must NOT call `advance_from(frontier, ..)` (that re-`add_step`s the frontier →
/// `step_id` PK collision); like resume it manually re-dispatches the existing
/// frontier step then `advance_from(frontier + 1, ..)`. Already-`Verified` earlier
/// steps are NEVER re-executed.
///
/// A5 IDEMPOTENCY: the frontier re-dispatch routes through
/// [`dispatch_step_idempotent`] (the same wrapper as run/resume), so a side-effect
/// step's COMMITTED effect is recorded under a stable per-effect key (m0029) and a
/// re-drive of the SAME effect is skipped (the executor is not re-called). HONEST
/// SCOPE: in this linear synchronous engine a committed side-effect step is
/// `Verified` and the frontier already SKIPS `Verified` steps, so the skip is
/// REDUNDANT defense-in-depth (forward-safe for a DAG/async model); the always-active
/// behavior is the committed-effect RECORD. It does NOT make a partially-applied
/// EXTERNAL tool exactly-once — that needs the key CARRIED into the executor (a
/// deferred sub-AC). See [`dispatch_step_idempotent`] and the PR body.
#[allow(clippy::too_many_arguments)]
pub fn retry_workflow(
    def: &WorkflowDefinition,
    executor: &dyn ToolExecutor,
    conn: &Connection,
    run_id: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    now_ms: i64,
) -> Result<WorkflowOutcome, StorageError> {
    let state = workflow::run_state(conn, run_id)?
        .ok_or_else(|| StorageError::Unsupported(format!("workflow_run '{run_id}' not found")))?;
    if state != WorkflowRunState::Failed {
        return Err(StorageError::Unsupported(format!(
            "cannot retry workflow_run '{run_id}': state is {} (only a Failed run is retryable)",
            state.as_str()
        )));
    }
    let frontier_seq = find_retry_frontier_seq(conn, run_id, def.steps.len())?;
    let step = &def.steps[frontier_seq];
    let step_id = format!("{run_id}:s{frontier_seq}");
    // Reopen the frontier step (-> Pending, attempt += 1) BEFORE the run transition, so
    // a failure to reopen (e.g. it is unexpectedly Verified) aborts without mutating run
    // state.
    workflow::reopen_failed_step(conn, &step_id, now_ms)?;
    // Failed -> Running (the R2 slice-2 core retry edge).
    workflow::set_run_state(conn, run_id, WorkflowRunState::Running, now_ms)?;
    // Re-dispatch the frontier step through the gate — the SAME authorization path as
    // resume/run. A mutating step needs a valid `approve`; otherwise it re-pauses (it
    // does NOT execute unapproved). Failure arms mirror `resume_workflow` exactly.
    let raw = RawToolCall {
        action: step.action.clone(),
        params: step.params.clone(),
    };
    match dispatch_step_idempotent(
        conn,
        executor,
        &raw,
        run_id,
        frontier_seq,
        &step_id,
        secret,
        approve,
        now_ms,
    )? {
        GateDispatch::Executed(receipt) => {
            workflow::complete_step(conn, &step_id, Some(&receipt.summary), true, now_ms)?;
        }
        GateDispatch::RequiresApproval => {
            // The frontier is a mutating step with no valid approval → pause (do not
            // execute unapproved). The retried run is now AwaitingCheckpoint, resumable.
            workflow::set_run_state(conn, run_id, WorkflowRunState::AwaitingCheckpoint, now_ms)?;
            return Ok(WorkflowOutcome {
                status: WorkflowRunStatus::AwaitingCheckpoint {
                    step_id,
                    reason: "gate_requires_approval (retry of a mutating step without an approval)"
                        .to_string(),
                },
                executed_steps: 0,
            });
        }
        GateDispatch::Denied(reason) => {
            workflow::set_run_state(conn, run_id, WorkflowRunState::Failed, now_ms)?;
            return Ok(WorkflowOutcome {
                status: WorkflowRunStatus::Failed {
                    step_id,
                    reason: format!("denied:{reason}"),
                },
                executed_steps: 0,
            });
        }
        GateDispatch::ExecError(e) => {
            workflow::complete_step(conn, &step_id, None, false, now_ms)?;
            workflow::set_run_state(conn, run_id, WorkflowRunState::Failed, now_ms)?;
            return Ok(WorkflowOutcome {
                status: WorkflowRunStatus::Failed {
                    step_id,
                    reason: format!("exec_error:{e}"),
                },
                executed_steps: 0,
            });
        }
        GateDispatch::Unregistered(action) => {
            workflow::set_run_state(conn, run_id, WorkflowRunState::Failed, now_ms)?;
            return Ok(WorkflowOutcome {
                status: WorkflowRunStatus::Failed {
                    step_id,
                    reason: format!("unregistered:{action}"),
                },
                executed_steps: 0,
            });
        }
    }
    // Frontier re-executed → continue auto-advancing the rest (count seeded at 1).
    advance_from(
        def,
        frontier_seq + 1,
        executor,
        conn,
        run_id,
        secret,
        approve,
        1,
        now_ms,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ExecError, ToolReceipt};
    use friday_storage::Db;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-wfexec-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    const SECRET: &[u8] = b"wf-exec-secret-0123456789abcdef";

    /// Executor that records its call count and returns a receipt — so a test can prove
    /// a checkpoint step was NEVER executed (call-count witness).
    struct CountingExec {
        calls: Cell<usize>,
    }
    impl ToolExecutor for CountingExec {
        fn execute(
            &self,
            action: &str,
            _params: &[(String, String)],
        ) -> Result<ToolReceipt, ExecError> {
            self.calls.set(self.calls.get() + 1);
            Ok(ToolReceipt {
                action: action.to_string(),
                summary: format!("ran {action}"),
                content: None,
            })
        }
    }

    fn deny_all(_r: &MutatingActionRequest) -> Option<CanonicalApproval> {
        None
    }

    fn step(
        id: &str,
        action: &str,
        params: &[(&str, &str)],
        force: bool,
        evidence: bool,
    ) -> crate::planner::WorkflowStep {
        crate::planner::WorkflowStep {
            id: id.to_string(),
            action: action.to_string(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            force_checkpoint: force,
            evidence_required: evidence,
        }
    }

    fn run_state(db: &Db, run_id: &str) -> String {
        workflow::run_state(db.conn(), run_id)
            .unwrap()
            .unwrap()
            .as_str()
            .to_string()
    }

    #[test]
    fn all_read_only_steps_auto_advance_to_completed() {
        let db = Db::open_hub(&tmp("ro")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = WorkflowDefinition {
            name: "research".into(),
            steps: vec![
                step("a", "read_file", &[("path", "x")], false, false),
                step("b", "search", &[("query", "TODO")], false, false),
            ],
        };
        let out = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 100).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        assert_eq!(out.executed_steps, 2);
        assert_eq!(exec.calls.get(), 2, "both read-only steps executed");
        assert_eq!(run_state(&db, "r1"), "done");
    }

    #[test]
    fn mutating_step_pauses_and_executor_is_never_called_for_it() {
        // THE safety witness: a checkpoint step is registered but NOT executed.
        let db = Db::open_hub(&tmp("pause")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = WorkflowDefinition {
            name: "ship".into(),
            steps: vec![
                step("read", "read_file", &[("path", "x")], false, false),
                step(
                    "write",
                    "write_file",
                    &[("path", "o"), ("content", "y")],
                    false,
                    true,
                ),
                step("never", "read_file", &[("path", "z")], false, false),
            ],
        };
        let out = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 100).unwrap();
        match out.status {
            WorkflowRunStatus::AwaitingCheckpoint { step_id, reason } => {
                assert_eq!(step_id, "r1:s1");
                assert!(reason.contains("mutating"));
            }
            other => panic!("expected AwaitingCheckpoint, got {other:?}"),
        }
        // Only the FIRST read-only step ran; the mutating step (and the step after it)
        // were NOT executed.
        assert_eq!(out.executed_steps, 1);
        assert_eq!(
            exec.calls.get(),
            1,
            "executor must NOT run the mutating checkpoint step"
        );
        assert_eq!(run_state(&db, "r1"), "awaiting_checkpoint");
    }

    #[test]
    fn sensitive_resource_read_pauses_and_is_not_executed() {
        // A read of a sensitive resource checkpoints (the planner SensitiveResource floor):
        // the workflow pauses and the executor is NEVER called for it.
        let db = Db::open_hub(&tmp("sensread")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = WorkflowDefinition {
            name: "audit".into(),
            steps: vec![step(
                "read_secret",
                "read_file",
                &[("path", "id_rsa")],
                false,
                false,
            )],
        };
        let out = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 100).unwrap();
        match out.status {
            WorkflowRunStatus::AwaitingCheckpoint { reason, .. } => {
                assert!(reason.contains("sensitive resource"), "reason: {reason}");
            }
            other => panic!("expected AwaitingCheckpoint, got {other:?}"),
        }
        assert_eq!(
            exec.calls.get(),
            0,
            "a sensitive read must NOT auto-execute"
        );
        assert_eq!(run_state(&db, "r1"), "awaiting_checkpoint");
    }

    #[test]
    fn unknown_action_step_fails_closed_to_checkpoint_not_executed() {
        let db = Db::open_hub(&tmp("unknown")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = WorkflowDefinition {
            name: "x".into(),
            steps: vec![step("u", "frobnicate", &[], false, false)],
        };
        let out = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 100).unwrap();
        assert!(matches!(
            out.status,
            WorkflowRunStatus::AwaitingCheckpoint { .. }
        ));
        assert_eq!(exec.calls.get(), 0, "an unknown action is never executed");
    }

    #[test]
    fn evidence_required_step_completes_with_receipt_and_run_reaches_done() {
        // An evidence_required (side-effect) read-only step executes; its tool receipt
        // is attached as evidence → Verified → the run-completion gate lets it reach Done.
        let db = Db::open_hub(&tmp("evidence")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = WorkflowDefinition {
            name: "qa".into(),
            steps: vec![step("e", "read_file", &[("path", "log")], false, true)],
        };
        let out = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 100).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        assert_eq!(run_state(&db, "r1"), "done");
        // the step is Verified (evidence attached).
        let status = workflow::step_status(db.conn(), "r1:s0").unwrap().unwrap();
        assert_eq!(status.as_str(), "verified");
    }

    #[test]
    fn re_invoking_the_same_run_id_fails_closed_single_shot() {
        let db = Db::open_hub(&tmp("single")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = WorkflowDefinition {
            name: "x".into(),
            steps: vec![step("a", "read_file", &[("path", "x")], false, false)],
        };
        run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 100).unwrap();
        // re-invoking the SAME run_id is a fail-closed dup (no double-dispatch).
        assert!(run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 200).is_err());
    }

    // --- resume-after-approval (operator-authorized) -------------------------

    /// A minting approval policy: grants a valid, digest-bound approval for the request
    /// (stands in for the operator-gated owner-approval leg in tests).
    fn mint_all(r: &MutatingActionRequest) -> Option<CanonicalApproval> {
        Some(crate::mint_approval(r, "owner", SECRET, 10_000_000))
    }

    fn read_then_write_def() -> WorkflowDefinition {
        WorkflowDefinition {
            name: "ship".into(),
            steps: vec![
                step("read", "read_file", &[("path", "x")], false, false),
                step(
                    "write",
                    "write_file",
                    &[("path", "o"), ("content", "y")],
                    false,
                    true,
                ),
            ],
        }
    }

    #[test]
    fn resume_executes_approved_mutating_step_and_completes_without_re_running_earlier() {
        let db = Db::open_hub(&tmp("resume-ok")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = read_then_write_def();
        // Pause at the mutating write step (deny-all): read ran, write did not.
        let paused = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 100).unwrap();
        assert!(matches!(
            paused.status,
            WorkflowRunStatus::AwaitingCheckpoint { .. }
        ));
        assert_eq!(exec.calls.get(), 1);
        // Resume WITH a valid approval → the write executes (gate Allow via approval) → Done.
        let out = resume_workflow(&def, &exec, db.conn(), "r1", SECRET, &mint_all, 200).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        assert_eq!(run_state(&db, "r1"), "done");
        // The read step was NOT re-executed — only the write ran on resume (1 → 2 total).
        assert_eq!(exec.calls.get(), 2, "earlier verified step must not re-run");
        // both steps verified.
        assert_eq!(
            workflow::step_status(db.conn(), "r1:s1")
                .unwrap()
                .unwrap()
                .as_str(),
            "verified"
        );
    }

    #[test]
    fn resume_without_a_valid_approval_re_pauses_and_does_not_execute() {
        let db = Db::open_hub(&tmp("resume-deny")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = read_then_write_def();
        run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 100).unwrap();
        assert_eq!(exec.calls.get(), 1);
        // Resume with NO approval (deny-all) → the mutating step RE-pauses, never executes.
        let out = resume_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 200).unwrap();
        assert!(matches!(
            out.status,
            WorkflowRunStatus::AwaitingCheckpoint { .. }
        ));
        assert_eq!(
            exec.calls.get(),
            1,
            "unapproved mutating step must NOT execute on resume"
        );
        assert_eq!(run_state(&db, "r1"), "awaiting_checkpoint");
    }

    #[test]
    fn resume_a_non_awaiting_checkpoint_run_is_fail_closed() {
        let db = Db::open_hub(&tmp("resume-nonpaused")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        // an all-read-only run completes immediately (Done, not paused).
        let def = WorkflowDefinition {
            name: "research".into(),
            steps: vec![step("a", "read_file", &[("path", "x")], false, false)],
        };
        let out = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 100).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        // resuming a Done run is fail-closed.
        assert!(resume_workflow(&def, &exec, db.conn(), "r1", SECRET, &mint_all, 200).is_err());
        // resuming a non-existent run is fail-closed too.
        assert!(resume_workflow(&def, &exec, db.conn(), "ghost", SECRET, &mint_all, 200).is_err());
    }

    #[test]
    fn resume_of_a_sensitive_read_executes_on_resume_alone_no_crypto_approval() {
        // Locks the documented authorization asymmetry: a sensitive READ checkpoints at
        // the planner, but on RESUME it is gate-Allowed (a read needs no approval) — the
        // resume_workflow call IS the human authorization. Even with deny-all (no minted
        // approval), the resumed read executes. (A mutating step would still need a crypto
        // approval — proven by resume_without_a_valid_approval_re_pauses.)
        let db = Db::open_hub(&tmp("resume-sensread")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = WorkflowDefinition {
            name: "audit".into(),
            steps: vec![step(
                "read_secret",
                "read_file",
                &[("path", "id_rsa")],
                false,
                false,
            )],
        };
        // Pause at the sensitive read; the executor is NOT called.
        let paused = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 100).unwrap();
        assert!(matches!(
            paused.status,
            WorkflowRunStatus::AwaitingCheckpoint { .. }
        ));
        assert_eq!(exec.calls.get(), 0);
        // Resume with NO crypto approval (deny-all) → the read executes (resume is the
        // authorization for a read) → run reaches Done.
        let out = resume_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 200).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        assert_eq!(
            exec.calls.get(),
            1,
            "the sensitive read executes on resume alone"
        );
        assert_eq!(run_state(&db, "r1"), "done");
    }

    #[test]
    fn resume_advances_to_the_next_checkpoint() {
        let db = Db::open_hub(&tmp("resume-next")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = WorkflowDefinition {
            name: "multi".into(),
            steps: vec![
                step("r1", "read_file", &[("path", "a")], false, false),
                step(
                    "w1",
                    "write_file",
                    &[("path", "o1"), ("content", "y")],
                    false,
                    true,
                ),
                step("r2", "read_file", &[("path", "b")], false, false),
                step(
                    "w2",
                    "write_file",
                    &[("path", "o2"), ("content", "z")],
                    false,
                    true,
                ),
            ],
        };
        // pause at w1 (s1) after r1.
        run_workflow(&def, &exec, db.conn(), "run", SECRET, &deny_all, 100).unwrap();
        assert_eq!(exec.calls.get(), 1);
        // resume w1 → executes w1, auto-advances r2, pauses at w2 (s3).
        let out = resume_workflow(&def, &exec, db.conn(), "run", SECRET, &mint_all, 200).unwrap();
        match out.status {
            WorkflowRunStatus::AwaitingCheckpoint { step_id, .. } => assert_eq!(step_id, "run:s3"),
            other => panic!("expected AwaitingCheckpoint at w2, got {other:?}"),
        }
        // r1 + w1 + r2 ran (3); w2 did not.
        assert_eq!(exec.calls.get(), 3);
        // resume again → w2 executes → Done.
        let out2 = resume_workflow(&def, &exec, db.conn(), "run", SECRET, &mint_all, 300).unwrap();
        assert_eq!(out2.status, WorkflowRunStatus::Completed);
        assert_eq!(exec.calls.get(), 4);
        assert_eq!(run_state(&db, "run"), "done");
    }

    // --- workflow → Needs-Me (08 §2) -----------------------------------------

    #[test]
    fn paused_workflows_surface_as_needs_me_items_completed_ones_do_not() {
        let db = Db::open_hub(&tmp("needsme")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        // A run that PAUSES at a mutating checkpoint.
        run_workflow(
            &db_def_paused(),
            &exec,
            db.conn(),
            "paused1",
            SECRET,
            &deny_all,
            100,
        )
        .unwrap();
        // A run that COMPLETES (all read-only).
        let done_def = WorkflowDefinition {
            name: "research".into(),
            steps: vec![step("r", "read_file", &[("path", "x")], false, false)],
        };
        run_workflow(&done_def, &exec, db.conn(), "done1", SECRET, &deny_all, 200).unwrap();

        let items = workflow_needs_me(db.conn()).unwrap();
        // Only the paused run is a Needs-Me item; the completed run is not.
        assert_eq!(items.len(), 1, "only the AwaitingCheckpoint run surfaces");
        let it = &items[0];
        assert_eq!(it.source, "workflow");
        assert_eq!(it.id, "paused1");
        assert_eq!(it.destination, "workflow/paused1");
        assert_eq!(it.priority, WORKFLOW_CHECKPOINT_PRIORITY);
        // reason carries the workflow name + the exact paused step (never dropped).
        assert!(
            it.reason.contains("ship") && it.reason.contains("s1"),
            "reason: {}",
            it.reason
        );

        // It composes with the cross-source inbox via aggregate_needs_me.
        let mut all = items;
        all.push(NeedsMeItem {
            source: "claude".into(),
            id: "c1".into(),
            reason: "urgent question".into(),
            priority: 9,
            destination: "session/claude-1".into(),
        });
        let ranked = friday_core::aggregate_needs_me(all);
        // urgency-first: the p9 claude item ranks above the p7 workflow checkpoint.
        assert_eq!(ranked[0].source, "claude");
        assert_eq!(ranked[1].source, "workflow");
    }

    #[test]
    fn workflow_needs_me_is_empty_when_no_run_is_paused() {
        let db = Db::open_hub(&tmp("needsme-empty")).unwrap();
        assert!(workflow_needs_me(db.conn()).unwrap().is_empty());
        // a completed run leaves the inbox empty.
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = WorkflowDefinition {
            name: "research".into(),
            steps: vec![step("r", "read_file", &[("path", "x")], false, false)],
        };
        run_workflow(&def, &exec, db.conn(), "done1", SECRET, &deny_all, 100).unwrap();
        assert!(workflow_needs_me(db.conn()).unwrap().is_empty());
    }

    // a definition that pauses at a mutating step `s1` (named "ship").
    fn db_def_paused() -> WorkflowDefinition {
        WorkflowDefinition {
            name: "ship".into(),
            steps: vec![
                step("read", "read_file", &[("path", "x")], false, false),
                step(
                    "write",
                    "write_file",
                    &[("path", "o"), ("content", "y")],
                    false,
                    true,
                ),
            ],
        }
    }

    // --- A5: per-step-effect idempotency (m0029) -----------------------------

    /// Executor that ERRS on its first call and SUCCEEDS thereafter (a transient
    /// failure) — distinct from `CountingExec` so an A5 test can drive a real
    /// engine-produced Failed run with a NON-Verified side-effect frontier.
    struct TransientExec {
        calls: Cell<usize>,
    }
    impl ToolExecutor for TransientExec {
        fn execute(
            &self,
            action: &str,
            _params: &[(String, String)],
        ) -> Result<ToolReceipt, ExecError> {
            let n = self.calls.get() + 1;
            self.calls.set(n);
            if n == 1 {
                Err(ExecError::Unsupported("transient boom".to_string()))
            } else {
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!("ran {action} (attempt {n})"),
                    content: None,
                })
            }
        }
    }

    /// A single SIDE-EFFECT (evidence_required) but gate-safe (`read_file`,
    /// auto-advances) step. Its `has_side_effect` flag is true, so it is ledger-tracked,
    /// yet it executes WITHOUT a checkpoint pause (the gate Allows a read), which is the
    /// only synchronous shape in the linear engine where a side-effect step runs the
    /// executor and is recorded.
    fn single_side_effect_def() -> WorkflowDefinition {
        WorkflowDefinition {
            name: "probe".into(),
            steps: vec![step("e", "read_file", &[("path", "log")], false, true)],
        }
    }

    #[test]
    fn a_committed_side_effect_records_its_effect_in_the_idempotency_ledger() {
        // THE always-active, genuinely-new A5 behavior: when a side-effect step
        // commits (executor Ok), the engine RECORDS the committed effect under its
        // stable per-effect key (m0029). This is observable provenance regardless of
        // whether the skip ever fires. A read-only step is NOT recorded (not a hazard).
        let db = Db::open_hub(&tmp("a5-record")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let def = WorkflowDefinition {
            name: "mix".into(),
            steps: vec![
                step("read", "read_file", &[("path", "x")], false, false), // read-only s0
                step("ev", "read_file", &[("path", "log")], false, true),  // side-effect s1
            ],
        };
        let out = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &deny_all, 100).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);

        // The side-effect step (s1) recorded a committed effect under its stable key.
        let key = workflow::step_effect_idem_key(
            "r1",
            1,
            "read_file",
            &[("path".to_string(), "log".to_string())],
        );
        let committed = workflow::committed_effect(db.conn(), &key).unwrap();
        assert!(
            committed.is_some(),
            "the committed side-effect step recorded its effect"
        );
        let committed = committed.unwrap();
        assert_eq!(committed.step_id, "r1:s1");
        assert_eq!(committed.action, "read_file");

        // The READ-ONLY step (s0) recorded NOTHING (not a re-run hazard).
        let read_key = workflow::step_effect_idem_key(
            "r1",
            0,
            "read_file",
            &[("path".to_string(), "x".to_string())],
        );
        assert!(
            workflow::committed_effect(db.conn(), &read_key)
                .unwrap()
                .is_none(),
            "a read-only step is never ledger-recorded"
        );
    }

    #[test]
    fn idempotency_key_skips_a_non_verified_committed_side_effect_on_retry() {
        // THE load-bearing GUARD-LOGIC test, isolating the idempotency KEY from
        // Verified-skip. We construct a state the current linear engine does NOT
        // produce on its own — a side-effect step left NON-Verified (ProofPending)
        // that ALSO has a committed-effect ledger row — to prove the skip branch is
        // the SOLE cause of the executor NOT being called.
        //
        // HONEST: this is a guard-logic test against an INJECTED ledger row, NOT a
        // regression test of a prevented live double-run. In today's engine a committed
        // side-effect step is Verified and the retry frontier skips Verified, so this
        // exact (non-Verified + committed) combination is unreachable through normal
        // run/retry; the skip is forward-safe defense-in-depth (see
        // `dispatch_step_idempotent`). Verified-skip cannot cause this assertion: the
        // step here is ProofPending, NOT Verified, so the frontier DOES reopen + re-drive
        // it — only the ledger entry stops the executor.
        let db = Db::open_hub(&tmp("a5-skip")).unwrap();
        let exec = TransientExec {
            calls: Cell::new(0),
        };
        let def = single_side_effect_def();

        // First drive: gate Allows the read, executor ERRS → step ProofPending, run Failed.
        let started = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &mint_all, 100).unwrap();
        assert!(matches!(started.status, WorkflowRunStatus::Failed { .. }));
        assert_eq!(exec.calls.get(), 1);
        assert_eq!(
            workflow::step_status(db.conn(), "r1:s0").unwrap(),
            Some(StepStatus::ProofPending),
            "a side-effect exec-error leaves the step ProofPending (non-Verified frontier)"
        );
        // NB: no committed effect was recorded (the executor ERRED, never committed).
        let key = workflow::step_effect_idem_key(
            "r1",
            0,
            "read_file",
            &[("path".to_string(), "log".to_string())],
        );
        assert!(workflow::committed_effect(db.conn(), &key)
            .unwrap()
            .is_none());

        // INJECT a committed-effect ledger row for this exact effect (the synthetic
        // state). On retry, the frontier reopens (ProofPending → Pending) and is
        // re-driven through `dispatch_step_idempotent`, which now finds the recorded
        // effect → SKIPS the executor and replays the recorded receipt.
        workflow::record_committed_effect(
            db.conn(),
            &key,
            "r1",
            "r1:s0",
            0,
            "read_file",
            "recorded-receipt-summary",
            None,
            150,
        )
        .unwrap();

        let out = retry_workflow(&def, &exec, db.conn(), "r1", SECRET, &mint_all, 200).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        assert_eq!(
            exec.calls.get(),
            1,
            "the committed effect was SKIPPED on retry: the executor was NOT called again"
        );
        // The step completed from the recorded receipt → Verified.
        assert_eq!(
            workflow::step_status(db.conn(), "r1:s0").unwrap(),
            Some(StepStatus::Verified)
        );
    }

    #[test]
    fn retry_without_a_ledger_entry_re_runs_the_frontier_the_negative_twin() {
        // The NEGATIVE TWIN of the skip test: IDENTICAL setup but NO injected ledger
        // row → the executor IS called again on retry. This isolates the key as the
        // sole cause of the skip in the positive case (same engine path, same
        // non-Verified frontier; the only difference is the ledger entry).
        let db = Db::open_hub(&tmp("a5-noskip")).unwrap();
        let exec = TransientExec {
            calls: Cell::new(0),
        };
        let def = single_side_effect_def();

        let started = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &mint_all, 100).unwrap();
        assert!(matches!(started.status, WorkflowRunStatus::Failed { .. }));
        assert_eq!(exec.calls.get(), 1);

        // NO ledger row injected → retry re-drives the frontier (executor called a 2nd time).
        let out = retry_workflow(&def, &exec, db.conn(), "r1", SECRET, &mint_all, 200).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        assert_eq!(
            exec.calls.get(),
            2,
            "with NO committed-effect ledger entry the frontier is re-driven (executor re-called)"
        );
        assert_eq!(
            workflow::step_status(db.conn(), "r1:s0").unwrap(),
            Some(StepStatus::Verified)
        );
        // The re-drive committed the effect now (so a FURTHER re-drive would skip it).
        let key = workflow::step_effect_idem_key(
            "r1",
            0,
            "read_file",
            &[("path".to_string(), "log".to_string())],
        );
        assert!(
            workflow::committed_effect(db.conn(), &key)
                .unwrap()
                .is_some(),
            "the successful re-drive recorded the committed effect"
        );
    }

    #[test]
    fn retry_after_partial_success_does_not_double_run_committed_steps_only_re_drives_frontier() {
        // The required per-behavior retry test, driven END-TO-END (no injected state):
        // a multi-step run where an EARLIER side-effect step COMMITS (Verified) and a
        // LATER step is the failure frontier. Retry must re-drive ONLY the failed
        // frontier — the already-committed earlier step's executor is NOT re-called.
        //
        // (In the linear engine this is enforced by Verified-skip; the A5 ledger ALSO
        // recorded the earlier step's effect, so a future model that re-presented it at
        // the frontier would skip it too. Both guards agree here.)
        let db = Db::open_hub(&tmp("a5-partial")).unwrap();
        // s0 = side-effect read (commits Verified on attempt 1); s1 = side-effect read
        // that ERRS on its first execution (the frontier), succeeds on retry. A single
        // TransientExec errs only on its FIRST call — which is s1 (s0 ran first, OK on
        // call 1? no: call 1 is s0). So use a frontier-only-failing executor instead.
        struct FrontierFailExec {
            calls: Cell<usize>,
            // step ids that have been executed, to prove no double-run.
            ran: std::cell::RefCell<Vec<String>>,
            fail_action_once: std::cell::RefCell<Option<String>>,
        }
        impl ToolExecutor for FrontierFailExec {
            fn execute(
                &self,
                action: &str,
                params: &[(String, String)],
            ) -> Result<ToolReceipt, ExecError> {
                self.calls.set(self.calls.get() + 1);
                let path = params
                    .iter()
                    .find(|(k, _)| k == "path")
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default();
                self.ran.borrow_mut().push(format!("{action}:{path}"));
                // Fail the frontier action exactly once (the first time it is seen).
                let mut once = self.fail_action_once.borrow_mut();
                if once.as_deref() == Some(path.as_str()) {
                    *once = None;
                    return Err(ExecError::Unsupported("frontier boom".to_string()));
                }
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!("ran {action} {path}"),
                    content: None,
                })
            }
        }
        let exec = FrontierFailExec {
            calls: Cell::new(0),
            ran: std::cell::RefCell::new(Vec::new()),
            fail_action_once: std::cell::RefCell::new(Some("frontier".to_string())),
        };
        let def = WorkflowDefinition {
            name: "twostep".into(),
            steps: vec![
                step("a", "read_file", &[("path", "committed")], false, true), // s0 side-effect
                step("b", "read_file", &[("path", "frontier")], false, true), // s1 side-effect frontier
            ],
        };

        // First drive: s0 commits (Verified), s1 errs → ProofPending, run Failed.
        let started = run_workflow(&def, &exec, db.conn(), "r1", SECRET, &mint_all, 100).unwrap();
        assert!(matches!(started.status, WorkflowRunStatus::Failed { .. }));
        assert_eq!(
            workflow::step_status(db.conn(), "r1:s0").unwrap(),
            Some(StepStatus::Verified),
            "the earlier side-effect step committed (Verified)"
        );
        assert_eq!(
            workflow::step_status(db.conn(), "r1:s1").unwrap(),
            Some(StepStatus::ProofPending),
            "the frontier side-effect step failed (ProofPending)"
        );
        assert_eq!(
            *exec.ran.borrow(),
            vec!["read_file:committed", "read_file:frontier"]
        );
        let calls_after_first = exec.calls.get();
        assert_eq!(calls_after_first, 2);
        // s0's committed effect is recorded.
        let s0_key = workflow::step_effect_idem_key(
            "r1",
            0,
            "read_file",
            &[("path".to_string(), "committed".to_string())],
        );
        assert!(workflow::committed_effect(db.conn(), &s0_key)
            .unwrap()
            .is_some());

        // Retry: ONLY the frontier (s1) is re-driven; s0 is NOT re-executed.
        let out = retry_workflow(&def, &exec, db.conn(), "r1", SECRET, &mint_all, 200).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        assert_eq!(run_state(&db, "r1"), "done");
        // Exactly ONE more executor call (the frontier re-drive); s0 not re-run.
        assert_eq!(
            exec.calls.get(),
            calls_after_first + 1,
            "retry re-drove ONLY the frontier — the committed earlier step was not double-run"
        );
        assert_eq!(
            *exec.ran.borrow(),
            vec![
                "read_file:committed",
                "read_file:frontier",
                "read_file:frontier"
            ],
            "the committed step (committed) ran exactly once; only the frontier re-ran"
        );
    }
}
