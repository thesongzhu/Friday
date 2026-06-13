//! LIVE Codex app-server smoke (CODEX-LIVE-001). `#[ignore]`d — run only where the Codex
//! CLI is installed + logged in (`cargo test -p friday-providers --test codex_live -- --ignored`).
//!
//! Spawns `codex app-server` over stdio and drives the REAL local lifecycle:
//! `initialize` -> `initialized` -> `thread/list` (a metadata read — NO model turn, NO
//! `codex exec`). It proves Friday's LOCAL Codex control lane, labeled
//! `provider_app_server_local`; it deliberately does NOT claim official ChatGPT/Codex
//! same-account history sync (that is the operator-gated CODEX-REMOTE-001 lane).
//!
//! Honesty / safety:
//! - codex CLI absent -> graceful SKIP (not a Friday defect).
//! - codex present but a real round trip fails (login/account) -> exact blocker surfaced,
//!   never faked.
//! - a pid watchdog kills the child if the lifecycle hangs, so a blocking read can never
//!   freeze the suite.
//! - the evidence artifact records only counts + truth labels — no thread paths/contents,
//!   no account ids, no provider secrets.

use friday_providers::codex_appserver::{
    LocalCodexAppServer, CODEX_APP_SERVER_SYNC_MODE, MODEL_TURN_APPROVAL_POLICY,
};
use std::sync::mpsc;
use std::time::Duration;

#[test]
#[ignore = "live: needs Codex CLI installed + logged in"]
fn codex_app_server_local_lifecycle_smoke() {
    let program = std::env::var("CODEX_BIN").unwrap_or_else(|_| "codex".to_string());

    let mut server = match LocalCodexAppServer::spawn(&program) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("SKIP: could not spawn `{program} app-server` ({e:?}) — Codex CLI not available here");
            return;
        }
    };

    // Watchdog: if the lifecycle hangs > 20s, kill the child by pid so the blocking read
    // returns EOF and the call errors (never a frozen suite). Stood down on completion.
    let pid = server.child_id();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let watchdog = std::thread::spawn(move || {
        if done_rx.recv_timeout(Duration::from_secs(20)).is_err() {
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .status();
        }
    });

    let init = server
        .client()
        .initialize("friday-hub-live-proof", "codex-live-001");
    let inited = init.as_ref().ok().map(|_| server.client().initialized());
    let list = init
        .as_ref()
        .ok()
        .map(|_| server.client().thread_list_probe());

    // Stand down the watchdog and reap the child.
    let _ = done_tx.send(());
    let _ = watchdog.join();
    server.kill();

    // initialize MUST round-trip against a logged-in app-server. A failure here is the
    // exact (login/account/transport) blocker — surfaced, not faked.
    let summary = init.unwrap_or_else(|e| {
        panic!("BLOCKER: codex app-server `initialize` did not round-trip: {e:?} (codex logged in? `codex login status`)")
    });
    assert!(
        !summary.platform_family.is_empty() && !summary.platform_os.is_empty(),
        "initialize result missing platform fields: {summary:?}"
    );
    assert!(
        summary.user_agent.contains("friday-hub-live-proof"),
        "userAgent must echo the Friday client name: {:?}",
        summary.user_agent
    );

    let inited = inited.expect("initialized handshake attempted after initialize");
    inited.expect("initialized notification must write without error");

    let probe = list
        .expect("thread/list attempted after initialize")
        .unwrap_or_else(|e| {
            panic!("BLOCKER: codex app-server `thread/list` did not round-trip: {e:?}")
        });

    eprintln!(
        "CODEX-LIVE-001 OK: sync_mode={CODEX_APP_SERVER_SYNC_MODE} platform={}/{} thread_count={} (metadata read only; no model turn; no official-history claim)",
        summary.platform_family, summary.platform_os, probe.item_count
    );

    // Evidence — counts + truth labels only (no thread paths/contents, no account ids).
    let evidence = serde_json::json!({
        "proof": "codex_app_server_local_lifecycle_smoke",
        "sync_mode": CODEX_APP_SERVER_SYNC_MODE,
        "initialize_ok": true,
        "platform_family": summary.platform_family,
        "platform_os": summary.platform_os,
        "user_agent_echoes_client": summary.user_agent.contains("friday-hub-live-proof"),
        "initialized_ok": true,
        "thread_list_ok": true,
        "thread_count": probe.item_count,
        "model_turn_started": false,
        "official_history_claimed": false,
    });
    if let Ok(out) = std::env::var("CODEX_PROOF_OUT") {
        std::fs::write(&out, serde_json::to_string_pretty(&evidence).unwrap())
            .expect("write codex live-proof evidence");
        eprintln!("evidence written to {out}");
    }

    assert_eq!(CODEX_APP_SERVER_SYNC_MODE, "provider_app_server_local");
}

