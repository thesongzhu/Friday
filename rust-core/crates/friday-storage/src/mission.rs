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
    find_duplicate_work_item as core_find_duplicate_work_item, outcome_checked_proof_enabled,
    parse_outcome_receipt, validate_friday_conversation_id, ApprovalState, FridayConversation,
    HandoffJudgmentMemory, Mission, MissionLink, MissionLinkKind, MissionStatus,
    MissionSurfaceProjection, ProofRequirementKind, RouteActionItem, RouteActionReversibility,
    RouteActionTargetKind, RouteDecisionCard, RouteDecisionProjection, SurfaceEvent,
    SurfaceEventKind, SurfaceKind, SurfaceThread, TruthStatus, VisibilityPolicy, WorkItem,
    WorkItemStatus, WorkLane,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};

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

fn ref_id_part(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

#[derive(Debug)]
struct ActiveRouteDecisionControl {
    decision_id: String,
    control_kind: String,
    override_lane: Option<WorkLane>,
    override_provider_or_agent: Option<String>,
    reason: String,
}

pub struct DeferredRouteFollowUpRequest<'a> {
    pub decision_id: &'a str,
    pub source_work_item_id: &'a str,
    pub follow_up_work_item_id: &'a str,
    pub follow_up_lane: WorkLane,
    pub follow_up_provider_or_agent: Option<&'a str>,
    pub actor_ref: &'a str,
    pub reason: &'a str,
    pub now_ms: i64,
}

fn encode_vec(values: &[String], field: &str) -> Result<String> {
    serde_json::to_string(values)
        .map_err(|e| unsupported(format!("failed to encode {field} as json: {e}")))
}

fn decode_vec(value: String, field: &str) -> Result<Vec<String>> {
    serde_json::from_str(&value)
        .map_err(|e| unsupported(format!("failed to decode {field} json: {e}")))
}

