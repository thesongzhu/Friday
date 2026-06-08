//! Migration tests: round-trip, idempotent reopen, refuse-when-newer, and a
//! REAL destructive migration that drives the backup guard (gate 21 §2.2/§2.3,
//! §8 Unit-2 migration tests).

mod common;

use common::temp_db_path;
use friday_core::{ActivityState, ActivityType, LedgerEntry, SessionState};
use friday_storage::{
    hub_migrations, ActivityRow, AuditEvent, Db, Migration, Profile, StorageError,
};
use rusqlite::Transaction;

/// The max migration version the current hub migration set reaches. Derived
/// (not hardcoded) so these tests survive new additive migrations landing —
/// including the concurrent PR-3b version-4 migration merging alongside PR-5's 5.
fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

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
    assert_eq!(db.version().unwrap(), hub_max_version());
    let tables = db.table_names().unwrap();
    for t in FOUNDATION_HUB_TABLES {
        assert!(
            tables.iter().any(|x| x == t),
            "missing table {t}: have {tables:?}"
        );
    }
}

#[test]
fn forward_migration_adds_run_id_preserving_pre_v13_ledger_rows() {
    // S1.2 additive migration v13: token_ledger gains a nullable run_id. A pre-v13 row
    // (the ask path's shape) must survive forward migration with run_id backfilled to NULL
    // (never mis-attributed to a run), and a new run-attributed loop bill must then work.
    let p = temp_db_path("ledger-run-id-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 12);
        let db = Db::open(&p, Profile::Hub, &migs, "v12").unwrap();
        assert_eq!(db.version().unwrap(), 12);
        assert!(
            db.conn()
                .prepare("SELECT run_id FROM token_ledger")
                .is_err(),
            "run_id column must not exist before v13"
        );
        // Seed a row with the pre-v13 13-column shape (no run_id).
        db.conn()
            .execute(
                "INSERT INTO token_ledger
                    (ledger_id, session_id, activity_id, provider_kind, model, base_url_host,
                     prompt_tokens, completion_tokens, total_tokens, cost_estimate, fallback,
                     result_link, created_at)
                 VALUES ('old1','s1','a1','deepseek','deepseek-v4-flash','api.deepseek.com',
                         11, 8, 19, NULL, 0, NULL, 100)",
                [],
            )
            .unwrap();
    }
    // Reopen with the full set -> forward-migrate to v13 (adds run_id + index).
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    assert_eq!(db.count("token_ledger").unwrap(), 1, "pre-v13 row survived");
    let run_id: Option<String> = db
        .conn()
        .query_row(
            "SELECT run_id FROM token_ledger WHERE ledger_id = 'old1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(run_id, None, "pre-v13 row backfills to NULL run_id");
    // A new run-attributed loop bill works against the migrated DB.
    let entry = LedgerEntry::friday_route(
        "new1",
        "run-1",
        "a2",
        "deepseek-v4-flash",
        5,
        5,
        None,
        None,
        200,
    )
    .unwrap();
    let activity = ActivityRow {
        activity_id: "a2".into(),
        session_id: Some("run-1".into()),
        kind: ActivityType::AskReceipt,
        state: ActivityState::Done,
        summary: "10 tokens via deepseek-v4-flash".into(),
        created_at: 200,
        updated_at: 200,
        deep_link: None,
    };
    let audit = AuditEvent {
        audit_id: "au-new".into(),
        actor: "hub-agent".into(),
        action: "agent_loop.model_call".into(),
        payload_ref: None,
        created_at: 200,
    };
    friday_storage::record_run_model_call(db.conn(), "run-1", &entry, &activity, &audit).unwrap();
    let mine = friday_storage::agent_run_read::run_token_totals(db.conn(), "run-1").unwrap();
    assert_eq!(mine.total, 10);
}

#[test]
fn forward_migration_v19_to_v20_backfills_existing_messages_to_pending() {
    // Session-memory slice-2 additive migration v20: agent_session_message gains
    // `memory_extract_status TEXT NOT NULL DEFAULT 'pending'`. A PRE-EXISTING v19
    // message row (seeded before the column existed) must survive the forward ALTER
    // with its status BACKFILLED to 'pending' (so the first post-upgrade extraction
    // still reads the full history), and `load_pending_session_messages` must return it.
    use friday_storage::agent_session::{
        ensure_session, load_pending_session_messages, SessionMessage,
    };

    let p = temp_db_path("msg-extract-status-mig");
    let seeded_id;
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 19);
        let db = Db::open(&p, Profile::Hub, &migs, "v19").unwrap();
        assert_eq!(db.version().unwrap(), 19);
        assert!(
            db.conn()
                .prepare("SELECT memory_extract_status FROM agent_session_message")
                .is_err(),
            "memory_extract_status column must not exist before v20"
        );
        // Seed a session + a message with the pre-v20 shape (no status column).
        ensure_session(db.conn(), "s1", 1).unwrap();
        seeded_id = friday_storage::agent_session::append_session_message(
            db.conn(),
            "s1",
            &SessionMessage::new("user", "remember this", None),
            10,
        )
        .unwrap();
    }
    // Reopen with the full set -> forward-migrate to v20 (the additive ALTER + index).
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    assert_eq!(
        db.count("agent_session_message").unwrap(),
        1,
        "pre-v20 message row survived the migration"
    );
    // The ALTER's DEFAULT backfilled the PRE-EXISTING row to 'pending'.
    let status: String = db
        .conn()
        .query_row(
            "SELECT memory_extract_status FROM agent_session_message WHERE message_id = ?1",
            [&seeded_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "pending", "existing row backfills to 'pending'");
    // ...and the dedup read returns it (so the first post-upgrade extraction sees it).
    let pending = load_pending_session_messages(db.conn(), "s1").unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].message_id, seeded_id);
}

