//! UNW-003 — dynamic provider routing (decision layer).
//!
//! Friday can be configured with multiple model providers (DeepSeek, Codex,
//! Claude) that differ by **api**, **backendKind** (`http`/`cli`/`sdk`), **model
//! size**, and **runtime capabilities**. This module is the runtime
//! *decision layer* that, for one request, selects WHICH provider/model answers
//! — mirroring the oracle's
//! `filterFridayProviderRoutesByRequiredCapabilities` + the provider-service
//! route selection, but scoped to the deterministic core (the cost/penalty/
//! history *ordering* machinery is the separate learning subsystem, out of
//! scope here).
//!
//! ## The load-bearing trust invariant (do not regress UNW-001)
//!
//! Routing decides *who answers*; it has **zero** authority over how the
//! resulting tool call is classified. The selected client emits the same
//! *untrusted* [`crate::RawToolCall`] as any other client, and that call still
//! flows through the single [`crate::build_request`] / `trusted_classify`
//! chokepoint. [`RawToolCall`] carries no provider/trust field, so a provider
//! being "available" or "preferred" can never downgrade a mutating action to
//! read-only or skip the owner-approval gate. This is enforced *by
//! construction* (the router never touches classification) and proven by
//! [`tests::routed_mutating_tool_is_denied_without_approval_regardless_of_provider`].
//!
//! ## Selection vs. fallback (no silent reroute)
//!
//! Mirroring [`crate::ProviderError`]/`friday-providers`' no-fallback contract:
//! a *specifically requested* provider that is unavailable is an
//! [`RouteError::RequestedProviderUnavailable`] — never a silent reroute to a
//! different provider. "Nothing specifically requested → pick the single
//! eligible provider" is *selection*, which is allowed.
//!
//! ## Honest scope
//!
//! In this build only DeepSeek is live (Codex/Claude are auth-gated — see the
//! `friday-providers` auth-readiness crate). So Codex/Claude routes are
//! registered as *unavailable* and multi-provider *dispatch* is mock-proven, not
//! live-proven. Live cross-provider routing remains operator-gated on provider
//! login.

use std::collections::{BTreeMap, BTreeSet};

use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
use friday_storage::StorageError;
use rusqlite::Connection;

use crate::{run_loop, AgentLlmClient, LoopOutcome, ToolExecutor};

/// Provider wire API. Subset of the oracle's `FRIDAY_PROVIDER_APIS` that this
/// decision layer routes across; the registrant tags each route with its api so
/// a request can pin one (e.g. "must use the Codex responses API").
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ProviderApi {
    /// OpenAI-style `/chat/completions` (DeepSeek speaks this).
    OpenAiCompletions,
    /// OpenAI Responses API.
    OpenAiResponses,
    /// Codex responses API (Codex CLI backend).
    OpenAiCodexResponses,
    /// Anthropic `/v1/messages` (Claude).
    AnthropicMessages,
}

/// How a provider is reached. Mirrors the oracle's
/// `FRIDAY_PROVIDER_BACKEND_KINDS = ["http", "cli", "sdk"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum BackendKind {
    /// Direct HTTP API (DeepSeek).
    Http,
    /// A local provider CLI (Codex/Claude CLIs).
    Cli,
    /// A vendor SDK.
    Sdk,
}

/// Coarse model-size class, a **registrant-set route property** (NOT inferred
/// from the model string at selection time — same registrant-sets-the-truth
/// discipline as the UNW-002 tool registry). DeepSeek registers `flash` as
/// [`ModelSize::Small`] and `pro` as [`ModelSize::Large`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ModelSize {
    Small,
    Large,
}

/// A runtime capability a route may support. Subset of the oracle's
/// `FRIDAY_RUNTIME_CAPABILITY_IDS` relevant to the agent loop. A request lists
/// the capabilities it *requires*; a route is eligible only if it supports
/// **every** one (fail-closed — an un-advertised capability is treated as
/// unsupported).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Capability {
    Text,
    Vision,
    WebSearch,
    FileRead,
    FileWrite,
}

