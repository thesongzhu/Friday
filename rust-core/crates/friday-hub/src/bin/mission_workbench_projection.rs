//! `mission_workbench_projection` — the one-shot Mission Workbench projection CLI bin.
//!
//! **S-R1 thin-wrapper.** The projection LOGIC now lives in the shared library fn
//! [`friday_hub::workbench_projection::project_workbench`] so this CLI bin AND the DARK sealed-WS
//! read-projection server (`bin/hub_read_projection_server.rs`) call ONE implementation — no
//! duplication, no drift. This bin keeps its exact CLI contract: `--db` (required) + optional
//! `--mission-id`, opens the hub DB READ-ONLY, calls the library fn, and pretty-prints the
//! refs-only snapshot to stdout. The forbidden-output guard runs INSIDE the library fn.

use friday_storage::Db;
use std::env;
use std::path::Path;

fn main() {
    if let Err(err) = run() {
        eprintln!("mission_workbench_projection_unavailable: {err}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    let db_path = arg_value(&args, "--db").ok_or("--db is required")?;
    if !Path::new(&db_path).is_file() {
        return Err("rust hub db not found".to_string());
    }
    let requested_mission_id = arg_value(&args, "--mission-id");
    let db = Db::open_hub_readonly(&db_path).map_err(|err| err.to_string())?;
    let snapshot =
        friday_hub::workbench_projection::project_workbench(&db, requested_mission_id.as_deref())?;
    let rendered = serde_json::to_string_pretty(&snapshot).map_err(|err| err.to_string())?;
    println!("{rendered}");
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionLink,
        MissionLinkKind, MissionStatus, RouteDecisionCard, SurfaceEvent, SurfaceEventKind,
        SurfaceKind, SurfaceThread, TruthStatus, VisibilityPolicy, WorkItem, WorkItemStatus,
        WorkLane,
    };

    #[test]
    #[ignore = "writes an isolated probe DB only when FRIDAY_MISSION_WORKBENCH_PROBE_DB is set"]
    fn write_mission_workbench_probe_db() {
        let path = env::var("FRIDAY_MISSION_WORKBENCH_PROBE_DB")
            .expect("FRIDAY_MISSION_WORKBENCH_PROBE_DB required");
        let db = Db::open_hub(&path).unwrap();
        let now = 1_780_640_000_000;
        let conversation_id = "fconv_mission_workbench_probe";
        let mission_id = "mission_workbench_probe_20260605";
        let work_provider = "work_probe_provider";
        let work_done = "work_probe_done";

        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: conversation_id.into(),
            owner_principal: "owner_probe".into(),
            title: "Mission Workbench probe".into(),
            current_focus_summary: "same Mission state across probe surfaces".into(),
            active_mission_ids: vec![mission_id.into()],
            surface_thread_ids: vec![
                "surface_probe_mobile".into(),
                "surface_probe_desktop".into(),
                "surface_probe_telegram".into(),
            ],
            memory_scope_ref: None,
            truth_status: TruthStatus::Proven,
            proof_refs: vec!["proof://mission/workbench-probe".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: mission_id.into(),
            friday_conversation_id: conversation_id.into(),
            title: "Prove Mission Workbench projection".into(),
            intent: "show live Rust Hub Workbench route projection".into(),
            status: MissionStatus::Active,
            why_now: "route readiness must be proven before UI capture".into(),
            decision_path_summary: "Rust Hub owns the Mission projection; UI consumes it.".into(),
            considered_options: vec!["route missing".into(), "live Rust projection".into()],
            deferred_options: vec!["final UI/device evidence".into()],
            known_pitfalls: vec!["provider ack is not completion".into()],
            handoff_inheritance: vec!["keep proof refs redacted".into()],
            work_item_ids: vec![work_provider.into(), work_done.into()],
            memory_candidate_refs: vec!["memory://candidate/workbench-probe".into()],
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://mission/workbench-probe".into()],
            created_at_ms: now,
            updated_at_ms: now + 10,
        })
        .unwrap();

        for (id, surface, visibility, ts) in [
            (
                "surface_probe_mobile",
                SurfaceKind::Mobile,
                VisibilityPolicy::Compact,
                now + 1,
            ),
            (
                "surface_probe_desktop",
                SurfaceKind::Desktop,
                VisibilityPolicy::RichProof,
                now + 2,
            ),
            (
                "surface_probe_telegram",
                SurfaceKind::Telegram,
                VisibilityPolicy::StatusOnly,
                now + 3,
            ),
        ] {
            db.upsert_surface_thread(&SurfaceThread {
                surface_thread_id: id.into(),
                friday_conversation_id: conversation_id.into(),
                mission_id: Some(mission_id.into()),
                surface_kind: surface,
                channel_binding_id: None,
                delivery_route: format!("route_{id}"),
                visibility_policy: visibility,
                allowed_actions: vec!["open".into()],
                last_seen_at_ms: Some(ts),
                last_delivered_event_seq: None,
                created_at_ms: ts,
                updated_at_ms: ts,
            })
            .unwrap();
        }

        let provider_item = WorkItem {
            work_item_id: work_provider.into(),
            mission_id: mission_id.into(),
            lane: WorkLane::DeepSeek,
            target_provider_or_agent: Some("deepseek".into()),
            status: WorkItemStatus::ProviderWaiting,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("skill.mission-advisor".into()),
            risk_level: friday_core::Risk::Low,
            approval_state: ApprovalState::Required,
            blocking_reason: Some("provider receipt pending".into()),
            input_refs: vec!["body://redacted/provider-request".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["provider proof receipt before completion".into()],
            proof_receipts: Vec::new(),
            judgment_memory: judgment("Mission-bound provider action", "deepseek"),
            created_at_ms: now + 4,
            updated_at_ms: now + 5,
        };
        db.upsert_work_item(&provider_item).unwrap();
        let done_item = WorkItem {
            work_item_id: work_done.into(),
            mission_id: mission_id.into(),
            lane: WorkLane::FridayHub,
            target_provider_or_agent: None,
            status: WorkItemStatus::CompletedWithProof,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("capability.proof-workbench".into()),
            risk_level: friday_core::Risk::ReadOnly,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["body://redacted/proof-read".into()],
            output_refs: vec!["proof://provider/receipt/redacted-probe".into()],
            proof_requirements: vec!["verified proof receipt".into()],
            proof_receipts: vec!["proof://provider/receipt/redacted-probe".into()],
            judgment_memory: judgment("Completed only after proof receipt", "friday_hub"),
            created_at_ms: now + 6,
            updated_at_ms: now + 7,
        };
        db.upsert_work_item(&done_item).unwrap();

        db.upsert_route_decision(&RouteDecisionCard::from_work_item(
            "route_probe_provider".into(),
            &provider_item,
            vec!["trace://redacted/provider-route".into()],
            now + 8,
            None,
        ))
        .unwrap();

        for link in [
            MissionLink {
                link_id: "link_probe_provider_session".into(),
                mission_id: mission_id.into(),
                work_item_id: Some(work_provider.into()),
                link_kind: MissionLinkKind::ProviderSession,
                target_ref: "provider://redacted/session".into(),
                proof_ref: Some("proof://provider/ack/redacted-probe".into()),
                created_at_ms: now + 9,
            },
            MissionLink {
                link_id: "link_probe_channel".into(),
                mission_id: mission_id.into(),
                work_item_id: Some(work_provider.into()),
                link_kind: MissionLinkKind::ChannelInbound,
                target_ref: "channel://redacted/inbound".into(),
                proof_ref: Some("proof://channel/receipt/redacted-probe".into()),
                created_at_ms: now + 10,
            },
            MissionLink {
                link_id: "link_probe_workflow".into(),
                mission_id: mission_id.into(),
                work_item_id: Some(work_provider.into()),
                link_kind: MissionLinkKind::WorkflowRun,
                target_ref: "workflow://redacted/probe".into(),
                proof_ref: Some("proof://workflow/redacted-probe".into()),
                created_at_ms: now + 11,
            },
            MissionLink {
                link_id: "link_probe_memory_candidate".into(),
                mission_id: mission_id.into(),
                work_item_id: None,
                link_kind: MissionLinkKind::MemoryCandidate,
                target_ref: "memory://candidate/redacted-probe".into(),
                proof_ref: Some("proof://memory/candidate-review-only".into()),
                created_at_ms: now + 12,
            },
            MissionLink {
                link_id: "link_probe_proof_receipt".into(),
                mission_id: mission_id.into(),
                work_item_id: Some(work_done.into()),
                link_kind: MissionLinkKind::ProofReceipt,
                target_ref: "proof://provider/receipt/redacted-probe".into(),
                proof_ref: Some("proof://provider/receipt/redacted-probe".into()),
                created_at_ms: now + 13,
            },
        ] {
            db.upsert_mission_link(&link).unwrap();
        }

        for (id, work, surface, kind, proof, ts) in [
            (
                "surface_event_probe_mobile",
                Some(work_provider),
                SurfaceKind::Mobile,
                SurfaceEventKind::UserMessage,
                Some("proof://surface/mobile/redacted-probe"),
                now + 14,
            ),
            (
                "surface_event_probe_desktop",
                Some(work_done),
                SurfaceKind::Desktop,
                SurfaceEventKind::ProofReceipt,
                Some("proof://provider/receipt/redacted-probe"),
                now + 15,
            ),
            (
                "surface_event_probe_telegram",
                Some(work_provider),
                SurfaceKind::Telegram,
                SurfaceEventKind::ChannelInbound,
                Some("proof://channel/receipt/redacted-probe"),
                now + 16,
            ),
        ] {
            db.upsert_surface_event(&SurfaceEvent {
                surface_event_id: id.into(),
                friday_conversation_id: conversation_id.into(),
                mission_id: mission_id.into(),
                work_item_id: work.map(str::to_string),
                surface_thread_id: format!("surface_probe_{}", surface.as_str()),
                source_surface: surface,
                event_kind: kind,
                body_ref: Some(format!("friday://body/{id}")),
                visibility_policy: VisibilityPolicy::RichProof,
                proof_ref: proof.map(str::to_string),
                created_at_ms: ts,
            })
            .unwrap();
        }
    }

    fn judgment(task: &str, target: &str) -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: task.into(),
            current_blocker: None,
            target_lane_thread_agent_provider: target.into(),
            read_first_files: vec!["rust-core/crates/friday-hub/src/hub_server.rs".into()],
            required_output: "redacted Mission Workbench projection".into(),
            done_criteria: vec!["proof receipt required before done".into()],
            red_lines: vec!["do not leak raw transcripts or ids".into()],
            why_this_route: "The Workbench must consume Rust Hub Mission truth.".into(),
            considered_options: vec!["missing route".into(), "Rust Hub projection".into()],
            deferred_options: vec!["final UI/device capture".into()],
            previous_pitfalls: vec!["provider ack looked like done".into()],
            inheritable_context: vec!["carry proof refs, not raw transcript".into()],
            proof_requirements: vec!["redacted route projection".into()],
            ownership_claim_ids: Vec::new(),
        }
    }
}
