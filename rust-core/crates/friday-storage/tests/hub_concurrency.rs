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
    get_run_answer_for_principal, persist_run_result, Db, RunAnswerAccess, RunResult, StorageError,
    HUB_BUSY_TIMEOUT_MS,
};
use rusqlite::{Connection, ErrorCode};

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
        other => {
            panic!("contended owner readback must be Granted (no immediate BUSY), got {other:?}")
        }
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

/// THE FLIP-BOUNDARY CASE (deterministic, no threads/sleeps): a peer holding an
/// EXCLUSIVE write txn at the flip instant makes `Db::open_hub` (which performs the
/// one-time WAL flip) get a REAL `SQLITE_BUSY` from SQLite — not a synthetic one. With
/// a contender that NEVER releases, the bounded retry must EXHAUST and FAIL CLOSED with
/// the busy/locked error (so `init_failed` stays deterministic, never a hang) — and the
/// surfaced error must be exactly the busy/locked class the retry recognises. The short
/// pre-flip busy_timeout keeps each attempt fast, so the whole exhaust is ~1s, not the
/// ~5s-per-attempt the old post-flip ordering produced. (When the contender DOES clear
/// within the budget the same loop instead heals — proven by the injected-closure unit
/// tests in `lib.rs`, which need no timing.)
#[test]
fn writable_open_fails_closed_with_busy_when_a_peer_holds_exclusive_at_the_flip() {
    let p = temp_db_path("hub-wal-flip-contended");
    // Put the file in WAL first so the contender below can take a write lock cleanly,
    // then close it so the EXCLUSIVE-holding connection is the ONLY live one.
    {
        let db = Db::open_hub(&p).unwrap();
        assert_eq!(journal_mode(&db).to_lowercase(), "wal");
    }

    // A raw rollback-journal contender holding an EXCLUSIVE txn — never released for the
    // duration of the open attempt. (It also forces the file mode contention the flip
    // hits.) `busy_timeout=0` here so the contender itself never waits.
    let blocker = Connection::open(&p).unwrap();
    blocker
        .pragma_update(None, "journal_mode", "DELETE")
        .unwrap();
    blocker.pragma_update(None, "busy_timeout", 0_i64).unwrap();
    blocker.execute_batch("BEGIN EXCLUSIVE;").unwrap();

    // The writable Hub open now races the held EXCLUSIVE lock at the WAL flip. The
    // bounded retry re-attempts ONLY the busy/locked case, then — since the blocker
    // never releases — exhausts the budget and returns the busy error (fails closed).
    // `Db` is not `Debug`, so match on the Result rather than `expect_err`.
    let err = match Db::open_hub(&p) {
        Ok(_) => panic!(
            "a writable open contended by a never-released EXCLUSIVE txn must fail closed, not hang"
        ),
        Err(e) => e,
    };
    match err {
        StorageError::Sqlite(rusqlite::Error::SqliteFailure(e, _)) => {
            assert!(
                matches!(e.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked),
                "the flip-boundary failure must be a busy/locked error, got {e:?}"
            );
        }
        other => panic!("expected a busy/locked SqliteFailure, got {other:?}"),
    }

    // Release the contender, then prove the SAME open now SUCCEEDS — the retry path did
    // not corrupt the file and the heal happens once contention clears.
    blocker.execute_batch("COMMIT;").unwrap();
    drop(blocker);
    let healed = Db::open_hub(&p).expect("open must succeed once the contender releases");
    assert_eq!(journal_mode(&healed).to_lowercase(), "wal");
    assert_eq!(busy_timeout(&healed), HUB_BUSY_TIMEOUT_MS);
}
