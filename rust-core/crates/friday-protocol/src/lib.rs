//! Friday Rust Core — the phone<->Hub wire contract (gate `21` §4).
//!
//! Both endpoints are Rust, so the wire types are serde structs carrying a
//! per-message `schema_version` (gate §0/§4.1). This crate is **pure**: envelope
//! types, (de)serialization, version negotiation, idempotency, and replay/
//! catch-up logic — no networking and no encryption (the transport layer seals
//! the serialized payload; see Unit-4 transport slice).
//!
//! Scope (gate §4.2): the first-slice message kinds plus Provider Workspace wire
//! messages (schema v3), Mission Spine surface projections (schema v4),
//! redacted route-decision proof traces (schema v5), and refs-only Mission
//! timeline snapshots (schema v6).
//! Mission-bound Ask Friday requests (schema v7).
//! Mission timeline surface events (schema v8).
//! Mission lifecycle commands/results (schema v9).
//! Bounded Mission timeline hydration (schema v10).
//! Mission intake/preflight from mobile/desktop/channel surfaces (schema v11).
//! Session-detail, attachments, and workflow messages remain deferred to their owning
//! units; for the provider lane, what is still deferred is NOT these wire types but the
//! real provider ADAPTERS (live dispatch) and the operator-gated remote proof lanes. The
//! actual networked WebSocket + relay + live key exchange are the Unit-4 transport
//! sub-slice (this crate is the contract they carry).

use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;

/// Highest wire schema version this build speaks.
pub const CURRENT_SCHEMA_VERSION: u16 = 11;
/// The inclusive range of versions this build supports.
pub const SUPPORTED: VersionRange = VersionRange { min: 1, max: 11 };

/// A surface-safe Mission projection. This is the wire shape mobile, desktop, and
/// channel surfaces may render. It intentionally has no raw provider ids, channel
/// chat ids, cwd, account hashes, external URLs, raw transcripts, or secrets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionSurfaceProjectionWire {
    pub surface_thread_id: String,
    pub friday_conversation_id: String,
    pub mission_id: String,
    pub surface_kind: String,
    pub visibility_policy: String,
    pub title: String,
    pub status: String,
    pub truth_status: String,
    pub current_focus_summary: String,
    pub proof_refs: Vec<String>,
    pub updated_at_ms: i64,
}

impl From<friday_core::MissionSurfaceProjection> for MissionSurfaceProjectionWire {
    fn from(value: friday_core::MissionSurfaceProjection) -> Self {
        Self {
            surface_thread_id: value.surface_thread_id,
            friday_conversation_id: value.friday_conversation_id,
            mission_id: value.mission_id,
            surface_kind: value.surface_kind.as_str().to_string(),
            visibility_policy: value.visibility_policy.as_str().to_string(),
            title: value.title,
            status: value.status.as_str().to_string(),
            truth_status: value.truth_status.as_str().to_string(),
            current_focus_summary: value.current_focus_summary,
            proof_refs: value.proof_refs,
            updated_at_ms: value.updated_at_ms,
        }
    }
}

/// Surface-safe route judgment attached to a Mission snapshot. This preserves
/// Friday's lane/agent/channel judgment path for UI and handoff dashboards, but
/// carries only redacted refs/counts. Raw channel chat ids, provider thread ids,
/// trace refs, cwd, account hashes, and transcripts stay Hub-side.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteDecisionProjectionWire {
    pub route_decision_ref: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub selected_lane: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_target_label: Option<String>,
    pub why_this_route: String,
    pub considered_options: Vec<String>,
    pub deferred_options: Vec<String>,
    pub previous_pitfalls: Vec<String>,
    pub inheritable_context: Vec<String>,
    pub conflict_ref_count: u64,
    pub proof_requirements: Vec<String>,
    pub ownership_claim_count: u64,
    pub trace_ref_count: u64,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
}

impl From<friday_core::RouteDecisionProjection> for RouteDecisionProjectionWire {
    fn from(value: friday_core::RouteDecisionProjection) -> Self {
        Self {
            route_decision_ref: value.route_decision_ref,
            mission_id: value.mission_id,
            work_item_id: value.work_item_id,
            selected_lane: value.selected_lane.as_str().to_string(),
            selected_target_label: value.selected_target_label,
            why_this_route: value.why_this_route,
            considered_options: value.considered_options,
            deferred_options: value.deferred_options,
            previous_pitfalls: value.previous_pitfalls,
            inheritable_context: value.inheritable_context,
            conflict_ref_count: value.conflict_ref_count as u64,
            proof_requirements: value.proof_requirements,
            ownership_claim_count: value.ownership_claim_count as u64,
            trace_ref_count: value.trace_ref_count as u64,
            created_at_ms: value.created_at_ms,
            expires_at_ms: value.expires_at_ms,
        }
    }
}

/// Client request for the Mission projections attached to one canonical Friday
/// conversation. The id must be a Friday-owned conversation id (`fconv_*`), never
/// a provider thread id, channel chat id, or frontend-local id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionProjectionRequestWire {
    pub friday_conversation_id: String,
}

/// Hub response carrying every surface projection for a canonical Friday
/// conversation. Mobile/desktop/channel may filter locally by `surface_kind`, but
/// the authoritative Mission ids/statuses are shared.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionProjectionSnapshotWire {
    pub friday_conversation_id: String,
    pub generated_at_ms: i64,
    pub projections: Vec<MissionSurfaceProjectionWire>,
    #[serde(default)]
    pub route_decisions: Vec<RouteDecisionProjectionWire>,
}

/// Client request for one Mission's refs-only timeline/read model. The
/// conversation id must be canonical; the Mission id is checked Hub-side to
/// belong to that conversation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionTimelineRequestWire {
    pub friday_conversation_id: String,
    pub mission_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// Client request to change one Mission's lifecycle state. This is a Hub-owned
/// mutation: the Hub validates the canonical conversation id, Mission ownership,
/// status transition, actor/reason, and any proof/merge refs before writing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionLifecycleRequestWire {
    pub friday_conversation_id: String,
    pub mission_id: String,
    pub target_status: String,
    pub actor_ref: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_into_mission_id: Option<String>,
}

/// Hub response after a Mission lifecycle command. It returns the changed
/// Mission status and active Mission list; it does not imply provider/workflow
/// completion unless the command carried and persisted valid proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionLifecycleResultWire {
    pub friday_conversation_id: String,
    pub mission_id: String,
    pub previous_status: String,
    pub status: String,
    pub actor_ref: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_into_mission_id: Option<String>,
    pub active_mission_ids: Vec<String>,
    pub updated_at_ms: i64,
}

/// Client request to resolve/create a Mission from one mobile/desktop/channel
/// surface input. This is a Hub-owned preflight mutation, not a provider/model
/// call. Duplicate/conflict outcomes must be surfaced instead of silently
/// creating task debt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionIntakeRequestWire {
    pub friday_conversation_id: String,
    pub owner_principal: String,
    pub surface_thread_id: String,
    pub surface_kind: String,
    pub delivery_route: String,
    pub visibility_policy: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub title: String,
    pub intent: String,
    pub lane: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_provider_or_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_ref: Option<String>,
    #[serde(default)]
    pub includes_sensitive_context: bool,
}

/// Hub response for Mission intake/preflight. `status=blocked` means no new
/// WorkItem was written; duplicate ids tell the client which existing Mission or
/// WorkItem to show.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionIntakeResultWire {
    pub friday_conversation_id: String,
    pub mission_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    pub surface_thread_id: String,
    pub status: String,
    pub blockers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duplicate_mission_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duplicate_work_item_id: Option<String>,
    pub created_or_ready: bool,
}

