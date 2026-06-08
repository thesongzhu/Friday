//! D1-substrate answer store persistence: a REAL forward migration adds the
//! Hub-only `run_result` table (preserving existing data), the table is Hub-only
//! (absent from the phone profile, asserted both ways), and the public API
//! round-trips a synthetic run result while keeping the refs-only readback
//! body-free.
//!
//! Version note: the migration max version is DERIVED from `hub_migrations()`
//! (never hardcoded), so these assertions survive a renumber if a concurrent
//! storage migration lands on the same version int.

mod common;

use common::temp_db_path;
use friday_core::SessionState;
use friday_storage::{
    get_run_result, get_run_result_ref, hub_migrations, persist_run_result, Db,
    PersistRunResultOutcome, Profile, RunResult, HUB_ONLY_TABLES,
};

/// The max migration version the current hub migration set reaches.
fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

#[test]
fn forward_migration_adds_run_result_preserving_pre_v15_data() {
    let p = temp_db_path("run-result-mig");
    // Open at the pre-v15 set and seed a row that must survive the migration.
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 14);
        let db = Db::open(&p, Profile::Hub, &migs, "v14").unwrap();
        assert_eq!(db.version().unwrap(), 14);
        assert!(
            !db.table_names().unwrap().iter().any(|t| t == "run_result"),
            "run_result must not exist before v15"
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
    // Reopen with the full hub set -> forward-migrate up to the run_result migration.
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    let tables = db.table_names().unwrap();
    assert!(
        tables.iter().any(|t| t == "run_result"),
        "run_result missing after forward migration: {tables:?}"
    );
    // Pre-existing data survived the additive migration.
    assert_eq!(db.count("session").unwrap(), 1);
    // And the new table is usable immediately.
    let result = RunResult::new("finished", "post-migration answer", None);
    persist_run_result(db.conn(), "run-mig", &result, 100).unwrap();
    assert_eq!(db.count("run_result").unwrap(), 1);
}

#[test]
fn run_result_is_hub_only_and_absent_from_phone() {
    assert!(HUB_ONLY_TABLES.contains(&"run_result"));

    // Present on the Hub profile...
    let hp = temp_db_path("run-result-hub");
    let hub = Db::open_hub(&hp).unwrap();
    assert!(hub.table_names().unwrap().iter().any(|t| t == "run_result"));

    // ...and ABSENT from the phone profile.
    let pp = temp_db_path("run-result-phone");
    let phone = Db::open_phone(&pp).unwrap();
    assert!(
        !phone
            .table_names()
            .unwrap()
            .iter()
            .any(|t| t == "run_result"),
        "run_result must not exist on a phone"
    );
}

#[test]
fn public_api_round_trips_and_refs_only_read_has_no_body() {
    let p = temp_db_path("run-result-api");
    let db = Db::open_hub(&p).unwrap();
    let answer = "BODY-CANARY-the durable answer that must stay Hub-side";
    let result = RunResult::new("finished", answer, Some("audit-1".to_string()));

    assert_eq!(
        persist_run_result(db.conn(), "run-1", &result, 1700).unwrap(),
        PersistRunResultOutcome::Persisted
    );

    // Hub-internal read returns the body...
    let stored = get_run_result(db.conn(), "run-1").unwrap().unwrap();
    assert_eq!(stored.answer, answer);
    assert_eq!(stored.answer_len, answer.len() as i64);
    assert_eq!(stored.answer_sha256.len(), 64);

    // ...the refs-only read returns the fingerprint but NEVER the body.
    let refs = get_run_result_ref(db.conn(), "run-1").unwrap().unwrap();
    assert_eq!(refs.answer_sha256, stored.answer_sha256);
    assert_eq!(refs.answer_len, stored.answer_len);
    assert_eq!(refs.status, "finished");
    assert!(
        !format!("{refs:?}").contains("BODY-CANARY"),
        "the refs-only readback must never carry the answer body"
    );
}
