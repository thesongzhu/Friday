//! Atomic multi-table write + token-ledger fallback semantics
//! (gate 21 §2.3 / §6, §8 Unit-2 integration test).

mod common;

use common::temp_db_path;
use friday_core::{ActivityState, ActivityType, LedgerEntry};
use friday_storage::{
    audit, sweep_lifecycle, sweep_retention, ActivityRow, AuditEvent, Db, RetentionWindows,
    StorageError,
};
use rusqlite::{params, Connection};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

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
        owner: None,
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

// The M1 audit event a background memory-extraction billing call appends: action
// "memory.extract.model_call", payload_ref = the ledger id (carries run attribution).
fn extraction_audit_event(id: &str) -> AuditEvent {
    AuditEvent {
        audit_id: id.into(),
        actor: "hub-agent".into(),
        action: "memory.extract.model_call".into(),
        payload_ref: Some("led:run-1:100".into()),
        created_at: 100,
    }
}

#[test]
fn record_extraction_model_call_writes_ledger_plus_exactly_one_audit_no_activity() {
    // M1 audit-coverage fix: extraction billing now pairs the token_ledger row with EXACTLY
    // one hash-chained audit_ledger row (action "memory.extract.model_call") in one tx — and
    // does NOT mint an activity row (extraction never has). The audit chain stays valid.
    let p = temp_db_path("extract-bill-ok");
    let db = Db::open_hub(&p).unwrap();
    db.record_extraction_model_call(&ledger("le1"), &extraction_audit_event("le1:modelcall"))
        .unwrap();

    assert_eq!(db.count("token_ledger").unwrap(), 1);
    assert_eq!(
        db.count("activity_item").unwrap(),
        0,
        "extraction billing writes NO activity row (ledger + audit only)"
    );
    assert_eq!(
        db.count("audit_ledger").unwrap(),
        1,
        "extraction billing appends EXACTLY one audit row"
    );
    // The single audit row carries the M1 action.
    let action: String = db
        .conn()
        .query_row("SELECT action FROM audit_ledger LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(action, "memory.extract.model_call");
    // The hash chain remains intact after the extraction audit append.
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 1);

    // Extraction is its OWN cost dimension: the ledger row stays run-unattributed (run_id =
    // NULL), so it is excluded from any run's metered total (M1 must not re-attribute).
    let run_id: Option<String> = db
        .conn()
        .query_row(
            "SELECT run_id FROM token_ledger WHERE ledger_id = 'le1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        run_id, None,
        "extraction ledger row carries no run attribution"
    );
    let run = friday_storage::agent_run_read::run_token_totals(db.conn(), "run-1").unwrap();
    assert_eq!(
        run.total, 0,
        "extraction cost is excluded from the run total"
    );
}

#[test]
fn record_extraction_model_call_rolls_back_both_on_failure() {
    // Atomicity: if the audit insert collides (PK clash), the token_ledger row must NOT
    // persist — an extraction can never leave a charge with no audit row.
    let p = temp_db_path("extract-bill-fail");
    let db = Db::open_hub(&p).unwrap();
    {
        let tx = db.conn().unchecked_transaction().unwrap();
        audit::append_audit(&tx, "dup", "x", "seed", None, 1).unwrap();
        tx.commit().unwrap();
    }
    let res = db.record_extraction_model_call(&ledger("le1"), &extraction_audit_event("dup"));
    assert!(res.is_err(), "duplicate audit_id must fail the call");
    assert_eq!(
        db.count("token_ledger").unwrap(),
        0,
        "the billing ledger row must roll back with the failed audit append"
    );
    assert_eq!(
        db.count("audit_ledger").unwrap(),
        1,
        "only the seed row remains"
    );
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 1);
}

#[test]
fn record_extraction_model_call_is_hub_only() {
    let p = temp_db_path("extract-bill-phone");
    let db = Db::open_phone(&p).unwrap();
    let res =
        db.record_extraction_model_call(&ledger("le1"), &extraction_audit_event("le1:modelcall"));
    assert!(matches!(res, Err(StorageError::Unsupported(_))));
    // No billing row persisted; `audit_ledger` does not exist on a phone profile at all
    // (so it is not counted here — the guard fires before any write).
    assert_eq!(db.count("token_ledger").unwrap(), 0);
}

