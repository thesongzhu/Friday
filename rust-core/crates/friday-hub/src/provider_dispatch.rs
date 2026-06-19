//! Provider Workspace dispatch adapter SEAM (PWS-004).
//!
//! PWS-003 ([`crate::provider_workspace::guard_action_request`]) DECIDES
//! accepted/routed/blocker but never dispatches. This seam wires an
//! ACCEPTED + ROUTED action to a provider adapter only after canonical Mission
//! context resolution and route-decision derivation, then returns the
//! `dispatch_ref` / `truth_label` / `blocker`.
//!
//! Invariants (file 60 §6, file 81 PWS-004, file 83):
//! - GATE FIRST. The guard runs before the adapter is ever consulted. A blocked /
//!   unknown / mismatched / non-routed request is returned VERBATIM with no adapter
//!   call — so there is no hidden provider/model call on a non-accepted request.
//! - NO TRUTH UPGRADE. The result's `truth_label` is the capability's (from the guard).
//!   The adapter CANNOT relabel it (no `provider_native_synced` from a local dispatch);
//!   [`DispatchOutcome`] deliberately carries no truth label.
//! - SECRETS STAY HUB-SIDE. The adapter may run a provider CLI/app-server (in
//!   CODEX-LIVE-001 / CLAUDE-MIRROR-001), but the [`DispatchOutcome`] / [`DispatchError`]
//!   surfaced here must never include provider credentials, raw account ids, or raw
//!   provider output.
//! - NO FALLBACK. A failed dispatch returns an exact blocker; it never silently reroutes
//!   to another provider.
//! - ROUTE JUDGMENT FIRST. Accepted provider work must carry the WorkItem's
//!   `RouteDecisionCard` into the adapter context, so the live adapter cannot receive
//!   task facts without the "why this route / what was considered / proof needed" path.
//!
//! Sync by design — the core is blocking (ureq, no tokio). PWS-004 defines the trait +
//! the gate-then-dispatch flow and is proven with an injected fake adapter (no real
//! process / network in tests). The real Codex app-server and Claude mirror adapters
//! land in CODEX-LIVE-001 / CLAUDE-MIRROR-001 as `ProviderDispatchAdapter` impls.

use std::time::{SystemTime, UNIX_EPOCH};

use friday_core::{RouteDecisionCard, WorkItem};
use friday_protocol::{
    ProviderWorkspaceActionRequestWire, ProviderWorkspaceActionResultWire,
    ProviderWorkspaceMissionContextWire,
};
use friday_providers::unified::ProviderSession;
use friday_storage::Db;
use thiserror::Error;

use crate::mission_context::{
    resolve_mission_context, route_decision_card_for_context, MissionContextLookup,
    MissionContextResolution, ResolvedMissionContext,
};
use crate::provider_workspace::{guard_action_request, ProviderWorkspaceCatalog};

/// What the adapter is given for an action the guard has ALREADY accepted + routed.
/// `provider`/`action`/`capability_id` are the guard-validated strings; `truth_label` is
/// informational only (the adapter must not change it).
pub struct DispatchContext<'a> {
    pub session: &'a ProviderSession,
    pub provider: &'a str,
    pub action: &'a str,
    pub capability_id: &'a str,
    pub dispatch_ref: &'a str,
    pub truth_label: &'a str,
    pub payload_ref: Option<&'a str>,
    pub provider_thread_id: Option<&'a str>,
    pub work_item_input_refs: &'a [String],
    pub mission_context: &'a ResolvedMissionContext,
    pub route_decision: &'a RouteDecisionCard,
}

/// Coarse dispatch lifecycle. `Errored` is represented as `Err(DispatchError)`, not a
/// status, so a failure can never be mistaken for a completion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DispatchStatus {
    Queued,
    Running,
    Completed,
}

fn dispatch_status_str(status: DispatchStatus) -> &'static str {
    match status {
        DispatchStatus::Queued => "dispatched_queued",
        DispatchStatus::Running => "dispatched_running",
        DispatchStatus::Completed => "dispatched_completed",
    }
}

