//! D20 signed-batch worktree artifact CLI tests.
//!
//! The CLI consumes an already operator-signed batch artifact plus the operator
//! public verify key. These tests use a TEST keypair only: the Hub never reads an
//! operator private key, never signs, and never mints approvals.

use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_batch_signature_bytes, ApprovalDecision,
    CanonicalApprovalBatch, MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use friday_crypto::{OperatorSigningKey, OperatorVerifyingKey};
use friday_hub::{build_request_with_policy, RawToolCall, RunPolicy};
use friday_storage::Db;
use serde_json::Value;

const NOW: i64 = 1_000;
const FUTURE: i64 = 5_000_000_000_000;

static C: AtomicU64 = AtomicU64::new(0);

fn unique(tag: &str) -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        tag,
        C.fetch_add(1, Ordering::Relaxed)
    )
}

fn temp_path(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("friday-d20-worktree-cli-{}", unique(tag)))
}

fn temp_db(tag: &str) -> String {
    temp_path(&format!("{tag}.sqlite"))
        .to_string_lossy()
        .into_owned()
}

fn vk_hex(vk: &OperatorVerifyingKey) -> String {
    vk.to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn operator() -> (OperatorSigningKey, OperatorVerifyingKey) {
    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();
    (sk, vk)
}

fn raw(action: &str, params: &[(&str, &str)]) -> RawToolCall {
    RawToolCall {
        action: action.to_string(),
        params: params
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect(),
    }
}

fn request_for(raw: &RawToolCall) -> MutatingActionRequest {
    build_request_with_policy(raw, &RunPolicy::default()).expect("fixture action must classify")
}

fn signed_batch(
    request: &MutatingActionRequest,
    sk: &OperatorSigningKey,
    batch_sign_id: &str,
) -> CanonicalApprovalBatch {
    let mut batch = CanonicalApprovalBatch {
        decision: ApprovalDecision::Approved,
        batch_sign_id: batch_sign_id.to_string(),
        action_digests: vec![friday_crypto::action_digest(&canonical_action_bytes(
            request,
        ))],
        expires_at: Some(FUTURE),
        issuer: Some(CANONICAL_GATE_ISSUER.to_string()),
        signature: None,
    };
    batch.signature = Some(
        sk.sign(&canonical_approval_batch_signature_bytes(&batch))
            .to_hex(),
    );
    batch
}

fn write_signed_batch(path: &std::path::Path, batch: &CanonicalApprovalBatch) {
    let decision = match batch.decision {
        ApprovalDecision::Approved => "approved",
        ApprovalDecision::Denied => "denied",
    };
    std::fs::write(
        path,
        serde_json::json!({
            "decision": decision,
            "batch_sign_id": batch.batch_sign_id,
            "action_digests": batch.action_digests,
            "expires_at": batch.expires_at.unwrap(),
            "issuer": batch.issuer,
            "signature": batch.signature,
        })
        .to_string(),
    )
    .unwrap();
}

fn write_action(path: &std::path::Path, raw: &RawToolCall) {
    let params: Vec<Value> = raw
        .params
        .iter()
        .map(|(key, value)| serde_json::json!({ "key": key, "value": value }))
        .collect();
    std::fs::write(
        path,
        serde_json::json!({
            "action": raw.action,
            "params": params,
        })
        .to_string(),
    )
    .unwrap();
}

fn run_cli(
    db_path: &str,
    workspace: &std::path::Path,
    vk_path: &std::path::Path,
    signed_path: &std::path::Path,
    action_path: &std::path::Path,
    now_ms: i64,
) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_hub_d20_signed_batch_worktree"))
        .arg("--db")
        .arg(db_path)
        .arg("--workspace")
        .arg(workspace)
        .arg("--operator-vk-path")
        .arg(vk_path)
        .arg("--signed-batch-json")
        .arg(signed_path)
        .arg("--action-json")
        .arg(action_path)
        .arg("--now-ms")
        .arg(now_ms.to_string())
        .output()
        .unwrap()
}

