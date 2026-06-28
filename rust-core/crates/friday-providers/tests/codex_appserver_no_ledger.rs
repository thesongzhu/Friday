//! PNS-002 token-safety lock: app-server health/schema/list probes are not model
//! turns and must not write token ledger rows.

use friday_providers::codex_appserver::{
    map_server_message_to_provider_event, CodexAppServerClient, JsonRpcResponse,
    JsonRpcServerMessage, MockCodexAppServerTransport, ProviderMirrorContext,
    CODEX_APP_SERVER_SYNC_MODE,
};
use friday_storage::Db;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

use friday_core::{ProviderSessionLink, SyncMode};

fn temp_db_path(tag: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "friday-codex-appserver-noledger-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.push("db.sqlite");
    dir.to_string_lossy().to_string()
}

fn ok(
    result: serde_json::Value,
) -> Result<JsonRpcResponse, friday_providers::codex_appserver::CodexAppServerError> {
    Ok(JsonRpcResponse {
        id: Some(json!(1)),
        result: Some(result),
        error: None,
    })
}

fn link() -> ProviderSessionLink {
    ProviderSessionLink {
        friday_session_id: "friday-session-1".into(),
        provider: "codex".into(),
        account_key_hash: "account-hash-never-project".into(), // pragma: allowlist secret
        workspace_id: "workspace-alpha".into(),
        cwd: Some("/Users/example/private/project".into()),
        external_session_id: Some("provider-session-id".into()),
        external_thread_id: Some("thread-1".into()),
        external_url: None,
        sync_mode: SyncMode::ProviderAppServerLocal,
        capability_snapshot: "thread/start,thread/read,turn/start,turn/interrupt".into(),
        last_provider_seen_at: Some(30),
        last_friday_event_id: None,
        truth_label: "Provider local session; no official app-history claim".into(),
    }
}

#[test]
fn codex_appserver_health_probe_writes_no_token_ledger_rows() {
    let db = Db::open_hub(&temp_db_path("hub")).unwrap();
    assert_eq!(db.count("token_ledger").unwrap(), 0);

    let transport = MockCodexAppServerTransport::new(vec![
        ok(json!({
            "codexHome": "/tmp/codex",
            "platformFamily": "unix",
            "platformOs": "macos",
            "userAgent": "codex-cli 0.136.0",
        })),
        ok(json!({
            "data": [],
            "nextCursor": null,
            "backwardsCursor": null,
        })),
    ]);
    let mut client = CodexAppServerClient::new(transport);
    let summary = client.health_check("friday", "0.0.1").unwrap();
    assert_eq!(summary.sync_mode, CODEX_APP_SERVER_SYNC_MODE);
    assert_eq!(db.count("token_ledger").unwrap(), 0);
}

#[test]
fn mapped_codex_events_persist_in_provider_session_mirror_without_raw_body() {
    let db = Db::open_hub(&temp_db_path("event-mirror")).unwrap();
    db.upsert_provider_session_link(&link()).unwrap();

    let context = ProviderMirrorContext::codex("friday-session-1");
    let msg = JsonRpcServerMessage {
        id: None,
        method: "item/agentMessage/delta".to_string(),
        params: json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "item-1",
            "delta": "raw transcript body must not be in the event row",
        }),
    };
    let event = map_server_message_to_provider_event(&context, &msg, 123, 1)
        .unwrap()
        .unwrap();
    db.append_provider_session_event(&event).unwrap();

    let rows = db.list_provider_session_events("friday-session-1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].event_kind, "agent_message_delta");
    assert_eq!(rows[0].transcript_item_kind, "agent_message");
    assert_eq!(rows[0].redaction_level, "metadata_only");
    let rendered = format!("{rows:?}");
    assert!(
        !rendered.contains("raw transcript body"),
        "provider_session_event rows must reference future body storage, not inline raw provider text"
    );
}