/// The result of a successful adapter dispatch. Carries NO truth label (the capability's
/// is authoritative) and NO raw provider output/secret — only opaque refs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispatchOutcome {
    pub status: DispatchStatus,
    pub provider_event_id: Option<String>,
    pub audit_receipt_ref: Option<String>,
}

/// Why a dispatch failed. Messages are coarse and operator-safe — never include provider
/// stderr, credentials, account ids, or URLs.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DispatchError {
    #[error("provider adapter not ready: {0}")]
    AdapterNotReady(String),
    #[error("provider dispatch failed: {0}")]
    ExecutionFailed(String),
}

/// The provider-specific dispatch seam. Implemented by the real Codex app-server / Claude
/// mirror adapters (CODEX-LIVE-001 / CLAUDE-MIRROR-001) and by a fake adapter in tests.
///
/// `execute_action` is called ONLY for an action the guard already accepted + routed.
pub trait ProviderDispatchAdapter {
    fn execute_action(&self, ctx: &DispatchContext<'_>) -> Result<DispatchOutcome, DispatchError>;
}

/// Gate, then dispatch. The single entrypoint that wires an accepted Provider Workspace
/// action to a provider adapter. See the module invariants.
pub fn dispatch_provider_action(
    catalog: &ProviderWorkspaceCatalog,
    adapter: &dyn ProviderDispatchAdapter,
    session: &ProviderSession,
    db: &Db,
    request: ProviderWorkspaceActionRequestWire,
) -> ProviderWorkspaceActionResultWire {
    // Mission context is the first product boundary. Even an unproven or malformed
    // Provider Workspace action cannot use stale/bogus Mission context to reach an
    // accepted-looking guard result.
    let payload_ref = request.payload_ref.clone();
    let mission_context = request.mission_context.clone();
    let resolved_context = match resolve_provider_mission_context(db, mission_context.as_ref()) {
        Ok(context) => context,
        Err(blocker) => return mission_context_blocked_request(request, blocker),
    };

    // GATE FIRST — any refusal returns verbatim, adapter untouched.
    let guard = guard_action_request(catalog, session, request);
    if !guard.accepted || !guard.routed {
        return guard;
    }

    let work_item =
        match validate_resolved_provider_context(db, session, &guard.provider, &resolved_context) {
            Ok(work_item) => work_item,
            Err(blocker) => return mission_context_blocked_result(guard, blocker),
        };
    if let Err(blocker) = validate_payload_ref_binding(payload_ref.as_deref(), &work_item) {
        return mission_context_blocked_result(guard, blocker);
    }

    // An accepted + routed guard result always carries a dispatch_ref; fail closed
    // (no dispatch) if it somehow does not.
    let dispatch_ref = match guard.dispatch_ref.as_deref() {
        Some(r) => r.to_string(),
        None => {
            return ProviderWorkspaceActionResultWire {
                status: "dispatch_ref_missing".to_string(),
                blocker: Some("internal: accepted action missing dispatch_ref".to_string()),
                dispatch_ref: None,
                ..guard
            };
        }
    };

    let route_decision = match route_decision_card_for_context(
        db,
        &resolved_context,
        format!("route-decision:{}", guard.request_id),
        route_trace_refs(&guard, &dispatch_ref),
        current_unix_ms(),
        None,
    ) {
        Ok(card) => card,
        Err(err) => {
            return mission_context_blocked_result(
                guard,
                format!("provider dispatch route decision invalid: {err}"),
            );
        }
    };
    if let Err(blocker) =
        validate_route_decision_for_provider(&route_decision, session, &guard.provider)
    {
        return mission_context_blocked_result(guard, blocker);
    }
    if let Err(err) = db.upsert_route_decision(&route_decision) {
        return mission_context_blocked_result(
            guard,
            format!("provider dispatch route decision persistence failed: {err}"),
        );
    }

    // Dispatch. Scope the borrow of `guard` so the struct-update below can move it.
    let outcome = {
        let ctx = DispatchContext {
            session,
            provider: &guard.provider,
            action: &guard.action,
            capability_id: &guard.capability_id,
            dispatch_ref: &dispatch_ref,
            truth_label: &guard.truth_label,
            payload_ref: payload_ref.as_deref(),
            provider_thread_id: session.external_thread_id.as_deref(),
            work_item_input_refs: &work_item.input_refs,
            mission_context: &resolved_context,
            route_decision: &route_decision,
        };
        adapter.execute_action(&ctx)
    };

    match outcome {
        Ok(outcome) => ProviderWorkspaceActionResultWire {
            status: dispatch_status_str(outcome.status).to_string(),
            blocker: None,
            // Echo the deterministic guard dispatch_ref — the adapter cannot mint a new
            // identity for the action.
            dispatch_ref: Some(dispatch_ref),
            // request_id/session/provider/action/capability_id/accepted/routed/
            // truth_label/proof_ref are carried unchanged from the guard.
            ..guard
        },
        Err(err) => ProviderWorkspaceActionResultWire {
            status: "dispatch_failed".to_string(),
            // STRUCTURAL no-leak: surface a FIXED operator-safe blocker per variant — the
            // adapter's free-text detail (`{0}`, which could contain stderr / a credential
            // / a raw url) is NEVER put on the wire. The detail stays in the `DispatchError`
            // value for Hub-side logging/audit by the caller, not in the projection.
            blocker: Some(wire_blocker(&err).to_string()),
            dispatch_ref: None,
            ..guard
        },
    }
}

fn resolve_provider_mission_context(
    db: &Db,
    mission_context: Option<&ProviderWorkspaceMissionContextWire>,
) -> Result<ResolvedMissionContext, String> {
    let Some(context) = mission_context else {
        return Err("provider dispatch requires Mission context".to_string());
    };
    match resolve_mission_context(
        db,
        MissionContextLookup::by_work_item(
            context.friday_conversation_id.clone(),
            context.mission_id.clone(),
            context.work_item_id.clone(),
        ),
    )
    .map_err(|err| format!("provider dispatch Mission context read failed: {err}"))?
    {
        MissionContextResolution::Resolved(context) => Ok(context),
        MissionContextResolution::Blocked { blockers } => Err(format!(
            "provider dispatch Mission context blocked: {}",
            blockers.join(",")
        )),
    }
}

fn validate_resolved_provider_context(
    db: &Db,
    session: &ProviderSession,
    provider: &str,
    context: &ResolvedMissionContext,
) -> Result<WorkItem, String> {
    let work_item = db
        .get_work_item(&context.work_item_id)
        .map_err(|err| format!("provider dispatch Mission context read failed: {err}"))?
        .ok_or_else(|| "provider dispatch Mission context work item not found".to_string())?;
    if work_item.mission_id != context.mission_id {
        return Err("provider dispatch Mission context work item mismatch".to_string());
    }
    if work_item.target_provider_or_agent.as_deref() != Some(provider) {
        return Err("provider dispatch Mission context provider mismatch".to_string());
    }
    if provider != session.provider.as_str() {
        return Err("provider dispatch provider/session mismatch".to_string());
    }
    if !work_item.is_active_like() {
        return Err("provider dispatch Mission context work item is terminal".to_string());
    }
    Ok(work_item)
}

fn validate_payload_ref_binding(
    payload_ref: Option<&str>,
    work_item: &WorkItem,
) -> Result<(), String> {
    let Some(payload_ref) = payload_ref else {
        return Ok(());
    };
    if work_item
        .input_refs
        .iter()
        .any(|input_ref| input_ref == payload_ref)
    {
        Ok(())
    } else {
        Err("provider dispatch payload_ref is not bound to the WorkItem input_refs".to_string())
    }
}

fn mission_context_blocked_result(
    guard: ProviderWorkspaceActionResultWire,
    blocker: String,
) -> ProviderWorkspaceActionResultWire {
    ProviderWorkspaceActionResultWire {
        accepted: false,
        routed: false,
        status: "mission_context_required".to_string(),
        blocker: Some(blocker),
        dispatch_ref: None,
        ..guard
    }
}

fn mission_context_blocked_request(
    request: ProviderWorkspaceActionRequestWire,
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
        status: "mission_context_required".to_string(),
        truth_label: "provider_workspace_action_refused_before_dispatch".to_string(),
        blocker: Some(blocker),
        proof_ref: None,
        dispatch_ref: None,
        mission_context: request.mission_context,
    }
}

