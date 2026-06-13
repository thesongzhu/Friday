//! UNW-004 — Hub composition root.
//!
//! Wires the BUILT service graph into ONE composed entry point so the agent loop is
//! callable from a single bootstrap:
//!
//! ```text
//! Db (friday-storage) + RouteRegistry (UNW-003) + live DeepSeek agent client
//!   + FsToolExecutor (friday-fs, gate-mandatory) + Hub secret + ApprovalPolicy
//!   => HubRuntime::run_task(run_id, task)
//!        -> select_route (UNW-003 no-fallback)
//!        -> run_routed_loop -> run_loop (gate-mandatory multi-turn dispatch, #481/#482)
//! ```
//!
//! ## Honest scope (v1 = NO-GO)
//! Only **deepseek-flash** has a live client in this build. The route registry marks
//! `deepseek-pro`/`codex`/`claude` **unavailable**, so a Large or other-provider request
//! honestly resolves to `NoEligibleRoute` — it NEVER silently runs flash-for-pro and never
//! reroutes (the UNW-003 no-fallback contract). Live multi-provider routing stays
//! operator-gated on Codex/Claude login.
//!
//! The owner-approval seam defaults to [`DenyAllApprovals`] (safe): a mutating action
//! **Pauses** (resumable) until the phone-relayed owner-approval leg exists. This withholds
//! the approval *grant* only — the mutating-action gate is ALWAYS evaluated (deny-all does
//! not, and cannot, disable the UNW-001 gate). The gate-approval signing `secret` is
//! Hub-held (production: `friday-crypto::SecureStore`); it is dormant under deny-all.

use std::path::PathBuf;

use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
use friday_core::WorkLane;
use friday_crypto::OperatorVerifyingKey;
use friday_deepseek::{DeepSeekClient, DeepSeekError, Transport, UreqTransport};
use friday_storage::{agent_run, persist_run_result, Db, RunResult, SessionOwner, StorageError};

use crate::hub_server::{project_answer_for_authed, AuthedAnswer, AuthedPrincipal};
use crate::mission_context::MissionContextLookup;
use crate::mission_preflight::MissionAttachmentOutcome;
use crate::mission_runtime::{
    attach_agent_loop_provider_state, resolve_mission_runtime_envelope, MissionRuntimeEnvelope,
    MissionRuntimeOutcome, MissionRuntimeRequest,
};
use crate::routing::{
    run_routed_loop_with_policy, ProviderClientResolver, ProviderRoute, RouteRegistry,
    RouteRequest, RoutedLoopError, RoutedSelection,
};
use crate::{
    run_session_loop, AgentLlmClient, DeepSeekAgentLlmClient, FsToolExecutor, LoopOutcome,
    LoopStatus, RunPolicy,
};

/// S1.3 — the outcome of [`HubRuntime::run_agent_loop_for_mission`], mirroring
/// [`crate::mission_runtime::MissionBoundAskOutcome`] for the agent loop.
#[derive(Debug)]
pub enum MissionBoundLoopOutcome {
    /// The Mission/work-item preflight failed CLOSED — the loop NEVER ran (no `agent_run`
    /// row was created, no model call, no route_decision for an invalid Mission). Mirrors
    /// the ask path's `Blocked`.
    Blocked { blockers: Vec<String> },
    /// The Mission was valid: the composed loop ran and the run was bound to the Mission.
    Ran {
        envelope: Box<MissionRuntimeEnvelope>,
        selection: RoutedSelection,
        outcome: LoopOutcome,
        /// `friday://agent-run/{run_id}` — the run's result link, bound into the Mission
        /// (the run's proof of work on `Finished`).
        result_link: String,
        attachment: MissionAttachmentOutcome,
    },
}

/// The owner-approval seam: given a mutating request, return a signed [`CanonicalApproval`]
/// iff the owner approved THIS exact action. Production default is [`DenyAllApprovals`]
/// until the phone-relayed owner-approval leg is wired (operator-gated).
pub trait ApprovalPolicy {
    fn approve(&self, request: &MutatingActionRequest) -> Option<CanonicalApproval>;
}

/// Safe default: never grants an approval, so every mutating action `Pauses` (resumable).
/// This only WITHHOLDS the grant — the mutating-action gate is still evaluated on every
/// dispatch; deny-all does not disable it.
#[derive(Debug, Default)]
pub struct DenyAllApprovals;

impl ApprovalPolicy for DenyAllApprovals {
    fn approve(&self, _request: &MutatingActionRequest) -> Option<CanonicalApproval> {
        None
    }
}

/// Composition-root configuration.
pub struct HubConfig {
    pub db_path: String,
    pub workspace_root: PathBuf,
    /// Gate-approval signing secret (Hub-held). Dormant under [`DenyAllApprovals`] (no
    /// approval to verify); load-bearing once a granting policy is wired.
    pub secret: Vec<u8>,
    pub max_turns: u64,
    /// The Hub owner whose confirmed memory may be recalled into a task's prompt
    /// (PROOF-MEMORY-001). A Hub is single-owner in v1, so every run inherits this
    /// principal. `None` ⇒ memory recall is DISABLED (fail-closed: no owner, no recall).
    ///
    /// S4: this is ALSO the principal bound into every gate request's `Actor` (and thus
    /// the action digest) for the run — the recall principal and the gate principal are
    /// now the SAME source (they no longer silently diverge). Binding it confers no
    /// approval authority (the run actor stays Agent-kind; it can never self-approve).
    pub principal_id: Option<String>,
    /// S4: tool names DISABLED for every run on this Hub (`disabledToolNames`). A disabled
    /// tool is rejected before it can execute. Empty ⇒ nothing disabled (pre-S4 behavior).
    pub disabled_tools: Vec<String>,
    /// S4: a read-only run constraint (`constraints.readOnly`). When `true`, a mutating
    /// tool is blocked before execution (strictly stricter than the default Pause). `false`
    /// ⇒ pre-S4 behavior.
    pub read_only: bool,
    /// S6d: the operator's PUBLIC Ed25519 verify key — the linchpin. When `Some`, a
    /// protected (mutating) action authorizes against it via the Ed25519 verify-only
    /// policy (NEVER the legacy HMAC authorize), and on Pause the loop persists a
    /// `pending_approval_request` the offline operator can sign + the resume entrypoint
    /// re-executes. When `None` (NO operator key provisioned), the loop is fail-closed:
    /// every mutating action Pauses and is NEVER Allowed.
    ///
    /// This MUST be loaded from an OPERATOR-CONTROLLED source ([`crate::operator_vk`] — a
    /// file the operator wrote from the S6c CLI `keygen`, or a `SecureStore` entry the
    /// operator provisioned). The Hub MUST NOT generate/derive its own keypair here: a
    /// Hub-minted operator key would be full self-mint. [`HubRuntime::live`] resolves it
    /// from the operator-controlled env path; tests provision a test key directly.
    pub operator_vk: Option<OperatorVerifyingKey>,
}

/// Why the live runtime failed to assemble.
#[derive(Debug)]
pub enum HubInitError {
    DeepSeek(DeepSeekError),
    /// S7 — the DARK Claude route gate was ON but its client could not be built
    /// (`FRIDAY_ANTHROPIC_API_KEY` missing/empty, etc.). A CLEAR failure: when the
    /// operator explicitly enables the gate, a missing credential is a hard error, not a
    /// silent degrade. With the gate OFF (the default) this is never reached.
    Claude(friday_anthropic::ClaudeError),
    Storage(StorageError),
    /// S6d: an operator verify key SOURCE was configured (the env path is set) but could
    /// not be read/parsed. A CLEAR failure — a broken provisioning never silently degrades
    /// to "no key" (which would be a different, fail-closed-Pause state). An UNSET source
    /// is NOT an error (it is `operator_vk = None` ⇒ fail-closed Pause).
    OperatorVk(crate::operator_vk::OperatorVkError),
}

impl std::fmt::Display for HubInitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // DeepSeekError's Debug carries no key (verified in friday-deepseek); never prints the secret.
            HubInitError::DeepSeek(e) => write!(f, "deepseek init failed: {e:?}"),
            // ClaudeError's Debug carries no key (status code / kind only; verified by the
            // friday-anthropic leak-lens tests); never prints the secret.
            HubInitError::Claude(e) => write!(f, "claude init failed: {e:?}"),
            HubInitError::Storage(e) => write!(f, "storage init failed: {e}"),
            HubInitError::OperatorVk(e) => {
                write!(f, "operator verify key provisioning failed: {e:?}")
            }
        }
    }
}
impl std::error::Error for HubInitError {}

/// The assembled Hub runtime: a single composed entry (`run_task`) over the built graph.
/// Generic over the DeepSeek transport so tests inject a scripted mock; the live build is
/// [`HubRuntime<UreqTransport>`] via [`HubRuntime::live`].
pub struct HubRuntime<T: Transport> {
    db: Db,
    routes: RouteRegistry,
    deepseek: DeepSeekAgentLlmClient<T>,
    /// S7 — DARK / default-off Claude/Anthropic route client. `None` in every build
    /// EXCEPT a `live()` build whose `FRIDAY_CLAUDE_ROUTE_ENABLED` gate is on. It is a
    /// boxed `dyn AgentLlmClient` (NOT generic over `T`, which is the *DeepSeek*
    /// transport — Claude has its own). Default-off is enforced at two layers: this
    /// field stays `None`, AND the `claude` route is registered `available: false` so
    /// `select_route` never picks it. The DeepSeek path is unchanged.
    claude: Option<Box<dyn AgentLlmClient>>,
    executor: FsToolExecutor,
    /// S6d: the operator's PUBLIC verify key (provisioned from an operator-controlled
    /// source). `None` ⇒ fail-closed (protected actions Pause, never Allow). The Hub holds
    /// ONLY a verify key — never a signing key — so it can verify an operator approval but
    /// never mint one.
    operator_vk: Option<OperatorVerifyingKey>,
    approval: Box<dyn ApprovalPolicy>,
    max_turns: u64,
    /// S4 per-run policy: the bound principal (also the memory-recall owner — ONE source,
    /// see [`HubConfig::principal_id`]) + the run's disabled-tool / read-only restrictions.
    policy: RunPolicy,
}

impl<T: Transport> HubRuntime<T> {
    /// Assemble the runtime from a (possibly mock-transport) DeepSeek client + config +
    /// approval policy. Opens the Hub DB, builds the workspace-root-contained
    /// `FsToolExecutor`, and the dispatchable route registry.
    pub fn new(
        config: HubConfig,
        deepseek: DeepSeekAgentLlmClient<T>,
        approval: Box<dyn ApprovalPolicy>,
    ) -> Result<Self, StorageError> {
        let db = Db::open_hub(&config.db_path)?;
        let executor = FsToolExecutor::new(config.workspace_root);
        let routes = Self::dispatchable_routes();
        // S4: ONE policy carries the run's principal (also the recall owner) + restrictions.
        let policy = RunPolicy::new(config.principal_id, config.disabled_tools, config.read_only);
        Ok(Self {
            db,
            routes,
            deepseek,
            // S7: DARK — no Claude client by default. Only `live()` may populate this,
            // and only when the default-OFF `FRIDAY_CLAUDE_ROUTE_ENABLED` gate is on
            // (via [`Self::with_claude`]). Tests + the prod default leave it `None`.
            claude: None,
            executor,
            operator_vk: config.operator_vk,
            approval,
            max_turns: config.max_turns,
            policy,
        })
    }

    /// S7 — attach the DARK Claude route client (builder, default-off). This is the
    /// ONLY way the `claude` field becomes `Some`. It does NOT touch the DeepSeek path,
    /// the route registry, or any default; selecting Claude still additionally requires
    /// a dispatchable `claude` route (the autonomous baseline marks it `available: false`).
    /// Consumes + returns `self` so `live()` can chain it behind the env gate.
    pub fn with_claude(mut self, claude: Box<dyn AgentLlmClient>) -> Self {
        self.claude = Some(claude);
        self
    }

    /// The route registry reflecting THIS build's ACTUAL dispatch capability: only the live
    /// `deepseek` (flash) route is available; `deepseek-pro`/`codex`/`claude` are marked
    /// unavailable so a Large/other request honestly `NoEligibleRoute`s. The single live
    /// client always `select_model`→flash, so marking pro unavailable prevents silently
    /// running flash for a pro request (no hidden downgrade).
    fn dispatchable_routes() -> RouteRegistry {
        let mut r = RouteRegistry::autonomous_baseline();
        if let Some(pro) = r.get("deepseek-pro").cloned() {
            r.register(ProviderRoute {
                available: false,
                validation_ok: false,
                ..pro
            });
        }
        r
    }

    /// (C2) Promote a route to `available: true` in THIS runtime's IN-PROCESS registry only
    /// (never the autonomous baseline, which stays `available: false`). This is the gated,
    /// per-runtime half of making the DARK Claude route selectable: it is called ONLY behind
    /// the default-OFF `FRIDAY_CLAUDE_ROUTE_ENABLED` gate (see
    /// [`Self::maybe_attach_claude_from_env`]). It leaves `validation_ok` untouched, so the
    /// route is STILL not dispatchable until [`Self::validate_and_enable_claude`] flips that
    /// (via the live key probe). A no-op if the route is absent.
    fn mark_route_available(&mut self, provider_id: &str) {
        if let Some(r) = self.routes.get(provider_id).cloned() {
            self.routes.register(ProviderRoute {
                available: true,
                ..r
            });
        }
    }

