//! S9 — the manual workflow-RUN bridge seam: load a STORED workflow definition
//! (S8, [`crate::workflow_def`]) by `workflow_id`/`version` (or its published
//! version) and execute it through the EXISTING, UNMODIFIED
//! [`crate::workflow_exec`] engine.
//!
//! ## Scope and truth labels (DARK substrate)
//! - This is the non-test dispatch seam the S9 lane adds: before it, the
//!   engine's `run_workflow` entrypoint had only `#[cfg(test)]` callers. It
//!   registers NO production route, NO scheduler/trigger/cron/daemon (that is
//!   S10, operator-gated), and changes NO TS runtime file. Workflow execution
//!   remains fenced in TS and is NOT product-replaced; NOT v1 GO.
//! - There is NO second executor and NO engine change: the loader's output
//!   ([`crate::planner::WorkflowDefinition`]) IS the engine's input, and every
//!   step still goes through the engine's planner + `gate_dispatch` chokepoints
//!   with the SAME gate posture the engine already has — under the default
//!   deny-all approval policy a mutating/checkpoint step PAUSES the run
//!   (`AwaitingCheckpoint`) and is never executed. No gate/approval/crypto code
//!   is touched here.
//! - Mission/WorkItem binding: the existing engine does not model it — a
//!   workflow run is keyed by `run_id` only (`workflow_run` has no
//!   mission/work-item column). This seam therefore does NOT invent one; if a
//!   later slice adds Mission binding to the engine, this seam inherits it.
//! - Single-shot is inherited from the engine: re-invoking with an already-used
//!   `run_id` fails closed at `create_run` (duplicate PK, no double-dispatch).
//!
//! ## Fail-closed posture
//! A missing definition / missing published version / unparsable or
//! name-divergent stored body all fail closed in the S8 loader BEFORE any run
//! row is created — a run is only ever created for a definition that loaded and
//! validated.

use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
use rusqlite::Connection;

use crate::workflow_def::{load_definition, WorkflowDefError};
use crate::workflow_exec::{run_workflow, WorkflowOutcome};
use crate::ToolExecutor;

/// The outcome of running a STORED workflow definition: which definition ran
/// (id + the resolved version — meaningful for published-version dispatch) plus
/// the engine's own [`WorkflowOutcome`], unchanged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredWorkflowRun {
    pub workflow_id: String,
    /// The definition version that actually ran (explicit, or the resolved
    /// published version).
    pub version: i64,
    pub outcome: WorkflowOutcome,
}

/// Run a STORED workflow definition (exact `workflow_id` + `version`) through
/// the EXISTING engine: S8 loader (fail-closed parse/validate/name-crosscheck)
/// → [`crate::workflow_exec::run_workflow`] (planner + gate per step, pause at
/// the first checkpoint, evidence-gated completion). Pure composition — no
/// engine change, no second executor.
#[allow(clippy::too_many_arguments)]
pub fn run_stored_workflow(
    conn: &Connection,
    executor: &dyn ToolExecutor,
    workflow_id: &str,
    version: i64,
    run_id: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    now_ms: i64,
) -> Result<StoredWorkflowRun, WorkflowDefError> {
    // Fail-closed load FIRST: no run row is created for a definition that does
    // not load + validate.
    let def = load_definition(conn, workflow_id, version)?;
    let outcome = run_workflow(&def, executor, conn, run_id, secret, approve, now_ms)?;
    Ok(StoredWorkflowRun {
        workflow_id: workflow_id.to_string(),
        version,
        outcome,
    })
}

/// Run the PUBLISHED version of a stored workflow. Resolves the published
/// version fail-closed (no published version ⇒ [`WorkflowDefError::NotFound`]),
/// then dispatches through [`run_stored_workflow`] so both entrypoints share
/// one load→engine path.
pub fn run_stored_published_workflow(
    conn: &Connection,
    executor: &dyn ToolExecutor,
    workflow_id: &str,
    run_id: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    now_ms: i64,
) -> Result<StoredWorkflowRun, WorkflowDefError> {
    let version = published_version(conn, workflow_id)?;
    run_stored_workflow(
        conn,
        executor,
        workflow_id,
        version,
        run_id,
        secret,
        approve,
        now_ms,
    )
}