// ───────────────────────────────────────────────────────────────────────────
// CONCURRENCY: the billing busy-retry (MED bug, hardening audit).
//
// `record_run_model_call` runs on the long-lived WS-server connection. Once a SECOND
// writer exists — the reaper thread's `sweep_lifecycle` + `sweep_retention` batched DELETE
// on its OWN connection — a batch that out-holds the WAL write lock LONGER than the billing
// connection's `busy_timeout` makes the billing INSERT return `SQLITE_BUSY`; pre-fix the
// caller's bare `?` crashed the run mid-billing. The fix wraps the whole txn in the bounded
// busy-retry idiom. These tests prove it against a REAL on-disk WAL file (WAL is a no-op on
// `:memory:`).
// ───────────────────────────────────────────────────────────────────────────

/// A run-attributed per-turn bill with DETERMINISTIC, turn-unique ids (mirroring the hub's
/// `bill_model_call`: `run_id:tN:*`), so N concurrent turns leave N distinct rows and the
/// audit chain never PK-collides.
fn bill_turn(conn: &Connection, run_id: &str, turn: u64, now_ms: i64) -> Result<(), StorageError> {
    let ledger_id = format!("{run_id}:t{turn}:ledger");
    let activity_id = format!("{run_id}:t{turn}:askreceipt");
    let audit_id = format!("{run_id}:t{turn}:modelcall");
    let entry = LedgerEntry::friday_route(
        &ledger_id,
        run_id,
        &activity_id,
        "deepseek-v4-flash",
        5,
        3,
        None,
        None,
        now_ms,
    )
    .unwrap();
    let activity = ActivityRow {
        activity_id,
        session_id: Some(run_id.to_string()),
        kind: ActivityType::AskReceipt,
        state: ActivityState::Done,
        summary: "turn done".into(),
        created_at: now_ms,
        updated_at: now_ms,
        deep_link: None,
        owner: None,
    };
    let audit = AuditEvent {
        audit_id,
        actor: "hub-agent".into(),
        action: "agent_loop.model_call".into(),
        payload_ref: Some(ledger_id),
        created_at: now_ms,
    };
    friday_storage::record_run_model_call(conn, run_id, &entry, &activity, &audit)
}

/// Open a RAW writer connection to an already-WAL Hub file with a chosen `busy_timeout`.
/// (The billing connection in prod sets `HUB_BUSY_TIMEOUT_MS`; the deterministic test sets
/// 0 so ANY overlap surfaces `SQLITE_BUSY` immediately and the retry — not `busy_timeout` —
/// is what must absorb it.)
fn raw_writer(path: &str, busy_timeout_ms: i64) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    conn.pragma_update(None, "busy_timeout", busy_timeout_ms)
        .unwrap();
    conn
}

