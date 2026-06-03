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

#[test]
fn insert_rejects_divergent_total_at_the_persistence_boundary() {
    // Audit 10A Q3 / finding 3c: even a STRUCT-LITERAL writer (pub fields) cannot
    // persist a ledger row whose total != prompt+completion. The invariant is enforced
    // at the single insert chokepoint, regardless of how the entry was constructed.
    let p = temp_db_path("token-invariant");
    let db = Db::open_phone(&p).unwrap();

    let divergent = LedgerEntry {
        ledger_id: "bad".into(),
        session_id: "s1".into(),
        activity_id: "a1".into(),
        provider_kind: ProviderKind::DeepSeek,
        model: "deepseek-v4-flash".into(),
        base_url_host: "api.deepseek.com".into(),
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 999_999, // LIE: not 1500
        cost_estimate: Some(0.01),
        fallback: false,
        result_link: None,
        created_at: 1,
    };
    let err = db.insert_token_ledger(&divergent).unwrap_err();
    assert!(
        format!("{err}").contains("token_ledger invariant"),
        "divergent total must be rejected, got: {err}"
    );
    assert_eq!(
        db.count("token_ledger").unwrap(),
        0,
        "nothing persisted on rejection"
    );

    // A correct row (total == prompt+completion) inserts fine.
    let ok = LedgerEntry {
        total_tokens: 1500,
        ..divergent
    };
    db.insert_token_ledger(&ok).unwrap();
    assert_eq!(db.count("token_ledger").unwrap(), 1);
}

#[test]
fn insert_rejects_negative_token_counts() {
    // A sign-garbage row sums consistently (prompt=-100, completion=50, total=-50) but
    // must NOT persist — it would corrupt every cost/usage projection. The persistence
    // boundary rejects negatives, mirroring the constructor.
    let p = temp_db_path("token-negative");
    let db = Db::open_phone(&p).unwrap();
    let neg = LedgerEntry {
        ledger_id: "neg".into(),
        session_id: "s1".into(),
        activity_id: "a1".into(),
        provider_kind: ProviderKind::DeepSeek,
        model: "deepseek-v4-flash".into(),
        base_url_host: "api.deepseek.com".into(),
        prompt_tokens: -100,
        completion_tokens: 50,
        total_tokens: -50, // internally consistent (-100 + 50), but negative
        cost_estimate: None,
        fallback: false,
        result_link: None,
        created_at: 1,
    };
    let err = db.insert_token_ledger(&neg).unwrap_err();
    assert!(
        format!("{err}").contains("negative token count"),
        "negative tokens must be rejected, got: {err}"
    );
    assert_eq!(db.count("token_ledger").unwrap(), 0);

    // A negative or non-finite cost is also rejected (valid counts, garbage cost).
    let bad_cost = LedgerEntry {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cost_estimate: Some(-1.0),
        ..neg
    };
    let err = db.insert_token_ledger(&bad_cost).unwrap_err();
    assert!(
        format!("{err}").contains("invalid cost_estimate"),
        "negative cost must be rejected, got: {err}"
    );
    let nan_cost = LedgerEntry {
        cost_estimate: Some(f64::NAN),
        ..bad_cost
    };
    assert!(
        db.insert_token_ledger(&nan_cost).is_err(),
        "NaN cost must be rejected"
    );
    assert_eq!(db.count("token_ledger").unwrap(), 0);
}
