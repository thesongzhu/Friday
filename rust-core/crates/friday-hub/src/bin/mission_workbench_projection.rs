use friday_core::{MissionLinkKind, WorkItem, WorkItemStatus, WorkLane};
use friday_storage::Db;
use serde_json::{json, Map, Value};
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
    let mission = match requested_mission_id.as_deref() {
        Some(id) => db
            .get_mission(id)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "mission not found".to_string())?,
        None => db
            .list_active_missions()
            .map_err(|err| err.to_string())?
            .into_iter()
            .next()
            .ok_or_else(|| "no active mission found".to_string())?,
    };
    if !mission.mission_id.starts_with("mission_") {
        return Err("mission id is not UI proof canonical mission_ shape".to_string());
    }

    let mut projections = db
        .list_mission_surface_projections(&mission.friday_conversation_id)
        .map_err(|err| err.to_string())?
        .into_iter()
        .filter(|projection| projection.mission_id == mission.mission_id)
        .collect::<Vec<_>>();
    projections.sort_by(|left, right| {
        left.surface_kind
            .as_str()
            .cmp(right.surface_kind.as_str())
            .then_with(|| left.surface_thread_id.cmp(&right.surface_thread_id))
    });
    let work_items = db
        .list_work_items_for_mission(&mission.mission_id)
        .map_err(|err| err.to_string())?;
    let links = db
        .list_mission_links(&mission.mission_id)
        .map_err(|err| err.to_string())?;
    let route_decisions = db
        .list_route_decision_projections_for_mission(&mission.mission_id)
        .map_err(|err| err.to_string())?;
    let surface_events = db
        .list_surface_events_for_mission(&mission.mission_id)
        .map_err(|err| err.to_string())?;

    let first_work_item_id = work_items
        .first()
        .map(|item| item.work_item_id.clone())
        .ok_or_else(|| "mission has no work items".to_string())?;
    let route_decision = route_decisions
        .first()
        .ok_or_else(|| "mission has no route decision projection".to_string())?;

    let provider_receipt_refs = provider_receipt_refs(&work_items, &links);
    let channel_receipt_refs = channel_receipt_refs(&links);
    let mut transcript_events = Vec::new();
    append_projection_events(&mut transcript_events, &mission.mission_id, &projections);
    append_surface_events(&mut transcript_events, &surface_events);
    append_route_events(&mut transcript_events, &route_decisions);
    append_link_events(&mut transcript_events, &links);
    append_work_item_events(&mut transcript_events, &work_items);
    transcript_events.push(timeline_read_event(
        &mission.mission_id,
        &first_work_item_id,
        transcript_events.len(),
    ));

    let timeline_event_refs = transcript_events
        .iter()
        .filter_map(|event| event.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<Vec<_>>();
    let split = timeline_event_refs.len().max(2).div_ceil(2);
    let page_one_refs = timeline_event_refs
        .iter()
        .take(split)
        .cloned()
        .collect::<Vec<_>>();
    let page_two_refs = timeline_event_refs
        .iter()
        .skip(split)
        .cloned()
        .collect::<Vec<_>>();

    let snapshot = json!({
        "missionId": mission.mission_id,
        "fridayConversationId": mission.friday_conversation_id,
        "runtimeFeedStatus": "live_rust_hub_projection",
        "statusLabels": ["stale", "offline", "error"],
        "duplicatePreflight": {
            "status": "opens_existing_mission",
            "duplicateMissionId": mission.mission_id,
            "duplicateWorkItemId": first_work_item_id
        },
        "routeDecision": {
            "advisorSummary": route_decision.why_this_route,
            "selectedRoute": redacted_ref("route-decision", &route_decision.route_decision_ref),
            "alternatives": route_decision.considered_options,
            "truthLabel": "friday_owned"
        },
        "providerReceiptRefs": provider_receipt_refs,
        "channelReceiptRefs": channel_receipt_refs,
        "workItems": work_items_json(&work_items),
        "timelinePages": [
            {
                "page": 1,
                "cursor": "start",
                "nextCursor": "offset:1",
                "eventRefs": page_one_refs
            },
            {
                "page": 2,
                "cursor": "offset:1",
                "eventRefs": page_two_refs
            }
        ],
        "memoryCandidates": memory_candidates_json(&mission, &links),
        "capabilityStates": capability_states_json(&work_items, route_decision.route_decision_ref.as_str()),
        "transcriptSections": transcript_sections_json(&mission.mission_id, transcript_events)
    });

    let rendered = serde_json::to_string_pretty(&snapshot).map_err(|err| err.to_string())?;
    reject_forbidden_output(&rendered)?;
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

fn provider_receipt_refs(
    work_items: &[WorkItem],
    links: &[friday_core::MissionLink],
) -> Vec<String> {
    let mut refs = Vec::new();
    for item in work_items {
        refs.extend(
            item.proof_receipts
                .iter()
                .map(|proof| redacted_ref("provider-receipt", proof)),
        );
    }
    for link in links {
        if matches!(
            link.link_kind,
            MissionLinkKind::ProofReceipt
                | MissionLinkKind::ProviderSession
                | MissionLinkKind::ProviderTimeline
        ) {
            refs.push(redacted_link_proof_ref("provider-receipt", link));
        }
    }
    dedupe(refs)
}

fn channel_receipt_refs(links: &[friday_core::MissionLink]) -> Vec<String> {
    dedupe(
        links
            .iter()
            .filter(|link| link.link_kind == MissionLinkKind::ChannelInbound)
            .map(|link| redacted_link_proof_ref("channel-receipt", link))
            .collect(),
    )
}

fn work_items_json(work_items: &[WorkItem]) -> Vec<Value> {
    let mut rows = work_items
        .iter()
        .map(|item| {
            let state = lifecycle_state_for_work_item(item.status);
            let done = item.completion_is_proven();
            json!({
                "id": item.work_item_id,
                "title": item.judgment_memory.task,
                "state": state,
                "owner": truth_label_for_lane(item.lane),
                "proofRef": item.proof_receipts.first()
                    .map(|proof| redacted_ref("work-item-proof", proof))
                    .unwrap_or_else(|| redacted_ref("work-item-required", &item.work_item_id)),
                "done": done
            })
        })
        .collect::<Vec<_>>();
    if let Some(first) = work_items.first() {
        rows.push(json!({
            "id": format!("workbench_timeline_read_{}", safe_ref_part(&first.mission_id)),
            "title": "Bounded Mission timeline read",
            "state": "timeline_read",
            "owner": "friday_owned",
            "proofRef": redacted_ref("timeline-read", &first.mission_id),
            "done": false
        }));
    }
    rows
}

fn memory_candidates_json(
    mission: &friday_core::Mission,
    links: &[friday_core::MissionLink],
) -> Vec<Value> {
    let mut rows = links
        .iter()
        .filter(|link| link.link_kind == MissionLinkKind::MemoryCandidate)
        .enumerate()
        .map(|(index, link)| {
            json!({
                "id": format!("memory_candidate_{}_{}", safe_ref_part(&mission.mission_id), index),
                "preview": "Review-only memory candidate attached to this Mission.",
                "state": "candidate_review_only",
                "grantsMemoryAuthority": false,
                "evidenceRef": redacted_link_proof_ref("memory-candidate", link)
            })
        })
        .collect::<Vec<_>>();
    for (index, _candidate_ref) in mission.memory_candidate_refs.iter().enumerate() {
        rows.push(json!({
            "id": format!("memory_candidate_{}_mission_{}", safe_ref_part(&mission.mission_id), index),
            "preview": "Review-only memory candidate attached to this Mission.",
            "state": "candidate_review_only",
            "grantsMemoryAuthority": false,
            "evidenceRef": redacted_ref("memory-candidate", &format!("{}:{index}", mission.mission_id))
        }));
    }
    rows
}

fn capability_states_json(work_items: &[WorkItem], route_ref: &str) -> Vec<Value> {
    let mut rows = vec![json!({
        "id": "capability_mission_advisor",
        "label": "Mission advisor",
        "kind": "advisor",
        "truthLabel": "friday_owned",
        "approvalState": "not_required",
        "dispatchAllowed": false,
        "summary": "Advisor state is projected from Rust Hub route decisions; UI does not choose routes.",
        "proofRef": redacted_ref("route-decision", route_ref)
    })];
    for item in work_items {
        if let Some(capability_id) = item.capability_id.as_ref() {
            rows.push(json!({
                "id": format!("capability_{}", safe_ref_part(capability_id)),
                "label": capability_label(capability_id),
                "kind": if capability_id.starts_with("skill.") { "skill" } else { "capability" },
                "truthLabel": truth_label_for_lane(item.lane),
                "approvalState": approval_state(item.approval_state),
                "dispatchAllowed": item.approval_state == friday_core::ApprovalState::Approved,
                "summary": "Capability availability is a Rust Hub projection and still follows canonical approval gates.",
                "proofRef": redacted_ref("capability-projection", capability_id)
            }));
        }
    }
    rows
}

fn transcript_sections_json(mission_id: &str, events: Vec<Value>) -> Vec<Value> {
    let mut mission_events = Vec::new();
    let mut provider_events = Vec::new();
    let mut channel_events = Vec::new();
    let mut workflow_events = Vec::new();
    let mut skill_events = Vec::new();
    let mut status_events = Vec::new();
    for event in events {
        let evidence = event.get("evidenceRefs").and_then(Value::as_object);
        if evidence.and_then(|refs| refs.get("providerRef")).is_some() {
            provider_events.push(event);
        } else if evidence.and_then(|refs| refs.get("channelRef")).is_some() {
            channel_events.push(event);
        } else if evidence.and_then(|refs| refs.get("skillRunRef")).is_some() {
            skill_events.push(event);
        } else if evidence.and_then(|refs| refs.get("workflowRef")).is_some() {
            workflow_events.push(event);
        } else if event.get("status").and_then(Value::as_str) == Some("timeline_read") {
            status_events.push(event);
        } else {
            mission_events.push(event);
        }
    }
    let mut sections = Vec::new();
    push_section(
        &mut sections,
        "section_mission",
        "Mission projection",
        "mission",
        mission_id,
        "waiting",
        mission_events,
    );
    push_section(
        &mut sections,
        "section_provider",
        "Provider session refs",
        "provider_session",
        mission_id,
        "provider_ack",
        provider_events,
    );
    push_section(
        &mut sections,
        "section_channel",
        "Channel task refs",
        "channel_task",
        mission_id,
        "queued",
        channel_events,
    );
    push_section(
        &mut sections,
        "section_workflow",
        "Workflow refs",
        "workflow",
        mission_id,
        "queued",
        workflow_events,
    );
    push_section(
        &mut sections,
        "section_skill",
        "Skill run refs",
        "skill_run",
        mission_id,
        "waiting",
        skill_events,
    );
    push_section(
        &mut sections,
        "section_status",
        "Status and timeline reads",
        "status",
        mission_id,
        "timeline_read",
        status_events,
    );
    sections
}

fn push_section(
    sections: &mut Vec<Value>,
    id: &str,
    title: &str,
    group_kind: &str,
    mission_id: &str,
    status: &str,
    events: Vec<Value>,
) {
    if events.is_empty() {
        return;
    }
    sections.push(json!({
        "id": id,
        "title": title,
        "groupKind": group_kind,
        "missionId": mission_id,
        "truthLabel": "friday_owned",
        "status": status,
        "events": events
    }));
}

fn append_projection_events(
    events: &mut Vec<Value>,
    mission_id: &str,
    projections: &[friday_core::MissionSurfaceProjection],
) {
    for (index, projection) in projections.iter().enumerate() {
        events.push(event_json(
            format!("event_surface_projection_{index}"),
            mission_id,
            None,
            surface_for_projection(projection.surface_kind.as_str()),
            "waiting",
            "friday_owned",
            format!(
                "{} surface is attached to this Mission via a redacted surface thread projection.",
                projection.surface_kind.as_str()
            ),
            Some(redacted_ref(
                "surface-thread",
                &projection.surface_thread_id,
            )),
            evidence_refs(vec![
                (
                    "surfaceThreadRef",
                    redacted_ref("surface-thread", &projection.surface_thread_id),
                ),
                (
                    "timelineRef",
                    format!(
                        "timeline://mission/{}/surface-projection/{index}",
                        safe_ref_part(mission_id)
                    ),
                ),
            ]),
            projection.updated_at_ms,
        ));
    }
}

fn append_surface_events(events: &mut Vec<Value>, surface_events: &[friday_core::SurfaceEvent]) {
    for (index, event) in surface_events.iter().enumerate() {
        let mission_id = event.mission_id.as_str();
        events.push(event_json(
            format!("event_surface_{}", index),
            mission_id,
            event.work_item_id.clone(),
            surface_for_projection(event.source_surface.as_str()),
            status_for_surface_event(event.event_kind.as_str()),
            "friday_owned",
            format!(
                "{} event is attached through a redacted Mission surface event row.",
                event.source_surface.as_str()
            ),
            event
                .proof_ref
                .as_ref()
                .map(|proof| redacted_ref("surface-proof", proof)),
            evidence_refs(vec![
                (
                    "surfaceThreadRef",
                    redacted_ref("surface-thread", &event.surface_thread_id),
                ),
                (
                    "timelineRef",
                    format!(
                        "timeline://mission/{}/surface-event/{index}",
                        safe_ref_part(mission_id)
                    ),
                ),
            ]),
            event.created_at_ms,
        ));
    }
}

fn append_route_events(
    events: &mut Vec<Value>,
    route_decisions: &[friday_core::RouteDecisionProjection],
) {
    for (index, route) in route_decisions.iter().enumerate() {
        events.push(event_json(
            format!("event_route_decision_{index}"),
            &route.mission_id,
            Some(route.work_item_id.clone()),
            "timeline",
            "ready",
            "friday_owned",
            "Route decision is projected as redacted advisor evidence.",
            Some(redacted_ref("route-decision", &route.route_decision_ref)),
            evidence_refs(vec![
                (
                    "workflowRef",
                    redacted_ref("route-decision-workflow", &route.route_decision_ref),
                ),
                (
                    "timelineRef",
                    format!(
                        "timeline://mission/{}/route-decision/{index}",
                        safe_ref_part(&route.mission_id)
                    ),
                ),
            ]),
            route.created_at_ms,
        ));
    }
}

fn append_link_events(events: &mut Vec<Value>, links: &[friday_core::MissionLink]) {
    for (index, link) in links.iter().enumerate() {
        let (surface, status, truth, summary, refs) = match link.link_kind {
            MissionLinkKind::ProviderSession | MissionLinkKind::ProviderTimeline => (
                "timeline",
                "provider_ack",
                "linked_only",
                "Provider evidence is represented as a redacted proof ref and is not completion.",
                evidence_refs(vec![
                    ("providerRef", redacted_link_ref("provider-session", link)),
                    (
                        "proofReceiptRef",
                        redacted_link_proof_ref("provider-receipt", link),
                    ),
                    (
                        "timelineRef",
                        format!(
                            "timeline://mission/{}/provider-link/{index}",
                            safe_ref_part(&link.mission_id)
                        ),
                    ),
                ]),
            ),
            MissionLinkKind::ProofReceipt => (
                "desktop",
                "completed_with_proof",
                "friday_owned",
                "Completed state is backed by a proof receipt ref.",
                evidence_refs(vec![
                    (
                        "proofReceiptRef",
                        redacted_link_proof_ref("proof-receipt", link),
                    ),
                    (
                        "timelineRef",
                        format!(
                            "timeline://mission/{}/proof-receipt/{index}",
                            safe_ref_part(&link.mission_id)
                        ),
                    ),
                ]),
            ),
            MissionLinkKind::ChannelInbound => (
                "telegram",
                "queued",
                "observed_only",
                "Channel receipt is redacted and attached to the Mission as evidence.",
                evidence_refs(vec![
                    ("channelRef", redacted_link_ref("channel-receipt", link)),
                    (
                        "proofReceiptRef",
                        redacted_link_proof_ref("channel-receipt", link),
                    ),
                    (
                        "timelineRef",
                        format!(
                            "timeline://mission/{}/channel-link/{index}",
                            safe_ref_part(&link.mission_id)
                        ),
                    ),
                ]),
            ),
            MissionLinkKind::WorkflowRun => (
                "timeline",
                "queued",
                "friday_owned",
                "Workflow run ref is attached to the Mission timeline.",
                evidence_refs(vec![
                    ("workflowRef", redacted_link_ref("workflow-run", link)),
                    (
                        "timelineRef",
                        format!(
                            "timeline://mission/{}/workflow-link/{index}",
                            safe_ref_part(&link.mission_id)
                        ),
                    ),
                ]),
            ),
            MissionLinkKind::MemoryCandidate => (
                "timeline",
                "waiting",
                "friday_adopted",
                "Memory remains a review-only candidate.",
                evidence_refs(vec![
                    ("skillRunRef", redacted_link_ref("skill-run", link)),
                    (
                        "timelineRef",
                        format!(
                            "timeline://mission/{}/memory-candidate/{index}",
                            safe_ref_part(&link.mission_id)
                        ),
                    ),
                ]),
            ),
            _ => (
                "timeline",
                "waiting",
                "friday_owned",
                "Mission link is attached as a redacted timeline ref.",
                evidence_refs(vec![(
                    "timelineRef",
                    format!(
                        "timeline://mission/{}/link/{index}",
                        safe_ref_part(&link.mission_id)
                    ),
                )]),
            ),
        };
        events.push(event_json(
            format!("event_link_{index}"),
            &link.mission_id,
            link.work_item_id.clone(),
            surface,
            status,
            truth,
            summary,
            link.proof_ref
                .as_ref()
                .map(|proof| redacted_ref("mission-link-proof", proof)),
            refs,
            link.created_at_ms,
        ));
    }
}

fn append_work_item_events(events: &mut Vec<Value>, work_items: &[WorkItem]) {
    for (index, item) in work_items.iter().enumerate() {
        let mut refs = vec![(
            "timelineRef",
            format!(
                "timeline://mission/{}/work-item/{index}",
                safe_ref_part(&item.mission_id)
            ),
        )];
        if matches!(
            item.lane,
            WorkLane::Codex | WorkLane::Claude | WorkLane::DeepSeek | WorkLane::FutureApi
        ) {
            refs.push((
                "providerRef",
                redacted_ref("provider-work-item", &item.work_item_id),
            ));
        }
        if item.lane == WorkLane::Workflow {
            refs.push((
                "workflowRef",
                redacted_ref("workflow-work-item", &item.work_item_id),
            ));
        }
        if let Some(capability_id) = item.capability_id.as_ref() {
            if capability_id.starts_with("skill.") {
                refs.push((
                    "skillRunRef",
                    redacted_ref("skill-candidate", capability_id),
                ));
            }
        }
        if let Some(proof) = item.proof_receipts.first() {
            refs.push(("proofReceiptRef", redacted_ref("work-item-proof", proof)));
        }
        events.push(event_json(
            format!("event_work_item_{index}"),
            &item.mission_id,
            Some(item.work_item_id.clone()),
            "timeline",
            lifecycle_state_for_work_item(item.status),
            truth_label_for_lane(item.lane),
            "WorkItem lifecycle is projected from Rust Hub and non-terminal states are not done.",
            item.proof_receipts
                .first()
                .map(|proof| redacted_ref("work-item-proof", proof)),
            evidence_refs(refs),
            item.updated_at_ms,
        ));
    }
}

fn timeline_read_event(mission_id: &str, _work_item_id: &str, index: usize) -> Value {
    event_json(
        format!("event_timeline_read_{index}"),
        mission_id,
        Some(format!(
            "workbench_timeline_read_{}",
            safe_ref_part(mission_id)
        )),
        "timeline",
        "timeline_read",
        "friday_owned",
        "This Workbench read is bounded and is not completion proof.",
        Some(redacted_ref("timeline-read", mission_id)),
        evidence_refs(vec![
            (
                "workflowRef",
                redacted_ref("timeline-read-workflow", mission_id),
            ),
            (
                "timelineRef",
                format!(
                    "timeline://mission/{}/bounded-read",
                    safe_ref_part(mission_id)
                ),
            ),
        ]),
        0,
    )
}

#[allow(clippy::too_many_arguments)]
fn event_json(
    id: String,
    mission_id: &str,
    work_item_id: Option<String>,
    surface: &str,
    status: &str,
    truth_label: &str,
    summary: impl Into<String>,
    proof_ref: Option<String>,
    evidence_refs: Value,
    captured_at_ms: i64,
) -> Value {
    let mut row = Map::new();
    row.insert("id".to_string(), Value::String(id));
    row.insert(
        "missionId".to_string(),
        Value::String(mission_id.to_string()),
    );
    if let Some(work_item_id) = work_item_id {
        row.insert("workItemId".to_string(), Value::String(work_item_id));
    }
    row.insert("surface".to_string(), Value::String(surface.to_string()));
    row.insert("status".to_string(), Value::String(status.to_string()));
    row.insert(
        "truthLabel".to_string(),
        Value::String(truth_label.to_string()),
    );
    row.insert("summary".to_string(), Value::String(summary.into()));
    if let Some(proof_ref) = proof_ref {
        row.insert("proofRef".to_string(), Value::String(proof_ref));
    }
    row.insert("evidenceRefs".to_string(), evidence_refs);
    row.insert(
        "capturedAt".to_string(),
        Value::String(format!("unix_ms:{captured_at_ms}")),
    );
    Value::Object(row)
}

fn evidence_refs(entries: Vec<(&'static str, String)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        if !value.trim().is_empty() {
            map.insert(key.to_string(), Value::String(value));
        }
    }
    Value::Object(map)
}

