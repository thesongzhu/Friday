//! D21 governed local skill execution substrate.
//!
//! This DARK leg executes only adopted managed-local `runtime.kind = "shell"` skills
//! after an operator Ed25519 approval for the exact `run_skill` gate request. It does
//! not install skills, promote candidates, mark WorkItems complete, or infer GO-LIVE.

use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

use friday_core::{
    gate::{CanonicalApproval, GateDecision},
    MissionLink, MissionLinkKind, SkillCatalogEntry, SkillCatalogSnapshot,
};
use friday_crypto::OperatorVerifyingKey;
use friday_storage::{authorize_mutating_action_ed25519, Db, StorageError};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::skill_catalog::{discover_skill_catalog, skill_run_gate_request, SkillCatalogDiscovery};

pub const FRIDAY_D21_SKILL_RUN_LOCAL: &str = "FRIDAY_D21_SKILL_RUN_LOCAL";

#[derive(Debug, thiserror::Error)]
pub enum SkillExecutionError {
    #[error("skill execution blocked: {0}")]
    Blocked(String),
    #[error("skill execution io failed")]
    Io(#[from] std::io::Error),
    #[error("skill execution manifest parse failed")]
    ManifestParse(#[from] serde_json::Error),
    #[error("skill execution storage failed")]
    Storage(#[from] StorageError),
    #[error("skill execution catalog failed")]
    Catalog(#[from] crate::skill_catalog::SkillCatalogError),
    #[error("skill execution runner failed")]
    Runner(#[from] friday_fs::FsError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalSkillRunRequest {
    pub managed_skills_root: String,
    pub adopted_skill_ids: Vec<String>,
    pub approved_first_run_skill_ids: Vec<String>,
    pub skill_id: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub operator_principal_id: String,
    pub canonical_approval: CanonicalApproval,
    pub now_ms: i64,
    pub require_darwin_sandbox: bool,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalSkillRunReceipt {
    pub run_ref: String,
    pub proof_ref: String,
    pub skill_ref: String,
    pub skill_id: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub status: String,
    pub sandbox_mode: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub output_truncated: bool,
    pub output_sha256: String,
    pub output_len: usize,
}

#[derive(Clone, Debug)]
struct RuntimeManifest {
    entrypoint: PathBuf,
}

pub fn skill_run_local_enabled_from(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1"))
}

pub fn run_local_skill_ed25519(
    db: &Db,
    request: LocalSkillRunRequest,
    operator_vk: &OperatorVerifyingKey,
    enabled: bool,
) -> Result<LocalSkillRunReceipt, SkillExecutionError> {
    if !enabled {
        return Err(SkillExecutionError::Blocked(
            "skill_run_local_flag_off".to_string(),
        ));
    }
    if request.timeout_ms == 0 || request.timeout_ms > 120_000 {
        return Err(SkillExecutionError::Blocked(
            "skill_run_timeout_out_of_range".to_string(),
        ));
    }

    let snapshot = discover_skill_catalog(SkillCatalogDiscovery {
        managed_skills_root: request.managed_skills_root.clone(),
        adopted_skill_ids: request.adopted_skill_ids.clone(),
        approved_first_run_skill_ids: request.approved_first_run_skill_ids.clone(),
        proof_refs_by_skill_id: Default::default(),
        run_refs_by_skill_id: Default::default(),
        now_ms: request.now_ms,
    })?;
    let entry = runnable_entry(&snapshot, &request.skill_id)?;
    let skill_dir = contained_skill_dir(&request.managed_skills_root, &request.skill_id)?;
    let runtime = read_runtime_manifest(&skill_dir)?;
    validate_mission_work_item(db, &request.mission_id, &request.work_item_id)?;

    let gate_request = skill_run_gate_request(
        &request.skill_id,
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
        return Err(SkillExecutionError::Blocked(format!(
            "skill_run_canonical_gate_{}",
            gate.reason
        )));
    }

    let command = format!("./{}", runtime.entrypoint.to_string_lossy());
    let timeout = Duration::from_millis(request.timeout_ms);
    let result = if request.require_darwin_sandbox {
        friday_fs::run_command_in_root_with_darwin_sandbox_timeout(&skill_dir, &command, timeout)?
    } else {
        friday_fs::run_command_in_root_with_timeout(&skill_dir, &command, timeout)?
    };
    let output_sha256 = sha256_hex(result.output.as_bytes());
    let run_ref = redacted_ref(
        "skill-run-local",
        &format!(
            "{}:{}:{}:{}:{}",
            request.skill_id,
            request.mission_id,
            request.work_item_id,
            request.now_ms,
            output_sha256
        ),
    );
    let proof_ref = format!(
        "proof://skill-run-local/{}/{}",
        request.skill_id, output_sha256
    );
    db.upsert_mission_link(&MissionLink {
        link_id: run_ref.clone(),
        mission_id: request.mission_id.clone(),
        work_item_id: Some(request.work_item_id.clone()),
        link_kind: MissionLinkKind::ProofReceipt,
        target_ref: run_ref.clone(),
        proof_ref: Some(proof_ref.clone()),
        created_at_ms: request.now_ms,
    })?;

    Ok(LocalSkillRunReceipt {
        run_ref,
        proof_ref,
        skill_ref: entry.skill_ref.clone(),
        skill_id: request.skill_id,
        mission_id: request.mission_id,
        work_item_id: request.work_item_id,
        status: "skill_executed_not_completed".to_string(),
        sandbox_mode: if request.require_darwin_sandbox {
            "darwin_seatbelt"
        } else {
            "workspace_contained"
        }
        .to_string(),
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        output_truncated: result.output_truncated,
        output_sha256,
        output_len: result.output.len(),
    })
}

fn runnable_entry<'a>(
    snapshot: &'a SkillCatalogSnapshot,
    skill_id: &str,
) -> Result<&'a SkillCatalogEntry, SkillExecutionError> {
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.skill_id == skill_id)
        .ok_or_else(|| SkillExecutionError::Blocked("unknown_skill".to_string()))?;
    if !entry.can_be_recommended() {
        return Err(SkillExecutionError::Blocked(
            "skill_not_runnable_or_not_approved".to_string(),
        ));
    }
    if entry.runtime_kind != "shell" {
        return Err(SkillExecutionError::Blocked(
            "skill_runtime_not_shell".to_string(),
        ));
    }
    Ok(entry)
}

fn contained_skill_dir(root: &str, skill_id: &str) -> Result<PathBuf, SkillExecutionError> {
    if !is_safe_id(skill_id) {
        return Err(SkillExecutionError::Blocked(
            "safe_skill_id_required".to_string(),
        ));
    }
    let root = fs::canonicalize(root)?;
    let skill_dir = fs::canonicalize(root.join(skill_id))?;
    if !skill_dir.starts_with(&root) {
        return Err(SkillExecutionError::Blocked(
            "skill_dir_outside_root".to_string(),
        ));
    }
    Ok(skill_dir)
}

fn read_runtime_manifest(skill_dir: &Path) -> Result<RuntimeManifest, SkillExecutionError> {
    let raw = fs::read_to_string(skill_dir.join("skill.manifest.json"))?;
    let value: Value = serde_json::from_str(&raw)?;
    let kind = value
        .get("runtime")
        .and_then(|runtime| runtime.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if kind != "shell" {
        return Err(SkillExecutionError::Blocked(
            "skill_runtime_not_shell".to_string(),
        ));
    }
    let entrypoint = value
        .get("runtime")
        .and_then(|runtime| runtime.get("entrypoint"))
        .and_then(Value::as_str)
        .ok_or_else(|| SkillExecutionError::Blocked("skill_entrypoint_required".to_string()))?;
    Ok(RuntimeManifest {
        entrypoint: safe_relative_entrypoint(entrypoint)?,
    })
}

fn safe_relative_entrypoint(value: &str) -> Result<PathBuf, SkillExecutionError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 160
        || value.contains('\\')
        || value.contains('"')
        || value.contains('\'')
        || value.chars().any(char::is_whitespace)
    {
        return Err(SkillExecutionError::Blocked(
            "skill_entrypoint_safe_relative_required".to_string(),
        ));
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Err(SkillExecutionError::Blocked(
            "skill_entrypoint_safe_relative_required".to_string(),
        ));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(SkillExecutionError::Blocked(
                    "skill_entrypoint_safe_relative_required".to_string(),
                ));
            }
        }
    }
    Ok(path)
}

fn validate_mission_work_item(
    db: &Db,
    mission_id: &str,
    work_item_id: &str,
) -> Result<(), SkillExecutionError> {
    let mission = db
        .get_mission(mission_id)?
        .ok_or_else(|| SkillExecutionError::Blocked("unknown_mission".to_string()))?;
    if mission.status.is_terminal() {
        return Err(SkillExecutionError::Blocked(
            "mission_is_terminal".to_string(),
        ));
    }
    let work_item = db
        .get_work_item(work_item_id)?
        .ok_or_else(|| SkillExecutionError::Blocked("unknown_work_item".to_string()))?;
    if work_item.mission_id != mission_id {
        return Err(SkillExecutionError::Blocked(
            "work_item_mission_mismatch".to_string(),
        ));
    }
    if work_item.status.is_terminal() {
        return Err(SkillExecutionError::Blocked(
            "work_item_is_terminal".to_string(),
        ));
    }
    Ok(())
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn redacted_ref(kind: &str, raw: &str) -> String {
    format!("friday://{kind}/{}", sha256_hex(raw.as_bytes()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(bytes);
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_run_local_flag_parser_is_exact_one_default_off() {
        assert!(!skill_run_local_enabled_from(None));
        assert!(!skill_run_local_enabled_from(Some("")));
        assert!(!skill_run_local_enabled_from(Some("0")));
        assert!(!skill_run_local_enabled_from(Some("true")));
        assert!(!skill_run_local_enabled_from(Some("2")));
        assert!(skill_run_local_enabled_from(Some("1")));
        assert!(skill_run_local_enabled_from(Some(" 1 ")));
    }

    #[test]
    fn entrypoint_must_be_safe_relative() {
        assert!(safe_relative_entrypoint("./run.sh").is_err());
        assert!(safe_relative_entrypoint("../run.sh").is_err());
        assert!(safe_relative_entrypoint("/tmp/run.sh").is_err());
        assert_eq!(
            safe_relative_entrypoint("bin/run").unwrap(),
            PathBuf::from("bin/run")
        );
    }
}
