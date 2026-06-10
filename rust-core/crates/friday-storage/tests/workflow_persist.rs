//! Unit-9 workflow persistence: a REAL forward migration (v1 -> v2 adds the
//! workflow tables, preserving existing data), the run state machine persisted,
//! and evidence-gated step completion persisted (`08` §6 / `10` §6).

mod common;

use common::temp_db_path;
use friday_core::{SessionState, StepStatus, WorkflowRunState};
use friday_storage::{hub_migrations, workflow, Db, Profile};

#[test]
fn forward_migration_v1_to_v2_adds_workflow_tables_preserving_data() {
    let p = temp_db_path("wf-mig");
    // Open at v1 only (init_hub), seed a row.
    {
        let mut migs = hub_migrations();
        migs.truncate(1); // keep only 0001_init_hub
        let db = Db::open(&p, Profile::Hub, &migs, "v1").unwrap();
        assert_eq!(db.version().unwrap(), 1);
        assert!(
            !db.table_names()
                .unwrap()
                .iter()
                .any(|t| t == "workflow_run"),
            "workflow tables must not exist at v1"
        );
        db.insert_session(
            "s1",
            "friday_ask",
            "hi",
            SessionState::Created,
            1,
            1,
            "mac_live",
        )
        .unwrap();
    }
    // Reopen with the v2 set -> forward-migrate v1 -> v2 in isolation (truncating
    // to 2 keeps this test pinned to the workflow migration, independent of later
    // migrations such as 0003).
    let mut migs2 = hub_migrations();
    migs2.truncate(2);
    let db = Db::open(&p, Profile::Hub, &migs2, "v2").unwrap();
    assert_eq!(db.version().unwrap(), 2);
    let tables = db.table_names().unwrap();
    assert!(tables.iter().any(|t| t == "workflow_run"));
    assert!(tables.iter().any(|t| t == "workflow_step"));
    // Pre-existing data survived the migration.
    assert_eq!(db.count("session").unwrap(), 1);
}

#[test]
fn run_state_machine_is_persisted_and_validated() {
    let p = temp_db_path("wf-run");
    let db = Db::open_hub(&p).unwrap();
    workflow::create_run(db.conn(), "r1", "QA", 1).unwrap();
    assert_eq!(
        workflow::run_state(db.conn(), "r1").unwrap(),
        Some(WorkflowRunState::Pending)
    );
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Running, 2).unwrap();
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Done, 3).unwrap();
    assert_eq!(
        workflow::run_state(db.conn(), "r1").unwrap(),
        Some(WorkflowRunState::Done)
    );

    // Invalid transition (Pending -> Done) is rejected by the state machine.
    workflow::create_run(db.conn(), "r2", "x", 1).unwrap();
    assert!(workflow::set_run_state(db.conn(), "r2", WorkflowRunState::Done, 2).is_err());
}

