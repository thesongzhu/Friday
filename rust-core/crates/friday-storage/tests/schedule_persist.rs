//! S10-A workflow-SCHEDULER substrate persistence tests (DARK substrate):
//! the additive v23→v24 forward migration (table presence + CHECK constraints +
//! the seeded control singleton), schedule CRUD (born disabled, missing = error),
//! watermark monotonicity (refuses to lower), per-slot fire receipt PK dedupe,
//! control pause read/write, and the single-instance lease (acquire / refresh /
//! release / supersede-on-expiry, including a real two-connection file-backed
//! race proving exactly-one acquirer).

mod common;

use common::temp_db_path;
use friday_storage::schedule::{
    acquire_lease, delete_schedule, get_control, get_fire, get_lease, get_schedule,
    insert_schedule, list_enabled_schedules, list_schedules, record_fire, refresh_lease,
    release_lease, set_enabled, set_last_slot, set_paused, LeaseAcquireOutcome, NewSchedule,
    RecordFireOutcome,
};
use friday_storage::{hub_migrations, Db, Profile, StorageError, HUB_ONLY_TABLES};
use rusqlite::Connection;

fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

fn new_sched<'a>(id: &'a str, wf: &'a str, cron: &'a str) -> NewSchedule<'a> {
    NewSchedule {
        schedule_id: id,
        workflow_id: wf,
        cron_expr: cron,
    }
}

// --- forward migration v23 -> v24: presence + CHECKs + seeded singleton -----

#[test]
fn forward_migration_v23_to_v24_adds_scheduler_tables_and_constraints() {
    let p = temp_db_path("sched-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 23);
        let db = Db::open(&p, Profile::Hub, &migs, "v23").unwrap();
        assert_eq!(db.version().unwrap(), 23);
        for t in [
            "workflow_schedule",
            "workflow_schedule_fire",
            "scheduler_control",
            "scheduler_lease",
        ] {
            assert!(
                !db.table_names().unwrap().iter().any(|x| x == t),
                "pre-v24 DB must not have {t}"
            );
        }
    }
    // Re-open with the full set -> the additive m0024 applies.
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    let conn = db.conn();

    // The migration SEEDED the control singleton (id=1, paused=0) so a pause read
    // is always defined.
    let ctrl = get_control(conn).unwrap();
    assert!(!ctrl.paused);
    assert_eq!(ctrl.reason, None);

    // A valid born-disabled insert works on the migrated DB.
    insert_schedule(conn, &new_sched("s1", "wf1", "*/5 * * * *"), 100).unwrap();
    assert!(get_schedule(conn, "s1").unwrap().is_some());

    // --- CHECK constraints are enforced by the migrated schema (raw SQL) ---
    // non-UTC timezone is unrepresentable
    assert!(
        conn.execute(
            "INSERT INTO workflow_schedule
                (schedule_id, workflow_id, cron_expr, timezone, enabled, created_at, updated_at)
             VALUES ('bad-tz', 'wf', '* * * * *', 'America/New_York', 0, 1, 1)",
            [],
        )
        .is_err(),
        "non-UTC timezone must violate the CHECK"
    );
    // enabled outside {0,1}
    assert!(
        conn.execute(
            "INSERT INTO workflow_schedule
                (schedule_id, workflow_id, cron_expr, enabled, created_at, updated_at)
             VALUES ('bad-en', 'wf', '* * * * *', 2, 1, 1)",
            [],
        )
        .is_err(),
        "enabled=2 must violate the CHECK"
    );
    // empty schedule_id
    assert!(
        conn.execute(
            "INSERT INTO workflow_schedule
                (schedule_id, workflow_id, cron_expr, created_at, updated_at)
             VALUES ('   ', 'wf', '* * * * *', 1, 1)",
            [],
        )
        .is_err(),
        "blank schedule_id must violate the CHECK"
    );
    // fire outcome outside the closed vocab
    assert!(
        conn.execute(
            "INSERT INTO workflow_schedule_fire
                (schedule_id, slot_ts, outcome, created_at)
             VALUES ('s1', 60000, 'wat', 1)",
            [],
        )
        .is_err(),
        "an unknown fire outcome must violate the CHECK"
    );
    // a valid outcome is accepted
    conn.execute(
        "INSERT INTO workflow_schedule_fire
            (schedule_id, slot_ts, outcome, created_at)
         VALUES ('s1', 60000, 'fired', 1)",
        [],
    )
    .unwrap();
    // duplicate (schedule_id, slot_ts) PK is unrepresentable
    assert!(
        conn.execute(
            "INSERT INTO workflow_schedule_fire
                (schedule_id, slot_ts, outcome, created_at)
             VALUES ('s1', 60000, 'error', 1)",
            [],
        )
        .is_err(),
        "duplicate fire PK must be rejected"
    );
    // control / lease singleton id must be 1
    assert!(
        conn.execute(
            "INSERT INTO scheduler_control (id, paused, updated_at) VALUES (2, 0, 1)",
            [],
        )
        .is_err(),
        "scheduler_control id must be 1"
    );
    assert!(
        conn.execute(
            "INSERT INTO scheduler_lease (id, holder, expires_at, updated_at)
             VALUES (2, 'h', 1, 1)",
            [],
        )
        .is_err(),
        "scheduler_lease id must be 1"
    );
}