fn encode_route_action_items(values: &[RouteActionItem], field: &str) -> Result<String> {
    let items = values
        .iter()
        .map(|item| {
            serde_json::json!({
                "description": item.description,
                "target_kind": item.target_kind.as_str(),
                "target_ref": item.target_ref,
                "reversibility": item.reversibility.as_str(),
                "assigned_lane": item.assigned_lane.as_str(),
                "assigned_provider_or_agent": item.assigned_provider_or_agent,
                "route_reason": item.route_reason,
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&items)
        .map_err(|e| unsupported(format!("failed to encode {field} as json: {e}")))
}

fn decode_route_action_items(value: String, field: &str) -> Result<Vec<RouteActionItem>> {
    let values = serde_json::from_str::<Vec<serde_json::Value>>(&value)
        .map_err(|e| unsupported(format!("failed to decode {field} json: {e}")))?;
    values
        .into_iter()
        .enumerate()
        .map(|(index, value)| decode_route_action_item(value, field, index))
        .collect()
}

fn decode_route_action_item(
    value: serde_json::Value,
    field: &str,
    index: usize,
) -> Result<RouteActionItem> {
    let object = value
        .as_object()
        .ok_or_else(|| unsupported(format!("{field}[{index}] must be a route action object")))?;
    let assigned_provider_or_agent = match object.get("assigned_provider_or_agent") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => Some(json_string(
            value,
            field,
            index,
            "assigned_provider_or_agent",
        )?),
    };
    Ok(RouteActionItem {
        description: json_string(
            object
                .get("description")
                .ok_or_else(|| missing_json_field(field, index, "description"))?,
            field,
            index,
            "description",
        )?,
        target_kind: parse_route_action_target_kind(&json_string(
            object
                .get("target_kind")
                .ok_or_else(|| missing_json_field(field, index, "target_kind"))?,
            field,
            index,
            "target_kind",
        )?)?,
        target_ref: json_string(
            object
                .get("target_ref")
                .ok_or_else(|| missing_json_field(field, index, "target_ref"))?,
            field,
            index,
            "target_ref",
        )?,
        reversibility: parse_route_action_reversibility(&json_string(
            object
                .get("reversibility")
                .ok_or_else(|| missing_json_field(field, index, "reversibility"))?,
            field,
            index,
            "reversibility",
        )?)?,
        assigned_lane: parse_work_lane(json_string(
            object
                .get("assigned_lane")
                .ok_or_else(|| missing_json_field(field, index, "assigned_lane"))?,
            field,
            index,
            "assigned_lane",
        )?)?,
        assigned_provider_or_agent,
        route_reason: json_string(
            object
                .get("route_reason")
                .ok_or_else(|| missing_json_field(field, index, "route_reason"))?,
            field,
            index,
            "route_reason",
        )?,
    })
}

fn json_string(
    value: &serde_json::Value,
    field: &str,
    index: usize,
    child: &str,
) -> Result<String> {
    value
        .as_str()
        .map(ToString::to_string)
        .ok_or_else(|| unsupported(format!("{field}[{index}].{child} must be a string")))
}

fn missing_json_field(field: &str, index: usize, child: &str) -> StorageError {
    unsupported(format!("{field}[{index}].{child} is required"))
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

fn parse_route_action_target_kind(value: &str) -> Result<RouteActionTargetKind> {
    match value {
        "file" => Ok(RouteActionTargetKind::File),
        "command" => Ok(RouteActionTargetKind::Command),
        "subtask" => Ok(RouteActionTargetKind::Subtask),
        _ => Err(unsupported(format!(
            "unknown route action target kind '{value}'"
        ))),
    }
}

fn parse_route_action_reversibility(value: &str) -> Result<RouteActionReversibility> {
    match value {
        "reversible_git_worktree" => Ok(RouteActionReversibility::ReversibleGitWorktree),
        "operator_gate_required" => Ok(RouteActionReversibility::OperatorGateRequired),
        "pending_classify" => Ok(RouteActionReversibility::PendingClassify),
        _ => Err(unsupported(format!(
            "unknown route action reversibility '{value}'"
        ))),
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
    if item.status == WorkItemStatus::CompletedWithProof
        && outcome_checked_proof_enabled()
        && item.has_outcome_proof_requirements()
        && !item.completion_outcome_is_proven()
    {
        return Err(unsupported(format!(
            "work_item '{}' outcome-checked completion requires a typed outcome proof receipt matching every outcome proof requirement",
            item.work_item_id
        )));
    }
    Ok(())
}

fn validate_work_item_outcome_receipts(conn: &Connection, item: &WorkItem) -> Result<()> {
    if item.status != WorkItemStatus::CompletedWithProof
        || !outcome_checked_proof_enabled()
        || !item.has_outcome_proof_requirements()
    {
        return Ok(());
    }
    if !item.completion_outcome_is_proven() {
        return Err(unsupported(format!(
            "work_item '{}' outcome-checked completion requires a typed outcome proof receipt matching every outcome proof requirement",
            item.work_item_id
        )));
    }
    for requirement in item.outcome_requirement_specs() {
        if requirement.kind != ProofRequirementKind::AnswerProduced {
            continue;
        }
        for receipt in &item.proof_receipts {
            let Some(receipt) = parse_outcome_receipt(receipt) else {
                continue;
            };
            if receipt.kind != ProofRequirementKind::AnswerProduced {
                continue;
            }
            let Some(answer_len) = outcome_signal_field(&receipt.signal, "answer_len")
                .and_then(|value| value.parse::<i64>().ok())
            else {
                return Err(outcome_receipt_unsupported(&item.work_item_id));
            };
            let Some(answer_sha256) = outcome_signal_field(&receipt.signal, "answer_sha256") else {
                return Err(outcome_receipt_unsupported(&item.work_item_id));
            };
            let Some(stored) = crate::get_run_result_ref(conn, &receipt.run_id)? else {
                return Err(outcome_receipt_unsupported(&item.work_item_id));
            };
            if stored.status != "finished"
                || stored.answer_len != answer_len
                || stored.answer_sha256 != answer_sha256
            {
                return Err(outcome_receipt_unsupported(&item.work_item_id));
            }
        }
    }
    Ok(())
}

fn outcome_signal_field<'a>(signal: &'a str, key: &str) -> Option<&'a str> {
    signal.split([';', ',']).find_map(|part| {
        let (field, value) = part.trim().split_once('=')?;
        (field.trim() == key).then_some(value.trim())
    })
}

fn outcome_receipt_unsupported(work_item_id: &str) -> StorageError {
    unsupported(format!(
        "work_item '{work_item_id}' outcome-checked completion requires a typed outcome proof receipt backed by matching persisted run_result"
    ))
}

fn require_safe_surface_body_ref(value: &str, field: &str) -> Result<()> {
    require_non_empty(value, field)?;
    let trimmed = value.trim();
    if is_safe_body_ref(trimmed) {
        Ok(())
    } else {
        Err(unsupported(format!(
            "surface_event {field} must be a Friday-owned body/blob ref"
        )))
    }
}

fn is_safe_body_ref(value: &str) -> bool {
    value.starts_with("friday://body/")
        || value.starts_with("friday://surface-event-body/")
        || value.starts_with("blob://")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissionBodySnapshot {
    pub body_ref: String,
    pub owner_principal: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub source_surface: String,
    pub body: String,
    pub body_sha256: String,
    pub body_len: i64,
    pub created_at_ms: i64,
}

impl MissionBodySnapshot {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner_principal: &str,
        mission_id: &str,
        work_item_id: &str,
        body_ref: &str,
        source_surface: &str,
        body: &str,
        created_at_ms: i64,
    ) -> Result<Self> {
        let body_len = i64::try_from(body.len()).map_err(|_| {
            unsupported("mission_body_snapshot.body length exceeds SQLite INTEGER range")
        })?;
        let snapshot = Self {
            body_ref: body_ref.to_string(),
            owner_principal: owner_principal.to_string(),
            mission_id: mission_id.to_string(),
            work_item_id: work_item_id.to_string(),
            source_surface: source_surface.to_string(),
            body: body.to_string(),
            body_sha256: sha256_hex(body.as_bytes()),
            body_len,
            created_at_ms,
        };
        validate_mission_body_snapshot(&snapshot)?;
        Ok(snapshot)
    }
}

fn validate_mission_body_snapshot(snapshot: &MissionBodySnapshot) -> Result<()> {
    require_non_empty(&snapshot.body_ref, "mission_body_snapshot.body_ref")?;
    require_non_empty(
        &snapshot.owner_principal,
        "mission_body_snapshot.owner_principal",
    )?;
    require_non_empty(&snapshot.mission_id, "mission_body_snapshot.mission_id")?;
    require_non_empty(&snapshot.work_item_id, "mission_body_snapshot.work_item_id")?;
    require_non_empty(
        &snapshot.source_surface,
        "mission_body_snapshot.source_surface",
    )?;
    require_non_empty(&snapshot.body, "mission_body_snapshot.body")?;
    if !is_safe_body_ref(snapshot.body_ref.trim()) {
        return Err(unsupported(
            "mission_body_snapshot.body_ref must be a Friday-owned body/blob ref",
        ));
    }
    Ok(())
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
    if next_status != MissionStatus::Merged && merged_into_mission_id.is_some() {
        return Err(unsupported(
            "mission_lifecycle merged_into_mission_id is only valid for merged status",
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
    }

    // ATOMICITY + CONCURRENCY (#H1/#H3, hardening audit): this transition reads the mission (and,
    // on a merge, the merge target), the conversation, then writes BOTH the mission AND the
    // conversation. Pre-fix those two writes (`upsert_mission` + `upsert_conversation`) were SEPARATE
    // auto-committed statements on the bare conn — so a failure (or a crash) AFTER the mission write
    // but BEFORE the conversation write left the mission's new status persisted while the
    // conversation's `active_mission_ids` membership lagged: a split-brain active-set. AND, because
    // it touches two rows in sequence on the long-lived Hub connection while the reaper/retention
    // tick writes on a SEPARATE connection, a WAL `SQLITE_BUSY` (notably `SQLITE_BUSY_SNAPSHOT`,
    // which `busy_timeout` does NOT auto-retry) on the second write would crash the transition
    // spuriously. Naively wrapping the OLD two-write shape in busy-retry would be UNSAFE: a retry
    // would re-read the ALREADY-committed new status and `try_transition` would re-apply from the
    // mutated state (illegal-hop error or double-apply). So both writes are now made ONE
    // `unchecked_transaction` (all reads + both upserts + commit) FIRST — all-or-nothing, no
    // split-brain — and only THEN wrapped in the crate's ONE bounded busy-retry idiom
    // ([`crate::with_busy_retry`]). On a BUSY the txn has rolled back (NOTHING committed), so the
    // retry re-reads the live pre-transition mission/conversation and re-applies cleanly. NO-DEGRADE:
    // the success-path rows are byte-identical (same upsert contents, mission-then-conversation
    // order preserved inside the txn); the failure path goes from partial-write to all-or-nothing.
    crate::with_busy_retry(|| {
        let tx = conn.unchecked_transaction()?;

        // Merge-target validation reads the live target row INSIDE the txn so the active-like /
        // ownership check sees a consistent snapshot with the writes below (and rolls back with them
        // on any error). The scalar guards above already rejected the empty/self-merge cases.
        if next_status == MissionStatus::Merged {
            let target_mission_id = merged_into_mission_id.expect("checked above");
            let target = get_mission(&tx, target_mission_id)?.ok_or_else(|| {
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
        }

        let mut mission = get_mission(&tx, mission_id)?.ok_or_else(|| {
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

        // M2 (audit-coverage hardening): record the Mission status hop in the hash-chained audit
        // ledger inside the SAME txn as the state write — the WorkItem sibling
        // (`transition_work_item_status_inner`, audit row at the `work_item.lifecycle:` action)
        // already chains its hop, but a Mission's transition was recorded ONLY in the mutable,
        // free-text `decision_path_summary` (above), which is not tamper-evident. The summary entry
        // is preserved (no-degrade); this ADDS the append-only, verifiable receipt so a mission
        // lifecycle transition can never be silently rewritten. The audit read+insert and the
        // upserts share this one txn, so a `with_busy_retry` re-run rolls back ALL of it first and
        // re-appends from the live prev-hash — never a double-append or a forked chain.
        crate::audit::append_audit(
            &tx,
            &format!("mission_lifecycle:{}:{now_ms}", mission.mission_id),
            actor_ref,
            &format!(
                "mission.lifecycle:{}->{}:{}",
                previous_status.as_str(),
                mission.status.as_str(),
                reason
            ),
            Some(mission.mission_id.as_str()),
            now_ms,
        )?;
        upsert_mission(&tx, &mission)?;

        let mut conversation = get_conversation(&tx, friday_conversation_id)?.ok_or_else(|| {
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
        upsert_conversation(&tx, &conversation)?;

        tx.commit()?;

        Ok((mission, previous_status, conversation.active_mission_ids))
    })
}

/// Transition a WorkItem's lifecycle status at the persistence boundary — the
/// WorkItem parity of [`transition_mission_status`].
///
/// Enforces the domain's `try_transition` (an illegal hop is rejected here, not
/// silently upserted), and REQUIRES a `proof_receipt` when the next status is
/// `CompletedWithProof` — so "completed" can never be claimed without proof (the
/// `completion_is_proven` invariant is true at write time, not just at validate
/// time). The transition is recorded in the hash-chained audit ledger (a WorkItem
/// has no `decision_path_summary` text field, so the lifecycle entry IS the audit
/// row), and the loaded WorkItem is upserted — both inside ONE transaction (the
/// audit-read and the state write are atomic, per the audit-ledger invariant). On
/// `CompletedWithProof` the new receipt is appended to `proof_receipts` so the
/// stored row satisfies [`WorkItem::completion_is_proven`].
#[allow(clippy::too_many_arguments)]
pub fn transition_work_item_status(
    conn: &Connection,
    work_item_id: &str,
    next_status: WorkItemStatus,
    actor_ref: &str,
    reason: &str,
    proof_receipt: Option<&str>,
    now_ms: i64,
) -> Result<(WorkItem, WorkItemStatus)> {
    transition_work_item_status_inner(
        conn,
        work_item_id,
        next_status,
        actor_ref,
        reason,
        proof_receipt,
        now_ms,
        /* clear_executing = */ false,
    )
}

/// (#24b degrade-3 fix) Like [`transition_work_item_status`], but ALSO clears the durable
/// `executing` marker (`executing = 0`) in the SAME transaction as the status hop. The agent-loop
/// binding routes its FINAL resting-state hop (`ProviderRouted` on a pause/await/error, or
/// `CompletedWithProof` on completion) through this so a run that reaches a binding rest state
/// ALWAYS has `executing == 0` written ATOMICALLY with the status — a swallowed best-effort tail
/// clear can therefore NEVER strand `executing == 1` on a live paused/awaiting run (which boot
/// crash-recovery PASS-2 would then falsely reconcile after a long human approval latency). The
/// clear is status-preserving on the execution columns only (`last_heartbeat_ms` is left as-is —
/// PASS-2 only acts on `executing == 1` rows, so a cleared row's timestamp is never consulted).
#[allow(clippy::too_many_arguments)]
pub fn transition_work_item_status_clearing_executing(
    conn: &Connection,
    work_item_id: &str,
    next_status: WorkItemStatus,
    actor_ref: &str,
    reason: &str,
    proof_receipt: Option<&str>,
    now_ms: i64,
) -> Result<(WorkItem, WorkItemStatus)> {
    transition_work_item_status_inner(
        conn,
        work_item_id,
        next_status,
        actor_ref,
        reason,
        proof_receipt,
        now_ms,
        /* clear_executing = */ true,
    )
}

#[allow(clippy::too_many_arguments)]
fn transition_work_item_status_inner(
    conn: &Connection,
    work_item_id: &str,
    next_status: WorkItemStatus,
    actor_ref: &str,
    reason: &str,
    proof_receipt: Option<&str>,
    now_ms: i64,
    clear_executing: bool,
) -> Result<(WorkItem, WorkItemStatus)> {
    require_non_empty(work_item_id, "work_item_lifecycle.work_item_id")?;
    require_non_empty(actor_ref, "work_item_lifecycle.actor_ref")?;
    require_non_empty(reason, "work_item_lifecycle.reason")?;

    // Fail-completion: a CompletedWithProof transition MUST carry a proof receipt, so
    // a fake-ready completion is rejected at the persistence boundary (before any of
    // the lower validate/upsert checks). A receipt presented for any OTHER target is
    // rejected too — it would be silently dropped and misrepresent the transition.
    match (next_status, proof_receipt) {
        (WorkItemStatus::CompletedWithProof, None) => {
            return Err(unsupported(
                "work_item_lifecycle completed_with_proof requires a proof_receipt so completion is not fake-ready",
            ));
        }
        (WorkItemStatus::CompletedWithProof, Some(receipt)) => {
            require_non_empty(receipt, "work_item_lifecycle.proof_receipt")?;
        }
        (_, Some(_)) => {
            return Err(unsupported(
                "work_item_lifecycle proof_receipt is only valid for a completed_with_proof transition",
            ));
        }
        (_, None) => {}
    }

    // CONCURRENCY (#H3, hardening audit): the read (`get_work_item`) + the audit/upsert txn run
    // on the long-lived Hub connection while the reaper/retention tick writes on a SEPARATE
    // connection. Under WAL contention the read or the deferred write txn can return `SQLITE_BUSY`
    // (notably `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` does NOT auto-retry — only an app-level
    // retry recovers it); un-retried the caller's `?` would CRASH the transition spuriously. So the
    // WHOLE read+txn body is wrapped in the crate's ONE bounded busy-retry idiom
    // ([`crate::with_busy_retry`]) — the SAME wrapper the writable open / run-billing txn /
    // retention sweep use, never a second policy. The retry re-runs the READ then the txn: this is
    // REQUIRED for audit-chain atomicity (`append_audit` reads the prev chain hash THEN inserts, so
    // a stale-prev-hash retry would forge a broken chain) AND for transition correctness (`item` is
    // re-read from the live row, so `try_transition` is re-applied from the persisted state, never a
    // stale in-memory copy). On a BUSY the failed txn has ALREADY rolled back (NOTHING committed),
    // so each retry re-reads the live row and re-runs the deterministic `now_ms`-keyed audit id +
    // upsert cleanly. NO-DEGRADE: the retry fires ONLY on [`crate::is_storage_busy`]; with no
    // contention the closure runs EXACTLY ONCE and the result is byte-identical to the pre-fix path.
    crate::with_busy_retry(|| {
        let mut item = get_work_item(conn, work_item_id)?.ok_or_else(|| {
            unsupported(format!(
                "work_item_lifecycle WorkItem '{work_item_id}' not found"
            ))
        })?;

        let previous_status = item.status;
        item.status = previous_status
            .try_transition(next_status)
            .map_err(|e| unsupported(e.to_string()))?;
        item.updated_at_ms = now_ms;
        if let Some(receipt) = proof_receipt {
            let receipt = receipt.to_string();
            if !item.proof_receipts.contains(&receipt) {
                item.proof_receipts.push(receipt);
            }
        }
        if item.status == WorkItemStatus::CompletedWithProof
            && outcome_checked_proof_enabled()
            && item.has_outcome_proof_requirements()
            && !item.completion_outcome_is_proven()
        {
            return Err(unsupported(
                "work_item_lifecycle outcome-checked completion requires a typed outcome proof receipt matching an outcome proof requirement",
            ));
        }

        // One transaction: the lifecycle audit row (the hash-chain read + insert) and the
        // upsert commit together, so a recorded transition always has a persisted state.
        // The audit row IS the WorkItem's lifecycle entry — it carries actor, the
        // from->to hop, and the reason (a WorkItem has no decision_path_summary column).
        let tx = conn.unchecked_transaction()?;
        if previous_status == WorkItemStatus::ReadyToDispatch
            && item.status == WorkItemStatus::Dispatched
        {
            if let Some(control) = active_route_decision_control_for_work_item(&tx, work_item_id)? {
                match control.control_kind.as_str() {
                    "veto" => {
                        return Err(unsupported(format!(
                            "route_decision_veto_active:{}:{}",
                            control.decision_id, control.reason
                        )));
                    }
                    "override" => {
                        let Some(override_lane) = control.override_lane else {
                            return Err(unsupported(format!(
                                "route_decision_override_missing_lane:{}",
                                control.decision_id
                            )));
                        };
                        item.lane = override_lane;
                        item.target_provider_or_agent = control.override_provider_or_agent.clone();
                        crate::audit::append_audit(
                            &tx,
                            &format!(
                                "route_decision_override_applied:{work_item_id}:{}",
                                control.decision_id
                            ),
                            actor_ref,
                            &format!(
                                "route_decision.override_applied:{}:{}",
                                control.decision_id, control.reason
                            ),
                            Some(work_item_id),
                            now_ms,
                        )?;
                    }
                    other => {
                        return Err(unsupported(format!(
                            "unknown route_decision_control kind '{other}'"
                        )));
                    }
                }
            }
        }
        let audit_id = format!("workitem_lifecycle:{work_item_id}:{now_ms}");
        let action = format!(
            "work_item.lifecycle:{}->{}:{}",
            previous_status.as_str(),
            item.status.as_str(),
            reason
        );
        crate::audit::append_audit(
            &tx,
            &audit_id,
            actor_ref,
            &action,
            Some(work_item_id),
            now_ms,
        )?;
        upsert_work_item(&tx, &item)?;
        maybe_close_mission_after_work_item_completion(
            &tx,
            &item,
            previous_status,
            &audit_id,
            actor_ref,
            reason,
            now_ms,
        )?;
        // (#24b degrade-3) ATOMIC executing-clear: when the caller routes a binding rest-state hop
        // through `transition_work_item_status_clearing_executing`, clear the durable `executing`
        // marker in the SAME transaction as the status write. `upsert_work_item` does NOT touch the
        // execution columns (they are managed only by `set_work_item_executing`), so this targeted
        // `UPDATE` is required to land `executing = 0` atomically with the status. `last_heartbeat_ms`
        // is left as-is — PASS-2 only acts on `executing == 1` rows, so a cleared row's timestamp is
        // never consulted by the reconcile.
        if clear_executing {
            tx.execute(
                "UPDATE work_item SET executing = 0 WHERE work_item_id = ?1",
                params![work_item_id],
            )?;
        }
        tx.commit()?;

        Ok((item, previous_status))
    })
}

fn maybe_close_mission_after_work_item_completion(
    tx: &Transaction<'_>,
    item: &WorkItem,
    previous_status: WorkItemStatus,
    work_item_audit_id: &str,
    actor_ref: &str,
    reason: &str,
    now_ms: i64,
) -> Result<()> {
    if previous_status == WorkItemStatus::CompletedWithProof
        || item.status != WorkItemStatus::CompletedWithProof
    {
        return Ok(());
    }

    let Some(mut mission) = get_mission(tx, &item.mission_id)? else {
        return Ok(());
    };
    if !mission.status.can_transition_to(MissionStatus::Done) {
        return Ok(());
    }

    let work_items = list_work_items_for_mission(tx, &item.mission_id)?;
    if work_items.is_empty()
        || !work_items
            .iter()
            .all(|work_item| work_item.status == WorkItemStatus::CompletedWithProof)
    {
        return Ok(());
    }
    if has_unmaterialized_deferred_follow_up(tx, &item.mission_id, &work_items)? {
        return Ok(());
    }

    let proof_ref = format!("audit://{work_item_audit_id}");
    let previous_mission_status = mission.status;
    mission.status = mission
        .status
        .try_transition(MissionStatus::Done)
        .map_err(|e| unsupported(e.to_string()))?;
    mission.updated_at_ms = now_ms;
    if !mission.proof_refs.contains(&proof_ref) {
        mission.proof_refs.push(proof_ref.clone());
    }
    let lifecycle_entry = format!(
        "lifecycle:{}:active->done by {}: auto-close after WorkItem '{}' completed_with_proof ({reason})",
        mission.mission_id, actor_ref, item.work_item_id
    );
    mission.decision_path_summary =
        append_lifecycle_summary(&mission.decision_path_summary, &lifecycle_entry);

    // M2 (audit-coverage hardening): the auto-close is a Mission status hop (active->Done) exactly
    // like an explicit `transition_mission_status`, so it gets the SAME hash-chained receipt — the
    // caller (`transition_work_item_status_inner`) passes its OPEN `tx`, so this audit row + the
    // mission/conversation upserts below land atomically with the triggering WorkItem completion.
    // A distinct `mission_autoclose:` audit_id prefix guarantees no collision with an explicit
    // `mission_lifecycle:` row at the same `now_ms`. `decision_path_summary` is preserved
    // (no-degrade); this ADDS the tamper-evident record the close previously lacked.
    crate::audit::append_audit(
        tx,
        &format!("mission_autoclose:{}:{now_ms}", mission.mission_id),
        actor_ref,
        &format!(
            "mission.lifecycle:{}->{}:auto_close_after_work_item:{}",
            previous_mission_status.as_str(),
            mission.status.as_str(),
            item.work_item_id
        ),
        Some(mission.mission_id.as_str()),
        now_ms,
    )?;
    upsert_mission(tx, &mission)?;

    let mut conversation =
        get_conversation(tx, &mission.friday_conversation_id)?.ok_or_else(|| {
            unsupported(format!(
                "mission_auto_close conversation '{}' not found",
                mission.friday_conversation_id
            ))
        })?;
    conversation
        .active_mission_ids
        .retain(|id| id != &mission.mission_id);
    conversation.updated_at_ms = now_ms;
    upsert_conversation(tx, &conversation)?;

    Ok(())
}

fn has_unmaterialized_deferred_follow_up(
    conn: &Connection,
    mission_id: &str,
    work_items: &[WorkItem],
) -> Result<bool> {
    let route_decisions = list_route_decisions_for_mission(conn, mission_id)?;
    for decision in &route_decisions {
        if decision.deferred_options.is_empty() {
            continue;
        }
        if decision
            .inheritable_context
            .iter()
            .any(|context| context.starts_with("source_route_decision:"))
        {
            continue;
        }
        if !deferred_route_decision_materialized(decision, &route_decisions, work_items) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn deferred_route_decision_materialized(
    decision: &RouteDecisionCard,
    route_decisions: &[RouteDecisionCard],
    work_items: &[WorkItem],
) -> bool {
    let source_marker = format!("source_route_decision:{}", decision.decision_id);
    if work_items.iter().any(|work_item| {
        work_item
            .judgment_memory
            .inheritable_context
            .iter()
            .any(|context| context == &source_marker)
    }) {
        return true;
    }

    // Product intake can record an early route decision, then the mission-bound run records the
    // actionable route decision for the same source WorkItem and materializes the follow-up from
    // that later card. Do not keep the Mission open on the stale intake twin once the same source
    // WorkItem has a later materialized deferred decision.
    route_decisions
        .iter()
        .filter(|candidate| {
            candidate.decision_id != decision.decision_id
                && candidate.work_item_id == decision.work_item_id
                && candidate.created_at_ms >= decision.created_at_ms
                && !candidate.deferred_options.is_empty()
        })
        .any(|candidate| {
            let source_marker = format!("source_route_decision:{}", candidate.decision_id);
            work_items.iter().any(|work_item| {
                work_item
                    .judgment_memory
                    .inheritable_context
                    .iter()
                    .any(|context| context == &source_marker)
            })
        })
}

pub fn veto_route_decision(
    conn: &Connection,
    decision_id: &str,
    actor_ref: &str,
    reason: &str,
    now_ms: i64,
) -> Result<()> {
    record_route_decision_control(
        conn,
        decision_id,
        "veto",
        None,
        None,
        actor_ref,
        reason,
        now_ms,
    )
}

pub fn override_route_decision(
    conn: &Connection,
    decision_id: &str,
    override_lane: WorkLane,
    override_provider_or_agent: Option<&str>,
    actor_ref: &str,
    reason: &str,
    now_ms: i64,
) -> Result<()> {
    record_route_decision_control(
        conn,
        decision_id,
        "override",
        Some(override_lane),
        override_provider_or_agent,
        actor_ref,
        reason,
        now_ms,
    )
}

pub fn materialize_deferred_route_follow_up(
    conn: &Connection,
    request: DeferredRouteFollowUpRequest<'_>,
) -> Result<WorkItem> {
    require_non_empty(request.decision_id, "deferred_follow_up.decision_id")?;
    require_non_empty(
        request.source_work_item_id,
        "deferred_follow_up.source_work_item_id",
    )?;
    require_non_empty(
        request.follow_up_work_item_id,
        "deferred_follow_up.follow_up_work_item_id",
    )?;
    require_non_empty(request.actor_ref, "deferred_follow_up.actor_ref")?;
    require_non_empty(request.reason, "deferred_follow_up.reason")?;
    if let Some(target) = request.follow_up_provider_or_agent {
        require_non_empty(target, "deferred_follow_up.follow_up_provider_or_agent")?;
    }
    if request.source_work_item_id == request.follow_up_work_item_id {
        return Err(unsupported(
            "deferred_follow_up follow-up WorkItem must be distinct from source WorkItem",
        ));
    }

    crate::with_busy_retry(|| {
        let tx = conn.unchecked_transaction()?;
        let source = get_work_item(&tx, request.source_work_item_id)?.ok_or_else(|| {
            unsupported(format!(
                "deferred_follow_up source WorkItem '{}' not found",
                request.source_work_item_id
            ))
        })?;
        if source.status != WorkItemStatus::CompletedWithProof {
            return Err(unsupported(format!(
                "deferred_follow_up source WorkItem '{}' must be completed_with_proof",
                request.source_work_item_id
            )));
        }
        if get_work_item(&tx, request.follow_up_work_item_id)?.is_some() {
            return Err(unsupported(format!(
                "deferred_follow_up WorkItem '{}' already exists",
                request.follow_up_work_item_id
            )));
        }

        let route = get_route_decision(&tx, request.decision_id)?.ok_or_else(|| {
            unsupported(format!(
                "deferred_follow_up route_decision '{}' not found",
                request.decision_id
            ))
        })?;
        if route.work_item_id != source.work_item_id {
            return Err(unsupported(format!(
                "deferred_follow_up route_decision '{}' belongs to WorkItem '{}' not '{}'",
                request.decision_id, route.work_item_id, source.work_item_id
            )));
        }
        let Some(deferred_option) = route.deferred_options.first() else {
            return Err(unsupported(format!(
                "deferred_follow_up route_decision '{}' has no deferred options",
                request.decision_id
            )));
        };

        let mut mission = get_mission(&tx, &source.mission_id)?.ok_or_else(|| {
            unsupported(format!(
                "deferred_follow_up Mission '{}' not found",
                source.mission_id
            ))
        })?;
        if mission.status.is_terminal() {
            return Err(unsupported(format!(
                "deferred_follow_up Mission '{}' is terminal",
                source.mission_id
            )));
        }
        let source_proof_refs = if source.proof_receipts.is_empty() {
            vec![format!("friday://work-item/{}", source.work_item_id)]
        } else {
            source.proof_receipts.clone()
        };
        let target_label = request
            .follow_up_provider_or_agent
            .unwrap_or(request.follow_up_lane.as_str())
            .to_string();

        let mut inheritable_context = source.judgment_memory.inheritable_context.clone();
        for value in [
            format!("source_work_item:{}", source.work_item_id),
            format!("source_route_decision:{}", route.decision_id),
        ] {
            if !inheritable_context.contains(&value) {
                inheritable_context.push(value);
            }
        }
        for proof_ref in &source_proof_refs {
            let value = format!("source_proof:{proof_ref}");
            if !inheritable_context.contains(&value) {
                inheritable_context.push(value);
            }
        }

        let mut considered_options = route.considered_options.clone();
        if !considered_options.contains(deferred_option) {
            considered_options.push(deferred_option.clone());
        }
        let follow_up = WorkItem {
            work_item_id: request.follow_up_work_item_id.to_string(),
            mission_id: source.mission_id.clone(),
            lane: request.follow_up_lane,
            target_provider_or_agent: request.follow_up_provider_or_agent.map(str::to_string),
            status: WorkItemStatus::ReadyToDispatch,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some(format!("provider.{target_label}.turn")),
            risk_level: source.risk_level,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: source_proof_refs,
            output_refs: Vec::new(),
            proof_requirements: vec!["outcome:AnswerProduced:>=1".into()],
            proof_receipts: Vec::new(),
            judgment_memory: HandoffJudgmentMemory {
                task: format!("Deferred follow-up for {}: {deferred_option}", source.work_item_id),
                current_blocker: None,
                target_lane_thread_agent_provider: target_label.clone(),
                read_first_files: Vec::new(),
                required_output: "synthesis follow-up answer with proof-backed completion".into(),
                done_criteria: vec![
                    "follow-up WorkItem reaches completed_with_proof with an answer receipt".into(),
                ],
                red_lines: vec![
                    "do not claim dual-model completion until this follow-up completes with proof"
                        .into(),
                ],
                why_this_route: format!(
                    "Materialized deferred route option from {} after source proof: {deferred_option}",
                    route.decision_id
                ),
                considered_options,
                deferred_options: vec![
                    "automatic follow-up execution is separate from materialization".into(),
                ],
                previous_pitfalls: route.previous_pitfalls.clone(),
                inheritable_context,
                proof_requirements: vec!["outcome:AnswerProduced:>=1".into()],
                ownership_claim_ids: Vec::new(),
            },
            created_at_ms: request.now_ms,
            updated_at_ms: request.now_ms,
        };

        upsert_work_item(&tx, &follow_up)?;
        if !mission.work_item_ids.contains(&follow_up.work_item_id) {
            mission.work_item_ids.push(follow_up.work_item_id.clone());
        }
        let marker = format!("deferred_follow_up:{}", follow_up.work_item_id);
        if !mission.handoff_inheritance.contains(&marker) {
            mission.handoff_inheritance.push(marker);
        }
        mission.updated_at_ms = request.now_ms;
        upsert_mission(&tx, &mission)?;

        let follow_route = RouteDecisionCard::from_work_item(
            format!(
                "route-deferred-{}-{}",
                ref_id_part(&route.decision_id),
                ref_id_part(&follow_up.work_item_id)
            ),
            &follow_up,
            vec![route.route_decision_ref()],
            request.now_ms,
            None,
        );
        upsert_route_decision(&tx, &follow_route)?;
        crate::audit::append_audit(
            &tx,
            &format!(
                "route_decision_deferred_follow_up:{}:{}",
                ref_id_part(&route.decision_id),
                request.now_ms
            ),
            request.actor_ref,
            &format!(
                "route_decision.deferred_follow_up_materialized:{}:{}->{}:{}",
                route.decision_id, source.work_item_id, follow_up.work_item_id, request.reason
            ),
            Some(&follow_up.work_item_id),
            request.now_ms,
        )?;
        tx.commit()?;
        Ok(follow_up)
    })
}

#[allow(clippy::too_many_arguments)]
fn record_route_decision_control(
    conn: &Connection,
    decision_id: &str,
    control_kind: &str,
    override_lane: Option<WorkLane>,
    override_provider_or_agent: Option<&str>,
    actor_ref: &str,
    reason: &str,
    now_ms: i64,
) -> Result<()> {
    require_non_empty(decision_id, "route_decision_control.decision_id")?;
    require_non_empty(actor_ref, "route_decision_control.actor_ref")?;
    require_non_empty(reason, "route_decision_control.reason")?;
    if control_kind == "veto" {
        if override_lane.is_some() || override_provider_or_agent.is_some() {
            return Err(unsupported(
                "route_decision_control veto cannot carry override target",
            ));
        }
    } else if control_kind == "override" {
        if let Some(target) = override_provider_or_agent {
            require_non_empty(target, "route_decision_control.override_provider_or_agent")?;
        }
        if override_lane.is_none() {
            return Err(unsupported(
                "route_decision_control override requires override_lane",
            ));
        }
    } else {
        return Err(unsupported(format!(
            "unknown route_decision_control kind '{control_kind}'"
        )));
    }

    crate::with_busy_retry(|| {
        let (mission_id, work_item_id): (String, String) = conn
            .query_row(
                "SELECT mission_id, work_item_id FROM route_decision WHERE decision_id = ?1",
                [decision_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| {
                unsupported(format!(
                    "route_decision_control points to unknown route_decision '{decision_id}'"
                ))
            })?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO route_decision_control
                (decision_id, mission_id, work_item_id, control_kind, override_lane,
                 override_provider_or_agent, actor_ref, reason, active, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)
             ON CONFLICT(decision_id) DO UPDATE SET
                mission_id = excluded.mission_id,
                work_item_id = excluded.work_item_id,
                control_kind = excluded.control_kind,
                override_lane = excluded.override_lane,
                override_provider_or_agent = excluded.override_provider_or_agent,
                actor_ref = excluded.actor_ref,
                reason = excluded.reason,
                active = 1,
                created_at_ms = excluded.created_at_ms",
            params![
                decision_id,
                mission_id,
                work_item_id,
                control_kind,
                override_lane.map(|lane| lane.as_str().to_string()),
                override_provider_or_agent,
                actor_ref,
                reason,
                now_ms,
            ],
        )?;
        crate::audit::append_audit(
            &tx,
            &format!("route_decision_control:{decision_id}:{now_ms}"),
            actor_ref,
            &format!("route_decision.{control_kind}:{decision_id}:{reason}"),
            Some(&work_item_id),
            now_ms,
        )?;
        tx.commit()?;
        Ok(())
    })
}

fn active_route_decision_control_for_work_item(
    conn: &Connection,
    work_item_id: &str,
) -> Result<Option<ActiveRouteDecisionControl>> {
    conn.query_row(
        "SELECT decision_id, control_kind, override_lane, override_provider_or_agent, reason
           FROM route_decision_control
          WHERE work_item_id = ?1 AND active = 1
          ORDER BY created_at_ms DESC, decision_id DESC
          LIMIT 1",
        [work_item_id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
            ))
        },
    )
    .optional()?
    .map(
        |(decision_id, control_kind, override_lane, override_provider_or_agent, reason)| {
            let override_lane = override_lane.map(parse_work_lane).transpose()?;
            Ok(ActiveRouteDecisionControl {
                decision_id,
                control_kind,
                override_lane,
                override_provider_or_agent,
                reason,
            })
        },
    )
    .transpose()
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
    validate_work_item_outcome_receipts(conn, item)?;
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

#[allow(clippy::too_many_arguments)]
pub fn upsert_mission_body_snapshot(
    conn: &Connection,
    owner_principal: &str,
    mission_id: &str,
    work_item_id: &str,
    body_ref: &str,
    source_surface: &str,
    body: &str,
    created_at_ms: i64,
) -> Result<MissionBodySnapshot> {
    let snapshot = MissionBodySnapshot::new(
        owner_principal,
        mission_id,
        work_item_id,
        body_ref,
        source_surface,
        body,
        created_at_ms,
    )?;

    let existing = conn
        .query_row(
            "SELECT owner_principal, mission_id, work_item_id, body_sha256, body_len
             FROM mission_body_snapshot WHERE body_ref = ?1",
            params![&snapshot.body_ref],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    if let Some((owner, mission, work_item, sha, len)) = existing {
        if owner == snapshot.owner_principal
            && mission == snapshot.mission_id
            && work_item == snapshot.work_item_id
            && sha == snapshot.body_sha256
            && len == snapshot.body_len
        {
            return Ok(snapshot);
        }
        return Err(unsupported(format!(
            "mission_body_snapshot '{}' already exists with a different binding or body",
            snapshot.body_ref
        )));
    }

    conn.execute(
        "INSERT INTO mission_body_snapshot
            (body_ref, owner_principal, mission_id, work_item_id, source_surface,
             body, body_sha256, body_len, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            &snapshot.body_ref,
            &snapshot.owner_principal,
            &snapshot.mission_id,
            &snapshot.work_item_id,
            &snapshot.source_surface,
            &snapshot.body,
            &snapshot.body_sha256,
            snapshot.body_len,
            snapshot.created_at_ms,
        ],
    )?;
    Ok(snapshot)
}

pub fn get_mission_body_snapshot(
    conn: &Connection,
    owner_principal: &str,
    work_item_id: &str,
    body_ref: &str,
) -> Result<Option<MissionBodySnapshot>> {
    require_non_empty(owner_principal, "mission_body_snapshot.owner_principal")?;
    require_non_empty(work_item_id, "mission_body_snapshot.work_item_id")?;
    require_non_empty(body_ref, "mission_body_snapshot.body_ref")?;
    let snapshot = conn
        .query_row(
            "SELECT body_ref, owner_principal, mission_id, work_item_id, source_surface,
                    body, body_sha256, body_len, created_at_ms
             FROM mission_body_snapshot
             WHERE owner_principal = ?1 AND work_item_id = ?2 AND body_ref = ?3",
            params![owner_principal, work_item_id, body_ref],
            |r| {
                Ok(MissionBodySnapshot {
                    body_ref: r.get(0)?,
                    owner_principal: r.get(1)?,
                    mission_id: r.get(2)?,
                    work_item_id: r.get(3)?,
                    source_surface: r.get(4)?,
                    body: r.get(5)?,
                    body_sha256: r.get(6)?,
                    body_len: r.get(7)?,
                    created_at_ms: r.get(8)?,
                })
            },
        )
        .optional()?;
    if let Some(snapshot) = snapshot {
        let derived_sha = sha256_hex(snapshot.body.as_bytes());
        let derived_len = i64::try_from(snapshot.body.len()).map_err(|_| {
            unsupported("mission_body_snapshot.body length exceeds SQLite INTEGER range")
        })?;
        if snapshot.body_sha256 != derived_sha || snapshot.body_len != derived_len {
            return Err(unsupported(format!(
                "mission_body_snapshot '{}' fingerprint mismatch",
                snapshot.body_ref
            )));
        }
        return Ok(Some(snapshot));
    }
    Ok(None)
}

/// (#24b degrade-3 fix) `upsert_work_item` followed by clearing the durable `executing` marker
/// (`executing = 0`) in the SAME transaction — the OFF-path (un-guarded, no-audit-row) parity of
/// [`transition_work_item_status_clearing_executing`]. The agent-loop binding routes its FINAL
/// resting-state hop through this on the OFF path so a run that reaches its rest state ALWAYS has
/// `executing == 0` written atomically with the status. `last_heartbeat_ms` is left as-is (PASS-2
/// only acts on `executing == 1` rows).
pub fn upsert_work_item_clearing_executing(conn: &Connection, item: &WorkItem) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    upsert_work_item_clearing_executing_in(&tx, item)?;
    tx.commit()?;
    Ok(())
}

/// [`upsert_work_item_clearing_executing`] WITHOUT opening/committing its own transaction —
/// the caller supplies the connection (a [`rusqlite::Transaction`] derefs to [`Connection`])
/// and owns the surrounding `BEGIN`/`COMMIT`. Both statements still land together because
/// the caller's transaction is the atomic boundary. This is the seam the resume-completion
/// fold (H3 crash-window atomicity) uses to advance the WorkItem to its resting state inside
/// the SAME transaction that commits the run's `run_result`; SQLite forbids a nested `BEGIN`,
/// so a caller already inside a transaction MUST use this variant.
pub fn upsert_work_item_clearing_executing_in(conn: &Connection, item: &WorkItem) -> Result<()> {
    upsert_work_item(conn, item)?;
    conn.execute(
        "UPDATE work_item SET executing = 0 WHERE work_item_id = ?1",
        params![item.work_item_id],
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

/// The durable EXECUTION STATE of a WorkItem (#24b) — the `executing` 0/1 marker the agent loop
/// SETs just before each model call and CLEARs at every loop exit, plus the epoch-ms of the last
/// SET. Boot crash-recovery PASS-2 reads this to tell a CRASHED-while-executing
/// `ProviderRouted`/`ProviderWaiting` row (`executing == true` + a STALE `last_heartbeat_ms`) apart
/// from a legitimately-paused/awaiting one (`executing == false`). These columns are managed ONLY
/// by [`set_work_item_executing`] — they are NOT part of the [`WorkItem`] struct, the
/// `upsert_work_item` write set, or the `work_items_by_clause` read set, so a status-preserving
/// re-upsert (e.g. the crash-recovery `blocking_reason` marker write) can NEVER clobber them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WorkItemExecutionState {
    pub executing: bool,
    pub last_heartbeat_ms: Option<i64>,
}

/// SET/CLEAR a WorkItem's durable execution marker (#24b). A STATUS-PRESERVING targeted `UPDATE` of
/// ONLY the `executing` + `last_heartbeat_ms` columns — it never touches status, blocking_reason,
/// or any other column (so it cannot race the lifecycle state machine), and it never inserts a row
/// (a missing/sessionless work_item is a 0-row no-op `Ok`, never an error). The caller (the agent
/// loop) treats every write as BEST-EFFORT / FAIL-SAFE: a heartbeat write error is logged + swallowed
/// and never changes the turn outcome or billing. `heartbeat_ms` is recorded on BOTH the SET
/// (`executing = true`, marking the model call in flight) and the CLEAR (`executing = false`, leaving
/// the last-seen timestamp for observability — PASS-2 only acts on `executing == 1` rows, so a
/// cleared row's timestamp is never used to reconcile).
pub fn set_work_item_executing(
    conn: &Connection,
    work_item_id: &str,
    executing: bool,
    heartbeat_ms: i64,
) -> Result<()> {
    require_non_empty(work_item_id, "work_item.execution_state.work_item_id")?;
    conn.execute(
        "UPDATE work_item SET executing = ?2, last_heartbeat_ms = ?3 WHERE work_item_id = ?1",
        params![work_item_id, executing as i64, heartbeat_ms],
    )?;
    Ok(())
}

/// Read a WorkItem's durable execution state (#24b). `Ok(None)` when the row does not exist;
/// otherwise the `(executing, last_heartbeat_ms)` pair. A pre-v33 row (migrated, never touched by
/// [`set_work_item_executing`]) reads back `executing = false, last_heartbeat_ms = None` — the
/// fail-closed at-rest value (NOT executing ⇒ PASS-2 never reconciles it).
pub fn get_work_item_execution_state(
    conn: &Connection,
    work_item_id: &str,
) -> Result<Option<WorkItemExecutionState>> {
    conn.query_row(
        "SELECT executing, last_heartbeat_ms FROM work_item WHERE work_item_id = ?1",
        [work_item_id],
        |r| {
            Ok(WorkItemExecutionState {
                executing: r.get::<_, i64>(0)? != 0,
                last_heartbeat_ms: r.get::<_, Option<i64>>(1)?,
            })
        },
    )
    .optional()
    .map_err(StorageError::from)
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

/// All [`SurfaceThread`]s bound to `mission_id` (the surface_thread row's OWN `mission_id`
/// column — the canonical binding, NOT the conversation's `surface_thread_ids` list), oldest
/// first, with `surface_thread_id` as the deterministic tie-break. Index-backed by
/// `idx_surface_thread_mission`.
///
/// This is the read the surface_event PRODUCER uses at the run lifecycle points: the resolved
/// mission context carries an OPTIONAL `surface_thread_id` (the `by_mission_work_item` lookup the
/// live mission-bound run uses leaves it `None`), so the producer resolves the bound thread by
/// mission here instead. A surface_event REQUIRES a thread bound to its mission with a matching
/// `surface_kind` (see `validate_surface_event`), so the producer reads `source_surface` FROM the
/// thread returned here — never a hardcoded kind.
pub fn list_surface_threads_for_mission(
    conn: &Connection,
    mission_id: &str,
) -> Result<Vec<SurfaceThread>> {
    let mut stmt = conn.prepare(
        "SELECT surface_thread_id, friday_conversation_id, mission_id, surface_kind,
                channel_binding_id, delivery_route, visibility_policy, allowed_actions,
                last_seen_at_ms, last_delivered_event_seq, created_at_ms, updated_at_ms
         FROM surface_thread
         WHERE mission_id = ?1
         ORDER BY created_at_ms, surface_thread_id",
    )?;
    let rows = stmt.query_map([mission_id], |r| {
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
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
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
        ) = row?;
        out.push(SurfaceThread {
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
        });
    }
    Ok(out)
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

/// Resolve the SINGLE `provider_timeline` [`MissionLink`] whose `target_ref` encodes EXACTLY this
/// `run_id` as its trailing `#`-segment (the pause-time binding an agent-loop run writes —
/// `friday://provider-timeline/{session}#{run_id}`, see
/// `friday_hub::mission_preflight::attach_provider_timeline_state_guarded`'s `target_ref`).
///
/// This is the run's OWN binding: it carries the bound `mission_id` + `work_item_id` directly, so a
/// resume-completion leg can resolve the WorkItem to advance WITHOUT trusting any wire-supplied
/// work_item_id (the cross-mission proof-injection defense). The match is EXACT on the segment after
/// the LAST `#` (`rsplit_once('#')`), never a substring/`ends_with` — `run-x` must not resolve a
/// link bound to `prefix-run-x`. Fail-closed on ambiguity: returns `Ok(None)` if ZERO links match
/// OR if MORE THAN ONE matches (an ambiguous binding is never advanced). `run_id` is matched in Rust
/// (not via a SQL `LIKE`), so a `run_id` containing SQL wildcards cannot widen the match.
pub fn find_provider_timeline_link_by_run_id(
    conn: &Connection,
    run_id: &str,
) -> Result<Option<MissionLink>> {
    let mut stmt = conn.prepare(
        "SELECT link_id, mission_id, work_item_id, link_kind, target_ref, proof_ref, created_at_ms
         FROM mission_link
         WHERE link_kind = 'provider_timeline'
         ORDER BY created_at_ms, link_id",
    )?;
    let rows = stmt.query_map([], |r| {
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
    let mut matched: Option<MissionLink> = None;
    for row in rows {
        let (link_id, mission_id, work_item_id, link_kind, target_ref, proof_ref, created_at_ms) =
            row?;
        // EXACT match on the segment after the LAST '#'. A target_ref with no '#' never matches.
        let is_match = target_ref
            .rsplit_once('#')
            .is_some_and(|(_, tail)| tail == run_id);
        if !is_match {
            continue;
        }
        if matched.is_some() {
            // Ambiguous: more than one provider_timeline link encodes this run_id ⇒ fail-closed.
            return Ok(None);
        }
        matched = Some(MissionLink {
            link_id,
            mission_id,
            work_item_id,
            link_kind: parse_mission_link_kind(link_kind)?,
            target_ref,
            proof_ref,
            created_at_ms,
        });
    }
    Ok(matched)
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
             action_items, created_at_ms, expires_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
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
            action_items = excluded.action_items,
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
            encode_route_action_items(&card.action_items, "route_decision.action_items")?,
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
                    action_items, created_at_ms, expires_at_ms
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
                    r.get::<_, String>(14)?,
                    r.get::<_, i64>(15)?,
                    r.get::<_, Option<i64>>(16)?,
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
                action_items, created_at_ms, expires_at_ms
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
            r.get::<_, String>(14)?,
            r.get::<_, i64>(15)?,
            r.get::<_, Option<i64>>(16)?,
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
        action_items,
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
        action_items: decode_route_action_items(action_items, "route_decision.action_items")?,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;
    use friday_core::OUTCOME_CHECKED_PROOF_FLAG;
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard};
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
        _lock: MutexGuard<'static, ()>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self {
                key,
                previous,
                _lock: lock,
            }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn tmp(tag: &str) -> String {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut path: PathBuf = std::env::temp_dir();
        path.push(format!(
            "friday-storage-mission-{tag}-{}-{unique}.sqlite",
            std::process::id()
        ));
        path.to_string_lossy().into_owned()
    }

    fn judgment() -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "prove an outcome with a durable result".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: WorkLane::Codex.as_str().into(),
            read_first_files: vec!["rust-core/crates/friday-storage/src/mission.rs".into()],
            required_output: "typed outcome receipt bound to run_result".into(),
            done_criteria: vec!["completed_with_proof requires durable outcome proof".into()],
            red_lines: vec!["do not accept detached proof receipt text".into()],
            why_this_route: "storage owns the final completion invariant".into(),
            considered_options: vec!["trust receipt string only".into()],
            deferred_options: vec!["provider-specific attestations".into()],
            previous_pitfalls: vec!["B4 receipt text looked like verification".into()],
            inheritable_context: vec!["fake receipt must fail closed".into()],
            proof_requirements: vec!["outcome:AnswerProduced:>=1".into()],
            ownership_claim_ids: Vec::new(),
        }
    }

    fn seed_graph(db: &Db, work_status: WorkItemStatus, proof_receipts: Vec<String>) -> WorkItem {
        let now = 1_777_000_000_000;
        upsert_conversation(
            db.conn(),
            &FridayConversation {
                friday_conversation_id: "fconv_b4_verify".into(),
                title: "B4 verify".into(),
                created_at_ms: now,
                updated_at_ms: now,
                active_mission_ids: vec!["mission-b4".into()],
                surface_thread_ids: Vec::new(),
                owner_principal: "principal:b4-owner".into(),
                truth_status: TruthStatus::Proven,
                current_focus_summary: "B4 proof verification".into(),
                memory_scope_ref: None,
                proof_refs: vec!["proof://b4/test".into()],
            },
        )
        .unwrap();
        upsert_mission(
            db.conn(),
            &Mission {
                mission_id: "mission-b4".into(),
                friday_conversation_id: "fconv_b4_verify".into(),
                title: "B4 verify".into(),
                intent: "reject detached outcome receipts".into(),
                status: MissionStatus::Active,
                why_now: "completed_with_proof must mean true outcome evidence".into(),
                decision_path_summary: "storage invariant red test".into(),
                considered_options: vec!["trust receipt text".into()],
                deferred_options: vec!["external attestation".into()],
                known_pitfalls: vec!["receipt-only verification".into()],
                handoff_inheritance: vec!["B4".into()],
                work_item_ids: vec!["work-b4".into()],
                memory_candidate_refs: Vec::new(),
                context_passport_refs: Vec::new(),
                proof_refs: vec!["proof://b4/test".into()],
                created_at_ms: now,
                updated_at_ms: now,
            },
        )
        .unwrap();
        WorkItem {
            work_item_id: "work-b4".into(),
            mission_id: "mission-b4".into(),
            lane: WorkLane::Codex,
            target_provider_or_agent: Some("codex".into()),
            status: work_status,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("mission.b4".into()),
            risk_level: Risk::Medium,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["input://b4".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["outcome:AnswerProduced:>=1".into()],
            proof_receipts,
            judgment_memory: judgment(),
            created_at_ms: now,
            updated_at_ms: now,
        }
    }

    #[test]
    fn outcome_checked_upsert_rejects_detached_answer_receipt_without_run_result() {
        let _flag = EnvVarGuard::set(OUTCOME_CHECKED_PROOF_FLAG, "1");
        let db = Db::open_hub(&tmp("upsert-detached-receipt")).unwrap();
        let fake_receipt =
            "proof://outcome/AnswerProduced/run-missing?signal=answer_len=18".to_string();
        let item = seed_graph(&db, WorkItemStatus::CompletedWithProof, vec![fake_receipt]);

        let err = upsert_work_item(db.conn(), &item).expect_err(
            "typed AnswerProduced receipt without a matching run_result must fail closed",
        );

        assert!(
            err.to_string().contains("outcome-checked completion"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn outcome_checked_transition_rejects_detached_answer_receipt_without_run_result() {
        let _flag = EnvVarGuard::set(OUTCOME_CHECKED_PROOF_FLAG, "1");
        let db = Db::open_hub(&tmp("transition-detached-receipt")).unwrap();
        let item = seed_graph(&db, WorkItemStatus::ProviderWaiting, Vec::new());
        upsert_work_item(db.conn(), &item).unwrap();

        let err = transition_work_item_status(
            db.conn(),
            "work-b4",
            WorkItemStatus::CompletedWithProof,
            "test://b4",
            "prove B4 fail-close",
            Some("proof://outcome/AnswerProduced/run-missing?signal=answer_len=18"),
            1_777_000_000_010,
        )
        .expect_err("typed AnswerProduced transition must require a matching run_result");

        assert!(
            err.to_string().contains("outcome-checked completion"),
            "unexpected error: {err}"
        );
    }
}
