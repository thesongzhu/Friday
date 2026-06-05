//! Mission Spine persistence. Hub-only canonical product graph.
//!
//! This stores `FridayConversation -> Mission -> WorkItem -> SurfaceThread /
//! MissionLink`. Provider timelines, channel events, memory decisions, Context
//! Passports, and proofs attach by ref; they do not replace the Mission as the
//! user-facing product identity.

use crate::error::{Result, StorageError};
use friday_core::Risk;
use friday_core::{
    find_duplicate_mission as core_find_duplicate_mission,
    find_duplicate_work_item as core_find_duplicate_work_item, validate_friday_conversation_id,
    ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionLink,
    MissionLinkKind, MissionStatus, MissionSurfaceProjection, RouteDecisionCard,
    RouteDecisionProjection, SurfaceEvent, SurfaceEventKind, SurfaceKind, SurfaceThread,
    TruthStatus, VisibilityPolicy, WorkItem, WorkItemStatus, WorkLane,
};
use rusqlite::{params, Connection, OptionalExtension};

fn unsupported(message: impl Into<String>) -> StorageError {
    StorageError::Unsupported(message.into())
}

fn require_non_empty(value: &str, field: &str) -> Result<()> {
    if value.trim().is_empty() {
        Err(unsupported(format!(
            "mission spine {field} must not be empty"
        )))
    } else {
        Ok(())
    }
}

fn encode_vec(values: &[String], field: &str) -> Result<String> {
    serde_json::to_string(values)
        .map_err(|e| unsupported(format!("failed to encode {field} as json: {e}")))
}

fn decode_vec(value: String, field: &str) -> Result<Vec<String>> {
    serde_json::from_str(&value)
        .map_err(|e| unsupported(format!("failed to decode {field} json: {e}")))
}

fn parse_truth_status(value: String) -> Result<TruthStatus> {
    match value.as_str() {
        "proven" => Ok(TruthStatus::Proven),
        "design_proof" => Ok(TruthStatus::DesignProof),
        "wired_registry" => Ok(TruthStatus::WiredRegistry),
        "NO-GO" => Ok(TruthStatus::NoGo),
        "operator_gated" => Ok(TruthStatus::OperatorGated),
        "external_blocked" => Ok(TruthStatus::ExternalBlocked),
        "historical" => Ok(TruthStatus::Historical),
        _ => Err(unsupported(format!("unknown truth_status '{value}'"))),
    }
}

fn parse_mission_status(value: String) -> Result<MissionStatus> {
    match value.as_str() {
        "active" => Ok(MissionStatus::Active),
        "waiting_for_user" => Ok(MissionStatus::WaitingForUser),
        "blocked" => Ok(MissionStatus::Blocked),
        "paused" => Ok(MissionStatus::Paused),
        "done" => Ok(MissionStatus::Done),
        "archived" => Ok(MissionStatus::Archived),
        "merged" => Ok(MissionStatus::Merged),
        _ => Err(unsupported(format!("unknown mission status '{value}'"))),
    }
}

fn parse_work_lane(value: String) -> Result<WorkLane> {
    match value.as_str() {
        "friday_hub" => Ok(WorkLane::FridayHub),
        "codex" => Ok(WorkLane::Codex),
        "claude" => Ok(WorkLane::Claude),
        "deepseek" => Ok(WorkLane::DeepSeek),
        "workflow" => Ok(WorkLane::Workflow),
        "channel" => Ok(WorkLane::Channel),
        "human" => Ok(WorkLane::Human),
        "future_api" => Ok(WorkLane::FutureApi),
        _ => Err(unsupported(format!("unknown work lane '{value}'"))),
    }
}

fn parse_approval_state(value: String) -> Result<ApprovalState> {
    match value.as_str() {
        "not_required" => Ok(ApprovalState::NotRequired),
        "required" => Ok(ApprovalState::Required),
        "approved" => Ok(ApprovalState::Approved),
        "rejected" => Ok(ApprovalState::Rejected),
        _ => Err(unsupported(format!("unknown approval state '{value}'"))),
    }
}

fn parse_work_item_status(value: String) -> Result<WorkItemStatus> {
    match value.as_str() {
        "draft" => Ok(WorkItemStatus::Draft),
        "preflight_blocked" => Ok(WorkItemStatus::PreflightBlocked),
        "waiting_for_user" => Ok(WorkItemStatus::WaitingForUser),
        "ready_to_dispatch" => Ok(WorkItemStatus::ReadyToDispatch),
        "dispatched" => Ok(WorkItemStatus::Dispatched),
        "hub_accepted" => Ok(WorkItemStatus::HubAccepted),
        "provider_routed" => Ok(WorkItemStatus::ProviderRouted),
        "provider_waiting" => Ok(WorkItemStatus::ProviderWaiting),
        "completed_with_proof" => Ok(WorkItemStatus::CompletedWithProof),
        "failed_retryable" => Ok(WorkItemStatus::FailedRetryable),
        "failed_terminal" => Ok(WorkItemStatus::FailedTerminal),
        "cancelled" => Ok(WorkItemStatus::Cancelled),
        "merged" => Ok(WorkItemStatus::Merged),
        "archived" => Ok(WorkItemStatus::Archived),
        _ => Err(unsupported(format!("unknown work item status '{value}'"))),
    }
}

fn parse_surface_kind(value: String) -> Result<SurfaceKind> {
    match value.as_str() {
        "mobile" => Ok(SurfaceKind::Mobile),
        "desktop" => Ok(SurfaceKind::Desktop),
        "telegram" => Ok(SurfaceKind::Telegram),
        "discord" => Ok(SurfaceKind::Discord),
        "lark" => Ok(SurfaceKind::Lark),
        "web_chat" => Ok(SurfaceKind::WebChat),
        "provider_workspace" => Ok(SurfaceKind::ProviderWorkspace),
        "future_channel" => Ok(SurfaceKind::FutureChannel),
        _ => Err(unsupported(format!("unknown surface kind '{value}'"))),
    }
}

fn parse_visibility_policy(value: String) -> Result<VisibilityPolicy> {
    match value.as_str() {
        "compact" => Ok(VisibilityPolicy::Compact),
        "rich_proof" => Ok(VisibilityPolicy::RichProof),
        "status_only" => Ok(VisibilityPolicy::StatusOnly),
        "hidden_trace_only" => Ok(VisibilityPolicy::HiddenTraceOnly),
        _ => Err(unsupported(format!("unknown visibility policy '{value}'"))),
    }
}

fn parse_surface_event_kind(value: String) -> Result<SurfaceEventKind> {
    match value.as_str() {
        "user_message" => Ok(SurfaceEventKind::UserMessage),
        "friday_reply" => Ok(SurfaceEventKind::FridayReply),
        "system_status" => Ok(SurfaceEventKind::SystemStatus),
        "channel_inbound" => Ok(SurfaceEventKind::ChannelInbound),
        "provider_trace" => Ok(SurfaceEventKind::ProviderTrace),
        "proof_receipt" => Ok(SurfaceEventKind::ProofReceipt),
        "memory_decision" => Ok(SurfaceEventKind::MemoryDecision),
        "needs_me" => Ok(SurfaceEventKind::NeedsMe),
        "handoff" => Ok(SurfaceEventKind::Handoff),
        _ => Err(unsupported(format!("unknown surface event kind '{value}'"))),
    }
}

