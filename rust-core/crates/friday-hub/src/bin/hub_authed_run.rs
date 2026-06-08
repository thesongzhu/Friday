//! D1-Q4 — `hub_authed_run`: the internal AUTHENTICATED single-provider agent-loop route.
//!
//! PROOF-ONLY. A reachable (non-test) entrypoint that exposes the Rust agent loop
//! ([`friday_hub::runtime::HubRuntime::run_task`]) to an AUTHENTICATED caller and returns the
//! answer body ONLY to that authenticated OWNER. It reuses the EXISTING sealed-session
//! authentication ([`friday_crypto::DeviceKeypair`] ECDH → a per-session [`friday_crypto::DataKey`],
//! the same mechanism `HubServer::serve_connection` is fenced by): a caller proves possession
//! of the shared session key by sealing the agreed challenge, which the Hub OPENS with its
//! half of the session. A caller without the paired key produces a seal the Hub cannot open →
//! no `AuthedPrincipal` → no run, no body (fail-closed).
//!
//! ## Truth label
//! INTERNAL, authenticated, SINGLE-provider (`deepseek-flash`) route. NOT multi-provider, NOT
//! provider-native, NOT a v1 GO; `executeRun` is NOT replaced. The answer BODY is delivered
//! ONLY to the authenticated owner (here, SEALED back over the owner's session — the
//! owner-only channel); the bin's stdout is a PROOF surface and carries refs-only.
//!
//! ## Demonstration harness honesty
//! A real deployment authenticates an EXTERNAL paired device over the WS transport. This
//! one-shot bin pairs an in-process device to demonstrate the boundary end-to-end without a
//! live peer. The OWNER principal is HUB-SUPPLIED (`--principal`, an operator CLI arg) — NEVER
//! client-controlled — so a caller can never self-assert another principal.
//!
//! ## Output contract — REFS ONLY (no bodies, no secrets, no PII)
//! Emits ONE JSON object to stdout carrying ONLY safe identifiers/refs: `truth_label`, the
//! authed-route outcome (`delivered_to_authenticated_owner` / `denied_not_owner` /
//! `no_answer_safe_failure`), `run_id`, status, the answer's **sha256 + length** (NEVER the
//! body), the length of the owner-sealed body ciphertext, and a static, redacted-safe
//! provider/model family. A defensive output guard rejects any forbidden marker before
//! printing. The `RunAnswerAccess::Granted` body Debug is NEVER printed (`AuthedAnswer`'s
//! Debug is body-redacting, and the body is consumed only to seal it to the owner).
//!
//! ## Live key
//! [`HubRuntime::live`] reads the DeepSeek key from the env (`DeepSeekClient::from_env`, never
//! logged). Running this for real needs `FRIDAY_DEEPSEEK_API_KEY` and spends quota — the
//! SEPARATE operator/coordinator live-proof step. CI only BUILDS this bin.

use std::env;
use std::io::Read;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use friday_crypto::{seal, DeviceKeypair};
use friday_hub::hub_server::{run_authed_agent_loop, AuthedPrincipal};
use friday_hub::runtime::{HubConfig, HubRuntime};
use serde_json::json;

/// The agreed authentication challenge (a fixed, public, non-secret constant — the security
/// is in possessing the session key that seals it, not in the challenge value).
const AUTH_CHALLENGE: &[u8] = b"friday:d1q4:authed-run:challenge:v1";
/// The session AAD binding the sealed proof (and the owner-sealed body) to this exchange.
const AUTH_AAD: &[u8] = b"friday:d1q4:authed-run:aad:v1";

/// A fail-closed error: `kind` is a coarse, safe category (the only thing surfaced); the raw
/// detail is deliberately NOT printed so storage/init errors cannot leak paths.
struct BridgeError {
    kind: &'static str,
}

impl BridgeError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

