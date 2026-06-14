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
//! ## Slice-3 ownership-binding — `--principal` is now a PROOF-TIME ASSERTION
//! The store SCOPE is DERIVED from the SESSION owner (the composite namespace
//! `tenant.<account>.channel.<channel>.user.<user>.shared`), NOT a caller-supplied
//! principal. The `--principal` arg is therefore OPTIONAL and, when supplied, is treated
//! as an ASSERTION: it MUST equal the derived namespace, else the emit FAILS CLOSED
//! (`error_kind="principal_mismatch"`, exit 2). This lets the coordinator's live-proof
//! pin the expected store scope without ever overriding it. The derived namespace is
//! echoed back as `principal_id` (a store-scope LABEL — composed from normalized ids,
//! never a body) so the isolation proof is legible. A session with no resolvable owner
//! `user_id` fails closed (`error_kind="namespace_unresolvable"`).
//!
//! ## CI vs live
//! CI only BUILDS this bin (it names it explicitly so a compile break reds CI).
//! Running it needs `FRIDAY_DEEPSEEK_API_KEY` + a real session DB and spends quota,
//! so the coordinator runs the live-proof separately; CI never executes it.
//!
//! ## Output contract — REFS ONLY
//! A single JSON object: `truth_label="rust_inline_memory_extraction"`,
//! `proof_only=true`, `ok`, the session ID (a ref), the DERIVED `principal_id`
//! (= the composite namespace store scope — a label, never a body),
//! `messages_read`, `items_parsed`, `sensitive_dropped`, `candidates_created`,
//! `messages_marked_extracted` (the slice-2 dedup mark — how many source messages this
//! run consumed so a re-run skips them), and token counts (`prompt`/`completion`/
//! `total`) + the reported `model` label. NO message text, NO candidate content, NO secret.

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
    // Slice-3: `--principal` is now OPTIONAL and is a proof-time ASSERTION (it must equal
    // the SESSION-derived namespace), NOT the store key. Absent = no assertion.
    let asserted_principal = arg_value(&args, "--principal");

    // Live provider client from the Hub env (FRIDAY_DEEPSEEK_API_KEY). A missing
    // credential fails CLOSED (never a fallback) — coarse category only.
    let client = DeepSeekClient::from_env().map_err(|_| ExtractError::new("credential_missing"))?;

    // A write bin: open the hub DB read-write (it records candidates + a ledger row).
    // `extract_inline` takes a SHARED `&Db` (it uses only `&self`/`&Connection` storage ops),
    // so no `mut` binding is needed.
    let db = Db::open_hub(&db_path).map_err(|_| ExtractError::new("open_failed"))?;

    let now_ms = now_ms();
    let id_prefix = format!("{session_id}:extract:{now_ms}");
    let ledger_id = format!("led:{session_id}:{now_ms}");

    let outcome = extract_inline(
        &db,
        &session_id,
        &client,
        DEFAULT_MAX_ITEMS,
        &id_prefix,
        &ledger_id,
        now_ms,
    )
    .map_err(map_extract_err)?;

    // Slice-3 assertion: if the operator pinned an expected store scope via `--principal`,
    // it MUST equal the derived namespace — else FAIL CLOSED (the proof would otherwise
    // claim a scope the data is not actually stored under).
    if let Some(expected) = asserted_principal.as_deref() {
        if expected != outcome.derived_namespace {
            return Err(ExtractError::new("principal_mismatch"));
        }
    }

    let payload = json!({
        "truth_label": "rust_inline_memory_extraction",
        "proof_only": true,
        "ts_path_live": true,
        "queue_auto_deferred": true,
        "ownership_binding": true,
        "ok": true,
        "session_id": session_id,
        // The DERIVED store scope (the composite namespace) — slice-3 ownership-binding.
        "principal_id": outcome.derived_namespace,
        "messages_read": outcome.messages_read,
        "items_parsed": outcome.items_parsed,
        "sensitive_dropped": outcome.sensitive_dropped,
        "candidates_created": outcome.candidates_created,
        "messages_marked_extracted": outcome.messages_marked_extracted,
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
        // Slice-3: the session's memory namespace is unresolvable (no owner user_id).
        E::NamespaceUnresolvable(_) => ExtractError::new("namespace_unresolvable"),
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
            "messages_marked_extracted": 4,
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

    #[test]
    fn derived_namespace_principal_is_guard_clean() {
        // Slice-3: the echoed `principal_id` is the composite namespace store scope (a
        // label of normalized ids + dots) — it must pass the refs-only guard.
        let ns = "tenant.default.channel.discord.user.user-abc.shared";
        let payload = json!({
            "truth_label": "rust_inline_memory_extraction",
            "proof_only": true,
            "ownership_binding": true,
            "ok": true,
            "session_id": "s1",
            "principal_id": ns,
            "candidates_created": 1,
            "token_total": 55,
            "model": "deepseek-v4-flash",
        });
        let rendered = serde_json::to_string(&payload).unwrap();
        assert!(reject_forbidden_output(&rendered).is_ok());
        let parsed: Value = from_str(&rendered).unwrap();
        assert_eq!(parsed["principal_id"], ns);
    }

    #[test]
    fn namespace_unresolvable_error_payload_passes_guard() {
        let payload = json!({
            "truth_label": "rust_inline_memory_extraction",
            "proof_only": true,
            "ok": false,
            "error_kind": "namespace_unresolvable",
        });
        assert!(reject_forbidden_output(&payload.to_string()).is_ok());
        let mismatch = json!({"ok": false, "error_kind": "principal_mismatch"});
        assert!(reject_forbidden_output(&mismatch.to_string()).is_ok());
    }
}
