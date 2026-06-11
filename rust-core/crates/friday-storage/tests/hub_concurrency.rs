//! Hub-DB concurrency-safety tests (the 503-after-billing fix).
//!
//! The `rust-hub.sqlite` Hub DB is opened CONCURRENTLY by multiple production
//! processes (the agent-run WS server's writable runtime + the answer-readback bin
//! opening it read-only). With the SQLite default (`journal_mode=delete` +
//! `busy_timeout=0`) a contended open/read returns `SQLITE_BUSY` IMMEDIATELY — the
//! exact mechanism behind the intermittent 503-after-billing readback failure (and
//! the WS-server `init_failed` crash-loop). The fix makes EVERY Hub opener
//! ([`Db::open_hub`] / [`Db::open_hub_concurrent`] / [`Db::open_hub_readonly`]) use
//! WAL + a non-zero `busy_timeout`.
//!
//! These tests prove the fix against a REAL on-disk file (WAL is a no-op on
//! `:memory:`, so a file path is mandatory): the writable opener converts the file
//! to WAL with the busy timeout, a read-only opener (the readback's open path) reads
//! a persisted row WHILE the writer connection is still open (the prod contention
//! shape), and the read-only opener also carries the busy timeout.

mod common;

use common::temp_db_path;
use friday_storage::{
    get_run_answer_for_principal, persist_run_result, Db, RunAnswerAccess, RunResult,
    HUB_BUSY_TIMEOUT_MS,
};

const OWNER: &str = "principal:owner-alice";
const BODY: &str = "PONG";

fn journal_mode(db: &Db) -> String {
    db.conn()
        .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
        .unwrap()
}

fn busy_timeout(db: &Db) -> i64 {
    db.conn()
        .query_row("PRAGMA busy_timeout", [], |r| r.get::<_, i64>(0))
        .unwrap()
}

/// The writable Hub opener sets WAL + the busy timeout persistently on a real file.
#[test]
fn open_hub_sets_wal_and_busy_timeout_on_a_file_db() {
    let p = temp_db_path("hub-wal-writable");
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(
        journal_mode(&db).to_lowercase(),
        "wal",
        "the writable Hub opener must put the file in WAL mode"
    );
    assert_eq!(
        busy_timeout(&db),
        HUB_BUSY_TIMEOUT_MS,
        "the writable Hub opener must set a non-zero busy_timeout"
    );
    // `open_hub` delegates to `open_hub_concurrent` — they must be byte-identical in
    // the pragmas they set (no divergent second WAL opener).
    drop(db);
    let db2 = Db::open_hub_concurrent(&p).unwrap();
    assert_eq!(journal_mode(&db2).to_lowercase(), "wal");
    assert_eq!(busy_timeout(&db2), HUB_BUSY_TIMEOUT_MS);
}

/// The read-only Hub opener (the answer-readback's open path) sets the busy timeout
/// so a contended read RETRIES instead of an immediate `SQLITE_BUSY`. A read-only
/// connection cannot change journal_mode, but it reads the WAL-mode file fine.
#[test]
fn open_hub_readonly_sets_busy_timeout_and_reads_a_wal_db() {
    let p = temp_db_path("hub-wal-readonly");
    // Convert to WAL + seed a row via the writable opener, then close it.
    {
        let db = Db::open_hub(&p).unwrap();
        let result = RunResult::new("finished", BODY, None).with_owner_principal(OWNER);
        persist_run_result(db.conn(), "run-1", &result, 1000).unwrap();
    }
    // The read-only opener (cleanly-closed WAL file): reads the persisted row.
    let ro = Db::open_hub_readonly(&p).unwrap();
    assert_eq!(
        busy_timeout(&ro),
        HUB_BUSY_TIMEOUT_MS,
        "the read-only Hub opener must set a non-zero busy_timeout"
    );
    let access = get_run_answer_for_principal(ro.conn(), "run-1", OWNER).unwrap();
    match access {
        RunAnswerAccess::Granted(stored) => assert_eq!(stored.answer, BODY),
        other => panic!("owner read of a WAL-mode DB must be Granted, got {other:?}"),
    }
}

/// THE LOAD-BEARING CASE: a read-only open (the readback bin) succeeds and reads the
/// answer WHILE the writable WS-server connection is STILL OPEN on the same file —
/// the exact prod contention shape that returned an immediate `SQLITE_BUSY` under
/// `journal_mode=delete` + `busy_timeout=0`. Under WAL + busy_timeout this no longer
/// fails: a WAL reader does not block on the writer, and the `-shm` exists because the
/// writer is up.
#[test]
fn readonly_open_reads_the_answer_while_a_writer_connection_is_still_open() {
    let p = temp_db_path("hub-wal-contended");
    // Writable runtime connection: convert to WAL, persist the finished answer, and
    // KEEP IT OPEN (the WS server holds its connection for the lifetime of the run).
    let writer = Db::open_hub(&p).unwrap();
    let result = RunResult::new("finished", BODY, None).with_owner_principal(OWNER);
    persist_run_result(writer.conn(), "run-contended", &result, 2000).unwrap();

    // The readback bin's open path, opened read-only against the SAME file while the
    // writer is still open. Under the old default this contended open could return
    // SQLITE_BUSY immediately; under WAL + busy_timeout it succeeds and delivers.
    let ro = Db::open_hub_readonly(&p).unwrap();
    let access = get_run_answer_for_principal(ro.conn(), "run-contended", OWNER).unwrap();
    match access {
        RunAnswerAccess::Granted(stored) => {
            assert_eq!(stored.answer, BODY);
            assert_eq!(stored.status, "finished");
        }
        other => panic!("contended owner readback must be Granted (no immediate BUSY), got {other:?}"),
    }

    // The writer is dropped only now (after the contended read) — proving the read
    // succeeded with the writer connection still live.
    drop(writer);
}

/// A second writable opener on a file already in WAL stays in WAL and keeps the busy
/// timeout — no opener fights the journal mode back to rollback-journal (which would
/// re-introduce the immediate-BUSY contention).
#[test]
fn reopening_a_wal_hub_db_stays_wal_with_busy_timeout() {
    let p = temp_db_path("hub-wal-reopen");
    {
        let db = Db::open_hub(&p).unwrap();
        assert_eq!(journal_mode(&db).to_lowercase(), "wal");
    }
    let again = Db::open_hub(&p).unwrap();
    assert_eq!(
        journal_mode(&again).to_lowercase(),
        "wal",
        "a reopen must not flip a WAL file back to rollback-journal"
    );
    assert_eq!(busy_timeout(&again), HUB_BUSY_TIMEOUT_MS);
}
