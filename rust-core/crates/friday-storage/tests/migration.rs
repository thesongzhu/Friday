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
        ..Default::default()
    };
    ensure_session_with_owner(db.conn(), "s2", &bound, 2).unwrap();
    assert_eq!(load_session_owner(db.conn(), "s2").unwrap(), Some(bound));
}

#[test]
fn forward_migration_v22_to_v23_backfills_conversation_axes_to_null() {
    // Owner-wiring additive migration v23: agent_session gains nullable `chat_kind`,
    // `chat_id`, `parent_session_id` (the DM/subagent userId-fallback axes). A
    // PRE-EXISTING v22 session row must survive the forward ALTER reading back NULL for
    // all three — i.e. NO fallback is derivable for it, so its namespace resolution stays
    // exactly as fail-closed as before (never silently DM-attributed). A fresh bind with
    // the new axes then round-trips on the migrated DB.
    use friday_storage::agent_session::{
        ensure_session, ensure_session_with_owner, load_session_owner, SessionOwner,
    };

    let p = temp_db_path("agent-session-conv-axes-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 22);
        let db = Db::open(&p, Profile::Hub, &migs, "v22").unwrap();
        assert_eq!(db.version().unwrap(), 22);
        assert!(
            db.conn()
                .prepare("SELECT chat_kind FROM agent_session")
                .is_err(),
            "conversation-axis columns must not exist before v23"
        );
        // Seed a session with the pre-v23 owner shape (slice-3 axes only). The current
        // `ensure_session_with_owner` names the v23 columns (it requires the latest
        // schema), so the v22-era owner bind is reproduced with base ensure + raw UPDATE.
        ensure_session(db.conn(), "s1", 1).unwrap();
        db.conn()
            .execute(
                "UPDATE agent_session
                 SET account_id = 'default', channel = 'discord', user_id = 'user-abc'
                 WHERE agent_session_id = 's1'",
                [],
            )
            .unwrap();
    }
    // Reopen with the full set -> forward-migrate to v23 (the additive ALTERs).
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    let owner = load_session_owner(db.conn(), "s1").unwrap().unwrap();
    assert_eq!(owner.user_id.as_deref(), Some("user-abc"), "owner survived");
    assert_eq!(owner.chat_kind, None, "pre-v23 row backfills to NULL");
    assert_eq!(owner.chat_id, None);
    assert_eq!(owner.parent_session_id, None);
    assert_eq!(
        owner.session_kind, None,
        "pre-v23 row backfills `session_kind` to NULL ⇒ no fallback derivable (fail-closed)"
    );

    // A fresh bind with the new axes (incl. the structural `session_kind`) round-trips on
    // the migrated DB.
    let dm = SessionOwner {
        account_id: Some("default".into()),
        channel: Some("telegram".into()),
        user_id: None,
        chat_kind: Some("dm".into()),
        chat_id: Some("chat-9".into()),
        parent_session_id: None,
        session_kind: Some("conversation".into()),
    };
    ensure_session_with_owner(db.conn(), "s2", &dm, 2).unwrap();
    assert_eq!(load_session_owner(db.conn(), "s2").unwrap(), Some(dm));
}

