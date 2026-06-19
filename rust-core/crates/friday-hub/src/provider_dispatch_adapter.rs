//! Live provider-workspace dispatch adapter (C1/C2 file-10 §3 parity) — DARK.
//!
//! [`crate::provider_dispatch::dispatch_provider_action`] (PWS-004) gates a Provider
//! Workspace action, derives Mission/route context, then hands an ACCEPTED + ROUTED action
//! to a [`ProviderDispatchAdapter`]. Until now the only non-test impl was
//! [`crate::hub_server`]'s `NoProviderWorkspaceDispatchAdapter`, which returns
//! `AdapterNotReady` for every action. This module supplies the FIRST real impl: it bridges
//! the Provider Workspace action matrix onto the existing, non-test provider clients
//! ([`friday_providers::codex_appserver`] / [`friday_providers::claude_control`]).
//!
//! ## What is LIVE vs honestly deferred
//!
//! The adapter routes the two NON-MODEL Codex metadata operations the existing
//! [`DispatchContext`] carries enough information to drive by default:
//!   - [`ProviderWorkspaceAction::ListSessions`] → `CodexAppServerClient::list_threads`
//!   - [`ProviderWorkspaceAction::StartSession`] → `CodexAppServerClient::start_thread`
//! It can also route Codex `send_turn` when tests or a future live caller inject a prompt
//! body resolver and the context carries a provider thread id. The current Hub selection can
//! inject the Mission body snapshot resolver, but production remains fail-closed / DARK because
//! the flag is default-OFF and no `friday_current()` send-turn capability is `Verified`.
//!
//! Every OTHER action returns a typed [`DispatchError::AdapterNotReady`] with a code-only
//! (secret-free) reason, NOT a fake success. The deferrals are honest and structural:
//!   - Read / Resume need provider client methods in this adapter; the context can now carry
//!     the existing `ProviderSessionLink.external_thread_id` when one is present.
//!   - Interrupt / Steer also need a provider `turn_id` (the session's `active_turn_id` is
//!     not threaded through the dispatch context).
//!   - Steer still needs both a provider `turn_id` and prompt text.
//!   - Send needs prompt text and a provider thread id; the resolver reads only a Mission-intake
//!     body snapshot bound to the resolved WorkItem input refs.
//!   - Fork / ApproveOrReject / AnswerQuestion have NO standalone client method (approve /
//!     answer exist only as the in-turn handler inside `run_turn_with_handler`).
//!   - OpenProviderNative is the unsupported / operator-gated native-link surface.
//!   - ALL Claude actions: the only live Claude surface is `mirror_stream_json`, a full
//!     model turn that needs prompt text (same body-reader gap as Codex Send).
//!
//! ## Invariants (preserved, never bypassed)
//!   - GATE FIRST. The adapter is reached ONLY after `dispatch_provider_action`'s guard
//!     accepts + routes the action — which requires a `Verified` capability. No
//!     `friday_current()` capability is `Verified` today, so in production the guard refuses
//!     every action before this adapter is ever consulted.
//!   - NO TRUTH UPGRADE. The adapter returns a [`DispatchOutcome`] carrying no truth label;
//!     the capability's label is authoritative.
//!   - SECRETS STAY HUB-SIDE. Every error is mapped to a code-only string (the same
//!     discipline as `codex_appserver`'s typed errors); no provider stderr / credential /
//!     account id / URL is surfaced. The dispatch seam additionally pins a FIXED wire blocker
//!     per [`DispatchError`] variant, so even this code never reaches a projected surface.
//!   - NO FALLBACK. A failed dispatch returns an exact blocker; it never reroutes.
//!   - NO MODEL CALL in the live set. `list_threads` / `start_thread` are metadata
//!     operations that spend zero tokens, so NO `token_ledger` row is written (a synthetic
//!     row would be a false billing record). The billing/metering reuse target is `SendTurn`,
//!     which is deferred until prompt text is resolvable.
//!
//! ## Flag gate
//! [`ENV_PROVIDER_WORKSPACE_DISPATCH`] (`FRIDAY_PROVIDER_WORKSPACE_DISPATCH`), exact `"1"`,
//! default-OFF. [`select_provider_workspace_dispatch_adapter`] returns the
//! `NoProviderWorkspaceDispatchAdapter` when OFF (byte-identical to today) and a real
//! [`ProviderWorkspaceDispatchAdapter`] when ON. Selection is at REQUEST time (the adapter
//! holds no client — it spawns a `codex app-server` per action and is stateless config), so
//! a missing Codex CLI surfaces as a per-action typed blocker, NOT a hub-boot crash.

