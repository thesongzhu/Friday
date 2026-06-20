//! D20 trust-dial worktree batch artifact consumer.
//!
//! VERIFY-ONLY. This bin consumes an operator-signed `CanonicalApprovalBatch` artifact and
//! dispatches one exact Hub tool call through the D20 worktree driver. It never reads an
//! operator private key, never signs, and never mints approvals. The signed batch is verified
//! against the operator PUBLIC verify key, single-use replay is consumed in storage, and
//! Irreversible / out-of-worktree actions pause before the executor.
//!
//! The action JSON must describe the same Hub raw tool call shape used to compute the signed
//! digest: actor Agent `hub-agent`, surface `agent`, optional `principal_id`, canonical params,
//! no idempotency key, and no plan digest. Wider operator-review schemas stay on the prepare side;
//! this bin is deliberately narrow so it cannot drift from the Hub dispatch chokepoint.
//!
//! Output is refs-only JSON: no file bodies, no secrets, no private paths.

use std::env;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use friday_core::gate::{ApprovalDecision, CanonicalApprovalBatch, CANONICAL_GATE_ISSUER};
use friday_hub::operator_vk::load_operator_vk_from_path;
use friday_hub::{
    d20_dispatch_signed_batch_artifact_in_worktree, D20WorktreeBatchOutcome, FsToolExecutor,
    RawToolCall, RunPolicy,
};
use friday_storage::{audit::verify_audit_chain, Db, DialWorktreeScope};
use serde::Deserialize;
use serde_json::json;

struct BridgeError {
    kind: &'static str,
}

impl BridgeError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

#[derive(Debug, Deserialize)]
struct SignedBatchIn {
    decision: String,
    batch_sign_id: String,
    action_digests: Vec<String>,
    expires_at: i64,
    #[serde(default)]
    issuer: Option<String>,
    signature: String,
}

#[derive(Debug, Deserialize)]
struct ActionIn {
    action: String,
    #[serde(default)]
    params: Vec<ActionParamIn>,
    #[serde(default)]
    principal_id: Option<String>,
    #[serde(default)]
    disabled_tools: Vec<String>,
    #[serde(default)]
    read_only: bool,
}

#[derive(Debug, Deserialize)]
struct ActionParamIn {
    key: String,
    value: String,
}