fn parse_mission_link_kind(value: String) -> Result<MissionLinkKind> {
    match value.as_str() {
        "provider_session" => Ok(MissionLinkKind::ProviderSession),
        "route_decision" => Ok(MissionLinkKind::RouteDecision),
        "provider_timeline" => Ok(MissionLinkKind::ProviderTimeline),
        "channel_inbound" => Ok(MissionLinkKind::ChannelInbound),
        "workflow_run" => Ok(MissionLinkKind::WorkflowRun),
        "memory_candidate" => Ok(MissionLinkKind::MemoryCandidate),
        "memory_decision" => Ok(MissionLinkKind::MemoryDecision),
        "confirmed_memory" => Ok(MissionLinkKind::ConfirmedMemory),
        "context_passport" => Ok(MissionLinkKind::ContextPassport),
        "proof_receipt" => Ok(MissionLinkKind::ProofReceipt),
        "workspace_claim" => Ok(MissionLinkKind::WorkspaceClaim),
        "handoff_artifact" => Ok(MissionLinkKind::HandoffArtifact),
        _ => Err(unsupported(format!("unknown mission link kind '{value}'"))),
    }
}

fn parse_risk(value: String) -> Result<Risk> {
    match value.as_str() {
        "read_only" => Ok(Risk::ReadOnly),
        "low" => Ok(Risk::Low),
        "medium" => Ok(Risk::Medium),
        "high" => Ok(Risk::High),
        "critical" => Ok(Risk::Critical),
        _ => Err(unsupported(format!("unknown risk level '{value}'"))),
    }
}

fn validate_work_item(item: &WorkItem) -> Result<()> {
    item.judgment_memory
        .validate()
        .map_err(|e| unsupported(e.to_string()))?;
    if !item.has_required_ownership_for_workspace_touch() {
        return Err(unsupported(format!(
            "work_item '{}' touches workspace/process refs without ownership_claim_ids",
            item.work_item_id
        )));
    }
    if item.status == WorkItemStatus::CompletedWithProof && item.proof_receipts.is_empty() {
        return Err(unsupported(format!(
            "work_item '{}' cannot be completed_with_proof without proof_receipts",
            item.work_item_id
        )));
    }
    Ok(())
}

fn require_safe_surface_body_ref(value: &str, field: &str) -> Result<()> {
    require_non_empty(value, field)?;
    let trimmed = value.trim();
    if trimmed.starts_with("friday://body/")
        || trimmed.starts_with("friday://surface-event-body/")
        || trimmed.starts_with("blob://")
    {
        Ok(())
    } else {
        Err(unsupported(format!(
            "surface_event {field} must be a Friday-owned body/blob ref"
        )))
    }
}

fn require_safe_surface_proof_ref(value: &str, field: &str) -> Result<()> {
    require_non_empty(value, field)?;
    let trimmed = value.trim();
    if trimmed.starts_with("proof://")
        || trimmed.starts_with("audit://")
        || trimmed.starts_with("friday://proof/")
        || trimmed.starts_with("friday://audit/")
    {
        Ok(())
    } else {
        Err(unsupported(format!(
            "surface_event {field} must be a Friday-owned proof/audit ref"
        )))
    }
}

fn require_safe_lifecycle_proof_ref(value: &str, field: &str) -> Result<()> {
    require_safe_surface_proof_ref(value, field)
}

fn compact_for_summary(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn append_lifecycle_summary(existing: &str, entry: &str) -> String {
    let compact_existing = compact_for_summary(existing);
    let compact_entry = compact_for_summary(entry);
    let joined = if compact_existing.is_empty() {
        compact_entry
    } else {
        format!("{compact_existing} | {compact_entry}")
    };
    const MAX_SUMMARY_BYTES: usize = 2048;
    if joined.len() <= MAX_SUMMARY_BYTES {
        return joined;
    }
    let start = joined.len().saturating_sub(MAX_SUMMARY_BYTES);
    let suffix = joined
        .char_indices()
        .find(|(idx, _)| *idx >= start)
        .map(|(idx, _)| &joined[idx..])
        .unwrap_or(&joined);
    format!("...{suffix}")
}

fn validate_surface_event(conn: &Connection, event: &SurfaceEvent) -> Result<()> {
    validate_friday_conversation_id(&event.friday_conversation_id)
        .map_err(|e| unsupported(e.to_string()))?;
    require_non_empty(&event.surface_event_id, "surface_event_id")?;
    require_non_empty(&event.mission_id, "surface_event.mission_id")?;
    require_non_empty(&event.surface_thread_id, "surface_event.surface_thread_id")?;
    if let Some(work_item_id) = event.work_item_id.as_deref() {
        require_non_empty(work_item_id, "surface_event.work_item_id")?;
    }
    if let Some(body_ref) = event.body_ref.as_deref() {
        require_safe_surface_body_ref(body_ref, "body_ref")?;
    }
    if let Some(proof_ref) = event.proof_ref.as_deref() {
        require_safe_surface_proof_ref(proof_ref, "proof_ref")?;
    }

    let mission = get_mission(conn, &event.mission_id)?.ok_or_else(|| {
        unsupported(format!(
            "surface_event '{}' points to unknown Mission '{}'",
            event.surface_event_id, event.mission_id
        ))
    })?;
    if mission.friday_conversation_id != event.friday_conversation_id {
        return Err(unsupported(format!(
            "surface_event '{}' Mission belongs to conversation '{}' not '{}'",
            event.surface_event_id, mission.friday_conversation_id, event.friday_conversation_id
        )));
    }

    let surface = get_surface_thread(conn, &event.surface_thread_id)?.ok_or_else(|| {
        unsupported(format!(
            "surface_event '{}' points to unknown SurfaceThread '{}'",
            event.surface_event_id, event.surface_thread_id
        ))
    })?;
    if surface.friday_conversation_id != event.friday_conversation_id {
        return Err(unsupported(format!(
            "surface_event '{}' SurfaceThread belongs to conversation '{}' not '{}'",
            event.surface_event_id, surface.friday_conversation_id, event.friday_conversation_id
        )));
    }
    if surface.mission_id.as_deref() != Some(event.mission_id.as_str()) {
        return Err(unsupported(format!(
            "surface_event '{}' SurfaceThread is not bound to Mission '{}'",
            event.surface_event_id, event.mission_id
        )));
    }
    if surface.surface_kind != event.source_surface {
        return Err(unsupported(format!(
            "surface_event '{}' source_surface does not match its SurfaceThread",
            event.surface_event_id
        )));
    }

    if let Some(work_item_id) = event.work_item_id.as_deref() {
        let work_item = get_work_item(conn, work_item_id)?.ok_or_else(|| {
            unsupported(format!(
                "surface_event '{}' points to unknown WorkItem '{}'",
                event.surface_event_id, work_item_id
            ))
        })?;
        if work_item.mission_id != event.mission_id {
            return Err(unsupported(format!(
                "surface_event '{}' WorkItem belongs to Mission '{}' not '{}'",
                event.surface_event_id, work_item.mission_id, event.mission_id
            )));
        }
    }
    Ok(())
}

pub fn upsert_conversation(conn: &Connection, conversation: &FridayConversation) -> Result<()> {
    validate_friday_conversation_id(&conversation.friday_conversation_id)
        .map_err(|e| unsupported(e.to_string()))?;
    require_non_empty(&conversation.owner_principal, "owner_principal")?;
    conn.execute(
        "INSERT INTO friday_conversation
            (friday_conversation_id, owner_principal, title, current_focus_summary,
             active_mission_ids, surface_thread_ids, memory_scope_ref, truth_status,
             proof_refs, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(friday_conversation_id) DO UPDATE SET
            owner_principal = excluded.owner_principal,
            title = excluded.title,
            current_focus_summary = excluded.current_focus_summary,
            active_mission_ids = excluded.active_mission_ids,
            surface_thread_ids = excluded.surface_thread_ids,
            memory_scope_ref = excluded.memory_scope_ref,
            truth_status = excluded.truth_status,
            proof_refs = excluded.proof_refs,
            updated_at_ms = excluded.updated_at_ms",
        params![
            conversation.friday_conversation_id,
            conversation.owner_principal,
            conversation.title,
            conversation.current_focus_summary,
            encode_vec(
                &conversation.active_mission_ids,
                "conversation.active_mission_ids"
            )?,
            encode_vec(
                &conversation.surface_thread_ids,
                "conversation.surface_thread_ids"
            )?,
            conversation.memory_scope_ref,
            conversation.truth_status.as_str(),
            encode_vec(&conversation.proof_refs, "conversation.proof_refs")?,
            conversation.created_at_ms,
            conversation.updated_at_ms,
        ],
    )?;
    Ok(())
}

pub fn get_conversation(
    conn: &Connection,
    friday_conversation_id: &str,
) -> Result<Option<FridayConversation>> {
    conn.query_row(
        "SELECT friday_conversation_id, owner_principal, title, current_focus_summary,
                active_mission_ids, surface_thread_ids, memory_scope_ref, truth_status,
                proof_refs, created_at_ms, updated_at_ms
         FROM friday_conversation
         WHERE friday_conversation_id = ?1",
        [friday_conversation_id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, i64>(9)?,
                r.get::<_, i64>(10)?,
            ))
        },
    )
    .optional()?
    .map(
        |(
            friday_conversation_id,
            owner_principal,
            title,
            current_focus_summary,
            active_mission_ids,
            surface_thread_ids,
            memory_scope_ref,
            truth_status,
            proof_refs,
            created_at_ms,
            updated_at_ms,
        )| {
            Ok(FridayConversation {
                friday_conversation_id,
                owner_principal,
                title,
                current_focus_summary,
                active_mission_ids: decode_vec(
                    active_mission_ids,
                    "conversation.active_mission_ids",
                )?,
                surface_thread_ids: decode_vec(
                    surface_thread_ids,
                    "conversation.surface_thread_ids",
                )?,
                memory_scope_ref,
                truth_status: parse_truth_status(truth_status)?,
                proof_refs: decode_vec(proof_refs, "conversation.proof_refs")?,
                created_at_ms,
                updated_at_ms,
            })
        },
    )
    .transpose()
}