use friday_providers::codex_appserver::{
    CodexAppServerClient, CodexAppServerError, CodexAppServerTransport, LocalCodexAppServer,
    TurnSummary,
};
use friday_storage::Db;

use crate::provider_dispatch::{
    DispatchContext, DispatchError, DispatchOutcome, DispatchStatus, ProviderDispatchAdapter,
};

/// The exact-`"1"` env flag that selects the live provider-workspace dispatch adapter.
/// UNSET / empty / `"0"` / any other value keeps the `NoProviderWorkspaceDispatchAdapter`
/// (byte-identical to today). Default-OFF / DARK.
pub const ENV_PROVIDER_WORKSPACE_DISPATCH: &str = "FRIDAY_PROVIDER_WORKSPACE_DISPATCH";

/// Pure flag-matcher for [`ENV_PROVIDER_WORKSPACE_DISPATCH`] (env read split out so the gate
/// is testable without mutating `std::env`, matching the program-standard split-env idiom).
/// ON iff the trimmed value is exactly `"1"`.
pub fn provider_workspace_dispatch_from(raw: Option<String>) -> bool {
    matches!(raw, Some(v) if v.trim() == "1")
}

/// Read [`ENV_PROVIDER_WORKSPACE_DISPATCH`] from the process env through the pure matcher.
pub fn provider_workspace_dispatch_enabled() -> bool {
    provider_workspace_dispatch_from(std::env::var(ENV_PROVIDER_WORKSPACE_DISPATCH).ok())
}

/// The minimal LIVE-set Codex client seam the adapter drives: the two NON-MODEL metadata
/// operations the dispatch context can fully describe. Mirrors the `CodexTurnSource` pattern
/// — `&self` + stateless-spawn-per-call keeps the live impl `Sync` — so a test can inject a
/// scripted [`CodexAppServerTransport`] (no real process / network) and the live impl spawns
/// a fresh `codex app-server`. Returns code-only typed errors (never raw provider text).
pub trait CodexWorkspaceClient {
    /// `thread/list` — a metadata read. Returns the listed thread count (NOT the raw thread
    /// bodies, which stay Hub-side).
    fn list_threads(&self) -> Result<usize, CodexAppServerError>;

    /// `thread/start` — opens a fresh local Codex thread. Returns the new provider thread id
    /// (an opaque local identifier, surfaced only as a `provider_event_id` ref).
    fn start_thread(&self) -> Result<String, CodexAppServerError>;

    /// `turn/start` — starts a Codex model turn on an existing provider thread. This is only
    /// reachable when the dispatch gate accepts a Verified action AND a prompt resolver supplies
    /// text from the WorkItem-bound payload ref.
    fn send_turn_text(
        &self,
        thread_id: &str,
        client_user_message_id: Option<&str>,
        text: &str,
    ) -> Result<TurnSummary, CodexAppServerError>;
}

/// A STATELESS live [`CodexWorkspaceClient`]: every call spawns a FRESH `codex app-server`,
/// `initialize`s + `initialized`-handshakes, runs the one metadata op, then tears the process
/// down on scope exit (`LocalCodexAppServer`'s kill-on-drop) — the same spawn-per-call shape
/// as `LocalCodexAppServerTurnSource`, so nothing non-`Sync` is held across calls. DARK:
/// spawning requires the Codex CLI installed + logged in; absence surfaces as a typed
/// `CodexAppServerError` (never faked).
pub struct LocalCodexWorkspaceClient {
    program: String,
    client_name: String,
    client_version: String,
}

impl LocalCodexWorkspaceClient {
    pub fn new(
        program: impl Into<String>,
        client_name: impl Into<String>,
        client_version: impl Into<String>,
    ) -> Self {
        Self {
            program: program.into(),
            client_name: client_name.into(),
            client_version: client_version.into(),
        }
    }
}

impl CodexWorkspaceClient for LocalCodexWorkspaceClient {
    fn list_threads(&self) -> Result<usize, CodexAppServerError> {
        let mut server = LocalCodexAppServer::spawn(&self.program)?;
        let client = server.client();
        client.initialize(&self.client_name, &self.client_version)?;
        client.initialized()?;
        // A small limit — this is a liveness/metadata probe, not a full enumeration.
        Ok(client.list_threads(20, true)?.threads.len())
    }

    fn start_thread(&self) -> Result<String, CodexAppServerError> {
        let mut server = LocalCodexAppServer::spawn(&self.program)?;
        let client = server.client();
        client.initialize(&self.client_name, &self.client_version)?;
        client.initialized()?;
        // No cwd / model override — let the app-server default (the dispatch context carries
        // neither; see the module deferral notes).
        Ok(client.start_thread(None, None)?.thread_id)
    }

