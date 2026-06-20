//! D21 SKILL.md import CLI tests.
//!
//! The CLI verifies an operator Ed25519 approval with only the public key, imports
//! a local SKILL.md package as a managed manifest candidate, and never executes it.

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
use friday_hub::skill_md_importer::{skill_md_import_gate_request, skill_md_promote_gate_request};
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
    std::env::temp_dir().join(format!("friday-skill-md-import-cli-{}", unique(tag)))
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
    source_digest_files(&[("SKILL.md", skill_md)])
}

fn source_digest_files(files: &[(&str, &[u8])]) -> String {
    let mut hash = Sha256::new();
    for (path, bytes) in files {
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(bytes);
        hash.update([0]);
    }
    let digest = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("skill-candidate-{digest}")
}

fn seed_mission(db: &Db) {
    db.upsert_friday_conversation(&FridayConversation {
        friday_conversation_id: "fconv_skill_md_import_cli".into(),
        owner_principal: "operator".into(),
        title: "Skill MD Import CLI".into(),
        current_focus_summary: "Import manifest candidate".into(),
        active_mission_ids: vec!["mission-skill-md-import-cli".into()],
        surface_thread_ids: Vec::new(),
        memory_scope_ref: None,
        truth_status: TruthStatus::Proven,
        proof_refs: Vec::new(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
    db.upsert_mission(&Mission {
        mission_id: "mission-skill-md-import-cli".into(),
        friday_conversation_id: "fconv_skill_md_import_cli".into(),
        title: "Skill MD Import CLI".into(),
        intent: "Import a local skill candidate without executing it".into(),
        status: MissionStatus::Active,
        why_now: "D21 needs an operator-facing verify-only import leg".into(),
        decision_path_summary: "Verify Ed25519 approval before writing a manifest candidate."
            .into(),
        considered_options: vec!["direct execution".into()],
        deferred_options: vec!["sandboxed runtime".into()],
        known_pitfalls: vec!["import confused with runnable execution".into()],
        handoff_inheritance: vec!["Hub verifies, operator signs".into()],
        work_item_ids: vec!["work-skill-md-import-cli".into()],
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: Vec::new(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
    db.upsert_work_item(&WorkItem {
        work_item_id: "work-skill-md-import-cli".into(),
        mission_id: "mission-skill-md-import-cli".into(),
        lane: WorkLane::FridayHub,
        target_provider_or_agent: Some("skill:import".into()),
        status: WorkItemStatus::ReadyToDispatch,
        owner_claim_ids: Vec::new(),
        workspace_refs: Vec::new(),
        capability_id: Some("skill.md.import".into()),
        risk_level: Risk::Low,
        approval_state: ApprovalState::Approved,
        blocking_reason: None,
        input_refs: vec!["friday://body/skill-md-import".into()],
        output_refs: Vec::new(),
        proof_requirements: vec!["skill md import receipt".into()],
        proof_receipts: Vec::new(),
        judgment_memory: HandoffJudgmentMemory {
            task: "Import a governed local SKILL.md candidate".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: WorkLane::FridayHub.as_str().into(),
            read_first_files: vec![
                "rust-core/crates/friday-hub/src/bin/hub_skill_md_import.rs".into()
            ],
            required_output: "manifest candidate import receipt".into(),
            done_criteria: vec!["candidate imported without execution".into()],
            red_lines: vec!["Hub must not self-mint operator approval".into()],
            why_this_route: "D21 A4 needs a dark governed local import leg.".into(),
            considered_options: vec!["legacy direct run".into()],
            deferred_options: vec!["skill execution".into()],
            previous_pitfalls: vec!["import mistaken for runnable".into()],
            inheritable_context: vec!["verify-only governance".into()],
            proof_requirements: vec!["CLI import test".into()],
            ownership_claim_ids: Vec::new(),
        },
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
}

fn gate_request(digest: &str) -> MutatingActionRequest {
    skill_md_import_gate_request(
        "summarize-local",
        digest,
        "mission-skill-md-import-cli",
        "work-skill-md-import-cli",
        "operator",
    )
}

fn promote_gate_request() -> MutatingActionRequest {
    skill_md_promote_gate_request(
        "summarize-local",
        "mission-skill-md-import-cli",
        "work-skill-md-import-cli",
        "operator",
    )
}

fn cli_base(
    db_path: &str,
    vk_path: &std::path::Path,
    approval_path: &std::path::Path,
    source_dir: &std::path::Path,
    managed_root: &std::path::Path,
    digest: &str,
) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_hub_skill_md_import"));
    cmd.arg("import-local")
        .arg("--db")
        .arg(db_path)
        .arg("--operator-vk-path")
        .arg(vk_path)
        .arg("--approval-json")
        .arg(approval_path)
        .arg("--source-dir")
        .arg(source_dir)
        .arg("--managed-skills-root")
        .arg(managed_root)
        .arg("--skill-id")
        .arg("summarize-local")
        .arg("--source-digest")
        .arg(digest)
        .arg("--mission-id")
        .arg("mission-skill-md-import-cli")
        .arg("--work-item-id")
        .arg("work-skill-md-import-cli")
        .arg("--operator-principal-id")
        .arg("operator")
        .arg("--proof-ref")
        .arg("proof://skill-md-import/summarize-local")
        .arg("--now-ms")
        .arg((NOW + 1).to_string());
    cmd
}

fn promote_cli_base(
    db_path: &str,
    vk_path: &std::path::Path,
    approval_path: &std::path::Path,
    managed_root: &std::path::Path,
) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_hub_skill_md_import"));
    cmd.arg("promote-imported-local")
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
        .arg("--entrypoint")
        .arg("run.sh")
        .arg("--mission-id")
        .arg("mission-skill-md-import-cli")
        .arg("--work-item-id")
        .arg("work-skill-md-import-cli")
        .arg("--operator-principal-id")
        .arg("operator")
        .arg("--proof-ref")
        .arg("proof://skill-md-promote/summarize-local")
        .arg("--now-ms")
        .arg((NOW + 2).to_string());
    cmd
}

#[test]
fn cli_imports_ed25519_candidate_without_install_or_execution() {
    let db_path = temp_db("allow");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);

    let source_dir = temp_path("source");
    let managed_root = temp_path("managed");
    std::fs::create_dir_all(&source_dir).unwrap();
    std::fs::create_dir_all(&managed_root).unwrap();
    let skill_md =
        b"---\nid: summarize-local\ntitle: Summarize Local\n---\nSummarize local text.\n";
    std::fs::write(source_dir.join("SKILL.md"), skill_md).unwrap();
    let digest = source_digest(skill_md);

    let (sk, vk) = operator();
    let vk_path = temp_path("operator.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let approval_path = temp_path("approval.json");
    write_approval(
        &approval_path,
        &ed_approval(&gate_request(&digest), &sk, "skill-md-import-ed-allow"),
    );

    let output = cli_base(
        &db_path,
        &vk_path,
        &approval_path,
        &source_dir,
        &managed_root,
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
    assert_eq!(json["truth_label"], "d21_skill_md_import");
    assert_eq!(json["ok"], true);
    assert_eq!(json["imports_skill"], true);
    assert_eq!(json["installs_skill"], false);
    assert_eq!(json["executes_skill"], false);
    assert_eq!(json["status"], "imported_manifest_candidate_not_executable");

    assert!(managed_root
        .join("summarize-local")
        .join("skill.manifest.json")
        .is_file());
    assert!(managed_root
        .join("summarize-local")
        .join("SKILL.md")
        .is_file());
    let item = db
        .get_work_item("work-skill-md-import-cli")
        .unwrap()
        .unwrap();
    assert_eq!(item.status, WorkItemStatus::ReadyToDispatch);
    assert!(item.proof_receipts.is_empty());
    let links = db
        .list_mission_links("mission-skill-md-import-cli")
        .unwrap();
    assert_eq!(links.len(), 1);
}

#[test]
fn cli_promotes_imported_candidate_to_sandbox_required_shell_without_execution() {
    let db_path = temp_db("promote");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);

    let source_dir = temp_path("promote-source");
    let managed_root = temp_path("promote-managed");
    std::fs::create_dir_all(&source_dir).unwrap();
    std::fs::create_dir_all(&managed_root).unwrap();
    let skill_md =
        b"---\nid: summarize-local\ntitle: Summarize Local\n---\nSummarize local text.\n";
    std::fs::write(source_dir.join("SKILL.md"), skill_md).unwrap();
    std::fs::write(
        source_dir.join("run.sh"),
        "#!/bin/sh\nprintf 'should-not-run-during-promote'\n",
    )
    .unwrap();
    let run_sh = b"#!/bin/sh\nprintf 'should-not-run-during-promote'\n";
    let digest = source_digest_files(&[("SKILL.md", skill_md), ("run.sh", run_sh)]);

    let (sk, vk) = operator();
    let vk_path = temp_path("promote-operator.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let import_approval_path = temp_path("promote-import-approval.json");
    write_approval(
        &import_approval_path,
        &ed_approval(
            &gate_request(&digest),
            &sk,
            "skill-md-import-before-promote",
        ),
    );
    let import_output = cli_base(
        &db_path,
        &vk_path,
        &import_approval_path,
        &source_dir,
        &managed_root,
        &digest,
    )
    .output()
    .unwrap();
    assert!(
        import_output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&import_output.stderr)
    );

    let promote_approval_path = temp_path("promote-approval.json");
    write_approval(
        &promote_approval_path,
        &ed_approval(&promote_gate_request(), &sk, "skill-md-promote-ed-allow"),
    );
    let output = promote_cli_base(&db_path, &vk_path, &promote_approval_path, &managed_root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(!stdout.contains("should-not-run-during-promote"));
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["truth_label"], "d21_skill_md_promote");
    assert_eq!(json["ok"], true);
    assert_eq!(json["imports_skill"], false);
    assert_eq!(json["promotes_runtime"], true);
    assert_eq!(json["executes_skill"], false);
    assert_eq!(json["completes_work_item"], false);
    assert_eq!(json["requires_darwin_sandbox"], true);
    assert_eq!(
        json["status"],
        "imported_manifest_promoted_to_sandbox_required_shell_not_executed"
    );

    let manifest_path = managed_root
        .join("summarize-local")
        .join("skill.manifest.json");
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(manifest_path).unwrap()).unwrap();
    assert_eq!(manifest["runtime"]["kind"], "shell");
    assert_eq!(manifest["runtime"]["entrypoint"], "run.sh");
    assert_eq!(manifest["runtime"]["requiresDarwinSandbox"], true);
    assert!(!managed_root
        .join("summarize-local")
        .join("marker.txt")
        .exists());

    let item = db
        .get_work_item("work-skill-md-import-cli")
        .unwrap()
        .unwrap();
    assert_eq!(item.status, WorkItemStatus::ReadyToDispatch);
    assert!(item.proof_receipts.is_empty());
    let links = db
        .list_mission_links("mission-skill-md-import-cli")
        .unwrap();
    assert_eq!(links.len(), 2);
}

#[test]
fn cli_rejects_hmac_promote_approval_without_changing_manifest() {
    let db_path = temp_db("promote-hmac");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);

    let source_dir = temp_path("promote-hmac-source");
    let managed_root = temp_path("promote-hmac-managed");
    std::fs::create_dir_all(&source_dir).unwrap();
    std::fs::create_dir_all(&managed_root).unwrap();
    let skill_md = b"---\nid: summarize-local\n---\nSummarize local text.\n";
    std::fs::write(source_dir.join("SKILL.md"), skill_md).unwrap();
    let run_sh = b"#!/bin/sh\nprintf nope\n";
    std::fs::write(source_dir.join("run.sh"), run_sh).unwrap();
    let digest = source_digest_files(&[("SKILL.md", skill_md), ("run.sh", run_sh)]);

    let (sk, vk) = operator();
    let vk_path = temp_path("operator-promote-hmac.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let import_approval_path = temp_path("approval-promote-hmac-import.json");
    write_approval(
        &import_approval_path,
        &ed_approval(
            &gate_request(&digest),
            &sk,
            "skill-md-import-for-hmac-promote",
        ),
    );
    let import_output = cli_base(
        &db_path,
        &vk_path,
        &import_approval_path,
        &source_dir,
        &managed_root,
        &digest,
    )
    .output()
    .unwrap();
    assert!(import_output.status.success());

    let promote_approval_path = temp_path("approval-promote-hmac.json");
    write_approval(
        &promote_approval_path,
        &hmac_approval(&promote_gate_request(), "skill-md-promote-hmac"),
    );
    let output = promote_cli_base(&db_path, &vk_path, &promote_approval_path, &managed_root)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["promotes_runtime"], false);
    assert_eq!(json["executes_skill"], false);

    let manifest_path = managed_root
        .join("summarize-local")
        .join("skill.manifest.json");
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(manifest_path).unwrap()).unwrap();
    assert_eq!(manifest["runtime"]["kind"], "skill-md-imported");
    let links = db
        .list_mission_links("mission-skill-md-import-cli")
        .unwrap();
    assert_eq!(links.len(), 1);
}

#[test]
fn cli_rejects_hmac_approval_without_importing_candidate() {
    let db_path = temp_db("hmac");
    let db = Db::open_hub(&db_path).unwrap();
    seed_mission(&db);

    let source_dir = temp_path("hmac-source");
    let managed_root = temp_path("hmac-managed");
    std::fs::create_dir_all(&source_dir).unwrap();
    std::fs::create_dir_all(&managed_root).unwrap();
    let skill_md = b"---\nid: summarize-local\n---\nSummarize local text.\n";
    std::fs::write(source_dir.join("SKILL.md"), skill_md).unwrap();
    let digest = source_digest(skill_md);

    let (_sk, vk) = operator();
    let vk_path = temp_path("operator-hmac.vk");
    std::fs::write(&vk_path, vk_hex(&vk)).unwrap();
    let approval_path = temp_path("approval-hmac.json");
    write_approval(
        &approval_path,
        &hmac_approval(&gate_request(&digest), "skill-md-import-hmac"),
    );

    let output = cli_base(
        &db_path,
        &vk_path,
        &approval_path,
        &source_dir,
        &managed_root,
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
    assert!(std::fs::read_dir(&managed_root).unwrap().next().is_none());
    assert!(db
        .list_mission_links("mission-skill-md-import-cli")
        .unwrap()
        .is_empty());
}