    /// (C2) Mark a route `validation_ok: true` in THIS runtime's IN-PROCESS registry only
    /// (mirrors [`Self::mark_route_available`]). Set ONLY after the live key probe returns
    /// `Valid` — see [`Self::validate_and_enable_claude`] — so a gated boot that never runs
    /// the probe leaves the route fail-closed (non-dispatchable). A no-op if absent.
    fn mark_route_validated(&mut self, provider_id: &str) {
        if let Some(r) = self.routes.get(provider_id).cloned() {
            self.routes.register(ProviderRoute {
                validation_ok: true,
                ..r
            });
        }
    }

    /// (C2) Validate the wired Claude key ONCE via the EXISTING R7 live probe and, ONLY on a
    /// `Valid` result, mark the in-process `claude` route `validation_ok: true` (dispatchable).
    ///
    /// This is an EXPLICIT, operator/harness-invoked one-shot — it is NEVER called at boot (so a
    /// gated `HubRuntime::live` construction spends ZERO Anthropic quota and never hangs on a
    /// network probe). It spends a tiny quota (one `max_tokens=1` chat) WHEN CALLED. With no key
    /// the probe returns [`friday_providers::KeyValidationOutcome::CredentialMissing`] ⇒
    /// `validation_ok` stays false ⇒ the route stays non-dispatchable (fail-closed); nothing is
    /// written. The outcome is returned so the caller can surface CredentialMissing / Invalid /
    /// Unavailable. THIS `.validate()` is the single residual that needs the live key.
    pub fn validate_and_enable_claude(&mut self) -> friday_providers::KeyValidationOutcome {
        use crate::provider_key_validation::LiveKeyValidationProbe;
        use friday_providers::{KeyProvider, KeyValidationOutcome, KeyValidationProbe};
        let outcome = LiveKeyValidationProbe::new().validate(KeyProvider::Anthropic);
        if matches!(outcome, KeyValidationOutcome::Valid) {
            self.mark_route_validated("claude");
        }
        outcome
    }

    /// Drive ONE task end-to-end through the composed graph: create the run row, select the
    /// provider route (UNW-003), then run the gate-mandatory multi-turn loop (#481/#482).
    /// `run_id` must be unique per task. Returns the routing selection (evidence) + outcome.
    pub fn run_task(
        &self,
        run_id: &str,
        task: &str,
        now_ms: i64,
    ) -> Result<(RoutedSelection, LoopOutcome), RoutedLoopError> {
        // Pre-A1 entry: NO per-run override ⇒ the run uses the runtime's boot `self.policy` +
        // `self.max_turns`. BYTE-IDENTICAL to the pre-A1 behavior (every existing caller — dev
        // bins, tests, the mission-bound entry — stays on this path unchanged).
        self.run_task_with_overrides(run_id, task, None, None, now_ms)
    }

    /// (A1) [`Self::run_task`] with an OPTIONAL per-run policy + max-turns override applied at
    /// run-START. This is the live-dispatch entry the WS server uses to APPLY a peer's
    /// [`friday_protocol::AgentRunConstraintsWire`] (read-only / disabled-tools / max-turns) onto
    /// the gate the loop consults — closing the A1 deferral.
    ///
    /// ## The override semantics (only-tighten, fail-safe)
    ///   - `policy_override: None` ⇒ the run uses the boot `self.policy` VERBATIM (the
    ///     `run_task` path) — byte-identical pre-A1 behavior. The dispatch arm passes `None`
    ///     precisely when the request carried NO `constraints` block.
    ///   - `policy_override: Some(p)` ⇒ the run uses `p`, which the caller MUST have built by
    ///     COMPOSING the boot policy with the constraint
    ///     ([`crate::agent_run_control::effective_run_policy_over`]) so it can only ever TIGHTEN.
    ///     The override REPLACES `self.policy` for THIS run's gate requests AND the owner-stamp —
    ///     so this fn is internally consistent on ONE policy object (`p.principal_id()` is the
    ///     stamped owner, which `effective_run_policy_over` preserves verbatim from boot, so the
    ///     owner is UNCHANGED by any constraint).
    ///   - `max_turns_override: None` ⇒ `self.max_turns`. `Some(cap)` ⇒ `self.max_turns.min(cap)`
    ///     (a cap can only LOWER the ceiling, never raise it past the runtime default — the floor
    ///     is applied HERE so a caller can pass the raw asserted cap).
    pub fn run_task_with_overrides(
        &self,
        run_id: &str,
        task: &str,
        policy_override: Option<&RunPolicy>,
        max_turns_override: Option<u64>,
        now_ms: i64,
    ) -> Result<(RoutedSelection, LoopOutcome), RoutedLoopError> {
        // BYTE-IDENTICAL to the pre-C2 body: a constraint-free `RouteRequest::any()` request
        // (selects the highest-priority dispatchable route = deepseek-flash). The ONLY thing
        // (C2) `run_task_pinned` varies is this request; everything else (create-run, recall,
        // routed loop, owner-wiring persist tail) is the SHARED `run_with_request` body.
        self.run_with_request(
            run_id,
            task,
            &RouteRequest::any(),
            policy_override,
            max_turns_override,
            now_ms,
        )
    }

    /// (C2) Pin a SPECIFIC provider for THIS run (no-fallback). Builds a pinned
    /// [`RouteRequest`] and drives the SAME composed loop as [`Self::run_task`] via the shared
    /// [`Self::run_with_request`] body. A non-dispatchable pin (e.g. `claude` while DARK)
    /// surfaces [`RoutedLoopError::Route`]`(`[`RouteError::RequestedProviderUnavailable`]`)` —
    /// NEVER a silent reroute. The DEFAULT path ([`Self::run_task`] /
    /// [`Self::run_task_with_overrides`]) is UNCHANGED (their request is `RouteRequest::any()`).
    /// This is the harness/operator entry the C2 routed-parity capture uses to drive the Claude
    /// leg; it takes no per-run policy/max-turns override (the boot config applies).
    pub fn run_task_pinned(
        &self,
        run_id: &str,
        task: &str,
        provider_id: &str,
        now_ms: i64,
    ) -> Result<(RoutedSelection, LoopOutcome), RoutedLoopError> {
        let request = RouteRequest {
            preferred_provider: Some(provider_id.to_string()),
            ..RouteRequest::any()
        };
        self.run_with_request(run_id, task, &request, None, None, now_ms)
    }

    /// (C2) The SHARED composed-loop body for [`Self::run_task_with_overrides`] (open request)
    /// and [`Self::run_task_pinned`] (provider-pinned request). Factored out so there is ONE
    /// composed loop — the ONLY variable between the two entries is `request`. The default path
    /// remains byte-identical: `run_task_with_overrides` calls this with `&RouteRequest::any()`.
    fn run_with_request(
        &self,
        run_id: &str,
        task: &str,
        request: &RouteRequest,
        policy_override: Option<&RunPolicy>,
        max_turns_override: Option<u64>,
        now_ms: i64,
    ) -> Result<(RoutedSelection, LoopOutcome), RoutedLoopError> {
        // The effective per-run policy + ceiling. Absent override ⇒ boot config unchanged.
        let policy = policy_override.unwrap_or(&self.policy);
        let max_turns = match max_turns_override {
            Some(cap) => self.max_turns.min(cap),
            None => self.max_turns,
        };
        agent_run::create_run(self.db.conn(), run_id, task, now_ms)?;
        // PROOF-MEMORY-001: recall this owner's confirmed memory, gate it through the
        // Context Passport, and inject it as a prompt PREAMBLE (the run's `task` stays
        // clean — the preamble is added only to what the model sees). `None` principal ⇒
        // no recall. Records a hash-chained `memory.recalled` audit receipt.
        let recall_preamble = self.recall_preamble(run_id, now_ms)?;
        // The routing request is supplied by the caller: `RouteRequest::any()` for the default
        // entries (selects the highest-priority dispatchable route = deepseek-flash, the only
        // live one), or a provider-pin for `run_task_pinned` (C2). Deriving required
        // capabilities / model-size from the task is a later refinement.
        let approve = |req: &MutatingActionRequest| self.approval.approve(req);
        // S4: thread the (effective) run policy so the bound principal reaches every gate
        // request's Actor (and the action digest) and the disabled/read-only restrictions are
        // enforced before any tool executes. S6d: thread the provisioned operator verify
        // key so a protected action authorizes via the Ed25519 verify-only policy (never
        // HMAC); `None` ⇒ fail-closed Pause.
        let (selection, outcome) = run_routed_loop_with_policy(
            &self.routes,
            request,
            self,
            &self.executor,
            self.db.conn(),
            run_id,
            task,
            &recall_preamble,
            self.operator_vk.as_ref(),
            &approve,
            policy,
            max_turns,
            now_ms,
        )?;

        // D1 OWNER-WIRING: a FINISHED run produced a deliverable ANSWER; persist it Hub-side
        // keyed by `run_id` with the run's BOUND OWNER principal recorded
        // (`policy.principal_id()` — the SAME principal S4 binds into the gate Actor; the
        // override preserves boot's principal verbatim, so this is the configured owner), so
        // the authenticated body projection [`friday_storage::get_run_answer_for_principal`]
        // releases the answer body ONLY to that owner. A run with NO bound principal records
        // NO owner ⇒ the body stays unreadable to everyone (fail-closed, correct).
        //
        // We persist ONLY on `Finished`: a `Paused` run's `run_result` slot belongs to the
        // resume completion leg ([`crate::resume`]), and persisting an empty answer here would
        // collide with that later immutable `mutation_completed` result; `Errored`/`Bounded`/
        // `Blocked` carry no deliverable answer. A fresh `run_id` cannot already hold a
        // result, so a persist conflict here would signal a real bug and is propagated.
        if outcome.status == LoopStatus::Finished {
            let mut result = RunResult::new(
                "finished",
                outcome.final_message.clone().unwrap_or_default(),
                None,
            );
            if let Some(principal) = policy.principal_id() {
                result = result.with_owner_principal(principal);
            }
            persist_run_result(self.db.conn(), run_id, &result, now_ms)?;
        }

        Ok((selection, outcome))
    }

    /// (A2a Phase 1) The SESSIONED authenticated agent-loop entry — the read-only chat
    /// parity of [`run_authed_agent_loop`](crate::hub_server::run_authed_agent_loop) for a
    /// MULTI-TURN session. It drives the EXISTING, already-verified
    /// [`run_session_loop`] (no new loop code) so a run reloads its session history and
    /// appends this turn, then projects the answer body owner-gated EXACTLY as the
    /// sessionless entry does. The dispatch arm calls this ONLY when the client carried a
    /// non-empty `session_id`; a sessionless run stays on [`run_authed_agent_loop`]
    /// unchanged (byte-identical).
    ///
    /// ## Owner-scoping (INV-5/INV-7 — the load-bearing security property)
    /// The session OWNER is the AUTHENTICATED forwarded principal (`caller`, produced ONLY
    /// by [`AuthedPrincipal::authenticate_forwarded`] against the owner allowlist), NEVER
    /// the client-asserted `session_id`. We bind `SessionOwner { user_id:
    /// caller.principal(), .. }` at session creation, and the body is released via
    /// [`project_answer_for_authed`] to that SAME authenticated `caller` — so a peer can
    /// never read another owner's session history/body by guessing a `session_id`. Single-
    /// owner v1: the runtime's `self.policy.principal_id()` is the SAME configured owner the
    /// allowlist admits, so `run_session_loop`'s owner-wiring records `owner == caller` and
    /// the body is releasable to them. If they ever diverged (a multi-entry allowlist, NOT
    /// v1), `project_answer_for_authed` would DENY → fail-closed (the body stays withheld),
    /// which is the correct safe behavior, not a leak.
    ///
    /// SAFE FAILURE: a storage failure (the session loop's `Err`) OR a non-Finished run
    /// returns a body-free [`AuthedAnswer::NoAnswer`] — no panic, no partial/false success
    /// — mirroring [`run_authed_agent_loop`]. The body, when delivered, is carried ONLY in
    /// [`AuthedAnswer::Delivered`] for in-process hand-off to the authed owner; it is NEVER
    /// placed on a refs surface and NEVER logged.
    ///
    /// Recall: like [`Self::run_task`], the run still folds this owner's confirmed-memory
    /// recall preamble (keyed by `self.policy.principal_id()`) AHEAD of the session history
    /// — consistent with the sessionless entry; the session loop adds prior-turn history on
    /// top, it does not replace recall.
    ///
    /// Truth label: DARK Phase 1 (read-only sessioned chat). Reachable only when the WS
    /// server's dispatch arm branches on a client `session_id`; live only at DEPLOY GO.
    /// Read-only sessioned chat on Rust is an HONEST PARTIAL — it is NOT GATE-AGENT-REPLACE.
    pub fn run_session_task(
        &self,
        caller: &AuthedPrincipal,
        run_id: &str,
        session_id: &str,
        task: &str,
        now_ms: i64,
    ) -> AuthedAnswer {
        // Pre-A1 sessioned entry: NO per-run override ⇒ boot policy + ceiling (byte-identical).
        self.run_session_task_with_overrides(caller, run_id, session_id, task, None, None, now_ms)
    }

