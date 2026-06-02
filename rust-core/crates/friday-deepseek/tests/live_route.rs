//! LIVE Unit-3 proof — the MANDATORY DeepSeek Friday-route runtime smoke
//! (`15` §4, gate `21` §6, `18` §4). Gated `#[ignore]` so the normal
//! `cargo test --workspace` does not require network/credentials; this is the
//! ONLY test that proves `fallback=false` from REAL usage, so it must be run
//! explicitly and is the canonical Unit-3 evidence command:
//!
//! ```sh
//! set -a; . /private/tmp/friday-closure-20260530/.deepseek-env; set +a
//! cargo test -p friday-deepseek --test live_route -- --ignored --nocapture
//! ```
//!
//! Secret hygiene: the key is only read from the environment by the route; this
//! test never prints/logs it — output is limited to model id + token counts.

use friday_deepseek::{DeepSeekClient, BASE_URL_HOST};
use friday_storage::Db;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_db_path() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "friday-deepseek-live-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.push("db.sqlite");
    dir.to_string_lossy().to_string()
}

#[test]
#[ignore = "live: requires FRIDAY_DEEPSEEK_API_KEY (Hub env) + network to api.deepseek.com"]
fn live_friday_route_ledgers_fallback_false() {
    // 1. Credential from the Hub environment (never printed).
    let client = DeepSeekClient::from_env()
        .expect("FRIDAY_DEEPSEEK_API_KEY must be set in env for the live test");

    // 2. Runtime model discovery (no hardcoded stale model).
    let models = client.discover_models().expect("discover_models failed");
    assert!(!models.is_empty(), "no models discovered");
    println!("[live] models discovered: {models:?}");

    // 3. Friday route: discover -> select -> chat -> build ledger entry.
    //    max_tokens 64 so the call consumes real tokens even if reasoning tokens
    //    are spent (empty visible content is still a successful route).
    let (outcome, entry) = client
        .run_friday_ask(
            "live-l1",
            "live-s1",
            "live-a1",
            "Reply with the single word: ready.",
            64,
            1_700_000_000_000,
        )
        .expect("run_friday_ask failed");
    println!(
        "[live] model={} prompt={} completion={} total={} finish_reason={} fallback={}",
        outcome.model,
        outcome.prompt_tokens,
        outcome.completion_tokens,
        outcome.total_tokens,
        outcome.finish_reason,
        entry.fallback
    );

    // 4. Route assertions: real DeepSeek, fallback=false, real token usage.
    assert_eq!(entry.provider_kind.as_str(), "deepseek");
    assert_eq!(entry.base_url_host, BASE_URL_HOST);
    assert!(!entry.fallback, "Friday route must record fallback=false");
    assert!(entry.total_tokens > 0, "a live call must consume tokens");
    assert_eq!(
        entry.total_tokens,
        entry.prompt_tokens + entry.completion_tokens
    );
    assert!(!outcome.model.is_empty());

    // 5. Persist through Rust/Core storage and read the row back: fallback MUST
    //    be 0 in the token_ledger row (end-to-end path proof).
    let db = Db::open_hub(&temp_db_path()).expect("open hub db");
    db.insert_token_ledger(&entry).expect("insert token ledger");
    let (provider, host, fallback, total): (String, String, i64, i64) = db
        .conn()
        .query_row(
            "SELECT provider_kind, base_url_host, fallback, total_tokens
             FROM token_ledger WHERE ledger_id = 'live-l1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("read back ledger row");
    assert_eq!(provider, "deepseek");
    assert_eq!(host, "api.deepseek.com");
    assert_eq!(fallback, 0, "persisted ledger row must record fallback=0");
    assert!(total > 0);
    println!(
        "[live] ledger row persisted: provider={provider} host={host} fallback={fallback} total={total}"
    );
}