/// Canonical Mission/WorkItem context for a user-facing request. This is not a
/// provider thread id or frontend-local chat id; Hub resolves it against Mission
/// Spine storage before the request can become product work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionWorkItemContextWire {
    pub friday_conversation_id: String,
    pub mission_id: String,
    pub work_item_id: String,
}

/// User-facing Mission metadata for a timeline snapshot. This is Mission truth,
/// not provider/channel transcript truth.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionTimelineMissionWire {
    pub mission_id: String,
    pub friday_conversation_id: String,
    pub title: String,
    pub intent: String,
    pub status: String,
    pub why_now: String,
    pub decision_path_summary: String,
    pub proof_refs: Vec<String>,
    pub updated_at_ms: i64,
}

/// Refs/counts-only WorkItem projection. Raw targets, input refs, output refs,
/// provider thread ids, channel chat ids, cwd, account ids, and transcripts stay
/// Hub-side.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionTimelineWorkItemWire {
    pub work_item_id: String,
    pub mission_id: String,
    pub lane: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_id: Option<String>,
    pub risk_level: String,
    pub approval_state: String,
    pub has_blocker: bool,
    pub owner_claim_count: u64,
    pub workspace_ref_count: u64,
    pub input_ref_count: u64,
    pub output_ref_count: u64,
    pub proof_requirements: Vec<String>,
    pub proof_receipts: Vec<String>,
    pub updated_at_ms: i64,
}

/// Redacted Mission link row. `target_ref` and raw `link_id` are intentionally
/// absent because channel/provider/workflow refs may contain raw provider or
/// channel identifiers. `link_ref` is a surface projection ref only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionTimelineLinkWire {
    pub link_ref: String,
    pub mission_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    pub link_kind: String,
    pub has_proof: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_ref: Option<String>,
    pub grants_memory_authority: bool,
    pub created_at_ms: i64,
}

/// Refs-only surface event in a Mission timeline. This is the bridge for "mobile
/// message is visible on desktop" without treating mobile/desktop/channel as
/// separate canonical chats.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionTimelineSurfaceEventWire {
    pub surface_event_id: String,
    pub friday_conversation_id: String,
    pub mission_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    pub surface_thread_id: String,
    pub source_surface: String,
    pub event_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_ref: Option<String>,
    pub visibility_policy: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_ref: Option<String>,
    pub created_at_ms: i64,
}

impl From<friday_core::SurfaceEvent> for MissionTimelineSurfaceEventWire {
    fn from(value: friday_core::SurfaceEvent) -> Self {
        Self {
            surface_event_id: value.surface_event_id,
            friday_conversation_id: value.friday_conversation_id,
            mission_id: value.mission_id,
            work_item_id: value.work_item_id,
            surface_thread_id: value.surface_thread_id,
            source_surface: value.source_surface.as_str().to_string(),
            event_kind: value.event_kind.as_str().to_string(),
            body_ref: value.body_ref,
            visibility_policy: value.visibility_policy.as_str().to_string(),
            proof_ref: value.proof_ref,
            created_at_ms: value.created_at_ms,
        }
    }
}

/// Hub response composing a single Mission's visible state plus redacted attached
/// refs. This is a richer read model than `MissionProjectionSnapshot`, but it is
/// still not a raw event stream and not completion proof by itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionTimelineSnapshotWire {
    pub friday_conversation_id: String,
    pub mission_id: String,
    pub generated_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_from: Option<String>,
    #[serde(default)]
    pub bounded: bool,
    #[serde(default)]
    pub has_more: bool,
    pub mission: MissionTimelineMissionWire,
    pub projections: Vec<MissionSurfaceProjectionWire>,
    pub work_items: Vec<MissionTimelineWorkItemWire>,
    pub links: Vec<MissionTimelineLinkWire>,
    #[serde(default)]
    pub route_decisions: Vec<RouteDecisionProjectionWire>,
    #[serde(default)]
    pub surface_events: Vec<MissionTimelineSurfaceEventWire>,
}

/// Redacted provider-session projection safe to carry to phone/channel clients.
/// Hub-only fields such as account hashes, cwd, external URLs, provider tokens,
/// and raw provider ids are intentionally absent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderSessionProjectionWire {
    pub friday_session_id: String,
    pub provider: String,
    pub workspace_id: String,
    pub sync_mode: String,
    pub capability_snapshot: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_provider_seen_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_friday_event_id: Option<String>,
    pub truth_label: String,
}

impl From<friday_core::ProviderSessionProjection> for ProviderSessionProjectionWire {
    fn from(value: friday_core::ProviderSessionProjection) -> Self {
        Self {
            friday_session_id: value.friday_session_id,
            provider: value.provider,
            workspace_id: value.workspace_id,
            sync_mode: value.sync_mode.as_str().to_string(),
            capability_snapshot: value.capability_snapshot,
            last_provider_seen_at: value.last_provider_seen_at,
            last_friday_event_id: value.last_friday_event_id,
            truth_label: value.truth_label,
        }
    }
}

/// Provider Workspace session state safe for phone/desktop/channel clients.
/// This is Friday's redacted mirror shape, not a raw provider transcript or
/// credential-bearing session object.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderWorkspaceSessionWire {
    pub friday_session_id: String,
    pub provider: String,
    pub workspace_id: String,
    pub sync_mode: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
    pub last_event_seq: u64,
    pub truth_label: String,
    pub fallback_status: String,
}

/// Provider-native operation metadata safe to show to UI. This preserves the
/// distinction between Codex app-server, Claude Remote Control, and Claude
/// stream-json without linking phone code to provider/secret crates.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "provider_action", rename_all = "snake_case")]
pub enum ProviderWorkspaceNativeActionWire {
    CodexAppServer {
        method: String,
        schema_ref: String,
    },
    ClaudeRemoteControl {
        action: String,
        proof_required: bool,
    },
    ClaudeStreamJson {
        event_type: String,
    },
}

/// One UI action row in Provider Workspace. `routed=false` means the UI may show
/// the action with its blocker/proof state, but must not dispatch it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderWorkspaceActionWire {
    pub provider: String,
    pub action: String,
    pub capability_id: String,
    pub sync_mode: String,
    pub status: String,
    pub truth_label: String,
    pub routed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_action: Option<ProviderWorkspaceNativeActionWire>,
}

/// Metadata-only Needs-Me row derived from provider events. Raw command bodies,
/// transcript text, provider tokens, and provider account ids are absent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderWorkspaceNeedsMeWire {
    pub item_id: String,
    pub provider: String,
    pub friday_session_id: String,
    pub kind: String,
    pub priority: String,
    pub ref_id: String,
    pub status: String,
}

/// Snapshot message body for the Provider Workspace screen. Deltas can be added
/// later; this first wire shape gives UI clients a single canonical contract and
/// prevents surface-specific private action ids.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderWorkspaceProjectionWire {
    pub session: ProviderWorkspaceSessionWire,
    pub actions: Vec<ProviderWorkspaceActionWire>,
    pub needs_me: Vec<ProviderWorkspaceNeedsMeWire>,
}

/// A UI/client request to perform one Provider Workspace action. The Hub must
/// validate this against the capability catalog before any provider process or
/// model call can happen.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderWorkspaceActionRequestWire {
    pub request_id: String,
    pub friday_session_id: String,
    pub provider: String,
    pub action: String,
    pub capability_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_context: Option<ProviderWorkspaceMissionContextWire>,
}

