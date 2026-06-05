//! Hub-owned Skill / Capability Catalog / Advisor Bridge.
//!
//! This reads skill metadata and records approved run receipts. It never executes
//! a skill, never reads raw skill instructions beyond manifest fields, and never
//! treats discovery as ownership. A skill run receipt is proof that the canonical
//! gate allowed the run path; it does not mark a WorkItem complete by itself.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

use friday_core::{
    advise_skill,
    gate::{Actor, ActorKind, CanonicalApproval, GateDecision, MutatingActionRequest},
    MissionLink, MissionLinkKind, SkillAdvisorDecision, SkillAdvisorRequest, SkillCatalogEntry,
    SkillCatalogSnapshot, SkillCatalogSource, SkillState, WorkGraphNode, WorkGraphNodeKind,
    WorkGraphTruthLabel,
};
use friday_storage::{authorize_mutating_action, Db, StorageError};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum SkillCatalogError {
    #[error("skill catalog root read failed")]
    RootRead(#[source] std::io::Error),
    #[error("skill manifest read failed")]
    ManifestRead(#[source] std::io::Error),
    #[error("skill manifest parse failed")]
    ManifestParse(#[source] serde_json::Error),
    #[error("skill run blocked: {0}")]
    RunBlocked(String),
    #[error("skill run storage failed")]
    Storage(#[from] StorageError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillCatalogDiscovery {
    pub managed_skills_root: String,
    pub adopted_skill_ids: Vec<String>,
    pub approved_first_run_skill_ids: Vec<String>,
    pub proof_refs_by_skill_id: BTreeMap<String, Vec<String>>,
    pub run_refs_by_skill_id: BTreeMap<String, Vec<String>>,
    pub now_ms: i64,
}

pub fn discover_skill_catalog(
    request: SkillCatalogDiscovery,
) -> Result<SkillCatalogSnapshot, SkillCatalogError> {
    let mut entries = Vec::new();
    let adopted: BTreeSet<String> = request.adopted_skill_ids.into_iter().collect();
    let approved_first_run: BTreeSet<String> =
        request.approved_first_run_skill_ids.into_iter().collect();
    let root = Path::new(&request.managed_skills_root);
    let root_entries = fs::read_dir(root).map_err(SkillCatalogError::RootRead)?;
    for entry in root_entries {
        let Ok(dir_entry) = entry else {
            continue;
        };
        let Ok(file_type) = dir_entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let manifest_path = dir_entry.path().join("skill.manifest.json");
        if !manifest_path.is_file() {
            continue;
        }
        let manifest =
            fs::read_to_string(&manifest_path).map_err(SkillCatalogError::ManifestRead)?;
        let value: Value =
            serde_json::from_str(&manifest).map_err(SkillCatalogError::ManifestParse)?;
        let Some(skill_id) = string_field(&value, "id").filter(|id| is_safe_public_id(id)) else {
            continue;
        };
        let safe_name = string_field(&value, "name")
            .filter(|name| is_safe_public_text(name))
            .unwrap_or_else(|| skill_id.clone());
        let runtime_kind = value
            .get("runtime")
            .and_then(|v| string_field(v, "kind"))
            .filter(|kind| is_safe_public_id(kind))
            .unwrap_or_else(|| "unknown".to_string());
        let intent_keys = value
            .get("triggers")
            .and_then(|triggers| triggers.get("intents"))
            .map(string_array)
            .unwrap_or_default()
            .into_iter()
            .filter(|intent| is_safe_public_id(intent))
            .collect::<Vec<_>>();
        let phrase_count = value
            .get("triggers")
            .and_then(|triggers| triggers.get("phrases"))
            .and_then(|phrases| phrases.as_array())
            .map(|phrases| phrases.len())
            .unwrap_or(0);
        let priority = value
            .get("invocation")
            .and_then(|invocation| invocation.get("priority"))
            .and_then(|priority| priority.as_i64())
            .unwrap_or(0);
        let capability_ids = value
            .get("executionTargets")
            .and_then(|targets| targets.get("requiredCapabilities"))
            .map(string_array)
            .unwrap_or_default()
            .into_iter()
            .filter(|cap| is_safe_public_id(cap))
            .collect::<Vec<_>>();
        let prompt_on = value
            .get("permissions")
            .and_then(|permissions| permissions.get("promptOn"))
            .map(string_array)
            .unwrap_or_default();
        let grants = value
            .get("permissions")
            .and_then(|permissions| permissions.get("grants"))
            .and_then(|grants| grants.as_array())
            .map(|grants| grants.len())
            .unwrap_or(0);
        let requires_operator_approval =
            !prompt_on.is_empty() || grants > 0 || runtime_kind == "shell";
        let is_adopted = adopted.contains(&skill_id);
        let first_run_approved = approved_first_run.contains(&skill_id);
        let truth_label = if is_adopted {
            WorkGraphTruthLabel::FridayAdopted
        } else {
            WorkGraphTruthLabel::ObservedOnly
        };
        let state = if is_adopted {
            SkillState::Runnable
        } else {
            SkillState::Candidate
        };
        let mut approval_blockers = Vec::new();
        if !is_adopted {
            approval_blockers.push("operator_adoption_required_before_skill_run".to_string());
        }
        if requires_operator_approval && !first_run_approved {
            approval_blockers
                .push("operator_approval_required_before_first_or_high_risk_run".to_string());
        }
        entries.push(SkillCatalogEntry {
            skill_ref: redacted_ref("skill", &skill_id),
            skill_id: skill_id.clone(),
            safe_name,
            source: SkillCatalogSource::ManagedLocal,
            truth_label,
            state,
            runtime_kind,
            intent_keys,
            phrase_count,
            capability_ids,
            priority,
            requires_operator_approval,
            approval_blockers,
            proof_refs: request
                .proof_refs_by_skill_id
                .get(&skill_id)
                .map(|refs| filter_safe_refs(refs))
                .unwrap_or_default(),
            run_refs: request
                .run_refs_by_skill_id
                .get(&skill_id)
                .map(|refs| filter_safe_refs(refs))
                .unwrap_or_default(),
            updated_at_ms: request.now_ms,
        });
    }
    entries.sort_by(|a, b| a.skill_id.cmp(&b.skill_id));
    Ok(SkillCatalogSnapshot {
        generated_at_ms: request.now_ms,
        entries,
        no_go: vec![
            "skill_discovery_is_not_execution".to_string(),
            "observed_skill_is_not_owned".to_string(),
            "skill_run_requires_gate_and_receipt".to_string(),
            "skill_memory_preference_is_not_auto_confirmed".to_string(),
        ],
    })
}

pub fn advise_skill_from_catalog(
    snapshot: &SkillCatalogSnapshot,
    request: SkillAdvisorRequest,
) -> SkillAdvisorDecision {
    advise_skill(snapshot, &request)
}

pub fn skill_catalog_nodes(snapshot: &SkillCatalogSnapshot) -> Vec<WorkGraphNode> {
    snapshot
        .entries
        .iter()
        .map(|entry| WorkGraphNode {
            node_ref: entry.skill_ref.clone(),
            kind: WorkGraphNodeKind::Skill,
            truth_label: entry.truth_label,
            mission_id: None,
            work_item_id: None,
            lane: None,
            safe_title: entry.safe_name.clone(),
            status_label: entry.state.as_str().to_string(),
            evidence_refs: vec![entry.skill_ref.clone()],
            proof_refs: entry.proof_refs.clone(),
            blockers: skill_blockers(entry),
            control_allowed: false,
            updated_at_ms: entry.updated_at_ms,
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillRunReceiptRequest {
    pub skill_id: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub operator_principal_id: String,
    pub canonical_approval: CanonicalApproval,
    pub proof_ref: String,
    pub now_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillRunReceipt {
    pub run_ref: String,
    pub proof_ref: String,
    pub skill_ref: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub status: String,
}

pub fn record_skill_run_receipt(
    db: &Db,
    snapshot: &SkillCatalogSnapshot,
    request: SkillRunReceiptRequest,
    approval_secret: &[u8],
) -> Result<SkillRunReceipt, SkillCatalogError> {
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.skill_id == request.skill_id)
        .ok_or_else(|| SkillCatalogError::RunBlocked("unknown_skill".to_string()))?;
    if !entry.can_be_recommended() {
        return Err(SkillCatalogError::RunBlocked(
            "skill_not_runnable_or_not_approved".to_string(),
        ));
    }
    if !is_safe_proof_ref(&request.proof_ref) {
        return Err(SkillCatalogError::RunBlocked(
            "skill_run_proof_ref_required".to_string(),
        ));
    }
    let mission = db
        .get_mission(&request.mission_id)?
        .ok_or_else(|| SkillCatalogError::RunBlocked("unknown_mission".to_string()))?;
    if mission.status.is_terminal() {
        return Err(SkillCatalogError::RunBlocked(
            "mission_is_terminal".to_string(),
        ));
    }
    let work_item = db
        .get_work_item(&request.work_item_id)?
        .ok_or_else(|| SkillCatalogError::RunBlocked("unknown_work_item".to_string()))?;
    if work_item.mission_id != request.mission_id {
        return Err(SkillCatalogError::RunBlocked(
            "work_item_mission_mismatch".to_string(),
        ));
    }
    if work_item.status.is_terminal() {
        return Err(SkillCatalogError::RunBlocked(
            "work_item_is_terminal".to_string(),
        ));
    }
    let gate_request = skill_run_gate_request(
        &request.skill_id,
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
        return Err(SkillCatalogError::RunBlocked(format!(
            "skill_run_canonical_gate_{}",
            gate.reason
        )));
    }

    let run_ref = redacted_ref(
        "skill-run",
        &format!(
            "{}:{}:{}:{}",
            entry.skill_id, request.mission_id, request.work_item_id, request.now_ms
        ),
    );
    db.upsert_mission_link(&MissionLink {
        link_id: run_ref.clone(),
        mission_id: request.mission_id.clone(),
        work_item_id: Some(request.work_item_id.clone()),
        link_kind: MissionLinkKind::ProofReceipt,
        target_ref: run_ref.clone(),
        proof_ref: Some(request.proof_ref.clone()),
        created_at_ms: request.now_ms,
    })?;

    Ok(SkillRunReceipt {
        run_ref,
        proof_ref: request.proof_ref,
        skill_ref: entry.skill_ref.clone(),
        mission_id: request.mission_id,
        work_item_id: request.work_item_id,
        status: "receipt_recorded_not_completed".to_string(),
    })
}

pub fn skill_run_gate_request(
    skill_id: &str,
    mission_id: &str,
    work_item_id: &str,
    operator_principal_id: &str,
) -> MutatingActionRequest {
    let params = vec![
        ("target".to_string(), skill_id.to_string()),
        ("mission_id".to_string(), mission_id.to_string()),
        ("work_item_id".to_string(), work_item_id.to_string()),
    ];
    MutatingActionRequest::from_classification(
        friday_core::gate::classify(true, friday_core::Risk::High, "run_skill", &params),
        "run_skill".to_string(),
        Actor {
            kind: ActorKind::Owner,
            id: operator_principal_id.to_string(),
            principal_id: Some(operator_principal_id.to_string()),
        },
        "friday_hub_skill_catalog".to_string(),
        Vec::new(),
        Some(format!(
            "skill_id={skill_id};mission_id={mission_id};work_item_id={work_item_id}"
        )),
        Some(format!("skill-run:{skill_id}:{mission_id}:{work_item_id}")),
        None,
    )
}

pub fn skill_run_node(receipt: &SkillRunReceipt, now_ms: i64) -> WorkGraphNode {
    WorkGraphNode {
        node_ref: receipt.run_ref.clone(),
        kind: WorkGraphNodeKind::SkillRun,
        truth_label: WorkGraphTruthLabel::FridayOwned,
        mission_id: Some(receipt.mission_id.clone()),
        work_item_id: Some(receipt.work_item_id.clone()),
        lane: None,
        safe_title: "Approved skill run receipt".to_string(),
        status_label: receipt.status.clone(),
        evidence_refs: vec![receipt.skill_ref.clone(), receipt.run_ref.clone()],
        proof_refs: vec![receipt.proof_ref.clone()],
        blockers: vec!["skill_run_receipt_does_not_complete_work_item".to_string()],
        control_allowed: false,
        updated_at_ms: now_ms,
    }
}

fn skill_blockers(entry: &SkillCatalogEntry) -> Vec<String> {
    let mut blockers = entry.approval_blockers.clone();
    blockers.push("skill_catalog_does_not_grant_execution_control".to_string());
    if entry.run_refs.is_empty() {
        blockers.push("no_skill_run_receipt".to_string());
    }
    blockers.sort();
    blockers.dedup();
    blockers
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn filter_safe_refs(values: &[String]) -> Vec<String> {
    values
        .iter()
        .filter(|value| value.starts_with("proof://") || value.starts_with("friday://"))
        .filter(|value| !looks_private(value))
        .cloned()
        .collect()
}

fn is_safe_proof_ref(value: &str) -> bool {
    (value.starts_with("proof://") || value.starts_with("friday://"))
        && !looks_private(value)
        && value.len() <= 256
}

fn is_safe_public_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/'))
        && !looks_private(value)
}

fn is_safe_public_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && !looks_private(value)
        && !value.contains('\n')
        && !value.contains('\r')
}

fn redacted_ref(kind: &str, raw: &str) -> String {
    format!("friday://{kind}/{}", stable_hash(raw))
}

fn stable_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for b in value.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn looks_private(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("/users/")
        || lower.contains("/private/")
        || lower.contains("bearer")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("provider_native_synced")
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus,
        SkillAdvisorRecommendationKind, TruthStatus, WorkGraphTruthLabel, WorkItem, WorkItemStatus,
        WorkLane,
    };
    use friday_storage::Db;
    use std::{
        fs::{create_dir_all, write},
        sync::atomic::{AtomicU64, Ordering},
    };

    const APPROVAL_SECRET: &[u8] = b"skill-run-approval-secret";
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root(name: &str) -> std::path::PathBuf {
        let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "friday-skill-catalog-{name}-{}-{seq}-{nanos}",
            std::process::id()
        ))
    }

    fn write_skill(root: &Path, dir: &str, manifest: &str) {
        let skill_dir = root.join(dir);
        create_dir_all(&skill_dir).unwrap();
        write(skill_dir.join("skill.manifest.json"), manifest).unwrap();
        write(skill_dir.join("run.sh"), "#!/usr/bin/env bash\nexit 0\n").unwrap();
    }

    fn temp_db(name: &str) -> String {
        let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir()
            .join(format!(
                "friday-skill-run-{name}-{}-{seq}.sqlite",
                std::process::id()
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn judgment() -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "Run approved skill through receipt bridge".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: "skill:time".into(),
            read_first_files: vec!["skill.manifest.json".into()],
            required_output: "skill run receipt only".into(),
            done_criteria: vec!["receipt linked to Mission".into()],
            red_lines: vec!["skill run alone is not completion".into()],
            why_this_route: "Advisor selected an operator-approved skill.".into(),
            considered_options: vec!["skill receipt".into()],
            deferred_options: vec!["execute skill code".into()],
            previous_pitfalls: vec!["catalog discovery looked like execution".into()],
            inheritable_context: vec!["Mission owns completion".into()],
            proof_requirements: vec!["operator approval".into(), "skill run receipt".into()],
            ownership_claim_ids: Vec::new(),
        }
    }

    fn seed_skill_run_mission(db: &Db) {
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: "fconv_skill".into(),
            owner_principal: "operator".into(),
            title: "Skill Conversation".into(),
            current_focus_summary: "Approved skill run receipt".into(),
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
            intent: "Use approved skill safely".into(),
            status: MissionStatus::Active,
            why_now: "User requested a skill-backed action".into(),
            decision_path_summary: "Require Mission-bound skill receipt.".into(),
            considered_options: vec!["raw skill exec".into(), "receipt bridge".into()],
            deferred_options: vec!["plugin runtime".into()],
            known_pitfalls: vec!["skill run is not completion".into()],
            handoff_inheritance: vec!["keep Mission context".into()],
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
            target_provider_or_agent: Some("skill:time".into()),
            status: WorkItemStatus::ReadyToDispatch,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("skill.time".into()),
            risk_level: friday_core::Risk::Low,
            approval_state: ApprovalState::Approved,
            blocking_reason: None,
            input_refs: vec!["friday://body/skill".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["skill run receipt".into()],
            proof_receipts: Vec::new(),
            judgment_memory: judgment(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .unwrap();
    }

    fn signed_skill_run_approval(
        skill_id: &str,
        mission_id: &str,
        work_item_id: &str,
    ) -> friday_core::gate::CanonicalApproval {
        crate::mint_approval(
            &skill_run_gate_request(skill_id, mission_id, work_item_id, "operator"),
            "approval-skill-run",
            APPROVAL_SECRET,
            10_000,
        )
    }

    #[test]
    fn discovers_managed_skill_as_observed_without_raw_path_or_execution() {
        let root = temp_root("observed");
        write_skill(
            &root,
            "output-current-date-time",
            r#"{
              "id":"output-current-date-time",
              "name":"Output Current Date and Time",
              "runtime":{"kind":"shell","entrypoint":"run.sh"},
              "triggers":{"intents":["current_datetime"],"phrases":["what time is it"]},
              "invocation":{"priority":50},
              "permissions":{"grants":[],"promptOn":[]},
              "executionTargets":{"requiredCapabilities":[]}
            }"#,
        );
        let snapshot = discover_skill_catalog(SkillCatalogDiscovery {
            managed_skills_root: root.to_string_lossy().to_string(),
            adopted_skill_ids: Vec::new(),
            approved_first_run_skill_ids: Vec::new(),
            proof_refs_by_skill_id: BTreeMap::new(),
            run_refs_by_skill_id: BTreeMap::new(),
            now_ms: 10,
        })
        .unwrap();
        assert_eq!(snapshot.entries.len(), 1);
        let entry = &snapshot.entries[0];
        assert_eq!(entry.truth_label, WorkGraphTruthLabel::ObservedOnly);
        assert_eq!(entry.state, SkillState::Candidate);
        assert!(entry
            .approval_blockers
            .iter()
            .any(|b| b == "operator_adoption_required_before_skill_run"));
        let rendered = format!("{snapshot:?}");
        assert!(!rendered.contains(root.to_string_lossy().as_ref()));
        assert!(!rendered.contains("run.sh"));
    }

    #[test]
    fn adopted_skill_changes_advisor_from_blocked_to_recommendable_after_approval() {
        let root = temp_root("adopted");
        write_skill(
            &root,
            "output-current-date-time",
            r#"{
              "id":"output-current-date-time",
              "name":"Output Current Date and Time",
              "runtime":{"kind":"shell","entrypoint":"run.sh"},
              "triggers":{"intents":["current_datetime"],"phrases":[]},
              "invocation":{"priority":50},
              "permissions":{"grants":[],"promptOn":["shell.execute"]},
              "executionTargets":{"requiredCapabilities":[]}
            }"#,
        );

        let observed = discover_skill_catalog(SkillCatalogDiscovery {
            managed_skills_root: root.to_string_lossy().to_string(),
            adopted_skill_ids: Vec::new(),
            approved_first_run_skill_ids: Vec::new(),
            proof_refs_by_skill_id: BTreeMap::new(),
            run_refs_by_skill_id: BTreeMap::new(),
            now_ms: 10,
        })
        .unwrap();
        let blocked = advise_skill_from_catalog(
            &observed,
            SkillAdvisorRequest {
                intent_key: "current_datetime".to_string(),
                operator_approved_first_run: false,
            },
        );
        assert_eq!(
            blocked.recommendation,
            SkillAdvisorRecommendationKind::KeepObservedOnly
        );
        assert!(!blocked.run_allowed);

        let adopted = discover_skill_catalog(SkillCatalogDiscovery {
            managed_skills_root: root.to_string_lossy().to_string(),
            adopted_skill_ids: vec!["output-current-date-time".to_string()],
            approved_first_run_skill_ids: vec!["output-current-date-time".to_string()],
            proof_refs_by_skill_id: BTreeMap::from([(
                "output-current-date-time".to_string(),
                vec!["proof://operator/skill-adopt".to_string()],
            )]),
            run_refs_by_skill_id: BTreeMap::from([(
                "output-current-date-time".to_string(),
                vec!["proof://skill-run/time-1".to_string()],
            )]),
            now_ms: 11,
        })
        .unwrap();
        let recommended = advise_skill_from_catalog(
            &adopted,
            SkillAdvisorRequest {
                intent_key: "current_datetime".to_string(),
                operator_approved_first_run: true,
            },
        );
        assert_eq!(
            recommended.recommendation,
            SkillAdvisorRecommendationKind::RecommendRunnableSkill
        );
        assert!(recommended.run_allowed);
        assert_eq!(
            recommended.skill_id.as_deref(),
            Some("output-current-date-time")
        );
    }

    #[test]
    fn skill_catalog_nodes_never_grant_control_or_completion() {
        let root = temp_root("nodes");
        write_skill(
            &root,
            "time",
            r#"{
              "id":"time",
              "name":"Time",
              "runtime":{"kind":"shell"},
              "triggers":{"intents":["current_datetime"],"phrases":[]},
              "invocation":{"priority":50},
              "permissions":{"grants":[],"promptOn":[]},
              "executionTargets":{"requiredCapabilities":[]}
            }"#,
        );
        let snapshot = discover_skill_catalog(SkillCatalogDiscovery {
            managed_skills_root: root.to_string_lossy().to_string(),
            adopted_skill_ids: vec!["time".to_string()],
            approved_first_run_skill_ids: vec!["time".to_string()],
            proof_refs_by_skill_id: BTreeMap::new(),
            run_refs_by_skill_id: BTreeMap::new(),
            now_ms: 12,
        })
        .unwrap();
        let nodes = skill_catalog_nodes(&snapshot);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].kind, WorkGraphNodeKind::Skill);
        assert_eq!(nodes[0].truth_label, WorkGraphTruthLabel::FridayAdopted);
        assert!(!nodes[0].control_allowed);
        assert!(nodes[0]
            .blockers
            .contains(&"skill_catalog_does_not_grant_execution_control".to_string()));
        assert!(nodes[0]
            .blockers
            .contains(&"no_skill_run_receipt".to_string()));
    }

    #[test]
    fn approved_skill_run_records_receipt_without_completing_work_item() {
        let root = temp_root("run-receipt");
        write_skill(
            &root,
            "time",
            r#"{
              "id":"time",
              "name":"Time",
              "runtime":{"kind":"shell"},
              "triggers":{"intents":["current_datetime"],"phrases":[]},
              "invocation":{"priority":50},
              "permissions":{"grants":[],"promptOn":[]},
              "executionTargets":{"requiredCapabilities":[]}
            }"#,
        );
        let snapshot = discover_skill_catalog(SkillCatalogDiscovery {
            managed_skills_root: root.to_string_lossy().to_string(),
            adopted_skill_ids: vec!["time".to_string()],
            approved_first_run_skill_ids: vec!["time".to_string()],
            proof_refs_by_skill_id: BTreeMap::from([(
                "time".to_string(),
                vec!["proof://operator/skill-adopt".to_string()],
            )]),
            run_refs_by_skill_id: BTreeMap::new(),
            now_ms: 20,
        })
        .unwrap();
        let db = Db::open_hub(&temp_db("receipt")).unwrap();
        seed_skill_run_mission(&db);

        let receipt = record_skill_run_receipt(
            &db,
            &snapshot,
            SkillRunReceiptRequest {
                skill_id: "time".into(),
                mission_id: "mission-skill".into(),
                work_item_id: "work-skill".into(),
                operator_principal_id: "operator".into(),
                canonical_approval: signed_skill_run_approval(
                    "time",
                    "mission-skill",
                    "work-skill",
                ),
                proof_ref: "proof://skill-run/time-1".into(),
                now_ms: 21,
            },
            APPROVAL_SECRET,
        )
        .unwrap();

        assert_eq!(receipt.status, "receipt_recorded_not_completed");
        let links = db.list_mission_links("mission-skill").unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_ref, receipt.run_ref);
        assert_eq!(
            links[0].proof_ref.as_deref(),
            Some("proof://skill-run/time-1")
        );
        let item = db.get_work_item("work-skill").unwrap().unwrap();
        assert_eq!(item.status, WorkItemStatus::ReadyToDispatch);
        assert!(item.proof_receipts.is_empty());

        let node = skill_run_node(&receipt, 22);
        assert_eq!(node.kind, WorkGraphNodeKind::SkillRun);
        assert!(!node.control_allowed);
        assert!(node
            .blockers
            .contains(&"skill_run_receipt_does_not_complete_work_item".to_string()));
    }

    #[test]
    fn skill_run_receipt_blocks_observed_or_missing_mission_context() {
        let root = temp_root("run-blocked");
        write_skill(
            &root,
            "time",
            r#"{
              "id":"time",
              "name":"Time",
              "runtime":{"kind":"shell"},
              "triggers":{"intents":["current_datetime"],"phrases":[]},
              "invocation":{"priority":50},
              "permissions":{"grants":[],"promptOn":[]},
              "executionTargets":{"requiredCapabilities":[]}
            }"#,
        );
        let observed = discover_skill_catalog(SkillCatalogDiscovery {
            managed_skills_root: root.to_string_lossy().to_string(),
            adopted_skill_ids: Vec::new(),
            approved_first_run_skill_ids: Vec::new(),
            proof_refs_by_skill_id: BTreeMap::new(),
            run_refs_by_skill_id: BTreeMap::new(),
            now_ms: 30,
        })
        .unwrap();
        let db = Db::open_hub(&temp_db("blocked")).unwrap();
        let blocked = record_skill_run_receipt(
            &db,
            &observed,
            SkillRunReceiptRequest {
                skill_id: "time".into(),
                mission_id: "mission-skill".into(),
                work_item_id: "work-skill".into(),
                operator_principal_id: "operator".into(),
                canonical_approval: signed_skill_run_approval(
                    "time",
                    "mission-skill",
                    "work-skill",
                ),
                proof_ref: "proof://skill-run/time-1".into(),
                now_ms: 31,
            },
            APPROVAL_SECRET,
        )
        .unwrap_err();
        assert!(blocked
            .to_string()
            .contains("skill_not_runnable_or_not_approved"));

        let adopted = discover_skill_catalog(SkillCatalogDiscovery {
            managed_skills_root: root.to_string_lossy().to_string(),
            adopted_skill_ids: vec!["time".to_string()],
            approved_first_run_skill_ids: vec!["time".to_string()],
            proof_refs_by_skill_id: BTreeMap::new(),
            run_refs_by_skill_id: BTreeMap::new(),
            now_ms: 32,
        })
        .unwrap();
        let blocked = record_skill_run_receipt(
            &db,
            &adopted,
            SkillRunReceiptRequest {
                skill_id: "time".into(),
                mission_id: "mission-skill".into(),
                work_item_id: "work-skill".into(),
                operator_principal_id: "operator".into(),
                canonical_approval: signed_skill_run_approval(
                    "time",
                    "mission-skill",
                    "work-skill",
                ),
                proof_ref: "proof://skill-run/time-1".into(),
                now_ms: 33,
            },
            APPROVAL_SECRET,
        )
        .unwrap_err();
        assert!(blocked.to_string().contains("unknown_mission"));
    }

    #[test]
    fn skill_run_receipt_requires_digest_bound_canonical_approval() {
        let root = temp_root("run-approval");
        write_skill(
            &root,
            "time",
            r#"{
              "id":"time",
              "name":"Time",
              "runtime":{"kind":"shell"},
              "triggers":{"intents":["current_datetime"],"phrases":[]},
              "invocation":{"priority":50},
              "permissions":{"grants":[],"promptOn":[]},
              "executionTargets":{"requiredCapabilities":[]}
            }"#,
        );
        let snapshot = discover_skill_catalog(SkillCatalogDiscovery {
            managed_skills_root: root.to_string_lossy().to_string(),
            adopted_skill_ids: vec!["time".to_string()],
            approved_first_run_skill_ids: vec!["time".to_string()],
            proof_refs_by_skill_id: BTreeMap::new(),
            run_refs_by_skill_id: BTreeMap::new(),
            now_ms: 40,
        })
        .unwrap();
        let db = Db::open_hub(&temp_db("approval")).unwrap();
        seed_skill_run_mission(&db);
        let wrong_work_item_approval =
            signed_skill_run_approval("time", "mission-skill", "work-skill-other");

        let blocked = record_skill_run_receipt(
            &db,
            &snapshot,
            SkillRunReceiptRequest {
                skill_id: "time".into(),
                mission_id: "mission-skill".into(),
                work_item_id: "work-skill".into(),
                operator_principal_id: "operator".into(),
                canonical_approval: wrong_work_item_approval,
                proof_ref: "proof://skill-run/time-approval".into(),
                now_ms: 41,
            },
            APPROVAL_SECRET,
        )
        .unwrap_err();
        assert!(blocked
            .to_string()
            .contains("skill_run_canonical_gate_canonical_approval_digest_mismatch"));
        assert!(db.list_mission_links("mission-skill").unwrap().is_empty());
    }
}
