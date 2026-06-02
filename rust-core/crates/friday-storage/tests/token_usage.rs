//! `Db::list_token_usage` read projection (used by the phone-side cost view).

mod common;

use common::temp_db_path;
use friday_core::{LedgerEntry, ProviderKind};
use friday_storage::Db;

#[test]
fn list_token_usage_projects_ledger_and_surfaces_fallback() {
    let p = temp_db_path("token-usage");
    let db = Db::open_phone(&p).unwrap();
    assert!(db.list_token_usage().unwrap().is_empty());

    let e = LedgerEntry {
        ledger_id: "l1".into(),
        session_id: "s1".into(),
        activity_id: "a1".into(),
        provider_kind: ProviderKind::DeepSeek,
        model: "deepseek-v4-flash".into(),
        base_url_host: "api.deepseek.com".into(),
        prompt_tokens: 1200,
        completion_tokens: 800,
        total_tokens: 2000,
        cost_estimate: Some(0.0021),
        fallback: false,
        result_link: None,
        created_at: 1,
    };
    db.insert_token_ledger(&e).unwrap();

    let list = db.list_token_usage().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].provider_kind, "deepseek");
    assert_eq!(list[0].model, "deepseek-v4-flash");
    assert_eq!(list[0].total_tokens, 2000);
    assert_eq!(list[0].cost_estimate, Some(0.0021));
    assert!(!list[0].fallback); // the fallback flag is surfaced, here = false
}