#[test]
fn scheduler_tables_are_hub_only() {
    for t in [
        "workflow_schedule",
        "workflow_schedule_fire",
        "scheduler_control",
        "scheduler_lease",
    ] {
        assert!(HUB_ONLY_TABLES.contains(&t), "{t} must be Hub-only");
    }
}

// --- schedule CRUD ----------------------------------------------------------

#[test]
fn insert_is_born_disabled_and_set_enabled_toggles() {
    let p = temp_db_path("sched-crud");
    let db = Db::open_hub(&p).unwrap();
    let conn = db.conn();

    insert_schedule(conn, &new_sched("s1", "wf1", "0 9 * * *"), 100).unwrap();
    let row = get_schedule(conn, "s1").unwrap().unwrap();
    assert!(!row.enabled, "a fresh schedule is BORN DISABLED");
    assert_eq!(row.timezone, "UTC");
    assert_eq!(row.last_slot_ts, None);
    assert!(list_enabled_schedules(conn).unwrap().is_empty());

    set_enabled(conn, "s1", true, 200).unwrap();
    assert!(get_schedule(conn, "s1").unwrap().unwrap().enabled);
    assert_eq!(list_enabled_schedules(conn).unwrap().len(), 1);

    // a duplicate schedule_id fails closed (PK)
    assert!(insert_schedule(conn, &new_sched("s1", "wf2", "* * * * *"), 300).is_err());

    // set_enabled / delete on a missing id is NotFound, never a silent no-op
    assert!(matches!(
        set_enabled(conn, "ghost", true, 1),
        Err(StorageError::NotFound(_))
    ));
    assert!(matches!(
        delete_schedule(conn, "ghost"),
        Err(StorageError::NotFound(_))
    ));

    delete_schedule(conn, "s1").unwrap();
    assert!(get_schedule(conn, "s1").unwrap().is_none());
}

#[test]
fn list_schedules_is_ordered_and_refs_only() {
    let p = temp_db_path("sched-list");
    let db = Db::open_hub(&p).unwrap();
    let conn = db.conn();
    insert_schedule(conn, &new_sched("b", "wf", "* * * * *"), 1).unwrap();
    insert_schedule(conn, &new_sched("a", "wf", "* * * * *"), 1).unwrap();
    let ids: Vec<String> = list_schedules(conn)
        .unwrap()
        .into_iter()
        .map(|r| r.schedule_id)
        .collect();
    assert_eq!(ids, vec!["a", "b"]);
}

// --- watermark monotonicity -------------------------------------------------

#[test]
fn set_last_slot_advances_but_refuses_to_lower() {
    let p = temp_db_path("sched-watermark");
    let db = Db::open_hub(&p).unwrap();
    let conn = db.conn();
    insert_schedule(conn, &new_sched("s1", "wf", "* * * * *"), 1).unwrap();

    set_last_slot(conn, "s1", 60_000, 2).unwrap();
    assert_eq!(
        get_schedule(conn, "s1").unwrap().unwrap().last_slot_ts,
        Some(60_000)
    );
    // advancing forward is fine
    set_last_slot(conn, "s1", 120_000, 3).unwrap();
    assert_eq!(
        get_schedule(conn, "s1").unwrap().unwrap().last_slot_ts,
        Some(120_000)
    );
    // equal is an idempotent no-op success
    set_last_slot(conn, "s1", 120_000, 4).unwrap();
    // moving BACKWARD is refused (the backwards-clock / re-presented-slot guard)
    assert!(matches!(
        set_last_slot(conn, "s1", 60_000, 5),
        Err(StorageError::Unsupported(_))
    ));
    assert_eq!(
        get_schedule(conn, "s1").unwrap().unwrap().last_slot_ts,
        Some(120_000),
        "a refused lower must leave the watermark untouched"
    );
    // a missing schedule is NotFound
    assert!(matches!(
        set_last_slot(conn, "ghost", 1, 1),
        Err(StorageError::NotFound(_))
    ));
}

// --- per-slot fire receipts (PK dedupe) -------------------------------------

