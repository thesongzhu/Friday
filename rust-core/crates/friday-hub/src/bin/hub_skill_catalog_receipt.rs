//! D21 governed skill-catalog receipt CLI.
//!
//! This is an operator-facing, verify-only bridge for staging a SKILL.md candidate
//! receipt. It never imports or executes a skill, and it never mints an approval:
//! the Hub loads only the operator-controlled public verify key and verifies the
//! supplied Ed25519 approval against the exact canonical action digest.

use std::env;
use std::io::Read;
use std::path::Path;

use friday_core::gate::{ApprovalDecision, CanonicalApproval, CANONICAL_GATE_ISSUER};
use friday_hub::operator_vk::load_operator_vk_from_path;
use friday_hub::skill_catalog::{
    record_skill_adoption_receipt_ed25519, stage_link_skill_candidate_receipt_ed25519,
    LinkSkillCandidateReceiptRequest, SkillAdoptionReceiptRequest, SkillCatalogError,
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
    match run() {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            let payload = json!({
                "truth_label": "d21_skill_catalog_receipt",
                "ok": false,
                "imports_skill": false,
                "executes_skill": false,
                "error_kind": err.kind,
            });
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_skill_catalog_receipt_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, CliError> {
    let args: Vec<String> = env::args().collect();
    let command = args.get(1).map(String::as_str).unwrap_or_default();
    if command != "stage-link-candidate" && command != "adopt-managed-skill" {
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
    if command == "adopt-managed-skill" {
        return adopt_managed_skill(&args, &db, approval, &operator_vk, now_ms);
    }
    let request = LinkSkillCandidateReceiptRequest {
        skill_id: arg_value(&args, "--skill-id").ok_or(CliError::new("bad_args"))?,
        safe_title: arg_value(&args, "--safe-title").ok_or(CliError::new("bad_args"))?,
        source_digest: arg_value(&args, "--source-digest").ok_or(CliError::new("bad_args"))?,
        evidence_url: arg_value(&args, "--evidence-url").ok_or(CliError::new("bad_args"))?,
        mission_id: arg_value(&args, "--mission-id").ok_or(CliError::new("bad_args"))?,
        work_item_id: arg_value(&args, "--work-item-id").ok_or(CliError::new("bad_args"))?,
        operator_principal_id: arg_value(&args, "--operator-principal-id")
            .unwrap_or_else(|| "operator".to_string()),
        canonical_approval: approval,
        proof_ref: arg_value(&args, "--proof-ref").ok_or(CliError::new("bad_args"))?,
        now_ms,
    };

    let receipt = stage_link_skill_candidate_receipt_ed25519(&db, request, &operator_vk)
        .map_err(|err| CliError::new(skill_error_kind(&err)))?;
    let payload = json!({
        "truth_label": "d21_skill_catalog_receipt",
        "ok": true,
        "imports_skill": false,
        "executes_skill": false,
        "skill_id": receipt.skill_id,
        "candidate_ref": receipt.candidate_ref,
        "proof_ref": receipt.proof_ref,
        "mission_id": receipt.mission_id,
        "work_item_id": receipt.work_item_id,
        "status": receipt.status,
    });
    let rendered =
        serde_json::to_string(&payload).map_err(|_| CliError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

fn adopt_managed_skill(
    args: &[String],
    db: &Db,
    approval: CanonicalApproval,
    operator_vk: &friday_crypto::OperatorVerifyingKey,
    now_ms: i64,
) -> Result<String, CliError> {
    let request = SkillAdoptionReceiptRequest {
        skill_id: arg_value(args, "--skill-id").ok_or(CliError::new("bad_args"))?,
        mission_id: arg_value(args, "--mission-id").ok_or(CliError::new("bad_args"))?,
        work_item_id: arg_value(args, "--work-item-id").ok_or(CliError::new("bad_args"))?,
        operator_principal_id: arg_value(args, "--operator-principal-id")
            .unwrap_or_else(|| "operator".to_string()),
        canonical_approval: approval,
        proof_ref: arg_value(args, "--proof-ref").ok_or(CliError::new("bad_args"))?,
        now_ms,
    };
    let receipt = record_skill_adoption_receipt_ed25519(db, request, operator_vk)
        .map_err(|err| CliError::new(skill_error_kind(&err)))?;
    let payload = json!({
        "truth_label": "d21_skill_adoption_receipt",
        "ok": true,
        "adopts_skill_for_mission": true,
        "imports_skill": false,
        "executes_skill": false,
        "completes_work_item": false,
        "skill_id": receipt.skill_id,
        "adoption_ref": receipt.adoption_ref,
        "proof_ref": receipt.proof_ref,
        "mission_id": receipt.mission_id,
        "work_item_id": receipt.work_item_id,
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

fn skill_error_kind(err: &SkillCatalogError) -> &'static str {
    match err {
        SkillCatalogError::RunBlocked(_) => "run_blocked",
        SkillCatalogError::Storage(_) => "storage_failed",
        SkillCatalogError::RootRead(_) => "root_read_failed",
        SkillCatalogError::ManifestRead(_) => "manifest_read_failed",
        SkillCatalogError::ManifestParse(_) => "manifest_parse_failed",
    }
}

fn reject_forbidden_output(rendered: &str) -> Result<(), CliError> {
    friday_hub::refs_guard::reject_forbidden_output(rendered, &["answer\":\""])
        .map_err(|_| CliError::new("output_guard"))
}