fn main() {
    match run() {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            let payload = json!({
                "truth_label": "d20_worktree_signed_batch_artifact",
                "proof_only": true,
                "ok": false,
                "error_kind": err.kind,
            });
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_d20_signed_batch_worktree_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, BridgeError> {
    let args: Vec<String> = env::args().collect();
    let db_path = arg_value(&args, "--db").ok_or(BridgeError::new("bad_args"))?;
    let workspace_root = arg_value(&args, "--workspace").ok_or(BridgeError::new("bad_args"))?;
    let signed_path =
        arg_value(&args, "--signed-batch-json").ok_or(BridgeError::new("bad_args"))?;
    let action_path = arg_value(&args, "--action-json").ok_or(BridgeError::new("bad_args"))?;

    let signed: SignedBatchIn =
        read_json_file(&signed_path).map_err(|_| BridgeError::new("bad_signed_batch"))?;
    let action: ActionIn =
        read_json_file(&action_path).map_err(|_| BridgeError::new("bad_action"))?;

    let vk_path = arg_value(&args, "--operator-vk-path")
        .or_else(|| env::var(friday_hub::operator_vk::OPERATOR_VK_PATH_ENV).ok())
        .filter(|p| !p.trim().is_empty())
        .ok_or(BridgeError::new("operator_vk_unprovisioned"))?;
    let operator_vk = load_operator_vk_from_path(Path::new(vk_path.trim()))
        .map_err(|_| BridgeError::new("operator_vk_malformed"))?;

    let now_ms = arg_value(&args, "--now-ms")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or_else(current_epoch_ms);

    let batch = CanonicalApprovalBatch {
        decision: parse_decision(&signed.decision).ok_or(BridgeError::new("bad_signed_batch"))?,
        batch_sign_id: nonempty(signed.batch_sign_id, "bad_signed_batch")?,
        action_digests: signed.action_digests,
        expires_at: Some(signed.expires_at),
        issuer: Some(
            signed
                .issuer
                .unwrap_or_else(|| CANONICAL_GATE_ISSUER.to_string()),
        ),
        signature: Some(nonempty(signed.signature, "bad_signed_batch")?),
    };

    let raw = RawToolCall {
        action: nonempty(action.action, "bad_action")?,
        params: action
            .params
            .into_iter()
            .map(|p| Ok((nonempty(p.key, "bad_action")?, p.value)))
            .collect::<Result<Vec<_>, BridgeError>>()?,
    };
    let policy = RunPolicy::new(action.principal_id, action.disabled_tools, action.read_only);
    let scope = DialWorktreeScope {
        plan_sign_id: batch.batch_sign_id.clone(),
        active_worktree: Path::new(&workspace_root).to_path_buf(),
    };

    let mut db = Db::open_hub(&db_path).map_err(|_| BridgeError::new("init_failed"))?;
    let executor = FsToolExecutor::new(&workspace_root);
    let outcome = d20_dispatch_signed_batch_artifact_in_worktree(
        db.conn_mut(),
        &executor,
        &raw,
        &operator_vk,
        &batch,
        &scope,
        &policy,
        now_ms,
    )
    .map_err(|_| BridgeError::new("storage_failed"))?;

    let audit_chain_verified = verify_audit_chain(db.conn()).is_ok();
    let payload = match outcome {
        D20WorktreeBatchOutcome::Executed { action, summary } => json!({
            "truth_label": "d20_worktree_signed_batch_artifact",
            "proof_only": true,
            "ok": true,
            "executed": true,
            "result_status": "executed",
            "action": action,
            "summary": summary,
            "batch_sign_id": batch.batch_sign_id,
            "audit_chain_verified": audit_chain_verified,
        }),
        D20WorktreeBatchOutcome::ExecError { .. } => json!({
            "truth_label": "d20_worktree_signed_batch_artifact",
            "proof_only": true,
            "ok": false,
            "executed": false,
            "result_status": "exec_error",
            "batch_sign_id": batch.batch_sign_id,
            "audit_chain_verified": audit_chain_verified,
        }),
        D20WorktreeBatchOutcome::RequiresApproval => json!({
            "truth_label": "d20_worktree_signed_batch_artifact",
            "proof_only": true,
            "ok": true,
            "executed": false,
            "result_status": "requires_approval",
            "batch_sign_id": batch.batch_sign_id,
            "audit_chain_verified": audit_chain_verified,
        }),
        D20WorktreeBatchOutcome::Denied { reason } => json!({
            "truth_label": "d20_worktree_signed_batch_artifact",
            "proof_only": true,
            "ok": true,
            "executed": false,
            "result_status": "denied",
            "reason": reason,
            "batch_sign_id": batch.batch_sign_id,
            "audit_chain_verified": audit_chain_verified,
        }),
        D20WorktreeBatchOutcome::Unregistered { action } => json!({
            "truth_label": "d20_worktree_signed_batch_artifact",
            "proof_only": true,
            "ok": true,
            "executed": false,
            "result_status": "unregistered",
            "action": action,
            "batch_sign_id": batch.batch_sign_id,
            "audit_chain_verified": audit_chain_verified,
        }),
    };
    let rendered =
        serde_json::to_string(&payload).map_err(|_| BridgeError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &str) -> Result<T, ()> {
    let contents = std::fs::read_to_string(path).map_err(|_| ())?;
    serde_json::from_str(&contents).map_err(|_| ())
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

fn nonempty(value: String, kind: &'static str) -> Result<String, BridgeError> {
    if value.trim().is_empty() {
        Err(BridgeError::new(kind))
    } else {
        Ok(value)
    }
}

fn current_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn reject_forbidden_output(rendered: &str) -> Result<(), BridgeError> {
    friday_hub::refs_guard::reject_forbidden_output(rendered, &["\"content\"", "\"body\""])
        .map_err(|_| BridgeError::new("output_guard"))
}
