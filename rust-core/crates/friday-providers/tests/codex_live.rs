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

use friday_providers::codex_appserver::{LocalCodexAppServer, CODEX_APP_SERVER_SYNC_MODE};
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
