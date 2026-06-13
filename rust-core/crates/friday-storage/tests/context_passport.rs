//! Context Passport persistence KATs (loop closure, commit 2; migration v30).
//!
//! Proves the v30 tables are Hub-only + forward-migrated, a built passport
//! round-trips through persist/reload, and — the load-time fail-closed invariant —
//! a directly-INSERTed secret/raw-token item makes the reload REBUILD fail (the
//! stored row is never silently trusted as a usable passport). Real SQLite, no creds.

mod common;

use common::temp_db_path;
use friday_core::{
    build_context_passport, ContextPassport, PassportItem, PassportItemKind, WorkLane,
};
use friday_storage::{hub_migrations, Db, Profile, StorageError, HUB_ONLY_TABLES};

fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

fn item(kind: PassportItemKind, label: &str, included: bool, sensitive: bool) -> PassportItem {
    PassportItem {
        kind,
        label: label.into(),
        included,
        sensitive,
    }
}

fn ok_passport(id: &str) -> ContextPassport {
    build_context_passport(
        id,
        "mission-cp",
        Some("work-cp".to_string()),
        WorkLane::Codex,
        Some("codex".to_string()),
        vec![
            item(PassportItemKind::Summary, "weekly plan", true, false),
            item(PassportItemKind::File, "design.md", false, false),
        ],
        false,
        100,
    )
    .unwrap()
}

#[test]
fn v30_tables_are_hub_only_and_forward_migrated() {
    for table in ["context_passport", "context_passport_item"] {
        assert!(HUB_ONLY_TABLES.contains(&table));
    }

    let p = temp_db_path("context-passport-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 29);
        let db = Db::open(&p, Profile::Hub, &migs, "v29").unwrap();
        assert_eq!(db.version().unwrap(), 29);
        for t in ["context_passport", "context_passport_item"] {
            assert!(
                db.conn()
                    .prepare(&format!("SELECT 1 FROM {t} LIMIT 1"))
                    .is_err(),
                "table {t} must not exist before v30"
            );
        }
    }
    // Reopen with the full set -> forward-migrate to v30 (the two additive CREATE TABLEs).
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    for t in ["context_passport", "context_passport_item"] {
        assert_eq!(
            db.count(t).unwrap(),
            0,
            "new table {t} exists and starts empty"
        );
    }
}

#[test]
fn passport_round_trips_through_persist_and_reload() {
    let db = Db::open_hub(&temp_db_path("cp-roundtrip")).unwrap();
    let passport = ok_passport("p-rt");
    db.upsert_context_passport(&passport).unwrap();

    let loaded = db.get_context_passport("p-rt").unwrap().unwrap();
    assert_eq!(loaded.passport_id, "p-rt");
    assert_eq!(loaded.mission_id, "mission-cp");
    assert_eq!(loaded.work_item_id.as_deref(), Some("work-cp"));
    assert_eq!(loaded.destination_lane, WorkLane::Codex);
    assert_eq!(loaded.destination_target.as_deref(), Some("codex"));
    assert_eq!(loaded.items.len(), 2);
    // The destination binding survives the round-trip.
    assert!(loaded.authorizes_transfer(WorkLane::Codex, Some("codex")));
    assert!(!loaded.authorizes_transfer(WorkLane::Claude, Some("codex")));
    // Only the included item is "shared".
    assert_eq!(loaded.shared_items().len(), 1);

    // list_for_mission surfaces it too.
    let listed = db.list_context_passports_for_mission("mission-cp").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].passport_id, "p-rt");

    // A missing id is None (not an error).
    assert!(db.get_context_passport("nope").unwrap().is_none());
}

#[test]
fn a_directly_inserted_secret_item_fails_closed_on_reload() {
    // The persist API can never store a secret item (build_context_passport gates it),
    // so simulate a TAMPERED row by inserting the parent + a ProviderSecret child
    // directly. The reload REBUILDS through build_context_passport, which re-runs
    // gate_transfer and refuses — the stored row never becomes a usable passport.
    let db = Db::open_hub(&temp_db_path("cp-tamper")).unwrap();
    db.conn()
        .execute(
            "INSERT INTO context_passport
                (passport_id, mission_id, work_item_id, destination_lane, destination_target,
                 approved_sensitive, created_at_ms)
             VALUES ('p-tamper', 'mission-cp', NULL, 'codex', 'codex', 1, 100)",
            [],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO context_passport_item
                (passport_id, seq, kind, label, included, sensitive)
             VALUES ('p-tamper', 0, 'provider_secret', 'leaked key', 1, 1)",
            [],
        )
        .unwrap();

    let err = db.get_context_passport("p-tamper").unwrap_err();
    assert!(
        matches!(err, StorageError::Unsupported(_)),
        "a secret-bearing row must fail the rebuild gate on load, got {err:?}"
    );
}
