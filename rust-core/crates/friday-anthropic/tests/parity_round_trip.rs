//! LIVE PARITY proof: the SAME prompt through DeepSeek AND Claude — BUILT, NOT RUN.
//!
//! This test is `#[ignore]`-d: it requires BOTH live credentials
//! (`FRIDAY_DEEPSEEK_API_KEY` and `FRIDAY_ANTHROPIC_API_KEY`) and makes real calls
//! to BOTH providers that SPEND QUOTA. It is the harness for the later live parity
//! proof (S7 second-provider parity); it must compile but is never run in this dark
//! slice (no Claude credential is provisioned).
//!
//! Run it LATER like this:
//!
//! ```text
//! FRIDAY_DEEPSEEK_API_KEY=<ds> FRIDAY_ANTHROPIC_API_KEY=<an> \
//!   cargo test -p friday-anthropic --test parity_round_trip --ignored -- --nocapture
//! ```
//!
//! It asserts BOTH providers return a non-empty reply to the same prompt through
//! their respective from_env → UreqTransport → real-endpoint paths, each with NO
//! fallback. SPENDS QUOTA on BOTH providers — do not run in CI.
//!
//! Note: `friday-deepseek` is a DEV-dependency of this crate only (it never enters
//! the runtime/public graph), so this parity harness lives here without changing the
//! dark crate's dependency surface.

use friday_anthropic::{ClaudeClient, DEFAULT_MODEL as CLAUDE_MODEL};
use friday_deepseek::{select_model, DeepSeekClient};

const PROMPT: &str = "Reply with exactly the single word: PONG";

#[test]
#[ignore = "live parity: needs BOTH FRIDAY_DEEPSEEK_API_KEY + FRIDAY_ANTHROPIC_API_KEY and spends quota on both; run with --ignored"]
fn parity_round_trip() {
    // --- DeepSeek leg (the proven first provider) ---
    let ds = DeepSeekClient::from_env().expect("FRIDAY_DEEPSEEK_API_KEY must be set");
    let ds_models = ds.discover_models().expect("DeepSeek model discovery");
    let ds_model = select_model(&ds_models).expect("a DeepSeek model must be available");
    let ds_out = ds
        .chat(&ds_model, PROMPT, 64)
        .expect("DeepSeek /chat/completions round-trip (no fallback)");
    assert!(
        !ds_out.content.trim().is_empty(),
        "DeepSeek parity reply must be non-empty"
    );

    // --- Claude leg (the new second provider) ---
    let claude = ClaudeClient::from_env().expect("FRIDAY_ANTHROPIC_API_KEY must be set");
    let claude_out = claude
        .chat(CLAUDE_MODEL, PROMPT, 64)
        .expect("Claude /v1/messages round-trip (no fallback)");
    assert!(
        !claude_out.content.trim().is_empty(),
        "Claude parity reply must be non-empty"
    );

    eprintln!(
        "PARITY OK: deepseek(model={}, content={:?}) | claude(model={}, content={:?})",
        ds_out.model, ds_out.content, claude_out.model, claude_out.content
    );
}
