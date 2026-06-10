//! LIVE round-trip proof for the Claude/Anthropic route — BUILT but NOT RUN.
//!
//! This test is `#[ignore]`-d: it requires a real `FRIDAY_ANTHROPIC_API_KEY` and
//! makes ONE real `POST /v1/messages` call that SPENDS QUOTA. No Claude credential
//! is provisioned in this dark slice, so it must compile but is never run here.
//!
//! Run it LATER (with the key sourced on the Hub) exactly like this:
//!
//! ```text
//! FRIDAY_ANTHROPIC_API_KEY=<key> \
//!   cargo test -p friday-anthropic --test live_round_trip --ignored -- --nocapture
//! ```
//!
//! It asserts a non-empty assistant reply through the FULL real path
//! (from_env → UreqTransport → real api.anthropic.com), proving the route works
//! end-to-end with NO fallback. SPENDS QUOTA — do not run in CI.

use friday_anthropic::{ClaudeClient, DEFAULT_MODEL};

#[test]
#[ignore = "live: needs FRIDAY_ANTHROPIC_API_KEY and spends Anthropic quota; run with --ignored"]
fn live_round_trip() {
    // from_env FAILS CLOSED if the key is absent — this is the real Hub path.
    let client = ClaudeClient::from_env()
        .expect("FRIDAY_ANTHROPIC_API_KEY must be set to run this live test");

    // One real, small completion. `max_tokens` is REQUIRED by the Messages API.
    let outcome = client
        .chat(
            DEFAULT_MODEL,
            "Reply with exactly the single word: PONG",
            64,
        )
        .expect("live Anthropic /v1/messages round-trip must succeed (no fallback)");

    // Prove a real, non-empty assistant reply came back through the full path.
    assert!(
        !outcome.content.trim().is_empty(),
        "live reply must be non-empty; got stop_reason={:?}",
        outcome.stop_reason
    );
    // Usage must be populated by a real call.
    assert!(
        outcome.input_tokens > 0,
        "input_tokens must be > 0 on a real call"
    );
    assert!(
        outcome.output_tokens > 0,
        "output_tokens must be > 0 on a real call"
    );
    assert_eq!(
        outcome.total_tokens,
        outcome.input_tokens + outcome.output_tokens
    );

    eprintln!(
        "LIVE OK: model={} stop_reason={} in={} out={} content={:?}",
        outcome.model,
        outcome.stop_reason,
        outcome.input_tokens,
        outcome.output_tokens,
        outcome.content
    );
}