pub fn upsert_mission(conn: &Connection, mission: &Mission) -> Result<()> {
    validate_friday_conversation_id(&mission.friday_conversation_id)
        .map_err(|e| unsupported(e.to_string()))?;
    require_non_empty(&mission.mission_id, "mission_id")?;
    require_non_empty(&mission.intent, "mission.intent")?;
    conn.execute(
        "INSERT INTO mission
            (mission_id, friday_conversation_id, title, intent, status, why_now,
             decision_path_summary, considered_options, deferred_options, known_pitfalls,
             handoff_inheritance, work_item_ids, memory_candidate_refs, context_passport_refs,
             proof_refs, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(mission_id) DO UPDATE SET
            friday_conversation_id = excluded.friday_conversation_id,
            title = excluded.title,
            intent = excluded.intent,
            status = excluded.status,
            why_now = excluded.why_now,
            decision_path_summary = excluded.decision_path_summary,
            considered_options = excluded.considered_options,
            deferred_options = excluded.deferred_options,
            known_pitfalls = excluded.known_pitfalls,
            handoff_inheritance = excluded.handoff_inheritance,
            work_item_ids = excluded.work_item_ids,
            memory_candidate_refs = excluded.memory_candidate_refs,
            context_passport_refs = excluded.context_passport_refs,
            proof_refs = excluded.proof_refs,
            updated_at_ms = excluded.updated_at_ms",
        params![
            mission.mission_id,
            mission.friday_conversation_id,
            mission.title,
            mission.intent,
            mission.status.as_str(),
            mission.why_now,
            mission.decision_path_summary,
            encode_vec(&mission.considered_options, "mission.considered_options")?,
            encode_vec(&mission.deferred_options, "mission.deferred_options")?,
            encode_vec(&mission.known_pitfalls, "mission.known_pitfalls")?,
            encode_vec(&mission.handoff_inheritance, "mission.handoff_inheritance")?,
            encode_vec(&mission.work_item_ids, "mission.work_item_ids")?,
            encode_vec(
                &mission.memory_candidate_refs,
                "mission.memory_candidate_refs"
            )?,
            encode_vec(
                &mission.context_passport_refs,
                "mission.context_passport_refs"
            )?,
            encode_vec(&mission.proof_refs, "mission.proof_refs")?,
            mission.created_at_ms,
            mission.updated_at_ms,
        ],
    )?;
    Ok(())
}

pub fn get_mission(conn: &Connection, mission_id: &str) -> Result<Option<Mission>> {
    mission_by_clause(conn, "WHERE mission_id = ?1", [mission_id]).map(|mut rows| rows.pop())
}

#[allow(clippy::too_many_arguments)]
pub fn transition_mission_status(
    conn: &Connection,
    friday_conversation_id: &str,
    mission_id: &str,
    next_status: MissionStatus,
    actor_ref: &str,
    reason: &str,
    proof_ref: Option<&str>,
    merged_into_mission_id: Option<&str>,
    now_ms: i64,
) -> Result<(Mission, MissionStatus, Vec<String>)> {
    validate_friday_conversation_id(friday_conversation_id)
        .map_err(|e| unsupported(e.to_string()))?;
    require_non_empty(mission_id, "mission_lifecycle.mission_id")?;
    require_non_empty(actor_ref, "mission_lifecycle.actor_ref")?;
    require_non_empty(reason, "mission_lifecycle.reason")?;

    if let Some(proof_ref) = proof_ref {
        require_safe_lifecycle_proof_ref(proof_ref, "proof_ref")?;
    }
    if next_status == MissionStatus::Done && proof_ref.is_none() {
        return Err(unsupported(
            "mission_lifecycle done requires proof_ref so completion is not fake-ready",
        ));
    }
    if next_status == MissionStatus::Merged {
        let Some(target_mission_id) = merged_into_mission_id else {
            return Err(unsupported(
                "mission_lifecycle merged requires merged_into_mission_id",
            ));
        };
        require_non_empty(
            target_mission_id,
            "mission_lifecycle.merged_into_mission_id",
        )?;
        if target_mission_id == mission_id {
            return Err(unsupported(
                "mission_lifecycle cannot merge a Mission into itself",
            ));
        }
        let target = get_mission(conn, target_mission_id)?.ok_or_else(|| {
            unsupported(format!(
                "mission_lifecycle merge target Mission '{target_mission_id}' not found"
            ))
        })?;
        if target.friday_conversation_id != friday_conversation_id {
            return Err(unsupported(format!(
                "mission_lifecycle merge target belongs to conversation '{}' not '{}'",
                target.friday_conversation_id, friday_conversation_id
            )));
        }
        if !target.status.is_active_like() {
            return Err(unsupported(format!(
                "mission_lifecycle merge target Mission '{target_mission_id}' is not active-like"
            )));
        }
    } else if merged_into_mission_id.is_some() {
        return Err(unsupported(
            "mission_lifecycle merged_into_mission_id is only valid for merged status",
        ));
    }

    let mut mission = get_mission(conn, mission_id)?.ok_or_else(|| {
        unsupported(format!(
            "mission_lifecycle Mission '{mission_id}' not found"
        ))
    })?;
    if mission.friday_conversation_id != friday_conversation_id {
        return Err(unsupported(format!(
            "mission_lifecycle Mission belongs to conversation '{}' not '{}'",
            mission.friday_conversation_id, friday_conversation_id
        )));
    }

    let previous_status = mission.status;
    mission.status = previous_status
        .try_transition(next_status)
        .map_err(|e| unsupported(e.to_string()))?;
    mission.updated_at_ms = now_ms;
    if let Some(proof_ref) = proof_ref {
        let proof_ref = proof_ref.to_string();
        if !mission.proof_refs.contains(&proof_ref) {
            mission.proof_refs.push(proof_ref);
        }
    }
    let mut lifecycle_entry = format!(
        "lifecycle:{}:{}->{} by {}: {}",
        mission.mission_id,
        previous_status.as_str(),
        mission.status.as_str(),
        actor_ref,
        reason
    );
    if let Some(target) = merged_into_mission_id {
        lifecycle_entry.push_str(&format!("; merged_into:{target}"));
        let inherited = format!("merged_into_mission_id:{target}");
        if !mission.handoff_inheritance.contains(&inherited) {
            mission.handoff_inheritance.push(inherited);
        }
    }
    mission.decision_path_summary =
        append_lifecycle_summary(&mission.decision_path_summary, &lifecycle_entry);
    upsert_mission(conn, &mission)?;

    let mut conversation = get_conversation(conn, friday_conversation_id)?.ok_or_else(|| {
        unsupported(format!(
            "mission_lifecycle conversation '{friday_conversation_id}' not found"
        ))
    })?;
    if mission.status.is_active_like() {
        if !conversation
            .active_mission_ids
            .iter()
            .any(|id| id == &mission.mission_id)
        {
            conversation
                .active_mission_ids
                .push(mission.mission_id.clone());
        }
    } else {
        conversation
            .active_mission_ids
            .retain(|id| id != &mission.mission_id);
    }
    conversation.updated_at_ms = now_ms;
    upsert_conversation(conn, &conversation)?;

    Ok((mission, previous_status, conversation.active_mission_ids))
}

pub fn list_missions_for_conversation(
    conn: &Connection,
    friday_conversation_id: &str,
) -> Result<Vec<Mission>> {
    mission_by_clause(
        conn,
        "WHERE friday_conversation_id = ?1 ORDER BY updated_at_ms DESC, mission_id",
        [friday_conversation_id],
    )
}

pub fn list_active_missions(conn: &Connection) -> Result<Vec<Mission>> {
    mission_by_clause(
        conn,
        "WHERE status IN ('active', 'waiting_for_user', 'blocked', 'paused')
         ORDER BY updated_at_ms DESC, mission_id",
        [],
    )
}

fn mission_by_clause<const N: usize>(
    conn: &Connection,
    clause: &str,
    params_arr: [&str; N],
) -> Result<Vec<Mission>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT mission_id, friday_conversation_id, title, intent, status, why_now,
                decision_path_summary, considered_options, deferred_options, known_pitfalls,
                handoff_inheritance, work_item_ids, memory_candidate_refs, context_passport_refs,
                proof_refs, created_at_ms, updated_at_ms
         FROM mission {clause}"
    ))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params_arr), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, String>(10)?,
            r.get::<_, String>(11)?,
            r.get::<_, String>(12)?,
            r.get::<_, String>(13)?,
            r.get::<_, String>(14)?,
            r.get::<_, i64>(15)?,
            r.get::<_, i64>(16)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            mission_id,
            friday_conversation_id,
            title,
            intent,
            status,
            why_now,
            decision_path_summary,
            considered_options,
            deferred_options,
            known_pitfalls,
            handoff_inheritance,
            work_item_ids,
            memory_candidate_refs,
            context_passport_refs,
            proof_refs,
            created_at_ms,
            updated_at_ms,
        ) = row?;
        out.push(Mission {
            mission_id,
            friday_conversation_id,
            title,
            intent,
            status: parse_mission_status(status)?,
            why_now,
            decision_path_summary,
            considered_options: decode_vec(considered_options, "mission.considered_options")?,
            deferred_options: decode_vec(deferred_options, "mission.deferred_options")?,
            known_pitfalls: decode_vec(known_pitfalls, "mission.known_pitfalls")?,
            handoff_inheritance: decode_vec(handoff_inheritance, "mission.handoff_inheritance")?,
            work_item_ids: decode_vec(work_item_ids, "mission.work_item_ids")?,
            memory_candidate_refs: decode_vec(
                memory_candidate_refs,
                "mission.memory_candidate_refs",
            )?,
            context_passport_refs: decode_vec(
                context_passport_refs,
                "mission.context_passport_refs",
            )?,
            proof_refs: decode_vec(proof_refs, "mission.proof_refs")?,
            created_at_ms,
            updated_at_ms,
        });
    }
    Ok(out)
}