#[test]
fn forward_migration_v25_to_v26_adds_system_intent_tables_and_preserves_v25_rows() {
    // R4 additive migration v26: four NEW Hub-only system-intent tables
    // (`system_intent_request`, `system_intent_result`, `system_control_lease`,
    // `system_intent_approval_record`). This is the NEW-TABLE migration pattern
    // (like m0015 run_result / m0005 agent_run), NOT an ALTER. A fresh v25 DB must
    // NOT have any of the tables; a v25 row seeded in a pre-existing table must
    // survive the forward migration untouched; and after reopen the schema reaches
    // the current max version with all four new tables present + usable.
    use friday_storage::system_intent::{
        acquire_control_lease, get_intent_result, insert_intent_request, IntentAction,
        IntentRequest, LeaseAcquireOutcome, NewControlLease, OwnerKind, RiskLabel,
    };

    let p = temp_db_path("system-intent-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 25);
        let db = Db::open(&p, Profile::Hub, &migs, "v25").unwrap();
        assert_eq!(db.version().unwrap(), 25);
        // None of the four R4 tables exist before v26.
        for t in [
            "system_intent_request",
            "system_intent_result",
            "system_control_lease",
            "system_intent_approval_record",
        ] {
            assert!(
                db.conn()
                    .prepare(&format!("SELECT 1 FROM {t} LIMIT 1"))
                    .is_err(),
                "table {t} must not exist before v26"
            );
        }
        // Seed a row in a PRE-EXISTING table (workflow_catalog, v25) to prove the
        // additive migration touches nothing.
        db.conn()
            .execute(
                "INSERT INTO workflow_catalog
                    (workflow_id, slug, name, description, tags_json, is_archived,
                     revision, etag, deployed_version, created_at, updated_at)
                 VALUES ('wf-pre-v26', 'pre-v26-slug', 'Pre v26', NULL, '[]', 0, 1,
                         '0000000000000000000000000000000000000000000000000000000000000000',
                         NULL, 10, 10)",
                [],
            )
            .unwrap();
    }
    // Reopen with the full set -> forward-migrate to v26 (the four additive CREATE TABLEs).
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    // The pre-existing v25 row survived the additive migration untouched.
    assert_eq!(
        db.count("workflow_catalog").unwrap(),
        1,
        "pre-v26 workflow_catalog row survived the migration"
    );
    // All four new tables are present and START EMPTY.
    for t in [
        "system_intent_request",
        "system_intent_result",
        "system_control_lease",
        "system_intent_approval_record",
    ] {
        let n: i64 = db
            .conn()
            .query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))
            .unwrap_or_else(|e| panic!("table {t} must exist + be queryable after v26: {e}"));
        assert_eq!(n, 0, "new table {t} starts empty");
    }
    // The typed API works against the migrated DB end-to-end: a request persists,
    // a lease acquires, and a deferred-action result reads back honestly.
    let request = IntentRequest {
        intent_id: "i-mig".to_string(),
        action: IntentAction::LaunchApp,
        actor_id: "agent-1".to_string(),
        actor_kind: OwnerKind::Agent,
        target_ref: Some("com.apple.Safari".to_string()),
        mutating: true,
        risk: RiskLabel::Medium,
        created_at: 100,
    };
    insert_intent_request(db.conn(), &request).unwrap();
    let nl = NewControlLease {
        lease_id: "L-mig".to_string(),
        owner_id: "agent-1".to_string(),
        owner_kind: OwnerKind::Agent,
        reason: Some("auto:launch_app".to_string()),
        ttl_ms: Some(1000),
    };
    assert!(matches!(
        acquire_control_lease(db.conn(), &nl, 100).unwrap(),
        LeaseAcquireOutcome::Acquired(_)
    ));
    assert!(get_intent_result(db.conn(), "i-mig").unwrap().is_none());
}

#[test]
fn forward_migration_v26_to_v27_adds_run_control_columns_and_preserves_v26_rows() {
    // R2 slice-2 additive migration v27: two ADDITIVE columns on the already-Hub-only
    // workflow tables — `workflow_step.attempt` (NOT NULL DEFAULT 1) and
    // `workflow_run.cancel_reason` (nullable). This is the ALTER ADD COLUMN pattern
    // (like m0013 token_ledger run_id / m0020 memory_extract_status), NOT a new table.
    // A PRE-EXISTING v26 run+step (seeded before the columns existed) must survive the
    // forward ALTER: the step's `attempt` BACKFILLS to the DEFAULT 1 (so a pre-v27 step
    // is the base attempt, never mis-counted as a retry), and the run's `cancel_reason`
    // reads back NULL (so a pre-v27 run is never silently attributed a cancel reason).
    use friday_core::WorkflowRunState;
    use friday_storage::workflow;

    let p = temp_db_path("wf-run-control-cols-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 26);
        let db = Db::open(&p, Profile::Hub, &migs, "v26").unwrap();
        assert_eq!(db.version().unwrap(), 26);
        // Neither column exists before v27.
        assert!(
            db.conn()
                .prepare("SELECT attempt FROM workflow_step")
                .is_err(),
            "workflow_step.attempt must not exist before v27"
        );
        assert!(
            db.conn()
                .prepare("SELECT cancel_reason FROM workflow_run")
                .is_err(),
            "workflow_run.cancel_reason must not exist before v27"
        );
        // Seed a run + a step with the pre-v27 shape (no attempt / cancel_reason).
        workflow::create_run(db.conn(), "r-pre-v27", "QA", 10).unwrap();
        workflow::add_step(db.conn(), "st-pre-v27", "r-pre-v27", 1, true, 10).unwrap();
    }
    // Reopen with the full set -> forward-migrate to v27 (the two additive ALTERs).
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    assert_eq!(
        db.count("workflow_run").unwrap(),
        1,
        "pre-v27 run row survived the migration"
    );
    assert_eq!(
        db.count("workflow_step").unwrap(),
        1,
        "pre-v27 step survived"
    );
    // The ALTER's DEFAULT backfilled the PRE-EXISTING step to attempt 1 (base attempt).
    assert_eq!(
        workflow::step_attempt(db.conn(), "st-pre-v27").unwrap(),
        Some(1),
        "pre-v27 step backfills to the base attempt (1)"
    );
    // The pre-existing run reads back NULL cancel_reason (never mis-attributed).
    assert_eq!(
        workflow::run_cancel_reason(db.conn(), "r-pre-v27").unwrap(),
        None,
        "pre-v27 run backfills to NULL cancel_reason"
    );
    // The typed run-control API works against the migrated DB end-to-end: cancel
    // writes the NEW terminal `Cancelled` state + a reason (NOT Failed) and reads
    // back faithfully — proving the v27 columns + the friday-core Cancelled state +
    // the parse_run_state round-trip all compose on a migrated DB.
    workflow::set_run_state(db.conn(), "r-pre-v27", WorkflowRunState::Running, 11).unwrap();
    workflow::cancel_run(db.conn(), "r-pre-v27", Some("operator requested"), 12).unwrap();
    assert_eq!(
        workflow::run_state(db.conn(), "r-pre-v27").unwrap(),
        Some(WorkflowRunState::Cancelled),
        "cancel writes terminal Cancelled (NOT Failed) and round-trips on the migrated DB"
    );
    assert_eq!(
        workflow::run_cancel_reason(db.conn(), "r-pre-v27").unwrap(),
        Some("operator requested".to_string()),
    );
}

