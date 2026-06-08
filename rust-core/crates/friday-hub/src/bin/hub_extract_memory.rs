//! `hub_extract_memory` — Rust-owned INLINE session-memory extraction bin (FIRST
//! Rust-ownership slice of the memory "moat").
//!
//! PROOF-ONLY. Runs [`friday_hub::memory_extraction::extract_inline`] for ONE
//! session against a LIVE [`friday_deepseek::DeepSeekClient::from_env`], and emits a
//! REFS-ONLY JSON outcome (counts + token totals + truth labels — NEVER raw message
//! or candidate content, NEVER a secret). It mirrors the existing read-only proof
//! bins (`hub_run_readback`): opens the hub DB, renders a refs-only payload, and
//! runs that payload through the shared [`reject_forbidden_output`] guard before
//! printing; any forbidden marker fails the whole emit CLOSED (exit 2).
//!
//! ## Scope / honesty
//! - This does NOT replace or retire the TS extraction path — that path stays LIVE
//!   (Rust owns the feature pending parity).
//! - INLINE manual trigger only; the queue / job-retry / auto machine is a follow-on
//!   slice.
//! - It WRITES candidate rows + a token-ledger row (it is a write bin), but emits
//!   only counts. The persisted candidates are NON-DURABLE (`state = Candidate`) —
//!   they require explicit confirm to become recallable.
//!
//! ## CI vs live
//! CI only BUILDS this bin (it names it explicitly so a compile break reds CI).
//! Running it needs `FRIDAY_DEEPSEEK_API_KEY` + a real session DB and spends quota,
//! so the coordinator runs the live-proof separately; CI never executes it.
//!
//! ## Output contract — REFS ONLY
//! A single JSON object: `truth_label="rust_inline_memory_extraction"`,
//! `proof_only=true`, `ok`, the session/principal IDs (caller-supplied refs),
//! `messages_read`, `items_parsed`, `sensitive_dropped`, `candidates_created`,
//! and token counts (`prompt`/`completion`/`total`) + the reported `model` label.
//! NO message text, NO candidate content, NO secret.

use std::env;
use std::path::Path;

use friday_deepseek::DeepSeekClient;
use friday_hub::memory_extraction::{extract_inline, DEFAULT_MAX_ITEMS};
use friday_storage::Db;
use serde_json::json;

/// A fail-closed error: `kind` is a coarse, safe category (the only thing surfaced);
/// the raw detail is deliberately NOT printed so storage/provider errors cannot leak.
struct ExtractError {
    kind: &'static str,
}

impl ExtractError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