fn parse_stdout(output: &std::process::Output) -> Value {
    let stdout = String::from_utf8(output.stdout.clone()).unwrap();
    serde_json::from_str(stdout.trim()).unwrap()
}

fn audit_count(db: &Db) -> i64 {
    db.conn()
        .query_row(
            "SELECT COUNT(*) FROM audit_ledger WHERE action='dial.batch.worktree_authorized'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

fn consumed_count(db: &Db) -> i64 {
    db.conn()
        .query_row("SELECT COUNT(*) FROM consumed_approval", [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn cli_executes_signed_member_once_and_replay_is_denied_refs_only() {
    let db_path = temp_db("allow");
    let db = Db::open_hub(&db_path).unwrap();
    let workspace = temp_path("workspace");
    std::fs::create_dir_all(&workspace).unwrap();

    let action = raw("write_file", &[("path", "out.txt"), ("content", "D20 cli")]);
    let request = request_for(&action);
    let (sk, vk) = operator();
    let vk_path = temp_path("operator.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let batch = signed_batch(&request, &sk, "d20-cli-allow");
    let signed_path = temp_path("signed-batch.json");
    write_signed_batch(&signed_path, &batch);
    let action_path = temp_path("action.json");
    write_action(&action_path, &action);

    let output = run_cli(
        &db_path,
        &workspace,
        &vk_path,
        &signed_path,
        &action_path,
        NOW,
    );
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = parse_stdout(&output);
    assert_eq!(json["truth_label"], "d20_worktree_signed_batch_artifact");
    assert_eq!(json["proof_only"], true);
    assert_eq!(json["ok"], true);
    assert_eq!(json["executed"], true);
    assert_eq!(json["result_status"], "executed");
    assert_eq!(json["action"], "write_file");
    assert_eq!(json["batch_sign_id"], "d20-cli-allow");
    assert_eq!(json["audit_chain_verified"], true);
    assert!(
        !json.to_string().contains("D20 cli"),
        "CLI output must stay refs-only and not leak file body: {json}"
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join("out.txt")).unwrap(),
        "D20 cli"
    );
    assert_eq!(audit_count(&db), 1);
    assert_eq!(consumed_count(&db), 1);

    let replay = run_cli(
        &db_path,
        &workspace,
        &vk_path,
        &signed_path,
        &action_path,
        NOW + 1,
    );
    assert!(
        replay.status.success(),
        "replay is a safe denied outcome, stderr={}",
        String::from_utf8_lossy(&replay.stderr)
    );
    let replay_json = parse_stdout(&replay);
    assert_eq!(replay_json["ok"], true);
    assert_eq!(replay_json["executed"], false);
    assert_eq!(replay_json["result_status"], "denied");
    assert_eq!(replay_json["reason"], "canonical_batch_replay_refused");
    assert_eq!(
        std::fs::read_to_string(workspace.join("out.txt")).unwrap(),
        "D20 cli",
        "replay must be denied before any second write side effect"
    );
    assert_eq!(audit_count(&db), 1);
    assert_eq!(consumed_count(&db), 1);
}

#[test]
fn cli_pauses_irreversible_member_before_executor() {
    let db_path = temp_db("irreversible");
    let db = Db::open_hub(&db_path).unwrap();
    let workspace = temp_path("irreversible-workspace");
    std::fs::create_dir_all(&workspace).unwrap();

    let action = raw("run_command", &[("command", "touch should_not_exist")]);
    let request = request_for(&action);
    let (sk, vk) = operator();
    let vk_path = temp_path("irreversible.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let batch = signed_batch(&request, &sk, "d20-cli-irreversible");
    let signed_path = temp_path("irreversible-signed.json");
    write_signed_batch(&signed_path, &batch);
    let action_path = temp_path("irreversible-action.json");
    write_action(&action_path, &action);

    let output = run_cli(
        &db_path,
        &workspace,
        &vk_path,
        &signed_path,
        &action_path,
        NOW,
    );
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = parse_stdout(&output);
    assert_eq!(json["ok"], true);
    assert_eq!(json["executed"], false);
    assert_eq!(json["result_status"], "requires_approval");
    assert_eq!(
        json["reason"],
        "dial_worktree_irreversible_requires_single_approval"
    );
    assert!(
        !workspace.join("should_not_exist").exists(),
        "irreversible run_command must pause before executor"
    );
    assert_eq!(audit_count(&db), 0);
    assert_eq!(consumed_count(&db), 0);
}

#[test]
fn cli_pauses_out_of_worktree_member_before_executor() {
    let db_path = temp_db("out-of-scope");
    let db = Db::open_hub(&db_path).unwrap();
    let workspace = temp_path("scope-workspace");
    let outside = temp_path("outside");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let outside_target = outside.join("escape.txt");

    let action = raw(
        "write_file",
        &[
            ("path", outside_target.to_str().unwrap()),
            ("content", "escape"),
        ],
    );
    let request = request_for(&action);
    let (sk, vk) = operator();
    let vk_path = temp_path("out-of-scope.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let batch = signed_batch(&request, &sk, "d20-cli-out-of-scope");
    let signed_path = temp_path("out-of-scope-signed.json");
    write_signed_batch(&signed_path, &batch);
    let action_path = temp_path("out-of-scope-action.json");
    write_action(&action_path, &action);

    let output = run_cli(
        &db_path,
        &workspace,
        &vk_path,
        &signed_path,
        &action_path,
        NOW,
    );
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = parse_stdout(&output);
    assert_eq!(json["ok"], true);
    assert_eq!(json["executed"], false);
    assert_eq!(json["result_status"], "requires_approval");
    assert_eq!(json["reason"], "dial_worktree_resource_out_of_scope");
    assert!(
        !outside_target.exists(),
        "out-of-worktree write must pause before executor"
    );
    assert_eq!(audit_count(&db), 0);
    assert_eq!(consumed_count(&db), 0);
}

#[test]
fn cli_reports_never_revertable_workspace_reason_refs_only() {
    let db_path = temp_db("never-revertable");
    let db = Db::open_hub(&db_path).unwrap();
    let workspace = temp_path("never-revertable-workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let never_revertable_dir =
        std::path::Path::new(&std::env::var("HOME").unwrap()).join(".friday");
    std::fs::create_dir_all(&never_revertable_dir).unwrap();
    let never_revertable_target = never_revertable_dir.join("d20-never-revertable.txt");
    let _ = std::fs::remove_file(&never_revertable_target);

    let action = raw(
        "write_file",
        &[
            ("path", "~/.friday/d20-never-revertable.txt"),
            ("content", "nope"),
        ],
    );
    let request = request_for(&action);
    let (sk, vk) = operator();
    let vk_path = temp_path("never-revertable.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let batch = signed_batch(&request, &sk, "d20-cli-never-revertable");
    let signed_path = temp_path("never-revertable-signed.json");
    write_signed_batch(&signed_path, &batch);
    let action_path = temp_path("never-revertable-action.json");
    write_action(&action_path, &action);

    let output = run_cli(
        &db_path,
        &workspace,
        &vk_path,
        &signed_path,
        &action_path,
        NOW,
    );
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = parse_stdout(&output);
    assert_eq!(json["truth_label"], "d20_worktree_signed_batch_artifact");
    assert_eq!(json["proof_only"], true);
    assert_eq!(json["ok"], true);
    assert_eq!(json["executed"], false);
    assert_eq!(json["result_status"], "requires_approval");
    assert_eq!(json["reason"], "dial_worktree_never_revertable_path");
    assert!(
        !never_revertable_target.exists(),
        "never-revertable target must pause before executor"
    );
    assert_eq!(audit_count(&db), 0);
    assert_eq!(consumed_count(&db), 0);
}
