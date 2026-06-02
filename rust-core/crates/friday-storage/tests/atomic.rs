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
fn record_model_call_rejected_on_phone_profile() {
    let p = temp_db_path("atomic-phone");
    let mut db = Db::open_phone(&p).unwrap();
    let res = db.record_model_call(&ledger("l1"), &activity("a1"), &audit_event("au1"));
    assert!(matches!(res, Err(StorageError::Unsupported(_))));
}
