//! D21 governed local skill run CLI tests.
//!
//! The CLI verifies an operator Ed25519 approval with only the public key, runs an
//! adopted managed-local shell skill, emits refs-only evidence, and never marks the
//! WorkItem complete.

use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, ApprovalDecision,
    CanonicalApproval, MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use friday_core::{
    ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionLink,
    MissionLinkKind, MissionStatus, Risk, TruthStatus, WorkItem, WorkItemStatus, WorkLane,
};
use friday_crypto::{OperatorSigningKey, OperatorVerifyingKey};
use friday_hub::skill_catalog::skill_run_gate_request;
use friday_hub::skill_executor::FRIDAY_D21_SKILL_RUN_LOCAL;
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
    std::env::temp_dir().join(format!("friday-skill-run-local-cli-{}", unique(tag)))
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

fn seed_mission(db: &Db) {
    db.upsert_friday_conversation(&FridayConversation {
        friday_conversation_id: "fconv_skill_run_local_cli".into(),
        owner_principal: "operator".into(),
        title: "Skill Run Local CLI".into(),
        current_focus_summary: "Run governed local skill".into(),
        active_mission_ids: vec!["mission-skill-run-local-cli".into()],
        surface_thread_ids: Vec::new(),
        memory_scope_ref: None,
        truth_status: TruthStatus::Proven,
        proof_refs: Vec::new(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
    db.upsert_mission(&Mission {
        mission_id: "mission-skill-run-local-cli".into(),
        friday_conversation_id: "fconv_skill_run_local_cli".into(),
        title: "Skill Run Local CLI".into(),
        intent: "Run an adopted managed local shell skill without completing the WorkItem".into(),
        status: MissionStatus::Active,
        why_now: "D21 needs a governed dark execution leg.".into(),
        decision_path_summary: "Verify Ed25519 approval before local execution.".into(),
        considered_options: vec!["receipt-only".into()],
        deferred_options: vec!["imported SKILL.md runtime adapter".into()],
        known_pitfalls: vec!["execution confused with completion".into()],
        handoff_inheritance: vec!["Hub verifies, operator signs".into()],
        work_item_ids: vec!["work-skill-run-local-cli".into()],
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: Vec::new(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
    db.upsert_work_item(&WorkItem {
        work_item_id: "work-skill-run-local-cli".into(),
        mission_id: "mission-skill-run-local-cli".into(),
        lane: WorkLane::FridayHub,
        target_provider_or_agent: Some("skill:run".into()),
        status: WorkItemStatus::ReadyToDispatch,
        owner_claim_ids: Vec::new(),
        workspace_refs: Vec::new(),
        capability_id: Some("skill.run.local".into()),
        risk_level: Risk::High,
        approval_state: ApprovalState::Required,
        blocking_reason: None,
        input_refs: vec!["friday://body/skill-run-local".into()],
        output_refs: Vec::new(),
        proof_requirements: vec!["skill local run receipt".into()],
        proof_receipts: Vec::new(),
        judgment_memory: HandoffJudgmentMemory {
            task: "Run a governed local skill".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: WorkLane::FridayHub.as_str().into(),
            read_first_files: vec![
                "rust-core/crates/friday-hub/src/bin/hub_skill_run_local.rs".into()
            ],
            required_output: "refs-only execution receipt".into(),
            done_criteria: vec!["local runner invoked after Ed25519 approval".into()],
            red_lines: vec!["Hub must not self-mint operator approval".into()],
            why_this_route: "D21 A4 needs a dark governed execution leg.".into(),
            considered_options: vec!["legacy direct shell".into()],
            deferred_options: vec!["live skill product route".into()],
            previous_pitfalls: vec!["run receipt mistaken for completion".into()],
            inheritable_context: vec!["verify-only governance".into()],
            proof_requirements: vec!["CLI execution test".into()],
            ownership_claim_ids: Vec::new(),
        },
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
}

fn gate_request() -> MutatingActionRequest {
    skill_run_gate_request(
        "summarize-local",
        "mission-skill-run-local-cli",
        "work-skill-run-local-cli",
        "operator",
    )
}

fn write_shell_skill(managed_root: &std::path::Path, runtime_kind: &str) -> std::path::PathBuf {
    let skill_dir = managed_root.join("summarize-local");
    std::fs::create_dir_all(&skill_dir).unwrap();
    let manifest = serde_json::json!({
        "id": "summarize-local",
        "name": "Summarize Local",
        "runtime": {
            "kind": runtime_kind,
            "entrypoint": "run.sh"
        },
        "triggers": { "intents": ["summarize"], "phrases": ["summarize"] },
        "permissions": { "promptOn": ["run"], "grants": ["local-write"] }
    });
    std::fs::write(
        skill_dir.join("skill.manifest.json"),
        serde_json::to_string(&manifest).unwrap(),
    )
    .unwrap();
    let script = skill_dir.join("run.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\nprintf 'raw-skill-output-not-json\\n'\nprintf 'marker' > marker.txt\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&script, permissions).unwrap();
    skill_dir
}

fn cli_base(
    db_path: &str,
    vk_path: &std::path::Path,
    approval_path: &std::path::Path,
    managed_root: &std::path::Path,
    include_explicit_adoption: bool,
) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_hub_skill_run_local"));
    cmd.arg("run-local")
        .arg("--db")
        .arg(db_path)
        .arg("--operator-vk-path")
        .arg(vk_path)
        .arg("--approval-json")
        .arg(approval_path)
        .arg("--managed-skills-root")
        .arg(managed_root)
        .arg("--skill-id")
        .arg("summarize-local")
        .arg("--mission-id")
        .arg("mission-skill-run-local-cli")
        .arg("--work-item-id")
        .arg("work-skill-run-local-cli")
        .arg("--operator-principal-id")
        .arg("operator")
        .arg("--timeout-ms")
        .arg("5000")
        .arg("--now-ms")
        .arg((NOW + 1).to_string());
    if include_explicit_adoption {
        cmd.arg("--adopted-skill-id").arg("summarize-local");
    }
    cmd.arg("--approved-first-run-skill-id")
        .arg("summarize-local");
    cmd
}

fn seed_adoption_receipt(db: &Db) {
    db.upsert_mission_link(&MissionLink {
        link_id: "friday://skill-adoption/test-receipt".into(),
        mission_id: "mission-skill-run-local-cli".into(),
        work_item_id: Some("work-skill-run-local-cli".into()),
        link_kind: MissionLinkKind::ProofReceipt,
        target_ref: "friday://skill-adoption/summarize-local".into(),
        proof_ref: Some("proof://skill-adoption/summarize-local".into()),
        created_at_ms: NOW,
    })
    .unwrap();
}

#[test]
fn flag_off_fails_closed_without_executing_skill() {
    let db_path = temp_db("flag-off");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);

    let managed_root = temp_path("flag-off-managed");
    std::fs::create_dir_all(&managed_root).unwrap();
    let skill_dir = write_shell_skill(&managed_root, "shell");
    let (sk, vk) = operator();
    let vk_path = temp_path("flag-off.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let approval_path = temp_path("flag-off-approval.json");
    write_approval(
        &approval_path,
        &ed_approval(&gate_request(), &sk, "skill-run-local-flag-off"),
    );

    let mut cmd = cli_base(&db_path, &vk_path, &approval_path, &managed_root, true);
    cmd.env_remove(FRIDAY_D21_SKILL_RUN_LOCAL);
    let output = cmd.output().unwrap();
    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["executes_skill"], false);
    assert_eq!(json["completes_work_item"], false);
    assert_eq!(json["error_kind"], "flag_off");
    assert!(!skill_dir.join("marker.txt").exists());
    assert!(db
        .list_mission_links("mission-skill-run-local-cli")
        .unwrap()
        .is_empty());
}

#[test]
fn flag_on_executes_adopted_shell_skill_after_ed25519_approval() {
    let db_path = temp_db("allow");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);

    let managed_root = temp_path("allow-managed");
    std::fs::create_dir_all(&managed_root).unwrap();
    let skill_dir = write_shell_skill(&managed_root, "shell");
    let (sk, vk) = operator();
    let vk_path = temp_path("allow.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let approval_path = temp_path("allow-approval.json");
    write_approval(
        &approval_path,
        &ed_approval(&gate_request(), &sk, "skill-run-local-ed-allow"),
    );

    let mut cmd = cli_base(&db_path, &vk_path, &approval_path, &managed_root, true);
    cmd.env(FRIDAY_D21_SKILL_RUN_LOCAL, "1");
    let output = cmd.output().unwrap();
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(!stdout.contains("raw-skill-output-not-json"));
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["truth_label"], "d21_skill_run_local");
    assert_eq!(json["ok"], true);
    assert_eq!(json["runs_skill"], true);
    assert_eq!(json["installs_skill"], false);
    assert_eq!(json["executes_skill"], true);
    assert_eq!(json["completes_work_item"], false);
    assert_eq!(json["status"], "skill_executed_not_completed");
    assert_eq!(json["sandbox_mode"], "workspace_contained");
    assert_eq!(json["exit_code"], 0);
    assert!(json["output_sha256"].as_str().unwrap().len() == 64);
    assert!(skill_dir.join("marker.txt").is_file());

    let item = db
        .get_work_item("work-skill-run-local-cli")
        .unwrap()
        .unwrap();
    assert_eq!(item.status, WorkItemStatus::ReadyToDispatch);
    assert!(item.proof_receipts.is_empty());
    let links = db
        .list_mission_links("mission-skill-run-local-cli")
        .unwrap();
    assert_eq!(links.len(), 1);
}

#[test]
fn flag_on_executes_shell_skill_after_mission_scoped_adoption_receipt() {
    let db_path = temp_db("adoption-receipt");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);
    seed_adoption_receipt(&db);

    let managed_root = temp_path("adoption-receipt-managed");
    std::fs::create_dir_all(&managed_root).unwrap();
    let skill_dir = write_shell_skill(&managed_root, "shell");
    let (sk, vk) = operator();
    let vk_path = temp_path("adoption-receipt.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let approval_path = temp_path("adoption-receipt-approval.json");
    write_approval(
        &approval_path,
        &ed_approval(&gate_request(), &sk, "skill-run-local-adoption-receipt"),
    );

    let mut cmd = cli_base(&db_path, &vk_path, &approval_path, &managed_root, false);
    cmd.env(FRIDAY_D21_SKILL_RUN_LOCAL, "1");
    let output = cmd.output().unwrap();
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["ok"], true);
    assert_eq!(json["runs_skill"], true);
    assert_eq!(json["executes_skill"], true);
    assert_eq!(json["completes_work_item"], false);
    assert!(skill_dir.join("marker.txt").is_file());

    let item = db
        .get_work_item("work-skill-run-local-cli")
        .unwrap()
        .unwrap();
    assert_eq!(item.status, WorkItemStatus::ReadyToDispatch);
    assert!(item.proof_receipts.is_empty());
    let links = db
        .list_mission_links("mission-skill-run-local-cli")
        .unwrap();
    assert_eq!(links.len(), 2);
    assert!(links
        .iter()
        .any(|link| link.target_ref == "friday://skill-adoption/summarize-local"));
}

#[test]
fn hmac_approval_is_rejected_before_execution() {
    let db_path = temp_db("hmac");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);

    let managed_root = temp_path("hmac-managed");
    std::fs::create_dir_all(&managed_root).unwrap();
    let skill_dir = write_shell_skill(&managed_root, "shell");
    let (_sk, vk) = operator();
    let vk_path = temp_path("hmac.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let approval_path = temp_path("hmac-approval.json");
    write_approval(
        &approval_path,
        &hmac_approval(&gate_request(), "skill-run-local-hmac"),
    );

    let mut cmd = cli_base(&db_path, &vk_path, &approval_path, &managed_root, true);
    cmd.env(FRIDAY_D21_SKILL_RUN_LOCAL, "1");
    let output = cmd.output().unwrap();
    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["executes_skill"], false);
    assert_eq!(json["error_kind"], "run_blocked");
    assert!(!skill_dir.join("marker.txt").exists());
    assert!(db
        .list_mission_links("mission-skill-run-local-cli")
        .unwrap()
        .is_empty());
}

#[test]
fn imported_skill_md_runtime_is_not_executable() {
    let db_path = temp_db("imported-runtime");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);

    let managed_root = temp_path("imported-runtime-managed");
    std::fs::create_dir_all(&managed_root).unwrap();
    let skill_dir = write_shell_skill(&managed_root, "skill-md-imported");
    let (sk, vk) = operator();
    let vk_path = temp_path("imported-runtime.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let approval_path = temp_path("imported-runtime-approval.json");
    write_approval(
        &approval_path,
        &ed_approval(&gate_request(), &sk, "skill-run-local-imported-runtime"),
    );

    let mut cmd = cli_base(&db_path, &vk_path, &approval_path, &managed_root, true);
    cmd.env(FRIDAY_D21_SKILL_RUN_LOCAL, "1");
    let output = cmd.output().unwrap();
    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["executes_skill"], false);
    assert_eq!(json["error_kind"], "run_blocked");
    assert!(!skill_dir.join("marker.txt").exists());
}