#[test]
fn run_control_state_classifies_resumable_and_terminal_for_the_r2_control_plane() {
    // The additive R2 read helper: the dark run-control plane's fail-closed
    // precheck. It must classify ONLY AwaitingCheckpoint as resumable (NOT
    // Pending — a fresh start is not a resume), and Done/Failed as terminal,
    // single-sourced with the friday-core machine. An unknown run is None.
    let p = temp_db_path("wf-ctl-state");
    let db = Db::open_hub(&p).unwrap();

    // Unknown run → None (the control layer surfaces a not-found error).
    assert!(workflow::run_control_state(db.conn(), "ghost")
        .unwrap()
        .is_none());

    workflow::create_run(db.conn(), "r1", "QA", 1).unwrap();
    // Pending: NOT resumable (a resume is re-entry of a PAUSED run, not a start),
    // not terminal.
    let s = workflow::run_control_state(db.conn(), "r1")
        .unwrap()
        .unwrap();
    assert_eq!(s.state, WorkflowRunState::Pending);
    assert!(!s.resumable, "Pending is a fresh start, not a resume");
    assert!(!s.terminal);

    // Running: not resumable, not terminal.
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Running, 2).unwrap();
    let s = workflow::run_control_state(db.conn(), "r1")
        .unwrap()
        .unwrap();
    assert!(!s.resumable);
    assert!(!s.terminal);

    // AwaitingCheckpoint: the ONLY resumable state.
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::AwaitingCheckpoint, 3).unwrap();
    let s = workflow::run_control_state(db.conn(), "r1")
        .unwrap()
        .unwrap();
    assert_eq!(s.state, WorkflowRunState::AwaitingCheckpoint);
    assert!(s.resumable, "an AwaitingCheckpoint run is resumable");
    assert!(!s.terminal);

    // Done (terminal): not resumable.
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Running, 4).unwrap();
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Done, 5).unwrap();
    let s = workflow::run_control_state(db.conn(), "r1")
        .unwrap()
        .unwrap();
    assert!(!s.resumable);
    assert!(s.terminal, "Done is terminal");

    // Failed (terminal): not resumable.
    workflow::create_run(db.conn(), "r2", "x", 1).unwrap();
    workflow::set_run_state(db.conn(), "r2", WorkflowRunState::Failed, 2).unwrap();
    let s = workflow::run_control_state(db.conn(), "r2")
        .unwrap()
        .unwrap();
    assert!(!s.resumable);
    assert!(s.terminal, "Failed is terminal");
}

#[test]
fn run_cannot_be_done_while_a_side_effect_step_is_proof_pending() {
    // The file-32 deferral, closed: persistence + per-step gating alone let a run
    // reach Done with an unverified side-effect step. This is the discriminating
    // test — "the transition is allowed" is NOT proof; we prove the unverified-step
    // run is refused, and that attaching evidence then unblocks it.
    let p = temp_db_path("wf-run-gate");
    let db = Db::open_hub(&p).unwrap();
    workflow::create_run(db.conn(), "r1", "QA", 1).unwrap();
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Running, 2).unwrap();

    // A side-effect step left ProofPending (model claimed done, no evidence).
    workflow::add_step(db.conn(), "st1", "r1", 1, true, 1).unwrap();
    assert_eq!(
        workflow::complete_step(db.conn(), "st1", None, true, 3).unwrap(),
        StepStatus::ProofPending
    );

    // -> Done is REFUSED while the side-effect step is unverified.
    assert!(
        workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Done, 4).is_err(),
        "a run with a ProofPending side-effect step must not be marked Done"
    );
    // The run did not silently advance — it is still Running.
    assert_eq!(
        workflow::run_state(db.conn(), "r1").unwrap(),
        Some(WorkflowRunState::Running)
    );

    // Evidence arrives -> the step verifies -> the SAME -> Done transition is now allowed.
    assert_eq!(
        workflow::complete_step(db.conn(), "st1", Some("evidence://receipt"), false, 5).unwrap(),
        StepStatus::Verified
    );
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Done, 6).unwrap();
    assert_eq!(
        workflow::run_state(db.conn(), "r1").unwrap(),
        Some(WorkflowRunState::Done)
    );
}

#[test]
fn run_with_all_side_effects_verified_can_be_done_even_with_an_incomplete_pure_step() {
    // Non-side-effect steps do not gate run completion (they complete on a model
    // result; the engine, not this gate, decides when their work is done).
    let p = temp_db_path("wf-run-gate-pure");
    let db = Db::open_hub(&p).unwrap();
    workflow::create_run(db.conn(), "r1", "QA", 1).unwrap();
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Running, 2).unwrap();

    workflow::add_step(db.conn(), "se", "r1", 1, true, 1).unwrap();
    workflow::complete_step(db.conn(), "se", Some("evidence://ok"), false, 3).unwrap();
    // A pure (no-side-effect) step that is still Pending must NOT block Done.
    workflow::add_step(db.conn(), "pure", "r1", 2, false, 1).unwrap();

    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Done, 4).unwrap();
    assert_eq!(
        workflow::run_state(db.conn(), "r1").unwrap(),
        Some(WorkflowRunState::Done)
    );
}