/// Canonical Mission context for a provider action. Provider requests are not
/// allowed to become detached provider work: dispatch must resolve these refs
/// against Hub Mission Spine storage before touching a provider adapter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderWorkspaceMissionContextWire {
    pub friday_conversation_id: String,
    pub mission_id: String,
    pub work_item_id: String,
}

/// The Hub's pre-dispatch decision for a Provider Workspace action. `accepted`
/// means the request may enter the provider adapter. It is not a provider
/// completion claim.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderWorkspaceActionResultWire {
    pub request_id: String,
    pub friday_session_id: String,
    pub provider: String,
    pub action: String,
    pub capability_id: String,
    pub accepted: bool,
    pub routed: bool,
    pub status: String,
    pub truth_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_context: Option<ProviderWorkspaceMissionContextWire>,
}

/// One provider-session timeline event on the wire (metadata-only). It carries ONLY
/// refs (`body_ref`/`provider_event_id`) — never raw transcript text. This is a
/// structural guarantee: there is no field on this type that can hold a transcript body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderTimelineEventWire {
    pub seq: u64,
    pub revision: u64,
    pub event_kind: String,
    pub actor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_event_id: Option<String>,
}

/// A Friday-originated pending action on the wire. `state` is the lifecycle label and
/// `terminal` is whether that state is terminal — together they preserve the honesty
/// invariant that a Hub ack (`sent_to_hub`/`accepted_by_hub`) is NOT a provider
/// completion: only `provider_completed` is both terminal and a real completion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderTimelinePendingWire {
    pub request_id: String,
    pub client_msg_id: String,
    pub action: String,
    pub state: String,
    pub terminal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
    pub base_revision: u64,
    pub updated_at_revision: u64,
}

/// The provider-session timeline reconnect answer on the wire: a bounded `delta` when
/// the client's cursor is still retained, else a `snapshot` (full retained replay) when
/// it is behind retention. Mirrors the Hub-side `ProviderTimeline::reconnect`; a UI applies
/// a delta incrementally and replaces on a snapshot. Internally tagged by `mode`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ProviderTimelineReconnectWire {
    Delta {
        from_seq: u64,
        to_seq: u64,
        from_revision: u64,
        to_revision: u64,
        events: Vec<ProviderTimelineEventWire>,
        pending: Vec<ProviderTimelinePendingWire>,
    },
    Snapshot {
        to_seq: u64,
        revision: u64,
        events: Vec<ProviderTimelineEventWire>,
        pending: Vec<ProviderTimelinePendingWire>,
        reason: String,
    },
}

/// Structured QR payload for Hub/device pairing. This is the JSON that can be
/// encoded into a QR code. It contains a short-lived Friday pairing secret, but
/// never provider OAuth/API/session material.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct FridayPairPayloadWire {
    pub v: u16,
    pub hub_id: String,
    pub pairing_id: String,
    pub pairing_secret: String,
    pub display_name: String,
    pub transport_hints: Vec<PairTransportHintWire>,
    pub expires_at: i64,
    pub capabilities_hint: Vec<String>,
}

impl fmt::Debug for FridayPairPayloadWire {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FridayPairPayloadWire")
            .field("v", &self.v)
            .field("hub_id", &self.hub_id)
            .field("pairing_id", &self.pairing_id)
            .field("pairing_secret", &"<redacted>")
            .field("display_name", &self.display_name)
            .field("transport_hints", &self.transport_hints)
            .field("expires_at", &self.expires_at)
            .field("capabilities_hint", &self.capabilities_hint)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PairTransportHintWire {
    pub kind: String,
    pub endpoint: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FridayPairProjectionWire {
    pub v: u16,
    pub hub_id: String,
    pub pairing_id: String,
    pub display_name: String,
    pub transport_labels: Vec<String>,
    pub expires_at: i64,
    pub capabilities_hint: Vec<String>,
}

impl FridayPairPayloadWire {
    pub fn encode_qr_json(&self) -> Result<String, ProtocolError> {
        serde_json::to_string(self).map_err(|e| ProtocolError::Encode(e.to_string()))
    }

    pub fn decode_qr_json(value: &str) -> Result<Self, ProtocolError> {
        serde_json::from_str(value).map_err(|e| ProtocolError::Decode(e.to_string()))
    }

    pub fn into_core(self) -> Result<friday_core::FridayPairPayload, ProtocolError> {
        let mut hints = Vec::with_capacity(self.transport_hints.len());
        for hint in self.transport_hints {
            let kind = friday_core::PairTransportKind::parse(&hint.kind).ok_or_else(|| {
                ProtocolError::Decode(format!("unknown pair transport kind '{}'", hint.kind))
            })?;
            hints.push(
                friday_core::PairTransportHint::new(kind, hint.endpoint, hint.label)
                    .map_err(|e| ProtocolError::Decode(e.to_string()))?,
            );
        }
        let mut authorities = Vec::with_capacity(self.capabilities_hint.len());
        for authority in self.capabilities_hint {
            authorities.push(
                friday_core::PairAuthority::parse(&authority).ok_or_else(|| {
                    ProtocolError::Decode(format!("unknown pair authority '{authority}'"))
                })?,
            );
        }
        friday_core::FridayPairPayload::new(
            self.v,
            self.hub_id,
            self.pairing_id,
            self.pairing_secret,
            self.display_name,
            hints,
            self.expires_at,
            authorities,
        )
        .map_err(|e| ProtocolError::Decode(e.to_string()))
    }
}

impl From<&friday_core::FridayPairPayload> for FridayPairPayloadWire {
    fn from(value: &friday_core::FridayPairPayload) -> Self {
        Self {
            v: value.v,
            hub_id: value.hub_id.clone(),
            pairing_id: value.pairing_id.clone(),
            pairing_secret: value.pairing_secret.expose_for_qr().to_string(),
            display_name: value.display_name.clone(),
            transport_hints: value
                .transport_hints
                .iter()
                .map(|hint| PairTransportHintWire {
                    kind: hint.kind.as_str().to_string(),
                    endpoint: hint.endpoint.clone(),
                    label: hint.label.clone(),
                })
                .collect(),
            expires_at: value.expires_at,
            capabilities_hint: value
                .capabilities_hint
                .iter()
                .map(|authority| authority.as_str().to_string())
                .collect(),
        }
    }
}

impl From<friday_core::FridayPairProjection> for FridayPairProjectionWire {
    fn from(value: friday_core::FridayPairProjection) -> Self {
        Self {
            v: value.v,
            hub_id: value.hub_id,
            pairing_id: value.pairing_id,
            display_name: value.display_name,
            transport_labels: value.transport_labels,
            expires_at: value.expires_at,
            capabilities_hint: value
                .capabilities_hint
                .iter()
                .map(|authority| authority.as_str().to_string())
                .collect(),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("decode error: {0}")]
    Decode(String),
    #[error("encode error: {0}")]
    Encode(String),
    #[error("schema versions incompatible: local {l_min}..={l_max}, remote {r_min}..={r_max}")]
    VersionUnsupported {
        l_min: u16,
        l_max: u16,
        r_min: u16,
        r_max: u16,
    },
}

/// Explicit, UI-visible error codes (gate §4.5). None degrade silently.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    PairingDenied,
    DeviceRevoked,
    SchemaVersionUnsupported,
    HubOffline,
    /// DeepSeek route down / credential bad — surfaced, never a silent fallback.
    ProviderUnavailable,
    RateLimited,
    /// Informational: a duplicate command was deduped (executed exactly once).
    IdempotencyReplay,
    Internal,
}

/// First-slice message kinds (gate §4.2). Tagged by `kind`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Message {
    /// phone->hub: complete QR pairing handshake (pubkey + proof; never the raw secret).
    Pair {
        device_id: String,
        device_pubkey: Vec<u8>,
        pairing_proof: Vec<u8>,
    },
    /// hub->phone: accept/deny pairing.
    PairAck {
        accepted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_code: Option<ErrorCode>,
    },
    /// hub->phone: health + capability set + supported version range. No model call.
    HubStatus {
        online: bool,
        capabilities: Vec<String>,
        min_version: u16,
        max_version: u16,
    },
    /// phone->hub: the only slice message that may cause a model call. When
    /// `mission_context` is present the Hub must attach the resulting proof to
    /// the canonical Mission/WorkItem instead of creating detached ask state.
    AskFridayRequest {
        prompt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mission_context: Option<MissionWorkItemContextWire>,
    },
    /// hub->phone: streamed token chunk; ordered/replayable by `seq`.
    AskFridayStream { seq: u64, chunk: String },
    /// hub->phone: terminal frame of a stream; carries the ledger id.
    AskFridayResult {
        ledger_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_link: Option<String>,
    },
    /// hub->phone: token/model ledger row projection (fallback must be false).
    LedgerEntry {
        ledger_id: String,
        provider_kind: String,
        model: String,
        base_url_host: String,
        total_tokens: i64,
        fallback: bool,
    },
    /// hub->phone: status/receipt for the ask.
    ActivityItem {
        activity_id: String,
        item_type: String,
        state: String,
    },
    /// hub->phone: ack of a queued offline action on reconnect. NOT completion.
    OfflineQueueAck { acked_msg_id: String },
    /// hub->phone: redacted Provider Workspace state/action snapshot. No model
    /// call, no provider credential, and blocked actions remain blocked.
    ProviderWorkspaceSnapshot {
        projection: ProviderWorkspaceProjectionWire,
    },
    /// phone/desktop/channel->hub: request one Provider Workspace action. The
    /// Hub must answer with a guard result before any provider dispatch.
    ProviderWorkspaceActionRequest {
        request: ProviderWorkspaceActionRequestWire,
    },
    /// hub->client: pre-dispatch result for a Provider Workspace action request.
    ProviderWorkspaceActionResult {
        result: ProviderWorkspaceActionResultWire,
    },
    /// hub->client: provider-session timeline reconnect — a bounded DELTA when the
    /// client's cursor is retained, else a SNAPSHOT. Events carry refs only (never raw
    /// transcript); a pending action's `state`/`terminal` preserve Hub-ack≠completion.
    ProviderTimelineReconnect {
        friday_session_id: String,
        reconnect: ProviderTimelineReconnectWire,
    },
    /// client->hub: read all surface-safe Mission projections for one canonical
    /// Friday conversation. Pure read; must not cause model/provider calls.
    MissionProjectionRequest {
        request: MissionProjectionRequestWire,
    },
    /// client->hub: resolve/create a Mission from one surface input and run
    /// duplicate/conflict preflight. Never a provider/model call.
    MissionIntakeRequest { request: MissionIntakeRequestWire },
    /// hub->client: Mission intake/preflight receipt.
    MissionIntakeResult { result: MissionIntakeResultWire },
    /// hub->client: same Mission ids/statuses for mobile/desktop/channel
    /// surfaces. This is the product graph projection, not a provider transcript.
    MissionProjectionSnapshot {
        snapshot: MissionProjectionSnapshotWire,
    },
    /// client->hub: read one Mission's refs-only timeline. Pure read; must not
    /// cause model/provider calls.
    MissionTimelineRequest { request: MissionTimelineRequestWire },
    /// hub->client: one Mission's richer refs-only timeline/read model.
    MissionTimelineSnapshot {
        snapshot: MissionTimelineSnapshotWire,
    },
    /// client->hub: mutate one canonical Mission's lifecycle through the Hub
    /// state machine. Never a provider/model call.
    MissionLifecycleRequest {
        request: MissionLifecycleRequestWire,
    },
    /// hub->client: lifecycle mutation receipt. Status changes here are Mission
    /// management facts, not provider completion unless proof_ref says so.
    MissionLifecycleResult { result: MissionLifecycleResultWire },
    /// either: explicit error code + message.
    Error { code: ErrorCode, message: String },
}

/// The versioned envelope (gate §4.1). The relay sees only ciphertext of the
/// serialized envelope after session establishment (transport layer).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub schema_version: u16,
    pub msg_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    pub sent_at: i64,
    pub message: Message,
}

