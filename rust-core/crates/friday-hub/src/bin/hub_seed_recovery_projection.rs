//! Seed a controlled recovery Workbench scenario for real desktop Accessibility proof.
//!
//! This proof driver writes a new Mission + one `FailedRetryable` WorkItem through typed storage
//! APIs. It does not touch existing user/organic missions, does not dispatch a provider, and does
//! not claim adoption or END-BAR. The seeded row exists only so the desktop recovery surface can
//! prove its retry/cancel affordances against real Rust Hub projection data.

use std::env;
use std::path::Path;

use friday_core::{
    ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus,
    RouteDecisionCard, TruthStatus, WorkItem, WorkItemStatus, WorkLane,
};
use friday_storage::{Db, StorageError};
use serde_json::json;

const ACK: &str = "operator-approved-controlled-recovery-projection";

fn main() {
    match run() {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            let payload = json!({
                "truth_label": "hub_seed_recovery_projection_controlled_not_organic",
                "ok": false,
                "error_kind": err,
            });
            println!("{}", payload);
            eprintln!("hub_seed_recovery_projection_unavailable: {err}");
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, &'static str> {
    let args: Vec<String> = env::args().collect();
    let db_path = arg_value(&args, "--db").ok_or("bad_args")?;
    let mission_id = arg_value(&args, "--mission-id").ok_or("bad_args")?;
    let ack = arg_value(&args, "--ack")
        .or_else(|| env::var("FRIDAY_SEED_RECOVERY_PROJECTION_ACK").ok())
        .ok_or("ack_required")?;
    if ack != ACK {
        return Err("ack_mismatch");
    }
    if !Path::new(&db_path).is_file() {
        return Err("db_not_found");
    }

    seed_recovery_projection(&db_path, &mission_id, now_ms())
}

fn seed_recovery_projection(
    db_path: &str,
    mission_id: &str,
    now_ms: i64,
) -> Result<String, &'static str> {
    if !mission_id.starts_with("mission_desktop_recovery_") {
        return Err("mission_id_not_controlled_recovery");
    }
    let db = Db::open_hub(db_path).map_err(map_open_error)?;
    let conversation_id = format!("fconv_{mission_id}");
    let work_item_id = format!("work_{mission_id}");
    let route_id = format!("route_{mission_id}");

    db.upsert_friday_conversation(&FridayConversation {
        friday_conversation_id: conversation_id.clone(),
        owner_principal: "admin-001".into(),
        title: "Desktop recovery projection proof".into(),
        current_focus_summary:
            "controlled refs-only recovery scenario for desktop Accessibility proof".into(),
        active_mission_ids: vec![mission_id.into()],
        surface_thread_ids: Vec::new(),
        memory_scope_ref: None,
        truth_status: TruthStatus::Proven,
        proof_refs: vec!["proof://desktop/recovery/projection-controlled".into()],
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    })
    .map_err(|_| "conversation_write_failed")?;

    db.upsert_mission(&Mission {
        mission_id: mission_id.into(),
        friday_conversation_id: conversation_id,
        title: "Prove desktop recovery queue".into(),
        intent: "show retry/cancel affordances only when Rust Hub projects a retryable WorkItem"
            .into(),
        status: MissionStatus::Active,
        why_now: "desktop AX runtime coverage needs a real recoverable WorkItem".into(),
        decision_path_summary:
            "controlled proof mission; not organic traffic and not provider execution".into(),
        considered_options: vec![
            "fake UI button".into(),
            "controlled typed Rust Hub WorkItem projection".into(),
        ],
        deferred_options: vec!["organic recovery occurrence".into()],
        known_pitfalls: vec!["do not count this as organic or adoption".into()],
        handoff_inheritance: vec!["refs-only recovery proof".into()],
        work_item_ids: vec![work_item_id.clone()],
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: vec!["proof://desktop/recovery/projection-controlled".into()],
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    })
    .map_err(|_| "mission_write_failed")?;

    let work_item = WorkItem {
        work_item_id: work_item_id.clone(),
        mission_id: mission_id.into(),
        lane: WorkLane::DeepSeek,
        target_provider_or_agent: Some("deepseek".into()),
        status: WorkItemStatus::FailedRetryable,
        owner_claim_ids: Vec::new(),
        workspace_refs: Vec::new(),
        capability_id: Some("desktop.recovery.proof".into()),
        risk_level: friday_core::Risk::Low,
        approval_state: ApprovalState::NotRequired,
        blocking_reason: Some(
            "controlled retryable proof row; no provider dispatch occurred".into(),
        ),
        input_refs: vec!["body://redacted/desktop-recovery-proof".into()],
        output_refs: Vec::new(),
        proof_requirements: vec!["desktop recovery retry/cancel visible in real AX tree".into()],
        proof_receipts: Vec::new(),
        judgment_memory: judgment(),
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    };
    db.upsert_work_item(&work_item)
        .map_err(|_| "work_item_write_failed")?;
    db.upsert_route_decision(&RouteDecisionCard::from_work_item(
        route_id,
        &work_item,
        vec!["trace://redacted/desktop-recovery-proof".into()],
        now_ms,
        None,
    ))
    .map_err(|_| "route_decision_write_failed")?;

    let snapshot = friday_hub::workbench_projection::project_workbench(&db, Some(mission_id))
        .map_err(|_| "project_failed")?;
    let work_items = snapshot
        .get("workItems")
        .and_then(|rows| rows.as_array())
        .ok_or("projection_missing_work_items")?;
    let retry_visible = work_items.iter().any(|row| {
        row.get("id").and_then(|id| id.as_str()) == Some(work_item_id.as_str())
            && row.get("canRetry").and_then(|value| value.as_bool()) == Some(true)
    });
    let cancel_visible = work_items.iter().any(|row| {
        row.get("id").and_then(|id| id.as_str()) == Some(work_item_id.as_str())
            && row.get("canCancel").and_then(|value| value.as_bool()) == Some(true)
    });

    let payload = json!({
        "truth_label": "hub_seed_recovery_projection_controlled_not_organic",
        "ok": retry_visible && cancel_visible,
        "mission_id": mission_id,
        "work_item_id": work_item_id,
        "status": "failed_retryable",
        "retry_visible": retry_visible,
        "cancel_visible": cancel_visible,
        "organic": false,
        "provider_dispatched": false,
        "endbar": false,
    });
    serde_json::to_string_pretty(&payload).map_err(|_| "serialize_failed")
}

