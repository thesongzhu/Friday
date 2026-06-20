//! D21 governed local skill run CLI.
//!
//! Verifies an operator-signed approval with only the public key, then runs an
//! adopted managed-local shell skill through the Hub's bounded local runner. It
//! never adopts, installs, promotes, or marks a WorkItem complete.

use std::env;
use std::io::Read;
use std::path::Path;

use friday_core::gate::{ApprovalDecision, CanonicalApproval, CANONICAL_GATE_ISSUER};
use friday_hub::operator_vk::load_operator_vk_from_path;
use friday_hub::skill_executor::{
    run_local_skill_ed25519, skill_run_local_enabled_from, LocalSkillRunRequest,
    SkillExecutionError, FRIDAY_D21_SKILL_RUN_LOCAL,
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
                "truth_label": "d21_skill_run_local",
                "ok": false,
                "runs_skill": false,
                "installs_skill": false,
                "executes_skill": false,
                "completes_work_item": false,
                "error_kind": err.kind,
            });
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_skill_run_local_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, CliError> {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) != Some("run-local") {
        return Err(CliError::new("bad_args"));
    }
    let enabled =
        skill_run_local_enabled_from(env::var(FRIDAY_D21_SKILL_RUN_LOCAL).ok().as_deref());
    if !enabled {
        return Err(CliError::new("flag_off"));
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
    let timeout_ms = arg_value(&args, "--timeout-ms")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(30_000);
    let db = Db::open_hub(&db_path).map_err(|_| CliError::new("init_failed"))?;
    let adopted_skill_id = arg_values(&args, "--adopted-skill-id");
    let approved_first_run_skill_id = arg_values(&args, "--approved-first-run-skill-id");
    let receipt = run_local_skill_ed25519(
        &db,
        LocalSkillRunRequest {
            managed_skills_root: arg_value(&args, "--managed-skills-root")
                .ok_or(CliError::new("bad_args"))?,
            adopted_skill_ids: adopted_skill_id,
            approved_first_run_skill_ids: approved_first_run_skill_id,
            skill_id: arg_value(&args, "--skill-id").ok_or(CliError::new("bad_args"))?,
            mission_id: arg_value(&args, "--mission-id").ok_or(CliError::new("bad_args"))?,
            work_item_id: arg_value(&args, "--work-item-id").ok_or(CliError::new("bad_args"))?,
            operator_principal_id: arg_value(&args, "--operator-principal-id")
                .unwrap_or_else(|| "operator".to_string()),
            canonical_approval: approval,
            now_ms,
            require_darwin_sandbox: args.iter().any(|arg| arg == "--require-darwin-sandbox"),
            timeout_ms,
        },
        &operator_vk,
        true,
    )
    .map_err(|err| CliError::new(skill_error_kind(&err)))?;

    let payload = json!({
        "truth_label": "d21_skill_run_local",
        "ok": true,
        "runs_skill": true,
        "installs_skill": false,
        "executes_skill": true,
        "completes_work_item": false,
        "run_ref": receipt.run_ref,
        "proof_ref": receipt.proof_ref,
        "skill_ref": receipt.skill_ref,
        "skill_id": receipt.skill_id,
        "mission_id": receipt.mission_id,
        "work_item_id": receipt.work_item_id,
        "status": receipt.status,
        "sandbox_mode": receipt.sandbox_mode,
        "exit_code": receipt.exit_code,
        "timed_out": receipt.timed_out,
        "output_truncated": receipt.output_truncated,
        "output_sha256": receipt.output_sha256,
        "output_len": receipt.output_len,
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

fn arg_values(args: &[String], name: &str) -> Vec<String> {
    let mut values = Vec::new();
    let prefix = format!("{name}=");
    let mut i = 0;
    while i < args.len() {
        if args[i] == name {
            if let Some(value) = args.get(i + 1) {
                values.push(value.clone());
            }
            i += 2;
            continue;
        }
        if let Some(value) = args[i].strip_prefix(&prefix) {
            values.push(value.to_string());
        }
        i += 1;
    }
    values
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

fn skill_error_kind(err: &SkillExecutionError) -> &'static str {
    match err {
        SkillExecutionError::Blocked(_) => "run_blocked",
        SkillExecutionError::Io(_) => "io_failed",
        SkillExecutionError::ManifestParse(_) => "manifest_parse_failed",
        SkillExecutionError::Storage(_) => "storage_failed",
        SkillExecutionError::Catalog(_) => "catalog_failed",
        SkillExecutionError::Runner(_) => "runner_failed",
    }
}

fn reject_forbidden_output(rendered: &str) -> Result<(), CliError> {
    friday_hub::refs_guard::reject_forbidden_output(rendered, &["answer\":\"", "output\":\""])
        .map_err(|_| CliError::new("output_guard"))
}
