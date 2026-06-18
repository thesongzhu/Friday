//! **S-R1** — the Mission Workbench projection, extracted to a CALLABLE library fn.
//!
//! The projection logic previously lived INLINE in `bin/mission_workbench_projection.rs::run()`.
//! S-R1 extracts the core into [`project_workbench`] so that BOTH the existing one-shot CLI bin AND
//! the new DARK sealed-WS read-projection server (`bin/hub_read_projection_server.rs`) share ONE
//! implementation — no duplication, no drift. The bin is now a thin wrapper (open DB read-only →
//! call this fn → print).
//!
//! ## Refs-only by construction
//! [`project_workbench`] runs [`reject_forbidden_output`] INSIDE itself and returns `Err` if any
//! forbidden marker is present, so EVERY caller (the bin and the read server) inherits the refs-only
//! guarantee — the snapshot carries redacted proof refs / counts / labels only, never raw
//! transcript / provider text / a `provider_native_synced` claim. Truth labels are emitted as-is and
//! never upgraded.
//!
//! ## No model call, no credential, read-only
//! This fn takes an ALREADY-OPENED [`Db`] (the bin and the server open it `open_hub_readonly`) and
//! does pure reads + JSON shaping. It never touches a provider credential or the model path.

use friday_core::{MissionLinkKind, WorkItem, WorkItemStatus, WorkLane};
use friday_storage::Db;
use serde_json::{json, Map, Value};