pub fn find_duplicate_mission(conn: &Connection, candidate: &Mission) -> Result<Option<Mission>> {
    let existing = list_missions_for_conversation(conn, &candidate.friday_conversation_id)?;
    Ok(core_find_duplicate_mission(candidate, &existing).cloned())
}

pub fn upsert_work_item(conn: &Connection, item: &WorkItem) -> Result<()> {
    validate_work_item(item)?;
    require_non_empty(&item.work_item_id, "work_item_id")?;
    require_non_empty(&item.mission_id, "work_item.mission_id")?;
    conn.execute(
        "INSERT INTO work_item
            (work_item_id, mission_id, lane, target_provider_or_agent, status, owner_claim_ids,
             workspace_refs, capability_id, risk_level, approval_state, blocking_reason,
             input_refs, output_refs, proof_requirements, proof_receipts, judgment_task,
             judgment_current_blocker, judgment_target_lane_thread_agent_provider,
             judgment_read_first_files, judgment_required_output, judgment_done_criteria,
             judgment_red_lines, judgment_why_this_route, judgment_considered_options,
             judgment_deferred_options, judgment_previous_pitfalls,
             judgment_inheritable_context, judgment_proof_requirements,
             judgment_ownership_claim_ids, created_at_ms, updated_at_ms)
         VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
             ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31)
         ON CONFLICT(work_item_id) DO UPDATE SET
            mission_id = excluded.mission_id,
            lane = excluded.lane,
            target_provider_or_agent = excluded.target_provider_or_agent,
            status = excluded.status,
            owner_claim_ids = excluded.owner_claim_ids,
            workspace_refs = excluded.workspace_refs,
            capability_id = excluded.capability_id,
            risk_level = excluded.risk_level,
            approval_state = excluded.approval_state,
            blocking_reason = excluded.blocking_reason,
            input_refs = excluded.input_refs,
            output_refs = excluded.output_refs,
            proof_requirements = excluded.proof_requirements,
            proof_receipts = excluded.proof_receipts,
            judgment_task = excluded.judgment_task,
            judgment_current_blocker = excluded.judgment_current_blocker,
            judgment_target_lane_thread_agent_provider =
                excluded.judgment_target_lane_thread_agent_provider,
            judgment_read_first_files = excluded.judgment_read_first_files,
            judgment_required_output = excluded.judgment_required_output,
            judgment_done_criteria = excluded.judgment_done_criteria,
            judgment_red_lines = excluded.judgment_red_lines,
            judgment_why_this_route = excluded.judgment_why_this_route,
            judgment_considered_options = excluded.judgment_considered_options,
            judgment_deferred_options = excluded.judgment_deferred_options,
            judgment_previous_pitfalls = excluded.judgment_previous_pitfalls,
            judgment_inheritable_context = excluded.judgment_inheritable_context,
            judgment_proof_requirements = excluded.judgment_proof_requirements,
            judgment_ownership_claim_ids = excluded.judgment_ownership_claim_ids,
            updated_at_ms = excluded.updated_at_ms",
        params![
            item.work_item_id,
            item.mission_id,
            item.lane.as_str(),
            item.target_provider_or_agent,
            item.status.as_str(),
            encode_vec(&item.owner_claim_ids, "work_item.owner_claim_ids")?,
            encode_vec(&item.workspace_refs, "work_item.workspace_refs")?,
            item.capability_id,
            item.risk_level.as_str(),
            item.approval_state.as_str(),
            item.blocking_reason,
            encode_vec(&item.input_refs, "work_item.input_refs")?,
            encode_vec(&item.output_refs, "work_item.output_refs")?,
            encode_vec(&item.proof_requirements, "work_item.proof_requirements")?,
            encode_vec(&item.proof_receipts, "work_item.proof_receipts")?,
            item.judgment_memory.task,
            item.judgment_memory.current_blocker,
            item.judgment_memory.target_lane_thread_agent_provider,
            encode_vec(
                &item.judgment_memory.read_first_files,
                "work_item.judgment.read_first_files",
            )?,
            item.judgment_memory.required_output,
            encode_vec(
                &item.judgment_memory.done_criteria,
                "work_item.judgment.done_criteria",
            )?,
            encode_vec(
                &item.judgment_memory.red_lines,
                "work_item.judgment.red_lines"
            )?,
            item.judgment_memory.why_this_route,
            encode_vec(
                &item.judgment_memory.considered_options,
                "work_item.judgment.considered_options",
            )?,
            encode_vec(
                &item.judgment_memory.deferred_options,
                "work_item.judgment.deferred_options",
            )?,
            encode_vec(
                &item.judgment_memory.previous_pitfalls,
                "work_item.judgment.previous_pitfalls",
            )?,
            encode_vec(
                &item.judgment_memory.inheritable_context,
                "work_item.judgment.inheritable_context",
            )?,
            encode_vec(
                &item.judgment_memory.proof_requirements,
                "work_item.judgment.proof_requirements",
            )?,
            encode_vec(
                &item.judgment_memory.ownership_claim_ids,
                "work_item.judgment.ownership_claim_ids",
            )?,
            item.created_at_ms,
            item.updated_at_ms,
        ],
    )?;
    Ok(())
}