    /// (A1) [`Self::run_session_task`] with an OPTIONAL per-run policy + max-turns override —
    /// the SESSIONED parity of [`Self::run_task_with_overrides`]. Same only-tighten semantics:
    /// `None` ⇒ boot `self.policy`/`self.max_turns` verbatim (the `run_session_task` path);
    /// `Some(p)` ⇒ the COMPOSED (only-tighten) per-run policy the dispatch arm built. The
    /// override drives the SAME existing [`run_session_loop`] (no new loop code) — read-only /
    /// disabled-tools are enforced by the loop's gate exactly as the sessionless entry, and a
    /// constraint can never re-bind the session owner (`p`'s principal == boot's, the
    /// authenticated `caller`).
    #[allow(clippy::too_many_arguments)]
    pub fn run_session_task_with_overrides(
        &self,
        caller: &AuthedPrincipal,
        run_id: &str,
        session_id: &str,
        task: &str,
        policy_override: Option<&RunPolicy>,
        max_turns_override: Option<u64>,
        now_ms: i64,
    ) -> AuthedAnswer {
        // The effective per-run policy + ceiling. Absent override ⇒ boot config unchanged.
        let policy = policy_override.unwrap_or(&self.policy);
        let max_turns = match max_turns_override {
            Some(cap) => self.max_turns.min(cap),
            None => self.max_turns,
        };
        // Create the run row FIRST — `run_session_loop` only `ensure_session`s the session
        // row; it does NOT create the `agent_run` row (its step-5 `persist_run_result`
        // would orphan without one). `run_task` does this too. A create failure is a SAFE
        // FAILURE (body-free NoAnswer; no panic, no partial body).
        if agent_run::create_run(self.db.conn(), run_id, task, now_ms).is_err() {
            return AuthedAnswer::NoAnswer {
                run_id: run_id.to_string(),
            };
        }

        // Owner-scoping: bind the session's owner to the AUTHENTICATED caller principal —
        // NEVER the client-asserted `session_id` (INV-5/INV-7). The `user_id` axis is what
        // the memory namespace + owner-wiring derive from.
        let owner = SessionOwner {
            user_id: Some(caller.principal().to_string()),
            ..SessionOwner::default()
        };

        // The owner's confirmed-memory recall preamble (same source as `run_task`). A recall
        // failure is a SAFE FAILURE (body-free NoAnswer) — never a panic.
        let recall_preamble = match self.recall_preamble(run_id, now_ms) {
            Ok(p) => p,
            Err(_) => {
                return AuthedAnswer::NoAnswer {
                    run_id: run_id.to_string(),
                };
            }
        };

        // Drive the EXISTING session loop AS the bound owner: it ensures the OWNED session,
        // loads + folds prior history, runs the SAME gate-mandatory loop (read-only stays
        // gate-enforced; a mutating tool would Pause — Phase 1 admits none), appends this
        // turn, and owner-wires a Finished answer's `run_result`. NO new loop code.
        let approve = |req: &MutatingActionRequest| self.approval.approve(req);
        let outcome = match run_session_loop(
            &self.deepseek,
            &self.executor,
            self.db.conn(),
            run_id,
            session_id,
            Some(&owner),
            task,
            &recall_preamble,
            self.operator_vk.as_ref(),
            &approve,
            policy,
            max_turns,
            now_ms,
        ) {
            Ok(outcome) => outcome,
            // A storage failure is a SAFE FAILURE: body-free NoAnswer (mirrors the
            // sessionless entry's route/provider-failure handling). No panic, no partial.
            Err(_) => {
                return AuthedAnswer::NoAnswer {
                    run_id: run_id.to_string(),
                };
            }
        };

        // Release the body ONLY to the authenticated owner (the SAME owner-gated projection
        // the sessionless entry uses), then attach the loop's COUNTS to a Delivered answer
        // (a no-op on Denied/NoAnswer). This is byte-shared with `run_authed_agent_loop`'s
        // tail, so the only difference between the two dispatch arms is which loop ran. Token
        // counts stay `None` (DEFERRED — billed to the Rust token_ledger, not on LoopOutcome).
        project_answer_for_authed(self.db.conn(), run_id, caller)
            .with_counts(outcome.turns, outcome.executed_tools)
    }

    /// S1.3 — the Mission-BOUND agent-loop entry (the `executeRun` Mission-context parity,
    /// deferred from S1.2). Mirrors [`crate::mission_runtime::ask_friday_for_mission`]'s
    /// preflight for the loop:
    ///
    /// 1. Resolve + validate the Mission/work-item envelope FAIL-CLOSED. An invalid/unknown
    ///    Mission or work-item (wrong lane/target, terminal, missing context) → `Blocked`,
    ///    and the loop NEVER runs — no `agent_run` row is created, no model is called, and no
    ///    route_decision is persisted for the invalid Mission (the resolve step returns
    ///    before `run_task` and before its own `upsert_route_decision`).
    /// 2. Run the SAME composed loop as [`Self::run_task`] (create run → memory recall →
    ///    routed gate-mandatory loop). Reusing `run_task` keeps the unbound dev bridge and
    ///    the Mission-bound path on ONE loop — no divergence.
    /// 3. Record the run's Mission binding (a `MissionLink` tying THIS run to the Mission)
    ///    via the SAME provider-timeline attachment the ask path uses, so the run's
    ///    result/billing/approval tie to that Mission.
    ///
    /// Lane choice (auditable): the agent loop is a Hub-orchestrated run that routes to
    /// DeepSeek (the only live provider in this build), so the envelope is validated against
    /// `WorkLane::DeepSeek` + target `deepseek` — the SAME lane/target the single-shot ask
    /// path uses. A future multi-provider loop would generalize `expected_target`; a "pure
    /// Hub orchestration" model would instead use `WorkLane::FridayHub` + no target.
    ///
    /// The S1.2 result/ledger/audit + S6 approval flows are UNCHANGED — this only BINDS the
    /// run to a Mission. [`Self::run_task`] (the unbound entry) is left working untouched.
    pub fn run_agent_loop_for_mission(
        &self,
        mission_lookup: MissionContextLookup,
        session_id: &str,
        run_id: &str,
        task: &str,
        now_ms: i64,
    ) -> Result<MissionBoundLoopOutcome, RoutedLoopError> {
        // PREFLIGHT (fail-closed): validate the Mission/work-item BEFORE any run exists. On
        // Blocked we return without ever calling `run_task`, so no `agent_run` row and no
        // model call happen for an invalid Mission — mirroring the ask path's preflight.
        let envelope = match resolve_mission_runtime_envelope(
            &self.db,
            MissionRuntimeRequest {
                lookup: mission_lookup,
                expected_lane: WorkLane::DeepSeek,
                expected_target: Some("deepseek".to_string()),
                decision_id: format!("route-decision:agent-loop:{run_id}"),
                trace_refs: vec![
                    format!("agent-run:{run_id}"),
                    format!("friday://agent-run/{run_id}"),
                ],
                now_ms,
                expires_at_ms: None,
            },
        )? {
            MissionRuntimeOutcome::Ready(envelope) => envelope,
            MissionRuntimeOutcome::Blocked { blockers } => {
                return Ok(MissionBoundLoopOutcome::Blocked { blockers });
            }
        };

        // Run the SAME composed loop as the unbound entry (no divergence).
        let (selection, outcome) = self.run_task(run_id, task, now_ms)?;

        // Bind the run to the Mission via the ask path's provider-timeline attachment.
        // Truth-honest: complete the WorkItem with the run as proof ONLY when the loop
        // Finished; otherwise bind at RoutedToProvider without over-claiming completion.
        let completed = outcome.status == LoopStatus::Finished;
        let result_link = format!("friday://agent-run/{run_id}");
        let attachment = attach_agent_loop_provider_state(
            &self.db,
            &envelope.context.mission_id,
            &envelope.context.work_item_id,
            session_id,
            run_id,
            completed,
            &result_link,
            now_ms,
        )?;

        Ok(MissionBoundLoopOutcome::Ran {
            envelope,
            selection,
            outcome,
            result_link,
            attachment,
        })
    }

    /// Build the memory-recall prompt preamble for this run and record its receipt.
    ///
    /// Pipeline: [`recall_confirmed`] (same-principal + Confirmed + content-bearing, SQL
    /// layer) → [`cognition::rank_recall`] (recency-decay + top-k + PII redaction) →
    /// [`cognition::gate_and_render_recall`] (the per-item Context Passport gate — a
    /// `sensitive` memory drops itself under v1 deny-all). When anything was recalled, a
    /// hash-chained `memory.recalled` audit event records the `recalled/injected/gated`
    /// counts and the injected `memory_id`s (the recall→answer receipt; the
    /// answer-carries-marker proof is the separate live e2e). `None` principal ⇒ empty
    /// preamble, no recall.
    ///
    /// SCOPE: this records the audit RECEIPT; it does NOT ledger tokens — the recall step
    /// itself spends no model call, so no token-accounting claim is made here. (The loop's
    /// per-turn MODEL calls ARE ledgered as of S1.2 by `run_loop` via `bill_model_call`.)
    fn recall_preamble(&self, run_id: &str, now_ms: i64) -> Result<String, RoutedLoopError> {
        // Delegates to the SHARED recall composition so the loop and the `friday_ask`
        // surface apply the identical per-item Passport gate (no divergence). As of S4 the
        // recall principal and the gate Actor's principal are the SAME source
        // (`self.policy.principal_id()`) — they can no longer silently diverge.
        let preamble = crate::recall_preamble_for(
            &self.db,
            self.policy.principal_id(),
            &format!("{run_id}:memory-recall"),
            now_ms,
        )?;
        Ok(preamble)
    }

    /// Read access to the composed DB (for evidence/inspection: agent_run events, audit chain).
    pub fn db(&self) -> &Db {
        &self.db
    }

    /// (A1 run-controls) The composed `FsToolExecutor` (workspace-root-contained, gate-mandatory).
    /// Exposed so the sealed-WS server's RESUME control handler can delegate to the S6
    /// [`crate::resume::resume_with_approval`] spine (which executes the ONE approved mutation
    /// through this executor). It is the SAME executor the live loop uses — no separate/forked
    /// executor for control ops. ADDITIVE, read-only accessor: no live behavior change.
    pub fn executor(&self) -> &FsToolExecutor {
        &self.executor
    }

    /// (A1 run-controls) The operator's PUBLIC verify key, if provisioned. Exposed so the RESUME
    /// control handler can verify an operator-signed approval (the Hub holds only a VERIFY key —
    /// it can never mint one). `None` ⇒ fail-closed (resume cannot verify, so nothing is Allowed).
    /// ADDITIVE, read-only accessor: no live behavior change.
    pub fn operator_vk(&self) -> Option<&OperatorVerifyingKey> {
        self.operator_vk.as_ref()
    }

    /// FIX-Q2 (hardening) — the run-owner principal this runtime is CONFIGURED with (the
    /// `--owner` allowlist's single entry, threaded via [`HubConfig::principal_id`] into the
    /// [`RunPolicy`]). This is the principal `run_task` stamps as the run's owner, recalls
    /// memory for, binds into the gate Actor, and bills. `None` ⇒ no owner configured.
    ///
    /// Exposed `pub(crate)` ONLY so the live exec entry ([`crate::run_authed_agent_loop`]) can
    /// assert `authenticated_caller == configured_owner` BEFORE dispatch — turning the
    /// single-owner doc convention ("the runtime MUST be configured with the SAME principal as
    /// `caller`") into a code invariant. It is NOT a wire/proof surface (a principal id is an
    /// identity, not a secret, but it is never logged/printed by this accessor's callers).
    pub(crate) fn configured_principal(&self) -> Option<&str> {
        self.policy.principal_id()
    }

    /// (A1) The runtime's BOOT [`RunPolicy`] (the `--owner` principal + boot disabled-tools /
    /// read-only, built ONCE at [`HubRuntime::live`]). Exposed so the WS dispatch arm can COMPOSE
    /// a peer's per-run constraints ONTO it ([`crate::agent_run_control::effective_run_policy_over`])
    /// — the override can only ever TIGHTEN this boot policy, never loosen it. Read-only accessor;
    /// it returns the SAME object the no-override `run_task` path uses, so an absent-constraint
    /// run composed off this is byte-equivalent to the boot path.
    pub fn policy(&self) -> &RunPolicy {
        &self.policy
    }

    /// (A1) The runtime's BOOT `max_turns` ceiling. A per-run cap can only LOWER this (never
    /// raise it past the runtime default); the floor is applied inside the run entries.
    pub fn max_turns(&self) -> u64 {
        self.max_turns
    }
}

impl HubRuntime<UreqTransport> {
    /// Assemble the LIVE runtime: the real DeepSeek client from the env key
    /// (`DeepSeekClient::from_env`, never logs the key) + deny-all approval (safe default).
    /// This is the bootstrap the live e2e proof drives.
    ///
    /// S6d: if the caller did not pre-provision `config.operator_vk`, resolve it from the
    /// OPERATOR-CONTROLLED env path ([`crate::operator_vk::provision_operator_vk_from_env`]):
    /// UNSET ⇒ `None` (fail-closed Pause for protected actions); SET-but-broken ⇒ a hard
    /// [`HubInitError::OperatorVk`]. The Hub NEVER generates its own operator key here — it
    /// only loads operator-supplied bytes — so a Hub-minted self-approval is impossible.
    pub fn live(mut config: HubConfig) -> Result<Self, HubInitError> {
        if config.operator_vk.is_none() {
            config.operator_vk = crate::operator_vk::provision_operator_vk_from_env()
                .map_err(HubInitError::OperatorVk)?;
        }
        let client = DeepSeekClient::from_env().map_err(HubInitError::DeepSeek)?;
        let agent = DeepSeekAgentLlmClient::new(client);
        let runtime =
            Self::new(config, agent, Box::new(DenyAllApprovals)).map_err(HubInitError::Storage)?;
        // S7 — DARK Claude route: wire the second-provider client ONLY when the
        // operator explicitly opts in via the default-OFF env gate. Absent/empty/any
        // non-`"1"` value ⇒ the gate is OFF and the Claude client is never constructed
        // (so its `FRIDAY_ANTHROPIC_API_KEY` is never even read) — prod default behavior
        // is UNCHANGED. Even when the gate is on, the `claude` route is still
        // `available: false` in the autonomous baseline, so this only PRE-WIRES the
        // client for a later live proof; it does not by itself make Claude selectable.
        runtime.maybe_attach_claude_from_env()
    }