fn main() {
    match run() {
        Ok(rendered) => {
            println!("{rendered}");
        }
        Err(err) => {
            let payload = json!({
                "truth_label": "rust_inline_memory_extraction",
                "proof_only": true,
                "ok": false,
                "error_kind": err.kind,
            });
            // Defense-in-depth: route the error payload through the SAME guard as the
            // success path. `error_kind` is a static closed-vocab token, so this never
            // suppresses output.
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_extract_memory_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, ExtractError> {
    let args: Vec<String> = env::args().collect();

    let db_path = arg_value(&args, "--db").ok_or(ExtractError::new("bad_args"))?;
    if !Path::new(&db_path).is_file() {
        return Err(ExtractError::new("db_not_found"));
    }
    let session_id = arg_value(&args, "--session").ok_or(ExtractError::new("bad_args"))?;
    let principal_id = arg_value(&args, "--principal").ok_or(ExtractError::new("bad_args"))?;

    // Live provider client from the Hub env (FRIDAY_DEEPSEEK_API_KEY). A missing
    // credential fails CLOSED (never a fallback) — coarse category only.
    let client = DeepSeekClient::from_env().map_err(|_| ExtractError::new("credential_missing"))?;

    // A write bin: open the hub DB read-write (it records candidates + a ledger row).
    let mut db = Db::open_hub(&db_path).map_err(|_| ExtractError::new("open_failed"))?;

    let now_ms = now_ms();
    let id_prefix = format!("{session_id}:extract:{now_ms}");
    let ledger_id = format!("led:{session_id}:{now_ms}");

    let outcome = extract_inline(
        &mut db,
        &session_id,
        &principal_id,
        &client,
        DEFAULT_MAX_ITEMS,
        &id_prefix,
        &ledger_id,
        now_ms,
    )
    .map_err(map_extract_err)?;

    let payload = json!({
        "truth_label": "rust_inline_memory_extraction",
        "proof_only": true,
        "ts_path_live": true,
        "queue_auto_deferred": true,
        "ok": true,
        "session_id": session_id,
        "principal_id": principal_id,
        "messages_read": outcome.messages_read,
        "items_parsed": outcome.items_parsed,
        "sensitive_dropped": outcome.sensitive_dropped,
        "candidates_created": outcome.candidates_created,
        "token_prompt": outcome.prompt_tokens,
        "token_completion": outcome.completion_tokens,
        "token_total": outcome.total_tokens,
        "model": outcome.model,
    });

    let rendered =
        serde_json::to_string(&payload).map_err(|_| ExtractError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

/// Map an extraction-engine error to a coarse, secret-free category. The provider
/// error variant is already secret-free, but we still surface ONLY a fixed token.
fn map_extract_err(e: friday_hub::memory_extraction::ExtractionError) -> ExtractError {
    use friday_hub::memory_extraction::ExtractionError as E;
    match e {
        E::Storage(_) => ExtractError::new("storage_failed"),
        E::Provider(_) => ExtractError::new("provider_failed"),
        E::Parse => ExtractError::new("parse_failed"),
        E::BadInput(_) => ExtractError::new("bad_args"),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
        .or_else(|| {
            let prefix = format!("{name}=");
            args.iter()
                .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_string))
        })
}

/// Defense-in-depth: refuse to print if any forbidden marker leaked into the
/// refs-only projection. Delegates to the shared guard (Authorization/Bearer/sk-/
/// `/Users/`/`/private/`) plus this bin's body-field markers that must never appear:
/// no candidate `"content"` field and no session message text key.
fn reject_forbidden_output(rendered: &str) -> Result<(), ExtractError> {
    friday_hub::refs_guard::reject_forbidden_output(rendered, &["\"content\"", "\"message_text\""])
        .map_err(|_| ExtractError::new("output_guard"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{from_str, Value};

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--db".to_string(),
            "/tmp/hub.sqlite".to_string(),
            "--session=s1".to_string(),
            "--principal".to_string(),
            "alice".to_string(),
        ];
        assert_eq!(arg_value(&args, "--db").as_deref(), Some("/tmp/hub.sqlite"));
        assert_eq!(arg_value(&args, "--session").as_deref(), Some("s1"));
        assert_eq!(arg_value(&args, "--principal").as_deref(), Some("alice"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn refs_only_payload_passes_guard_and_excludes_content() {
        // Mirror the success payload shape and assert the refs-only contract holds:
        // counts/labels/ids only, NO candidate content, NO message text.
        let payload = json!({
            "truth_label": "rust_inline_memory_extraction",
            "proof_only": true,
            "ok": true,
            "session_id": "s1",
            "principal_id": "alice",
            "messages_read": 4,
            "items_parsed": 2,
            "sensitive_dropped": 1,
            "candidates_created": 1,
            "token_prompt": 42,
            "token_completion": 13,
            "token_total": 55,
            "model": "deepseek-v4-flash",
        });
        let rendered = serde_json::to_string(&payload).unwrap();
        assert!(reject_forbidden_output(&rendered).is_ok());
        let parsed: Value = from_str(&rendered).unwrap();
        assert_eq!(parsed["truth_label"], "rust_inline_memory_extraction");
        assert!(
            parsed.get("content").is_none(),
            "must never carry candidate content"
        );
        assert!(
            parsed.get("message_text").is_none(),
            "must never carry message text"
        );
    }

    #[test]
    fn guard_blocks_content_secret_and_path_markers() {
        // A candidate-content field, a secret header, and an absolute path all fail closed.
        assert!(reject_forbidden_output(r#"{"content":"raw memory body"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"message_text":"raw msg"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"k":"/Users/jarvis/secret"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"k":"sk-deadbeef"}"#).is_err());
        // A clean counts-only payload passes.
        assert!(reject_forbidden_output(
            r#"{"ok":true,"candidates_created":1,"token_total":55,"model":"deepseek-v4-flash"}"#
        )
        .is_ok());
    }

    #[test]
    fn error_payload_is_refs_only_and_passes_guard() {
        let payload = json!({
            "truth_label": "rust_inline_memory_extraction",
            "proof_only": true,
            "ok": false,
            "error_kind": "provider_failed",
        });
        let rendered = payload.to_string();
        assert!(reject_forbidden_output(&rendered).is_ok());
    }
}
