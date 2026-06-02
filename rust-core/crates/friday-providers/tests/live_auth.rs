//! LIVE provider auth-readiness smoke (gated `#[ignore]`; needs the Hub's
//! authenticated codex + claude CLIs). Runs ONLY read-only status commands —
//! no prompt/send, so no model call and no cost. Secret-safe: prints only
//! booleans + the coarse detail label, never account identifiers. Run:
//!   cargo test -p friday-providers --test live_auth -- --ignored --nocapture

use friday_providers::{detect, CliProbe, Provider};

#[test]
#[ignore = "live: requires Hub-local authenticated codex + claude CLIs (read-only, no model call)"]
fn live_codex_and_claude_auth_ready() {
    let probe = CliProbe::default();
    let codex = detect(&probe, Provider::Codex);
    let claude = detect(&probe, Provider::Claude);

    println!(
        "[live] codex:  installed={} authenticated={} detail={}",
        codex.installed, codex.authenticated, codex.detail
    );
    println!(
        "[live] claude: installed={} authenticated={} detail={}",
        claude.installed, claude.authenticated, claude.detail
    );

    assert!(
        codex.installed,
        "codex CLI must be installed (~/.local/bin/codex)"
    );
    assert!(
        codex.authenticated,
        "codex must be logged in (codex login status)"
    );
    assert!(
        claude.installed,
        "claude CLI must be installed (~/.local/bin/claude)"
    );
    assert!(
        claude.authenticated,
        "claude must be logged in (claude auth status)"
    );
}
