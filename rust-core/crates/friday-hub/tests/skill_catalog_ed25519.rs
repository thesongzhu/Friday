//! D21 skill catalog Ed25519 receipt guards.
//!
//! These tests live in `tests/` because they construct a TEST operator signing
//! key. Hub source keeps only the verify key path.

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
use friday_hub::skill_catalog::{
    adopted_skill_ids_from_mission_links, link_skill_candidate_gate_request,
    record_skill_adoption_receipt_ed25519, skill_adoption_gate_request,
    stage_link_skill_candidate_receipt_ed25519, LinkSkillCandidateReceiptRequest,
    SkillAdoptionReceiptRequest,
};
use friday_storage::Db;

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

fn temp_db(tag: &str) -> String {
    std::env::temp_dir()
        .join(format!(
            "friday-skill-catalog-ed25519-{}.sqlite",
            unique(tag)
        ))
        .to_string_lossy()
        .into_owned()
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

fn judgment() -> HandoffJudgmentMemory {
    HandoffJudgmentMemory {
        task: "Stage a governed skill candidate receipt".into(),
        current_blocker: None,
        target_lane_thread_agent_provider: WorkLane::FridayHub.as_str().into(),
        read_first_files: vec!["rust-core/crates/friday-hub/src/skill_catalog.rs".into()],
        required_output: "LinkedOnly candidate receipt".into(),
        done_criteria: vec!["receipt recorded without import or execution".into()],
        red_lines: vec!["Hub must not self-mint an operator approval".into()],
        why_this_route: "D21 imports must pass through operator-governed receipts.".into(),
        considered_options: vec!["legacy HMAC approval".into()],
        deferred_options: vec!["runtime skill import".into()],
        previous_pitfalls: vec!["candidate discovery looked executable".into()],
        inheritable_context: vec!["skill catalog is advisory until imported".into()],
        proof_requirements: vec!["Ed25519 receipt tests".into()],
        ownership_claim_ids: Vec::new(),
    }
}

fn seed_mission(db: &Db) {
    db.upsert_friday_conversation(&FridayConversation {
        friday_conversation_id: "fconv_skill_ed".into(),
        owner_principal: "operator".into(),
        title: "Skill Candidate".into(),
        current_focus_summary: "Stage candidate receipt".into(),
        active_mission_ids: vec!["mission-skill-ed".into()],
        surface_thread_ids: Vec::new(),
        memory_scope_ref: None,
        truth_status: TruthStatus::Proven,
        proof_refs: Vec::new(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
    db.upsert_mission(&Mission {
        mission_id: "mission-skill-ed".into(),
        friday_conversation_id: "fconv_skill_ed".into(),
        title: "Skill Candidate".into(),
        intent: "Stage a skill candidate without importing or executing it".into(),
        status: MissionStatus::Active,
        why_now: "D21 skill hub needs a verify-only receipt path".into(),
        decision_path_summary: "Require Ed25519 operator approval before linking.".into(),
        considered_options: vec!["HMAC self-mint".into()],
        deferred_options: vec!["runtime import".into()],
        known_pitfalls: vec!["linked candidate mistaken for runnable skill".into()],
        handoff_inheritance: vec!["Hub verifies, operator signs".into()],
        work_item_ids: vec!["work-skill-ed".into()],
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: Vec::new(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
    db.upsert_work_item(&WorkItem {
        work_item_id: "work-skill-ed".into(),
        mission_id: "mission-skill-ed".into(),
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

fn link_request(approval: CanonicalApproval, now_ms: i64) -> LinkSkillCandidateReceiptRequest {
    LinkSkillCandidateReceiptRequest {
        skill_id: "invoice-link-skill".into(),
        safe_title: "Invoice Link Skill".into(),
        source_digest: "link-source-digest-alpha".into(),
        evidence_url: "https://example.com/skill-guide".into(),
        mission_id: "mission-skill-ed".into(),
        work_item_id: "work-skill-ed".into(),
        operator_principal_id: "operator".into(),
        canonical_approval: approval,
        proof_ref: "proof://link-skill-candidate/invoice".into(),
        now_ms,
    }
}

fn gate_request() -> MutatingActionRequest {
    link_skill_candidate_gate_request(
        "invoice-link-skill",
        "link-source-digest-alpha",
        "mission-skill-ed",
        "work-skill-ed",
        "operator",
    )
}

fn adoption_gate_request() -> MutatingActionRequest {
    skill_adoption_gate_request(
        "invoice-link-skill",
        "mission-skill-ed",
        "work-skill-ed",
        "operator",
    )
}

fn adoption_request(approval: CanonicalApproval, now_ms: i64) -> SkillAdoptionReceiptRequest {
    SkillAdoptionReceiptRequest {
        skill_id: "invoice-link-skill".into(),
        mission_id: "mission-skill-ed".into(),
        work_item_id: "work-skill-ed".into(),
        operator_principal_id: "operator".into(),
        canonical_approval: approval,
        proof_ref: "proof://skill-adoption/invoice".into(),
        now_ms,
    }
}

fn consumed_count(db: &Db) -> i64 {
    db.conn()
        .query_row("SELECT count(*) FROM consumed_approval", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn ed25519_skill_adoption_receipt_records_mission_scoped_adoption_without_execution() {
    let db = Db::open_hub(&temp_db("adopt-allow")).unwrap();
    seed_mission(&db);
    let (sk, vk) = operator();
    let approval = ed_approval(&adoption_gate_request(), &sk, "skill-adoption-ed-allow");

    let receipt =
        record_skill_adoption_receipt_ed25519(&db, adoption_request(approval, NOW + 1), &vk)
            .unwrap();

    assert_eq!(
        receipt.status,
        "skill_adoption_receipt_recorded_not_executed"
    );
    assert_eq!(receipt.skill_id, "invoice-link-skill");
    let adopted =
        adopted_skill_ids_from_mission_links(&db, "mission-skill-ed", "work-skill-ed").unwrap();
    assert_eq!(adopted, vec!["invoice-link-skill".to_string()]);
    let links = db.list_mission_links("mission-skill-ed").unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(
        links[0].target_ref,
        "friday://skill-adoption/invoice-link-skill"
    );
    assert_eq!(
        links[0].proof_ref.as_deref(),
        Some("proof://skill-adoption/invoice")
    );
    let item = db.get_work_item("work-skill-ed").unwrap().unwrap();
    assert_eq!(item.status, WorkItemStatus::ReadyToDispatch);
    assert!(item.proof_receipts.is_empty());
    assert_eq!(consumed_count(&db), 1);
}

#[test]
fn hmac_skill_adoption_approval_is_rejected_by_ed25519_path() {
    let db = Db::open_hub(&temp_db("adopt-hmac")).unwrap();
    seed_mission(&db);
    let (_sk, vk) = operator();
    let approval = hmac_approval(&adoption_gate_request(), "skill-adoption-hmac");

    let blocked =
        record_skill_adoption_receipt_ed25519(&db, adoption_request(approval, NOW + 1), &vk)
            .unwrap_err();

    assert!(blocked
        .to_string()
        .contains("skill_adoption_canonical_gate_canonical_approval_signature_invalid"));
    assert!(db
        .list_mission_links("mission-skill-ed")
        .unwrap()
        .is_empty());
    assert_eq!(consumed_count(&db), 0);
}

#[test]
fn ed25519_skill_adoption_approval_replay_is_refused_without_second_write() {
    let db = Db::open_hub(&temp_db("adopt-replay")).unwrap();
    seed_mission(&db);
    let (sk, vk) = operator();
    let approval = ed_approval(&adoption_gate_request(), &sk, "skill-adoption-replay");

    record_skill_adoption_receipt_ed25519(&db, adoption_request(approval.clone(), NOW + 1), &vk)
        .unwrap();
    let blocked =
        record_skill_adoption_receipt_ed25519(&db, adoption_request(approval, NOW + 2), &vk)
            .unwrap_err();

    assert!(blocked
        .to_string()
        .contains("skill_adoption_canonical_gate_canonical_approval_replay_refused"));
    assert_eq!(db.list_mission_links("mission-skill-ed").unwrap().len(), 1);
    assert_eq!(consumed_count(&db), 1);
}

#[test]
fn ed25519_link_candidate_receipt_records_without_import_or_execution() {
    let db = Db::open_hub(&temp_db("allow")).unwrap();
    seed_mission(&db);
    let (sk, vk) = operator();
    let approval = ed_approval(&gate_request(), &sk, "skill-link-ed-allow");

    let receipt =
        stage_link_skill_candidate_receipt_ed25519(&db, link_request(approval, NOW + 1), &vk)
            .unwrap();

    assert_eq!(receipt.status, "candidate_receipt_recorded_not_imported");
    assert_eq!(receipt.skill_id, "invoice-link-skill");
    let links = db.list_mission_links("mission-skill-ed").unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_ref, receipt.candidate_ref);
    assert_eq!(
        links[0].proof_ref.as_deref(),
        Some("proof://link-skill-candidate/invoice")
    );
    let item = db.get_work_item("work-skill-ed").unwrap().unwrap();
    assert_eq!(item.status, WorkItemStatus::ReadyToDispatch);
    assert!(item.proof_receipts.is_empty());
    assert_eq!(consumed_count(&db), 1);
}

#[test]
fn hmac_link_candidate_approval_is_rejected_by_ed25519_path() {
    let db = Db::open_hub(&temp_db("hmac")).unwrap();
    seed_mission(&db);
    let (_sk, vk) = operator();
    let approval = hmac_approval(&gate_request(), "skill-link-hmac");

    let blocked =
        stage_link_skill_candidate_receipt_ed25519(&db, link_request(approval, NOW + 1), &vk)
            .unwrap_err();

    assert!(blocked
        .to_string()
        .contains("link_skill_candidate_canonical_gate_canonical_approval_signature_invalid"));
    assert!(db
        .list_mission_links("mission-skill-ed")
        .unwrap()
        .is_empty());
    assert_eq!(consumed_count(&db), 0);
}

#[test]
fn ed25519_link_candidate_approval_replay_is_refused_without_second_write() {
    let db = Db::open_hub(&temp_db("replay")).unwrap();
    seed_mission(&db);
    let (sk, vk) = operator();
    let approval = ed_approval(&gate_request(), &sk, "skill-link-replay");

    stage_link_skill_candidate_receipt_ed25519(&db, link_request(approval.clone(), NOW + 1), &vk)
        .unwrap();
    let blocked =
        stage_link_skill_candidate_receipt_ed25519(&db, link_request(approval, NOW + 2), &vk)
            .unwrap_err();

    assert!(blocked
        .to_string()
        .contains("link_skill_candidate_canonical_gate_canonical_approval_replay_refused"));
    assert_eq!(db.list_mission_links("mission-skill-ed").unwrap().len(), 1);
    assert_eq!(consumed_count(&db), 1);
}