/// One dispatchable provider route. The fields are exactly those the selector
/// consumes; cost/region/penalty ordering inputs are deliberately absent (they
/// belong to the out-of-scope learning subsystem).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderRoute {
    /// Stable provider identifier (e.g. `"deepseek"`, `"codex"`, `"claude"`).
    /// Also the [`RouteRegistry`] key and the resolver lookup key.
    pub provider_id: String,
    pub api: ProviderApi,
    pub backend_kind: BackendKind,
    /// The concrete model id this route dispatches to (e.g. `"deepseek-v4-flash"`).
    pub model: String,
    pub model_size: ModelSize,
    pub capabilities: BTreeSet<Capability>,
    /// Provider lifecycle reachable in THIS deployment (installed/configured).
    /// Mirrors `isProviderLifecycleAvailableForRuntime`.
    pub available: bool,
    /// Last credential/connectivity validation succeeded. Mirrors the oracle's
    /// `validation.status === "ok"` precondition: a route that has not validated
    /// is never dispatchable (fail-closed).
    pub validation_ok: bool,
    /// Registrant-set deterministic tie-break (lower = preferred). Two otherwise
    /// equally-eligible routes are ordered by `(priority, provider_id)` so
    /// selection is reproducible.
    pub priority: u32,
}

impl ProviderRoute {
    /// A route is dispatchable iff its provider lifecycle is available AND its
    /// last validation succeeded. Both are runtime truth — never assumed.
    pub fn is_dispatchable(&self) -> bool {
        self.available && self.validation_ok
    }

    fn supports_all(&self, required: &[Capability]) -> bool {
        required.iter().all(|c| self.capabilities.contains(c))
    }
}

/// A late-bindable set of provider routes, keyed by `provider_id` (same
/// data-driven discipline as the UNW-002 [`crate::ToolRegistry`]). Iteration is
/// key-sorted, so selection over the registry is deterministic.
#[derive(Clone, Debug, Default)]
pub struct RouteRegistry {
    routes: BTreeMap<String, ProviderRoute>,
}

impl RouteRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register (or replace) a route. The registrant — Hub-trusted code — sets
    /// every property; nothing here is derived from model output.
    pub fn register(&mut self, route: ProviderRoute) {
        self.routes.insert(route.provider_id.clone(), route);
    }

    pub fn get(&self, provider_id: &str) -> Option<&ProviderRoute> {
        self.routes.get(provider_id)
    }

    /// All routes, deterministically ordered by `provider_id`.
    pub fn all(&self) -> impl Iterator<Item = &ProviderRoute> {
        self.routes.values()
    }

    pub fn is_empty(&self) -> bool {
        self.routes.is_empty()
    }

    /// The autonomous-baseline registry for THIS build: the two live DeepSeek
    /// routes (flash=Small, pro=Large, HTTP/OpenAI-completions, validated), plus
    /// Codex and Claude registered as **unavailable** (their CLIs are auth-gated
    /// here — see `friday-providers`). This documents the real deployment truth:
    /// DeepSeek is dispatchable; the others are present-but-not-live until the
    /// operator logs in.
    pub fn autonomous_baseline() -> Self {
        let text_files: BTreeSet<Capability> = [
            Capability::Text,
            Capability::FileRead,
            Capability::FileWrite,
        ]
        .into_iter()
        .collect();
        let mut r = Self::new();
        r.register(ProviderRoute {
            provider_id: "deepseek".to_string(),
            api: ProviderApi::OpenAiCompletions,
            backend_kind: BackendKind::Http,
            model: "deepseek-v4-flash".to_string(),
            model_size: ModelSize::Small,
            capabilities: text_files.clone(),
            available: true,
            validation_ok: true,
            priority: 0,
        });
        r.register(ProviderRoute {
            provider_id: "deepseek-pro".to_string(),
            api: ProviderApi::OpenAiCompletions,
            backend_kind: BackendKind::Http,
            model: "deepseek-v4-pro".to_string(),
            model_size: ModelSize::Large,
            capabilities: text_files.clone(),
            available: true,
            validation_ok: true,
            priority: 1,
        });
        r.register(ProviderRoute {
            provider_id: "codex".to_string(),
            api: ProviderApi::OpenAiCodexResponses,
            backend_kind: BackendKind::Cli,
            model: "gpt-5-codex".to_string(),
            model_size: ModelSize::Large,
            capabilities: text_files.clone(),
            available: false, // CLI auth-gated in this build
            validation_ok: false,
            priority: 2,
        });
        r.register(ProviderRoute {
            provider_id: "claude".to_string(),
            api: ProviderApi::AnthropicMessages,
            backend_kind: BackendKind::Cli,
            model: "claude-opus-4".to_string(),
            model_size: ModelSize::Large,
            capabilities: text_files,
            available: false, // CLI auth-gated in this build
            validation_ok: false,
            priority: 3,
        });
        r
    }
}

