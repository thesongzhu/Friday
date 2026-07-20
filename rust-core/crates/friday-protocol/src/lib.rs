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
//! WS-transport substrate (S-A) for the executeRun-replacement: the agent-run
//! request/result wire shapes carried over the long-lived sealed session (schema v12).
//! Session-detail, attachments, and workflow messages remain deferred to their owning
//! units; for the provider lane, what is still deferred is NOT these wire types but the
//! real provider ADAPTERS (live dispatch) and the operator-gated remote proof lanes. The
//! actual networked WebSocket + relay + live key exchange are the Unit-4 transport
//! sub-slice (this crate is the contract they carry).

use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;

/// Highest wire schema version this build speaks.
///
/// v12 adds the WS-transport substrate (S-A) message kinds for the
/// executeRun-replacement (`AgentRunRequest`/`AgentRunResult`). These land DARK:
/// nothing constructs or dispatches them yet — the server/dispatch/auth arms are
/// later sub-slices (S-B/S-C). Bumping the wire version here keeps wire-compat
/// honest (a peer that speaks v12 advertises these kinds exist), even while no
/// production route emits them.
///
/// v13 (A1 run-controls) adds the on-wire run-CONTROL protocol for the live
/// agent-run: `AgentRunPaused` (emitted when the loop's gate Pauses a mutating
/// tool — today a Paused run drops into the NoAnswer black hole), `AgentRunResume`
/// (TS is a pure COURIER of the operator's out-of-band Ed25519 signature, never its
/// author), `AgentRunCancel` (owner-authed terminal stop), `AgentRunReject`
/// (owner-authed `pending_approval_request.status='rejected'`), and the
/// `AgentRunControlResult` receipt. These also land DARK: the new variants append
/// to the enum (a peer that speaks v13 advertises they exist), but NOTHING emits or
/// handles them in production until the A1 server handlers are wired behind the
/// NEW default-off `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` flag. With that flag OFF a
/// Paused run emits exactly the pre-A1 `AgentRunResult{status:"no_answer"}` bytes —
/// so deploying a v13 binary changes NO live behavior. The constraint fields added
/// to `AgentRunRequest` are additive-optional (absent ⇒ byte-identical to the
/// pre-A1 wire), so the live courier's current bytes still decode to no-constraints.
///
/// v14 (D20 W1 route-decision control) adds `RouteDecisionControlRequest/Result`.
/// These wire the existing Hub-owned route veto/override lifecycle controls through
/// the sealed Mission Spine dispatch flag. They stay refs-only and default-dark: a
/// v14 binary with the dispatch flag off still echoes the message as a keepalive,
/// changing no live behavior.
///
/// v15 (A1 run-outcome learning confirm) adds
/// `RunOutcomeLearningDecisionRequest/Result`: the owner-authed, refs-only terminal
/// confirm/reject caller for pending run-outcome learning candidates. It is a pure
/// Hub DB mutation, default-dark behind the serving flag, and carries no answer body.
pub const CURRENT_SCHEMA_VERSION: u16 = 16;
/// The inclusive range of versions this build supports.
pub const SUPPORTED: VersionRange = VersionRange { min: 1, max: 16 };

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

/// Surface-safe D20 W1 plan action attached to a route decision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteActionItemWire {
    pub description: String,
    pub target_kind: String,
    pub target_ref: String,
    pub reversibility: String,
    pub assigned_lane: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_provider_or_agent: Option<String>,
    pub route_reason: String,
}

impl From<friday_core::RouteActionItem> for RouteActionItemWire {
    fn from(value: friday_core::RouteActionItem) -> Self {
        Self {
            description: value.description,
            target_kind: value.target_kind.as_str().to_string(),
            target_ref: value.target_ref,
            reversibility: value.reversibility.as_str().to_string(),
            assigned_lane: value.assigned_lane.as_str().to_string(),
            assigned_provider_or_agent: value.assigned_provider_or_agent,
            route_reason: value.route_reason,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub action_items: Vec<RouteActionItemWire>,
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
            action_items: value.action_items.into_iter().map(Into::into).collect(),
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

/// Client request to advance ONE WorkItem's lifecycle through the Hub state
/// machine. This is a Hub-owned mutation, not a provider/model call. A
/// `target_status` of `completed_with_proof` MUST carry a non-empty
/// `proof_receipt` — the persistence layer rejects a proofless completion so
/// "done" can never be claimed without proof (the proof-on-completion invariant).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkItemStatusRequestWire {
    pub work_item_id: String,
    pub target_status: String,
    pub actor_ref: String,
    pub reason: String,
    /// REQUIRED when `target_status == "completed_with_proof"` (non-empty), and
    /// REJECTED for any other target. Absent ⇒ no receipt is appended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_receipt: Option<String>,
}

/// Hub response after a WorkItem lifecycle command. It returns the changed
/// WorkItem's previous/current status and the redacted proof-receipt count; a
/// status of `completed_with_proof` here is only honest because the persistence
/// layer enforced a non-empty receipt before writing it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkItemStatusResultWire {
    pub work_item_id: String,
    pub mission_id: String,
    pub previous_status: String,
    pub status: String,
    pub actor_ref: String,
    pub reason: String,
    /// COUNT of persisted proof receipts (never the raw receipt refs themselves).
    pub proof_receipt_count: u64,
    pub updated_at_ms: i64,
}

/// Client request to apply one OWNER route-decision control before dispatch.
/// `control_kind="veto"` blocks the `ReadyToDispatch -> Dispatched` transition;
/// `control_kind="override"` changes the selected lane/target when that transition
/// is applied. This is Hub-owned lifecycle control, never a provider/model call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteDecisionControlRequestWire {
    pub decision_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    pub control_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_lane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_provider_or_agent: Option<String>,
    pub actor_ref: String,
    pub reason: String,
}

/// Hub response after one route-decision control is persisted. It carries only
/// canonical ids and the chosen control; it is not a provider dispatch receipt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteDecisionControlResultWire {
    pub decision_id: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub control_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_lane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_provider_or_agent: Option<String>,
    pub actor_ref: String,
    pub reason: String,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proof_requirements: Vec<String>,
    #[serde(default)]
    pub includes_sensitive_context: bool,
}

/// Hub response for Mission intake/preflight. `status=blocked` means no new
/// WorkItem was written; duplicate ids tell the client which existing Mission or
/// WorkItem to show. `status=needs_clarification` (the flag-gated mission-intake
/// clarification arm) means the intent was UNDER-SPECIFIED so NO rows were written
/// at all — `clarification_questions` carries the specific questions to ask, and
/// `created_or_ready` is `false` so the auto-dispatch producer never fires for it.
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
    /// The canonical WorkItem route selected by Rust intake. Optional for
    /// backward compatibility and non-ready results; when present it lets thin
    /// TS producers dispatch the server-selected route instead of re-reading
    /// the raw request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_lane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_target_provider_or_agent: Option<String>,
    /// (Mission-intake clarification — DARK, default-OFF) The specific clarifying
    /// questions for an UNDER-SPECIFIED intent. NON-EMPTY only when
    /// `status == "needs_clarification"`; every existing ready/blocked path leaves
    /// it empty. Additive + optional on the wire (`#[serde(default)]` + skipped when
    /// empty) so existing serialized payloads round-trip BYTE-IDENTICALLY.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clarification_questions: Vec<String>,
}

/// Client request to apply the OWNER's explicit confirm/reject decision to ONE
/// pending memory candidate (the Memory-confirmation loop's terminal action,
/// `07` §6/§7). This is the owner's OWN action over the sealed single-peer session
/// (the session IS the channel auth) — NOT an agent mutating-tool action, so it
/// does NOT route through the approval/trust gate. It is a pure Hub `&Db` mutation
/// (NO provider/model call). The decision is owner/namespace-scoped: it applies
/// ONLY when `owner_principal` matches the candidate's owning principal, fail-closed
/// on any mismatch (an unowned candidate is decidable by no one). A candidate becomes
/// durable (`Confirmed`, recallable) ONLY through this explicit confirm — there is no
/// auto-confirm path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryDecisionRequestWire {
    /// The candidate `memory_item` to decide on.
    pub memory_id: String,
    /// The owner principal asserting the decision. MUST equal the candidate's owning
    /// `principal_id` (the same key `recall_confirmed` enforces) — else fail-closed.
    pub owner_principal: String,
    /// The explicit decision: `"confirm"` (→ durable/recallable) or `"reject"`
    /// (→ terminal, never recallable). Parsed fail-closed: any other token is an Error.
    pub decision: String,
}

/// Hub response for a memory decision. Refs-only: it carries the candidate's id +
/// the resulting lifecycle state + a coarse status/reason — NEVER the candidate's
/// content (the content stays Hub-side; only the owner recalls it). `status` is
/// `"confirmed"` / `"rejected"` (the decision applied) or `"blocked"` (scope
/// mismatch / unknown candidate / terminal / invalid decision); `blocker` carries
/// the coarse reason when blocked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryDecisionResultWire {
    pub memory_id: String,
    /// The resulting lifecycle state token (`"candidate"` / `"confirmed"` /
    /// `"rejected"`) — the candidate's CURRENT state after the decision. On a block
    /// this reflects no change (or `"unknown"` when the candidate does not exist).
    pub state: String,
    /// Coarse outcome: `"confirmed"` / `"rejected"` / `"blocked"`.
    pub status: String,
    /// Set ONLY when `status == "blocked"`: the coarse reason (scope mismatch /
    /// unknown / terminal / invalid decision). Never echoes candidate content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
    /// Whether the candidate is now recallable (durable `Confirmed`). Mirrors
    /// `created_or_ready` on the intake result — a single honest yes/no.
    pub recallable: bool,
}

/// (CORE-A CR-3) Client request to CREATE/ensure ONE agent-session row over the sealed single-peer
/// session — the Rust-owned counterpart of the retired TS `sessions.create`. This is a PURE Hub
/// `&Db` mutation (NO provider/model call). The session's OWNER is the server-AUTHENTICATED principal
/// (the single-peer session IS the channel auth), NEVER a raw client field: the dispatch arm binds
/// `agent_session.user_id` to the Rust-derived owner exactly as `run_session_task_pinned` does, and
/// applies the FIX-Q3b cross-check (a body `user_id` that disagrees with the authenticated owner is
/// fail-closed). `session_id` is the canonical session key the client already derives; the remaining
/// axes are DESCRIPTIVE surface metadata. Matches the internally-tagged `{ request }` wrapper the
/// sibling `MemoryDecisionRequest` uses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCreateRequestWire {
    /// The canonical session key (`agent_session_id`) to ensure. Non-empty (the store rejects blank).
    pub session_id: String,
    /// Descriptive surface channel (e.g. `discord`). Additive + optional; absent ⇒ omitted on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Descriptive surface chat id. Additive + optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    /// The OWNER principal the client forwards. **NOT the authority** — the dispatch arm binds the
    /// session owner to the server-AUTHENTICATED principal and FIX-Q3b-refuses a value that
    /// disagrees. Additive + optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// Descriptive account/tenant id. Additive + optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Descriptive chat kind (e.g. `dm` / `channel`). Additive + optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_kind: Option<String>,
    /// Opaque client metadata as a JSON STRING (refs-only; the minimal session store does not persist
    /// it — it is echoed client-side). Additive + optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_json: Option<String>,
}

/// (CORE-A CR-3) Hub receipt for a session create/ensure. REFS-ONLY: the ensured session id + its
/// stored timestamps — NEVER any message body or descriptive echo (the client already holds the
/// surface fields it sent). `created_at` is the row's ORIGINAL creation time (an idempotent re-ensure
/// of an existing session keeps its `created_at` and only bumps `updated_at`), read back from the
/// store so the receipt is authoritative, not a `now_ms` guess.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCreateResultWire {
    pub session_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// (CORE-A CR-3) Client request to APPEND ONE conversation message to an existing session over the
/// sealed single-peer session — the Rust-owned counterpart of the retired TS
/// `sessions.messages.create`. PURE Hub `&Db` mutation (NO provider/model call). OWNER-GATED: the
/// dispatch arm refuses fail-closed unless the target session is owned by the server-AUTHENTICATED
/// principal (a guessed `session_id` cannot append to another owner's session). `content` is a BODY
/// kept Hub-side (the SAME discipline as the session store) — it rides the SEALED session, never a
/// refs field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMessageAppendRequestWire {
    /// The target session key (`agent_session_id`) — the message is refused unless the authenticated
    /// principal owns it.
    pub session_id: String,
    /// The speaker role (e.g. `user` / `assistant`). Non-empty (the store rejects a blank role).
    pub role: String,
    /// The message body kept Hub-side. Sealed on the wire; never echoed in the refs-only receipt.
    pub content: String,
    /// Optional soft-link ref (e.g. the producing run id). Additive + optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refs: Option<String>,
}

