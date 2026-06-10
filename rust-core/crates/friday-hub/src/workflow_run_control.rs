//! R2 — the Rust workflow RUN-CONTROL plane (DARK).
//!
//! The TypeScript run-control path — `resumeRun` / `retryRun` / `cancelRun` in
//! `src/workflows/services/friday-workflow-execution-service.ts` — is already
//! METHOD-guarded / fail-closed in the live runtime (the G4 retirement guard:
//! every non-route caller is fenced out with a 503 `TS_RUNTIME_WORKFLOW_RUNS_RETIRED`
//! while runtime ownership moves to Rust). This module is the Rust-owned
//! equivalent of that control surface, built DARK: NO production route, NO
//! scheduler/trigger/daemon, NO route flip, and it changes NO TS runtime file. It
//! is purely additive over the existing Rust run model. (R2 slice-2 DOES land one
//! additive dark migration — m0027, two `ALTER ADD COLUMN`s on the already-Hub-only
//! workflow tables — to back retry/cancel; it adds no new table and nothing reads
//! it in production.)
//!
//! ## What it mirrors, and the run-model it maps onto
//! The TS service uses an 8-state `WorkflowRunStatus`
//! (`queued/running/pausing/paused/compensating/completed/failed/cancelled`) with
//! a `failed -> running` retry edge and `* -> cancelled`. The Rust hub does NOT
//! own that TS schema; it owns the `friday-core` 6-state [`WorkflowRunState`]
//! (`Pending/Running/AwaitingCheckpoint/Done/Failed/Cancelled` — `Cancelled` added
//! additively in R2 slice-2) persisted in [`friday_storage::workflow`] and driven
//! by the LIVE S9 engine ([`crate::workflow_exec`]). So this module mirrors the TS
//! control *logic* (validation order, fail-closed error vocabulary, run effects)
//! mapped onto the Rust model — TS `paused` ≈ Rust `AwaitingCheckpoint`, TS
//! `cancelled` = Rust `Cancelled` — rather than porting the remaining TS-only
//! state-strings (`queued`/`pausing`/`compensating`) into the Rust `state` column
//! (which would silently corrupt every closed-vocab reader, since
//! [`friday_storage::workflow`]'s `parse_run_state` coerces an UNKNOWN string to
//! `Failed` — `cancelled` is now a KNOWN string and round-trips faithfully).
//!
//! ## Per-op scope (R2 slice-2: all three ops are now BUILT over the additive
//! `friday-core` `Cancelled`/retry-edge extension + m0027 columns)
//! - **`resume`** — the RESUME control bridge (slice-1). [`resume`] loads the
//!   STORED definition fail-closed, prechecks the run is `AwaitingCheckpoint` (the
//!   only resumable state), then DELEGATES to
//!   [`crate::workflow_exec::resume_workflow`] (real node re-entry through the SAME
//!   gate). It does NOT re-implement execution and does NOT flip-and-abandon state.
//! - **`retry`** — the RETRY control bridge (slice-2). Mirrors TS `retryRun`
//!   (`failed -> running` + per-node retry attempt). [`retry`] loads the STORED
//!   definition fail-closed, prechecks the run is `Failed` (the only retryable
//!   state), then DELEGATES to [`crate::workflow_exec::retry_workflow`], which
//!   reopens the failed run's frontier step (-> `Pending`, `attempt += 1` via the
//!   m0027 column), transitions `Failed -> Running` (the new core edge), and
//!   re-drives the frontier THROUGH THE SAME GATE then continues — REUSING the
//!   engine path, not re-implementing it. A mutating frontier with no approval
//!   re-pauses (never executes unapproved). HONEST: no idempotency keys yet (a
//!   partial side-effect could double-run on retry) — a documented deferred sub-AC.
//! - **`cancel`** — the CANCEL control bridge (slice-2). Mirrors TS `cancelRun`
//!   (terminal `cancelled`, distinct from `failed`, + a reason). [`cancel`]
//!   prechecks the run exists and is non-terminal, then writes the terminal
//!   `Cancelled` state + `cancel_reason` (m0027) atomically via
//!   [`friday_storage::workflow::cancel_run`] — NEVER coercing onto `Failed` (the
//!   cancelled/failed distinction is preserved end-to-end: the write is `Cancelled`
//!   and `parse_run_state` reads it back as `Cancelled`). Cancel does NOT load a
//!   definition (no node re-entry) and does NOT spend executor effort.
//!
//! ## Fail-closed posture
//! Every entrypoint fail-closes: an unknown run, a non-actionable run state (a
//! non-`AwaitingCheckpoint` resume, a non-`Failed` retry, a terminal cancel), and a
//! missing/unparsable stored definition all return an explicit [`RunControlError`]
//! — never a panic, never a silent success, never a coerced state write. No
//! `unwrap`/`expect` on caller input.