#[test]
fn forward_migration_v20_to_v21_backfills_owner_to_null_and_fresh_has_columns() {
    // Session-memory slice-3 additive migration v21: agent_session gains nullable
    // `account_id`, `channel`, `user_id`. A PRE-EXISTING v20 session row (seeded before the
    // columns existed) must survive the forward ALTER reading back NULL for all three (so a
    // pre-slice-3 session is never silently bound to a default scope — it fails closed at
    // namespace resolution until an owner is set). A FRESH install has the columns.
    use friday_storage::agent_session::{
        ensure_session, ensure_session_with_owner, load_session_owner, SessionOwner,
    };

    let p = temp_db_path("agent-session-owner-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 20);
        let db = Db::open(&p, Profile::Hub, &migs, "v20").unwrap();
        assert_eq!(db.version().unwrap(), 20);
        assert!(
            db.conn()
                .prepare("SELECT user_id FROM agent_session")
                .is_err(),
            "owner columns must not exist before v21"
        );
        // Seed a session with the pre-v21 shape (no owner columns).
        ensure_session(db.conn(), "s1", 1).unwrap();
    }
    // Reopen with the full set -> forward-migrate to v21 (the additive owner ALTERs).
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    assert_eq!(
        db.count("agent_session").unwrap(),
        1,
        "pre-v21 session row survived the migration"
    );
    // The pre-existing row reads back ALL owner axes as NULL (fail-closed at resolution).
    let owner = load_session_owner(db.conn(), "s1").unwrap();
    assert_eq!(
        owner,
        Some(SessionOwner::default()),
        "pre-v21 row backfills to no-owner (all NULL)"
    );

    // A fresh ensure_session_with_owner on the migrated DB stores + reads back the owner.
    let bound = SessionOwner {
        account_id: Some("default".into()),
        channel: Some("discord".into()),
        user_id: Some("user-abc".into()),
    };
    ensure_session_with_owner(db.conn(), "s2", &bound, 2).unwrap();
    assert_eq!(load_session_owner(db.conn(), "s2").unwrap(), Some(bound));
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
        assert_eq!(db.version().unwrap(), hub_max_version());
    }
    // Reopening runs zero pending migrations and keeps the data.
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
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
            assert_eq!(code, hub_max_version());
        }
        Ok(_) => panic!("expected SchemaTooNew, got Ok"),
        Err(other) => panic!("expected SchemaTooNew, got {other:?}"),
    }
}

#[test]
fn count_rejects_unknown_or_injected_table_identifier() {
    let p = temp_db_path("count-ident");
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.count("session").unwrap(), 0);
    assert!(matches!(
        db.count("session; DROP TABLE session"),
        Err(StorageError::Unsupported(_))
    ));
    assert!(matches!(
        db.count("not_a_foundation_table"),
        Err(StorageError::Unsupported(_))
    ));
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

    // Seed is at the current hub version; add a destructive migration ABOVE the
    // current max (derived, so it always runs as the next pending version even as
    // new additive migrations land — e.g. PR-5's v5 and PR-3b's v4).
    let destructive_version = hub_max_version() + 1;
    let mut migs = hub_migrations();
    migs.push(Migration {
        version: destructive_version,
        name: "rebuild_activity",
        destructive: true,
        up: rebuild_activity_v2,
    });
    let db = Db::open(&p, Profile::Hub, &migs, "test-destructive").unwrap();
    assert_eq!(db.version().unwrap(), destructive_version);

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