/// (CORE-A CR-3) Hub receipt for a session message append. REFS-ONLY: the assigned message id + its
/// per-session ordinal + timestamps — NEVER the appended body. `seq` is the store-assigned monotonic
/// ordinal (0 for the first message); `created_at`/`updated_at` are the append time (the store writes
/// both to the same `now_ms`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMessageAppendResultWire {
    pub message_id: String,
    pub seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One refs-only context-passport item proposed by a trusted client. Labels are operator/user
/// reviewed summaries or refs; sensitive raw material must not ride this wire. The Hub runs the
/// canonical context-passport gate before persisting any row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextPassportItemWire {
    pub kind: String,
    pub label: String,
    pub included: bool,
    pub sensitive: bool,
}

/// Client request to mint one ContextPassport for an existing Mission. This is a Hub-owned
/// governance mutation over the sealed peer session, never a provider/model call and never direct
/// DB access from the client.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextPassportTransferRequestWire {
    pub passport_id: String,
    pub mission_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    pub destination_lane: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_target: Option<String>,
    #[serde(default)]
    pub items: Vec<ContextPassportItemWire>,
    #[serde(default)]
    pub approved_sensitive: bool,
}

/// Hub response for context-passport minting. Refs-only; never echoes item content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextPassportTransferResultWire {
    pub passport_id: String,
    pub mission_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    pub destination_lane: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_target: Option<String>,
    pub shared_item_count: u64,
    pub mission_ref_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_id: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
}

/// Client request to apply the OWNER's explicit confirm/reject decision to ONE
/// pending A1 run-outcome learning candidate. This is refs-only governance over a
/// candidate row that already points at a run/session; it never carries the run
/// answer body and never calls a provider/model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunOutcomeLearningDecisionRequestWire {
    pub candidate_id: String,
    pub decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Hub response for a run-outcome learning decision. Refs-only: candidate/run
/// ids, lifecycle state, coarse status/blocker, and the candidate kind.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunOutcomeLearningDecisionResultWire {
    pub candidate_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub state: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
}

/// Client request to mark one Activity / Needs-Me item as `done`.
///
/// This is a refs-only owner action over an existing `activity_item`; it never carries a
/// transcript/body, never completes a WorkItem, and never calls a provider/model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityMarkDoneRequestWire {
    pub activity_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Hub response for an Activity / Needs-Me `done` action. Refs-only: the activity id,
/// resulting state, coarse status, and optional blocker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityMarkDoneResultWire {
    pub activity_id: String,
    pub state: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
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

/// (A1 run-controls) Per-run CONSTRAINTS carried on an `AgentRunRequest`. ADDITIVE +
/// OPTIONAL on the wire: an absent field is `None` (`#[serde(default)]`) and a `None`
/// constraints block is OMITTED from the wire (`skip_serializing_if`), so a request with
/// no constraints is BYTE-IDENTICAL to the pre-A1 `AgentRunRequest`. This mirrors the
/// `session_id` additive-optional discipline.
///
/// **SECURITY / TRUTH:** these are CLIENT-ASSERTED per-run restrictions the trusted-TS peer
/// forwards; the server maps them onto the per-run `RunPolicy` (read-only / disabled-tool /
/// max-turns) — they can only ever TIGHTEN a run (a constraint is a restriction, never a
/// grant). Today the wire carries no constraints and read-only is enforced ONLY by the TS
/// qualifier (per the A2 design doc); this is the wire shape that lets a run be constrained
/// in Rust. A `None`/absent block ⇒ the server's existing default `RunPolicy` (unchanged
/// live behavior). The server NEVER widens a run from these — an unknown/missing field
/// fail-closes to the stricter interpretation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRunConstraintsWire {
    /// When `true`, the run is constrained read-only: a mutating tool is blocked BEFORE
    /// execution (strictly stricter than the gate's default Pause-pending-approval).
    /// Absent ⇒ `false` (the run uses the gate's normal mutating-action discipline).
    #[serde(default)]
    pub read_only: bool,
    /// Tools disabled for THIS run (an allowlist's complement, mirroring the TS oracle's
    /// `disabledTools`). A disabled tool is rejected before classification/execution. Absent
    /// ⇒ empty (no per-run disable beyond the gate). NEVER a grant — only a restriction.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled_tools: Vec<String>,
    /// A per-run `max_turns` cap, when the caller wants one tighter than the runtime default.
    /// The server takes `min(runtime_default, this)` so a client-asserted value can only ever
    /// LOWER the bound (never raise it past the runtime ceiling). Absent ⇒ the runtime default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u64>,
}

/// **S-R1** — client→read-server request for the Mission Workbench read projection over the DARK
/// sealed-WS READ seam. This is a PURE READ: it must never cause a model/provider call. The read
/// server runs the SAME owner-auth chain a write request does — `forwarded_principal` + `auth_proof`
/// are verified against the sealed session (possession-of-session + per-handshake nonce +
/// owner-allowlist), and the proof is bound to `request_id` (the read analog of the write path's
/// `run_id` — a read has no run). The projection is released ONLY to the bound authenticated
/// principal, never a client-asserted id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkbenchProjectionRequestWire {
    /// Optional Mission id; absent ⇒ the first active Mission (mirrors the bin's `--mission-id`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<String>,
    /// The TS-token-resolved / device-resolved principal conveyed by the peer. VERIFIED against the
    /// sealed session before release — never trusted as an authority on its own.
    pub forwarded_principal: String,
    /// The sealed possession-of-session proof, bound to `request_id` + `forwarded_principal` in its
    /// AAD (the read analog of the write `auth_proof`). Opaque bytes here.
    pub auth_proof: Vec<u8>,
    /// The opaque per-request id the `auth_proof` is bound to (the read analog of `run_id`). Binding
    /// the proof to a fresh request id is what gives reads the IDENTICAL anti-lift guarantee writes
    /// have without a run.
    pub request_id: String,
}

/// **S-R1** — read-server→client refs-only Mission Workbench snapshot. Carries the refs-only
/// projection JSON as a STRING (the projection is already the shared library fn's guarded, refs-only
/// output; re-typing the whole nested tree here would only invite drift). `truth_status`/labels ride
/// inside the JSON as-is — never upgraded. The body is sealed under the owner-only session by the
/// transport before it leaves the server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkbenchProjectionSnapshotWire {
    /// Echoes the request id this snapshot answers (correlation).
    pub request_id: String,
    /// The refs-only projection JSON (the shared `project_workbench` output, serialized). Refs only
    /// — `ledger_id`/`result_link`/`activity_id`/counts/labels, never an inline body. The read
    /// server runs the forbidden-output guard (inside `project_workbench`) before sealing this.
    pub projection_json: String,
    /// Hub epoch-millis at which the snapshot was generated (lets the UI flag a stale snapshot).
    pub generated_at_ms: i64,
}

/// **S-R2** — client→read-server request for the run-readback read projection over the DARK
/// sealed-WS READ seam. The sibling of [`WorkbenchProjectionRequestWire`]: a PURE READ (never a
/// model/provider call) that runs the SAME owner-auth chain — `forwarded_principal` + `auth_proof`
/// are verified against the sealed session (possession-of-session + per-handshake nonce +
/// owner-allowlist), the proof bound to `request_id` (the read analog of `run_id`). The snapshot is
/// released ONLY to the bound authenticated principal. DARK: nothing in production constructs this.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunReadbackRequestWire {
    /// The run id to read back (refs-only summary: state/loop-status/event-kinds/counts). REQUIRED —
    /// a run readback has no "first active" default (unlike the workbench's optional mission id).
    pub run_id: String,
    /// The TS-token-resolved / device-resolved principal conveyed by the peer. VERIFIED against the
    /// sealed session before release — never trusted as an authority on its own.
    pub forwarded_principal: String,
    /// The sealed possession-of-session proof, bound to `request_id` + `forwarded_principal` in its
    /// AAD (the read analog of the write `auth_proof`). Opaque bytes here.
    pub auth_proof: Vec<u8>,
    /// The opaque per-request id the `auth_proof` is bound to (the read analog of `run_id` for the
    /// AUTH binding — distinct from the `run_id` being read). Binding the proof to a fresh request
    /// id gives reads the IDENTICAL anti-lift guarantee writes have without a run.
    pub request_id: String,
}

/// **S-R2** — read-server→client refs-only run-readback snapshot. Carries the refs-only projection
/// JSON as a STRING (the shared `project_run_readback` fn's guarded, refs-only output;
/// state/loop_status/event-kinds/counts + DB-WIDE token totals labelled as such — never as run
/// cost). The body is sealed under the owner-only session by the transport before it leaves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunReadbackSnapshotWire {
    /// Echoes the request id this snapshot answers (correlation).
    pub request_id: String,
    /// The refs-only projection JSON (the shared `project_run_readback` output, serialized). Refs
    /// only — run_id/state/loop_status/event-kinds/counts + DB-wide token totals, never a body. The
    /// read server runs the forbidden-output guard (inside the projection fn) before sealing this.
    pub projection_json: String,
    /// Hub epoch-millis at which the snapshot was generated (lets the UI flag a stale snapshot).
    pub generated_at_ms: i64,
}

/// **S-R2b** — client->read-server request for the owner-gated run ANSWER BODY over the sealed-WS
/// READ seam. This is deliberately separate from [`RunReadbackRequestWire`]: run-readback remains
/// refs-only, while this path releases the body only after the same owner-auth chain succeeds and
/// storage confirms the caller owns the run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunAnswerBodyRequestWire {
    pub run_id: String,
    pub forwarded_principal: String,
    pub auth_proof: Vec<u8>,
    pub request_id: String,
}

/// **S-R2b** — read-server->client owner-sealed run answer body snapshot. The `answer_json` field is
/// the owner-sealed JSON payload. On the delivered path that opened payload includes the answer body;
/// denied/not-found payloads are body-free.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunAnswerBodySnapshotWire {
    pub request_id: String,
    pub answer_json: String,
    pub generated_at_ms: i64,
}

/// **S-R3** — client→read-server request for the providers-doctor read projection over the DARK
/// sealed-WS READ seam. The sibling of [`WorkbenchProjectionRequestWire`]: a PURE READ that runs
/// the SAME owner-auth chain. Unlike the workbench/run-readback reads, the providers-doctor does NOT
/// read the hub DB — it runs each provider CLI's OFFICIAL read-only status command (no prompt/send,
/// no model call, no quota, no credential read). Owner-scoped + DARK like the rest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvidersDoctorRequestWire {
    /// Which providers to probe: `codex` | `claude` | `both` (default `both` when absent). Mirrors
    /// the `hub_providers_detect` bin's `--probe` selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<String>,
    /// The TS-token-resolved / device-resolved principal conveyed by the peer. VERIFIED against the
    /// sealed session before release — never trusted as an authority on its own.
    pub forwarded_principal: String,
    /// The sealed possession-of-session proof, bound to `request_id` + `forwarded_principal` in its
    /// AAD (the read analog of the write `auth_proof`). Opaque bytes here.
    pub auth_proof: Vec<u8>,
    /// The opaque per-request id the `auth_proof` is bound to (the read analog of `run_id`).
    pub request_id: String,
}

/// **S-R3** — read-server→client refs-only providers-doctor snapshot. Carries the refs-only
/// projection JSON as a STRING (the shared `project_providers_doctor` fn's guarded output:
/// per-provider `installed`/`authenticated` booleans + coarse static `detail` + `ready_providers`,
/// each provider lane CONSERVATIVELY truth-labelled `linked_only` — never upgraded, never raw
/// account info). The body is sealed under the owner-only session before it leaves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvidersDoctorSnapshotWire {
    /// Echoes the request id this snapshot answers (correlation).
    pub request_id: String,
    /// The refs-only projection JSON (the shared `project_providers_doctor` output, serialized).
    /// Booleans + labels only — never the raw `ProbeOutput` (CLI stdout/stderr), never account ids.
    pub projection_json: String,
    /// Hub epoch-millis at which the snapshot was generated.
    pub generated_at_ms: i64,
}

/// **S-R3b** — client->read-server request for the refs-only capability-doctor projection.
/// PURE READ in the dispatch sense: no prompt/send and no model completion. When
/// `validate_keys=true`, the Hub runs the existing key-validation doctor, which may perform
/// provider auth probes and can spend the documented tiny Anthropic validation quota.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityDoctorRequestWire {
    #[serde(default)]
    pub validate_keys: bool,
    pub forwarded_principal: String,
    pub auth_proof: Vec<u8>,
    pub request_id: String,
}

/// **S-R3b** — read-server->client owner-sealed capability-doctor snapshot. Carries
/// refs-only capability readiness JSON; never raw CLI/account/key material.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityDoctorSnapshotWire {
    pub request_id: String,
    pub projection_json: String,
    pub generated_at_ms: i64,
}