/// Constraints for one routing decision. All filters are AND-ed; `None`/empty
/// means "no constraint on this dimension".
#[derive(Clone, Debug, Default)]
pub struct RouteRequest {
    /// Capabilities the route MUST support (all of them).
    pub required_capabilities: Vec<Capability>,
    pub preferred_api: Option<ProviderApi>,
    pub preferred_backend: Option<BackendKind>,
    /// Required model-size class (`None` = any).
    pub model_size: Option<ModelSize>,
    /// Pin a specific provider. If set and that provider is not dispatchable,
    /// the decision is [`RouteError::RequestedProviderUnavailable`] — NEVER a
    /// silent reroute to another provider.
    pub preferred_provider: Option<String>,
}

impl RouteRequest {
    /// A request with no constraints (selects the highest-priority dispatchable
    /// route).
    pub fn any() -> Self {
        Self::default()
    }
}

/// Why a route could not be selected. Every variant is a hard, fail-closed
/// refusal — the selector NEVER substitutes a different provider than the one a
/// request constrained to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RouteError {
    /// The registry has no routes at all.
    EmptyRegistry,
    /// A specific provider was requested but is not dispatchable (absent, not
    /// available, or not validated). No reroute — this is the no-fallback path.
    RequestedProviderUnavailable(String),
    /// No dispatchable route satisfies the request's constraints.
    NoEligibleRoute {
        required_capabilities: Vec<Capability>,
        model_size: Option<ModelSize>,
    },
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RouteError::EmptyRegistry => write!(f, "no provider routes registered"),
            RouteError::RequestedProviderUnavailable(p) => write!(
                f,
                "requested provider {p} is not available; refusing to reroute (no fallback)"
            ),
            RouteError::NoEligibleRoute {
                required_capabilities,
                model_size,
            } => write!(
                f,
                "no dispatchable route satisfies the request (capabilities={required_capabilities:?}, model_size={model_size:?})"
            ),
        }
    }
}

impl std::error::Error for RouteError {}

/// Select the route for `request` against `registry`. Deterministic and pure.
///
/// Algorithm (every step fail-closed):
/// 1. If the registry is empty → [`RouteError::EmptyRegistry`].
/// 2. Restrict to **dispatchable** routes ([`ProviderRoute::is_dispatchable`]).
/// 3. If a `preferred_provider` is pinned: it must be in the dispatchable set,
///    else [`RouteError::RequestedProviderUnavailable`] (no reroute). It must
///    also satisfy the remaining constraints, else `NoEligibleRoute`.
/// 4. Apply the capability / api / backend / model-size filters (all AND-ed).
/// 5. Pick the deterministic best remaining route, ordered by
///    `(priority, provider_id)`; if none remain → `NoEligibleRoute`.
pub fn select_route<'a>(
    registry: &'a RouteRegistry,
    request: &RouteRequest,
) -> Result<&'a ProviderRoute, RouteError> {
    if registry.is_empty() {
        return Err(RouteError::EmptyRegistry);
    }

    // `map_or(true, ..)` (not `is_none_or`, which is 1.82+; the workspace MSRV is
    // 1.80): an absent constraint is vacuously satisfied.
    let satisfies = |r: &ProviderRoute| -> bool {
        r.supports_all(&request.required_capabilities)
            && request.preferred_api.map_or(true, |a| r.api == a)
            && request
                .preferred_backend
                .map_or(true, |b| r.backend_kind == b)
            && request.model_size.map_or(true, |s| r.model_size == s)
    };

    // A pinned provider is the no-fallback path: it must itself be dispatchable
    // AND satisfy the constraints — we never look at any other provider.
    if let Some(pinned) = &request.preferred_provider {
        let route = registry
            .get(pinned)
            .filter(|r| r.is_dispatchable())
            .ok_or_else(|| RouteError::RequestedProviderUnavailable(pinned.clone()))?;
        if satisfies(route) {
            return Ok(route);
        }
        return Err(RouteError::NoEligibleRoute {
            required_capabilities: request.required_capabilities.clone(),
            model_size: request.model_size,
        });
    }

    // Open selection: the best dispatchable route that satisfies the
    // constraints, by (priority, provider_id). `all()` is already key-sorted, so
    // min_by_key over priority gives a stable, reproducible winner.
    registry
        .all()
        .filter(|r| r.is_dispatchable() && satisfies(r))
        .min_by(|a, b| {
            a.priority
                .cmp(&b.priority)
                .then_with(|| a.provider_id.cmp(&b.provider_id))
        })
        .ok_or_else(|| RouteError::NoEligibleRoute {
            required_capabilities: request.required_capabilities.clone(),
            model_size: request.model_size,
        })
}