    fn send_turn_text(
        &self,
        thread_id: &str,
        client_user_message_id: Option<&str>,
        text: &str,
    ) -> Result<TurnSummary, CodexAppServerError> {
        let mut server = LocalCodexAppServer::spawn(&self.program)?;
        let client = server.client();
        client.initialize(&self.client_name, &self.client_version)?;
        client.initialized()?;
        client.send_turn_text(thread_id, client_user_message_id, text)
    }
}

/// A [`CodexWorkspaceClient`] over an already-initialized [`CodexAppServerClient`] for a
/// supplied (typically mocked) transport. Used by the creds-free flag-ON tests to drive the
/// REAL adapter routing through a scripted `CodexAppServerTransport` — no process, no network.
/// `&self` is satisfied by an interior `RefCell` because the underlying client is `&mut`;
/// this impl is NOT `Sync` and is intended for single-threaded test injection only.
pub struct TransportCodexWorkspaceClient<T> {
    client: std::cell::RefCell<CodexAppServerClient<T>>,
}

impl<T: CodexAppServerTransport> TransportCodexWorkspaceClient<T> {
    pub fn new(client: CodexAppServerClient<T>) -> Self {
        Self {
            client: std::cell::RefCell::new(client),
        }
    }
}

impl<T: CodexAppServerTransport> CodexWorkspaceClient for TransportCodexWorkspaceClient<T> {
    fn list_threads(&self) -> Result<usize, CodexAppServerError> {
        Ok(self
            .client
            .borrow_mut()
            .list_threads(20, true)?
            .threads
            .len())
    }

    fn start_thread(&self) -> Result<String, CodexAppServerError> {
        Ok(self.client.borrow_mut().start_thread(None, None)?.thread_id)
    }

    fn send_turn_text(
        &self,
        thread_id: &str,
        client_user_message_id: Option<&str>,
        text: &str,
    ) -> Result<TurnSummary, CodexAppServerError> {
        self.client
            .borrow_mut()
            .send_turn_text(thread_id, client_user_message_id, text)
    }
}

pub trait PromptBodyResolver {
    fn resolve_prompt(&self, ctx: &DispatchContext<'_>) -> Result<String, DispatchError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NoPromptBodyResolver;

impl PromptBodyResolver for NoPromptBodyResolver {
    fn resolve_prompt(&self, _ctx: &DispatchContext<'_>) -> Result<String, DispatchError> {
        Err(DispatchError::AdapterNotReady(
            "prompt_body_resolver_not_wired".to_string(),
        ))
    }
}

pub struct DbPromptBodyResolver<'a> {
    db: &'a Db,
}

impl<'a> DbPromptBodyResolver<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }
}

impl PromptBodyResolver for DbPromptBodyResolver<'_> {
    fn resolve_prompt(&self, ctx: &DispatchContext<'_>) -> Result<String, DispatchError> {
        let body_ref = ctx.payload_ref.ok_or_else(|| {
            DispatchError::AdapterNotReady("prompt_body_ref_required".to_string())
        })?;
        if !ctx
            .work_item_input_refs
            .iter()
            .any(|input| input == body_ref)
        {
            return Err(DispatchError::AdapterNotReady(
                "prompt_body_ref_not_bound_to_work_item".to_string(),
            ));
        }
        let mission = self
            .db
            .get_mission(&ctx.mission_context.mission_id)
            .map_err(|_| {
                DispatchError::AdapterNotReady("prompt_body_mission_lookup_failed".to_string())
            })?
            .ok_or_else(|| {
                DispatchError::AdapterNotReady("prompt_body_mission_missing".to_string())
            })?;
        let conversation = self
            .db
            .get_friday_conversation(&mission.friday_conversation_id)
            .map_err(|_| {
                DispatchError::AdapterNotReady("prompt_body_conversation_lookup_failed".to_string())
            })?
            .ok_or_else(|| {
                DispatchError::AdapterNotReady("prompt_body_conversation_missing".to_string())
            })?;
        let snapshot = self
            .db
            .get_mission_body_snapshot(
                &conversation.owner_principal,
                &ctx.mission_context.work_item_id,
                body_ref,
            )
            .map_err(|_| {
                DispatchError::AdapterNotReady("prompt_body_snapshot_lookup_failed".to_string())
            })?
            .ok_or_else(|| {
                DispatchError::AdapterNotReady("prompt_body_snapshot_missing".to_string())
            })?;
        Ok(snapshot.body)
    }
}

