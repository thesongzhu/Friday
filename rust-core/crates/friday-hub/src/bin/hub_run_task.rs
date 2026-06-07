//! S0 dev write-bridge — `hub_run_task`.
//!
//! PROOF-ONLY (Rust-wired-DEV). A thin one-shot bin around
//! [`friday_hub::runtime::HubRuntime::live`] + `run_task`, cloning the shape of the
//! read-only `mission_workbench_projection` bin so the Rust agent loop is reachable
//! end-to-end for a READ-MOSTLY task through a new TS→Rust transport.
//!
//! This is NOT a replacement for the (now fail-closed-fenced) TS `executeRun`. It does
//! NOT register a production route and confers no v1 GO. It exists to de-risk the
//! transport + secret boundary: prove the loop runs and emits a refs-only receipt.
//!
//! ## Output contract — REFS ONLY (no bodies, no secrets, no PII)
//! Emits a single JSON object to stdout carrying ONLY safe identifiers/refs:
//! `truth_label="rust_wired_dev"`, `run_id`, `route_id`, provider/model/route telemetry,
//! loop status + counts, the audit-chain-verified bool, and a **sha256 hash + length**
//! of the final message — NEVER the message text itself. A defensive output guard
//! rejects any forbidden marker before printing.
//!
//! ## Live key
//! [`HubRuntime::live`] reads the DeepSeek key from the env (`DeepSeekClient::from_env`,
//! never logged). Running this bin for real therefore needs `FRIDAY_DEEPSEEK_API_KEY`
//! and spends quota — that is the SEPARATE operator/coordinator live-proof step. CI only
//! BUILDS this bin; the TS bridge test spawns a scripted MOCK bin instead (no key, no
//! quota).

use std::env;
use std::io::Read;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use friday_hub::runtime::{HubConfig, HubRuntime};
use friday_storage::audit::verify_audit_chain;
use serde_json::json;
use sha2::{Digest, Sha256};

/// A fail-closed error: `kind` is a coarse, safe category (the only thing surfaced); the
/// raw detail is deliberately NOT printed so storage/init errors cannot leak paths.
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
        Ok(rendered) => {
            println!("{rendered}");
        }
        Err(err) => {
            // Refs-only error to stdout (no detail), coarse category to stderr, non-zero exit.
            let payload = json!({
                "truth_label": "rust_wired_dev",
                "proof_only": true,
                "ok": false,
                "error_kind": err.kind,
            });
            println!("{payload}");
            eprintln!("hub_run_task_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, BridgeError> {
    let args: Vec<String> = env::args().collect();

    // Task prompt: --task <prompt>, else read all of stdin (like the projection bin reads
    // its config from argv; stdin is the body-bearing channel so it stays off the argv).
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

    // Workspace root: the agent loop's fs tools are contained to this root (required).
    let workspace_root = arg_value(&args, "--workspace").ok_or(BridgeError::new("bad_args"))?;

    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    // Hub DB path: --db, else an isolated per-invocation dev DB under the workspace.
    let db_path = arg_value(&args, "--db")
        .unwrap_or_else(|| format!("{workspace_root}/.hub-run-task-dev-{pid}-{nanos}.sqlite"));

    let run_id =
        arg_value(&args, "--run-id").unwrap_or_else(|| format!("hub_run_task_dev_{pid}_{nanos}"));

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

    // Gate-approval signing secret: this is a DEV bridge driving a read-mostly task under
    // the deny-all approval policy baked into `HubRuntime::live`, where the secret is
    // DORMANT (no approval is ever minted/verified). We therefore derive ephemeral,
    // non-secret bytes from pid+nanos rather than reading any real key — nothing
    // secret-shaped is constructed or persisted.
    let secret = ephemeral_dev_secret(pid, nanos);

    let runtime = HubRuntime::live(HubConfig {
        db_path,
        workspace_root: PathBuf::from(&workspace_root),
        secret,
        max_turns,
        // Memory recall stays DISABLED in this dev bridge (no owner principal bound).
        principal_id: None,
    })
    .map_err(|_| BridgeError::new("init_failed"))?;

    let (selection, outcome) = runtime
        .run_task(&run_id, &task, now_ms)
        .map_err(|err| BridgeError::new(routed_loop_error_kind(&err)))?;

    // Audit chain verification over the composed run's DB (a bool, never the rows).
    let audit_chain_verified = verify_audit_chain(runtime.db().conn()).is_ok();

    // The final message is hashed + measured; the TEXT is never emitted.
    let final_message = outcome.final_message.unwrap_or_default();
    let final_message_len = final_message.len();
    let final_message_sha256 = sha256_hex(final_message.as_bytes());

    // route_id is a non-secret composite of provider + model identifiers.
    let route_id = format!("{}:{}", selection.provider_id, selection.model);

    let payload = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "run_id": run_id,
        "route_id": route_id,
        "provider_id": selection.provider_id,
        "model": selection.model,
        "model_size": format!("{:?}", selection.model_size),
        "backend_kind": format!("{:?}", selection.backend_kind),
        "loop_status": format!("{:?}", outcome.status),
        "turns": outcome.turns,
        "executed_tools": outcome.executed_tools,
        "final_message_sha256": final_message_sha256,
        "final_message_len": final_message_len,
        "audit_chain_verified": audit_chain_verified,
    });

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

