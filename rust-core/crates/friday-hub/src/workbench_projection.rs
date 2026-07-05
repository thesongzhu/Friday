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
use rusqlite::{params, OptionalExtension};
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

    let run_outcome_learning_candidates =
        run_outcome_learning_candidates_json(db, &work_items).map_err(|err| err.to_string())?;
    let readback_refs =
        readback_refs_json(db, &work_items, &links).map_err(|err| err.to_string())?;
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
        "statusLabels": status_labels_json(&work_items),
        "tokenLedgerRunId": readback_refs.token_ledger_run_id,
        "agentSessionId": readback_refs.agent_session_id,
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
        "runOutcomeLearningCandidates": run_outcome_learning_candidates,
        "capabilityStates": capability_states_json(&work_items, route_decision.route_decision_ref.as_str()),
        "t3ProvisioningStatus": t3_provisioning_status_json(db).map_err(|err| err.to_string())?,
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
            let recovery = recovery_metadata_for_work_item(item.status);
            json!({
                "id": item.work_item_id,
                "title": item.judgment_memory.task,
                "state": state,
                "owner": truth_label_for_lane(item.lane),
                "proofRef": item.proof_receipts.first()
                    .map(|proof| redacted_ref("work-item-proof", proof))
                    .unwrap_or_else(|| redacted_ref("work-item-required", &item.work_item_id)),
                "done": done,
                "blockingReason": recovery.blocking_reason,
                "recoveryKind": recovery.kind,
                "canRetry": recovery.can_retry,
                "canCancel": recovery.can_cancel
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
            "done": false,
            "blockingReason": "bounded timeline read only; no WorkItem recovery action applies",
            "recoveryKind": "none",
            "canRetry": false,
            "canCancel": false
        }));
    }
    rows
}

fn status_labels_json(work_items: &[WorkItem]) -> Vec<&'static str> {
    let has_stale = work_items
        .iter()
        .any(|item| item.status == WorkItemStatus::FailedRetryable);
    let has_error = work_items
        .iter()
        .any(|item| item.status == WorkItemStatus::FailedTerminal);
    let mut labels = Vec::new();
    if has_stale {
        labels.push("stale");
    }
    if has_error {
        labels.push("error");
    }
    labels
}

struct WorkItemRecoveryMetadata {
    kind: &'static str,
    blocking_reason: &'static str,
    can_retry: bool,
    can_cancel: bool,
}

fn recovery_metadata_for_work_item(status: WorkItemStatus) -> WorkItemRecoveryMetadata {
    let can_cancel = status.can_transition_to(WorkItemStatus::Cancelled);
    match status {
        WorkItemStatus::FailedRetryable => WorkItemRecoveryMetadata {
            kind: "retryable",
            blocking_reason: "failed retryable; operator may retry by returning the WorkItem to ready_to_dispatch",
            can_retry: true,
            can_cancel,
        },
        WorkItemStatus::FailedTerminal => WorkItemRecoveryMetadata {
            kind: "terminal",
            blocking_reason: "terminal failure; no automatic retry is exposed from the Workbench",
            can_retry: false,
            can_cancel: false,
        },
        WorkItemStatus::PreflightBlocked | WorkItemStatus::WaitingForUser => {
            WorkItemRecoveryMetadata {
                kind: "needs_operator",
                blocking_reason: "waiting on operator input or preflight resolution",
                can_retry: false,
                can_cancel,
            }
        }
        WorkItemStatus::Dispatched | WorkItemStatus::HubAccepted | WorkItemStatus::ProviderRouted => {
            WorkItemRecoveryMetadata {
                kind: "in_flight",
                blocking_reason: "provider or hub execution is still in flight; cancel is the only exposed recovery action",
                can_retry: false,
                can_cancel,
            }
        }
        WorkItemStatus::ProviderWaiting => WorkItemRecoveryMetadata {
            kind: "in_flight",
            blocking_reason: "provider execution is waiting; no legal recovery action is exposed until the provider returns or crash-recovery reconciles it",
            can_retry: false,
            can_cancel,
        },
        WorkItemStatus::Draft | WorkItemStatus::ReadyToDispatch => WorkItemRecoveryMetadata {
            kind: "dispatchable",
            blocking_reason: "ready for dispatch; no recovery action required",
            can_retry: false,
            can_cancel,
        },
        WorkItemStatus::CompletedWithProof
        | WorkItemStatus::Cancelled
        | WorkItemStatus::Merged
        | WorkItemStatus::Archived => WorkItemRecoveryMetadata {
            kind: "none",
            blocking_reason: "terminal or archived WorkItem; no recovery action applies",
            can_retry: false,
            can_cancel: false,
        },
    }
}