#[test]
fn failed_side_effect_step_blocks_done_through_the_single_write_api() {
    // A `Failed` side-effect step must also block `-> Done` (the run must go to
    // Failed, not Done). No public API yet produces a Failed step (that lands with
    // the engine slice), so we inject the failed status directly via raw SQL — the
    // gate must already defend against it. Scope of the "unrepresentable" claim: the
    // only *typed repo API* that sets run state is `set_run_state`, and it is gated;
    // `create_run` only ever writes `Pending`. Raw `Db::conn()` access (used here to
    // inject the otherwise-unreachable Failed step) is deliberately out of scope —
    // the guarantee holds at the typed-API layer, not against arbitrary raw SQL.
    let p = temp_db_path("wf-run-gate-failed");
    let db = Db::open_hub(&p).unwrap();
    workflow::create_run(db.conn(), "r1", "QA", 1).unwrap();
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Running, 2).unwrap();
    workflow::add_step(db.conn(), "st1", "r1", 1, true, 1).unwrap();
    // Inject a Failed side-effect step state directly (no fail-step API yet).
    db.conn()
        .execute(
            "UPDATE workflow_step SET status = 'failed' WHERE step_id = 'st1'",
            [],
        )
        .unwrap();

    assert!(
        workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Done, 3).is_err(),
        "a run with a Failed side-effect step must not be marked Done"
    );
    // But the run CAN legitimately transition to Failed.
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Failed, 4).unwrap();
    assert_eq!(
        workflow::run_state(db.conn(), "r1").unwrap(),
        Some(WorkflowRunState::Failed)
    );
}

