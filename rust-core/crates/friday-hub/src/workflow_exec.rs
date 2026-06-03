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
use friday_core::{StepStatus, WorkflowRunState};
use friday_storage::{workflow, StorageError};
use rusqlite::Connection;

use crate::planner::{plan_step, StepDisposition, WorkflowDefinition};
use crate::{gate_dispatch, GateDispatch, RawToolCall, ToolExecutor};

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
    match gate_dispatch(conn, executor, &raw, secret, approve, now_ms)? {
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
                match gate_dispatch(conn, executor, &raw, secret, approve, now_ms)? {
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
}
