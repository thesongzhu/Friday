//! S6d dev resume bridge — `hub_resume_approval`.
//!
//! PROOF-ONLY (Rust-wired-DEV, the COMPLETION leg). A thin one-shot bin around
//! [`friday_hub::resume::resume_with_approval`]: given a run that Paused on a mutating
//! action (the loop persisted a `pending_approval_request`) and an operator-Ed25519-signed
//! approval (the S6c CLI stdout JSON), it INGESTS the approval, VERIFIES it against the
//! operator's PUBLIC verify key (provisioned from an OPERATOR-CONTROLLED source — never a
//! Hub-generated key), executes the ONE approved mutation, and records a truth-labeled,
//! proof-linked result.
//!
//! It NEVER mints — only verifies + consumes. A replayed / expired / wrong-digest /
//! HMAC-signed approval is refused, and no mutation runs.
//!
//! ## Operator verify key (the linchpin)
//! Resolved from `--operator-vk-path <file>` or the `FRIDAY_OPERATOR_VK_PATH` env (a file
//! the operator wrote from the S6c CLI `keygen`). UNSET/absent ⇒ fail-closed (the bin
//! refuses — there is no operator key to verify against, so nothing can be Allowed). The
//! Hub never generates the key it verifies against.
//!
//! ## Output contract — REFS ONLY (no bodies, no secrets, no PII)
//! Emits ONE JSON object to stdout: `truth_label="rust_wired_dev"`, `run_id`,
//! `approval_id`, the gate decision + reason, `executed`, `result_status`, the answer
//! fingerprint (sha256 + length) of the persisted result, and `audit_chain_verified` —
//! NEVER any body text. A defensive output guard rejects forbidden markers before printing.
//!
//! ## LIVE proof is S6e
//! This bin BUILDS in CI and is mechanism-tested via the library function. The LIVE
//! operator-approved mutating-completion proof (with a real operator-held key) is S6e (the
//! key-custody gate). PROOF-ONLY; NOT a v1 GO.

use std::env;
use std::io::Read;
use std::path::Path;

use friday_core::gate::{ApprovalDecision, CanonicalApproval, CANONICAL_GATE_ISSUER};
use friday_hub::operator_vk::load_operator_vk_from_path;
use friday_hub::resume::{resume_with_approval, ResumeError};
use friday_hub::FsToolExecutor;
use friday_storage::{audit::verify_audit_chain, get_run_result_ref, Db};
use serde::Deserialize;
use serde_json::json;

/// A fail-closed error: `kind` is a coarse, safe category (the only thing surfaced).
struct BridgeError {
    kind: &'static str,
}
impl BridgeError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

/// The operator-signed approval JSON the S6c CLI emits (mirrors its `SignedApproval`).
/// Unknown fields tolerated. `scheme` is echoed for operator review; the Hub verifies it
/// as Ed25519 regardless (it never trusts a wire-supplied scheme to pick a code path).
#[derive(Debug, Deserialize)]
struct SignedApprovalIn {
    decision: String,
    approval_id: String,
    action_digest: String,
    expires_at: i64,
    #[serde(default)]
    issuer: Option<String>,
    signature: String,
}