fn main() {
    match run() {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            let payload = json!({
                "truth_label": "internal_authenticated_single_provider",
                "proof_only": true,
                "ok": false,
                "error_kind": err.kind,
            });
            // Defense-in-depth: route the error payload through the SAME guard as the
            // success path (fail closed if a marker ever leaked). `error_kind` is a
            // static closed-vocab token today, so this never suppresses output.
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_authed_run_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, BridgeError> {
    let args: Vec<String> = env::args().collect();

    // Task prompt: --task <prompt>, else stdin (the body-bearing channel stays off argv).
    let task = match arg_value(&args, "--task") {
        Some(task) => task,
        None => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|_| BridgeError::new("bad_args"))?;
            buf.trim().to_string()
        }
    };
    if task.is_empty() {
        return Err(BridgeError::new("bad_args"));
    }

    // The agent loop's fs tools are contained to this workspace root (required).
    let workspace_root = arg_value(&args, "--workspace").ok_or(BridgeError::new("bad_args"))?;

    // The OWNER principal is HUB-SUPPLIED here (operator CLI arg), never client-controlled.
    let principal = arg_value(&args, "--principal")
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .ok_or(BridgeError::new("bad_args"))?;

    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let db_path = arg_value(&args, "--db")
        .unwrap_or_else(|| format!("{workspace_root}/.hub-authed-run-dev-{pid}-{nanos}.sqlite"));
    let run_id =
        arg_value(&args, "--run-id").unwrap_or_else(|| format!("hub_authed_run_{pid}_{nanos}"));
    let max_turns = arg_value(&args, "--max-turns")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(6);
    let now_ms = arg_value(&args, "--now-ms")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        });

    // (a) AUTHENTICATE via the existing sealed-session mechanism. We pair an in-process device
    // (hub + caller DeviceKeypairs) and have the caller seal the agreed challenge; the Hub
    // OPENS it with its half of the ECDH session. A caller without the paired key would fail
    // here (the negative path is asserted by the hub_server unit tests). The authenticated
    // principal is the HUB-SUPPLIED owner — never anything the caller sends.
    let hub_kp = DeviceKeypair::generate();
    let caller_kp = DeviceKeypair::generate();
    let hub_session = hub_kp.agree(&caller_kp.public_bytes());
    let caller_session = caller_kp.agree(&hub_kp.public_bytes());
    let sealed_proof = seal(&caller_session, AUTH_CHALLENGE, AUTH_AAD)
        .map_err(|_| BridgeError::new("auth_seal"))?;
    let caller = AuthedPrincipal::authenticate(
        &hub_session,
        &sealed_proof,
        AUTH_AAD,
        AUTH_CHALLENGE,
        &principal,
    )
    .ok_or(BridgeError::new("auth_denied"))?;

    // (b) Build the LIVE single-provider runtime, configured with the SAME owner principal so
    // owner-wiring records owner == caller and the answer is releasable to them.
    let runtime = HubRuntime::live(HubConfig {
        db_path,
        workspace_root: PathBuf::from(&workspace_root),
        secret: ephemeral_dev_secret(pid, nanos),
        max_turns,
        principal_id: Some(principal.clone()),
        disabled_tools: vec![],
        read_only: false,
        operator_vk: None,
    })
    .map_err(|_| BridgeError::new("init_failed"))?;

    // (b)+(c) Run the loop as the authenticated principal and project the answer ONLY to the
    // authenticated owner.
    let outcome = run_authed_agent_loop(&runtime, &caller, &run_id, &task, now_ms);

    // (c) Deliver the body ONLY to the authenticated owner: SEAL it back over the owner's
    // session (the owner-only channel). The plaintext body NEVER touches stdout — we record
    // only the ciphertext length as proof that a sealed delivery occurred.
    let sealed_body_len = match outcome.delivered_body() {
        Some(body) => {
            let sealed = seal(&caller_session, body.as_bytes(), AUTH_AAD)
                .map_err(|_| BridgeError::new("deliver_seal"))?;
            Some(sealed.ciphertext.len())
        }
        None => None,
    };

    // (d) REFS-ONLY proof to stdout: outcome + status + answer FINGERPRINT (sha256/len) — never
    // the body, never a raw provider/secret/channel id. Provider/model is a static,
    // redacted-safe family label for this single-provider build.
    let mut payload = outcome.proof_refs_json();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "truth_label".into(),
            json!("internal_authenticated_single_provider"),
        );
        obj.insert("proof_only".into(), json!(true));
        obj.insert("ok".into(), json!(true));
        obj.insert("provider_family".into(), json!("deepseek"));
        obj.insert("model_class".into(), json!("flash"));
        obj.insert("multi_provider".into(), json!(false));
        obj.insert("v1_go".into(), json!(false));
        obj.insert("execute_run_replaced".into(), json!(false));
        obj.insert("authenticated".into(), json!(true));
        obj.insert(
            "auth_mechanism".into(),
            json!("sealed_session_devicekeypair"),
        );
        // Proof that the body left over the owner-only sealed channel (length only).
        obj.insert("owner_sealed_body_len".into(), json!(sealed_body_len));
    }

    let rendered =
        serde_json::to_string(&payload).map_err(|_| BridgeError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
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

/// Ephemeral, non-secret bytes (dormant under deny-all). Derived, not read from any key store.
fn ephemeral_dev_secret(pid: u32, nanos: u128) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!("hub-authed-run-dev:{pid}:{nanos}").as_bytes());
    hasher.finalize().to_vec()
}