pub fn get_work_item(conn: &Connection, work_item_id: &str) -> Result<Option<WorkItem>> {
    work_items_by_clause(conn, "WHERE work_item_id = ?1", [work_item_id]).map(|mut rows| rows.pop())
}

pub fn list_work_items_for_mission(conn: &Connection, mission_id: &str) -> Result<Vec<WorkItem>> {
    work_items_by_clause(
        conn,
        "WHERE mission_id = ?1 ORDER BY updated_at_ms DESC, work_item_id",
        [mission_id],
    )
}

pub fn list_active_work_items(conn: &Connection) -> Result<Vec<WorkItem>> {
    work_items_by_clause(
        conn,
        "WHERE status NOT IN ('completed_with_proof', 'failed_terminal', 'cancelled', 'merged', 'archived')
         ORDER BY updated_at_ms DESC, work_item_id",
        [],
    )
}

fn work_items_by_clause<const N: usize>(
    conn: &Connection,
    clause: &str,
    params_arr: [&str; N],
) -> Result<Vec<WorkItem>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT work_item_id, mission_id, lane, target_provider_or_agent, status,
                owner_claim_ids, workspace_refs, capability_id, risk_level, approval_state,
                blocking_reason, input_refs, output_refs, proof_requirements, proof_receipts,
                judgment_task, judgment_current_blocker,
                judgment_target_lane_thread_agent_provider, judgment_read_first_files,
                judgment_required_output, judgment_done_criteria, judgment_red_lines,
                judgment_why_this_route, judgment_considered_options, judgment_deferred_options,
                judgment_previous_pitfalls, judgment_inheritable_context,
                judgment_proof_requirements, judgment_ownership_claim_ids,
                created_at_ms, updated_at_ms
         FROM work_item {clause}"
    ))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params_arr), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, Option<String>>(10)?,
            r.get::<_, String>(11)?,
            r.get::<_, String>(12)?,
            r.get::<_, String>(13)?,
            r.get::<_, String>(14)?,
            r.get::<_, String>(15)?,
            r.get::<_, Option<String>>(16)?,
            r.get::<_, String>(17)?,
            r.get::<_, String>(18)?,
            r.get::<_, String>(19)?,
            r.get::<_, String>(20)?,
            r.get::<_, String>(21)?,
            r.get::<_, String>(22)?,
            r.get::<_, String>(23)?,
            r.get::<_, String>(24)?,
            r.get::<_, String>(25)?,
            r.get::<_, String>(26)?,
            r.get::<_, String>(27)?,
            r.get::<_, String>(28)?,
            r.get::<_, i64>(29)?,
            r.get::<_, i64>(30)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            work_item_id,
            mission_id,
            lane,
            target_provider_or_agent,
            status,
            owner_claim_ids,
            workspace_refs,
            capability_id,
            risk_level,
            approval_state,
            blocking_reason,
            input_refs,
            output_refs,
            proof_requirements,
            proof_receipts,
            judgment_task,
            judgment_current_blocker,
            judgment_target,
            judgment_read_first_files,
            judgment_required_output,
            judgment_done_criteria,
            judgment_red_lines,
            judgment_why_this_route,
            judgment_considered_options,
            judgment_deferred_options,
            judgment_previous_pitfalls,
            judgment_inheritable_context,
            judgment_proof_requirements,
            judgment_ownership_claim_ids,
            created_at_ms,
            updated_at_ms,
        ) = row?;
        out.push(WorkItem {
            work_item_id,
            mission_id,
            lane: parse_work_lane(lane)?,
            target_provider_or_agent,
            status: parse_work_item_status(status)?,
            owner_claim_ids: decode_vec(owner_claim_ids, "work_item.owner_claim_ids")?,
            workspace_refs: decode_vec(workspace_refs, "work_item.workspace_refs")?,
            capability_id,
            risk_level: parse_risk(risk_level)?,
            approval_state: parse_approval_state(approval_state)?,
            blocking_reason,
            input_refs: decode_vec(input_refs, "work_item.input_refs")?,
            output_refs: decode_vec(output_refs, "work_item.output_refs")?,
            proof_requirements: decode_vec(proof_requirements, "work_item.proof_requirements")?,
            proof_receipts: decode_vec(proof_receipts, "work_item.proof_receipts")?,
            judgment_memory: HandoffJudgmentMemory {
                task: judgment_task,
                current_blocker: judgment_current_blocker,
                target_lane_thread_agent_provider: judgment_target,
                read_first_files: decode_vec(
                    judgment_read_first_files,
                    "work_item.judgment.read_first_files",
                )?,
                required_output: judgment_required_output,
                done_criteria: decode_vec(
                    judgment_done_criteria,
                    "work_item.judgment.done_criteria",
                )?,
                red_lines: decode_vec(judgment_red_lines, "work_item.judgment.red_lines")?,
                why_this_route: judgment_why_this_route,
                considered_options: decode_vec(
                    judgment_considered_options,
                    "work_item.judgment.considered_options",
                )?,
                deferred_options: decode_vec(
                    judgment_deferred_options,
                    "work_item.judgment.deferred_options",
                )?,
                previous_pitfalls: decode_vec(
                    judgment_previous_pitfalls,
                    "work_item.judgment.previous_pitfalls",
                )?,
                inheritable_context: decode_vec(
                    judgment_inheritable_context,
                    "work_item.judgment.inheritable_context",
                )?,
                proof_requirements: decode_vec(
                    judgment_proof_requirements,
                    "work_item.judgment.proof_requirements",
                )?,
                ownership_claim_ids: decode_vec(
                    judgment_ownership_claim_ids,
                    "work_item.judgment.ownership_claim_ids",
                )?,
            },
            created_at_ms,
            updated_at_ms,
        });
    }
    Ok(out)
}