// ----------------------------------------------------------------------------------------------
// **C2I-PR2** — the 5 OWNER-GATED C2 READ-PLANE request/snapshot wire shapes for the DARK read
// server. Every one is the EXACT sibling of [`RunReadbackRequestWire`] / [`RunReadbackSnapshotWire`]:
// a PURE READ (never a model/provider call) that runs the SAME owner-auth chain —
// `forwarded_principal` + `auth_proof` are VERIFIED against the sealed session
// (possession-of-session + per-handshake nonce + owner-allowlist), the proof bound to `request_id`
// (the read analog of `run_id`). Each snapshot is released ONLY to the bound AUTHENTICATED principal
// and the body rides `projection_json` OWNER-SEALED by the transport. DARK / additive: `Message` is
// NOT `deny_unknown_fields`, so these new variants are byte-identical to current prod when nothing
// constructs them. Nothing in production constructs or dispatches any of these yet (the C2 lane is
// gated behind `FRIDAY_CLAUDE_ROUTE_ENABLED` + the slice-6 operator cutover).
// ----------------------------------------------------------------------------------------------

/// **C2I-PR2 (C2-4)** — client→read-server request for the OWNER-SCOPED routed-session LIST. No
/// resource key (it lists every session the AUTHENTICATED owner owns; a different principal's list
/// is naturally empty). Sibling of [`RunReadbackRequestWire`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionListRequestWire {
    /// The device-resolved principal conveyed by the peer. VERIFIED against the sealed session
    /// before release — never trusted as an authority on its own.
    pub forwarded_principal: String,
    /// The sealed possession-of-session proof, bound to `request_id` + `forwarded_principal` in its
    /// AAD (the read analog of the write `auth_proof`). Opaque bytes here.
    pub auth_proof: Vec<u8>,
    /// The opaque per-request id the `auth_proof` is bound to (the read analog of `run_id`).
    pub request_id: String,
}

/// **C2I-PR2 (C2-4)** — read-server→client refs-only routed-session LIST snapshot. The session list
/// (id + timestamps, NEVER a message body) rides `projection_json` OWNER-SEALED.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionListSnapshotWire {
    /// Echoes the request id this snapshot answers (correlation).
    pub request_id: String,
    /// The refs-only session-list JSON, OWNER-SEALED (the owner's `SessionListItem`s: id +
    /// timestamps only — never a body). A non-owner reads back an empty list, never an oracle.
    pub projection_json: String,
    /// Hub epoch-millis at which the snapshot was generated (lets the UI flag a stale snapshot).
    pub generated_at_ms: i64,
}

/// **C2I-PR2 (C2-4 / M-2)** — client→read-server request to OPEN one routed session's full
/// conversation transcript. `agent_session_id` is the resource key; the read is OWNER-GATED
/// (`owner_matches`) — a non-owner / owner-less / absent session is INDISTINGUISHABLE
/// (`session_not_found`). Sibling of [`RunReadbackRequestWire`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionOpenRequestWire {
    /// The routed session id to open. REQUIRED — open has no "first active" default.
    pub agent_session_id: String,
    /// The device-resolved principal conveyed by the peer. VERIFIED against the sealed session
    /// before release — never trusted as an authority on its own.
    pub forwarded_principal: String,
    /// The sealed possession-of-session proof, bound to `request_id` + `forwarded_principal` in its
    /// AAD (the read analog of the write `auth_proof`). Opaque bytes here.
    pub auth_proof: Vec<u8>,
    /// The opaque per-request id the `auth_proof` is bound to (the read analog of `run_id`).
    pub request_id: String,
}

/// **C2I-PR2 (C2-4 / M-2)** — read-server→client routed-session transcript snapshot. THE ONE
/// DELIBERATE BODY-DELIVERY CARVE-OUT on the read seam: unlike the refs-only reads, this carries the
/// session's FULL conversation messages. They are protected by the SAME two mechanisms every read
/// uses — (1) the owner gate (`owner_matches` on the VERIFIED principal; a non-owner gets
/// `session_not_found`, never bytes) and (2) OWNER-SEALING (`projection_json` is sealed under the
/// owner-authed session key, so the body never leaves the process unsealed). The read server does
/// NOT run `reject_forbidden_output` on this body — that guard would false-reject legitimate
/// transcript text; the owner gate + sealing ARE the protection (documented carve-out, M-2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionOpenSnapshotWire {
    /// Echoes the request id this snapshot answers (correlation).
    pub request_id: String,
    /// The session's folded conversation messages JSON, OWNER-SEALED. The M-2 carve-out: this DOES
    /// carry message bodies (owner-only, sealed) — never released to a non-owner, never unsealed.
    pub projection_json: String,
    /// Hub epoch-millis at which the snapshot was generated.
    pub generated_at_ms: i64,
}

/// **C2I-PR2 (C2-8)** — client→read-server request for one routed session's refs-only LINK-STATE
/// (`fresh`/`stale`/`offline`). `agent_session_id` is the resource key; OWNER-GATED. The staleness
/// is derived against the SERVER's clock (never a client-supplied timestamp), so a caller cannot
/// paint their own session fresh. Sibling of [`RunReadbackRequestWire`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionLinkStateRequestWire {
    /// The routed session id whose link-state to project. REQUIRED.
    pub agent_session_id: String,
    /// The device-resolved principal conveyed by the peer. VERIFIED against the sealed session
    /// before release — never trusted as an authority on its own.
    pub forwarded_principal: String,
    /// The sealed possession-of-session proof, bound to `request_id` + `forwarded_principal` in its
    /// AAD (the read analog of the write `auth_proof`). Opaque bytes here.
    pub auth_proof: Vec<u8>,
    /// The opaque per-request id the `auth_proof` is bound to (the read analog of `run_id`).
    pub request_id: String,
}

/// **C2I-PR2 (C2-8)** — read-server→client refs-only LINK-STATE snapshot. Carries the
/// closed-vocabulary connectivity label + the static thresholds it was derived against, OWNER-SEALED
/// — never any session text (the shared `project_session_link_state` guard ran before sealing).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionLinkStateSnapshotWire {
    /// Echoes the request id this snapshot answers (correlation).
    pub request_id: String,
    /// The refs-only link-state JSON, OWNER-SEALED (state label + thresholds only — never a body).
    pub projection_json: String,
    /// Hub epoch-millis at which the snapshot was generated.
    pub generated_at_ms: i64,
}

/// **C2I-PR2 (C2-5)** — client→read-server request for one run's refs-only FILE-VIEW (the workspace
/// file refs the run's `read_file` receipts recorded). `run_id` is the resource key; OWNER-GATED on
/// the run's bound owner (a non-owner gets `run_not_found`). Sibling of [`RunReadbackRequestWire`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunFileViewRequestWire {
    /// The run id whose file-view to read back. REQUIRED.
    pub run_id: String,
    /// The device-resolved principal conveyed by the peer. VERIFIED against the sealed session
    /// before release — never trusted as an authority on its own.
    pub forwarded_principal: String,
    /// The sealed possession-of-session proof, bound to `request_id` + `forwarded_principal` in its
    /// AAD (the read analog of the write `auth_proof`). Opaque bytes here.
    pub auth_proof: Vec<u8>,
    /// The opaque per-request id the `auth_proof` is bound to (the read analog of `run_id`).
    pub request_id: String,
}

/// **C2I-PR2 (C2-5)** — read-server→client refs-only FILE-VIEW snapshot. Carries the relative
/// workspace path refs (in receipt order) + the count, OWNER-SEALED — never a file body, never the
/// run `task` (the shared `project_run_file_view` guard ran before sealing).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunFileViewSnapshotWire {
    /// Echoes the request id this snapshot answers (correlation).
    pub request_id: String,
    /// The refs-only file-view JSON, OWNER-SEALED (relative path refs + count only — never a body).
    pub projection_json: String,
    /// Hub epoch-millis at which the snapshot was generated.
    pub generated_at_ms: i64,
}

/// **C2I-PR2 (C2-9)** — client→read-server request for one PAUSED run's Activity / Needs-Me
/// projection (the metered-turn AskReceipt rows + the pending-approval Needs-Me item). `run_id` is
/// the resource key; OWNER-GATED on the paused run's pending-row owner (`resolve_run_owner`; a
/// non-owner gets `run_not_found`). Sibling of [`RunReadbackRequestWire`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityNeedsMeRequestWire {
    /// The run id whose Activity / Needs-Me to project. REQUIRED.
    pub run_id: String,
    /// The device-resolved principal conveyed by the peer. VERIFIED against the sealed session
    /// before release — never trusted as an authority on its own.
    pub forwarded_principal: String,
    /// The sealed possession-of-session proof, bound to `request_id` + `forwarded_principal` in its
    /// AAD (the read analog of the write `auth_proof`). Opaque bytes here.
    pub auth_proof: Vec<u8>,
    /// The opaque per-request id the `auth_proof` is bound to (the read analog of `run_id`).
    pub request_id: String,
}