/// Defense-in-depth: refuse to print if any forbidden marker leaked into the refs-only
/// payload. Mirrors `hub_run_task`'s guard; `answer"` (the body field) must never appear.
fn reject_forbidden_output(rendered: &str) -> Result<(), BridgeError> {
    // Delegates to the single shared guard (common secret/path markers, now broadened
    // to /home,/var,/tmp,/etc) and adds this bin's body-field marker. `"answer"` (the
    // body text field) must never appear (only the sha256/len do).
    friday_hub::refs_guard::reject_forbidden_output(rendered, &["\"answer\""])
        .map_err(|_| BridgeError::new("output_guard"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_hub::hub_server::AuthedAnswer;
    use serde_json::{from_str, Value};

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--task".to_string(),
            "do a thing".to_string(),
            "--principal=principal:owner".to_string(),
        ];
        assert_eq!(arg_value(&args, "--task").as_deref(), Some("do a thing"));
        assert_eq!(
            arg_value(&args, "--principal").as_deref(),
            Some("principal:owner")
        );
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn forbidden_output_guard_blocks_body_and_secret_markers() {
        assert!(reject_forbidden_output(r#"{"answer":"hi"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"sk-xxx"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"answer_sha256":"00","answer_len":3}"#).is_ok());
    }

    /// The refs-only proof payload shape carries the fingerprint, the truth labels, and the
    /// owner-sealed-body length — but NEVER the body field.
    #[test]
    fn refs_only_payload_shape_excludes_body_text() {
        let answer = AuthedAnswer::Delivered {
            run_id: "run-1".into(),
            status: "finished".into(),
            answer: "THE-SECRET-BODY".into(),
            answer_sha256: "00".repeat(32),
            answer_len: 15,
        };
        let mut payload = answer.proof_refs_json();
        let obj = payload.as_object_mut().unwrap();
        obj.insert(
            "truth_label".into(),
            json!("internal_authenticated_single_provider"),
        );
        obj.insert("owner_sealed_body_len".into(), json!(64));
        let rendered = serde_json::to_string(&payload).unwrap();
        // CANARY: the body never appears; the guard passes; the fingerprint does appear.
        assert!(!rendered.contains("THE-SECRET-BODY"));
        assert!(reject_forbidden_output(&rendered).is_ok());
        let parsed: Value = from_str(&rendered).unwrap();
        assert_eq!(parsed["outcome"], "delivered_to_authenticated_owner");
        assert_eq!(parsed["answer_len"], 15);
        assert!(parsed.get("answer").is_none(), "must never carry body text");
    }

    #[test]
    fn ephemeral_secret_is_32_bytes() {
        assert_eq!(ephemeral_dev_secret(1, 2).len(), 32);
    }
}
