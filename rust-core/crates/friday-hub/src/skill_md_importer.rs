//! D21 governed SKILL.md import point.
//!
//! This DARK leg turns a reviewed local SKILL.md package into a managed manifest
//! candidate so the catalog can reason about it. Import is not adoption,
//! runnable eligibility, or execution. A separate operator-gated promotion can
//! arm the imported package as a sandbox-required local shell runtime; it still
//! does not adopt, run, or complete the skill.

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
use serde_json::json;
use sha2::{Digest, Sha256};

const MAX_FILES: usize = 64;
const MAX_TOTAL_BYTES: u64 = 512 * 1024;
const MAX_DEPTH: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum SkillMdImportError {
    #[error("skill md import blocked: {0}")]
    Blocked(String),
    #[error("skill md import io failed")]
    Io(#[from] std::io::Error),
    #[error("skill md import serialize failed")]
    Serialize(#[from] serde_json::Error),
    #[error("skill md import storage failed")]
    Storage(#[from] StorageError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillMdImportRequest {
    pub source_dir: String,
    pub managed_skills_root: String,
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
pub struct SkillMdImportReceipt {
    pub import_ref: String,
    pub proof_ref: String,
    pub skill_id: String,
    pub source_digest: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub mission_id: String,
    pub work_item_id: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillMdPromoteRequest {
    pub managed_skills_root: String,
    pub skill_id: String,
    pub entrypoint: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub operator_principal_id: String,
    pub canonical_approval: CanonicalApproval,
    pub proof_ref: String,
    pub now_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillMdPromoteReceipt {
    pub promote_ref: String,
    pub proof_ref: String,
    pub skill_id: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub entrypoint: String,
    pub status: String,
}

#[derive(Clone, Debug)]
struct CandidateFile {
    rel: PathBuf,
    bytes: Vec<u8>,
}

pub fn import_skill_md_candidate(
    db: &Db,
    request: SkillMdImportRequest,
    approval_secret: &[u8],
) -> Result<SkillMdImportReceipt, SkillMdImportError> {
    let files = validate_import_request(db, &request)?;
    let gate_request = skill_md_import_gate_request(
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
        return Err(SkillMdImportError::Blocked(format!(
            "skill_md_import_canonical_gate_{}",
            gate.reason
        )));
    }
    write_import(db, request, files)
}

pub fn import_skill_md_candidate_ed25519(
    db: &Db,
    request: SkillMdImportRequest,
    operator_vk: &OperatorVerifyingKey,
) -> Result<SkillMdImportReceipt, SkillMdImportError> {
    let files = validate_import_request(db, &request)?;
    let gate_request = skill_md_import_gate_request(
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
        return Err(SkillMdImportError::Blocked(format!(
            "skill_md_import_canonical_gate_{}",
            gate.reason
        )));
    }
    write_import(db, request, files)
}

pub fn skill_md_import_gate_request(
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
        friday_core::gate::classify(true, friday_core::Risk::High, "import_skill_md", &params),
        "import_skill_md".to_string(),
        Actor {
            kind: ActorKind::Owner,
            id: operator_principal_id.to_string(),
            principal_id: Some(operator_principal_id.to_string()),
        },
        "friday_hub_skill_md_importer".to_string(),
        Vec::new(),
        Some(format!(
            "skill_id={skill_id};source_digest={source_digest};mission_id={mission_id};work_item_id={work_item_id}"
        )),
        Some(format!(
            "skill-md-import:{skill_id}:{source_digest}:{mission_id}:{work_item_id}"
        )),
        None,
    )
}

pub fn promote_imported_skill_md_candidate_ed25519(
    db: &Db,
    request: SkillMdPromoteRequest,
    operator_vk: &OperatorVerifyingKey,
) -> Result<SkillMdPromoteReceipt, SkillMdImportError> {
    let promote = validate_promote_request(db, &request)?;
    let gate_request = skill_md_promote_gate_request(
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
        return Err(SkillMdImportError::Blocked(format!(
            "skill_md_promote_canonical_gate_{}",
            gate.reason
        )));
    }
    write_promote(db, request, promote)
}

pub fn skill_md_promote_gate_request(
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
        friday_core::gate::classify(
            true,
            friday_core::Risk::High,
            "promote_imported_skill_md",
            &params,
        ),
        "promote_imported_skill_md".to_string(),
        Actor {
            kind: ActorKind::Owner,
            id: operator_principal_id.to_string(),
            principal_id: Some(operator_principal_id.to_string()),
        },
        "friday_hub_skill_md_importer".to_string(),
        Vec::new(),
        Some(format!(
            "skill_id={skill_id};mission_id={mission_id};work_item_id={work_item_id}"
        )),
        Some(format!(
            "skill-md-promote:{skill_id}:{mission_id}:{work_item_id}"
        )),
        None,
    )
}

fn validate_import_request(
    db: &Db,
    request: &SkillMdImportRequest,
) -> Result<Vec<CandidateFile>, SkillMdImportError> {
    if !is_safe_id(&request.skill_id) || !is_safe_id(&request.source_digest) {
        return Err(SkillMdImportError::Blocked(
            "safe_public_metadata_required".into(),
        ));
    }
    if !request.proof_ref.starts_with("proof://") {
        return Err(SkillMdImportError::Blocked("proof_ref_required".into()));
    }
    let mission = db
        .get_mission(&request.mission_id)?
        .ok_or_else(|| SkillMdImportError::Blocked("unknown_mission".into()))?;
    if mission.status.is_terminal() {
        return Err(SkillMdImportError::Blocked("mission_is_terminal".into()));
    }
    let work_item = db
        .get_work_item(&request.work_item_id)?
        .ok_or_else(|| SkillMdImportError::Blocked("unknown_work_item".into()))?;
    if work_item.mission_id != request.mission_id {
        return Err(SkillMdImportError::Blocked(
            "work_item_mission_mismatch".into(),
        ));
    }
    if work_item.status.is_terminal() {
        return Err(SkillMdImportError::Blocked("work_item_is_terminal".into()));
    }

    let source = fs::canonicalize(&request.source_dir)?;
    let root = fs::canonicalize(&request.managed_skills_root).or_else(|_| {
        fs::create_dir_all(&request.managed_skills_root)?;
        fs::canonicalize(&request.managed_skills_root)
    })?;
    if source.starts_with(&root) {
        return Err(SkillMdImportError::Blocked(
            "source_inside_managed_root".into(),
        ));
    }
    if root.starts_with(&source) {
        return Err(SkillMdImportError::Blocked(
            "managed_root_inside_source".into(),
        ));
    }
    let destination = root.join(&request.skill_id);
    if destination.exists() {
        return Err(SkillMdImportError::Blocked(
            "destination_already_exists".into(),
        ));
    }

    let files = collect_files(&source)?;
    if !files.iter().any(|file| file.rel == Path::new("SKILL.md")) {
        return Err(SkillMdImportError::Blocked("skill_md_required".into()));
    }
    let digest = candidate_digest(&files);
    if digest != request.source_digest {
        return Err(SkillMdImportError::Blocked("source_digest_mismatch".into()));
    }
    Ok(files)
}

struct PromoteTarget {
    skill_dir: PathBuf,
    manifest_path: PathBuf,
    manifest: serde_json::Value,
    entrypoint: PathBuf,
}

fn validate_promote_request(
    db: &Db,
    request: &SkillMdPromoteRequest,
) -> Result<PromoteTarget, SkillMdImportError> {
    if !is_safe_id(&request.skill_id) {
        return Err(SkillMdImportError::Blocked("safe_skill_id_required".into()));
    }
    if !request.proof_ref.starts_with("proof://") {
        return Err(SkillMdImportError::Blocked("proof_ref_required".into()));
    }
    validate_mission_work_item(db, &request.mission_id, &request.work_item_id)?;

    let root = fs::canonicalize(&request.managed_skills_root)?;
    let skill_dir = fs::canonicalize(root.join(&request.skill_id))?;
    if !skill_dir.starts_with(&root) {
        return Err(SkillMdImportError::Blocked("skill_dir_outside_root".into()));
    }
    if !skill_dir.join("SKILL.md").is_file() {
        return Err(SkillMdImportError::Blocked("skill_md_required".into()));
    }
    let manifest_path = skill_dir.join("skill.manifest.json");
    let manifest_raw = fs::read_to_string(&manifest_path)?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_raw)?;
    let runtime_kind = manifest
        .get("runtime")
        .and_then(|runtime| runtime.get("kind"))
        .and_then(|kind| kind.as_str())
        .unwrap_or("");
    if runtime_kind != "skill-md-imported" {
        return Err(SkillMdImportError::Blocked(
            "imported_runtime_required".into(),
        ));
    }

    let entrypoint = safe_relative_entrypoint(&request.entrypoint)?;
    if !skill_dir.join(&entrypoint).is_file() {
        return Err(SkillMdImportError::Blocked(
            "skill_entrypoint_required".into(),
        ));
    }
    Ok(PromoteTarget {
        skill_dir,
        manifest_path,
        manifest,
        entrypoint,
    })
}

fn validate_mission_work_item(
    db: &Db,
    mission_id: &str,
    work_item_id: &str,
) -> Result<(), SkillMdImportError> {
    let mission = db
        .get_mission(mission_id)?
        .ok_or_else(|| SkillMdImportError::Blocked("unknown_mission".into()))?;
    if mission.status.is_terminal() {
        return Err(SkillMdImportError::Blocked("mission_is_terminal".into()));
    }
    let work_item = db
        .get_work_item(work_item_id)?
        .ok_or_else(|| SkillMdImportError::Blocked("unknown_work_item".into()))?;
    if work_item.mission_id != mission_id {
        return Err(SkillMdImportError::Blocked(
            "work_item_mission_mismatch".into(),
        ));
    }
    if work_item.status.is_terminal() {
        return Err(SkillMdImportError::Blocked("work_item_is_terminal".into()));
    }
    Ok(())
}

fn write_import(
    db: &Db,
    request: SkillMdImportRequest,
    files: Vec<CandidateFile>,
) -> Result<SkillMdImportReceipt, SkillMdImportError> {
    let import_ref = redacted_ref(
        "skill-md-import",
        &format!(
            "{}:{}:{}:{}",
            request.skill_id, request.source_digest, request.mission_id, request.work_item_id
        ),
    );
    let skill_dir = Path::new(&request.managed_skills_root).join(&request.skill_id);
    fs::create_dir_all(&skill_dir)?;
    for file in &files {
        let target = skill_dir.join(&file.rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(target, &file.bytes)?;
    }
    let title = files
        .iter()
        .find(|file| file.rel == Path::new("SKILL.md"))
        .and_then(|file| std::str::from_utf8(&file.bytes).ok())
        .map(skill_md_title)
        .filter(|title| is_safe_public_text(title))
        .unwrap_or_else(|| request.skill_id.clone());
    let manifest = json!({
        "id": request.skill_id,
        "name": title,
        "runtime": {
            "kind": "skill-md-imported"
        },
        "triggers": {
            "intents": [],
            "phrases": []
        },
        "invocation": {
            "priority": 0
        },
        "permissions": {
            "grants": [],
            "promptOn": ["operator.adopt_skill", "sandboxed_executor_required"]
        },
        "executionTargets": {
            "requiredCapabilities": ["skill.import.review"]
        }
    });
    fs::write(
        skill_dir.join("skill.manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;

    db.upsert_mission_link(&MissionLink {
        link_id: import_ref.clone(),
        mission_id: request.mission_id.clone(),
        work_item_id: Some(request.work_item_id.clone()),
        link_kind: MissionLinkKind::ProofReceipt,
        target_ref: import_ref.clone(),
        proof_ref: Some(request.proof_ref.clone()),
        created_at_ms: request.now_ms,
    })?;

    let total_bytes = files
        .iter()
        .map(|file| file.bytes.len() as u64)
        .sum::<u64>();
    Ok(SkillMdImportReceipt {
        import_ref,
        proof_ref: request.proof_ref,
        skill_id: request.skill_id,
        source_digest: request.source_digest,
        file_count: files.len(),
        total_bytes,
        mission_id: request.mission_id,
        work_item_id: request.work_item_id,
        status: "imported_manifest_candidate_not_executable".to_string(),
    })
}

fn write_promote(
    db: &Db,
    request: SkillMdPromoteRequest,
    mut promote: PromoteTarget,
) -> Result<SkillMdPromoteReceipt, SkillMdImportError> {
    let promote_ref = redacted_ref(
        "skill-md-promote",
        &format!(
            "{}:{}:{}:{}",
            request.skill_id, request.mission_id, request.work_item_id, request.now_ms
        ),
    );
    let runtime = json!({
        "kind": "shell",
        "entrypoint": promote.entrypoint.to_string_lossy(),
        "requiresDarwinSandbox": true
    });
    promote.manifest["runtime"] = runtime;
    promote.manifest["permissions"] = json!({
        "grants": [],
        "promptOn": ["operator.adopt_skill", "operator.run_skill", "darwin_sandbox_required"]
    });
    promote.manifest["executionTargets"] = json!({
        "requiredCapabilities": ["skill.import.review", "skill.run.local.darwin_sandbox"]
    });
    fs::write(
        &promote.manifest_path,
        serde_json::to_vec_pretty(&promote.manifest)?,
    )?;
    mark_entrypoint_executable(&promote.skill_dir.join(&promote.entrypoint))?;

    db.upsert_mission_link(&MissionLink {
        link_id: promote_ref.clone(),
        mission_id: request.mission_id.clone(),
        work_item_id: Some(request.work_item_id.clone()),
        link_kind: MissionLinkKind::ProofReceipt,
        target_ref: format!("friday://skill-md-promote/{}", request.skill_id),
        proof_ref: Some(request.proof_ref.clone()),
        created_at_ms: request.now_ms,
    })?;

    Ok(SkillMdPromoteReceipt {
        promote_ref,
        proof_ref: request.proof_ref,
        skill_id: request.skill_id,
        mission_id: request.mission_id,
        work_item_id: request.work_item_id,
        entrypoint: request.entrypoint,
        status: "imported_manifest_promoted_to_sandbox_required_shell_not_executed".to_string(),
    })
}

#[cfg(unix)]
fn mark_entrypoint_executable(path: &Path) -> Result<(), SkillMdImportError> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn mark_entrypoint_executable(_path: &Path) -> Result<(), SkillMdImportError> {
    Ok(())
}

fn collect_files(source: &Path) -> Result<Vec<CandidateFile>, SkillMdImportError> {
    let mut out = Vec::new();
    collect_files_inner(source, source, &mut out)?;
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    let total = out.iter().map(|f| f.bytes.len() as u64).sum::<u64>();
    if out.len() > MAX_FILES || total > MAX_TOTAL_BYTES {
        return Err(SkillMdImportError::Blocked("candidate_size_limit".into()));
    }
    Ok(out)
}

fn collect_files_inner(
    root: &Path,
    dir: &Path,
    out: &mut Vec<CandidateFile>,
) -> Result<(), SkillMdImportError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            return Err(SkillMdImportError::Blocked("symlink_rejected".into()));
        }
        let path = entry.path();
        if ty.is_dir() {
            collect_files_inner(root, &path, out)?;
            continue;
        }
        if !ty.is_file() {
            return Err(SkillMdImportError::Blocked("special_file_rejected".into()));
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| SkillMdImportError::Blocked("path_escape".into()))?;
        validate_relative_path(rel)?;
        out.push(CandidateFile {
            rel: rel.to_path_buf(),
            bytes: fs::read(&path)?,
        });
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<(), SkillMdImportError> {
    let depth = path.components().count();
    if depth == 0 || depth > MAX_DEPTH {
        return Err(SkillMdImportError::Blocked("path_depth_limit".into()));
    }
    for component in path.components() {
        match component {
            Component::Normal(part) if is_safe_path_part(&part.to_string_lossy()) => {}
            _ => return Err(SkillMdImportError::Blocked("unsafe_path".into())),
        }
    }
    Ok(())
}

fn safe_relative_entrypoint(value: &str) -> Result<PathBuf, SkillMdImportError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 160
        || value.contains('\\')
        || value.contains('"')
        || value.contains('\'')
        || value.chars().any(char::is_whitespace)
    {
        return Err(SkillMdImportError::Blocked(
            "skill_entrypoint_safe_relative_required".into(),
        ));
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Err(SkillMdImportError::Blocked(
            "skill_entrypoint_safe_relative_required".into(),
        ));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(SkillMdImportError::Blocked(
                    "skill_entrypoint_safe_relative_required".into(),
                ));
            }
        }
    }
    Ok(path)
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

fn skill_md_title(markdown: &str) -> String {
    let fields = parse_skill_md_frontmatter(markdown);
    fields
        .get("title")
        .or_else(|| fields.get("name"))
        .cloned()
        .unwrap_or_default()
}

fn parse_skill_md_frontmatter(markdown: &str) -> BTreeMap<String, String> {
    let normalized = markdown.replace("\r\n", "\n");
    let Some(after_open) = normalized.strip_prefix("---\n") else {
        return BTreeMap::new();
    };
    let Some(end) = after_open.find("\n---") else {
        return BTreeMap::new();
    };
    let yaml_block = &after_open[..end];
    let mut fields = BTreeMap::new();
    for line in yaml_block.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if !is_safe_id(key) {
            continue;
        }
        let value = value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string();
        if !value.is_empty() && is_safe_public_text(&value) {
            fields.insert(key.to_string(), value);
        }
    }
    fields
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

fn is_safe_public_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && !value.contains("/Users/")
        && !value.to_ascii_lowercase().contains("secret")
        && !value.contains('\n')
        && !value.contains('\r')
}