#[test]
fn forward_migration_v28_to_v29_adds_step_effect_table_and_preserves_v28_rows() {
    // A5 additive migration v29: ONE new Hub-only table `workflow_step_effect` (the
    // per-step-effect idempotency ledger). This is the NEW-TABLE migration pattern
    // (like m0026 system_intent / m0005 agent_run), NOT an ALTER — so it touches no
    // existing table. A fresh v28 DB must NOT have the table; a v28 row seeded in a
    // pre-existing table (workflow_step) must survive the forward migration untouched;
    // and after reopen the schema reaches the current max version with the new table
    // present + usable through the typed API.
    use friday_storage::workflow;

    let p = temp_db_path("wf-step-effect-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 28);
        let db = Db::open(&p, Profile::Hub, &migs, "v28").unwrap();
        assert_eq!(db.version().unwrap(), 28);
        // The table must not exist before v29.
        assert!(
            db.conn()
                .prepare("SELECT 1 FROM workflow_step_effect LIMIT 1")
                .is_err(),
            "workflow_step_effect must not exist before v29"
        );
        // Seed a run + step (a pre-existing table) to prove the additive migration
        // touches nothing.
        workflow::create_run(db.conn(), "r-pre-v29", "ship", 10).unwrap();
        workflow::add_step(db.conn(), "r-pre-v29:s0", "r-pre-v29", 0, true, 10).unwrap();
    }
    // Reopen with the full set -> forward-migrate to v29 (the additive CREATE TABLE).
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    // The pre-existing v28 rows survived untouched.
    assert_eq!(
        db.count("workflow_run").unwrap(),
        1,
        "pre-v29 run row survived the migration"
    );
    assert_eq!(
        db.count("workflow_step").unwrap(),
        1,
        "pre-v29 step survived"
    );
    // The new table is present and STARTS EMPTY.
    assert_eq!(
        db.count("workflow_step_effect").unwrap(),
        0,
        "new table starts empty"
    );
    // The typed idempotency API works against the migrated DB end-to-end: record a
    // committed effect under its stable key and read it back.
    let key = workflow::step_effect_idem_key(
        "r-pre-v29",
        0,
        "write_file",
        &[("path".to_string(), "o".to_string())],
    );
    assert!(workflow::committed_effect(db.conn(), &key)
        .unwrap()
        .is_none());
    workflow::record_committed_effect(
        db.conn(),
        &key,
        "r-pre-v29",
        "r-pre-v29:s0",
        0,
        "write_file",
        "committed on migrated db",
        None,
        11,
    )
    .unwrap();
    assert_eq!(
        workflow::committed_effect(db.conn(), &key)
            .unwrap()
            .unwrap()
            .receipt_summary,
        "committed on migrated db",
    );
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