fn memory_candidates_json(
    mission: &friday_core::Mission,
    links: &[friday_core::MissionLink],
) -> Vec<Value> {
    let mut seen_memory_ids: Vec<String> = Vec::new();
    let mut rows = links
        .iter()
        .filter(|link| link.link_kind == MissionLinkKind::MemoryCandidate)
        .filter_map(|link| {
            let memory_id = memory_id_from_ref(&link.target_ref)?;
            if seen_memory_ids.iter().any(|seen| seen == &memory_id) {
                return None;
            }
            seen_memory_ids.push(memory_id.clone());
            Some(memory_candidate_row(
                &memory_id,
                redacted_link_proof_ref("memory-candidate", link),
            ))
        })
        .collect::<Vec<_>>();
    for candidate_ref in &mission.memory_candidate_refs {
        let Some(memory_id) = memory_id_from_ref(candidate_ref) else {
            continue;
        };
        if seen_memory_ids.iter().any(|seen| seen == &memory_id) {
            continue;
        }
        seen_memory_ids.push(memory_id.clone());
        rows.push(memory_candidate_row(
            &memory_id,
            redacted_ref("memory-candidate", candidate_ref),
        ));
    }
    rows
}

fn memory_id_from_ref(memory_ref: &str) -> Option<String> {
    let id = memory_ref.strip_prefix("friday://memory/")?.trim();
    if id.is_empty() || id.contains('/') || id.contains('#') {
        return None;
    }
    Some(id.to_string())
}

fn memory_candidate_row(memory_id: &str, evidence_ref: String) -> Value {
    json!({
        "id": memory_id,
        "preview": "Review-only memory candidate attached to this Mission.",
        "state": "candidate_review_only",
        "grantsMemoryAuthority": false,
        "evidenceRef": evidence_ref
    })
}

fn run_outcome_learning_candidates_json(
    db: &Db,
    work_items: &[WorkItem],
) -> friday_storage::Result<Vec<Value>> {
    let mut rows = Vec::new();
    for item in work_items {
        for run_id in work_item_agent_run_ids(item) {
            let candidates =
                friday_storage::learning_candidate::list_run_outcome_candidates_for_run(
                    db.conn(),
                    &run_id,
                )?;
            for candidate in candidates {
                rows.push(json!({
                    "id": candidate.candidate_id,
                    "runId": candidate.run_id,
                    "workItemId": item.work_item_id,
                    "kind": candidate.kind.as_str(),
                    "state": candidate.state.as_str(),
                    "summary": candidate.summary,
                    "evidenceRef": redacted_ref("run-outcome-learning-candidate", &candidate.evidence_ref),
                    "turns": candidate.turns,
                    "executedTools": candidate.executed_tools
                }));
            }
        }
    }
    rows.sort_by(|left, right| {
        let left_id = left.get("id").and_then(Value::as_str);
        let right_id = right.get("id").and_then(Value::as_str);
        left_id.cmp(&right_id)
    });
    Ok(rows)
}

struct ReadbackRefs {
    token_ledger_run_id: Option<String>,
    agent_session_id: Option<String>,
}

fn readback_refs_json(
    db: &Db,
    work_items: &[WorkItem],
    links: &[friday_core::MissionLink],
) -> rusqlite::Result<ReadbackRefs> {
    let run_ids = projected_agent_run_ids(work_items, links);
    Ok(ReadbackRefs {
        token_ledger_run_id: first_token_ledger_run_id(db, &run_ids)?,
        agent_session_id: first_agent_session_id(db, &run_ids)?,
    })
}

fn projected_agent_run_ids(
    work_items: &[WorkItem],
    links: &[friday_core::MissionLink],
) -> Vec<String> {
    let mut ids = Vec::new();
    for item in work_items {
        push_unique_run_ids(&mut ids, work_item_agent_run_ids(item));
    }
    for link in links {
        let mut candidates = Vec::new();
        candidates.extend(link.proof_ref.as_deref().and_then(agent_run_id_from_ref));
        candidates.extend(agent_run_id_from_ref(&link.target_ref));
        candidates.extend(agent_run_id_from_provider_timeline_ref(&link.target_ref));
        push_unique_run_ids(&mut ids, candidates);
    }
    ids
}