/// DETERMINISTIC retry-fires proof (the regression test). A blocker thread holds a write
/// lock (`BEGIN IMMEDIATE`) on a SECOND connection; the billing connection has
/// `busy_timeout = 0`, so its FIRST attempt hits an IMMEDIATE `SQLITE_BUSY`. The blocker
/// releases WITHIN the bounded retry budget (4 × 200ms = 800ms), so the retry's next attempt
/// commits and the call returns `Ok`.
///
/// PRE-FIX (no retry) this billing call propagates the BUSY and FAILS. This was VERIFIED by
/// reverting `record_run_model_call` to the bare-`?` single-txn body and running this test:
/// it went RED with exactly
/// `Err(Sqlite(SqliteFailure(Error { code: DatabaseBusy, extended_code: 5 }, "database is
/// locked")))`. That confirms (a) the busy error really reaches the application as a matchable
/// `StorageError::Sqlite(SqliteFailure(..))` and (b) the retry is what recovers it. It ALSO
/// empirically settles the BUSY_SNAPSHOT question: the surfaced `extended_code` is `5` =
/// plain `SQLITE_BUSY`, NOT `517` = `SQLITE_BUSY_SNAPSHOT`. The billing txn is a write-first
/// deferred txn (its FIRST statement is the `token_ledger` INSERT, BEFORE `append_audit`
/// reads the chain), so it takes its snapshot at write time and contends as plain BUSY — the
/// BUSY_SNAPSHOT arm of `is_storage_busy` is belt-and-suspenders, never the path this hits.
#[test]
fn billing_retry_absorbs_a_busy_when_a_peer_write_lock_releases_within_budget() {
    let p = temp_db_path("billing-retry-deterministic");
    // Convert the file to WAL + create the schema via the canonical writable opener, keep it
    // OPEN for the duration (the WS-server holds its connection for the run's lifetime).
    let _hub = Db::open_hub(&p).unwrap();

    // Blocker connection: take a write lock and hold it ~250ms (< the ~800ms retry budget),
    // then release. A barrier proves the lock is HELD before the billing call's first attempt.
    let blocker = raw_writer(&p, 0);
    let held = Arc::new(AtomicBool::new(false));
    let held_w = held.clone();
    let blocker_thread = std::thread::spawn(move || {
        blocker.execute_batch("BEGIN IMMEDIATE;").unwrap();
        held_w.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(250));
        blocker.execute_batch("COMMIT;").unwrap();
    });
    while !held.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(1));
    }

    // Billing connection with busy_timeout=0: its first attempt sees the held write lock and
    // gets an IMMEDIATE busy. The bounded retry re-runs the whole txn; the blocker releases
    // within budget, so a later attempt commits → Ok. (Pre-fix: this returns Err here.)
    let billing = raw_writer(&p, 0);
    let res = bill_turn(&billing, "run-retry", 0, 9_000_000_000_000);
    assert!(
        res.is_ok(),
        "the billing busy-retry must absorb a peer write lock that releases within budget, got {res:?}"
    );

    blocker_thread.join().unwrap();

    // The bill committed exactly once — all three rows present, audit chain clean.
    let n_ledger: i64 = billing
        .query_row("SELECT COUNT(*) FROM token_ledger", [], |r| r.get(0))
        .unwrap();
    let n_activity: i64 = billing
        .query_row("SELECT COUNT(*) FROM activity_item", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        n_ledger, 1,
        "exactly one ledger row (no double-bill on retry)"
    );
    assert_eq!(n_activity, 1, "exactly one activity row");
    assert_eq!(
        audit::verify_audit_chain(&billing).unwrap(),
        1,
        "audit chain clean: the retry re-read prev-hash, never forged a stale link"
    );
}

// --- stress-test seeders (raw SQL, grounded in the live schema; mirror retention.rs) ------

fn seed_conversation(conn: &Connection, id: &str) {
    conn.execute(
        "INSERT OR IGNORE INTO friday_conversation
            (friday_conversation_id, owner_principal, truth_status, created_at_ms, updated_at_ms)
         VALUES (?1, 'owner', 'proven', 1, 1)",
        [id],
    )
    .unwrap();
}

fn seed_mission(conn: &Connection, id: &str, conv: &str, status: &str, updated_at_ms: i64) {
    conn.execute(
        "INSERT INTO mission
            (mission_id, friday_conversation_id, intent, status, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, 'do a thing', ?3, 1, ?4)",
        params![id, conv, status, updated_at_ms],
    )
    .unwrap();
}

fn seed_aged_ledger(conn: &Connection, id: &str, created_at: i64) {
    conn.execute(
        "INSERT INTO token_ledger
            (ledger_id, session_id, activity_id, provider_kind, model, base_url_host,
             prompt_tokens, completion_tokens, total_tokens, cost_estimate, fallback,
             result_link, created_at)
         VALUES (?1, NULL, NULL, 'deepseek', 'deepseek-chat', 'api.deepseek.com',
                 1, 1, 2, NULL, 0, NULL, ?2)",
        params![id, created_at],
    )
    .unwrap();
}

fn ledger_exists(conn: &Connection, id: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM token_ledger WHERE ledger_id = ?1)",
        [id],
        |r| r.get::<_, bool>(0),
    )
    .unwrap()
}

fn mission_exists(conn: &Connection, id: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM mission WHERE mission_id = ?1)",
        [id],
        |r| r.get::<_, bool>(0),
    )
    .unwrap()
}

