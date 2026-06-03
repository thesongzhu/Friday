//! Step-5 — the workflow EXECUTION engine (operator-authorized: orchestrates the
//! already-proven BUILT-IN tools through the existing gate, NOT imported code).
//!
//! `run_workflow` drives a [`crate::planner::WorkflowDefinition`] semi-automatically
//! (`08` §4): it AUTO-ADVANCES the planner-`AutoAdvance` (read-only, gate-safe) steps
//! and PAUSES at the first step the planner marks a checkpoint (mutating / high-risk /
//! template-policy / unclassifiable) — that step is registered but NOT executed; the
//! run goes `AwaitingCheckpoint` (resumable; resume is a documented follow-up).
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
//! - Run-state moves only through `set_run_state`'s SM guard + run-completion gate
//!   (`08` §6 / #471): the run cannot reach `Done` while a side-effect step is
//!   unverified, and an executed step is completed WITH its tool receipt as evidence.
//! - Single-shot: `run_workflow` creates the run; re-invoking with the same `run_id`
//!   fails closed at `create_run` (dup PK) — no double-dispatch. Resume = deferred.
//!
//! HONEST SCOPE: this advances `workflow_runtime_run_step_acceptance` toward wired
//! (read-only auto-advance + checkpoint-pause + evidence-gated completion). The full
//! engine (resume after approval, NL generation, skills) stays NO-GO; v1 NO-GO.

use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
use friday_core::WorkflowRunState;
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

/// Drive a workflow definition: auto-advance gate-safe steps, pause at the first
/// checkpoint. Creates the run (single-shot), records each step, and routes every
/// executed step through the shared [`gate_dispatch`]. See the module docs for the
/// security spine.
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

    let mut executed_steps = 0usize;
    for (seq, step) in def.steps.iter().enumerate() {
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
                    executed_steps,
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
                        executed_steps += 1;
                    }
                    GateDispatch::ExecError(e) => {
                        // Gate-Allowed but the tool failed: no evidence → not verified; run Failed.
                        workflow::complete_step(conn, &step_id, None, false, now_ms)?;
                        workflow::set_run_state(conn, run_id, WorkflowRunState::Failed, now_ms)?;
                        return Ok(WorkflowOutcome {
                            status: WorkflowRunStatus::Failed {
                                step_id,
                                reason: format!("exec_error:{e}"),
                            },
                            executed_steps,
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
                            executed_steps,
                        });
                    }
                    GateDispatch::Denied(reason) => {
                        workflow::set_run_state(conn, run_id, WorkflowRunState::Failed, now_ms)?;
                        return Ok(WorkflowOutcome {
                            status: WorkflowRunStatus::Failed {
                                step_id,
                                reason: format!("denied:{reason}"),
                            },
                            executed_steps,
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
                            executed_steps,
                        });
                    }
                }
            }
        }
    }

    // All steps auto-advanced. `set_run_state(Done)` enforces the completion gate
    // (refuses Done if any side-effect step is unverified).
    workflow::set_run_state(conn, run_id, WorkflowRunState::Done, now_ms)?;
    Ok(WorkflowOutcome {
        status: WorkflowRunStatus::Completed,
        executed_steps,
    })
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
}