fn lifecycle_state_for_work_item(status: WorkItemStatus) -> &'static str {
    match status {
        WorkItemStatus::Draft | WorkItemStatus::ReadyToDispatch => "ready",
        WorkItemStatus::PreflightBlocked => "blocked",
        WorkItemStatus::WaitingForUser => "waiting",
        WorkItemStatus::Dispatched
        | WorkItemStatus::HubAccepted
        | WorkItemStatus::ProviderRouted
        | WorkItemStatus::ProviderWaiting => "provider_ack",
        WorkItemStatus::CompletedWithProof => "completed_with_proof",
        WorkItemStatus::FailedRetryable => "stale",
        WorkItemStatus::FailedTerminal => "error",
        WorkItemStatus::Cancelled | WorkItemStatus::Merged | WorkItemStatus::Archived => "blocked",
    }
}

fn status_for_surface_event(kind: &str) -> &'static str {
    match kind {
        "channel_inbound" => "queued",
        "provider_trace" => "provider_ack",
        "proof_receipt" => "completed_with_proof",
        "memory_decision" | "needs_me" => "waiting",
        "system_status" => "stale",
        _ => "ready",
    }
}

fn truth_label_for_lane(lane: WorkLane) -> &'static str {
    match lane {
        WorkLane::FridayHub | WorkLane::Human | WorkLane::Workflow => "friday_owned",
        WorkLane::Channel => "observed_only",
        WorkLane::Codex | WorkLane::Claude | WorkLane::DeepSeek | WorkLane::FutureApi => {
            "linked_only"
        }
    }
}

