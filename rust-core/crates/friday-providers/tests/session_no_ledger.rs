//! Token-safety regression lock: a provider SEND returns reply text ONLY and
//! does NOT implicitly write a `token_ledger` row (goal `07` token-trust,
//! `10` §4, `02` §13).
//!
//! KNOWN GAP (intentional, documented here): the `friday-providers` send path
//! (Codex/Claude CLI sessions) currently performs NO token accounting at all —
//! it has no storage handle and cannot ledger usage, because the provider CLIs
//! do not surface per-call token usage the way the DeepSeek route does. So real
//! provider-send token accounting is a KNOWN GAP deferred to a later Unit, NOT
//! upheld here. What IS locked by this test is the safety direction of that gap:
//! a send must never SILENTLY write a (wrong/zero) ledger row behind the
//! operator's back. We prove it by opening a real Hub and Phone DB, sending via
//! the real `send_to_provider` entry point with a `MockSession`, and asserting
//! the `token_ledger` row count is unchanged. (Contrast: the DeepSeek route in
//! `friday-deepseek` is the path that DOES ledger usage, with `fallback = false`.)

use friday_providers::{
    send_to_provider, MockSession, ProbeOutput, Provider, ProviderError, ProviderProbe,
};
use friday_storage::Db;
use std::time::{SystemTime, UNIX_EPOCH};

/// A probe stub that reports a provider as installed + authenticated, so the
/// send actually reaches the runner (we are testing the post-auth send path).
struct AuthedProbe;
impl ProviderProbe for AuthedProbe {
    fn status(&self, provider: Provider) -> Result<ProbeOutput, ProviderError> {
        // Output that `parse_status` reads as authenticated for either provider.
        let stdout = match provider {
            Provider::Codex => "Logged in using ChatGPT".to_string(),
            Provider::Claude => "{\"loggedIn\": true}".to_string(),
        };
        Ok(ProbeOutput {
            stdout,
            stderr: String::new(),
        })
    }
}

/// A fresh on-disk SQLite path (a real file is needed so migrations run).
fn temp_db_path(tag: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "friday-providers-noledger-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.push("db.sqlite");
    dir.to_string_lossy().to_string()
}

#[test]
fn provider_send_does_not_write_a_token_ledger_row_hub() {
    let db = Db::open_hub(&temp_db_path("hub")).unwrap();
    assert_eq!(
        db.count("token_ledger").unwrap(),
        0,
        "freshly migrated hub db starts with an empty token_ledger"
    );

    // A successful, authorized send through the REAL entry point.
    let runner = MockSession::new(Ok("from-codex".into()), Ok("from-claude".into()));
    let out = send_to_provider(&AuthedProbe, &runner, Provider::Claude, "hi").unwrap();
    assert_eq!(out.text, "from-claude", "send returns the reply text only");

    // The send touched the runner exactly once and wrote NO ledger row: provider
    // session control does not (and must not silently) perform token accounting.
    assert_eq!(runner.calls(), vec![Provider::Claude]);
    assert_eq!(
        db.count("token_ledger").unwrap(),
        0,
        "a provider send must not implicitly write a token_ledger row"
    );
}

#[test]
fn provider_send_does_not_write_a_token_ledger_row_phone() {
    // Same invariant on the phone profile (where token_ledger also exists).
    let db = Db::open_phone(&temp_db_path("phone")).unwrap();
    assert_eq!(db.count("token_ledger").unwrap(), 0);

    let runner = MockSession::new(Ok("from-codex".into()), Ok("from-claude".into()));
    let out = send_to_provider(&AuthedProbe, &runner, Provider::Codex, "hi").unwrap();
    assert_eq!(out.text, "from-codex");

    assert_eq!(runner.calls(), vec![Provider::Codex]);
    assert_eq!(
        db.count("token_ledger").unwrap(),
        0,
        "a provider send must not implicitly write a token_ledger row"
    );
}

#[test]
fn refused_unauthenticated_send_also_writes_no_ledger_row() {
    // Adverse path: an unauthenticated send is refused before the runner is even
    // called — and naturally writes nothing. Locks that the refusal path, too,
    // has zero ledger side effect.
    struct Unauthed;
    impl ProviderProbe for Unauthed {
        fn status(&self, provider: Provider) -> Result<ProbeOutput, ProviderError> {
            let stdout = match provider {
                Provider::Codex => "Not logged in".to_string(),
                Provider::Claude => "{\"loggedIn\": false}".to_string(),
            };
            Ok(ProbeOutput {
                stdout,
                stderr: String::new(),
            })
        }
    }

    let db = Db::open_hub(&temp_db_path("refused")).unwrap();
    let runner = MockSession::new(Ok("x".into()), Ok("y".into()));
    let r = send_to_provider(&Unauthed, &runner, Provider::Claude, "hi");
    assert!(matches!(r, Err(ProviderError::NotAuthenticated("claude"))));
    assert!(
        runner.calls().is_empty(),
        "refused send never reaches the runner"
    );
    assert_eq!(db.count("token_ledger").unwrap(), 0);
}
