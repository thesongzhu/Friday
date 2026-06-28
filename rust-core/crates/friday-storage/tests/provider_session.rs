//! PNS-001 provider-session contract persistence.
//!
//! Provider session links and event mirrors are Hub-only. Phone/channel surfaces
//! only receive redacted projections: no provider secrets, account hashes, cwd,
//! raw external ids, or provider URLs.

mod common;

use common::temp_db_path;
use friday_core::{ProviderSessionEvent, ProviderSessionLink, SyncMode};
use friday_storage::{hub_migrations, Db, Profile, StorageError, HUB_ONLY_TABLES};

fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

fn link() -> ProviderSessionLink {
    ProviderSessionLink {
        friday_session_id: "friday-session-1".into(),
        provider: "codex".into(),
        account_key_hash: "account-hash-never-project".into(), // pragma: allowlist secret
        workspace_id: "workspace-alpha".into(),
        cwd: Some("/Users/example/private/project".into()),
        external_session_id: Some("provider-session-id".into()),
        external_thread_id: Some("provider-thread-id".into()),
        external_url: Some("https://provider.example/private/thread".into()),
        sync_mode: SyncMode::ProviderAppServerLocal,
        capability_snapshot: "thread/start,thread/read,turn/start".into(),
        last_provider_seen_at: Some(30),
        last_friday_event_id: Some("friday-event-9".into()),
        truth_label: "Provider local session; no official app-history claim".into(),
    }
}

fn event(provider_event_id: &str, observed_at: i64) -> ProviderSessionEvent {
    ProviderSessionEvent {
        friday_session_id: "friday-session-1".into(),
        provider_event_id: provider_event_id.into(),
        provider: "codex".into(),
        event_kind: "transcript.item".into(),
        transcript_item_kind: "assistant_delta".into(),
        body_ref: "blob:body".into(),
        redaction_level: "strict".into(),
        token_ledger_ref: Some("ledger-1".into()),
        approval_ref: None,
        audit_receipt_ref: Some("audit-1".into()),
        observed_at,
    }
}

#[test]
fn provider_session_tables_are_hub_only_and_forward_migrated() {
    assert!(HUB_ONLY_TABLES.contains(&"provider_session_link"));
    assert!(HUB_ONLY_TABLES.contains(&"provider_session_event"));

    let p = temp_db_path("provider-session-mig");
    {
        let mut migs = hub_migrations();
        migs.truncate(1);
        let db = Db::open(&p, Profile::Hub, &migs, "v1").unwrap();
        assert_eq!(db.version().unwrap(), 1);
        assert!(!db
            .table_names()
            .unwrap()
            .iter()
            .any(|t| t == "provider_session_link"));
    }

    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    let tables = db.table_names().unwrap();
    assert!(tables.iter().any(|t| t == "provider_session_link"));
    assert!(tables.iter().any(|t| t == "provider_session_event"));

    let phone_path = temp_db_path("provider-session-phone");
    let phone = Db::open_phone(&phone_path).unwrap();
    let phone_tables = phone.table_names().unwrap();
    assert!(!phone_tables.iter().any(|t| t == "provider_session_link"));
    assert!(!phone_tables.iter().any(|t| t == "provider_session_event"));

    assert!(matches!(
        phone.list_provider_session_projections(),
        Err(StorageError::Unsupported(_))
    ));
}

#[test]
fn link_round_trips_and_projection_redacts_hub_only_fields() {
    let p = temp_db_path("provider-link");
    let db = Db::open_hub(&p).unwrap();
    db.upsert_provider_session_link(&link()).unwrap();

    let stored = db
        .get_provider_session_link("friday-session-1")
        .unwrap()
        .expect("link exists");
    assert_eq!(stored.sync_mode, SyncMode::ProviderAppServerLocal);
    assert_eq!(
        stored.external_url.as_deref(),
        Some("https://provider.example/private/thread")
    );

    let projections = db.list_provider_session_projections().unwrap();
    assert_eq!(projections.len(), 1);
    let rendered = format!("{:?}", projections[0]);
    for forbidden in [
        "account-hash-never-project",
        "/Users/example/private/project",
        "provider-session-id",
        "provider-thread-id",
        "https://provider.example/private/thread",
    ] {
        assert!(
            !rendered.contains(forbidden),
            "projection leaked Hub-only field {forbidden}: {rendered}"
        );
    }
    assert!(rendered.contains("workspace-alpha"));
    assert!(rendered.contains("Provider local session"));
}

#[test]
fn invalid_sync_mode_is_structurally_rejected() {
    let p = temp_db_path("provider-sync-mode");
    let db = Db::open_hub(&p).unwrap();
    let insert = db.conn().execute(
        "INSERT INTO provider_session_link
            (friday_session_id, provider, account_key_hash, workspace_id, sync_mode, truth_label)
         VALUES ('s1', 'codex', 'hash', 'workspace', 'native_synced', 'bad')",
        [],
    );
    assert!(insert.is_err(), "invalid sync mode must violate CHECK");
}

#[test]
fn event_log_requires_existing_link_orders_events_and_refuses_duplicates() {
    let p = temp_db_path("provider-events");
    let db = Db::open_hub(&p).unwrap();

    assert!(
        db.append_provider_session_event(&event("e-missing", 1))
            .is_err(),
        "event mirror must require an existing provider_session_link"
    );

    db.upsert_provider_session_link(&link()).unwrap();
    db.append_provider_session_event(&event("e2", 20)).unwrap();
    db.append_provider_session_event(&event("e1", 10)).unwrap();

    let events = db.list_provider_session_events("friday-session-1").unwrap();
    let ids: Vec<&str> = events
        .iter()
        .map(|event| event.provider_event_id.as_str())
        .collect();
    assert_eq!(ids, vec!["e1", "e2"]);

    assert!(
        db.append_provider_session_event(&event("e1", 30)).is_err(),
        "duplicate provider_event_id per Friday session must be refused"
    );
}