fn push_unique_run_ids(ids: &mut Vec<String>, candidates: impl IntoIterator<Item = String>) {
    for run_id in candidates {
        if !ids.iter().any(|seen| seen == &run_id) {
            ids.push(run_id);
        }
    }
}

fn first_token_ledger_run_id(db: &Db, run_ids: &[String]) -> rusqlite::Result<Option<String>> {
    for run_id in run_ids {
        let found = db
            .conn()
            .query_row(
                "SELECT run_id FROM token_ledger
                 WHERE run_id = ?1 AND length(trim(run_id)) > 0
                 ORDER BY created_at DESC
                 LIMIT 1",
                params![run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

fn first_agent_session_id(db: &Db, run_ids: &[String]) -> rusqlite::Result<Option<String>> {
    for run_id in run_ids {
        let found = db
            .conn()
            .query_row(
                "SELECT agent_session_id FROM agent_session
                 WHERE agent_session_id = ?1
                 LIMIT 1",
                params![run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

fn work_item_agent_run_ids(item: &WorkItem) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for value in item.proof_receipts.iter().chain(item.output_refs.iter()) {
        if let Some(run_id) = agent_run_id_from_ref(value) {
            if !ids.iter().any(|seen| seen == &run_id) {
                ids.push(run_id);
            }
        }
    }
    ids
}

fn agent_run_id_from_ref(value: &str) -> Option<String> {
    let mut run_id = value
        .strip_prefix("friday://agent-run/")
        .or_else(|| value.strip_prefix("proof://outcome/AnswerProduced/"))?;
    if let Some((id, _)) = run_id.split_once('?') {
        run_id = id;
    }
    if let Some((id, _)) = run_id.split_once('#') {
        run_id = id;
    }
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return None;
    }
    Some(run_id.to_string())
}

fn agent_run_id_from_provider_timeline_ref(value: &str) -> Option<String> {
    let (_, run_id) = value
        .strip_prefix("friday://provider-timeline/")?
        .rsplit_once('#')?;
    let run_id = run_id.trim();
    if run_id.is_empty() || run_id.contains('/') {
        return None;
    }
    Some(run_id.to_string())
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

fn t3_provisioning_status_json(db: &Db) -> friday_storage::Result<Value> {
    let device_identity_count = db.count("device_identity")?;
    let trusted_device_count = db.count("trusted_device")?;
    let active_trusted_device_count: i64 = db.conn().query_row(
        "SELECT count(*) FROM trusted_device WHERE revoked_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    let trust_grant_count = db.count("trust_grant")?;
    let context_passport_count = db.count("context_passport")?;
    let context_passport_item_count = db.count("context_passport_item")?;
    let active_trust_grant_count: i64 = db.conn().query_row(
        "SELECT count(*) FROM trust_grant WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > strftime('%s','now') * 1000)",
        [],
        |row| row.get(0),
    )?;
    let latest_device = db.list_trusted_device_projections()?.into_iter().next();

    Ok(json!({
        "truthLabel": "rust_hub_t3_provisioning_read_only_no_mint",
        "paired": device_identity_count > 0 && active_trusted_device_count > 0,
        "deviceIdentityCount": device_identity_count,
        "trustedDeviceCount": trusted_device_count,
        "activeTrustedDeviceCount": active_trusted_device_count,
        "trustGrantCount": trust_grant_count,
        "activeTrustGrantCount": active_trust_grant_count,
        "contextPassportCount": context_passport_count,
        "contextPassportItemCount": context_passport_item_count,
        "latestDevice": latest_device.map(|device| json!({
            "deviceId": redacted_ref("device", &device.device_id),
            "label": device.label,
            "pairedAt": device.paired_at,
            "revokedAt": device.revoked_at,
            "keyRotatedAt": device.key_rotated_at,
            "pubkeyFingerprint": device.pubkey_fingerprint,
        }))
    }))
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
    use crate::channel_event::ingest_channel_inbound;
    use crate::channels::{redact_inbound, VerifiedInbound};
    use crate::mission_preflight::{attach_channel_inbound_receipt, attach_memory_candidate_ref};
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, MemoryScope, Mission,
        MissionStatus, RouteDecisionCard, SurfaceEvent, SurfaceEventKind, SurfaceKind,
        SurfaceThread, TruthStatus, VisibilityPolicy, WorkItem, WorkItemStatus, WorkLane,
    };
    use friday_storage::memory;
    use rusqlite::params;
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

    #[test]
    fn recovery_can_cancel_matches_core_cancel_transition() {
        let provider_waiting = recovery_metadata_for_work_item(WorkItemStatus::ProviderWaiting);
        assert!(
            !provider_waiting.can_cancel,
            "ProviderWaiting has no core ProviderWaiting->Cancelled edge"
        );
        let ready = recovery_metadata_for_work_item(WorkItemStatus::ReadyToDispatch);
        assert!(
            ready.can_cancel,
            "ReadyToDispatch keeps its legal core cancel affordance"
        );
        let failed = recovery_metadata_for_work_item(WorkItemStatus::FailedRetryable);
        assert!(
            failed.can_cancel,
            "FailedRetryable keeps its legal core cancel affordance"
        );
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

    #[test]
    fn healthy_live_projection_does_not_emit_stale_offline_or_error_labels() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mission_id = seed_real_producer_mission(&db);

        let snapshot = project_workbench(&db, Some(&mission_id)).unwrap();
        let labels = snapshot
            .get("statusLabels")
            .and_then(Value::as_array)
            .expect("statusLabels array");

        assert!(
            labels.is_empty(),
            "a successful live Rust Hub projection must not be hard-labelled stale/offline/error"
        );
    }

    #[test]
    fn system_status_surface_event_projects_offline_status_label() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mission_id = seed_real_producer_mission(&db);
        let mission = db.get_mission(&mission_id).unwrap().unwrap();
        let surface_thread_id = "surface-offline-status-desktop";
        db.upsert_surface_thread(&SurfaceThread {
            surface_thread_id: surface_thread_id.into(),
            friday_conversation_id: mission.friday_conversation_id.clone(),
            mission_id: Some(mission_id.clone()),
            surface_kind: SurfaceKind::Desktop,
            channel_binding_id: None,
            delivery_route: "scratch://offline-status".into(),
            visibility_policy: VisibilityPolicy::StatusOnly,
            allowed_actions: vec![],
            last_seen_at_ms: Some(1_780_640_000_500),
            last_delivered_event_seq: None,
            created_at_ms: 1_780_640_000_500,
            updated_at_ms: 1_780_640_000_500,
        })
        .unwrap();
        db.upsert_surface_event(&SurfaceEvent {
            surface_event_id: "surface-event-offline-status".into(),
            friday_conversation_id: mission.friday_conversation_id,
            mission_id: mission_id.clone(),
            work_item_id: None,
            surface_thread_id: surface_thread_id.into(),
            source_surface: SurfaceKind::Desktop,
            event_kind: SurfaceEventKind::SystemStatus,
            body_ref: Some("friday://body/surface-event/offline-status".into()),
            visibility_policy: VisibilityPolicy::StatusOnly,
            proof_ref: Some("proof://surface-event/offline-status-proof".into()),
            created_at_ms: 1_780_640_000_510,
        })
        .unwrap();

        let snapshot = project_workbench(&db, Some(&mission_id)).unwrap();
        let labels = snapshot
            .get("statusLabels")
            .and_then(Value::as_array)
            .expect("statusLabels array");
        assert!(
            labels.iter().any(|label| label.as_str() == Some("offline")),
            "system_status surface events must make the offline label available for strict workbench preflight"
        );
    }

    #[test]
    fn real_failed_retryable_work_item_projects_stale_retry_affordance() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mission_id = seed_real_producer_mission(&db);
        let mut item = db.get_work_item("autodisp-1781492033").unwrap().unwrap();
        item.status = WorkItemStatus::FailedRetryable;
        item.blocking_reason = Some(
            "failed retryable; operator may retry by returning the WorkItem to ready_to_dispatch"
                .into(),
        );
        db.upsert_work_item(&item).unwrap();

        let snapshot = project_workbench(&db, Some(&mission_id)).unwrap();
        let items = snapshot
            .get("workItems")
            .and_then(Value::as_array)
            .expect("workItems array");
        let projected = items
            .iter()
            .find(|row| row.get("id").and_then(Value::as_str) == Some("autodisp-1781492033"))
            .expect("real producer work item projection");

        assert_eq!(
            projected.get("state").and_then(Value::as_str),
            Some("stale")
        );
        assert_eq!(
            projected.get("recoveryKind").and_then(Value::as_str),
            Some("retryable")
        );
        assert_eq!(
            projected.get("canRetry").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            projected.get("canCancel").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(projected.get("done").and_then(Value::as_bool), Some(false));
        assert_eq!(
            snapshot.get("statusLabels").and_then(Value::as_array),
            Some(&vec![json!("stale")])
        );
    }

    #[test]
    fn failed_terminal_work_item_projects_error_status_label() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mission_id = seed_real_producer_mission(&db);
        let mut item = db.get_work_item("autodisp-1781492033").unwrap().unwrap();
        item.status = WorkItemStatus::FailedTerminal;
        db.upsert_work_item(&item).unwrap();

        let snapshot = project_workbench(&db, Some(&mission_id)).unwrap();
        assert_eq!(
            snapshot.get("statusLabels").and_then(Value::as_array),
            Some(&vec![json!("error")])
        );
    }

    #[test]
    fn memory_candidates_project_durable_memory_id_once() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mission_id = seed_real_producer_mission(&db);
        memory::record_candidate(
            db.conn(),
            &memory::NewMemoryCandidate {
                memory_id: "mem-workbench-confirm",
                scope: MemoryScope::Global,
                content_ref: Some("blob://mem-workbench-confirm"),
                content: Some("User wants precise Friday progress reports."),
                principal_id: Some("owner-real"),
                sensitive: false,
                created_at: 1_780_640_000_200,
            },
        )
        .unwrap();
        attach_memory_candidate_ref(&db, &mission_id, "mem-workbench-confirm", 1_780_640_000_300)
            .unwrap();

        let snapshot = project_workbench(&db, Some(&mission_id)).unwrap();
        let candidates = snapshot
            .get("memoryCandidates")
            .and_then(Value::as_array)
            .expect("memoryCandidates array");
        assert_eq!(
            candidates.len(),
            1,
            "mission links + mission refs point at the same durable memory id and must dedupe"
        );
        assert_eq!(
            candidates[0].get("id").and_then(Value::as_str),
            Some("mem-workbench-confirm"),
            "projection must surface the server-decidable memory_id, not a synthetic display id"
        );
        assert_eq!(
            candidates[0]
                .get("grantsMemoryAuthority")
                .and_then(Value::as_bool),
            Some(false),
            "candidate projection remains review-only until the write decision confirms it"
        );
        assert_ne!(
            candidates[0].get("id").and_then(Value::as_str),
            Some("memory_candidate_mission_x_0")
        );
    }

    #[test]
    fn projects_run_outcome_learning_candidates_from_agent_run_proof_refs() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mission_id = seed_real_producer_mission(&db);
        let mut item = db.get_work_item("autodisp-1781492033").unwrap().unwrap();
        item.status = WorkItemStatus::CompletedWithProof;
        item.proof_receipts = vec!["friday://agent-run/run-a1-projected".into()];
        db.upsert_work_item(&item).unwrap();
        friday_storage::learning_candidate::record_run_outcome_candidates(
            db.conn(),
            "run-a1-projected",
            Some("sess-a1-projected"),
            2,
            1,
            1_780_640_000_100,
        )
        .unwrap();

        let snapshot = project_workbench(&db, Some(&mission_id)).unwrap();
        let candidates = snapshot
            .get("runOutcomeLearningCandidates")
            .and_then(Value::as_array)
            .expect("projection must include runOutcomeLearningCandidates");
        assert_eq!(candidates.len(), 3);
        assert!(candidates.iter().all(|row| {
            row.get("runId").and_then(Value::as_str) == Some("run-a1-projected")
                && row.get("workItemId").and_then(Value::as_str) == Some("autodisp-1781492033")
        }));
        assert!(candidates.iter().all(|row| {
            row.get("evidenceRef")
                .and_then(Value::as_str)
                .is_some_and(|ref_| ref_.starts_with("proof://run-outcome-learning-candidate/"))
        }));
    }

    #[test]
    fn projects_readback_refs_only_when_run_has_real_ledger_or_session_rows() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mission_id = seed_real_producer_mission(&db);
        let run_id = "run-readback-projected";
        let mut item = db.get_work_item("autodisp-1781492033").unwrap().unwrap();
        item.status = WorkItemStatus::CompletedWithProof;
        item.proof_receipts = vec![format!("friday://agent-run/{run_id}")];
        db.upsert_work_item(&item).unwrap();
        db.conn()
            .execute(
                "INSERT INTO token_ledger
                    (ledger_id, session_id, activity_id, provider_kind, model, base_url_host,
                     prompt_tokens, completion_tokens, total_tokens, cost_estimate, fallback,
                     result_link, created_at, run_id)
                 VALUES (?1, ?2, ?3, 'codex', 'gpt-5.5', 'local',
                         10, 5, 15, NULL, 0, NULL, ?4, ?2)",
                params![
                    format!("{run_id}:t0:ledger"),
                    run_id,
                    format!("{run_id}:t0:activity"),
                    1_780_640_000_300_i64
                ],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO agent_session (agent_session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3)",
                params![run_id, 1_780_640_000_200_i64, 1_780_640_000_300_i64],
            )
            .unwrap();

        let snapshot = project_workbench(&db, Some(&mission_id)).unwrap();
        assert_eq!(
            snapshot.get("tokenLedgerRunId").and_then(Value::as_str),
            Some(run_id),
            "Token Ledger must unlock from a real token_ledger row, not from a bare proof ref"
        );
        assert_eq!(
            snapshot.get("agentSessionId").and_then(Value::as_str),
            Some(run_id),
            "Session read arms must unlock only when the agent_session row exists"
        );
    }

    #[test]
    fn projects_run_outcome_learning_candidates_from_answer_produced_proof_refs() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mission_id = seed_real_producer_mission(&db);
        let mut item = db.get_work_item("autodisp-1781492033").unwrap().unwrap();
        item.status = WorkItemStatus::CompletedWithProof;
        item.proof_receipts =
            vec!["proof://outcome/AnswerProduced/run-follow-up-a1?signal=answer_len=572".into()];
        db.upsert_work_item(&item).unwrap();
        friday_storage::learning_candidate::record_run_outcome_candidates(
            db.conn(),
            "run-follow-up-a1",
            Some("run-follow-up-a1"),
            1,
            0,
            1_780_640_000_200,
        )
        .unwrap();

        let snapshot = project_workbench(&db, Some(&mission_id)).unwrap();
        let candidates = snapshot
            .get("runOutcomeLearningCandidates")
            .and_then(Value::as_array)
            .expect("projection must include runOutcomeLearningCandidates");
        assert_eq!(candidates.len(), 3);
        assert!(candidates.iter().all(|row| {
            row.get("runId").and_then(Value::as_str) == Some("run-follow-up-a1")
                && row.get("workItemId").and_then(Value::as_str) == Some("autodisp-1781492033")
        }));
    }

    #[test]
    fn projects_t3_provisioning_status_from_hub_tables_without_raw_device_key() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mission_id = seed_real_producer_mission(&db);
        let device_pubkey = vec![1_u8; 32];
        db.conn()
            .execute(
                "INSERT INTO device_identity
                    (device_id, role, public_key, created_at, display_name)
                 VALUES (?1, 'phone', ?2, ?3, ?4)",
                params![
                    "ios-real-device-1",
                    device_pubkey.clone(),
                    1_780_640_000_010_i64,
                    "Operator phone"
                ],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO trusted_device
                    (device_id, public_key, paired_at, revoked_at, key_rotated_at, sealed_key_ref, label)
                 VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4)",
                params!["ios-real-device-1", device_pubkey, 1_780_640_000_010_i64, "Operator phone"],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO trust_grant
                    (grant_id, agent_id, granted_at, expires_at, revoked, revoked_at, boundaries)
                 VALUES ('grant-t3-1', 'agent-codex', ?1, NULL, 0, NULL, '{}')",
                [1_780_640_000_020_i64],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO context_passport
                    (passport_id, mission_id, work_item_id, destination_lane, destination_target, approved_sensitive, created_at_ms)
                 VALUES ('passport-t3-1', ?1, 'autodisp-1781492033', 'codex', 'codex', 0, ?2)",
                params![mission_id, 1_780_640_000_030_i64],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO context_passport_item
                    (passport_id, seq, kind, label, included, sensitive)
                 VALUES ('passport-t3-1', 0, 'mission_link', 'mission refs', 1, 0)",
                [],
            )
            .unwrap();

        let snapshot = project_workbench(&db, Some(&mission_id)).unwrap();
        let status = snapshot
            .get("t3ProvisioningStatus")
            .and_then(Value::as_object)
            .expect("projection must include T3 provisioning status");
        assert_eq!(
            status.get("truthLabel").and_then(Value::as_str),
            Some("rust_hub_t3_provisioning_read_only_no_mint")
        );
        assert_eq!(status.get("paired").and_then(Value::as_bool), Some(true));
        assert_eq!(
            status.get("activeTrustGrantCount").and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            status.get("contextPassportCount").and_then(Value::as_i64),
            Some(1)
        );
        let latest = status
            .get("latestDevice")
            .and_then(Value::as_object)
            .expect("latest trusted device");
        assert!(latest
            .get("deviceId")
            .and_then(Value::as_str)
            .is_some_and(|value| value.starts_with("proof://device/")));
        let fingerprint = latest
            .get("pubkeyFingerprint")
            .and_then(Value::as_str)
            .expect("redacted public-key fingerprint");
        assert!(fingerprint.contains(':'));
        let rendered = serde_json::to_string(&snapshot).unwrap();
        assert!(!rendered.contains("ios-real-device-1"));
        assert!(
            !rendered.contains("0101010101010101010101010101010101010101010101010101010101010101")
        );
    }

    #[test]
    fn channel_inbound_receipt_projects_as_refs_only_observed_evidence() {
        let mut db = Db::open_hub(&tmp()).unwrap();
        let mission_id = seed_real_producer_mission(&db);
        let redacted = redact_inbound(
            VerifiedInbound {
                channel_id: "tg:raw-room-123".into(),
                sender_id: "raw-sender-456".into(),
                bound_principal_id: "owner-real".into(),
            },
            "hello Friday from me@example.com".into(),
        );
        let receipt = ingest_channel_inbound(
            &mut db,
            &redacted,
            "raw-message-789",
            "message",
            false,
            friday_core::Risk::Low,
            &[],
            1_780_640_000_020,
        )
        .unwrap();
        assert_eq!(receipt.disposition, "recorded");
        assert_eq!(receipt.pii_kinds_redacted, vec!["email"]);
        attach_channel_inbound_receipt(
            &db,
            &mission_id,
            "autodisp-1781492033",
            &receipt,
            1_780_640_000_030,
        )
        .unwrap();

        let snapshot = project_workbench(&db, Some(&mission_id)).unwrap();
        let channel_refs = snapshot
            .get("channelReceiptRefs")
            .and_then(Value::as_array)
            .expect("projection must surface channel receipt refs");
        assert_eq!(channel_refs.len(), 1);
        assert!(channel_refs[0]
            .as_str()
            .is_some_and(|ref_| ref_.starts_with("proof://channel-receipt/")));

        let sections = snapshot
            .get("transcriptSections")
            .and_then(Value::as_array)
            .unwrap();
        let channel_section = sections
            .iter()
            .find(|section| section.get("id").and_then(Value::as_str) == Some("section_channel"))
            .expect("channel section");
        let events = channel_section
            .get("events")
            .and_then(Value::as_array)
            .expect("channel section events");
        let channel_event = events
            .iter()
            .find(|event| event.get("surface").and_then(Value::as_str) == Some("telegram"))
            .expect("telegram channel event");
        assert_eq!(
            channel_event.get("status").and_then(Value::as_str),
            Some("queued")
        );
        assert_eq!(
            channel_event.get("truthLabel").and_then(Value::as_str),
            Some("observed_only")
        );
        assert!(channel_event
            .get("evidenceRefs")
            .and_then(Value::as_object)
            .and_then(|refs| refs.get("channelRef"))
            .and_then(Value::as_str)
            .is_some_and(|ref_| ref_.starts_with("proof://channel-receipt/")));

        let rendered = serde_json::to_string(&snapshot).unwrap();
        for forbidden in [
            "tg:raw-room-123",
            "raw-sender-456",
            "raw-message-789",
            "me@example.com",
            "hello Friday",
            "completed_with_proof",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "channel projection must not leak or overclaim {forbidden}"
            );
        }
    }
}
