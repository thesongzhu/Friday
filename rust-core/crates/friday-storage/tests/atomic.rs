//! Atomic multi-table write + token-ledger fallback semantics
//! (gate 21 §2.3 / §6, §8 Unit-2 integration test).

mod common;

use common::temp_db_path;
use friday_core::{ActivityState, ActivityType, LedgerEntry};
use friday_storage::{audit, ActivityRow, AuditEvent, Db, StorageError};

fn ledger(id: &str) -> LedgerEntry {
    LedgerEntry::friday_route(id, "s1", "a1", "deepseek-v4-flash", 11, 8, None, None, 100).unwrap()
}

fn activity(id: &str) -> ActivityRow {
    ActivityRow {
        activity_id: id.into(),
        session_id: Some("s1".into()),
        kind: ActivityType::AskReceipt,
        state: ActivityState::Done,
        summary: "ask done".into(),
        created_at: 100,
        updated_at: 100,
        deep_link: None,
    }
}

fn audit_event(id: &str) -> AuditEvent {
    AuditEvent {
        audit_id: id.into(),
        actor: "friday".into(),
        action: "model_call".into(),
        payload_ref: None,
        created_at: 100,
    }
}

#[test]
fn token_ledger_records_fallback_false_and_computed_total() {
    let p = temp_db_path("ledger");
    let db = Db::open_hub(&p).unwrap();
    db.insert_token_ledger(&ledger("l1")).unwrap();
    let (fallback, total): (i64, i64) = db
        .conn()
        .query_row(
            "SELECT fallback, total_tokens FROM token_ledger WHERE ledger_id = 'l1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(fallback, 0, "Friday route must ledger fallback = 0");
    assert_eq!(total, 19);
}

#[test]
fn record_model_call_writes_all_three_atomically() {
    let p = temp_db_path("atomic-ok");
    let mut db = Db::open_hub(&p).unwrap();
    db.record_model_call(&ledger("l1"), &activity("a1"), &audit_event("au1"))
        .unwrap();
    assert_eq!(db.count("token_ledger").unwrap(), 1);
    assert_eq!(db.count("activity_item").unwrap(), 1);
    assert_eq!(db.count("audit_ledger").unwrap(), 1);
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 1);
}

#[test]
fn record_model_call_rolls_back_all_three_on_failure() {
    let p = temp_db_path("atomic-fail");
    let mut db = Db::open_hub(&p).unwrap();

    // Seed an audit row whose id the call will collide with (PK clash on the
    // third insert), forcing the whole transaction to roll back.
    {
        let tx = db.conn_mut().transaction().unwrap();
        audit::append_audit(&tx, "dup", "x", "seed", None, 1).unwrap();
        tx.commit().unwrap();
    }

    let res = db.record_model_call(&ledger("l1"), &activity("a1"), &audit_event("dup"));
    assert!(res.is_err(), "duplicate audit_id must fail the call");

    // None of the three writes persisted; only the seed audit row remains.
    assert_eq!(db.count("token_ledger").unwrap(), 0);
    assert_eq!(db.count("activity_item").unwrap(), 0);
    assert_eq!(db.count("audit_ledger").unwrap(), 1);
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 1);
}

#[test]
fn record_run_model_call_writes_run_attributed_ledger_activity_audit() {
    // S1.2 loop-billing sibling of record_model_call: same atomic 3-write, but the
    // token_ledger row carries the owning run_id (run-attributable), and it works off a
    // bare &Connection (the agent loop holds the conn by shared ref).
    let p = temp_db_path("run-atomic-ok");
    let db = Db::open_hub(&p).unwrap();
    friday_storage::record_run_model_call(
        db.conn(),
        "run-1",
        &ledger("l1"),
        &activity("a1"),
        &audit_event("au1"),
    )
    .unwrap();
    assert_eq!(db.count("token_ledger").unwrap(), 1);
    assert_eq!(db.count("activity_item").unwrap(), 1);
    assert_eq!(db.count("audit_ledger").unwrap(), 1);
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 1);
    // The ledger row is attributed to the run (the S1.2 column).
    let run_id: Option<String> = db
        .conn()
        .query_row(
            "SELECT run_id FROM token_ledger WHERE ledger_id = 'l1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(run_id.as_deref(), Some("run-1"));
    // run-scoped total sees this row; a different run sees nothing.
    let mine = friday_storage::agent_run_read::run_token_totals(db.conn(), "run-1").unwrap();
    assert_eq!(mine.total, 19);
    let other = friday_storage::agent_run_read::run_token_totals(db.conn(), "run-X").unwrap();
    assert_eq!(other.total, 0);
}