/// LIVE C1 MODEL TURN (CODEX-MODEL-TURN-001). `#[ignore]`d — this one DOES consume the
/// Codex account (it runs a real model completion). Run only deliberately, where the
/// Codex CLI is installed + logged in:
/// `cargo test -p friday-providers --test codex_live -- --ignored run_turn`.
///
/// Drives the REAL model-turn path end-to-end: spawn `codex app-server` ->
/// `initialize` -> `initialized` -> `thread/start` -> `run_turn("…ping…")` ->
/// the server's `turn/started`/`item/*`/`thread/tokenUsage/updated` notification stream
/// is drained until `turn/completed`, returning the authoritative assistant text +
/// terminal status + (if emitted) token usage. A failure surfaces the EXACT blocker
/// (login/account/transport) — never faked, never a fallback. Evidence records only
/// truth labels + counts + a boolean "non-empty content" — never the raw completion
/// text, no thread paths, no account ids, no secrets. A pid watchdog guarantees a
/// hung turn can never freeze the suite.
#[test]
#[ignore = "live: SPENDS the Codex account — needs Codex CLI installed + logged in"]
fn codex_model_turn_live_completion() {
    let program = std::env::var("CODEX_BIN").unwrap_or_else(|_| "codex".to_string());

    let mut server = match LocalCodexAppServer::spawn(&program) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("SKIP: could not spawn `{program} app-server` ({e:?}) — Codex CLI not available here");
            return;
        }
    };

    // Watchdog: a model turn is slower than a metadata read; allow 90s, then kill by pid
    // so a blocking read returns EOF and the call errors (never a frozen suite).
    let pid = server.child_id();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let watchdog = std::thread::spawn(move || {
        if done_rx.recv_timeout(Duration::from_secs(90)).is_err() {
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .status();
        }
    });

    let result = (|| {
        server
            .client()
            .initialize("friday-hub-model-turn", "codex-model-turn-001")?;
        server.client().initialized()?;
        // A fresh ephemeral-ish thread in the temp cwd; model unset (server default).
        let thread = server.client().start_thread(Some("/tmp"), None)?;
        // The actual completion: ask for a single deterministic token.
        let outcome = server.client().run_turn(
            &thread.thread_id,
            Some("friday-model-turn-001"),
            "Reply with exactly the single word: PONG",
        )?;
        Ok::<_, friday_providers::codex_appserver::CodexAppServerError>(outcome)
    })();

    let _ = done_tx.send(());
    let _ = watchdog.join();
    server.kill();

    let outcome = result.unwrap_or_else(|e| {
        panic!("BLOCKER: codex live model turn did not complete: {e:?} (codex logged in? `codex login status`)")
    });

    // The turn must reach a terminal status and produce non-empty assistant text.
    assert_eq!(
        outcome.status, "completed",
        "expected a completed turn, got status {:?}",
        outcome.status
    );
    assert!(
        !outcome.content.trim().is_empty(),
        "model turn returned empty content"
    );

    eprintln!(
        "CODEX-MODEL-TURN-001 OK: sync_mode={CODEX_APP_SERVER_SYNC_MODE} approval_policy={MODEL_TURN_APPROVAL_POLICY} status={} content_len={} usage_present={} (real completion; LOCAL control lane; no official-history claim)",
        outcome.status,
        outcome.content.len(),
        outcome.usage.is_some(),
    );

    // Evidence — truth labels + counts + booleans only (NO raw completion text, no
    // thread paths, no account ids, no secrets).
    let evidence = serde_json::json!({
        "proof": "codex_model_turn_live_completion",
        "sync_mode": CODEX_APP_SERVER_SYNC_MODE,
        "approval_policy": MODEL_TURN_APPROVAL_POLICY,
        "turn_started": true,
        "turn_status": outcome.status,
        "content_non_empty": !outcome.content.trim().is_empty(),
        "content_len": outcome.content.len(),
        "usage_present": outcome.usage.is_some(),
        "official_history_claimed": false,
    });
    if let Ok(out) = std::env::var("CODEX_PROOF_OUT") {
        std::fs::write(&out, serde_json::to_string_pretty(&evidence).unwrap())
            .expect("write codex model-turn live-proof evidence");
        eprintln!("evidence written to {out}");
    }
}
