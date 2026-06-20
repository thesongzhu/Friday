//! D21 local SKILL.md candidate materialize CLI tests.
//!
//! The CLI verifies an operator Ed25519 approval with only the public key, copies
//! a local SKILL.md package into a shadow candidate directory, and never imports,
//! installs, or executes the skill.

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
use friday_hub::skill_candidate_materializer::skill_candidate_materialize_gate_request;
use friday_storage::Db;
use serde_json::Value;
use sha2::{Digest, Sha256};

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
    std::env::temp_dir().join(format!("friday-skill-materialize-cli-{}", unique(tag)))
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

fn source_digest(skill_md: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"SKILL.md");
    hash.update([0]);
    hash.update(skill_md);
    hash.update([0]);
    let digest = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("skill-candidate-{digest}")
}

fn judgment() -> HandoffJudgmentMemory {
    HandoffJudgmentMemory {
        task: "Materialize a governed local SKILL.md candidate".into(),
        current_blocker: None,
        target_lane_thread_agent_provider: WorkLane::FridayHub.as_str().into(),
        read_first_files: vec![
            "rust-core/crates/friday-hub/src/bin/hub_skill_candidate_materialize.rs".into(),
        ],
        required_output: "shadow candidate receipt".into(),
        done_criteria: vec!["candidate copied without import, install, or execution".into()],
        red_lines: vec!["Hub must not self-mint operator approval".into()],
        why_this_route: "D21 A4 needs a dark governed local materialize leg.".into(),
        considered_options: vec!["legacy import route".into()],
        deferred_options: vec!["runtime skill import".into(), "skill execution".into()],
        previous_pitfalls: vec!["materialized candidate mistaken for runnable skill".into()],
        inheritable_context: vec!["verify-only governance".into()],
        proof_requirements: vec!["CLI materialize test".into()],
        ownership_claim_ids: Vec::new(),
    }
}

