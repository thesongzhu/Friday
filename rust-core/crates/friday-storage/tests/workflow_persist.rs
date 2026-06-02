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
