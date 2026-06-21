//! A1 run-outcome learning candidate persistence.

mod common;

use common::temp_db_path;
use friday_storage::learning_candidate::{self, RunOutcomeLearningKind, RunOutcomeLearningState};
use friday_storage::{hub_migrations, Db, Profile, StorageError, HUB_ONLY_TABLES};

fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

#[test]
fn run_outcome_learning_candidate_is_hub_only_and_forward_migrated() {
    assert!(HUB_ONLY_TABLES.contains(&"run_outcome_learning_candidate"));

    let p = temp_db_path("a1-learning-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version < 38);
        let db = Db::open(&p, Profile::Hub, &migs, "pre-a1").unwrap();
        assert_eq!(db.version().unwrap(), 37);
        assert!(!db
            .table_names()
            .unwrap()
            .iter()
            .any(|t| t == "run_outcome_learning_candidate"));
    }

    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    assert!(db
        .table_names()
        .unwrap()
        .iter()
        .any(|t| t == "run_outcome_learning_candidate"));

    let phone = Db::open_phone(&temp_db_path("a1-learning-phone")).unwrap();
    assert!(!phone
        .table_names()
        .unwrap()
        .iter()
        .any(|t| t == "run_outcome_learning_candidate"));
}

#[test]
fn record_candidates_is_refs_only_pending_and_idempotent_per_run() {
    let db = Db::open_hub(&temp_db_path("a1-learning-record")).unwrap();

    let inserted = learning_candidate::record_run_outcome_candidates(
        db.conn(),
        "run-a1",
        Some("sess-a1"),
        2,
        1,
        10_000,
    )
    .unwrap();
    assert_eq!(inserted, 3);

    let duplicate = learning_candidate::record_run_outcome_candidates(
        db.conn(),
        "run-a1",
        Some("sess-a1"),
        99,
        99,
        20_000,
    )
    .unwrap();
    assert_eq!(duplicate, 0, "same run fan-out is idempotent");

    let rows =
        learning_candidate::list_run_outcome_candidates_for_run(db.conn(), "run-a1").unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter().map(|r| r.kind).collect::<Vec<_>>(),
        vec![
            RunOutcomeLearningKind::Preference,
            RunOutcomeLearningKind::Reflex,
            RunOutcomeLearningKind::WorldModel,
        ]
    );
    for row in rows {
        assert_eq!(row.state, RunOutcomeLearningState::Pending);
        assert_eq!(row.evidence_ref, "friday://agent-run/run-a1");
        assert!(row.summary.contains("turns=2"));
        assert!(row.summary.contains("executed_tools=1"));
        assert!(row.summary.contains("refs_only=true"));
        assert!(row.summary.contains("confirm_required=true"));
        assert!(!format!("{row:?}").contains("PONG"));
    }
}

#[test]
fn record_candidates_builds_distinct_kind_signals_without_body_text() {
    let db = Db::open_hub(&temp_db_path("a1-learning-kind-signals")).unwrap();

    learning_candidate::record_run_outcome_candidates(
        db.conn(),
        "run-kind-signals",
        Some("sess-kind-signals"),
        4,
        2,
        10_000,
    )
    .unwrap();

    let rows =
        learning_candidate::list_run_outcome_candidates_for_run(db.conn(), "run-kind-signals")
            .unwrap();
    let preference = rows
        .iter()
        .find(|row| row.kind == RunOutcomeLearningKind::Preference)
        .unwrap();
    let reflex = rows
        .iter()
        .find(|row| row.kind == RunOutcomeLearningKind::Reflex)
        .unwrap();
    let world_model = rows
        .iter()
        .find(|row| row.kind == RunOutcomeLearningKind::WorldModel)
        .unwrap();

    assert!(preference.summary.contains("candidate_kind=preference"));
    assert!(preference.summary.contains("consumer=recall-preference"));
    assert!(reflex.summary.contains("candidate_kind=reflex"));
    assert!(reflex.summary.contains("consumer=governance-only"));
    assert!(world_model.summary.contains("candidate_kind=world_model"));
    assert!(world_model.summary.contains("consumer=recall-world-model"));
    assert_ne!(preference.summary, reflex.summary);
    assert_ne!(preference.summary, world_model.summary);
    assert!(rows.iter().all(|row| !row.summary.contains("PONG")));
}

#[test]
fn explicit_decision_confirms_or_rejects_once() {
    let db = Db::open_hub(&temp_db_path("a1-learning-decide")).unwrap();
    learning_candidate::record_run_outcome_candidates(
        db.conn(),
        "run-decision",
        Some("sess-decision"),
        1,
        0,
        1_000,
    )
    .unwrap();

    let next = learning_candidate::decide_run_outcome_candidate(
        db.conn(),
        "a1:run-decision:preference",
        true,
        2_000,
        Some("operator confirmed"),
    )
    .unwrap();
    assert_eq!(next, RunOutcomeLearningState::Confirmed);

    let row =
        learning_candidate::get_run_outcome_candidate(db.conn(), "a1:run-decision:preference")
            .unwrap()
            .unwrap();
    assert_eq!(row.state, RunOutcomeLearningState::Confirmed);
    assert_eq!(row.decided_at_ms, Some(2_000));
    assert_eq!(row.decision_reason.as_deref(), Some("operator confirmed"));

    let err = learning_candidate::decide_run_outcome_candidate(
        db.conn(),
        "a1:run-decision:preference",
        false,
        3_000,
        None,
    )
    .unwrap_err();
    assert!(matches!(err, StorageError::Unsupported(_)));
}
