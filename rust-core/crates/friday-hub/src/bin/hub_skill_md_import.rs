//! D21 governed SKILL.md import CLI.
//!
//! Verifies an operator-signed approval and imports a local SKILL.md package as a
//! managed manifest candidate or promotes an imported candidate to a sandbox-required
//! local shell runtime. It never adopts, executes, or marks a WorkItem complete.

use std::env;
use std::io::Read;
use std::path::Path;

use friday_core::gate::{ApprovalDecision, CanonicalApproval, CANONICAL_GATE_ISSUER};
use friday_hub::operator_vk::load_operator_vk_from_path;
use friday_hub::skill_md_importer::{
    import_skill_md_candidate_ed25519, promote_imported_skill_md_candidate_ed25519,
    SkillMdImportError, SkillMdImportRequest, SkillMdPromoteRequest,
};
use friday_storage::Db;
use serde::Deserialize;
use serde_json::json;

struct CliError {
    kind: &'static str,
}

impl CliError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

#[derive(Debug, Deserialize)]
struct SignedApprovalIn {
    decision: String,
    approval_id: String,
    action_digest: String,
    expires_at: i64,
    #[serde(default)]
    issuer: Option<String>,
    signature: String,
}

fn main() {
    let command = env::args().nth(1).unwrap_or_default();
    match run() {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            let payload = json!({
                "truth_label": if command == "promote-imported-local" { "d21_skill_md_promote" } else { "d21_skill_md_import" },
                "ok": false,
                "imports_skill": false,
                "promotes_runtime": false,
                "installs_skill": false,
                "executes_skill": false,
                "error_kind": err.kind,
            });
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_skill_md_import_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, CliError> {
    let args: Vec<String> = env::args().collect();
    let command = args.get(1).map(String::as_str).unwrap_or_default();
    if command != "import-local" && command != "promote-imported-local" {
        return Err(CliError::new("bad_args"));
    }

    let db_path = arg_value(&args, "--db").ok_or(CliError::new("bad_args"))?;
    let vk_path = arg_value(&args, "--operator-vk-path")
        .or_else(|| env::var(friday_hub::operator_vk::OPERATOR_VK_PATH_ENV).ok())
        .filter(|p| !p.trim().is_empty())
        .ok_or(CliError::new("operator_vk_unprovisioned"))?;
    let operator_vk = load_operator_vk_from_path(Path::new(vk_path.trim()))
        .map_err(|_| CliError::new("operator_vk_malformed"))?;

    let approval = read_approval(&args)?;
    let now_ms = arg_value(&args, "--now-ms")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or_else(now_ms);
    let db = Db::open_hub(&db_path).map_err(|_| CliError::new("init_failed"))?;
    if command == "promote-imported-local" {
        return promote_imported_local(&args, &db, approval, &operator_vk, now_ms);
    }
    let receipt = import_skill_md_candidate_ed25519(
        &db,
        SkillMdImportRequest {
            source_dir: arg_value(&args, "--source-dir").ok_or(CliError::new("bad_args"))?,
            managed_skills_root: arg_value(&args, "--managed-skills-root")
                .ok_or(CliError::new("bad_args"))?,
            skill_id: arg_value(&args, "--skill-id").ok_or(CliError::new("bad_args"))?,
            source_digest: arg_value(&args, "--source-digest").ok_or(CliError::new("bad_args"))?,
            mission_id: arg_value(&args, "--mission-id").ok_or(CliError::new("bad_args"))?,
            work_item_id: arg_value(&args, "--work-item-id").ok_or(CliError::new("bad_args"))?,
            operator_principal_id: arg_value(&args, "--operator-principal-id")
                .unwrap_or_else(|| "operator".to_string()),
            canonical_approval: approval,
            proof_ref: arg_value(&args, "--proof-ref").ok_or(CliError::new("bad_args"))?,
            now_ms,
        },
        &operator_vk,
    )
    .map_err(|err| CliError::new(skill_error_kind(&err)))?;

    let payload = json!({
        "truth_label": "d21_skill_md_import",
        "ok": true,
        "imports_skill": true,
        "promotes_runtime": false,
        "installs_skill": false,
        "executes_skill": false,
        "import_ref": receipt.import_ref,
        "proof_ref": receipt.proof_ref,
        "skill_id": receipt.skill_id,
        "source_digest": receipt.source_digest,
        "file_count": receipt.file_count,
        "total_bytes": receipt.total_bytes,
        "mission_id": receipt.mission_id,
        "work_item_id": receipt.work_item_id,
        "status": receipt.status,
    });
    let rendered =
        serde_json::to_string(&payload).map_err(|_| CliError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

fn promote_imported_local(
    args: &[String],
    db: &Db,
    approval: CanonicalApproval,
    operator_vk: &friday_crypto::OperatorVerifyingKey,
    now_ms: i64,
) -> Result<String, CliError> {
    let receipt = promote_imported_skill_md_candidate_ed25519(
        db,
        SkillMdPromoteRequest {
            managed_skills_root: arg_value(args, "--managed-skills-root")
                .ok_or(CliError::new("bad_args"))?,
            skill_id: arg_value(args, "--skill-id").ok_or(CliError::new("bad_args"))?,
            entrypoint: arg_value(args, "--entrypoint").ok_or(CliError::new("bad_args"))?,
            mission_id: arg_value(args, "--mission-id").ok_or(CliError::new("bad_args"))?,
            work_item_id: arg_value(args, "--work-item-id").ok_or(CliError::new("bad_args"))?,
            operator_principal_id: arg_value(args, "--operator-principal-id")
                .unwrap_or_else(|| "operator".to_string()),
            canonical_approval: approval,
            proof_ref: arg_value(args, "--proof-ref").ok_or(CliError::new("bad_args"))?,
            now_ms,
        },
        operator_vk,
    )
    .map_err(|err| CliError::new(skill_error_kind(&err)))?;

    let payload = json!({
        "truth_label": "d21_skill_md_promote",
        "ok": true,
        "imports_skill": false,
        "promotes_runtime": true,
        "installs_skill": false,
        "executes_skill": false,
        "completes_work_item": false,
        "requires_darwin_sandbox": true,
        "promote_ref": receipt.promote_ref,
        "proof_ref": receipt.proof_ref,
        "skill_id": receipt.skill_id,
        "mission_id": receipt.mission_id,
        "work_item_id": receipt.work_item_id,
        "entrypoint": receipt.entrypoint,
        "status": receipt.status,
    });
    let rendered =
        serde_json::to_string(&payload).map_err(|_| CliError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

fn read_approval(args: &[String]) -> Result<CanonicalApproval, CliError> {
    let approval_json = match arg_value(args, "--approval-json") {
        Some(path) => std::fs::read_to_string(path).map_err(|_| CliError::new("bad_args"))?,
        None => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|_| CliError::new("bad_args"))?;
            buf
        }
    };
    let signed: SignedApprovalIn =
        serde_json::from_str(approval_json.trim()).map_err(|_| CliError::new("bad_approval"))?;
    Ok(CanonicalApproval {
        decision: parse_decision(&signed.decision).ok_or(CliError::new("bad_approval"))?,
        approval_id: signed.approval_id,
        action_digest: signed.action_digest,
        expires_at: Some(signed.expires_at),
        issuer: Some(
            signed
                .issuer
                .unwrap_or_else(|| CANONICAL_GATE_ISSUER.to_string()),
        ),
        signature: Some(signed.signature),
    })
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
        .or_else(|| {
            let prefix = format!("{name}=");
            args.iter()
                .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_string))
        })
}

fn parse_decision(value: &str) -> Option<ApprovalDecision> {
    match value {
        "approved" => Some(ApprovalDecision::Approved),
        "denied" => Some(ApprovalDecision::Denied),
        _ => None,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn skill_error_kind(err: &SkillMdImportError) -> &'static str {
    match err {
        SkillMdImportError::Blocked(_) => "run_blocked",
        SkillMdImportError::Io(_) => "io_failed",
        SkillMdImportError::Serialize(_) => "serialize_failed",
        SkillMdImportError::Storage(_) => "storage_failed",
    }
}

fn reject_forbidden_output(rendered: &str) -> Result<(), CliError> {
    friday_hub::refs_guard::reject_forbidden_output(rendered, &["answer\":\""])
        .map_err(|_| CliError::new("output_guard"))
}