/// Maps a selected [`ProviderRoute`] to the live [`AgentLlmClient`] that drives
/// it. The composition root wires the concrete clients (DeepSeek live here);
/// tests inject mocks. Returns `None` when a route has no live client in THIS
/// deployment — a fail-closed gap that the routed loop refuses, never a reroute.
pub trait ProviderClientResolver {
    fn resolve(&self, route: &ProviderRoute) -> Option<&dyn AgentLlmClient>;
}

/// What [`run_routed_loop`] decided before running the loop — surfaced for
/// evidence/telemetry so the chosen provider/model is observable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoutedSelection {
    pub provider_id: String,
    pub model: String,
    pub model_size: ModelSize,
    pub backend_kind: BackendKind,
}

/// Failure modes of [`run_routed_loop`] before/at dispatch. Loop-internal
/// outcomes (Paused/Blocked/etc.) are carried in [`LoopOutcome`], not here.
#[derive(Debug)]
pub enum RoutedLoopError {
    /// Selection failed (see [`RouteError`]) — no client was ever called.
    Route(RouteError),
    /// A route was selected but has no live client wired in this deployment.
    /// Fail-closed: the loop does not run and we do NOT reroute.
    NoClientForProvider(String),
    /// The loop ran and a storage operation failed.
    Storage(StorageError),
}

impl std::fmt::Display for RoutedLoopError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RoutedLoopError::Route(e) => write!(f, "route selection failed: {e}"),
            RoutedLoopError::NoClientForProvider(p) => {
                write!(f, "no live client wired for selected provider {p}")
            }
            RoutedLoopError::Storage(e) => write!(f, "storage error during routed loop: {e}"),
        }
    }
}

impl std::error::Error for RoutedLoopError {}

impl From<RouteError> for RoutedLoopError {
    fn from(e: RouteError) -> Self {
        RoutedLoopError::Route(e)
    }
}

impl From<StorageError> for RoutedLoopError {
    fn from(e: StorageError) -> Self {
        RoutedLoopError::Storage(e)
    }
}