    /// S7 — read the default-OFF gate and, only when it is on, build the live Claude
    /// client from its env key and attach it (DARK). Separated from `live()` so the
    /// gate/credential logic is unit-testable. A missing/empty gate ⇒ OFF ⇒ unchanged.
    fn maybe_attach_claude_from_env(self) -> Result<Self, HubInitError> {
        if !claude_route_enabled_from_env() {
            return Ok(self);
        }
        // Gate is ON: build the real Claude client (fails closed if the key is absent)
        // and pin the route's model id.
        let client = friday_anthropic::ClaudeClient::from_env().map_err(HubInitError::Claude)?;
        let agent = crate::ClaudeAgentLlmClient::new(client, friday_anthropic::DEFAULT_MODEL);
        let mut me = self.with_claude(Box::new(agent));
        // (C2) Promote the claude route to `available: true` in THIS runtime's IN-PROCESS
        // registry ONLY (the autonomous baseline stays `available: false` — prod default
        // unchanged). This is gated-only: reached solely because the default-OFF
        // `FRIDAY_CLAUDE_ROUTE_ENABLED` gate is on. `validation_ok` STAYS false here, so the
        // route is still NOT dispatchable until `validate_and_enable_claude()` runs the live
        // key probe — a gated boot spends no Anthropic quota.
        me.mark_route_available("claude");
        Ok(me)
    }
}

/// S7 — the default-OFF environment gate that governs whether [`HubRuntime::live`]
/// wires the DARK Claude route. ON only when `FRIDAY_CLAUDE_ROUTE_ENABLED` is exactly
/// `"1"` (after trimming). UNSET / empty / `"0"` / any other value ⇒ OFF (unchanged
/// prod default). Kept narrow + explicit so the dark path cannot be enabled by accident.
pub const ENV_CLAUDE_ROUTE_ENABLED: &str = "FRIDAY_CLAUDE_ROUTE_ENABLED";

fn claude_route_enabled_from_env() -> bool {
    matches!(std::env::var(ENV_CLAUDE_ROUTE_ENABLED), Ok(v) if v.trim() == "1")
}

impl<T: Transport> ProviderClientResolver for HubRuntime<T> {
    /// The live `deepseek` provider always has a wired client. The `claude` provider has
    /// one ONLY when the DARK route was enabled (`self.claude` is `Some` — see
    /// [`HubRuntime::with_claude`] / [`HubRuntime::live`]'s `FRIDAY_CLAUDE_ROUTE_ENABLED`
    /// gate); when disabled (the default) it returns `None`. Any other route returns
    /// `None` → fail-closed `NoClientForProvider` (a defensive backstop; the route
    /// registry already prevents selecting unavailable providers — `claude` is
    /// `available: false` in the baseline — so this never fires on the happy path).
    /// Routing decides WHO answers; classification stays the trusted chokepoint
    /// regardless — this resolver confers no classification authority.
    fn resolve(&self, route: &ProviderRoute) -> Option<&dyn AgentLlmClient> {
        match route.provider_id.as_str() {
            "deepseek" => Some(&self.deepseek),
            // DARK: `as_deref()` yields `None` whenever the Claude client was not wired
            // (the default), so the default-off route fail-closes exactly like any
            // other unwired provider.
            "claude" => self.claude.as_deref(),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::RouteError;
    use crate::{mint_approval, AgentStep, LoopStatus};
    use friday_deepseek::DeepSeekError;
    use serde_json::Value;
    use std::cell::Cell;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-hub-runtime-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "friday-hub-rt-ws-{}-{}-{}",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Scripted DeepSeek transport: GET /models → one flash model; POST /chat → the next
    /// scripted assistant `content` (a tool-call JSON the strict parser reads). Counts POST
    /// calls so the no-hidden-call invariant is checkable.
    struct ScriptTransport {
        contents: Vec<String>,
        // Shared so a test can assert the real chat/POST count == loop turns (no hidden call).
        post_calls: Rc<Cell<usize>>,
    }
    impl ScriptTransport {
        fn new(contents: &[&str]) -> Self {
            Self {
                contents: contents.iter().map(|s| s.to_string()).collect(),
                post_calls: Rc::new(Cell::new(0)),
            }
        }
    }
    impl Transport for ScriptTransport {
        fn get_json(&self, _url: &str, _bearer: &str) -> Result<Value, DeepSeekError> {
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &Value,
        ) -> Result<Value, DeepSeekError> {
            let n = self.post_calls.get();
            self.post_calls.set(n + 1);
            let content = self
                .contents
                .get(n)
                .cloned()
                .unwrap_or_else(|| "{\"tool\":\"none\"}".to_string());
            Ok(serde_json::json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":content},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
            }))
        }
    }

    /// Test policy that mints a valid approval for the request (stands in for the owner).
    struct MintPolicy {
        secret: Vec<u8>,
        id: String,
        expires_at: i64,
    }
    impl ApprovalPolicy for MintPolicy {
        fn approve(&self, request: &MutatingActionRequest) -> Option<CanonicalApproval> {
            Some(mint_approval(
                request,
                &self.id,
                &self.secret,
                self.expires_at,
            ))
        }
    }

    const SECRET: &[u8] = b"hub-runtime-gate-secret-0123456789";