pub fn find_duplicate_work_item(
    conn: &Connection,
    candidate: &WorkItem,
) -> Result<Option<WorkItem>> {
    let existing = list_work_items_for_mission(conn, &candidate.mission_id)?;
    Ok(core_find_duplicate_work_item(candidate, &existing).cloned())
}

pub fn upsert_surface_thread(conn: &Connection, surface_thread: &SurfaceThread) -> Result<()> {
    validate_friday_conversation_id(&surface_thread.friday_conversation_id)
        .map_err(|e| unsupported(e.to_string()))?;
    require_non_empty(&surface_thread.surface_thread_id, "surface_thread_id")?;
    require_non_empty(
        &surface_thread.delivery_route,
        "surface_thread.delivery_route",
    )?;
    let last_delivered_event_seq = surface_thread
        .last_delivered_event_seq
        .map(i64::try_from)
        .transpose()
        .map_err(|_| unsupported("surface_thread.last_delivered_event_seq exceeds i64"))?;
    conn.execute(
        "INSERT INTO surface_thread
            (surface_thread_id, friday_conversation_id, mission_id, surface_kind,
             channel_binding_id, delivery_route, visibility_policy, allowed_actions,
             last_seen_at_ms, last_delivered_event_seq, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(surface_thread_id) DO UPDATE SET
            friday_conversation_id = excluded.friday_conversation_id,
            mission_id = excluded.mission_id,
            surface_kind = excluded.surface_kind,
            channel_binding_id = excluded.channel_binding_id,
            delivery_route = excluded.delivery_route,
            visibility_policy = excluded.visibility_policy,
            allowed_actions = excluded.allowed_actions,
            last_seen_at_ms = excluded.last_seen_at_ms,
            last_delivered_event_seq = excluded.last_delivered_event_seq,
            updated_at_ms = excluded.updated_at_ms",
        params![
            surface_thread.surface_thread_id,
            surface_thread.friday_conversation_id,
            surface_thread.mission_id,
            surface_thread.surface_kind.as_str(),
            surface_thread.channel_binding_id,
            surface_thread.delivery_route,
            surface_thread.visibility_policy.as_str(),
            encode_vec(
                &surface_thread.allowed_actions,
                "surface_thread.allowed_actions"
            )?,
            surface_thread.last_seen_at_ms,
            last_delivered_event_seq,
            surface_thread.created_at_ms,
            surface_thread.updated_at_ms,
        ],
    )?;
    Ok(())
}

pub fn get_surface_thread(
    conn: &Connection,
    surface_thread_id: &str,
) -> Result<Option<SurfaceThread>> {
    conn.query_row(
        "SELECT surface_thread_id, friday_conversation_id, mission_id, surface_kind,
                channel_binding_id, delivery_route, visibility_policy, allowed_actions,
                last_seen_at_ms, last_delivered_event_seq, created_at_ms, updated_at_ms
         FROM surface_thread
         WHERE surface_thread_id = ?1",
        [surface_thread_id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, Option<i64>>(8)?,
                r.get::<_, Option<i64>>(9)?,
                r.get::<_, i64>(10)?,
                r.get::<_, i64>(11)?,
            ))
        },
    )
    .optional()?
    .map(
        |(
            surface_thread_id,
            friday_conversation_id,
            mission_id,
            surface_kind,
            channel_binding_id,
            delivery_route,
            visibility_policy,
            allowed_actions,
            last_seen_at_ms,
            last_delivered_event_seq,
            created_at_ms,
            updated_at_ms,
        )| {
            Ok(SurfaceThread {
                surface_thread_id,
                friday_conversation_id,
                mission_id,
                surface_kind: parse_surface_kind(surface_kind)?,
                channel_binding_id,
                delivery_route,
                visibility_policy: parse_visibility_policy(visibility_policy)?,
                allowed_actions: decode_vec(allowed_actions, "surface_thread.allowed_actions")?,
                last_seen_at_ms,
                last_delivered_event_seq: last_delivered_event_seq.map(|v| v as u64),
                created_at_ms,
                updated_at_ms,
            })
        },
    )
    .transpose()
}

