//! D21 skill catalog receipt CLI tests.
//!
//! The CLI verifies an operator Ed25519 approval with only the public key, records
//! a LinkedOnly candidate receipt, and never imports or executes the skill.

use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, ApprovalDecision,
    CanonicalApproval, MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use friday_core::{
    ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus, Risk,
    TruthStatus, WorkItem, WorkItemStatus, WorkLane,
};
use friday_crypto::{OperatorSigningKey, OperatorVerifyingKey};
use friday_hub::skill_catalog::link_skill_candidate_gate_request;
use friday_storage::Db;
use serde_json::Value;

const HUB_HMAC_SECRET: &[u8] = b"hub-held-hmac-gate-secret-0123456789";
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
    std::env::temp_dir().join(format!("friday-skill-receipt-cli-{}", unique(tag)))
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

fn ed_approval(
    req: &MutatingActionRequest,
    sk: &OperatorSigningKey,
    approval_id: &str,
) -> CanonicalApproval {
    let digest = friday_crypto::action_digest(&canonical_action_bytes(req));
    let mut approval = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: approval_id.to_string(),
        action_digest: digest,
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

fn hmac_approval(req: &MutatingActionRequest, approval_id: &str) -> CanonicalApproval {
    let digest = friday_crypto::action_digest(&canonical_action_bytes(req));
    let mut approval = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: approval_id.to_string(),
        action_digest: digest,
        expires_at: Some(FUTURE),
        issuer: Some(CANONICAL_GATE_ISSUER.to_string()),
        signature: None,
    };
    approval.signature = Some(friday_crypto::sign_approval(
        &canonical_approval_signature_bytes(&approval),
        HUB_HMAC_SECRET,
    ));
    approval
}

fn write_approval(path: &std::path::Path, approval: &CanonicalApproval) {
    let decision = match approval.decision {
        ApprovalDecision::Approved => "approved",
        ApprovalDecision::Denied => "denied",
    };
    let body = serde_json::json!({
        "decision": decision,
        "approval_id": approval.approval_id,
        "action_digest": approval.action_digest,
        "expires_at": approval.expires_at.unwrap(),
        "issuer": approval.issuer,
        "signature": approval.signature,
    });
    std::fs::write(path, body.to_string()).unwrap();
}

fn judgment() -> HandoffJudgmentMemory {
    HandoffJudgmentMemory {
        task: "Stage a governed skill candidate receipt".into(),
        current_blocker: None,
        target_lane_thread_agent_provider: WorkLane::FridayHub.as_str().into(),
        read_first_files: vec![
            "rust-core/crates/friday-hub/src/bin/hub_skill_catalog_receipt.rs".into(),
        ],
        required_output: "LinkedOnly candidate receipt".into(),
        done_criteria: vec!["receipt recorded without import or execution".into()],
        red_lines: vec!["Hub must not self-mint operator approval".into()],
        why_this_route: "D21 CLI must verify an operator approval.".into(),
        considered_options: vec!["raw import".into()],
        deferred_options: vec!["runtime skill execution".into()],
        previous_pitfalls: vec!["candidate link mistaken for runnable skill".into()],
        inheritable_context: vec!["verify-only governance".into()],
        proof_requirements: vec!["CLI receipt test".into()],
        ownership_claim_ids: Vec::new(),
    }
}

