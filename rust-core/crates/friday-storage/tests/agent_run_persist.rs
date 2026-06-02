//! PR-5 agent-loop substrate persistence: a REAL forward migration adds the
//! `agent_run` + `agent_run_event` tables (preserving existing data), those
//! tables are Hub-only (absent from the phone profile, asserted both ways), and
//! the thin repo persists the run state machine + an append-only event log.
//!
//! Version note: this PR's migration is version 5 with a deliberate gap at 4
//! (reserved by the concurrent PR-3b). To stay robust against that merge, the
//! expected post-migration version is DERIVED from `hub_migrations()` rather than
//! hardcoded — once PR-3b lands its version-4 migration these assertions still hold.

mod common;

use common::temp_db_path;
use friday_core::{PlanState, SessionState};
use friday_storage::{agent_run, hub_migrations, Db, Profile, HUB_ONLY_TABLES};

/// The max migration version the current hub migration set reaches.
fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

#[test]
fn forward_migration_adds_agent_tables_preserving_data() {
    let p = temp_db_path("agent-mig");
    // Open at v1 only (init_hub) and seed a row that must survive the migration.
    {
        let mut migs = hub_migrations();
        migs.truncate(1); // keep only 0001_init_hub
        let db = Db::open(&p, Profile::Hub, &migs, "v1").unwrap();
        assert_eq!(db.version().unwrap(), 1);
        assert!(
            !db.table_names().unwrap().iter().any(|t| t == "agent_run"),
            "agent tables must not exist at v1"
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
    // Reopen with the full hub set -> forward-migrate up to the agent_run migration.
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    let tables = db.table_names().unwrap();
    assert!(
        tables.iter().any(|t| t == "agent_run"),
        "agent_run missing: {tables:?}"
    );
    assert!(
        tables.iter().any(|t| t == "agent_run_event"),
        "agent_run_event missing: {tables:?}"
    );
    // Pre-existing data survived the additive migration.
    assert_eq!(db.count("session").unwrap(), 1);
}

#[test]
fn agent_tables_are_hub_only_and_absent_from_phone() {
    // Both new tables are registered Hub-only.
    assert!(HUB_ONLY_TABLES.contains(&"agent_run"));
    assert!(HUB_ONLY_TABLES.contains(&"agent_run_event"));

    // Present on the Hub profile...
    let hp = temp_db_path("agent-hub");
    let hub = Db::open_hub(&hp).unwrap();
    let htables = hub.table_names().unwrap();
    assert!(htables.iter().any(|t| t == "agent_run"));
    assert!(htables.iter().any(|t| t == "agent_run_event"));

    // ...and ABSENT from the phone profile (the schema_profile guarantee, asserted
    // here directly for the two new tables both ways).
    let pp = temp_db_path("agent-phone");
    let phone = Db::open_phone(&pp).unwrap();
    let ptables = phone.table_names().unwrap();
    assert!(
        !ptables.iter().any(|t| t == "agent_run"),
        "agent_run must not exist on a phone: {ptables:?}"
    );
    assert!(
        !ptables.iter().any(|t| t == "agent_run_event"),
        "agent_run_event must not exist on a phone: {ptables:?}"
    );
}

#[test]
fn run_state_machine_is_persisted_and_validated() {
    let p = temp_db_path("agent-run");
    let db = Db::open_hub(&p).unwrap();
    agent_run::create_run(db.conn(), "r1", "build me a workflow", 1).unwrap();
    assert_eq!(
        agent_run::run_state(db.conn(), "r1").unwrap(),
        Some(PlanState::AwaitingClarification)
    );

    // Legal path: clarification -> plan-approval -> approved (terminal).
    agent_run::set_run_state(db.conn(), "r1", PlanState::AwaitingPlanApproval, 2).unwrap();
    agent_run::set_run_state(db.conn(), "r1", PlanState::Approved, 3).unwrap();
    assert_eq!(
        agent_run::run_state(db.conn(), "r1").unwrap(),
        Some(PlanState::Approved)
    );

    // Illegal transition (skip clarification -> approved) is rejected and NOT persisted.
    agent_run::create_run(db.conn(), "r2", "x", 1).unwrap();
    assert!(agent_run::set_run_state(db.conn(), "r2", PlanState::Approved, 2).is_err());
    assert_eq!(
        agent_run::run_state(db.conn(), "r2").unwrap(),
        Some(PlanState::AwaitingClarification),
        "a rejected transition must not advance the persisted state"
    );

    // Terminal state cannot be re-decided (no approved -> rejected).
    assert!(agent_run::set_run_state(db.conn(), "r1", PlanState::Rejected, 4).is_err());
    assert_eq!(
        agent_run::run_state(db.conn(), "r1").unwrap(),
        Some(PlanState::Approved)
    );
}

#[test]
fn event_log_is_append_only_with_monotonic_seq() {
    let p = temp_db_path("agent-events");
    let db = Db::open_hub(&p).unwrap();
    agent_run::create_run(db.conn(), "r1", "task", 1).unwrap();

    let s1 = agent_run::record_event(db.conn(), "e1", "r1", "run.started", 1).unwrap();
    let s2 = agent_run::record_event(db.conn(), "e2", "r1", "run.planning", 2).unwrap();
    let s3 = agent_run::record_event(db.conn(), "e3", "r1", "run.plan_ready", 3).unwrap();
    assert_eq!((s1, s2, s3), (1, 2, 3), "seq must be 1-based and monotonic");

    // Events are persisted in order.
    let kinds: Vec<String> = {
        let mut stmt = db
            .conn()
            .prepare("SELECT kind FROM agent_run_event WHERE run_id = 'r1' ORDER BY seq")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    };
    assert_eq!(kinds, vec!["run.started", "run.planning", "run.plan_ready"]);

    // Recording an event for an unknown run is refused.
    assert!(agent_run::record_event(db.conn(), "e9", "missing", "x", 9).is_err());
}

#[test]
fn duplicate_run_seq_is_structurally_refused() {
    // Reviewer-B C1: the `UNIQUE(run_id, seq)` constraint makes a per-run seq
    // collision an INSERT error rather than a silent duplicate — the same
    // "unrepresentable, not a check-then-consume race" discipline as
    // `consumed_approval`'s PK. A second row at the same (run_id, seq) is refused.
    let p = temp_db_path("agent-dup-seq");
    let db = Db::open_hub(&p).unwrap();
    agent_run::create_run(db.conn(), "r1", "task", 1).unwrap();
    agent_run::record_event(db.conn(), "e1", "r1", "run.started", 1).unwrap(); // seq 1
                                                                               // A forced second row at (run_id='r1', seq=1) violates UNIQUE(run_id, seq).
    let dup = db.conn().execute(
        "INSERT INTO agent_run_event (event_id, run_id, seq, kind, created_at)
         VALUES ('e_dup', 'r1', 1, 'forged', 2)",
        [],
    );
    assert!(
        dup.is_err(),
        "a duplicate (run_id, seq) must be refused by UNIQUE"
    );
}
