//! LIVE key-validation proof for the R7 provider-probe — BUILT but NOT RUN.
//!
//! These tests are `#[ignore]`-d: each requires a real provider API key in the
//! environment and makes ONE minimal authenticated round-trip that may SPEND QUOTA.
//! No key is provisioned in this dark slice, so they must COMPILE but are never run
//! here (mirrors `friday-anthropic`'s `tests/live_round_trip.rs`).
//!
//! ## Quota asymmetry (read before running)
//! - **DeepSeek** — validation is an authenticated `GET /models`, which spends NO
//!   completion quota. Cheap + safe to run.
//! - **Anthropic/Claude** — validation is a minimal `POST /v1/messages`
//!   (`max_tokens=1`), which spends a TINY amount of quota (~one or two tokens), as
//!   Anthropic has no in-crate `/models` discovery.
//!
//! ## How to run later (with the key sourced on the Hub)
//! ```text
//! # DeepSeek (no completion quota):
//! FRIDAY_DEEPSEEK_API_KEY=<key> \
//!   cargo test -p friday-hub --test key_validation_live deepseek -- --ignored --nocapture
//!
//! # Anthropic/Claude (spends ~1-2 tokens):
//! FRIDAY_ANTHROPIC_API_KEY=<key> \
//!   cargo test -p friday-hub --test key_validation_live anthropic -- --ignored --nocapture
//!
//! # Both at once (operator-authorized DeepSeek + Claude live):
//! FRIDAY_DEEPSEEK_API_KEY=<k1> FRIDAY_ANTHROPIC_API_KEY=<k2> \
//!   cargo test -p friday-hub --test key_validation_live -- --ignored --nocapture
//! ```
//!
//! Each asserts the live outcome is `Valid` (the real key is accepted) through the
//! FULL real path (`from_env` → real transport → real provider), proving the
//! key-validation mechanism works end-to-end with NO fallback. SPENDS QUOTA — do not
//! run in CI.

use friday_hub::provider_key_validation::LiveKeyValidationProbe;
use friday_providers::{KeyProvider, KeyValidationOutcome, KeyValidationProbe};

#[test]
#[ignore = "live: needs FRIDAY_DEEPSEEK_API_KEY; authenticated GET /models (no completion quota); run with --ignored"]
fn deepseek_live_key_is_valid() {
    let probe = LiveKeyValidationProbe::new();
    let outcome = probe.validate(KeyProvider::DeepSeek);
    assert_eq!(
        outcome,
        KeyValidationOutcome::Valid,
        "live DeepSeek key-validation must be Valid with a real key (got {outcome:?})"
    );
    eprintln!("LIVE OK: deepseek key-validation = {outcome:?}");
}

#[test]
#[ignore = "live: needs FRIDAY_ANTHROPIC_API_KEY; POST /v1/messages max_tokens=1 (spends ~1-2 tokens); run with --ignored"]
fn anthropic_live_key_is_valid() {
    let probe = LiveKeyValidationProbe::new();
    let outcome = probe.validate(KeyProvider::Anthropic);
    assert_eq!(
        outcome,
        KeyValidationOutcome::Valid,
        "live Anthropic key-validation must be Valid with a real key (got {outcome:?})"
    );
    eprintln!("LIVE OK: anthropic key-validation = {outcome:?}");
}