fn routed_loop_error_kind(err: &friday_hub::routing::RoutedLoopError) -> &'static str {
    use friday_hub::routing::RoutedLoopError::*;
    match err {
        Route(_) => "route_failed",
        NoClientForProvider(_) => "no_client",
        Storage(_) => "storage_failed",
    }
}

/// Ephemeral, non-secret bytes (dormant under deny-all — see `run`). Derived, not read.
fn ephemeral_dev_secret(pid: u32, nanos: u128) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(format!("hub-run-task-dev-bridge:{pid}:{nanos}").as_bytes());
    hasher.finalize().to_vec()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Defense-in-depth: refuse to print if any forbidden marker leaked into the refs-only
/// payload. Mirrors `mission_workbench_projection`'s `reject_forbidden_output`.
fn reject_forbidden_output(rendered: &str) -> Result<(), BridgeError> {
    for marker in [
        "Authorization",
        "Bearer",
        "sk-",
        "/Users/",
        "/private/",
        "final_message\"", // the body text field must never appear (only the hash/len do)
    ] {
        if rendered.contains(marker) {
            return Err(BridgeError::new("output_guard"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{from_str, Value};

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--task".to_string(),
            "do a thing".to_string(),
            "--workspace=/tmp/ws".to_string(),
        ];
        assert_eq!(arg_value(&args, "--task").as_deref(), Some("do a thing"));
        assert_eq!(arg_value(&args, "--workspace").as_deref(), Some("/tmp/ws"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn sha256_hex_is_64_lowercase_hex_chars() {
        let hex = sha256_hex(b"friday composed dev e2e");
        assert_eq!(hex.len(), 64);
        assert!(hex
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn forbidden_output_guard_blocks_body_and_secret_markers() {
        assert!(reject_forbidden_output(r#"{"final_message":"hi"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"final_message_sha256":"00","ok":true}"#).is_ok());
    }

    #[test]
    fn ephemeral_secret_is_32_bytes_and_not_a_read_key() {
        let s = ephemeral_dev_secret(123, 456);
        assert_eq!(s.len(), 32);
    }

    #[test]
    fn refs_only_payload_shape_excludes_body_text() {
        // Mirror the success payload shape and assert the refs-only contract holds.
        let payload = json!({
            "truth_label": "rust_wired_dev",
            "proof_only": true,
            "ok": true,
            "run_id": "hub_run_task_dev_1_2",
            "route_id": "deepseek:deepseek-v4-flash",
            "final_message_sha256": sha256_hex(b"body"),
            "final_message_len": 4,
            "audit_chain_verified": true,
        });
        let rendered = serde_json::to_string(&payload).unwrap();
        assert!(reject_forbidden_output(&rendered).is_ok());
        let parsed: Value = from_str(&rendered).unwrap();
        assert_eq!(parsed["truth_label"], "rust_wired_dev");
        assert!(
            parsed.get("final_message").is_none(),
            "must never carry body text"
        );
    }
}