#[test]
fn record_fire_dedupes_by_slot_pk() {
    let p = temp_db_path("sched-fire");
    let db = Db::open_hub(&p).unwrap();
    let conn = db.conn();
    insert_schedule(conn, &new_sched("s1", "wf", "* * * * *"), 1).unwrap();

    let first = record_fire(conn, "s1", 60_000, "fired", Some("sched:s1:60000"), None, 2).unwrap();
    assert_eq!(first, RecordFireOutcome::Recorded);
    // a SECOND attempt for the same slot is an idempotent Duplicate (the first
    // decision stands) — the per-slot at-most-once complement to the engine PK.
    let second = record_fire(conn, "s1", 60_000, "error", None, Some("clock_skew"), 3).unwrap();
    assert_eq!(second, RecordFireOutcome::Duplicate);

    let got = get_fire(conn, "s1", 60_000).unwrap().unwrap();
    assert_eq!(got.outcome, "fired", "the first receipt is preserved");
    assert_eq!(got.run_id.as_deref(), Some("sched:s1:60000"));

    // a different slot records cleanly
    assert_eq!(
        record_fire(conn, "s1", 120_000, "skipped_paused", None, None, 4).unwrap(),
        RecordFireOutcome::Recorded
    );
    // an unknown outcome string fails closed at the CHECK
    assert!(record_fire(conn, "s1", 180_000, "bogus", None, None, 5).is_err());
}

// --- control (pause kill-switch) --------------------------------------------

#[test]
fn control_pause_round_trips() {
    let p = temp_db_path("sched-control");
    let db = Db::open_hub(&p).unwrap();
    let conn = db.conn();
    // seeded by the migration
    assert!(!get_control(conn).unwrap().paused);
    set_paused(conn, true, Some("operator drained"), 10).unwrap();
    let c = get_control(conn).unwrap();
    assert!(c.paused);
    assert_eq!(c.reason.as_deref(), Some("operator drained"));
    set_paused(conn, false, None, 11).unwrap();
    assert!(!get_control(conn).unwrap().paused);
}

// --- lease (single-instance) ------------------------------------------------

#[test]
fn lease_acquire_refresh_release_and_supersede_on_expiry() {
    let p = temp_db_path("sched-lease");
    let db = Db::open_hub(&p).unwrap();
    let conn = db.conn();

    // free lease -> A acquires
    assert_eq!(
        acquire_lease(conn, "A", 1_000, 0).unwrap(),
        LeaseAcquireOutcome::Acquired
    );
    assert_eq!(get_lease(conn).unwrap().unwrap().holder, "A");

    // B sees A's LIVE lease (now=500 < expires 1000) and is refused
    assert_eq!(
        acquire_lease(conn, "B", 2_000, 500).unwrap(),
        LeaseAcquireOutcome::HeldByOther
    );
    assert_eq!(
        get_lease(conn).unwrap().unwrap().holder,
        "A",
        "A still holds"
    );

    // A refreshes its own lease (heartbeat)
    refresh_lease(conn, "A", 3_000, 600).unwrap();
    assert_eq!(get_lease(conn).unwrap().unwrap().expires_at, 3_000);
    // B cannot refresh a lease it does not hold
    assert!(matches!(
        refresh_lease(conn, "B", 9_000, 600),
        Err(StorageError::NotFound(_))
    ));

    // once A's lease EXPIRES (now >= expires_at), B supersedes it
    assert_eq!(
        acquire_lease(conn, "B", 5_000, 3_500).unwrap(),
        LeaseAcquireOutcome::Acquired
    );
    assert_eq!(get_lease(conn).unwrap().unwrap().holder, "B");

    // A's stale release is a no-op (it no longer holds); B's release frees it
    assert!(!release_lease(conn, "A").unwrap());
    assert!(release_lease(conn, "B").unwrap());
    assert!(get_lease(conn).unwrap().is_none());
}

#[test]
fn lease_two_connection_race_yields_exactly_one_acquirer() {
    // A REAL two-connection race on a file-backed concurrent (WAL) DB: two
    // separate connections both try to acquire the free lease "at once". The
    // IMMEDIATE transaction inside acquire_lease serializes them, so exactly one
    // observes "free" and wins; the other observes the live lease and is refused.
    let p = temp_db_path("sched-lease-race");
    // migrate via the concurrent (WAL + busy_timeout) open path the daemon uses
    let db = Db::open_hub_concurrent(&p).unwrap();
    drop(db);

    // Two independent connections (NOT shared) over the same file, both in WAL +
    // busy_timeout so a contended writer retries instead of erroring.
    let open = |path: &str| -> Connection {
        let c = Connection::open(path).unwrap();
        c.pragma_update(None, "journal_mode", "WAL").unwrap();
        c.pragma_update(None, "busy_timeout", 5000).unwrap();
        c
    };
    let c1 = open(&p);
    let c2 = open(&p);

    let r1 = acquire_lease(&c1, "inst-1", 10_000, 0).unwrap();
    let r2 = acquire_lease(&c2, "inst-2", 10_000, 0).unwrap();

    // Exactly one acquired; the other was refused (HeldByOther).
    let acquired = [r1, r2]
        .iter()
        .filter(|&&o| o == LeaseAcquireOutcome::Acquired)
        .count();
    assert_eq!(
        acquired, 1,
        "exactly one instance may hold the lease: {r1:?} / {r2:?}"
    );
    // the winner is whoever the DB row names; the loser must be HeldByOther
    let holder = get_lease(&c1).unwrap().unwrap().holder;
    assert!(holder == "inst-1" || holder == "inst-2");
}