/// **C2I-PR2 (C2-9)** — read-server→client refs-only Activity / Needs-Me snapshot. Carries the
/// body-free AskReceipt rows ("{n} tokens via {model}") + the Needs-Me item anchored to the REAL
/// pending-approval nonce, OWNER-SEALED — never the run `task` (the shared `project_activity_needs_me`
/// guard ran before sealing).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityNeedsMeSnapshotWire {
    /// Echoes the request id this snapshot answers (correlation).
    pub request_id: String,
    /// The refs-only Activity / Needs-Me JSON, OWNER-SEALED (receipt summaries + Needs-Me ref only).
    pub projection_json: String,
    /// Hub epoch-millis at which the snapshot was generated.
    pub generated_at_ms: i64,
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
    /// client->hub: advance ONE WorkItem's lifecycle through the Hub state
    /// machine. Never a provider/model call. A `completed_with_proof` target
    /// MUST carry a non-empty `proof_receipt` (the persistence layer rejects a
    /// proofless completion).
    WorkItemStatusRequest { request: WorkItemStatusRequestWire },
    /// hub->client: WorkItem lifecycle mutation receipt. A `completed_with_proof`
    /// status here is honest precisely because the proof-on-completion invariant
    /// was enforced before the write.
    WorkItemStatusResult { result: WorkItemStatusResultWire },
    /// client->hub: apply an OWNER route-decision control before dispatch.
    /// A veto blocks the dispatch transition; an override changes lane/target at
    /// the lifecycle hook. Never a provider/model call.
    RouteDecisionControlRequest {
        request: RouteDecisionControlRequestWire,
    },
    /// hub->client: route-decision control receipt. This only records the
    /// pre-dispatch control, not provider execution.
    RouteDecisionControlResult {
        result: RouteDecisionControlResultWire,
    },
    /// client->hub: apply the OWNER's explicit confirm/reject decision to ONE
    /// pending memory candidate (the Memory-confirmation loop's terminal action).
    /// Never a provider/model call. Owner/namespace-scoped: applies ONLY when
    /// `owner_principal` matches the candidate's owning principal (fail-closed on
    /// mismatch / unowned / unknown / terminal). A candidate becomes durable
    /// (recallable) ONLY through an explicit `confirm` here — no auto-confirm path.
    MemoryDecisionRequest { request: MemoryDecisionRequestWire },
    /// hub->client: memory decision receipt. Refs-only — carries the candidate id,
    /// the resulting lifecycle state, a coarse status, and whether it is now
    /// recallable. NEVER the candidate's content (the content stays Hub-side).
    MemoryDecisionResult { result: MemoryDecisionResultWire },
    /// (CORE-A CR-3) client->hub: create/ensure ONE agent-session row (the Rust-owned
    /// `sessions.create`). PURE Hub `&Db` mutation; NO provider/model call. Owner is the
    /// server-AUTHENTICATED principal (single-peer session = channel auth), never a raw client field.
    SessionCreateRequest { request: SessionCreateRequestWire },
    /// (CORE-A CR-3) hub->client: refs-only session create receipt (id + timestamps; no body).
    SessionCreateResult { result: SessionCreateResultWire },
    /// (CORE-A CR-3) client->hub: append ONE conversation message to an existing session (the
    /// Rust-owned `sessions.messages.create`). PURE Hub `&Db` mutation. OWNER-GATED fail-closed: a
    /// message for a session the authenticated principal does not own is refused (no row written).
    SessionMessageAppendRequest { request: SessionMessageAppendRequestWire },
    /// (CORE-A CR-3) hub->client: refs-only append receipt (message id + seq + timestamps; no body).
    SessionMessageAppendResult { result: SessionMessageAppendResultWire },
    /// client->hub: mint one ContextPassport for an existing Mission through the Hub gate.
    /// Never a provider/model call; never direct client DB writes.
    ContextPassportTransferRequest {
        request: ContextPassportTransferRequestWire,
    },
    /// hub->client: refs-only context-passport mint receipt.
    ContextPassportTransferResult {
        result: ContextPassportTransferResultWire,
    },
    /// client->hub: confirm/reject ONE pending A1 run-outcome learning candidate.
    /// Owner scope is derived server-side from the candidate's bound session/run.
    /// Never a provider/model call and never carries the run answer body.
    RunOutcomeLearningDecisionRequest {
        request: RunOutcomeLearningDecisionRequestWire,
    },
    /// hub->client: refs-only run-outcome learning decision receipt.
    RunOutcomeLearningDecisionResult {
        result: RunOutcomeLearningDecisionResultWire,
    },
    /// client->hub: mark ONE Activity / Needs-Me item done. This changes only
    /// `activity_item.state`, never a WorkItem/proof/provider row.
    ActivityMarkDoneRequest {
        request: ActivityMarkDoneRequestWire,
    },
    /// hub->client: refs-only Activity / Needs-Me mark-done receipt.
    ActivityMarkDoneResult { result: ActivityMarkDoneResultWire },
    /// **S-R1** — UI→DARK read-server: request the Mission Workbench read projection over the
    /// sealed-WS READ seam. PURE READ — no model/provider call. Owner-scoped: the read server
    /// authenticates `forwarded_principal`/`auth_proof` against the sealed session (the SAME chain a
    /// write uses, with the proof bound to `request_id`) and releases the snapshot ONLY to the bound
    /// principal. DARK: nothing in production constructs or dispatches this yet.
    WorkbenchProjectionRequest {
        request: WorkbenchProjectionRequestWire,
    },
    /// **S-R1** — DARK read-server→UI: the owner-sealed, refs-only Mission Workbench snapshot. The
    /// projection JSON is refs-only (the shared `project_workbench` fn ran the forbidden-output
    /// guard before this was built); truth labels ride as-is, never upgraded.
    WorkbenchProjectionSnapshot {
        snapshot: WorkbenchProjectionSnapshotWire,
    },
    /// **S-R2** — UI→DARK read-server: request the run-readback read projection over the sealed-WS
    /// READ seam. PURE READ — no model/provider call. Owner-scoped (the SAME chain a write uses,
    /// proof bound to `request_id`), snapshot released ONLY to the bound principal. DARK.
    RunReadbackRequest { request: RunReadbackRequestWire },
    /// **S-R2** — DARK read-server→UI: owner-sealed, refs-only run-readback snapshot
    /// (state/loop-status/event-kinds/counts + DB-WIDE token totals labelled as such, never run
    /// cost). The shared projection fn ran the forbidden-output guard; truth labels never upgraded.
    RunReadbackSnapshot { snapshot: RunReadbackSnapshotWire },
    /// **S-R2b** — UI→DARK read-server: request the OWNER-GATED run answer body over the sealed-WS
    /// READ seam. PURE READ — no model/provider call. This is the body-bearing sibling of
    /// RunReadback, kept separate so refs-only projections stay refs-only.
    RunAnswerBodyRequest { request: RunAnswerBodyRequestWire },
    /// **S-R2b** — DARK read-server→UI: owner-sealed answer-body snapshot. The opened payload
    /// carries the answer only on the delivered path; denied/not-found paths stay body-free.
    RunAnswerBodySnapshot { snapshot: RunAnswerBodySnapshotWire },
    /// **S-R3** — UI→DARK read-server: request the providers-doctor read projection over the
    /// sealed-WS READ seam. PURE READ — runs each provider CLI's read-only status command only (no
    /// prompt/send, no model call, no quota). Owner-scoped + DARK.
    ProvidersDoctorRequest { request: ProvidersDoctorRequestWire },
    /// **S-R3** — DARK read-server→UI: owner-sealed, refs-only providers-doctor snapshot
    /// (installed/authenticated booleans + ready_providers, each provider lane conservatively
    /// `linked_only` — never upgraded, never raw account info). Guard ran before sealing.
    ProvidersDoctorSnapshot {
        snapshot: ProvidersDoctorSnapshotWire,
    },
    /// **S-R3b** — UI->DARK read-server: owner-authenticated capability-doctor read projection.
    CapabilityDoctorRequest {
        request: CapabilityDoctorRequestWire,
    },
    /// **S-R3b** — DARK read-server->UI: owner-sealed, refs-only capability-doctor snapshot.
    CapabilityDoctorSnapshot {
        snapshot: CapabilityDoctorSnapshotWire,
    },
    /// **C2I-PR2 (C2-4)** — UI→DARK read-server: request the OWNER-SCOPED routed-session LIST over
    /// the sealed-WS READ seam. PURE READ — no model/provider call. Owner-scoped (the SAME chain a
    /// write uses, proof bound to `request_id`); a non-owner's list is naturally empty. DARK.
    SessionListRequest { request: SessionListRequestWire },
    /// **C2I-PR2 (C2-4)** — DARK read-server→UI: owner-sealed refs-only routed-session LIST
    /// (id + timestamps only, never a body). DARK.
    SessionListSnapshot { snapshot: SessionListSnapshotWire },
    /// **C2I-PR2 (C2-4 / M-2)** — UI→DARK read-server: OPEN one routed session's full conversation
    /// transcript. PURE READ — no model/provider call. Owner-GATED (`owner_matches` on the VERIFIED
    /// principal); a non-owner gets `session_not_found` (no body, no oracle). DARK.
    SessionOpenRequest { request: SessionOpenRequestWire },
    /// **C2I-PR2 (C2-4 / M-2)** — DARK read-server→UI: the routed-session transcript snapshot. THE
    /// deliberate body-delivery carve-out: it DOES carry message bodies, OWNER-SEALED + owner-gated
    /// (never `reject_forbidden_output`, which would false-reject legit transcript text). DARK.
    SessionOpenSnapshot { snapshot: SessionOpenSnapshotWire },
    /// **C2I-PR2 (C2-8)** — UI→DARK read-server: request one routed session's refs-only LINK-STATE.
    /// PURE READ. Owner-GATED; staleness derived against the SERVER clock (never a client field). DARK.
    SessionLinkStateRequest {
        request: SessionLinkStateRequestWire,
    },
    /// **C2I-PR2 (C2-8)** — DARK read-server→UI: owner-sealed refs-only LINK-STATE snapshot
    /// (closed-vocab state label + thresholds, never any session text). DARK.
    SessionLinkStateSnapshot {
        snapshot: SessionLinkStateSnapshotWire,
    },
    /// **C2I-PR2 (C2-5)** — UI→DARK read-server: request one run's refs-only FILE-VIEW (the
    /// `read_file` receipt path refs). PURE READ. Owner-GATED on the run's bound owner; a non-owner
    /// gets `run_not_found`. DARK.
    RunFileViewRequest { request: RunFileViewRequestWire },
    /// **C2I-PR2 (C2-5)** — DARK read-server→UI: owner-sealed refs-only FILE-VIEW snapshot
    /// (relative path refs + count, never a file body, never the run `task`). DARK.
    RunFileViewSnapshot { snapshot: RunFileViewSnapshotWire },
    /// **C2I-PR2 (C2-9)** — UI→DARK read-server: request one PAUSED run's Activity / Needs-Me
    /// projection. PURE READ. Owner-GATED on the paused run's pending-row owner; a non-owner gets
    /// `run_not_found`. DARK.
    ActivityNeedsMeRequest { request: ActivityNeedsMeRequestWire },
    /// **C2I-PR2 (C2-9)** — DARK read-server→UI: owner-sealed refs-only Activity / Needs-Me snapshot
    /// (body-free AskReceipt summaries + the Needs-Me item anchored to the real approval nonce). DARK.
    ActivityNeedsMeSnapshot {
        snapshot: ActivityNeedsMeSnapshotWire,
    },
    /// trusted-TS-peer->hub: dispatch one production agent-run to the Rust loop
    /// over the long-lived sealed WS session. **WS-transport substrate (S-A) for
    /// the executeRun-replacement.** This slice defines ONLY the wire shape — it
    /// lands DARK: nothing constructs or dispatches it yet. The server, dispatch,
    /// and auth-verification arms are the later sub-slices S-B and S-C. Truth
    /// label: `rust_wired` at best, with NO production route, and NOT v1 GO.
    AgentRunRequest {
        /// Caller-chosen idempotency/run identifier for this agent-run.
        run_id: String,
        /// The agent task/prompt to run on the Rust loop.
        task: String,
        /// The TS-token-resolved principal conveyed by the trusted in-TCB peer
        /// (the only peer on the sealed session). **SHAPE-ONLY here:** a LATER
        /// sub-slice (S-C) MUST VERIFY this against the sealed session before any
        /// dispatch; this slice never trusts it. Defining the field does not
        /// confer trust.
        forwarded_principal: String,
        /// The sealed proof bytes the dispatch arm will later verify against the
        /// session (S-C). **SHAPE-ONLY here** — opaque, unverified at this layer.
        auth_proof: Vec<u8>,
        /// (A2a Phase 1) The CLIENT-ASSERTED session id this run participates in,
        /// when the run is a sessioned (multi-turn) chat. ADDITIVE + OPTIONAL — an
        /// absent field deserializes to `None` (`#[serde(default)]`) and a `None`
        /// value is OMITTED from the wire (`skip_serializing_if`), so a sessionless
        /// request is BYTE-IDENTICAL to the pre-A2a wire and routes through the
        /// unchanged sessionless dispatch path. **Mirrors the A1 additive-optional
        /// pattern.**
        ///
        /// **SECURITY (INV-5/INV-7): this is a CLIENT ASSERTION, NOT an authority.**
        /// It selects WHICH session row to load/append — it does NOT grant access to
        /// it. The run's bound OWNER is the AUTHENTICATED forwarded principal
        /// (verified by [`crate`]-external `authenticate_forwarded` against the owner
        /// allowlist), NEVER this `session_id`. Session history + the answer body are
        /// releasable only to that authenticated owner — so a peer cannot read another
        /// owner's history by guessing a `session_id`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        /// (A1 run-controls) Per-run CONSTRAINTS the server maps onto the run's `RunPolicy`
        /// (read-only / disabled-tool / max-turns). ADDITIVE + OPTIONAL — an absent block
        /// deserializes to `None` (`#[serde(default)]`) and a `None` value is OMITTED from
        /// the wire (`skip_serializing_if`), so a constraint-free request is BYTE-IDENTICAL
        /// to the pre-A1 wire and the live courier's current bytes decode to no-constraints.
        /// SECURITY: a constraint can only TIGHTEN a run (a restriction, never a grant); see
        /// [`AgentRunConstraintsWire`]. Threading these onto the per-run policy is the
        /// prerequisite for any mutating run-control.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        constraints: Option<AgentRunConstraintsWire>,
        /// (NS45-PR1 / M-4) The FIRST-CLASS Mission handle this run participates in, retiring the
        /// provisional `session_id`-as-surface-thread shim that NS-4 used for mission resolution.
        /// A real handle `{friday_conversation_id, mission_id, work_item_id}` from the NS-5
        /// `MissionIntakeResult` lets the dispatch resolve the Mission via
        /// `MissionContextLookup::by_mission_work_item` and route through the mission-bound run
        /// path, INSTEAD of conflating a chat-session id with a surface-thread id.
        ///
        /// ADDITIVE + OPTIONAL — an absent field deserializes to `None` (`#[serde(default)]`) and
        /// a `None` value is OMITTED from the wire (`skip_serializing_if`), so a request WITHOUT a
        /// handle is BYTE-IDENTICAL to the pre-NS45 wire and routes through the UNCHANGED unbound
        /// dispatch path. Mirrors the `session_id`/`constraints` additive-optional pattern.
        ///
        /// **SECURITY (INV-5/INV-7): this is a CLIENT ASSERTION, NOT an authority.** It selects
        /// WHICH Mission/WorkItem the run binds to — it does NOT grant access. The run's bound
        /// OWNER is the AUTHENTICATED forwarded principal (the FIX-Q2 `configured_principal` owner
        /// gate at the mission-bound seam), NEVER this handle. A client-asserted `mission_id` is
        /// safe under single-owner v1 + that owner gate; enforcing ownership of a client-asserted
        /// `mission_id` under a multi-owner (`owner_allowlist > 1`) allowlist is a NAMED go-live
        /// gate, not added here (see the NS45-PR1 scope).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mission_context: Option<MissionWorkItemContextWire>,
    },
    /// hub->trusted-TS-peer: REFS-ONLY terminal receipt for an agent-run.
    /// **WS-transport substrate (S-A).** It carries a coarse loop-status label and
    /// the answer FINGERPRINT (sha256 + length) — and **MUST NOT** carry the
    /// answer body / `final_message`. The body is delivered SEALED over the
    /// session by a LATER sub-slice, NEVER as a refs field. This mirrors the
    /// `AuthedAnswer::proof_refs_json` and `owner_sealed_body_len` discipline.
    /// Lands DARK. Truth label: `rust_wired` at best, and NOT v1 GO.
    AgentRunResult {
        /// The run this result terminates (echoes `AgentRunRequest::run_id`).
        run_id: String,
        /// Coarse loop-status label (e.g. completed / denied / no_answer). A
        /// status here is a loop fact, not a body — see the refs-only note below.
        status: String,
        /// sha256 fingerprint of the answer body, when an answer exists. The body
        /// itself NEVER travels in this message.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answer_sha256: Option<String>,
        /// Byte length of the answer body, when an answer exists. A length is a
        /// ref/fingerprint — never the body bytes.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answer_len: Option<u64>,
        /// (A1 transport-truth) REFS-surface run METADATA: the count of model turns
        /// the loop took (`LoopOutcome::turns`). A COUNT only — never a turn body /
        /// message / param. ADDITIVE + OPTIONAL: an OLD server omits it (deserializes
        /// to `None` on a new client via `#[serde(default)]`); a NEW server's value is
        /// ignored by an old client (serde ignores unknown fields — `Message` is not
        /// `deny_unknown_fields`). `None` ⇒ byte-identical to the pre-A1 wire.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turns: Option<u64>,
        /// (A1) REFS-surface run METADATA: the count of tools that actually executed
        /// (gate `Allow` + executor `Ok`; `LoopOutcome::executed_tools`). A COUNT only
        /// — NEVER a tool name / args / receipt. Same additive/optional/byte-identical
        /// discipline as `turns`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        executed_tools: Option<u64>,
        /// (A1) REFS-surface run METADATA: prompt-token total for the run, when known.
        /// A COUNT only. **Wire-shape reserved; population is DEFERRED** — the per-turn
        /// usage is billed to the Rust `token_ledger` (keyed by `run_id`) and is NOT on
        /// `LoopOutcome`, so the emit path leaves this `None` for now (a later slice
        /// folds the ledger total in). Carrying the field here completes the
        /// wire-widening pattern so no second wire change is needed then.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt_tokens: Option<u64>,
        /// (A1) REFS-surface run METADATA: completion-token total for the run, when
        /// known. A COUNT only. Same DEFERRED-population note as `prompt_tokens`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        completion_tokens: Option<u64>,
    },
    /// hub->trusted-TS-peer: (A1 run-controls) the loop's gate PAUSED a mutating tool on
    /// `run_id` waiting for an operator approval. Today a Paused run writes no `run_result`
    /// and drops into the NoAnswer black hole (the TS courier sees `AgentRunResult{status:
    /// "no_answer"}` and cannot tell a pause from a dead run). This variant surfaces the
    /// pause so the operator can be prompted to sign (out-of-band) and the courier can later
    /// relay an `AgentRunResume`. It is REFS-ONLY: it carries the single-use approval `nonce`
    /// (= the `pending_approval_request.approval_id` the operator signs over) and the
    /// `action_digest` (which transitively binds principal/scope/params) — and a coarse,
    /// body-free `summary` of what paused (the action verb). It NEVER carries the tool body,
    /// args, or the answer. **DARK + FLAG-GATED:** the server emits this ONLY when the
    /// default-off `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` flag is on; with the flag off the
    /// server emits exactly the pre-A1 `AgentRunResult{status:"no_answer"}` bytes.
    AgentRunPaused {
        /// The run that paused (echoes `AgentRunRequest::run_id`).
        run_id: String,
        /// The single-use CSPRNG approval nonce the operator signs over (=
        /// `pending_approval_request.approval_id`). It is a nonce, not a secret — it
        /// identifies WHICH pause to resume; signing it requires the operator's private key.
        nonce: String,
        /// Hex SHA-256 of the request's `canonical_action_bytes` — binds the EXACT paused
        /// action (and transitively principal/scope/params/derived-risk). A fingerprint, not
        /// a body.
        action_digest: String,
        /// A coarse, body-free summary of WHAT paused (e.g. the action verb). NEVER the tool
        /// args, the params, or any mutation body.
        summary: String,
    },
    /// trusted-TS-peer->hub: (A1 run-controls) relay an operator's out-of-band approval to
    /// RESUME a paused run. **The TS peer is a pure COURIER, never the author:** `signed_blob`
    /// is the operator's canonical Ed25519-signed approval (the S6c CLI output), opaque to TS.
    /// The server decodes it to a `CanonicalApproval` and delegates VERBATIM to the S6
    /// `resume_with_approval` spine — which looks the pending row up by the approval's nonce,
    /// cross-checks the action digest, Ed25519-verifies under the OPERATOR's public key,
    /// CONSUMES the nonce (single-use), executes the ONE approved mutation, and records the
    /// owner. The Hub holds only a VERIFY key — it can never mint this. A forged/replayed/
    /// expired/HMAC blob is refused (no mutation). DARK + FLAG-GATED.
    AgentRunResume {
        /// The run to resume (echoes the paused `run_id`). Advisory context; the AUTHORITY is
        /// the `signed_blob`'s nonce + digest, which the resume spine looks up independently.
        run_id: String,
        /// The operator's canonical Ed25519-signed approval bytes (JSON of a `CanonicalApproval`).
        /// Opaque to the courier; verified by the server. Carries no secret (a signature +
        /// public scope), and is single-use (the nonce is consumed on a successful verify).
        signed_blob: Vec<u8>,
    },
    /// trusted-TS-peer->hub: (A1 run-controls) CANCEL a live agent-run — write a terminal
    /// `cancelled` `agent_run.state` and stop the loop. **Owner-authed:** unlike resume (which
    /// is self-authenticating via the operator signature), cancel carries a `forwarded_principal`
    /// plus an `auth_proof` (the SAME sealed-session possession proof an `AgentRunRequest`
    /// carries, bound to this `run_id`); the server verifies it against the session AND requires
    /// the authenticated principal == the run's bound owner before writing the terminal state.
    /// A non-owner / forged / ownerless-run cancel fails closed (no state change). DARK +
    /// FLAG-GATED. Idempotent: cancelling an already-terminal run is a no-op success.
    AgentRunCancel {
        run_id: String,
        /// The TS-token-resolved principal the trusted peer forwards. **A client assertion,
        /// NOT an authority** — verified against the sealed session (`auth_proof`) and then
        /// matched to the run's bound owner. Mirrors `AgentRunRequest::forwarded_principal`.
        forwarded_principal: String,
        /// The sealed possession proof (`AUTH_CHALLENGE || session_nonce`, AAD-bound to
        /// `(principal, run_id)`). Mirrors `AgentRunRequest::auth_proof`. Opaque here.
        auth_proof: Vec<u8>,
        /// A coarse, body-free reason for the cancel (operator/audit context). NEVER a body.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// trusted-TS-peer->hub: (A1 run-controls) REJECT a pending tool-approval on a paused run —
    /// mark `pending_approval_request.status='rejected'` (reuses the existing m0014 status
    /// column; NO migration). **Owner-authed** on the SAME terms as `AgentRunCancel`: the
    /// `forwarded_principal` + `auth_proof` are verified against the session, then the
    /// authenticated principal must equal the pending row's bound owner (`principal_id`).
    /// Reject is a SEPARATE leg from cancel: it refuses ONE pending mutation (the run stays
    /// alive, just un-approved) rather than terminating the whole run. The load-bearing
    /// single-use guarantee remains the gate's `consumed_approval` store; this status is
    /// idempotent bookkeeping + the operator-facing "I said no" record. DARK + FLAG-GATED.
    AgentRunReject {
        run_id: String,
        /// The pending approval to reject (= `pending_approval_request.approval_id` /
        /// `AgentRunPaused::nonce`). Identifies WHICH pending mutation to refuse.
        approval_id: String,
        forwarded_principal: String,
        auth_proof: Vec<u8>,
    },
    /// hub->trusted-TS-peer: (A1 run-controls) the body-free receipt for a control op
    /// (`AgentRunResume` / `AgentRunCancel` / `AgentRunReject`). It carries a coarse outcome
    /// status (e.g. `cancelled` / `already_terminal` / `rejected` / `mutation_completed` /
    /// `denied` / `not_owner` / `unknown_run`) and a soft audit ref — NEVER a body, a tool
    /// args, or an answer. `accepted=false` means the control op was refused (fail-closed);
    /// the `status` says why at a coarse grain. Mirrors the refs-only discipline of
    /// `AgentRunResult` and `MissionLifecycleResult`.
    AgentRunControlResult {
        run_id: String,
        /// The control op this terminates (`resume` / `cancel` / `reject`).
        op: String,
        /// Whether the op was accepted (`true`) or refused fail-closed (`false`).
        accepted: bool,
        /// Coarse, body-free outcome label.
        status: String,
        /// Soft link to the hash-chained audit receipt for this control op, when one was
        /// written. A ref, never a body.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        audit_ref: Option<String>,
    },
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

    /// The number of DISTINCT `msg_id`s seen this session. A holder uses this to bound the
    /// within-session set (an authenticated peer streaming unbounded distinct ids = self-DoS).
    /// This is a pure observation — it adds NO evict/cap/LRU behavior to the dedup set (evicting
    /// would reopen anti-replay: flushing a live id then resending it would re-`First`-execute it).
    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
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
                    action_items: vec![],
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
                    action_items: vec![],
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
                    proof_requirements: Vec::new(),
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
                    selected_lane: Some("deepseek".into()),
                    selected_target_provider_or_agent: Some("deepseek".into()),
                    clarification_questions: Vec::new(),
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
            Message::WorkItemStatusRequest {
                request: WorkItemStatusRequestWire {
                    work_item_id: "work-1".into(),
                    target_status: "completed_with_proof".into(),
                    actor_ref: "operator:jarvis".into(),
                    reason: "provider returned a verified result".into(),
                    proof_receipt: Some("proof://work-item/1".into()),
                },
            },
            Message::WorkItemStatusResult {
                result: WorkItemStatusResultWire {
                    work_item_id: "work-1".into(),
                    mission_id: "mission-1".into(),
                    previous_status: "provider_waiting".into(),
                    status: "completed_with_proof".into(),
                    actor_ref: "operator:jarvis".into(),
                    reason: "provider returned a verified result".into(),
                    proof_receipt_count: 1,
                    updated_at_ms: 1_700_000_000_007,
                },
            },
            Message::MemoryDecisionRequest {
                request: MemoryDecisionRequestWire {
                    memory_id: "mem-1".into(),
                    owner_principal: "owner-1".into(),
                    decision: "confirm".into(),
                },
            },
            Message::MemoryDecisionResult {
                result: MemoryDecisionResultWire {
                    memory_id: "mem-1".into(),
                    state: "confirmed".into(),
                    status: "confirmed".into(),
                    blocker: None,
                    recallable: true,
                },
            },
            Message::RunOutcomeLearningDecisionRequest {
                request: RunOutcomeLearningDecisionRequestWire {
                    candidate_id: "a1:run-1:preference".into(),
                    decision: "confirm".into(),
                    reason: Some("owner confirmed this learning".into()),
                },
            },
            Message::RunOutcomeLearningDecisionResult {
                result: RunOutcomeLearningDecisionResultWire {
                    candidate_id: "a1:run-1:preference".into(),
                    run_id: Some("run-1".into()),
                    kind: Some("preference".into()),
                    state: "confirmed".into(),
                    status: "confirmed".into(),
                    blocker: None,
                },
            },
            Message::ActivityMarkDoneRequest {
                request: ActivityMarkDoneRequestWire {
                    activity_id: "activity-1".into(),
                    reason: Some("owner cleared the row".into()),
                },
            },
            Message::ActivityMarkDoneResult {
                result: ActivityMarkDoneResultWire {
                    activity_id: "activity-1".into(),
                    state: "done".into(),
                    status: "done".into(),
                    blocker: None,
                },
            },
            Message::RunAnswerBodyRequest {
                request: RunAnswerBodyRequestWire {
                    run_id: "run-readable".into(),
                    forwarded_principal: "owner-1".into(),
                    auth_proof: vec![1, 2, 3],
                    request_id: "req-r2b".into(),
                },
            },
            Message::RunAnswerBodySnapshot {
                snapshot: RunAnswerBodySnapshotWire {
                    request_id: "req-r2b".into(),
                    answer_json: "c0ffee".into(),
                    generated_at_ms: 1_700_000_000_011,
                },
            },
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
    fn run_outcome_learning_decision_wire_is_refs_only_and_round_trips() {
        let request = Message::RunOutcomeLearningDecisionRequest {
            request: RunOutcomeLearningDecisionRequestWire {
                candidate_id: "a1:run-1:preference".into(),
                decision: "confirm".into(),
                reason: Some("operator confirmed".into()),
            },
        };
        let env = Envelope::new("a1-dec-req", 1000, request.clone()).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"RunOutcomeLearningDecisionRequest\""));
        assert!(json.contains("\"request\":{"));
        assert!(json.contains("\"candidate_id\":\"a1:run-1:preference\""));
        for forbidden in [
            "answer body",
            "raw transcript",
            "sk-",
            "/Users/example/private",
        ] {
            assert!(
                !json.contains(forbidden),
                "run-outcome learning request leaked {forbidden}: {json}"
            );
        }
        assert_eq!(Envelope::decode(&json).unwrap(), env);

        let result = Message::RunOutcomeLearningDecisionResult {
            result: RunOutcomeLearningDecisionResultWire {
                candidate_id: "a1:run-1:preference".into(),
                run_id: Some("run-1".into()),
                kind: Some("preference".into()),
                state: "rejected".into(),
                status: "blocked".into(),
                blocker: Some("owner_scope_mismatch".into()),
            },
        };
        let env = Envelope::new("a1-dec-res", 1001, result).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"RunOutcomeLearningDecisionResult\""));
        assert!(json.contains("\"result\":{"));
        assert!(json.contains("\"blocker\":\"owner_scope_mismatch\""));
        assert_eq!(Envelope::decode(&json).unwrap(), env);
    }

    #[test]
    fn activity_mark_done_wire_is_refs_only_and_round_trips() {
        let request = Message::ActivityMarkDoneRequest {
            request: ActivityMarkDoneRequestWire {
                activity_id: "activity-1".into(),
                reason: Some("owner cleared the row".into()),
            },
        };
        let env = Envelope::new("activity-done-req", 1000, request).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"ActivityMarkDoneRequest\""));
        assert!(json.contains("\"request\":{"));
        assert!(json.contains("\"activity_id\":\"activity-1\""));
        for forbidden in [
            "transcript",
            "answer body",
            "proof_receipt",
            "completed_with_proof",
            "sk-",
            "/Users/example/private",
        ] {
            assert!(
                !json.contains(forbidden),
                "activity mark-done request leaked {forbidden}: {json}"
            );
        }
        assert_eq!(Envelope::decode(&json).unwrap(), env);

        let result = Message::ActivityMarkDoneResult {
            result: ActivityMarkDoneResultWire {
                activity_id: "activity-1".into(),
                state: "done".into(),
                status: "blocked".into(),
                blocker: Some("unknown_activity".into()),
            },
        };
        let env = Envelope::new("activity-done-res", 1001, result).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"ActivityMarkDoneResult\""));
        assert!(json.contains("\"result\":{"));
        assert!(json.contains("\"blocker\":\"unknown_activity\""));
        assert_eq!(Envelope::decode(&json).unwrap(), env);
    }

    #[test]
    fn memory_decision_wire_round_trips_and_uses_the_request_result_wrapper() {
        // The decision request rides the SAME internally-tagged `{ request }` / `{ result }`
        // wrapper as MissionIntake (enum `tag="kind"` + a single named field). A prior surface
        // shipped a FLAT shape that 503'd every call — this asserts the wrapper is present so a
        // regression to the flat shape is caught at the protocol layer.
        let request = Message::MemoryDecisionRequest {
            request: MemoryDecisionRequestWire {
                memory_id: "mem-decision-1".into(),
                owner_principal: "owner-1".into(),
                decision: "confirm".into(),
            },
        };
        let env = Envelope::new("mem-dec-req", 1000, request.clone()).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"MemoryDecisionRequest\""));
        // The load-bearing wrapper: the payload sits under `"request":{...}`, NOT flattened
        // alongside `kind` (the flat-shape regression guard).
        assert!(json.contains("\"request\":{"));
        assert!(json.contains("\"memory_id\":\"mem-decision-1\""));
        assert!(json.contains("\"decision\":\"confirm\""));
        assert_eq!(Envelope::decode(&json).unwrap(), env);

        let result = Message::MemoryDecisionResult {
            result: MemoryDecisionResultWire {
                memory_id: "mem-decision-1".into(),
                state: "rejected".into(),
                status: "blocked".into(),
                blocker: Some("owner_scope_mismatch".into()),
                recallable: false,
            },
        };
        let env = Envelope::new("mem-dec-res", 1001, result).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"MemoryDecisionResult\""));
        assert!(json.contains("\"result\":{"));
        assert!(json.contains("\"recallable\":false"));
        assert!(json.contains("\"blocker\":\"owner_scope_mismatch\""));
        assert_eq!(Envelope::decode(&json).unwrap(), env);
    }

    #[test]
    fn session_lifecycle_wire_round_trips_and_uses_the_request_result_wrapper() {
        // (CORE-A CR-3) The session create/append wire rides the SAME internally-tagged
        // `{ request }` / `{ result }` wrapper as MemoryDecision/MissionIntake (enum `tag="kind"`
        // + a single named field). This pins the byte-exact `{kind,request}` nesting so a flat-shape
        // regression (which 503s server-side on `Envelope::decode`) is caught at the protocol layer.
        let create_req = Message::SessionCreateRequest {
            request: SessionCreateRequestWire {
                session_id: "discord:default:chat-1".into(),
                channel: Some("discord".into()),
                chat_id: Some("chat-1".into()),
                user_id: Some("owner-1".into()),
                account_id: Some("default".into()),
                chat_kind: Some("dm".into()),
                metadata_json: Some("{\"source\":\"cr3\"}".into()),
            },
        };
        let env = Envelope::new("sess-create-req", 1000, create_req.clone()).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"SessionCreateRequest\""));
        assert!(json.contains("\"request\":{"));
        assert!(json.contains("\"session_id\":\"discord:default:chat-1\""));
        assert!(json.contains("\"chat_kind\":\"dm\""));
        assert_eq!(Envelope::decode(&json).unwrap(), env);

        // Absent optional axes are OMITTED (byte-clean) and round-trip to `None`.
        let create_req_min = Message::SessionCreateRequest {
            request: SessionCreateRequestWire {
                session_id: "system:default:heartbeat".into(),
                channel: None,
                chat_id: None,
                user_id: None,
                account_id: None,
                chat_kind: None,
                metadata_json: None,
            },
        };
        let env_min = Envelope::new("sess-create-min", 1000, create_req_min.clone());
        let json_min = env_min.encode().unwrap();
        assert!(!json_min.contains("channel"));
        assert!(!json_min.contains("metadata_json"));
        assert_eq!(Envelope::decode(&json_min).unwrap(), env_min);

        let create_res = Message::SessionCreateResult {
            result: SessionCreateResultWire {
                session_id: "discord:default:chat-1".into(),
                created_at: 900,
                updated_at: 1000,
            },
        };
        let env = Envelope::new("sess-create-res", 1001, create_res).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"SessionCreateResult\""));
        assert!(json.contains("\"result\":{"));
        assert!(json.contains("\"created_at\":900"));
        assert!(json.contains("\"updated_at\":1000"));
        // REFS-ONLY: no descriptive echo / no body on the receipt.
        assert!(!json.contains("chat_kind"));
        assert_eq!(Envelope::decode(&json).unwrap(), env);

        let append_req = Message::SessionMessageAppendRequest {
            request: SessionMessageAppendRequestWire {
                session_id: "discord:default:chat-1".into(),
                role: "user".into(),
                content: "remember teal".into(),
                refs: Some("run-7".into()),
            },
        };
        let env = Envelope::new("sess-append-req", 1002, append_req.clone()).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"SessionMessageAppendRequest\""));
        assert!(json.contains("\"request\":{"));
        assert!(json.contains("\"role\":\"user\""));
        assert!(json.contains("\"refs\":\"run-7\""));
        assert_eq!(Envelope::decode(&json).unwrap(), env);

        let append_res = Message::SessionMessageAppendResult {
            result: SessionMessageAppendResultWire {
                message_id: "discord:default:chat-1:m0".into(),
                seq: 0,
                created_at: 1002,
                updated_at: 1002,
            },
        };
        let env = Envelope::new("sess-append-res", 1003, append_res).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"SessionMessageAppendResult\""));
        assert!(json.contains("\"result\":{"));
        assert!(json.contains("\"message_id\":\"discord:default:chat-1:m0\""));
        assert!(json.contains("\"seq\":0"));
        // REFS-ONLY: the appended body never rides the receipt.
        assert!(!json.contains("remember teal"));
        assert_eq!(Envelope::decode(&json).unwrap(), env);
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
            "/Users/example/private",
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
                "/Users/example/private",
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
            "/Users/example/private",
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
            "/Users/example/private",
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
            "/Users/example/private",
        ] {
            assert!(
                !json.contains(forbidden),
                "mission lifecycle wire leaked {forbidden}: {json}"
            );
        }
        assert_eq!(Envelope::decode(&json).unwrap(), env);
    }

    #[test]
    fn work_item_status_request_omits_proof_receipt_when_absent_and_round_trips() {
        // A non-completion transition carries NO proof_receipt — the key must be ABSENT on the
        // wire (additive-optional), so an older peer's decode is unaffected and the shape stays
        // honest (a receipt is only valid for a completed_with_proof transition).
        let env = Envelope::new(
            "work-item-status-1",
            1000,
            Message::WorkItemStatusRequest {
                request: WorkItemStatusRequestWire {
                    work_item_id: "work-1".into(),
                    target_status: "ready_to_dispatch".into(),
                    actor_ref: "operator:jarvis".into(),
                    reason: "preflight cleared".into(),
                    proof_receipt: None,
                },
            },
        );
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"WorkItemStatusRequest\""));
        assert!(
            !json.contains("proof_receipt"),
            "a receipt-free WorkItemStatusRequest must not carry a proof_receipt key: {json}"
        );
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

    // M5 (within-session bound — defense-in-depth). The live holders cap the per-session distinct
    // `msg_id` set with the guard `if seen_ids.len() >= MAX && !seen_ids.has_seen(id) { fail-close }`
    // placed IMMEDIATELY BEFORE the existing `observe()` Replay check. These tests model that guard
    // predicate against the tracker invariants it relies on, using a SMALL local CAP (the prod const
    // is 100_000 in each holder — untouched). The cap must NEVER evict/LRU: eviction would reopen
    // anti-replay (flush a live id, resend it, re-`First`-execute it).

    /// Models the holder guard: at the cap, observe a NEW id => the guard would fail-close WITHOUT
    /// inserting. Asserts the predicate fires AND the tracker is NOT mutated (no flush, no execute).
    #[test]
    fn idempotency_cap_fails_closed_on_new_id_without_flushing() {
        const CAP: usize = 3;
        let mut t = IdempotencyTracker::new();
        for i in 0..CAP {
            assert_eq!(t.observe(&format!("id-{i}")), Seen::First);
        }
        assert_eq!(t.len(), CAP);
        // A NEW id at the cap: the holder guard `len() >= CAP && !has_seen(new)` is TRUE => the
        // session would fail-close BEFORE `observe()`, so the new id is never inserted.
        let new_id = "id-new";
        assert!(
            t.len() >= CAP && !t.has_seen(new_id),
            "guard predicate must fire"
        );
        // Crucially, the guard does NOT call observe(): the set is unchanged (no flush of older ids,
        // and the new id is NOT recorded). A real holder simply ends the session here.
        assert_eq!(t.len(), CAP, "cap branch must not grow/flush the set");
        for i in 0..CAP {
            assert!(t.has_seen(&format!("id-{i}")), "older ids must remain seen");
        }
        assert!(
            !t.has_seen(new_id),
            "the rejected new id must NOT be recorded"
        );
    }

    /// The anti-replay regression tripwire: an id seen BEFORE the cap is STILL reported `Replay`
    /// at/after the cap — it is NEVER flushed and re-`First`-ed. If anyone adds eviction/LRU, the
    /// early id gets dropped and re-observe returns `First`, failing this test.
    #[test]
    fn idempotency_cap_never_re_firsts_an_id_seen_before_the_cap() {
        const CAP: usize = 3;
        let mut t = IdempotencyTracker::new();
        // An id seen early, BEFORE we reach the cap.
        let early = "early-id";
        assert_eq!(t.observe(early), Seen::First);
        // Fill up to (and past) the cap with DISTINCT junk ids.
        for i in 0..CAP {
            t.observe(&format!("junk-{i}"));
        }
        assert!(t.len() >= CAP);
        // The holder guard only fires for a NEW id (`!has_seen`). A REPLAY of `early` has
        // `has_seen == true`, so the guard FALLS THROUGH to `observe()`, which MUST return Replay.
        assert!(t.has_seen(early));
        assert_eq!(
            t.observe(early),
            Seen::Replay,
            "an id seen before the cap must stay Replay forever — no eviction"
        );
    }

    /// Normal under-cap behavior is unchanged: distinct ids First, resend Replay.
    #[test]
    fn idempotency_under_cap_behavior_unchanged() {
        const CAP: usize = 3;
        let mut t = IdempotencyTracker::new();
        assert_eq!(t.observe("a"), Seen::First);
        assert_eq!(t.observe("b"), Seen::First);
        assert_eq!(t.observe("a"), Seen::Replay);
        assert!(t.len() < CAP, "still under the cap — no guard involvement");
        assert!(t.has_seen("a") && t.has_seen("b"));
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
            cwd: Some("/Users/example/private".into()),
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
            "/Users/example/private",
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

    // --- WS-transport substrate (S-A) for the executeRun-replacement -----------
    // These cover the two DARK message kinds added at schema v12. They exercise
    // ONLY the codec/shape; nothing here constructs a server, dispatch, or auth
    // path (those are later sub-slices S-B/S-C).

    #[test]
    fn agent_run_request_round_trips_over_envelope() {
        let msg = Message::AgentRunRequest {
            run_id: "run-1".into(),
            task: "summarize the inbox".into(),
            // SHAPE-ONLY: a later sub-slice (S-C) verifies these against the
            // sealed session; the codec just carries them.
            forwarded_principal: "owner-1".into(),
            auth_proof: vec![0xDE, 0xAD, 0xBE, 0xEF],
            // A2a Phase 1: a sessionless request (the pre-A2a shape) carries `None`.
            session_id: None,
            // A1 run-controls: a constraint-free request carries `None`.
            constraints: None,
            // NS45-PR1: a request with no Mission handle carries `None`.
            mission_context: None,
        };
        let env = Envelope::new("m1", 1000, msg.clone()).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains(&format!("\"schema_version\":{CURRENT_SCHEMA_VERSION}")));
        assert!(json.contains("\"kind\":\"AgentRunRequest\""));
        let back = Envelope::decode(&json).unwrap();
        assert_eq!(back, env);
        assert_eq!(back.message, msg);
    }

    #[test]
    fn agent_run_request_sessionless_is_byte_identical_no_session_id_key() {
        // (A2a Phase 1) BYTE-IDENTICAL proof: a `session_id: None` request serializes
        // with NO `session_id` key at all (`skip_serializing_if = "Option::is_none"`),
        // so the sessionless wire is exactly the pre-A2a wire. This is the additive-
        // optional discipline A1 established; absent ⇒ unchanged on the wire.
        let msg = Message::AgentRunRequest {
            run_id: "run-1".into(),
            task: "summarize the inbox".into(),
            forwarded_principal: "owner-1".into(),
            auth_proof: vec![0xDE, 0xAD, 0xBE, 0xEF],
            session_id: None,
            constraints: None,
            mission_context: None,
        };
        let json = Envelope::new("m1", 1000, msg).encode().unwrap();
        assert!(
            !json.contains("session_id"),
            "a sessionless AgentRunRequest must not carry a session_id key (byte-identical to pre-A2a): {json}"
        );
        // (A1 run-controls) absent constraints ⇒ NO `constraints` key on the wire
        // (byte-identical to the pre-A1 AgentRunRequest, so the live courier's current
        // bytes still decode to no-constraints).
        assert!(
            !json.contains("constraints"),
            "a constraint-free AgentRunRequest must not carry a constraints key (byte-identical to pre-A1): {json}"
        );
        // (NS45-PR1) absent mission_context ⇒ NO `mission_context` key on the wire
        // (byte-identical to the pre-NS45 AgentRunRequest, so a handle-free request decodes
        // unchanged and routes through the unbound path).
        assert!(
            !json.contains("mission_context"),
            "a handle-free AgentRunRequest must not carry a mission_context key (byte-identical to pre-NS45): {json}"
        );
    }

    #[test]
    fn agent_run_request_sessioned_round_trips_with_session_id() {
        // (A2a Phase 1) A sessioned request carries `session_id` on the wire and
        // round-trips it. An OLD decoder (pre-A2a) ignores the unknown field (the
        // `Message` enum is NOT `deny_unknown_fields`), so a new client talking to an
        // old server degrades to sessionless rather than failing — same forward/back
        // compatibility A1 relies on.
        let msg = Message::AgentRunRequest {
            run_id: "run-2".into(),
            task: "compare it to the other file".into(),
            forwarded_principal: "owner-1".into(),
            auth_proof: vec![0x01, 0x02],
            session_id: Some("sess-abc".into()),
            constraints: None,
            mission_context: None,
        };
        let env = Envelope::new("m2", 2000, msg.clone());
        let json = env.encode().unwrap();
        assert!(
            json.contains("\"session_id\":\"sess-abc\""),
            "a sessioned request must carry session_id on the wire: {json}"
        );
        let back = Envelope::decode(&json).unwrap();
        assert_eq!(back.message, msg);
    }

    #[test]
    fn agent_run_result_round_trips_over_envelope() {
        // Refs-only terminal receipt: a coarse status + the answer FINGERPRINT.
        let msg = Message::AgentRunResult {
            run_id: "run-1".into(),
            status: "completed".into(),
            answer_sha256: Some("a".repeat(64)),
            answer_len: Some(4096),
            turns: Some(3),
            executed_tools: Some(2),
            prompt_tokens: None,
            completion_tokens: None,
        };
        let env = Envelope::new("m2", 2000, msg.clone()).with_correlation("c2");
        let json = env.encode().unwrap();
        assert!(json.contains(&format!("\"schema_version\":{CURRENT_SCHEMA_VERSION}")));
        assert!(json.contains("\"kind\":\"AgentRunResult\""));
        let back = Envelope::decode(&json).unwrap();
        assert_eq!(back, env);
        assert_eq!(back.message, msg);

        // The fingerprint fields are optional: a no-answer result omits them, and
        // `skip_serializing_if` keeps them off the wire entirely. The A1 count fields
        // are optional on the SAME terms.
        let no_answer = Message::AgentRunResult {
            run_id: "run-2".into(),
            status: "no_answer".into(),
            answer_sha256: None,
            answer_len: None,
            turns: None,
            executed_tools: None,
            prompt_tokens: None,
            completion_tokens: None,
        };
        let env2 = Envelope::new("m3", 3000, no_answer.clone());
        let json2 = env2.encode().unwrap();
        assert!(!json2.contains("answer_sha256"));
        assert!(!json2.contains("answer_len"));
        assert!(!json2.contains("turns"));
        assert!(!json2.contains("executed_tools"));
        assert!(!json2.contains("prompt_tokens"));
        assert!(!json2.contains("completion_tokens"));
        assert_eq!(Envelope::decode(&json2).unwrap().message, no_answer);
    }

    /// (A1 transport-truth) Serde back-compat for the ADDITIVE count fields, BOTH
    /// directions — the load-bearing wire-widening proof.
    #[test]
    fn agent_run_result_a1_counts_are_backward_and_forward_compatible() {
        // (1) ABSENT ⇒ BYTE-IDENTICAL TO TODAY: a `None`-count result serializes with
        // NO count keys at all (the pre-A1 wire shape, verbatim). This is the proof
        // that a server which never populates counts emits exactly today's bytes.
        let pre_a1_shape = Message::AgentRunResult {
            run_id: "run-compat".into(),
            status: "finished".into(),
            answer_sha256: Some("c".repeat(64)),
            answer_len: Some(42),
            turns: None,
            executed_tools: None,
            prompt_tokens: None,
            completion_tokens: None,
        };
        let pre_a1_json = Envelope::new("c1", 1, pre_a1_shape.clone())
            .encode()
            .unwrap();
        for key in [
            "turns",
            "executed_tools",
            "prompt_tokens",
            "completion_tokens",
        ] {
            assert!(
                !pre_a1_json.contains(key),
                "an absent count must NOT appear on the wire (byte-identical to pre-A1): {key}"
            );
        }

        // (2) FORWARD-COMPAT (new server → old client): a NEW server's JSON that
        // CARRIES the count fields still deserializes on a client that does not know
        // them — serde ignores unknown fields (`Message` is not `deny_unknown_fields`).
        // We model "an old client" by an envelope JSON the running code can decode even
        // with EXTRA keys present.
        let new_server_json = r#"{"schema_version":1,"msg_id":"c2","sent_at":2,"message":{"kind":"AgentRunResult","run_id":"run-fwd","status":"finished","answer_sha256":"deadbeef","answer_len":10,"turns":4,"executed_tools":3,"prompt_tokens":111,"completion_tokens":22,"some_future_field":"ignored"}}"#;
        let decoded = Envelope::decode(new_server_json).expect("forward-compat decode");
        match decoded.message {
            Message::AgentRunResult {
                turns,
                executed_tools,
                prompt_tokens,
                completion_tokens,
                ..
            } => {
                assert_eq!(turns, Some(4));
                assert_eq!(executed_tools, Some(3));
                assert_eq!(prompt_tokens, Some(111));
                assert_eq!(completion_tokens, Some(22));
            }
            other => panic!("expected AgentRunResult, got {other:?}"),
        }

        // (3) BACKWARD-COMPAT (old server → new client): a result JSON with NO count
        // keys (today's server) deserializes to `None` on the new client via
        // `#[serde(default)]` — never an error.
        let old_server_json = r#"{"schema_version":1,"msg_id":"c3","sent_at":3,"message":{"kind":"AgentRunResult","run_id":"run-bwd","status":"finished","answer_sha256":"deadbeef","answer_len":10}}"#;
        match Envelope::decode(old_server_json)
            .expect("backward-compat decode")
            .message
        {
            Message::AgentRunResult {
                turns,
                executed_tools,
                prompt_tokens,
                completion_tokens,
                ..
            } => {
                assert_eq!(turns, None);
                assert_eq!(executed_tools, None);
                assert_eq!(prompt_tokens, None);
                assert_eq!(completion_tokens, None);
            }
            other => panic!("expected AgentRunResult, got {other:?}"),
        }

        // (4) POPULATED round-trips intact (the new-server-to-new-client path).
        let populated = Message::AgentRunResult {
            run_id: "run-rt".into(),
            status: "finished".into(),
            answer_sha256: Some("a".repeat(64)),
            answer_len: Some(7),
            turns: Some(5),
            executed_tools: Some(1),
            prompt_tokens: Some(900),
            completion_tokens: Some(80),
        };
        let env = Envelope::new("c4", 4, populated.clone());
        assert_eq!(
            Envelope::decode(&env.encode().unwrap()).unwrap().message,
            populated
        );
    }

    #[test]
    fn agent_run_result_is_refs_only_never_carries_the_body() {
        // STRUCTURAL refs-only proof (mirrors `AuthedAnswer::proof_refs_json` /
        // the `owner_sealed_body_len` discipline): the serialized AgentRunResult
        // must contain ONLY the refs fields — run_id, status, the answer FINGERPRINT,
        // and (A1) the run COUNTS — and NEVER the answer body or any `final_message`
        // key. The body is sealed over the session by a later sub-slice, never here.
        const BODY: &str = "TOP-SECRET ANSWER BODY THAT MUST NEVER HIT THE WIRE";
        let msg = Message::AgentRunResult {
            run_id: "run-1".into(),
            status: "completed".into(),
            answer_sha256: Some("b".repeat(64)),
            answer_len: Some(BODY.len() as u64),
            // A1 counts: present but body-free (counts are metadata, never a body).
            turns: Some(2),
            executed_tools: Some(1),
            prompt_tokens: None,
            completion_tokens: None,
        };
        let json = Envelope::new("m1", 1000, msg).encode().unwrap();

        // No body / final_message field can exist (the struct has no such field),
        // and no body-bearing key name leaks onto the wire.
        for forbidden in [
            "answer\"",
            "\"answer\":",
            "final_message",
            "body",
            "final_answer",
            "plaintext",
            BODY,
        ] {
            assert!(
                !json.contains(forbidden),
                "AgentRunResult leaked a body field/key: {forbidden} in {json}"
            );
        }

        // What IS allowed: exactly the refs/fingerprint keys PLUS the A1 run COUNTS
        // (turns / executed_tools — present here; token counts are deferred ⇒ absent).
        // No body-bearing key is in this set; every member is a ref/count, not a body.
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let m = parsed.get("message").unwrap().as_object().unwrap();
        let mut keys: Vec<&str> = m.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "answer_len",
                "answer_sha256",
                "executed_tools",
                "kind",
                "run_id",
                "status",
                "turns",
            ]
        );
        // (A1) The counts are NUMBERS (metadata), not strings/objects that could smuggle
        // a body — a structural guard that the count surface stays count-only.
        assert!(m.get("turns").unwrap().is_number());
        assert!(m.get("executed_tools").unwrap().is_number());
    }

    #[test]
    fn schema_version_bumped_to_sixteen_for_activity_mark_done() {
        // Activity mark-done adds a new refs-only owner action over Activity / Needs-Me rows.
        // Bump the advertised wire version so peers can tell the request/result kinds exist.
        assert_eq!(CURRENT_SCHEMA_VERSION, 16);
        assert_eq!(SUPPORTED.max, 16);
        assert_eq!(SUPPORTED.min, 1);
    }

    #[test]
    fn route_decision_control_wire_is_refs_only_and_round_trips() {
        let env = Envelope::new(
            "route-control-1",
            1000,
            Message::RouteDecisionControlRequest {
                request: RouteDecisionControlRequestWire {
                    decision_id: "route-decision-1".into(),
                    mission_id: Some("mission-1".into()),
                    work_item_id: Some("work-1".into()),
                    control_kind: "override".into(),
                    override_lane: Some("codex".into()),
                    override_provider_or_agent: Some("codex".into()),
                    actor_ref: "operator:jarvis".into(),
                    reason: "Codex owns this edit".into(),
                },
            },
        );
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"RouteDecisionControlRequest\""));
        assert!(json.contains("\"decision_id\":\"route-decision-1\""));
        for forbidden in [
            "raw transcript",
            "provider-thread",
            "sk-",
            "/Users/example/private",
        ] {
            assert!(
                !json.contains(forbidden),
                "route decision control wire leaked {forbidden}: {json}"
            );
        }
        assert_eq!(Envelope::decode(&json).unwrap(), env);
    }

    // --- A1 run-controls: the on-wire control protocol (v13) --------------------
    // Per-behavior codec coverage for the NEW additive variants. These exercise ONLY
    // the codec/shape — nothing here constructs a server or executes a control op
    // (those are the friday-hub handlers, behind the default-off flag).

    #[test]
    fn agent_run_request_constraints_round_trip_and_are_additive_optional() {
        // A constrained request round-trips its constraints; an absent block is byte-identical.
        let constrained = Message::AgentRunRequest {
            run_id: "run-c".into(),
            task: "tidy the workspace".into(),
            forwarded_principal: "owner-1".into(),
            auth_proof: vec![0x01],
            session_id: None,
            constraints: Some(AgentRunConstraintsWire {
                read_only: true,
                disabled_tools: vec!["run_command".into(), "delete_file".into()],
                max_turns: Some(3),
            }),
            mission_context: None,
        };
        let json = Envelope::new("m", 1, constrained.clone()).encode().unwrap();
        assert!(json.contains("\"read_only\":true"));
        assert!(json.contains("\"disabled_tools\":[\"run_command\",\"delete_file\"]"));
        assert!(json.contains("\"max_turns\":3"));
        assert_eq!(Envelope::decode(&json).unwrap().message, constrained);

        // An empty-but-present constraints block omits the empty vec / None max_turns but keeps
        // read_only (a bool always serializes) — still a tightening-only, body-free shape.
        let empty = Message::AgentRunRequest {
            run_id: "run-e".into(),
            task: "go".into(),
            forwarded_principal: "owner-1".into(),
            auth_proof: vec![],
            session_id: None,
            constraints: Some(AgentRunConstraintsWire::default()),
            mission_context: None,
        };
        let json = Envelope::new("m", 1, empty.clone()).encode().unwrap();
        assert!(!json.contains("disabled_tools"));
        assert!(!json.contains("max_turns"));
        assert_eq!(Envelope::decode(&json).unwrap().message, empty);
    }

    #[test]
    fn agent_run_paused_is_refs_only_and_round_trips() {
        // Paused carries the nonce + digest + a coarse summary — NEVER a body/args.
        const ARGS: &str = "rm -rf /Users/example/private/secret";
        let msg = Message::AgentRunPaused {
            run_id: "run-1".into(),
            nonce: "a".repeat(64),
            action_digest: "b".repeat(64),
            summary: "paused on delete_file".into(),
        };
        let env = Envelope::new("p1", 1000, msg.clone()).with_correlation("c1");
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"AgentRunPaused\""));
        assert!(json.contains(&format!("\"schema_version\":{CURRENT_SCHEMA_VERSION}")));
        // Structural body-free guard: no args/params/body key can appear (the struct has none).
        for forbidden in [
            ARGS,
            "params",
            "args",
            "tool_params",
            "body",
            "final_message",
        ] {
            assert!(
                !json.contains(forbidden),
                "AgentRunPaused leaked {forbidden}: {json}"
            );
        }
        assert_eq!(Envelope::decode(&json).unwrap(), env);
    }

    #[test]
    fn agent_run_resume_is_a_courier_blob_and_round_trips() {
        // The TS peer carries an opaque signed_blob (the operator's signature) — the courier
        // never authors it; the server verifies it. The codec just carries the bytes.
        let msg = Message::AgentRunResume {
            run_id: "run-1".into(),
            signed_blob: vec![0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01],
        };
        let env = Envelope::new("r1", 1001, msg.clone());
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"AgentRunResume\""));
        assert_eq!(Envelope::decode(&json).unwrap().message, msg);
    }

    #[test]
    fn agent_run_cancel_carries_owner_auth_and_round_trips() {
        // Cancel is owner-authed: it carries the forwarded principal + the sealed proof
        // (mirroring AgentRunRequest) plus an optional coarse reason.
        let msg = Message::AgentRunCancel {
            run_id: "run-1".into(),
            forwarded_principal: "owner-1".into(),
            auth_proof: vec![0x01, 0x02, 0x03],
            reason: Some("operator changed their mind".into()),
        };
        let env = Envelope::new("x1", 1002, msg.clone());
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"AgentRunCancel\""));
        assert!(json.contains("\"forwarded_principal\":\"owner-1\""));
        assert_eq!(Envelope::decode(&json).unwrap().message, msg);

        // Absent reason omits the key (additive-optional).
        let no_reason = Message::AgentRunCancel {
            run_id: "run-2".into(),
            forwarded_principal: "owner-1".into(),
            auth_proof: vec![],
            reason: None,
        };
        let json = Envelope::new("x2", 1003, no_reason.clone())
            .encode()
            .unwrap();
        assert!(!json.contains("reason"));
        assert_eq!(Envelope::decode(&json).unwrap().message, no_reason);
    }

    #[test]
    fn agent_run_reject_carries_owner_auth_and_approval_id() {
        let msg = Message::AgentRunReject {
            run_id: "run-1".into(),
            approval_id: "a".repeat(64),
            forwarded_principal: "owner-1".into(),
            auth_proof: vec![0x09],
        };
        let env = Envelope::new("j1", 1004, msg.clone());
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"AgentRunReject\""));
        assert!(json.contains("\"approval_id\""));
        assert_eq!(Envelope::decode(&json).unwrap().message, msg);
    }

    #[test]
    fn agent_run_control_result_is_refs_only_and_round_trips() {
        let msg = Message::AgentRunControlResult {
            run_id: "run-1".into(),
            op: "cancel".into(),
            accepted: true,
            status: "cancelled".into(),
            audit_ref: Some("audit://agent-run-control/run-1".into()),
        };
        let env = Envelope::new("k1", 1005, msg.clone());
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"AgentRunControlResult\""));
        assert!(json.contains("\"op\":\"cancel\""));
        assert!(json.contains("\"accepted\":true"));
        // Body-free guard.
        for forbidden in ["body", "final_message", "answer\"", "params"] {
            assert!(
                !json.contains(forbidden),
                "control result leaked {forbidden}"
            );
        }
        assert_eq!(Envelope::decode(&json).unwrap().message, msg);

        // A refused op (accepted=false) with no audit_ref omits the key.
        let refused = Message::AgentRunControlResult {
            run_id: "run-2".into(),
            op: "reject".into(),
            accepted: false,
            status: "not_owner".into(),
            audit_ref: None,
        };
        let json = Envelope::new("k2", 1006, refused.clone()).encode().unwrap();
        assert!(!json.contains("audit_ref"));
        assert_eq!(Envelope::decode(&json).unwrap().message, refused);
    }

    #[test]
    fn pre_a1_agent_run_request_decodes_with_no_constraints() {
        // FORWARD/BACKWARD-COMPAT: the live courier's CURRENT (pre-A1) AgentRunRequest JSON —
        // which has no `constraints` key — still decodes on a v13 build to `constraints: None`
        // (via `#[serde(default)]`). This is what makes deploying a v13 binary safe for the
        // current peer.
        let pre_a1 = r#"{"schema_version":12,"msg_id":"m","sent_at":1,"message":{"kind":"AgentRunRequest","run_id":"r","task":"t","forwarded_principal":"owner-1","auth_proof":[1,2]}}"#;
        match Envelope::decode(pre_a1).expect("pre-A1 decode").message {
            Message::AgentRunRequest {
                session_id,
                constraints,
                mission_context,
                ..
            } => {
                assert_eq!(session_id, None);
                assert_eq!(constraints, None);
                // (NS45-PR1) the pre-NS45 wire (no `mission_context` key) decodes to `None`
                // via `#[serde(default)]` — the additive-optional guarantee that makes
                // deploying a build with this field safe for the current courier.
                assert_eq!(mission_context, None);
            }
            other => panic!("expected AgentRunRequest, got {other:?}"),
        }
    }

    /// **C2I-PR2** — the 5 owner-gated C2 read-plane request + snapshot wire shapes round-trip
    /// over the envelope codec (the read-server arms the bin dispatches them to). Mirrors the
    /// `agent_run_request_round_trips_over_envelope` style: encode → assert the `kind` tag →
    /// decode → byte-equal. Pure codec/shape — nothing here constructs a server or auth path.
    #[test]
    fn c2i_pr2_read_plane_wire_shapes_round_trip_over_envelope() {
        let cases: Vec<(Message, &str)> = vec![
            (
                Message::SessionListRequest {
                    request: SessionListRequestWire {
                        forwarded_principal: "owner-1".into(),
                        auth_proof: vec![1, 2, 3],
                        request_id: "req-list".into(),
                    },
                },
                "SessionListRequest",
            ),
            (
                Message::SessionListSnapshot {
                    snapshot: SessionListSnapshotWire {
                        request_id: "req-list".into(),
                        projection_json: "deadbeef".into(),
                        generated_at_ms: 1000,
                    },
                },
                "SessionListSnapshot",
            ),
            (
                Message::SessionOpenRequest {
                    request: SessionOpenRequestWire {
                        agent_session_id: "sess-1".into(),
                        forwarded_principal: "owner-1".into(),
                        auth_proof: vec![4, 5],
                        request_id: "req-open".into(),
                    },
                },
                "SessionOpenRequest",
            ),
            (
                Message::SessionOpenSnapshot {
                    snapshot: SessionOpenSnapshotWire {
                        request_id: "req-open".into(),
                        projection_json: "cafe".into(),
                        generated_at_ms: 1001,
                    },
                },
                "SessionOpenSnapshot",
            ),
            (
                Message::SessionLinkStateRequest {
                    request: SessionLinkStateRequestWire {
                        agent_session_id: "sess-1".into(),
                        forwarded_principal: "owner-1".into(),
                        auth_proof: vec![6],
                        request_id: "req-link".into(),
                    },
                },
                "SessionLinkStateRequest",
            ),
            (
                Message::SessionLinkStateSnapshot {
                    snapshot: SessionLinkStateSnapshotWire {
                        request_id: "req-link".into(),
                        projection_json: "01".into(),
                        generated_at_ms: 1002,
                    },
                },
                "SessionLinkStateSnapshot",
            ),
            (
                Message::RunFileViewRequest {
                    request: RunFileViewRequestWire {
                        run_id: "run-1".into(),
                        forwarded_principal: "owner-1".into(),
                        auth_proof: vec![7, 8],
                        request_id: "req-fv".into(),
                    },
                },
                "RunFileViewRequest",
            ),
            (
                Message::RunFileViewSnapshot {
                    snapshot: RunFileViewSnapshotWire {
                        request_id: "req-fv".into(),
                        projection_json: "02".into(),
                        generated_at_ms: 1003,
                    },
                },
                "RunFileViewSnapshot",
            ),
            (
                Message::ActivityNeedsMeRequest {
                    request: ActivityNeedsMeRequestWire {
                        run_id: "run-1".into(),
                        forwarded_principal: "owner-1".into(),
                        auth_proof: vec![9],
                        request_id: "req-anm".into(),
                    },
                },
                "ActivityNeedsMeRequest",
            ),
            (
                Message::ActivityNeedsMeSnapshot {
                    snapshot: ActivityNeedsMeSnapshotWire {
                        request_id: "req-anm".into(),
                        projection_json: "03".into(),
                        generated_at_ms: 1004,
                    },
                },
                "ActivityNeedsMeSnapshot",
            ),
        ];
        for (msg, kind) in cases {
            let env = Envelope::new("m1", 1000, msg.clone()).with_correlation("c1");
            let json = env.encode().unwrap();
            assert!(
                json.contains(&format!("\"schema_version\":{CURRENT_SCHEMA_VERSION}")),
                "carries the current schema version: {json}"
            );
            assert!(
                json.contains(&format!("\"kind\":\"{kind}\"")),
                "carries the {kind} tag: {json}"
            );
            let back = Envelope::decode(&json).unwrap();
            assert_eq!(back, env, "{kind} round-trips byte-equal");
            assert_eq!(back.message, msg);
        }
    }
}
