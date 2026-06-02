//! Migration tests: round-trip, idempotent reopen, refuse-when-newer, and a
//! REAL destructive migration that drives the backup guard (gate 21 §2.2/§2.3,
//! §8 Unit-2 migration tests).

mod common;

use common::temp_db_path;
use friday_core::{ActivityState, ActivityType, SessionState};
use friday_storage::{hub_migrations, ActivityRow, Db, Migration, Profile, StorageError};
use rusqlite::Transaction;

const FOUNDATION_HUB_TABLES: &[&str] = &[
    "device_identity",
    "trusted_device",
    "session",
    "activity_item",
    "token_ledger",
    "audit_ledger",
    "memory_item",
    "blob_index",
    "blob_store",
    "schema_version",
];

#[test]
fn fresh_hub_db_has_all_foundation_tables() {
    let p = temp_db_path("fresh");
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), 1);
    let tables = db.table_names().unwrap();
    for t in FOUNDATION_HUB_TABLES {
        assert!(
            tables.iter().any(|x| x == t),
            "missing table {t}: have {tables:?}"
        );
    }
}

#[test]
fn reopen_is_idempotent_and_preserves_rows() {
    let p = temp_db_path("seeded");
    {
        let db = Db::open_hub(&p).unwrap();
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
        assert_eq!(db.version().unwrap(), 1);
    }
    // Reopening runs zero pending migrations and keeps the data.
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), 1);
    assert_eq!(db.count("session").unwrap(), 1);
}

#[test]
fn refuses_to_open_when_disk_newer_than_code() {
    let p = temp_db_path("toonew");
    {
        let db = Db::open_hub(&p).unwrap();
        db.conn()
            .execute("UPDATE schema_version SET version = 999 WHERE id = 1", [])
            .unwrap();
    }
    match Db::open_hub(&p) {
        Err(StorageError::SchemaTooNew { disk, code }) => {
            assert_eq!(disk, 999);
            assert_eq!(code, 1);
        }
        Ok(_) => panic!("expected SchemaTooNew, got Ok"),
        Err(other) => panic!("expected SchemaTooNew, got {other:?}"),
    }
}

/// A genuinely destructive migration: rebuild `activity_item` with an extra
/// column (drop + recreate + copy). This is what makes the backup guard fire.
fn rebuild_activity_v2(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE activity_item_new (
            activity_id TEXT PRIMARY KEY,
            session_id  TEXT,
            type        TEXT NOT NULL,
            state       TEXT NOT NULL,
            summary     TEXT NOT NULL DEFAULT '',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            deep_link   TEXT,
            priority    INTEGER NOT NULL DEFAULT 0
         );
         INSERT INTO activity_item_new
            (activity_id, session_id, type, state, summary, created_at, updated_at, deep_link)
            SELECT activity_id, session_id, type, state, summary, created_at, updated_at, deep_link
            FROM activity_item;
         DROP TABLE activity_item;
         ALTER TABLE activity_item_new RENAME TO activity_item;",
    )
}

#[test]
fn destructive_migration_creates_verified_backup() {
    let p = temp_db_path("destructive");

    // v1 + a seeded row.
    {
        let db = Db::open_hub(&p).unwrap();
        db.insert_activity(&ActivityRow {
            activity_id: "a1".into(),
            session_id: None,
            kind: ActivityType::AskStatus,
            state: ActivityState::Pending,
            summary: "seed".into(),
            created_at: 1,
            updated_at: 1,
            deep_link: None,
        })
        .unwrap();
    }

    // v1 + destructive v2.
    let mut migs = hub_migrations();
    migs.push(Migration {
        version: 2,
        name: "rebuild_activity",
        destructive: true,
        up: rebuild_activity_v2,
    });
    let db = Db::open(&p, Profile::Hub, &migs, "test-destructive").unwrap();
    assert_eq!(db.version().unwrap(), 2);

    // New column exists post-migration.
    let has_priority: i64 = db
        .conn()
        .query_row(
            "SELECT count(*) FROM pragma_table_info('activity_item') WHERE name = 'priority'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_priority, 1);

    // Data preserved across the destructive migration.
    assert_eq!(db.count("activity_item").unwrap(), 1);

    // A verified backup exists, captures the seeded row, and PREDATES the
    // destructive change (no `priority` column in the backup).
    let backups_dir = std::path::Path::new(&p).parent().unwrap().join("backups");
    let mut found_seed_backup = false;
    for entry in std::fs::read_dir(&backups_dir).unwrap() {
        let bpath = entry.unwrap().path();
        let bconn = rusqlite::Connection::open(&bpath).unwrap();
        let seeded: i64 = bconn
            .query_row(
                "SELECT count(*) FROM activity_item WHERE activity_id = 'a1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let prio: i64 = bconn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('activity_item') WHERE name = 'priority'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        if seeded == 1 {
            found_seed_backup = true;
            assert_eq!(prio, 0, "backup must predate the destructive migration");
        }
    }
    assert!(
        found_seed_backup,
        "no verified pre-migration backup with the seeded row in {backups_dir:?}"
    );
}
