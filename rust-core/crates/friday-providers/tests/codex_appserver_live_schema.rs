//! Ignored live-ish schema drift check. This invokes only
//! `codex app-server generate-json-schema`; it does not authenticate, start a
//! thread, or call a model.

use friday_providers::codex_appserver::CodexAppServerSchemaMethods;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
#[ignore = "local CLI check: requires codex app-server generate-json-schema"]
fn generated_codex_appserver_schema_contains_required_surface() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "friday-codex-appserver-live-schema-{}-{nanos}",
        std::process::id()
    ));
    let status = std::process::Command::new("codex")
        .args([
            "app-server",
            "generate-json-schema",
            "--out",
            dir.to_string_lossy().as_ref(),
        ])
        .status()
        .expect("codex app-server generate-json-schema should launch");
    assert!(status.success());

    let methods = CodexAppServerSchemaMethods::from_generated_bundle_dir(&dir).unwrap();
    methods.assert_required_surface().unwrap();
}
