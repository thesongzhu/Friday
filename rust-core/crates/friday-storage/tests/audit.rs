//! Append-only audit ledger tests: sequential chain integrity + tamper/delete
//! detection (gate 21 §2.3 / §8 Unit-2 audit tests).
//!
//! Scope: sequential append integrity. True multi-writer concurrency is a Hub
//! runtime concern (Unit 4) and is not asserted here.

mod common;

use common::temp_db_path;
use friday_storage::{audit, Db, StorageError};

fn append(db: &mut Db, id: &str, action: &str, ts: i64) {
    let tx = db.conn_mut().transaction().unwrap();
    audit::append_audit(&tx, id, "operator", action, None, ts).unwrap();
    tx.commit().unwrap();
}

#[test]
fn sequential_chain_verifies() {
    let p = temp_db_path("audit-seq");
    let mut db = Db::open_hub(&p).unwrap();
    for i in 0..50 {
        append(&mut db, &format!("au{i}"), "model_call", i);
    }
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 50);
}

#[test]
fn multiple_appends_in_one_transaction_keep_chain_gap_free() {
    // Gate 21 §8: "concurrent-append keeps the chain gap-free within the
    // transaction." Several appends inside ONE transaction must each see the
    // previous (still-uncommitted) entry's hash, so the chain has no gap.
    let p = temp_db_path("audit-one-tx");
    let mut db = Db::open_hub(&p).unwrap();
    {
        let tx = db.conn_mut().transaction().unwrap();
        audit::append_audit(&tx, "t0", "friday", "model_call", None, 0).unwrap();
        audit::append_audit(&tx, "t1", "friday", "model_call", None, 1).unwrap();
        audit::append_audit(&tx, "t2", "friday", "revoke", Some("blob:1"), 2).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 3);
}

#[test]
fn mutating_a_row_breaks_the_chain() {
    let p = temp_db_path("audit-mut");
    let mut db = Db::open_hub(&p).unwrap();
    append(&mut db, "au0", "pairing", 0);
    append(&mut db, "au1", "model_call", 1);
    append(&mut db, "au2", "revoke", 2);
    assert!(audit::verify_audit_chain(db.conn()).is_ok());

    // Tamper with a recorded action after the fact.
    db.conn()
        .execute(
            "UPDATE audit_ledger SET action = 'tampered' WHERE audit_id = 'au1'",
            [],
        )
        .unwrap();

    match audit::verify_audit_chain(db.conn()) {
        Err(StorageError::AuditChainBroken(id)) => assert_eq!(id, "au1"),
        other => panic!("expected AuditChainBroken(au1), got {other:?}"),
    }
}

#[test]
fn deleting_a_row_breaks_the_chain() {
    let p = temp_db_path("audit-del");
    let mut db = Db::open_hub(&p).unwrap();
    append(&mut db, "au0", "pairing", 0);
    append(&mut db, "au1", "model_call", 1);
    append(&mut db, "au2", "revoke", 2);

    db.conn()
        .execute("DELETE FROM audit_ledger WHERE audit_id = 'au1'", [])
        .unwrap();

    // au2's stored prev_hash no longer matches the recomputed prev (au0's hash).
    match audit::verify_audit_chain(db.conn()) {
        Err(StorageError::AuditChainBroken(id)) => assert_eq!(id, "au2"),
        other => panic!("expected AuditChainBroken(au2), got {other:?}"),
    }
}

#[test]
fn deleting_tail_row_breaks_the_chain() {
    let p = temp_db_path("audit-tail-del");
    let mut db = Db::open_hub(&p).unwrap();
    append(&mut db, "au0", "pairing", 0);
    append(&mut db, "au1", "model_call", 1);
    append(&mut db, "au2", "revoke", 2);
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 3);

    db.conn()
        .execute("DELETE FROM audit_ledger WHERE audit_id = 'au2'", [])
        .unwrap();

    match audit::verify_audit_chain(db.conn()) {
        Err(StorageError::AuditChainBroken(id)) => assert_eq!(id, "au2"),
        other => panic!("expected AuditChainBroken(au2), got {other:?}"),
    }
}
