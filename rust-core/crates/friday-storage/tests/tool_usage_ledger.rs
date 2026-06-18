//! B5 tool/provider usage ledger persistence.

mod common;

use common::temp_db_path;
use friday_core::ToolUsageMeasurement;
use friday_storage::{hub_migrations, record_tool_usage, Db, Profile, HUB_ONLY_TABLES};

fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

#[test]
fn tool_usage_ledger_is_hub_only_and_forward_migrated() {
    assert!(HUB_ONLY_TABLES.contains(&"tool_usage_ledger"));

    let p = temp_db_path("tool-usage-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version < 39);
        let db = Db::open(&p, Profile::Hub, &migs, "pre-b5-tool-usage").unwrap();
        assert_eq!(db.version().unwrap(), 38);
        assert!(!db
            .table_names()
            .unwrap()
            .iter()
            .any(|t| t == "tool_usage_ledger"));
    }

    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    assert!(db
        .table_names()
        .unwrap()
        .iter()
        .any(|t| t == "tool_usage_ledger"));

    let phone = Db::open_phone(&temp_db_path("tool-usage-phone")).unwrap();
    assert!(!phone
        .table_names()
        .unwrap()
        .iter()
        .any(|t| t == "tool_usage_ledger"));
}

#[test]
fn record_tool_usage_persists_explicit_units_and_run_scope() {
    let db = Db::open_hub(&temp_db_path("tool-usage-record")).unwrap();
    let usage = ToolUsageMeasurement::new(
        "ocr_extract",
        "ocr_provider",
        "stub-ocr-1",
        "image_bytes",
        12,
        "text_chars",
        34,
        None,
        Some("tool://ocr/result".to_string()),
    )
    .unwrap();

    record_tool_usage(db.conn(), &usage, Some("run-media-1"), 1234).unwrap();
    let rows = db.list_tool_usage().unwrap();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert!(row.usage_id.starts_with("toolusage:"));
    assert_eq!(row.run_id.as_deref(), Some("run-media-1"));
    assert_eq!(row.tool, "ocr_extract");
    assert_eq!(row.provider_kind, "ocr_provider");
    assert_eq!(row.model, "stub-ocr-1");
    assert_eq!(row.input_unit, "image_bytes");
    assert_eq!(row.input_count, 12);
    assert_eq!(row.output_unit, "text_chars");
    assert_eq!(row.output_count, 34);
    assert_eq!(row.result_link.as_deref(), Some("tool://ocr/result"));
}
