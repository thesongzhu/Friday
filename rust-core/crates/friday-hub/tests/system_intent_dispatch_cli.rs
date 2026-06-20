//! B3 system-intent DARK CLI tests.
//!
//! The CLI reaches the Rust system-intent domain layer behind a default-off flag.
//! It never signs, never wires a host backend, and never reports a completed OS
//! effect for dry-run/unavailable execution.

use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::gate::{
    canonical_approval_signature_bytes, ApprovalDecision, CanonicalApproval, CANONICAL_GATE_ISSUER,
};
use friday_crypto::{OperatorSigningKey, OperatorVerifyingKey};
use friday_hub::system_intent::{intent_action_digest, IntentInput, DRY_RUN_OBSERVED_MARKER};
use friday_storage::system_intent::{IntentAction, IntentStatus, OwnerKind};
use friday_storage::Db;
use serde_json::Value;

const FLAG: &str = "FRIDAY_SYSTEM_INTENT_RUST_ENTRYPOINT";
const NOW: i64 = 1_000;
const FUTURE: i64 = 5_000_000_000_000;

static C: AtomicU64 = AtomicU64::new(0);

fn temp_path(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "friday-system-intent-cli-{}-{}-{}",
        std::process::id(),
        tag,
        C.fetch_add(1, Ordering::Relaxed)
    ))
}

fn base_cmd(db_path: &str, intent_id: &str, action: &str) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_hub_system_intent_dispatch"));
    cmd.arg("dispatch")
        .arg("--db")
        .arg(db_path)
        .arg("--intent-id")
        .arg(intent_id)
        .arg("--action")
        .arg(action)
        .arg("--actor-id")
        .arg("api-1")
        .arg("--actor-kind")
        .arg("api")
        .arg("--now-ms")
        .arg(NOW.to_string());
    cmd
}

fn operator() -> (OperatorSigningKey, OperatorVerifyingKey) {
    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();
    (sk, vk)
}

fn vk_hex(vk: &OperatorVerifyingKey) -> String {
    vk.to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn write_vk(path: &std::path::Path, vk: &OperatorVerifyingKey) {
    std::fs::write(path, vk_hex(vk)).unwrap();
}

fn launch_app_input(intent_id: &str) -> IntentInput {
    IntentInput {
        intent_id: intent_id.to_string(),
        action: IntentAction::LaunchApp,
        actor_id: "api-1".into(),
        actor_kind: OwnerKind::Api,
        target_ref: Some("com.apple.Safari".into()),
        reason: None,
        lease_ttl_ms: None,
    }
}

fn ed_approval(inp: &IntentInput, sk: &OperatorSigningKey, approval_id: &str) -> CanonicalApproval {
    let mut approval = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: approval_id.to_string(),
        action_digest: intent_action_digest(inp),
        expires_at: Some(FUTURE),
        issuer: Some(CANONICAL_GATE_ISSUER.to_string()),
        signature: None,
    };
    approval.signature = Some(
        sk.sign(&canonical_approval_signature_bytes(&approval))
            .to_hex(),
    );
    approval
}

fn write_approval(path: &std::path::Path, approval: &CanonicalApproval) {
    let body = serde_json::json!({
        "decision": "approved",
        "approval_id": approval.approval_id,
        "action_digest": approval.action_digest,
        "expires_at": approval.expires_at.unwrap(),
        "issuer": approval.issuer,
        "signature": approval.signature,
    });
    std::fs::write(path, body.to_string()).unwrap();
}

#[test]
fn flag_off_fails_closed_without_creating_db() {
    let db_path = temp_path("flag-off.sqlite");
    let output = base_cmd(db_path.to_str().unwrap(), "intent-flag-off", "snapshot")
        .env_remove(FLAG)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!db_path.exists(), "flag-off must fail before opening a DB");
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["truth_label"],
        "b3_system_intent_rust_dark_entrypoint"
    );
    assert_eq!(value["ok"], false);
    assert_eq!(value["error_kind"], "flag_disabled");
    assert_eq!(value["os_actuated"], false);
}

#[test]
fn flag_on_dispatches_snapshot_as_dry_run_unavailable_not_completed() {
    let db_path = temp_path("snapshot.sqlite");
    let output = base_cmd(db_path.to_str().unwrap(), "intent-snapshot", "snapshot")
        .env(FLAG, "1")
        .output()
        .unwrap();
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["truth_label"],
        "b3_system_intent_rust_dark_entrypoint"
    );
    assert_eq!(value["ok"], true);
    assert_eq!(value["live"], false);
    assert_eq!(value["action"], "snapshot");
    assert_eq!(value["status"], "unavailable");
    assert_eq!(value["dry_run"], true);
    assert_eq!(value["os_actuated"], false);
    assert_eq!(value["completes_effect"], false);
    assert_eq!(value["message"], DRY_RUN_OBSERVED_MARKER);

    let db = Db::open_hub(db_path.to_str().unwrap()).unwrap();
    let result = friday_storage::system_intent::get_intent_result(db.conn(), "intent-snapshot")
        .unwrap()
        .unwrap();
    assert_eq!(result.status, IntentStatus::Unavailable);
}

#[test]
fn valid_operator_approval_authorizes_launch_app_but_still_dry_runs() {
    let db_path = temp_path("launch.sqlite");
    let vk_path = temp_path("operator.vk");
    let approval_path = temp_path("approval.json");
    let (sk, vk) = operator();
    write_vk(&vk_path, &vk);
    let input = launch_app_input("intent-launch");
    write_approval(&approval_path, &ed_approval(&input, &sk, "approval-launch"));

    let output = base_cmd(db_path.to_str().unwrap(), "intent-launch", "launch_app")
        .env(FLAG, "1")
        .arg("--target-ref")
        .arg("com.apple.Safari")
        .arg("--operator-vk-path")
        .arg(vk_path)
        .arg("--approval-json")
        .arg(approval_path)
        .output()
        .unwrap();
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["action"], "launch_app");
    assert_eq!(value["status"], "unavailable");
    assert_eq!(value["dry_run"], true);
    assert_eq!(value["execution_deferred"], false);
    assert_eq!(value["os_actuated"], false);
    assert_eq!(value["completes_effect"], false);
    assert_eq!(value["message"], DRY_RUN_OBSERVED_MARKER);
    assert!(value["control_lease_id"].as_str().is_some());

    let db = Db::open_hub(db_path.to_str().unwrap()).unwrap();
    let approvals =
        friday_storage::system_intent::list_approval_records(db.conn(), "intent-launch").unwrap();
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0].decision.as_str(), "allow");
}