/// Project the Mission Workbench snapshot for `requested_mission_id` (or the first active Mission
/// when `None`) from an already-opened read-only hub [`Db`]. Returns the refs-only snapshot
/// `serde_json::Value` on success.
///
/// Fail-closed: a missing mission, a mission with no work items / no route decision, or a
/// forbidden-marker leak all return `Err(String)` (the same coarse error strings the bin surfaced)
/// — never a partial or a raw body. The forbidden-output guard runs INSIDE this fn so both the bin
/// and the read server inherit it.
///
/// The projection is id-shape-AGNOSTIC: it accepts ANY mission id the real producer mints (the live
/// hub mints HYPHEN ids — `mission-{work_item_id}` and `mission-autodisp-…` / `mission-loop1-…`),
/// never an underscore `mission_` shape. There is no shape gate: safety is enforced SUBSTANTIVELY by
/// the existence + work-item + route-decision + forbidden-output guards below, not by the id text.
pub fn project_workbench(db: &Db, requested_mission_id: Option<&str>) -> Result<Value, String> {
    let mission = match requested_mission_id {
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
            "controlRef": route_decision.route_decision_ref,
            "workItemId": route_decision.work_item_id,
            "alternatives": route_decision.considered_options,
            "actionItems": route_decision_action_items_json(&route_decision.action_items),
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

    // Run the forbidden-output guard INSIDE the library fn so the bin AND the read server both
    // inherit refs-only. The guard renders to a string and rejects on any forbidden marker.
    let rendered = serde_json::to_string(&snapshot).map_err(|err| err.to_string())?;
    reject_forbidden_output(&rendered)?;
    Ok(snapshot)
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

fn route_decision_action_items_json(items: &[friday_core::RouteActionItem]) -> Vec<Value> {
    items
        .iter()
        .map(|item| {
            json!({
                "description": item.description.clone(),
                "targetKind": item.target_kind.as_str(),
                "targetRef": item.target_ref.clone(),
                "reversibility": item.reversibility.as_str(),
                "assignedLane": item.assigned_lane.as_str(),
                "assignedProviderOrAgent": item.assigned_provider_or_agent.clone(),
                "routeReason": item.route_reason.clone(),
            })
        })
        .collect()
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

/// Refs-only output guard — the SAME shared guard the bin ran, plus this projection's raw-content
/// body markers. A projection must surface only redacted proof refs, never raw transcript/provider
/// text or a `provider_native_synced` claim. Returns `Err(marker)` on any forbidden marker so both
/// the bin and the read server fail closed identically.
fn reject_forbidden_output(rendered: &str) -> Result<(), String> {
    crate::refs_guard::reject_forbidden_output(
        rendered,
        &[
            "provider_native_synced",
            "raw transcript",
            "raw_provider",
            "raw-channel",
            "raw-chat",
        ],
    )
    .map_err(|marker| format!("forbidden marker in projection: {marker}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus,
        RouteDecisionCard, TruthStatus, WorkItem, WorkItemStatus, WorkLane,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp() -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-workbench-projection-{}-{}.sqlite",
                std::process::id(),
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn judgment() -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "Mission-bound provider action".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: "deepseek".into(),
            read_first_files: vec![],
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

    /// Seed a Mission EXACTLY the way the REAL live producer mints it — a HYPHEN `mission-{…}` id
    /// (the live hub's `format!("mission-{work_item_id}")` shape; cf. `lib.rs` heartbeat seed +
    /// the real prod DB rows `mission-autodisp-…` / `mission-loop1-proof-001`) and an underscore
    /// `fconv_` conversation. Gives it the ≥1 work_item + ≥1 route_decision the SUBSTANTIVE guards
    /// require. Returns the exact minted hyphen mission id.
    ///
    /// This is DELIBERATELY a hyphen id, NOT the synthetic underscore `mission_` fixtures the older
    /// read-seam/surface-timeline tests use — those synthetic shapes the real producer never mints
    /// false-passed the deleted `mission_`-prefix gate, while every REAL (hyphen) mission failed it,
    /// rendering nothing in the live Console. This test drives producer reality.
    fn seed_real_producer_mission(db: &Db) -> String {
        let now = 1_780_640_000_000;
        let work_item_id = "autodisp-1781492033";
        // The live producer shape: HYPHEN mission id, underscore conversation id.
        let mission_id = format!("mission-{work_item_id}");
        let conversation_id = format!("fconv_{}", work_item_id.replace('-', "_"));

        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: conversation_id.clone(),
            owner_principal: "owner-real".into(),
            title: "Real producer-minted mission".into(),
            current_focus_summary: "hyphen mission id must project".into(),
            active_mission_ids: vec![mission_id.clone()],
            surface_thread_ids: vec![],
            memory_scope_ref: None,
            truth_status: TruthStatus::Proven,
            proof_refs: vec!["proof://mission/real-producer".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: mission_id.clone(),
            friday_conversation_id: conversation_id.clone(),
            title: "Prove the real (hyphen) mission projects".into(),
            intent: "render the live producer-minted mission in the workbench".into(),
            status: MissionStatus::Active,
            why_now: "the read seam must project real producer ids".into(),
            decision_path_summary: "Rust Hub owns the Mission projection; UI reads it.".into(),
            considered_options: vec!["route missing".into(), "live Rust projection".into()],
            deferred_options: vec!["final UI/device evidence".into()],
            known_pitfalls: vec!["provider ack is not completion".into()],
            handoff_inheritance: vec!["keep proof refs redacted".into()],
            work_item_ids: vec![work_item_id.into()],
            memory_candidate_refs: vec![],
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://mission/real-producer".into()],
            created_at_ms: now,
            updated_at_ms: now + 10,
        })
        .unwrap();
        let provider_item = WorkItem {
            work_item_id: work_item_id.into(),
            mission_id: mission_id.clone(),
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
            judgment_memory: judgment(),
            created_at_ms: now + 4,
            updated_at_ms: now + 5,
        };
        db.upsert_work_item(&provider_item).unwrap();
        db.upsert_route_decision(&RouteDecisionCard::from_work_item(
            "route_real_producer".into(),
            &provider_item,
            vec!["trace://redacted/provider-route".into()],
            now + 8,
            None,
        ))
        .unwrap();
        mission_id
    }

    /// NO-FALSE-CLOSURE regression. Drives the REAL producer id-shape (a HYPHEN `mission-…` id, the
    /// ONLY shape the live hub mints) end-to-end through `project_workbench` and asserts it SUCCEEDS
    /// and the snapshot carries that EXACT hyphen id.
    ///
    /// This FAILS against the deleted `if !mission.mission_id.starts_with("mission_")` gate — that
    /// gate returned `Err("mission id is not UI proof canonical mission_ shape")` for every real
    /// (hyphen) mission, so `.unwrap()` here would panic. Restore the 3-line gate locally to watch
    /// it fail; that is what makes this a genuine contract guard, not a shape-coincidence pass.
    #[test]
    fn real_producer_hyphen_mission_id_projects_without_false_closure() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mission_id = seed_real_producer_mission(&db);
        assert!(
            !mission_id.starts_with("mission_"),
            "guard precondition: the real producer mints a HYPHEN id, never `mission_`: {mission_id}"
        );

        let snapshot = project_workbench(&db, Some(&mission_id)).expect(
            "a real producer-minted (hyphen) mission must project — no shape false-closure",
        );

        assert_eq!(
            snapshot.get("missionId").and_then(Value::as_str),
            Some(mission_id.as_str()),
            "the snapshot must carry the EXACT real hyphen mission id, not a rewritten/synthetic shape"
        );
    }
}