pub fn upsert_surface_event(conn: &Connection, event: &SurfaceEvent) -> Result<()> {
    validate_surface_event(conn, event)?;
    conn.execute(
        "INSERT INTO surface_event
            (surface_event_id, friday_conversation_id, mission_id, work_item_id,
             surface_thread_id, source_surface, event_kind, body_ref, visibility_policy,
             proof_ref, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(surface_event_id) DO UPDATE SET
            friday_conversation_id = excluded.friday_conversation_id,
            mission_id = excluded.mission_id,
            work_item_id = excluded.work_item_id,
            surface_thread_id = excluded.surface_thread_id,
            source_surface = excluded.source_surface,
            event_kind = excluded.event_kind,
            body_ref = excluded.body_ref,
            visibility_policy = excluded.visibility_policy,
            proof_ref = excluded.proof_ref,
            created_at_ms = excluded.created_at_ms",
        params![
            event.surface_event_id.as_str(),
            event.friday_conversation_id.as_str(),
            event.mission_id.as_str(),
            event.work_item_id.as_deref(),
            event.surface_thread_id.as_str(),
            event.source_surface.as_str(),
            event.event_kind.as_str(),
            event.body_ref.as_deref(),
            event.visibility_policy.as_str(),
            event.proof_ref.as_deref(),
            event.created_at_ms,
        ],
    )?;
    Ok(())
}

pub fn list_surface_events_for_mission(
    conn: &Connection,
    mission_id: &str,
) -> Result<Vec<SurfaceEvent>> {
    surface_events_by_clause(
        conn,
        "WHERE mission_id = ?1 ORDER BY created_at_ms, surface_event_id",
        [mission_id],
    )
}

pub fn list_surface_events_for_conversation(
    conn: &Connection,
    friday_conversation_id: &str,
) -> Result<Vec<SurfaceEvent>> {
    surface_events_by_clause(
        conn,
        "WHERE friday_conversation_id = ?1 ORDER BY created_at_ms, surface_event_id",
        [friday_conversation_id],
    )
}

fn surface_events_by_clause<const N: usize>(
    conn: &Connection,
    clause: &str,
    params_arr: [&str; N],
) -> Result<Vec<SurfaceEvent>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT surface_event_id, friday_conversation_id, mission_id, work_item_id,
                surface_thread_id, source_surface, event_kind, body_ref,
                visibility_policy, proof_ref, created_at_ms
         FROM surface_event {clause}"
    ))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params_arr), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, Option<String>>(9)?,
            r.get::<_, i64>(10)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            surface_event_id,
            friday_conversation_id,
            mission_id,
            work_item_id,
            surface_thread_id,
            source_surface,
            event_kind,
            body_ref,
            visibility_policy,
            proof_ref,
            created_at_ms,
        ) = row?;
        out.push(SurfaceEvent {
            surface_event_id,
            friday_conversation_id,
            mission_id,
            work_item_id,
            surface_thread_id,
            source_surface: parse_surface_kind(source_surface)?,
            event_kind: parse_surface_event_kind(event_kind)?,
            body_ref,
            visibility_policy: parse_visibility_policy(visibility_policy)?,
            proof_ref,
            created_at_ms,
        });
    }
    Ok(out)
}