impl Envelope {
    /// Build an envelope stamped with the current schema version.
    pub fn new(msg_id: impl Into<String>, sent_at: i64, message: Message) -> Envelope {
        Envelope {
            schema_version: CURRENT_SCHEMA_VERSION,
            msg_id: msg_id.into(),
            correlation_id: None,
            sent_at,
            message,
        }
    }

    pub fn with_correlation(mut self, correlation_id: impl Into<String>) -> Envelope {
        self.correlation_id = Some(correlation_id.into());
        self
    }

    /// Serialize to JSON (gate §4.6: JSON chosen for debuggability).
    pub fn encode(&self) -> Result<String, ProtocolError> {
        serde_json::to_string(self).map_err(|e| ProtocolError::Encode(e.to_string()))
    }

    /// Parse from JSON. Unknown *fields* are tolerated (forward-compatible);
    /// unknown message *kinds* are a hard decode error (truth-labeled, not
    /// silently dropped).
    pub fn decode(s: &str) -> Result<Envelope, ProtocolError> {
        serde_json::from_str(s).map_err(|e| ProtocolError::Decode(e.to_string()))
    }
}

/// Inclusive supported schema-version range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VersionRange {
    pub min: u16,
    pub max: u16,
}

/// Agree on the highest schema version both sides support (gate §4.4). Errors
/// (never silently downgrades) when the ranges are disjoint.
pub fn negotiate_version(local: VersionRange, remote: VersionRange) -> Result<u16, ProtocolError> {
    let lo = local.min.max(remote.min);
    let hi = local.max.min(remote.max);
    if lo <= hi {
        Ok(hi)
    } else {
        Err(ProtocolError::VersionUnsupported {
            l_min: local.min,
            l_max: local.max,
            r_min: remote.min,
            r_max: remote.max,
        })
    }
}

/// Result of observing a client command's `msg_id`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seen {
    /// First time seen — execute it.
    First,
    /// Already processed — dedupe so it executes exactly once.
    Replay,
}

/// Dedupes client commands by `msg_id` so a reconnect-and-resend executes once
/// (critical for the offline queue — gate §4.4).
#[derive(Default)]
pub struct IdempotencyTracker {
    seen: std::collections::HashSet<String>,
}

impl IdempotencyTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn observe(&mut self, msg_id: &str) -> Seen {
        if self.seen.insert(msg_id.to_string()) {
            Seen::First
        } else {
            Seen::Replay
        }
    }

    pub fn has_seen(&self, msg_id: &str) -> bool {
        self.seen.contains(msg_id)
    }
}

/// A durable, resumable stream of `AskFridayStream` frames (gate §4.3). On
/// reconnect, the peer reports its last acked `seq` and we replay only the
/// frames it missed, in order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamFrame {
    pub seq: u64,
    pub chunk: String,
}

#[derive(Default)]
pub struct ResumableStream {
    frames: Vec<StreamFrame>,
}