/// CONCURRENCY-CORRECTNESS STRESS (the invariant harness). On ONE WAL file:
///   * N billing threads each run several `bill_turn` calls back-to-back (distinct ids), on
///     their OWN connections — PROD-FAITHFUL (`busy_timeout = HUB_BUSY_TIMEOUT_MS`, the same as
///     the real WS-server billing connection), with the busy-retry as the residual backstop;
///   * a reaper thread runs `sweep_lifecycle` + `sweep_retention` on a SHORT cadence with a
///     SMALL batch over SEEDED aged terminal rows (the exact prod second-writer shape).
///
/// Asserts the no-degrade INVARIANTS under genuine concurrent commits: (a) NO billing call
/// errors and NO storage-busy propagates to the app; (b) aged rows are deleted while active
/// missions + the freshly-billed recent rows survive; no FK errors (the reaper never reports
/// a per-table failure); no double-bill; and the audit hash-chain verifies clean across every
/// concurrent commit.
///
/// SCOPE NOTE: this test does NOT deterministically force the busy-retry to fire — every
/// writer here holds the WAL lock for microseconds, so a patient `busy_timeout` acquires it
/// and a real BUSY almost never surfaces. The DETERMINISTIC fix-proof (a controlled
/// lock-hold that exceeds the timeout, the retry recovering it, and red-without-fix) is the
/// sibling test above. This one proves the FK/atomicity/no-double-bill invariants hold while
/// the reaper and N billers commit concurrently — which is the property that would regress if
/// the fix interacted badly with the second writer. N + cadence are bounded so CI is fast.
#[test]
fn concurrent_billing_survives_a_reaper_sweeping_on_a_short_cadence() {
    let p = temp_db_path("billing-reaper-stress");
    // Canonical writable opener: WAL + schema. Held open for the whole test.
    let hub = Db::open_hub(&p).unwrap();

    // A logical "now" far past every retention window so the seeded-aged rows are eligible
    // and the freshly-billed rows (created_at == now) are NOT. The reaper uses the SAME now.
    let now_ms: i64 = 9_000_000_000_000; // ~year 2255 in epoch-ms; all billing uses this.
    let one_year_ms: i64 = 365 * 24 * 60 * 60 * 1000;

    // Seed aged terminal artifacts (reaper deletes these) + an ACTIVE mission (NEVER deleted).
    seed_conversation(hub.conn(), "fconv_1");
    seed_mission(hub.conn(), "miss_active", "fconv_1", "active", 1); // ancient but active
    seed_mission(
        hub.conn(),
        "miss_term_old",
        "fconv_1",
        "done",
        now_ms - one_year_ms - 1,
    );
    for i in 0..20 {
        seed_aged_ledger(hub.conn(), &format!("aged_{i}"), now_ms - one_year_ms - 1);
    }

    // Small batch + the same `now_ms` so only the seeded-aged rows match the cutoffs. The DEFAULT
    // policy is now permanent (deletes nothing), so this concurrency stress explicitly opts EVERY
    // category in via `operator_windows()` to exercise the deletion mechanism under contention.
    let windows = RetentionWindows {
        batch_limit: 4,
        ..RetentionWindows::operator_windows()
    };

    let stop = Arc::new(AtomicBool::new(false));
    let billing_errors = Arc::new(AtomicUsize::new(0));
    let reaper_table_errors = Arc::new(AtomicUsize::new(0));

    // Reaper thread: its OWN connection, sweeping on a short cadence (the second writer).
    let reaper = {
        let path = p.clone();
        let stop = stop.clone();
        let reaper_errs = reaper_table_errors.clone();
        std::thread::spawn(move || {
            // Prod-faithful: the reaper opens via `Db::open_hub` (→ HUB_BUSY_TIMEOUT_MS), so its
            // batched DELETE WAITS for the (microsecond) billing write lock and acquires it. Most
            // contention is absorbed by that timeout; the residual `SQLITE_BUSY`/`BUSY_SNAPSHOT`
            // that the timeout does NOT auto-retry (e.g. the extra `memory_fts` write the v34
            // `memory_fts_ad` AFTER-DELETE trigger adds inside the `memory_item` delete txn) is
            // absorbed by the sweep's per-table busy-retry (`delete_bounded` → `with_busy_retry`).
            // So the ONLY thing left that can set `table_errors` is a real FK violation — which is
            // exactly the no-degrade "no FK errors" check below.
            let conn = raw_writer(&path, friday_storage::HUB_BUSY_TIMEOUT_MS);
            while !stop.load(Ordering::SeqCst) {
                // sweep_lifecycle is best-effort (logged-and-swallowed in prod); ignore its
                // Result here — the billing-side assertion is what gates the fix.
                let _ = sweep_lifecycle(&conn, now_ms);
                let out = sweep_retention(&conn, now_ms, windows);
                reaper_errs.fetch_add(out.table_errors, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    };

    // N billing threads: each bills several turns back-to-back, on its OWN connection.
    const N_THREADS: u64 = 6;
    const TURNS_PER_THREAD: u64 = 25;
    let mut billers = Vec::new();
    for t in 0..N_THREADS {
        let path = p.clone();
        let billing_errors = billing_errors.clone();
        billers.push(std::thread::spawn(move || {
            // Prod-faithful: the WS-server billing connection carries HUB_BUSY_TIMEOUT_MS; the
            // busy-retry is the residual backstop for a batch that out-holds even that.
            let conn = raw_writer(&path, friday_storage::HUB_BUSY_TIMEOUT_MS);
            let run_id = format!("run-{t}");
            for turn in 0..TURNS_PER_THREAD {
                if let Err(e) = bill_turn(&conn, &run_id, turn, now_ms) {
                    eprintln!("billing error t={t} turn={turn}: {e:?}");
                    billing_errors.fetch_add(1, Ordering::SeqCst);
                }
            }
        }));
    }
    for b in billers {
        b.join().unwrap();
    }
    stop.store(true, Ordering::SeqCst);
    reaper.join().unwrap();

    // (a) NO billing call errored — the busy-retry absorbed every contention from the reaper.
    assert_eq!(
        billing_errors.load(Ordering::SeqCst),
        0,
        "no billing call may error/crash under concurrent reaper contention"
    );
    // The reaper never hit an FK refusal / per-table failure on its own writes.
    assert_eq!(
        reaper_table_errors.load(Ordering::SeqCst),
        0,
        "the retention sweep must never report a per-table (FK/lock) failure"
    );

    // (b) Every billed turn committed exactly once: N*TURNS run-attributed ledger rows survive
    // (created_at == now_ms, never aged). Read on a FRESH connection (avoid WAL staleness).
    let verify = raw_writer(&p, friday_storage::HUB_BUSY_TIMEOUT_MS);

    // DETERMINISM: the "aged rows deleted" assertions must not depend on how many ticks the
    // reaper got before `stop`. Drain the small-batch backlog synchronously now (no contention,
    // bounded), so deletion is settled before we assert it.
    let mut drains = 0;
    loop {
        let out = sweep_retention(&verify, now_ms, windows);
        assert_eq!(out.table_errors, 0, "uncontended drain must not FK-fail");
        if out.is_empty() {
            break;
        }
        drains += 1;
        assert!(drains < 50, "drain must terminate (bounded backlog)");
    }

    let billed: i64 = verify
        .query_row(
            "SELECT COUNT(*) FROM token_ledger WHERE run_id IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        billed as u64,
        N_THREADS * TURNS_PER_THREAD,
        "every billed turn must persist exactly once (no lost bill, no double-bill)"
    );

    // Aged rows pruned (the reaper's small batch drains 20 over its ticks); active mission +
    // a freshly-billed recent row survive; the old-terminal mission is pruned.
    for i in 0..20 {
        assert!(
            !ledger_exists(&verify, &format!("aged_{i}")),
            "aged ledger row aged_{i} must be pruned by the reaper"
        );
    }
    assert!(
        mission_exists(&verify, "miss_active"),
        "the active mission is NEVER deleted regardless of age"
    );
    assert!(
        !mission_exists(&verify, "miss_term_old"),
        "the old-terminal leaf mission must be pruned"
    );
    assert!(
        ledger_exists(&verify, "run-0:t0:ledger"),
        "a freshly-billed recent row survives (created_at == now, never aged)"
    );

    // The audit chain across all N*TURNS billed rows still verifies clean — every retry
    // re-read the live prev-hash; not one forged a stale link.
    assert_eq!(
        audit::verify_audit_chain(&verify).unwrap() as u64,
        N_THREADS * TURNS_PER_THREAD,
        "audit chain clean across all concurrent bills"
    );

    drop(hub);
}