fn main() {
    match run() {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            let payload = json!({
                "truth_label": "rust_wired_dev",
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
            eprintln!("hub_resume_approval_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, BridgeError> {
    let args: Vec<String> = env::args().collect();

    // The Hub DB the run Paused on (carries the pending_approval_request), and the
    // workspace the fs tools are contained to.
    let db_path = arg_value(&args, "--db").ok_or(BridgeError::new("bad_args"))?;
    let workspace_root = arg_value(&args, "--workspace").ok_or(BridgeError::new("bad_args"))?;

    // The operator-signed approval JSON: --approval-json <file>, else stdin.
    let approval_json = match arg_value(&args, "--approval-json") {
        Some(p) => std::fs::read_to_string(&p).map_err(|_| BridgeError::new("bad_args"))?,
        None => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|_| BridgeError::new("bad_args"))?;
            buf
        }
    };
    let signed: SignedApprovalIn =
        serde_json::from_str(approval_json.trim()).map_err(|_| BridgeError::new("bad_approval"))?;

    // The OPERATOR-controlled verify key: --operator-vk-path <file>, else the env path.
    // Absent ⇒ fail-closed (no key to verify against ⇒ nothing can be Allowed).
    let vk_path = arg_value(&args, "--operator-vk-path")
        .or_else(|| env::var(friday_hub::operator_vk::OPERATOR_VK_PATH_ENV).ok())
        .filter(|p| !p.trim().is_empty())
        .ok_or(BridgeError::new("operator_vk_unprovisioned"))?;
    let operator_vk = load_operator_vk_from_path(Path::new(vk_path.trim()))
        .map_err(|_| BridgeError::new("operator_vk_malformed"))?;

    let now_ms = arg_value(&args, "--now-ms")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        });

    // Build the CanonicalApproval from the signed JSON. The signature is ALWAYS treated as
    // Ed25519 by the verify-only policy; an issuer/decision are mapped fail-closed.
    let approval = CanonicalApproval {
        decision: parse_decision(&signed.decision).ok_or(BridgeError::new("bad_approval"))?,
        approval_id: signed.approval_id.clone(),
        action_digest: signed.action_digest.clone(),
        expires_at: Some(signed.expires_at),
        issuer: Some(
            signed
                .issuer
                .clone()
                .unwrap_or_else(|| CANONICAL_GATE_ISSUER.to_string()),
        ),
        signature: Some(signed.signature.clone()),
    };

    let db = Db::open_hub(&db_path).map_err(|_| BridgeError::new("init_failed"))?;
    let executor = FsToolExecutor::new(&workspace_root);

    let outcome = resume_with_approval(db.conn(), &executor, &operator_vk, &approval, now_ms)
        .map_err(|e| BridgeError::new(resume_error_kind(&e)))?;

    // Refs-only result fingerprint (sha256 + length), never the body.
    let result_ref = get_run_result_ref(db.conn(), &outcome.run_id)
        .map_err(|_| BridgeError::new("storage_failed"))?;
    let (answer_sha256, answer_len) = match &result_ref {
        Some(r) => (r.answer_sha256.clone(), r.answer_len),
        None => (String::new(), 0),
    };
    let audit_chain_verified = verify_audit_chain(db.conn()).is_ok();

    let payload = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "run_id": outcome.run_id,
        "approval_id": outcome.approval_id,
        "gate_decision": format!("{:?}", outcome.decision),
        "gate_reason": outcome.reason,
        "executed": outcome.executed,
        "result_status": outcome.result_status,
        "result_answer_sha256": answer_sha256,
        "result_answer_len": answer_len,
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

fn parse_decision(s: &str) -> Option<ApprovalDecision> {
    match s {
        "approved" => Some(ApprovalDecision::Approved),
        "denied" => Some(ApprovalDecision::Denied),
        _ => None,
    }
}

/// Map a [`ResumeError`] to ONE bounded, refs-only category token (never embeds detail).
fn resume_error_kind(err: &ResumeError) -> &'static str {
    match err {
        ResumeError::UnknownNonce => "unknown_nonce",
        ResumeError::NoToolCall => "no_tool_call",
        ResumeError::Unregistered(_) => "unregistered_tool",
        ResumeError::DigestMismatch => "digest_mismatch",
        ResumeError::Storage(_) => "storage_failed",
    }
}

/// Refuse to print if any forbidden marker leaked into the refs-only payload.
fn reject_forbidden_output(rendered: &str) -> Result<(), BridgeError> {
    // Delegates to the single shared guard (common secret/path markers, now broadened
    // to /home,/var,/tmp,/etc) and adds this bin's body-field marker. A result body
    // field (`answer":"`) must never appear (only the hash/len do).
    friday_hub::refs_guard::reject_forbidden_output(rendered, &["answer\":\""])
        .map_err(|_| BridgeError::new("output_guard"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_decision_is_fail_closed() {
        assert_eq!(parse_decision("approved"), Some(ApprovalDecision::Approved));
        assert_eq!(parse_decision("denied"), Some(ApprovalDecision::Denied));
        assert_eq!(parse_decision("maybe"), None);
        assert_eq!(parse_decision(""), None);
    }

    #[test]
    fn output_guard_blocks_body_and_secret_markers() {
        assert!(reject_forbidden_output(r#"{"answer":"hi"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"result_answer_sha256":"00","ok":true}"#).is_ok());
    }

    #[test]
    fn resume_error_kinds_are_bounded_tokens() {
        assert_eq!(
            resume_error_kind(&ResumeError::UnknownNonce),
            "unknown_nonce"
        );
        assert_eq!(
            resume_error_kind(&ResumeError::DigestMismatch),
            "digest_mismatch"
        );
        assert_eq!(
            resume_error_kind(&ResumeError::Unregistered("zzz".into())),
            "unregistered_tool"
        );
    }
}