impl ResumableStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append the next frame. Returns its assigned seq (monotonic from 1).
    pub fn push(&mut self, chunk: impl Into<String>) -> u64 {
        let seq = self.frames.len() as u64 + 1;
        self.frames.push(StreamFrame {
            seq,
            chunk: chunk.into(),
        });
        seq
    }

    /// Frames the peer missed (seq strictly greater than its last acked seq).
    pub fn missed_since(&self, last_acked_seq: u64) -> Vec<StreamFrame> {
        self.frames
            .iter()
            .filter(|f| f.seq > last_acked_seq)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_workspace_snapshot() -> Message {
        Message::ProviderWorkspaceSnapshot {
            projection: ProviderWorkspaceProjectionWire {
                session: ProviderWorkspaceSessionWire {
                    friday_session_id: "friday-codex-1".into(),
                    provider: "codex".into(),
                    workspace_id: "workspace-1".into(),
                    sync_mode: "provider_app_server_local".into(),
                    status: "awaiting_approval".into(),
                    active_turn_id: Some("turn-1".into()),
                    last_event_seq: 7,
                    truth_label: "codex app-server local, official history unproven".into(),
                    fallback_status: "no_fallback".into(),
                },
                actions: vec![ProviderWorkspaceActionWire {
                    provider: "codex".into(),
                    action: "send_turn".into(),
                    capability_id: "provider.codex.send_turn".into(),
                    sync_mode: "provider_app_server_local".into(),
                    status: "implemented_unproven".into(),
                    truth_label: "codex_app_server_local_turn_start_unproven_for_ui".into(),
                    routed: false,
                    blocker: Some("official-history behavior is not fully proven".into()),
                    proof_ref: None,
                    native_action: Some(ProviderWorkspaceNativeActionWire::CodexAppServer {
                        method: "turn_start".into(),
                        schema_ref: "codex-app-server-generated-schema".into(),
                    }),
                }],
                needs_me: vec![ProviderWorkspaceNeedsMeWire {
                    item_id: "needs-me:friday-codex-1:approval-1".into(),
                    provider: "codex".into(),
                    friday_session_id: "friday-codex-1".into(),
                    kind: "approval".into(),
                    priority: "high".into(),
                    ref_id: "approval-1".into(),
                    status: "awaiting_approval".into(),
                }],
            },
        }
    }

    fn provider_workspace_action_request() -> Message {
        Message::ProviderWorkspaceActionRequest {
            request: ProviderWorkspaceActionRequestWire {
                request_id: "request-1".into(),
                friday_session_id: "friday-codex-1".into(),
                provider: "codex".into(),
                action: "send_turn".into(),
                capability_id: "provider.codex.send_turn".into(),
                payload_ref: Some("friday://body/user-message/1".into()),
                mission_context: Some(ProviderWorkspaceMissionContextWire {
                    friday_conversation_id: "fconv_provider_workspace".into(),
                    mission_id: "mission-provider-workspace".into(),
                    work_item_id: "work-provider-workspace".into(),
                }),
            },
        }
    }

    fn provider_workspace_action_result() -> Message {
        Message::ProviderWorkspaceActionResult {
            result: ProviderWorkspaceActionResultWire {
                request_id: "request-1".into(),
                friday_session_id: "friday-codex-1".into(),
                provider: "codex".into(),
                action: "send_turn".into(),
                capability_id: "provider.codex.send_turn".into(),
                accepted: false,
                routed: false,
                status: "implemented_unproven".into(),
                truth_label: "codex_app_server_local_turn_start_unproven_for_ui".into(),
                blocker: Some("official-history behavior is not fully proven".into()),
                proof_ref: None,
                dispatch_ref: None,
                mission_context: Some(ProviderWorkspaceMissionContextWire {
                    friday_conversation_id: "fconv_provider_workspace".into(),
                    mission_id: "mission-provider-workspace".into(),
                    work_item_id: "work-provider-workspace".into(),
                }),
            },
        }
    }

    fn mission_projection_snapshot() -> Message {
        Message::MissionProjectionSnapshot {
            snapshot: MissionProjectionSnapshotWire {
                friday_conversation_id: "fconv_global_secretary".into(),
                generated_at_ms: 1_700_000_000_000,
                projections: vec![
                    MissionSurfaceProjectionWire {
                        surface_thread_id: "surface-mobile-1".into(),
                        friday_conversation_id: "fconv_global_secretary".into(),
                        mission_id: "mission-1".into(),
                        surface_kind: "mobile".into(),
                        visibility_policy: "compact".into(),
                        title: "Ship Friday Mission Spine".into(),
                        status: "active".into(),
                        truth_status: "wired_registry".into(),
                        current_focus_summary: "same Mission across surfaces".into(),
                        proof_refs: vec!["proof://mission-spine".into()],
                        updated_at_ms: 1_700_000_000_001,
                    },
                    MissionSurfaceProjectionWire {
                        surface_thread_id: "surface-desktop-1".into(),
                        friday_conversation_id: "fconv_global_secretary".into(),
                        mission_id: "mission-1".into(),
                        surface_kind: "desktop".into(),
                        visibility_policy: "rich_proof".into(),
                        title: "Ship Friday Mission Spine".into(),
                        status: "active".into(),
                        truth_status: "wired_registry".into(),
                        current_focus_summary: "same Mission across surfaces".into(),
                        proof_refs: vec!["proof://mission-spine".into()],
                        updated_at_ms: 1_700_000_000_001,
                    },
                ],
                route_decisions: vec![RouteDecisionProjectionWire {
                    route_decision_ref:
                        "friday://route-decision-projection/mission-1/work-1/1700000000002".into(),
                    mission_id: "mission-1".into(),
                    work_item_id: "work-1".into(),
                    selected_lane: "channel".into(),
                    selected_target_label: Some("bound_channel".into()),
                    why_this_route: "same Mission state should reach the bound channel".into(),
                    considered_options: vec![
                        "mobile only".into(),
                        "shared Mission projection".into(),
                    ],
                    deferred_options: vec!["native provider history sync claim".into()],
                    previous_pitfalls: vec!["raw channel ids must not leak".into()],
                    inheritable_context: vec!["carry judgment, not transcript".into()],
                    conflict_ref_count: 1,
                    proof_requirements: vec!["route decision projection test".into()],
                    ownership_claim_count: 0,
                    trace_ref_count: 2,
                    created_at_ms: 1_700_000_000_002,
                    expires_at_ms: None,
                }],
            },
        }
    }

    fn mission_timeline_snapshot() -> Message {
        Message::MissionTimelineSnapshot {
            snapshot: MissionTimelineSnapshotWire {
                friday_conversation_id: "fconv_global_secretary".into(),
                mission_id: "mission-1".into(),
                generated_at_ms: 1_700_000_000_010,
                requested_cursor: Some("offset:0".into()),
                next_cursor: Some("offset:3".into()),
                retained_from: Some("offset:0".into()),
                bounded: true,
                has_more: true,
                mission: MissionTimelineMissionWire {
                    mission_id: "mission-1".into(),
                    friday_conversation_id: "fconv_global_secretary".into(),
                    title: "Ship Friday Mission Spine".into(),
                    intent: "keep one Mission across every surface".into(),
                    status: "active".into(),
                    why_now: "avoid pinned chat debt".into(),
                    decision_path_summary: "Mission first, providers as evidence".into(),
                    proof_refs: vec!["proof://mission-spine".into()],
                    updated_at_ms: 1_700_000_000_009,
                },
                projections: vec![MissionSurfaceProjectionWire {
                    surface_thread_id: "surface-mobile-1".into(),
                    friday_conversation_id: "fconv_global_secretary".into(),
                    mission_id: "mission-1".into(),
                    surface_kind: "mobile".into(),
                    visibility_policy: "compact".into(),
                    title: "Ship Friday Mission Spine".into(),
                    status: "active".into(),
                    truth_status: "wired_registry".into(),
                    current_focus_summary: "same Mission across surfaces".into(),
                    proof_refs: vec!["proof://mission-spine".into()],
                    updated_at_ms: 1_700_000_000_001,
                }],
                work_items: vec![MissionTimelineWorkItemWire {
                    work_item_id: "work-1".into(),
                    mission_id: "mission-1".into(),
                    lane: "channel".into(),
                    status: "provider_waiting".into(),
                    capability_id: Some("channel.telegram.send".into()),
                    risk_level: "low".into(),
                    approval_state: "not_required".into(),
                    has_blocker: false,
                    owner_claim_count: 0,
                    workspace_ref_count: 0,
                    input_ref_count: 1,
                    output_ref_count: 0,
                    proof_requirements: vec!["proof receipt required before done".into()],
                    proof_receipts: vec![],
                    updated_at_ms: 1_700_000_000_008,
                }],
                links: vec![
                    MissionTimelineLinkWire {
                        link_ref: "friday://mission-link-projection/mission-1/channel_inbound/1/0"
                            .into(),
                        mission_id: "mission-1".into(),
                        work_item_id: Some("work-1".into()),
                        link_kind: "channel_inbound".into(),
                        has_proof: true,
                        proof_ref: Some("audit://channel-redacted".into()),
                        grants_memory_authority: false,
                        created_at_ms: 1_700_000_000_003,
                    },
                    MissionTimelineLinkWire {
                        link_ref: "friday://mission-link-projection/mission-1/memory_candidate/2/1"
                            .into(),
                        mission_id: "mission-1".into(),
                        work_item_id: None,
                        link_kind: "memory_candidate".into(),
                        has_proof: false,
                        proof_ref: None,
                        grants_memory_authority: false,
                        created_at_ms: 1_700_000_000_004,
                    },
                ],
                route_decisions: vec![RouteDecisionProjectionWire {
                    route_decision_ref:
                        "friday://route-decision-projection/mission-1/work-1/1700000000002".into(),
                    mission_id: "mission-1".into(),
                    work_item_id: "work-1".into(),
                    selected_lane: "channel".into(),
                    selected_target_label: Some("bound_channel".into()),
                    why_this_route: "same Mission state should reach the bound channel".into(),
                    considered_options: vec![
                        "mobile only".into(),
                        "shared Mission projection".into(),
                    ],
                    deferred_options: vec!["native provider history sync claim".into()],
                    previous_pitfalls: vec!["raw channel ids must not leak".into()],
                    inheritable_context: vec!["carry judgment, not transcript".into()],
                    conflict_ref_count: 1,
                    proof_requirements: vec!["route decision projection test".into()],
                    ownership_claim_count: 0,
                    trace_ref_count: 2,
                    created_at_ms: 1_700_000_000_002,
                    expires_at_ms: None,
                }],
                surface_events: vec![MissionTimelineSurfaceEventWire {
                    surface_event_id: "surf-event-mobile-1".into(),
                    friday_conversation_id: "fconv_global_secretary".into(),
                    mission_id: "mission-1".into(),
                    work_item_id: Some("work-1".into()),
                    surface_thread_id: "surface-mobile-1".into(),
                    source_surface: "mobile".into(),
                    event_kind: "user_message".into(),
                    body_ref: Some("friday://body/mobile-message/1".into()),
                    visibility_policy: "compact".into(),
                    proof_ref: Some("audit://surface-event-redacted".into()),
                    created_at_ms: 1_700_000_000_005,
                }],
            },
        }
    }

    fn mission_lifecycle_result() -> Message {
        Message::MissionLifecycleResult {
            result: MissionLifecycleResultWire {
                friday_conversation_id: "fconv_global_secretary".into(),
                mission_id: "mission-1".into(),
                previous_status: "active".into(),
                status: "paused".into(),
                actor_ref: "operator:jarvis".into(),
                reason: "pause before conflicting route".into(),
                proof_ref: Some("audit://mission-lifecycle/1".into()),
                merged_into_mission_id: None,
                active_mission_ids: vec!["mission-1".into()],
                updated_at_ms: 1_700_000_000_006,
            },
        }
    }

    #[test]
    fn envelope_round_trips_for_each_kind() {
        let cases = vec![
            Message::Pair {
                device_id: "dev-1".into(),
                device_pubkey: vec![1, 2, 3],
                pairing_proof: vec![4, 5],
            },
            Message::AskFridayRequest {
                prompt: "hello".into(),
                mission_context: None,
            },
            Message::AskFridayResult {
                ledger_id: "l1".into(),
                result_link: Some("friday://result/1".into()),
            },
            Message::LedgerEntry {
                ledger_id: "l1".into(),
                provider_kind: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                base_url_host: "api.deepseek.com".into(),
                total_tokens: 31,
                fallback: false,
            },
            Message::Error {
                code: ErrorCode::ProviderUnavailable,
                message: "down".into(),
            },
            provider_workspace_snapshot(),
            provider_workspace_action_request(),
            provider_workspace_action_result(),
            Message::MissionProjectionRequest {
                request: MissionProjectionRequestWire {
                    friday_conversation_id: "fconv_global_secretary".into(),
                },
            },
            Message::MissionIntakeRequest {
                request: MissionIntakeRequestWire {
                    friday_conversation_id: "fconv_global_secretary".into(),
                    owner_principal: "owner-1".into(),
                    surface_thread_id: "surface-mobile-1".into(),
                    surface_kind: "mobile".into(),
                    delivery_route: "mobile".into(),
                    visibility_policy: "compact".into(),
                    mission_id: "mission-1".into(),
                    work_item_id: "work-1".into(),
                    title: "Coordinate Friday work".into(),
                    intent: "keep one Mission across every surface".into(),
                    lane: "deepseek".into(),
                    target_provider_or_agent: Some("deepseek".into()),
                    capability_id: Some("ask_friday.deepseek".into()),
                    body_ref: Some("friday://body/mobile/1".into()),
                    includes_sensitive_context: false,
                },
            },
            Message::MissionIntakeResult {
                result: MissionIntakeResultWire {
                    friday_conversation_id: "fconv_global_secretary".into(),
                    mission_id: "mission-1".into(),
                    work_item_id: Some("work-1".into()),
                    surface_thread_id: "surface-mobile-1".into(),
                    status: "ready".into(),
                    blockers: Vec::new(),
                    duplicate_mission_id: None,
                    duplicate_work_item_id: None,
                    created_or_ready: true,
                },
            },
            mission_projection_snapshot(),
            Message::MissionTimelineRequest {
                request: MissionTimelineRequestWire {
                    friday_conversation_id: "fconv_global_secretary".into(),
                    mission_id: "mission-1".into(),
                    cursor: Some("offset:2".into()),
                    limit: Some(25),
                },
            },
            mission_timeline_snapshot(),
            Message::MissionLifecycleRequest {
                request: MissionLifecycleRequestWire {
                    friday_conversation_id: "fconv_global_secretary".into(),
                    mission_id: "mission-1".into(),
                    target_status: "paused".into(),
                    actor_ref: "operator:jarvis".into(),
                    reason: "pause before conflicting route".into(),
                    proof_ref: Some("audit://mission-lifecycle/1".into()),
                    merged_into_mission_id: None,
                },
            },
            mission_lifecycle_result(),
        ];
        for msg in cases {
            let env = Envelope::new("m1", 1000, msg).with_correlation("c1");
            let json = env.encode().unwrap();
            assert!(json.contains(&format!("\"schema_version\":{CURRENT_SCHEMA_VERSION}")));
            let back = Envelope::decode(&json).unwrap();
            assert_eq!(back, env);
        }
    }

    #[test]
    fn provider_timeline_reconnect_wire_round_trips_delta_and_snapshot() {
        // DELTA: internally tagged by mode; events carry refs only; a Hub-ack pending
        // action is NOT terminal (ack != provider completion).
        let delta = Message::ProviderTimelineReconnect {
            friday_session_id: "fsess-1".into(),
            reconnect: ProviderTimelineReconnectWire::Delta {
                from_seq: 2,
                to_seq: 4,
                from_revision: 5,
                to_revision: 7,
                events: vec![ProviderTimelineEventWire {
                    seq: 3,
                    revision: 6,
                    event_kind: "provider_event".into(),
                    actor: "provider".into(),
                    body_ref: Some("ref://event/3".into()),
                    provider_event_id: Some("pe-3".into()),
                }],
                pending: vec![ProviderTimelinePendingWire {
                    request_id: "r1".into(),
                    client_msg_id: "c1".into(),
                    action: "send_turn".into(),
                    state: "accepted_by_hub".into(),
                    terminal: false,
                    dispatch_ref: None,
                    blocker: None,
                    base_revision: 5,
                    updated_at_revision: 6,
                }],
            },
        };
        let env = Envelope::new("ptl-delta", 1000, delta.clone());
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"ProviderTimelineReconnect\""));
        assert!(json.contains("\"mode\":\"delta\""));
        assert!(json.contains("\"body_ref\":\"ref://event/3\""));
        assert!(json.contains("\"terminal\":false")); // Hub ack is not completion
        assert_eq!(Envelope::decode(&json).unwrap(), env);

        // SNAPSHOT: carries the fallback reason; round-trips.
        let snapshot = Message::ProviderTimelineReconnect {
            friday_session_id: "fsess-1".into(),
            reconnect: ProviderTimelineReconnectWire::Snapshot {
                to_seq: 9,
                revision: 12,
                events: vec![],
                pending: vec![],
                reason: "cursor_behind_retention".into(),
            },
        };
        let env = Envelope::new("ptl-snap", 1001, snapshot);
        let json = env.encode().unwrap();
        assert!(json.contains("\"mode\":\"snapshot\""));
        assert!(json.contains("\"reason\":\"cursor_behind_retention\""));
        assert_eq!(Envelope::decode(&json).unwrap(), env);
    }

    #[test]
    fn provider_workspace_snapshot_wire_is_redacted_and_truth_labeled() {
        let env = Envelope::new("provider-workspace-1", 1000, provider_workspace_snapshot());
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"ProviderWorkspaceSnapshot\""));
        assert!(json.contains("\"capability_id\":\"provider.codex.send_turn\""));
        assert!(json.contains("official-history"));
        assert!(json.contains("\"routed\":false"));
        assert!(json.contains("\"provider_action\":\"codex_app_server\""));
        for forbidden in [
            "sk-",
            "account-hash",
            "/Users/jarvis/private",
            "external-thread",
            "https://provider.example/private",
            "raw command body",
        ] {
            assert!(
                !json.contains(forbidden),
                "provider workspace snapshot leaked {forbidden}: {json}"
            );
        }
        let decoded = Envelope::decode(&json).unwrap();
        assert_eq!(decoded, env);
    }

    #[test]
    fn provider_workspace_action_request_and_result_are_metadata_only() {
        let request = Envelope::new(
            "provider-action-1",
            1000,
            provider_workspace_action_request(),
        );
        let result = Envelope::new(
            "provider-action-2",
            1001,
            provider_workspace_action_result(),
        );
        for env in [request, result] {
            let json = env.encode().unwrap();
            assert!(json.contains("ProviderWorkspaceAction"));
            assert!(json.contains(&format!("\"schema_version\":{CURRENT_SCHEMA_VERSION}")));
            assert!(json.contains("\"capability_id\":\"provider.codex.send_turn\""));
            assert!(json.contains("\"mission_id\":\"mission-provider-workspace\""));
            for forbidden in [
                "raw user prompt",
                "rm -rf",
                "sk-",
                "provider-token",
                "/Users/jarvis/private",
                "https://provider.example/private",
            ] {
                assert!(
                    !json.contains(forbidden),
                    "provider workspace action wire leaked {forbidden}: {json}"
                );
            }
            assert_eq!(Envelope::decode(&json).unwrap(), env);
        }
    }

    #[test]
    fn mission_projection_snapshot_wire_is_redacted_and_shared_across_surfaces() {
        let env = Envelope::new("mission-proj-1", 1000, mission_projection_snapshot());
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"MissionProjectionSnapshot\""));
        assert!(json.contains("\"friday_conversation_id\":\"fconv_global_secretary\""));
        assert!(json.contains("\"surface_kind\":\"mobile\""));
        assert!(json.contains("\"surface_kind\":\"desktop\""));
        assert!(json.contains("\"mission_id\":\"mission-1\""));
        assert!(json.contains("\"status\":\"active\""));
        for forbidden in [
            "account-hash",
            "/Users/jarvis/private",
            "external-session",
            "external-thread",
            "https://provider.example/private",
            "tg:raw-chat-id",
            "raw transcript",
            "sk-",
        ] {
            assert!(
                !json.contains(forbidden),
                "mission projection wire leaked {forbidden}: {json}"
            );
        }
        assert_eq!(Envelope::decode(&json).unwrap(), env);
    }

    #[test]
    fn mission_timeline_snapshot_wire_is_refs_only_and_does_not_complete_work() {
        let env = Envelope::new("mission-timeline-1", 1000, mission_timeline_snapshot());
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"MissionTimelineSnapshot\""));
        assert!(json.contains("\"mission_id\":\"mission-1\""));
        assert!(json.contains("\"requested_cursor\":\"offset:0\""));
        assert!(json.contains("\"next_cursor\":\"offset:3\""));
        assert!(json.contains("\"retained_from\":\"offset:0\""));
        assert!(json.contains("\"bounded\":true"));
        assert!(json.contains("\"has_more\":true"));
        assert!(json.contains("\"link_kind\":\"channel_inbound\""));
        assert!(json.contains("\"link_kind\":\"memory_candidate\""));
        assert!(json.contains("\"event_kind\":\"user_message\""));
        assert!(json.contains("\"body_ref\":\"friday://body/mobile-message/1\""));
        assert!(json.contains("\"grants_memory_authority\":false"));
        assert!(json.contains("\"status\":\"provider_waiting\""));
        assert!(!json.contains("\"status\":\"completed_with_proof\""));
        for forbidden in [
            "account-hash",
            "/Users/jarvis/private",
            "external-session",
            "external-thread",
            "https://provider.example/private",
            "tg:raw-chat-id",
            "telegram:raw-chat-123",
            "raw transcript",
            "raw user prompt",
            "sk-",
        ] {
            assert!(
                !json.contains(forbidden),
                "mission timeline wire leaked {forbidden}: {json}"
            );
        }
        assert_eq!(Envelope::decode(&json).unwrap(), env);
    }

    #[test]
    fn mission_lifecycle_wire_is_status_receipt_not_completion_proof_by_itself() {
        let env = Envelope::new("mission-lifecycle-1", 1000, mission_lifecycle_result());
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"MissionLifecycleResult\""));
        assert!(json.contains("\"previous_status\":\"active\""));
        assert!(json.contains("\"status\":\"paused\""));
        assert!(json.contains("\"proof_ref\":\"audit://mission-lifecycle/1\""));
        assert!(!json.contains("\"completed_with_proof\""));
        for forbidden in [
            "provider-thread",
            "telegram:raw-chat-id",
            "raw transcript",
            "sk-",
            "/Users/jarvis/private",
        ] {
            assert!(
                !json.contains(forbidden),
                "mission lifecycle wire leaked {forbidden}: {json}"
            );
        }
        assert_eq!(Envelope::decode(&json).unwrap(), env);
    }

    #[test]
    fn decode_tolerates_unknown_future_fields() {
        // A newer peer adds a field we don't know; we must still parse.
        let json = r#"{"schema_version":1,"msg_id":"m1","sent_at":5,
            "future_top_level":"ignored",
            "message":{"kind":"AskFridayRequest","prompt":"hi","future_field":42}}"#;
        let env = Envelope::decode(json).unwrap();
        assert_eq!(
            env.message,
            Message::AskFridayRequest {
                prompt: "hi".into(),
                mission_context: None,
            }
        );
    }

    #[test]
    fn decode_rejects_unknown_kind_explicitly() {
        let json = r#"{"schema_version":1,"msg_id":"m1","sent_at":5,
            "message":{"kind":"TeleportUser","whom":"all"}}"#;
        assert!(matches!(
            Envelope::decode(json),
            Err(ProtocolError::Decode(_))
        ));
    }

    #[test]
    fn version_negotiation_picks_highest_common() {
        assert_eq!(
            negotiate_version(
                VersionRange { min: 1, max: 3 },
                VersionRange { min: 2, max: 5 }
            )
            .unwrap(),
            3
        );
        assert_eq!(
            negotiate_version(
                VersionRange { min: 1, max: 4 },
                VersionRange { min: 2, max: 5 }
            )
            .unwrap(),
            4
        );
        assert_eq!(
            negotiate_version(
                VersionRange { min: 1, max: 1 },
                VersionRange { min: 1, max: 1 }
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn version_negotiation_errors_when_disjoint() {
        let err = negotiate_version(
            VersionRange { min: 1, max: 1 },
            VersionRange { min: 2, max: 4 },
        )
        .unwrap_err();
        assert!(matches!(err, ProtocolError::VersionUnsupported { .. }));
    }

    #[test]
    fn idempotency_executes_command_once() {
        let mut t = IdempotencyTracker::new();
        assert_eq!(t.observe("cmd-1"), Seen::First); // execute
        assert_eq!(t.observe("cmd-1"), Seen::Replay); // reconnect resend -> skip
        assert_eq!(t.observe("cmd-2"), Seen::First);
        assert!(t.has_seen("cmd-1"));
    }

    #[test]
    fn resumable_stream_replays_only_missed_frames() {
        let mut s = ResumableStream::new();
        assert_eq!(s.push("a"), 1);
        assert_eq!(s.push("b"), 2);
        assert_eq!(s.push("c"), 3);
        // Peer acked up to seq 1 -> it missed 2 and 3.
        let missed = s.missed_since(1);
        assert_eq!(
            missed,
            vec![
                StreamFrame {
                    seq: 2,
                    chunk: "b".into()
                },
                StreamFrame {
                    seq: 3,
                    chunk: "c".into()
                },
            ]
        );
        // Fully caught up -> nothing to replay.
        assert!(s.missed_since(3).is_empty());
    }

    #[test]
    fn provider_session_projection_wire_is_redacted() {
        let wire: ProviderSessionProjectionWire = friday_core::ProviderSessionLink {
            friday_session_id: "friday-s1".into(),
            provider: "codex".into(),
            account_key_hash: "account-hash".into(), // pragma: allowlist secret
            workspace_id: "workspace".into(),
            cwd: Some("/Users/jarvis/private".into()),
            external_session_id: Some("external-session".into()),
            external_thread_id: Some("external-thread".into()),
            external_url: Some("https://provider.example/private".into()),
            sync_mode: friday_core::SyncMode::ProviderAppServerLocal,
            capability_snapshot: "thread/read".into(),
            last_provider_seen_at: Some(1),
            last_friday_event_id: Some("event-1".into()),
            truth_label: "provider local session".into(),
        }
        .redacted_projection()
        .into();
        let json = serde_json::to_string(&wire).unwrap();
        assert!(json.contains("provider_app_server_local"));
        for forbidden in [
            "account-hash",
            "/Users/jarvis/private",
            "external-session",
            "external-thread",
            "https://provider.example/private",
        ] {
            assert!(
                !json.contains(forbidden),
                "provider session wire projection leaked {forbidden}: {json}"
            );
        }
    }

    #[test]
    fn friday_pair_payload_wire_round_trips_and_projection_redacts_secret() {
        let payload = friday_core::FridayPairPayload::new(
            friday_core::CURRENT_PAIR_PAYLOAD_VERSION,
            "hub-mac-mini",
            "pair-1",
            "friday-pairing-secret-32-bytes",
            "Jarvis Mac mini",
            vec![friday_core::PairTransportHint::new(
                friday_core::PairTransportKind::LanWebSocket,
                "ws://192.168.1.8:4477",
                "LAN WebSocket",
            )
            .unwrap()],
            2000,
            vec![
                friday_core::PairAuthority::StatusOnly,
                friday_core::PairAuthority::Approvals,
            ],
        )
        .unwrap();
        let wire = FridayPairPayloadWire::from(&payload);
        let debug = format!("{wire:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains(payload.pairing_secret.expose_for_qr()));

        let json = wire.encode_qr_json().unwrap();
        assert!(
            json.contains(payload.pairing_secret.expose_for_qr()),
            "QR JSON must carry the Friday-scoped pairing secret"
        );
        let decoded = FridayPairPayloadWire::decode_qr_json(&json)
            .unwrap()
            .into_core()
            .unwrap();
        decoded.validate_at(1000).unwrap();

        let projection: FridayPairProjectionWire = decoded.redacted_projection().into();
        let projection_json = serde_json::to_string(&projection).unwrap();
        assert!(!projection_json.contains(payload.pairing_secret.expose_for_qr()));
        assert!(projection_json.contains("LAN WebSocket"));
    }

    #[test]
    fn friday_pair_payload_wire_rejects_unknown_authority_and_provider_secret_hints() {
        let raw = format!(
            r#"{{
            "v":1,
            "hub_id":"hub",
            "pairing_id":"pair",
            "pairing_{}":"friday-pairing-credential-32-bytes",
            "display_name":"Hub",
            "transport_hints":[{{"kind":"lan_websocket","endpoint":"ws://127.0.0.1:4477?api_key=abc","label":"LAN"}}],
            "expires_at":2000,
            "capabilities_hint":["status_only"]
        }}"#,
            "secret"
        );
        assert!(FridayPairPayloadWire::decode_qr_json(&raw)
            .unwrap()
            .into_core()
            .is_err());

        let raw = format!(
            r#"{{
            "v":1,
            "hub_id":"hub",
            "pairing_id":"pair",
            "pairing_{}":"friday-pairing-credential-32-bytes",
            "display_name":"Hub",
            "transport_hints":[{{"kind":"lan_websocket","endpoint":"ws://127.0.0.1:4477","label":"LAN"}}],
            "expires_at":2000,
            "capabilities_hint":["provider_oauth_admin"]
        }}"#,
            "secret"
        );
        assert!(FridayPairPayloadWire::decode_qr_json(&raw)
            .unwrap()
            .into_core()
            .is_err());
    }
}
