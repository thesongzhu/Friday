//! D21 local SKILL.md candidate materializer.
//!
//! This is a DARK, local-only import leg. It copies a reviewed local SKILL.md package
//! into a shadow candidate area and records a Mission-bound receipt. It does not install,
//! promote, mark runnable, or execute the skill.

use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

use friday_core::{
    gate::{Actor, ActorKind, CanonicalApproval, GateDecision, MutatingActionRequest},
    MissionLink, MissionLinkKind,
};
use friday_crypto::OperatorVerifyingKey;
use friday_storage::{
    authorize_mutating_action, authorize_mutating_action_ed25519, Db, StorageError,
};
use sha2::{Digest, Sha256};

const MAX_FILES: usize = 64;
const MAX_TOTAL_BYTES: u64 = 512 * 1024;
const MAX_DEPTH: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum SkillCandidateMaterializeError {
    #[error("skill candidate materialize blocked: {0}")]
    Blocked(String),
    #[error("skill candidate materialize io failed")]
    Io(#[from] std::io::Error),
    #[error("skill candidate materialize serialize failed")]
    Serialize(#[from] serde_json::Error),
    #[error("skill candidate materialize storage failed")]
    Storage(#[from] StorageError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillCandidateMaterializeRequest {
    pub source_dir: String,
    pub candidate_root: String,
    pub skill_id: String,
    pub source_digest: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub operator_principal_id: String,
    pub canonical_approval: CanonicalApproval,
    pub proof_ref: String,
    pub now_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillCandidateMaterializeReceipt {
    pub candidate_ref: String,
    pub proof_ref: String,
    pub skill_id: String,
    pub source_digest: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub mission_id: String,
    pub work_item_id: String,
    pub status: String,
}

#[derive(Clone, Debug)]
struct CandidateFile {
    rel: PathBuf,
    bytes: Vec<u8>,
}

pub fn materialize_skill_candidate(
    db: &Db,
    request: SkillCandidateMaterializeRequest,
    approval_secret: &[u8],
) -> Result<SkillCandidateMaterializeReceipt, SkillCandidateMaterializeError> {
    let files = validate_candidate_request(db, &request)?;
    let gate_request = skill_candidate_materialize_gate_request(
        &request.skill_id,
        &request.source_digest,
        &request.mission_id,
        &request.work_item_id,
        &request.operator_principal_id,
    );
    let gate = authorize_mutating_action(
        db.conn(),
        &gate_request,
        Some(&request.canonical_approval),
        approval_secret,
        request.now_ms,
    )?;
    if gate.decision != GateDecision::Allow {
        return Err(SkillCandidateMaterializeError::Blocked(format!(
            "candidate_materialize_canonical_gate_{}",
            gate.reason
        )));
    }
    write_candidate(db, request, files)
}

pub fn materialize_skill_candidate_ed25519(
    db: &Db,
    request: SkillCandidateMaterializeRequest,
    operator_vk: &OperatorVerifyingKey,
) -> Result<SkillCandidateMaterializeReceipt, SkillCandidateMaterializeError> {
    let files = validate_candidate_request(db, &request)?;
    let gate_request = skill_candidate_materialize_gate_request(
        &request.skill_id,
        &request.source_digest,
        &request.mission_id,
        &request.work_item_id,
        &request.operator_principal_id,
    );
    let gate = authorize_mutating_action_ed25519(
        db.conn(),
        &gate_request,
        Some(&request.canonical_approval),
        operator_vk,
        request.now_ms,
    )?;
    if gate.decision != GateDecision::Allow {
        return Err(SkillCandidateMaterializeError::Blocked(format!(
            "candidate_materialize_canonical_gate_{}",
            gate.reason
        )));
    }
    write_candidate(db, request, files)
}

pub fn skill_candidate_materialize_gate_request(
    skill_id: &str,
    source_digest: &str,
    mission_id: &str,
    work_item_id: &str,
    operator_principal_id: &str,
) -> MutatingActionRequest {
    let params = vec![
        ("target".to_string(), skill_id.to_string()),
        ("source_digest".to_string(), source_digest.to_string()),
        ("mission_id".to_string(), mission_id.to_string()),
        ("work_item_id".to_string(), work_item_id.to_string()),
    ];
    MutatingActionRequest::from_classification(
        friday_core::gate::classify(true, friday_core::Risk::High, "materialize_skill_candidate", &params),
        "materialize_skill_candidate".to_string(),
        Actor {
            kind: ActorKind::Owner,
            id: operator_principal_id.to_string(),
            principal_id: Some(operator_principal_id.to_string()),
        },
        "friday_hub_skill_candidate_materializer".to_string(),
        Vec::new(),
        Some(format!(
            "skill_id={skill_id};source_digest={source_digest};mission_id={mission_id};work_item_id={work_item_id}"
        )),
        Some(format!("skill-candidate:{skill_id}:{source_digest}:{mission_id}:{work_item_id}")),
        None,
    )
}

fn validate_candidate_request(
    db: &Db,
    request: &SkillCandidateMaterializeRequest,
) -> Result<Vec<CandidateFile>, SkillCandidateMaterializeError> {
    if !is_safe_id(&request.skill_id) || !is_safe_id(&request.source_digest) {
        return Err(SkillCandidateMaterializeError::Blocked(
            "safe_public_metadata_required".into(),
        ));
    }
    if !request.proof_ref.starts_with("proof://") {
        return Err(SkillCandidateMaterializeError::Blocked(
            "proof_ref_required".into(),
        ));
    }
    let mission = db
        .get_mission(&request.mission_id)?
        .ok_or_else(|| SkillCandidateMaterializeError::Blocked("unknown_mission".into()))?;
    if mission.status.is_terminal() {
        return Err(SkillCandidateMaterializeError::Blocked(
            "mission_is_terminal".into(),
        ));
    }
    let work_item = db
        .get_work_item(&request.work_item_id)?
        .ok_or_else(|| SkillCandidateMaterializeError::Blocked("unknown_work_item".into()))?;
    if work_item.mission_id != request.mission_id {
        return Err(SkillCandidateMaterializeError::Blocked(
            "work_item_mission_mismatch".into(),
        ));
    }
    if work_item.status.is_terminal() {
        return Err(SkillCandidateMaterializeError::Blocked(
            "work_item_is_terminal".into(),
        ));
    }

    let source = fs::canonicalize(&request.source_dir)?;
    let root = fs::canonicalize(&request.candidate_root).or_else(|_| {
        fs::create_dir_all(&request.candidate_root)?;
        fs::canonicalize(&request.candidate_root)
    })?;
    if source.starts_with(&root) {
        return Err(SkillCandidateMaterializeError::Blocked(
            "source_inside_candidate_root".into(),
        ));
    }
    if root.starts_with(&source) {
        return Err(SkillCandidateMaterializeError::Blocked(
            "candidate_root_inside_source".into(),
        ));
    }
    let files = collect_files(&source)?;
    if !files.iter().any(|file| file.rel == Path::new("SKILL.md")) {
        return Err(SkillCandidateMaterializeError::Blocked(
            "skill_md_required".into(),
        ));
    }
    let digest = candidate_digest(&files);
    if digest != request.source_digest {
        return Err(SkillCandidateMaterializeError::Blocked(
            "source_digest_mismatch".into(),
        ));
    }
    Ok(files)
}

fn collect_files(source: &Path) -> Result<Vec<CandidateFile>, SkillCandidateMaterializeError> {
    let mut out = Vec::new();
    collect_files_inner(source, source, &mut out)?;
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    let total = out.iter().map(|f| f.bytes.len() as u64).sum::<u64>();
    if out.len() > MAX_FILES || total > MAX_TOTAL_BYTES {
        return Err(SkillCandidateMaterializeError::Blocked(
            "candidate_size_limit".into(),
        ));
    }
    Ok(out)
}

fn collect_files_inner(
    root: &Path,
    dir: &Path,
    out: &mut Vec<CandidateFile>,
) -> Result<(), SkillCandidateMaterializeError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            return Err(SkillCandidateMaterializeError::Blocked(
                "symlink_rejected".into(),
            ));
        }
        let path = entry.path();
        if ty.is_dir() {
            collect_files_inner(root, &path, out)?;
            continue;
        }
        if !ty.is_file() {
            return Err(SkillCandidateMaterializeError::Blocked(
                "special_file_rejected".into(),
            ));
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| SkillCandidateMaterializeError::Blocked("path_escape".into()))?;
        validate_relative_path(rel)?;
        out.push(CandidateFile {
            rel: rel.to_path_buf(),
            bytes: fs::read(&path)?,
        });
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<(), SkillCandidateMaterializeError> {
    let depth = path.components().count();
    if depth == 0 || depth > MAX_DEPTH {
        return Err(SkillCandidateMaterializeError::Blocked(
            "path_depth_limit".into(),
        ));
    }
    for component in path.components() {
        match component {
            Component::Normal(part) if is_safe_path_part(&part.to_string_lossy()) => {}
            _ => {
                return Err(SkillCandidateMaterializeError::Blocked(
                    "unsafe_path".into(),
                ))
            }
        }
    }
    Ok(())
}

fn write_candidate(
    db: &Db,
    request: SkillCandidateMaterializeRequest,
    files: Vec<CandidateFile>,
) -> Result<SkillCandidateMaterializeReceipt, SkillCandidateMaterializeError> {
    let candidate_ref = redacted_ref(
        "skill-candidate",
        &format!(
            "{}:{}:{}:{}",
            request.skill_id, request.source_digest, request.mission_id, request.work_item_id
        ),
    );
    let candidate_dir = Path::new(&request.candidate_root).join(&candidate_ref);
    let files_dir = candidate_dir.join("files");
    fs::create_dir_all(&files_dir)?;
    for file in &files {
        let target = files_dir.join(&file.rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(target, &file.bytes)?;
    }
    let total_bytes = files
        .iter()
        .map(|file| file.bytes.len() as u64)
        .sum::<u64>();
    let metadata = BTreeMap::from([
        ("candidate_ref", candidate_ref.clone()),
        ("skill_id", request.skill_id.clone()),
        ("source_digest", request.source_digest.clone()),
        (
            "status",
            "materialized_candidate_not_installed_not_executable".to_string(),
        ),
    ]);
    fs::write(
        candidate_dir.join("candidate.json"),
        serde_json::to_vec_pretty(&metadata)?,
    )?;
    db.upsert_mission_link(&MissionLink {
        link_id: candidate_ref.clone(),
        mission_id: request.mission_id.clone(),
        work_item_id: Some(request.work_item_id.clone()),
        link_kind: MissionLinkKind::ProofReceipt,
        target_ref: candidate_ref.clone(),
        proof_ref: Some(request.proof_ref.clone()),
        created_at_ms: request.now_ms,
    })?;
    Ok(SkillCandidateMaterializeReceipt {
        candidate_ref,
        proof_ref: request.proof_ref,
        skill_id: request.skill_id,
        source_digest: request.source_digest,
        file_count: files.len(),
        total_bytes,
        mission_id: request.mission_id,
        work_item_id: request.work_item_id,
        status: "materialized_candidate_not_installed_not_executable".to_string(),
    })
}

fn candidate_digest(files: &[CandidateFile]) -> String {
    let mut hash = Sha256::new();
    for file in files {
        hash.update(file.rel.to_string_lossy().as_bytes());
        hash.update([0]);
        hash.update(&file.bytes);
        hash.update([0]);
    }
    format!("skill-candidate-{}", hex_digest(hash.finalize().as_slice()))
}

fn redacted_ref(prefix: &str, value: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(value.as_bytes());
    format!("{prefix}:{}", hex_digest(hash.finalize().as_slice()))
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn is_safe_path_part(value: &str) -> bool {
    is_safe_id(value) || value == "SKILL.md"
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{
        gate::CanonicalApproval, ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission,
        MissionStatus, Risk, TruthStatus, WorkItem, WorkItemStatus, WorkLane,
    };
    use friday_storage::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    const APPROVAL_SECRET: &[u8] = b"skill-candidate-materialize-secret";
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root(name: &str) -> PathBuf {
        let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "friday-skill-candidate-materialize-{name}-{}-{seq}",
            std::process::id()
        ))
    }

    fn temp_db(name: &str) -> String {
        temp_root(name)
            .with_extension("sqlite")
            .to_string_lossy()
            .into_owned()
    }

    fn seed_mission(db: &Db) {
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: "fconv_skill".into(),
            owner_principal: "operator".into(),
            title: "Skill Conversation".into(),
            current_focus_summary: "Materialize skill candidate".into(),
            active_mission_ids: vec!["mission-skill".into()],
            surface_thread_ids: Vec::new(),
            memory_scope_ref: None,
            truth_status: TruthStatus::Proven,
            proof_refs: Vec::new(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: "mission-skill".into(),
            friday_conversation_id: "fconv_skill".into(),
            title: "Skill Mission".into(),
            intent: "Review a local SKILL.md candidate".into(),
            status: MissionStatus::Active,
            why_now: "User wants a governed skill candidate".into(),
            decision_path_summary: "Materialize shadow candidate only.".into(),
            considered_options: vec!["direct install".into(), "shadow candidate".into()],
            deferred_options: vec!["runtime execution".into()],
            known_pitfalls: vec!["materialize is not install".into()],
            handoff_inheritance: vec!["keep candidate dark".into()],
            work_item_ids: vec!["work-skill".into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: Vec::new(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .unwrap();
        db.upsert_work_item(&WorkItem {
            work_item_id: "work-skill".into(),
            mission_id: "mission-skill".into(),
            lane: WorkLane::FridayHub,
            target_provider_or_agent: Some("skill-candidate".into()),
            status: WorkItemStatus::ReadyToDispatch,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("skill.materialize".into()),
            risk_level: Risk::Low,
            approval_state: ApprovalState::Approved,
            blocking_reason: None,
            input_refs: vec!["friday://body/skill-candidate".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["candidate materialize receipt".into()],
            proof_receipts: Vec::new(),
            judgment_memory: HandoffJudgmentMemory {
                task: "Materialize a skill candidate".into(),
                current_blocker: None,
                target_lane_thread_agent_provider: "skill-candidate".into(),
                read_first_files: vec!["SKILL.md".into()],
                required_output: "candidate receipt only".into(),
                done_criteria: vec!["shadow candidate written".into()],
                red_lines: vec!["do not install or execute".into()],
                why_this_route: "D21 governed import dark leg.".into(),
                considered_options: vec!["direct install".into()],
                deferred_options: vec!["execution".into()],
                previous_pitfalls: vec!["import looked like runnable".into()],
                inheritable_context: vec!["candidate is not installed".into()],
                proof_requirements: vec!["operator approval".into()],
                ownership_claim_ids: Vec::new(),
            },
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .unwrap();
    }

    fn approval(skill_id: &str, digest: &str) -> CanonicalApproval {
        crate::mint_approval(
            &skill_candidate_materialize_gate_request(
                skill_id,
                digest,
                "mission-skill",
                "work-skill",
                "operator",
            ),
            "approval-materialize",
            APPROVAL_SECRET,
            10_000,
        )
    }

    #[test]
    fn materializes_local_skill_md_candidate_without_install_or_execution() {
        let source = temp_root("source");
        let candidate_root = temp_root("candidates");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&candidate_root).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nid: summarize\n---\nSummarize safely.\n",
        )
        .unwrap();
        let files = collect_files(&source).unwrap();
        let digest = candidate_digest(&files);
        let db = Db::open_hub(&temp_db("happy")).unwrap();
        seed_mission(&db);

        let receipt = materialize_skill_candidate(
            &db,
            SkillCandidateMaterializeRequest {
                source_dir: source.to_string_lossy().to_string(),
                candidate_root: candidate_root.to_string_lossy().to_string(),
                skill_id: "summarize".into(),
                source_digest: digest.clone(),
                mission_id: "mission-skill".into(),
                work_item_id: "work-skill".into(),
                operator_principal_id: "operator".into(),
                canonical_approval: approval("summarize", &digest),
                proof_ref: "proof://skill-candidate/summarize".into(),
                now_ms: 10,
            },
            APPROVAL_SECRET,
        )
        .unwrap();

        assert_eq!(
            receipt.status,
            "materialized_candidate_not_installed_not_executable"
        );
        assert_eq!(receipt.file_count, 1);
        assert!(candidate_root
            .join(&receipt.candidate_ref)
            .join("files")
            .join("SKILL.md")
            .is_file());
        assert!(candidate_root
            .join(&receipt.candidate_ref)
            .join("candidate.json")
            .is_file());
        let item = db.get_work_item("work-skill").unwrap().unwrap();
        assert_eq!(item.status, WorkItemStatus::ReadyToDispatch);
        assert!(item.proof_receipts.is_empty());
        let links = db.list_mission_links("mission-skill").unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_ref, receipt.candidate_ref);
        let rendered = format!("{receipt:?}");
        assert!(!rendered.contains(source.to_string_lossy().as_ref()));
        assert!(!rendered.contains("Summarize safely"));
    }

    #[test]
    fn digest_mismatch_blocks_before_writing_candidate() {
        let source = temp_root("mismatch-source");
        let candidate_root = temp_root("mismatch-candidates");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&candidate_root).unwrap();
        fs::write(source.join("SKILL.md"), "body").unwrap();
        let db = Db::open_hub(&temp_db("mismatch")).unwrap();
        seed_mission(&db);

        let err = materialize_skill_candidate(
            &db,
            SkillCandidateMaterializeRequest {
                source_dir: source.to_string_lossy().to_string(),
                candidate_root: candidate_root.to_string_lossy().to_string(),
                skill_id: "summarize".into(),
                source_digest: "skill-candidate-wrong".into(),
                mission_id: "mission-skill".into(),
                work_item_id: "work-skill".into(),
                operator_principal_id: "operator".into(),
                canonical_approval: approval("summarize", "skill-candidate-wrong"),
                proof_ref: "proof://skill-candidate/summarize".into(),
                now_ms: 10,
            },
            APPROVAL_SECRET,
        )
        .unwrap_err();

        assert!(err.to_string().contains("source_digest_mismatch"));
        assert!(fs::read_dir(&candidate_root).unwrap().next().is_none());
        assert!(db.list_mission_links("mission-skill").unwrap().is_empty());
    }

    #[test]
    fn candidate_root_inside_source_is_rejected_before_writing() {
        let source = temp_root("nested-source");
        let candidate_root = source.join("candidates");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&candidate_root).unwrap();
        fs::write(source.join("SKILL.md"), "body").unwrap();
        let files = collect_files(&source).unwrap();
        let digest = candidate_digest(&files);
        let db = Db::open_hub(&temp_db("nested")).unwrap();
        seed_mission(&db);

        let err = materialize_skill_candidate(
            &db,
            SkillCandidateMaterializeRequest {
                source_dir: source.to_string_lossy().to_string(),
                candidate_root: candidate_root.to_string_lossy().to_string(),
                skill_id: "summarize".into(),
                source_digest: digest.clone(),
                mission_id: "mission-skill".into(),
                work_item_id: "work-skill".into(),
                operator_principal_id: "operator".into(),
                canonical_approval: approval("summarize", &digest),
                proof_ref: "proof://skill-candidate/summarize".into(),
                now_ms: 10,
            },
            APPROVAL_SECRET,
        )
        .unwrap_err();

        assert!(err.to_string().contains("candidate_root_inside_source"));
        assert!(fs::read_dir(&candidate_root).unwrap().next().is_none());
        assert!(db.list_mission_links("mission-skill").unwrap().is_empty());
    }
}