fn judgment() -> HandoffJudgmentMemory {
    HandoffJudgmentMemory {
        task: "Desktop recovery retry/cancel projection".into(),
        current_blocker: Some("controlled retryable row for AX proof".into()),
        target_lane_thread_agent_provider: "deepseek".into(),
        read_first_files: vec![
            "rust-core/crates/friday-hub/src/workbench_projection.rs".into(),
            "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopProjectionScreens.swift"
                .into(),
        ],
        required_output: "real desktop AX tree shows retry and cancel affordances".into(),
        done_criteria: vec!["retry available".into(), "cancel available".into()],
        red_lines: vec![
            "do not count as organic".into(),
            "do not dispatch provider".into(),
            "do not claim END-BAR".into(),
        ],
        why_this_route:
            "Recovery UI must be proven against Rust-owned WorkItem lifecycle projection.".into(),
        considered_options: vec!["fake UI target".into(), "typed projection proof row".into()],
        deferred_options: vec!["organic recovery occurrence".into()],
        previous_pitfalls: vec!["empty recovery queue looked like missing UI".into()],
        inheritable_context: vec!["controlled proof only".into()],
        proof_requirements: vec!["desktop Accessibility capture".into()],
        ownership_claim_ids: Vec::new(),
    }
}

fn map_open_error(err: StorageError) -> &'static str {
    match err {
        StorageError::SchemaTooNew { .. } => "schema_too_new",
        _ => "open_failed",
    }
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_non_controlled_mission_id() {
        let path = tmp_db();
        let db = Db::open_hub(&path).unwrap();
        drop(db);

        let err = seed_recovery_projection(&path, "codex-organic-mission-real", 10).unwrap_err();
        assert_eq!(err, "mission_id_not_controlled_recovery");
    }

    #[test]
    fn seeds_retryable_projection_without_provider_dispatch_or_organic_claim() {
        let path = tmp_db();
        let db = Db::open_hub(&path).unwrap();
        drop(db);

        let rendered =
            seed_recovery_projection(&path, "mission_desktop_recovery_contract", 10).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&rendered).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["retry_visible"], true);
        assert_eq!(parsed["cancel_visible"], true);
        assert_eq!(parsed["organic"], false);
        assert_eq!(parsed["provider_dispatched"], false);
        assert_eq!(parsed["endbar"], false);
    }

    fn tmp_db() -> String {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "friday-seed-recovery-projection-{}-{}.sqlite",
            std::process::id(),
            now_ms()
        ));
        path.to_string_lossy().to_string()
    }
}
