//! LIVE Claude local-mirror smoke (CLAUDE-MIRROR-001). `#[ignore]`d — run only where the
//! Claude CLI is installed + logged in
//! (`cargo test -p friday-providers --test claude_live -- --ignored`).
//!
//! Two legs, both reusing the CLAUDE-001 contract substrate:
//! 1. Capability classification (NO model turn): parse the live `claude --help` →
//!    `classify_stream_json_surface` must be `friday_local_mirror`.
//! 2. Live stream-json mirror (ONE model turn — the stream-json path inherently runs a
//!    turn; provider live sends are operator-authorized): run
//!    `claude -p … --output-format stream-json` and fold the REAL event stream through
//!    `map_stream_json_to_provider_event` into metadata-only `ProviderSessionEvent`s.
//!
//! Truth: `friday_local_mirror` — Friday owns the transcript. This is NOT Claude Remote
//! Control and NOT provider-native sync (those stay operator-gated). Redaction is proven
//! by a distinctive prompt sentinel that must NEVER appear in any mirrored event. codex
//! CLI absent → graceful SKIP; a live failure → exact blocker, never faked.

use friday_core::SyncMode;
use friday_providers::claude_control::{
    classify_stream_json_surface, ClaudeMirrorContext, LocalClaudeMirror,
    CLAUDE_STREAM_JSON_SYNC_MODE,
};
use std::time::Duration;

const SENTINEL: &str = "FRIDAYMIRRORPROBE7";

#[test]
#[ignore = "live: needs Claude CLI installed + logged in (runs one authorized stream-json turn)"]
fn claude_stream_json_local_mirror_smoke() {
    let program = std::env::var("CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string());

    // Leg 1 — capability classification (no model turn).
    let caps = match LocalClaudeMirror::capabilities(&program) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "SKIP: could not run `{program} --help` ({e:?}) — Claude CLI not available here"
            );
            return;
        }
    };
    assert!(
        caps.has_local_stream_surface(),
        "live claude --help must expose the stream-json local-mirror surface: {caps:?}"
    );
    let surface = classify_stream_json_surface(&caps);
    assert_eq!(surface.sync_mode, SyncMode::FridayLocalMirror);
    assert_eq!(
        surface.truth_label,
        "claude_stream_json_friday_local_mirror"
    );
    assert_eq!(CLAUDE_STREAM_JSON_SYNC_MODE, "friday_local_mirror");

    // Leg 2 — live stream-json mirror (one authorized turn).
    let context = ClaudeMirrorContext::claude("friday-claude-mirror-live");
    let prompt = format!("Reply with only this exact token and nothing else: {SENTINEL}");
    let run = LocalClaudeMirror::mirror_stream_json(
        &program,
        &prompt,
        &context,
        0,
        Duration::from_secs(90),
    )
    .unwrap_or_else(|e| panic!("BLOCKER: claude stream-json mirror failed: {e:?} (claude logged in? `claude auth status`)"));

    assert!(
        !run.events.is_empty(),
        "BLOCKER: live stream-json produced no mappable events (login/account?)"
    );
    assert!(
        run.session_id.is_some(),
        "stream-json events must carry a session_id"
    );
    // Every mirrored event is metadata-only, and NONE inlines the raw transcript: the
    // model echoes the sentinel in its answer, but the metadata-only mapper must not
    // carry it.
    for event in &run.events {
        assert_eq!(
            event.redaction_level, "metadata_only",
            "every mirrored event must be metadata_only: {event:?}"
        );
        assert_eq!(event.provider, "claude");
        let debug = format!("{event:?}");
        assert!(
            !debug.contains(SENTINEL),
            "raw transcript leaked into a mirrored event: {debug}"
        );
    }
    let kinds: Vec<&str> = run.events.iter().map(|e| e.event_kind.as_str()).collect();

    eprintln!(
        "CLAUDE-MIRROR-001 OK: sync_mode={CLAUDE_STREAM_JSON_SYNC_MODE} events={} unmapped={} kinds={kinds:?} (Friday-owned mirror; NOT Remote Control; NOT provider-native sync)",
        run.events.len(),
        run.unmapped_count,
    );

    // Evidence — counts + kinds + truth labels only (no raw transcript, no account ids).
    let evidence = serde_json::json!({
        "proof": "claude_stream_json_local_mirror_smoke",
        "sync_mode": CLAUDE_STREAM_JSON_SYNC_MODE,
        "stream_json_surface_friday_local_mirror": true,
        "has_local_stream_surface": caps.has_local_stream_surface(),
        "remote_control_claimed": false,
        "provider_native_synced_claimed": false,
        "mirrored_event_count": run.events.len(),
        "unmapped_line_count": run.unmapped_count,
        "event_kinds": kinds,
        "all_events_metadata_only": true,
        "sentinel_redacted_from_all_events": true,
        "session_id_present": run.session_id.is_some(),
    });
    if let Ok(out) = std::env::var("CLAUDE_PROOF_OUT") {
        std::fs::write(&out, serde_json::to_string_pretty(&evidence).unwrap())
            .expect("write claude live-proof evidence");
        eprintln!("evidence written to {out}");
    }
}
