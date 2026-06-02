//! GATED live session smoke (Unit 6/7 send slice). Ignored by default — run it
//! explicitly to prove a real, authorized send to each provider:
//!   cargo test -p friday-providers --test live_session -- --ignored --nocapture
//!
//! This CONSUMES the account (one minimal model call per provider; operator-
//! authorized). The prompt asks for a COMPUTED value (6*7) so the "42" marker can
//! only appear if the model actually answered — it is NOT present in the prompt,
//! so this cannot pass on prompt-echo.

use friday_providers::{send_to_provider, CliProbe, CliSession, Provider};

const PROMPT: &str = "What is 6 times 7? Reply with only the number, nothing else.";

#[test]
#[ignore = "live: consumes provider account (authorized); run with --ignored"]
fn codex_live_send_produces_computed_answer() {
    let out = send_to_provider(
        &CliProbe::default(),
        &CliSession::default(),
        Provider::Codex,
        PROMPT,
    )
    .expect("codex authorized send should succeed");
    println!("codex reply: {:?}", out.text);
    assert!(
        out.text.contains("42"),
        "codex did not produce the computed answer: {:?}",
        out.text
    );
}

#[test]
#[ignore = "live: consumes provider account (authorized); run with --ignored"]
fn claude_live_send_produces_computed_answer() {
    let out = send_to_provider(
        &CliProbe::default(),
        &CliSession::default(),
        Provider::Claude,
        PROMPT,
    )
    .expect("claude authorized send should succeed");
    println!("claude reply: {:?}", out.text);
    assert!(
        out.text.contains("42"),
        "claude did not produce the computed answer: {:?}",
        out.text
    );
}
