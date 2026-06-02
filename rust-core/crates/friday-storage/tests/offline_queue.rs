//! Offline-queue execution engine tests (product decision `02` §15; gate `21`
//! §4.4): ack≠completion, execute-requires-ack, exactly-once on re-delivery,
//! approval-invalid fails closed, and msg_id dedup.

mod common;

use common::temp_db_path;
use friday_core::OfflineQueueState;
use friday_storage::offline::{self, ExecOutcome};
use friday_storage::Db;
use std::cell::Cell;

#[test]
fn ack_is_not_completion_and_execute_requires_ack() {
    let p = temp_db_path("oq-ack");
    let mut db = Db::open_phone(&p).unwrap();
    offline::enqueue(db.conn(), "q1", "send_msg", "m1", None, Some("scope-1"), 1).unwrap();
    assert_eq!(
        offline::get_state(db.conn(), "q1").unwrap(),
        Some(OfflineQueueState::Queued)
    );

    // Cannot execute before an ack (an ack is not completion, and execution
    // requires the acked state).
    assert!(offline::execute_once(db.conn_mut(), "q1", true, 2, || Ok("x".into())).is_err());

    offline::ack(db.conn(), "q1").unwrap();
    let acked = offline::get_state(db.conn(), "q1").unwrap().unwrap();
    assert_eq!(acked, OfflineQueueState::Acked);
    assert!(!acked.is_complete(), "Acked must NOT be complete");

    let out =
        offline::execute_once(db.conn_mut(), "q1", true, 3, || Ok("delivered".into())).unwrap();
    assert_eq!(out, ExecOutcome::Executed);
    assert!(offline::get_state(db.conn(), "q1")
        .unwrap()
        .unwrap()
        .is_complete());
    assert_eq!(
        db.count("activity_item").unwrap(),
        1,
        "one execution receipt"
    );
}

#[test]
fn execute_runs_exactly_once_on_redelivery() {
    let p = temp_db_path("oq-once");
    let mut db = Db::open_phone(&p).unwrap();
    offline::enqueue(db.conn(), "q1", "send_msg", "m1", None, None, 1).unwrap();
    offline::ack(db.conn(), "q1").unwrap();

    let runs = Cell::new(0u32);
    let out1 = offline::execute_once(db.conn_mut(), "q1", true, 2, || {
        runs.set(runs.get() + 1);
        Ok("done".into())
    })
    .unwrap();
    let out2 = offline::execute_once(db.conn_mut(), "q1", true, 3, || {
        runs.set(runs.get() + 1);
        Ok("done-again".into())
    })
    .unwrap();

    assert_eq!(out1, ExecOutcome::Executed);
    assert_eq!(out2, ExecOutcome::AlreadyExecuted);
    assert_eq!(runs.get(), 1, "side effect must run exactly once");
    assert_eq!(db.count("activity_item").unwrap(), 1, "exactly one receipt");
}

#[test]
fn invalid_approval_fails_closed_without_executing() {
    let p = temp_db_path("oq-approval");
    let mut db = Db::open_phone(&p).unwrap();
    offline::enqueue(db.conn(), "q1", "send_msg", "m1", None, Some("scope-1"), 1).unwrap();
    offline::ack(db.conn(), "q1").unwrap();

    let runs = Cell::new(0u32);
    let out = offline::execute_once(db.conn_mut(), "q1", false, 2, || {
        runs.set(runs.get() + 1);
        Ok("should-not-run".into())
    })
    .unwrap();

    assert_eq!(out, ExecOutcome::ApprovalInvalid);
    assert_eq!(runs.get(), 0, "must not execute when approval is invalid");
    assert_eq!(
        offline::get_state(db.conn(), "q1").unwrap().unwrap(),
        OfflineQueueState::Failed
    );
    assert_eq!(
        db.count("activity_item").unwrap(),
        0,
        "no receipt on fail-closed"
    );
}

#[test]
fn enqueue_dedupes_on_msg_id() {
    let p = temp_db_path("oq-dedup");
    let db = Db::open_phone(&p).unwrap();
    let q_a = offline::enqueue(db.conn(), "q1", "send_msg", "same-msg", None, None, 1).unwrap();
    let q_b = offline::enqueue(db.conn(), "q2", "send_msg", "same-msg", None, None, 2).unwrap();
    assert_eq!(q_a, "q1");
    assert_eq!(
        q_b, "q1",
        "a resend of the same msg_id returns the existing row"
    );
    assert_eq!(db.count("offline_queue").unwrap(), 1);
}
