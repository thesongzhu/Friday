//! Attach an existing pending memory candidate to a Mission for refs-only Workbench proof.
//!
//! This is an ops/proof driver. It does not create a memory item, does not read or print
//! candidate content, and does not confirm/reject/grant memory authority. The only write is the
//! existing governed [`friday_hub::mission_preflight::attach_memory_candidate_ref`] path.

use std::env;
use std::path::Path;

use friday_hub::mission_preflight::{attach_memory_candidate_ref, MissionAttachmentOutcome};
use friday_hub::workbench_projection::project_workbench;
use friday_storage::{Db, StorageError};
use serde_json::{json, Value};

const ACK: &str = "operator-approved-existing-candidate-mission-attach";

fn main() {
    match run() {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            let payload = json!({
                "truth_label": "hub_attach_memory_candidate_refs_only",
                "ok": false,
                "error_kind": err,
            });
            println!("{}", payload);
            eprintln!("hub_attach_memory_candidate_unavailable: {err}");
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, &'static str> {
    let args: Vec<String> = env::args().collect();
    let db_path = arg_value(&args, "--db").ok_or("bad_args")?;
    let mission_id = arg_value(&args, "--mission-id").ok_or("bad_args")?;
    let memory_id = arg_value(&args, "--memory-id").ok_or("bad_args")?;
    let ack = arg_value(&args, "--ack")
        .or_else(|| env::var("FRIDAY_ATTACH_MEMORY_CANDIDATE_ACK").ok())
        .ok_or("ack_required")?;
    if ack != ACK {
        return Err("ack_mismatch");
    }
    if !Path::new(&db_path).is_file() {
        return Err("db_not_found");
    }

    render_attach(&db_path, &mission_id, &memory_id, now_ms())
}

fn render_attach(
    db_path: &str,
    mission_id: &str,
    memory_id: &str,
    now_ms: i64,
) -> Result<String, &'static str> {
    let db = Db::open_hub(db_path).map_err(map_open_error)?;
    let outcome = attach_memory_candidate_ref(&db, mission_id, memory_id, now_ms)
        .map_err(|_| "attach_failed")?;
    let (status, link_id, blockers) = outcome_fields(&outcome);
    let snapshot = project_workbench(&db, Some(mission_id)).map_err(|_| "project_failed")?;
    let visible = snapshot
        .get("memoryCandidates")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .any(|row| row.get("id").and_then(Value::as_str) == Some(memory_id))
        })
        .unwrap_or(false);

    let payload = json!({
        "truth_label": "hub_attach_memory_candidate_refs_only",
        "proof_only": true,
        "ok": matches!(outcome, MissionAttachmentOutcome::Attached { .. } | MissionAttachmentOutcome::MissionLinked { .. }) && visible,
        "mission_id": mission_id,
        "memory_id": memory_id,
        "status": status,
        "link_id": link_id,
        "blockers": blockers,
        "workbench_memory_candidate_visible": visible,
        "authority_granted": false,
        "candidate_content_emitted": false,
    });
    let rendered = serde_json::to_string_pretty(&payload).map_err(|_| "serialize_failed")?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

fn outcome_fields(outcome: &MissionAttachmentOutcome) -> (&'static str, Option<&str>, Vec<String>) {
    match outcome {
        MissionAttachmentOutcome::Attached { link_id, .. } => {
            ("attached", Some(link_id.as_str()), Vec::new())
        }
        MissionAttachmentOutcome::MissionLinked { link_id } => {
            ("mission_linked", Some(link_id.as_str()), Vec::new())
        }
        MissionAttachmentOutcome::Blocked { blockers } => ("blocked", None, blockers.clone()),
    }
}

fn map_open_error(err: StorageError) -> &'static str {
    match err {
        StorageError::SchemaTooNew { .. } => "schema_too_new",
        _ => "open_failed",
    }
}