/// Resolve a workflow's PUBLISHED version number (read-only). Fail-closed when
/// the workflow has no published version.
pub fn published_version(conn: &Connection, workflow_id: &str) -> Result<i64, WorkflowDefError> {
    let row = friday_storage::workflow_def::get_published_definition(conn, workflow_id)?
        .ok_or_else(|| {
            WorkflowDefError::NotFound(format!("'{workflow_id}' (no published version)"))
        })?;
    Ok(row.version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow_def::{
        create_definition, store_published_version, StoredWorkflowDefV1, StoredWorkflowStepV1,
        WORKFLOW_DEF_SCHEMA_VERSION,
    };
    use crate::workflow_exec::WorkflowRunStatus;
    use crate::FsToolExecutor;
    use friday_storage::workflow_def::DefinitionSource;
    use friday_storage::workflow_read::{get_workflow_run_summary, list_workflow_step_summaries};
    use friday_storage::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "friday-wfrun-{}-{}-{}",
            std::process::id(),
            tag,
            C.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn tmp_db(tag: &str) -> String {
        tmp(tag)
            .with_extension("sqlite")
            .to_string_lossy()
            .into_owned()
    }

    /// A real temp WORKSPACE (not a mock): contains `notes.txt` so a read-only
    /// stored workflow has something genuine to read through `FsToolExecutor`.
    fn tmp_workspace(tag: &str) -> std::path::PathBuf {
        let ws = tmp(tag);
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("notes.txt"), b"hello workflow").unwrap();
        ws
    }

    const SECRET: &[u8] = b"wf-run-secret-0123456789abcdef";

    fn deny_all(_r: &MutatingActionRequest) -> Option<CanonicalApproval> {
        None
    }

    fn step(id: &str, action: &str, params: &[(&str, &str)]) -> StoredWorkflowStepV1 {
        StoredWorkflowStepV1 {
            id: id.to_string(),
            action: action.to_string(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            force_checkpoint: false,
            evidence_required: false,
        }
    }

    fn read_only_def() -> StoredWorkflowDefV1 {
        StoredWorkflowDefV1 {
            schema_version: WORKFLOW_DEF_SCHEMA_VERSION,
            name: "research".into(),
            steps: vec![
                step("read", "read_file", &[("path", "notes.txt")]),
                step("ls", "list_dir", &[("path", ".")]),
            ],
        }
    }

    fn mutating_def() -> StoredWorkflowDefV1 {
        StoredWorkflowDefV1 {
            schema_version: WORKFLOW_DEF_SCHEMA_VERSION,
            name: "ship".into(),
            steps: vec![
                step("read", "read_file", &[("path", "notes.txt")]),
                step(
                    "write",
                    "write_file",
                    &[("path", "out.txt"), ("content", "y")],
                ),
            ],
        }
    }

    #[test]
    fn stored_published_definition_runs_end_to_end_through_the_existing_engine() {
        // THE seam test: stored def → S8 loader → UNMODIFIED engine executes a
        // read-only linear workflow against a REAL temp workspace via the REAL
        // FsToolExecutor → run/step rows persisted → readback helpers project
        // refs-only summaries.
        let db = Db::open_hub(&tmp_db("e2e")).unwrap();
        let ws = tmp_workspace("e2e-ws");
        store_published_version(
            db.conn(),
            "wf1",
            3,
            &read_only_def(),
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();

        let exec = FsToolExecutor::new(&ws);
        let run =
            run_stored_published_workflow(db.conn(), &exec, "wf1", "run1", SECRET, &deny_all, 200)
                .unwrap();

        assert_eq!(run.workflow_id, "wf1");
        assert_eq!(
            run.version, 3,
            "the published version is resolved + reported"
        );
        assert_eq!(run.outcome.status, WorkflowRunStatus::Completed);
        assert_eq!(run.outcome.executed_steps, 2);

        // Run + step rows persisted by the EXISTING engine, projectable refs-only.
        let summary = get_workflow_run_summary(db.conn(), "run1")
            .unwrap()
            .unwrap();
        assert_eq!(summary.name, "research");
        assert_eq!(summary.state, "done");
        let steps = list_workflow_step_summaries(db.conn(), "run1").unwrap();
        assert_eq!(steps.len(), 2);
        assert!(steps.iter().all(|s| s.status == "verified"));
        assert!(
            steps.iter().all(|s| s.has_evidence),
            "executed steps complete WITH their tool receipt as evidence"
        );
        // refs-only at the type level: the summary struct has no evidence text field.
        assert_eq!(steps[0].step_id, "run1:s0");
        assert_eq!(steps[1].seq, 1);
    }

    #[test]
    fn explicit_version_dispatch_runs_that_exact_version() {
        let db = Db::open_hub(&tmp_db("ver")).unwrap();
        let ws = tmp_workspace("ver-ws");
        // v1 = two steps (unpublished), v2 = one step (published).
        create_definition(
            db.conn(),
            "wf1",
            1,
            &read_only_def(),
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();
        let mut v2 = read_only_def();
        v2.steps.pop();
        store_published_version(
            db.conn(),
            "wf1",
            2,
            &v2,
            DefinitionSource::RustNative,
            None,
            200,
        )
        .unwrap();

        let exec = FsToolExecutor::new(&ws);
        // Explicit v1 runs the TWO-step definition even though v2 is published.
        let run = run_stored_workflow(db.conn(), &exec, "wf1", 1, "run-v1", SECRET, &deny_all, 300)
            .unwrap();
        assert_eq!(run.version, 1);
        assert_eq!(run.outcome.executed_steps, 2);
    }

    #[test]
    fn mutating_step_gate_pauses_and_the_workspace_is_unchanged() {
        // The S9 safety witness: a stored mutating step loaded from the DB still
        // checkpoints under deny-all — the run pauses, the write NEVER executes,
        // and the workspace file is NOT created.
        let db = Db::open_hub(&tmp_db("pause")).unwrap();
        let ws = tmp_workspace("pause-ws");
        store_published_version(
            db.conn(),
            "wf-ship",
            1,
            &mutating_def(),
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();

        let exec = FsToolExecutor::new(&ws);
        let run = run_stored_published_workflow(
            db.conn(),
            &exec,
            "wf-ship",
            "run1",
            SECRET,
            &deny_all,
            200,
        )
        .unwrap();

        match &run.outcome.status {
            WorkflowRunStatus::AwaitingCheckpoint { step_id, reason } => {
                assert_eq!(step_id, "run1:s1");
                assert!(reason.contains("mutating"), "reason: {reason}");
            }
            other => panic!("expected AwaitingCheckpoint, got {other:?}"),
        }
        assert_eq!(run.outcome.executed_steps, 1, "only the read step ran");
        assert!(
            !ws.join("out.txt").exists(),
            "the gate-paused write must NOT touch the workspace"
        );
        let summary = get_workflow_run_summary(db.conn(), "run1")
            .unwrap()
            .unwrap();
        assert_eq!(summary.state, "awaiting_checkpoint");
        let steps = list_workflow_step_summaries(db.conn(), "run1").unwrap();
        assert_eq!(steps[1].status, "pending");
        assert!(!steps[1].has_evidence);
        assert!(steps[1].has_side_effect);
    }

    #[test]
    fn missing_definition_or_version_fails_closed_before_any_run_row() {
        let db = Db::open_hub(&tmp_db("missing")).unwrap();
        let ws = tmp_workspace("missing-ws");
        let exec = FsToolExecutor::new(&ws);
        // Unknown workflow id.
        assert!(matches!(
            run_stored_workflow(db.conn(), &exec, "ghost", 1, "r1", SECRET, &deny_all, 100),
            Err(WorkflowDefError::NotFound(_))
        ));
        // Known id, missing version.
        create_definition(
            db.conn(),
            "wf1",
            1,
            &read_only_def(),
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();
        assert!(matches!(
            run_stored_workflow(db.conn(), &exec, "wf1", 9, "r2", SECRET, &deny_all, 200),
            Err(WorkflowDefError::NotFound(_))
        ));
        // No published version (v1 exists but is unpublished).
        assert!(matches!(
            run_stored_published_workflow(db.conn(), &exec, "wf1", "r3", SECRET, &deny_all, 300),
            Err(WorkflowDefError::NotFound(_))
        ));
        // Fail-closed BEFORE the run: no run row was ever created.
        assert!(get_workflow_run_summary(db.conn(), "r1").unwrap().is_none());
        assert!(get_workflow_run_summary(db.conn(), "r2").unwrap().is_none());
        assert!(get_workflow_run_summary(db.conn(), "r3").unwrap().is_none());
    }

    #[test]
    fn duplicate_run_id_fails_closed_single_shot_is_inherited() {
        let db = Db::open_hub(&tmp_db("dup")).unwrap();
        let ws = tmp_workspace("dup-ws");
        store_published_version(
            db.conn(),
            "wf1",
            1,
            &read_only_def(),
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();
        let exec = FsToolExecutor::new(&ws);
        run_stored_published_workflow(db.conn(), &exec, "wf1", "run1", SECRET, &deny_all, 200)
            .unwrap();
        // Re-dispatching the SAME run_id is a fail-closed dup (engine `create_run` PK).
        assert!(matches!(
            run_stored_published_workflow(db.conn(), &exec, "wf1", "run1", SECRET, &deny_all, 300),
            Err(WorkflowDefError::Storage(_))
        ));
    }
}
