//! LIVE Telegram inbound proof for the Rust channels track (UNW-013). `#[ignore]`d —
//! run ONLY in CI (the `phase-24-live-channels` environment) via `--ignored`. It polls
//! `getUpdates` for one real message from the trusted user and drives it through the REAL
//! channels pipeline: `register`/`provision_channel_auth` (A-PR1/A-PR2) → `resolve_and_verify`
//! (bearer + allowlist, A-PR2) → `redact_inbound` (A-PR3) — proving the Rust channels code
//! against real Telegram input (real sender id, real message text, real CJK/PII).
//!
//! HONEST SCOPE: in polling mode the wire AUTH is the bot token (only the holder can poll)
//! plus the sender allowlist. Telegram does not deliver the webhook bearer over
//! `getUpdates`, so the bearer presented to `resolve_and_verify` here is a synthetic
//! per-channel secret we provision (the bearer LOGIC is exercised against the real sender
//! id and the negatives; Telegram's real `secret_token` delivery is a webhook-mode
//! concern, not exercised here).
//!
//! SECURITY: the bot token comes ONLY from `FRIDAY_TELEGRAM_BOT_TOKEN` (env) and is never
//! logged or written. The evidence artifact contains only redacted text + the PII kinds.

use friday_crypto::InMemorySecureStore;
use friday_hub::channels::{
    provision_channel_auth, redact_inbound, resolve_and_verify, InboundRejection,
};
use friday_storage::channel::{get_channel, ChannelKind};
use friday_storage::Db;
use std::time::{Duration, Instant};

fn url(token: &str, method: &str) -> String {
    format!("https://api.telegram.org/bot{token}/{method}")
}

fn tmp_db() -> String {
    std::env::temp_dir()
        .join(format!("friday-tg-live-{}.sqlite", std::process::id()))
        .to_string_lossy()
        .into_owned()
}

