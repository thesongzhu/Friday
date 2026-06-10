//! R2 — the Rust workflow RUN-CONTROL plane (DARK).
//!
//! The TypeScript run-control path — `resumeRun` / `retryRun` / `cancelRun` in
//! `src/workflows/services/friday-workflow-execution-service.ts` — is already
//! METHOD-guarded / fail-closed in the live runtime (the G4 retirement guard:
//! every non-route caller is fenced out with a 503 `TS_RUNTIME_WORKFLOW_RUNS_RETIRED`
//! while runtime ownership moves to Rust). This module is the Rust-owned
//! equivalent of that control surface, built DARK: NO production route, NO
//! scheduler/trigger/daemon, NO migration, NO route flip, and it changes NO TS
//! runtime file. It is purely additive over the existing Rust run model.
//!
//! ## What it mirrors, and the run-model it maps onto
//! The TS service uses an 8-state `WorkflowRunStatus`
//! (`queued/running/pausing/paused/compensating/completed/failed/cancelled`) with
//! a `failed -> running` retry edge and `* -> cancelled`. The Rust hub does NOT
//! own that TS schema; it owns the `friday-core` 5-state [`WorkflowRunState`]
//! (`Pending/Running/AwaitingCheckpoint/Done/Failed`) persisted in
//! [`friday_storage::workflow`] and driven by the LIVE S9 engine
//! ([`crate::workflow_exec`]). So this module mirrors the TS control *logic*
//! (validation order, fail-closed error vocabulary, run effects) mapped onto the
//! Rust model — TS `paused` ≈ Rust `AwaitingCheckpoint` — rather than porting the
//! 8 TS state-strings into the Rust `state` column (which would silently corrupt
//! every 5-state reader, since [`friday_storage::workflow`]'s `parse_run_state`
//! coerces an unknown string to `Failed`).
//!
//! ## Per-op scope (HONEST — two ops fail closed by representability, not by choice)
//! - **`resume`** — fully built. It is the missing RESUME control bridge: S9
//!   ([`crate::workflow_run`]) added a START bridge (`run_stored_workflow`) but no
//!   resume bridge. [`resume`] loads the STORED definition fail-closed, prechecks
//!   the run is `AwaitingCheckpoint` (the only resumable state — surfacing a
//!   precise fail-closed error otherwise, matching the TS
//!   `INVALID_RUN_TRANSITION`/`WORKFLOW_RUN_NOT_FOUND` posture), then DELEGATES to
//!   the existing [`crate::workflow_exec::resume_workflow`] engine entrypoint
//!   (real node re-entry through the SAME gate; mutating steps stay approval-gated
//!   exactly as in the engine). It does NOT re-implement execution and does NOT
//!   flip state and return hollow (which, in this dark substrate with no tick
//!   loop, would strand a run in `Running` with nothing driving it).
//! - **`retry`** — fails closed with [`RunControlError::NotRepresentable`]. TS
//!   `retryRun` is `failed -> running` plus per-node retry-attempt rows
//!   (`attempt+1`, idempotency key, `retrying` status). The `friday-core` machine
//!   has NO `Failed -> Running` edge and the `workflow_step` schema has no
//!   attempt/idempotency/`retrying` concept. Representing it requires changing
//!   `friday-core/src/workflow.rs` (a shared core type the LIVE S9 engine +
//!   `skill.rs`/`planning.rs`/`workflow_read.rs` all match on) and an m0027
//!   migration — a cross-cutting, non-additive change outside R2's write-set that
//!   would touch live behavior. See the PR body's DEFERRED ACCEPTANCE CRITERIA.
//! - **`cancel`** — fails closed with [`RunControlError::NotRepresentable`]. TS
//!   `cancelRun` writes a terminal `cancelled` run state (distinct from `failed`)
//!   + cancels pending nodes + records a cancel reason. `friday-core` has NO
//!   `Cancelled` run state and NO `Cancelled` step status; mapping cancel onto
//!   `Failed` would erase the cancelled/failed distinction (a data-fudge the hard
//!   rules forbid). Representing it faithfully requires the same cross-cutting
//!   `friday-core` change + an m0027 `cancel_reason`. See the PR body.
//!
//! ## Fail-closed posture
//! Every entrypoint fail-closes: an unknown run, a non-resumable run state, a
//! missing/unparsable stored definition, and the two not-yet-representable ops
//! all return an explicit [`RunControlError`] — never a panic, never a silent
//! success, never a coerced state write. No `unwrap`/`expect` on caller input.

use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
use friday_storage::workflow::run_control_state;
use rusqlite::Connection;

use crate::workflow_def::{load_definition, WorkflowDefError};
use crate::workflow_exec::{resume_workflow, WorkflowOutcome};
use crate::ToolExecutor;