fn seed_mission(db: &Db) {
    db.upsert_friday_conversation(&FridayConversation {
        friday_conversation_id: "fconv_skill_materialize_cli".into(),
        owner_principal: "operator".into(),
        title: "Skill Candidate Materialize CLI".into(),
        current_focus_summary: "Materialize shadow candidate".into(),
        active_mission_ids: vec!["mission-skill-materialize-cli".into()],
        surface_thread_ids: Vec::new(),
        memory_scope_ref: None,
        truth_status: TruthStatus::Proven,
        proof_refs: Vec::new(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
    db.upsert_mission(&Mission {
        mission_id: "mission-skill-materialize-cli".into(),
        friday_conversation_id: "fconv_skill_materialize_cli".into(),
        title: "Skill Candidate Materialize CLI".into(),
        intent: "Materialize a local skill candidate without importing or executing it".into(),
        status: MissionStatus::Active,
        why_now: "D21 needs an operator-facing verify-only local candidate bridge".into(),
        decision_path_summary: "Verify Ed25519 approval before writing a shadow candidate.".into(),
        considered_options: vec!["legacy import".into()],
        deferred_options: vec!["runtime execution".into()],
        known_pitfalls: vec!["candidate link confused with installation".into()],
        handoff_inheritance: vec!["Hub verifies, operator signs".into()],
        work_item_ids: vec!["work-skill-materialize-cli".into()],
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: Vec::new(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
    db.upsert_work_item(&WorkItem {
        work_item_id: "work-skill-materialize-cli".into(),
        mission_id: "mission-skill-materialize-cli".into(),
        lane: WorkLane::FridayHub,
        target_provider_or_agent: Some("skill:candidate".into()),
        status: WorkItemStatus::ReadyToDispatch,
        owner_claim_ids: Vec::new(),
        workspace_refs: Vec::new(),
        capability_id: Some("skill.candidate.materialize".into()),
        risk_level: Risk::Low,
        approval_state: ApprovalState::Approved,
        blocking_reason: None,
        input_refs: vec!["friday://body/skill-candidate".into()],
        output_refs: Vec::new(),
        proof_requirements: vec!["skill candidate materialize receipt".into()],
        proof_receipts: Vec::new(),
        judgment_memory: judgment(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
}

fn gate_request(digest: &str) -> MutatingActionRequest {
    skill_candidate_materialize_gate_request(
        "summarize-local",
        digest,
        "mission-skill-materialize-cli",
        "work-skill-materialize-cli",
        "operator",
    )
}

fn cli_base(
    db_path: &str,
    vk_path: &std::path::Path,
    approval_path: &std::path::Path,
    source_dir: &std::path::Path,
    candidate_root: &std::path::Path,
    digest: &str,
) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_hub_skill_candidate_materialize"));
    cmd.arg("materialize-local")
        .arg("--db")
        .arg(db_path)
        .arg("--operator-vk-path")
        .arg(vk_path)
        .arg("--approval-json")
        .arg(approval_path)
        .arg("--source-dir")
        .arg(source_dir)
        .arg("--candidate-root")
        .arg(candidate_root)
        .arg("--skill-id")
        .arg("summarize-local")
        .arg("--source-digest")
        .arg(digest)
        .arg("--mission-id")
        .arg("mission-skill-materialize-cli")
        .arg("--work-item-id")
        .arg("work-skill-materialize-cli")
        .arg("--operator-principal-id")
        .arg("operator")
        .arg("--proof-ref")
        .arg("proof://skill-candidate-materialize/summarize-local")
        .arg("--now-ms")
        .arg((NOW + 1).to_string());
    cmd
}

#[test]
fn cli_materializes_ed25519_candidate_without_import_install_or_execution() {
    let db_path = temp_db("allow");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);

    let source_dir = temp_path("source");
    let candidate_root = temp_path("candidate-root");
    std::fs::create_dir_all(&source_dir).unwrap();
    std::fs::create_dir_all(&candidate_root).unwrap();
    let skill_md = b"---\nid: summarize-local\n---\nSummarize local text.\n";
    std::fs::write(source_dir.join("SKILL.md"), skill_md).unwrap();
    let digest = source_digest(skill_md);

    let (sk, vk) = operator();
    let vk_path = temp_path("operator.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let approval_path = temp_path("approval.json");
    write_approval(
        &approval_path,
        &ed_approval(&gate_request(&digest), &sk, "skill-materialize-ed-allow"),
    );

    let output = cli_base(
        &db_path,
        &vk_path,
        &approval_path,
        &source_dir,
        &candidate_root,
        &digest,
    )
    .output()
    .unwrap();
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["truth_label"], "d21_skill_candidate_materialize");
    assert_eq!(json["ok"], true);
    assert_eq!(json["imports_skill"], false);
    assert_eq!(json["installs_skill"], false);
    assert_eq!(json["executes_skill"], false);
    assert_eq!(
        json["status"],
        "materialized_candidate_not_installed_not_executable"
    );

    let candidate_ref = json["candidate_ref"].as_str().unwrap();
    assert!(candidate_root
        .join(candidate_ref)
        .join("files")
        .join("SKILL.md")
        .is_file());
    let item = db
        .get_work_item("work-skill-materialize-cli")
        .unwrap()
        .unwrap();
    assert_eq!(item.status, WorkItemStatus::ReadyToDispatch);
    assert!(item.proof_receipts.is_empty());
    let links = db
        .list_mission_links("mission-skill-materialize-cli")
        .unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_ref, candidate_ref);
}

#[test]
fn cli_rejects_hmac_approval_without_writing_candidate() {
    let db_path = temp_db("hmac");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);

    let source_dir = temp_path("hmac-source");
    let candidate_root = temp_path("hmac-candidate-root");
    std::fs::create_dir_all(&source_dir).unwrap();
    std::fs::create_dir_all(&candidate_root).unwrap();
    let skill_md = b"---\nid: summarize-local\n---\nSummarize local text.\n";
    std::fs::write(source_dir.join("SKILL.md"), skill_md).unwrap();
    let digest = source_digest(skill_md);

    let (_sk, vk) = operator();
    let vk_path = temp_path("operator-hmac.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let approval_path = temp_path("approval-hmac.json");
    write_approval(
        &approval_path,
        &hmac_approval(&gate_request(&digest), "skill-materialize-hmac"),
    );

    let output = cli_base(
        &db_path,
        &vk_path,
        &approval_path,
        &source_dir,
        &candidate_root,
        &digest,
    )
    .output()
    .unwrap();
    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["imports_skill"], false);
    assert_eq!(json["installs_skill"], false);
    assert_eq!(json["executes_skill"], false);
    assert!(std::fs::read_dir(&candidate_root).unwrap().next().is_none());
    assert!(db
        .list_mission_links("mission-skill-materialize-cli")
        .unwrap()
        .is_empty());
}
