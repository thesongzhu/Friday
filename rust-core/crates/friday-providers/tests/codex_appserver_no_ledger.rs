//! PNS-002 token-safety lock: app-server health/schema/list probes are not model
//! turns and must not write token ledger rows.

use friday_providers::codex_appserver::{
    CodexAppServerClient, JsonRpcResponse, MockCodexAppServerTransport, CODEX_APP_SERVER_SYNC_MODE,
};
use friday_storage::Db;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

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