/// The live provider-workspace dispatch adapter. Routes the LIVE-set Codex metadata actions
/// onto the injected [`CodexWorkspaceClient`]; returns a typed, secret-free
/// [`DispatchError::AdapterNotReady`] for every honestly-deferred action.
pub struct ProviderWorkspaceDispatchAdapter<C, R = NoPromptBodyResolver> {
    codex: C,
    prompt_resolver: R,
}

impl<C: CodexWorkspaceClient> ProviderWorkspaceDispatchAdapter<C, NoPromptBodyResolver> {
    pub fn new(codex: C) -> Self {
        Self {
            codex,
            prompt_resolver: NoPromptBodyResolver,
        }
    }
}

impl<C: CodexWorkspaceClient, R: PromptBodyResolver> ProviderWorkspaceDispatchAdapter<C, R> {
    pub fn with_prompt_resolver(codex: C, prompt_resolver: R) -> Self {
        Self {
            codex,
            prompt_resolver,
        }
    }
}

impl<C: CodexWorkspaceClient, R: PromptBodyResolver> ProviderDispatchAdapter
    for ProviderWorkspaceDispatchAdapter<C, R>
{
    fn execute_action(&self, ctx: &DispatchContext<'_>) -> Result<DispatchOutcome, DispatchError> {
        // The provider/action strings are the guard-validated ones. Map provider kind first;
        // a non-codex provider has no live workspace client wired this slice.
        match ctx.provider {
            "codex" => self.execute_codex(ctx),
            // Claude's only live surface is a full model turn (mirror_stream_json), which
            // needs prompt text the dispatch context cannot resolve — honestly deferred.
            "claude" => Err(DispatchError::AdapterNotReady(
                "claude_workspace_dispatch_not_wired".to_string(),
            )),
            other => Err(DispatchError::AdapterNotReady(format!(
                "provider_workspace_dispatch_unknown_provider:{other}"
            ))),
        }
    }
}

impl<C: CodexWorkspaceClient, R: PromptBodyResolver> ProviderWorkspaceDispatchAdapter<C, R> {
    fn execute_codex(&self, ctx: &DispatchContext<'_>) -> Result<DispatchOutcome, DispatchError> {
        match ctx.action {
            "list_sessions" => {
                // Metadata read — zero tokens, no model call, no ledger row.
                let _count = self.codex.list_threads().map_err(map_codex_error)?;
                Ok(DispatchOutcome {
                    status: DispatchStatus::Completed,
                    // The count is metadata; do not surface it (or thread bodies) on the
                    // outcome. The dispatch_ref the seam echoes is the action identity.
                    provider_event_id: None,
                    audit_receipt_ref: None,
                })
            }
            "start_session" => {
                // Opens a fresh local Codex thread — a control op, not a model turn.
                let thread_id = self.codex.start_thread().map_err(map_codex_error)?;
                Ok(DispatchOutcome {
                    status: DispatchStatus::Completed,
                    provider_event_id: Some(thread_id),
                    audit_receipt_ref: None,
                })
            }
            "send_turn" => {
                let thread_id = ctx.provider_thread_id.ok_or_else(|| {
                    DispatchError::AdapterNotReady("codex_send_turn_thread_id_missing".to_string())
                })?;
                let prompt = self.prompt_resolver.resolve_prompt(ctx)?;
                if prompt.trim().is_empty() {
                    return Err(DispatchError::AdapterNotReady(
                        "prompt_body_empty".to_string(),
                    ));
                }
                let turn = self
                    .codex
                    .send_turn_text(thread_id, None, &prompt)
                    .map_err(map_codex_error)?;
                Ok(DispatchOutcome {
                    status: DispatchStatus::Running,
                    provider_event_id: Some(turn.turn_id),
                    audit_receipt_ref: None,
                })
            }
            // Honestly-deferred Codex actions — typed, secret-free, NOT a fake success.
            // See the module deferral notes for the precise missing input per action.
            other => Err(DispatchError::AdapterNotReady(format!(
                "codex_workspace_action_not_supported:{other}"
            ))),
        }
    }
}