fn validate_route_decision_for_provider(
    route_decision: &RouteDecisionCard,
    session: &ProviderSession,
    provider: &str,
) -> Result<(), String> {
    if route_decision.selected_provider_or_agent.as_deref() != Some(provider) {
        return Err("provider dispatch route decision provider mismatch".to_string());
    }
    if provider != session.provider.as_str() {
        return Err("provider dispatch route decision provider/session mismatch".to_string());
    }
    Ok(())
}

fn route_trace_refs(guard: &ProviderWorkspaceActionResultWire, dispatch_ref: &str) -> Vec<String> {
    let mut refs = vec![
        format!("provider_action_request:{}", guard.request_id),
        dispatch_ref.to_string(),
    ];
    if let Some(proof_ref) = guard.proof_ref.as_ref() {
        refs.push(proof_ref.clone());
    }
    refs
}

fn current_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// The fixed, operator-safe wire blocker for a dispatch failure. Deliberately coarse and
/// free of any adapter-supplied text so a provider secret / raw output can never reach a
/// projected surface (file 60 §6, file 83 channel-redaction discipline).
fn wire_blocker(err: &DispatchError) -> &'static str {
    match err {
        DispatchError::AdapterNotReady(_) => "provider adapter not ready",
        DispatchError::ExecutionFailed(_) => "provider dispatch failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus,
        TruthStatus, WorkItem, WorkItemStatus, WorkLane,
    };
    use friday_providers::unified::{
        CapabilityStatus, FallbackStatus, PlatformProvider, ProviderCapability,
        ProviderNativeAction, ProviderSyncMode, SessionStatus,
    };
    use friday_storage::Db;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);

    fn tmp_db() -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-provider-dispatch-{}-{}.sqlite",
                std::process::id(),
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn empty_db() -> Db {
        Db::open_hub(&tmp_db()).unwrap()
    }

    fn mission_context() -> ProviderWorkspaceMissionContextWire {
        ProviderWorkspaceMissionContextWire {
            friday_conversation_id: "fconv_provider_dispatch".to_string(),
            mission_id: "mission-provider-dispatch".to_string(),
            work_item_id: "work-provider-dispatch".to_string(),
        }
    }

    fn judgment(provider: PlatformProvider) -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "Dispatch provider action through Mission context".to_string(),
            current_blocker: None,
            target_lane_thread_agent_provider: provider.as_str().to_string(),
            read_first_files: vec!["rust-core/crates/friday-hub/src/provider_dispatch.rs".into()],
            required_output: "provider dispatch result".to_string(),
            done_criteria: vec!["adapter called only after Mission context resolves".into()],
            red_lines: vec!["do not dispatch detached provider work".into()],
            why_this_route: "Provider action must attach to a WorkItem.".into(),
            considered_options: vec![
                "detached provider dispatch".into(),
                "Mission context".into(),
            ],
            deferred_options: vec!["native UI".into()],
            previous_pitfalls: vec!["provider ack looked like completion".into()],
            inheritable_context: vec!["Mission Spine owns product state".into()],
            proof_requirements: vec!["provider dispatch test".into()],
            ownership_claim_ids: vec!["own-test".into()],
        }
    }

    fn db_with_mission_context(provider: PlatformProvider) -> Db {
        let db = empty_db();
        let now = 1_700_000_000_000;
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: "fconv_provider_dispatch".into(),
            owner_principal: "owner-1".into(),
            title: "Provider dispatch Mission".into(),
            current_focus_summary: "provider action attached to WorkItem".into(),
            active_mission_ids: vec!["mission-provider-dispatch".into()],
            surface_thread_ids: Vec::new(),
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: vec!["proof://provider-dispatch".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: "mission-provider-dispatch".into(),
            friday_conversation_id: "fconv_provider_dispatch".into(),
            title: "Provider dispatch Mission".into(),
            intent: "dispatch provider action with Mission context".into(),
            status: MissionStatus::Active,
            why_now: "Provider work must not detach from Friday global state.".into(),
            decision_path_summary: "Resolve Mission context before adapter call.".into(),
            considered_options: vec!["detached dispatch".into(), "mission-bound dispatch".into()],
            deferred_options: vec!["provider live proof".into()],
            known_pitfalls: vec!["ack is not completion".into()],
            handoff_inheritance: vec!["preserve judgment".into()],
            work_item_ids: vec!["work-provider-dispatch".into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://provider-dispatch".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_work_item(&WorkItem {
            work_item_id: "work-provider-dispatch".into(),
            mission_id: "mission-provider-dispatch".into(),
            lane: WorkLane::Codex,
            target_provider_or_agent: Some(provider.as_str().to_string()),
            status: WorkItemStatus::ReadyToDispatch,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("provider.codex.list_sessions".into()),
            risk_level: friday_core::Risk::Low,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["friday://body/request/1".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["provider dispatch test".into()],
            proof_receipts: Vec::new(),
            judgment_memory: judgment(provider),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db
    }

    fn session(provider: PlatformProvider) -> ProviderSession {
        ProviderSession {
            friday_session_id: format!("friday-{}", provider.as_str()),
            provider,
            workspace_id: "workspace-1".to_string(),
            sync_mode: ProviderSyncMode::ProviderAppServerLocal,
            status: SessionStatus::Idle,
            capability_snapshot: Vec::new(),
            external_thread_id: None,
            active_turn_id: None,
            last_event_seq: 0,
            truth_label: "provider dispatch test".to_string(),
            fallback_status: FallbackStatus::NoFallback,
        }
    }

    fn req(
        provider: &str,
        friday_session_id: &str,
        action: &str,
        capability_id: &str,
    ) -> ProviderWorkspaceActionRequestWire {
        ProviderWorkspaceActionRequestWire {
            request_id: "request-1".to_string(),
            friday_session_id: friday_session_id.to_string(),
            provider: provider.to_string(),
            action: action.to_string(),
            capability_id: capability_id.to_string(),
            payload_ref: Some("friday://body/request/1".to_string()),
            mission_context: None,
        }
    }

    fn req_with_mission_context(
        provider: &str,
        friday_session_id: &str,
        action: &str,
        capability_id: &str,
    ) -> ProviderWorkspaceActionRequestWire {
        ProviderWorkspaceActionRequestWire {
            mission_context: Some(mission_context()),
            ..req(provider, friday_session_id, action, capability_id)
        }
    }

    const VERIFIED_TRUTH: &str = "verified app-server list";

    fn verified_catalog() -> ProviderWorkspaceCatalog {
        let mut catalog = ProviderWorkspaceCatalog::new();
        catalog
            .register(
                crate::provider_workspace::ProviderWorkspaceAction::ListSessions,
                ProviderCapability {
                    capability_id: "provider.codex.list_sessions".to_string(),
                    provider: PlatformProvider::Codex,
                    status: CapabilityStatus::Verified,
                    sync_mode: ProviderSyncMode::ProviderAppServerLocal,
                    truth_label: VERIFIED_TRUTH.to_string(),
                    blocker: None,
                    proof_ref: Some("proof-1".to_string()),
                    native_action: Some(ProviderNativeAction::CodexAppServer {
                        method: friday_providers::unified::CodexAppServerMethod::ThreadList,
                        schema_ref: "schema".to_string(),
                    }),
                },
            )
            .unwrap();
        catalog
    }

    fn unproven_catalog() -> ProviderWorkspaceCatalog {
        let mut catalog = ProviderWorkspaceCatalog::new();
        catalog
            .register(
                crate::provider_workspace::ProviderWorkspaceAction::ListSessions,
                ProviderCapability {
                    capability_id: "provider.codex.list_sessions".to_string(),
                    provider: PlatformProvider::Codex,
                    status: CapabilityStatus::ImplementedUnproven,
                    sync_mode: ProviderSyncMode::ProviderAppServerLocal,
                    truth_label: "codex list unproven".to_string(),
                    blocker: Some("app-server list not yet live-proven".to_string()),
                    proof_ref: None,
                    native_action: None,
                },
            )
            .unwrap();
        catalog
    }

    /// A fake adapter that records calls and never spawns a real process / network.
    enum Behavior {
        Ok(DispatchStatus),
        Fail(DispatchError),
    }
    struct FakeAdapter {
        calls: Cell<usize>,
        behavior: Behavior,
    }
    impl FakeAdapter {
        fn with(behavior: Behavior) -> Self {
            Self {
                calls: Cell::new(0),
                behavior,
            }
        }
        fn ok() -> Self {
            Self::with(Behavior::Ok(DispatchStatus::Queued))
        }
        fn ok_status(status: DispatchStatus) -> Self {
            Self::with(Behavior::Ok(status))
        }
        fn failing() -> Self {
            Self::with(Behavior::Fail(DispatchError::ExecutionFailed(
                "adapter offline".to_string(),
            )))
        }
        /// A failing adapter whose error string carries secret-shaped material — used to
        /// prove the seam REDACTS it from the wire blocker (no longer a vacuous test).
        fn failing_leaky() -> Self {
            Self::with(Behavior::Fail(DispatchError::ExecutionFailed(
                "token=sk-shouldNeverHappen account=acct_12345".to_string(),
            )))
        }
        fn count(&self) -> usize {
            self.calls.get()
        }
    }
    impl ProviderDispatchAdapter for FakeAdapter {
        fn execute_action(
            &self,
            ctx: &DispatchContext<'_>,
        ) -> Result<DispatchOutcome, DispatchError> {
            self.calls.set(self.calls.get() + 1);
            // The seam must pass the deterministic guard dispatch_ref through.
            assert!(ctx.dispatch_ref.starts_with("friday://provider-dispatch/"));
            assert_eq!(ctx.mission_context.mission_id, "mission-provider-dispatch");
            assert_eq!(ctx.mission_context.work_item_id, "work-provider-dispatch");
            assert_eq!(ctx.payload_ref, Some("friday://body/request/1"));
            assert!(ctx
                .work_item_input_refs
                .iter()
                .any(|input_ref| input_ref == "friday://body/request/1"));
            assert_eq!(ctx.route_decision.mission_id, "mission-provider-dispatch");
            assert_eq!(ctx.route_decision.work_item_id, "work-provider-dispatch");
            assert_eq!(
                ctx.route_decision.selected_provider_or_agent.as_deref(),
                Some(ctx.provider)
            );
            assert_eq!(
                ctx.route_decision.why_this_route,
                "Provider action must attach to a WorkItem."
            );
            assert!(ctx
                .route_decision
                .considered_options
                .iter()
                .any(|option| option == "detached provider dispatch"));
            assert!(ctx
                .route_decision
                .trace_refs
                .iter()
                .any(|trace_ref| trace_ref == ctx.dispatch_ref));
            match &self.behavior {
                Behavior::Ok(status) => Ok(DispatchOutcome {
                    status: *status,
                    provider_event_id: Some("provider-event-1".to_string()),
                    audit_receipt_ref: Some("audit-1".to_string()),
                }),
                Behavior::Fail(err) => Err(err.clone()),
            }
        }
    }

    #[test]
    fn unproven_action_is_not_dispatched() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let db = db_with_mission_context(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &unproven_catalog(),
            &adapter,
            &s,
            &db,
            req_with_mission_context(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!result.accepted);
        assert!(!result.routed);
        assert!(result.blocker.is_some());
        assert!(result.dispatch_ref.is_none());
        assert_eq!(
            adapter.count(),
            0,
            "a non-routed action must NOT reach the adapter"
        );
    }

    #[test]
    fn wrong_provider_is_refused_before_dispatch() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let db = db_with_mission_context(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            &db,
            req_with_mission_context(
                "claude",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!result.accepted);
        assert_eq!(result.status, "provider_mismatch");
        assert_eq!(adapter.count(), 0);
    }

    #[test]
    fn wrong_session_is_refused_before_dispatch() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let db = db_with_mission_context(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            &db,
            req_with_mission_context(
                "codex",
                "friday-other",
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!result.accepted);
        assert_eq!(result.status, "session_mismatch");
        assert_eq!(adapter.count(), 0);
    }

    #[test]
    fn unknown_action_is_refused_before_dispatch() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let db = db_with_mission_context(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            &db,
            req_with_mission_context(
                "codex",
                &s.friday_session_id,
                "teleport",
                "provider.codex.teleport",
            ),
        );
        assert!(!result.accepted);
        assert_eq!(result.status, "unknown");
        assert_eq!(adapter.count(), 0);
    }

    #[test]
    fn missing_capability_row_is_refused_before_dispatch() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let db = db_with_mission_context(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &ProviderWorkspaceCatalog::new(), // empty
            &adapter,
            &s,
            &db,
            req_with_mission_context(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!result.accepted);
        assert_eq!(result.status, "missing_capability");
        assert_eq!(adapter.count(), 0);
    }

    #[test]
    fn verified_action_without_mission_context_is_blocked_before_adapter() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            &empty_db(),
            req(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!result.accepted);
        assert!(!result.routed);
        assert_eq!(result.status, "mission_context_required");
        assert_eq!(
            result.blocker.as_deref(),
            Some("provider dispatch requires Mission context")
        );
        assert!(result.dispatch_ref.is_none());
        assert_eq!(
            adapter.count(),
            0,
            "accepted provider guard still must not dispatch detached provider work"
        );
    }

    #[test]
    fn verified_action_with_unresolved_mission_context_is_blocked_before_adapter() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            &empty_db(),
            req_with_mission_context(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!result.accepted);
        assert!(!result.routed);
        assert_eq!(result.status, "mission_context_required");
        assert_eq!(
            result.blocker.as_deref(),
            Some("provider dispatch Mission context blocked: unknown_work_item,unknown_mission")
        );
        assert_eq!(
            adapter.count(),
            0,
            "unresolved Mission context must not reach the provider adapter"
        );
    }

    #[test]
    fn verified_action_with_provider_mismatched_mission_context_is_blocked_before_adapter() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let db = db_with_mission_context(PlatformProvider::Claude);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            &db,
            req_with_mission_context(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!result.accepted);
        assert!(!result.routed);
        assert_eq!(result.status, "mission_context_required");
        assert_eq!(
            result.blocker.as_deref(),
            Some("provider dispatch Mission context provider mismatch")
        );
        assert_eq!(
            adapter.count(),
            0,
            "resolved Mission context must match the target provider before dispatch"
        );
    }

    #[test]
    fn unbound_payload_ref_is_blocked_before_adapter() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let db = db_with_mission_context(PlatformProvider::Codex);
        let mut request = req_with_mission_context(
            "codex",
            &s.friday_session_id,
            "list_sessions",
            "provider.codex.list_sessions",
        );
        request.payload_ref = Some("friday://body/other-request".to_string());

        let result = dispatch_provider_action(&verified_catalog(), &adapter, &s, &db, request);

        assert!(!result.accepted);
        assert!(!result.routed);
        assert_eq!(result.status, "mission_context_required");
        assert_eq!(
            result.blocker.as_deref(),
            Some("provider dispatch payload_ref is not bound to the WorkItem input_refs")
        );
        assert_eq!(adapter.count(), 0);
    }

    #[test]
    fn verified_action_is_dispatched_with_dispatch_ref_and_preserved_truth_label() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let db = db_with_mission_context(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            &db,
            req_with_mission_context(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(result.accepted);
        assert!(result.routed);
        assert_eq!(result.status, "dispatched_queued");
        assert!(result.blocker.is_none());
        let dr = result
            .dispatch_ref
            .expect("dispatch_ref present on dispatched action");
        assert_eq!(
            dr,
            "friday://provider-dispatch/codex/friday-codex/list_sessions"
        );
        // The truth label is the CAPABILITY's, not upgraded by the dispatch.
        assert_eq!(result.truth_label, VERIFIED_TRUTH);
        assert_eq!(
            result.mission_context.as_ref().unwrap().mission_id,
            "mission-provider-dispatch"
        );
        let route_decision = db
            .get_route_decision("route-decision:request-1")
            .unwrap()
            .unwrap();
        assert_eq!(route_decision.mission_id, "mission-provider-dispatch");
        assert_eq!(route_decision.work_item_id, "work-provider-dispatch");
        assert_eq!(
            route_decision.selected_provider_or_agent.as_deref(),
            Some("codex")
        );
        assert_eq!(
            route_decision.why_this_route,
            "Provider action must attach to a WorkItem."
        );
        assert!(db
            .list_mission_links("mission-provider-dispatch")
            .unwrap()
            .iter()
            .any(
                |link| link.link_kind == friday_core::MissionLinkKind::RouteDecision
                    && !link.link_kind.grants_memory_authority()
            ));
        assert_eq!(adapter.count(), 1);
    }

    #[test]
    fn adapter_failure_is_an_exact_blocker_not_a_completion() {
        let adapter = FakeAdapter::failing();
        let s = session(PlatformProvider::Codex);
        let db = db_with_mission_context(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            &db,
            req_with_mission_context(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        // Guard accepted it, but dispatch failed — never a completion.
        assert!(result.accepted);
        assert!(result.routed);
        assert_eq!(result.status, "dispatch_failed");
        assert!(result.dispatch_ref.is_none());
        // The wire blocker is the FIXED operator-safe string; the adapter's free-text
        // detail ("adapter offline") is NOT surfaced on the wire.
        assert_eq!(result.blocker.as_deref(), Some("provider dispatch failed"));
        assert_eq!(adapter.count(), 1);
    }

    #[test]
    fn dispatch_failure_redacts_adapter_supplied_secret_material() {
        // Non-vacuous secret-leak proof: the adapter returns a secret-shaped error
        // string; the seam must NOT surface any of it on the wire blocker.
        let adapter = FakeAdapter::failing_leaky();
        let s = session(PlatformProvider::Codex);
        let db = db_with_mission_context(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            &db,
            req_with_mission_context(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        let blocker = result.blocker.expect("failure carries a blocker");
        assert_eq!(blocker, "provider dispatch failed");
        for leak in ["sk-", "token", "account", "acct_", "shouldNeverHappen"] {
            assert!(
                !blocker.contains(leak),
                "adapter error text {leak:?} leaked into the wire blocker: {blocker:?}"
            );
        }
    }

    #[test]
    fn dispatch_status_running_and_completed_map_to_distinct_strings() {
        let s = session(PlatformProvider::Codex);
        for (status, expected) in [
            (DispatchStatus::Running, "dispatched_running"),
            (DispatchStatus::Completed, "dispatched_completed"),
        ] {
            let adapter = FakeAdapter::ok_status(status);
            let db = db_with_mission_context(PlatformProvider::Codex);
            let result = dispatch_provider_action(
                &verified_catalog(),
                &adapter,
                &s,
                &db,
                req_with_mission_context(
                    "codex",
                    &s.friday_session_id,
                    "list_sessions",
                    "provider.codex.list_sessions",
                ),
            );
            assert!(result.accepted);
            assert_eq!(result.status, expected);
            assert!(result.dispatch_ref.is_some());
            assert_eq!(adapter.count(), 1);
        }
    }

    #[test]
    fn unknown_provider_and_capability_mismatch_are_refused_before_dispatch() {
        let s = session(PlatformProvider::Codex);
        let db = db_with_mission_context(PlatformProvider::Codex);
        // Unknown provider string.
        let a1 = FakeAdapter::ok();
        let r1 = dispatch_provider_action(
            &verified_catalog(),
            &a1,
            &s,
            &db,
            req_with_mission_context(
                "frobnicator",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!r1.accepted);
        assert_eq!(r1.status, "unknown");
        assert_eq!(a1.count(), 0);
        // Correct provider/action but a forged capability id.
        let a2 = FakeAdapter::ok();
        let r2 = dispatch_provider_action(
            &verified_catalog(),
            &a2,
            &s,
            &db,
            req_with_mission_context(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.WRONG_ID",
            ),
        );
        assert!(!r2.accepted);
        assert_eq!(r2.status, "capability_mismatch");
        assert_eq!(a2.count(), 0);
    }
}