#[test]
fn record_run_model_call_rolls_back_all_three_on_failure() {
    let p = temp_db_path("run-atomic-fail");
    let db = Db::open_hub(&p).unwrap();
    // Seed an audit row whose id the call collides with (PK clash on the audit insert),
    // forcing the whole transaction to roll back — no half-billed run row.
    {
        let tx = db.conn().unchecked_transaction().unwrap();
        audit::append_audit(&tx, "dup", "x", "seed", None, 1).unwrap();
        tx.commit().unwrap();
    }
    let res = friday_storage::record_run_model_call(
        db.conn(),
        "run-1",
        &ledger("l1"),
        &activity("a1"),
        &audit_event("dup"),
    );
    assert!(res.is_err(), "duplicate audit_id must fail the call");
    assert_eq!(db.count("token_ledger").unwrap(), 0);
    assert_eq!(db.count("activity_item").unwrap(), 0);
    assert_eq!(db.count("audit_ledger").unwrap(), 1);
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 1);
}

#[test]
fn ask_path_row_has_null_run_id_and_is_excluded_from_run_totals() {
    // Backward-safety: the ask path (insert_token_ledger / record_model_call) writes
    // NULL run_id, so an additive run_id column never mis-attributes ask-path billing to
    // any run, and db_wide_token_totals still sees every row.
    let p = temp_db_path("null-run");
    let mut db = Db::open_hub(&p).unwrap();
    db.record_model_call(&ledger("ask1"), &activity("aa1"), &audit_event("aau1"))
        .unwrap();
    let run_id: Option<String> = db
        .conn()
        .query_row(
            "SELECT run_id FROM token_ledger WHERE ledger_id = 'ask1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(run_id, None, "ask-path row carries no run attribution");
    let wide = friday_storage::agent_run_read::db_wide_token_totals(db.conn()).unwrap();
    assert_eq!(wide.total, 19, "db-wide total still sees the ask-path row");
    let run = friday_storage::agent_run_read::run_token_totals(db.conn(), "run-1").unwrap();
    assert_eq!(run.total, 0, "no run owns the ask-path row");
}

#[test]
fn record_model_call_rejected_on_phone_profile() {
    let p = temp_db_path("atomic-phone");
    let mut db = Db::open_phone(&p).unwrap();
    let res = db.record_model_call(&ledger("l1"), &activity("a1"), &audit_event("au1"));
    assert!(matches!(res, Err(StorageError::Unsupported(_))));
}

#[test]
fn record_event_writes_activity_and_audit_then_replay_writes_nothing() {
    let p = temp_db_path("event-replay");
    let mut db = Db::open_hub(&p).unwrap();

    let recorded = db
        .record_event(&activity("evt-1"), &audit_event("evt-1"))
        .unwrap();
    assert_eq!(recorded, friday_storage::RecordEventOutcome::Recorded);
    assert_eq!(db.count("activity_item").unwrap(), 1);
    assert_eq!(db.count("audit_ledger").unwrap(), 1);
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 1);

    let replayed = db
        .record_event(&activity("evt-1"), &audit_event("evt-1-replay"))
        .unwrap();
    assert_eq!(replayed, friday_storage::RecordEventOutcome::Duplicate);
    assert_eq!(db.count("activity_item").unwrap(), 1);
    assert_eq!(
        db.count("audit_ledger").unwrap(),
        1,
        "replay must not append a second audit row"
    );
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 1);
}

#[test]
fn record_event_is_hub_only() {
    let p = temp_db_path("event-phone");
    let mut db = Db::open_phone(&p).unwrap();
    let res = db.record_event(&activity("evt-1"), &audit_event("evt-1"));
    assert!(matches!(res, Err(StorageError::Unsupported(_))));
    assert_eq!(db.count("activity_item").unwrap(), 0);
}
