//! Phase-1 runtime bridge — headless Hub serve-loop (goal file 92 §Phase 1).
//!
//! Composes existing Rust mechanisms into a local **headless** Hub runtime that a future
//! mobile/desktop UI can consume over the proven E2E-sealed WebSocket transport. It serves
//! a TRUSTED session (the per-session [`DataKey`] is established out of band by pairing;
//! a client without it cannot produce valid sealed envelopes → fail-closed) and handles a
//! STREAM of messages per connection (beyond a single `accept_one`).
//!
//! Call discipline (the load-bearing invariant): the non-model operations
//! (connect / status / refresh / list / reconnect) are **pure Hub reads and produce ZERO
//! provider/model calls**. ONLY a Mission-bound [`Message::AskFridayRequest`] reaches the
//! Hub-owned DeepSeek route — via [`crate::mission_runtime::ask_friday_for_mission`],
//! which attaches proof to the canonical Mission/WorkItem. Detached asks fail closed.
//! There is **no fallback** to Codex/Claude/OpenAI/local/mock: a route failure is
//! surfaced as an exact blocker.
//!
//! Safe outbound projection: an ask returns only **refs** ([`Message::AskFridayResult`]
//! = `ledger_id` + a `result_link`) — never the raw answer text, provider account ids,
//! auth material, raw private reasoning, cwd, or external urls on the wire. The answer +
//! usage live Hub-side in the token_ledger / Activity receipt. No UI code here.

use friday_core::MISSION_NATIVE_UI_IMPLEMENTATION_DEFERRED_OPTION;
use friday_crypto::{open, DataKey, Sealed};
use friday_deepseek::{DeepSeekClient, Transport};
use friday_protocol::{
    ActivityMarkDoneRequestWire, ActivityMarkDoneResultWire, ContextPassportTransferRequestWire,
    ContextPassportTransferResultWire, Envelope, ErrorCode, MemoryDecisionRequestWire,
    MemoryDecisionResultWire, Message, MissionIntakeRequestWire, MissionIntakeResultWire,
    MissionLifecycleRequestWire, MissionLifecycleResultWire, MissionProjectionSnapshotWire,
    MissionTimelineLinkWire, MissionTimelineMissionWire, MissionTimelineRequestWire,
    MissionTimelineSnapshotWire, MissionTimelineSurfaceEventWire, MissionTimelineWorkItemWire,
    MissionWorkItemContextWire, ProviderWorkspaceActionRequestWire,
    ProviderWorkspaceActionResultWire, RouteDecisionControlRequestWire,
    RouteDecisionControlResultWire, RouteDecisionProjectionWire,
    RunOutcomeLearningDecisionRequestWire, RunOutcomeLearningDecisionResultWire,
    SessionCreateRequestWire, SessionCreateResultWire, SessionMessageAppendRequestWire,
    SessionMessageAppendResultWire, WorkItemStatusRequestWire, WorkItemStatusResultWire, SUPPORTED,
};
use friday_providers::unified::{FallbackStatus, PlatformProvider, ProviderSession, SessionStatus};
use friday_storage::{
    get_run_answer_for_principal, get_run_result, get_run_result_ref, load_session_owner,
    AnswerDenyReason, Db, MissionBodySnapshot, RunAnswerAccess, RunResultRef, SessionMessage,
    SessionOwner,
};
use friday_transport::{ws_recv_envelope, ws_send_envelope, TransportError, WireWebSocket};
use serde_json::json;
use std::collections::BTreeSet;
use std::io::{Read, Write};

use crate::mission_context::MissionContextLookup;
use crate::mission_preflight::{
    preflight_and_stage_work_item_with_workspace_claims, MissionPreflightOutcome,
    MissionPreflightRequest,
};
use crate::mission_runtime::{ask_friday_for_mission, MissionBoundAskOutcome};
use crate::provider_dispatch::{
    dispatch_provider_action, DispatchContext, DispatchError, ProviderDispatchAdapter,
};
use crate::provider_dispatch_adapter::{
    provider_workspace_dispatch_enabled, DbPromptBodyResolver, LocalCodexWorkspaceClient,
    ProviderWorkspaceDispatchAdapter,
};
use crate::provider_workspace::ProviderWorkspaceCatalog;
use crate::runtime::HubRuntime;
use crate::RecordAskError;

fn parse_passport_lane(value: &str) -> Result<friday_core::WorkLane, &'static str> {
    match value {
        "friday_hub" => Ok(friday_core::WorkLane::FridayHub),
        "codex" => Ok(friday_core::WorkLane::Codex),
        "claude" => Ok(friday_core::WorkLane::Claude),
        "deepseek" => Ok(friday_core::WorkLane::DeepSeek),
        "workflow" => Ok(friday_core::WorkLane::Workflow),
        "channel" => Ok(friday_core::WorkLane::Channel),
        "human" => Ok(friday_core::WorkLane::Human),
        "future_api" => Ok(friday_core::WorkLane::FutureApi),
        _ => Err("unknown_destination_lane"),
    }
}

fn parse_passport_item_kind(value: &str) -> Result<friday_core::PassportItemKind, &'static str> {
    match value {
        "memory_snippet" => Ok(friday_core::PassportItemKind::MemorySnippet),
        "summary" => Ok(friday_core::PassportItemKind::Summary),
        "file" => Ok(friday_core::PassportItemKind::File),
        "screenshot" => Ok(friday_core::PassportItemKind::Screenshot),
        "attachment" => Ok(friday_core::PassportItemKind::Attachment),
        "provider_secret" => Ok(friday_core::PassportItemKind::ProviderSecret),
        "raw_token" => Ok(friday_core::PassportItemKind::RawToken),
        _ => Err("unknown_item_kind"),
    }
}

/// A headless Hub runtime serving one or more trusted client sessions. Generic over the
/// DeepSeek [`Transport`] so tests inject a scripted mock and a live build uses
/// `DeepSeekClient::from_env()` (Hub-only credential).
pub struct HubServer<T: Transport> {
    db: Db,
    deepseek: DeepSeekClient<T>,
    capabilities: Vec<String>,
    max_tokens: u32,
    /// Monotonic per-ask id source (a fresh ledger_id per ask — reuse fails CLOSED on the
    /// token_ledger PK).
    next_ask: u64,
}

fn provider_workspace_session_from_link(
    link: &friday_core::ProviderSessionLink,
) -> Option<ProviderSession> {
    let provider = match link.provider.as_str() {
        "codex" => PlatformProvider::Codex,
        "claude" => PlatformProvider::Claude,
        _ => return None,
    };
    Some(ProviderSession {
        friday_session_id: link.friday_session_id.clone(),
        provider,
        workspace_id: link.workspace_id.clone(),
        sync_mode: link.sync_mode.into(),
        status: SessionStatus::Idle,
        capability_snapshot: Vec::new(),
        external_thread_id: link.external_thread_id.clone(),
        active_turn_id: None,
        last_event_seq: 0,
        truth_label: link.truth_label.clone(),
        fallback_status: FallbackStatus::NoFallback,
    })
}

struct NoProviderWorkspaceDispatchAdapter;

impl ProviderDispatchAdapter for NoProviderWorkspaceDispatchAdapter {
    fn execute_action(
        &self,
        _ctx: &DispatchContext<'_>,
    ) -> Result<crate::provider_dispatch::DispatchOutcome, DispatchError> {
        Err(DispatchError::AdapterNotReady(
            "provider adapter unavailable from Hub metadata gate".to_string(),
        ))
    }
}

struct MissionAskDispatch<'a> {
    msg_id: &'a str,
    prompt: &'a str,
    context: MissionWorkItemContextWire,
    ledger_id: &'a str,
    session_id: &'a str,
    activity_id: &'a str,
    now_ms: i64,
}

impl<T: Transport> HubServer<T> {
    pub fn new(
        db: Db,
        deepseek: DeepSeekClient<T>,
        capabilities: Vec<String>,
        max_tokens: u32,
    ) -> Self {
        Self {
            db,
            deepseek,
            capabilities,
            max_tokens,
            next_ask: 0,
        }
    }

    /// Borrow the Db (e.g. to inspect ledger/activity Hub-side).
    pub fn db(&self) -> &Db {
        &self.db
    }

    /// Dispatch ONE client envelope to a response. `now_ms` is supplied by the caller's
    /// clock (deterministic in tests). Non-model messages never touch the DeepSeek client.
    pub fn dispatch(&mut self, env: Envelope, now_ms: i64) -> Envelope {
        let corr = env.msg_id.clone();
        match env.message {
            // Pure Hub read — NO provider/model call.
            Message::HubStatus { .. } => self.status(&corr).with_correlation(corr),
            // Hub-owned Mission intake/preflight mutation — NO provider/model call.
            Message::MissionIntakeRequest { request } => self
                .mission_intake_result(&corr, request, now_ms)
                .with_correlation(corr),
            // Pure Hub read — canonical Mission projections, NO provider/model call.
            Message::MissionProjectionRequest { request } => self
                .mission_projection_snapshot(&corr, &request.friday_conversation_id, now_ms)
                .with_correlation(corr),
            // Pure Hub read — one Mission timeline/read model, NO provider/model call.
            Message::MissionTimelineRequest { request } => self
                .mission_timeline_snapshot(&corr, request, now_ms)
                .with_correlation(corr),
            // Hub-owned Mission lifecycle mutation — NO provider/model call.
            Message::MissionLifecycleRequest { request } => self
                .mission_lifecycle_result(&corr, request, now_ms)
                .with_correlation(corr),
            // Hub-owned context-passport mint — NO provider/model call.
            Message::ContextPassportTransferRequest { request } => {
                context_passport_transfer_result_for_db(&self.db, &corr, request, now_ms)
            }
            // Provider Workspace action pre-dispatch guard. No provider adapter call here.
            Message::ProviderWorkspaceActionRequest { request } => self
                .provider_workspace_action_result(&corr, request, now_ms)
                .with_correlation(corr),
            // The ONLY model path: Hub-owned DeepSeek route + ledger/audit/activity.
            Message::AskFridayRequest {
                prompt,
                mission_context,
            } => self
                .ask(&corr, &prompt, mission_context, now_ms)
                .with_correlation(corr),
            // The pairing channel established the session; a Pair here is out of place.
            Message::Pair { .. } => Self::error(
                &corr,
                now_ms,
                ErrorCode::Internal,
                "already on a trusted session; pairing is the connect step",
            ),
            _ => Self::error(
                &corr,
                now_ms,
                ErrorCode::Internal,
                "unsupported runtime-bridge message",
            ),
        }
    }

    fn status(&self, msg_id: &str) -> Envelope {
        Envelope::new(
            format!("{msg_id}-status"),
            0,
            Message::HubStatus {
                online: true,
                capabilities: self.capabilities.clone(),
                min_version: SUPPORTED.min,
                max_version: SUPPORTED.max,
            },
        )
    }

    fn mission_intake_result(
        &mut self,
        msg_id: &str,
        request: MissionIntakeRequestWire,
        now_ms: i64,
    ) -> Envelope {
        // (NS-5) The intake body is a pure `&Db` mutation (no `deepseek`/`next_ask`), so it is
        // extracted to the free `mission_intake_result_for_db` — letting the LIVE agent-run server
        // bin (which holds a `HubRuntime`, not a `HubServer`) REUSE the exact same Mission-birth
        // path through its flag-gated dispatch arm WITHOUT reimplementing it. This dispatch and the
        // bin's arm therefore birth a Mission identically (same rows, same wire result).
        //
        // (FIX-Q3b) `authenticated_owner` is the identity the persisted owner is BOUND to (never
        // the raw body field). This LEGACY `HubServer::dispatch` path has NO production binary
        // caller (both live bins use `HubRuntime`; this serve-loop is the in-crate TS-bridge under
        // test only) and carries no session-derived principal, so it passes the request's own
        // `owner_principal` as the authenticated owner — keeping this path BYTE-IDENTICAL (the
        // equality check below is a tautology here, the persisted owner is unchanged). The LIVE
        // mission-spine path is the bin's flag-gated arm, which threads `runtime.policy()
        // .principal_id()` (== the configured `--owner`) as the real authenticated owner.
        let body_owner = request.owner_principal.clone();
        mission_intake_result_for_db(&self.db, msg_id, request, Some(body_owner.as_str()), now_ms)
    }
}

/// (FIX-Q3b) Resolve the canonical OWNER principal of `friday_conversation_id` from the Hub's
/// `friday_conversation` row — the single source of truth for "who this Mission belongs to". Used
/// by the mission-spine free fns to bind an inbound mutation to the AUTHENTICATED owner instead of
/// trusting a self-asserted body field. `None` when the conversation does not exist OR its
/// `owner_principal` is empty/whitespace (fail-closed: an unresolvable owner can match no
/// authenticated principal). A DB read error is treated as unresolvable (`None`) so a transient
/// failure fails CLOSED rather than admitting the mutation.
fn resolve_conversation_owner(db: &Db, friday_conversation_id: &str) -> Option<String> {
    db.get_friday_conversation(friday_conversation_id)
        .ok()
        .flatten()
        .map(|c| c.owner_principal.trim().to_string())
        .filter(|owner| !owner.is_empty())
}

/// (NS-5) The Mission-intake/preflight mutation, parameterized over `&Db` so BOTH the
/// [`HubServer::dispatch`] path AND the live agent-run server bin's flag-gated dispatch arm reuse
/// the EXACT same Mission-birth (Mission + WorkItem(Draft) + SurfaceThread + route_decision) and
/// the same [`MissionIntakeResultWire`] reply. It touches ONLY the DB (validation + preflight +
/// route-decision write) and makes NO provider/model call — so it writes ZERO `token_ledger` rows.
///
/// Returns either a [`Message::MissionIntakeResult`] envelope (ready/blocked) or a
/// [`Message::Error`] envelope on a validation/preflight failure, correlated to `msg_id`.
///
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MissionIntakeFeatureFlags {
    pub clarify_enabled: bool,
    pub surface_events: bool,
    pub action_list_enabled: bool,
}

impl MissionIntakeFeatureFlags {
    pub const fn new(
        clarify_enabled: bool,
        surface_events: bool,
        action_list_enabled: bool,
    ) -> Self {
        Self {
            clarify_enabled,
            surface_events,
            action_list_enabled,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct IntakeRouteSelection {
    lane: friday_core::WorkLane,
    target_provider_or_agent: Option<String>,
    why_this_route: String,
    considered_options: Vec<String>,
    deferred_options: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AutoRouteDecision {
    lane: friday_core::WorkLane,
    reason: &'static str,
    considered_options: Vec<String>,
    deferred_options: Vec<String>,
}

fn intake_route_selection(
    request: &MissionIntakeRequestWire,
) -> Result<IntakeRouteSelection, &'static str> {
    if request.lane.trim() != "auto" {
        let lane = work_lane_from_wire(&request.lane)?;
        let target = request
            .target_provider_or_agent
            .clone()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| Some(lane.as_str().to_string()));
        return Ok(IntakeRouteSelection {
            lane,
            target_provider_or_agent: target,
            why_this_route: "Surface input must resolve to a canonical Mission.".into(),
            considered_options: vec!["surface-local chat".into(), "Mission Spine".into()],
            deferred_options: vec![MISSION_NATIVE_UI_IMPLEMENTATION_DEFERRED_OPTION.into()],
        });
    }

    if request
        .target_provider_or_agent
        .as_deref()
        .is_some_and(|target| !target.trim().is_empty() && target.trim() != "auto")
    {
        return Err("mission intake auto lane cannot carry an explicit target_provider_or_agent");
    }

    let decision = auto_route_for_intake(
        &request.intent,
        request.capability_id.as_deref().unwrap_or(""),
    );
    Ok(IntakeRouteSelection {
        lane: decision.lane,
        target_provider_or_agent: Some(decision.lane.as_str().to_string()),
        why_this_route: format!("Auto route selected {}.", decision.reason),
        considered_options: decision.considered_options,
        deferred_options: decision.deferred_options,
    })
}

fn auto_route_for_intake(intent: &str, capability_id: &str) -> AutoRouteDecision {
    let text = format!("{} {}", capability_id, intent).to_lowercase();
    let codex_signal = contains_any(
        &text,
        &[
            "codex",
            "code",
            "repo",
            "rust",
            "typescript",
            "swift",
            "python",
            "test",
            "debug",
            "bug",
            "build",
            "compile",
            "refactor",
            "file",
            "workspace",
            "diff",
            "patch",
            "cargo",
            "npm",
            "git",
            "代码",
            "仓库",
            "修复",
            "调试",
            "测试",
            "编译",
            "文件",
        ],
    );
    let claude_signal = contains_any(
        &text,
        &[
            "claude",
            "write",
            "summarize",
            "summary",
            "research",
            "explain",
            "strategy",
            "compare",
            "doc",
            "document",
            "brief",
            "synthesis",
            "synthesize",
            "综述",
            "总结",
            "调研",
            "写作",
            "文档",
            "解释",
            "计划",
        ],
    );
    let base_options = || {
        vec![
            "codex: code, repo, file, test, and workspace changes".into(),
            "claude: writing, synthesis, research, and explanation".into(),
            "deepseek: general quick answer when no stronger route signal is present".into(),
        ]
    };
    if codex_signal && claude_signal {
        return AutoRouteDecision {
            lane: friday_core::WorkLane::Codex,
            reason: "Codex first for workspace execution strength, with Claude synthesis deferred after proof",
            considered_options: vec![
                "combination: Codex first for repo execution, Claude follow-up for synthesis".into(),
                "codex: code, repo, file, test, and workspace changes".into(),
                "claude: writing, synthesis, research, and explanation".into(),
                "deepseek: general quick answer when no stronger route signal is present".into(),
            ],
            deferred_options: vec![
                "Claude synthesis follow-up after the Codex work item produces a proof receipt"
                    .into(),
                MISSION_NATIVE_UI_IMPLEMENTATION_DEFERRED_OPTION.into(),
            ],
        };
    }
    if codex_signal {
        return AutoRouteDecision {
            lane: friday_core::WorkLane::Codex,
            reason: "Codex for code, repo, and workspace execution strength",
            considered_options: base_options(),
            deferred_options: vec![MISSION_NATIVE_UI_IMPLEMENTATION_DEFERRED_OPTION.into()],
        };
    }
    if claude_signal {
        return AutoRouteDecision {
            lane: friday_core::WorkLane::Claude,
            reason: "Claude for synthesis, writing, and explanation strength",
            considered_options: base_options(),
            deferred_options: vec![MISSION_NATIVE_UI_IMPLEMENTATION_DEFERRED_OPTION.into()],
        };
    }
    AutoRouteDecision {
        lane: friday_core::WorkLane::DeepSeek,
        reason: "DeepSeek for general fast-response strength",
        considered_options: base_options(),
        deferred_options: vec![MISSION_NATIVE_UI_IMPLEMENTATION_DEFERRED_OPTION.into()],
    }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

/// ## Mission-intake clarification ([`crate::FRIDAY_MISSION_INTAKE_CLARIFY`], DARK)
/// The [`crate::FRIDAY_MISSION_INTAKE_CLARIFY`] env flag is read ONCE here (the only env
/// read; semantics in [`crate::mission_intake_clarify_from`]) and threaded as a pure bool
/// to the parameterized [`mission_intake_result_for_db_flagged`]. **Default-OFF:** when
/// off the producer is BYTE-IDENTICAL to the pre-clarification baseline — no detail check,
/// every intent births a Mission exactly as now.
///
/// ## Owner binding ([`crate::FRIDAY_MISSION_INTAKE`] dispatch — FIX-Q3b)
/// `authenticated_owner` is the identity the persisted Mission/conversation owner is BOUND to —
/// the Rust-derived session principal at the dispatch arm (`runtime.policy().principal_id()`),
/// NEVER the self-asserted `request.owner_principal` body field. BEFORE persisting ANY row the
/// producer fail-closes unless `request.owner_principal == authenticated_owner` (a `None`/empty
/// authenticated owner, or any mismatch, is a typed `Error` and writes ZERO rows), then persists
/// the AUTHENTICATED owner. Single-peer/single-owner happy path (the body owner == the configured
/// owner) is UNCHANGED — only a MISMATCHED body owner is now rejected (was silently persisted).
pub fn mission_intake_result_for_db(
    db: &Db,
    msg_id: &str,
    request: MissionIntakeRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
) -> Envelope {
    let clarify_enabled = crate::mission_intake_clarify_from(
        std::env::var(crate::FRIDAY_MISSION_INTAKE_CLARIFY)
            .ok()
            .as_deref(),
    );
    // FRIDAY_SURFACE_EVENTS (DARK, default-OFF): read ONCE here and thread the resulting bool to
    // the flagged body — the "split env-read from pure logic" idiom. OFF ⇒ no surface_event emit.
    let surface_events =
        crate::surface_events_from(std::env::var(crate::FRIDAY_SURFACE_EVENTS).ok().as_deref());
    let action_list_enabled = crate::d20_action_list_from(
        std::env::var(crate::FRIDAY_D20_ACTION_LIST_ENABLED)
            .ok()
            .as_deref(),
    );
    let feature_flags =
        MissionIntakeFeatureFlags::new(clarify_enabled, surface_events, action_list_enabled);
    mission_intake_result_for_db_flagged(
        db,
        msg_id,
        request,
        authenticated_owner,
        now_ms,
        feature_flags,
    )
}

/// The parameterized Mission-intake producer body — see [`mission_intake_result_for_db`]
/// for the public env-reading entrypoint. `clarify_enabled` is the resolved
/// [`crate::FRIDAY_MISSION_INTAKE_CLARIFY`] bool, injected directly so the behavioral
/// arms (clarify-ON, clarify-OFF) are testable WITHOUT racing `std::env` in a shared test
/// binary (the codebase's "split env-read from pure logic" idiom).
///
/// **`clarify_enabled == false` ⇒ this is BYTE-IDENTICAL to the pre-clarification baseline:**
/// the whole detail-check block is skipped and the Mission/WorkItem/SurfaceThread/route_decision
/// rows are written exactly as before.
///
/// **`clarify_enabled == true` ⇒** BEFORE constructing or persisting ANY row, the intent is
/// classified ([`friday_core::classify_kind`]); if it classifies to a planning kind that is
/// NOT detailed enough ([`friday_core::is_task_detailed_enough`]), the producer returns a
/// `needs_clarification` [`MissionIntakeResultWire`] carrying the specific
/// [`friday_core::questions_for_kind`] — writing ZERO rows (no Conversation/Mission/
/// SurfaceThread/WorkItem/route_decision) and making NO model call. `created_or_ready` is
/// `false` so the auto-dispatch producer NEVER fires for an under-specified intent.
///
/// **`surface_events`** is the resolved [`crate::FRIDAY_SURFACE_EVENTS`] bool (DARK, default-OFF).
/// When ON, AFTER preflight succeeds (the READY path only — never the `needs_clarification` or
/// `blocked` paths), a single intake-birth [`friday_core::SurfaceEvent`]
/// ([`friday_core::SurfaceEventKind::SystemStatus`]) is emitted BEST-EFFORT via
/// [`crate::surface_events::emit_surface_event`] so the Mission Workbench timeline reader has a
/// birth row to fold in. OFF ⇒ byte-identical (no emit). The emit is failure-isolated: a write
/// failure is logged + swallowed and the intake result is UNCHANGED.
///
/// **`action_list_enabled`** is the resolved [`crate::FRIDAY_D20_ACTION_LIST_ENABLED`] bool.
/// OFF leaves route decisions without `action_items`; ON adds the D20 W1 plan-as-action-list
/// item derived from the WorkItem's existing judgment memory.
pub fn mission_intake_result_for_db_flagged(
    db: &Db,
    msg_id: &str,
    request: MissionIntakeRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
    feature_flags: MissionIntakeFeatureFlags,
) -> Envelope {
    let MissionIntakeFeatureFlags {
        clarify_enabled,
        surface_events,
        action_list_enabled,
    } = feature_flags;
    // (FIX-Q3b) OWNER BINDING — fail-closed BEFORE constructing or persisting ANY row. The
    // persisted Mission/conversation owner MUST be the AUTHENTICATED owner (the Rust-derived
    // session principal threaded from the dispatch arm), NEVER the self-asserted
    // `request.owner_principal` body field. A `None`/empty authenticated owner, or a body
    // `owner_principal` that does not byte-equal it (after trim), is a typed `Error` that writes
    // ZERO rows — closing the audit gap where a self-asserted owner_principal was silently
    // persisted. NO-DEGRADE: the single-peer/single-owner happy path (the body owner == the
    // configured owner == the authenticated owner) passes this check unchanged.
    let authenticated_owner = authenticated_owner.unwrap_or("").trim();
    if authenticated_owner.is_empty() || request.owner_principal.trim() != authenticated_owner {
        return mission_intake_error(
            msg_id,
            now_ms,
            ErrorCode::Internal,
            "mission intake owner_principal does not match the authenticated owner",
        );
    }
    if let Err(err) = friday_core::validate_friday_conversation_id(&request.friday_conversation_id)
    {
        return mission_intake_error(msg_id, now_ms, ErrorCode::Internal, &err.to_string());
    }
    if request.owner_principal.trim().is_empty()
        || request.surface_thread_id.trim().is_empty()
        || request.delivery_route.trim().is_empty()
        || request.mission_id.trim().is_empty()
        || request.work_item_id.trim().is_empty()
        || request.intent.trim().is_empty()
    {
        return mission_intake_error(
            msg_id,
            now_ms,
            ErrorCode::Internal,
            "mission intake required field missing",
        );
    }
    let surface_kind = match surface_kind_from_wire(&request.surface_kind) {
        Ok(kind) => kind,
        Err(message) => return mission_intake_error(msg_id, now_ms, ErrorCode::Internal, message),
    };
    let visibility_policy = match visibility_policy_from_wire(&request.visibility_policy) {
        Ok(policy) => policy,
        Err(message) => return mission_intake_error(msg_id, now_ms, ErrorCode::Internal, message),
    };
    let route_selection = match intake_route_selection(&request) {
        Ok(selection) => selection,
        Err(message) => return mission_intake_error(msg_id, now_ms, ErrorCode::Internal, message),
    };
    let lane = route_selection.lane;
    if let Some(body_ref) = request.body_ref.as_deref() {
        if !is_safe_body_ref(body_ref) {
            return mission_intake_error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                "mission intake body_ref must be a Friday-owned body/blob ref",
            );
        }
    }

    // (FRIDAY_MISSION_INTAKE_CLARIFY, DARK) Ask-first detail check — GATED so flag-OFF is
    // BYTE-IDENTICAL (the whole block is skipped). BEFORE constructing or persisting ANY row:
    // if the intent classifies to a planning kind that is NOT detailed enough, return a
    // `needs_clarification` result carrying the specific questions and write ZERO rows
    // (no Conversation/Mission/SurfaceThread/WorkItem/route_decision). `created_or_ready` is
    // `false`, so the auto-dispatch producer never fires for an under-specified intent — we
    // ask first instead of silently minting an Active Mission. Validation errors above still
    // take precedence identically (this runs only on an already-validated request).
    if clarify_enabled {
        if let Some(kind) = friday_core::classify_kind(&request.intent) {
            if !friday_core::is_task_detailed_enough(&request.intent, kind) {
                let questions: Vec<String> = friday_core::questions_for_kind(kind)
                    .iter()
                    .map(|q| (*q).to_string())
                    .collect();
                // Echo the request's mission_id / surface_thread_id (NO row was written for
                // either — these are the client's proposed ids, surfaced so the TS result
                // parser's required-ref check passes and the clarification is delivered, not
                // buried under a fail-closed 503). work_item_id is None; blockers is empty.
                let result = MissionIntakeResultWire {
                    friday_conversation_id: request.friday_conversation_id.clone(),
                    mission_id: request.mission_id.clone(),
                    work_item_id: None,
                    surface_thread_id: request.surface_thread_id.clone(),
                    status: "needs_clarification".into(),
                    blockers: Vec::new(),
                    duplicate_mission_id: None,
                    duplicate_work_item_id: None,
                    created_or_ready: false,
                    selected_lane: None,
                    selected_target_provider_or_agent: None,
                    clarification_questions: questions,
                };
                return Envelope::new(
                    format!("{msg_id}-mission-intake"),
                    now_ms,
                    Message::MissionIntakeResult { result },
                );
            }
        }
    }

    let target = route_selection.target_provider_or_agent.clone();
    let capability_id = request
        .capability_id
        .clone()
        .filter(|value| !value.trim().is_empty());
    let title = if request.title.trim().is_empty() {
        "Friday Mission".to_string()
    } else {
        request.title.clone()
    };
    let input_ref = request.body_ref.clone().unwrap_or_else(|| {
        format!(
            "friday://body/mission-intake/{}",
            projection_ref_part(&request.work_item_id)
        )
    });
    let codex_provider_claim = if lane == friday_core::WorkLane::Codex
        || target.as_deref() == Some("codex")
    {
        Some(friday_core::WorkspaceClaim {
            claim_id: format!(
                "claim-codex-provider-session-{}-{}",
                projection_ref_part(&request.mission_id),
                projection_ref_part(&request.work_item_id)
            ),
            mission_id: request.mission_id.clone(),
            work_item_id: Some(request.work_item_id.clone()),
            owner_principal: authenticated_owner.to_string(),
            owner_agent: "friday-hub:mission-intake".into(),
            workspace_ref: format!(
                "friday://provider-session/codex/{}",
                projection_ref_part(&request.work_item_id)
            ),
            claim_kind: friday_core::WorkspaceClaimKind::ProviderSession,
            state: friday_core::ClaimState::Active,
            reason: "Mission intake reserved the Codex provider session for observe-wrapper proof."
                .into(),
            safe_release_policy: "release when the bound WorkItem completes or stale recovery reclaims the provider session".into(),
            proof_requirements: vec!["claim-bound Codex process observation".into()],
            proof_refs: vec![format!(
                "proof://mission-intake/{}",
                projection_ref_part(&request.mission_id)
            )],
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            released_at_ms: None,
        })
    } else {
        None
    };
    let owner_claim_ids: Vec<String> = codex_provider_claim
        .as_ref()
        .map(|claim| vec![claim.claim_id.clone()])
        .unwrap_or_default();
    let workspace_claims: Vec<friday_core::WorkspaceClaim> =
        codex_provider_claim.into_iter().collect();

    let conversation = friday_core::FridayConversation {
        friday_conversation_id: request.friday_conversation_id.clone(),
        // (FIX-Q3b) BIND the persisted owner to the AUTHENTICATED owner, never the raw body field.
        // The owner-binding check above already guarantees these are byte-equal (after trim), so
        // this is byte-identical on the happy path — but persisting the authenticated identity is
        // the load-bearing invariant: the audit-trail owner can never disagree with the executing
        // owner, even if a future caller's body field and authenticated principal diverged.
        owner_principal: authenticated_owner.to_string(),
        title: title.clone(),
        current_focus_summary: request.intent.clone(),
        active_mission_ids: Vec::new(),
        surface_thread_ids: Vec::new(),
        memory_scope_ref: None,
        truth_status: friday_core::TruthStatus::WiredRegistry,
        proof_refs: vec![format!(
            "proof://mission-intake/{}",
            projection_ref_part(&request.mission_id)
        )],
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    };
    let mission = friday_core::Mission {
        mission_id: request.mission_id.clone(),
        friday_conversation_id: request.friday_conversation_id.clone(),
        title,
        intent: request.intent.clone(),
        status: friday_core::MissionStatus::Active,
        why_now: "Surface input requested Friday coordination.".into(),
        decision_path_summary: "Mission intake resolved the surface input through Hub preflight."
            .into(),
        considered_options: vec!["detached surface chat".into(), "Mission Spine".into()],
        deferred_options: vec!["native UI rendering".into()],
        known_pitfalls: vec!["duplicate input can create task debt".into()],
        handoff_inheritance: vec!["carry canonical Mission id across surfaces".into()],
        work_item_ids: Vec::new(),
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: Vec::new(),
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    };
    let surface_thread = friday_core::SurfaceThread {
        surface_thread_id: request.surface_thread_id.clone(),
        friday_conversation_id: request.friday_conversation_id.clone(),
        mission_id: Some(request.mission_id.clone()),
        surface_kind,
        channel_binding_id: None,
        delivery_route: request.delivery_route.clone(),
        visibility_policy,
        allowed_actions: vec!["open_mission".into(), "ask_friday".into()],
        last_seen_at_ms: Some(now_ms),
        last_delivered_event_seq: None,
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    };
    let proof_requirements = if request.proof_requirements.is_empty() {
        vec!["Mission-bound provider proof receipt".into()]
    } else {
        request.proof_requirements.clone()
    };
    let work_item = friday_core::WorkItem {
        work_item_id: request.work_item_id.clone(),
        mission_id: request.mission_id.clone(),
        lane,
        target_provider_or_agent: target.clone(),
        status: friday_core::WorkItemStatus::Draft,
        owner_claim_ids: owner_claim_ids.clone(),
        workspace_refs: Vec::new(),
        capability_id,
        risk_level: friday_core::Risk::Low,
        approval_state: friday_core::ApprovalState::NotRequired,
        blocking_reason: None,
        input_refs: vec![input_ref],
        output_refs: Vec::new(),
        proof_requirements: proof_requirements.clone(),
        proof_receipts: Vec::new(),
        judgment_memory: friday_core::HandoffJudgmentMemory {
            task: request.intent.clone(),
            current_blocker: None,
            target_lane_thread_agent_provider: lane.as_str().to_string(),
            read_first_files: Vec::new(),
            required_output: "Mission-bound result with proof receipt".into(),
            done_criteria: vec!["WorkItem completes only after proof".into()],
            red_lines: vec!["do not create detached provider state".into()],
            why_this_route: route_selection.why_this_route,
            considered_options: route_selection.considered_options,
            deferred_options: route_selection.deferred_options,
            previous_pitfalls: vec!["provider ack looked like done".into()],
            inheritable_context: vec!["same Mission renders across surfaces".into()],
            proof_requirements,
            ownership_claim_ids: owner_claim_ids,
        },
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    };
    let route_decision = friday_core::RouteDecisionCard::from_work_item_flagged(
        format!(
            "route-intake-{}-{}",
            projection_ref_part(&request.mission_id),
            projection_ref_part(&request.work_item_id)
        ),
        &work_item,
        vec![format!(
            "friday://surface-thread/{}",
            projection_ref_part(&request.surface_thread_id)
        )],
        now_ms,
        None,
        action_list_enabled,
    );
    let body_snapshot = match MissionBodySnapshot::new(
        authenticated_owner,
        &request.mission_id,
        &request.work_item_id,
        work_item
            .input_refs
            .first()
            .map(String::as_str)
            .unwrap_or(""),
        surface_kind.as_str(),
        &request.intent,
        now_ms,
    ) {
        Ok(snapshot) => snapshot,
        Err(err) => {
            return mission_intake_error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                &format!("mission intake body snapshot blocked: {err}"),
            );
        }
    };

    let outcome = match preflight_and_stage_work_item_with_workspace_claims(
        db,
        MissionPreflightRequest {
            conversation,
            mission,
            surface_thread: Some(surface_thread),
            work_item,
            body_snapshot: Some(body_snapshot),
            includes_sensitive_context: request.includes_sensitive_context,
        },
        &workspace_claims,
    ) {
        Ok(outcome) => outcome,
        Err(err) => {
            return mission_intake_error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                &format!("mission intake blocked: {err}"),
            );
        }
    };

    if outcome.is_ready() {
        if let Err(err) = db.upsert_route_decision(&route_decision) {
            return mission_intake_error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                &format!("mission intake route decision write failed: {err}"),
            );
        }
        // (FRIDAY_SURFACE_EVENTS, DARK, default-OFF) Intake-birth surface_event — emitted ONLY on
        // the READY path (NOT needs_clarification / blocked), AFTER preflight wrote the
        // Mission/SurfaceThread (so the linkage validates) and the route decision succeeded. The
        // SurfaceThread the preflight upserted is bound to this Mission with `surface_kind` (the
        // value resolved above), so `validate_surface_event` passes and the workbench timeline
        // reader folds the row in. BEST-EFFORT: a write failure is logged + swallowed inside
        // `emit_surface_event`, so the intake result below is UNCHANGED. `surface_events == false`
        // ⇒ `emit_surface_event` returns before any write (byte-identical-off, belt-and-suspenders
        // on top of the caller already skipping on flag-OFF).
        if let MissionPreflightOutcome::Ready {
            mission_id,
            work_item_id,
        } = &outcome
        {
            crate::surface_events::emit_surface_event(
                db,
                surface_events,
                crate::surface_events::SurfaceEventLifecycle::IntakeBirth,
                &crate::surface_events::SurfaceEventLink {
                    friday_conversation_id: &request.friday_conversation_id,
                    mission_id,
                    work_item_id: Some(work_item_id),
                    surface_thread_id: &request.surface_thread_id,
                    source_surface: surface_kind,
                },
                // No run yet at intake birth; the event_id keys on the mission_id for this point.
                mission_id,
                None,
                None,
                now_ms,
            );
        }
    }

    let result = match outcome {
        MissionPreflightOutcome::Ready {
            mission_id,
            work_item_id,
        } => MissionIntakeResultWire {
            friday_conversation_id: request.friday_conversation_id,
            mission_id,
            work_item_id: Some(work_item_id),
            surface_thread_id: request.surface_thread_id,
            status: "ready".into(),
            blockers: Vec::new(),
            duplicate_mission_id: None,
            duplicate_work_item_id: None,
            created_or_ready: true,
            selected_lane: Some(lane.as_str().to_string()),
            selected_target_provider_or_agent: target.clone(),
            clarification_questions: Vec::new(),
        },
        MissionPreflightOutcome::Blocked {
            blockers,
            duplicate_mission_id,
            duplicate_work_item_id,
        } => {
            let mission_id = duplicate_mission_id
                .clone()
                .unwrap_or_else(|| request.mission_id.clone());
            let work_item_id = duplicate_work_item_id.clone();
            MissionIntakeResultWire {
                friday_conversation_id: request.friday_conversation_id,
                mission_id,
                work_item_id,
                surface_thread_id: request.surface_thread_id,
                status: "blocked".into(),
                blockers,
                duplicate_mission_id,
                duplicate_work_item_id,
                created_or_ready: false,
                selected_lane: None,
                selected_target_provider_or_agent: None,
                clarification_questions: Vec::new(),
            }
        }
    };
    Envelope::new(
        format!("{msg_id}-mission-intake"),
        now_ms,
        Message::MissionIntakeResult { result },
    )
}

/// (NS-5) Free-function form of [`HubServer::error`] for [`mission_intake_result_for_db`] (which is
/// not a method, so it cannot call `Self::error`). Same shape: a correlated [`Message::Error`]
/// envelope.
fn mission_intake_error(msg_id: &str, now_ms: i64, code: ErrorCode, message: &str) -> Envelope {
    Envelope::new(
        format!("{msg_id}-error"),
        now_ms,
        Message::Error {
            code,
            message: message.to_string(),
        },
    )
    .with_correlation(msg_id.to_string())
}

/// The Mission lifecycle-transition mutation, parameterized over `&Db` so BOTH the
/// [`HubServer::dispatch`] path AND the live agent-run server bin's flag-gated dispatch arm reuse
/// the EXACT same Hub state-machine transition and the same [`MissionLifecycleResultWire`] reply.
/// It touches ONLY the DB (status-transition validation + audit + write) and makes NO
/// provider/model call — so it writes ZERO `token_ledger` rows.
///
/// Returns a [`Message::MissionLifecycleResult`] envelope on success, or a [`Message::Error`]
/// envelope on an unknown target status / invalid transition / missing Mission, correlated to
/// `msg_id`. A status change here is a Mission-management fact, NOT provider completion unless the
/// command carried and persisted valid proof.
///
/// ## Owner binding (FIX-Q3b)
/// `authenticated_owner` is the Rust-derived session principal threaded from the dispatch arm
/// (`runtime.policy().principal_id()`). The target Mission's OWNER (its conversation's
/// `owner_principal`) MUST match it: a request to transition a Mission owned by a DIFFERENT
/// principal — or by no authenticated principal at all (`None`/empty) — is a typed `Error` that
/// transitions NOTHING. The owner check runs only when the target Mission EXISTS; an unknown
/// Mission falls through to the storage transition, preserving the existing not-found Error shape
/// (so the cross-owner/not-found denial stays "not found"). NO-DEGRADE: under single-peer/
/// single-owner the Mission owner == the configured owner == the authenticated owner, so the
/// happy-path transition is unchanged.
pub fn mission_lifecycle_result_for_db(
    db: &Db,
    msg_id: &str,
    request: MissionLifecycleRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
) -> Envelope {
    let next_status = match mission_status_from_wire(&request.target_status) {
        Ok(status) => status,
        Err(message) => {
            return mission_intake_error(msg_id, now_ms, ErrorCode::Internal, message);
        }
    };

    // (FIX-Q3b) OWNER BINDING — reject a cross-owner transition BEFORE any write. The target
    // Mission's owner is its conversation's `owner_principal` (the Hub's single source of truth).
    // Resolve it ONLY when the Mission exists; an unknown Mission yields `None` here and falls
    // through to `transition_mission_status`, which produces the existing "not found" Error — so
    // the cross-owner/not-found denial keeps its current shape. A present Mission whose owner does
    // NOT match the authenticated owner (or a `None`/empty authenticated owner) is fail-closed.
    let authenticated_owner = authenticated_owner.unwrap_or("").trim();
    if let Ok(Some(mission)) = db.get_mission(&request.mission_id) {
        // Resolve the owner from the Mission's OWN conversation (its source of truth), not the
        // request's `friday_conversation_id` — so a body that points the wrong conversation at a
        // real Mission cannot dodge the owner check.
        let mission_owner = resolve_conversation_owner(db, &mission.friday_conversation_id);
        let owner_ok = !authenticated_owner.is_empty()
            && mission_owner.as_deref() == Some(authenticated_owner);
        if !owner_ok {
            return mission_intake_error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                "mission lifecycle blocked: target Mission is not owned by the authenticated owner",
            );
        }
    }

    match db.transition_mission_status(
        &request.friday_conversation_id,
        &request.mission_id,
        next_status,
        &request.actor_ref,
        &request.reason,
        request.proof_ref.as_deref(),
        request.merged_into_mission_id.as_deref(),
        now_ms,
    ) {
        Ok((mission, previous_status, active_mission_ids)) => Envelope::new(
            format!("{msg_id}-mission-lifecycle"),
            now_ms,
            Message::MissionLifecycleResult {
                result: MissionLifecycleResultWire {
                    friday_conversation_id: mission.friday_conversation_id,
                    mission_id: mission.mission_id,
                    previous_status: previous_status.as_str().to_string(),
                    status: mission.status.as_str().to_string(),
                    actor_ref: request.actor_ref,
                    reason: request.reason,
                    proof_ref: request.proof_ref,
                    merged_into_mission_id: request.merged_into_mission_id,
                    active_mission_ids,
                    updated_at_ms: mission.updated_at_ms,
                },
            },
        ),
        // FAIL-CLOSED: any transition error (unknown Mission, illegal hop, conflicting merge) is a
        // typed Error envelope — never a partial write (the storage transition is one transaction).
        Err(err) => mission_intake_error(
            msg_id,
            now_ms,
            ErrorCode::Internal,
            &format!("mission lifecycle blocked: {err}"),
        ),
    }
}

/// The WorkItem lifecycle-transition mutation, parameterized over `&Db` so the live agent-run
/// server bin's flag-gated dispatch arm can advance a WorkItem through the Hub state machine
/// WITHOUT a `HubServer`. It touches ONLY the DB (status-transition validation + the
/// proof-on-completion invariant + audit + write) and makes NO provider/model call — so it writes
/// ZERO `token_ledger` rows.
///
/// **Proof-on-completion is ENFORCED, not advisory:** the underlying
/// [`Db::transition_work_item_status`] REJECTS a `completed_with_proof` target that carries no
/// `proof_receipt` (or an empty one), so "done" can never be claimed without proof. This function
/// surfaces that rejection as a typed [`Message::Error`] — it never fakes a completion. Returns a
/// [`Message::WorkItemStatusResult`] on success, correlated to `msg_id`.
///
/// ## Owner binding (FIX-Q3b)
/// `authenticated_owner` is the Rust-derived session principal threaded from the dispatch arm
/// (`runtime.policy().principal_id()`). The target WorkItem's OWNER (its Mission's conversation's
/// `owner_principal`) MUST match it: advancing a WorkItem owned by a DIFFERENT principal — or by
/// no authenticated principal (`None`/empty) — is a typed `Error` that transitions NOTHING. The
/// check runs only when the target WorkItem EXISTS; an unknown WorkItem falls through to the
/// storage transition, preserving the existing "not found" denial shape (the cross-owner/not-found
/// equivalence under single-peer). NO-DEGRADE: under single-peer/single-owner the owner == the
/// configured owner == the authenticated owner, so the happy-path transition is unchanged.
pub fn work_item_status_result_for_db(
    db: &Db,
    msg_id: &str,
    request: WorkItemStatusRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
) -> Envelope {
    let next_status = match work_item_status_from_wire(&request.target_status) {
        Ok(status) => status,
        Err(message) => {
            return mission_intake_error(msg_id, now_ms, ErrorCode::Internal, message);
        }
    };

    // (FIX-Q3b) OWNER BINDING — reject a cross-owner transition BEFORE any write. The target
    // WorkItem's owner is its Mission's conversation's `owner_principal`. Resolve it ONLY when the
    // WorkItem (and its Mission) exists; an unknown WorkItem yields `None` and falls through to
    // `transition_work_item_status`, which produces the existing "not found" Error — so the
    // cross-owner/not-found denial keeps its current shape. A present WorkItem whose owner does NOT
    // match the authenticated owner (or a `None`/empty authenticated owner) is fail-closed.
    let authenticated_owner = authenticated_owner.unwrap_or("").trim();
    if let Ok(Some(work_item)) = db.get_work_item(&request.work_item_id) {
        let owner = db
            .get_mission(&work_item.mission_id)
            .ok()
            .flatten()
            .and_then(|m| resolve_conversation_owner(db, &m.friday_conversation_id));
        let owner_ok =
            !authenticated_owner.is_empty() && owner.as_deref() == Some(authenticated_owner);
        if !owner_ok {
            return mission_intake_error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                "work item lifecycle blocked: target WorkItem is not owned by the authenticated owner",
            );
        }
        if next_status == friday_core::WorkItemStatus::CompletedWithProof
            && friday_core::outcome_checked_proof_enabled()
            && work_item.has_outcome_proof_requirements()
        {
            return mission_intake_error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                "work item lifecycle blocked: outcome-checked completion requires a server-minted outcome receipt; WorkItemStatus WS ingress cannot accept client-supplied outcome proof",
            );
        }
    }

    // A blank proof_receipt is normalized to `None` BEFORE the call so the storage layer's
    // (CompletedWithProof, None) rejection fires for an all-whitespace receipt too — a
    // whitespace-only "proof" must never satisfy the proof-on-completion invariant.
    let proof_receipt = request
        .proof_receipt
        .as_deref()
        .map(str::trim)
        .filter(|receipt| !receipt.is_empty());

    match db.transition_work_item_status(
        &request.work_item_id,
        next_status,
        &request.actor_ref,
        &request.reason,
        proof_receipt,
        now_ms,
    ) {
        Ok((work_item, previous_status)) => Envelope::new(
            format!("{msg_id}-work-item-status"),
            now_ms,
            Message::WorkItemStatusResult {
                result: WorkItemStatusResultWire {
                    work_item_id: work_item.work_item_id,
                    mission_id: work_item.mission_id,
                    previous_status: previous_status.as_str().to_string(),
                    status: work_item.status.as_str().to_string(),
                    actor_ref: request.actor_ref,
                    reason: request.reason,
                    // COUNT only — never the raw receipt refs (they can carry provider/channel ids).
                    proof_receipt_count: work_item.proof_receipts.len() as u64,
                    updated_at_ms: work_item.updated_at_ms,
                },
            },
        ),
        // FAIL-CLOSED: a proofless `completed_with_proof`, an illegal hop, an unknown WorkItem, or a
        // receipt on a non-completion target is a typed Error — never a partial / fake-ready write
        // (the storage transition is one transaction: audit row + upsert commit together).
        Err(err) => mission_intake_error(
            msg_id,
            now_ms,
            ErrorCode::Internal,
            &format!("work item lifecycle blocked: {err}"),
        ),
    }
}

/// Apply one OWNER route-decision control before dispatch. This is the operator-facing half of
/// D20 W1-S3: it does not decorate the card only; the persisted control is consulted by the
/// `ReadyToDispatch -> Dispatched` WorkItem lifecycle transition in `friday-storage`, where a veto
/// blocks dispatch and an override changes lane/target inside the same transaction.
///
/// Owner binding mirrors WorkItem status: resolve decision -> WorkItem -> Mission -> conversation
/// owner, and require it to match the Rust-derived authenticated owner before writing.
pub fn route_decision_control_result_for_db(
    db: &Db,
    msg_id: &str,
    request: RouteDecisionControlRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
) -> Envelope {
    let (resolved_decision_id, decision) = match resolve_route_decision_control_target(db, &request)
    {
        Ok((decision_id, Some(decision))) => (decision_id, decision),
        Ok((_, None)) => {
            return mission_intake_error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                "route decision control blocked: target RouteDecision not found",
            );
        }
        Err(message) => {
            return mission_intake_error(msg_id, now_ms, ErrorCode::Internal, message);
        }
    };

    let authenticated_owner = authenticated_owner.unwrap_or("").trim();
    let owner = db
        .get_mission(&decision.mission_id)
        .ok()
        .flatten()
        .and_then(|m| resolve_conversation_owner(db, &m.friday_conversation_id));
    let owner_ok = !authenticated_owner.is_empty() && owner.as_deref() == Some(authenticated_owner);
    if !owner_ok {
        return mission_intake_error(
            msg_id,
            now_ms,
            ErrorCode::Internal,
            "route decision control blocked: target RouteDecision is not owned by the authenticated owner",
        );
    }

    let (override_lane, override_provider_or_agent) = match request.control_kind.as_str() {
        "veto" => {
            if request.override_lane.is_some() || request.override_provider_or_agent.is_some() {
                return mission_intake_error(
                    msg_id,
                    now_ms,
                    ErrorCode::Internal,
                    "route decision control blocked: veto cannot carry override target",
                );
            }
            (None, None)
        }
        "override" => {
            let Some(lane) = request.override_lane.as_deref() else {
                return mission_intake_error(
                    msg_id,
                    now_ms,
                    ErrorCode::Internal,
                    "route decision control blocked: override requires override_lane",
                );
            };
            let lane = match work_lane_from_wire(lane) {
                Ok(lane) => lane,
                Err(message) => {
                    return mission_intake_error(msg_id, now_ms, ErrorCode::Internal, message);
                }
            };
            (Some(lane), request.override_provider_or_agent.as_deref())
        }
        _ => {
            return mission_intake_error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                "route decision control blocked: control_kind is unknown",
            );
        }
    };

    let result = match request.control_kind.as_str() {
        "veto" => db.veto_route_decision(
            &resolved_decision_id,
            &request.actor_ref,
            &request.reason,
            now_ms,
        ),
        "override" => db.override_route_decision(
            &resolved_decision_id,
            override_lane.expect("override lane was validated above"),
            override_provider_or_agent,
            &request.actor_ref,
            &request.reason,
            now_ms,
        ),
        _ => unreachable!("control_kind was validated above"),
    };

    match result {
        Ok(()) => match db.get_route_decision(&resolved_decision_id) {
            Ok(Some(decision)) => Envelope::new(
                format!("{msg_id}-route-decision-control"),
                now_ms,
                Message::RouteDecisionControlResult {
                    result: RouteDecisionControlResultWire {
                        decision_id: decision.decision_id,
                        mission_id: decision.mission_id,
                        work_item_id: decision.work_item_id,
                        control_kind: request.control_kind,
                        override_lane: override_lane.map(|lane| lane.as_str().to_string()),
                        override_provider_or_agent: request.override_provider_or_agent,
                        actor_ref: request.actor_ref,
                        reason: request.reason,
                        updated_at_ms: now_ms,
                    },
                },
            ),
            Ok(None) => mission_intake_error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                "route decision control blocked: RouteDecision disappeared after control write",
            ),
            Err(err) => mission_intake_error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                &format!("route decision control blocked: {err}"),
            ),
        },
        Err(err) => mission_intake_error(
            msg_id,
            now_ms,
            ErrorCode::Internal,
            &format!("route decision control blocked: {err}"),
        ),
    }
}

fn resolve_route_decision_control_target(
    db: &Db,
    request: &RouteDecisionControlRequestWire,
) -> Result<(String, Option<friday_core::RouteDecisionCard>), &'static str> {
    let direct = db
        .get_route_decision(&request.decision_id)
        .map_err(|_| "route decision control blocked: target lookup failed")?;
    if let Some(decision) = direct {
        return Ok((request.decision_id.clone(), Some(decision)));
    }

    let mission_id = request
        .mission_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("route decision control blocked: projection ref requires mission_id")?;
    let projection_ref = request.decision_id.trim();
    let mut matches = db
        .list_route_decisions_for_mission(mission_id)
        .map_err(|_| "route decision control blocked: mission lookup failed")?
        .into_iter()
        .filter(|candidate| {
            candidate.to_projection().route_decision_ref == projection_ref
                && request
                    .work_item_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map_or(true, |work_item_id| candidate.work_item_id == work_item_id)
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err("route decision control blocked: projection ref did not resolve to exactly one RouteDecision");
    }
    let decision = matches.remove(0);
    Ok((decision.decision_id.clone(), Some(decision)))
}

/// Apply the OWNER's explicit confirm/reject decision to ONE pending memory
/// candidate — the live caller that CLOSES the Memory-confirmation loop's terminal
/// arm (`07` §6/§7). Parameterized over `&Db` so the live agent-run server bin's
/// flag-gated dispatch arm reuses the EXACT same mutation WITHOUT a `HubServer`,
/// mirroring [`mission_intake_result_for_db`] / [`work_item_status_result_for_db`].
/// It touches ONLY the DB and makes NO provider/model call — so it writes ZERO
/// `token_ledger` rows.
///
/// **The decision is the OWNER's own action.** The sealed single-peer session IS the
/// channel auth (the same invariant the mission arms rely on); this is NOT an agent
/// mutating-tool action, so it does NOT route through the approval/trust gate. But it
/// IS owner/namespace-scoped and **fail-closed on mismatch**, enforced BEFORE the
/// decide so a blocked request leaves the candidate UNCHANGED:
/// - the scope source is the **`authenticated_owner`** (the Rust-derived principal at
///   the dispatch arm — `runtime.policy().principal_id()`), NOT the raw
///   `request.owner_principal` body field. An empty/absent `authenticated_owner` ⇒ no
///   candidate matches ⇒ blocked.
/// - the candidate must exist — else blocked (`state="unknown"`).
/// - the candidate's `principal_id` must be a MEMBER of the SAME owner-derived dual-read
///   namespace candidate list [`crate::session_namespace::resolve_session_memory_namespace_candidates`]
///   that the SESSIONED recall consults (`(None, None, authenticated_owner)`). The live
///   extraction keys a candidate's `principal_id` on this COMPOSITE namespace (never the
///   raw principal), so scoping on the raw body field would NEVER match — the defect this
///   fix closes (mirrors #759's recall alignment). A candidate owned by a different
///   principal's namespace, OR an UNOWNED (`None`-principal) candidate, is decidable by NO
///   ONE (no wildcard; an empty owner yields an EMPTY candidate list ⇒ fail-closed). The
///   per-principal SQL stays exact-match, so a member-check over alice's candidate list can
///   never contain bob's namespace — no cross-owner confirm.
///
/// Only after the scope check passes does it call
/// [`friday_storage::memory::confirm`] / [`reject`]. A `confirm` makes the candidate
/// durable AND recallable (the whole point of the loop): the SAME `principal_id`
/// threads `record_candidate` → confirm → `recall_confirmed`. A `reject` makes it a
/// terminal `Rejected` row (never recallable). A terminal candidate (already
/// confirmed/rejected) is refused by the storage layer ("refusing to re-decide") and
/// surfaced as a blocked result — never a panic. The reply is REFS-ONLY: the candidate
/// id + resulting state + a coarse status/blocker — NEVER the candidate's content.
///
/// Returns a [`Message::MemoryDecisionResult`] envelope (confirmed / rejected /
/// blocked) correlated to `msg_id`.
pub fn memory_decision_result_for_db(
    db: &Db,
    msg_id: &str,
    request: MemoryDecisionRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
) -> Envelope {
    use friday_storage::memory;

    let decision = request.decision.trim().to_ascii_lowercase();

    // The SCOPE source is the AUTHENTICATED owner (the Rust-derived principal threaded from
    // the dispatch arm), NEVER the raw `request.owner_principal` body field. An empty/absent
    // owner trims to the empty string, which yields an EMPTY candidate list below — so it
    // matches NO candidate (fail-closed, preserving the old owner_principal_required block).
    let owner = authenticated_owner.unwrap_or("").trim();

    // Validate the decision token fail-closed (the `*_from_wire` idiom): anything other
    // than the two explicit decisions is a block, never a default.
    let confirmed = match decision.as_str() {
        "confirm" => true,
        "reject" => false,
        _ => {
            return memory_decision_blocked(
                msg_id,
                now_ms,
                &request.memory_id,
                "unknown",
                "invalid_decision",
            );
        }
    };

    // An owner-less request (no AUTHENTICATED principal) can match no candidate (recall's
    // blank→fail-closed rule; the candidate list below would be empty anyway, but we block
    // early with the SAME `owner_principal_required` reason for a clear refs surface).
    if owner.is_empty() {
        return memory_decision_blocked(
            msg_id,
            now_ms,
            &request.memory_id,
            "unknown",
            "owner_principal_required",
        );
    }

    // The owner-derived dual-read namespace candidate list — the SAME `[hardened, legacy]`
    // list the SESSIONED recall consults (account/channel unset, direct userId == the
    // authenticated owner). The live extraction keys a candidate's `principal_id` on this
    // COMPOSITE namespace, so this is the correct scope source (NOT the raw owner string).
    // A non-empty owner always resolves (no fail-closed `UnresolvableNoUserId` here), but we
    // `unwrap_or_default()` to an EMPTY list defensively so any unforeseen unresolvable owner
    // fails closed (matches no candidate) rather than panicking. NO-WIDEN: this list for
    // owner alice can NEVER contain bob's namespace, and the per-principal SQL stays
    // exact-match, so a member-check can never confirm a cross-owner candidate.
    let scope_candidates = crate::session_namespace::resolve_session_memory_namespace_candidates(
        None,
        None,
        Some(owner),
    )
    .unwrap_or_default();

    // Resolve the candidate. An unknown id is a block (no decide call, no panic).
    let row = match memory::get(db.conn(), &request.memory_id) {
        Ok(Some(row)) => row,
        Ok(None) => {
            return memory_decision_blocked(
                msg_id,
                now_ms,
                &request.memory_id,
                "unknown",
                "unknown_candidate",
            );
        }
        Err(_) => {
            return memory_decision_blocked(
                msg_id,
                now_ms,
                &request.memory_id,
                "unknown",
                "candidate_read_failed",
            );
        }
    };

    // Owner/namespace scope: DUAL-READ MEMBERSHIP of the candidate's owning principal in the
    // owner-derived namespace candidate list (the SAME list recall uses). An unowned (`None`)
    // candidate, or one keyed on a DIFFERENT owner's namespace, is a MEMBER of no one's list —
    // decidable by no one, fail-closed, candidate left UNCHANGED (this check runs BEFORE any
    // decide). An empty `scope_candidates` (only when owner is unresolvable, defended above)
    // matches nothing.
    let scope_ok = row
        .principal_id
        .as_deref()
        .is_some_and(|p| scope_candidates.iter().any(|c| c.as_str() == p));
    if !scope_ok {
        return memory_decision_blocked(
            msg_id,
            now_ms,
            &request.memory_id,
            row.state.as_str(),
            "owner_scope_mismatch",
        );
    }

    // Scope cleared: apply the explicit decision. A terminal candidate is refused by
    // the storage layer (no re-decide / no downgrade) — surface it as a block.
    let new_state = match memory::decide(db.conn(), &request.memory_id, confirmed, now_ms) {
        Ok(state) => state,
        Err(_) => {
            return memory_decision_blocked(
                msg_id,
                now_ms,
                &request.memory_id,
                row.state.as_str(),
                "not_decidable",
            );
        }
    };

    // Recallability is the loop's payoff: a confirmed, content-bearing candidate keyed on the
    // owner's composite namespace is now returned by the SESSIONED recall. Derive `recallable`
    // from the SAME dual-read query that recall uses (`recall_confirmed_multi` over the SAME
    // namespace candidate list) — NOT the raw owner — so the surface never claims
    // recallability a recall would not honor (e.g. a content-less confirmed row, OR — the bug
    // this fix closes — a composite-namespace row a raw-owner query would miss).
    let candidate_refs: Vec<&str> = scope_candidates.iter().map(String::as_str).collect();
    let recallable = matches!(new_state, friday_core::MemoryState::Confirmed)
        && memory::recall_confirmed_multi(db.conn(), &candidate_refs)
            .map(|rows| rows.iter().any(|r| r.memory_id == request.memory_id))
            .unwrap_or(false);

    let status = match new_state {
        friday_core::MemoryState::Confirmed => "confirmed",
        friday_core::MemoryState::Rejected => "rejected",
        // `decide` over a pending candidate only ever returns Confirmed/Rejected;
        // a still-Candidate result is impossible here (Some(true|false) was passed).
        friday_core::MemoryState::Candidate => "blocked",
    };

    Envelope::new(
        format!("{msg_id}-memory-decision"),
        now_ms,
        Message::MemoryDecisionResult {
            result: MemoryDecisionResultWire {
                memory_id: request.memory_id,
                state: new_state.as_str().to_string(),
                status: status.to_string(),
                blocker: None,
                recallable,
            },
        },
    )
    .with_correlation(msg_id.to_string())
}

/// (CORE-A CR-3) CREATE/ensure ONE agent-session row from a sealed [`Message::SessionCreateRequest`]
/// — the Rust-owned `sessions.create`. PURE Hub `&Db` mutation: NO provider/model call, ZERO
/// `token_ledger` rows. Reuses the EXISTING [`friday_storage::ensure_session_with_owner`] storage
/// primitive (no new storage).
///
/// **OWNER binding (FIX-Q3b + INV-5/INV-7):** the session's owner axis (`agent_session.user_id`) is
/// bound to the Rust-derived AUTHENTICATED owner (`authenticated_owner`, the configured
/// `--owner`/`principal_id`), NEVER a raw client field — exactly as `run_session_task_pinned` binds
/// it. A body `user_id` that is present AND disagrees with the authenticated owner is fail-closed (an
/// `Error`, writing ZERO rows); an absent/blank/matching body `user_id` binds the authenticated
/// owner. An empty authenticated owner is refused (no anonymous session). The descriptive axes
/// (channel/chat_id/account_id/chat_kind) ride from the request; `metadata_json` is refs-only and NOT
/// persisted by the minimal store.
///
/// Reply: a REFS-ONLY [`Message::SessionCreateResult`] (id + stored timestamps, read back so an
/// idempotent re-ensure reports the row's ORIGINAL `created_at`). Any storage failure surfaces as a
/// typed `Error` (fail-closed) — never a fake receipt.
pub fn session_create_result_for_db(
    db: &Db,
    msg_id: &str,
    request: SessionCreateRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
) -> Envelope {
    let owner = authenticated_owner.unwrap_or("").trim();
    if owner.is_empty() {
        return session_error(msg_id, now_ms, "session create requires an authenticated owner");
    }
    if request.session_id.trim().is_empty() {
        return session_error(msg_id, now_ms, "session create requires a non-empty session id");
    }
    // FIX-Q3b: a body-asserted owner that DISAGREES with the authenticated owner is fail-closed.
    // Absent/blank/matching ⇒ bind the authenticated owner (single-owner v1: the forwarded
    // principal equals the configured owner, so the live path is unchanged).
    if let Some(body_owner) = request.user_id.as_deref() {
        let body_owner = body_owner.trim();
        if !body_owner.is_empty() && body_owner != owner {
            return session_error(
                msg_id,
                now_ms,
                "session create owner mismatch (body user_id disagrees with authenticated owner)",
            );
        }
    }

    let session_id = request.session_id.trim();
    let session_owner = SessionOwner {
        // OWNER SCOPE axis = the authenticated principal (NEVER the raw body field).
        user_id: Some(owner.to_string()),
        channel: request.channel.clone(),
        chat_id: request.chat_id.clone(),
        account_id: request.account_id.clone(),
        chat_kind: request.chat_kind.clone(),
        ..SessionOwner::default()
    };
    if friday_storage::ensure_session_with_owner(db.conn(), session_id, &session_owner, now_ms)
        .is_err()
    {
        return session_error(msg_id, now_ms, "session create storage write failed");
    }
    // Read back the AUTHORITATIVE timestamps (an idempotent re-ensure keeps `created_at`).
    let (created_at, updated_at) = match friday_storage::session_timestamps(db.conn(), session_id) {
        Ok(Some(ts)) => ts,
        _ => return session_error(msg_id, now_ms, "session create readback failed"),
    };

    Envelope::new(
        format!("{msg_id}-session-create"),
        now_ms,
        Message::SessionCreateResult {
            result: SessionCreateResultWire {
                session_id: session_id.to_string(),
                created_at,
                updated_at,
            },
        },
    )
    .with_correlation(msg_id.to_string())
}

/// (CORE-A CR-3) APPEND ONE conversation message from a sealed
/// [`Message::SessionMessageAppendRequest`] — the Rust-owned `sessions.messages.create`. PURE Hub
/// `&Db` mutation: NO provider/model call, ZERO `token_ledger` rows. Reuses the EXISTING owner-gated
/// [`friday_storage::append_session_message`] (seq auto-increment, `updated_at` bump) — no new
/// storage.
///
/// **OWNER-GATED fail-closed (INV-5/INV-7):** the append is REFUSED (a typed `Error`, ZERO rows)
/// unless the target session is owned by the AUTHENTICATED principal
/// ([`friday_storage::session_owner_matches`] on the SAME `agent_session.user_id` axis as the C2-4
/// read API). A guessed `session_id`, an owner-less session, or a DIFFERENT owner cannot append. An
/// empty authenticated owner is refused.
///
/// Reply: a REFS-ONLY [`Message::SessionMessageAppendResult`] (message id + store-assigned `seq` +
/// timestamps; NEVER the appended body).
pub fn session_message_append_result_for_db(
    db: &Db,
    msg_id: &str,
    request: SessionMessageAppendRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
) -> Envelope {
    let owner = authenticated_owner.unwrap_or("").trim();
    if owner.is_empty() {
        return session_error(msg_id, now_ms, "session append requires an authenticated owner");
    }
    let session_id = request.session_id.trim();
    if session_id.is_empty() {
        return session_error(msg_id, now_ms, "session append requires a non-empty session id");
    }
    if request.role.trim().is_empty() {
        return session_error(msg_id, now_ms, "session append requires a non-empty role");
    }
    // OWNER GATE FIRST: refuse before ANY write when the authenticated principal does not own the
    // session (a non-owner, an owner-less session, or an absent id all fail-closed here).
    match friday_storage::session_owner_matches(db.conn(), owner, session_id) {
        Ok(true) => {}
        Ok(false) => {
            return session_error(
                msg_id,
                now_ms,
                "session append refused: authenticated owner does not own this session",
            );
        }
        Err(_) => return session_error(msg_id, now_ms, "session append owner check failed"),
    }

    let message = SessionMessage {
        role: request.role.clone(),
        content: request.content.clone(),
        refs: request.refs.clone(),
    };
    let message_id =
        match friday_storage::append_session_message(db.conn(), session_id, &message, now_ms) {
            Ok(id) => id,
            Err(_) => return session_error(msg_id, now_ms, "session append storage write failed"),
        };
    // The store assigns `message_id = "<session>:m<seq>"` and writes the message `created_at` AND the
    // session `updated_at` to the SAME `now_ms` — so `seq` is parsed from the id suffix and the
    // timestamps are `now_ms` (authoritative, not invented). Defensive parse: an unexpected id shape
    // fails closed rather than reporting a wrong ordinal.
    let seq = match message_id.rsplit_once(":m").and_then(|(_, s)| s.parse::<i64>().ok()) {
        Some(seq) => seq,
        None => return session_error(msg_id, now_ms, "session append produced an unparseable id"),
    };

    Envelope::new(
        format!("{msg_id}-session-append"),
        now_ms,
        Message::SessionMessageAppendResult {
            result: SessionMessageAppendResultWire {
                message_id,
                seq,
                created_at: now_ms,
                updated_at: now_ms,
            },
        },
    )
    .with_correlation(msg_id.to_string())
}

/// (CORE-A CR-3) Fail-closed session-lifecycle refusal/error envelope: a typed [`Message::Error`]
/// correlated to the inbound request. Used for owner refusals, empty-owner, invalid input, and
/// storage failures — a WRITE op that does not succeed surfaces an `Error` (the TS sealed client
/// fails closed → 503), NEVER a fabricated refs receipt.
fn session_error(msg_id: &str, now_ms: i64, message: &str) -> Envelope {
    Envelope::new(
        format!("{msg_id}-session-error"),
        now_ms,
        Message::Error {
            code: ErrorCode::Internal,
            message: message.to_string(),
        },
    )
    .with_correlation(msg_id.to_string())
}

/// Mint one ContextPassport for an existing Mission through the canonical Hub gate. The reply is
/// refs-only and fail-closed: invalid lane/kind/scope or sensitive unapproved items return
/// `status=blocked` and do not write a partial passport.
pub fn context_passport_transfer_result_for_db(
    db: &Db,
    msg_id: &str,
    request: ContextPassportTransferRequestWire,
    now_ms: i64,
) -> Envelope {
    context_passport_transfer_result_for_db_as_owner(db, msg_id, request, None, now_ms)
}

/// Owner-bound variant of [`context_passport_transfer_result_for_db`]. `authenticated_owner` is
/// the Rust-derived sealed-session principal, never a request body field.
pub fn context_passport_transfer_result_for_db_as_owner(
    db: &Db,
    msg_id: &str,
    request: ContextPassportTransferRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
) -> Envelope {
    let passport_id = request.passport_id.trim();
    if passport_id.is_empty() {
        return context_passport_transfer_blocked(msg_id, now_ms, &request, "passport_id_required");
    }
    let mission_id = request.mission_id.trim();
    if mission_id.is_empty() {
        return context_passport_transfer_blocked(msg_id, now_ms, &request, "mission_id_required");
    }
    if request.items.is_empty() {
        return context_passport_transfer_blocked(msg_id, now_ms, &request, "items_required");
    }

    let destination_lane = match parse_passport_lane(request.destination_lane.trim()) {
        Ok(lane) => lane,
        Err(blocker) => {
            return context_passport_transfer_blocked(msg_id, now_ms, &request, blocker)
        }
    };
    let mut items = Vec::with_capacity(request.items.len());
    for item in &request.items {
        let kind = match parse_passport_item_kind(item.kind.trim()) {
            Ok(kind) => kind,
            Err(blocker) => {
                return context_passport_transfer_blocked(msg_id, now_ms, &request, blocker)
            }
        };
        items.push(friday_core::PassportItem {
            kind,
            label: item.label.clone(),
            included: item.included,
            sensitive: item.sensitive,
        });
    }

    let mut mission = match db.get_mission(mission_id) {
        Ok(Some(mission)) => mission,
        Ok(None) => {
            return context_passport_transfer_blocked(msg_id, now_ms, &request, "mission_not_found")
        }
        Err(_) => {
            return context_passport_transfer_blocked(
                msg_id,
                now_ms,
                &request,
                "mission_read_failed",
            )
        }
    };
    let authenticated_owner = authenticated_owner.unwrap_or("").trim();
    let mission_owner = resolve_conversation_owner(db, &mission.friday_conversation_id);
    let owner_ok =
        !authenticated_owner.is_empty() && mission_owner.as_deref() == Some(authenticated_owner);
    if !owner_ok {
        return context_passport_transfer_blocked(
            msg_id,
            now_ms,
            &request,
            "mission_owner_mismatch",
        );
    }
    if let Some(work_item_id) = request
        .work_item_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        match db.get_work_item(work_item_id) {
            Ok(Some(work_item)) if work_item.mission_id == mission_id => {}
            Ok(Some(_)) => {
                return context_passport_transfer_blocked(
                    msg_id,
                    now_ms,
                    &request,
                    "work_item_scope_mismatch",
                )
            }
            Ok(None) => {
                return context_passport_transfer_blocked(
                    msg_id,
                    now_ms,
                    &request,
                    "work_item_not_found",
                )
            }
            Err(_) => {
                return context_passport_transfer_blocked(
                    msg_id,
                    now_ms,
                    &request,
                    "work_item_read_failed",
                )
            }
        }
    }

    let passport = match friday_core::build_context_passport(
        passport_id.to_string(),
        mission_id.to_string(),
        request
            .work_item_id
            .clone()
            .filter(|value| !value.trim().is_empty()),
        destination_lane,
        request
            .destination_target
            .clone()
            .filter(|value| !value.trim().is_empty()),
        items,
        request.approved_sensitive,
        now_ms,
    ) {
        Ok(passport) => passport,
        Err(_) => {
            return context_passport_transfer_blocked(
                msg_id,
                now_ms,
                &request,
                "context_passport_blocked",
            )
        }
    };

    let link_id = format!(
        "context-passport-{}-{}",
        passport_id
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
            .take(48)
            .collect::<String>(),
        now_ms
    );
    let tx = match db.conn().unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => {
            return context_passport_transfer_blocked(
                msg_id,
                now_ms,
                &request,
                "passport_write_failed",
            )
        }
    };
    if friday_storage::passport::upsert_context_passport_in(&tx, &passport).is_err() {
        return context_passport_transfer_blocked(
            msg_id,
            now_ms,
            &request,
            "passport_write_failed",
        );
    }
    if friday_storage::mission::upsert_mission_link(
        &tx,
        &friday_core::MissionLink {
            link_id: link_id.clone(),
            mission_id: mission_id.to_string(),
            work_item_id: request
                .work_item_id
                .clone()
                .filter(|value| !value.trim().is_empty()),
            link_kind: friday_core::MissionLinkKind::ContextPassport,
            target_ref: format!("friday://context-passport/{passport_id}"),
            proof_ref: Some(passport_id.to_string()),
            created_at_ms: now_ms,
        },
    )
    .is_err()
    {
        return context_passport_transfer_blocked(
            msg_id,
            now_ms,
            &request,
            "mission_link_write_failed",
        );
    }
    if !mission
        .context_passport_refs
        .iter()
        .any(|existing| existing == passport_id)
    {
        mission.context_passport_refs.push(passport_id.to_string());
    }
    mission.updated_at_ms = now_ms;
    if friday_storage::mission::upsert_mission(&tx, &mission).is_err() {
        return context_passport_transfer_blocked(msg_id, now_ms, &request, "mission_write_failed");
    }
    if tx.commit().is_err() {
        return context_passport_transfer_blocked(
            msg_id,
            now_ms,
            &request,
            "passport_write_failed",
        );
    }

    Envelope::new(
        format!("{msg_id}-context-passport-transfer"),
        now_ms,
        Message::ContextPassportTransferResult {
            result: ContextPassportTransferResultWire {
                passport_id: passport_id.to_string(),
                mission_id: mission_id.to_string(),
                work_item_id: request
                    .work_item_id
                    .clone()
                    .filter(|value| !value.trim().is_empty()),
                destination_lane: request.destination_lane,
                destination_target: request.destination_target,
                shared_item_count: passport.shared_items().len() as u64,
                mission_ref_count: mission.context_passport_refs.len() as u64,
                link_id: Some(link_id),
                status: "confirmed".to_string(),
                blocker: None,
            },
        },
    )
    .with_correlation(msg_id.to_string())
}

fn context_passport_transfer_blocked(
    msg_id: &str,
    now_ms: i64,
    request: &ContextPassportTransferRequestWire,
    blocker: &str,
) -> Envelope {
    Envelope::new(
        format!("{msg_id}-context-passport-transfer"),
        now_ms,
        Message::ContextPassportTransferResult {
            result: ContextPassportTransferResultWire {
                passport_id: request.passport_id.clone(),
                mission_id: request.mission_id.clone(),
                work_item_id: request
                    .work_item_id
                    .clone()
                    .filter(|value| !value.trim().is_empty()),
                destination_lane: request.destination_lane.clone(),
                destination_target: request.destination_target.clone(),
                shared_item_count: 0,
                mission_ref_count: 0,
                link_id: None,
                status: "blocked".to_string(),
                blocker: Some(blocker.to_string()),
            },
        },
    )
    .with_correlation(msg_id.to_string())
}

/// A blocked [`Message::MemoryDecisionResult`] — the candidate is UNCHANGED. Refs-only:
/// carries the id + the (unchanged) state + the coarse blocker reason; never content.
fn memory_decision_blocked(
    msg_id: &str,
    now_ms: i64,
    memory_id: &str,
    state: &str,
    blocker: &str,
) -> Envelope {
    Envelope::new(
        format!("{msg_id}-memory-decision"),
        now_ms,
        Message::MemoryDecisionResult {
            result: MemoryDecisionResultWire {
                memory_id: memory_id.to_string(),
                state: state.to_string(),
                status: "blocked".to_string(),
                blocker: Some(blocker.to_string()),
                recallable: false,
            },
        },
    )
    .with_correlation(msg_id.to_string())
}

/// Apply the OWNER's explicit confirm/reject decision to ONE pending A1 run-outcome
/// learning candidate. This is the product caller for the already-built
/// emit -> candidate leg: it is a pure Hub DB mutation, makes no provider/model
/// call, and returns only refs/coarse state.
///
/// Owner scope is derived from the candidate's bound session, not from a client
/// asserted owner field. The candidate stores `session_id` (or falls back to
/// `run_id` for run-scoped sessions); that session's `user_id` must match the
/// authenticated sealed-session owner before any decision is written.
pub fn run_outcome_learning_decision_result_for_db(
    db: &Db,
    msg_id: &str,
    request: RunOutcomeLearningDecisionRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
) -> Envelope {
    use friday_storage::learning_candidate;

    let decision = request.decision.trim().to_ascii_lowercase();
    let confirmed = match decision.as_str() {
        "confirm" => true,
        "reject" => false,
        _ => {
            return run_outcome_learning_decision_blocked(
                msg_id,
                now_ms,
                &request.candidate_id,
                None,
                None,
                "unknown",
                "invalid_decision",
            );
        }
    };

    let row = match learning_candidate::get_run_outcome_candidate(db.conn(), &request.candidate_id)
    {
        Ok(Some(row)) => row,
        Ok(None) => {
            return run_outcome_learning_decision_blocked(
                msg_id,
                now_ms,
                &request.candidate_id,
                None,
                None,
                "unknown",
                "unknown_candidate",
            );
        }
        Err(_) => {
            return run_outcome_learning_decision_blocked(
                msg_id,
                now_ms,
                &request.candidate_id,
                None,
                None,
                "unknown",
                "candidate_read_failed",
            );
        }
    };

    let authed = authenticated_owner.unwrap_or("").trim();
    if authed.is_empty() {
        return run_outcome_learning_decision_blocked(
            msg_id,
            now_ms,
            &row.candidate_id,
            Some(&row.run_id),
            Some(row.kind.as_str()),
            row.state.as_str(),
            "owner_principal_required",
        );
    }

    match run_outcome_candidate_owner_matches(db, &row, authed) {
        Ok(true) => {}
        Ok(false) => {
            return run_outcome_learning_decision_blocked(
                msg_id,
                now_ms,
                &row.candidate_id,
                Some(&row.run_id),
                Some(row.kind.as_str()),
                row.state.as_str(),
                "owner_scope_mismatch",
            );
        }
        Err(_) => {
            return run_outcome_learning_decision_blocked(
                msg_id,
                now_ms,
                &row.candidate_id,
                Some(&row.run_id),
                Some(row.kind.as_str()),
                row.state.as_str(),
                "owner_read_failed",
            );
        }
    }

    let new_state = match learning_candidate::decide_run_outcome_candidate(
        db.conn(),
        &row.candidate_id,
        confirmed,
        now_ms,
        request.reason.as_deref(),
    ) {
        Ok(state) => state,
        Err(_) => {
            return run_outcome_learning_decision_blocked(
                msg_id,
                now_ms,
                &row.candidate_id,
                Some(&row.run_id),
                Some(row.kind.as_str()),
                row.state.as_str(),
                "not_decidable",
            );
        }
    };

    let status = match new_state {
        learning_candidate::RunOutcomeLearningState::Confirmed => "confirmed",
        learning_candidate::RunOutcomeLearningState::Rejected => "rejected",
        learning_candidate::RunOutcomeLearningState::Pending => "blocked",
    };

    Envelope::new(
        format!("{msg_id}-run-outcome-learning-decision"),
        now_ms,
        Message::RunOutcomeLearningDecisionResult {
            result: RunOutcomeLearningDecisionResultWire {
                candidate_id: row.candidate_id,
                run_id: Some(row.run_id),
                kind: Some(row.kind.as_str().to_string()),
                state: new_state.as_str().to_string(),
                status: status.to_string(),
                blocker: None,
            },
        },
    )
    .with_correlation(msg_id.to_string())
}

fn run_outcome_candidate_owner_matches(
    db: &Db,
    row: &friday_storage::learning_candidate::RunOutcomeLearningCandidateRow,
    authenticated_owner: &str,
) -> friday_storage::Result<bool> {
    let mut keys = Vec::new();
    if let Some(session_id) = row.session_id.as_deref().filter(|s| !s.trim().is_empty()) {
        keys.push(session_id);
    }
    if !keys.iter().any(|key| *key == row.run_id) {
        keys.push(row.run_id.as_str());
    }

    for key in keys {
        if let Some(owner) = load_session_owner(db.conn(), key)? {
            if owner.user_id.as_deref().map(str::trim) == Some(authenticated_owner) {
                return Ok(true);
            }
        }
    }

    if let Some(result) = get_run_result(db.conn(), &row.run_id)? {
        if result.owner_principal.as_deref().map(str::trim) == Some(authenticated_owner) {
            return Ok(true);
        }
    }

    Ok(false)
}

fn run_outcome_learning_decision_blocked(
    msg_id: &str,
    now_ms: i64,
    candidate_id: &str,
    run_id: Option<&str>,
    kind: Option<&str>,
    state: &str,
    blocker: &str,
) -> Envelope {
    Envelope::new(
        format!("{msg_id}-run-outcome-learning-decision"),
        now_ms,
        Message::RunOutcomeLearningDecisionResult {
            result: RunOutcomeLearningDecisionResultWire {
                candidate_id: candidate_id.to_string(),
                run_id: run_id.map(str::to_string),
                kind: kind.map(str::to_string),
                state: state.to_string(),
                status: "blocked".to_string(),
                blocker: Some(blocker.to_string()),
            },
        },
    )
    .with_correlation(msg_id.to_string())
}

/// Mark one Activity / Needs-Me row done. This is a refs-only owner action over `activity_item`;
/// it never completes a WorkItem, writes proof receipts, or calls a provider/model.
pub fn activity_mark_done_result_for_db(
    db: &Db,
    msg_id: &str,
    request: ActivityMarkDoneRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
) -> Envelope {
    let activity_id = request.activity_id.trim();
    if activity_id.is_empty() {
        return activity_mark_done_blocked(msg_id, now_ms, "", "unknown", "activity_id_required");
    }

    // M6: the SCOPE source is the AUTHENTICATED owner (the Rust-derived principal threaded
    // from the WS dispatch arm), NEVER a raw body field. An empty/absent owner fails closed
    // with `owner_principal_required` (mirrors `memory_decision_result_for_db`). The WS path
    // always passes `Some(principal)`; the local FFI path passes `None` and goes through
    // `Db::mark_activity_done` directly (the legacy NULL-allow arm), never here.
    let owner = authenticated_owner.unwrap_or("").trim();
    if owner.is_empty() {
        return activity_mark_done_blocked(
            msg_id,
            now_ms,
            activity_id,
            "unknown",
            "owner_principal_required",
        );
    }

    // Owner-scoped clear: a cross-owner row (a different principal's item) and an unknown id
    // BOTH yield `Ok(false)` => both map to `unknown_activity` (no existence oracle — a
    // cross-owner probe is indistinguishable from a missing id, which is MORE leak-resistant
    // than the sibling get-row/check-owner idiom).
    match db.mark_activity_done(activity_id, Some(owner), now_ms) {
        Ok(true) => Envelope::new(
            format!("{msg_id}-activity-mark-done"),
            now_ms,
            Message::ActivityMarkDoneResult {
                result: ActivityMarkDoneResultWire {
                    activity_id: activity_id.to_string(),
                    state: "done".to_string(),
                    status: "done".to_string(),
                    blocker: None,
                },
            },
        )
        .with_correlation(msg_id.to_string()),
        Ok(false) => {
            activity_mark_done_blocked(msg_id, now_ms, activity_id, "unknown", "unknown_activity")
        }
        Err(_) => activity_mark_done_blocked(
            msg_id,
            now_ms,
            activity_id,
            "unknown",
            "activity_write_failed",
        ),
    }
}

fn activity_mark_done_blocked(
    msg_id: &str,
    now_ms: i64,
    activity_id: &str,
    state: &str,
    blocker: &str,
) -> Envelope {
    Envelope::new(
        format!("{msg_id}-activity-mark-done"),
        now_ms,
        Message::ActivityMarkDoneResult {
            result: ActivityMarkDoneResultWire {
                activity_id: activity_id.to_string(),
                state: state.to_string(),
                status: "blocked".to_string(),
                blocker: Some(blocker.to_string()),
            },
        },
    )
    .with_correlation(msg_id.to_string())
}

impl<T: Transport> HubServer<T> {
    fn ask(
        &mut self,
        msg_id: &str,
        prompt: &str,
        mission_context: Option<MissionWorkItemContextWire>,
        now_ms: i64,
    ) -> Envelope {
        self.next_ask += 1;
        let ledger_id = format!("ask-{msg_id}-{}", self.next_ask);
        let activity_id = format!("{ledger_id}:activity");
        let session_id = "friday-hub-session";
        if let Some(context) = mission_context {
            return self.mission_bound_ask(MissionAskDispatch {
                msg_id,
                prompt,
                context,
                ledger_id: &ledger_id,
                session_id,
                activity_id: &activity_id,
                now_ms,
            });
        }
        Self::error(
            msg_id,
            now_ms,
            ErrorCode::Internal,
            "ask_friday requires Mission context; detached asks are blocked",
        )
    }

    fn provider_workspace_action_result(
        &self,
        msg_id: &str,
        request: ProviderWorkspaceActionRequestWire,
        now_ms: i64,
    ) -> Envelope {
        // Delegate to the standalone `&Db` producer so the live serve-bin's flag-gated
        // `ProviderWorkspaceActionRequest` arm and this `HubServer::dispatch` arm share ONE
        // implementation. This in-process facade has no sealed-session principal, so derive
        // the owner from an already-resolved Mission to preserve the old test-only dispatch shape;
        // the live serve-bin passes the authenticated principal explicitly.
        let derived_owner = provider_workspace_mission_owner(&self.db, &request);
        provider_workspace_action_result_for_db_as_owner(
            &self.db,
            msg_id,
            request,
            derived_owner.as_deref(),
            now_ms,
        )
    }
}

/// Standalone `&Db` producer for one Provider Workspace action — the pre-dispatch GUARD +
/// (flag-gated) adapter dispatch, returning the correlated [`Message::ProviderWorkspaceActionResult`]
/// envelope. Extracted from [`HubServer::provider_workspace_action_result`] so the live
/// serve-bin (`hub_agent_run_server`) can route a sealed-session `ProviderWorkspaceActionRequest`
/// through the SAME path the `HubServer::dispatch` arm uses (no second implementation to drift).
///
/// The legacy no-owner entrypoint is fail-closed; use
/// [`provider_workspace_action_result_for_db_as_owner`] from live sealed-session dispatch.
pub fn provider_workspace_action_result_for_db(
    db: &Db,
    msg_id: &str,
    request: ProviderWorkspaceActionRequestWire,
    now_ms: i64,
) -> Envelope {
    provider_workspace_action_result_for_db_as_owner(db, msg_id, request, None, now_ms)
}

/// Owner-bound Provider Workspace action pre-dispatch guard. `authenticated_owner` is the
/// Rust-derived sealed-session principal, never a request body field.
pub fn provider_workspace_action_result_for_db_as_owner(
    db: &Db,
    msg_id: &str,
    request: ProviderWorkspaceActionRequestWire,
    authenticated_owner: Option<&str>,
    now_ms: i64,
) -> Envelope {
    let result = if request.mission_context.is_none() {
        provider_workspace_rejected_result(
            request,
            "mission_context_required",
            "provider workspace action requires Mission context".to_string(),
        )
    } else if provider_workspace_owner_mismatch(db, &request, authenticated_owner) {
        provider_workspace_rejected_result(
            request,
            "mission_owner_mismatch",
            "provider workspace action blocked: target Mission is not owned by the authenticated owner"
                .to_string(),
        )
    } else {
        match db.get_provider_session_link(&request.friday_session_id) {
            Ok(Some(link)) => match provider_workspace_session_from_link(&link) {
                Some(session) => {
                    // Flag-gated adapter selection at REQUEST time (the real adapter holds
                    // no client — it spawns a `codex app-server` per action and is
                    // stateless config, so a missing Codex CLI surfaces as a per-action
                    // typed blocker, never a hub-boot crash). Flag-OFF (the default) keeps
                    // the `NoProviderWorkspaceDispatchAdapter` — BYTE-IDENTICAL to today.
                    // Production reachability ALSO requires the action's capability to be
                    // `Verified` (none in `friday_current()` are), so the guard refuses
                    // every real request before the adapter is consulted regardless.
                    let no_adapter = NoProviderWorkspaceDispatchAdapter;
                    let live_adapter = ProviderWorkspaceDispatchAdapter::with_prompt_resolver(
                        LocalCodexWorkspaceClient::new(
                            "codex",
                            "friday-hub",
                            env!("CARGO_PKG_VERSION"),
                        ),
                        DbPromptBodyResolver::new(db),
                    );
                    let adapter: &dyn ProviderDispatchAdapter =
                        if provider_workspace_dispatch_enabled() {
                            &live_adapter
                        } else {
                            &no_adapter
                        };
                    dispatch_provider_action(
                        &ProviderWorkspaceCatalog::friday_current(),
                        adapter,
                        &session,
                        db,
                        request,
                    )
                }
                None => provider_workspace_rejected_result(
                    request,
                    "unknown_provider",
                    "provider session has unknown provider".to_string(),
                ),
            },
            Ok(None) => provider_workspace_rejected_result(
                request,
                "missing_session",
                "provider workspace session not found".to_string(),
            ),
            Err(_) => provider_workspace_rejected_result(
                request,
                "session_read_failed",
                "provider workspace session read failed".to_string(),
            ),
        }
    };
    Envelope::new(
        format!("{msg_id}-provider-workspace-action"),
        now_ms,
        Message::ProviderWorkspaceActionResult { result },
    )
}

fn provider_workspace_mission_owner(
    db: &Db,
    request: &ProviderWorkspaceActionRequestWire,
) -> Option<String> {
    let context = request.mission_context.as_ref()?;
    let mission = db.get_mission(&context.mission_id).ok().flatten()?;
    resolve_conversation_owner(db, &mission.friday_conversation_id)
}

fn provider_workspace_owner_mismatch(
    db: &Db,
    request: &ProviderWorkspaceActionRequestWire,
    authenticated_owner: Option<&str>,
) -> bool {
    let Some(context) = request.mission_context.as_ref() else {
        return false;
    };
    let Ok(Some(mission)) = db.get_mission(&context.mission_id) else {
        return false;
    };
    let authenticated_owner = authenticated_owner.unwrap_or("").trim();
    let mission_owner = resolve_conversation_owner(db, &mission.friday_conversation_id);
    authenticated_owner.is_empty() || mission_owner.as_deref() != Some(authenticated_owner)
}

fn provider_workspace_rejected_result(
    request: ProviderWorkspaceActionRequestWire,
    status: &str,
    blocker: String,
) -> ProviderWorkspaceActionResultWire {
    ProviderWorkspaceActionResultWire {
        request_id: request.request_id,
        friday_session_id: request.friday_session_id,
        provider: request.provider,
        action: request.action,
        capability_id: request.capability_id,
        accepted: false,
        routed: false,
        status: status.to_string(),
        truth_label: "provider_workspace_action_refused_before_dispatch".to_string(),
        blocker: Some(blocker),
        proof_ref: None,
        dispatch_ref: None,
        mission_context: request.mission_context,
    }
}

impl<T: Transport> HubServer<T> {
    fn mission_bound_ask(&mut self, dispatch: MissionAskDispatch<'_>) -> Envelope {
        match ask_friday_for_mission(
            &mut self.db,
            &self.deepseek,
            MissionContextLookup::by_work_item(
                dispatch.context.friday_conversation_id,
                dispatch.context.mission_id,
                dispatch.context.work_item_id,
            ),
            dispatch.ledger_id,
            dispatch.session_id,
            dispatch.activity_id,
            dispatch.prompt,
            self.max_tokens,
            dispatch.now_ms,
        ) {
            Ok(MissionBoundAskOutcome::Answered {
                ledger_id,
                result_link,
                ..
            }) => Envelope::new(
                format!("{}-result", dispatch.msg_id),
                dispatch.now_ms,
                Message::AskFridayResult {
                    ledger_id,
                    result_link: Some(result_link),
                },
            ),
            Ok(MissionBoundAskOutcome::Blocked { blockers }) => Self::error(
                dispatch.msg_id,
                dispatch.now_ms,
                ErrorCode::Internal,
                &format!("ask mission context blocked: {}", blockers.join(",")),
            ),
            Err(RecordAskError::Route(_)) => Self::error(
                dispatch.msg_id,
                dispatch.now_ms,
                ErrorCode::ProviderUnavailable,
                "ask route unavailable (Hub-owned DeepSeek; no fallback)",
            ),
            Err(RecordAskError::Storage(_)) => Self::error(
                dispatch.msg_id,
                dispatch.now_ms,
                ErrorCode::Internal,
                "ask mission attachment/ledger write failed",
            ),
        }
    }

    fn mission_projection_snapshot(
        &self,
        msg_id: &str,
        friday_conversation_id: &str,
        now_ms: i64,
    ) -> Envelope {
        if let Err(err) = friday_core::validate_friday_conversation_id(friday_conversation_id) {
            return Self::error(msg_id, now_ms, ErrorCode::Internal, &err.to_string());
        }
        match self
            .db
            .list_mission_surface_projections(friday_conversation_id)
        {
            Ok(projections) => {
                let mission_ids: BTreeSet<_> = projections
                    .iter()
                    .map(|projection| projection.mission_id.clone())
                    .collect();
                let mut route_decisions = Vec::new();
                for mission_id in mission_ids {
                    let Ok(mission_route_decisions) = self
                        .db
                        .list_route_decision_projections_for_mission(&mission_id)
                    else {
                        return Self::error(
                            msg_id,
                            now_ms,
                            ErrorCode::Internal,
                            "mission route decision projection read failed",
                        );
                    };
                    route_decisions.extend(
                        mission_route_decisions
                            .into_iter()
                            .map(RouteDecisionProjectionWire::from),
                    );
                }
                Envelope::new(
                    format!("{msg_id}-mission-projection"),
                    now_ms,
                    Message::MissionProjectionSnapshot {
                        snapshot: MissionProjectionSnapshotWire {
                            friday_conversation_id: friday_conversation_id.to_string(),
                            generated_at_ms: now_ms,
                            projections: projections.into_iter().map(Into::into).collect(),
                            route_decisions,
                        },
                    },
                )
            }
            Err(_) => Self::error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                "mission projection read failed",
            ),
        }
    }

    fn mission_timeline_snapshot(
        &self,
        msg_id: &str,
        request: MissionTimelineRequestWire,
        now_ms: i64,
    ) -> Envelope {
        let friday_conversation_id = request.friday_conversation_id.clone();
        let mission_id = request.mission_id.clone();
        if let Err(err) = friday_core::validate_friday_conversation_id(&friday_conversation_id) {
            return Self::error(msg_id, now_ms, ErrorCode::Internal, &err.to_string());
        }
        if mission_id.trim().is_empty() {
            return Self::error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                "mission timeline mission_id required",
            );
        }
        let timeline_window = match parse_timeline_window(request.cursor.clone(), request.limit) {
            Ok(window) => window,
            Err(err) => return Self::error(msg_id, now_ms, ErrorCode::Internal, &err),
        };

        let mission = match self.db.get_mission(&mission_id) {
            Ok(Some(mission)) => mission,
            Ok(None) => {
                return Self::error(
                    msg_id,
                    now_ms,
                    ErrorCode::Internal,
                    "mission timeline unknown mission",
                )
            }
            Err(_) => {
                return Self::error(
                    msg_id,
                    now_ms,
                    ErrorCode::Internal,
                    "mission timeline mission read failed",
                )
            }
        };
        if mission.friday_conversation_id != friday_conversation_id {
            return Self::error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                "mission timeline conversation mismatch",
            );
        }

        let projections = match self
            .db
            .list_mission_surface_projections(&friday_conversation_id)
        {
            Ok(projections) => projections
                .into_iter()
                .filter(|projection| projection.mission_id == mission_id)
                .map(Into::into)
                .collect(),
            Err(_) => {
                return Self::error(
                    msg_id,
                    now_ms,
                    ErrorCode::Internal,
                    "mission timeline projection read failed",
                )
            }
        };
        let work_items = match self.db.list_work_items_for_mission(&mission_id) {
            Ok(items) => items.into_iter().map(work_item_timeline_wire).collect(),
            Err(_) => {
                return Self::error(
                    msg_id,
                    now_ms,
                    ErrorCode::Internal,
                    "mission timeline work item read failed",
                )
            }
        };
        let raw_links = match self.db.list_mission_links(&mission_id) {
            Ok(links) => links,
            Err(_) => {
                return Self::error(
                    msg_id,
                    now_ms,
                    ErrorCode::Internal,
                    "mission timeline link read failed",
                )
            }
        };
        let raw_route_decisions = match self
            .db
            .list_route_decision_projections_for_mission(&mission_id)
        {
            Ok(route_decisions) => route_decisions,
            Err(_) => {
                return Self::error(
                    msg_id,
                    now_ms,
                    ErrorCode::Internal,
                    "mission timeline route decision read failed",
                )
            }
        };
        let raw_surface_events = match self.db.list_surface_events_for_mission(&mission_id) {
            Ok(events) => events,
            Err(_) => {
                return Self::error(
                    msg_id,
                    now_ms,
                    ErrorCode::Internal,
                    "mission timeline surface event read failed",
                )
            }
        };
        let timeline = apply_timeline_window(
            raw_links,
            raw_route_decisions,
            raw_surface_events,
            timeline_window,
        );

        Envelope::new(
            format!("{msg_id}-mission-timeline"),
            now_ms,
            Message::MissionTimelineSnapshot {
                snapshot: MissionTimelineSnapshotWire {
                    friday_conversation_id: friday_conversation_id.to_string(),
                    mission_id: mission_id.to_string(),
                    generated_at_ms: now_ms,
                    mission: MissionTimelineMissionWire {
                        mission_id: mission.mission_id,
                        friday_conversation_id: mission.friday_conversation_id,
                        title: mission.title,
                        intent: mission.intent,
                        status: mission.status.as_str().to_string(),
                        why_now: mission.why_now,
                        decision_path_summary: mission.decision_path_summary,
                        proof_refs: mission.proof_refs,
                        updated_at_ms: mission.updated_at_ms,
                    },
                    projections,
                    work_items,
                    requested_cursor: timeline.requested_cursor,
                    next_cursor: timeline.next_cursor,
                    retained_from: timeline.retained_from,
                    bounded: timeline.bounded,
                    has_more: timeline.has_more,
                    links: timeline.links,
                    route_decisions: timeline.route_decisions,
                    surface_events: timeline.surface_events,
                },
            },
        )
    }

    fn mission_lifecycle_result(
        &self,
        msg_id: &str,
        request: MissionLifecycleRequestWire,
        now_ms: i64,
    ) -> Envelope {
        // The lifecycle body is a pure `&Db` mutation (no `deepseek`/`next_ask`), so it is
        // extracted to the free `mission_lifecycle_result_for_db` — letting the LIVE agent-run
        // server bin (which holds a `HubRuntime`, not a `HubServer`) REUSE the exact same Hub
        // state-machine transition through its flag-gated dispatch arm WITHOUT reimplementing it.
        //
        // (FIX-Q3b) This LEGACY `HubServer::dispatch` path has NO production binary caller and
        // carries no session-derived principal, so it supplies the target Mission's OWN owner
        // (resolved from the Hub, the source of truth) as the authenticated owner — keeping this
        // path BYTE-IDENTICAL (the owner check is a tautology here). The LIVE mission-spine path is
        // the bin's flag-gated arm, which threads `runtime.policy().principal_id()` (== the
        // configured `--owner`) as the real authenticated owner. An unknown Mission resolves to
        // `None` here, which still flows through to the existing not-found Error.
        let legacy_owner = self
            .db
            .get_mission(&request.mission_id)
            .ok()
            .flatten()
            .and_then(|m| resolve_conversation_owner(&self.db, &m.friday_conversation_id));
        mission_lifecycle_result_for_db(&self.db, msg_id, request, legacy_owner.as_deref(), now_ms)
    }

    fn error(msg_id: &str, now_ms: i64, code: ErrorCode, message: &str) -> Envelope {
        Envelope::new(
            format!("{msg_id}-error"),
            now_ms,
            Message::Error {
                code,
                message: message.to_string(),
            },
        )
        .with_correlation(msg_id.to_string())
    }

    /// Serve a STREAM of sealed messages over ONE established session until the client
    /// disconnects (or sends an envelope that fails to open — fail-closed, no dispatch).
    /// `clock` supplies `now_ms` per message. Returns when the connection ends.
    pub fn serve_connection<S: Read + Write>(
        &mut self,
        ws: &mut WireWebSocket<S>,
        session_key: &friday_crypto::DataKey,
        aad: &[u8],
        clock: &mut dyn FnMut() -> i64,
    ) -> Result<(), TransportError> {
        loop {
            let env = match ws_recv_envelope(ws, session_key, aad) {
                Ok(e) => e,
                // EOF / disconnect / unauthenticated-or-tampered seal → end the session.
                Err(_) => return Ok(()),
            };
            let response = self.dispatch(env, clock());
            ws_send_envelope(ws, session_key, &response, aad)?;
        }
    }
}

// ===========================================================================
// D1-Q4 — internal AUTHENTICATED single-provider agent-loop route.
// ===========================================================================
//
// Truth label: this is an INTERNAL, authenticated, SINGLE-provider (`deepseek-flash`) route.
// It is NOT multi-provider, NOT provider-native, and NOT a v1 GO; `executeRun` is NOT
// replaced. The answer BODY is delivered ONLY to the AUTHENTICATED OWNER of the run; every
// proof/unauth surface gets refs-only (status + the answer's sha256 + length), never the
// body, never a raw provider/secret/channel id.
//
// Authentication reuses the EXISTING sealed-session mechanism (`DeviceKeypair` ECDH →
// per-session `DataKey`, the same one [`HubServer::serve_connection`] is fenced by): a caller
// proves possession of the shared session key by sealing the agreed challenge, which the Hub
// OPENS with its half of the session. A caller without the paired key produces a seal the Hub
// cannot open → no [`AuthedPrincipal`] → no run, no body (fail-closed).

/// An AUTHENTICATED caller principal, derived from a verified sealed session (D1-Q4).
///
/// Constructible ONLY by [`AuthedPrincipal::authenticate`]. The bound principal is the
/// HUB-OWNER principal supplied by Hub config — NEVER a client-supplied string — so a caller
/// can never self-assert another principal to read someone else's answer. There is no public
/// constructor and no way to mint one without opening a caller-sealed proof.
pub struct AuthedPrincipal(String);

/// The per-request inputs to [`AuthedPrincipal::authenticate_forwarded`], bundled so the
/// verifier signature stays small. **Trust is NOT uniform across these fields — read carefully:**
/// `auth_proof` / `run_id` / `forwarded_principal` are PEER-conveyed on the wire (attacker-
/// controlled; the verifier trusts none of them until the possession-of-session + nonce-bound-
/// challenge + allowlist chain passes). `session_nonce` is the EXCEPTION: it is **SERVER-
/// generated per handshake and MUST NEVER be read from the wire / a request field** — it is the
/// anti-replay binding, and if it were attacker-suppliable (or empty) the binding would collapse
/// back to the bare fixed challenge (the exact replay hole S-E closes). The verifier
/// SELF-ENFORCES this (rejects a wrong-width `session_nonce`), but a caller MUST still pass the
/// server's fresh nonce, never a peer value. Borrowed (no allocation).
pub struct ForwardedAuth<'a> {
    /// The peer's sealed possession-of-session proof (decoded from the wire `auth_proof`). Must
    /// open under the session key to `expected_challenge || session_nonce` with the per-request
    /// AAD — a stale/lifted proof fails.
    pub auth_proof: &'a Sealed,
    /// THIS handshake's fresh per-handshake nonce — the anti-replay binding. **SERVER-generated,
    /// never wire-read.** A captured proof sealed a DIFFERENT nonce will not verify here; a
    /// missing/short nonce is REJECTED by the verifier (it must be `SESSION_NONCE_LEN` wide).
    pub session_nonce: &'a [u8],
    /// The OPAQUE per-request context the proof is bound to (length-delimited into the AAD) — a
    /// proof can't be lifted to a different request. **S-R0 generalization:** this was `run_id:
    /// &str` (write path). It is now an opaque `&[u8]` so a READ request (which has no run) can
    /// bind the proof to its own per-request id (e.g. the request's `request_id`) instead. The
    /// WRITE path passes `run_id.as_bytes()`, which produces the IDENTICAL AAD bytes the prior
    /// `run_id: &str` field did — the write-path AAD is byte-unchanged (see the frozen-AAD KAT).
    pub bound_context: &'a [u8],
    /// The trusted-peer-forwarded principal (allowlist-checked; also length-delimited into the
    /// AAD — a proof can't be lifted to a different principal).
    pub forwarded_principal: &'a str,
}

/// Required width of [`ForwardedAuth::session_nonce`] — the server's `generate_approval_nonce`
/// emits 32 CSPRNG bytes as 64 lowercase-hex ASCII bytes. MUST match the bin's `SESSION_NONCE_LEN`
/// (`hub_agent_run_server.rs`). The verifier rejects any other width so the anti-replay nonce
/// binding cannot collapse to the bare fixed challenge.
const SESSION_NONCE_LEN: usize = 64;

impl AuthedPrincipal {
    /// Authenticate a caller over the established sealed session and bind the Hub's OWNER
    /// principal to it.
    ///
    /// Authentication == the Hub can OPEN the caller's `sealed_proof` under the shared session
    /// `DataKey` (proving the caller holds the paired session key — the SAME seal/open the WS
    /// transport uses) AND the opened bytes equal the agreed `expected_challenge` (binding the
    /// proof to THIS exchange). A different `DeviceKeypair` yields a seal that does not open →
    /// `None`. The `owner_principal` is Hub-supplied (single-owner v1); an empty/blank one is
    /// rejected (no anonymous owner). Returns `None` on ANY failure — fail-closed.
    pub fn authenticate(
        hub_session: &DataKey,
        sealed_proof: &Sealed,
        aad: &[u8],
        expected_challenge: &[u8],
        owner_principal: &str,
    ) -> Option<AuthedPrincipal> {
        // Possession of the shared session key is the authentication; opening fails closed for
        // any caller that did not seal under it.
        let opened = open(hub_session, sealed_proof, aad).ok()?;
        if opened.as_slice() != expected_challenge {
            return None;
        }
        let principal = owner_principal.trim();
        if principal.is_empty() {
            return None;
        }
        Some(AuthedPrincipal(principal.to_string()))
    }

    /// WS substrate **S-C** — authenticate a TRUSTED-PEER-FORWARDED principal over the
    /// established sealed session and bind it (fail-closed).
    ///
    /// This is the SIBLING of [`AuthedPrincipal::authenticate`] for the agent-run WS dispatch
    /// arm. Where `authenticate` binds the Hub's OWN configured owner (the caller is just
    /// proving session possession), this binds the principal the trusted in-TCB peer
    /// FORWARDED on the request — but ONLY after every one of the following holds, in order:
    ///
    /// 1. `auth_proof` OPENS under the established `session_key` and equals
    ///    `expected_challenge` — i.e. the peer holds the paired ECDH half (the SAME seal/open
    ///    the WS transport is fenced by). A peer that completed the handshake but cannot seal
    ///    the agreed challenge under the session key fails here. **A session key is NOT
    ///    authorization on its own** — this is only step 1.
    /// 2. `forwarded_principal` is non-empty / non-whitespace.
    /// 3. `forwarded_principal` is NOT anonymous / public under the SAME sentinel set the
    ///    body-ownership gate uses ([`friday_core::gate::is_anonymous_principal`], via
    ///    `is_forwarded_principal_anonymous` — `""`, `"public"`, `"public:default"` all fail).
    /// 4. `forwarded_principal` is IN the Hub `owner_allowlist` (v1 = a single configured
    ///    owner, passed in). A principal not on the allowlist — even a well-formed one
    ///    forwarded by a peer holding the session key — is REJECTED.
    ///
    /// **Trust basis (HONEST — the peer is NOT yet authenticated).** The bound principal is
    /// INTENDED to be TRUSTED-PEER-FORWARDED: in production the in-TCB TS API resolves it from a
    /// validated bearer token and forwards it over the sealed session. BUT this slice does NOT
    /// authenticate the PEER: the session is established by an UNAUTHENTICATED dev ECDH handshake
    /// (cleartext peer pubkey, a stable server key), so on loopback ANY local process can complete
    /// a FRESH handshake and produce an openable `auth_proof` under the CURRENT nonce — there is
    /// NO pairing / SecureStore check here. So `open()` proves only "the caller completed THIS
    /// handshake", NOT "the caller is the one authorized peer". What stops an ARBITRARY principal
    /// TODAY is solely the `owner_allowlist` ceiling (an attacker would still have to forward an
    /// allowlisted owner string). This is acceptable ONLY because the slice is DARK + loopback-
    /// only + has NO production caller. **HARD FORWARD-GATE before S-F wires any production caller
    /// (and before any slice-6 spend) — do NOT skip:** (S-F) add real PEER authentication
    /// (SecureStore pubkey allowlist / pairing) before trusting a forwarded principal — a fresh
    /// local process completing the current handshake and forging a proof for an allowlisted owner
    /// string is STILL possible (the peer-auth gap). `rust_wired` at best, DARK, NOT a v1 GO.
    ///
    /// **S-E anti-replay (this slice).** The challenge bound here is NOT a fixed constant: the
    /// caller seals `expected_challenge || session_nonce`, where `session_nonce` is a FRESH
    /// per-handshake CSPRNG nonce the SERVER generated and sent in cleartext. The auth AAD also
    /// length-delimits `forwarded_principal` and `run_id` into [`auth_aad`]. Consequences:
    /// * a `auth_proof` CAPTURED from a PRIOR handshake (nonce `N1`) does NOT open/verify on a new
    ///   handshake (nonce `N2 != N1`) — REPLAY-TO-AUTHENTICATE is defeated. The attacker can
    ///   replay the public peer-pubkey preamble, but cannot RE-SEAL `challenge||N2` without the
    ///   paired ECDH private half; and
    /// * a proof sealed for one `(principal, run_id)` cannot be LIFTED to a different one (the AAD
    ///   binds both, length-delimited, so cross-pair substitution fails to open).
    ///
    /// (Replay-to-RE-RUN is separately blocked by the `run_id` PRIMARY KEY; this closes the AUTH
    /// replay only. PEER-auth remains S-F's job — see above.)
    ///
    /// The request-derived inputs (`auth_proof`, `session_nonce`, `run_id`, `forwarded_principal`)
    /// are bundled in [`ForwardedAuth`] so the verifier signature stays small; the SESSION inputs
    /// (`session_key`, `aad`, `expected_challenge`) and the Hub-supplied `owner_allowlist` stay
    /// explicit.
    ///
    /// Returns `None` on ANY failure — fail-closed, never partial.
    pub fn authenticate_forwarded(
        session_key: &DataKey,
        aad: &[u8],
        expected_challenge: &[u8],
        req: ForwardedAuth<'_>,
        owner_allowlist: &[String],
    ) -> Option<AuthedPrincipal> {
        let ForwardedAuth {
            auth_proof,
            session_nonce,
            bound_context,
            forwarded_principal,
        } = req;
        // (0) SELF-ENFORCE the anti-replay invariant AT this verification boundary (the one that
        // OWNS the property). The server ALWAYS supplies a fresh full-width CSPRNG nonce
        // (`SESSION_NONCE_LEN`); a missing/short/wrong-width `session_nonce` would let
        // `nonce_bound_challenge` collapse back toward the bare fixed challenge — the exact replay
        // hole S-E closes. Reject it here so the property cannot silently regress if a future
        // caller mis-wires `session_nonce` (no upstream test would catch that).
        if session_nonce.len() != SESSION_NONCE_LEN {
            return None;
        }
        // (1) Possession-of-session proof BOUND to THIS handshake. The peer must seal the agreed
        // challenge CONCATENATED with this connection's fresh `session_nonce`, under the
        // ESTABLISHED session key, with the per-request auth AAD (principal+run_id, length-
        // delimited). A correct-handshake peer that cannot open this — any peer on a different
        // key, OR a captured proof from a PRIOR handshake (different nonce), OR a proof lifted
        // from a different (principal, run_id) — fails closed here. A session key alone is NOT
        // enough, and a stale `auth_proof` is NOT replayable.
        let req_aad = auth_aad(aad, forwarded_principal, bound_context);
        let opened = open(session_key, auth_proof, &req_aad).ok()?;
        let expected = nonce_bound_challenge(expected_challenge, session_nonce);
        if opened != expected {
            return None;
        }
        // (2) Non-empty / non-whitespace forwarded principal.
        let principal = forwarded_principal.trim();
        if principal.is_empty() {
            return None;
        }
        // (3) Non-anonymous under the EXACT sentinel set the body-ownership gate uses, so a
        // forwarded "public"/"public:default" can never be bound (it would never own a body).
        if is_forwarded_principal_anonymous(principal) {
            return None;
        }
        // (4) Owner-allowlist ceiling: the forwarded principal must be a configured Hub owner.
        // A well-formed, non-anonymous, session-key-backed principal that is NOT on the
        // allowlist is REJECTED — the handshake authenticated the CHANNEL, not the principal.
        if !owner_allowlist.iter().any(|owner| owner == principal) {
            return None;
        }
        // Bind the FORWARDED principal (trusted-peer-forwarded, allowlisted) — never a raw
        // client-asserted string that skipped the above chain.
        Some(AuthedPrincipal(principal.to_string()))
    }

    /// The bound, Hub-trusted principal (never client-supplied).
    pub fn principal(&self) -> &str {
        &self.0
    }
}

/// S-E anti-replay — the per-handshake challenge the trusted peer must seal: the fixed agreed
/// `challenge` CONCATENATED with this connection's fresh CSPRNG `session_nonce`. Both inputs are
/// fixed-length on the wire (the challenge is a static constant; the nonce is a fixed-width
/// CSPRNG token), so a plain concat is unambiguous. A captured proof from a PRIOR handshake
/// sealed `challenge || N1`; on a new handshake the server expects `challenge || N2` (N2 != N1),
/// so the stale proof's opened bytes never match — REPLAY-TO-AUTHENTICATE is defeated.
///
/// `pub` so the trusted peer (the production caller wired by S-F, and the bin's loopback test
/// client) constructs the IDENTICAL bytes it must seal — the verifier and the prover share ONE
/// encoding. Carries no key material; the security is in the session key that seals it.
pub fn nonce_bound_challenge(challenge: &[u8], session_nonce: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(challenge.len() + session_nonce.len());
    out.extend_from_slice(challenge);
    out.extend_from_slice(session_nonce);
    out
}

/// S-E anti-replay — the per-REQUEST auth AAD: the session `aad` plus the `forwarded_principal`
/// and the opaque `bound_context`, each LENGTH-DELIMITED (a 4-byte big-endian length prefix per
/// field) so the encoding is unambiguous — `("ab","c")` and `("a","bc")` produce DISTINCT AADs.
/// Binding both into the AAD means an `auth_proof` sealed for one `(principal, bound_context)`
/// cannot be LIFTED to a different one: substituting either field changes the AAD, so `open` fails
/// (the AEAD tag no longer authenticates). The AAD is NOT secret (it is reconstructed by the
/// verifier from the cleartext request fields); its job is binding, not confidentiality.
///
/// **S-R0 generalization (byte-identical for writes).** The third argument was `run_id: &str`. It
/// is now an opaque `bound_context: &[u8]` so a READ request — which has no run — can bind its
/// own per-request id instead. The WRITE path passes `run_id.as_bytes()`; since the prior code
/// took exactly those bytes (`run_id.as_bytes()`) internally, the emitted AAD is BYTE-IDENTICAL
/// for the write path (a length prefix over the same bytes), so no write proof's verification
/// changes. The frozen-AAD KAT (`auth_aad_write_path_is_byte_unchanged`) pins this.
///
/// `pub` for the same reason as [`nonce_bound_challenge`]: the prover and the verifier must
/// derive the SAME AAD bytes from the same `(aad, principal, bound_context)` triple.
pub fn auth_aad(aad: &[u8], forwarded_principal: &str, bound_context: &[u8]) -> Vec<u8> {
    let principal = forwarded_principal.as_bytes();
    let mut out = Vec::with_capacity(aad.len() + 8 + principal.len() + bound_context.len());
    out.extend_from_slice(aad);
    out.extend_from_slice(&(principal.len() as u32).to_be_bytes());
    out.extend_from_slice(principal);
    out.extend_from_slice(&(bound_context.len() as u32).to_be_bytes());
    out.extend_from_slice(bound_context);
    out
}

/// True if a forwarded principal is anonymous / public / empty under the SAME sentinel set
/// the body-ownership gate ([`friday_storage::get_run_answer_for_principal`]) enforces — so a
/// forwarded `""`, `"public"`, or `"public:default"` is rejected by
/// [`AuthedPrincipal::authenticate_forwarded`] before it can ever be bound. Mirrors
/// `friday_storage::run_result`'s private `is_anonymous_principal_str`: the actor `kind`/`id`
/// are irrelevant (the gate inspects only `principal_id`); a placeholder is passed.
fn is_forwarded_principal_anonymous(principal: &str) -> bool {
    friday_core::gate::is_anonymous_principal(&friday_core::gate::Actor {
        kind: friday_core::gate::ActorKind::Owner,
        id: String::new(),
        principal_id: Some(principal.to_string()),
    })
}

/// The body-release outcome of the authenticated answer projection (D1-Q4).
///
/// The answer BODY is carried ONLY in [`AuthedAnswer::Delivered`] — for in-process hand-off
/// to the authenticated owner. Every other variant is body-free. A MANUAL [`std::fmt::Debug`]
/// (below) redacts the body, so an accidental `{:?}` can never leak it; the body is NEVER
/// placed on a refs-only/proof surface (use [`AuthedAnswer::proof_refs_json`]).
pub enum AuthedAnswer {
    /// The authenticated caller IS the run's owner: the answer body is released to them,
    /// alongside its refs-only fingerprint (sha256 + length) for proof.
    Delivered {
        run_id: String,
        status: String,
        answer: String,
        answer_sha256: String,
        answer_len: i64,
        /// (A1 transport-truth) REFS-surface run METADATA carried from the
        /// [`crate::LoopOutcome`]: the model-turn count. A COUNT only — never a turn
        /// body. `None` until a caller attaches it via [`AuthedAnswer::with_counts`]
        /// (e.g. [`run_authed_agent_loop`], which now has the outcome in hand). The
        /// body-projection path that mints this variant leaves it `None` (it reads DB
        /// state and has no outcome) — the loop entry attaches the real counts after.
        turns: Option<u64>,
        /// (A1) REFS-surface run METADATA: the executed-tool COUNT. Never a tool name
        /// / args. Same `with_counts`-attached / `None`-by-default discipline as `turns`.
        executed_tools: Option<u64>,
    },
    /// A stored answer exists but the authenticated caller is NOT its owner (or the run has no
    /// owner): the body is WITHHELD. Carries only the coarse deny reason + the refs-only
    /// fingerprint (never the body, never the owner principal).
    Denied {
        run_id: String,
        reason: AnswerDenyReason,
        refs: Option<RunResultRef>,
    },
    /// No stored answer for this run (provider unavailable / run not Finished): safe failure,
    /// no body, no panic.
    NoAnswer { run_id: String },
}

impl std::fmt::Debug for AuthedAnswer {
    /// Body-redacting Debug: a `Delivered` renders only its fingerprint (sha256 + length),
    /// NEVER the answer body. This is the structural guard behind the "never log the Granted
    /// body" rule — even a stray `{:?}` on this type cannot leak the answer.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthedAnswer::Delivered {
                run_id,
                status,
                answer_sha256,
                answer_len,
                turns,
                executed_tools,
                ..
            } => f
                .debug_struct("AuthedAnswer::Delivered")
                .field("run_id", run_id)
                .field("status", status)
                .field("answer_sha256", answer_sha256)
                .field("answer_len", answer_len)
                .field("turns", turns)
                .field("executed_tools", executed_tools)
                .field("answer", &"<redacted: owner-only body>")
                .finish(),
            AuthedAnswer::Denied {
                run_id,
                reason,
                refs,
            } => f
                .debug_struct("AuthedAnswer::Denied")
                .field("run_id", run_id)
                .field("reason", reason)
                .field("refs", refs)
                .finish(),
            AuthedAnswer::NoAnswer { run_id } => f
                .debug_struct("AuthedAnswer::NoAnswer")
                .field("run_id", run_id)
                .finish(),
        }
    }
}

impl AuthedAnswer {
    /// The answer body for the AUTHENTICATED OWNER (in-process hand-off ONLY). `None` for
    /// every non-delivered variant. NEVER call this for a proof/log/wire surface.
    pub fn delivered_body(&self) -> Option<&str> {
        match self {
            AuthedAnswer::Delivered { answer, .. } => Some(answer),
            _ => None,
        }
    }

    /// (A1 transport-truth) Attach the REFS-surface run COUNTS from the
    /// [`crate::LoopOutcome`] to a `Delivered` answer. A NO-OP on `Denied` / `NoAnswer`
    /// (a non-delivered outcome carries no counts) — so the loop entry can attach
    /// unconditionally without re-matching. Counts are metadata only; this NEVER touches
    /// the body, sha256, len, status, or owner. The body-release projection
    /// ([`project_answer_for_authed`]) mints `Delivered` with `None` counts (it has no
    /// outcome); the loop entry that holds the [`crate::LoopOutcome`] attaches the real
    /// numbers here.
    pub fn with_counts(self, turns: u64, executed_tools: u64) -> AuthedAnswer {
        match self {
            AuthedAnswer::Delivered {
                run_id,
                status,
                answer,
                answer_sha256,
                answer_len,
                ..
            } => AuthedAnswer::Delivered {
                run_id,
                status,
                answer,
                answer_sha256,
                answer_len,
                turns: Some(turns),
                executed_tools: Some(executed_tools),
            },
            // A non-delivered outcome carries no counts — unchanged.
            other => other,
        }
    }

    /// The (d) REFS-ONLY proof projection: outcome label + status + the answer FINGERPRINT
    /// (sha256 + length) + run_id — and NEVER the answer body (and never an owner principal,
    /// raw provider/secret/channel id). This is what a proof/unauth surface (e.g. the bin's
    /// stdout) prints.
    pub fn proof_refs_json(&self) -> serde_json::Value {
        match self {
            AuthedAnswer::Delivered {
                run_id,
                status,
                answer_sha256,
                answer_len,
                turns,
                executed_tools,
                ..
            } => json!({
                "outcome": "delivered_to_authenticated_owner",
                "run_id": run_id,
                "status": status,
                "answer_sha256": answer_sha256,
                "answer_len": answer_len,
                // (A1) REFS-surface run COUNTS (metadata, never a body). Absent ⇒ null
                // (the proof surface and the wire result agree on the same numbers).
                "turns": turns,
                "executed_tools": executed_tools,
            }),
            AuthedAnswer::Denied {
                run_id,
                reason,
                refs,
            } => json!({
                "outcome": "denied_not_owner",
                "run_id": run_id,
                "deny_reason": format!("{reason:?}"),
                "answer_sha256": refs.as_ref().map(|r| r.answer_sha256.clone()),
                "answer_len": refs.as_ref().map(|r| r.answer_len),
            }),
            AuthedAnswer::NoAnswer { run_id } => json!({
                "outcome": "no_answer_safe_failure",
                "run_id": run_id,
            }),
        }
    }
}

/// (b)/(c) The auditable BODY-RELEASE decision: project a run's answer to an AUTHENTICATED
/// caller. Releases the body ONLY when the caller's authenticated principal matches the run's
/// bound OWNER principal (via [`friday_storage::get_run_answer_for_principal`]); otherwise the
/// body is WITHHELD and only the refs-only fingerprint is returned. A `RunAnswerAccess::Granted`
/// is destructured IMMEDIATELY into [`AuthedAnswer::Delivered`] and never allowed to escape as
/// a `{:?}` (it carries the body). A storage error fails closed to [`AuthedAnswer::NoAnswer`].
pub fn project_answer_for_authed(
    conn: &rusqlite::Connection,
    run_id: &str,
    caller: &AuthedPrincipal,
) -> AuthedAnswer {
    match get_run_answer_for_principal(conn, run_id, caller.principal()) {
        Ok(RunAnswerAccess::Granted(stored)) => AuthedAnswer::Delivered {
            run_id: run_id.to_string(),
            status: stored.status,
            answer: stored.answer,
            answer_sha256: stored.answer_sha256,
            answer_len: stored.answer_len,
            // (A1) This DB-projection path has no LoopOutcome in hand — counts default
            // to `None`. The loop entry ([`run_authed_agent_loop`]) holds the outcome and
            // attaches the real counts via [`AuthedAnswer::with_counts`].
            turns: None,
            executed_tools: None,
        },
        Ok(RunAnswerAccess::Denied(reason)) => AuthedAnswer::Denied {
            run_id: run_id.to_string(),
            reason,
            // refs-only fingerprint (body-free, owner-free) for the deny's proof surface.
            refs: get_run_result_ref(conn, run_id).ok().flatten(),
        },
        Ok(RunAnswerAccess::NotFound) | Err(_) => AuthedAnswer::NoAnswer {
            run_id: run_id.to_string(),
        },
    }
}

/// (a)+(b)+(c) The internal AUTHENTICATED single-provider agent-loop route (D1-Q4).
///
/// Runs the Rust agent loop ([`HubRuntime::run_task`]) for an ALREADY-AUTHENTICATED caller
/// (the `caller` is produced ONLY by [`AuthedPrincipal::authenticate`] over the sealed
/// session), then projects the answer body to that authenticated OWNER via
/// [`project_answer_for_authed`]. The runtime is single-owner (v1): it MUST be configured with
/// the SAME principal as `caller` so owner-wiring records `owner == caller` and the body is
/// released to them.
///
/// SAFE FAILURE: a route/provider failure (`run_task` `Err`) OR a non-Finished run (e.g. a
/// transport-errored loop, which persists no `run_result`) returns a body-free
/// [`AuthedAnswer::NoAnswer`] — no panic, no partial/false success. The answer body, when
/// delivered, is carried ONLY in [`AuthedAnswer::Delivered`] for in-process hand-off to the
/// authed owner — it is NEVER placed on a refs-only/proof surface and NEVER logged.
///
/// FIX-Q2 (hardening — the symmetric twin of the merged FIX-Q3a) — BEFORE dispatching, assert
/// the authenticated `caller` EQUALS the runtime's configured owner principal
/// ([`HubRuntime::configured_principal`]). On a mismatch (or an unconfigured `None` owner) the
/// loop NEVER executes and returns the body-free [`AuthedAnswer::NoAnswer`] — no run row, no
/// memory recall, no gate Actor, no model spend, no owner-stamp.
///
/// WHY this is a code invariant, not just a doc convention: `run_task` derives the run OWNER from
/// the runtime's STATIC CONFIG ([`RunPolicy::principal_id`]), NOT from `caller`. The audit's Q2
/// gap is that under a future >1 owner allowlist, caller B could authenticate, trigger a run, and
/// have it execute + recall + bill as the CONFIG owner A (an integrity/attribution/spend harm —
/// the readback gate still denies B the body, but the EXEC was never caller-gated). The guard
/// must precede `run_task` because the harm is the DISPATCH itself; an after-exec check is
/// pointless (the spend already happened).
///
/// LIVE POSTURE: on the single-owner config this is a PROVABLE NO-OP — `caller` is drawn from the
/// `--owner` allowlist (a ≤1 entry collection), the runtime principal is `owner_allowlist.first()`,
/// and FIX-Q3a forces exactly one enrolled peer, so `caller == configured_principal` always holds.
/// This slice does NOT enable multi-principal: it makes the single-owner invariant FAIL-CLOSED in
/// code. The deeper FIX-Q2 (DERIVE the per-run owner from `caller` instead of the static config)
/// remains a multi-principal prerequisite and is DEFERRED with FIX-Q3b.
pub fn run_authed_agent_loop<T: Transport>(
    runtime: &HubRuntime<T>,
    caller: &AuthedPrincipal,
    run_id: &str,
    task: &str,
    now_ms: i64,
) -> AuthedAnswer {
    // Pre-A1 entry: NO per-run override ⇒ the boot policy / ceiling (byte-identical). Every
    // pre-A1 caller (dev bin, tests) stays on this path; only the WS dispatch arm opts into an
    // override via `run_authed_agent_loop_with_policy`.
    run_authed_agent_loop_with_policy(runtime, caller, run_id, task, None, None, now_ms)
}

/// (A1) [`run_authed_agent_loop`] with an OPTIONAL per-run policy + max-turns override applied at
/// run-START — the SESSIONLESS dispatch entry that APPLIES a peer's
/// [`friday_protocol::AgentRunConstraintsWire`]. `None`/`None` ⇒ the boot policy/ceiling
/// (byte-identical pre-A1 path). `Some(p)` ⇒ the COMPOSED only-tighten policy the dispatch arm
/// built via [`crate::agent_run_control::effective_run_policy_over`].
///
/// The FIX-Q2 `caller == configured_principal` guard is UNCHANGED and still precedes any dispatch:
/// a per-run CONSTRAINT tightens WHAT the run may do, it does NOT change WHO it runs as — the owner
/// gate is orthogonal and a constraint can never relax it. A non-owner caller still fails closed to
/// a body-free `NoAnswer` regardless of the override.
#[allow(clippy::too_many_arguments)]
pub fn run_authed_agent_loop_with_policy<T: Transport>(
    runtime: &HubRuntime<T>,
    caller: &AuthedPrincipal,
    run_id: &str,
    task: &str,
    policy_override: Option<&crate::RunPolicy>,
    max_turns_override: Option<u64>,
    now_ms: i64,
) -> AuthedAnswer {
    // (FIX-Q2) caller == configured-owner, asserted BEFORE any dispatch. A mismatch — or an
    // unconfigured (`None`) owner — fails CLOSED to a body-free `NoAnswer`: the loop never runs,
    // so nothing is created/recalled/billed/owner-stamped under the wrong principal. On live
    // (single owner) this is unreachable (caller is always the configured owner by construction).
    // The override does NOT touch this gate — a constraint cannot relax the owner check.
    match runtime.configured_principal() {
        Some(owner) if owner == caller.principal() => {}
        _ => {
            return AuthedAnswer::NoAnswer {
                run_id: run_id.to_string(),
            };
        }
    }
    // (a) the caller is already authenticated (typed proof). (b) run the loop as that
    // principal under the (effective) per-run policy; a route/provider failure is a SAFE FAILURE
    // (no body, no panic).
    //
    // A1 transport-truth: `run_task_with_overrides` ALREADY returns the `LoopOutcome { turns,
    // executed_tools, .. }` — this entry used to DISCARD it via `.is_err()`. Capture it so
    // the REFS-surface run COUNTS can ride the result. This is a no-behavior-change edit:
    // the `Err` arm still returns the identical body-free `NoAnswer`, and the `Ok` arm
    // still projects the identical owner-gated body — counts are pure additive metadata.
    let outcome = match runtime.run_task_with_overrides(
        run_id,
        task,
        policy_override,
        max_turns_override,
        now_ms,
    ) {
        Ok((_selection, outcome)) => outcome,
        Err(_) => {
            return AuthedAnswer::NoAnswer {
                run_id: run_id.to_string(),
            };
        }
    };
    // (c) release the answer ONLY to the authenticated owner (owner-wiring + ownership gate),
    // then (A1) attach the loop's turn / executed-tool COUNTS to a `Delivered` answer
    // (a NO-OP on Denied / NoAnswer). Counts are metadata — this never touches the body.
    // Token counts stay `None` (DEFERRED): the per-turn usage is billed to the Rust
    // `token_ledger`, not carried on `LoopOutcome`, so the wire field is reserved but
    // unpopulated for now.
    project_answer_for_authed(runtime.db().conn(), run_id, caller)
        .with_counts(outcome.turns, outcome.executed_tools)
}

/// (NS-4) The FLAG-GATED Mission-BOUND dispatch seam — the live-reachable counterpart of the
/// UNBOUND [`run_authed_agent_loop_with_policy`]. When the operator has flipped
/// `FRIDAY_MISSION_BOUND_RUN` ON **and** a [`MissionContextLookup`] resolves to a live
/// provider-lane Mission/WorkItem for this run, it dispatches the run through the matching
/// mission-bound runtime entry — minting the mission-birth /
/// WorkItem bind (a `MissionLink` + a WorkItem status transition + a `route_decision`) the
/// unbound `run_task` path never produces. This is the seam mission-birth + passport-mint
/// depend on to be live-reachable.
///
/// ## Return contract (the load-bearing NO-DEGRADE shape)
/// - `Some(answer)` — the bound path was TAKEN (or fail-closed): the caller MUST use this and
///   NOT run the unbound path. Two cases:
///     * `MissionBoundLoopOutcome::Ran` ⇒ the owner-gated body, projected by
///       [`project_answer_for_authed`] EXACTLY as the unbound entry does (same owner-wiring —
///       both go through `run_with_request`), with the loop's COUNTS attached.
///     * `MissionBoundLoopOutcome::Blocked` ⇒ a body-free [`AuthedAnswer::NoAnswer`]. A request
///       carrying an explicit first-class `mission_context` asserted mission-bound intent; if that
///       handle cannot resolve/preflight, we fail closed instead of silently running an unbound
///       session and letting upstream project a false mission/provider route.
///     * `Err(_)` ⇒ a body-free [`AuthedAnswer::NoAnswer`]. A SAFE FAILURE that MUST NOT fall
///       through: by the time `run_agent_loop_for_mission` errors it has ALREADY created the
///       `agent_run` row + may have spent model calls, so re-running the unbound path would
///       conflict on `create_run` and double-bill. We stop here.
/// - `None` — the bound path was NOT taken; the caller falls through to the EXISTING unbound
///   dispatch BYTE-IDENTICALLY only when no first-class Mission handle was present. A present but
///   invalid handle is never a fall-through.
///
/// ## FIX-Q2 owner gate (UNCHANGED invariant)
/// The `caller == configured_principal` gate is asserted HERE, BEFORE any dispatch — the SAME
/// fail-closed guard the unbound entry enforces. A non-owner caller (or an unconfigured `None`
/// owner) returns a body-free `NoAnswer` and the loop NEVER runs (no row, no recall, no spend,
/// no mission bind). The Mission-bound path must not be a way around the owner gate.
///
/// ## First-class Mission-handle ingress (NS45-PR1 / M-4)
/// Resolution now keys off the FIRST-CLASS `mission_context` handle the wire `AgentRunRequest`
/// carries — `{friday_conversation_id, mission_id, work_item_id}` — mapped via
/// [`MissionContextLookup::by_mission_work_item`]. This RETIRES the provisional NS-4 shim that
/// conflated the client-asserted `session_id` with a surface-thread id for mission resolution
/// (the `session_id` field stays on the wire for the sessioned-chat unbound path, but it is NO
/// LONGER the mission-resolution key). A run with NO handle (`None`) is NOT mission-resolvable ⇒
/// `None` ⇒ the caller falls through to the unbound path, BYTE-IDENTICAL to today. A present handle
/// that fails preflight returns `Some(NoAnswer)`, not `None`, so upstream cannot turn an unbound
/// answer into a false mission-bound provider projection. The handle is a CLIENT ASSERTION that
/// selects WHICH Mission to bind to; it is never an authority — the FIX-Q2 owner gate below is the
/// authority.
///
/// The handle is populated by organic ingress (the native client / courier from the NS-5
/// `MissionIntakeResult`) + the operator flips the flag. This helper is only called after the WS
/// arm has admitted the mission-bound flag; the WS arm itself treats handle-present/flag-off as
/// fail-closed `NoAnswer`, while no-handle requests keep the unchanged unbound path.
///
/// ## Go-live caveat (DEFERRED — a named gate, NOT added here)
/// A client-asserted `mission_id` under an `owner_allowlist > 1` is a cross-principal resolution
/// surface (the same deferred class as M-3/M-5). It is SAFE under single-owner v1 + the FIX-Q2
/// owner gate (the single configured owner is the only principal that can dispatch a bound run).
/// Enforcing that a multi-owner caller actually OWNS the asserted `mission_id` is a NAMED go-live
/// gate — this PR resolves the handle but does NOT add that multi-owner ownership check.
///
/// ## Semantics worth stating
/// The bound path is SESSIONLESS (`run_task_with_overrides`, no history fold): a handle dispatches
/// a bound WORK-run, not a sessioned chat — prior turns are not folded. The provider-timeline
/// session label for the Mission bind is derived from the handle's `friday_conversation_id` (the
/// canonical conversation the run belongs to), NOT the `session_id` shim. The override threading
/// matches the unbound arm so a peer-asserted tightening constraint is enforced identically
/// (read-only / disabled-tools / max-turns).
///
/// Codex WorkItems (`lane=codex`, `target_provider_or_agent=codex`) route to the Codex sibling;
/// Claude WorkItems (`lane=claude`, `target_provider_or_agent=claude`) route to the Claude
/// sibling; every other handle preserves the existing DeepSeek mission-bound entry and its
/// fail-closed preflight behavior.
#[allow(clippy::too_many_arguments)]
pub fn run_authed_agent_loop_mission_bound<T: Transport>(
    runtime: &HubRuntime<T>,
    caller: &AuthedPrincipal,
    run_id: &str,
    task: &str,
    mission_context: Option<&MissionWorkItemContextWire>,
    policy_override: Option<&crate::RunPolicy>,
    max_turns_override: Option<u64>,
    now_ms: i64,
) -> Option<AuthedAnswer> {
    // (NS45-PR1 / M-4) Derive the MissionContextLookup from the FIRST-CLASS handle on the wire —
    // NOT the `session_id` surface-thread shim. A run with NO handle (`None`) is NOT
    // mission-resolvable ⇒ `None` ⇒ the caller falls through to the unbound path unchanged. This
    // is the retirement point of the provisional shim: a flag-ON run with no handle takes the
    // exact same unbound dispatch as a flag-OFF run.
    let handle = mission_context?;
    let lookup = MissionContextLookup::by_mission_work_item(
        handle.friday_conversation_id.clone(),
        handle.mission_id.clone(),
        handle.work_item_id.clone(),
    );

    // (FIX-Q2) caller == configured-owner, asserted BEFORE any dispatch — the SAME fail-closed
    // guard the unbound entry enforces. A mismatch (or an unconfigured `None` owner) ⇒ a
    // body-free `NoAnswer`, the loop NEVER runs, and we DO NOT fall through (returning `Some`
    // closes the run as denied rather than silently re-trying the unbound owner-gated path).
    match runtime.configured_principal() {
        Some(owner) if owner == caller.principal() => {}
        _ => {
            return Some(AuthedAnswer::NoAnswer {
                run_id: run_id.to_string(),
            });
        }
    }

    // The provider-timeline session label for the Mission bind (the `friday_session_id` baked into
    // the MissionLink `target_ref`). NS45-PR1 derives it from the handle's `friday_conversation_id`
    // — the canonical conversation this run belongs to — instead of the retired surface-thread
    // shim. It is a label; the preflight has already resolved+validated the handle, so this id
    // matches the Mission's conversation by the time the bind runs.
    let session = handle.friday_conversation_id.as_str();

    let result = match mission_handle_provider_target(runtime, handle) {
        MissionBoundProviderTarget::Codex => runtime
            .run_codex_agent_loop_for_mission_with_overrides(
                lookup,
                session,
                run_id,
                task,
                policy_override,
                max_turns_override,
                now_ms,
            ),
        MissionBoundProviderTarget::Claude => runtime
            .run_claude_agent_loop_for_mission_with_overrides(
                lookup,
                session,
                run_id,
                task,
                policy_override,
                max_turns_override,
                now_ms,
            ),
        MissionBoundProviderTarget::DeepSeek => runtime.run_agent_loop_for_mission_with_overrides(
            lookup,
            session,
            run_id,
            task,
            policy_override,
            max_turns_override,
            now_ms,
        ),
    };

    match result {
        // The Mission was valid: the composed loop ran and the run was bound to the Mission.
        // Project the owner-gated body EXACTLY as the unbound entry does (both persist
        // `run_result` with the same owner-wiring via `run_with_request`), then attach the
        // loop's COUNTS. Token counts stay `None` (DEFERRED — billed to the token_ledger).
        Ok(crate::runtime::MissionBoundLoopOutcome::Ran { outcome, .. }) => Some(
            project_answer_for_authed(runtime.db().conn(), run_id, caller)
                .with_counts(outcome.turns, outcome.executed_tools),
        ),
        // The preflight failed CLOSED (no resolvable/valid Mission for this explicit handle) — it
        // wrote NOTHING (no `agent_run`, no `route_decision`, no `mission_link`). Do NOT fall
        // through to unbound: the peer asserted a mission_context, and upstream may project the
        // requested provider/model as the route shape. A body-free NoAnswer preserves fail-closed
        // truth without running a different route.
        Ok(crate::runtime::MissionBoundLoopOutcome::Blocked { .. }) => {
            Some(AuthedAnswer::NoAnswer {
                run_id: run_id.to_string(),
            })
        }
        // SAFE FAILURE: a route/storage error AFTER the run row exists. Body-free `NoAnswer`; we
        // MUST NOT fall through (the unbound path would re-`create_run` and double-bill).
        Err(_) => Some(AuthedAnswer::NoAnswer {
            run_id: run_id.to_string(),
        }),
    }
}

enum MissionBoundProviderTarget {
    DeepSeek,
    Codex,
    Claude,
}

fn mission_handle_provider_target<T: Transport>(
    runtime: &HubRuntime<T>,
    handle: &MissionWorkItemContextWire,
) -> MissionBoundProviderTarget {
    let Ok(Some(work_item)) = runtime.db().get_work_item(&handle.work_item_id) else {
        return MissionBoundProviderTarget::DeepSeek;
    };
    match (
        work_item.lane,
        work_item.target_provider_or_agent.as_deref().map(str::trim),
    ) {
        (friday_core::WorkLane::Codex, Some("codex")) => MissionBoundProviderTarget::Codex,
        (friday_core::WorkLane::Claude, Some("claude")) => MissionBoundProviderTarget::Claude,
        _ => MissionBoundProviderTarget::DeepSeek,
    }
}

fn work_item_timeline_wire(item: friday_core::WorkItem) -> MissionTimelineWorkItemWire {
    MissionTimelineWorkItemWire {
        work_item_id: item.work_item_id,
        mission_id: item.mission_id,
        lane: item.lane.as_str().to_string(),
        status: item.status.as_str().to_string(),
        capability_id: item.capability_id,
        risk_level: item.risk_level.as_str().to_string(),
        approval_state: item.approval_state.as_str().to_string(),
        has_blocker: item.blocking_reason.is_some(),
        owner_claim_count: item.owner_claim_ids.len() as u64,
        workspace_ref_count: item.workspace_refs.len() as u64,
        input_ref_count: item.input_refs.len() as u64,
        output_ref_count: item.output_refs.len() as u64,
        proof_requirements: item.proof_requirements,
        proof_receipts: item.proof_receipts,
        updated_at_ms: item.updated_at_ms,
    }
}

const MISSION_TIMELINE_DEFAULT_LIMIT: usize = 50;
const MISSION_TIMELINE_MAX_LIMIT: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
struct TimelineWindow {
    requested_cursor: Option<String>,
    start: usize,
    limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MissionTimelinePage {
    requested_cursor: Option<String>,
    next_cursor: Option<String>,
    retained_from: Option<String>,
    bounded: bool,
    has_more: bool,
    links: Vec<MissionTimelineLinkWire>,
    route_decisions: Vec<RouteDecisionProjectionWire>,
    surface_events: Vec<MissionTimelineSurfaceEventWire>,
}

enum TimelineItem {
    Link {
        projection_index: usize,
        link: friday_core::MissionLink,
    },
    Route(friday_core::RouteDecisionProjection),
    Surface(friday_core::SurfaceEvent),
}

impl TimelineItem {
    fn created_at_ms(&self) -> i64 {
        match self {
            TimelineItem::Link { link, .. } => link.created_at_ms,
            TimelineItem::Route(route) => route.created_at_ms,
            TimelineItem::Surface(event) => event.created_at_ms,
        }
    }

    fn kind_order(&self) -> u8 {
        match self {
            TimelineItem::Route(_) => 0,
            TimelineItem::Link { .. } => 1,
            TimelineItem::Surface(_) => 2,
        }
    }

    fn stable_id(&self) -> &str {
        match self {
            TimelineItem::Link { link, .. } => &link.link_id,
            TimelineItem::Route(route) => &route.route_decision_ref,
            TimelineItem::Surface(event) => &event.surface_event_id,
        }
    }
}

fn parse_timeline_window(
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Option<TimelineWindow>, String> {
    if cursor.is_none() && limit.is_none() {
        return Ok(None);
    }
    let limit = match limit {
        Some(0) => return Err("mission timeline limit must be greater than 0".to_string()),
        Some(limit) => (limit as usize).min(MISSION_TIMELINE_MAX_LIMIT),
        None => MISSION_TIMELINE_DEFAULT_LIMIT,
    };
    let start = match cursor.as_deref() {
        None | Some("start") => 0,
        Some(raw) => {
            let raw = raw.trim();
            if raw == "start" {
                0
            } else if let Some(offset) = raw.strip_prefix("offset:") {
                offset.parse::<usize>().map_err(|_| {
                    "mission timeline cursor must be start or offset:<n>".to_string()
                })?
            } else {
                return Err("mission timeline cursor must be start or offset:<n>".to_string());
            }
        }
    };
    Ok(Some(TimelineWindow {
        requested_cursor: cursor,
        start,
        limit,
    }))
}

fn apply_timeline_window(
    links: Vec<friday_core::MissionLink>,
    route_decisions: Vec<friday_core::RouteDecisionProjection>,
    surface_events: Vec<friday_core::SurfaceEvent>,
    window: Option<TimelineWindow>,
) -> MissionTimelinePage {
    let Some(window) = window else {
        return MissionTimelinePage {
            requested_cursor: None,
            next_cursor: None,
            retained_from: None,
            bounded: false,
            has_more: false,
            links: links
                .into_iter()
                .enumerate()
                .map(|(index, link)| mission_link_timeline_wire(index, link))
                .collect(),
            route_decisions: route_decisions.into_iter().map(Into::into).collect(),
            surface_events: surface_events
                .into_iter()
                .map(MissionTimelineSurfaceEventWire::from)
                .collect(),
        };
    };

    let mut items = Vec::new();
    for (index, link) in links.into_iter().enumerate() {
        items.push(TimelineItem::Link {
            projection_index: index,
            link,
        });
    }
    items.extend(route_decisions.into_iter().map(TimelineItem::Route));
    items.extend(surface_events.into_iter().map(TimelineItem::Surface));
    items.sort_by(|left, right| {
        left.created_at_ms()
            .cmp(&right.created_at_ms())
            .then_with(|| left.kind_order().cmp(&right.kind_order()))
            .then_with(|| left.stable_id().cmp(right.stable_id()))
    });

    let total = items.len();
    let start = window.start.min(total);
    let end = start.saturating_add(window.limit).min(total);
    let has_more = end < total;
    let mut page = MissionTimelinePage {
        requested_cursor: window.requested_cursor,
        next_cursor: has_more.then(|| format!("offset:{end}")),
        retained_from: Some(format!("offset:{start}")),
        bounded: true,
        has_more,
        links: Vec::new(),
        route_decisions: Vec::new(),
        surface_events: Vec::new(),
    };

    for item in items.into_iter().skip(start).take(end - start) {
        match item {
            TimelineItem::Link {
                projection_index,
                link,
            } => page
                .links
                .push(mission_link_timeline_wire(projection_index, link)),
            TimelineItem::Route(route) => page.route_decisions.push(route.into()),
            TimelineItem::Surface(event) => page
                .surface_events
                .push(MissionTimelineSurfaceEventWire::from(event)),
        }
    }
    page
}

fn mission_link_timeline_wire(
    index: usize,
    link: friday_core::MissionLink,
) -> MissionTimelineLinkWire {
    let link_kind = link.link_kind.as_str().to_string();
    MissionTimelineLinkWire {
        link_ref: format!(
            "friday://mission-link-projection/{}/{}/{}/{}",
            projection_ref_part(&link.mission_id),
            link_kind,
            link.created_at_ms,
            index
        ),
        mission_id: link.mission_id,
        work_item_id: link.work_item_id,
        link_kind,
        has_proof: link.proof_ref.is_some(),
        proof_ref: link.proof_ref,
        grants_memory_authority: link.link_kind.grants_memory_authority(),
        created_at_ms: link.created_at_ms,
    }
}

fn projection_ref_part(value: &str) -> String {
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

fn surface_kind_from_wire(value: &str) -> Result<friday_core::SurfaceKind, &'static str> {
    match value {
        "mobile" => Ok(friday_core::SurfaceKind::Mobile),
        "desktop" => Ok(friday_core::SurfaceKind::Desktop),
        "telegram" => Ok(friday_core::SurfaceKind::Telegram),
        "discord" => Ok(friday_core::SurfaceKind::Discord),
        "lark" => Ok(friday_core::SurfaceKind::Lark),
        "web_chat" => Ok(friday_core::SurfaceKind::WebChat),
        "provider_workspace" => Ok(friday_core::SurfaceKind::ProviderWorkspace),
        "future_channel" => Ok(friday_core::SurfaceKind::FutureChannel),
        _ => Err("mission intake surface_kind is unknown"),
    }
}

fn visibility_policy_from_wire(value: &str) -> Result<friday_core::VisibilityPolicy, &'static str> {
    match value {
        "compact" => Ok(friday_core::VisibilityPolicy::Compact),
        "rich_proof" => Ok(friday_core::VisibilityPolicy::RichProof),
        "status_only" => Ok(friday_core::VisibilityPolicy::StatusOnly),
        "hidden_trace_only" => Ok(friday_core::VisibilityPolicy::HiddenTraceOnly),
        _ => Err("mission intake visibility_policy is unknown"),
    }
}

fn work_lane_from_wire(value: &str) -> Result<friday_core::WorkLane, &'static str> {
    match value {
        "friday_hub" => Ok(friday_core::WorkLane::FridayHub),
        "codex" => Ok(friday_core::WorkLane::Codex),
        "claude" => Ok(friday_core::WorkLane::Claude),
        "deepseek" => Ok(friday_core::WorkLane::DeepSeek),
        "workflow" => Ok(friday_core::WorkLane::Workflow),
        "channel" => Ok(friday_core::WorkLane::Channel),
        "human" => Ok(friday_core::WorkLane::Human),
        "future_api" => Ok(friday_core::WorkLane::FutureApi),
        _ => Err("mission intake lane is unknown"),
    }
}

fn is_safe_body_ref(value: &str) -> bool {
    value.starts_with("friday://body/")
        || value.starts_with("friday://surface-event-body/")
        || value.starts_with("blob://")
}

fn mission_status_from_wire(value: &str) -> Result<friday_core::MissionStatus, &'static str> {
    match value {
        "active" => Ok(friday_core::MissionStatus::Active),
        "waiting_for_user" => Ok(friday_core::MissionStatus::WaitingForUser),
        "blocked" => Ok(friday_core::MissionStatus::Blocked),
        "paused" => Ok(friday_core::MissionStatus::Paused),
        "done" => Ok(friday_core::MissionStatus::Done),
        "archived" => Ok(friday_core::MissionStatus::Archived),
        "merged" => Ok(friday_core::MissionStatus::Merged),
        _ => Err("mission lifecycle target_status is unknown"),
    }
}

/// Map a WorkItem `target_status` wire string to the canonical [`friday_core::WorkItemStatus`].
/// Mirrors the (private) storage-side `parse_work_item_status` vocabulary so the bin's flag-gated
/// dispatch arm validates the target BEFORE the transition; an unknown value is a typed error,
/// never a silent default.
fn work_item_status_from_wire(value: &str) -> Result<friday_core::WorkItemStatus, &'static str> {
    match value {
        "draft" => Ok(friday_core::WorkItemStatus::Draft),
        "preflight_blocked" => Ok(friday_core::WorkItemStatus::PreflightBlocked),
        "waiting_for_user" => Ok(friday_core::WorkItemStatus::WaitingForUser),
        "ready_to_dispatch" => Ok(friday_core::WorkItemStatus::ReadyToDispatch),
        "dispatched" => Ok(friday_core::WorkItemStatus::Dispatched),
        "hub_accepted" => Ok(friday_core::WorkItemStatus::HubAccepted),
        "provider_routed" => Ok(friday_core::WorkItemStatus::ProviderRouted),
        "provider_waiting" => Ok(friday_core::WorkItemStatus::ProviderWaiting),
        "completed_with_proof" => Ok(friday_core::WorkItemStatus::CompletedWithProof),
        "failed_retryable" => Ok(friday_core::WorkItemStatus::FailedRetryable),
        "failed_terminal" => Ok(friday_core::WorkItemStatus::FailedTerminal),
        "cancelled" => Ok(friday_core::WorkItemStatus::Cancelled),
        "merged" => Ok(friday_core::WorkItemStatus::Merged),
        "archived" => Ok(friday_core::WorkItemStatus::Archived),
        _ => Err("work item lifecycle target_status is unknown"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{
        ApprovalState, ClaimState, FridayConversation, HandoffJudgmentMemory, MemoryScope, Mission,
        MissionLink, MissionLinkKind, MissionStatus, ProviderSessionLink, RouteDecisionCard,
        SurfaceEvent, SurfaceEventKind, SurfaceKind, SurfaceThread, SyncMode, TruthStatus,
        VisibilityPolicy, WorkItem, WorkItemStatus, WorkLane, WorkspaceClaimKind,
    };
    use friday_crypto::DeviceKeypair;
    use friday_deepseek::{DeepSeekError, Transport};
    use friday_storage::memory;
    use friday_transport::{ws_accept, ws_connect, ws_recv_envelope, ws_send_envelope};
    use serde_json::{json, Value};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const AAD: &[u8] = b"friday-runtime-bridge-v1";
    static TMP_DB_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn tmp_db() -> String {
        let seq = TMP_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "friday-hubserver-{}-{seq}-{}.sqlite",
                std::process::id(),
                nanos
            ))
            .to_string_lossy()
            .into_owned()
    }

    // ─── (CORE-A CR-3) session create/append handler KATs ───

    #[test]
    fn session_create_binds_authenticated_owner_and_append_is_owner_gated() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let now = 1_700_000_000_000;
        let sid = "discord:default:cr3-chat";

        // CREATE as owner "alice": ensures the row + binds the OWNER axis to the authenticated owner.
        let create = session_create_result_for_db(
            &db,
            "m-create",
            SessionCreateRequestWire {
                session_id: sid.into(),
                channel: Some("discord".into()),
                chat_id: Some("cr3-chat".into()),
                user_id: Some("alice".into()),
                account_id: Some("default".into()),
                chat_kind: Some("dm".into()),
                metadata_json: Some("{\"src\":\"cr3\"}".into()),
            },
            Some("alice"),
            now,
        );
        match create.message {
            Message::SessionCreateResult { result } => {
                assert_eq!(result.session_id, sid);
                assert_eq!(result.created_at, now);
                assert_eq!(result.updated_at, now);
            }
            other => panic!("expected SessionCreateResult, got {other:?}"),
        }
        // The stored owner axis is the AUTHENTICATED owner.
        assert_eq!(
            friday_storage::load_session_owner(db.conn(), sid)
                .unwrap()
                .unwrap()
                .user_id
                .as_deref(),
            Some("alice")
        );

        // APPEND as the OWNER "alice" → accepted, refs-only receipt, row written.
        let ok = session_message_append_result_for_db(
            &db,
            "m-append-ok",
            SessionMessageAppendRequestWire {
                session_id: sid.into(),
                role: "user".into(),
                content: "remember teal".into(),
                refs: Some("run-1".into()),
            },
            Some("alice"),
            now + 1,
        );
        match ok.message {
            Message::SessionMessageAppendResult { result } => {
                assert_eq!(result.message_id, format!("{sid}:m0"));
                assert_eq!(result.seq, 0);
                assert_eq!(result.created_at, now + 1);
            }
            other => panic!("expected SessionMessageAppendResult, got {other:?}"),
        }
        assert_eq!(friday_storage::session_message_count(db.conn(), sid).unwrap(), 1);

        // APPEND as a DIFFERENT owner "bob" → REFUSED fail-closed (Error), NO row written.
        let denied = session_message_append_result_for_db(
            &db,
            "m-append-bob",
            SessionMessageAppendRequestWire {
                session_id: sid.into(),
                role: "user".into(),
                content: "sneaky".into(),
                refs: None,
            },
            Some("bob"),
            now + 2,
        );
        assert!(
            matches!(denied.message, Message::Error { .. }),
            "a non-owner append must fail closed with an Error, got {:?}",
            denied.message
        );
        assert_eq!(
            friday_storage::session_message_count(db.conn(), sid).unwrap(),
            1,
            "a refused append must write ZERO rows"
        );
    }

    #[test]
    fn session_create_refuses_empty_and_mismatched_owner_and_append_unknown_session() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let now = 1_700_000_100_000;

        // Empty authenticated owner → refused (no anonymous session).
        let anon = session_create_result_for_db(
            &db,
            "m-anon",
            SessionCreateRequestWire {
                session_id: "s:default:x".into(),
                channel: None,
                chat_id: None,
                user_id: None,
                account_id: None,
                chat_kind: None,
                metadata_json: None,
            },
            Some("   "),
            now,
        );
        assert!(matches!(anon.message, Message::Error { .. }));
        assert!(!friday_storage::session_exists(db.conn(), "s:default:x").unwrap());

        // FIX-Q3b: a body user_id that disagrees with the authenticated owner → fail-closed, no row.
        let mismatch = session_create_result_for_db(
            &db,
            "m-mismatch",
            SessionCreateRequestWire {
                session_id: "s:default:y".into(),
                channel: None,
                chat_id: None,
                user_id: Some("mallory".into()),
                account_id: None,
                chat_kind: None,
                metadata_json: None,
            },
            Some("alice"),
            now,
        );
        assert!(matches!(mismatch.message, Message::Error { .. }));
        assert!(!friday_storage::session_exists(db.conn(), "s:default:y").unwrap());

        // Append to a session that does not exist → owner check fails closed (Error), no row.
        let ghost = session_message_append_result_for_db(
            &db,
            "m-ghost",
            SessionMessageAppendRequestWire {
                session_id: "s:default:ghost".into(),
                role: "user".into(),
                content: "hi".into(),
                refs: None,
            },
            Some("alice"),
            now,
        );
        assert!(matches!(ghost.message, Message::Error { .. }));
    }

    #[test]
    fn session_create_is_idempotent_and_preserves_created_at() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let sid = "discord:default:idem";
        let first = 1_700_000_200_000;
        let r1 = session_create_result_for_db(
            &db,
            "m1",
            SessionCreateRequestWire {
                session_id: sid.into(),
                channel: Some("discord".into()),
                chat_id: Some("idem".into()),
                user_id: Some("alice".into()),
                account_id: None,
                chat_kind: None,
                metadata_json: None,
            },
            Some("alice"),
            first,
        );
        let created_at = match r1.message {
            Message::SessionCreateResult { result } => result.created_at,
            other => panic!("expected SessionCreateResult, got {other:?}"),
        };
        assert_eq!(created_at, first);

        // Re-ensure later: created_at is PRESERVED (original), updated_at BUMPED.
        let later = first + 5_000;
        let r2 = session_create_result_for_db(
            &db,
            "m2",
            SessionCreateRequestWire {
                session_id: sid.into(),
                channel: Some("discord".into()),
                chat_id: Some("idem".into()),
                user_id: Some("alice".into()),
                account_id: None,
                chat_kind: None,
                metadata_json: None,
            },
            Some("alice"),
            later,
        );
        match r2.message {
            Message::SessionCreateResult { result } => {
                assert_eq!(result.created_at, first, "created_at must be preserved on re-ensure");
                assert_eq!(result.updated_at, later, "updated_at must bump on re-ensure");
            }
            other => panic!("expected SessionCreateResult, got {other:?}"),
        }
    }

    #[test]
    fn mission_intake_writes_body_snapshot_bound_to_work_item_input_ref() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let now = 1_700_002_000_000;
        let intent = "send this mission prompt to the Codex workspace";
        let body_ref = "friday://body/mobile/snapshot-1";
        let response = mission_intake_result_for_db(
            &db,
            "intake-snapshot",
            MissionIntakeRequestWire {
                friday_conversation_id: "fconv_snapshot".into(),
                owner_principal: "principal:jarvis".into(),
                surface_thread_id: "surface-snapshot".into(),
                surface_kind: "mobile".into(),
                delivery_route: "mobile://local/thread/snapshot".into(),
                visibility_policy: "compact".into(),
                mission_id: "mission-snapshot".into(),
                work_item_id: "work-snapshot".into(),
                title: "Snapshot Mission".into(),
                intent: intent.into(),
                lane: "codex".into(),
                target_provider_or_agent: Some("codex".into()),
                capability_id: Some("provider.codex.send_turn".into()),
                body_ref: Some(body_ref.into()),
                proof_requirements: Vec::new(),
                includes_sensitive_context: false,
            },
            Some("principal:jarvis"),
            now,
        );
        let Message::MissionIntakeResult { result } = response.message else {
            panic!("expected MissionIntakeResult, got {response:?}");
        };
        assert_eq!(result.status, "ready");
        let work_item = db
            .get_work_item("work-snapshot")
            .unwrap()
            .expect("WorkItem row");
        assert_eq!(work_item.input_refs, vec![body_ref.to_string()]);
        let snapshot = db
            .get_mission_body_snapshot("principal:jarvis", "work-snapshot", body_ref)
            .unwrap()
            .expect("mission body snapshot");
        assert_eq!(snapshot.body, intent);
        assert_eq!(snapshot.body_len, intent.len() as i64);
        assert_eq!(snapshot.owner_principal, "principal:jarvis");
    }

    #[test]
    fn mission_intake_auto_route_picks_codex_for_code_work() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let response = mission_intake_result_for_db(
            &db,
            "intake-auto-codex",
            MissionIntakeRequestWire {
                friday_conversation_id: "fconv_auto_codex".into(),
                owner_principal: "principal:jarvis".into(),
                surface_thread_id: "surface-auto-codex".into(),
                surface_kind: "desktop".into(),
                delivery_route: "desktop://local/auto-codex".into(),
                visibility_policy: "compact".into(),
                mission_id: "mission-auto-codex".into(),
                work_item_id: "work-auto-codex".into(),
                title: "Auto route code task".into(),
                intent: "Fix the Rust compile failure and add a focused regression test.".into(),
                lane: "auto".into(),
                target_provider_or_agent: None,
                capability_id: None,
                body_ref: Some("friday://body/auto/codex".into()),
                proof_requirements: Vec::new(),
                includes_sensitive_context: false,
            },
            Some("principal:jarvis"),
            1_700_002_010_000,
        );
        let Message::MissionIntakeResult { result } = response.message else {
            panic!("expected MissionIntakeResult, got {response:?}");
        };
        assert_eq!(result.status, "ready");

        let work = db
            .get_work_item("work-auto-codex")
            .unwrap()
            .expect("auto-routed WorkItem");
        assert_eq!(work.lane, WorkLane::Codex);
        assert_eq!(work.target_provider_or_agent.as_deref(), Some("codex"));
        assert_eq!(
            work.judgment_memory.target_lane_thread_agent_provider,
            "codex"
        );
        assert!(work
            .judgment_memory
            .why_this_route
            .contains("Auto route selected Codex"));
        assert_eq!(db.count("workspace_claim").unwrap(), 1);

        let route = db
            .get_route_decision("route-intake-mission-auto-codex-work-auto-codex")
            .unwrap()
            .expect("route decision");
        assert_eq!(route.selected_lane, WorkLane::Codex);
        assert_eq!(route.selected_provider_or_agent.as_deref(), Some("codex"));
        assert!(route
            .considered_options
            .iter()
            .any(|option| option.starts_with("codex:")));
    }

    #[test]
    fn mission_intake_auto_route_picks_claude_for_synthesis_work() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let response = mission_intake_result_for_db(
            &db,
            "intake-auto-claude",
            MissionIntakeRequestWire {
                friday_conversation_id: "fconv_auto_claude".into(),
                owner_principal: "principal:jarvis".into(),
                surface_thread_id: "surface-auto-claude".into(),
                surface_kind: "mobile".into(),
                delivery_route: "mobile://local/auto-claude".into(),
                visibility_policy: "compact".into(),
                mission_id: "mission-auto-claude".into(),
                work_item_id: "work-auto-claude".into(),
                title: "Auto route synthesis task".into(),
                intent: "写一份调研综述，总结这个方案的利弊和下一步计划。".into(),
                lane: "auto".into(),
                target_provider_or_agent: None,
                capability_id: None,
                body_ref: Some("friday://body/auto/claude".into()),
                proof_requirements: Vec::new(),
                includes_sensitive_context: false,
            },
            Some("principal:jarvis"),
            1_700_002_020_000,
        );
        let Message::MissionIntakeResult { result } = response.message else {
            panic!("expected MissionIntakeResult, got {response:?}");
        };
        assert_eq!(result.status, "ready");

        let work = db
            .get_work_item("work-auto-claude")
            .unwrap()
            .expect("auto-routed WorkItem");
        assert_eq!(work.lane, WorkLane::Claude);
        assert_eq!(work.target_provider_or_agent.as_deref(), Some("claude"));
        assert_eq!(
            work.judgment_memory.target_lane_thread_agent_provider,
            "claude"
        );
        assert!(work
            .judgment_memory
            .why_this_route
            .contains("Auto route selected Claude"));
        assert_eq!(
            db.count("workspace_claim").unwrap(),
            0,
            "Claude auto-route must not mint a Codex provider-session claim"
        );

        let route = db
            .get_route_decision("route-intake-mission-auto-claude-work-auto-claude")
            .unwrap()
            .expect("route decision");
        assert_eq!(route.selected_lane, WorkLane::Claude);
        assert_eq!(route.selected_provider_or_agent.as_deref(), Some("claude"));
        assert!(route
            .considered_options
            .iter()
            .any(|option| option.starts_with("claude:")));
    }

    #[test]
    fn mission_intake_auto_route_records_hybrid_strength_plan() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let response = mission_intake_result_for_db(
            &db,
            "intake-auto-hybrid",
            MissionIntakeRequestWire {
                friday_conversation_id: "fconv_auto_hybrid".into(),
                owner_principal: "principal:jarvis".into(),
                surface_thread_id: "surface-auto-hybrid".into(),
                surface_kind: "desktop".into(),
                delivery_route: "desktop://local/auto-hybrid".into(),
                visibility_policy: "compact".into(),
                mission_id: "mission-auto-hybrid".into(),
                work_item_id: "work-auto-hybrid".into(),
                title: "Auto route hybrid task".into(),
                intent: "Fix the Swift bug, add a regression test, then summarize the tradeoffs."
                    .into(),
                lane: "auto".into(),
                target_provider_or_agent: None,
                capability_id: None,
                body_ref: Some("friday://body/auto/hybrid".into()),
                proof_requirements: Vec::new(),
                includes_sensitive_context: false,
            },
            Some("principal:jarvis"),
            1_700_002_030_000,
        );
        let Message::MissionIntakeResult { result } = response.message else {
            panic!("expected MissionIntakeResult, got {response:?}");
        };
        assert_eq!(result.status, "ready");

        let work = db
            .get_work_item("work-auto-hybrid")
            .unwrap()
            .expect("auto-routed WorkItem");
        assert_eq!(
            work.lane,
            WorkLane::Codex,
            "hybrid code+synthesis work starts on the executable workspace leg"
        );
        assert_eq!(work.target_provider_or_agent.as_deref(), Some("codex"));
        assert!(work.judgment_memory.why_this_route.contains("Codex first"));
        assert!(work
            .judgment_memory
            .considered_options
            .iter()
            .any(|option| option.starts_with("combination:")));
        assert!(work
            .judgment_memory
            .deferred_options
            .iter()
            .any(|option| option.contains("Claude synthesis follow-up")));

        let route = db
            .get_route_decision("route-intake-mission-auto-hybrid-work-auto-hybrid")
            .unwrap()
            .expect("route decision");
        assert_eq!(route.selected_lane, WorkLane::Codex);
        assert!(route
            .considered_options
            .iter()
            .any(|option| option.starts_with("combination:")));
        assert!(route
            .deferred_options
            .iter()
            .any(|option| option.contains("Claude synthesis follow-up")));
    }

    fn provider_session_link() -> ProviderSessionLink {
        ProviderSessionLink {
            friday_session_id: "friday-session-1".into(),
            provider: "codex".into(),
            account_key_hash: "account-hash-never-project".into(), // pragma: allowlist secret
            workspace_id: "workspace-alpha".into(),
            cwd: Some("/Users/example/private/project".into()),
            external_session_id: Some("provider-session-id".into()),
            external_thread_id: Some("provider-thread-id".into()),
            external_url: Some("https://provider.example/private/thread".into()),
            sync_mode: SyncMode::ProviderAppServerLocal,
            capability_snapshot: "thread/start,thread/read,turn/start".into(),
            last_provider_seen_at: Some(30),
            last_friday_event_id: Some("friday-event-9".into()),
            truth_label: "provider_workspace_test_link".into(),
        }
    }

    fn seed_provider_workspace_mission(db: &Db) {
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: "fconv_provider_workspace".into(),
            owner_principal: "owner-1".into(),
            title: "Provider Workspace Conversation".into(),
            current_focus_summary: "Provider Workspace action attached to Mission".into(),
            active_mission_ids: vec!["mission-provider-workspace".into()],
            surface_thread_ids: Vec::new(),
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: Vec::new(),
            created_at_ms: 1_700_000_100_000,
            updated_at_ms: 1_700_000_100_000,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: "mission-provider-workspace".into(),
            friday_conversation_id: "fconv_provider_workspace".into(),
            title: "Provider Workspace Mission".into(),
            intent: "Dispatch provider workspace action through Mission context".into(),
            status: MissionStatus::Active,
            why_now: "Provider actions must not detach from Friday Mission state.".into(),
            decision_path_summary: "Resolve Mission context before provider capability guard."
                .into(),
            considered_options: vec![
                "detached provider action".into(),
                "mission-bound action".into(),
            ],
            deferred_options: vec!["live provider execution".into()],
            known_pitfalls: vec!["provider ack is not completion".into()],
            handoff_inheritance: vec!["Mission context is required".into()],
            work_item_ids: vec!["work-provider-workspace".into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: Vec::new(),
            created_at_ms: 1_700_000_100_000,
            updated_at_ms: 1_700_000_100_000,
        })
        .unwrap();
        db.upsert_work_item(&WorkItem {
            work_item_id: "work-provider-workspace".into(),
            mission_id: "mission-provider-workspace".into(),
            lane: WorkLane::Codex,
            target_provider_or_agent: Some("codex".into()),
            status: WorkItemStatus::ReadyToDispatch,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("provider.codex.list_sessions".into()),
            risk_level: friday_core::Risk::Low,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["friday://provider-workspace/request".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["provider workspace guard".into()],
            proof_receipts: Vec::new(),
            judgment_memory: HandoffJudgmentMemory {
                task: "Guard provider workspace action".into(),
                current_blocker: None,
                target_lane_thread_agent_provider: "codex".into(),
                read_first_files: vec![
                    "rust-core/crates/friday-hub/src/provider_dispatch.rs".into()
                ],
                required_output: "guarded provider action result".into(),
                done_criteria: vec!["Mission context resolves before dispatch".into()],
                red_lines: vec!["detached provider action".into()],
                why_this_route: "Provider action must remain attached to a WorkItem.".into(),
                considered_options: vec![
                    "detached dispatch".into(),
                    "Mission-bound dispatch".into(),
                ],
                deferred_options: vec!["provider adapter live proof".into()],
                previous_pitfalls: vec!["provider ack looked like done".into()],
                inheritable_context: vec!["same Mission id across surfaces".into()],
                proof_requirements: vec!["hub dispatch test".into()],
                ownership_claim_ids: Vec::new(),
            },
            created_at_ms: 1_700_000_100_000,
            updated_at_ms: 1_700_000_100_000,
        })
        .unwrap();
    }

    #[derive(Debug)]
    struct HttpProviderRequest {
        method: String,
        path: String,
        authorization: Option<String>,
        body: String,
    }

    fn serve_deepseek_http_models_and_chat_once() -> (
        String,
        Arc<Mutex<Vec<HttpProviderRequest>>>,
        thread::JoinHandle<()>,
    ) {
        serve_deepseek_http_models_and_chat_requests(2)
    }

    fn serve_deepseek_http_models_and_chat_requests(
        expected_requests: usize,
    ) -> (
        String,
        Arc<Mutex<Vec<HttpProviderRequest>>>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let server_requests = requests.clone();
        let handle = thread::spawn(move || {
            for _ in 0..expected_requests {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http_provider_request(&mut stream);
                let body = match (request.method.as_str(), request.path.as_str()) {
                    ("GET", "/models") => {
                        r#"{"object":"list","data":[{"id":"deepseek-v4-flash","object":"model","owned_by":"deepseek"}]}"#
                    }
                    ("POST", "/chat/completions") => {
                        r#"{"model":"deepseek-v4-flash","choices":[{"index":0,"message":{"role":"assistant","content":"SECRET-HTTP-ANSWER-TEXT"},"finish_reason":"stop"}],"usage":{"prompt_tokens":13,"completion_tokens":5,"total_tokens":18}}"#
                    }
                    _ => r#"{"error":"unexpected path"}"#,
                };
                let status = if request.path == "/models" || request.path == "/chat/completions" {
                    "200 OK"
                } else {
                    "404 Not Found"
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
                server_requests.lock().unwrap().push(request);
            }
        });
        (base_url, requests, handle)
    }

    fn read_http_provider_request(stream: &mut TcpStream) -> HttpProviderRequest {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    bytes.extend_from_slice(&chunk[..n]);
                    if http_request_complete(&bytes) {
                        break;
                    }
                }
                Err(err)
                    if err.kind() == std::io::ErrorKind::WouldBlock
                        || err.kind() == std::io::ErrorKind::TimedOut =>
                {
                    break
                }
                Err(err) => panic!("provider HTTP read failed: {err}"),
            }
        }
        let header_end = find_subslice(&bytes, b"\r\n\r\n").expect("HTTP header terminator");
        let header = String::from_utf8_lossy(&bytes[..header_end]).to_string();
        let body = String::from_utf8_lossy(&bytes[header_end + 4..]).to_string();
        let mut lines = header.lines();
        let request_line = lines.next().unwrap_or_default();
        let mut request_parts = request_line.split_whitespace();
        let method = request_parts.next().unwrap_or_default().to_string();
        let path = request_parts.next().unwrap_or_default().to_string();
        let authorization = header.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("authorization")
                .then(|| value.trim().to_string())
        });
        HttpProviderRequest {
            method,
            path,
            authorization,
            body,
        }
    }

    fn http_request_complete(bytes: &[u8]) -> bool {
        let Some(header_end) = find_subslice(bytes, b"\r\n\r\n") else {
            return false;
        };
        let header = String::from_utf8_lossy(&bytes[..header_end]);
        let content_length = header
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        bytes.len() >= header_end + 4 + content_length
    }

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    /// Scripted DeepSeek transport: returns canned models + chat, and counts EVERY
    /// transport call via a shared atomic so a test can prove "zero provider calls" on the
    /// non-model ops.
    struct CountingMock {
        calls: Arc<AtomicUsize>,
    }
    impl Transport for CountingMock {
        fn get_json(&self, _url: &str, _bearer: &str) -> Result<Value, DeepSeekError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"object":"list","data":[
                {"id":"deepseek-v4-flash","object":"model","owned_by":"deepseek"}
            ]}))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &Value,
        ) -> Result<Value, DeepSeekError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({
                "model":"deepseek-v4-flash",
                "choices":[{"index":0,"message":{"role":"assistant","content":"SECRET-ANSWER-TEXT"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":11,"completion_tokens":8,"total_tokens":19}
            }))
        }
    }

    struct FailingMock {
        calls: Arc<AtomicUsize>,
    }

    impl Transport for FailingMock {
        fn get_json(&self, _url: &str, _bearer: &str) -> Result<Value, DeepSeekError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(DeepSeekError::ProviderUnavailable(
                "forced test outage".into(),
            ))
        }

        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &Value,
        ) -> Result<Value, DeepSeekError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(DeepSeekError::ProviderUnavailable(
                "post should not run after discovery failure".into(),
            ))
        }
    }

    struct PostFailingMock {
        calls: Arc<AtomicUsize>,
        reason: &'static str,
    }

    impl Transport for PostFailingMock {
        fn get_json(&self, _url: &str, _bearer: &str) -> Result<Value, DeepSeekError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"object":"list","data":[
                {"id":"deepseek-v4-flash","object":"model","owned_by":"deepseek"}
            ]}))
        }

        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &Value,
        ) -> Result<Value, DeepSeekError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(DeepSeekError::ProviderUnavailable(self.reason.into()))
        }
    }

    fn server(calls: Arc<AtomicUsize>, db_path: &str) -> HubServer<CountingMock> {
        let db = Db::open_hub(db_path).unwrap();
        let client =
            DeepSeekClient::with_transport(CountingMock { calls }, "test-key-not-real".to_string()); // pragma: allowlist secret
        HubServer::new(db, client, vec!["ask_friday".into(), "status".into()], 256)
    }

    fn seed_mission_projection(db: &Db) {
        let now = 1_700_000_000_000;
        let conversation = FridayConversation {
            friday_conversation_id: "fconv_hub_projection".into(),
            owner_principal: "owner-1".into(),
            title: "Friday global secretary".into(),
            current_focus_summary: "same Mission state on mobile and desktop".into(),
            active_mission_ids: vec!["mission-hub-projection".into()],
            surface_thread_ids: vec!["surface-mobile".into(), "surface-desktop".into()],
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: vec!["proof://mission-projection".into()],
            created_at_ms: now,
            updated_at_ms: now,
        };
        db.upsert_friday_conversation(&conversation).unwrap();
        db.upsert_mission(&Mission {
            mission_id: "mission-hub-projection".into(),
            friday_conversation_id: "fconv_hub_projection".into(),
            title: "Coordinate Friday surfaces".into(),
            intent: "one mission across surfaces".into(),
            status: MissionStatus::Active,
            why_now: "The user should not manage separate chat truth.".into(),
            decision_path_summary: "Project one Mission into different surfaces.".into(),
            considered_options: vec!["provider chat as source".into(), "Mission Spine".into()],
            deferred_options: vec![MISSION_NATIVE_UI_IMPLEMENTATION_DEFERRED_OPTION.into()],
            known_pitfalls: vec!["provider ack is not completion".into()],
            handoff_inheritance: vec!["carry judgment path".into()],
            work_item_ids: vec!["work-hub-route".into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://mission-projection".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        let work_item = WorkItem {
            work_item_id: "work-hub-route".into(),
            mission_id: "mission-hub-projection".into(),
            lane: WorkLane::Channel,
            target_provider_or_agent: Some("telegram:raw-chat-123".into()),
            status: WorkItemStatus::ProviderWaiting,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("channel.telegram.send".into()),
            risk_level: friday_core::Risk::Low,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: Some("duplicate channel route found and resolved".into()),
            input_refs: vec!["friday://body/channel-request".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["route decision projection is visible".into()],
            proof_receipts: Vec::new(),
            judgment_memory: HandoffJudgmentMemory {
                task: "Show the same Mission decision on every surface".into(),
                current_blocker: None,
                target_lane_thread_agent_provider: "bound telegram channel".into(),
                read_first_files: Vec::new(),
                required_output: "redacted route decision projection".into(),
                done_criteria: vec!["Hub snapshot includes route decision trace".into()],
                red_lines: vec!["never leak raw channel ids".into()],
                why_this_route: "The channel should receive the Mission-bound reply without becoming the source of truth.".into(),
                considered_options: vec!["mobile-only reply".into(), "Mission-bound channel route".into()],
                deferred_options: vec!["provider-native history sync proof".into()],
                previous_pitfalls: vec!["provider ack is not completion".into()],
                inheritable_context: vec!["carry judgment and proof refs across surfaces".into()],
                proof_requirements: vec!["pure Hub read exposes redacted trace".into()],
                ownership_claim_ids: Vec::new(),
            },
            created_at_ms: now + 1,
            updated_at_ms: now + 1,
        };
        db.upsert_work_item(&work_item).unwrap();
        db.upsert_route_decision(&RouteDecisionCard::from_work_item(
            "route-decision-hub".into(),
            &work_item,
            vec![
                "telegram:raw-chat-123".into(),
                "provider-thread:external-thread".into(),
            ],
            now + 2,
            None,
        ))
        .unwrap();
        db.upsert_mission_link(&MissionLink {
            link_id: "link-with-raw-channel-id-telegram-raw-chat-123".into(),
            mission_id: "mission-hub-projection".into(),
            work_item_id: Some("work-hub-route".into()),
            link_kind: MissionLinkKind::ChannelInbound,
            target_ref: "telegram:raw-chat-123:message-99".into(),
            proof_ref: Some("audit://channel-redacted".into()),
            created_at_ms: now + 3,
        })
        .unwrap();
        db.upsert_mission_link(&MissionLink {
            link_id: "link-memory-candidate".into(),
            mission_id: "mission-hub-projection".into(),
            work_item_id: None,
            link_kind: MissionLinkKind::MemoryCandidate,
            target_ref: "memory-candidate://raw-private-candidate".into(),
            proof_ref: None,
            created_at_ms: now + 4,
        })
        .unwrap();
        for (surface_thread_id, surface_kind, visibility_policy) in [
            (
                "surface-mobile",
                SurfaceKind::Mobile,
                VisibilityPolicy::Compact,
            ),
            (
                "surface-desktop",
                SurfaceKind::Desktop,
                VisibilityPolicy::RichProof,
            ),
        ] {
            db.upsert_surface_thread(&SurfaceThread {
                surface_thread_id: surface_thread_id.into(),
                friday_conversation_id: "fconv_hub_projection".into(),
                mission_id: Some("mission-hub-projection".into()),
                surface_kind,
                channel_binding_id: None,
                delivery_route: surface_thread_id.into(),
                visibility_policy,
                allowed_actions: vec!["open".into()],
                last_seen_at_ms: Some(now),
                last_delivered_event_seq: None,
                created_at_ms: now,
                updated_at_ms: now,
            })
            .unwrap();
        }
        db.upsert_surface_event(&SurfaceEvent {
            surface_event_id: "surf-event-mobile-1".into(),
            friday_conversation_id: "fconv_hub_projection".into(),
            mission_id: "mission-hub-projection".into(),
            work_item_id: Some("work-hub-route".into()),
            surface_thread_id: "surface-mobile".into(),
            source_surface: SurfaceKind::Mobile,
            event_kind: SurfaceEventKind::UserMessage,
            body_ref: Some("friday://body/mobile-message/1".into()),
            visibility_policy: VisibilityPolicy::Compact,
            proof_ref: Some("audit://surface-event-redacted".into()),
            created_at_ms: now + 5,
        })
        .unwrap();
    }

    fn seed_context_passport_mission(db: &Db, owner: &str, mission_id: &str) {
        let now = 1_700_004_000_000;
        let conversation_id = format!("fconv_{mission_id}");
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: conversation_id.clone(),
            owner_principal: owner.into(),
            title: "Context passport owner scope".into(),
            current_focus_summary: "context passport transfer should stay owner scoped".into(),
            active_mission_ids: vec![mission_id.into()],
            surface_thread_ids: Vec::new(),
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: vec!["proof://context-passport-owner-scope".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: mission_id.into(),
            friday_conversation_id: conversation_id,
            title: "Context passport owner scope".into(),
            intent: "prove cross-owner context passport transfer is blocked".into(),
            status: MissionStatus::Active,
            why_now: "Context passports carry refs across execution lanes.".into(),
            decision_path_summary: "Seeded directly for owner-binding regression.".into(),
            considered_options: vec![
                "allow raw mission_id".into(),
                "bind to authenticated owner".into(),
            ],
            deferred_options: Vec::new(),
            known_pitfalls: vec!["mission_id alone is not an owner proof".into()],
            handoff_inheritance: Vec::new(),
            work_item_ids: Vec::new(),
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://context-passport-owner-scope".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
    }

    fn context_passport_request(
        mission_id: &str,
        passport_id: &str,
    ) -> ContextPassportTransferRequestWire {
        ContextPassportTransferRequestWire {
            passport_id: passport_id.into(),
            mission_id: mission_id.into(),
            work_item_id: None,
            destination_lane: "codex".into(),
            destination_target: Some("codex".into()),
            items: vec![friday_protocol::ContextPassportItemWire {
                kind: "summary".into(),
                label: "summary".into(),
                included: true,
                sensitive: false,
            }],
            approved_sensitive: false,
        }
    }

    fn provider_workspace_action_request() -> ProviderWorkspaceActionRequestWire {
        ProviderWorkspaceActionRequestWire {
            request_id: "provider-action-owner-scope".into(),
            friday_session_id: "friday-session-1".into(),
            provider: "codex".into(),
            action: "list_sessions".into(),
            capability_id: "provider.codex.list_sessions".into(),
            payload_ref: None,
            mission_context: Some(friday_protocol::ProviderWorkspaceMissionContextWire {
                friday_conversation_id: "fconv_provider_workspace".into(),
                mission_id: "mission-provider-workspace".into(),
                work_item_id: "work-provider-workspace".into(),
            }),
        }
    }

    #[test]
    fn provider_workspace_action_blocks_without_authenticated_owner_binding() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_provider_workspace_mission(&db);
        db.upsert_provider_session_link(&provider_session_link())
            .unwrap();

        let response = provider_workspace_action_result_for_db(
            &db,
            "provider-action-owner-scope",
            provider_workspace_action_request(),
            1_700_004_030_000,
        );

        let Message::ProviderWorkspaceActionResult { result } = response.message else {
            panic!("expected ProviderWorkspaceActionResult, got {response:?}");
        };
        assert_eq!(result.status, "mission_owner_mismatch");
        assert!(!result.accepted);
        assert!(!result.routed);
        assert_eq!(
            result.blocker.as_deref(),
            Some("provider workspace action blocked: target Mission is not owned by the authenticated owner"),
        );
    }

    #[test]
    fn provider_workspace_action_allows_authenticated_mission_owner() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_provider_workspace_mission(&db);
        db.upsert_provider_session_link(&provider_session_link())
            .unwrap();

        let response = provider_workspace_action_result_for_db_as_owner(
            &db,
            "provider-action-owner-ok",
            provider_workspace_action_request(),
            Some("owner-1"),
            1_700_004_040_000,
        );

        let Message::ProviderWorkspaceActionResult { result } = response.message else {
            panic!("expected ProviderWorkspaceActionResult, got {response:?}");
        };
        assert_eq!(result.status, "implemented_unproven");
        assert!(!result.accepted);
        assert!(!result.routed);
        assert!(result.blocker.is_some());
    }

    #[test]
    fn context_passport_transfer_blocks_mission_without_authenticated_owner_binding() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_context_passport_mission(&db, "principal:victim", "mission-passport-victim");

        let response = context_passport_transfer_result_for_db(
            &db,
            "passport-cross-owner",
            context_passport_request("mission-passport-victim", "passport-cross-owner"),
            1_700_004_010_000,
        );

        let Message::ContextPassportTransferResult { result } = response.message else {
            panic!("expected ContextPassportTransferResult, got {response:?}");
        };
        assert_eq!(result.status, "blocked");
        assert_eq!(result.blocker.as_deref(), Some("mission_owner_mismatch"));
        assert!(
            db.get_mission("mission-passport-victim")
                .unwrap()
                .expect("seeded mission")
                .context_passport_refs
                .is_empty(),
            "blocked cross-owner transfer must not mutate mission refs"
        );
    }

    #[test]
    fn context_passport_transfer_allows_authenticated_mission_owner() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_context_passport_mission(&db, "principal:owner", "mission-passport-owner");

        let response = context_passport_transfer_result_for_db_as_owner(
            &db,
            "passport-owner",
            context_passport_request("mission-passport-owner", "passport-owner"),
            Some("principal:owner"),
            1_700_004_020_000,
        );

        let Message::ContextPassportTransferResult { result } = response.message else {
            panic!("expected ContextPassportTransferResult, got {response:?}");
        };
        assert_eq!(result.status, "confirmed");
        assert_eq!(result.blocker, None);
        assert_eq!(result.shared_item_count, 1);
        assert!(
            db.get_mission("mission-passport-owner")
                .unwrap()
                .expect("seeded mission")
                .context_passport_refs
                .contains(&"passport-owner".to_string()),
            "the authenticated owner path should still attach the passport ref"
        );
    }

    fn seed_mission_ask(db: &Db) {
        let now = 1_700_000_100_000;
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: "fconv_hub_ask".into(),
            owner_principal: "owner-1".into(),
            title: "Ask Friday from Mission".into(),
            current_focus_summary: "Ask should attach to the Mission timeline".into(),
            active_mission_ids: vec!["mission-hub-ask".into()],
            surface_thread_ids: vec!["surface-mobile-ask".into(), "surface-desktop-ask".into()],
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: Vec::new(),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: "mission-hub-ask".into(),
            friday_conversation_id: "fconv_hub_ask".into(),
            title: "Mission-bound Ask Friday".into(),
            intent: "prove Ask Friday is not detached ledger state".into(),
            status: MissionStatus::Active,
            why_now: "mobile and desktop need the same Mission proof after an ask".into(),
            decision_path_summary: "Route DeepSeek ask through Mission context".into(),
            considered_options: vec!["detached ask ledger".into(), "Mission-bound ask".into()],
            deferred_options: vec!["native UI rendering".into()],
            known_pitfalls: vec!["token ledger alone is not product timeline".into()],
            handoff_inheritance: vec!["ask proof attaches to WorkItem".into()],
            work_item_ids: vec!["work-hub-ask".into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: Vec::new(),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_work_item(&WorkItem {
            work_item_id: "work-hub-ask".into(),
            mission_id: "mission-hub-ask".into(),
            lane: WorkLane::DeepSeek,
            target_provider_or_agent: Some("deepseek".into()),
            status: WorkItemStatus::ReadyToDispatch,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("ask_friday.deepseek".into()),
            risk_level: friday_core::Risk::Low,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["friday://body/ask".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["ledgered ask receipt".into()],
            proof_receipts: Vec::new(),
            judgment_memory: HandoffJudgmentMemory {
                task: "Answer through Friday's DeepSeek route".into(),
                current_blocker: None,
                target_lane_thread_agent_provider: "deepseek".into(),
                read_first_files: Vec::new(),
                required_output: "ledgered ask result attached to Mission".into(),
                done_criteria: vec!["WorkItem completed only with proof".into()],
                red_lines: vec!["do not create detached ask state".into()],
                why_this_route: "The user's ask is part of this Mission's decision path.".into(),
                considered_options: vec![
                    "plain AskFridayRequest".into(),
                    "Mission-bound ask".into(),
                ],
                deferred_options: vec!["provider-native sync".into()],
                previous_pitfalls: vec!["ledger without Mission proof is hard to inspect".into()],
                inheritable_context: vec!["same Mission must render on mobile and desktop".into()],
                proof_requirements: vec!["ledgered ask receipt".into()],
                ownership_claim_ids: Vec::new(),
            },
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        for (surface_thread_id, surface_kind, visibility_policy) in [
            (
                "surface-mobile-ask",
                SurfaceKind::Mobile,
                VisibilityPolicy::Compact,
            ),
            (
                "surface-desktop-ask",
                SurfaceKind::Desktop,
                VisibilityPolicy::RichProof,
            ),
        ] {
            db.upsert_surface_thread(&SurfaceThread {
                surface_thread_id: surface_thread_id.into(),
                friday_conversation_id: "fconv_hub_ask".into(),
                mission_id: Some("mission-hub-ask".into()),
                surface_kind,
                channel_binding_id: None,
                delivery_route: surface_thread_id.into(),
                visibility_policy,
                allowed_actions: vec!["ask_friday".into()],
                last_seen_at_ms: Some(now),
                last_delivered_event_seq: None,
                created_at_ms: now,
                updated_at_ms: now,
            })
            .unwrap();
        }
    }

    fn pressure_judgment(index: usize) -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: format!("Mission-bound pressure ask {index}"),
            current_blocker: None,
            target_lane_thread_agent_provider: "deepseek".into(),
            read_first_files: vec!["rust-core/crates/friday-hub/src/hub_server.rs".into()],
            required_output: "proof-backed ask receipt".into(),
            done_criteria: vec!["WorkItem reaches completed_with_proof only after proof".into()],
            red_lines: vec!["do not fallback to another provider".into()],
            why_this_route: "Pressure asks must remain attached to one Mission.".into(),
            considered_options: vec!["detached ask ledger".into(), "Mission-bound ask".into()],
            deferred_options: vec!["provider-native sync".into()],
            previous_pitfalls: vec!["provider ack looked like done".into()],
            inheritable_context: vec!["same Mission renders on mobile and desktop".into()],
            proof_requirements: vec!["ledger/activity/audit proof".into()],
            ownership_claim_ids: Vec::new(),
        }
    }

    fn seed_pressure_mission(db: &Db, asks: usize) {
        let now = 1_700_000_300_000;
        let work_item_ids: Vec<String> = (0..asks)
            .map(|index| format!("work-pressure-{index:02}"))
            .collect();
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: "fconv_pressure".into(),
            owner_principal: "owner-1".into(),
            title: "Mission pressure proof".into(),
            current_focus_summary: "mobile/desktop/channel inputs resolve to one Mission".into(),
            active_mission_ids: vec!["mission-pressure".into()],
            surface_thread_ids: vec![
                "surface-pressure-mobile".into(),
                "surface-pressure-desktop".into(),
                "surface-pressure-channel".into(),
            ],
            memory_scope_ref: Some("memory-scope://pressure".into()),
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: Vec::new(),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: "mission-pressure".into(),
            friday_conversation_id: "fconv_pressure".into(),
            title: "Pressure Mission-bound asks".into(),
            intent: "prove repeated asks attach to one Friday Mission".into(),
            status: MissionStatus::Active,
            why_now: "Long-running Friday work needs pressure proof, not one happy path.".into(),
            decision_path_summary: "Route every ask through Mission context and proof receipts."
                .into(),
            considered_options: vec![
                "chat-first pressure".into(),
                "Mission-bound pressure".into(),
            ],
            deferred_options: vec!["native UI screenshots".into()],
            known_pitfalls: vec![
                "long timeline hydration".into(),
                "candidate memory drift".into(),
            ],
            handoff_inheritance: vec!["bounded timeline is the read contract".into()],
            work_item_ids: work_item_ids.clone(),
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: Vec::new(),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        for (surface_thread_id, surface_kind, visibility_policy, route) in [
            (
                "surface-pressure-mobile",
                SurfaceKind::Mobile,
                VisibilityPolicy::Compact,
                "mobile",
            ),
            (
                "surface-pressure-desktop",
                SurfaceKind::Desktop,
                VisibilityPolicy::RichProof,
                "desktop",
            ),
            (
                "surface-pressure-channel",
                SurfaceKind::Telegram,
                VisibilityPolicy::StatusOnly,
                "telegram",
            ),
        ] {
            db.upsert_surface_thread(&SurfaceThread {
                surface_thread_id: surface_thread_id.into(),
                friday_conversation_id: "fconv_pressure".into(),
                mission_id: Some("mission-pressure".into()),
                surface_kind,
                channel_binding_id: (surface_kind == SurfaceKind::Telegram)
                    .then(|| "tg:pressure-room".into()),
                delivery_route: route.into(),
                visibility_policy,
                allowed_actions: vec!["ask_friday".into(), "open_mission".into()],
                last_seen_at_ms: Some(now),
                last_delivered_event_seq: Some(0),
                created_at_ms: now,
                updated_at_ms: now,
            })
            .unwrap();
        }
        for (index, work_item_id) in work_item_ids.iter().enumerate() {
            db.upsert_work_item(&WorkItem {
                work_item_id: work_item_id.clone(),
                mission_id: "mission-pressure".into(),
                lane: WorkLane::DeepSeek,
                target_provider_or_agent: Some("deepseek".into()),
                status: WorkItemStatus::ReadyToDispatch,
                owner_claim_ids: Vec::new(),
                workspace_refs: Vec::new(),
                capability_id: Some("ask_friday.deepseek".into()),
                risk_level: friday_core::Risk::Low,
                approval_state: ApprovalState::NotRequired,
                blocking_reason: None,
                input_refs: vec![format!("friday://body/pressure-ask/{index:02}")],
                output_refs: Vec::new(),
                proof_requirements: vec!["ledgered ask receipt".into()],
                proof_receipts: Vec::new(),
                judgment_memory: pressure_judgment(index),
                created_at_ms: now + index as i64,
                updated_at_ms: now + index as i64,
            })
            .unwrap();
        }
        db.upsert_surface_event(&SurfaceEvent {
            surface_event_id: "surface-pressure-mobile-msg".into(),
            friday_conversation_id: "fconv_pressure".into(),
            mission_id: "mission-pressure".into(),
            work_item_id: Some("work-pressure-00".into()),
            surface_thread_id: "surface-pressure-mobile".into(),
            source_surface: SurfaceKind::Mobile,
            event_kind: SurfaceEventKind::UserMessage,
            body_ref: Some("friday://body/mobile-pressure-input".into()),
            visibility_policy: VisibilityPolicy::Compact,
            proof_ref: Some("audit://surface/pressure-mobile".into()),
            created_at_ms: now + 10_000,
        })
        .unwrap();
        memory::record_candidate(
            db.conn(),
            &memory::NewMemoryCandidate {
                memory_id: "mem-pressure-candidate",
                scope: MemoryScope::Project,
                content_ref: Some("friday://memory-candidate/pressure"),
                content: Some("Candidate pressure fact; must not become durable automatically."),
                principal_id: Some("owner-1"),
                sensitive: false,
                created_at: now + 11_000,
            },
        )
        .unwrap();
        crate::mission_preflight::attach_memory_candidate_ref(
            db,
            "mission-pressure",
            "mem-pressure-candidate",
            now + 11_100,
        )
        .unwrap();
    }

    /// Headless e2e over real loopback TCP + the sealed WS transport + a mock DeepSeek:
    /// connect → status (no model call) → ask (one model call → ledger/activity/audit) →
    /// reconnect → status (still no extra model call). Proves the call discipline + safe
    /// projection end to end.
    #[test]
    fn headless_e2e_status_is_pure_detached_ask_is_blocked() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let hub_kp = DeviceKeypair::generate();
        let phone_kp = DeviceKeypair::generate();
        let hub_pub = hub_kp.public_bytes();
        let phone_pub = phone_kp.public_bytes();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_calls = calls.clone();
        let server_db = db_path.clone();
        let srv = thread::spawn(move || {
            let session = hub_kp.agree(&phone_pub);
            let mut hub = server(server_calls, &server_db);
            // Serve TWO connections (the second = reconnect).
            for _ in 0..2 {
                let (stream, _) = listener.accept().unwrap();
                let mut ws = ws_accept(stream).unwrap();
                let mut clock = || 1000i64;
                hub.serve_connection(&mut ws, &session, AAD, &mut clock)
                    .unwrap();
            }
        });

        let session = phone_kp.agree(&hub_pub);

        // --- connection 1: status (pure) then ask (model) ---
        {
            let stream = TcpStream::connect(addr).unwrap();
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();

            // status → pure, zero provider calls so far
            let status_req = Envelope::new(
                "c1-status",
                1,
                Message::HubStatus {
                    online: false,
                    capabilities: vec![],
                    min_version: SUPPORTED.min,
                    max_version: SUPPORTED.max,
                },
            );
            ws_send_envelope(&mut ws, &session, &status_req, AAD).unwrap();
            let status_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            assert!(matches!(
                status_resp.message,
                Message::HubStatus { online: true, .. }
            ));
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "status must make ZERO provider calls"
            );

            // Detached ask → explicit blocker; no provider call, no ledger/activity.
            let ask_req = Envelope::new(
                "c1-ask",
                2,
                Message::AskFridayRequest {
                    prompt: "hello friday".into(),
                    mission_context: None,
                },
            );
            ws_send_envelope(&mut ws, &session, &ask_req, AAD).unwrap();
            let ask_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            match &ask_resp.message {
                Message::Error { code, message } => {
                    assert_eq!(*code, ErrorCode::Internal);
                    assert!(message.contains("requires Mission context"));
                }
                other => panic!("expected detached-ask blocker, got {other:?}"),
            }
            // SAFE PROJECTION: the raw answer text must NOT appear anywhere in the wire response.
            assert!(
                !format!("{ask_resp:?}").contains("SECRET-ANSWER-TEXT"),
                "raw answer leaked to the wire"
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "detached ask must not reach the DeepSeek route"
            );
        } // client 1 disconnects → serve_connection returns

        let calls_after_ask = calls.load(Ordering::SeqCst);

        // --- connection 2: reconnect + status → still no extra provider call ---
        {
            let stream = TcpStream::connect(addr).unwrap();
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
            let status_req = Envelope::new(
                "c2-status",
                3,
                Message::HubStatus {
                    online: false,
                    capabilities: vec![],
                    min_version: SUPPORTED.min,
                    max_version: SUPPORTED.max,
                },
            );
            ws_send_envelope(&mut ws, &session, &status_req, AAD).unwrap();
            let resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            assert!(matches!(
                resp.message,
                Message::HubStatus { online: true, .. }
            ));
        }
        srv.join().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            calls_after_ask,
            "reconnect/status must make NO extra provider call"
        );

        // Hub-side: detached ask is blocked before provider/ledger/audit state.
        let db = Db::open_hub(&db_path).unwrap();
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("activity_item").unwrap(), 0);
        assert_eq!(db.count("audit_ledger").unwrap(), 0);
    }

    /// Headless Mission E2E over real loopback TCP + sealed WS transport:
    /// mobile sends a Mission-bound ask; desktop reconnects and reads the same
    /// Mission projection + bounded timeline. Projection/timeline/status are pure
    /// reads, so the only provider calls are the ask's discover+post.
    #[test]
    fn headless_e2e_mission_bound_mobile_ask_desktop_reconnect_reads_same_result() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        {
            let db = Db::open_hub(&db_path).unwrap();
            seed_pressure_mission(&db, 2);
        }
        let hub_kp = DeviceKeypair::generate();
        let phone_kp = DeviceKeypair::generate();
        let hub_pub = hub_kp.public_bytes();
        let phone_pub = phone_kp.public_bytes();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_calls = calls.clone();
        let server_db = db_path.clone();
        let srv = thread::spawn(move || {
            let session = hub_kp.agree(&phone_pub);
            let db = Db::open_hub(&server_db).unwrap();
            let client = DeepSeekClient::with_transport(
                CountingMock {
                    calls: server_calls,
                },
                "test-key-not-real".to_string(), // pragma: allowlist secret
            );
            let mut hub = HubServer::new(
                db,
                client,
                vec![
                    "ask_friday".into(),
                    "mission_projection".into(),
                    "mission_timeline".into(),
                    "status".into(),
                ],
                64,
            );
            for _ in 0..2 {
                let (stream, _) = listener.accept().unwrap();
                let mut ws = ws_accept(stream).unwrap();
                let mut now = 1_700_000_900_000i64;
                let mut clock = || {
                    now += 1;
                    now
                };
                hub.serve_connection(&mut ws, &session, AAD, &mut clock)
                    .unwrap();
            }
        });

        let session = phone_kp.agree(&hub_pub);

        // Connection 1: mobile input asks through a concrete Mission context.
        let proof_ref = {
            let stream = TcpStream::connect(addr).unwrap();
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
            let ask_req = Envelope::new(
                "wire-mobile-ask",
                1,
                Message::AskFridayRequest {
                    prompt: "Mobile Mission input: answer with proof only.".into(),
                    mission_context: Some(MissionWorkItemContextWire {
                        friday_conversation_id: "fconv_pressure".into(),
                        mission_id: "mission-pressure".into(),
                        work_item_id: "work-pressure-00".into(),
                    }),
                },
            );
            ws_send_envelope(&mut ws, &session, &ask_req, AAD).unwrap();
            let ask_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            let debug = format!("{ask_resp:?}");
            let Message::AskFridayResult {
                ledger_id,
                result_link,
            } = ask_resp.message
            else {
                panic!("expected Mission-bound ask result, got {ask_resp:?}");
            };
            assert_eq!(ledger_id, "ask-wire-mobile-ask-1");
            let proof_ref = result_link.expect("Mission-bound ask proof link");
            assert_eq!(
                proof_ref,
                "friday://activity/ask-wire-mobile-ask-1:activity"
            );
            for forbidden in ["SECRET-ANSWER-TEXT", "test-key-not-real", "Authorization"] {
                assert!(
                    !debug.contains(forbidden),
                    "wire Mission-bound ask leaked {forbidden}: {debug}"
                );
            }
            proof_ref
        };
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "mobile Mission-bound ask should discover + post exactly once"
        );
        let calls_after_mobile_ask = calls.load(Ordering::SeqCst);

        // Connection 2: desktop/reconnect reads status + shared Mission proof.
        {
            let stream = TcpStream::connect(addr).unwrap();
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
            let status_req = Envelope::new(
                "wire-desktop-status",
                2,
                Message::HubStatus {
                    online: false,
                    capabilities: vec![],
                    min_version: SUPPORTED.min,
                    max_version: SUPPORTED.max,
                },
            );
            ws_send_envelope(&mut ws, &session, &status_req, AAD).unwrap();
            let status_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            assert!(matches!(
                status_resp.message,
                Message::HubStatus { online: true, .. }
            ));
            assert_eq!(
                calls.load(Ordering::SeqCst),
                calls_after_mobile_ask,
                "reconnect status must not call provider/model"
            );

            let projection_req = Envelope::new(
                "wire-desktop-projection",
                3,
                Message::MissionProjectionRequest {
                    request: friday_protocol::MissionProjectionRequestWire {
                        friday_conversation_id: "fconv_pressure".into(),
                    },
                },
            );
            ws_send_envelope(&mut ws, &session, &projection_req, AAD).unwrap();
            let projection_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            let Message::MissionProjectionSnapshot { snapshot } = projection_resp.message else {
                panic!("expected Mission projection after reconnect, got {projection_resp:?}");
            };
            assert_eq!(snapshot.projections.len(), 3);
            for surface in ["mobile", "desktop", "telegram"] {
                assert!(
                    snapshot.projections.iter().any(|projection| {
                        projection.surface_kind == surface
                            && projection.mission_id == "mission-pressure"
                            && projection.status == "active"
                    }),
                    "{surface} should read the same Mission after mobile ask"
                );
            }
            assert!(snapshot.route_decisions.iter().any(|route| {
                route.work_item_id == "work-pressure-00"
                    && route.selected_lane == "deepseek"
                    && route.selected_target_label.as_deref() == Some("deepseek")
            }));
            let debug = format!("{snapshot:?}");
            for forbidden in [
                "SECRET-ANSWER-TEXT",
                "test-key-not-real",
                "tg:pressure-room",
                "Candidate pressure fact",
                "raw transcript",
                "sk-test",
            ] {
                assert!(
                    !debug.contains(forbidden),
                    "wire Mission projection leaked {forbidden}: {debug}"
                );
            }

            let mut cursor = None;
            let mut pages = 0usize;
            let mut provider_link_seen = false;
            let mut memory_candidate_seen = false;
            let mut mobile_event_seen = false;
            let mut completed_work_seen = false;
            loop {
                let timeline_req = Envelope::new(
                    format!("wire-desktop-timeline-{pages}"),
                    4 + pages as i64,
                    Message::MissionTimelineRequest {
                        request: friday_protocol::MissionTimelineRequestWire {
                            friday_conversation_id: "fconv_pressure".into(),
                            mission_id: "mission-pressure".into(),
                            cursor: cursor.clone(),
                            limit: Some(2),
                        },
                    },
                );
                ws_send_envelope(&mut ws, &session, &timeline_req, AAD).unwrap();
                let timeline_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
                let Message::MissionTimelineSnapshot { snapshot } = timeline_resp.message else {
                    panic!("expected bounded Mission timeline, got {timeline_resp:?}");
                };
                assert!(snapshot.bounded);
                assert_eq!(snapshot.work_items.len(), 2);
                completed_work_seen |= snapshot.work_items.iter().any(|item| {
                    item.work_item_id == "work-pressure-00"
                        && item.status == "completed_with_proof"
                        && item.proof_receipts.contains(&proof_ref)
                });
                provider_link_seen |= snapshot.links.iter().any(|link| {
                    link.link_kind == "provider_timeline"
                        && link.has_proof
                        && link.proof_ref.as_deref() == Some(proof_ref.as_str())
                });
                memory_candidate_seen |= snapshot.links.iter().any(|link| {
                    link.link_kind == "memory_candidate" && !link.grants_memory_authority
                });
                mobile_event_seen |= snapshot
                    .surface_events
                    .iter()
                    .any(|event| event.source_surface == "mobile");
                let debug = format!("{snapshot:?}");
                for forbidden in [
                    "SECRET-ANSWER-TEXT",
                    "test-key-not-real",
                    "Candidate pressure fact",
                    "raw transcript",
                    "sk-test",
                ] {
                    assert!(
                        !debug.contains(forbidden),
                        "wire Mission timeline leaked {forbidden}: {debug}"
                    );
                }
                pages += 1;
                if snapshot.has_more {
                    cursor = snapshot.next_cursor.clone();
                    assert!(cursor.is_some());
                } else {
                    assert_eq!(snapshot.next_cursor, None);
                    break;
                }
            }
            assert!(pages > 1, "bounded wire timeline should page");
            assert!(completed_work_seen);
            assert!(provider_link_seen);
            assert!(memory_candidate_seen);
            assert!(mobile_event_seen);
            assert_eq!(
                calls.load(Ordering::SeqCst),
                calls_after_mobile_ask,
                "desktop projection/timeline reads must make zero provider/model calls"
            );
        }
        srv.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), calls_after_mobile_ask);

        let db = Db::open_hub(&db_path).unwrap();
        assert_eq!(db.count("token_ledger").unwrap(), 1);
        assert_eq!(db.count("activity_item").unwrap(), 1);
        assert_eq!(memory::auto_usable(db.conn()).unwrap().len(), 0);
        assert_eq!(
            db.get_work_item("work-pressure-00")
                .unwrap()
                .unwrap()
                .status,
            WorkItemStatus::CompletedWithProof
        );
        assert_eq!(
            db.get_work_item("work-pressure-01")
                .unwrap()
                .unwrap()
                .status,
            WorkItemStatus::ReadyToDispatch
        );
    }

    /// Headless Mission-bound ask over sealed WS + the real `UreqTransport`
    /// pointed at a DeepSeek-compatible loopback HTTP provider. This is not a
    /// live DeepSeek account proof, but it proves the Hub success path crosses
    /// the actual HTTP transport, JSON provider response parsing, ledger write,
    /// proof attachment, and refs-only timeline projection.
    #[test]
    fn headless_e2e_mission_bound_ask_uses_real_ureq_transport_loopback_provider() {
        let db_path = tmp_db();
        {
            let db = Db::open_hub(&db_path).unwrap();
            seed_mission_ask(&db);
        }
        let (provider_base_url, provider_requests, provider_srv) =
            serve_deepseek_http_models_and_chat_once();
        let hub_kp = DeviceKeypair::generate();
        let phone_kp = DeviceKeypair::generate();
        let hub_pub = hub_kp.public_bytes();
        let phone_pub = phone_kp.public_bytes();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_db = db_path.clone();
        let srv = thread::spawn(move || {
            let session = hub_kp.agree(&phone_pub);
            let db = Db::open_hub(&server_db).unwrap();
            let client = DeepSeekClient::with_transport_and_base_url(
                friday_deepseek::UreqTransport::new(),
                "test-key-not-real".to_string(), // pragma: allowlist secret
                provider_base_url,
            );
            let mut hub = HubServer::new(
                db,
                client,
                vec!["ask_friday".into(), "mission_timeline".into()],
                64,
            );
            let (stream, _) = listener.accept().unwrap();
            let mut ws = ws_accept(stream).unwrap();
            let mut now = 1_700_001_200_000i64;
            let mut clock = || {
                now += 1;
                now
            };
            hub.serve_connection(&mut ws, &session, AAD, &mut clock)
                .unwrap();
        });

        let session = phone_kp.agree(&hub_pub);
        let proof_ref = {
            let stream = TcpStream::connect(addr).unwrap();
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
            let ask_req = Envelope::new(
                "wire-real-http-mobile-ask",
                1,
                Message::AskFridayRequest {
                    prompt: "Real Ureq loopback provider proof. Keep output refs-only.".into(),
                    mission_context: Some(MissionWorkItemContextWire {
                        friday_conversation_id: "fconv_hub_ask".into(),
                        mission_id: "mission-hub-ask".into(),
                        work_item_id: "work-hub-ask".into(),
                    }),
                },
            );
            ws_send_envelope(&mut ws, &session, &ask_req, AAD).unwrap();
            let ask_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            let debug = format!("{ask_resp:?}");
            let Message::AskFridayResult {
                ledger_id,
                result_link,
            } = ask_resp.message
            else {
                panic!("expected real-transport Mission ask result, got {ask_resp:?}");
            };
            assert_eq!(ledger_id, "ask-wire-real-http-mobile-ask-1");
            let proof_ref = result_link.expect("proof activity link");
            assert_eq!(
                proof_ref,
                "friday://activity/ask-wire-real-http-mobile-ask-1:activity"
            );
            for forbidden in [
                "SECRET-HTTP-ANSWER-TEXT",
                "test-key-not-real",
                "Authorization",
                "Bearer",
            ] {
                assert!(
                    !debug.contains(forbidden),
                    "real HTTP ask response leaked {forbidden}: {debug}"
                );
            }

            let timeline_req = Envelope::new(
                "wire-real-http-timeline",
                2,
                Message::MissionTimelineRequest {
                    request: friday_protocol::MissionTimelineRequestWire {
                        friday_conversation_id: "fconv_hub_ask".into(),
                        mission_id: "mission-hub-ask".into(),
                        cursor: None,
                        limit: Some(10),
                    },
                },
            );
            ws_send_envelope(&mut ws, &session, &timeline_req, AAD).unwrap();
            let timeline_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            let Message::MissionTimelineSnapshot { snapshot } = timeline_resp.message else {
                panic!("expected real-transport timeline, got {timeline_resp:?}");
            };
            assert!(snapshot.bounded);
            assert_eq!(snapshot.work_items.len(), 1);
            assert!(snapshot.work_items.iter().any(|item| {
                item.work_item_id == "work-hub-ask"
                    && item.status == "completed_with_proof"
                    && item.proof_receipts.contains(&proof_ref)
            }));
            assert!(snapshot.links.iter().any(|link| {
                link.link_kind == "provider_timeline"
                    && link.has_proof
                    && link.proof_ref.as_deref() == Some(proof_ref.as_str())
            }));
            let debug = format!("{snapshot:?}");
            for forbidden in [
                "SECRET-HTTP-ANSWER-TEXT",
                "test-key-not-real",
                "Authorization",
                "Bearer",
            ] {
                assert!(
                    !debug.contains(forbidden),
                    "real HTTP timeline leaked {forbidden}: {debug}"
                );
            }
            proof_ref
        };
        srv.join().unwrap();
        provider_srv.join().unwrap();

        let requests = provider_requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].path, "/models");
        assert_eq!(
            requests[0].authorization.as_deref(),
            Some("Bearer test-key-not-real")
        );
        assert_eq!(requests[1].method, "POST");
        assert_eq!(requests[1].path, "/chat/completions");
        assert_eq!(
            requests[1].authorization.as_deref(),
            Some("Bearer test-key-not-real")
        );
        assert!(requests[1].body.contains("deepseek-v4-flash"));
        assert!(requests[1]
            .body
            .contains("Real Ureq loopback provider proof"));
        assert!(requests[1].body.contains("\"stream\":false"));
        drop(requests);

        let db = Db::open_hub(&db_path).unwrap();
        assert_eq!(db.count("token_ledger").unwrap(), 1);
        assert_eq!(db.count("activity_item").unwrap(), 1);
        assert_eq!(memory::auto_usable(db.conn()).unwrap().len(), 0);
        let work = db
            .get_work_item("work-hub-ask")
            .unwrap()
            .expect("real HTTP work item");
        assert_eq!(work.status, WorkItemStatus::CompletedWithProof);
        assert_eq!(work.proof_receipts, vec![proof_ref]);
    }

    /// Real HTTP transport pressure proof: 20 Mission-bound asks through the
    /// actual `UreqTransport` against a DeepSeek-compatible loopback provider.
    /// This keeps the pressure/no-leak/no-fallback/timeline guarantees while
    /// replacing the scripted provider transport with real HTTP request/response
    /// parsing. It is still not an external DeepSeek-account live proof.
    #[test]
    fn mission_bound_ask_real_ureq_transport_pressure_loop_paginates_and_redacts() {
        const ASK_COUNT: usize = 50;
        let db_path = tmp_db();
        let db = Db::open_hub(&db_path).unwrap();
        seed_pressure_mission(&db, ASK_COUNT);
        let (provider_base_url, provider_requests, provider_srv) =
            serve_deepseek_http_models_and_chat_requests(ASK_COUNT * 2);
        let client = DeepSeekClient::with_transport_and_base_url(
            friday_deepseek::UreqTransport::new(),
            "test-key-not-real".to_string(), // pragma: allowlist secret
            provider_base_url,
        );
        let mut hub = HubServer::new(
            db,
            client,
            vec![
                "ask_friday".into(),
                "mission_projection".into(),
                "mission_timeline".into(),
            ],
            64,
        );

        let mut proof_refs = Vec::new();
        for index in 0..ASK_COUNT {
            let response = hub.dispatch(
                Envelope::new(
                    format!("real-http-pressure-ask-{index:02}"),
                    index as i64,
                    Message::AskFridayRequest {
                        prompt: format!(
                            "Real HTTP Mission pressure ask {index:02}. Return refs only."
                        ),
                        mission_context: Some(MissionWorkItemContextWire {
                            friday_conversation_id: "fconv_pressure".into(),
                            mission_id: "mission-pressure".into(),
                            work_item_id: format!("work-pressure-{index:02}"),
                        }),
                    },
                ),
                1_700_001_300_000 + index as i64,
            );
            let debug = format!("{response:?}");
            let Message::AskFridayResult {
                ledger_id,
                result_link,
            } = response.message
            else {
                panic!("expected real HTTP pressure ask result, got {response:?}");
            };
            assert_eq!(
                ledger_id,
                format!("ask-real-http-pressure-ask-{index:02}-{}", index + 1)
            );
            let proof_ref = result_link.expect("proof activity link");
            assert!(proof_ref.starts_with("friday://activity/"));
            proof_refs.push(proof_ref);
            for forbidden in [
                "SECRET-HTTP-ANSWER-TEXT",
                "test-key-not-real",
                "Authorization",
                "Bearer",
                "sk-test",
            ] {
                assert!(
                    !debug.contains(forbidden),
                    "real HTTP pressure ask leaked {forbidden}: {debug}"
                );
            }
        }
        provider_srv.join().unwrap();

        {
            let requests = provider_requests.lock().unwrap();
            assert_eq!(requests.len(), ASK_COUNT * 2);
            for index in 0..ASK_COUNT {
                let get = &requests[index * 2];
                let post = &requests[index * 2 + 1];
                assert_eq!(get.method, "GET");
                assert_eq!(get.path, "/models");
                assert_eq!(
                    get.authorization.as_deref(),
                    Some("Bearer test-key-not-real")
                );
                assert_eq!(post.method, "POST");
                assert_eq!(post.path, "/chat/completions");
                assert_eq!(
                    post.authorization.as_deref(),
                    Some("Bearer test-key-not-real")
                );
                assert!(post.body.contains("deepseek-v4-flash"));
                assert!(post
                    .body
                    .contains(&format!("Real HTTP Mission pressure ask {index:02}")));
                assert!(post.body.contains("\"stream\":false"));
            }
        }

        assert_eq!(hub.db().count("token_ledger").unwrap(), ASK_COUNT as i64);
        assert_eq!(hub.db().count("activity_item").unwrap(), ASK_COUNT as i64);
        assert_eq!(memory::auto_usable(hub.db().conn()).unwrap().len(), 0);

        let projection = hub.dispatch(
            Envelope::new(
                "real-http-pressure-projection",
                500,
                Message::MissionProjectionRequest {
                    request: friday_protocol::MissionProjectionRequestWire {
                        friday_conversation_id: "fconv_pressure".into(),
                    },
                },
            ),
            1_700_001_400_000,
        );
        let Message::MissionProjectionSnapshot { snapshot } = projection.message else {
            panic!("expected real HTTP pressure projection, got {projection:?}");
        };
        assert_eq!(snapshot.projections.len(), 3);
        for surface in ["mobile", "desktop", "telegram"] {
            assert!(
                snapshot.projections.iter().any(|projection| {
                    projection.surface_kind == surface
                        && projection.mission_id == "mission-pressure"
                        && projection.status == "active"
                }),
                "{surface} projection should see one Mission after real HTTP pressure asks"
            );
        }
        let debug = format!("{snapshot:?}");
        for forbidden in [
            "SECRET-HTTP-ANSWER-TEXT",
            "test-key-not-real",
            "Authorization",
            "Bearer",
            "raw transcript",
            "sk-test",
        ] {
            assert!(
                !debug.contains(forbidden),
                "real HTTP pressure projection leaked {forbidden}: {debug}"
            );
        }

        let mut cursor = None;
        let mut pages = 0usize;
        let mut provider_link_count = 0usize;
        let mut memory_candidate_seen = false;
        loop {
            let timeline = hub.dispatch(
                Envelope::new(
                    format!("real-http-pressure-timeline-{pages}"),
                    600 + pages as i64,
                    Message::MissionTimelineRequest {
                        request: friday_protocol::MissionTimelineRequestWire {
                            friday_conversation_id: "fconv_pressure".into(),
                            mission_id: "mission-pressure".into(),
                            cursor: cursor.clone(),
                            limit: Some(17),
                        },
                    },
                ),
                1_700_001_500_000 + pages as i64,
            );
            let Message::MissionTimelineSnapshot { snapshot } = timeline.message else {
                panic!("expected real HTTP pressure timeline, got {timeline:?}");
            };
            assert!(snapshot.bounded);
            assert_eq!(snapshot.work_items.len(), ASK_COUNT);
            assert!(snapshot.work_items.iter().all(|item| {
                item.status == "completed_with_proof" && !item.proof_receipts.is_empty()
            }));
            provider_link_count += snapshot
                .links
                .iter()
                .filter(|link| link.link_kind == "provider_timeline" && link.has_proof)
                .count();
            memory_candidate_seen |= snapshot
                .links
                .iter()
                .any(|link| link.link_kind == "memory_candidate" && !link.grants_memory_authority);
            let debug = format!("{snapshot:?}");
            for forbidden in [
                "SECRET-HTTP-ANSWER-TEXT",
                "test-key-not-real",
                "Authorization",
                "Bearer",
                "raw transcript",
                "sk-test",
            ] {
                assert!(
                    !debug.contains(forbidden),
                    "real HTTP pressure timeline leaked {forbidden}: {debug}"
                );
            }
            pages += 1;
            if snapshot.has_more {
                cursor = snapshot.next_cursor.clone();
                assert!(cursor.is_some());
            } else {
                assert_eq!(snapshot.next_cursor, None);
                break;
            }
        }
        assert!(pages > 1, "real HTTP pressure timeline should page");
        assert_eq!(provider_link_count, ASK_COUNT);
        assert!(memory_candidate_seen);
        for proof_ref in proof_refs {
            let work_item_id = proof_ref
                .strip_prefix("friday://activity/ask-real-http-pressure-ask-")
                .and_then(|suffix| suffix.get(..2))
                .map(|index| format!("work-pressure-{index}"))
                .expect("proof ref index");
            let work = hub.db().get_work_item(&work_item_id).unwrap().unwrap();
            assert!(work.proof_receipts.contains(&proof_ref));
        }
    }

    /// Headless Mission intake E2E over real loopback TCP + sealed WS transport:
    /// mobile creates the Mission/WorkItem, then desktop + channel repeat the
    /// same intent and are bound to the existing Mission instead of writing task
    /// debt. This is pure Hub preflight: no provider/model calls.
    #[test]
    fn headless_e2e_mission_intake_mobile_create_desktop_channel_duplicate_bind_same_mission() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let hub_kp = DeviceKeypair::generate();
        let phone_kp = DeviceKeypair::generate();
        let hub_pub = hub_kp.public_bytes();
        let phone_pub = phone_kp.public_bytes();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_calls = calls.clone();
        let server_db = db_path.clone();
        let srv = thread::spawn(move || {
            let session = hub_kp.agree(&phone_pub);
            let db = Db::open_hub(&server_db).unwrap();
            let client = DeepSeekClient::with_transport(
                CountingMock {
                    calls: server_calls,
                },
                "test-key-not-real".to_string(), // pragma: allowlist secret
            );
            let mut hub = HubServer::new(
                db,
                client,
                vec![
                    "ask_friday".into(),
                    "mission_intake".into(),
                    "mission_projection".into(),
                    "status".into(),
                ],
                64,
            );
            for _ in 0..2 {
                let (stream, _) = listener.accept().unwrap();
                let mut ws = ws_accept(stream).unwrap();
                let mut now = 1_700_001_000_000i64;
                let mut clock = || {
                    now += 1;
                    now
                };
                hub.serve_connection(&mut ws, &session, AAD, &mut clock)
                    .unwrap();
            }
        });

        let session = phone_kp.agree(&hub_pub);
        let shared_intent = "resolve the Friday mobile desktop channel mission";

        // Connection 1: mobile creates the canonical Mission and first WorkItem.
        {
            let stream = TcpStream::connect(addr).unwrap();
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
            let intake_req = Envelope::new(
                "wire-mobile-intake",
                1,
                Message::MissionIntakeRequest {
                    request: MissionIntakeRequestWire {
                        friday_conversation_id: "fconv_intake_ws".into(),
                        owner_principal: "principal:jarvis".into(),
                        surface_thread_id: "surface-mobile-intake".into(),
                        surface_kind: "mobile".into(),
                        delivery_route: "mobile://local/thread/intake".into(),
                        visibility_policy: "compact".into(),
                        mission_id: "mission-intake".into(),
                        work_item_id: "work-intake-mobile".into(),
                        title: "Mission intake".into(),
                        intent: shared_intent.into(),
                        lane: "codex".into(),
                        target_provider_or_agent: Some("codex".into()),
                        capability_id: Some("observe-wrapper.codex".into()),
                        body_ref: Some("friday://body/mobile/intake-1".into()),
                        proof_requirements: vec!["outcome:AnswerProduced:>=1".into()],
                        includes_sensitive_context: false,
                    },
                },
            );
            ws_send_envelope(&mut ws, &session, &intake_req, AAD).unwrap();
            let intake_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            let Message::MissionIntakeResult { result } = intake_resp.message else {
                panic!("expected mobile Mission intake result, got {intake_resp:?}");
            };
            assert_eq!(result.friday_conversation_id, "fconv_intake_ws");
            assert_eq!(result.mission_id, "mission-intake");
            assert_eq!(result.work_item_id.as_deref(), Some("work-intake-mobile"));
            assert_eq!(result.surface_thread_id, "surface-mobile-intake");
            assert_eq!(result.status, "ready");
            assert!(result.blockers.is_empty());
            assert!(result.created_or_ready);
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "Mission intake must not call provider/model"
            );
        }

        // Connection 2: desktop and channel repeat the same intent, then read one
        // shared projection.
        {
            let stream = TcpStream::connect(addr).unwrap();
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();

            let desktop_req = Envelope::new(
                "wire-desktop-intake-duplicate",
                2,
                Message::MissionIntakeRequest {
                    request: MissionIntakeRequestWire {
                        friday_conversation_id: "fconv_intake_ws".into(),
                        owner_principal: "principal:jarvis".into(),
                        surface_thread_id: "surface-desktop-intake".into(),
                        surface_kind: "desktop".into(),
                        delivery_route: "desktop://local/window/intake".into(),
                        visibility_policy: "rich_proof".into(),
                        mission_id: "mission-intake-desktop-duplicate".into(),
                        work_item_id: "work-intake-desktop-duplicate".into(),
                        title: "Desktop duplicate".into(),
                        intent: shared_intent.into(),
                        lane: "codex".into(),
                        target_provider_or_agent: Some("codex".into()),
                        capability_id: Some("observe-wrapper.codex".into()),
                        body_ref: Some("friday://body/desktop/intake-duplicate".into()),
                        proof_requirements: Vec::new(),
                        includes_sensitive_context: false,
                    },
                },
            );
            ws_send_envelope(&mut ws, &session, &desktop_req, AAD).unwrap();
            let desktop_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            let Message::MissionIntakeResult { result } = desktop_resp.message else {
                panic!("expected desktop duplicate intake result, got {desktop_resp:?}");
            };
            assert_eq!(result.friday_conversation_id, "fconv_intake_ws");
            assert_eq!(result.mission_id, "mission-intake");
            assert_eq!(result.work_item_id, None);
            assert_eq!(result.surface_thread_id, "surface-desktop-intake");
            assert_eq!(result.status, "blocked");
            assert_eq!(
                result.duplicate_mission_id.as_deref(),
                Some("mission-intake")
            );
            assert_eq!(result.duplicate_work_item_id, None);
            assert!(result
                .blockers
                .contains(&"duplicate_active_mission_before_dispatch".to_string()));
            assert!(!result.created_or_ready);

            let channel_req = Envelope::new(
                "wire-channel-intake-duplicate",
                3,
                Message::MissionIntakeRequest {
                    request: MissionIntakeRequestWire {
                        friday_conversation_id: "fconv_intake_ws".into(),
                        owner_principal: "principal:jarvis".into(),
                        surface_thread_id: "surface-telegram-intake".into(),
                        surface_kind: "telegram".into(),
                        delivery_route: "telegram://bound/channel/intake".into(),
                        visibility_policy: "status_only".into(),
                        mission_id: "mission-intake-channel-duplicate".into(),
                        work_item_id: "work-intake-channel-duplicate".into(),
                        title: "Channel duplicate".into(),
                        intent: shared_intent.into(),
                        lane: "codex".into(),
                        target_provider_or_agent: Some("codex".into()),
                        capability_id: Some("observe-wrapper.codex".into()),
                        body_ref: Some("friday://surface-event-body/telegram/intake".into()),
                        proof_requirements: Vec::new(),
                        includes_sensitive_context: false,
                    },
                },
            );
            ws_send_envelope(&mut ws, &session, &channel_req, AAD).unwrap();
            let channel_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            let Message::MissionIntakeResult { result } = channel_resp.message else {
                panic!("expected channel duplicate intake result, got {channel_resp:?}");
            };
            assert_eq!(result.mission_id, "mission-intake");
            assert_eq!(result.surface_thread_id, "surface-telegram-intake");
            assert_eq!(result.status, "blocked");
            assert_eq!(
                result.duplicate_mission_id.as_deref(),
                Some("mission-intake")
            );

            let projection_req = Envelope::new(
                "wire-intake-projection",
                4,
                Message::MissionProjectionRequest {
                    request: friday_protocol::MissionProjectionRequestWire {
                        friday_conversation_id: "fconv_intake_ws".into(),
                    },
                },
            );
            ws_send_envelope(&mut ws, &session, &projection_req, AAD).unwrap();
            let projection_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            let Message::MissionProjectionSnapshot { snapshot } = projection_resp.message else {
                panic!("expected intake Mission projection, got {projection_resp:?}");
            };
            assert_eq!(snapshot.friday_conversation_id, "fconv_intake_ws");
            assert_eq!(snapshot.projections.len(), 3);
            for (surface_thread_id, surface_kind, visibility_policy) in [
                ("surface-mobile-intake", "mobile", "compact"),
                ("surface-desktop-intake", "desktop", "rich_proof"),
                ("surface-telegram-intake", "telegram", "status_only"),
            ] {
                assert!(
                    snapshot.projections.iter().any(|projection| {
                        projection.surface_thread_id == surface_thread_id
                            && projection.surface_kind == surface_kind
                            && projection.visibility_policy == visibility_policy
                            && projection.mission_id == "mission-intake"
                            && projection.status == "active"
                    }),
                    "{surface_kind} should be bound to the same Mission projection"
                );
            }
            assert!(snapshot.route_decisions.iter().any(|route| {
                route.mission_id == "mission-intake"
                    && route.work_item_id == "work-intake-mobile"
                    && route.selected_lane == "codex"
                    && route.selected_target_label.as_deref() == Some("codex")
            }));
            let debug = format!("{snapshot:?}");
            for forbidden in [
                "test-key-not-real",
                "telegram://bound/channel/intake",
                "friday://body/mobile/intake-1",
                "raw transcript",
                "sk-test",
            ] {
                assert!(
                    !debug.contains(forbidden),
                    "Mission intake projection leaked {forbidden}: {debug}"
                );
            }
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "intake duplicate/projection must not call provider/model"
            );
        }
        srv.join().unwrap();

        let db = Db::open_hub(&db_path).unwrap();
        assert_eq!(db.count("mission").unwrap(), 1);
        assert_eq!(db.count("work_item").unwrap(), 1);
        assert_eq!(db.count("surface_thread").unwrap(), 3);
        assert_eq!(db.count("workspace_claim").unwrap(), 1);
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("activity_item").unwrap(), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let conversation = db
            .get_friday_conversation("fconv_intake_ws")
            .unwrap()
            .expect("conversation");
        assert_eq!(
            conversation.active_mission_ids,
            vec!["mission-intake".to_string()]
        );
        for surface_thread_id in [
            "surface-mobile-intake",
            "surface-desktop-intake",
            "surface-telegram-intake",
        ] {
            assert!(
                conversation
                    .surface_thread_ids
                    .contains(&surface_thread_id.to_string()),
                "{surface_thread_id} should be attached to the conversation"
            );
            let surface = db
                .get_surface_thread(surface_thread_id)
                .unwrap()
                .expect("surface thread");
            assert_eq!(surface.mission_id.as_deref(), Some("mission-intake"));
            assert_eq!(surface.friday_conversation_id, "fconv_intake_ws");
        }
        let mission = db.get_mission("mission-intake").unwrap().expect("mission");
        assert_eq!(
            mission.work_item_ids,
            vec!["work-intake-mobile".to_string()]
        );
        let work = db
            .get_work_item("work-intake-mobile")
            .unwrap()
            .expect("work item");
        assert_eq!(work.status, WorkItemStatus::ReadyToDispatch);
        assert_eq!(work.input_refs, vec!["friday://body/mobile/intake-1"]);
        assert_eq!(
            work.proof_requirements,
            vec!["outcome:AnswerProduced:>=1".to_string()]
        );
        assert_eq!(
            work.judgment_memory.proof_requirements,
            vec!["outcome:AnswerProduced:>=1".to_string()]
        );
        let claim_id = format!(
            "claim-codex-provider-session-{}-{}",
            projection_ref_part("mission-intake"),
            projection_ref_part("work-intake-mobile")
        );
        assert_eq!(work.owner_claim_ids, vec![claim_id.clone()]);
        assert_eq!(
            work.judgment_memory.ownership_claim_ids,
            vec![claim_id.clone()]
        );
        let claim = db
            .get_workspace_claim(&claim_id)
            .unwrap()
            .expect("Codex provider-session claim");
        assert_eq!(claim.mission_id, "mission-intake");
        assert_eq!(claim.work_item_id.as_deref(), Some("work-intake-mobile"));
        assert_eq!(claim.owner_principal, "principal:jarvis");
        assert_eq!(claim.claim_kind, WorkspaceClaimKind::ProviderSession);
        assert_eq!(claim.state, ClaimState::Active);
        assert_eq!(
            claim.workspace_ref,
            "friday://provider-session/codex/work-intake-mobile"
        );
    }

    /// One sealed-WS proof chain in the user-requested order:
    /// mobile input -> Mission intake -> Mission-bound ask -> proof receipt ->
    /// desktop/channel duplicate binding -> desktop projection + bounded timeline.
    /// The provider is scripted, but the transport, Hub dispatch, storage writes,
    /// proof attachment, pagination, no-fallback discipline, and redacted wire
    /// projections are all exercised in one flow.
    #[test]
    fn headless_e2e_intake_then_mission_bound_ask_then_duplicate_projection_timeline() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let hub_kp = DeviceKeypair::generate();
        let phone_kp = DeviceKeypair::generate();
        let hub_pub = hub_kp.public_bytes();
        let phone_pub = phone_kp.public_bytes();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_calls = calls.clone();
        let server_db = db_path.clone();
        let srv = thread::spawn(move || {
            let session = hub_kp.agree(&phone_pub);
            let db = Db::open_hub(&server_db).unwrap();
            let client = DeepSeekClient::with_transport(
                CountingMock {
                    calls: server_calls,
                },
                "test-key-not-real".to_string(), // pragma: allowlist secret
            );
            let mut hub = HubServer::new(
                db,
                client,
                vec![
                    "ask_friday".into(),
                    "mission_intake".into(),
                    "mission_projection".into(),
                    "mission_timeline".into(),
                    "status".into(),
                ],
                64,
            );
            for _ in 0..2 {
                let (stream, _) = listener.accept().unwrap();
                let mut ws = ws_accept(stream).unwrap();
                let mut now = 1_700_001_100_000i64;
                let mut clock = || {
                    now += 1;
                    now
                };
                hub.serve_connection(&mut ws, &session, AAD, &mut clock)
                    .unwrap();
            }
        });

        let session = phone_kp.agree(&hub_pub);
        let shared_intent = "ship one Friday Mission across mobile desktop channel";
        let proof_ref = {
            let stream = TcpStream::connect(addr).unwrap();
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
            let intake_req = Envelope::new(
                "wire-chain-mobile-intake",
                1,
                Message::MissionIntakeRequest {
                    request: MissionIntakeRequestWire {
                        friday_conversation_id: "fconv_chain_ws".into(),
                        owner_principal: "principal:jarvis".into(),
                        surface_thread_id: "surface-chain-mobile".into(),
                        surface_kind: "mobile".into(),
                        delivery_route: "mobile://local/thread/chain".into(),
                        visibility_policy: "compact".into(),
                        mission_id: "mission-chain".into(),
                        work_item_id: "work-chain-mobile".into(),
                        title: "Chain Mission".into(),
                        intent: shared_intent.into(),
                        lane: "deepseek".into(),
                        target_provider_or_agent: Some("deepseek".into()),
                        capability_id: Some("ask_friday.deepseek".into()),
                        body_ref: Some("friday://body/mobile/chain".into()),
                        proof_requirements: Vec::new(),
                        includes_sensitive_context: false,
                    },
                },
            );
            ws_send_envelope(&mut ws, &session, &intake_req, AAD).unwrap();
            let intake_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            let Message::MissionIntakeResult { result } = intake_resp.message else {
                panic!("expected chain intake result, got {intake_resp:?}");
            };
            assert_eq!(result.status, "ready");
            assert_eq!(result.mission_id, "mission-chain");
            assert_eq!(result.work_item_id.as_deref(), Some("work-chain-mobile"));
            assert!(result.created_or_ready);
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "Mission intake must not call provider/model"
            );

            let ask_req = Envelope::new(
                "wire-chain-mobile-ask",
                2,
                Message::AskFridayRequest {
                    prompt: "Use the canonical Mission context and attach proof.".into(),
                    mission_context: Some(MissionWorkItemContextWire {
                        friday_conversation_id: result.friday_conversation_id,
                        mission_id: result.mission_id,
                        work_item_id: result.work_item_id.expect("ready work item id"),
                    }),
                },
            );
            ws_send_envelope(&mut ws, &session, &ask_req, AAD).unwrap();
            let ask_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            let debug = format!("{ask_resp:?}");
            let Message::AskFridayResult {
                ledger_id,
                result_link,
            } = ask_resp.message
            else {
                panic!("expected chain Mission-bound ask result, got {ask_resp:?}");
            };
            assert_eq!(ledger_id, "ask-wire-chain-mobile-ask-1");
            let proof_ref = result_link.expect("proof activity link");
            assert_eq!(
                proof_ref,
                "friday://activity/ask-wire-chain-mobile-ask-1:activity"
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                2,
                "Mission-bound ask should discover + post exactly once"
            );
            for forbidden in ["SECRET-ANSWER-TEXT", "test-key-not-real", "Authorization"] {
                assert!(
                    !debug.contains(forbidden),
                    "chain ask response leaked {forbidden}: {debug}"
                );
            }
            proof_ref
        };

        let calls_after_ask = calls.load(Ordering::SeqCst);
        {
            let stream = TcpStream::connect(addr).unwrap();
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
            for (
                msg_id,
                surface_thread_id,
                surface_kind,
                delivery_route,
                visibility_policy,
                mission_id,
                work_item_id,
                body_ref,
            ) in [
                (
                    "wire-chain-desktop-duplicate",
                    "surface-chain-desktop",
                    "desktop",
                    "desktop://local/window/chain",
                    "rich_proof",
                    "mission-chain-desktop-dupe",
                    "work-chain-desktop-dupe",
                    "friday://body/desktop/chain-dupe",
                ),
                (
                    "wire-chain-channel-duplicate",
                    "surface-chain-telegram",
                    "telegram",
                    "telegram://bound/channel/chain",
                    "status_only",
                    "mission-chain-channel-dupe",
                    "work-chain-channel-dupe",
                    "friday://surface-event-body/telegram/chain-dupe",
                ),
            ] {
                let duplicate_req = Envelope::new(
                    msg_id,
                    3,
                    Message::MissionIntakeRequest {
                        request: MissionIntakeRequestWire {
                            friday_conversation_id: "fconv_chain_ws".into(),
                            owner_principal: "principal:jarvis".into(),
                            surface_thread_id: surface_thread_id.into(),
                            surface_kind: surface_kind.into(),
                            delivery_route: delivery_route.into(),
                            visibility_policy: visibility_policy.into(),
                            mission_id: mission_id.into(),
                            work_item_id: work_item_id.into(),
                            title: "Duplicate chain Mission".into(),
                            intent: shared_intent.into(),
                            lane: "deepseek".into(),
                            target_provider_or_agent: Some("deepseek".into()),
                            capability_id: Some("ask_friday.deepseek".into()),
                            body_ref: Some(body_ref.into()),
                            proof_requirements: Vec::new(),
                            includes_sensitive_context: false,
                        },
                    },
                );
                ws_send_envelope(&mut ws, &session, &duplicate_req, AAD).unwrap();
                let duplicate_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
                let Message::MissionIntakeResult { result } = duplicate_resp.message else {
                    panic!("expected chain duplicate intake result, got {duplicate_resp:?}");
                };
                assert_eq!(result.status, "blocked");
                assert_eq!(result.mission_id, "mission-chain");
                assert_eq!(result.surface_thread_id, surface_thread_id);
                assert_eq!(
                    result.duplicate_mission_id.as_deref(),
                    Some("mission-chain")
                );
                assert!(!result.created_or_ready);
                assert_eq!(
                    calls.load(Ordering::SeqCst),
                    calls_after_ask,
                    "duplicate intake must not call provider/model"
                );
            }

            let projection_req = Envelope::new(
                "wire-chain-desktop-projection",
                5,
                Message::MissionProjectionRequest {
                    request: friday_protocol::MissionProjectionRequestWire {
                        friday_conversation_id: "fconv_chain_ws".into(),
                    },
                },
            );
            ws_send_envelope(&mut ws, &session, &projection_req, AAD).unwrap();
            let projection_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            let Message::MissionProjectionSnapshot { snapshot } = projection_resp.message else {
                panic!("expected chain projection, got {projection_resp:?}");
            };
            assert_eq!(snapshot.projections.len(), 3);
            for surface in ["mobile", "desktop", "telegram"] {
                assert!(
                    snapshot.projections.iter().any(|projection| {
                        projection.surface_kind == surface
                            && projection.mission_id == "mission-chain"
                            && projection.status == "active"
                    }),
                    "{surface} should see the same chain Mission"
                );
            }
            assert!(snapshot.route_decisions.iter().any(|route| {
                route.mission_id == "mission-chain"
                    && route.work_item_id == "work-chain-mobile"
                    && route.selected_lane == "deepseek"
                    && route.selected_target_label.as_deref() == Some("deepseek")
            }));
            let debug = format!("{snapshot:?}");
            for forbidden in [
                "SECRET-ANSWER-TEXT",
                "test-key-not-real",
                "mobile://local/thread/chain",
                "telegram://bound/channel/chain",
                "friday://body/mobile/chain",
                "raw transcript",
                "sk-test",
            ] {
                assert!(
                    !debug.contains(forbidden),
                    "chain projection leaked {forbidden}: {debug}"
                );
            }

            let mut cursor = None;
            let mut pages = 0usize;
            let mut provider_link_seen = false;
            let mut route_decision_seen = false;
            let mut completed_work_seen = false;
            loop {
                let timeline_req = Envelope::new(
                    format!("wire-chain-desktop-timeline-{pages}"),
                    6 + pages as i64,
                    Message::MissionTimelineRequest {
                        request: friday_protocol::MissionTimelineRequestWire {
                            friday_conversation_id: "fconv_chain_ws".into(),
                            mission_id: "mission-chain".into(),
                            cursor: cursor.clone(),
                            limit: Some(1),
                        },
                    },
                );
                ws_send_envelope(&mut ws, &session, &timeline_req, AAD).unwrap();
                let timeline_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
                let Message::MissionTimelineSnapshot { snapshot } = timeline_resp.message else {
                    panic!("expected chain bounded timeline, got {timeline_resp:?}");
                };
                assert!(snapshot.bounded);
                assert_eq!(snapshot.work_items.len(), 1);
                completed_work_seen |= snapshot.work_items.iter().any(|item| {
                    item.work_item_id == "work-chain-mobile"
                        && item.status == "completed_with_proof"
                        && item.proof_receipts.contains(&proof_ref)
                });
                provider_link_seen |= snapshot.links.iter().any(|link| {
                    link.link_kind == "provider_timeline"
                        && link.has_proof
                        && link.proof_ref.as_deref() == Some(proof_ref.as_str())
                });
                route_decision_seen |= snapshot.links.iter().any(|link| {
                    link.link_kind == "route_decision" && !link.grants_memory_authority
                });
                let debug = format!("{snapshot:?}");
                for forbidden in [
                    "SECRET-ANSWER-TEXT",
                    "test-key-not-real",
                    "mobile://local/thread/chain",
                    "telegram://bound/channel/chain",
                    "friday://body/mobile/chain",
                    "raw transcript",
                    "sk-test",
                ] {
                    assert!(
                        !debug.contains(forbidden),
                        "chain timeline leaked {forbidden}: {debug}"
                    );
                }
                pages += 1;
                if snapshot.has_more {
                    cursor = snapshot.next_cursor.clone();
                    assert!(cursor.is_some());
                } else {
                    assert_eq!(snapshot.next_cursor, None);
                    break;
                }
            }
            assert!(pages > 1, "chain bounded timeline should page");
            assert!(completed_work_seen);
            assert!(provider_link_seen);
            assert!(route_decision_seen);
            assert_eq!(
                calls.load(Ordering::SeqCst),
                calls_after_ask,
                "desktop duplicate/projection/timeline reads must not call provider/model"
            );
        }
        srv.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), calls_after_ask);

        let db = Db::open_hub(&db_path).unwrap();
        assert_eq!(db.count("mission").unwrap(), 1);
        assert_eq!(db.count("work_item").unwrap(), 1);
        assert_eq!(db.count("surface_thread").unwrap(), 3);
        assert_eq!(db.count("token_ledger").unwrap(), 1);
        assert_eq!(db.count("activity_item").unwrap(), 1);
        assert_eq!(memory::auto_usable(db.conn()).unwrap().len(), 0);
        let work = db
            .get_work_item("work-chain-mobile")
            .unwrap()
            .expect("chain work item");
        assert_eq!(work.status, WorkItemStatus::CompletedWithProof);
        assert_eq!(work.proof_receipts, vec![proof_ref]);
        for missing in ["work-chain-desktop-dupe", "work-chain-channel-dupe"] {
            assert!(
                db.get_work_item(missing).unwrap().is_none(),
                "duplicate work item {missing} should not exist"
            );
        }
    }

    #[test]
    fn mission_projection_request_is_pure_and_shares_mission_across_surfaces() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_projection(&db);
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["mission_projection".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "mission-projection-1",
                1,
                Message::MissionProjectionRequest {
                    request: friday_protocol::MissionProjectionRequestWire {
                        friday_conversation_id: "fconv_hub_projection".into(),
                    },
                },
            ),
            1_700_000_000_500,
        );
        let Message::MissionProjectionSnapshot { snapshot } = response.message else {
            panic!("expected mission projection snapshot, got {response:?}");
        };
        assert_eq!(snapshot.friday_conversation_id, "fconv_hub_projection");
        assert_eq!(snapshot.generated_at_ms, 1_700_000_000_500);
        assert_eq!(snapshot.projections.len(), 2);
        let mission_ids: std::collections::BTreeSet<_> = snapshot
            .projections
            .iter()
            .map(|projection| projection.mission_id.as_str())
            .collect();
        assert_eq!(
            mission_ids,
            std::collections::BTreeSet::from(["mission-hub-projection"])
        );
        assert!(snapshot
            .projections
            .iter()
            .any(|projection| projection.surface_kind == "mobile"
                && projection.visibility_policy == "compact"
                && projection.status == "active"));
        assert!(snapshot
            .projections
            .iter()
            .any(|projection| projection.surface_kind == "desktop"
                && projection.visibility_policy == "rich_proof"
                && projection.status == "active"));
        assert_eq!(snapshot.route_decisions.len(), 1);
        let route = &snapshot.route_decisions[0];
        assert_eq!(route.mission_id, "mission-hub-projection");
        assert_eq!(route.work_item_id, "work-hub-route");
        assert_eq!(route.selected_lane, "channel");
        assert_eq!(
            route.selected_target_label.as_deref(),
            Some("bound_channel")
        );
        assert_eq!(route.conflict_ref_count, 1);
        assert_eq!(route.trace_ref_count, 2);
        assert!(route
            .route_decision_ref
            .starts_with("friday://route-decision-projection/"));
        let debug = format!("{snapshot:?}");
        for forbidden in [
            "external-thread",
            "provider-token",
            "raw-chat-123",
            "telegram:raw",
            "/Users/example/private",
            "raw transcript",
            "sk-",
        ] {
            assert!(
                !debug.contains(forbidden),
                "Mission projection leaked {forbidden}: {debug}"
            );
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "mission projection is a pure Hub read"
        );
    }

    #[test]
    fn provider_workspace_action_request_is_guarded_by_hub_dispatch() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_provider_workspace_mission(&db);
        db.upsert_provider_session_link(&provider_session_link())
            .unwrap();
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["provider_workspace".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "provider-action",
                1,
                Message::ProviderWorkspaceActionRequest {
                    request: ProviderWorkspaceActionRequestWire {
                        request_id: "provider-action-1".into(),
                        friday_session_id: "friday-session-1".into(),
                        provider: "codex".into(),
                        action: "list_sessions".into(),
                        capability_id: "provider.codex.list_sessions".into(),
                        payload_ref: None,
                        mission_context: Some(
                            friday_protocol::ProviderWorkspaceMissionContextWire {
                                friday_conversation_id: "fconv_provider_workspace".into(),
                                mission_id: "mission-provider-workspace".into(),
                                work_item_id: "work-provider-workspace".into(),
                            },
                        ),
                    },
                },
            ),
            1_700_000_100_300,
        );
        let rendered = format!("{response:?}");
        let Message::ProviderWorkspaceActionResult { result } = response.message else {
            panic!("expected provider workspace action result, got {response:?}");
        };
        assert_eq!(result.request_id, "provider-action-1");
        assert_eq!(result.status, "implemented_unproven");
        assert!(!result.accepted);
        assert!(!result.routed);
        assert!(result.blocker.is_some());
        assert!(result.mission_context.is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        for forbidden in [
            "account-hash-never-project",
            "/Users/example/private/project",
            "provider-session-id",
            "provider-thread-id",
            "provider.example/private",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "provider workspace guard leaked private value {forbidden}: {rendered}"
            );
        }
    }

    #[test]
    fn provider_workspace_dispatch_flag_is_byte_identical_at_the_hub_slot() {
        // The hub slot selects the live ProviderWorkspaceDispatchAdapter when
        // FRIDAY_PROVIDER_WORKSPACE_DISPATCH=1, else the NoProviderWorkspaceDispatchAdapter.
        // But the production catalog (`friday_current()`) marks NO capability Verified, so the
        // guard refuses every action BEFORE the adapter is consulted — making the slot's
        // RESULT byte-identical regardless of the flag. Both env states are exercised in ONE
        // #[test] (no cross-test env race; the live adapter only ever spawns a real codex
        // app-server, which a non-Verified request can never reach).
        //
        // SAFETY NOTE: the env mutation here is race-free ONLY because nothing is Verified —
        // both arms return `implemented_unproven` regardless of the flag, so a concurrent test
        // hitting this slot cannot flake on it. The DAY a capability is marked Verified, this
        // test must convert to the injected-adapter style of the discriminators in
        // `provider_dispatch_adapter.rs` (which never touch `std::env`).
        fn dispatch_once() -> ProviderWorkspaceActionResultWire {
            let db_path = tmp_db();
            let calls = Arc::new(AtomicUsize::new(0));
            let db = Db::open_hub(&db_path).unwrap();
            seed_provider_workspace_mission(&db);
            db.upsert_provider_session_link(&provider_session_link())
                .unwrap();
            let client = DeepSeekClient::with_transport(
                CountingMock {
                    calls: calls.clone(),
                },
                "test-key-not-real".to_string(), // pragma: allowlist secret
            );
            let mut hub = HubServer::new(db, client, vec!["provider_workspace".into()], 256);
            let response = hub.dispatch(
                Envelope::new(
                    "provider-action",
                    1,
                    Message::ProviderWorkspaceActionRequest {
                        request: ProviderWorkspaceActionRequestWire {
                            request_id: "provider-action-1".into(),
                            friday_session_id: "friday-session-1".into(),
                            provider: "codex".into(),
                            action: "list_sessions".into(),
                            capability_id: "provider.codex.list_sessions".into(),
                            payload_ref: None,
                            mission_context: Some(
                                friday_protocol::ProviderWorkspaceMissionContextWire {
                                    friday_conversation_id: "fconv_provider_workspace".into(),
                                    mission_id: "mission-provider-workspace".into(),
                                    work_item_id: "work-provider-workspace".into(),
                                },
                            ),
                        },
                    },
                ),
                1_700_000_100_300,
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "no model call on a guarded action"
            );
            let Message::ProviderWorkspaceActionResult { result } = response.message else {
                panic!("expected provider workspace action result");
            };
            result
        }

        std::env::remove_var("FRIDAY_PROVIDER_WORKSPACE_DISPATCH");
        let off = dispatch_once();
        std::env::set_var("FRIDAY_PROVIDER_WORKSPACE_DISPATCH", "1");
        let on = dispatch_once();
        std::env::remove_var("FRIDAY_PROVIDER_WORKSPACE_DISPATCH");

        // Byte-identical: same status, accepted/routed, blocker, dispatch_ref.
        assert_eq!(off.status, "implemented_unproven");
        assert_eq!(on.status, off.status);
        assert_eq!(on.accepted, off.accepted);
        assert_eq!(on.routed, off.routed);
        assert_eq!(on.blocker, off.blocker);
        assert_eq!(on.dispatch_ref, off.dispatch_ref);
        assert!(!on.accepted);
        assert!(on.dispatch_ref.is_none());
    }

    #[test]
    fn provider_workspace_action_with_stale_mission_context_is_refused_before_catalog_acceptance() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        db.upsert_provider_session_link(&provider_session_link())
            .unwrap();
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["provider_workspace".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "provider-action-stale-mission",
                1,
                Message::ProviderWorkspaceActionRequest {
                    request: ProviderWorkspaceActionRequestWire {
                        request_id: "provider-action-stale-mission".into(),
                        friday_session_id: "friday-session-1".into(),
                        provider: "codex".into(),
                        action: "list_sessions".into(),
                        capability_id: "provider.codex.list_sessions".into(),
                        payload_ref: None,
                        mission_context: Some(
                            friday_protocol::ProviderWorkspaceMissionContextWire {
                                friday_conversation_id: "fconv_provider_workspace".into(),
                                mission_id: "mission-provider-workspace".into(),
                                work_item_id: "work-provider-workspace".into(),
                            },
                        ),
                    },
                },
            ),
            1_700_000_100_320,
        );
        let Message::ProviderWorkspaceActionResult { result } = response.message else {
            panic!("expected provider workspace action result, got {response:?}");
        };
        assert_eq!(result.status, "mission_context_required");
        assert!(!result.accepted);
        assert!(!result.routed);
        assert!(result
            .blocker
            .as_deref()
            .unwrap()
            .contains("provider dispatch Mission context blocked"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn provider_workspace_action_without_mission_context_is_refused() {
        let db_path = tmp_db();
        let db = Db::open_hub(&db_path).unwrap();
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: Arc::new(AtomicUsize::new(0)),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["provider_workspace".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "provider-action-detached",
                1,
                Message::ProviderWorkspaceActionRequest {
                    request: ProviderWorkspaceActionRequestWire {
                        request_id: "provider-action-detached".into(),
                        friday_session_id: "friday-session-1".into(),
                        provider: "codex".into(),
                        action: "list_sessions".into(),
                        capability_id: "provider.codex.list_sessions".into(),
                        payload_ref: None,
                        mission_context: None,
                    },
                },
            ),
            1_700_000_100_350,
        );
        let Message::ProviderWorkspaceActionResult { result } = response.message else {
            panic!("expected provider workspace action result, got {response:?}");
        };
        assert_eq!(result.status, "mission_context_required");
        assert!(!result.accepted);
        assert!(!result.routed);
        assert!(result
            .blocker
            .as_deref()
            .unwrap()
            .contains("requires Mission context"));
    }

    #[test]
    fn ask_without_mission_context_is_blocked_before_provider_or_ledger() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["ask_friday".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "detached-ask",
                1,
                Message::AskFridayRequest {
                    prompt: "This must not create detached provider state.".into(),
                    mission_context: None,
                },
            ),
            1_700_000_100_400,
        );

        let Message::Error { code, message } = response.message else {
            panic!("expected missing-context error, got {response:?}");
        };
        assert_eq!(code, ErrorCode::Internal);
        assert!(message.contains("requires Mission context"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(hub.db().count("token_ledger").unwrap(), 0);
        assert_eq!(hub.db().count("activity_item").unwrap(), 0);
    }

    #[test]
    fn mission_bound_ask_attaches_proof_to_timeline_and_completion() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_ask(&db);
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["ask_friday".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "mission-ask-1",
                1,
                Message::AskFridayRequest {
                    prompt: "What should Friday do next?".into(),
                    mission_context: Some(MissionWorkItemContextWire {
                        friday_conversation_id: "fconv_hub_ask".into(),
                        mission_id: "mission-hub-ask".into(),
                        work_item_id: "work-hub-ask".into(),
                    }),
                },
            ),
            1_700_000_100_500,
        );
        let Message::AskFridayResult {
            ledger_id,
            result_link,
        } = response.message
        else {
            panic!("expected mission-bound ask result, got {response:?}");
        };
        assert_eq!(ledger_id, "ask-mission-ask-1-1");
        let proof_ref = result_link.expect("proof/activity ref");
        assert_eq!(proof_ref, "friday://activity/ask-mission-ask-1-1:activity");
        assert!(
            calls.load(Ordering::SeqCst) >= 1,
            "mission-bound ask must call DeepSeek only after context resolves"
        );

        let response = hub.dispatch(
            Envelope::new(
                "mission-ask-timeline",
                2,
                Message::MissionTimelineRequest {
                    request: friday_protocol::MissionTimelineRequestWire {
                        friday_conversation_id: "fconv_hub_ask".into(),
                        mission_id: "mission-hub-ask".into(),
                        cursor: None,
                        limit: None,
                    },
                },
            ),
            1_700_000_100_600,
        );
        let Message::MissionTimelineSnapshot { snapshot } = response.message else {
            panic!("expected mission timeline snapshot, got {response:?}");
        };
        assert_eq!(snapshot.work_items.len(), 1);
        let item = &snapshot.work_items[0];
        assert_eq!(item.work_item_id, "work-hub-ask");
        assert_eq!(item.status, "completed_with_proof");
        assert!(item.proof_receipts.contains(&proof_ref));
        assert!(snapshot.mission.proof_refs.contains(&proof_ref));
        assert!(snapshot
            .links
            .iter()
            .any(|link| link.link_kind == "provider_timeline"
                && link.has_proof
                && link.proof_ref.as_deref() == Some(proof_ref.as_str())));
        assert!(snapshot
            .route_decisions
            .iter()
            .any(|route| route.selected_lane == "deepseek"
                && route.selected_target_label.as_deref() == Some("deepseek")));
        let debug = format!("{snapshot:?}");
        for forbidden in ["SECRET-ANSWER-TEXT", "test-key-not-real", "raw user prompt"] {
            assert!(
                !debug.contains(forbidden),
                "Mission-bound ask leaked {forbidden}: {debug}"
            );
        }
    }

    #[test]
    fn work_item_status_ws_ingress_rejects_client_supplied_outcome_proof_when_flag_on() {
        let _guard = crate::test_env::EnvVarGuard::set("FRIDAY_OUTCOME_CHECKED_PROOF", "1");
        let db_path = tmp_db();
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_ask(&db);
        let mut work = db.get_work_item("work-hub-ask").unwrap().unwrap();
        work.status = WorkItemStatus::ProviderWaiting;
        work.proof_requirements = vec!["outcome:ToolsExecuted:>=1".into()];
        db.upsert_work_item(&work).unwrap();

        let response = work_item_status_result_for_db(
            &db,
            "ws-outcome-client-proof",
            WorkItemStatusRequestWire {
                work_item_id: "work-hub-ask".into(),
                target_status: "completed_with_proof".into(),
                actor_ref: "client:mobile".into(),
                reason: "client claims outcome".into(),
                proof_receipt: Some(
                    "proof://outcome/ToolsExecuted/run-1?signal=executed_tools=1".into(),
                ),
            },
            Some("owner-1"),
            1_700_000_100_650,
        );
        let Message::Error { code, message } = response.message else {
            panic!("expected outcome proof ingress block, got {response:?}");
        };
        assert_eq!(code, ErrorCode::Internal);
        assert!(message.contains("server-minted outcome receipt"));

        let stored = db.get_work_item("work-hub-ask").unwrap().unwrap();
        assert_eq!(stored.status, WorkItemStatus::ProviderWaiting);
        assert!(
            stored.proof_receipts.is_empty(),
            "client-supplied outcome receipt must not persist"
        );
    }

    #[test]
    fn work_item_status_dispatch_arm_updates_timeline_without_provider_call() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_ask(&db);

        let audit_before = db.count("audit_ledger").unwrap();
        let response = work_item_status_result_for_db(
            &db,
            "workitem-dispatch-arm",
            WorkItemStatusRequestWire {
                work_item_id: "work-hub-ask".into(),
                target_status: "dispatched".into(),
                actor_ref: "system:mission-spine-dispatch".into(),
                reason: "dispatch ready WorkItem through the mission spine".into(),
                proof_receipt: None,
            },
            Some("owner-1"),
            1_700_000_100_700,
        );
        let Message::WorkItemStatusResult { result } = response.message else {
            panic!("expected WorkItem status result, got {response:?}");
        };
        assert_eq!(result.work_item_id, "work-hub-ask");
        assert_eq!(result.mission_id, "mission-hub-ask");
        assert_eq!(result.previous_status, "ready_to_dispatch");
        assert_eq!(result.status, "dispatched");
        assert_eq!(result.actor_ref, "system:mission-spine-dispatch");
        assert_eq!(
            result.reason,
            "dispatch ready WorkItem through the mission spine"
        );
        assert_eq!(result.proof_receipt_count, 0);
        assert_eq!(result.updated_at_ms, 1_700_000_100_700);

        let stored = db.get_work_item("work-hub-ask").unwrap().unwrap();
        assert_eq!(stored.status, WorkItemStatus::Dispatched);
        assert_eq!(db.count("audit_ledger").unwrap(), audit_before + 1);
        assert_eq!(db.count("token_ledger").unwrap(), 0);

        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["mission_timeline".into()], 64);
        let timeline = hub.dispatch(
            Envelope::new(
                "workitem-dispatch-arm-timeline",
                2,
                Message::MissionTimelineRequest {
                    request: friday_protocol::MissionTimelineRequestWire {
                        friday_conversation_id: "fconv_hub_ask".into(),
                        mission_id: "mission-hub-ask".into(),
                        cursor: None,
                        limit: None,
                    },
                },
            ),
            1_700_000_100_710,
        );
        let Message::MissionTimelineSnapshot { snapshot } = timeline.message else {
            panic!("expected mission timeline snapshot, got {timeline:?}");
        };
        let item = snapshot
            .work_items
            .iter()
            .find(|item| item.work_item_id == "work-hub-ask")
            .expect("timeline should include dispatched WorkItem");
        assert_eq!(item.status, "dispatched");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "WorkItem status dispatch/readback must not call a provider/model"
        );
        assert_eq!(hub.db().count("token_ledger").unwrap(), 0);
    }

    #[test]
    fn mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary() {
        const ASK_COUNT: usize = 25;
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_pressure_mission(&db, ASK_COUNT);
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["ask_friday".into()], 32);

        for index in 0..ASK_COUNT {
            let response = hub.dispatch(
                Envelope::new(
                    format!("pressure-ask-{index:02}"),
                    index as i64,
                    Message::AskFridayRequest {
                        prompt: format!("Pressure ask {index:02}: reply with OK."),
                        mission_context: Some(MissionWorkItemContextWire {
                            friday_conversation_id: "fconv_pressure".into(),
                            mission_id: "mission-pressure".into(),
                            work_item_id: format!("work-pressure-{index:02}"),
                        }),
                    },
                ),
                1_700_000_400_000 + index as i64,
            );
            let Message::AskFridayResult {
                ledger_id,
                result_link,
            } = response.message
            else {
                panic!("expected pressure ask result {index}, got {response:?}");
            };
            assert_eq!(
                ledger_id,
                format!("ask-pressure-ask-{index:02}-{}", index + 1)
            );
            let expected_result_link = format!(
                "friday://activity/ask-pressure-ask-{index:02}-{}:activity",
                index + 1
            );
            assert_eq!(result_link.as_deref(), Some(expected_result_link.as_str()));
        }

        assert_eq!(
            calls.load(Ordering::SeqCst),
            ASK_COUNT * 2,
            "each Mission-bound ask should discover + call exactly once; no hidden fallback"
        );
        assert_eq!(hub.db().count("token_ledger").unwrap(), ASK_COUNT as i64);
        assert_eq!(hub.db().count("activity_item").unwrap(), ASK_COUNT as i64);
        assert_eq!(
            memory::auto_usable(hub.db().conn()).unwrap().len(),
            0,
            "candidate memory must not become confirmed/auto-usable during ask pressure"
        );

        let projection = hub.dispatch(
            Envelope::new(
                "pressure-projection",
                100,
                Message::MissionProjectionRequest {
                    request: friday_protocol::MissionProjectionRequestWire {
                        friday_conversation_id: "fconv_pressure".into(),
                    },
                },
            ),
            1_700_000_500_000,
        );
        let Message::MissionProjectionSnapshot { snapshot } = projection.message else {
            panic!("expected pressure projection, got {projection:?}");
        };
        assert_eq!(snapshot.projections.len(), 3);
        for surface in ["mobile", "desktop", "telegram"] {
            assert!(
                snapshot.projections.iter().any(|projection| {
                    projection.surface_kind == surface
                        && projection.mission_id == "mission-pressure"
                        && projection.status == "active"
                }),
                "{surface} projection should see the same Mission"
            );
        }

        let mut cursor = None;
        let mut pages = 0usize;
        let mut route_count = 0usize;
        let mut provider_link_count = 0usize;
        let mut memory_candidate_seen = false;
        let mut mobile_event_seen = false;
        loop {
            let response = hub.dispatch(
                Envelope::new(
                    format!("pressure-timeline-page-{pages}"),
                    200 + pages as i64,
                    Message::MissionTimelineRequest {
                        request: friday_protocol::MissionTimelineRequestWire {
                            friday_conversation_id: "fconv_pressure".into(),
                            mission_id: "mission-pressure".into(),
                            cursor: cursor.clone(),
                            limit: Some(17),
                        },
                    },
                ),
                1_700_000_600_000 + pages as i64,
            );
            let Message::MissionTimelineSnapshot { snapshot } = response.message else {
                panic!("expected pressure timeline page, got {response:?}");
            };
            assert!(snapshot.bounded);
            assert_eq!(snapshot.work_items.len(), ASK_COUNT);
            assert!(
                snapshot
                    .work_items
                    .iter()
                    .all(|item| item.status == "completed_with_proof"),
                "all pressure WorkItems should be proof-completed"
            );
            route_count += snapshot.route_decisions.len();
            provider_link_count += snapshot
                .links
                .iter()
                .filter(|link| link.link_kind == "provider_timeline" && link.has_proof)
                .count();
            memory_candidate_seen |= snapshot
                .links
                .iter()
                .any(|link| link.link_kind == "memory_candidate" && !link.grants_memory_authority);
            mobile_event_seen |= snapshot
                .surface_events
                .iter()
                .any(|event| event.source_surface == "mobile");
            let debug = format!("{snapshot:?}");
            for forbidden in [
                "SECRET-ANSWER-TEXT",
                "test-key-not-real",
                "Candidate pressure fact",
                "raw transcript",
                "sk-test",
            ] {
                assert!(
                    !debug.contains(forbidden),
                    "pressure timeline leaked {forbidden}: {debug}"
                );
            }
            pages += 1;
            if snapshot.has_more {
                cursor = snapshot.next_cursor.clone();
                assert!(cursor.is_some(), "has_more must carry next_cursor");
            } else {
                assert_eq!(snapshot.next_cursor, None);
                break;
            }
        }
        assert!(pages > 1, "bounded read should require multiple pages");
        assert_eq!(route_count, ASK_COUNT);
        assert_eq!(provider_link_count, ASK_COUNT);
        assert!(memory_candidate_seen);
        assert!(mobile_event_seen);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            ASK_COUNT * 2,
            "projection/timeline reads must make zero additional provider/model calls"
        );
    }

    #[test]
    fn mission_bound_ask_provider_error_is_explicit_no_fallback_no_ledger() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_ask(&db);
        let client = DeepSeekClient::with_transport(
            FailingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["ask_friday".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "mission-ask-provider-down",
                1,
                Message::AskFridayRequest {
                    prompt: "Should surface provider outage without fallback.".into(),
                    mission_context: Some(MissionWorkItemContextWire {
                        friday_conversation_id: "fconv_hub_ask".into(),
                        mission_id: "mission-hub-ask".into(),
                        work_item_id: "work-hub-ask".into(),
                    }),
                },
            ),
            1_700_000_100_900,
        );
        let Message::Error { code, message } = response.message else {
            panic!("expected provider error, got {response:?}");
        };
        assert_eq!(code, ErrorCode::ProviderUnavailable);
        assert!(message.contains("no fallback"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "provider discovery failed once; no post call and no fallback provider"
        );
        assert_eq!(hub.db().count("token_ledger").unwrap(), 0);
        assert_eq!(hub.db().count("activity_item").unwrap(), 0);
        assert_eq!(
            hub.db()
                .get_work_item("work-hub-ask")
                .unwrap()
                .unwrap()
                .status,
            WorkItemStatus::ReadyToDispatch,
            "provider outage must not mark the WorkItem done"
        );
    }

    #[test]
    fn mission_bound_ask_quota_post_error_is_no_fallback_no_ledger_or_secret_leak() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_ask(&db);
        let client = DeepSeekClient::with_transport(
            PostFailingMock {
                calls: calls.clone(),
                reason: "HTTP 429 quota exhausted for SECRET-QUOTA-BODY",
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["ask_friday".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "mission-ask-quota-down",
                1,
                Message::AskFridayRequest {
                    prompt: "Should surface quota outage without fallback.".into(),
                    mission_context: Some(MissionWorkItemContextWire {
                        friday_conversation_id: "fconv_hub_ask".into(),
                        mission_id: "mission-hub-ask".into(),
                        work_item_id: "work-hub-ask".into(),
                    }),
                },
            ),
            1_700_000_100_950,
        );
        let rendered = format!("{response:?}");
        let Message::Error { code, message } = response.message else {
            panic!("expected quota provider error, got {response:?}");
        };
        assert_eq!(code, ErrorCode::ProviderUnavailable);
        assert!(message.contains("no fallback"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "quota failure should be one discovery + one post, with no fallback provider"
        );
        assert_eq!(hub.db().count("token_ledger").unwrap(), 0);
        assert_eq!(hub.db().count("activity_item").unwrap(), 0);
        assert_eq!(
            hub.db()
                .get_work_item("work-hub-ask")
                .unwrap()
                .unwrap()
                .status,
            WorkItemStatus::ReadyToDispatch,
            "quota failure must not mark the WorkItem done"
        );
        for forbidden in [
            "SECRET-QUOTA-BODY",
            "test-key-not-real",
            "Authorization",
            "Bearer",
            "sk-test",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "quota provider error leaked {forbidden}: {rendered}"
            );
        }
    }

    #[test]
    fn mission_bound_ask_network_discovery_error_is_no_fallback_no_ledger_or_completion() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_ask(&db);
        let client = DeepSeekClient::with_transport(
            FailingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["ask_friday".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "mission-ask-network-down",
                1,
                Message::AskFridayRequest {
                    prompt: "Should surface network outage without fallback.".into(),
                    mission_context: Some(MissionWorkItemContextWire {
                        friday_conversation_id: "fconv_hub_ask".into(),
                        mission_id: "mission-hub-ask".into(),
                        work_item_id: "work-hub-ask".into(),
                    }),
                },
            ),
            1_700_000_100_980,
        );
        let rendered = format!("{response:?}");
        let Message::Error { code, message } = response.message else {
            panic!("expected network provider error, got {response:?}");
        };
        assert_eq!(code, ErrorCode::ProviderUnavailable);
        assert!(message.contains("no fallback"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "network discovery failed once; no post call and no fallback provider"
        );
        assert_eq!(hub.db().count("token_ledger").unwrap(), 0);
        assert_eq!(hub.db().count("activity_item").unwrap(), 0);
        assert_eq!(
            hub.db()
                .get_work_item("work-hub-ask")
                .unwrap()
                .unwrap()
                .status,
            WorkItemStatus::ReadyToDispatch,
            "network failure must not mark the WorkItem done"
        );
        for forbidden in [
            "forced test outage",
            "test-key-not-real",
            "Authorization",
            "Bearer",
            "sk-test",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "network provider error leaked {forbidden}: {rendered}"
            );
        }
    }

    #[test]
    fn mission_bound_ask_blocks_bad_context_before_provider_call() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["ask_friday".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "mission-ask-blocked",
                1,
                Message::AskFridayRequest {
                    prompt: "Should not call model".into(),
                    mission_context: Some(MissionWorkItemContextWire {
                        friday_conversation_id: "fconv_missing".into(),
                        mission_id: "mission-missing".into(),
                        work_item_id: "work-missing".into(),
                    }),
                },
            ),
            1_700_000_100_700,
        );
        let Message::Error { code, message } = response.message else {
            panic!("expected blocked mission ask error, got {response:?}");
        };
        assert_eq!(code, ErrorCode::Internal);
        assert!(message.contains("unknown_mission"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "blocked mission ask must not make a provider/model call"
        );
        assert_eq!(hub.db().count("token_ledger").unwrap(), 0);
        assert_eq!(hub.db().count("activity_item").unwrap(), 0);
    }

    #[test]
    fn mission_timeline_request_is_refs_only_and_composes_mission_state() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_projection(&db);
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["mission_timeline".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "mission-timeline-1",
                1,
                Message::MissionTimelineRequest {
                    request: friday_protocol::MissionTimelineRequestWire {
                        friday_conversation_id: "fconv_hub_projection".into(),
                        mission_id: "mission-hub-projection".into(),
                        cursor: None,
                        limit: None,
                    },
                },
            ),
            1_700_000_000_600,
        );
        let Message::MissionTimelineSnapshot { snapshot } = response.message else {
            panic!("expected mission timeline snapshot, got {response:?}");
        };
        assert_eq!(snapshot.friday_conversation_id, "fconv_hub_projection");
        assert_eq!(snapshot.mission_id, "mission-hub-projection");
        assert_eq!(snapshot.generated_at_ms, 1_700_000_000_600);
        assert!(!snapshot.bounded);
        assert!(!snapshot.has_more);
        assert_eq!(snapshot.requested_cursor, None);
        assert_eq!(snapshot.next_cursor, None);
        assert_eq!(snapshot.retained_from, None);
        assert_eq!(snapshot.mission.status, "active");
        assert_eq!(snapshot.projections.len(), 2);
        assert_eq!(snapshot.work_items.len(), 1);
        let item = &snapshot.work_items[0];
        assert_eq!(item.work_item_id, "work-hub-route");
        assert_eq!(item.lane, "channel");
        assert_eq!(item.status, "provider_waiting");
        assert!(item.proof_receipts.is_empty());
        assert!(
            item.status != "completed_with_proof",
            "provider_waiting must not be rendered as completion"
        );
        assert!(snapshot
            .links
            .iter()
            .any(|link| link.link_kind == "channel_inbound"
                && link.has_proof
                && !link.grants_memory_authority));
        assert!(snapshot
            .links
            .iter()
            .any(|link| link.link_kind == "memory_candidate"
                && !link.has_proof
                && !link.grants_memory_authority));
        assert_eq!(snapshot.route_decisions.len(), 1);
        assert_eq!(snapshot.surface_events.len(), 1);
        let event = &snapshot.surface_events[0];
        assert_eq!(event.source_surface, "mobile");
        assert_eq!(event.mission_id, "mission-hub-projection");
        assert_eq!(event.surface_thread_id, "surface-mobile");
        assert_eq!(
            event.body_ref.as_deref(),
            Some("friday://body/mobile-message/1")
        );
        let debug = format!("{snapshot:?}");
        for forbidden in [
            "external-thread",
            "provider-token",
            "raw-chat-123",
            "telegram:raw",
            "message-99",
            "raw-private-candidate",
            "link-with-raw-channel-id",
            "/Users/example/private",
            "raw transcript",
            "sk-",
        ] {
            assert!(
                !debug.contains(forbidden),
                "Mission timeline leaked {forbidden}: {debug}"
            );
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "mission timeline is a pure Hub read"
        );
    }

    #[test]
    fn mission_timeline_request_can_page_surface_safe_refs_without_provider_call() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_projection(&db);
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["mission_timeline".into()], 256);

        let first = hub.dispatch(
            Envelope::new(
                "mission-timeline-page-1",
                1,
                Message::MissionTimelineRequest {
                    request: friday_protocol::MissionTimelineRequestWire {
                        friday_conversation_id: "fconv_hub_projection".into(),
                        mission_id: "mission-hub-projection".into(),
                        cursor: None,
                        limit: Some(3),
                    },
                },
            ),
            1_700_000_000_610,
        );
        let Message::MissionTimelineSnapshot { snapshot: first } = first.message else {
            panic!("expected first mission timeline page, got {first:?}");
        };
        assert!(first.bounded);
        assert!(first.has_more);
        assert_eq!(first.requested_cursor, None);
        assert_eq!(first.retained_from.as_deref(), Some("offset:0"));
        assert_eq!(first.next_cursor.as_deref(), Some("offset:3"));
        assert_eq!(first.route_decisions.len(), 1);
        assert_eq!(first.links.len(), 2);
        assert!(first
            .links
            .iter()
            .any(|link| link.link_kind == "route_decision"));
        assert!(first
            .links
            .iter()
            .any(|link| link.link_kind == "channel_inbound"));
        assert!(first.surface_events.is_empty());

        let second = hub.dispatch(
            Envelope::new(
                "mission-timeline-page-2",
                2,
                Message::MissionTimelineRequest {
                    request: friday_protocol::MissionTimelineRequestWire {
                        friday_conversation_id: "fconv_hub_projection".into(),
                        mission_id: "mission-hub-projection".into(),
                        cursor: first.next_cursor.clone(),
                        limit: Some(2),
                    },
                },
            ),
            1_700_000_000_620,
        );
        let Message::MissionTimelineSnapshot { snapshot: second } = second.message else {
            panic!("expected second mission timeline page, got {second:?}");
        };
        assert!(second.bounded);
        assert!(!second.has_more);
        assert_eq!(second.requested_cursor.as_deref(), Some("offset:3"));
        assert_eq!(second.retained_from.as_deref(), Some("offset:3"));
        assert_eq!(second.next_cursor, None);
        assert_eq!(second.route_decisions.len(), 0);
        assert_eq!(second.links.len(), 1);
        assert_eq!(second.links[0].link_kind, "memory_candidate");
        assert_eq!(second.surface_events.len(), 1);
        assert_eq!(second.surface_events[0].source_surface, "mobile");

        let debug = format!("{first:?}{second:?}");
        for forbidden in [
            "telegram:raw-chat-123",
            "raw-private-candidate",
            "link-with-raw-channel-id",
            "message-99",
            "test-key-not-real",
        ] {
            assert!(
                !debug.contains(forbidden),
                "bounded mission timeline leaked {forbidden}: {debug}"
            );
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "bounded mission timeline is a pure Hub read"
        );
    }

    #[test]
    fn mission_lifecycle_request_updates_mission_without_provider_call() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_projection(&db);
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["mission_lifecycle".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "mission-lifecycle-archive",
                1,
                Message::MissionLifecycleRequest {
                    request: MissionLifecycleRequestWire {
                        friday_conversation_id: "fconv_hub_projection".into(),
                        mission_id: "mission-hub-projection".into(),
                        target_status: "archived".into(),
                        actor_ref: "operator:jarvis".into(),
                        reason: "archive after duplicate Mission resolved".into(),
                        proof_ref: Some("audit://mission-lifecycle/archive".into()),
                        merged_into_mission_id: None,
                    },
                },
            ),
            1_700_000_000_700,
        );
        let Message::MissionLifecycleResult { result } = response.message else {
            panic!("expected mission lifecycle result, got {response:?}");
        };
        assert_eq!(result.friday_conversation_id, "fconv_hub_projection");
        assert_eq!(result.mission_id, "mission-hub-projection");
        assert_eq!(result.previous_status, "active");
        assert_eq!(result.status, "archived");
        assert_eq!(result.actor_ref, "operator:jarvis");
        assert_eq!(result.updated_at_ms, 1_700_000_000_700);
        assert!(!result
            .active_mission_ids
            .contains(&"mission-hub-projection".to_string()));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "Mission lifecycle mutation must not call a provider/model"
        );
        assert_eq!(hub.db().count("token_ledger").unwrap(), 0);

        let timeline = hub.dispatch(
            Envelope::new(
                "mission-lifecycle-timeline",
                2,
                Message::MissionTimelineRequest {
                    request: friday_protocol::MissionTimelineRequestWire {
                        friday_conversation_id: "fconv_hub_projection".into(),
                        mission_id: "mission-hub-projection".into(),
                        cursor: None,
                        limit: None,
                    },
                },
            ),
            1_700_000_000_710,
        );
        let Message::MissionTimelineSnapshot { snapshot } = timeline.message else {
            panic!("expected mission timeline snapshot, got {timeline:?}");
        };
        assert_eq!(snapshot.mission.status, "archived");
        assert!(snapshot
            .mission
            .proof_refs
            .contains(&"audit://mission-lifecycle/archive".to_string()));
    }

    #[test]
    fn mission_lifecycle_blocks_fake_done_before_provider_call() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_projection(&db);
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["mission_lifecycle".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "mission-lifecycle-fake-done",
                1,
                Message::MissionLifecycleRequest {
                    request: MissionLifecycleRequestWire {
                        friday_conversation_id: "fconv_hub_projection".into(),
                        mission_id: "mission-hub-projection".into(),
                        target_status: "done".into(),
                        actor_ref: "operator:jarvis".into(),
                        reason: "no proof should not complete Mission".into(),
                        proof_ref: None,
                        merged_into_mission_id: None,
                    },
                },
            ),
            1_700_000_000_800,
        );
        let Message::Error { code, message } = response.message else {
            panic!("expected mission lifecycle block, got {response:?}");
        };
        assert_eq!(code, ErrorCode::Internal);
        assert!(message.contains("done requires proof_ref"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "blocked Mission lifecycle mutation must not call a provider/model"
        );
        assert_eq!(
            hub.db()
                .get_mission("mission-hub-projection")
                .unwrap()
                .unwrap()
                .status,
            MissionStatus::Active
        );
    }

    #[test]
    fn mission_timeline_rejects_mismatched_conversation_without_provider_call() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_projection(&db);
        let client = DeepSeekClient::with_transport(
            CountingMock {
                calls: calls.clone(),
            },
            "test-key-not-real".to_string(), // pragma: allowlist secret
        );
        let mut hub = HubServer::new(db, client, vec!["mission_timeline".into()], 256);

        let response = hub.dispatch(
            Envelope::new(
                "mission-timeline-bad",
                1,
                Message::MissionTimelineRequest {
                    request: friday_protocol::MissionTimelineRequestWire {
                        friday_conversation_id: "fconv_other".into(),
                        mission_id: "mission-hub-projection".into(),
                        cursor: None,
                        limit: None,
                    },
                },
            ),
            2,
        );
        match response.message {
            Message::Error { code, message } => {
                assert_eq!(code, ErrorCode::Internal);
                assert!(message.contains("conversation mismatch"));
            }
            other => panic!("expected error for mismatched conversation, got {other:?}"),
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "invalid mission timeline request must not reach provider/model"
        );
    }

    #[test]
    fn mission_projection_rejects_provider_thread_like_id() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut hub = server(calls.clone(), &db_path);
        let response = hub.dispatch(
            Envelope::new(
                "mission-projection-bad-id",
                1,
                Message::MissionProjectionRequest {
                    request: friday_protocol::MissionProjectionRequestWire {
                        friday_conversation_id: "provider-thread-123".into(),
                    },
                },
            ),
            2,
        );
        match response.message {
            Message::Error { code, message } => {
                assert_eq!(code, ErrorCode::Internal);
                assert!(message.contains("non-canonical Friday conversation id"));
            }
            other => panic!("expected error for provider-like id, got {other:?}"),
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "invalid mission projection request must not reach provider/model"
        );
    }

    #[test]
    fn unauthenticated_session_key_serves_nothing() {
        // A client with the WRONG session key cannot produce a sealed envelope the Hub can
        // open → serve_connection ends without dispatching (fail-closed).
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let hub_kp = DeviceKeypair::generate();
        let phone_kp = DeviceKeypair::generate();
        let attacker_kp = DeviceKeypair::generate();
        let hub_pub = hub_kp.public_bytes();
        let phone_pub = phone_kp.public_bytes();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_calls = calls.clone();
        let server_db = db_path.clone();
        let srv = thread::spawn(move || {
            let session = hub_kp.agree(&phone_pub); // Hub's real session
            let mut hub = server(server_calls, &server_db);
            let (stream, _) = listener.accept().unwrap();
            let mut ws = ws_accept(stream).unwrap();
            let mut clock = || 1000i64;
            hub.serve_connection(&mut ws, &session, AAD, &mut clock)
                .unwrap();
        });

        // Attacker uses a key the Hub does not share.
        let wrong = attacker_kp.agree(&hub_pub);
        let stream = TcpStream::connect(addr).unwrap();
        let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        let ask = Envelope::new(
            "x-ask",
            1,
            Message::AskFridayRequest {
                prompt: "exfiltrate".into(),
                mission_context: None,
            },
        );
        // The send may encode, but the Hub cannot open it → no dispatch, no model call.
        let _ = ws_send_envelope(&mut ws, &wrong, &ask, AAD);
        drop(ws);
        srv.join().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "no provider call for an unauthenticated session"
        );
        let db = Db::open_hub(&db_path).unwrap();
        assert_eq!(db.count("token_ledger").unwrap(), 0);
    }

    /// LIVE Phase-1 DeepSeek proof (`#[ignore]`d) — the ONE authorized live model call.
    /// Run with the Hub credential exported, e.g.:
    ///   set -a; . /private/tmp/friday-closure-20260530/.deepseek-env; set +a
    ///   cargo test -p friday-hub --test ... -- --ignored   (here: in-crate, via --ignored)
    /// Missing credential → graceful skip recorded as an EXACT blocker (never faked).
    #[test]
    #[ignore = "live: needs FRIDAY_DEEPSEEK_API_KEY (Hub-only); one authorized DeepSeek ask"]
    fn live_ask_friday_routes_through_deepseek_and_ledgers() {
        if std::env::var(friday_deepseek::ENV_KEY)
            .map(|k| k.trim().is_empty())
            .unwrap_or(true)
        {
            eprintln!(
                "SKIP/BLOCKER: {} not set — DeepSeek live proof not run (no fake success)",
                friday_deepseek::ENV_KEY
            );
            return;
        }
        let db_path = tmp_db();
        let client = DeepSeekClient::from_env().expect("live DeepSeek client");
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_ask(&db);
        let mut hub = HubServer::new(db, client, vec!["ask_friday".into()], 64);
        let resp = hub.dispatch(
            Envelope::new(
                "live-1",
                1,
                Message::AskFridayRequest {
                    prompt: "Reply with the single word: OK".into(),
                    mission_context: Some(MissionWorkItemContextWire {
                        friday_conversation_id: "fconv_hub_ask".into(),
                        mission_id: "mission-hub-ask".into(),
                        work_item_id: "work-hub-ask".into(),
                    }),
                },
            ),
            1_700_000_000_000,
        );
        match resp.message {
            Message::AskFridayResult { ledger_id, .. } => {
                eprintln!("LIVE ask ok: ledger {ledger_id}")
            }
            Message::Error { code, message } => {
                panic!("BLOCKER (no fake): live ask errored: {code:?} {message}")
            }
            other => panic!("unexpected {other:?}"),
        }
        let db = Db::open_hub(&db_path).unwrap();
        assert_eq!(
            db.count("token_ledger").unwrap(),
            1,
            "live Mission-bound ask must write exactly one ledger row"
        );
        assert_eq!(db.count("activity_item").unwrap(), 1);
        assert_eq!(
            db.get_work_item("work-hub-ask").unwrap().unwrap().status,
            WorkItemStatus::CompletedWithProof
        );
    }

    /// LIVE negative provider proof: use an intentionally invalid DeepSeek key
    /// against the real provider endpoint. This proves an auth/provider failure
    /// is surfaced as a blocker with no fallback, no ledger row, and no fake
    /// WorkItem completion. It does not require a real secret.
    #[test]
    #[ignore = "live-negative: calls DeepSeek with an intentionally invalid key; no secret required"]
    fn live_invalid_deepseek_key_is_no_fallback_no_ledger_or_completion() {
        let db_path = tmp_db();
        let db = Db::open_hub(&db_path).unwrap();
        seed_mission_ask(&db);
        let client = DeepSeekClient::with_transport(
            friday_deepseek::UreqTransport::new(),
            "friday-invalid-key-for-negative-proof".to_string(),
        );
        let mut hub = HubServer::new(db, client, vec!["ask_friday".into()], 16);

        let response = hub.dispatch(
            Envelope::new(
                "live-invalid-key-ask",
                1,
                Message::AskFridayRequest {
                    prompt: "This should fail before any proof is written.".into(),
                    mission_context: Some(MissionWorkItemContextWire {
                        friday_conversation_id: "fconv_hub_ask".into(),
                        mission_id: "mission-hub-ask".into(),
                        work_item_id: "work-hub-ask".into(),
                    }),
                },
            ),
            1_700_000_650_000,
        );
        let rendered = format!("{response:?}");
        let Message::Error { code, message } = response.message else {
            panic!("expected invalid-key provider error, got {response:?}");
        };
        eprintln!("[live-negative] invalid DeepSeek key surfaced: {code:?} {message}");
        assert_eq!(code, ErrorCode::ProviderUnavailable);
        assert!(message.contains("no fallback"));
        assert_eq!(hub.db().count("token_ledger").unwrap(), 0);
        assert_eq!(hub.db().count("activity_item").unwrap(), 0);
        assert_eq!(
            hub.db()
                .get_work_item("work-hub-ask")
                .unwrap()
                .unwrap()
                .status,
            WorkItemStatus::ReadyToDispatch,
            "invalid provider key must not mark the WorkItem done"
        );
        for forbidden in [
            "friday-invalid-key-for-negative-proof",
            "Authorization",
            "Bearer",
            "sk-test",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "invalid-key error leaked {forbidden}: {rendered}"
            );
        }
    }

    /// LIVE pressure proof for the operator's requested closed loop:
    /// Mission context -> real provider execution -> proof receipts -> bounded
    /// timeline -> same Mission projections. This intentionally FAILS with an
    /// exact blocker when the Hub-only DeepSeek key is missing; missing key is not
    /// a fake pass.
    #[test]
    #[ignore = "live/stress: requires FRIDAY_DEEPSEEK_API_KEY; runs 20-50 real Mission-bound asks"]
    fn live_mission_bound_deepseek_pressure_asks_write_proof_and_bounded_timeline() {
        if std::env::var(friday_deepseek::ENV_KEY)
            .map(|k| k.trim().is_empty())
            .unwrap_or(true)
        {
            panic!(
                "BLOCKER: {} not set — cannot run real Mission-bound provider pressure proof",
                friday_deepseek::ENV_KEY
            );
        }
        let ask_count = std::env::var("FRIDAY_MISSION_LIVE_ASKS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(20)
            .clamp(20, 50);
        let db_path = tmp_db();
        let db = Db::open_hub(&db_path).unwrap();
        seed_pressure_mission(&db, ask_count);
        let client = DeepSeekClient::from_env().expect("live DeepSeek client");
        let mut hub = HubServer::new(db, client, vec!["ask_friday".into()], 16);

        for index in 0..ask_count {
            let response = hub.dispatch(
                Envelope::new(
                    format!("live-pressure-ask-{index:02}"),
                    index as i64,
                    Message::AskFridayRequest {
                        prompt: format!("Live pressure ask {index:02}. Reply with only OK."),
                        mission_context: Some(MissionWorkItemContextWire {
                            friday_conversation_id: "fconv_pressure".into(),
                            mission_id: "mission-pressure".into(),
                            work_item_id: format!("work-pressure-{index:02}"),
                        }),
                    },
                ),
                1_700_000_700_000 + index as i64,
            );
            match response.message {
                Message::AskFridayResult { ledger_id, .. } => {
                    eprintln!("[live-pressure] {index:02} ledger={ledger_id}");
                }
                Message::Error { code, message } => {
                    panic!(
                        "BLOCKER: live Mission-bound ask {index:02} errored: {code:?} {message}"
                    );
                }
                other => panic!("unexpected live pressure response: {other:?}"),
            }
        }
        assert_eq!(hub.db().count("token_ledger").unwrap(), ask_count as i64);
        assert_eq!(hub.db().count("activity_item").unwrap(), ask_count as i64);
        assert_eq!(memory::auto_usable(hub.db().conn()).unwrap().len(), 0);

        let mut cursor = None;
        let mut pages = 0usize;
        let mut provider_link_count = 0usize;
        loop {
            let response = hub.dispatch(
                Envelope::new(
                    format!("live-pressure-timeline-{pages}"),
                    200 + pages as i64,
                    Message::MissionTimelineRequest {
                        request: friday_protocol::MissionTimelineRequestWire {
                            friday_conversation_id: "fconv_pressure".into(),
                            mission_id: "mission-pressure".into(),
                            cursor: cursor.clone(),
                            limit: Some(25),
                        },
                    },
                ),
                1_700_000_800_000 + pages as i64,
            );
            let Message::MissionTimelineSnapshot { snapshot } = response.message else {
                panic!("expected live pressure timeline, got {response:?}");
            };
            assert!(snapshot.bounded);
            assert_eq!(snapshot.work_items.len(), ask_count);
            assert!(snapshot
                .work_items
                .iter()
                .all(|item| item.status == "completed_with_proof"));
            provider_link_count += snapshot
                .links
                .iter()
                .filter(|link| link.link_kind == "provider_timeline" && link.has_proof)
                .count();
            let rendered = format!("{snapshot:?}");
            for forbidden in [
                "FRIDAY_DEEPSEEK_API_KEY",
                "sk-test",
                "SECRET",
                "Candidate pressure fact",
                "raw transcript",
            ] {
                assert!(
                    !rendered.contains(forbidden),
                    "live pressure timeline leaked {forbidden}: {rendered}"
                );
            }
            pages += 1;
            if snapshot.has_more {
                cursor = snapshot.next_cursor;
                assert!(cursor.is_some());
            } else {
                break;
            }
        }
        assert!(pages > 1);
        assert_eq!(provider_link_count, ask_count);
    }

    // --- A1 run-outcome learning confirm arm -----------------------------------------------

    fn seed_run_outcome_candidate(db: &Db, run_id: &str, session_id: &str, owner: &str) {
        friday_storage::ensure_session_with_owner(
            db.conn(),
            session_id,
            &friday_storage::SessionOwner {
                user_id: Some(owner.to_string()),
                ..Default::default()
            },
            1_000,
        )
        .unwrap();
        friday_storage::agent_run::create_run(db.conn(), run_id, "refs-only task", 1_000).unwrap();
        friday_storage::learning_candidate::record_run_outcome_candidates(
            db.conn(),
            run_id,
            Some(session_id),
            2,
            1,
            1_100,
        )
        .unwrap();
    }

    fn seed_run_outcome_candidate_with_run_owner(
        db: &Db,
        run_id: &str,
        session_id: Option<&str>,
        owner: &str,
    ) {
        friday_storage::agent_run::create_run(db.conn(), run_id, "refs-only task", 1_000).unwrap();
        friday_storage::persist_run_result(
            db.conn(),
            run_id,
            &friday_storage::RunResult::new("finished", "refs-only answer", None)
                .with_owner_principal(owner),
            1_050,
        )
        .unwrap();
        friday_storage::learning_candidate::record_run_outcome_candidates(
            db.conn(),
            run_id,
            session_id,
            2,
            1,
            1_100,
        )
        .unwrap();
    }

    fn decode_run_outcome_learning_decision(
        env: &Envelope,
    ) -> &RunOutcomeLearningDecisionResultWire {
        match &env.message {
            Message::RunOutcomeLearningDecisionResult { result } => result,
            other => panic!("expected RunOutcomeLearningDecisionResult, got {other:?}"),
        }
    }

    fn decode_activity_mark_done(env: &Envelope) -> &ActivityMarkDoneResultWire {
        match &env.message {
            Message::ActivityMarkDoneResult { result } => result,
            other => panic!("expected ActivityMarkDoneResult, got {other:?}"),
        }
    }

    fn seed_activity(db: &Db, activity_id: &str) {
        seed_activity_owned(db, activity_id, Some("owner-1"));
    }

    /// Seed a Pending ApprovalRequired row owned by `owner` (None = pre-migration NULL owner).
    fn seed_activity_owned(db: &Db, activity_id: &str, owner: Option<&str>) {
        db.insert_activity(&friday_storage::ActivityRow {
            activity_id: activity_id.to_string(),
            session_id: Some("session-activity".to_string()),
            kind: friday_core::ActivityType::ApprovalRequired,
            state: friday_core::ActivityState::Pending,
            summary: "approval required · refs only".to_string(),
            created_at: 1_000,
            updated_at: 1_000,
            deep_link: Some("friday://activity/session-activity".to_string()),
            owner: owner.map(str::to_string),
        })
        .unwrap();
    }

    #[test]
    fn activity_mark_done_marks_only_activity_row_done() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_activity(&db, "activity-mark-done-1");

        let env = activity_mark_done_result_for_db(
            &db,
            "msg-activity-done",
            ActivityMarkDoneRequestWire {
                activity_id: "activity-mark-done-1".into(),
                reason: Some("owner cleared it".into()),
            },
            // The seeded row's owner — an owner-match ALLOW.
            Some("owner-1"),
            1_200,
        );
        let result = decode_activity_mark_done(&env);
        assert_eq!(result.status, "done");
        assert_eq!(result.state, "done");
        assert_eq!(result.activity_id, "activity-mark-done-1");
        assert!(result.blocker.is_none());

        let rows = db.list_activity().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].activity_id, "activity-mark-done-1");
        assert_eq!(rows[0].state, "done");
        assert_eq!(
            db.count("token_ledger").unwrap(),
            0,
            "marking activity done makes NO model call"
        );
        assert_eq!(
            db.count("work_item").unwrap(),
            0,
            "marking activity done must not complete or create WorkItems"
        );
    }

    #[test]
    fn activity_mark_done_unknown_id_is_blocked_and_changes_nothing() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let env = activity_mark_done_result_for_db(
            &db,
            "msg-activity-unknown",
            ActivityMarkDoneRequestWire {
                activity_id: "missing-activity".into(),
                reason: None,
            },
            // A non-empty authenticated owner so this exercises the unknown-id path, NOT the
            // owner-empty fail-closed path.
            Some("owner-1"),
            1_200,
        );
        let result = decode_activity_mark_done(&env);
        assert_eq!(result.status, "blocked");
        assert_eq!(result.state, "unknown");
        assert_eq!(result.blocker.as_deref(), Some("unknown_activity"));
        assert_eq!(db.count("activity_item").unwrap(), 0);
    }

    /// M6: the producer fails closed when no authenticated owner is threaded (None / empty /
    /// whitespace), mirroring `memory_decision_result_for_db`. The WS arm always passes
    /// `Some(principal)`; this is the defense-in-depth guard.
    #[test]
    fn activity_mark_done_empty_owner_is_blocked_owner_principal_required() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_activity(&db, "activity-mark-done-1");
        for owner in [None, Some(""), Some("   ")] {
            let env = activity_mark_done_result_for_db(
                &db,
                "msg-no-owner",
                ActivityMarkDoneRequestWire {
                    activity_id: "activity-mark-done-1".into(),
                    reason: None,
                },
                owner,
                1_200,
            );
            let result = decode_activity_mark_done(&env);
            assert_eq!(
                result.status, "blocked",
                "empty owner ⇒ blocked ({owner:?})"
            );
            assert_eq!(result.blocker.as_deref(), Some("owner_principal_required"));
        }
        // The row was never touched.
        let rows = db.list_activity().unwrap();
        assert_eq!(rows[0].state, "pending");
    }

    /// M6: a cross-owner mark-done (the row is owned by a DIFFERENT principal) is BLOCKED and
    /// the row is unchanged. By design the cross-owner case is indistinguishable from an
    /// unknown id (no existence oracle), so only `status=="blocked"` is asserted — NOT a
    /// distinct mismatch reason.
    #[test]
    fn activity_mark_done_cross_owner_is_blocked_and_row_unchanged() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_activity_owned(&db, "activity-mark-done-1", Some("owner-1"));
        let env = activity_mark_done_result_for_db(
            &db,
            "msg-cross-owner",
            ActivityMarkDoneRequestWire {
                activity_id: "activity-mark-done-1".into(),
                reason: None,
            },
            // A DIFFERENT authenticated principal.
            Some("owner-2"),
            1_200,
        );
        let result = decode_activity_mark_done(&env);
        assert_eq!(result.status, "blocked", "a cross-owner clear is blocked");
        // Row unchanged — still Pending, never cleared by a non-owner.
        let rows = db.list_activity().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].state, "pending",
            "the non-owner clear changed nothing"
        );
    }

    /// M6: a pre-migration (NULL-owner) row is legacy-allow — any authenticated principal can
    /// clear it (a deny-NULL would strand pre-deploy rows = a degrade).
    #[test]
    fn activity_mark_done_null_owner_legacy_row_is_allowed_for_any_principal() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        // A pre-migration row carries owner = NULL.
        seed_activity_owned(&db, "activity-mark-done-1", None);
        let env = activity_mark_done_result_for_db(
            &db,
            "msg-null-owner",
            ActivityMarkDoneRequestWire {
                activity_id: "activity-mark-done-1".into(),
                reason: None,
            },
            Some("any-principal"),
            1_200,
        );
        let result = decode_activity_mark_done(&env);
        assert_eq!(
            result.status, "done",
            "a NULL-owner legacy row clears (legacy-allow)"
        );
        let rows = db.list_activity().unwrap();
        assert_eq!(rows[0].state, "done");
    }

    #[test]
    fn run_outcome_learning_decision_confirm_marks_candidate_terminal_for_owner() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_run_outcome_candidate(&db, "run-a1-confirm", "sess-a1-confirm", "owner-1");

        let env = run_outcome_learning_decision_result_for_db(
            &db,
            "msg-a1-confirm",
            RunOutcomeLearningDecisionRequestWire {
                candidate_id: "a1:run-a1-confirm:preference".into(),
                decision: "confirm".into(),
                reason: Some("owner accepted the preference".into()),
            },
            Some("owner-1"),
            1_200,
        );
        let result = decode_run_outcome_learning_decision(&env);
        assert_eq!(result.status, "confirmed");
        assert_eq!(result.state, "confirmed");
        assert_eq!(result.run_id.as_deref(), Some("run-a1-confirm"));
        assert_eq!(result.kind.as_deref(), Some("preference"));
        assert!(result.blocker.is_none());

        let row = friday_storage::learning_candidate::get_run_outcome_candidate(
            db.conn(),
            "a1:run-a1-confirm:preference",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            row.state,
            friday_storage::learning_candidate::RunOutcomeLearningState::Confirmed
        );
        assert_eq!(
            row.decision_reason.as_deref(),
            Some("owner accepted the preference")
        );
    }

    #[test]
    fn run_outcome_learning_decision_accepts_finished_run_owner_without_session_owner() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_run_outcome_candidate_with_run_owner(
            &db,
            "run-a1-mission-owned",
            Some("run-a1-mission-owned"),
            "owner-1",
        );

        let env = run_outcome_learning_decision_result_for_db(
            &db,
            "msg-a1-run-owner",
            RunOutcomeLearningDecisionRequestWire {
                candidate_id: "a1:run-a1-mission-owned:preference".into(),
                decision: "confirm".into(),
                reason: Some("mission-bound run owner accepted the preference".into()),
            },
            Some("owner-1"),
            1_200,
        );
        let result = decode_run_outcome_learning_decision(&env);
        assert_eq!(result.status, "confirmed");
        assert_eq!(result.state, "confirmed");
        assert!(result.blocker.is_none());

        let row = friday_storage::learning_candidate::get_run_outcome_candidate(
            db.conn(),
            "a1:run-a1-mission-owned:preference",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            row.state,
            friday_storage::learning_candidate::RunOutcomeLearningState::Confirmed
        );
    }

    #[test]
    fn run_outcome_learning_decision_wrong_finished_run_owner_is_blocked() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_run_outcome_candidate_with_run_owner(
            &db,
            "run-a1-mission-scope",
            Some("run-a1-mission-scope"),
            "owner-1",
        );

        let env = run_outcome_learning_decision_result_for_db(
            &db,
            "msg-a1-run-owner-scope",
            RunOutcomeLearningDecisionRequestWire {
                candidate_id: "a1:run-a1-mission-scope:world_model".into(),
                decision: "confirm".into(),
                reason: None,
            },
            Some("intruder"),
            1_200,
        );
        let result = decode_run_outcome_learning_decision(&env);
        assert_eq!(result.status, "blocked");
        assert_eq!(result.blocker.as_deref(), Some("owner_scope_mismatch"));

        let row = friday_storage::learning_candidate::get_run_outcome_candidate(
            db.conn(),
            "a1:run-a1-mission-scope:world_model",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            row.state,
            friday_storage::learning_candidate::RunOutcomeLearningState::Pending
        );
    }

    #[test]
    fn run_outcome_learning_decision_wrong_owner_is_blocked_and_unchanged() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_run_outcome_candidate(&db, "run-a1-scope", "sess-a1-scope", "owner-1");

        let env = run_outcome_learning_decision_result_for_db(
            &db,
            "msg-a1-scope",
            RunOutcomeLearningDecisionRequestWire {
                candidate_id: "a1:run-a1-scope:reflex".into(),
                decision: "confirm".into(),
                reason: None,
            },
            Some("intruder"),
            1_200,
        );
        let result = decode_run_outcome_learning_decision(&env);
        assert_eq!(result.status, "blocked");
        assert_eq!(result.blocker.as_deref(), Some("owner_scope_mismatch"));

        let row = friday_storage::learning_candidate::get_run_outcome_candidate(
            db.conn(),
            "a1:run-a1-scope:reflex",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            row.state,
            friday_storage::learning_candidate::RunOutcomeLearningState::Pending
        );
    }

    #[test]
    fn run_outcome_learning_decision_terminal_candidate_is_not_redone() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        seed_run_outcome_candidate(&db, "run-a1-terminal", "sess-a1-terminal", "owner-1");
        friday_storage::learning_candidate::decide_run_outcome_candidate(
            db.conn(),
            "a1:run-a1-terminal:world_model",
            true,
            1_200,
            Some("first decision"),
        )
        .unwrap();

        let env = run_outcome_learning_decision_result_for_db(
            &db,
            "msg-a1-terminal",
            RunOutcomeLearningDecisionRequestWire {
                candidate_id: "a1:run-a1-terminal:world_model".into(),
                decision: "reject".into(),
                reason: Some("try to change it".into()),
            },
            Some("owner-1"),
            1_300,
        );
        let result = decode_run_outcome_learning_decision(&env);
        assert_eq!(result.status, "blocked");
        assert_eq!(result.blocker.as_deref(), Some("not_decidable"));

        let row = friday_storage::learning_candidate::get_run_outcome_candidate(
            db.conn(),
            "a1:run-a1-terminal:world_model",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            row.state,
            friday_storage::learning_candidate::RunOutcomeLearningState::Confirmed
        );
        assert_eq!(row.decision_reason.as_deref(), Some("first decision"));
    }

    // --- Memory-confirm arm (the live caller that CLOSES the Memory-confirmation loop) ---------

    /// The COMPOSITE namespace a session owned by `owner` resolves to (account/channel unset →
    /// "default"/"unknown", direct userId == owner) — EXACTLY what the live extraction keys a
    /// candidate's `principal_id` on for an agent-run session bound to `owner`, and the SAME
    /// scope source the confirm handler now derives from `authenticated_owner`.
    fn composite_ns(owner: &str) -> String {
        crate::session_namespace::resolve_session_memory_namespace(None, None, Some(owner)).unwrap()
    }

    /// Seed ONE pending memory candidate keyed on `owner`'s COMPOSITE namespace (what live
    /// extraction stores) — or UNOWNED when `owner` is `None` — with content (so a confirm makes
    /// it recallable; `recall_confirmed` requires non-NULL/non-empty content). The decision
    /// handler is driven with `authenticated_owner = owner`, so a matching owner resolves the
    /// SAME composite namespace and the membership scope check passes.
    fn seed_memory_candidate(db: &Db, memory_id: &str, owner: Option<&str>, now: i64) {
        let ns = owner.map(composite_ns);
        memory::record_candidate(
            db.conn(),
            &memory::NewMemoryCandidate {
                memory_id,
                scope: MemoryScope::Global,
                content_ref: None,
                // Content-bearing: a confirm must yield a recallable row.
                content: Some("prefers rust"),
                principal_id: ns.as_deref(),
                sensitive: false,
                created_at: now,
            },
        )
        .unwrap();
    }

    fn decode_memory_decision(env: &Envelope) -> &MemoryDecisionResultWire {
        match &env.message {
            Message::MemoryDecisionResult { result } => result,
            other => panic!("expected MemoryDecisionResult, got {other:?}"),
        }
    }

    #[test]
    fn memory_decision_confirm_makes_candidate_recallable() {
        // The whole point of the loop: a confirmed, owner-owned, content-bearing candidate becomes
        // recallable (the answer path's `recall_confirmed` returns it).
        let db = Db::open_hub(&tmp_db()).unwrap();
        let now = 1_700_000_000_000;
        seed_memory_candidate(&db, "mem-confirm", Some("owner-1"), now);
        let ns = composite_ns("owner-1");
        // Pre-confirm: NOT recallable (under the COMPOSITE namespace the candidate is keyed on).
        assert!(memory::recall_confirmed(db.conn(), &ns).unwrap().is_empty());

        let env = memory_decision_result_for_db(
            &db,
            "msg-confirm",
            MemoryDecisionRequestWire {
                // The raw body field is IRRELEVANT to scope now (the authenticated owner is) —
                // pass an arbitrary value to prove it is no longer the scope source.
                memory_id: "mem-confirm".into(),
                owner_principal: "ignored-body-field".into(),
                decision: "confirm".into(),
            },
            Some("owner-1"),
            now + 1,
        );
        let result = decode_memory_decision(&env);
        assert_eq!(result.status, "confirmed");
        assert_eq!(result.state, "confirmed");
        assert!(
            result.recallable,
            "a confirmed candidate must be recallable"
        );
        assert!(result.blocker.is_none());

        // Storage truth: the row is Confirmed AND recall (keyed on the composite namespace, as
        // the live sessioned recall is) now returns it.
        assert_eq!(
            memory::get(db.conn(), "mem-confirm")
                .unwrap()
                .unwrap()
                .state,
            friday_core::MemoryState::Confirmed
        );
        let recalled = memory::recall_confirmed(db.conn(), &ns).unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0].memory_id, "mem-confirm");
    }

    #[test]
    fn memory_decision_reject_is_terminal_and_not_recallable() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let now = 1_700_000_000_000;
        seed_memory_candidate(&db, "mem-reject", Some("owner-1"), now);

        let env = memory_decision_result_for_db(
            &db,
            "msg-reject",
            MemoryDecisionRequestWire {
                memory_id: "mem-reject".into(),
                owner_principal: "ignored-body-field".into(),
                decision: "reject".into(),
            },
            Some("owner-1"),
            now + 1,
        );
        let result = decode_memory_decision(&env);
        assert_eq!(result.status, "rejected");
        assert_eq!(result.state, "rejected");
        assert!(
            !result.recallable,
            "a rejected candidate is never recallable"
        );

        assert_eq!(
            memory::get(db.conn(), "mem-reject").unwrap().unwrap().state,
            friday_core::MemoryState::Rejected
        );
        assert!(
            memory::recall_confirmed(db.conn(), &composite_ns("owner-1"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn memory_decision_owner_mismatch_is_blocked_and_leaves_candidate_unchanged() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let now = 1_700_000_000_000;
        seed_memory_candidate(&db, "mem-scope", Some("owner-1"), now);

        // A DIFFERENT AUTHENTICATED principal tries to confirm owner-1's candidate. The
        // intruder's namespace candidate list can NEVER contain owner-1's composite namespace —
        // the no-cross-owner-confirm guard.
        let env = memory_decision_result_for_db(
            &db,
            "msg-scope",
            MemoryDecisionRequestWire {
                memory_id: "mem-scope".into(),
                owner_principal: "owner-1".into(), // even spoofing the body field can't help
                decision: "confirm".into(),
            },
            Some("intruder"),
            now + 1,
        );
        let result = decode_memory_decision(&env);
        assert_eq!(result.status, "blocked");
        assert_eq!(result.blocker.as_deref(), Some("owner_scope_mismatch"));
        assert!(!result.recallable);

        // UNCHANGED: still a pending Candidate; recallable by no one.
        assert_eq!(
            memory::get(db.conn(), "mem-scope").unwrap().unwrap().state,
            friday_core::MemoryState::Candidate
        );
        assert!(
            memory::recall_confirmed(db.conn(), &composite_ns("owner-1"))
                .unwrap()
                .is_empty()
        );
        assert!(
            memory::recall_confirmed(db.conn(), &composite_ns("intruder"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn memory_decision_unowned_candidate_is_decidable_by_no_one() {
        // An UNOWNED (`None`-principal) candidate must be decidable by no one — fail-closed, no
        // wildcard (mirrors `recall_confirmed`'s blank→fail-closed rule).
        let db = Db::open_hub(&tmp_db()).unwrap();
        let now = 1_700_000_000_000;
        seed_memory_candidate(&db, "mem-unowned", None, now);

        let env = memory_decision_result_for_db(
            &db,
            "msg-unowned",
            MemoryDecisionRequestWire {
                memory_id: "mem-unowned".into(),
                owner_principal: "owner-1".into(),
                decision: "confirm".into(),
            },
            Some("owner-1"),
            now + 1,
        );
        let result = decode_memory_decision(&env);
        assert_eq!(result.status, "blocked");
        assert_eq!(result.blocker.as_deref(), Some("owner_scope_mismatch"));
        assert_eq!(
            memory::get(db.conn(), "mem-unowned")
                .unwrap()
                .unwrap()
                .state,
            friday_core::MemoryState::Candidate
        );
    }

    #[test]
    fn memory_decision_unknown_candidate_is_blocked_no_panic() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let env = memory_decision_result_for_db(
            &db,
            "msg-unknown",
            MemoryDecisionRequestWire {
                memory_id: "does-not-exist".into(),
                owner_principal: "owner-1".into(),
                decision: "confirm".into(),
            },
            Some("owner-1"),
            1_700_000_000_000,
        );
        let result = decode_memory_decision(&env);
        assert_eq!(result.status, "blocked");
        assert_eq!(result.state, "unknown");
        assert_eq!(result.blocker.as_deref(), Some("unknown_candidate"));
        assert!(!result.recallable);
    }

    #[test]
    fn memory_decision_invalid_decision_token_is_blocked() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        let now = 1_700_000_000_000;
        seed_memory_candidate(&db, "mem-bad-token", Some("owner-1"), now);
        let env = memory_decision_result_for_db(
            &db,
            "msg-bad-token",
            MemoryDecisionRequestWire {
                memory_id: "mem-bad-token".into(),
                owner_principal: "owner-1".into(),
                decision: "maybe".into(),
            },
            Some("owner-1"),
            now + 1,
        );
        let result = decode_memory_decision(&env);
        assert_eq!(result.status, "blocked");
        assert_eq!(result.blocker.as_deref(), Some("invalid_decision"));
        // The candidate is untouched (no decide call).
        assert_eq!(
            memory::get(db.conn(), "mem-bad-token")
                .unwrap()
                .unwrap()
                .state,
            friday_core::MemoryState::Candidate
        );
    }

    #[test]
    fn memory_decision_terminal_candidate_is_refused() {
        // Re-deciding a terminal (already-confirmed) candidate is refused by the storage layer —
        // surfaced as a block, never a panic; the confirmed row stays confirmed.
        let db = Db::open_hub(&tmp_db()).unwrap();
        let now = 1_700_000_000_000;
        seed_memory_candidate(&db, "mem-terminal", Some("owner-1"), now);
        memory::confirm(db.conn(), "mem-terminal", now + 1).unwrap();

        let env = memory_decision_result_for_db(
            &db,
            "msg-terminal",
            MemoryDecisionRequestWire {
                memory_id: "mem-terminal".into(),
                owner_principal: "owner-1".into(),
                decision: "reject".into(),
            },
            Some("owner-1"),
            now + 2,
        );
        let result = decode_memory_decision(&env);
        assert_eq!(result.status, "blocked");
        assert_eq!(result.blocker.as_deref(), Some("not_decidable"));
        // Still Confirmed (no downgrade) and still recallable.
        assert_eq!(
            memory::get(db.conn(), "mem-terminal")
                .unwrap()
                .unwrap()
                .state,
            friday_core::MemoryState::Confirmed
        );
        assert_eq!(
            memory::recall_confirmed(db.conn(), &composite_ns("owner-1"))
                .unwrap()
                .len(),
            1
        );
    }
}

#[cfg(test)]
mod authed_route_tests {
    //! D1-Q4 adversarial tests: the auth boundary is the point.
    //!
    //! Authentication reuses the existing sealed-session mechanism (`DeviceKeypair` ECDH →
    //! `DataKey`); the body is released ONLY to the authenticated owner; unauth / wrong-
    //! principal / provider-unavailable are body-free; and no proof/log projection carries
    //! the body or a secret.
    use super::*;
    use crate::runtime::{DenyAllApprovals, HubConfig, HubRuntime};
    use crate::DeepSeekAgentLlmClient;
    use friday_crypto::{seal, DeviceKeypair};
    use friday_deepseek::{DeepSeekClient, DeepSeekError};
    use friday_storage::{persist_run_result, RunResult};
    use serde_json::Value;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-authed-route-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    const AAD: &[u8] = b"d1q4-authed-route-aad";
    const CHALLENGE: &[u8] = b"d1q4-authed-run-challenge";
    const BODY: &str = "AUTHED-ROUTE-BODY-CANARY-only-owner-P";

    /// Two halves of ONE shared session via DeviceKeypair ECDH (the existing pairing/session
    /// mechanism): a challenge sealed by the caller opens for the hub == authenticated.
    fn paired_sessions() -> (DataKey, DataKey) {
        let hub = DeviceKeypair::generate();
        let phone = DeviceKeypair::generate();
        (
            hub.agree(&phone.public_bytes()),
            phone.agree(&hub.public_bytes()),
        )
    }

    /// An authenticated caller bound to `principal` over a freshly paired session.
    fn authed(principal: &str) -> AuthedPrincipal {
        let (hub_session, caller_session) = paired_sessions();
        let sealed = seal(&caller_session, CHALLENGE, AAD).unwrap();
        AuthedPrincipal::authenticate(&hub_session, &sealed, AAD, CHALLENGE, principal).unwrap()
    }

    // --- authentication boundary (the existing sealed-session mechanism) ------

    #[test]
    fn authenticate_grants_principal_for_the_paired_caller() {
        let (hub_session, caller_session) = paired_sessions();
        let sealed = seal(&caller_session, CHALLENGE, AAD).unwrap();
        let authed =
            AuthedPrincipal::authenticate(&hub_session, &sealed, AAD, CHALLENGE, "principal:owner")
                .expect("the paired caller authenticates");
        assert_eq!(authed.principal(), "principal:owner");
    }

    #[test]
    fn authenticate_denies_an_unpaired_attacker_keypair() {
        // The attacker shares NO key with the hub → its seal does not open → None. THIS is the
        // real auth boundary: no principal ⇒ no run, no body downstream (fail-closed).
        let hub = DeviceKeypair::generate();
        let real_phone = DeviceKeypair::generate();
        let hub_session = hub.agree(&real_phone.public_bytes());

        let attacker = DeviceKeypair::generate();
        let attacker_session = attacker.agree(&hub.public_bytes()); // hub never shared with attacker
        let sealed = seal(&attacker_session, CHALLENGE, AAD).unwrap();
        assert!(
            AuthedPrincipal::authenticate(&hub_session, &sealed, AAD, CHALLENGE, "principal:owner")
                .is_none(),
            "an unpaired attacker keypair must NOT authenticate"
        );
    }

    #[test]
    fn authenticate_denies_wrong_challenge_or_blank_principal() {
        let (hub_session, caller_session) = paired_sessions();
        // A seal of the WRONG bytes (opens, but is not the agreed challenge) is refused.
        let sealed_wrong = seal(&caller_session, b"not-the-challenge", AAD).unwrap();
        assert!(AuthedPrincipal::authenticate(
            &hub_session,
            &sealed_wrong,
            AAD,
            CHALLENGE,
            "principal:owner"
        )
        .is_none());
        // A blank/anonymous principal is refused (no anonymous owner).
        let sealed_ok = seal(&caller_session, CHALLENGE, AAD).unwrap();
        assert!(
            AuthedPrincipal::authenticate(&hub_session, &sealed_ok, AAD, CHALLENGE, "   ")
                .is_none()
        );
    }

    // --- S-C: authenticate_forwarded (the trusted-peer-forwarded principal sibling) ----------
    // --- S-E: per-handshake nonce + (principal, run_id) AAD binding (anti-replay) ------------

    // --- S-R0: the write-path AAD is BYTE-UNCHANGED by the `bound_context` generalization -----
    /// FROZEN-AAD KAT. The S-R0 refactor generalized [`auth_aad`]'s third argument from
    /// `run_id: &str` to an opaque `bound_context: &[u8]`. This KAT pins the EXACT bytes [`auth_aad`]
    /// emits for a known write-path `(aad, principal, run_id)` triple — a literal `Vec<u8>`, not an
    /// old-fn==new-fn comparison (the old fn is gone). It is the structural proof that the write
    /// path's auth AAD did not change: the session AAD, then a 4-byte BE length + the principal
    /// bytes, then a 4-byte BE length + the run_id bytes (now passed as `run_id.as_bytes()`). If a
    /// future edit perturbs the encoding, every captured write `auth_proof` would stop verifying —
    /// this test red-flags that BEFORE it ships.
    #[test]
    fn auth_aad_write_path_is_byte_unchanged() {
        let aad = b"friday:execrun:ws:s-c:agent-run-session:aad:v1";
        let principal = "principal:owner-allowlisted";
        let run_id = "run-x";
        // The write path passes `run_id.as_bytes()` (the byte-identical-for-writes substitution).
        let got = auth_aad(aad, principal, run_id.as_bytes());
        // Construct the EXPECTED bytes independently: aad || be32(plen) || principal || be32(rlen) ||
        // run_id. Frozen literal lengths: principal = 27 bytes, run_id = 5 bytes.
        let mut expected = Vec::new();
        expected.extend_from_slice(aad);
        expected.extend_from_slice(&27u32.to_be_bytes());
        expected.extend_from_slice(principal.as_bytes());
        expected.extend_from_slice(&5u32.to_be_bytes());
        expected.extend_from_slice(run_id.as_bytes());
        assert_eq!(principal.len(), 27, "frozen principal length");
        assert_eq!(run_id.len(), 5, "frozen run_id length");
        assert_eq!(
            got, expected,
            "the write-path auth AAD bytes must be byte-identical after the bound_context generalization"
        );
    }

    /// The allowlisted single Hub owner used by the forwarded-auth tests.
    const FWD_OWNER: &str = "principal:forwarded-owner";
    /// A fixed per-handshake nonce stand-in for the unit tests (the bin tests drive the REAL
    /// per-connection CSPRNG nonce end-to-end). Non-secret. // pragma: allowlist secret
    /// SESSION_NONCE_LEN (64) bytes wide — matches the server's real `generate_approval_nonce`
    /// output so the tests exercise the production path (and the verifier's self-enforcement guard).
    const FWD_NONCE: &[u8] = &[b'a'; 64];
    /// A second, DISTINCT 64-byte nonce — the "later handshake" in the replay test.
    const FWD_NONCE_2: &[u8] = &[b'b'; 64];
    /// The run_id bound into the auth AAD for the forwarded-auth tests.
    const FWD_RUN: &str = "run:fwd-unit";

    /// Build a valid forwarded auth_proof sealed under the peer's session view, BOUND to the
    /// given handshake `nonce` and `(principal, bound_context)` AAD — the S-E binding the peer
    /// performs. The write path's `bound_context` is `run_id.as_bytes()`.
    fn fwd_proof_bound(
        caller_session: &DataKey,
        nonce: &[u8],
        principal: &str,
        run_id: &str,
    ) -> Sealed {
        let challenge = nonce_bound_challenge(CHALLENGE, nonce);
        let req_aad = auth_aad(AAD, principal, run_id.as_bytes());
        seal(caller_session, &challenge, &req_aad).unwrap()
    }

    /// The common-case proof: bound to `FWD_NONCE`, `FWD_OWNER`, `FWD_RUN`.
    fn fwd_proof(caller_session: &DataKey) -> Sealed {
        fwd_proof_bound(caller_session, FWD_NONCE, FWD_OWNER, FWD_RUN)
    }

    #[test]
    fn authenticate_forwarded_binds_an_allowlisted_principal_for_the_paired_peer() {
        let (hub_session, caller_session) = paired_sessions();
        let proof = fwd_proof(&caller_session);
        let bound = AuthedPrincipal::authenticate_forwarded(
            &hub_session,
            AAD,
            CHALLENGE,
            ForwardedAuth {
                auth_proof: &proof,
                session_nonce: FWD_NONCE,
                bound_context: FWD_RUN.as_bytes(),
                forwarded_principal: FWD_OWNER,
            },
            &[FWD_OWNER.to_string()],
        )
        .expect("a paired peer forwarding an allowlisted principal authenticates");
        assert_eq!(
            bound.principal(),
            FWD_OWNER,
            "binds the FORWARDED principal"
        );
    }

    // S-E (b): SELF-ENFORCEMENT — a wrong-width (short/empty) session_nonce is rejected AT the
    // verifier even when the peer sealed its proof under that SAME short nonce (so the step-(1)
    // proof comparison alone would PASS). Without the boundary guard a missing/short nonce
    // collapses the binding toward the bare fixed challenge (the replay hole); this proves the
    // guard — not just the proof comparison — blocks it, so a future caller can't silently regress.
    #[test]
    fn authenticate_forwarded_rejects_a_wrong_width_session_nonce() {
        let (hub_session, caller_session) = paired_sessions();
        let short: &[u8] = b"too-short-nonce"; // not SESSION_NONCE_LEN wide
                                               // Proof sealed under the SHORT nonce ⇒ the proof comparison alone would otherwise PASS.
        let proof = fwd_proof_bound(&caller_session, short, FWD_OWNER, FWD_RUN);
        assert!(
            AuthedPrincipal::authenticate_forwarded(
                &hub_session,
                AAD,
                CHALLENGE,
                ForwardedAuth {
                    auth_proof: &proof,
                    session_nonce: short,
                    bound_context: FWD_RUN.as_bytes(),
                    forwarded_principal: FWD_OWNER,
                },
                &[FWD_OWNER.to_string()],
            )
            .is_none(),
            "a wrong-width session_nonce must be rejected by the self-enforcement guard"
        );
    }

    // S-E (a): a proof captured under nonce N1 REPLAYED against a later handshake (nonce N2)
    // FAILS — the verifier expects `CHALLENGE || N2`, the captured proof sealed `CHALLENGE || N1`.
    // This is the replay-to-authenticate defense at the unit level (same session key, two nonces).
    #[test]
    fn authenticate_forwarded_rejects_a_proof_captured_under_a_prior_handshake_nonce() {
        let (hub_session, caller_session) = paired_sessions();
        // Proof sealed under the FIRST handshake's nonce.
        let captured = fwd_proof_bound(&caller_session, FWD_NONCE, FWD_OWNER, FWD_RUN);
        // The SAME proof, replayed verbatim, against a LATER handshake's nonce (N2 != N1).
        assert!(
            AuthedPrincipal::authenticate_forwarded(
                &hub_session,
                AAD,
                CHALLENGE,
                ForwardedAuth {
                    auth_proof: &captured,
                    session_nonce: FWD_NONCE_2, // the new handshake's nonce
                    bound_context: FWD_RUN.as_bytes(),
                    forwarded_principal: FWD_OWNER,
                },
                &[FWD_OWNER.to_string()],
            )
            .is_none(),
            "a captured auth_proof must NOT re-authenticate under a fresh handshake nonce"
        );
        // CONTROL: the SAME captured proof STILL authenticates under its OWN nonce (no false-neg).
        assert!(
            AuthedPrincipal::authenticate_forwarded(
                &hub_session,
                AAD,
                CHALLENGE,
                ForwardedAuth {
                    auth_proof: &captured,
                    session_nonce: FWD_NONCE, // its own nonce
                    bound_context: FWD_RUN.as_bytes(),
                    forwarded_principal: FWD_OWNER,
                },
                &[FWD_OWNER.to_string()],
            )
            .is_some(),
            "a proof under the CURRENT nonce must still authenticate"
        );
    }

    // S-E: a proof sealed for (principal, run) cannot be LIFTED to a different run_id — the AAD
    // binds run_id (length-delimited), so substituting it makes `open` fail.
    #[test]
    fn authenticate_forwarded_rejects_a_proof_lifted_to_a_different_run_id() {
        let (hub_session, caller_session) = paired_sessions();
        // The peer sealed a proof for FWD_RUN.
        let proof = fwd_proof_bound(&caller_session, FWD_NONCE, FWD_OWNER, FWD_RUN);
        // The verifier is asked to authenticate it for a DIFFERENT run_id — the AAD differs.
        assert!(
            AuthedPrincipal::authenticate_forwarded(
                &hub_session,
                AAD,
                CHALLENGE,
                ForwardedAuth {
                    auth_proof: &proof,
                    session_nonce: FWD_NONCE,
                    bound_context: b"run:some-other-run", // lifted to a different run
                    forwarded_principal: FWD_OWNER,
                },
                &[FWD_OWNER.to_string()],
            )
            .is_none(),
            "a proof bound to one run_id must not authenticate a different run_id"
        );
    }

    // S-E: the length-delimited AAD is UNAMBIGUOUS — ("ab","c") and ("a","bc") must NOT collide.
    // A naive `principal || run_id` concat would let a proof for ("ab","c") authenticate ("a","bc").
    #[test]
    fn auth_aad_is_unambiguous_across_field_boundaries() {
        assert_ne!(
            auth_aad(AAD, "ab", b"c"),
            auth_aad(AAD, "a", b"bc"),
            "length-delimited AAD must distinguish field boundaries"
        );
        // And end-to-end: a proof for ("ab","c") must not open for ("a","bc").
        let (hub_session, caller_session) = paired_sessions();
        let proof = fwd_proof_bound(&caller_session, FWD_NONCE, "principal:ab", "c");
        assert!(
            AuthedPrincipal::authenticate_forwarded(
                &hub_session,
                AAD,
                CHALLENGE,
                ForwardedAuth {
                    auth_proof: &proof,
                    session_nonce: FWD_NONCE,
                    bound_context: b"bc",
                    forwarded_principal: "principal:a",
                },
                &["principal:a".to_string()],
            )
            .is_none(),
            "a boundary-shifted (principal, run_id) must not authenticate"
        );
    }

    #[test]
    fn authenticate_forwarded_rejects_a_non_allowlisted_principal() {
        // THE PRECONDITION: a correct-session peer forwarding a well-formed but NON-allowlisted
        // principal is rejected — a session key is NOT authorization.
        let (hub_session, caller_session) = paired_sessions();
        // Seal the proof BOUND to the attacker's forwarded principal (so the open succeeds and the
        // ALLOWLIST check is what rejects, not the AAD mismatch).
        let attacker = "principal:attacker-not-on-allowlist";
        let proof = fwd_proof_bound(&caller_session, FWD_NONCE, attacker, FWD_RUN);
        assert!(
            AuthedPrincipal::authenticate_forwarded(
                &hub_session,
                AAD,
                CHALLENGE,
                ForwardedAuth {
                    auth_proof: &proof,
                    session_nonce: FWD_NONCE,
                    bound_context: FWD_RUN.as_bytes(),
                    forwarded_principal: attacker,
                },
                &[FWD_OWNER.to_string()],
            )
            .is_none(),
            "a non-allowlisted forwarded principal must be rejected"
        );
    }

    #[test]
    fn authenticate_forwarded_rejects_empty_and_anonymous_forwarded_principals() {
        let (hub_session, caller_session) = paired_sessions();
        for bad in ["", "   ", "public", "public:default"] {
            // Seal the proof bound to `bad` so the open succeeds and the ANONYMOUS/empty check is
            // what rejects (not an AAD mismatch).
            let proof = fwd_proof_bound(&caller_session, FWD_NONCE, bad, FWD_RUN);
            assert!(
                AuthedPrincipal::authenticate_forwarded(
                    &hub_session,
                    AAD,
                    CHALLENGE,
                    ForwardedAuth {
                        auth_proof: &proof,
                        session_nonce: FWD_NONCE,
                        bound_context: FWD_RUN.as_bytes(),
                        forwarded_principal: bad,
                    },
                    // Even if (pathologically) the anonymous sentinel were on the allowlist,
                    // the anonymous check rejects it first.
                    &[bad.to_string(), FWD_OWNER.to_string()],
                )
                .is_none(),
                "an empty/anonymous forwarded principal must be rejected: {bad:?}"
            );
        }
    }

    #[test]
    fn authenticate_forwarded_rejects_an_unpaired_peer_even_if_principal_allowlisted() {
        // The peer shares NO key with the hub → its auth_proof does not open → None, REGARDLESS
        // of the forwarded principal being allowlisted. Possession-of-session is step 1.
        let hub = DeviceKeypair::generate();
        let real_peer = DeviceKeypair::generate();
        let hub_session = hub.agree(&real_peer.public_bytes());
        let attacker = DeviceKeypair::generate();
        let attacker_session = attacker.agree(&hub.public_bytes()); // hub never shared with attacker
        let proof = fwd_proof_bound(&attacker_session, FWD_NONCE, FWD_OWNER, FWD_RUN);
        assert!(
            AuthedPrincipal::authenticate_forwarded(
                &hub_session,
                AAD,
                CHALLENGE,
                ForwardedAuth {
                    auth_proof: &proof,
                    session_nonce: FWD_NONCE,
                    bound_context: FWD_RUN.as_bytes(),
                    forwarded_principal: FWD_OWNER,
                },
                &[FWD_OWNER.to_string()],
            )
            .is_none(),
            "an unpaired peer must NOT authenticate even with an allowlisted principal"
        );
    }

    #[test]
    fn authenticate_forwarded_rejects_a_wrong_challenge_seal() {
        let (hub_session, caller_session) = paired_sessions();
        // Opens (correct session key + correct AAD) but is NOT the agreed (nonce-bound) challenge.
        let req_aad = auth_aad(AAD, FWD_OWNER, FWD_RUN.as_bytes());
        let proof_wrong = seal(&caller_session, b"not-the-challenge", &req_aad).unwrap();
        assert!(
            AuthedPrincipal::authenticate_forwarded(
                &hub_session,
                AAD,
                CHALLENGE,
                ForwardedAuth {
                    auth_proof: &proof_wrong,
                    session_nonce: FWD_NONCE,
                    bound_context: FWD_RUN.as_bytes(),
                    forwarded_principal: FWD_OWNER,
                },
                &[FWD_OWNER.to_string()],
            )
            .is_none(),
            "a proof of the wrong challenge must be rejected"
        );
    }

    #[test]
    fn authenticate_forwarded_rejects_when_allowlist_empty() {
        // An empty owner-allowlist (no configured owner) rejects EVERY forwarded principal.
        let (hub_session, caller_session) = paired_sessions();
        let proof = fwd_proof(&caller_session);
        assert!(
            AuthedPrincipal::authenticate_forwarded(
                &hub_session,
                AAD,
                CHALLENGE,
                ForwardedAuth {
                    auth_proof: &proof,
                    session_nonce: FWD_NONCE,
                    bound_context: FWD_RUN.as_bytes(),
                    forwarded_principal: FWD_OWNER,
                },
                &[],
            )
            .is_none(),
            "an empty allowlist must reject every dispatch"
        );
    }

    // --- body-release projection (auditable, runtime-free) --------------------

    fn seed_owned(tag: &str, run_id: &str, owner: &str) -> Db {
        let db = Db::open_hub(&tmp(tag)).unwrap();
        persist_run_result(
            db.conn(),
            run_id,
            &RunResult::new("finished", BODY, None).with_owner_principal(owner),
            10,
        )
        .unwrap();
        db
    }

    #[test]
    fn project_delivers_body_to_authed_owner_and_proof_is_body_free() {
        let db = seed_owned("proj-owner", "run-x", "principal:P");
        let owner = authed("principal:P");
        let out = project_answer_for_authed(db.conn(), "run-x", &owner);
        assert_eq!(
            out.delivered_body(),
            Some(BODY),
            "the owner receives the body"
        );
        // CANARY: neither the refs-only proof projection nor the Debug carries the body.
        let proof = out.proof_refs_json().to_string();
        assert!(
            !proof.contains(BODY),
            "proof surface leaked the body: {proof}"
        );
        assert!(
            !format!("{out:?}").contains(BODY),
            "Debug leaked the owner-only body"
        );
    }

    #[test]
    fn project_denies_a_wrong_principal_with_no_body() {
        let db = seed_owned("proj-wrong", "run-x", "principal:P");
        let other = authed("principal:Q");
        let out = project_answer_for_authed(db.conn(), "run-x", &other);
        assert!(out.delivered_body().is_none(), "a non-owner gets NO body");
        assert!(matches!(
            out,
            AuthedAnswer::Denied {
                reason: AnswerDenyReason::PrincipalMismatch,
                ..
            }
        ));
        assert!(!out.proof_refs_json().to_string().contains(BODY));
        assert!(!format!("{out:?}").contains(BODY));
    }

    #[test]
    fn project_no_answer_for_an_unknown_run() {
        let db = Db::open_hub(&tmp("proj-none")).unwrap();
        let owner = authed("principal:P");
        let out = project_answer_for_authed(db.conn(), "nope", &owner);
        assert!(matches!(out, AuthedAnswer::NoAnswer { .. }));
        assert!(out.delivered_body().is_none());
    }

    /// (A1 transport-truth) `with_counts` ATTACHES the run COUNTS to a `Delivered` answer
    /// (the populated path `run_authed_agent_loop` drives) and is a NO-OP on a non-delivered
    /// outcome. This is the regression guard for the PR's post-deploy value: without it, a
    /// `with_counts` that silently dropped the counts (or a refactor that dropped the
    /// `.with_counts(..)` call) would still pass every other test.
    #[test]
    fn a1_with_counts_populates_delivered_and_is_noop_otherwise() {
        // A real owner-delivered projection (turns/tools default to None before attach).
        let db = seed_owned("a1-owner", "run-c", "principal:P");
        let owner = authed("principal:P");
        let delivered = project_answer_for_authed(db.conn(), "run-c", &owner);
        // Pre-attach: the DB-projection path has no outcome ⇒ no counts on the proof surface.
        let pre = delivered.proof_refs_json();
        assert!(pre.get("turns").unwrap().is_null());
        assert!(pre.get("executed_tools").unwrap().is_null());

        // ATTACH the loop's counts — the populated path. Counts now ride the proof surface as
        // NUMBERS, and the body is STILL owner-only (never on the refs/proof surface).
        let attached = delivered.with_counts(3, 2);
        assert_eq!(
            attached.delivered_body(),
            Some(BODY),
            "body still delivered"
        );
        let proof = attached.proof_refs_json();
        assert_eq!(proof.get("turns").and_then(|v| v.as_u64()), Some(3));
        assert_eq!(
            proof.get("executed_tools").and_then(|v| v.as_u64()),
            Some(2)
        );
        assert!(
            !proof.to_string().contains(BODY),
            "the count-bearing proof surface must still be body-free"
        );

        // NO-OP on a non-delivered outcome: a NoAnswer carries no counts and is unchanged.
        let none = AuthedAnswer::NoAnswer {
            run_id: "run-c".into(),
        };
        let none_after = none.with_counts(9, 9);
        assert!(matches!(none_after, AuthedAnswer::NoAnswer { .. }));
        let none_proof = none_after.proof_refs_json();
        assert!(
            none_proof.get("turns").is_none(),
            "NoAnswer carries no turns"
        );
        assert!(
            none_proof.get("executed_tools").is_none(),
            "NoAnswer carries no executed_tools"
        );

        // NO-OP on a Denied outcome too (wrong principal): counts never appear.
        let other = authed("principal:Q");
        let denied = project_answer_for_authed(db.conn(), "run-c", &other).with_counts(9, 9);
        assert!(matches!(denied, AuthedAnswer::Denied { .. }));
        let denied_proof = denied.proof_refs_json();
        assert!(denied_proof.get("turns").is_none());
        assert!(denied_proof.get("executed_tools").is_none());
    }

    // --- end-to-end through the real HubRuntime agent loop --------------------

    struct TempWs(PathBuf);
    impl TempWs {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "friday-authed-route-ws-{}-{}-{}",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempWs(p)
        }
    }
    impl Drop for TempWs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A transport that finishes the loop in one turn with `answer` as the final message.
    struct FinishTransport {
        answer: String,
    }
    impl Transport for FinishTransport {
        fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
            let content = format!("{{\"tool\":\"none\",\"answer\":\"{}\"}}", self.answer);
            Ok(serde_json::json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":content},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
            }))
        }
    }

    /// A transport whose chat POST fails — the provider is unavailable mid-loop.
    struct ProviderDownTransport;
    impl Transport for ProviderDownTransport {
        fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
            Err(DeepSeekError::ProviderUnavailable(
                "network down".to_string(),
            ))
        }
    }

    fn runtime_with<T: Transport>(tag: &str, t: T, principal: &str) -> (HubRuntime<T>, TempWs) {
        let ws = TempWs::new(tag);
        let client = DeepSeekClient::with_transport(t, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: b"authed-route-test-secret-0123456789".to_vec(),
                max_turns: 4,
                principal_id: Some(principal.to_string()),
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        (rt, ws)
    }

    #[test]
    fn authed_loop_delivers_body_to_owner_and_proof_canary_is_clean() {
        let (rt, _ws) = runtime_with(
            "loop-owner",
            FinishTransport {
                answer: BODY.to_string(),
            },
            "principal:owner",
        );
        // The caller is authenticated as the SAME principal the runtime is configured with.
        let caller = authed("principal:owner");
        let out = run_authed_agent_loop(&rt, &caller, "run-authed-1", "answer me", 1000);
        assert_eq!(
            out.delivered_body(),
            Some(BODY),
            "the authenticated owner receives the answer body"
        );
        // CANARY: the body appears in NEITHER the refs-only proof NOR the Debug; and no secret.
        let proof = out.proof_refs_json().to_string();
        assert!(
            !proof.contains(BODY),
            "proof surface leaked the body: {proof}"
        );
        assert!(!proof.contains("authed-route-test-secret"));
        assert!(!format!("{out:?}").contains(BODY));
    }

    #[test]
    fn authed_loop_wrong_principal_caller_gets_no_body() {
        // The run is OWNED by `principal:owner` (the runtime's principal); a caller
        // authenticated as a DIFFERENT principal is denied the body.
        let (rt, _ws) = runtime_with(
            "loop-wrong",
            FinishTransport {
                answer: BODY.to_string(),
            },
            "principal:owner",
        );
        let _seed =
            run_authed_agent_loop(&rt, &authed("principal:owner"), "run-authed-2", "go", 1000);
        // Now a different authenticated principal projects the SAME run → Denied, no body.
        let intruder = authed("principal:intruder");
        let out = project_answer_for_authed(rt.db().conn(), "run-authed-2", &intruder);
        assert!(
            out.delivered_body().is_none(),
            "a non-owner must get NO body"
        );
        assert!(matches!(
            out,
            AuthedAnswer::Denied {
                reason: AnswerDenyReason::PrincipalMismatch,
                ..
            }
        ));
        assert!(!out.proof_refs_json().to_string().contains(BODY));
    }

    /// FIX-Q2 (hardening): a caller authenticated as a principal that is NOT the runtime's
    /// configured owner must NEVER reach `run_task`. The loop returns the body-free `NoAnswer`
    /// AND — the property that proves the invariant, not just the return value — NO run row is
    /// ever created (the dispatch, recall, gate Actor, and model spend all never happen).
    #[test]
    fn authed_loop_mismatched_caller_never_dispatches_and_gets_no_body() {
        // Runtime is configured for `principal:owner`; a DIFFERENT authenticated caller arrives.
        let (rt, _ws) = runtime_with(
            "loop-q2-mismatch",
            FinishTransport {
                answer: BODY.to_string(),
            },
            "principal:owner",
        );
        let intruder = authed("principal:intruder");
        let out = run_authed_agent_loop(&rt, &intruder, "run-q2-mismatch", "answer me", 1000);

        // (1) Body-free safe failure — no body, no leak of the configured owner principal.
        assert!(
            matches!(out, AuthedAnswer::NoAnswer { .. }),
            "a mismatched caller must get the body-free NoAnswer"
        );
        assert!(out.delivered_body().is_none());
        let proof = out.proof_refs_json().to_string();
        assert!(!proof.contains(BODY), "no body on the refs surface");
        assert!(
            !proof.contains("principal:owner"),
            "the configured owner principal must never leak to a mismatched caller"
        );

        // (2) THE INVARIANT: the run NEVER executed — `run_task`'s first act is `create_run`,
        // so a guard that fires BEFORE dispatch leaves no `agent_run` row. (An after-exec check
        // would already have created the row + paid the spend.)
        let summary =
            friday_storage::agent_run_read::get_run_summary(rt.db().conn(), "run-q2-mismatch")
                .unwrap();
        assert!(
            summary.is_none(),
            "FIX-Q2: a mismatched caller must NOT create a run row (no dispatch, no spend)"
        );
    }

    /// FIX-Q2 (hardening): the matched single-owner path is a PROVABLE NO-OP — the configured
    /// owner still dispatches and IS delivered the body, AND the run row IS created. This is the
    /// live posture: the guard changes nothing when `caller == configured_principal`.
    #[test]
    fn authed_loop_matched_owner_still_dispatches_and_delivers_body() {
        let (rt, _ws) = runtime_with(
            "loop-q2-match",
            FinishTransport {
                answer: BODY.to_string(),
            },
            "principal:owner",
        );
        let caller = authed("principal:owner");
        let out = run_authed_agent_loop(&rt, &caller, "run-q2-match", "answer me", 1000);
        assert_eq!(
            out.delivered_body(),
            Some(BODY),
            "the configured owner is still delivered the body (guard is a no-op on a match)"
        );
        // The run DID execute — a row exists (proving the guard did not block the live path).
        let summary =
            friday_storage::agent_run_read::get_run_summary(rt.db().conn(), "run-q2-match")
                .unwrap();
        assert!(
            summary.is_some(),
            "the matched owner's run must execute (FIX-Q2 guard is a no-op on a match)"
        );
    }

    /// FIX-Q2 (hardening, fail-closed corner): an UNCONFIGURED runtime (no owner principal)
    /// dispatches NOTHING — even a non-anonymous, well-formed caller is refused, because there
    /// is no configured owner to match against. (Defends the `None` arm of the guard.)
    #[test]
    fn authed_loop_unconfigured_owner_never_dispatches() {
        let ws = TempWs::new("loop-q2-noowner");
        let client = DeepSeekClient::with_transport(
            FinishTransport {
                answer: BODY.to_string(),
            },
            "k".into(),
        );
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp("loop-q2-noowner"),
                workspace_root: ws.0.clone(),
                secret: b"authed-route-test-secret-0123456789".to_vec(),
                max_turns: 4,
                principal_id: None, // NO configured owner
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        let caller = authed("principal:owner");
        let out = run_authed_agent_loop(&rt, &caller, "run-q2-noowner", "answer me", 1000);
        assert!(
            matches!(out, AuthedAnswer::NoAnswer { .. }),
            "an unconfigured (None owner) runtime must dispatch nothing"
        );
        let summary =
            friday_storage::agent_run_read::get_run_summary(rt.db().conn(), "run-q2-noowner")
                .unwrap();
        assert!(
            summary.is_none(),
            "FIX-Q2: a None-owner runtime must NOT create a run row"
        );
    }

    #[test]
    fn authed_loop_provider_unavailable_is_safe_failure_no_body_no_panic() {
        let (rt, _ws) = runtime_with("loop-down", ProviderDownTransport, "principal:owner");
        let caller = authed("principal:owner");
        let out = run_authed_agent_loop(&rt, &caller, "run-authed-down", "answer me", 1000);
        assert!(
            matches!(out, AuthedAnswer::NoAnswer { .. }),
            "provider-unavailable must be a body-free safe failure, got {out:?}"
        );
        assert!(out.delivered_body().is_none());
        // No run_result persisted for the errored (non-Finished) run.
        assert_eq!(
            rt.db()
                .conn()
                .query_row(
                    "SELECT count(*) FROM run_result WHERE run_id = 'run-authed-down'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    // ---- A1: per-run-constraints override on the LIVE dispatch entries -------
    //
    // These pin the override THREADING through the two hot dispatch entries the WS server
    // calls: the SESSIONLESS `run_authed_agent_loop_with_policy` and the SESSIONED
    // `run_session_task_with_overrides`. The spec's risk-flag names this path explicitly; the
    // tests prove a `read_only:true` override actually BLOCKS a mutating tool (not just that the
    // mapping is pure).

    /// A transport that proposes ONE mutating `write_file` tool call on the first turn.
    struct MutateTransport;
    impl Transport for MutateTransport {
        fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
            let content =
                "{\"tool\":\"write_file\",\"parameters\":{\"path\":\"out.txt\",\"content\":\"X\"}}";
            Ok(serde_json::json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":content},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
            }))
        }
    }

    fn read_only_override(rt_principal: &str) -> crate::RunPolicy {
        let c = friday_protocol::AgentRunConstraintsWire {
            read_only: true,
            disabled_tools: vec![],
            max_turns: None,
        };
        // Compose onto the boot policy of a runtime configured with `rt_principal` (unconstrained
        // boot) — exactly what the dispatch arm does with `runtime.policy()`.
        let boot =
            crate::RunPolicy::new(Some(rt_principal.to_string()), Vec::<String>::new(), false);
        crate::agent_run_control::effective_run_policy_over(&boot, Some(&c))
    }

    /// (A1) SESSIONLESS dispatch entry: a `read_only:true` policy override BLOCKS a mutating tool
    /// through `run_authed_agent_loop_with_policy`, writing no file. The override is APPLIED, not
    /// dropped, on the hub_server live entry.
    #[test]
    fn a1_sessionless_override_read_only_blocks_mutating_tool() {
        let (rt, ws) = runtime_with("a1-sessionless-ro", MutateTransport, "principal:owner");
        let caller = authed("principal:owner");
        let policy = read_only_override("principal:owner");
        let out = run_authed_agent_loop_with_policy(
            &rt,
            &caller,
            "a1-sl-ro",
            "write a file",
            Some(&policy),
            None,
            1000,
        );
        // Read-only Deny ⇒ non-Finished ⇒ body-free NoAnswer; nothing executed, no file written.
        assert!(out.delivered_body().is_none(), "read-only blocks the body");
        assert!(
            !ws.0.join("out.txt").exists(),
            "the read-only override withheld the write (no file)"
        );
        let blocked: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run_event WHERE run_id = 'a1-sl-ro' AND kind LIKE 'tool.blocked:deny:run_is_read_only:write_file%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(blocked, 1, "the read-only block is recorded for the run");
    }

    /// (A1) SESSIONED dispatch entry (the hot, live-reachable path the risk-flag names): a
    /// `read_only:true` override BLOCKS a mutating tool through `run_session_task_with_overrides`
    /// — proving the override threads symmetrically into `run_session_loop`, not just the
    /// sessionless loop.
    #[test]
    fn a1_sessioned_override_read_only_blocks_mutating_tool() {
        let (rt, ws) = runtime_with("a1-sessioned-ro", MutateTransport, "principal:owner");
        let caller = authed("principal:owner");
        let policy = read_only_override("principal:owner");
        let out = rt.run_session_task_with_overrides(
            &caller,
            "a1-se-ro",
            "chat-session-1",
            "write a file",
            Some(&policy),
            None,
            1000,
        );
        assert!(
            out.delivered_body().is_none(),
            "read-only blocks the body on the sessioned path too"
        );
        assert!(
            !ws.0.join("out.txt").exists(),
            "the read-only override withheld the write on the sessioned path (no file)"
        );
        let blocked: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run_event WHERE run_id = 'a1-se-ro' AND kind LIKE 'tool.blocked:deny:run_is_read_only:write_file%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            blocked, 1,
            "the read-only block is recorded for the sessioned run"
        );
    }

    /// (A1) Control: with NO override on the sessioned entry (the `run_session_task` path) and a
    /// boot policy that is NOT read-only, the SAME mutating tool is NOT read-only-blocked (it
    /// Pauses pending approval instead) — proving the block in the test above is the OVERRIDE, not
    /// a broken loop.
    #[test]
    fn a1_sessioned_absent_override_is_not_read_only_blocked() {
        let (rt, _ws) = runtime_with("a1-sessioned-noov", MutateTransport, "principal:owner");
        let caller = authed("principal:owner");
        // `run_session_task` = the absent-override path.
        let _out = rt.run_session_task(
            &caller,
            "a1-se-noov",
            "chat-session-2",
            "write a file",
            1000,
        );
        let ro_blocked: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run_event WHERE run_id = 'a1-se-noov' AND kind LIKE 'tool.blocked:deny:run_is_read_only:%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            ro_blocked, 0,
            "with no override + non-read-only boot, the run is NOT read-only-blocked (the override is what blocks)"
        );
    }

    /// A non-read-only per-run constraint (`read_only:false`) composing onto a non-read-only boot
    /// policy.
    fn mutating_override(rt_principal: &str) -> crate::RunPolicy {
        let c = friday_protocol::AgentRunConstraintsWire {
            read_only: false,
            disabled_tools: vec![],
            max_turns: None,
        };
        let boot =
            crate::RunPolicy::new(Some(rt_principal.to_string()), Vec::<String>::new(), false);
        crate::agent_run_control::effective_run_policy_over(&boot, Some(&c))
    }

    /// (S6 mutating-chat — THE B#3 LOAD-BEARING TEST) A mutating run admitted under the LIVE
    /// dispatch entry with a per-run `read_only:false` constraint composed onto the server's
    /// `read_only:false` boot policy (exactly what the WS server's flag-on dispatch arm builds via
    /// `effective_run_policy_over(runtime.policy(), constraints)`) must **PAUSE** the mutating tool
    /// pending an operator-signed approval — NOT Deny it (that would force the read-only path), and
    /// NOT silently Allow it (the catastrophic escalation the whole S6 model rests on NOT happening).
    ///
    /// This is the complement to `a1_sessionless_override_read_only_blocks_mutating_tool` (the
    /// `read_only:true → BLOCK` case): together they pin both arms of the composed-policy gate. The
    /// `read_only:false` composition is the ACTUAL mutating-chat dispatch — the existing test only
    /// proved the tightening direction; this proves a permitted-but-ungated mutation HALTS, so the
    /// only path to execution is the operator's Ed25519 signature (proven end-to-end by
    /// `s6d_resume_ingestion.rs` / `a1_run_control.rs`).
    #[test]
    fn s6_mutating_override_read_only_false_pauses_not_allows_not_denies() {
        let (rt, ws) = runtime_with("s6-mutate-pause", MutateTransport, "principal:owner");
        let caller = authed("principal:owner");
        let policy = mutating_override("principal:owner");

        // The composed policy is NOT read-only (no escalation, no silent loosening did NOT happen)
        // — a `read_only:false` constraint over a `read_only:false` boot stays mutating-CAPABLE.
        assert!(
            !policy.is_read_only(),
            "read_only:false over read_only:false boot stays non-read-only (mutating-capable)"
        );

        let out = run_authed_agent_loop_with_policy(
            &rt,
            &caller,
            "s6-mut-ro-false",
            "write a file",
            Some(&policy),
            None,
            1000,
        );

        // PAUSE ⇒ no body delivered, NO file written (the mutation did NOT execute).
        assert!(
            out.delivered_body().is_none(),
            "a paused (ungated) mutating run delivers no body"
        );
        assert!(
            !ws.0.join("out.txt").exists(),
            "the mutating tool PAUSED — it must NOT have executed without an operator signature"
        );

        // It is NOT a read-only Deny (that would be the wrong, over-restrictive outcome): there is
        // NO `run_is_read_only:*` block event for this run.
        let ro_blocked: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run_event WHERE run_id = 's6-mut-ro-false' AND kind LIKE 'tool.blocked:deny:run_is_read_only:%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            ro_blocked, 0,
            "a read_only:false mutating run must NOT be read-only-denied (it pauses, not denies)"
        );

        // It DID pause: a live `pending` approval row (CSPRNG nonce + the exact tool call + digest)
        // was persisted — the single thing an operator signature later authorizes. This is the gate
        // standing between an admitted mutating run and an unsigned mutation executing.
        let pause =
            crate::agent_run_control::detect_pause(rt.db().conn(), "s6-mut-ro-false").unwrap();
        let pause = pause.expect("an ungated mutating run must PAUSE pending approval");
        assert_eq!(pause.nonce.len(), 64, "CSPRNG nonce is 32 bytes => 64 hex");
        assert!(
            pause.summary.contains("write_file"),
            "the pause is for the mutating write_file action"
        );
    }

    // --- NS-4 / NS45-PR1: the flag-gated MISSION-BOUND run seam ---------------
    //
    // `run_authed_agent_loop_mission_bound` is the live-reachable counterpart of the unbound
    // entry: when (in the bin) `FRIDAY_MISSION_BOUND_RUN` is ON and the run carries a FIRST-CLASS
    // `mission_context` handle that resolves to a live routed-provider Mission/WorkItem, a run is
    // dispatched BOUND (minting the mission-birth + WorkItem bind). NS45-PR1 (M-4) retired the
    // `session_id`-as-surface-thread shim: resolution now keys off the handle
    // `{friday_conversation_id, mission_id, work_item_id}` via `by_mission_work_item`. These tests
    // drive the SEAM directly (the bin's flag plumbing, including handle-present/flag-off
    // fail-closed behavior, is exercised by bin tests). The flag-on tests prove REAL mission
    // binding (MissionLink + WorkItem transition + route_decision); the no-handle test proves
    // byte-identical fall-through; the unresolvable-handle test proves explicit handles fail
    // closed instead of falling through unbound.

    use friday_core::{
        ApprovalState as NsApprovalState, ClaimState as NsClaimState,
        FridayConversation as NsFridayConversation,
        HandoffJudgmentMemory as NsHandoffJudgmentMemory, Mission as NsMission,
        MissionStatus as NsMissionStatus, Risk as NsRisk, SurfaceKind as NsSurfaceKind,
        SurfaceThread as NsSurfaceThread, TruthStatus as NsTruthStatus,
        VisibilityPolicy as NsVisibilityPolicy, WorkItem as NsWorkItem,
        WorkItemStatus as NsWorkItemStatus, WorkLane as NsWorkLane,
        WorkspaceClaim as NsWorkspaceClaim, WorkspaceClaimKind as NsWorkspaceClaimKind,
    };

    /// The FIRST-CLASS Mission handle (NS45-PR1) that resolves against the graph
    /// [`ns4_seed_mission`] stages — the three ids match the seeded
    /// `FridayConversation`/`Mission`/`WorkItem` rows, so `by_mission_work_item` resolves Ready.
    fn ns4_handle() -> MissionWorkItemContextWire {
        MissionWorkItemContextWire {
            friday_conversation_id: "fconv_ns4".into(),
            mission_id: "mission-ns4".into(),
            work_item_id: "work-ns4".into(),
        }
    }

    /// Stage a `FridayConversation -> Mission -> WorkItem` graph the seam's preflight resolves via
    /// the FIRST-CLASS handle (`{fconv_ns4, mission-ns4, work-ns4}` — see [`ns4_handle`]). The
    /// `surface_thread_id` arg is seeded for graph realism but is NO LONGER the resolution key
    /// (NS45-PR1 retired the surface-thread shim). A DeepSeek-lane / `deepseek`-target active
    /// WorkItem makes the bound dispatch RESOLVABLE.
    fn ns4_seed_mission<T: Transport>(rt: &HubRuntime<T>, surface_thread_id: &str) {
        ns4_seed_mission_with_route(
            rt,
            surface_thread_id,
            NsWorkLane::DeepSeek,
            Some("deepseek"),
            Vec::new(),
            Vec::new(),
        );
    }

    fn ns4_seed_mission_with_route<T: Transport>(
        rt: &HubRuntime<T>,
        surface_thread_id: &str,
        lane: NsWorkLane,
        target: Option<&str>,
        owner_claim_ids: Vec<String>,
        workspace_refs: Vec<String>,
    ) {
        let now = 1_700_000_000_000;
        let db = rt.db();
        db.upsert_friday_conversation(&NsFridayConversation {
            friday_conversation_id: "fconv_ns4".into(),
            owner_principal: "principal:owner".into(),
            title: "NS-4 mission".into(),
            current_focus_summary: "Mission-bound run seam".into(),
            active_mission_ids: vec!["mission-ns4".into()],
            surface_thread_ids: vec![surface_thread_id.to_string()],
            memory_scope_ref: None,
            truth_status: NsTruthStatus::WiredRegistry,
            proof_refs: vec!["proof://ns4-test".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&NsMission {
            mission_id: "mission-ns4".into(),
            friday_conversation_id: "fconv_ns4".into(),
            title: "NS-4 mission".into(),
            intent: "bind the live run to a mission".into(),
            status: NsMissionStatus::Active,
            why_now: "live runs must tie to a mission".into(),
            decision_path_summary: "resolve mission context before the loop".into(),
            considered_options: vec!["unbound run".into()],
            deferred_options: vec!["multi-provider".into()],
            known_pitfalls: vec!["unbound run looked bound".into()],
            handoff_inheritance: vec!["preserve route judgment".into()],
            work_item_ids: vec!["work-ns4".into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://ns4-test".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_surface_thread(&NsSurfaceThread {
            surface_thread_id: surface_thread_id.to_string(),
            friday_conversation_id: "fconv_ns4".into(),
            mission_id: Some("mission-ns4".into()),
            surface_kind: NsSurfaceKind::Mobile,
            channel_binding_id: None,
            delivery_route: "mobile".into(),
            visibility_policy: NsVisibilityPolicy::Compact,
            allowed_actions: vec!["open_mission".into()],
            last_seen_at_ms: Some(now),
            last_delivered_event_seq: Some(1),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        let target = target.map(str::to_string);
        db.upsert_work_item(&NsWorkItem {
            work_item_id: "work-ns4".into(),
            mission_id: "mission-ns4".into(),
            lane,
            target_provider_or_agent: target.clone(),
            status: NsWorkItemStatus::ReadyToDispatch,
            owner_claim_ids,
            workspace_refs,
            capability_id: Some("mission.ns4".into()),
            risk_level: NsRisk::Medium,
            approval_state: NsApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["input://ns4".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["ns4 tests".into()],
            proof_receipts: Vec::new(),
            judgment_memory: ns4_judgment_for(lane, target.as_deref().unwrap_or(lane.as_str())),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
    }

    fn ns4_judgment_for(lane: NsWorkLane, target: &str) -> NsHandoffJudgmentMemory {
        NsHandoffJudgmentMemory {
            task: "Run the Mission-bound agent loop".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: target.into(),
            read_first_files: vec!["rust-core/crates/friday-hub/src/hub_server.rs".into()],
            required_output: "Mission-bound run".into(),
            done_criteria: vec!["run bound to mission".into()],
            red_lines: vec!["do not run before mission context".into()],
            why_this_route: format!("The {} WorkItem lane owns the agent loop.", lane.as_str()),
            considered_options: vec!["unbound run_task".into()],
            deferred_options: vec!["multi-provider loop".into()],
            previous_pitfalls: vec!["detached run looked bound".into()],
            inheritable_context: vec!["Mission is product truth".into()],
            proof_requirements: vec!["ns4 tests".into()],
            ownership_claim_ids: Vec::new(),
        }
    }

    const CODEX_BOUND_BODY: &str = "CODEX-BOUND-BODY-CANARY-only-owner-P";
    type CodexObserveContextProbe =
        Arc<Mutex<Option<crate::observe_wrapper::CodexObserveMissionContext>>>;
    type CodexSeamFixture = (
        HubRuntime<ProviderDownTransport>,
        TempWs,
        Arc<AtomicU64>,
        CodexObserveContextProbe,
    );

    struct SeamCodexStub {
        answer: String,
        calls: Arc<AtomicU64>,
        last_context: CodexObserveContextProbe,
    }

    impl crate::CodexTurnExecutor for SeamCodexStub {
        fn run_gated_turn(
            &self,
            _conn: &rusqlite::Connection,
            _policy: &crate::RunPolicy,
            _secret: &[u8],
            _operator_vk: Option<&friday_crypto::OperatorVerifyingKey>,
            _approve: &dyn Fn(
                &friday_core::gate::MutatingActionRequest,
            ) -> Option<friday_core::gate::CanonicalApproval>,
            _task: &str,
            _run_id: &str,
            observe_context: Option<&crate::observe_wrapper::CodexObserveMissionContext>,
            _now_ms: i64,
        ) -> Result<
            crate::codex_gated_turn::CodexTurnOutcome,
            crate::codex_gated_turn::CodexGatedTurnError,
        > {
            self.calls.fetch_add(1, Ordering::Relaxed);
            *self.last_context.lock().unwrap() = observe_context.cloned();
            Ok(crate::codex_gated_turn::CodexTurnOutcome::Finished {
                answer: self.answer.clone(),
                usage: crate::BilledUsage {
                    provider_kind: friday_core::ProviderKind::Codex,
                    model: "gpt-5.5".into(),
                    prompt_tokens: 2,
                    completion_tokens: 3,
                },
            })
        }
    }

    fn runtime_with_codex_stub(tag: &str) -> CodexSeamFixture {
        let (rt, ws) = runtime_with(tag, ProviderDownTransport, "principal:owner");
        let calls = Arc::new(AtomicU64::new(0));
        let last_context = Arc::new(Mutex::new(None));
        let stub = SeamCodexStub {
            answer: CODEX_BOUND_BODY.into(),
            calls: Arc::clone(&calls),
            last_context: Arc::clone(&last_context),
        };
        let mut rt = rt.with_codex(Box::new(stub));
        rt.mark_route_available("codex");
        rt.mark_route_validated("codex");
        (rt, ws, calls, last_context)
    }

    const CLAUDE_BOUND_BODY: &str = "CLAUDE-BOUND-BODY-CANARY-only-owner-P";
    type ClaudeSeamFixture = (HubRuntime<ProviderDownTransport>, TempWs, Arc<AtomicU64>);

    struct SeamClaudeStub {
        answer: String,
        calls: Arc<AtomicU64>,
    }

    impl crate::AgentLlmClient for SeamClaudeStub {
        fn propose_tool_call(&self, _task: &str) -> Result<crate::RawToolCall, crate::AgentError> {
            unreachable!("mission-bound Claude seam uses next_step_metered")
        }

        fn next_step_metered(
            &self,
            _task: &str,
            _history: &[crate::TurnTrace],
        ) -> Result<crate::MeteredStep, crate::AgentError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok((
                Ok(crate::AgentStep::Finish {
                    message: self.answer.clone(),
                }),
                Some(crate::BilledUsage {
                    provider_kind: friday_core::ProviderKind::Anthropic,
                    model: friday_anthropic::DEFAULT_MODEL.to_string(),
                    prompt_tokens: 11,
                    completion_tokens: 8,
                }),
            ))
        }
    }

    fn runtime_with_claude_stub(tag: &str) -> ClaudeSeamFixture {
        let (rt, ws) = runtime_with(tag, ProviderDownTransport, "principal:owner");
        let calls = Arc::new(AtomicU64::new(0));
        let stub = SeamClaudeStub {
            answer: CLAUDE_BOUND_BODY.into(),
            calls: Arc::clone(&calls),
        };
        let mut rt = rt.with_claude(Box::new(stub));
        rt.mark_route_available("claude");
        rt.mark_route_validated("claude");
        (rt, ws, calls)
    }

    fn ns4_codex_provider_claim() -> NsWorkspaceClaim {
        NsWorkspaceClaim {
            claim_id: "claim-ns4-codex-provider-session".into(),
            mission_id: "mission-ns4".into(),
            work_item_id: Some("work-ns4".into()),
            owner_principal: "principal:owner".into(),
            owner_agent: "codex".into(),
            workspace_ref: "friday://provider-session/ns4-codex".into(),
            claim_kind: NsWorkspaceClaimKind::ProviderSession,
            state: NsClaimState::Active,
            reason: "mission-bound hub seam owns this Codex provider session".into(),
            safe_release_policy: "release after observe-wrapper proof".into(),
            proof_requirements: vec!["hub seam Codex observe context proof".into()],
            proof_refs: Vec::new(),
            created_at_ms: 1_700_000_000_001,
            updated_at_ms: 1_700_000_000_001,
            released_at_ms: None,
        }
    }

    struct Ns4CodexMissionSeed {
        handle: MissionWorkItemContextWire,
        claim_id: String,
        work_item_id: String,
    }

    fn ns4_seed_unique_codex_mission<T: Transport>(
        rt: &HubRuntime<T>,
        suffix: &str,
    ) -> Ns4CodexMissionSeed {
        let now = 1_700_000_100_000;
        let friday_conversation_id = format!("fconv_ns4_{suffix}");
        let mission_id = format!("mission-ns4-{suffix}");
        let work_item_id = format!("work-ns4-{suffix}");
        let surface_thread_id = format!("surface-ns4-{suffix}");
        let claim_id = format!("claim-ns4-codex-provider-session-{suffix}");
        let workspace_ref = format!("friday://provider-session/ns4-codex-{suffix}");
        let db = rt.db();
        db.upsert_friday_conversation(&NsFridayConversation {
            friday_conversation_id: friday_conversation_id.clone(),
            owner_principal: "principal:owner".into(),
            title: format!("NS-4 Codex soak mission {suffix}"),
            current_focus_summary: "Mission-bound Codex observe soak".into(),
            active_mission_ids: vec![mission_id.clone()],
            surface_thread_ids: vec![surface_thread_id.clone()],
            memory_scope_ref: None,
            truth_status: NsTruthStatus::WiredRegistry,
            proof_refs: vec![format!("proof://ns4-codex-soak/{suffix}")],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&NsMission {
            mission_id: mission_id.clone(),
            friday_conversation_id: friday_conversation_id.clone(),
            title: format!("NS-4 Codex soak mission {suffix}"),
            intent: "observe one real Codex app-server run bound to this Mission".into(),
            status: NsMissionStatus::Active,
            why_now: "high-pressure observe-wrapper soak needs independent work items".into(),
            decision_path_summary: "mission-bound Codex seam with provider-session claim".into(),
            considered_options: vec!["reuse one WorkItem".into()],
            deferred_options: vec!["organic operator dogfood".into()],
            known_pitfalls: vec!["terminal WorkItem cannot be reused".into()],
            handoff_inheritance: vec!["preserve claim-to-observation truth".into()],
            work_item_ids: vec![work_item_id.clone()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: vec![format!("proof://ns4-codex-soak/{suffix}")],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_surface_thread(&NsSurfaceThread {
            surface_thread_id,
            friday_conversation_id: friday_conversation_id.clone(),
            mission_id: Some(mission_id.clone()),
            surface_kind: NsSurfaceKind::Mobile,
            channel_binding_id: None,
            delivery_route: "mobile".into(),
            visibility_policy: NsVisibilityPolicy::Compact,
            allowed_actions: vec!["open_mission".into()],
            last_seen_at_ms: Some(now),
            last_delivered_event_seq: Some(1),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_work_item(&NsWorkItem {
            work_item_id: work_item_id.clone(),
            mission_id: mission_id.clone(),
            lane: NsWorkLane::Codex,
            target_provider_or_agent: Some("codex".into()),
            status: NsWorkItemStatus::ReadyToDispatch,
            owner_claim_ids: vec![claim_id.clone()],
            workspace_refs: vec![workspace_ref.clone()],
            capability_id: Some(format!("mission.ns4.codex.{suffix}")),
            risk_level: NsRisk::Medium,
            approval_state: NsApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec![format!("input://ns4-codex-soak/{suffix}")],
            output_refs: Vec::new(),
            proof_requirements: vec!["real Codex observe-wrapper rows reconcile".into()],
            proof_receipts: Vec::new(),
            judgment_memory: ns4_judgment_for(NsWorkLane::Codex, "codex"),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_workspace_claim(&NsWorkspaceClaim {
            claim_id: claim_id.clone(),
            mission_id: mission_id.clone(),
            work_item_id: Some(work_item_id.clone()),
            owner_principal: "principal:owner".into(),
            owner_agent: "codex".into(),
            workspace_ref,
            claim_kind: NsWorkspaceClaimKind::ProviderSession,
            state: NsClaimState::Active,
            reason: "soak owns this Codex provider session observation".into(),
            safe_release_policy: "release after soak iteration".into(),
            proof_requirements: vec!["observe wrapper process claim proof".into()],
            proof_refs: Vec::new(),
            created_at_ms: now,
            updated_at_ms: now,
            released_at_ms: None,
        })
        .unwrap();
        Ns4CodexMissionSeed {
            handle: MissionWorkItemContextWire {
                friday_conversation_id,
                mission_id,
                work_item_id: work_item_id.clone(),
            },
            claim_id,
            work_item_id,
        }
    }

    fn assert_live_codex_observe_invariants<T: Transport>(
        rt: &HubRuntime<T>,
        run_id: &str,
        claim_id: &str,
        work_item_id: &str,
    ) {
        let session_id = crate::observe_wrapper::codex_friday_session_id(run_id);
        let link = friday_storage::provider_session::get_link(rt.db().conn(), &session_id)
            .unwrap()
            .expect("observe wrapper must write a provider_session_link");
        assert_eq!(link.provider, "codex");
        assert!(
            link.external_thread_id.is_some(),
            "provider thread id should be mirrored as a ref"
        );

        let usage = rt.db().list_run_token_usage(run_id).unwrap();
        assert_eq!(usage.len(), 1, "live Codex turn writes one ledger row");
        assert_eq!(usage[0].provider_kind, "codex");
        assert!(!usage[0].fallback);

        let events = friday_storage::provider_session::list_events(rt.db().conn(), &session_id)
            .expect("provider events readable");
        assert!(
            !events.is_empty(),
            "observe wrapper must mirror at least one provider event"
        );
        assert!(
            events
                .iter()
                .all(|event| event.redaction_level == "metadata_only"),
            "provider events stay refs-only metadata"
        );
        let ledger_id = format!("{run_id}:t0:ledger");
        assert!(
            events
                .iter()
                .any(|event| event.token_ledger_ref.as_deref() == Some(ledger_id.as_str())),
            "provider events should be reconciled to the run ledger"
        );

        let observation_id = crate::observe_wrapper::codex_process_observation_id(run_id);
        let observation = friday_storage::process_registry::get_process_observation(
            rt.db().conn(),
            &observation_id,
        )
        .unwrap()
        .expect("observe wrapper must write a claimed process observation");
        assert!(observation.pid > 0);
        assert_eq!(observation.matched_claim_id.as_deref(), Some(claim_id));
        assert_eq!(
            observation.ownership_status,
            friday_core::OwnershipStatus::FridayOwnedClaimed
        );

        let work_item = rt.db().get_work_item(work_item_id).unwrap().unwrap();
        assert_eq!(work_item.status, NsWorkItemStatus::CompletedWithProof);
        assert!(work_item
            .proof_receipts
            .contains(&format!("friday://agent-run/{run_id}")));
    }

    struct EnvRestore {
        key: &'static str,
        prev: Option<String>,
    }
    impl EnvRestore {
        fn set(key: &'static str, value: &str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, prev }
        }
    }
    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match &self.prev {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn table_count<T: Transport>(rt: &HubRuntime<T>, table: &str) -> i64 {
        rt.db()
            .conn()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn agent_run_count<T: Transport>(rt: &HubRuntime<T>, run_id: &str) -> i64 {
        rt.db()
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run WHERE run_id = ?1",
                [run_id],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// FLAG-ON happy path: a run whose first-class `mission_context` handle resolves to a live
    /// routed WorkItem is dispatched BOUND. The seam returns the owner-gated body AND mints REAL
    /// mission binding — a `MissionLink` tied to THIS run_id, a
    /// `ReadyToDispatch -> CompletedWithProof` WorkItem transition (the run as proof), and a
    /// `route_decision` row keyed to this run.
    #[test]
    fn mission_bound_seam_on_binds_run_to_mission_and_delivers_body_to_owner() {
        let (rt, _ws) = runtime_with(
            "ns4-bound",
            FinishTransport {
                answer: BODY.to_string(),
            },
            "principal:owner",
        );
        let surface = "surface-ns4-session";
        ns4_seed_mission(&rt, surface);
        let caller = authed("principal:owner");

        // The seam is consulted (as the bin does when the flag is ON) with the run's FIRST-CLASS
        // mission_context handle (NS45-PR1) — NOT the session_id surface-thread shim.
        let handle = ns4_handle();
        let out = run_authed_agent_loop_mission_bound(
            &rt,
            &caller,
            "run-ns4-bound",
            "do the mission work",
            Some(&handle),
            None,
            None,
            1000,
        )
        .expect("the bound seam took the run (Some), not a fall-through");

        // The authenticated owner is delivered the body via the SAME owner-gated projection the
        // unbound path uses.
        assert_eq!(
            out.delivered_body(),
            Some(BODY),
            "the owner receives the bound run's answer body"
        );
        // The refs surface never leaks the body or a secret.
        let proof = out.proof_refs_json().to_string();
        assert!(
            !proof.contains(BODY),
            "proof surface leaked the body: {proof}"
        );
        assert!(!proof.contains("authed-route-test-secret"));

        // REAL mission binding #1 — a MissionLink ties THIS run to the Mission/WorkItem. NS45-PR1:
        // the provider-timeline session label is derived from the handle's friday_conversation_id
        // (the retired surface-thread shim is no longer the label source).
        let links = rt.db().list_mission_links("mission-ns4").unwrap();
        assert!(
            links.iter().any(|link| link.target_ref
                == format!(
                    "friday://provider-timeline/{}#run-ns4-bound",
                    handle.friday_conversation_id
                )
                && link.work_item_id.as_deref() == Some("work-ns4")),
            "a mission_link must bind THIS run to the mission: {links:?}"
        );
        // REAL mission binding #2 — the WorkItem transitioned ReadyToDispatch -> CompletedWithProof
        // with the run as proof (the run actually completed the work).
        let work_item = rt.db().get_work_item("work-ns4").unwrap().unwrap();
        assert_eq!(work_item.status, NsWorkItemStatus::CompletedWithProof);
        assert!(work_item
            .proof_receipts
            .contains(&"friday://agent-run/run-ns4-bound".to_string()));
        // REAL mission binding #3 — a route_decision row keyed to THIS run exists.
        let route_decisions: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM route_decision WHERE decision_id = ?1",
                ["route-decision:agent-loop:run-ns4-bound"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            route_decisions, 1,
            "a route_decision binds the run to the mission"
        );
        assert_eq!(agent_run_count(&rt, "run-ns4-bound"), 1, "the loop ran");
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    #[test]
    fn mission_bound_seam_on_codex_work_item_routes_to_codex_and_threads_claim_context() {
        let (rt, _ws, codex_calls, codex_context) = runtime_with_codex_stub("ns4-bound-codex");
        let claim = ns4_codex_provider_claim();
        let claim_id = claim.claim_id.clone();
        let workspace_ref = claim.workspace_ref.clone();
        ns4_seed_mission_with_route(
            &rt,
            "surface-ns4-codex-session",
            NsWorkLane::Codex,
            Some("codex"),
            vec![claim_id.clone()],
            vec![workspace_ref],
        );
        rt.db().upsert_workspace_claim(&claim).unwrap();
        let caller = authed("principal:owner");
        let handle = ns4_handle();

        let out = run_authed_agent_loop_mission_bound(
            &rt,
            &caller,
            "run-ns4-codex-bound",
            "do the Codex mission work",
            Some(&handle),
            None,
            None,
            1000,
        )
        .expect("the bound Codex seam took the run (Some), not a fall-through");

        assert_eq!(
            out.delivered_body(),
            Some(CODEX_BOUND_BODY),
            "a Codex WorkItem must dispatch through the Codex runner, not DeepSeek"
        );
        assert_eq!(
            codex_calls.load(Ordering::Relaxed),
            1,
            "the Codex executor was called exactly once"
        );
        let observed_context = codex_context
            .lock()
            .unwrap()
            .clone()
            .expect("hub seam threaded WorkItem claim context into the Codex executor");
        assert_eq!(observed_context.mission_id, "mission-ns4");
        assert_eq!(observed_context.work_item_id, "work-ns4");
        assert_eq!(observed_context.owner_claim_ids, vec![claim_id]);

        let work_item = rt.db().get_work_item("work-ns4").unwrap().unwrap();
        assert_eq!(work_item.status, NsWorkItemStatus::CompletedWithProof);
        assert!(work_item
            .proof_receipts
            .contains(&"friday://agent-run/run-ns4-codex-bound".to_string()));
        let route_decisions: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM route_decision WHERE decision_id = ?1",
                ["route-decision:agent-loop:run-ns4-codex-bound"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(route_decisions, 1);
        let usage = rt.db().list_run_token_usage("run-ns4-codex-bound").unwrap();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].provider_kind, "codex");
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    #[test]
    fn mission_bound_seam_on_claude_work_item_routes_to_claude_and_bills_anthropic() {
        let (rt, _ws, claude_calls) = runtime_with_claude_stub("ns4-bound-claude");
        ns4_seed_mission_with_route(
            &rt,
            "surface-ns4-claude-session",
            NsWorkLane::Claude,
            Some("claude"),
            Vec::new(),
            Vec::new(),
        );
        let caller = authed("principal:owner");
        let handle = ns4_handle();

        let out = run_authed_agent_loop_mission_bound(
            &rt,
            &caller,
            "run-ns4-claude-bound",
            "do the Claude mission work",
            Some(&handle),
            None,
            None,
            1000,
        )
        .expect("the bound Claude seam took the run (Some), not a fall-through");

        assert_eq!(
            out.delivered_body(),
            Some(CLAUDE_BOUND_BODY),
            "a Claude WorkItem must dispatch through the Claude client, not DeepSeek"
        );
        assert_eq!(
            claude_calls.load(Ordering::Relaxed),
            1,
            "the Claude client was called exactly once"
        );

        let work_item = rt.db().get_work_item("work-ns4").unwrap().unwrap();
        assert_eq!(work_item.status, NsWorkItemStatus::CompletedWithProof);
        assert!(work_item
            .proof_receipts
            .contains(&"friday://agent-run/run-ns4-claude-bound".to_string()));
        let route_decisions: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM route_decision WHERE decision_id = ?1",
                ["route-decision:agent-loop:run-ns4-claude-bound"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(route_decisions, 1);
        let usage = rt
            .db()
            .list_run_token_usage("run-ns4-claude-bound")
            .unwrap();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].provider_kind, "anthropic");
        assert!(!usage[0].fallback);
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    #[test]
    #[ignore = "live: needs logged-in Codex CLI; spawns codex app-server and spends one Codex turn"]
    fn live_mission_bound_codex_observe_wrapper_records_session_ledger_and_claimed_process() {
        let _observe = EnvRestore::set(
            crate::observe_wrapper::ENV_FRIDAY_OBSERVE_WRAPPER_ENABLED,
            "1",
        );
        let (rt, ws) = runtime_with(
            "ns4-live-codex-observe",
            ProviderDownTransport,
            "principal:owner",
        );
        let cwd = ws.0.to_string_lossy().to_string();
        let mut rt = rt.with_codex(Box::new(crate::LocalCodexGatedTurnExecutor::new(
            "codex",
            "friday-hub-live-observe-test",
            "0.0.1",
            Some(cwd),
            "gpt-5.5",
        )));
        rt.mark_route_available("codex");
        rt.validate_and_enable_codex()
            .expect("logged-in Codex app-server health check must pass");

        let claim = ns4_codex_provider_claim();
        let claim_id = claim.claim_id.clone();
        let workspace_ref = claim.workspace_ref.clone();
        ns4_seed_mission_with_route(
            &rt,
            "surface-ns4-live-codex-session",
            NsWorkLane::Codex,
            Some("codex"),
            vec![claim_id.clone()],
            vec![workspace_ref],
        );
        rt.db().upsert_workspace_claim(&claim).unwrap();

        let run_id = "run-ns4-live-codex-observe";
        let handle = ns4_handle();
        let out = run_authed_agent_loop_mission_bound(
            &rt,
            &authed("principal:owner"),
            run_id,
            "Reply with exactly PONG. Do not use tools.",
            Some(&handle),
            None,
            Some(1),
            1_700_000_000_100,
        )
        .expect("mission-bound Codex seam must take the live run");
        assert!(
            out.delivered_body().is_some(),
            "the owner should receive the live Codex answer body"
        );

        assert_live_codex_observe_invariants(&rt, run_id, &claim_id, "work-ns4");
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    #[test]
    #[ignore = "live: needs logged-in Codex CLI; spawns codex app-server and spends twenty Codex turns"]
    fn live_mission_bound_codex_observe_wrapper_20_session_soak() {
        const SOAK_SESSIONS: usize = 20;
        let _observe = EnvRestore::set(
            crate::observe_wrapper::ENV_FRIDAY_OBSERVE_WRAPPER_ENABLED,
            "1",
        );
        let _watchdog = EnvRestore::set(
            friday_providers::codex_appserver::FRIDAY_CODEX_APP_SERVER_TIMEOUT_MS,
            "300000",
        );
        let (rt, ws) = runtime_with(
            "ns4-live-codex-observe-soak",
            ProviderDownTransport,
            "principal:owner",
        );
        let cwd = ws.0.to_string_lossy().to_string();
        let mut rt = rt.with_codex(Box::new(crate::LocalCodexGatedTurnExecutor::new(
            "codex",
            "friday-hub-live-observe-soak",
            "0.0.1",
            Some(cwd),
            "gpt-5.5",
        )));
        rt.mark_route_available("codex");
        rt.validate_and_enable_codex()
            .expect("logged-in Codex app-server health check must pass before the soak");

        for i in 0..SOAK_SESSIONS {
            let suffix = format!("soak-{i:02}");
            let seed = ns4_seed_unique_codex_mission(&rt, &suffix);
            let run_id = format!("run-ns4-live-codex-observe-soak-{i:02}");
            let out = run_authed_agent_loop_mission_bound(
                &rt,
                &authed("principal:owner"),
                &run_id,
                "Reply with exactly PONG. Do not use tools.",
                Some(&seed.handle),
                None,
                Some(1),
                1_700_000_100_000 + i as i64,
            )
            .expect("mission-bound Codex seam must take every live soak run");
            assert!(
                out.delivered_body().is_some(),
                "the owner should receive the live Codex answer body for soak iteration {i}"
            );
            assert_live_codex_observe_invariants(&rt, &run_id, &seed.claim_id, &seed.work_item_id);
            assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
        }

        let ledger_rows: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM token_ledger WHERE provider_kind = 'codex'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ledger_rows, SOAK_SESSIONS as i64);
        let claimed_observations: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM process_observation WHERE ownership_status = 'friday_owned_claimed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(claimed_observations, SOAK_SESSIONS as i64);
    }

    /// Direct unbound-entry parity: when the caller does not enter the mission-bound seam, the
    /// unbound `run_authed_agent_loop_with_policy` path still produces ZERO mission binding (no
    /// MissionLink, no WorkItem transition, no route_decision) and delivers the IDENTICAL body even
    /// with the SAME Mission staged. The real WS flag-off + explicit `mission_context` case is
    /// covered in `hub_agent_run_server` and must fail closed, not call this unbound path.
    #[test]
    fn mission_bound_flag_off_is_byte_identical_unbound_run_no_binding() {
        let (rt, _ws) = runtime_with(
            "ns4-off",
            FinishTransport {
                answer: BODY.to_string(),
            },
            "principal:owner",
        );
        ns4_seed_mission(&rt, "surface-ns4-session");
        let caller = authed("principal:owner");

        // The bin's flag-off path: the seam is NEVER consulted; the run goes straight through the
        // unbound entry. We invoke EXACTLY that entry here (the same call the dispatch arm makes
        // for a sessionless run with the flag off).
        let out = run_authed_agent_loop_with_policy(
            &rt,
            &caller,
            "run-ns4-off",
            "do work",
            None,
            None,
            1000,
        );

        // Same body delivered to the owner — unchanged behavior.
        assert_eq!(
            out.delivered_body(),
            Some(BODY),
            "flag-off run delivers the same body the pre-NS-4 unbound run did"
        );
        // ZERO mission binding — the unbound run touches no mission graph even though one resolves.
        assert_eq!(
            table_count(&rt, "mission_link"),
            0,
            "flag-off / unbound run must create NO mission_link"
        );
        assert_eq!(
            table_count(&rt, "route_decision"),
            0,
            "flag-off / unbound run must create NO route_decision"
        );
        let work_item = rt.db().get_work_item("work-ns4").unwrap().unwrap();
        assert_eq!(
            work_item.status,
            NsWorkItemStatus::ReadyToDispatch,
            "flag-off / unbound run must NOT transition the WorkItem"
        );
        assert!(
            work_item.proof_receipts.is_empty(),
            "no proof attached unbound"
        );
        assert_eq!(
            agent_run_count(&rt, "run-ns4-off"),
            1,
            "the unbound run still ran"
        );
    }

    /// FLAG-ON but UNRESOLVABLE handle: a `mission_context` handle pointing at a Mission/WorkItem
    /// that does NOT exist (no graph staged) fails CLOSED to `Some(NoAnswer)` — the caller must not
    /// fall through to the unbound path and accidentally surface an unbound answer as mission-bound.
    /// The preflight blocked BEFORE `create_run`, so it wrote NOTHING.
    #[test]
    fn mission_bound_seam_on_unresolvable_handle_returns_no_answer_no_binding() {
        let (rt, _ws) = runtime_with(
            "ns4-fallthrough",
            FinishTransport {
                answer: BODY.to_string(),
            },
            "principal:owner",
        );
        // NO mission staged — the handle's ids do not resolve to a real Mission/WorkItem.
        let caller = authed("principal:owner");
        let unresolvable = MissionWorkItemContextWire {
            friday_conversation_id: "fconv_does_not_exist".into(),
            mission_id: "mission_does_not_exist".into(),
            work_item_id: "work_does_not_exist".into(),
        };

        let out = run_authed_agent_loop_mission_bound(
            &rt,
            &caller,
            "run-ns4-ft",
            "do work",
            Some(&unresolvable),
            None,
            None,
            1000,
        );

        // The seam returns Some(NoAnswer) ⇒ no unbound dispatch fallback for an explicit handle.
        let out =
            out.expect("an explicit but unresolvable handle must fail closed, not fall through");
        assert!(
            matches!(out, AuthedAnswer::NoAnswer { .. }),
            "an unresolvable handle must not bind and must not fall through"
        );
        // The fail-closed preflight wrote nothing: no run, no route_decision, no mission_link.
        assert_eq!(
            agent_run_count(&rt, "run-ns4-ft"),
            0,
            "no run on a blocked preflight"
        );
        assert_eq!(table_count(&rt, "route_decision"), 0);
        assert_eq!(table_count(&rt, "mission_link"), 0);
    }

    /// FLAG-ON no-handle: a run with NO `mission_context` handle is NOT mission-resolvable ⇒ the
    /// seam returns `None` immediately (before any DB touch / owner-gate) and the caller falls
    /// through unbound — the retirement point of the surface-thread shim (a `session_id` alone no
    /// longer makes a run mission-bound).
    #[test]
    fn mission_bound_seam_on_no_handle_returns_none() {
        let (rt, _ws) = runtime_with(
            "ns4-no-handle",
            FinishTransport {
                answer: BODY.to_string(),
            },
            "principal:owner",
        );
        ns4_seed_mission(&rt, "surface-ns4-session");
        let caller = authed("principal:owner");

        let out = run_authed_agent_loop_mission_bound(
            &rt,
            &caller,
            "run-ns4-none",
            "do work",
            None, // no handle — no key to resolve a mission
            None,
            None,
            1000,
        );
        assert!(out.is_none(), "a run with no handle is not mission-bound");
        // No run was created by the seam (it returned None before any dispatch).
        assert_eq!(agent_run_count(&rt, "run-ns4-none"), 0);
        assert_eq!(table_count(&rt, "mission_link"), 0);
    }

    /// FIX-Q2 at the seam: a caller authenticated as a principal that is NOT the runtime's
    /// configured owner must NEVER reach the bound dispatch — even with a resolvable Mission. The
    /// seam returns `Some(NoAnswer)` (denied, not a fall-through) and the loop NEVER runs (no run
    /// row, no mission binding). The mission-bound path must not be a way around the owner gate.
    #[test]
    fn mission_bound_seam_mismatched_caller_never_dispatches() {
        let (rt, _ws) = runtime_with(
            "ns4-q2",
            FinishTransport {
                answer: BODY.to_string(),
            },
            "principal:owner",
        );
        let surface = "surface-ns4-session";
        ns4_seed_mission(&rt, surface);
        let intruder = authed("principal:intruder");
        let handle = ns4_handle();

        let out = run_authed_agent_loop_mission_bound(
            &rt,
            &intruder,
            "run-ns4-q2",
            "do work",
            Some(&handle),
            None,
            None,
            1000,
        )
        .expect("the owner gate returns Some(NoAnswer), not a fall-through");
        assert!(
            matches!(out, AuthedAnswer::NoAnswer { .. }),
            "a mismatched caller must get the body-free NoAnswer"
        );
        // THE INVARIANT: no run row, no mission binding — the guard fired BEFORE any dispatch.
        assert_eq!(
            agent_run_count(&rt, "run-ns4-q2"),
            0,
            "FIX-Q2 at the seam: a mismatched caller must NOT dispatch a bound run"
        );
        assert_eq!(
            table_count(&rt, "mission_link"),
            0,
            "no binding for a denied caller"
        );
        // The configured owner principal never leaks to the mismatched caller.
        assert!(!out
            .proof_refs_json()
            .to_string()
            .contains("principal:owner"));
    }
}