#[test]
fn evidence_gated_step_completion_is_persisted() {
    let p = temp_db_path("wf-step");
    let db = Db::open_hub(&p).unwrap();
    workflow::create_run(db.conn(), "r1", "QA", 1).unwrap();

    // Side-effect step, NO evidence, model claims done -> ProofPending (NOT Verified).
    workflow::add_step(db.conn(), "st1", "r1", 1, true, 1).unwrap();
    assert_eq!(
        workflow::complete_step(db.conn(), "st1", None, true, 2).unwrap(),
        StepStatus::ProofPending
    );
    assert_eq!(
        workflow::step_status(db.conn(), "st1").unwrap(),
        Some(StepStatus::ProofPending)
    );

    // Side-effect step WITH evidence -> Verified.
    workflow::add_step(db.conn(), "st2", "r1", 2, true, 1).unwrap();
    assert_eq!(
        workflow::complete_step(db.conn(), "st2", Some("evidence://receipt-1"), false, 3).unwrap(),
        StepStatus::Verified
    );
    assert!(workflow::step_status(db.conn(), "st2")
        .unwrap()
        .unwrap()
        .is_complete());

    // No-side-effect step may complete on a model result.
    workflow::add_step(db.conn(), "st3", "r1", 3, false, 1).unwrap();
    assert_eq!(
        workflow::complete_step(db.conn(), "st3", None, true, 4).unwrap(),
        StepStatus::Verified
    );

    // evidence_ref is stored only for the evidence-verified step.
    let ev2: Option<String> = db
        .conn()
        .query_row(
            "SELECT evidence_ref FROM workflow_step WHERE step_id = 'st2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ev2.as_deref(), Some("evidence://receipt-1"));
    let ev1: Option<String> = db
        .conn()
        .query_row(
            "SELECT evidence_ref FROM workflow_step WHERE step_id = 'st1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        ev1, None,
        "ProofPending step must not carry an evidence_ref"
    );
}

#[test]
fn proof_pending_verifies_when_evidence_arrives_but_verified_cannot_downgrade() {
    let p = temp_db_path("wf-terminal");
    let db = Db::open_hub(&p).unwrap();
    workflow::create_run(db.conn(), "r1", "QA", 1).unwrap();

    // Side-effect step completes with no evidence yet -> ProofPending (non-terminal).
    workflow::add_step(db.conn(), "st1", "r1", 1, true, 1).unwrap();
    assert_eq!(
        workflow::complete_step(db.conn(), "st1", None, true, 2).unwrap(),
        StepStatus::ProofPending
    );

    // Evidence arrives later -> the SAME step now verifies (ProofPending is not terminal).
    assert_eq!(
        workflow::complete_step(db.conn(), "st1", Some("evidence://late"), false, 3).unwrap(),
        StepStatus::Verified
    );
    let ev: Option<String> = db
        .conn()
        .query_row(
            "SELECT evidence_ref FROM workflow_step WHERE step_id = 'st1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ev.as_deref(), Some("evidence://late"));

    // A second completion with NO evidence must NOT downgrade a Verified step.
    assert!(
        workflow::complete_step(db.conn(), "st1", None, true, 4).is_err(),
        "a terminal (Verified) step must not be re-completable"
    );
    assert_eq!(
        workflow::step_status(db.conn(), "st1").unwrap(),
        Some(StepStatus::Verified)
    );
    // The evidence_ref survived the rejected downgrade attempt.
    let ev_after: Option<String> = db
        .conn()
        .query_row(
            "SELECT evidence_ref FROM workflow_step WHERE step_id = 'st1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ev_after.as_deref(), Some("evidence://late"));
}

// --- R2 slice-2 run-control persistence (cancel / retry primitives) ----------

#[test]
fn cancel_run_writes_terminal_cancelled_with_reason_and_never_coerces_to_failed() {
    // The cancel primitive writes the NEW terminal `Cancelled` state (NOT Failed),
    // records the reason atomically, and — the data-fudge guard — reads back as
    // Cancelled (the parse_run_state round-trip), distinct from Failed.
    let p = temp_db_path("wf-cancel");
    let db = Db::open_hub(&p).unwrap();
    workflow::create_run(db.conn(), "r1", "QA", 1).unwrap();
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Running, 2).unwrap();

    workflow::cancel_run(db.conn(), "r1", Some("operator requested"), 3).unwrap();
    assert_eq!(
        workflow::run_state(db.conn(), "r1").unwrap(),
        Some(WorkflowRunState::Cancelled),
        "cancel writes terminal Cancelled, NOT Failed"
    );
    assert_ne!(
        workflow::run_state(db.conn(), "r1").unwrap(),
        Some(WorkflowRunState::Failed),
        "the cancelled/failed distinction is preserved end-to-end"
    );
    assert_eq!(
        workflow::run_cancel_reason(db.conn(), "r1").unwrap(),
        Some("operator requested".to_string())
    );
    // The raw column stores the exact string "cancelled" (not "failed").
    let raw: String = db
        .conn()
        .query_row(
            "SELECT state FROM workflow_run WHERE run_id = 'r1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(raw, "cancelled");
}

#[test]
fn cancel_run_fail_closed_on_terminal_and_unknown_runs() {
    let p = temp_db_path("wf-cancel-closed");
    let db = Db::open_hub(&p).unwrap();
    // Unknown run -> error, no write.
    assert!(workflow::cancel_run(db.conn(), "ghost", None, 1).is_err());

    // A terminal Done run cannot be cancelled (no Done -> Cancelled edge).
    workflow::create_run(db.conn(), "r-done", "QA", 1).unwrap();
    workflow::set_run_state(db.conn(), "r-done", WorkflowRunState::Running, 2).unwrap();
    workflow::set_run_state(db.conn(), "r-done", WorkflowRunState::Done, 3).unwrap();
    assert!(
        workflow::cancel_run(db.conn(), "r-done", Some("too late"), 4).is_err(),
        "a terminal Done run is not cancellable"
    );
    assert_eq!(
        workflow::run_state(db.conn(), "r-done").unwrap(),
        Some(WorkflowRunState::Done),
        "the terminal run is untouched by the refused cancel"
    );

    // A terminal Failed run cannot be cancelled (preserves failed, never coerced).
    workflow::create_run(db.conn(), "r-failed", "QA", 1).unwrap();
    workflow::set_run_state(db.conn(), "r-failed", WorkflowRunState::Failed, 2).unwrap();
    assert!(workflow::cancel_run(db.conn(), "r-failed", None, 3).is_err());
    assert_eq!(
        workflow::run_state(db.conn(), "r-failed").unwrap(),
        Some(WorkflowRunState::Failed)
    );

    // A cancelled run cannot be re-cancelled (Cancelled is terminal).
    workflow::create_run(db.conn(), "r-cx", "QA", 1).unwrap();
    workflow::set_run_state(db.conn(), "r-cx", WorkflowRunState::Running, 2).unwrap();
    workflow::cancel_run(db.conn(), "r-cx", Some("first"), 3).unwrap();
    assert!(workflow::cancel_run(db.conn(), "r-cx", Some("again"), 4).is_err());
    assert_eq!(
        workflow::run_cancel_reason(db.conn(), "r-cx").unwrap(),
        Some("first".to_string()),
        "the original reason is preserved; a re-cancel writes nothing"
    );
}

#[test]
fn reopen_step_accepts_real_engine_frontier_states_and_refuses_verified() {
    // The retry primitive reopens the NON-Verified frontier step (-> Pending,
    // attempt += 1) so a re-drive can re-dispatch + re-complete it. CRITICAL: the
    // engine never persists a `Failed` STEP status — a failed run's frontier is
    // ProofPending (side-effect exec-error) / Running (pure exec-error) / Pending
    // (denied checkpoint), so those are the states that must be retryable. Only a
    // `Verified` step is refused (completed work must not be silently redone).
    let p = temp_db_path("wf-reopen-step");
    let db = Db::open_hub(&p).unwrap();
    workflow::create_run(db.conn(), "r1", "QA", 1).unwrap();

    // Frontier as ProofPending (the real side-effect exec-error state): retryable.
    workflow::add_step(db.conn(), "st1", "r1", 1, true, 1).unwrap();
    assert_eq!(workflow::step_attempt(db.conn(), "st1").unwrap(), Some(1)); // m0027 base
    workflow::complete_step(db.conn(), "st1", None, false, 2).unwrap(); // -> ProofPending
    assert_eq!(
        workflow::step_status(db.conn(), "st1").unwrap(),
        Some(StepStatus::ProofPending)
    );
    let a = workflow::reopen_failed_step(db.conn(), "st1", 3).unwrap();
    assert_eq!(
        a, 2,
        "attempt bumped to 2 on the first retry of a ProofPending step"
    );
    assert_eq!(
        workflow::step_status(db.conn(), "st1").unwrap(),
        Some(StepStatus::Pending),
        "reopened step is back to Pending (so complete_step accepts it again)"
    );

    // Frontier still Pending (denied-checkpoint state): retryable too.
    workflow::add_step(db.conn(), "st2", "r1", 2, true, 1).unwrap();
    assert_eq!(
        workflow::reopen_failed_step(db.conn(), "st2", 4).unwrap(),
        2
    );

    // A Verified step is REFUSED — completed (evidence-verified) work is not re-driveable.
    workflow::add_step(db.conn(), "st3", "r1", 3, true, 1).unwrap();
    workflow::complete_step(db.conn(), "st3", Some("evidence://done"), false, 5).unwrap();
    assert_eq!(
        workflow::step_status(db.conn(), "st3").unwrap(),
        Some(StepStatus::Verified)
    );
    assert!(
        workflow::reopen_failed_step(db.conn(), "st3", 6).is_err(),
        "a Verified step is not re-driveable on retry"
    );

    // The injected-only `Failed` step status is also accepted (defensive).
    db.conn()
        .execute(
            "UPDATE workflow_step SET status = 'failed', evidence_ref = 'stale' WHERE step_id = 'st2'",
            [],
        )
        .unwrap();
    let a2 = workflow::reopen_failed_step(db.conn(), "st2", 7).unwrap();
    assert_eq!(a2, 3, "attempt accumulates across retries");
    // The stale evidence_ref from the failed attempt is cleared (a fresh attempt re-earns it).
    let ev: Option<String> = db
        .conn()
        .query_row(
            "SELECT evidence_ref FROM workflow_step WHERE step_id = 'st2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ev, None, "stale evidence cleared on reopen");

    // Unknown step -> fail-closed.
    assert!(workflow::reopen_failed_step(db.conn(), "ghost", 8).is_err());
}