pub fn upsert_mission_link(conn: &Connection, link: &MissionLink) -> Result<()> {
    require_non_empty(&link.link_id, "mission_link.link_id")?;
    require_non_empty(&link.mission_id, "mission_link.mission_id")?;
    require_non_empty(&link.target_ref, "mission_link.target_ref")?;
    conn.execute(
        "INSERT INTO mission_link
            (link_id, mission_id, work_item_id, link_kind, target_ref, proof_ref, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(link_id) DO UPDATE SET
            mission_id = excluded.mission_id,
            work_item_id = excluded.work_item_id,
            link_kind = excluded.link_kind,
            target_ref = excluded.target_ref,
            proof_ref = excluded.proof_ref",
        params![
            link.link_id,
            link.mission_id,
            link.work_item_id,
            link.link_kind.as_str(),
            link.target_ref,
            link.proof_ref,
            link.created_at_ms,
        ],
    )?;
    Ok(())
}

pub fn list_mission_links(conn: &Connection, mission_id: &str) -> Result<Vec<MissionLink>> {
    let mut stmt = conn.prepare(
        "SELECT link_id, mission_id, work_item_id, link_kind, target_ref, proof_ref, created_at_ms
         FROM mission_link
         WHERE mission_id = ?1
         ORDER BY created_at_ms, link_id",
    )?;
    let rows = stmt.query_map([mission_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, i64>(6)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (link_id, mission_id, work_item_id, link_kind, target_ref, proof_ref, created_at_ms) =
            row?;
        out.push(MissionLink {
            link_id,
            mission_id,
            work_item_id,
            link_kind: parse_mission_link_kind(link_kind)?,
            target_ref,
            proof_ref,
            created_at_ms,
        });
    }
    Ok(out)
}

pub fn upsert_route_decision(conn: &Connection, card: &RouteDecisionCard) -> Result<()> {
    card.validate().map_err(|e| unsupported(e.to_string()))?;
    let work_item_mission_id: Option<String> = conn
        .query_row(
            "SELECT mission_id FROM work_item WHERE work_item_id = ?1",
            [&card.work_item_id],
            |r| r.get(0),
        )
        .optional()?;
    match work_item_mission_id {
        Some(mission_id) if mission_id == card.mission_id => {}
        Some(mission_id) => {
            return Err(unsupported(format!(
                "route_decision '{}' WorkItem belongs to mission '{}' not '{}'",
                card.decision_id, mission_id, card.mission_id
            )));
        }
        None => {
            return Err(unsupported(format!(
                "route_decision '{}' points to unknown WorkItem '{}'",
                card.decision_id, card.work_item_id
            )));
        }
    }
    conn.execute(
        "INSERT INTO route_decision
            (decision_id, mission_id, work_item_id, selected_lane,
             selected_provider_or_agent, why_this_route, considered_options,
             deferred_options, previous_pitfalls, inheritable_context,
             conflict_refs, proof_requirements, ownership_claim_ids, trace_refs,
             created_at_ms, expires_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(decision_id) DO UPDATE SET
            mission_id = excluded.mission_id,
            work_item_id = excluded.work_item_id,
            selected_lane = excluded.selected_lane,
            selected_provider_or_agent = excluded.selected_provider_or_agent,
            why_this_route = excluded.why_this_route,
            considered_options = excluded.considered_options,
            deferred_options = excluded.deferred_options,
            previous_pitfalls = excluded.previous_pitfalls,
            inheritable_context = excluded.inheritable_context,
            conflict_refs = excluded.conflict_refs,
            proof_requirements = excluded.proof_requirements,
            ownership_claim_ids = excluded.ownership_claim_ids,
            trace_refs = excluded.trace_refs,
            created_at_ms = excluded.created_at_ms,
            expires_at_ms = excluded.expires_at_ms",
        params![
            card.decision_id.as_str(),
            card.mission_id.as_str(),
            card.work_item_id.as_str(),
            card.selected_lane.as_str(),
            card.selected_provider_or_agent.as_deref(),
            card.why_this_route.as_str(),
            encode_vec(
                &card.considered_options,
                "route_decision.considered_options"
            )?,
            encode_vec(&card.deferred_options, "route_decision.deferred_options")?,
            encode_vec(&card.previous_pitfalls, "route_decision.previous_pitfalls")?,
            encode_vec(
                &card.inheritable_context,
                "route_decision.inheritable_context"
            )?,
            encode_vec(&card.conflict_refs, "route_decision.conflict_refs")?,
            encode_vec(
                &card.proof_requirements,
                "route_decision.proof_requirements"
            )?,
            encode_vec(
                &card.ownership_claim_ids,
                "route_decision.ownership_claim_ids"
            )?,
            encode_vec(&card.trace_refs, "route_decision.trace_refs")?,
            card.created_at_ms,
            card.expires_at_ms,
        ],
    )?;
    upsert_mission_link(
        conn,
        &MissionLink {
            link_id: format!("route-decision-link:{}", card.decision_id),
            mission_id: card.mission_id.clone(),
            work_item_id: Some(card.work_item_id.clone()),
            link_kind: MissionLinkKind::RouteDecision,
            target_ref: card.route_decision_ref(),
            proof_ref: None,
            created_at_ms: card.created_at_ms,
        },
    )
}

pub fn get_route_decision(
    conn: &Connection,
    decision_id: &str,
) -> Result<Option<RouteDecisionCard>> {
    let row = conn
        .query_row(
            "SELECT decision_id, mission_id, work_item_id, selected_lane,
                    selected_provider_or_agent, why_this_route, considered_options,
                    deferred_options, previous_pitfalls, inheritable_context,
                    conflict_refs, proof_requirements, ownership_claim_ids, trace_refs,
                    created_at_ms, expires_at_ms
             FROM route_decision
             WHERE decision_id = ?1",
            [decision_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, String>(9)?,
                    r.get::<_, String>(10)?,
                    r.get::<_, String>(11)?,
                    r.get::<_, String>(12)?,
                    r.get::<_, String>(13)?,
                    r.get::<_, i64>(14)?,
                    r.get::<_, Option<i64>>(15)?,
                ))
            },
        )
        .optional()?;
    row.map(route_decision_from_row).transpose()
}

pub fn list_route_decisions_for_mission(
    conn: &Connection,
    mission_id: &str,
) -> Result<Vec<RouteDecisionCard>> {
    let mut stmt = conn.prepare(
        "SELECT decision_id, mission_id, work_item_id, selected_lane,
                selected_provider_or_agent, why_this_route, considered_options,
                deferred_options, previous_pitfalls, inheritable_context,
                conflict_refs, proof_requirements, ownership_claim_ids, trace_refs,
                created_at_ms, expires_at_ms
         FROM route_decision
         WHERE mission_id = ?1
         ORDER BY created_at_ms, decision_id",
    )?;
    let rows = stmt.query_map([mission_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, String>(10)?,
            r.get::<_, String>(11)?,
            r.get::<_, String>(12)?,
            r.get::<_, String>(13)?,
            r.get::<_, i64>(14)?,
            r.get::<_, Option<i64>>(15)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(route_decision_from_row(row?)?);
    }
    Ok(out)
}

pub fn list_route_decision_projections_for_mission(
    conn: &Connection,
    mission_id: &str,
) -> Result<Vec<RouteDecisionProjection>> {
    Ok(list_route_decisions_for_mission(conn, mission_id)?
        .into_iter()
        .map(|card| card.to_projection())
        .collect())
}

#[allow(clippy::type_complexity)]
fn route_decision_from_row(
    row: (
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        Option<i64>,
    ),
) -> Result<RouteDecisionCard> {
    let (
        decision_id,
        mission_id,
        work_item_id,
        selected_lane,
        selected_provider_or_agent,
        why_this_route,
        considered_options,
        deferred_options,
        previous_pitfalls,
        inheritable_context,
        conflict_refs,
        proof_requirements,
        ownership_claim_ids,
        trace_refs,
        created_at_ms,
        expires_at_ms,
    ) = row;
    let card = RouteDecisionCard {
        decision_id,
        mission_id,
        work_item_id,
        selected_lane: parse_work_lane(selected_lane)?,
        selected_provider_or_agent,
        why_this_route,
        considered_options: decode_vec(considered_options, "route_decision.considered_options")?,
        deferred_options: decode_vec(deferred_options, "route_decision.deferred_options")?,
        previous_pitfalls: decode_vec(previous_pitfalls, "route_decision.previous_pitfalls")?,
        inheritable_context: decode_vec(inheritable_context, "route_decision.inheritable_context")?,
        conflict_refs: decode_vec(conflict_refs, "route_decision.conflict_refs")?,
        proof_requirements: decode_vec(proof_requirements, "route_decision.proof_requirements")?,
        ownership_claim_ids: decode_vec(ownership_claim_ids, "route_decision.ownership_claim_ids")?,
        trace_refs: decode_vec(trace_refs, "route_decision.trace_refs")?,
        created_at_ms,
        expires_at_ms,
    };
    card.validate().map_err(|e| unsupported(e.to_string()))?;
    Ok(card)
}

/// Redacted surface projections keyed by Friday conversation/mission, not by
/// provider thread id or channel chat id.
pub fn list_mission_surface_projections(
    conn: &Connection,
    friday_conversation_id: &str,
) -> Result<Vec<MissionSurfaceProjection>> {
    let mut stmt = conn.prepare(
        "SELECT st.surface_thread_id, st.friday_conversation_id, st.mission_id,
                st.surface_kind, st.visibility_policy, m.title, m.status,
                fc.truth_status, fc.current_focus_summary, m.proof_refs,
                MAX(st.updated_at_ms, m.updated_at_ms, fc.updated_at_ms)
         FROM surface_thread st
         JOIN mission m ON m.mission_id = st.mission_id
         JOIN friday_conversation fc
              ON fc.friday_conversation_id = st.friday_conversation_id
         WHERE st.friday_conversation_id = ?1
           AND st.mission_id IS NOT NULL
         ORDER BY m.updated_at_ms DESC, st.surface_kind, st.surface_thread_id",
    )?;
    let rows = stmt.query_map([friday_conversation_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, i64>(10)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            surface_thread_id,
            friday_conversation_id,
            mission_id,
            surface_kind,
            visibility_policy,
            title,
            status,
            truth_status,
            current_focus_summary,
            proof_refs,
            updated_at_ms,
        ) = row?;
        out.push(MissionSurfaceProjection {
            surface_thread_id,
            friday_conversation_id,
            mission_id,
            surface_kind: parse_surface_kind(surface_kind)?,
            visibility_policy: parse_visibility_policy(visibility_policy)?,
            title,
            status: parse_mission_status(status)?,
            truth_status: parse_truth_status(truth_status)?,
            current_focus_summary,
            proof_refs: decode_vec(proof_refs, "mission.proof_refs")?,
            updated_at_ms,
        });
    }
    Ok(out)
}