    fn runtime_with(
        tag: &str,
        contents: &[&str],
        approval: Box<dyn ApprovalPolicy>,
    ) -> (HubRuntime<ScriptTransport>, TempDir, Rc<Cell<usize>>) {
        let ws = TempDir::new(tag);
        let transport = ScriptTransport::new(contents);
        let post_calls = transport.post_calls.clone(); // shared chat/POST counter for no-hidden-call proof
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 6,
                principal_id: None, // recall disabled by default; the recall test sets it
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None, // S6d: no operator key in these tests ⇒ fail-closed Pause
            },
            agent,
            approval,
        )
        .unwrap();
        (rt, ws, post_calls) // TempDir guard keeps the workspace alive; counter for the no-hidden test
    }

    // ---- S7: DARK Claude route default-off -----------------------------------

    #[test]
    fn claude_route_gate_is_off_by_default_and_on_only_for_exactly_1() {
        // The default-off gate is the only thing that lets `live()` wire Claude.
        // Verify the exact-`"1"` predicate WITHOUT mutating the process env: drive the
        // matcher logic directly via the documented contract values.
        let on = |v: &str| v.trim() == "1";
        assert!(on("1"), "exactly \"1\" enables");
        assert!(on(" 1 "), "trimmed \"1\" enables");
        for off in ["", "0", "true", "yes", "01", "1 0", "enabled"] {
            assert!(!on(off), "{off:?} must NOT enable the dark route");
        }
        // Sanity: the live env var is currently unset in the test process, so the real
        // helper reports OFF — the prod default.
        assert!(
            !claude_route_enabled_from_env(),
            "FRIDAY_CLAUDE_ROUTE_ENABLED must be unset/off in the test env"
        );
    }

    #[test]
    fn resolver_returns_none_for_claude_when_dark_some_when_wired() {
        // Build a runtime with NO Claude client (the default). The baseline `claude`
        // route must resolve to `None` (DARK fail-closed) while `deepseek` resolves to
        // its live client and an unknown provider resolves to `None`.
        let (rt, _ws, _c) = runtime_with(
            "claude-dark",
            &["{\"tool\":\"none\"}"],
            Box::new(DenyAllApprovals),
        );
        let baseline = RouteRegistry::autonomous_baseline();
        let claude_route = baseline
            .get("claude")
            .expect("baseline has a claude route")
            .clone();
        let deepseek_route = baseline
            .get("deepseek")
            .expect("baseline has deepseek")
            .clone();

        // DARK default: no Claude client wired ⇒ resolver yields None (fail-closed).
        assert!(
            rt.resolve(&claude_route).is_none(),
            "claude must resolve to None by default (dark/off)"
        );
        // The baseline marks claude unavailable, so it is doubly fail-closed.
        assert!(
            !claude_route.is_dispatchable(),
            "claude route stays available:false"
        );
        // DeepSeek path is unchanged — still resolves to a live client.
        assert!(
            rt.resolve(&deepseek_route).is_some(),
            "deepseek path unchanged"
        );

        // Now wire the Claude client (what the gated `live()` path does). resolve("claude")
        // becomes Some; deepseek is still Some; nothing else changes.
        let wired = rt.with_claude(Box::new(crate::MockAgentLlmClient {
            proposal: crate::RawToolCall {
                action: "none".to_string(),
                params: vec![],
            },
        }));
        assert!(
            wired.resolve(&claude_route).is_some(),
            "claude resolves to the wired client once attached"
        );
        assert!(
            wired.resolve(&deepseek_route).is_some(),
            "deepseek still wired"
        );
    }

    // ---- C2 item 1: pin + gated validation (no-key) --------------------------

    #[test]
    fn pin_claude_dark_is_requested_unavailable() {
        // A plain runtime (gate OFF ⇒ claude route stays `available:false` in the baseline,
        // never promoted). `run_task_pinned(.., "claude", ..)` must surface
        // RequestedProviderUnavailable("claude") — the pin is PLUMBED through `run_task_pinned`
        // and fails closed with NO key, NO network, NO reroute to deepseek.
        let (rt, _ws, post_calls) = runtime_with(
            "pin-claude-dark",
            &["{\"tool\":\"none\"}"],
            Box::new(DenyAllApprovals),
        );
        let err = rt
            .run_task_pinned("run-pin-dark", "ask claude", "claude", 1_000)
            .expect_err("a dark claude pin must fail closed");
        assert!(
            matches!(
                err,
                RoutedLoopError::Route(RouteError::RequestedProviderUnavailable(ref p)) if p == "claude"
            ),
            "expected RequestedProviderUnavailable(claude), got {err:?}"
        );
        // Selection refused BEFORE dispatch — no model/chat call was ever made.
        assert_eq!(
            post_calls.get(),
            0,
            "no provider call on a refused pin (no reroute to deepseek)"
        );
    }

    #[test]
    fn run_task_pinned_deepseek_still_routes_to_deepseek() {
        // The pin entry is general: pinning the LIVE deepseek route routes to deepseek and runs
        // the SAME composed loop as `run_task` (shared `run_with_request` body). This guards the
        // refactor — the default path is byte-identical and the pin path is wired end-to-end.
        let (rt, _ws, _c) = runtime_with(
            "pin-deepseek",
            &["{\"tool\":\"none\",\"answer\":\"PONG\"}"],
            Box::new(DenyAllApprovals),
        );
        let (selection, outcome) = rt
            .run_task_pinned("run-pin-ds", "say pong", "deepseek", 1_000)
            .expect("pinned deepseek runs");
        assert_eq!(selection.provider_id, "deepseek");
        assert_eq!(outcome.status, LoopStatus::Finished);
    }

    #[test]
    fn validation_probe_credential_missing_keeps_claude_undispatchable() {
        // With NO Anthropic key in the env, the explicit one-shot `validate_and_enable_claude()`
        // runs the R7 live probe, which fails closed to CredentialMissing (NO quota spent, the
        // route stays non-validated). A subsequent claude pin therefore still fails closed with
        // RequestedProviderUnavailable. This is the no-key fail-closed proof; it presupposes the
        // test env has no FRIDAY_ANTHROPIC_API_KEY (CI is DeepSeek-only; asserted below).
        use friday_providers::KeyValidationOutcome;
        assert!(
            std::env::var("FRIDAY_ANTHROPIC_API_KEY")
                .map(|v| v.trim().is_empty())
                .unwrap_or(true),
            "this no-key proof requires FRIDAY_ANTHROPIC_API_KEY to be unset/empty"
        );
        let (mut rt, _ws, post_calls) = runtime_with(
            "validate-no-key",
            &["{\"tool\":\"none\"}"],
            Box::new(DenyAllApprovals),
        );
        let outcome = rt.validate_and_enable_claude();
        assert_eq!(
            outcome,
            KeyValidationOutcome::CredentialMissing,
            "no key ⇒ CredentialMissing (fail-closed, not Valid)"
        );
        // validation_ok was never flipped ⇒ a claude pin is still undispatchable.
        let err = rt
            .run_task_pinned("run-after-novalidate", "ask claude", "claude", 2_000)
            .expect_err("claude stays undispatchable after a missing-key validation");
        assert!(
            matches!(
                err,
                RoutedLoopError::Route(RouteError::RequestedProviderUnavailable(ref p)) if p == "claude"
            ),
            "expected RequestedProviderUnavailable(claude), got {err:?}"
        );
        assert_eq!(
            post_calls.get(),
            0,
            "no provider call: route never dispatched"
        );
    }

    // ---- C2 item 3: routed Claude parity (no-key, in-crate) ------------------
    //
    // These two tests are the DETERMINISTIC, no-key core of the C2 routed-parity proof:
    // they drive the REAL public `HubRuntime::run_task_pinned("claude", ..)` entry — through
    // `with_claude` + the in-process route promotion the gated `live()` path uses — to a STUB
    // Claude client that surfaces an Anthropic-kind `BilledUsage` exactly as the live
    // `ClaudeAgentLlmClient::next_step_metered` would after a real chat. This is the genuinely
    // new coverage over the lib.rs `claude_step_writes_anthropic_provider_row` test, which
    // BYPASSES the runtime (hand-built resolver + registry). NO key, NO network is needed; the
    // `#[ignore]`'d `tests/routed_claude_parity.rs` harness drives the SAME entry against a
    // LIVE Claude key (the operator run that spends quota).

    /// A stub Claude client: each metered step surfaces an Anthropic-kind [`BilledUsage`] (the
    /// bits the live `ClaudeAgentLlmClient` maps from a real chat) plus the next scripted step.
    /// Once the script is exhausted it finishes (so a tool turn that Pauses leaves no dangling
    /// turn). `propose_tool_call` is unused by the routed loop (it uses `next_step_metered`).
    struct StubClaudeMeteredClient {
        steps: Vec<AgentStep>,
        prompt_tokens: i64,
        completion_tokens: i64,
        model: String,
        calls: Cell<usize>,
    }
    impl StubClaudeMeteredClient {
        fn new(steps: Vec<AgentStep>, prompt_tokens: i64, completion_tokens: i64) -> Self {
            Self {
                steps,
                prompt_tokens,
                completion_tokens,
                model: friday_anthropic::DEFAULT_MODEL.to_string(),
                calls: Cell::new(0),
            }
        }
    }
    impl crate::AgentLlmClient for StubClaudeMeteredClient {
        fn propose_tool_call(&self, _task: &str) -> Result<crate::RawToolCall, crate::AgentError> {
            unreachable!("routed loop uses next_step_metered")
        }
        fn next_step_metered(
            &self,
            _task: &str,
            _history: &[crate::TurnTrace],
        ) -> Result<crate::MeteredStep, crate::AgentError> {
            let i = self.calls.get();
            self.calls.set(i + 1);
            let step = self.steps.get(i).cloned().unwrap_or(AgentStep::Finish {
                message: "done".to_string(),
            });
            let usage = crate::BilledUsage {
                provider_kind: friday_core::ProviderKind::Anthropic,
                model: self.model.clone(),
                prompt_tokens: self.prompt_tokens,
                completion_tokens: self.completion_tokens,
            };
            Ok((Ok(step), Some(usage)))
        }
    }

    /// Build a runtime with the DARK Claude client WIRED and its in-process route promoted to
    /// dispatchable — the SAME two flips the gated `live()` path performs
    /// (`with_claude` + `mark_route_available` + `mark_route_validated`), but WITHOUT a live key
    /// (no `validate_and_enable_claude` probe). This is legal in-crate because the test module is
    /// a child of the impl, so it may call the private route-promotion helpers; it does NOT add
    /// any public no-key route-enable (the dark/default-off invariant is untouched — the
    /// autonomous baseline still marks `claude` `available:false`).
    fn runtime_with_claude_wired(
        tag: &str,
        steps: Vec<AgentStep>,
        approval: Box<dyn ApprovalPolicy>,
    ) -> (HubRuntime<ScriptTransport>, TempDir) {
        let ws = TempDir::new(tag);
        // The DeepSeek transport is present (required by the runtime type) but never reached:
        // the claude pin routes to the wired Claude stub, not deepseek.
        let transport = ScriptTransport::new(&["{\"tool\":\"none\"}"]);
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let mut rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 6,
                principal_id: None,
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None, // fail-closed Pause on a mutating action (no auto-approve)
            },
            agent,
            approval,
        )
        .unwrap();
        rt = rt.with_claude(Box::new(StubClaudeMeteredClient::new(steps, 11, 8)));
        // The gated `live()` path does these two flips behind FRIDAY_CLAUDE_ROUTE_ENABLED + a
        // live key probe; we do them directly (no key) for the deterministic in-crate proof.
        rt.mark_route_available("claude");
        rt.mark_route_validated("claude");
        (rt, ws)
    }

    #[test]
    fn run_task_pinned_claude_routes_through_runtime_and_writes_anthropic_row() {
        // CHAT FLOW (send message / Ask Friday): a `run_task_pinned("claude")` through the REAL
        // HubRuntime entry routes to the wired Claude client, finishes, and records EXACTLY ONE
        // run-scoped token_ledger row attributed to Anthropic — host api.anthropic.com, the
        // claude model, fallback=false. NO key, NO network. This is the deterministic mirror of
        // the live `tests/routed_claude_parity.rs` chat leg.
        let (rt, _ws) = runtime_with_claude_wired(
            "c2-pinned-claude-chat",
            vec![AgentStep::Finish {
                message: "PONG".to_string(),
            }],
            Box::new(DenyAllApprovals),
        );
        let (selection, outcome) = rt
            .run_task_pinned("run-c2-chat", "say pong", "claude", 1_000)
            .expect("pinned claude runs through the runtime");
        assert_eq!(selection.provider_id, "claude", "the pin routed to claude");
        assert_eq!(outcome.status, LoopStatus::Finished);

        let rows = rt.db().list_run_token_usage("run-c2-chat").unwrap();
        assert_eq!(
            rows.len(),
            1,
            "one anthropic row for the single claude turn"
        );
        let row = &rows[0];
        assert_eq!(
            row.provider_kind, "anthropic",
            "NOT mis-attributed as deepseek"
        );
        assert_eq!(row.base_url_host, "api.anthropic.com");
        assert_eq!(row.model, friday_anthropic::DEFAULT_MODEL);
        assert_eq!(row.total_tokens, 19, "11 + 8 (summed by the ledger)");
        assert!(!row.fallback, "the claude route is never a fallback");

        // The whole-ledger projection agrees (only this anthropic row exists; no hidden call).
        let all = rt.db().list_token_usage().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].provider_kind, "anthropic");
    }

    #[test]
    fn claude_mutating_turn_bills_anthropic_row_then_pauses_for_approval() {
        // APPROVAL-REQUEST FLOW (routed + metered): a claude-pinned turn that proposes a MUTATING
        // tool (`write_file`) is BILLED an anthropic row (the chat that produced the proposal
        // spent tokens) and THEN the gate withholds it — with no operator key the run Pauses
        // (RequiresApproval), executes nothing, and persists a pending approval the offline
        // operator could sign. This proves "approval request" is a ROUTED+METERED Claude flow,
        // not a deferred one: the metered turn IS the claude turn, and the Pause is the gate
        // mechanics on top. NO key, NO network.
        let (rt, ws) = runtime_with_claude_wired(
            "c2-pinned-claude-approval",
            vec![AgentStep::Tool(crate::RawToolCall {
                action: "write_file".to_string(),
                params: vec![
                    ("path".to_string(), "out.txt".to_string()),
                    ("content".to_string(), "C2".to_string()),
                ],
            })],
            Box::new(DenyAllApprovals),
        );
        let (selection, outcome) = rt
            .run_task_pinned("run-c2-appr", "write a file", "claude", 2_000)
            .expect("pinned claude runs through the runtime");
        assert_eq!(selection.provider_id, "claude", "the pin routed to claude");
        assert_eq!(
            outcome.status,
            LoopStatus::Paused,
            "no operator key ⇒ the mutating action Pauses (RequiresApproval), never executes"
        );

        // The model call that PROPOSED the mutation was billed BEFORE the gate dispatch — one
        // anthropic row, correctly attributed.
        let rows = rt.db().list_run_token_usage("run-c2-appr").unwrap();
        assert_eq!(rows.len(), 1, "the proposing claude turn was billed");
        assert_eq!(rows[0].provider_kind, "anthropic");
        assert_eq!(rows[0].base_url_host, "api.anthropic.com");

        // The gate withheld the write — no file was created (no execute-on-Pause bypass).
        assert!(
            !ws.0.join("out.txt").exists(),
            "the gate withheld the write — no file created"
        );

        // A pending approval was persisted for the OFFLINE operator to sign (the resume leg).
        let pending: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM pending_approval_request WHERE run_id = 'run-c2-appr'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pending, 1, "one pending approval recorded for resume");
    }

    #[test]
    fn claude_route_error_fails_run_closed_and_bills_nothing() {
        // ERROR HANDLING (§3): a claude turn whose model call FAILS (an OUTER AgentError — what
        // the live ClaudeAgentLlmClient surfaces on a transport/HTTP error) fails the run CLOSED
        // (LoopStatus::Errored) with NO reroute to deepseek and NO ledger row (a call that
        // produced no usage bills nothing — the honest default). This makes "error handling" a
        // genuinely covered chat-expressible flow, not an assumed one. NO key, NO network.
        struct ErroringClaudeClient;
        impl crate::AgentLlmClient for ErroringClaudeClient {
            fn propose_tool_call(
                &self,
                _task: &str,
            ) -> Result<crate::RawToolCall, crate::AgentError> {
                unreachable!("routed loop uses next_step_metered")
            }
            fn next_step_metered(
                &self,
                _task: &str,
                _history: &[crate::TurnTrace],
            ) -> Result<crate::MeteredStep, crate::AgentError> {
                // The live adapter maps a ClaudeError into AgentError::Model (retry-classification
                // deferred); a Model error is TERMINAL (never retried) ⇒ the run fails closed.
                Err(crate::AgentError::Model("claude route error".to_string()))
            }
        }

        let ws = TempDir::new("c2-claude-route-error");
        let transport = ScriptTransport::new(&["{\"tool\":\"none\"}"]);
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let mut rt = HubRuntime::new(
            HubConfig {
                db_path: tmp("c2-claude-route-error"),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 6,
                principal_id: None,
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        rt = rt.with_claude(Box::new(ErroringClaudeClient));
        rt.mark_route_available("claude");
        rt.mark_route_validated("claude");

        let (selection, outcome) = rt
            .run_task_pinned("run-c2-err", "say pong", "claude", 1_000)
            .expect("a claude route error is a loop outcome, not a routing error");
        assert_eq!(
            selection.provider_id, "claude",
            "the pin routed to claude (no reroute)"
        );
        assert_eq!(
            outcome.status,
            LoopStatus::Errored,
            "a model-call error fails the run closed"
        );
        // A failed call produced no usage ⇒ NO ledger row (never a half-billed row).
        assert!(
            rt.db()
                .list_run_token_usage("run-c2-err")
                .unwrap()
                .is_empty(),
            "a route error bills nothing"
        );
    }

    // ---- PROOF-MEMORY-001 recall→inject wiring -------------------------------

    /// A transport that CAPTURES every outgoing chat body (so a test can assert what
    /// the model actually receives), and finishes the loop in one turn.
    struct CaptureTransport {
        bodies: Rc<std::cell::RefCell<Vec<Value>>>,
    }
    impl Transport for CaptureTransport {
        fn get_json(&self, _url: &str, _bearer: &str) -> Result<Value, DeepSeekError> {
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            body: &Value,
        ) -> Result<Value, DeepSeekError> {
            self.bodies.borrow_mut().push(body.clone());
            // Finish immediately so the loop runs exactly one turn.
            Ok(serde_json::json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":"{\"tool\":\"none\"}"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
            }))
        }
    }

    fn recall_runtime(
        tag: &str,
        principal: Option<&str>,
    ) -> (
        HubRuntime<CaptureTransport>,
        TempDir,
        Rc<std::cell::RefCell<Vec<Value>>>,
    ) {
        let ws = TempDir::new(tag);
        let bodies = Rc::new(std::cell::RefCell::new(Vec::new()));
        let transport = CaptureTransport {
            bodies: bodies.clone(),
        };
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 4,
                principal_id: principal.map(|p| p.to_string()),
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        (rt, ws, bodies)
    }

    fn seed_confirmed(
        rt: &HubRuntime<CaptureTransport>,
        id: &str,
        content: &str,
        principal: &str,
        sensitive: bool,
    ) {
        let conn = rt.db().conn();
        friday_storage::memory::record_candidate(
            conn,
            &friday_storage::memory::NewMemoryCandidate {
                memory_id: id,
                scope: friday_core::MemoryScope::Global,
                content_ref: None,
                content: Some(content),
                principal_id: Some(principal),
                sensitive,
                created_at: 1,
            },
        )
        .unwrap();
        friday_storage::memory::confirm(conn, id, 2).unwrap();
    }

    fn body_contains(bodies: &Rc<std::cell::RefCell<Vec<Value>>>, needle: &str) -> bool {
        bodies
            .borrow()
            .iter()
            .any(|b| b.to_string().contains(needle))
    }

    fn recall_audit_count(rt: &HubRuntime<CaptureTransport>) -> i64 {
        rt.db()
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE action LIKE 'memory.recalled%'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn recall_injects_owner_confirmed_memory_into_the_prompt_and_records_receipt() {
        // POSITIVE recall — the test that makes the negatives below non-vacuous.
        let (rt, _ws, bodies) = recall_runtime("recall-pos", Some("alice"));
        seed_confirmed(&rt, "m1", "MEMMARKER-alice-prefers-rust", "alice", false);
        rt.run_task("r-pos", "help me", 100).unwrap();
        assert!(
            body_contains(&bodies, "MEMMARKER-alice-prefers-rust"),
            "alice's confirmed memory must be injected into the outgoing prompt"
        );
        // a hash-chained memory.recalled receipt was written.
        assert_eq!(recall_audit_count(&rt), 1);
        // SCOPE: this proves recall→PROMPT INJECTION, not that the model's ANSWER carries
        // the marker (that is the separate live e2e — PROOF-MEMORY-001 stays proof_pending).
    }

    #[test]
    fn recall_is_cross_principal_isolated_in_the_prompt() {
        // bob's runtime, alice's memory → bob's prompt must NEVER carry it.
        let (rt, _ws, bodies) = recall_runtime("recall-xp", Some("bob"));
        seed_confirmed(&rt, "m1", "MEMMARKER-alice-secret-plan", "alice", false);
        rt.run_task("r-xp", "help me", 100).unwrap();
        assert!(
            !body_contains(&bodies, "MEMMARKER-alice-secret-plan"),
            "cross-principal recall leak: alice's memory reached bob's prompt"
        );
        // nothing was recalled for bob → no receipt.
        assert_eq!(recall_audit_count(&rt), 0);
    }

    #[test]
    fn recall_no_principal_injects_nothing() {
        let (rt, _ws, bodies) = recall_runtime("recall-none", None);
        seed_confirmed(&rt, "m1", "MEMMARKER-unowned", "alice", false);
        rt.run_task("r-none", "help me", 100).unwrap();
        assert!(!body_contains(&bodies, "MEMMARKER-unowned"));
        assert_eq!(recall_audit_count(&rt), 0);
    }

    #[test]
    fn recall_sensitive_memory_is_gated_out_under_deny_all() {
        let (rt, _ws, bodies) = recall_runtime("recall-sens", Some("alice"));
        seed_confirmed(&rt, "ok", "MEMMARKER-ok-nonsensitive", "alice", false);
        seed_confirmed(&rt, "sens", "MEMMARKER-sensitive-pii", "alice", true);
        rt.run_task("r-sens", "help me", 100).unwrap();
        // the non-sensitive memory injects; the sensitive one is gated out (deny-all).
        assert!(body_contains(&bodies, "MEMMARKER-ok-nonsensitive"));
        assert!(
            !body_contains(&bodies, "MEMMARKER-sensitive-pii"),
            "a sensitive memory must NOT be injected under deny-all"
        );
        // receipt recorded recalled=2 injected=1 gated_sensitive=1.
        let action: String = rt
            .db()
            .conn()
            .query_row(
                "SELECT action FROM audit_ledger WHERE action LIKE 'memory.recalled%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(action.contains("recalled=2") && action.contains("injected=1"));
        assert!(action.contains("gated_sensitive=1"));
    }

    // ---- routing honesty (dispatchable_routes) ------------------------------

    #[test]
    fn dispatchable_routes_only_flash_live_pro_and_others_honestly_unavailable() {
        let r = HubRuntime::<ScriptTransport>::dispatchable_routes();
        // open request → deepseek flash (the only live route)
        assert_eq!(
            crate::routing::select_route(&r, &RouteRequest::any())
                .unwrap()
                .provider_id,
            "deepseek"
        );
        // a Large request → deepseek-pro is unavailable → NoEligibleRoute (never silent flash-for-pro)
        let large = RouteRequest {
            model_size: Some(crate::routing::ModelSize::Large),
            ..RouteRequest::any()
        };
        assert!(matches!(
            crate::routing::select_route(&r, &large).unwrap_err(),
            RouteError::NoEligibleRoute { .. }
        ));
        // pinning codex (auth-gated) → RequestedProviderUnavailable (no reroute)
        let codex = RouteRequest {
            preferred_provider: Some("codex".to_string()),
            ..RouteRequest::any()
        };
        assert!(matches!(
            crate::routing::select_route(&r, &codex).unwrap_err(),
            RouteError::RequestedProviderUnavailable(_)
        ));
    }

    #[test]
    fn resolver_resolves_only_deepseek() {
        let (rt, _root, _post) = runtime_with(
            "resolve",
            &["{\"tool\":\"none\"}"],
            Box::new(DenyAllApprovals),
        );
        let r = HubRuntime::<ScriptTransport>::dispatchable_routes();
        let ds = r.get("deepseek").unwrap();
        assert!(rt.resolve(ds).is_some());
        let codex = r.get("codex").unwrap();
        assert!(rt.resolve(codex).is_none());
    }

    // ---- composed end-to-end through run_task -------------------------------

    #[test]
    fn composed_read_only_task_executes_via_gate_and_audit() {
        // turn 0: read_file (read-only → Allow → real fs read) ; turn 1: finish
        let (rt, root, _post) = runtime_with(
            "ro",
            &[
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"none\"}",
            ],
            Box::new(DenyAllApprovals),
        );
        std::fs::write(root.join("notes.md"), b"composed e2e note").unwrap();
        let (sel, out) = rt.run_task("run-ro", "read the notes", 1000).unwrap();
        assert_eq!(sel.provider_id, "deepseek");
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.executed_tools, 1);
        // hash-chained audit receipt exists + verifies through the composed entry
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    /// ADVERSE no-bypass: a mutating tool proposed through the composed entry is DENIED
    /// without an owner approval (deny-all) — it Pauses, executes nothing, writes no file.
    #[test]
    fn composed_mutating_task_denied_without_approval_no_bypass() {
        let (rt, root, _post) = runtime_with(
            "nobypass",
            &["{\"tool\":\"write_file\",\"parameters\":{\"path\":\"out.txt\",\"content\":\"X\"}}"],
            Box::new(DenyAllApprovals),
        );
        let (_sel, out) = rt.run_task("run-mut", "write a file", 2000).unwrap();
        assert!(
            matches!(out.status, LoopStatus::Paused | LoopStatus::Blocked),
            "mutating w/o approval must Pause/Block, got {:?}",
            out.status
        );
        assert_eq!(out.executed_tools, 0, "no execution without approval");
        assert!(
            !root.join("out.txt").exists(),
            "the gate withheld the write — no file created (no bypass)"
        );
    }

    /// S4: a tool DISABLED for the run is rejected through the composed entry — it is
    /// Blocked, executes nothing, and writes no file (the disabled `read_file` never reads).
    /// The control (`composed_read_only_task_executes_via_gate_and_audit`, identical script
    /// minus the disable) proves this is the disable doing the blocking, not a broken read.
    #[test]
    fn composed_disabled_tool_is_blocked_through_run_task() {
        let ws = TempDir::new("disabled");
        std::fs::write(ws.0.join("notes.md"), b"secret-do-not-read").unwrap();
        let transport = ScriptTransport::new(&[
            "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
            "{\"tool\":\"none\"}",
        ]);
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp("disabled"),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 6,
                principal_id: None,
                disabled_tools: vec!["read_file".to_string()], // <- disabled for this run
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        let (_sel, out) = rt.run_task("run-disabled", "read the notes", 1000).unwrap();
        assert_eq!(
            out.status,
            LoopStatus::Blocked,
            "a disabled tool must Block the run"
        );
        assert_eq!(out.executed_tools, 0, "the disabled tool must not execute");
        // The block is observable on the hash-chained audit/event log with the S4 reason.
        let blocked: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run_event WHERE kind LIKE 'tool.blocked:deny:tool_disabled_for_run:read_file%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            blocked, 1,
            "the disabled-tool block is recorded with its reason"
        );
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    /// S6d HMAC-DOWNGRADE CLOSED (composed level): a Hub that CAN mint a valid HMAC
    /// approval (the [`MintPolicy`] holds the symmetric secret) still cannot complete a
    /// protected mutation through the composed runtime when NO operator verify key is
    /// provisioned (`operator_vk: None`, the runtime_with default). The loop's protected
    /// path is Ed25519-only / fail-closed — it never consults the HMAC authorize — so the
    /// write Pauses, executes nothing, and writes no file. The positive Ed25519-approved
    /// completion + replay-refusal is the integration test `s6d_resume_ingestion` (it needs
    /// an operator SIGNING key, which `friday-hub/src/**` must never reference — see
    /// `operator_vk::tests::hub_crate_never_references_a_signing_key`).
    #[test]
    fn composed_hmac_minted_approval_cannot_complete_a_protected_mutation_fail_closed() {
        let write =
            "{\"tool\":\"write_file\",\"parameters\":{\"path\":\"out.txt\",\"content\":\"C\"}}";
        let (rt, root, _post) = runtime_with(
            "downgrade",
            &[write, "{\"tool\":\"none\"}"],
            Box::new(MintPolicy {
                secret: SECRET.to_vec(),
                id: "ap-rt".to_string(),
                expires_at: 1_000_000,
            }),
        );
        let (_sel, out) = rt.run_task("run-appr", "write once", 1000).unwrap();
        assert_eq!(
            out.executed_tools, 0,
            "an HMAC-minted approval must NOT complete a protected mutation (downgrade closed)"
        );
        assert!(
            matches!(out.status, LoopStatus::Paused),
            "no operator key ⇒ the protected write Pauses, got {:?}",
            out.status
        );
        assert!(
            !root.join("out.txt").exists(),
            "the gate withheld the write — no file created (fail-closed, no bypass)"
        );
        // The Pause persisted a `pending_approval_request` with a CSPRNG nonce (S6d req 4),
        // bound to THIS exact action, status `pending` — the offline operator's to-sign item.
        let (count, nonce_len): (i64, i64) = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*), COALESCE(length(MAX(approval_id)),0) \
                 FROM pending_approval_request WHERE run_id='run-appr' AND status='pending'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1, "exactly one pending request persisted on Pause");
        assert_eq!(nonce_len, 64, "CSPRNG nonce is 32 bytes => 64 hex chars");
        // No execution receipt on the hash-chain.
        let receipts: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE action LIKE 'tool.executed%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(receipts, 0, "no mutation executed ⇒ no execution receipt");
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    /// ADVERSE no-hidden-call: the model client is called EXACTLY once per loop turn (the
    /// transport's POST count == turns), and the executor is reached only on a gate-Allow.
    #[test]
    fn composed_no_hidden_model_call_one_post_per_turn() {
        // read_file (Allow+exec) → finish = 2 turns, 2 chat POSTs, 1 execution.
        let (rt, root, post) = runtime_with(
            "nohidden",
            &[
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"n.md\"}}",
                "{\"tool\":\"none\"}",
            ],
            Box::new(DenyAllApprovals),
        );
        std::fs::write(root.join("n.md"), b"x").unwrap();
        let (_sel, out) = rt.run_task("run-nh", "read n.md", 1000).unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.turns, 2, "exactly 2 model turns");
        assert_eq!(out.executed_tools, 1);
        // THE no-hidden-call proof (transport-level, not just the loop's self-count): the
        // shared chat/POST counter equals the loop's turn count — exactly one model call per
        // turn, none hidden inside next_step or outside the loop body.
        assert_eq!(
            post.get(),
            out.turns as usize,
            "exactly one model chat/POST per loop turn — no hidden model call"
        );
    }

    // ---- S1.3 Mission-bound agent loop --------------------------------------

    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus, Risk,
        SurfaceKind, SurfaceThread, TruthStatus, VisibilityPolicy, WorkItem, WorkItemStatus,
    };

    fn judgment_loop() -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "Run the Mission-bound agent loop".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: WorkLane::DeepSeek.as_str().into(),
            read_first_files: vec!["rust-core/crates/friday-hub/src/runtime.rs".into()],
            required_output: "Mission-bound loop run".into(),
            done_criteria: vec!["loop bound to mission".into()],
            red_lines: vec!["do not run before mission context".into()],
            why_this_route: "The WorkItem lane owns the agent loop.".into(),
            considered_options: vec!["unbound run_task".into()],
            deferred_options: vec!["multi-provider loop".into()],
            previous_pitfalls: vec!["detached run looked bound".into()],
            inheritable_context: vec!["Mission is product truth".into()],
            proof_requirements: vec!["mission loop tests".into()],
            ownership_claim_ids: Vec::new(),
        }
    }

    /// Seed a `FridayConversation -> Mission -> WorkItem` graph the loop's preflight resolves.
    fn seed_loop_mission(db: &Db, lane: WorkLane, target: Option<&str>, status: WorkItemStatus) {
        let now = 1_700_000_000_000;
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: "fconv_loop".into(),
            owner_principal: "owner-1".into(),
            title: "Mission loop".into(),
            current_focus_summary: "Mission-bound agent loop".into(),
            active_mission_ids: vec!["mission-loop".into()],
            surface_thread_ids: vec!["surface-mobile-loop".into()],
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: vec!["proof://mission-loop-test".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: "mission-loop".into(),
            friday_conversation_id: "fconv_loop".into(),
            title: "Mission loop".into(),
            intent: "bind the agent loop to a mission".into(),
            status: MissionStatus::Active,
            why_now: "loop runs must tie to a mission".into(),
            decision_path_summary: "resolve mission context before the loop".into(),
            considered_options: vec!["unbound run".into()],
            deferred_options: vec!["multi-provider".into()],
            known_pitfalls: vec!["unbound run looked bound".into()],
            handoff_inheritance: vec!["preserve route judgment".into()],
            work_item_ids: vec!["work-loop".into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://mission-loop-test".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_surface_thread(&SurfaceThread {
            surface_thread_id: "surface-mobile-loop".into(),
            friday_conversation_id: "fconv_loop".into(),
            mission_id: Some("mission-loop".into()),
            surface_kind: SurfaceKind::Mobile,
            channel_binding_id: None,
            delivery_route: "mobile".into(),
            visibility_policy: VisibilityPolicy::Compact,
            allowed_actions: vec!["open_mission".into()],
            last_seen_at_ms: Some(now),
            last_delivered_event_seq: Some(1),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_work_item(&WorkItem {
            work_item_id: "work-loop".into(),
            mission_id: "mission-loop".into(),
            lane,
            target_provider_or_agent: target.map(str::to_string),
            status,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("mission.loop".into()),
            risk_level: Risk::Medium,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["input://loop".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["mission loop tests".into()],
            proof_receipts: Vec::new(),
            judgment_memory: judgment_loop(),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
    }

    fn loop_lookup() -> MissionContextLookup {
        MissionContextLookup::by_work_item("fconv_loop", "mission-loop", "work-loop")
    }

    fn agent_run_count(rt: &HubRuntime<ScriptTransport>, run_id: &str) -> i64 {
        rt.db()
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run WHERE run_id = ?1",
                [run_id],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn table_count(rt: &HubRuntime<ScriptTransport>, table: &str) -> i64 {
        rt.db()
            .conn()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// VALID Mission: the loop runs through the composed entry AND records a `MissionLink`
    /// binding tied to THIS run_id; a Finished loop completes the WorkItem with the run as
    /// proof (result tied to the Mission).
    #[test]
    fn mission_bound_loop_runs_and_records_binding_tied_to_run_id() {
        let (rt, root, _post) = runtime_with(
            "mloop-ok",
            &[
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"none\"}",
            ],
            Box::new(DenyAllApprovals),
        );
        std::fs::write(root.join("notes.md"), b"mission-bound note").unwrap();
        seed_loop_mission(
            rt.db(),
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );

        let outcome = rt
            .run_agent_loop_for_mission(
                loop_lookup(),
                "friday-hub-session",
                "run-mloop",
                "read the notes",
                1000,
            )
            .unwrap();

        let MissionBoundLoopOutcome::Ran {
            envelope,
            selection,
            outcome,
            result_link,
            attachment,
        } = outcome
        else {
            panic!("expected a Mission-bound loop run");
        };
        assert_eq!(selection.provider_id, "deepseek");
        assert_eq!(outcome.status, LoopStatus::Finished);
        assert_eq!(outcome.executed_tools, 1);
        assert_eq!(result_link, "friday://agent-run/run-mloop");
        assert_eq!(envelope.route_decision.selected_lane, WorkLane::DeepSeek);
        assert!(matches!(
            attachment,
            MissionAttachmentOutcome::Attached {
                work_item_status: WorkItemStatus::CompletedWithProof,
                ..
            }
        ));
        // the loop actually ran (the run row exists)
        assert_eq!(agent_run_count(&rt, "run-mloop"), 1);
        // the binding exists, tied to THIS run_id
        let links = rt.db().list_mission_links("mission-loop").unwrap();
        assert!(
            links.iter().any(|link| link.target_ref
                == "friday://provider-timeline/friday-hub-session#run-mloop"
                && link.work_item_id.as_deref() == Some("work-loop")),
            "a mission_link must bind the run to the mission: {links:?}"
        );
        // the run's result ties to the Mission (proof on the WorkItem)
        let work_item = rt.db().get_work_item("work-loop").unwrap().unwrap();
        assert_eq!(work_item.status, WorkItemStatus::CompletedWithProof);
        assert!(work_item
            .proof_receipts
            .contains(&"friday://agent-run/run-mloop".to_string()));
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    /// A NON-Finished (Paused) loop is still bound to the Mission (link tied to run_id) but
    /// the binding is TRUTH-honest: it does NOT over-claim `CompletedWithProof` — it stops at
    /// `ProviderRouted` (true for any Ok loop outcome).
    #[test]
    fn mission_bound_loop_paused_binds_run_without_claiming_completion() {
        let (rt, root, _post) = runtime_with(
            "mloop-paused",
            &["{\"tool\":\"write_file\",\"parameters\":{\"path\":\"out.txt\",\"content\":\"X\"}}"],
            Box::new(DenyAllApprovals),
        );
        seed_loop_mission(
            rt.db(),
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );

        let outcome = rt
            .run_agent_loop_for_mission(
                loop_lookup(),
                "friday-hub-session",
                "run-mloop-p",
                "write a file",
                2000,
            )
            .unwrap();

        let MissionBoundLoopOutcome::Ran {
            outcome,
            attachment,
            ..
        } = outcome
        else {
            panic!("expected a Mission-bound loop run");
        };
        assert!(matches!(
            outcome.status,
            LoopStatus::Paused | LoopStatus::Blocked
        ));
        assert_eq!(outcome.executed_tools, 0);
        assert!(!root.join("out.txt").exists());
        // bound (link tied to run_id) ...
        let links = rt.db().list_mission_links("mission-loop").unwrap();
        assert!(links
            .iter()
            .any(|link| link.target_ref
                == "friday://provider-timeline/friday-hub-session#run-mloop-p"));
        // ... but NOT over-claimed as completed.
        assert!(matches!(
            attachment,
            MissionAttachmentOutcome::Attached {
                work_item_status: WorkItemStatus::ProviderRouted,
                ..
            }
        ));
        let work_item = rt.db().get_work_item("work-loop").unwrap().unwrap();
        assert_eq!(work_item.status, WorkItemStatus::ProviderRouted);
        assert!(
            !work_item
                .proof_receipts
                .iter()
                .any(|p| p.contains("run-mloop-p")),
            "a paused run must not record a completion proof"
        );
    }

    /// FAIL-CLOSED (missing context): an empty lookup blocks before any run — no `agent_run`
    /// row, no model call, no route_decision, no binding. Mirrors the ask path's
    /// `mission_bound_ask_blocks_missing_context_before_model_call`.
    #[test]
    fn mission_bound_loop_missing_context_fails_closed_no_run() {
        let (rt, root, post) = runtime_with(
            "mloop-fc",
            &["{\"tool\":\"none\"}"],
            Box::new(DenyAllApprovals),
        );
        std::fs::write(root.join("notes.md"), b"x").unwrap();

        let outcome = rt
            .run_agent_loop_for_mission(
                MissionContextLookup::default(),
                "friday-hub-session",
                "run-fc",
                "do work",
                1000,
            )
            .unwrap();

        assert!(matches!(
            outcome,
            MissionBoundLoopOutcome::Blocked { blockers }
                if blockers.contains(&"mission_context_lookup_required".to_string())
        ));
        assert_eq!(
            agent_run_count(&rt, "run-fc"),
            0,
            "no run created on invalid mission"
        );
        assert_eq!(post.get(), 0, "no model call on invalid mission");
        assert_eq!(
            table_count(&rt, "route_decision"),
            0,
            "no route_decision for an invalid mission"
        );
        assert_eq!(
            table_count(&rt, "mission_link"),
            0,
            "no binding for an invalid mission"
        );
    }

    /// FAIL-CLOSED (wrong lane): a real-but-wrong Mission (Channel-lane WorkItem) blocks the
    /// DeepSeek-lane loop — the loop never runs. Proves the preflight VALIDATES (not just the
    /// empty-lookup guard).
    #[test]
    fn mission_bound_loop_wrong_lane_fails_closed_no_run() {
        let (rt, _root, post) = runtime_with(
            "mloop-lane",
            &["{\"tool\":\"none\"}"],
            Box::new(DenyAllApprovals),
        );
        seed_loop_mission(
            rt.db(),
            WorkLane::Channel,
            Some("tg:room"),
            WorkItemStatus::ReadyToDispatch,
        );

        let outcome = rt
            .run_agent_loop_for_mission(
                loop_lookup(),
                "friday-hub-session",
                "run-lane",
                "do work",
                1000,
            )
            .unwrap();

        assert!(matches!(
            outcome,
            MissionBoundLoopOutcome::Blocked { blockers }
                if blockers.contains(&"mission_runtime_lane_mismatch".to_string())
        ));
        assert_eq!(agent_run_count(&rt, "run-lane"), 0);
        assert_eq!(post.get(), 0, "no model call on a lane-mismatched mission");
        assert_eq!(table_count(&rt, "mission_link"), 0);
    }

    /// NO REGRESSION: the unbound `run_task` entry still drives the loop end-to-end AND binds
    /// to no Mission — even when a Mission is present, the unbound entry writes no
    /// `mission_link`.
    #[test]
    fn run_task_unbound_still_works_and_creates_no_mission_binding() {
        let (rt, root, _post) = runtime_with(
            "unbound",
            &[
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"n.md\"}}",
                "{\"tool\":\"none\"}",
            ],
            Box::new(DenyAllApprovals),
        );
        std::fs::write(root.join("n.md"), b"x").unwrap();
        seed_loop_mission(
            rt.db(),
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );

        let (sel, out) = rt.run_task("run-unbound", "read n.md", 1000).unwrap();
        assert_eq!(sel.provider_id, "deepseek");
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.executed_tools, 1);
        assert_eq!(agent_run_count(&rt, "run-unbound"), 1);
        assert_eq!(
            table_count(&rt, "mission_link"),
            0,
            "the unbound run_task must not bind to any mission"
        );
    }

    // ---- D1 owner-wiring (run_task persists owner_principal) -----------------

    /// D1 OWNER-WIRING: a FINISHED run owned by principal P persists its answer with
    /// `owner_principal == P`, so the authenticated body projection Grants the body to P and
    /// Denies a different principal Q — the owner axis is wired end-to-end through `run_task`.
    #[test]
    fn owner_wiring_finished_run_records_owner_and_gates_authed_body() {
        use friday_storage::{get_run_answer_for_principal, AnswerDenyReason, RunAnswerAccess};

        const ANSWER: &str = "OWNER-ANSWER-CANARY-d1q4-only-P-may-read";

        let ws = TempDir::new("owner-wire");
        let script = format!("{{\"tool\":\"none\",\"answer\":\"{ANSWER}\"}}");
        let transport = ScriptTransport::new(&[script.as_str()]);
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp("owner-wire"),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 4,
                principal_id: Some("alice".to_string()), // the run's bound OWNER principal
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();

        let (_sel, out) = rt.run_task("run-owned", "answer me", 1000).unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.final_message.as_deref(), Some(ANSWER));

        // run_result recorded owner_principal == P.
        let owner: Option<String> = rt
            .db()
            .conn()
            .query_row(
                "SELECT owner_principal FROM run_result WHERE run_id = 'run-owned'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owner.as_deref(), Some("alice"));

        // P (owner) is GRANTED the body; Q (≠P) is DENIED with no body.
        match get_run_answer_for_principal(rt.db().conn(), "run-owned", "alice").unwrap() {
            RunAnswerAccess::Granted(stored) => assert_eq!(stored.answer, ANSWER),
            other => panic!("owner P must be Granted the body, got {other:?}"),
        }
        let denied = get_run_answer_for_principal(rt.db().conn(), "run-owned", "bob").unwrap();
        assert_eq!(
            denied,
            RunAnswerAccess::Denied(AnswerDenyReason::PrincipalMismatch)
        );
        // Canary: the denied (non-owner) projection carries NEITHER the body NOR the owner.
        let rendered = format!("{denied:?}");
        assert!(!rendered.contains(ANSWER) && !rendered.contains("alice"));
    }

    /// A FINISHED run with NO bound principal records NO owner ⇒ the body is unreadable to
    /// everyone (fail-closed), even though the body genuinely IS stored Hub-side.
    #[test]
    fn owner_wiring_unowned_run_records_no_owner_body_unreadable() {
        use friday_storage::{get_run_answer_for_principal, AnswerDenyReason, RunAnswerAccess};

        let (rt, _ws, _post) = runtime_with(
            "owner-wire-none",
            &["{\"tool\":\"none\",\"answer\":\"unowned-answer\"}"],
            Box::new(DenyAllApprovals),
        );
        let (_sel, out) = rt.run_task("run-unowned", "answer me", 1000).unwrap();
        assert_eq!(out.status, LoopStatus::Finished);

        let owner: Option<String> = rt
            .db()
            .conn()
            .query_row(
                "SELECT owner_principal FROM run_result WHERE run_id = 'run-unowned'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owner, None, "an unowned run must record no owner principal");

        // No owner ⇒ body released to NO ONE, even a valid-looking principal.
        assert_eq!(
            get_run_answer_for_principal(rt.db().conn(), "run-unowned", "alice").unwrap(),
            RunAnswerAccess::Denied(AnswerDenyReason::NoOwnerPrincipal)
        );
        // ...but the body IS stored Hub-side (the deny is authorization, not missing data).
        assert_eq!(
            friday_storage::get_run_result(rt.db().conn(), "run-unowned")
                .unwrap()
                .unwrap()
                .answer,
            "unowned-answer"
        );
    }

    /// A non-Finished run (here a Paused mutating action) persists NO `run_result` from
    /// `run_task` — leaving the slot free for the resume completion leg (no immutable-result
    /// collision) and meaning the authed projection safely finds NO answer.
    #[test]
    fn owner_wiring_paused_run_persists_no_result() {
        use friday_storage::{get_run_answer_for_principal, RunAnswerAccess};

        let (rt, _root, _post) = runtime_with(
            "owner-wire-paused",
            &["{\"tool\":\"write_file\",\"parameters\":{\"path\":\"out.txt\",\"content\":\"X\"}}"],
            Box::new(DenyAllApprovals),
        );
        let (_sel, out) = rt.run_task("run-paused", "write a file", 2000).unwrap();
        assert!(matches!(
            out.status,
            LoopStatus::Paused | LoopStatus::Blocked
        ));
        // No run_result row was written by run_task (the resume leg owns a Paused run's slot).
        assert_eq!(
            rt.db()
                .conn()
                .query_row(
                    "SELECT count(*) FROM run_result WHERE run_id = 'run-paused'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            get_run_answer_for_principal(rt.db().conn(), "run-paused", "alice").unwrap(),
            RunAnswerAccess::NotFound
        );
    }

    /// LIVE end-to-end (runtime-proven) through the FULL composition root. Ignored in CI (no
    /// key); run manually with the Hub key. Real DeepSeek → route select → gate → real fs
    /// read → hash-chained audit receipt, all from one `HubRuntime::live().run_task()`.
    #[test]
    #[ignore = "live: requires FRIDAY_DEEPSEEK_API_KEY; run manually (see ledger)"]
    fn live_composed_run_task_e2e() {
        let ws = TempDir::new("live");
        std::fs::write(ws.0.join("notes.md"), b"Friday composed live e2e.").unwrap();
        let rt = HubRuntime::live(HubConfig {
            db_path: tmp("live"),
            workspace_root: ws.0.clone(),
            secret: SECRET.to_vec(),
            max_turns: 5,
            principal_id: None, // the live save→recall→answer-carries-marker e2e is a separate proof (PR4)
            disabled_tools: vec![],
            read_only: false,
            operator_vk: None, // the live operator-approved mutating-completion proof is S6e
        })
        .expect("live runtime assembles (FRIDAY_DEEPSEEK_API_KEY set)");
        let (sel, out) = rt
            .run_task("run-live", "read the file notes.md and summarize it", 5000)
            .expect("composed run_task");
        eprintln!(
            "LIVE composed: provider={} status={:?} turns={} executed={}",
            sel.provider_id, out.status, out.turns, out.executed_tools
        );
        if out.executed_tools > 0 {
            assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
        }
    }

    // ---- A1: per-run-constraints application (override threading) ------------
    //
    // These prove the live application of `AgentRunConstraintsWire` onto the per-run
    // `RunPolicy` — the deferral #660 left open. The discriminating no-regression test (the
    // one the advisor flagged) is `boot read_only/disabled + ABSENT or non-tightening
    // override ⇒ STILL constrained` — it fails if the override REPLACES rather than COMPOSES
    // the boot policy.

    /// Build a runtime with EXPLICIT boot policy + max_turns (the parts `runtime_with` fixes).
    fn runtime_with_boot(
        tag: &str,
        contents: &[&str],
        principal_id: Option<String>,
        disabled_tools: Vec<String>,
        read_only: bool,
        max_turns: u64,
    ) -> (HubRuntime<ScriptTransport>, TempDir) {
        let ws = TempDir::new(tag);
        let transport = ScriptTransport::new(contents);
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns,
                principal_id,
                disabled_tools,
                read_only,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        (rt, ws)
    }

    fn constraints(
        read_only: bool,
        disabled_tools: &[&str],
        max_turns: Option<u64>,
    ) -> friday_protocol::AgentRunConstraintsWire {
        friday_protocol::AgentRunConstraintsWire {
            read_only,
            disabled_tools: disabled_tools.iter().map(|s| s.to_string()).collect(),
            max_turns,
        }
    }

    /// Count the `tool.blocked:deny:run_is_read_only:<tool>` events for a run.
    fn read_only_blocks(rt: &HubRuntime<ScriptTransport>, tool: &str) -> i64 {
        rt.db()
            .conn()
            .query_row(
                &format!(
                    "SELECT count(*) FROM agent_run_event WHERE kind LIKE 'tool.blocked:deny:run_is_read_only:{tool}%'"
                ),
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// Count the `tool.blocked:deny:tool_disabled_for_run:<tool>` events for a run.
    fn disabled_blocks(rt: &HubRuntime<ScriptTransport>, tool: &str) -> i64 {
        rt.db()
            .conn()
            .query_row(
                &format!(
                    "SELECT count(*) FROM agent_run_event WHERE kind LIKE 'tool.blocked:deny:tool_disabled_for_run:{tool}%'"
                ),
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// TIGHTEN (the spec's named test): boot is read_only:FALSE, but an asserted
    /// `read_only:true` constraint forces a gate-DENY of a mutating tool — even though boot
    /// would have Paused-pending-approval. Proves the override is APPLIED, not dropped.
    #[test]
    fn a1_override_read_only_true_forces_block_though_boot_is_not_read_only() {
        let (rt, root) = runtime_with_boot(
            "a1-tighten-ro",
            &["{\"tool\":\"write_file\",\"parameters\":{\"path\":\"out.txt\",\"content\":\"X\"}}"],
            None,
            vec![],
            false, // boot: NOT read-only
            6,
        );
        let c = constraints(true, &[], None); // per-run: read-only
        let policy = crate::agent_run_control::effective_run_policy_over(rt.policy(), Some(&c));
        let (_sel, out) = rt
            .run_task_with_overrides("a1-ro", "write a file", Some(&policy), c.max_turns, 1000)
            .unwrap();
        assert_eq!(
            out.status,
            LoopStatus::Blocked,
            "read_only:true override must BLOCK the mutating tool"
        );
        assert_eq!(out.executed_tools, 0, "nothing executes under read-only");
        assert!(!root.join("out.txt").exists(), "no file written");
        assert_eq!(
            read_only_blocks(&rt, "write_file"),
            1,
            "the block is recorded with the run_is_read_only reason"
        );
    }

    /// TIGHTEN: boot has NO disabled tools; an asserted `disabled_tools:[read_file]` constraint
    /// blocks the read through the override.
    #[test]
    fn a1_override_disabled_tool_blocks_though_boot_disables_none() {
        let (rt, root) = runtime_with_boot(
            "a1-tighten-dis",
            &[
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"none\"}",
            ],
            None,
            vec![], // boot: nothing disabled
            false,
            6,
        );
        std::fs::write(root.join("notes.md"), b"secret").unwrap();
        let c = constraints(false, &["read_file"], None);
        let policy = crate::agent_run_control::effective_run_policy_over(rt.policy(), Some(&c));
        let (_sel, out) = rt
            .run_task_with_overrides("a1-dis", "read the notes", Some(&policy), None, 1000)
            .unwrap();
        assert_eq!(out.status, LoopStatus::Blocked, "disabled tool blocks");
        assert_eq!(out.executed_tools, 0);
        assert_eq!(disabled_blocks(&rt, "read_file"), 1);
    }

    /// NO-REGRESSION (the discriminating one): boot is read_only:TRUE, and the override is
    /// ABSENT (`None`). The run MUST stay read-only. A REPLACE-the-boot-policy mistake would
    /// pass `run_task`'s default unconstrained policy and let the write through — this catches
    /// it. (`run_task` itself = the absent-override path.)
    #[test]
    fn a1_absent_override_preserves_boot_read_only() {
        let (rt, root) = runtime_with_boot(
            "a1-noreg-ro",
            &["{\"tool\":\"write_file\",\"parameters\":{\"path\":\"out.txt\",\"content\":\"X\"}}"],
            None,
            vec![],
            true, // boot: read-only
            6,
        );
        // Absent override = the `run_task` path (delegates `(None, None)`).
        let (_sel, out) = rt
            .run_task("a1-noreg-ro-run", "write a file", 1000)
            .unwrap();
        assert_eq!(
            out.status,
            LoopStatus::Blocked,
            "boot read-only must persist with NO override"
        );
        assert_eq!(out.executed_tools, 0);
        assert!(!root.join("out.txt").exists());
        assert_eq!(read_only_blocks(&rt, "write_file"), 1);
    }

    /// NO-REGRESSION (compose, not replace): boot is read_only:TRUE, and a PRESENT override
    /// asserts read_only:FALSE (+ a max_turns cap). The OR semantics mean the run STAYS
    /// read-only — a constraint can never UN-read-only a boot-configured read-only run. A
    /// replace-mistake (taking the constraint verbatim) would loosen it.
    #[test]
    fn a1_override_cannot_loosen_boot_read_only() {
        let (rt, root) = runtime_with_boot(
            "a1-noloose-ro",
            &["{\"tool\":\"write_file\",\"parameters\":{\"path\":\"out.txt\",\"content\":\"X\"}}"],
            None,
            vec![],
            true, // boot: read-only
            6,
        );
        let c = constraints(false, &[], Some(2)); // tries to turn read-only OFF
        let policy = crate::agent_run_control::effective_run_policy_over(rt.policy(), Some(&c));
        assert!(
            policy.is_read_only(),
            "composed policy stays read-only (boot OR constraint)"
        );
        let (_sel, out) = rt
            .run_task_with_overrides(
                "a1-noloose-ro-run",
                "write a file",
                Some(&policy),
                c.max_turns,
                1000,
            )
            .unwrap();
        assert_eq!(out.status, LoopStatus::Blocked, "still read-only");
        assert_eq!(out.executed_tools, 0);
        assert!(!root.join("out.txt").exists());
    }

    /// NO-REGRESSION (union, not replace): boot disables `read_file`; a PRESENT override that
    /// does NOT name `read_file` (disables something else) must STILL keep read_file disabled.
    #[test]
    fn a1_override_cannot_re_enable_boot_disabled_tool() {
        let (rt, root) = runtime_with_boot(
            "a1-noloose-dis",
            &[
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"none\"}",
            ],
            None,
            vec!["read_file".to_string()], // boot disables read_file
            false,
            6,
        );
        std::fs::write(root.join("notes.md"), b"secret").unwrap();
        // Override names a DIFFERENT tool — does not mention read_file.
        let c = constraints(false, &["delete_file"], None);
        let policy = crate::agent_run_control::effective_run_policy_over(rt.policy(), Some(&c));
        assert!(
            policy.is_tool_disabled("read_file"),
            "boot-disabled read_file stays disabled after compose"
        );
        let (_sel, out) = rt
            .run_task_with_overrides(
                "a1-noloose-dis-run",
                "read the notes",
                Some(&policy),
                None,
                1000,
            )
            .unwrap();
        assert_eq!(out.status, LoopStatus::Blocked, "read_file still blocked");
        assert_eq!(out.executed_tools, 0);
        assert_eq!(disabled_blocks(&rt, "read_file"), 1);
    }

    /// max_turns: a per-run cap LOWERS the ceiling (cannot raise it). Boot ceiling = 6; an
    /// override cap of 1 means the loop bounds after a single turn. (The floor is applied
    /// inside `run_task_with_overrides` as `self.max_turns.min(cap)`.)
    #[test]
    fn a1_override_max_turns_cap_lowers_ceiling() {
        // A script that keeps proposing a read (never "none") — without a cap it would run to
        // the boot ceiling; the cap forces a Bounded outcome sooner.
        let (rt, root) = runtime_with_boot(
            "a1-maxturns",
            &[
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
            ],
            None,
            vec![],
            false,
            6, // boot ceiling
        );
        std::fs::write(root.join("notes.md"), b"hello").unwrap();
        // cap=1: a cap can only lower; min(6,1)=1.
        let c = constraints(false, &[], Some(1));
        let policy = crate::agent_run_control::effective_run_policy_over(rt.policy(), Some(&c));
        let (_sel, out) = rt
            .run_task_with_overrides("a1-maxturns-run", "read", Some(&policy), c.max_turns, 1000)
            .unwrap();
        assert!(
            out.turns <= 1,
            "the max_turns cap (1) lowered the boot ceiling (6); got {} turns",
            out.turns
        );
        // A cap of 1 cannot RAISE past boot: passing 100 must still floor to boot (6) — the loop
        // never runs more than the boot ceiling.
        let c_high = constraints(false, &[], Some(100));
        let policy_high =
            crate::agent_run_control::effective_run_policy_over(rt.policy(), Some(&c_high));
        let (_sel2, out2) = rt
            .run_task_with_overrides(
                "a1-maxturns-high",
                "read",
                Some(&policy_high),
                c_high.max_turns,
                2000,
            )
            .unwrap();
        assert!(
            out2.turns <= 6,
            "a cap above boot cannot raise the ceiling; got {} turns",
            out2.turns
        );
    }

    /// The override preserves the bound OWNER (a constraint restricts WHAT, never WHO). A
    /// Finished run under a constraint still owner-stamps the boot principal — so the body is
    /// releasable to that owner exactly as the no-override path.
    #[test]
    fn a1_override_preserves_bound_owner_on_finished_run() {
        let (rt, _root) = runtime_with_boot(
            "a1-owner",
            &["{\"tool\":\"none\"}"], // finish immediately
            Some("principal:owner-a1".to_string()),
            vec![],
            false,
            6,
        );
        let c = constraints(true, &["delete_file"], Some(3)); // a tightening constraint
        let policy = crate::agent_run_control::effective_run_policy_over(rt.policy(), Some(&c));
        assert_eq!(
            policy.principal_id(),
            Some("principal:owner-a1"),
            "compose preserves the boot principal verbatim"
        );
        let (_sel, out) = rt
            .run_task_with_overrides(
                "a1-owner-run",
                "answer me",
                Some(&policy),
                c.max_turns,
                1000,
            )
            .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        // The owner was stamped: the result row records the boot owner.
        let owner: Option<String> = rt
            .db()
            .conn()
            .query_row(
                "SELECT owner_principal FROM run_result WHERE run_id = 'a1-owner-run'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            owner.as_deref(),
            Some("principal:owner-a1"),
            "the constrained run still owner-stamps the boot principal"
        );
    }
}