fn surface_for_projection(surface: &str) -> &'static str {
    match surface {
        "mobile" => "mobile",
        "desktop" => "desktop",
        "telegram" => "telegram",
        _ => "timeline",
    }
}

fn approval_state(state: friday_core::ApprovalState) -> &'static str {
    match state {
        friday_core::ApprovalState::NotRequired => "not_required",
        friday_core::ApprovalState::Required => "required",
        friday_core::ApprovalState::Approved => "approved",
        friday_core::ApprovalState::Rejected => "blocked",
    }
}

fn capability_label(capability_id: &str) -> String {
    capability_id
        .split(['.', ':', '/', '-'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn redacted_ref(kind: &str, value: &str) -> String {
    format!("proof://{}/{}", safe_ref_part(kind), ref_fingerprint(value))
}

fn redacted_link_ref(kind: &str, link: &friday_core::MissionLink) -> String {
    redacted_ref(
        kind,
        &format!(
            "{}:{}:{}:{}",
            link.mission_id,
            link.work_item_id.as_deref().unwrap_or(""),
            link.link_kind.as_str(),
            link.created_at_ms
        ),
    )
}

fn redacted_link_proof_ref(kind: &str, link: &friday_core::MissionLink) -> String {
    link.proof_ref
        .as_ref()
        .map(|proof| redacted_ref(kind, proof))
        .unwrap_or_else(|| redacted_link_ref(kind, link))
}

fn ref_fingerprint(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn safe_ref_part(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn dedupe(values: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        if !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

fn reject_forbidden_output(rendered: &str) -> Result<(), String> {
    for marker in [
        "provider_native_synced",
        "raw transcript",
        "raw_provider",
        "raw-channel",
        "raw-chat",
        "Authorization",
        "Bearer",
        "sk-",
        "/Users/",
        "/private/",
    ] {
        if rendered.contains(marker) {
            return Err(format!("forbidden marker in projection: {marker}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionLink,
        MissionStatus, RouteDecisionCard, SurfaceEvent, SurfaceEventKind, SurfaceKind,
        SurfaceThread, TruthStatus, VisibilityPolicy, WorkLane,
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
