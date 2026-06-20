//! B3 system-intent DARK Hub entrypoint.
//!
//! This CLI reaches the Rust-owned system-intent domain layer behind an exact
//! default-off flag. It is not a product route and never wires a real OS backend:
//! the production executor is dry-run/unavailable only, so an approved OS intent
//! is authorized and recorded without faking a completed host effect.

use std::env;
use std::io::Read;
use std::path::Path;

use friday_core::gate::{ApprovalDecision, CanonicalApproval, CANONICAL_GATE_ISSUER};
use friday_hub::operator_vk::load_operator_vk_from_path;
use friday_hub::system_intent::{
    DispatchOutcome, IntentInput, OsIntentExecutor, SystemIntentEntrypoint,
};
use friday_storage::system_intent::{IntentAction, OwnerKind};
use friday_storage::Db;
use serde::Deserialize;
use serde_json::json;

const FLAG: &str = "FRIDAY_SYSTEM_INTENT_RUST_ENTRYPOINT";

struct CliError {
    kind: &'static str,
}

impl CliError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

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
                "truth_label": "b3_system_intent_rust_dark_entrypoint",
                "ok": false,
                "live": false,
                "os_actuated": false,
                "completes_effect": false,
                "completes_host_effect": false,
                "error_kind": err.kind,
            });
            println!("{}", payload);
            eprintln!("hub_system_intent_dispatch_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, CliError> {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) != Some("dispatch") {
        return Err(CliError::new("bad_args"));
    }
    if !flag_enabled_from(env::var(FLAG).ok().as_deref()) {
        return Err(CliError::new("flag_disabled"));
    }

    let db_path = arg_value(&args, "--db").ok_or(CliError::new("bad_args"))?;
    let input = IntentInput {
        intent_id: arg_value(&args, "--intent-id").ok_or(CliError::new("bad_args"))?,
        action: parse_action(&arg_value(&args, "--action").ok_or(CliError::new("bad_args"))?)?,
        actor_id: arg_value(&args, "--actor-id").ok_or(CliError::new("bad_args"))?,
        actor_kind: parse_owner_kind(
            &arg_value(&args, "--actor-kind").ok_or(CliError::new("bad_args"))?,
        )?,
        target_ref: arg_value(&args, "--target-ref"),
        reason: arg_value(&args, "--reason"),
        lease_ttl_ms: arg_value(&args, "--lease-ttl-ms").and_then(|v| v.parse::<i64>().ok()),
    };
    let now_ms = arg_value(&args, "--now-ms")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or_else(now_ms);
    let db = Db::open_hub(&db_path).map_err(|_| CliError::new("init_failed"))?;
    let ep = SystemIntentEntrypoint::with_execution_enabled(OsIntentExecutor::production_default());

    let outcome = match arg_value(&args, "--approval-json") {
        Some(approval_path) => {
            let vk_path = arg_value(&args, "--operator-vk-path")
                .or_else(|| env::var(friday_hub::operator_vk::OPERATOR_VK_PATH_ENV).ok())
                .filter(|p| !p.trim().is_empty())
                .ok_or(CliError::new("operator_vk_unprovisioned"))?;
            let operator_vk = load_operator_vk_from_path(Path::new(vk_path.trim()))
                .map_err(|_| CliError::new("operator_vk_malformed"))?;
            let approval = read_approval(Some(&approval_path))?;
            ep.dispatch_with_approval(db.conn(), &input, &approval, &operator_vk, now_ms)
                .map_err(|_| CliError::new("dispatch_failed"))?
        }
        None => ep
            .dispatch(db.conn(), &input, now_ms)
            .map_err(|_| CliError::new("dispatch_failed"))?,
    };

    render(input.action, outcome)
}

fn flag_enabled_from(value: Option<&str>) -> bool {
    value.map(str::trim) == Some("1")
}

fn parse_action(value: &str) -> Result<IntentAction, CliError> {
    IntentAction::parse(value).map_err(|_| CliError::new("bad_args"))
}

fn parse_owner_kind(value: &str) -> Result<OwnerKind, CliError> {
    OwnerKind::parse(value).map_err(|_| CliError::new("bad_args"))
}

fn read_approval(path: Option<&str>) -> Result<CanonicalApproval, CliError> {
    let approval_json = match path {
        Some(path) => std::fs::read_to_string(path).map_err(|_| CliError::new("bad_args"))?,
        None => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|_| CliError::new("bad_args"))?;
            buf
        }
    };
    let signed: SignedApprovalIn =
        serde_json::from_str(approval_json.trim()).map_err(|_| CliError::new("bad_approval"))?;
    Ok(CanonicalApproval {
        decision: parse_decision(&signed.decision).ok_or(CliError::new("bad_approval"))?,
        approval_id: signed.approval_id,
        action_digest: signed.action_digest,
        expires_at: Some(signed.expires_at),
        issuer: Some(
            signed
                .issuer
                .unwrap_or_else(|| CANONICAL_GATE_ISSUER.to_string()),
        ),
        signature: Some(signed.signature),
    })
}

fn parse_decision(value: &str) -> Option<ApprovalDecision> {
    match value {
        "approved" => Some(ApprovalDecision::Approved),
        "denied" => Some(ApprovalDecision::Denied),
        _ => None,
    }
}

fn render(action: IntentAction, outcome: DispatchOutcome) -> Result<String, CliError> {
    let status = outcome.result.status;
    let message = outcome.result.message.clone();
    let payload = json!({
        "truth_label": "b3_system_intent_rust_dark_entrypoint",
        "ok": true,
        "live": false,
        "db_writes": true,
        "os_actuated": false,
        "completes_effect": false,
        "completes_host_effect": false,
        "action": action.as_str(),
        "status": status.as_str(),
        "dry_run": outcome.dry_run,
        "execution_deferred": outcome.execution_deferred,
        "control_lease_id": outcome.result.control_lease_id,
        "gate_reason": outcome.result.gate_reason,
        "message": message,
    });
    let rendered =
        serde_json::to_string(&payload).map_err(|_| CliError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

fn reject_forbidden_output(rendered: &str) -> Result<(), CliError> {
    friday_hub::refs_guard::reject_forbidden_output(
        rendered,
        &[
            "clipboard:",
            "notification body",
            "raw_output",
            "screenshot_base64",
        ],
    )
    .map_err(|_| CliError::new("output_guard"))
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_matcher_is_exact_one_default_off() {
        assert!(!flag_enabled_from(None));
        assert!(!flag_enabled_from(Some("")));
        assert!(!flag_enabled_from(Some("true")));
        assert!(!flag_enabled_from(Some("0")));
        assert!(!flag_enabled_from(Some("2")));
        assert!(flag_enabled_from(Some("1")));
        assert!(flag_enabled_from(Some(" 1 ")));
    }
}