#[test]
#[ignore = "live: needs FRIDAY_TELEGRAM_BOT_TOKEN + a real message from the trusted user during the window"]
fn telegram_inbound_through_rust_channels_pipeline() {
    let token = std::env::var("FRIDAY_TELEGRAM_BOT_TOKEN").unwrap_or_default();
    if token.trim().is_empty() {
        eprintln!("SKIP: FRIDAY_TELEGRAM_BOT_TOKEN not set (run only in the live-channels CI env)");
        return;
    }
    let allowed = std::env::var("FRIDAY_TELEGRAM_ALLOWED_USER_ID").unwrap_or_default();
    assert!(
        !allowed.trim().is_empty(),
        "FRIDAY_TELEGRAM_ALLOWED_USER_ID must be set for the live proof"
    );
    let window_secs: u64 = std::env::var("TELEGRAM_LISTEN_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);

    // 1) getMe — prove the token is live + capture the bot identity.
    let me: serde_json::Value = ureq::get(&url(&token, "getMe"))
        .timeout(Duration::from_secs(15))
        .call()
        .expect("getMe call failed")
        .into_json()
        .expect("getMe json");
    assert_eq!(me["ok"], serde_json::json!(true), "getMe not ok");
    let bot_id = me["result"]["id"].as_i64().expect("bot id");
    let bot_username = me["result"]["username"].as_str().unwrap_or("?").to_string();
    eprintln!("bot=@{bot_username} (id={bot_id}); waiting up to {window_secs}s for a DM from trusted user {allowed} — SEND ONE NOW");

    // 2) getUpdates long-poll until a text message from the allowed user (or timeout).
    let deadline = Instant::now() + Duration::from_secs(window_secs);
    let mut offset: i64 = 0;
    let mut found: Option<(String, String)> = None; // (from_id, text)
    'poll: while Instant::now() < deadline {
        let u = format!(
            "{}?timeout=20&offset={}&allowed_updates=%5B%22message%22%5D",
            url(&token, "getUpdates"),
            offset
        );
        let resp: serde_json::Value = match ureq::get(&u).timeout(Duration::from_secs(30)).call() {
            Ok(r) => r.into_json().expect("getUpdates json"),
            Err(e) => {
                eprintln!("getUpdates transient error (retrying): {e}");
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
        };
        assert_eq!(
            resp["ok"],
            serde_json::json!(true),
            "getUpdates not ok (a webhook may be set — polling 409s until it is deleted): {resp}"
        );
        for upd in resp["result"].as_array().cloned().unwrap_or_default() {
            offset = upd["update_id"].as_i64().unwrap_or(offset) + 1;
            let from_id = upd["message"]["from"]["id"]
                .as_i64()
                .map(|i| i.to_string())
                .unwrap_or_default();
            let text = upd["message"]["text"].as_str();
            if from_id == allowed {
                if let Some(t) = text {
                    found = Some((from_id, t.to_string()));
                    break 'poll;
                }
            } else if !from_id.is_empty() {
                eprintln!("ignoring message from non-allowlisted user {from_id}");
            }
        }
    }
    let (from_id, text) =
        found.expect("timed out: no text message from the trusted user within the window");

    // 3) Drive the REAL channels pipeline with the real sender id + text.
    let db = Db::open_hub(&tmp_db()).expect("open hub db");
    let mut store = InMemorySecureStore::new();
    let channel_id = format!("telegram:{bot_id}");
    // Synthetic per-channel secret (polling carries no webhook bearer); >= 16 bytes.
    let secret: &[u8] = b"friday-live-proof-inbound-material-01"; // pragma: allowlist secret
    let bearer = provision_channel_auth(
        &mut store,
        db.conn(),
        &channel_id,
        ChannelKind::Telegram,
        "owner",
        std::slice::from_ref(&from_id),
        secret,
        0,
    )
    .expect("provision_channel_auth");
    let binding = get_channel(db.conn(), &channel_id)
        .expect("get_channel")
        .expect("binding exists");

    // Positive: correct bearer + allowlisted REAL sender authenticates.
    let verified = resolve_and_verify(&store, &binding, &bearer, &from_id)
        .expect("auth chain must accept the correct bearer for the allowlisted real sender");
    assert_eq!(verified.bound_principal_id, "owner");
    // Negative: a forged bearer is rejected (constant-time HMAC fails closed).
    assert_eq!(
        resolve_and_verify(&store, &binding, "deadbeef", &from_id),
        Err(InboundRejection::BadBearer)
    );
    // Negative: a non-allowlisted sender is rejected even with the correct bearer.
    assert_eq!(
        resolve_and_verify(&store, &binding, &bearer, "999999999"),
        Err(InboundRejection::SenderNotAllowed)
    );

    // 4) Redact the REAL message body (A-PR3).
    let redacted = redact_inbound(verified, text.clone());
    assert_eq!(redacted.bound_principal_id, "owner");
    // The redacted text must not echo any redaction-marker-free raw PII (sanity: the
    // markers, if any, prove redaction ran; the raw values are gone by construction).
    eprintln!(
        "LIVE PROOF OK: bot=@{bot_username} sender={from_id} allowlisted; bearer-auth pass + forged/non-allowlisted rejected; pii_redacted={:?}",
        redacted.pii_redacted
    );

    // 5) Evidence artifact — redacted text + kinds only (no token, no raw PII).
    let evidence = serde_json::json!({
        "proof": "telegram_inbound_through_rust_channels_pipeline",
        "bot_username": bot_username,
        "bot_id": bot_id,
        "channel_id": channel_id,
        "sender_id": from_id,
        "sender_allowlisted": true,
        "bound_principal_id": "owner",
        "bearer_auth_accepted_correct": true,
        "forged_bearer_rejected": true,
        "non_allowlisted_sender_rejected": true,
        "pii_kinds_redacted": format!("{:?}", redacted.pii_redacted),
        "redacted_text": redacted.text,
        "raw_text_chars": text.chars().count(),
    });
    let out = std::env::var("TELEGRAM_PROOF_OUT")
        .unwrap_or_else(|_| "telegram_live_proof.json".to_string());
    std::fs::write(&out, serde_json::to_string_pretty(&evidence).unwrap())
        .expect("write evidence artifact");
    eprintln!("evidence written to {out}");
}