fn seed_mission(db: &Db) {
    db.upsert_friday_conversation(&FridayConversation {
        friday_conversation_id: "fconv_skill_cli".into(),
        owner_principal: "operator".into(),
        title: "Skill Candidate CLI".into(),
        current_focus_summary: "Stage candidate receipt".into(),
        active_mission_ids: vec!["mission-skill-cli".into()],
        surface_thread_ids: Vec::new(),
        memory_scope_ref: None,
        truth_status: TruthStatus::Proven,
        proof_refs: Vec::new(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
    db.upsert_mission(&Mission {
        mission_id: "mission-skill-cli".into(),
        friday_conversation_id: "fconv_skill_cli".into(),
        title: "Skill Candidate CLI".into(),
        intent: "Stage a skill candidate without importing or executing it".into(),
        status: MissionStatus::Active,
        why_now: "D21 needs an operator-facing verify-only receipt entry.".into(),
        decision_path_summary: "Verify Ed25519 approval before linking.".into(),
        considered_options: vec!["HMAC self-mint".into()],
        deferred_options: vec!["runtime import".into()],
        known_pitfalls: vec!["receipt confused with execution".into()],
        handoff_inheritance: vec!["Hub verifies, operator signs".into()],
        work_item_ids: vec!["work-skill-cli".into()],
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: Vec::new(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
    db.upsert_work_item(&WorkItem {
        work_item_id: "work-skill-cli".into(),
        mission_id: "mission-skill-cli".into(),
        lane: WorkLane::FridayHub,
        target_provider_or_agent: Some("skill:candidate".into()),
        status: WorkItemStatus::ReadyToDispatch,
        owner_claim_ids: Vec::new(),
        workspace_refs: Vec::new(),
        capability_id: Some("skill.candidate".into()),
        risk_level: Risk::Low,
        approval_state: ApprovalState::Approved,
        blocking_reason: None,
        input_refs: vec!["friday://body/skill-candidate".into()],
        output_refs: Vec::new(),
        proof_requirements: vec!["skill candidate receipt".into()],
        proof_receipts: Vec::new(),
        judgment_memory: judgment(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
}

fn gate_request() -> MutatingActionRequest {
    link_skill_candidate_gate_request(
        "invoice-link-skill",
        "link-source-digest-alpha",
        "mission-skill-cli",
        "work-skill-cli",
        "operator",
    )
}

fn cli_base(db_path: &str, vk_path: &std::path::Path, approval_path: &std::path::Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_hub_skill_catalog_receipt"));
    cmd.arg("stage-link-candidate")
        .arg("--db")
        .arg(db_path)
        .arg("--operator-vk-path")
        .arg(vk_path)
        .arg("--approval-json")
        .arg(approval_path)
        .arg("--skill-id")
        .arg("invoice-link-skill")
        .arg("--safe-title")
        .arg("Invoice Link Skill")
        .arg("--source-digest")
        .arg("link-source-digest-alpha")
        .arg("--evidence-url")
        .arg("https://example.com/skill-guide")
        .arg("--mission-id")
        .arg("mission-skill-cli")
        .arg("--work-item-id")
        .arg("work-skill-cli")
        .arg("--operator-principal-id")
        .arg("operator")
        .arg("--proof-ref")
        .arg("proof://link-skill-candidate/invoice")
        .arg("--now-ms")
        .arg((NOW + 1).to_string());
    cmd
}

#[test]
fn cli_records_ed25519_candidate_receipt_without_import_or_execution() {
    let db_path = temp_db("allow");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);
    let (sk, vk) = operator();
    let vk_path = temp_path("operator.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let approval_path = temp_path("approval.json");
    write_approval(
        &approval_path,
        &ed_approval(&gate_request(), &sk, "skill-cli-ed-allow"),
    );

    let output = cli_base(&db_path, &vk_path, &approval_path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["ok"], true);
    assert_eq!(json["imports_skill"], false);
    assert_eq!(json["executes_skill"], false);
    assert_eq!(json["status"], "candidate_receipt_recorded_not_imported");
    assert!(json["candidate_ref"]
        .as_str()
        .unwrap()
        .starts_with("friday://link-skill-candidate/"));

    let links = db.list_mission_links("mission-skill-cli").unwrap();
    assert_eq!(links.len(), 1);
    let item = db.get_work_item("work-skill-cli").unwrap().unwrap();
    assert_eq!(item.status, WorkItemStatus::ReadyToDispatch);
    assert!(item.proof_receipts.is_empty());
}

#[test]
fn cli_rejects_hmac_approval_without_writing_candidate_receipt() {
    let db_path = temp_db("hmac");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);
    let (_sk, vk) = operator();
    let vk_path = temp_path("operator-hmac.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let approval_path = temp_path("approval-hmac.json");
    write_approval(
        &approval_path,
        &hmac_approval(&gate_request(), "skill-cli-hmac"),
    );

    let output = cli_base(&db_path, &vk_path, &approval_path)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["imports_skill"], false);
    assert_eq!(json["executes_skill"], false);
    assert_eq!(json["error_kind"], "run_blocked");
    assert!(db
        .list_mission_links("mission-skill-cli")
        .unwrap()
        .is_empty());
}