fn reject_forbidden_output(rendered: &str) -> Result<(), &'static str> {
    friday_hub::refs_guard::reject_forbidden_output(
        rendered,
        &["\"content\"", "\"candidate_content\""],
    )
    .map_err(|_| "output_guard")
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
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, MemoryScope, Mission,
        MissionStatus, RouteDecisionCard, TruthStatus, WorkItem, WorkItemStatus, WorkLane,
    };
    use friday_storage::memory::{record_candidate, NewMemoryCandidate};

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--db=/tmp/hub.sqlite".to_string(),
            "--mission-id".to_string(),
            "mission-1".to_string(),
            "--memory-id".to_string(),
            "mem-1".to_string(),
        ];
        assert_eq!(arg_value(&args, "--db").as_deref(), Some("/tmp/hub.sqlite"));
        assert_eq!(
            arg_value(&args, "--mission-id").as_deref(),
            Some("mission-1")
        );
        assert_eq!(arg_value(&args, "--memory-id").as_deref(), Some("mem-1"));
    }

    #[test]
    fn existing_candidate_attach_surfaces_workbench_memory_candidate_without_content() {
        let path = tmp_db();
        let db = Db::open_hub(&path).unwrap();
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: "fconv_memory_attach".into(),
            owner_principal: "admin-001".into(),
            title: "Memory attach proof".into(),
            current_focus_summary: "refs-only candidate attach".into(),
            active_mission_ids: vec!["mission_memory_attach".into()],
            surface_thread_ids: Vec::new(),
            memory_scope_ref: None,
            truth_status: TruthStatus::Proven,
            proof_refs: Vec::new(),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: "mission_memory_attach".into(),
            friday_conversation_id: "fconv_memory_attach".into(),
            title: "Memory attach proof".into(),
            intent: "surface review-only memory candidate".into(),
            status: MissionStatus::Active,
            why_now: "desktop evidence needs real memory projection".into(),
            decision_path_summary: "existing candidate attach".into(),
            considered_options: Vec::new(),
            deferred_options: vec!["final mobile+desktop UI proof".into()],
            known_pitfalls: Vec::new(),
            handoff_inheritance: Vec::new(),
            work_item_ids: vec!["work_memory_attach".into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: Vec::new(),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .unwrap();
        let work_item = WorkItem {
            work_item_id: "work_memory_attach".into(),
            mission_id: "mission_memory_attach".into(),
            lane: WorkLane::DeepSeek,
            target_provider_or_agent: Some("deepseek".into()),
            status: WorkItemStatus::ReadyToDispatch,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("memory.review".into()),
            risk_level: friday_core::Risk::Low,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["body://redacted/memory-review".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["refs-only memory candidate projection".into()],
            proof_receipts: Vec::new(),
            judgment_memory: judgment(),
            created_at_ms: 10,
            updated_at_ms: 10,
        };
        db.upsert_work_item(&work_item).unwrap();
        db.upsert_route_decision(&RouteDecisionCard::from_work_item(
            "route_memory_attach".into(),
            &work_item,
            vec!["trace://redacted/memory-route".into()],
            11,
            None,
        ))
        .unwrap();
        record_candidate(
            db.conn(),
            &NewMemoryCandidate {
                memory_id: "mem-existing-candidate",
                scope: MemoryScope::Session,
                content_ref: Some("friday://memory-candidate/existing"),
                content: Some("Candidate content must never be emitted by this proof bin."),
                principal_id: Some("tenant.default.channel.unknown.user.admin-001.shared"),
                sensitive: false,
                created_at: 11,
            },
        )
        .unwrap();

        let rendered = run_with_args(vec![
            "bin",
            "--db",
            &path,
            "--mission-id",
            "mission_memory_attach",
            "--memory-id",
            "mem-existing-candidate",
            "--ack",
            ACK,
        ])
        .unwrap();
        let parsed: Value = serde_json::from_str(&rendered).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["workbench_memory_candidate_visible"], true);
        assert_eq!(parsed["authority_granted"], false);
        assert!(reject_forbidden_output(&rendered).is_ok());
        assert!(!rendered.contains("Candidate content must never"));
    }

    fn run_with_args(raw: Vec<&str>) -> Result<String, &'static str> {
        let args = raw.into_iter().map(str::to_string).collect::<Vec<_>>();
        run_from_args(args)
    }

    fn run_from_args(args: Vec<String>) -> Result<String, &'static str> {
        let db_path = arg_value(&args, "--db").ok_or("bad_args")?;
        let mission_id = arg_value(&args, "--mission-id").ok_or("bad_args")?;
        let memory_id = arg_value(&args, "--memory-id").ok_or("bad_args")?;
        let ack = arg_value(&args, "--ack").ok_or("ack_required")?;
        if ack != ACK {
            return Err("ack_mismatch");
        }
        render_attach(&db_path, &mission_id, &memory_id, 12)
    }

    fn tmp_db() -> String {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "friday-attach-memory-candidate-{}-{}.sqlite",
            std::process::id(),
            now_ms()
        ));
        path.to_string_lossy().to_string()
    }

    fn judgment() -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "Memory candidate Workbench projection".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: "deepseek".into(),
            read_first_files: Vec::new(),
            required_output: "refs-only candidate projection".into(),
            done_criteria: vec!["memory candidate is visible without content".into()],
            red_lines: vec![
                "do not confirm memory".into(),
                "do not emit candidate content".into(),
            ],
            why_this_route: "Workbench consumes mission refs owned by Rust Hub.".into(),
            considered_options: vec!["direct SQL".into(), "governed attach path".into()],
            deferred_options: vec!["final UI/device capture".into()],
            previous_pitfalls: vec!["visible UI is not memory authority".into()],
            inheritable_context: vec!["memory candidate remains review-only".into()],
            proof_requirements: vec!["refs-only output guard".into()],
            ownership_claim_ids: Vec::new(),
        }
    }
}