/// Per-conversation provider routing: select the route ONCE for the request,
/// resolve its live client, then run the WHOLE [`run_loop`] on that one provider
/// (so the multi-turn conversation history stays coherent — a single provider
/// owns the whole conversation; mid-conversation provider switching is a
/// deliberately out-of-scope XL concern).
///
/// The selected client feeds the exact same gate-mandatory dispatch as a
/// non-routed loop: routing changes *who proposes* tool calls, never how they
/// are classified or gated. Returns the [`RoutedSelection`] (for evidence)
/// alongside the [`LoopOutcome`].
#[allow(clippy::too_many_arguments)]
pub fn run_routed_loop(
    registry: &RouteRegistry,
    request: &RouteRequest,
    resolver: &dyn ProviderClientResolver,
    executor: &dyn ToolExecutor,
    conn: &Connection,
    run_id: &str,
    task: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    max_turns: u64,
    now_ms: i64,
) -> Result<(RoutedSelection, LoopOutcome), RoutedLoopError> {
    let route = select_route(registry, request)?;
    let selection = RoutedSelection {
        provider_id: route.provider_id.clone(),
        model: route.model.clone(),
        model_size: route.model_size,
        backend_kind: route.backend_kind,
    };
    let client = resolver
        .resolve(route)
        .ok_or_else(|| RoutedLoopError::NoClientForProvider(route.provider_id.clone()))?;

    let outcome = run_loop(
        client, executor, conn, run_id, task, secret, approve, max_turns, now_ms,
    )?;
    Ok((selection, outcome))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentError, AgentStep, ExecError, RawToolCall, ToolReceipt, TurnTrace};
    use friday_storage::{agent_run, Db};
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);

    /// Unique file-backed DB path per call (pid + atomic counter), matching the
    /// crate's other tests — a fixed name would let a prior run's `r1` row
    /// collide on reopen.
    fn tp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-hub-routing-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    /// Open a hub DB and pre-create the agent run row the loop records against.
    fn db_with_run(tag: &str, run_id: &str, task: &str) -> Db {
        let db = Db::open_hub(&tp(tag)).unwrap();
        agent_run::create_run(db.conn(), run_id, task, 1).unwrap();
        db
    }

    fn caps(items: &[Capability]) -> BTreeSet<Capability> {
        items.iter().copied().collect()
    }

    /// A small dispatchable HTTP route with the given id/priority/caps.
    fn route(id: &str, priority: u32, size: ModelSize, cap_list: &[Capability]) -> ProviderRoute {
        ProviderRoute {
            provider_id: id.to_string(),
            api: ProviderApi::OpenAiCompletions,
            backend_kind: BackendKind::Http,
            model: format!("{id}-model"),
            model_size: size,
            capabilities: caps(cap_list),
            available: true,
            validation_ok: true,
            priority,
        }
    }

    // ---- pure selection -----------------------------------------------------

    #[test]
    fn empty_registry_errors() {
        let r = RouteRegistry::new();
        assert_eq!(
            select_route(&r, &RouteRequest::any()).unwrap_err(),
            RouteError::EmptyRegistry
        );
    }

    #[test]
    fn selects_only_available_provider_is_selection_not_fallback() {
        // DeepSeek available; Codex registered but unavailable. With NO preference
        // the single eligible provider is *selected* (allowed) — this is not a
        // reroute, because nothing else was requested.
        let mut r = RouteRegistry::new();
        r.register(route("deepseek", 0, ModelSize::Small, &[Capability::Text]));
        let mut codex = route("codex", 1, ModelSize::Large, &[Capability::Text]);
        codex.available = false;
        codex.validation_ok = false;
        r.register(codex);
        let sel = select_route(&r, &RouteRequest::any()).unwrap();
        assert_eq!(sel.provider_id, "deepseek");
    }

    #[test]
    fn requested_unavailable_provider_errors_with_no_reroute() {
        // Codex is pinned but unavailable; DeepSeek is available. The contract is
        // NO silent reroute — this must error, NOT return deepseek.
        let mut r = RouteRegistry::new();
        r.register(route("deepseek", 0, ModelSize::Small, &[Capability::Text]));
        let mut codex = route("codex", 1, ModelSize::Large, &[Capability::Text]);
        codex.available = false;
        codex.validation_ok = false;
        r.register(codex);
        let req = RouteRequest {
            preferred_provider: Some("codex".to_string()),
            ..RouteRequest::any()
        };
        assert_eq!(
            select_route(&r, &req).unwrap_err(),
            RouteError::RequestedProviderUnavailable("codex".to_string())
        );
    }

    #[test]
    fn pinned_available_provider_is_selected() {
        let mut r = RouteRegistry::new();
        r.register(route("deepseek", 0, ModelSize::Small, &[Capability::Text]));
        r.register(route("other", 1, ModelSize::Small, &[Capability::Text]));
        let req = RouteRequest {
            preferred_provider: Some("other".to_string()),
            ..RouteRequest::any()
        };
        assert_eq!(select_route(&r, &req).unwrap().provider_id, "other");
    }

    #[test]
    fn validation_not_ok_route_is_never_selected() {
        // available but never validated => not dispatchable => fail-closed.
        let mut r = RouteRegistry::new();
        let mut only = route("deepseek", 0, ModelSize::Small, &[Capability::Text]);
        only.validation_ok = false;
        r.register(only);
        assert!(matches!(
            select_route(&r, &RouteRequest::any()).unwrap_err(),
            RouteError::NoEligibleRoute { .. }
        ));
    }

    #[test]
    fn filters_by_required_capability() {
        let mut r = RouteRegistry::new();
        r.register(route("text-only", 0, ModelSize::Small, &[Capability::Text]));
        r.register(route(
            "writer",
            1,
            ModelSize::Small,
            &[Capability::Text, Capability::FileWrite],
        ));
        let req = RouteRequest {
            required_capabilities: vec![Capability::FileWrite],
            ..RouteRequest::any()
        };
        // text-only lacks FileWrite even though it has lower priority — the
        // capability filter excludes it; writer wins.
        assert_eq!(select_route(&r, &req).unwrap().provider_id, "writer");
    }

    #[test]
    fn required_capability_supported_by_none_errors() {
        let mut r = RouteRegistry::new();
        r.register(route("text-only", 0, ModelSize::Small, &[Capability::Text]));
        let req = RouteRequest {
            required_capabilities: vec![Capability::Vision],
            ..RouteRequest::any()
        };
        assert!(matches!(
            select_route(&r, &req).unwrap_err(),
            RouteError::NoEligibleRoute { .. }
        ));
    }

    #[test]
    fn filters_by_model_size() {
        let mut r = RouteRegistry::new();
        r.register(route("flash", 0, ModelSize::Small, &[Capability::Text]));
        r.register(route("pro", 1, ModelSize::Large, &[Capability::Text]));
        let req = RouteRequest {
            model_size: Some(ModelSize::Large),
            ..RouteRequest::any()
        };
        // flash has lower priority but wrong size — size filter picks pro.
        assert_eq!(select_route(&r, &req).unwrap().provider_id, "pro");
    }

    #[test]
    fn filters_by_backend_kind_no_downgrade() {
        // Only an HTTP route exists; a CLI-required request must NOT downgrade to
        // HTTP — it errors.
        let mut r = RouteRegistry::new();
        r.register(route("deepseek", 0, ModelSize::Small, &[Capability::Text]));
        let req = RouteRequest {
            preferred_backend: Some(BackendKind::Cli),
            ..RouteRequest::any()
        };
        assert!(matches!(
            select_route(&r, &req).unwrap_err(),
            RouteError::NoEligibleRoute { .. }
        ));
    }

    #[test]
    fn filters_by_api() {
        let mut r = RouteRegistry::new();
        r.register(route("deepseek", 0, ModelSize::Small, &[Capability::Text]));
        let mut anthropic = route("claude", 1, ModelSize::Large, &[Capability::Text]);
        anthropic.api = ProviderApi::AnthropicMessages;
        r.register(anthropic);
        let req = RouteRequest {
            preferred_api: Some(ProviderApi::AnthropicMessages),
            ..RouteRequest::any()
        };
        assert_eq!(select_route(&r, &req).unwrap().provider_id, "claude");
    }

    #[test]
    fn deterministic_tie_break_by_priority_then_id() {
        // Two equally-eligible routes: lower priority wins.
        let mut r = RouteRegistry::new();
        r.register(route("bbb", 5, ModelSize::Small, &[Capability::Text]));
        r.register(route("aaa", 2, ModelSize::Small, &[Capability::Text]));
        assert_eq!(
            select_route(&r, &RouteRequest::any()).unwrap().provider_id,
            "aaa"
        );

        // Equal priority: lexicographic provider_id breaks the tie, stably.
        let mut r2 = RouteRegistry::new();
        r2.register(route("zzz", 1, ModelSize::Small, &[Capability::Text]));
        r2.register(route("mmm", 1, ModelSize::Small, &[Capability::Text]));
        assert_eq!(
            select_route(&r2, &RouteRequest::any()).unwrap().provider_id,
            "mmm"
        );
    }

    #[test]
    fn autonomous_baseline_routes_to_deepseek_and_refuses_codex() {
        let r = RouteRegistry::autonomous_baseline();
        // Open request → DeepSeek flash (priority 0), the only live provider.
        assert_eq!(
            select_route(&r, &RouteRequest::any()).unwrap().provider_id,
            "deepseek"
        );
        // A large model is still served live by DeepSeek pro.
        let large = RouteRequest {
            model_size: Some(ModelSize::Large),
            ..RouteRequest::any()
        };
        assert_eq!(
            select_route(&r, &large).unwrap().provider_id,
            "deepseek-pro"
        );
        // Pinning Codex (auth-gated here) is refused with no reroute.
        let codex = RouteRequest {
            preferred_provider: Some("codex".to_string()),
            ..RouteRequest::any()
        };
        assert_eq!(
            select_route(&r, &codex).unwrap_err(),
            RouteError::RequestedProviderUnavailable("codex".to_string())
        );
    }

    // ---- routed loop integration -------------------------------------------

    /// A scripted client that emits a fixed first step then `Finish`. Stands in
    /// for ANY provider's client — the point of the trust tests is that the loop
    /// classifies its output identically no matter which provider "routed" to it.
    struct ScriptedRoutedClient {
        first: AgentStep,
        calls: Cell<u64>,
    }
    impl ScriptedRoutedClient {
        fn new(first: AgentStep) -> Self {
            Self {
                first,
                calls: Cell::new(0),
            }
        }
    }
    impl AgentLlmClient for ScriptedRoutedClient {
        fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
            unreachable!("routed loop uses next_step")
        }
        fn next_step(&self, _task: &str, _history: &[TurnTrace]) -> Result<AgentStep, AgentError> {
            let n = self.calls.get();
            self.calls.set(n + 1);
            if n == 0 {
                Ok(self.first.clone())
            } else {
                Ok(AgentStep::Finish {
                    message: "done".to_string(),
                })
            }
        }
    }

    /// A resolver that always returns the same client for the selected route —
    /// modeling "this provider's live client is wired".
    struct FixedResolver<'a> {
        client: &'a dyn AgentLlmClient,
    }
    impl<'a> ProviderClientResolver for FixedResolver<'a> {
        fn resolve(&self, _route: &ProviderRoute) -> Option<&dyn AgentLlmClient> {
            Some(self.client)
        }
    }

    /// A resolver with NO client wired (every provider is a dispatch gap).
    struct EmptyResolver;
    impl ProviderClientResolver for EmptyResolver {
        fn resolve(&self, _route: &ProviderRoute) -> Option<&dyn AgentLlmClient> {
            None
        }
    }

    /// An executor that records whether it was called and what for. Read-only +
    /// write tools "succeed"; anything else is unsupported.
    struct SpyExecutor {
        executed: Cell<u64>,
    }
    impl ToolExecutor for SpyExecutor {
        fn execute(
            &self,
            action: &str,
            _params: &[(String, String)],
        ) -> Result<ToolReceipt, ExecError> {
            self.executed.set(self.executed.get() + 1);
            Ok(ToolReceipt {
                action: action.to_string(),
                summary: format!("ran {action}"),
            })
        }
    }

    fn deepseek_registry() -> RouteRegistry {
        let mut r = RouteRegistry::new();
        r.register(route(
            "deepseek",
            0,
            ModelSize::Small,
            &[
                Capability::Text,
                Capability::FileRead,
                Capability::FileWrite,
            ],
        ));
        r
    }

    #[test]
    fn routed_loop_read_only_allows_and_executes() {
        let db = db_with_run("ro", "run-ro", "read the notes");
        let client = ScriptedRoutedClient::new(AgentStep::Tool(RawToolCall {
            action: "read_file".to_string(),
            params: vec![("path".to_string(), "notes.md".to_string())],
        }));
        let resolver = FixedResolver { client: &client };
        let executor = SpyExecutor {
            executed: Cell::new(0),
        };
        let (selection, outcome) = run_routed_loop(
            &deepseek_registry(),
            &RouteRequest::any(),
            &resolver,
            &executor,
            db.conn(),
            "run-ro",
            "read the notes",
            b"secret-key-0123456789",
            &|_req| None,
            4,
            1_000,
        )
        .expect("routed loop runs");
        assert_eq!(selection.provider_id, "deepseek");
        assert_eq!(outcome.status, crate::LoopStatus::Finished);
        assert_eq!(outcome.executed_tools, 1);
        assert_eq!(executor.executed.get(), 1);
    }

    /// THE trust invariant (advisor #2): a routed, "available/trusted" provider
    /// proposing a destructive tool gets it classified MUTATING and DENIED
    /// without an owner approval — provider availability confers ZERO
    /// classification authority. The executor is NEVER reached.
    #[test]
    fn routed_mutating_tool_is_denied_without_approval_regardless_of_provider() {
        let db = db_with_run("mut", "run-mut", "delete the database");
        let client = ScriptedRoutedClient::new(AgentStep::Tool(RawToolCall {
            action: "delete_file".to_string(),
            params: vec![("path".to_string(), "important.db".to_string())],
        }));
        let resolver = FixedResolver { client: &client };
        let executor = SpyExecutor {
            executed: Cell::new(0),
        };
        let (selection, outcome) = run_routed_loop(
            &deepseek_registry(),
            &RouteRequest::any(),
            &resolver,
            &executor,
            db.conn(),
            "run-mut",
            "delete the database",
            b"secret-key-0123456789",
            &|_req| None, // owner does NOT approve
            4,
            2_000,
        )
        .expect("routed loop runs");
        assert_eq!(selection.provider_id, "deepseek");
        // Mutating + no approval => the loop pauses/blocks; it NEVER executes.
        assert!(
            matches!(
                outcome.status,
                crate::LoopStatus::Paused | crate::LoopStatus::Blocked
            ),
            "expected Paused/Blocked, got {:?}",
            outcome.status
        );
        assert_eq!(outcome.executed_tools, 0);
        assert_eq!(
            executor.executed.get(),
            0,
            "a mutating tool must never reach the executor without approval, regardless of routing"
        );
    }

    /// A selected route with no wired client fails closed — the loop never runs,
    /// and we do NOT reroute to a different provider.
    #[test]
    fn routed_loop_no_client_fails_closed() {
        // No create_run: selection succeeds but the resolver yields no client, so
        // the loop never runs and never touches the DB.
        let db = Db::open_hub(&tp("noclient")).unwrap();
        let executor = SpyExecutor {
            executed: Cell::new(0),
        };
        let err = run_routed_loop(
            &deepseek_registry(),
            &RouteRequest::any(),
            &EmptyResolver,
            &executor,
            db.conn(),
            "run-noclient",
            "do something",
            b"secret-key-0123456789",
            &|_req| None,
            4,
            3_000,
        )
        .unwrap_err();
        assert!(matches!(err, RoutedLoopError::NoClientForProvider(p) if p == "deepseek"));
        assert_eq!(executor.executed.get(), 0);
    }

    /// A pinned-but-unavailable provider never reaches dispatch: selection errors
    /// out before any client/executor is touched (no-fallback at the loop level).
    #[test]
    fn routed_loop_requested_unavailable_never_dispatches() {
        // Selection errors before dispatch — the DB is never written.
        let db = Db::open_hub(&tp("pinned")).unwrap();
        let client = ScriptedRoutedClient::new(AgentStep::Finish {
            message: "unused".to_string(),
        });
        let resolver = FixedResolver { client: &client };
        let executor = SpyExecutor {
            executed: Cell::new(0),
        };
        let req = RouteRequest {
            preferred_provider: Some("codex".to_string()), // not in deepseek_registry
            ..RouteRequest::any()
        };
        let err = run_routed_loop(
            &deepseek_registry(),
            &req,
            &resolver,
            &executor,
            db.conn(),
            "run-pinned",
            "use codex",
            b"secret-key-0123456789",
            &|_req| None,
            4,
            4_000,
        )
        .unwrap_err();
        assert!(matches!(
            err,
            RoutedLoopError::Route(RouteError::RequestedProviderUnavailable(p)) if p == "codex"
        ));
        // No model call, no execution — selection refused before dispatch.
        assert_eq!(client.calls.get(), 0);
        assert_eq!(executor.executed.get(), 0);
    }
}