/// Fail-closed errors of the R2 run-control plane. Mirrors the TS service's
/// error *vocabulary* (run-not-found, invalid-transition) and adds the explicit
/// not-representable signal for the two ops the Rust run model cannot yet honor.
#[derive(Debug, thiserror::Error)]
pub enum RunControlError {
    /// The targeted run does not exist (TS `WORKFLOW_RUN_NOT_FOUND`, 404).
    #[error("workflow run not found: {0}")]
    NotFound(String),
    /// The run is not in a state this control op may act on — e.g. a resume of a
    /// non-`AwaitingCheckpoint` run (TS `INVALID_RUN_TRANSITION`, 400). Carries
    /// the current state and the attempted control op for an explicit message.
    #[error("invalid run-control transition: {0}")]
    InvalidTransition(String),
    /// The control op is NOT representable in the current Rust run model without
    /// a cross-cutting `friday-core` change outside R2's additive write-set. This
    /// is the honest, documented fail-closed for `retry`/`cancel` — NOT a stub,
    /// NOT a silent no-op, NOT a coercion onto `Failed`. The message names the
    /// exact missing capability so the acceptance criterion is unambiguous.
    #[error("workflow run-control op not representable in the Rust run model: {0}")]
    NotRepresentable(String),
    /// The stored definition failed to load/parse/validate (fail-closed before
    /// any control effect — a run is never resumed against an invalid body).
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

/// RETRY a run's failed nodes — NOT representable in the current Rust run model
/// (fail-closed). See the module docs and the PR's DEFERRED ACCEPTANCE CRITERIA:
/// faithfully mirroring TS `retryRun` needs a `friday-core` `Failed -> Running`
/// edge + per-attempt `workflow_step` columns (m0027), a cross-cutting change
/// outside R2's additive write-set that would touch the live S9 engine. This
/// returns an explicit, documented [`RunControlError::NotRepresentable`] — it
/// performs NO write and NO coercion. `nodes` is accepted to pin the intended TS
/// signature (selective-node retry) so the future representable version is a
/// drop-in; it is intentionally unused here.
pub fn retry(
    _conn: &Connection,
    run_id: &str,
    _nodes: Option<&[String]>,
) -> Result<WorkflowOutcome> {
    Err(RunControlError::NotRepresentable(format!(
        "retry of run '{run_id}': the friday-core run-state machine has no 'Failed -> Running' \
         retry edge and the workflow_step schema has no per-attempt (attempt/idempotency/retrying) \
         columns. Representing TS retryRun requires a cross-cutting friday-core change + an m0027 \
         migration, outside R2's additive write-set (it would touch the live S9 engine). Deferred."
    )))
}

/// CANCEL a run — NOT representable in the current Rust run model (fail-closed).
/// See the module docs and the PR's DEFERRED ACCEPTANCE CRITERIA: `friday-core`
/// has no terminal `Cancelled` run state (and no `Cancelled` step status);
/// mapping cancel onto `Failed` would erase the cancelled/failed distinction (a
/// data-fudge the hard rules forbid). A faithful cancel needs the same
/// cross-cutting `friday-core` change + an m0027 `cancel_reason`, outside R2's
/// write-set. Returns an explicit [`RunControlError::NotRepresentable`]; performs
/// NO write and NO coercion. `reason` is accepted to pin the TS signature.
pub fn cancel(_conn: &Connection, run_id: &str, _reason: Option<&str>) -> Result<WorkflowOutcome> {
    Err(RunControlError::NotRepresentable(format!(
        "cancel of run '{run_id}': the friday-core run-state machine has no terminal 'Cancelled' \
         state (and no 'Cancelled' step status); coercing cancel onto 'Failed' would erase the \
         cancelled/failed distinction. Representing TS cancelRun requires a cross-cutting \
         friday-core change + an m0027 cancel_reason, outside R2's additive write-set. Deferred."
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

    #[test]
    fn retry_is_fail_closed_not_representable() {
        // Documented deferral: retry returns an explicit NotRepresentable error,
        // performs NO write, and names the exact missing capability.
        let db = Db::open_hub(&tmp_db("retry-defer")).unwrap();
        let conn = db.conn();
        workflow::create_run(conn, "r1", "wf", 100).unwrap();
        workflow::set_run_state(conn, "r1", WorkflowRunState::Running, 110).unwrap();
        workflow::set_run_state(conn, "r1", WorkflowRunState::Failed, 120).unwrap();

        let r = retry(conn, "r1", Some(&["n1".to_string()]));
        match r {
            Err(RunControlError::NotRepresentable(msg)) => {
                assert!(
                    msg.contains("Failed -> Running"),
                    "names the missing edge: {msg}"
                );
            }
            other => panic!("expected NotRepresentable, got {other:?}"),
        }
        // The run state is untouched by the fail-closed retry (no coercion).
        assert_eq!(run_state_str(&db, "r1"), "failed");
    }

    #[test]
    fn cancel_is_fail_closed_not_representable_and_never_coerces_to_failed() {
        // Documented deferral: cancel returns NotRepresentable, performs NO write,
        // and does NOT coerce a running run onto Failed (the data-fudge the hard
        // rules forbid).
        let db = Db::open_hub(&tmp_db("cancel-defer")).unwrap();
        let conn = db.conn();
        workflow::create_run(conn, "r1", "wf", 100).unwrap();
        workflow::set_run_state(conn, "r1", WorkflowRunState::Running, 110).unwrap();

        let r = cancel(conn, "r1", Some("operator requested"));
        match r {
            Err(RunControlError::NotRepresentable(msg)) => {
                assert!(msg.contains("Cancelled"), "names the missing state: {msg}");
            }
            other => panic!("expected NotRepresentable, got {other:?}"),
        }
        // The running run is NOT coerced to Failed (or anything) — untouched.
        assert_eq!(run_state_str(&db, "r1"), "running");
    }
}