use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
use friday_storage::workflow::{cancel_run, run_control_state};
use rusqlite::Connection;

use crate::workflow_def::{load_definition, WorkflowDefError};
use crate::workflow_exec::{resume_workflow, retry_workflow, WorkflowOutcome};
use crate::ToolExecutor;

/// Fail-closed errors of the R2 run-control plane. Mirrors the TS service's
/// error *vocabulary* (run-not-found, invalid-transition).
#[derive(Debug, thiserror::Error)]
pub enum RunControlError {
    /// The targeted run does not exist (TS `WORKFLOW_RUN_NOT_FOUND`, 404).
    #[error("workflow run not found: {0}")]
    NotFound(String),
    /// The run is not in a state this control op may act on — e.g. a resume of a
    /// non-`AwaitingCheckpoint` run, a retry of a non-`Failed` run, or a cancel of
    /// a terminal run (TS `INVALID_RUN_TRANSITION`, 400). Carries the current state
    /// and the attempted control op for an explicit message.
    #[error("invalid run-control transition: {0}")]
    InvalidTransition(String),
    /// The stored definition failed to load/parse/validate (fail-closed before
    /// any control effect — a run is never resumed/retried against an invalid body).
    #[error("workflow definition error: {0}")]
    Definition(#[from] WorkflowDefError),
    /// A storage-layer failure surfaced fail-closed (never swallowed).
    #[error("storage error: {0}")]
    Storage(#[from] friday_storage::StorageError),
}

type Result<T> = std::result::Result<T, RunControlError>;

/// RESUME a paused (`AwaitingCheckpoint`) workflow run — the R2 control bridge.
///
/// This is the missing RESUME counterpart to S9's START bridge
/// ([`crate::workflow_run::run_stored_workflow`]): it loads the STORED definition
/// (`workflow_id` + `version`) fail-closed, prechecks the run is resumable, and
/// DELEGATES to the existing [`crate::workflow_exec::resume_workflow`] engine
/// entrypoint. The engine performs the real `AwaitingCheckpoint -> Running`
/// transition, finds the paused step, force-dispatches it THROUGH THE GATE (a
/// mutating step executes ONLY with a valid `approve` grant, else it re-pauses),
/// and continues to the next checkpoint / `Done`. No execution is re-implemented
/// here and no state is flipped-and-abandoned.
///
/// Fail-closed order (mirrors the TS `resumeRun` posture):
/// 1. Unknown run → [`RunControlError::NotFound`] (TS `WORKFLOW_RUN_NOT_FOUND`).
/// 2. Run not `AwaitingCheckpoint` → [`RunControlError::InvalidTransition`]
///    (TS `INVALID_RUN_TRANSITION`) — checked BEFORE the definition load so a
///    non-resumable run never triggers a parse.
/// 3. Stored definition missing/unparsable → [`RunControlError::Definition`]
///    (BEFORE any run mutation — the engine's own re-check is a backstop).
///
/// The `version` is explicit on purpose: a resume must re-enter the SAME
/// definition body the run started under. Resolving "published" here could pick a
/// newer version than the run paused on — the caller (a future Rust run-control
/// route) owns recording the run's version; this bridge does not guess it.
///
/// ## Approval-semantics mapping (an explicit divergence from TS `resumeRun`)
/// TS `resumeRun` takes a 3-way `approvalDecision`: a MISSING decision when an
/// approval node is blocked throws `WORKFLOW_APPROVAL_DECISION_REQUIRED` (400);
/// `rejected` marks the approval node failed and FINALIZES THE RUN FAILED;
/// `approved` continues. The Rust engine has no "approval node" — its checkpoints
/// are GATE checkpoints — so this bridge maps approval onto the engine's
/// `approve` gate-callback instead: a valid grant continues (≈ `approved`); a
/// WITHHELD grant RE-PAUSES (the run stays `AwaitingCheckpoint`) rather than
/// raising a decision-required error; and the explicit user-REJECT → fail-the-run
/// path is NOT modeled (only a gate-policy `Denied`/exec-error fails the run, via
/// the engine). This is a deliberate Rust-native mapping, NOT a port of approval
/// nodes; faithful reject→fail-run and decision-required semantics are a DEFERRED
/// acceptance criterion (would require modeling approval nodes, outside R2).
#[allow(clippy::too_many_arguments)]
pub fn resume(
    conn: &Connection,
    executor: &dyn ToolExecutor,
    workflow_id: &str,
    version: i64,
    run_id: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    now_ms: i64,
) -> Result<WorkflowOutcome> {
    // (1)/(2) Fail-closed precheck FIRST, derived from the canonical core machine
    // (single-sourced with `set_run_state`): unknown run → NotFound; a
    // non-AwaitingCheckpoint run → InvalidTransition. This runs BEFORE the
    // definition load so a non-resumable run never pays a parse.
    let control = run_control_state(conn, run_id)?
        .ok_or_else(|| RunControlError::NotFound(format!("'{run_id}'")))?;
    if !control.resumable {
        return Err(RunControlError::InvalidTransition(format!(
            "cannot resume run '{run_id}': state is '{}' (only an AwaitingCheckpoint run is \
             resumable; '{}' is{} terminal)",
            control.state.as_str(),
            control.state.as_str(),
            if control.terminal { "" } else { " not" },
        )));
    }

    // (3) Fail-closed definition load (parse/validate/name-crosscheck) BEFORE any
    // mutation — a run is never resumed against an invalid body.
    let def = load_definition(conn, workflow_id, version)?;

    // DELEGATE to the existing engine: real node re-entry through the gate. The
    // engine re-validates AwaitingCheckpoint (defense-in-depth) and owns every
    // state write from here, so there is no flip-and-abandon.
    let outcome = resume_workflow(&def, executor, conn, run_id, secret, approve, now_ms)?;
    Ok(outcome)
}

/// RETRY a `Failed` workflow run — the R2 slice-2 control bridge mirroring TS
/// `retryRun(runId, nodeIds)`.
///
/// It loads the STORED definition (`workflow_id` + `version`) fail-closed,
/// prechecks the run is `Failed` (the only retryable state — surfacing a precise
/// fail-closed error otherwise, matching the TS `INVALID_RUN_TRANSITION`/
/// `WORKFLOW_RUN_NOT_FOUND` posture), then DELEGATES to
/// [`crate::workflow_exec::retry_workflow`], which reopens the failed run's
/// frontier step (-> `Pending`, `attempt += 1`), transitions `Failed -> Running`
/// (the new core retry edge), and re-drives the frontier THROUGH THE SAME GATE then
/// continues — the SAME re-entry chokepoint as resume. No execution is
/// re-implemented here and no state is flipped-and-abandoned (a hollow
/// `Failed -> Running` flip in this dark, tick-loop-less substrate would strand the
/// run in `Running`).
///
/// Fail-closed order (mirrors the TS `retryRun` posture):
/// 1. Unknown run → [`RunControlError::NotFound`] (TS `WORKFLOW_RUN_NOT_FOUND`).
/// 2. Run not `Failed` → [`RunControlError::InvalidTransition`] (TS
///    `INVALID_RUN_TRANSITION`) — checked BEFORE the definition load.
/// 3. Stored definition missing/unparsable → [`RunControlError::Definition`].
///
/// ## Divergences from TS `retryRun` (explicit, documented)
/// - **Selective-node retry (`nodes`) is NOT modeled.** TS retries a chosen subset
///   of failed nodes; the Rust engine is a LINEAR step run with a single failure
///   frontier (it fails fast at the first non-passing step), so "retry" is "re-drive
///   from the frontier". `nodes` is accepted to pin the TS signature but, if
///   supplied, MUST name exactly the frontier step (`{run_id}:s{frontier}`) — any
///   other selection is a fail-closed [`RunControlError::InvalidTransition`] (we do
///   NOT silently ignore a caller's node selection). A future DAG engine would honor
///   arbitrary subsets — a deferred sub-AC.
/// - **No idempotency keys** (TS has per-attempt idempotency keys). Re-driving the
///   frontier is correct for a TRANSIENT failure; a partially-applied side effect
///   could double-run. A documented deferred sub-AC (see the module docs / PR body).
#[allow(clippy::too_many_arguments)]
pub fn retry(
    conn: &Connection,
    executor: &dyn ToolExecutor,
    workflow_id: &str,
    version: i64,
    run_id: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    nodes: Option<&[String]>,
    now_ms: i64,
) -> Result<WorkflowOutcome> {
    // (1)/(2) Fail-closed precheck FIRST: unknown run → NotFound; a non-Failed run →
    // InvalidTransition. This runs BEFORE the definition load so a non-retryable run
    // never pays a parse.
    let control = run_control_state(conn, run_id)?
        .ok_or_else(|| RunControlError::NotFound(format!("'{run_id}'")))?;
    if control.state != friday_core::WorkflowRunState::Failed {
        return Err(RunControlError::InvalidTransition(format!(
            "cannot retry run '{run_id}': state is '{}' (only a Failed run is retryable)",
            control.state.as_str(),
        )));
    }

    // (3) Fail-closed definition load BEFORE any mutation.
    let def = load_definition(conn, workflow_id, version)?;

    // Selective-node retry guard: if a node selection is supplied, it must name
    // exactly the engine's single failure frontier — we never silently drop a
    // caller's selection (that would be a quiet semantic divergence).
    if let Some(sel) = nodes {
        let frontier_id = frontier_step_id(conn, run_id, def.steps.len())?;
        let ok = sel.len() == 1 && sel[0] == frontier_id;
        if !ok {
            return Err(RunControlError::InvalidTransition(format!(
                "selective-node retry of run '{run_id}' is limited to the single failure frontier \
                 step '{frontier_id}' in the linear Rust engine; got {sel:?} (arbitrary-subset \
                 retry is a deferred sub-AC)"
            )));
        }
    }

    // DELEGATE to the engine: reopen the frontier, Failed -> Running, re-drive
    // through the gate, continue. The engine owns every state write from here.
    let outcome = retry_workflow(&def, executor, conn, run_id, secret, approve, now_ms)?;
    Ok(outcome)
}

/// CANCEL a workflow run terminally — the R2 slice-2 control bridge mirroring TS
/// `cancelRun(runId, reason)`.
///
/// It writes the terminal `Cancelled` state + `cancel_reason` (m0027) atomically via
/// [`friday_storage::workflow::cancel_run`], which validates the transition through
/// the SAME `friday-core` machine `set_run_state` uses — so only a non-terminal run
/// (`Pending`/`Running`/`AwaitingCheckpoint`) cancels and a terminal
/// (`Done`/`Failed`/`Cancelled`) run is REFUSED (no reopen). It NEVER coerces a run
/// onto `Failed`: the cancelled/failed distinction is preserved end-to-end (the
/// write is `Cancelled` and `parse_run_state` reads it back as `Cancelled`).
///
/// Unlike TS `cancelRun` (which also aborts in-flight node `AbortController`s),
/// there is NO in-flight async run to abort in this dark, tick-loop-less substrate —
/// a Rust run is driven synchronously by an explicit `run_workflow`/`resume_workflow`/
/// `retry_workflow` call, never a background controller — so the cancel is purely the
/// terminal state+reason write. Cancel does NOT load a definition (no node re-entry)
/// and spends NO executor effort.
///
/// Fail-closed order (mirrors the TS `cancelRun` posture):
/// 1. Unknown run → [`RunControlError::NotFound`] (TS `WORKFLOW_RUN_NOT_FOUND`).
/// 2. Terminal run (no `-> Cancelled` edge) → [`RunControlError::InvalidTransition`]
///    (TS `INVALID_RUN_TRANSITION` from `assertTransition(status,"cancelled")`).
///
/// Returns a [`WorkflowRunStatus::Cancelled`] outcome on success.
pub fn cancel(conn: &Connection, run_id: &str, reason: Option<&str>, now_ms: i64) -> Result<()> {
    // (1) Unknown run → NotFound (the explicit not-found posture, before the
    // transition check, so a ghost run is a NotFound rather than a generic storage
    // error). (2) The terminal-state refusal is enforced inside `cancel_run` via the
    // core machine — surfaced as a storage error and mapped to InvalidTransition for
    // the precise TS-mirrored vocabulary.
    let control = run_control_state(conn, run_id)?
        .ok_or_else(|| RunControlError::NotFound(format!("'{run_id}'")))?;
    if control.terminal {
        return Err(RunControlError::InvalidTransition(format!(
            "cannot cancel run '{run_id}': state is '{}' (a terminal run cannot be cancelled)",
            control.state.as_str(),
        )));
    }
    cancel_run(conn, run_id, reason, now_ms)?;
    Ok(())
}

/// The `step_id` of the engine's single failure frontier (first non-`Verified`
/// registered step) — the only node a selective-node `retry` may name. Mirrors the
/// engine's `find_retry_frontier_seq` without re-exporting it.
fn frontier_step_id(conn: &Connection, run_id: &str, n_steps: usize) -> Result<String> {
    use friday_core::StepStatus;
    for seq in 0..n_steps {
        let step_id = format!("{run_id}:s{seq}");
        match friday_storage::workflow::step_status(conn, &step_id)? {
            Some(StepStatus::Verified) => continue,
            Some(_) => return Ok(step_id),
            None => break,
        }
    }
    Err(RunControlError::InvalidTransition(format!(
        "run '{run_id}' has no retryable (non-verified) frontier step"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planner::{WorkflowDefinition, WorkflowStep};
    use crate::workflow_def::{create_definition, StoredWorkflowDefV1};
    use crate::workflow_exec::{run_workflow, WorkflowRunStatus};
    use friday_core::WorkflowRunState;
    use friday_storage::workflow_def::DefinitionSource;
    use friday_storage::{workflow, Db};
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};

    use crate::{ExecError, ToolReceipt};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp_db(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-wfctl-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    const SECRET: &[u8] = b"wf-ctl-secret-0123456789abcdef0";

    /// Executor that records its call count — the witness that a paused step is
    /// NEVER executed without an approval (mirrors the engine's CountingExec).
    struct CountingExec {
        calls: Cell<usize>,
    }
    impl ToolExecutor for CountingExec {
        fn execute(
            &self,
            action: &str,
            _params: &[(String, String)],
        ) -> std::result::Result<ToolReceipt, ExecError> {
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
    fn mint_all(r: &MutatingActionRequest) -> Option<CanonicalApproval> {
        Some(crate::mint_approval(r, "owner", SECRET, 10_000_000))
    }

    fn step(id: &str, action: &str, params: &[(&str, &str)], evidence: bool) -> WorkflowStep {
        WorkflowStep {
            id: id.to_string(),
            action: action.to_string(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            force_checkpoint: false,
            evidence_required: evidence,
        }
    }

    /// read (auto-advance) → write (mutating checkpoint, pauses under deny-all).
    fn read_then_write_def() -> WorkflowDefinition {
        WorkflowDefinition {
            name: "ship".into(),
            steps: vec![
                step("read", "read_file", &[("path", "x")], false),
                step(
                    "write",
                    "write_file",
                    &[("path", "o"), ("content", "y")],
                    true,
                ),
            ],
        }
    }

    /// Store the executable def so the resume bridge can LOAD it (the bridge
    /// loads from storage, exactly as a real run-control route would).
    fn store_def(conn: &Connection, workflow_id: &str, def: &WorkflowDefinition) {
        let stored = StoredWorkflowDefV1::from_executable(def);
        create_definition(
            conn,
            workflow_id,
            1,
            &stored,
            DefinitionSource::RustNative,
            None,
            1,
        )
        .unwrap();
    }

    fn run_state_str(db: &Db, run_id: &str) -> String {
        workflow::run_state(db.conn(), run_id)
            .unwrap()
            .unwrap()
            .as_str()
            .to_string()
    }

    #[test]
    fn resume_bridge_loads_def_and_completes_an_approved_paused_run() {
        // The end-to-end happy path: a run paused at a mutating step is resumed
        // THROUGH THE BRIDGE (which loads the stored def + delegates to the engine)
        // with a valid approval → the write executes → Done. The earlier verified
        // step is NOT re-run (engine guarantee, observed via the call count).
        let db = Db::open_hub(&tmp_db("resume-ok")).unwrap();
        let conn = db.conn();
        let def = read_then_write_def();
        store_def(conn, "wf1", &def);
        let exec = CountingExec {
            calls: Cell::new(0),
        };

        // Start (deny-all): read runs, write pauses → AwaitingCheckpoint.
        let started = run_workflow(&def, &exec, conn, "r1", SECRET, &deny_all, 100).unwrap();
        assert!(matches!(
            started.status,
            WorkflowRunStatus::AwaitingCheckpoint { .. }
        ));
        assert_eq!(exec.calls.get(), 1);
        assert_eq!(run_state_str(&db, "r1"), "awaiting_checkpoint");

        // Resume THROUGH THE BRIDGE with a valid approval → write executes → Done.
        let out = resume(conn, &exec, "wf1", 1, "r1", SECRET, &mint_all, 200).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        assert_eq!(run_state_str(&db, "r1"), "done");
        assert_eq!(
            exec.calls.get(),
            2,
            "earlier verified step must not re-run; only the write ran on resume"
        );
    }

    #[test]
    fn resume_bridge_re_pauses_without_a_valid_approval_and_never_executes_unapproved() {
        // Safety witness through the bridge: resuming a mutating-paused run with
        // NO approval RE-pauses and the executor is NOT called for the mutating
        // step (the gate, not the bridge, is the authorization).
        let db = Db::open_hub(&tmp_db("resume-deny")).unwrap();
        let conn = db.conn();
        let def = read_then_write_def();
        store_def(conn, "wf1", &def);
        let exec = CountingExec {
            calls: Cell::new(0),
        };

        run_workflow(&def, &exec, conn, "r1", SECRET, &deny_all, 100).unwrap();
        assert_eq!(exec.calls.get(), 1);

        let out = resume(conn, &exec, "wf1", 1, "r1", SECRET, &deny_all, 200).unwrap();
        assert!(matches!(
            out.status,
            WorkflowRunStatus::AwaitingCheckpoint { .. }
        ));
        assert_eq!(
            exec.calls.get(),
            1,
            "unapproved mutating step must NOT execute on resume"
        );
        assert_eq!(run_state_str(&db, "r1"), "awaiting_checkpoint");
    }

    #[test]
    fn resume_unknown_run_is_fail_closed_not_found() {
        let db = Db::open_hub(&tmp_db("resume-404")).unwrap();
        let conn = db.conn();
        store_def(conn, "wf1", &read_then_write_def());
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let r = resume(conn, &exec, "wf1", 1, "ghost", SECRET, &mint_all, 100);
        assert!(matches!(r, Err(RunControlError::NotFound(_))), "got {r:?}");
        assert_eq!(exec.calls.get(), 0, "no execution for a non-existent run");
    }

    #[test]
    fn resume_a_non_awaiting_checkpoint_run_is_fail_closed_invalid_transition() {
        // A completed (Done) run is not resumable → InvalidTransition, and the
        // definition is never even loaded (precheck runs first), no execution.
        let db = Db::open_hub(&tmp_db("resume-nonpaused")).unwrap();
        let conn = db.conn();
        let def = WorkflowDefinition {
            name: "research".into(),
            steps: vec![step("a", "read_file", &[("path", "x")], false)],
        };
        store_def(conn, "wf1", &def);
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        // All-read-only → Done immediately.
        let out = run_workflow(&def, &exec, conn, "r1", SECRET, &deny_all, 100).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        let before = exec.calls.get();

        let r = resume(conn, &exec, "wf1", 1, "r1", SECRET, &mint_all, 200);
        assert!(
            matches!(r, Err(RunControlError::InvalidTransition(_))),
            "got {r:?}"
        );
        assert_eq!(
            exec.calls.get(),
            before,
            "a non-resumable run triggers no execution"
        );
        assert_eq!(
            run_state_str(&db, "r1"),
            "done",
            "the run state is untouched"
        );
    }

    #[test]
    fn resume_with_a_missing_stored_definition_is_fail_closed() {
        // Run is genuinely AwaitingCheckpoint, but the stored def for the resume
        // version is absent → Definition error, surfaced fail-closed.
        let db = Db::open_hub(&tmp_db("resume-nodef")).unwrap();
        let conn = db.conn();
        let def = read_then_write_def();
        store_def(conn, "wf1", &def);
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        run_workflow(&def, &exec, conn, "r1", SECRET, &deny_all, 100).unwrap();
        assert_eq!(run_state_str(&db, "r1"), "awaiting_checkpoint");
        // Resume against a version that was never stored (v2).
        let r = resume(conn, &exec, "wf1", 2, "r1", SECRET, &mint_all, 200);
        assert!(
            matches!(r, Err(RunControlError::Definition(_))),
            "got {r:?}"
        );
        // The run was NOT mutated by the failed resume — still paused.
        assert_eq!(run_state_str(&db, "r1"), "awaiting_checkpoint");
    }

    /// Executor that ERRS on its first call and SUCCEEDS thereafter — the witness
    /// that retry resolves an ENGINE-PRODUCED failure (a transient error), with NO
    /// injected step state. Mirrors a real transient tool failure.
    struct TransientExec {
        calls: Cell<usize>,
    }
    impl ToolExecutor for TransientExec {
        fn execute(
            &self,
            action: &str,
            _params: &[(String, String)],
        ) -> std::result::Result<ToolReceipt, ExecError> {
            let n = self.calls.get() + 1;
            self.calls.set(n);
            if n == 1 {
                // Simulate a transient tool failure (any ExecError fails the run).
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

    /// A single read-only step (auto-advances through the gate; no checkpoint).
    fn single_read_def() -> WorkflowDefinition {
        WorkflowDefinition {
            name: "probe".into(),
            steps: vec![step("read", "read_file", &[("path", "x")], false)],
        }
    }

    #[test]
    fn retry_re_drives_a_real_engine_failure_to_done_through_the_gate() {
        // The end-to-end happy path with NO injected state: a transient executor
        // error fails the run on the FIRST drive (engine-produced Failed); retry
        // THROUGH THE BRIDGE reopens the frontier, transitions Failed -> Running,
        // re-dispatches (executor now succeeds) → Done. The step's attempt is bumped.
        let db = Db::open_hub(&tmp_db("retry-ok")).unwrap();
        let conn = db.conn();
        let def = single_read_def();
        store_def(conn, "wf1", &def);
        let exec = TransientExec {
            calls: Cell::new(0),
        };

        // First drive: gate allows the read, executor errs → run Failed.
        let started = run_workflow(&def, &exec, conn, "r1", SECRET, &mint_all, 100).unwrap();
        assert!(matches!(started.status, WorkflowRunStatus::Failed { .. }));
        assert_eq!(run_state_str(&db, "r1"), "failed");
        assert_eq!(exec.calls.get(), 1);
        // The engine left the frontier step NON-Verified — here `Running` (an
        // exec-error on a NON-side-effect step leaves it Running, never a `Failed`
        // step status). This is the real engine failure shape retry must handle; it
        // is NOT a `StepStatus::Failed` (the engine has no path that writes that).
        assert_eq!(
            workflow::step_status(conn, "r1:s0").unwrap(),
            Some(friday_core::StepStatus::Running),
            "exec-error on a pure step leaves it Running (the real frontier), not Failed"
        );

        // Retry THROUGH THE BRIDGE: reopen + Failed->Running + re-drive → Done.
        let out = retry(conn, &exec, "wf1", 1, "r1", SECRET, &mint_all, None, 200).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        assert_eq!(run_state_str(&db, "r1"), "done");
        assert_eq!(exec.calls.get(), 2, "the frontier was re-dispatched once");
        assert_eq!(
            workflow::step_attempt(conn, "r1:s0").unwrap(),
            Some(2),
            "the retried step's attempt was bumped to 2"
        );
    }

    #[test]
    fn retry_of_a_mutating_frontier_re_pauses_without_an_approval_and_never_executes_unapproved() {
        // Safety witness for retry: a run whose mutating frontier failed, retried
        // with NO valid approval, RE-pauses (AwaitingCheckpoint) and the executor is
        // NOT called for the mutating step — the gate, not the bridge, authorizes.
        // Construct an engine-real Failed run with a mutating frontier: a read then a
        // write; deny-all pauses at the write; we then fail the paused run, then retry.
        let db = Db::open_hub(&tmp_db("retry-mut")).unwrap();
        let conn = db.conn();
        let def = read_then_write_def();
        store_def(conn, "wf1", &def);
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        // Drive: read runs, write checkpoints → AwaitingCheckpoint.
        run_workflow(&def, &exec, conn, "r1", SECRET, &deny_all, 100).unwrap();
        assert_eq!(run_state_str(&db, "r1"), "awaiting_checkpoint");
        assert_eq!(exec.calls.get(), 1);
        // Fail the run (AwaitingCheckpoint -> Failed is a legal core edge) to model a
        // run that failed at the mutating frontier (the write step is still Pending).
        workflow::set_run_state(conn, "r1", WorkflowRunState::Failed, 150).unwrap();
        assert_eq!(
            workflow::step_status(conn, "r1:s1").unwrap(),
            Some(friday_core::StepStatus::Pending),
            "the mutating frontier is Pending (registered, never executed)"
        );

        // Retry with deny-all: the mutating frontier needs an approval → re-pause.
        let out = retry(conn, &exec, "wf1", 1, "r1", SECRET, &deny_all, None, 200).unwrap();
        assert!(matches!(
            out.status,
            WorkflowRunStatus::AwaitingCheckpoint { .. }
        ));
        assert_eq!(run_state_str(&db, "r1"), "awaiting_checkpoint");
        assert_eq!(
            exec.calls.get(),
            1,
            "the unapproved mutating frontier must NOT execute on retry"
        );
    }

    #[test]
    fn retry_fail_closed_unknown_non_failed_and_bad_node_selection() {
        let db = Db::open_hub(&tmp_db("retry-closed")).unwrap();
        let conn = db.conn();
        let def = single_read_def();
        store_def(conn, "wf1", &def);
        let exec = CountingExec {
            calls: Cell::new(0),
        };

        // Unknown run → NotFound, no execution.
        let r = retry(conn, &exec, "wf1", 1, "ghost", SECRET, &mint_all, None, 100);
        assert!(matches!(r, Err(RunControlError::NotFound(_))), "got {r:?}");
        assert_eq!(exec.calls.get(), 0);

        // A non-Failed (Done) run is not retryable → InvalidTransition, untouched.
        let out = run_workflow(&def, &exec, conn, "r1", SECRET, &mint_all, 100).unwrap();
        assert_eq!(out.status, WorkflowRunStatus::Completed);
        let calls_after_done = exec.calls.get();
        let r = retry(conn, &exec, "wf1", 1, "r1", SECRET, &mint_all, None, 200);
        assert!(
            matches!(r, Err(RunControlError::InvalidTransition(_))),
            "got {r:?}"
        );
        assert_eq!(run_state_str(&db, "r1"), "done");
        assert_eq!(
            exec.calls.get(),
            calls_after_done,
            "no re-execution of a Done run"
        );

        // A Failed run with a node selection that is NOT the frontier → InvalidTransition.
        let exec2 = TransientExec {
            calls: Cell::new(0),
        };
        run_workflow(&def, &exec2, conn, "r2", SECRET, &mint_all, 100).unwrap();
        assert_eq!(run_state_str(&db, "r2"), "failed");
        let r = retry(
            conn,
            &exec2,
            "wf1",
            1,
            "r2",
            SECRET,
            &mint_all,
            Some(&["not-the-frontier".to_string()]),
            200,
        );
        assert!(
            matches!(r, Err(RunControlError::InvalidTransition(_))),
            "a bad node selection is fail-closed, not silently ignored: {r:?}"
        );
        assert_eq!(
            run_state_str(&db, "r2"),
            "failed",
            "untouched by the refused retry"
        );
    }

    #[test]
    fn cancel_writes_terminal_cancelled_with_reason_and_never_coerces_to_failed() {
        // Real cancel: a Running run is cancelled THROUGH THE BRIDGE → terminal
        // Cancelled (NOT Failed) with the reason recorded; reads back as Cancelled.
        let db = Db::open_hub(&tmp_db("cancel-ok")).unwrap();
        let conn = db.conn();
        workflow::create_run(conn, "r1", "wf", 100).unwrap();
        workflow::set_run_state(conn, "r1", WorkflowRunState::Running, 110).unwrap();

        cancel(conn, "r1", Some("operator requested"), 120).unwrap();
        assert_eq!(run_state_str(&db, "r1"), "cancelled");
        assert_ne!(run_state_str(&db, "r1"), "failed");
        assert_eq!(
            workflow::run_cancel_reason(conn, "r1").unwrap(),
            Some("operator requested".to_string())
        );
    }

    #[test]
    fn cancel_fail_closed_unknown_and_terminal_runs() {
        let db = Db::open_hub(&tmp_db("cancel-closed")).unwrap();
        let conn = db.conn();

        // Unknown run → NotFound.
        assert!(matches!(
            cancel(conn, "ghost", None, 100),
            Err(RunControlError::NotFound(_))
        ));

        // A terminal Failed run cannot be cancelled → InvalidTransition; the run is
        // NOT coerced — it stays Failed (the cancelled/failed distinction holds).
        workflow::create_run(conn, "r1", "wf", 100).unwrap();
        workflow::set_run_state(conn, "r1", WorkflowRunState::Failed, 110).unwrap();
        let r = cancel(conn, "r1", Some("too late"), 120);
        assert!(
            matches!(r, Err(RunControlError::InvalidTransition(_))),
            "got {r:?}"
        );
        assert_eq!(run_state_str(&db, "r1"), "failed");
        assert_eq!(
            workflow::run_cancel_reason(conn, "r1").unwrap(),
            None,
            "a refused cancel writes no reason"
        );
    }
}