/// Map a [`CodexAppServerError`] to a code-only [`DispatchError`] (mirrors
/// `codex_gated_turn::codex_error_code`'s discipline). The text is a fixed code namespace —
/// no provider stderr / credential / raw output. The dispatch seam additionally collapses
/// this to a FIXED per-variant wire blocker, so this code never reaches a projection.
fn map_codex_error(e: CodexAppServerError) -> DispatchError {
    match e {
        CodexAppServerError::Transport { code } => {
            DispatchError::ExecutionFailed(format!("codex_transport:{code}"))
        }
        CodexAppServerError::Protocol { code } => {
            DispatchError::ExecutionFailed(format!("codex_protocol:{code}"))
        }
        CodexAppServerError::SchemaDrift => {
            DispatchError::ExecutionFailed("codex_schema_drift".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_providers::codex_appserver::{JsonRpcResponse, MockCodexAppServerTransport};
    use serde_json::json;

    fn ok(result: serde_json::Value) -> Result<JsonRpcResponse, CodexAppServerError> {
        Ok(JsonRpcResponse {
            id: Some(json!(1)),
            result: Some(result),
            error: None,
        })
    }

    /// Build a transport-backed live client whose scripted responses satisfy
    /// initialize + initialized (a notify no-op) + the one metadata op.
    fn transport_client(
        responses: Vec<Result<JsonRpcResponse, CodexAppServerError>>,
    ) -> TransportCodexWorkspaceClient<MockCodexAppServerTransport> {
        TransportCodexWorkspaceClient::new(CodexAppServerClient::new(
            MockCodexAppServerTransport::new(responses),
        ))
    }

    #[test]
    fn flag_matcher_only_literal_one_enables() {
        assert!(provider_workspace_dispatch_from(Some("1".to_string())));
        assert!(provider_workspace_dispatch_from(Some("  1  ".to_string())));
        for off in [
            None,
            Some(""),
            Some("0"),
            Some("1 1"),
            Some("true"),
            Some("01"),
        ] {
            assert!(
                !provider_workspace_dispatch_from(off.map(str::to_string)),
                "{off:?} must NOT enable the adapter"
            );
        }
    }

    #[test]
    fn list_threads_maps_to_completed_metadata_no_event_id() {
        let client = transport_client(vec![ok(json!({
            "data": [
                { "id": "thread-a" },
                { "id": "thread-b" }
            ],
            "nextCursor": null
        }))]);
        let count = client.list_threads().unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn start_thread_returns_provider_thread_id() {
        let client = transport_client(vec![ok(json!({
            "thread": { "id": "thread-new" }
        }))]);
        let id = client.start_thread().unwrap();
        assert_eq!(id, "thread-new");
    }

    #[test]
    fn codex_error_is_mapped_code_only_never_raw_text() {
        // A protocol error from the client must become a code-only DispatchError.
        let mapped = map_codex_error(CodexAppServerError::Protocol {
            code: "thread-list-data",
        });
        match mapped {
            DispatchError::ExecutionFailed(code) => {
                assert_eq!(code, "codex_protocol:thread-list-data");
                assert!(!code.contains("sk-"));
                assert!(!code.contains('/'));
            }
            other => panic!("expected ExecutionFailed, got {other:?}"),
        }
    }

    // ---- End-to-end seam tests: the REAL adapter routed through the FULL gated
    // `dispatch_provider_action` flow (gate -> Mission-context -> route-decision -> adapter),
    // over a Verified test catalog + a mock transport (no process, no network). These mirror
    // the existing `provider_dispatch` fixtures and prove the adapter is reached only after
    // the gate, routes the right client method, and defers honestly. ----
    use crate::provider_dispatch::dispatch_provider_action;
    use crate::provider_workspace::{ProviderWorkspaceAction, ProviderWorkspaceCatalog};
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus,
        TruthStatus, WorkItem, WorkItemStatus, WorkLane,
    };
    use friday_protocol::{
        ProviderWorkspaceActionRequestWire, ProviderWorkspaceMissionContextWire,
    };
    use friday_providers::unified::{
        CapabilityStatus, FallbackStatus, PlatformProvider, ProviderCapability,
        ProviderNativeAction, ProviderSession, ProviderSyncMode, SessionStatus,
    };
    use friday_storage::{Db, MissionBodySnapshot};
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);

    fn tmp_db() -> Db {
        let path = std::env::temp_dir()
            .join(format!(
                "friday-pw-dispatch-adapter-{}-{}.sqlite",
                std::process::id(),
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned();
        Db::open_hub(&path).unwrap()
    }

    /// A Verified catalog for the two LIVE-set Codex actions, so the gate ACCEPTS + ROUTES
    /// them and the adapter is actually reached. (`friday_current()` marks none Verified, so
    /// the adapter is unreachable in prod — this test catalog is the only way to exercise it,
    /// exactly as the existing `provider_dispatch` tests do.)
    fn verified_codex_catalog() -> ProviderWorkspaceCatalog {
        let mut catalog = ProviderWorkspaceCatalog::new();
        for (action, id, method) in [
            (
                ProviderWorkspaceAction::ListSessions,
                "provider.codex.list_sessions",
                friday_providers::unified::CodexAppServerMethod::ThreadList,
            ),
            (
                ProviderWorkspaceAction::StartSession,
                "provider.codex.start_session",
                friday_providers::unified::CodexAppServerMethod::ThreadStart,
            ),
            (
                // A Verified-but-deferred action, to prove the adapter returns a typed
                // not-supported even when the GATE would route it.
                ProviderWorkspaceAction::ForkSession,
                "provider.codex.fork_session",
                friday_providers::unified::CodexAppServerMethod::ThreadFork,
            ),
            (
                ProviderWorkspaceAction::SendTurn,
                "provider.codex.send_turn",
                friday_providers::unified::CodexAppServerMethod::TurnStart,
            ),
        ] {
            catalog
                .register(
                    action,
                    ProviderCapability {
                        capability_id: id.to_string(),
                        provider: PlatformProvider::Codex,
                        status: CapabilityStatus::Verified,
                        sync_mode: ProviderSyncMode::ProviderAppServerLocal,
                        truth_label: "verified test catalog".to_string(),
                        blocker: None,
                        proof_ref: Some("proof-1".to_string()),
                        native_action: Some(ProviderNativeAction::CodexAppServer {
                            method,
                            schema_ref: "schema".to_string(),
                        }),
                    },
                )
                .unwrap();
        }
        catalog
    }

    fn session() -> ProviderSession {
        ProviderSession {
            friday_session_id: "friday-codex".to_string(),
            provider: PlatformProvider::Codex,
            workspace_id: "workspace-1".to_string(),
            sync_mode: ProviderSyncMode::ProviderAppServerLocal,
            status: SessionStatus::Idle,
            capability_snapshot: Vec::new(),
            external_thread_id: Some("thread-1".to_string()),
            active_turn_id: None,
            last_event_seq: 0,
            truth_label: "test".to_string(),
            fallback_status: FallbackStatus::NoFallback,
        }
    }

    fn judgment() -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "Dispatch a provider workspace action".to_string(),
            current_blocker: None,
            target_lane_thread_agent_provider: "codex".to_string(),
            read_first_files: vec!["provider_dispatch_adapter.rs".into()],
            required_output: "provider dispatch result".to_string(),
            done_criteria: vec!["adapter routes the action".into()],
            red_lines: vec!["no fake success".into()],
            why_this_route: "Provider action must attach to a WorkItem.".into(),
            considered_options: vec!["detached dispatch".into(), "Mission context".into()],
            deferred_options: vec!["native UI".into()],
            previous_pitfalls: vec!["ack looked like completion".into()],
            inheritable_context: vec!["Mission Spine owns product state".into()],
            proof_requirements: vec!["adapter test".into()],
            ownership_claim_ids: vec!["own-test".into()],
        }
    }

    fn db_with_context() -> Db {
        let db = tmp_db();
        let now = 1_700_000_000_000;
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: "fconv_pw".into(),
            owner_principal: "owner-1".into(),
            title: "PW dispatch".into(),
            current_focus_summary: "provider action attached to WorkItem".into(),
            active_mission_ids: vec!["mission-1".into()],
            surface_thread_ids: Vec::new(),
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: vec!["proof://x".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: "mission-1".into(),
            friday_conversation_id: "fconv_pw".into(),
            title: "PW dispatch".into(),
            intent: "dispatch provider action".into(),
            status: MissionStatus::Active,
            why_now: "Provider work must not detach.".into(),
            decision_path_summary: "Resolve Mission context before adapter.".into(),
            considered_options: vec!["detached".into(), "bound".into()],
            deferred_options: vec!["live proof".into()],
            known_pitfalls: vec!["ack is not completion".into()],
            handoff_inheritance: vec!["preserve judgment".into()],
            work_item_ids: vec!["work-1".into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://x".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_work_item(&WorkItem {
            work_item_id: "work-1".into(),
            mission_id: "mission-1".into(),
            lane: WorkLane::Codex,
            target_provider_or_agent: Some("codex".to_string()),
            status: WorkItemStatus::ReadyToDispatch,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("provider.codex.list_sessions".into()),
            risk_level: friday_core::Risk::Low,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["friday://body/request/1".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["adapter test".into()],
            proof_receipts: Vec::new(),
            judgment_memory: judgment(),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        let snapshot = MissionBodySnapshot::new(
            "owner-1",
            "mission-1",
            "work-1",
            "friday://body/request/1",
            "provider_workspace",
            "Say exactly READY.",
            now,
        )
        .unwrap();
        db.upsert_mission_body_snapshot(&snapshot).unwrap();
        db
    }

    fn req(action: &str, capability_id: &str) -> ProviderWorkspaceActionRequestWire {
        ProviderWorkspaceActionRequestWire {
            request_id: "request-1".to_string(),
            friday_session_id: "friday-codex".to_string(),
            provider: "codex".to_string(),
            action: action.to_string(),
            capability_id: capability_id.to_string(),
            payload_ref: Some("friday://body/request/1".to_string()),
            mission_context: Some(ProviderWorkspaceMissionContextWire {
                friday_conversation_id: "fconv_pw".to_string(),
                mission_id: "mission-1".to_string(),
                work_item_id: "work-1".to_string(),
            }),
        }
    }

    #[derive(Clone, Copy)]
    struct TestPromptResolver;

    impl PromptBodyResolver for TestPromptResolver {
        fn resolve_prompt(&self, ctx: &DispatchContext<'_>) -> Result<String, DispatchError> {
            let payload_ref = ctx.payload_ref.ok_or_else(|| {
                DispatchError::AdapterNotReady("prompt_payload_ref_missing".to_string())
            })?;
            assert!(ctx
                .work_item_input_refs
                .iter()
                .any(|input_ref| input_ref == payload_ref));
            Ok("Say exactly READY.".to_string())
        }
    }

    /// FLAG-ON discriminator: the REAL adapter routes `list_sessions` to `thread/list` and the
    /// gated seam returns a dispatched/completed result (NOT `AdapterNotReady`).
    #[test]
    fn flag_on_real_adapter_routes_list_sessions_to_thread_list() {
        let adapter = ProviderWorkspaceDispatchAdapter::new(transport_client(vec![ok(json!({
            "data": [ { "id": "thread-a" } ],
            "nextCursor": null
        }))]));
        let result = dispatch_provider_action(
            &verified_codex_catalog(),
            &adapter,
            &session(),
            &db_with_context(),
            req("list_sessions", "provider.codex.list_sessions"),
        );
        assert!(result.accepted, "gate must accept a Verified action");
        assert!(result.routed);
        assert_eq!(result.status, "dispatched_completed");
        assert!(result.blocker.is_none());
        assert!(result.dispatch_ref.is_some());
        // Truth label is the capability's, NOT upgraded by the dispatch.
        assert_eq!(result.truth_label, "verified test catalog");
    }

    /// FLAG-ON: `start_session` routes to `thread/start` and the new thread id flows back as
    /// the dispatch's provider_event_id-bearing completion.
    #[test]
    fn flag_on_real_adapter_routes_start_session_to_thread_start() {
        let adapter = ProviderWorkspaceDispatchAdapter::new(transport_client(vec![ok(json!({
            "thread": { "id": "thread-new" }
        }))]));
        let result = dispatch_provider_action(
            &verified_codex_catalog(),
            &adapter,
            &session(),
            &db_with_context(),
            req("start_session", "provider.codex.start_session"),
        );
        assert!(result.accepted);
        assert_eq!(result.status, "dispatched_completed");
        assert!(result.dispatch_ref.is_some());
    }

    #[test]
    fn flag_on_send_turn_without_prompt_resolver_fails_closed() {
        let adapter = ProviderWorkspaceDispatchAdapter::new(transport_client(vec![ok(json!({
            "turn": { "id": "must-not-call", "status": "inProgress", "items": [] }
        }))]));
        let result = dispatch_provider_action(
            &verified_codex_catalog(),
            &adapter,
            &session(),
            &db_with_context(),
            req("send_turn", "provider.codex.send_turn"),
        );
        assert!(result.accepted);
        assert!(result.routed);
        assert_eq!(result.status, "dispatch_failed");
        assert_eq!(
            result.blocker.as_deref(),
            Some("provider adapter not ready")
        );
        assert!(result.dispatch_ref.is_none());
    }

    #[test]
    fn flag_on_send_turn_with_prompt_resolver_routes_to_turn_start() {
        let adapter = ProviderWorkspaceDispatchAdapter::with_prompt_resolver(
            transport_client(vec![ok(json!({
                "turn": { "id": "turn-1", "status": "inProgress", "items": [] }
            }))]),
            TestPromptResolver,
        );
        let result = dispatch_provider_action(
            &verified_codex_catalog(),
            &adapter,
            &session(),
            &db_with_context(),
            req("send_turn", "provider.codex.send_turn"),
        );
        assert!(result.accepted);
        assert!(result.routed);
        assert_eq!(result.status, "dispatched_running");
        assert!(result.blocker.is_none());
        assert!(result.dispatch_ref.is_some());
        assert_eq!(result.truth_label, "verified test catalog");
    }

    #[test]
    fn flag_on_send_turn_with_db_prompt_resolver_routes_to_turn_start() {
        let db = db_with_context();
        let adapter = ProviderWorkspaceDispatchAdapter::with_prompt_resolver(
            transport_client(vec![ok(json!({
                "turn": { "id": "turn-db", "status": "inProgress", "items": [] }
            }))]),
            DbPromptBodyResolver::new(&db),
        );
        let result = dispatch_provider_action(
            &verified_codex_catalog(),
            &adapter,
            &session(),
            &db,
            req("send_turn", "provider.codex.send_turn"),
        );
        assert!(result.accepted);
        assert!(result.routed);
        assert_eq!(result.status, "dispatched_running");
        assert!(result.blocker.is_none());
        assert!(result.dispatch_ref.is_some());
        assert_eq!(result.truth_label, "verified test catalog");
    }

    /// FLAG-OFF byte-identical discriminator: the `NoProviderWorkspaceDispatchAdapter` over the
    /// SAME Verified catalog + Mission context returns the `dispatch_failed` outcome (the
    /// adapter-not-ready blocker), so flag-OFF behavior is the historical one. The pair
    /// (this + the two flag-ON tests above) discriminates the selection.
    #[test]
    fn flag_off_no_adapter_returns_adapter_not_ready_on_same_verified_action() {
        // Re-create the No-adapter behavior locally (it lives private in hub_server.rs): an
        // adapter that always returns AdapterNotReady.
        struct AlwaysNotReady;
        impl ProviderDispatchAdapter for AlwaysNotReady {
            fn execute_action(
                &self,
                _ctx: &DispatchContext<'_>,
            ) -> Result<DispatchOutcome, DispatchError> {
                Err(DispatchError::AdapterNotReady(
                    "provider adapter unavailable from Hub metadata gate".to_string(),
                ))
            }
        }
        let result = dispatch_provider_action(
            &verified_codex_catalog(),
            &AlwaysNotReady,
            &session(),
            &db_with_context(),
            req("list_sessions", "provider.codex.list_sessions"),
        );
        // Gate still accepted+routed it (same as flag-ON), but the No-adapter fails it closed.
        assert!(result.accepted);
        assert!(result.routed);
        assert_eq!(result.status, "dispatch_failed");
        assert_eq!(
            result.blocker.as_deref(),
            Some("provider adapter not ready")
        );
        assert!(result.dispatch_ref.is_none());
    }

    /// A Verified-but-deferred action (fork_session) routes through the gate but the REAL
    /// adapter returns a typed not-supported (surfaced as the fixed `provider dispatch failed`
    /// wire blocker) — an HONEST deferral, never a fake success.
    #[test]
    fn flag_on_deferred_action_returns_typed_not_supported() {
        let adapter = ProviderWorkspaceDispatchAdapter::new(transport_client(vec![]));
        let result = dispatch_provider_action(
            &verified_codex_catalog(),
            &adapter,
            &session(),
            &db_with_context(),
            req("fork_session", "provider.codex.fork_session"),
        );
        assert!(
            result.accepted,
            "gate routes a Verified action to the adapter"
        );
        assert_eq!(result.status, "dispatch_failed");
        // The fixed per-variant wire blocker — never the adapter's free-text code namespace.
        assert_eq!(
            result.blocker.as_deref(),
            Some("provider adapter not ready")
        );
        assert!(result.dispatch_ref.is_none());
    }

    /// The adapter is reached ONLY after the gate: an UNPROVEN (non-Verified) capability is
    /// refused before the adapter, so a "broken" mock transport is never even consulted.
    #[test]
    fn unproven_capability_never_reaches_the_adapter() {
        // friday_current() marks list_sessions ImplementedUnproven (not Verified).
        let adapter = ProviderWorkspaceDispatchAdapter::new(transport_client(vec![Err(
            CodexAppServerError::Transport {
                code: "must-not-call",
            },
        )]));
        let result = dispatch_provider_action(
            &ProviderWorkspaceCatalog::friday_current(),
            &adapter,
            &session(),
            &db_with_context(),
            req("list_sessions", "provider.codex.list_sessions"),
        );
        assert!(!result.accepted);
        assert!(!result.routed);
        // The capability's own blocker, NOT an adapter error — the adapter was never called.
        assert!(result
            .blocker
            .as_deref()
            .unwrap()
            .contains("official-history"));
    }
}
