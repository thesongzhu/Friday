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
    run_session_loop, AgentLlmClient, CancelToken, CodexTurnExecutor, DeepSeekAgentLlmClient,
    FsToolExecutor, LoopOutcome, LoopStatus, RunPolicy,
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
    /// C1 PR-B — DARK / default-off Codex (app-server) route executor. MIRRORS `claude`'s
    /// dark-by-default discipline: `None` in every build EXCEPT a `live()` build whose
    /// `FRIDAY_CODEX_ROUTE_ENABLED` gate is on. UNLIKE `claude` (a `dyn AgentLlmClient`), this is
    /// a [`crate::CodexTurnExecutor`] (the production impl is a
    /// [`crate::LocalCodexGatedTurnExecutor`]) — the CORRECT Codex seam that drives
    /// [`crate::codex_gated_turn::run_codex_gated_turn`] (NOT the conn-less `next_step_metered`
    /// the retired brain used). The codex route is therefore SPECIAL-CASED in `run_with_request`
    /// (it never flows through the generic `run_routed_loop_with_policy`/`resolve()` path).
    /// Default-off at two layers: this field stays `None`, AND the `codex` route is registered
    /// `available: false` (autonomous baseline; CLI auth-gated) so `select_route` never picks it.
    /// The DeepSeek/Claude paths are unchanged.
    codex: Option<Box<dyn CodexTurnExecutor>>,
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
    /// C1 PR-B — the Hub gate-approval HMAC secret (from [`HubConfig::secret`]). RETAINED on the
    /// runtime ONLY for the special-cased Codex gated-turn branch, which calls
    /// [`crate::codex_gated_turn::run_codex_gated_turn`] → `friday_storage::authorize_agent_action`
    /// (the HMAC authorize the gated turn was built on; see the PR-B note on the Ed25519/HMAC
    /// divergence). The DeepSeek/Claude routed loop authorizes via the operator Ed25519 verify
    /// key (`operator_vk`), NEVER this secret — so storing it here changes NOTHING for those
    /// paths, and under the dark default (`approve_fn → None`) a mutating Codex action Pauses
    /// (RequiresApproval) regardless, exactly as the #745 security review vetted.
    secret: Vec<u8>,
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
        // TP-PR2 (H-1 trust PRODUCER): capture the boot-context dims BEFORE `workspace_root`/
        // `principal_id` are moved into the executor/policy below. These feed the live
        // `AgentActionContext` attached to the boot policy so the (default-OFF)
        // `FRIDAY_TRUST_GRANT_ENFORCE` flag stops being a brick (see the attach block).
        let boot_principal = config.principal_id.clone();
        let boot_workspace = config.workspace_root.to_string_lossy().into_owned();
        // C1 PR-B: retain the gate-approval HMAC secret for the special-cased Codex gated-turn
        // branch (the ONLY consumer; see the `secret` field doc). Captured before the moves
        // below; the DeepSeek/Claude paths never read it.
        let secret = config.secret.clone();
        let executor = FsToolExecutor::new(config.workspace_root);
        let routes = Self::dispatchable_routes();
        // S4: ONE policy carries the run's principal (also the recall owner) + restrictions.
        let policy = RunPolicy::new(config.principal_id, config.disabled_tools, config.read_only);
        // ── TP-PR2 (H-1): attach the live boot `AgentActionContext` to the run policy ───────
        // The NS-2 trust chokepoint (`gate_dispatch_with_policy_enforced`, lib.rs) consumes
        // `policy.action_context()` ONLY inside its `if enforce_trust && request.mutating()`
        // arm — the single decision-consumer of the accessor (verified by grep). With
        // `FRIDAY_TRUST_GRANT_ENFORCE` OFF (the default, unchanged here) that arm is skipped,
        // so attaching this context is BYTE-IDENTICAL to not attaching it (a boot field-set,
        // no new env read / DB query / side-effect). The producer NEVER adds, flips, or
        // changes the default of any flag — it only makes the existing flag SATISFIABLE.
        //
        // Brick-safety is runtime STATE, not code: under flag-ON the chokepoint's `Some(ctx)`
        // arm loads the active grant `WHERE agent_id = ?1`; if no grant row exists it Denies
        // `trust_no_active_grant` (correct fail-closed). This producer adds NO fallback that
        // would let a mutating action through without a grant when enforce is ON.
        //
        // Dims:
        //   - `agent_id` = the bound owner (`config.principal_id`) — the SAME `--owner`
        //     allowlist string the operator issues the NS-3 grant for.
        //   - `workspace` = the boot workspace root, so an operator who scopes a grant to that
        //     workspace prefix is satisfiable; `check_grant` would otherwise DENY a
        //     workspace-scoped grant when `ctx.workspace` is None (the `_ => deny
        //     trust_grant_workspace_out_of_scope` arm in friday_core::check_grant). v1 enforce
        //     honors agent_id + workspace-prefix + risk_ceiling + expiry + token/run ceilings +
        //     tool allowlist.
        //   - `tool` = None: enriched PER-ACTION at the chokepoint from
        //     `canonical_rust_name(raw.action)` (TP-PR1), so the `allowed_tools` allowlist is
        //     actually evaluated rather than silently skipped. A boot-level `tool` would be wrong.
        //   - `provider`/`channel`/`workflow_family`/`skill_family` = None: these are
        //     per-action/per-ingress, not boot-knowable. Enforcing them is the NAMED follow-up
        //     (needs the dimension threaded into the chokepoint signature, the way TP-PR1 did
        //     for `tool`). Left None ⇒ `check_grant` skips them (an unset dimension on the
        //     ACTION side, not a loophole on a grant boundary).
        //
        // If `principal_id` is None ⇒ NO context is attached: no owner ⇒ no authority, and
        // under flag-ON the chokepoint's `None`-arm correctly Denies every mutating action.
        let policy = match boot_principal {
            Some(agent_id) => policy.with_action_context(friday_storage::AgentActionContext {
                agent_id,
                workspace: Some(boot_workspace),
                tool: None,
                ..Default::default()
            }),
            None => policy,
        };
        Ok(Self {
            db,
            routes,
            deepseek,
            // S7: DARK — no Claude client by default. Only `live()` may populate this,
            // and only when the default-OFF `FRIDAY_CLAUDE_ROUTE_ENABLED` gate is on
            // (via [`Self::with_claude`]). Tests + the prod default leave it `None`.
            claude: None,
            // C1-3: DARK — no Codex client by default (mirrors `claude`). Only `live()` may
            // populate this, and only when the default-OFF `FRIDAY_CODEX_ROUTE_ENABLED` gate
            // is on (via [`Self::with_codex`]). Tests + the prod default leave it `None`.
            codex: None,
            executor,
            operator_vk: config.operator_vk,
            approval,
            max_turns: config.max_turns,
            policy,
            secret,
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

    /// C1 PR-B — attach the DARK Codex route EXECUTOR (builder, default-off). MIRRORS
    /// [`Self::with_claude`]'s dark discipline: the ONLY way the `codex` field becomes `Some`. It
    /// does NOT touch the DeepSeek/Claude paths, the route registry, or any default; selecting
    /// Codex still additionally requires a dispatchable `codex` route (the autonomous baseline
    /// marks it `available: false` — CLI auth-gated). UNLIKE `with_claude`, this takes a
    /// [`crate::CodexTurnExecutor`] (driving `run_codex_gated_turn`), not a `dyn AgentLlmClient`.
    /// Consumes + returns `self` so `live()` can chain it behind the env gate.
    pub fn with_codex(mut self, codex: Box<dyn CodexTurnExecutor>) -> Self {
        self.codex = Some(codex);
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

    /// (C1-3) Validate the wired Codex route ONCE via a CREDS-LIGHT app-server `health_check`
    /// and, ONLY on success, mark the in-process `codex` route `validation_ok: true`
    /// (dispatchable).
    ///
    /// ## Divergence from [`Self::validate_and_enable_claude`]: NO HTTP key probe
    /// Codex has NO `KeyProvider` / HTTP key-validation path (see `friday-providers`
    /// `key_validation`: the key-bearing providers are `{DeepSeek, Anthropic}` only; Codex is a
    /// CLI login, not an API key). So this does NOT route through `LiveKeyValidationProbe` —
    /// pretending a key probe exists for Codex would be a dishonesty bug. Instead it spawns a
    /// fresh local Codex app-server and runs `health_check` =
    /// `initialize` + `thread/list` — a metadata-only round-trip that drives NO model turn and
    /// therefore spends ZERO completion quota. (`codex login status` is the equivalent shell
    /// signal; the app-server `health_check` is the in-process mirror used here.)
    ///
    /// Like the Claude probe this is an EXPLICIT, operator/harness-invoked one-shot — NEVER
    /// called at boot, so a gated `HubRuntime::live` construction spawns no app-server and never
    /// hangs. With no Codex CLI installed / not logged in, the spawn/handshake surfaces a typed
    /// [`friday_providers::codex_appserver::CodexAppServerError`] (`Err`) ⇒ `validation_ok` stays
    /// false ⇒ the route stays non-dispatchable (fail-closed); nothing is written. The raw
    /// `Result<HealthSummary, _>` is returned (NOT a fabricated `KeyValidationOutcome`) so the
    /// caller can surface the exact health signal.
    pub fn validate_and_enable_codex(
        &mut self,
    ) -> Result<
        friday_providers::codex_appserver::HealthSummary,
        friday_providers::codex_appserver::CodexAppServerError,
    > {
        use friday_providers::codex_appserver::LocalCodexAppServer;
        // Spawn a fresh local app-server (killed on drop at scope exit) and run the creds-light
        // health probe — initialize + thread/list, NO model turn (spends nothing). Same
        // `program`/identity the route's `LocalCodexAppServerTurnSource` uses.
        let mut server = LocalCodexAppServer::spawn(CODEX_APP_SERVER_PROGRAM)?;
        let summary = server
            .client()
            .health_check(CODEX_CLIENT_NAME, CODEX_CLIENT_VERSION)?;
        // Success ⇒ the route is dispatchable in THIS runtime's in-process registry only.
        self.mark_route_validated("codex");
        Ok(summary)
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
            None, // cancel: not cancellable here (C2-1)
            None, // steer: not steerable here (C2-2)
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
        self.run_with_request(run_id, task, &request, None, None, None, None, now_ms)
    }

    /// (C2-1) [`Self::run_task_pinned`] with a cooperative [`CancelToken`] threaded into the
    /// routed loop — the interrupt/stop entry the routed-claude parity harness's `interrupt /
    /// stop` flow needs. The token is checked at the TOP of each turn (BEFORE the model call):
    /// when tripped at a turn boundary the loop stops with [`LoopStatus::Interrupted`], makes
    /// NO further model call, and bills NOTHING after the trip. The holder keeps a clone of the
    /// same `cancel` to call [`CancelToken::cancel`] from another point (in a single-threaded
    /// test it is tripped between scripted turns via a cancel-on-call stub). Identical to
    /// `run_task_pinned` in every other respect; passing a fresh/un-tripped token reproduces
    /// `run_task_pinned` exactly.
    pub fn run_task_pinned_cancellable(
        &self,
        run_id: &str,
        task: &str,
        provider_id: &str,
        cancel: &CancelToken,
        now_ms: i64,
    ) -> Result<(RoutedSelection, LoopOutcome), RoutedLoopError> {
        let request = RouteRequest {
            preferred_provider: Some(provider_id.to_string()),
            ..RouteRequest::any()
        };
        self.run_with_request(
            run_id,
            task,
            &request,
            None,
            None,
            Some(cancel),
            None,
            now_ms,
        )
    }

    /// (C2-2) [`Self::run_task_pinned`] with a cooperative [`crate::SteerHandle`] threaded into
    /// the routed loop — the mid-loop STEER entry the routed-claude parity harness needs. The
    /// handle is drained at the TOP of each turn (AFTER the cancel check, BEFORE the model call):
    /// a pending instruction is folded into THAT turn's prompt, so the turn's metered chat carries
    /// it and produces a REAL billed model call grounded on the steer — an ADDITIONAL metered turn
    /// when the loop was continuing, NOT a no-op mirror event. The holder keeps a clone of the same
    /// `steer` to call [`crate::SteerHandle::steer`] from another point (in a single-threaded test
    /// the steer is injected between scripted turns via a steer-on-call stub; the live test injects
    /// it from a background thread). Identical to `run_task_pinned` in every other respect; an
    /// EMPTY handle (nothing ever steered) reproduces `run_task_pinned` exactly. NOT cancellable
    /// (steer and cancel are independent entries this slice; composing both is a later refinement).
    pub fn run_task_pinned_steerable(
        &self,
        run_id: &str,
        task: &str,
        provider_id: &str,
        steer: &crate::SteerHandle,
        now_ms: i64,
    ) -> Result<(RoutedSelection, LoopOutcome), RoutedLoopError> {
        let request = RouteRequest {
            preferred_provider: Some(provider_id.to_string()),
            ..RouteRequest::any()
        };
        self.run_with_request(
            run_id,
            task,
            &request,
            None,
            None,
            None,
            Some(steer),
            now_ms,
        )
    }

    /// (C2) The SHARED composed-loop body for [`Self::run_task_with_overrides`] (open request)
    /// and [`Self::run_task_pinned`] (provider-pinned request). Factored out so there is ONE
    /// composed loop — the ONLY variable between the two entries is `request` (C2-1 adds the
    /// optional `cancel` handle, C2-2 the optional `steer` handle, both `None` for the
    /// default/pinned non-cancellable/non-steerable entries). The default path remains
    /// byte-identical: `run_task_with_overrides` calls this with `&RouteRequest::any()`,
    /// `cancel: None`, and `steer: None`.
    #[allow(clippy::too_many_arguments)]
    fn run_with_request(
        &self,
        run_id: &str,
        task: &str,
        request: &RouteRequest,
        policy_override: Option<&RunPolicy>,
        max_turns_override: Option<u64>,
        cancel: Option<&CancelToken>,
        steer: Option<&crate::SteerHandle>,
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

        // ── C1 PR-B: the SPECIAL-CASED Codex execution path ────────────────────────────────
        // A codex route does NOT flow through the generic `run_routed_loop_with_policy`/
        // `resolve()` path (which drives the conn-less `next_step_metered` — the retired brain
        // model). It is intercepted HERE, where `conn`/`policy`/`secret`/`approve` are in scope,
        // and driven through `run_codex_gated_turn` (the ONLY codex execution path). We select
        // the route FIRST (deterministic + pure — re-selecting below for the non-codex delegate
        // is byte-identical) so we can branch on `provider_id` BEFORE `resolve()`:
        //   - codex selected + executor wired ⇒ drive the gated turn here.
        //   - codex selected + executor NOT wired (the dark default) ⇒ fail-closed
        //     `NoClientForProvider("codex")` (NEVER a reroute), mirroring the resolver backstop.
        //   - codex pinned but the route is not dispatchable (the autonomous-baseline default:
        //     `available:false`) ⇒ `select_route` errors `RequestedProviderUnavailable("codex")`
        //     before this, BEFORE any model call — unchanged.
        //   - any other selection (deepseek/claude, incl. the default `RouteRequest::any()`) ⇒
        //     fall through to the EXISTING `run_routed_loop_with_policy` UNCHANGED.
        // NO-DEGRADE: the default `RouteRequest::any()` selects deepseek, so this branch is
        // skipped and the path below is byte-identical to before.
        let selected = crate::routing::select_route(&self.routes, request)?;
        if selected.provider_id == "codex" {
            let codex = self
                .codex
                .as_deref()
                .ok_or_else(|| RoutedLoopError::NoClientForProvider("codex".to_string()))?;
            let selection = RoutedSelection {
                provider_id: selected.provider_id.clone(),
                model: selected.model.clone(),
                model_size: selected.model_size,
                backend_kind: selected.backend_kind,
            };
            let outcome = self.run_codex_route_turn(
                codex,
                policy,
                run_id,
                &recall_preamble,
                task,
                &approve,
                now_ms,
            )?;
            // D1 OWNER-WIRING parity: persist a Finished answer Hub-side keyed by `run_id` with
            // the run's bound owner, EXACTLY as the routed-loop tail below (same `Finished`-only
            // discipline). Reuses `persist_run_result`; no parallel persistence path.
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
            // CLARIFICATION-GATE persist parity: an `AwaitingClarification` outcome carries the
            // clarifying questions in `final_message`; persist them owner-wired with status
            // "awaiting_clarification" so they reach the owner (same arm as the routed-loop tail
            // below and `run_session_loop` step-5b). The codex gated-turn path does not itself
            // produce this status today, but the parity arm keeps the persist discipline uniform.
            if outcome.status == LoopStatus::AwaitingClarification {
                let mut result = RunResult::new(
                    "awaiting_clarification",
                    outcome.final_message.clone().unwrap_or_default(),
                    None,
                );
                if let Some(principal) = policy.principal_id() {
                    result = result.with_owner_principal(principal);
                }
                persist_run_result(self.db.conn(), run_id, &result, now_ms)?;
            }
            return Ok((selection, outcome));
        }

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
            cancel,
            steer,
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

        // CLARIFICATION-GATE persist arm (the routed/sessionless parity of `run_session_loop`
        // step-5b): the flag-gated clarification gate inside `run_loop_with_policy_flagged` can
        // stop an under-specified planning task with `AwaitingClarification`, carrying the
        // clarifying questions in `final_message`. Persist them owner-wired with status
        // "awaiting_clarification" (same owner-gated discipline as the Finished arm) so
        // `project_answer_for_authed` delivers the questions to the owner — the questions reach
        // the user via the run_result, zero new transport. No bound principal ⇒ no owner ⇒
        // body stays unreadable (fail-closed).
        if outcome.status == LoopStatus::AwaitingClarification {
            let mut result = RunResult::new(
                "awaiting_clarification",
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

    /// (C1 PR-B) Drive ONE gated Codex turn and map its [`crate::codex_gated_turn::CodexTurnOutcome`]
    /// onto a [`LoopOutcome`] in the SAME vocabulary the routed loop uses (Finished/Paused/Errored),
    /// recording the SAME run-attributed event markers and billing through the SAME single biller
    /// ([`crate::bill_model_call`]). It owns NO gate/pending/ledger mechanism of its own —
    /// `run_codex_gated_turn` already does the gate + the pending-approval persist; this only maps
    /// the result + records the loop-vocabulary outcome event + bills a Finished turn's usage.
    ///
    /// The prompt is the SAME recall-preamble + clean-task composition the loop builds (the run's
    /// `task` stays clean — the preamble augments only what the model sees). `turns: 1` (one model
    /// turn), `executed_tools: 0` (Codex runs its side effects in its OWN runtime; Friday's
    /// executor is never invoked on a codex turn — the gate routes Codex's pre-execution approval
    /// requests, it does not execute them).
    #[allow(clippy::too_many_arguments)]
    fn run_codex_route_turn(
        &self,
        codex: &dyn CodexTurnExecutor,
        policy: &RunPolicy,
        run_id: &str,
        recall_preamble: &str,
        task: &str,
        approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
        now_ms: i64,
    ) -> Result<LoopOutcome, RoutedLoopError> {
        // Plan classification + the SAME recall-preamble prompt the loop records/builds, so a
        // codex run's event log + prompt are consistent with a deepseek/claude run.
        let plan_kind = friday_core::classify_kind(task).map(|k| k.as_str());
        agent_run::record_event(
            self.db.conn(),
            &format!("{run_id}:plan"),
            run_id,
            &format!("plan.{}", plan_kind.unwrap_or("none")),
            now_ms,
        )?;
        let prompt = if recall_preamble.is_empty() {
            task.to_string()
        } else {
            format!("{recall_preamble}{task}")
        };

        // The ONLY codex execution path: the gated turn (gate + pending-persist live inside it).
        // `Err` is a Friday-side fault (the pending-persist for a RequiresApproval failed) — fail
        // CLOSED to `Errored` (the pause is not durably recoverable; never a phantom success).
        let codex_outcome = match codex.run_gated_turn(
            self.db.conn(),
            policy,
            &self.secret,
            approve,
            &prompt,
            run_id,
            now_ms,
        ) {
            Ok(outcome) => outcome,
            Err(e) => {
                let reason = format!("codex_gated_turn_error:{e}");
                agent_run::record_event(
                    self.db.conn(),
                    &format!("{run_id}:t0:outcome"),
                    run_id,
                    &format!("agent.error:{reason}"),
                    now_ms,
                )?;
                return Ok(LoopOutcome {
                    status: LoopStatus::Errored,
                    turns: 1,
                    executed_tools: 0,
                    final_message: None,
                    detail: reason,
                });
            }
        };

        let ev = |suffix: &str| format!("{run_id}:t0:{suffix}");
        match codex_outcome {
            // Finished: BILL the turn's usage through the single biller (one codex row), record
            // the SAME `agent.finished` marker the loop's Finish arm records, surface the answer.
            crate::codex_gated_turn::CodexTurnOutcome::Finished { answer, usage } => {
                crate::bill_model_call(self.db.conn(), run_id, 0, &usage, now_ms)?;
                agent_run::record_event(
                    self.db.conn(),
                    &ev("finish"),
                    run_id,
                    "agent.finished",
                    now_ms,
                )?;
                Ok(LoopOutcome {
                    status: LoopStatus::Finished,
                    turns: 1,
                    executed_tools: 0,
                    final_message: Some(answer),
                    detail: "finished".to_string(),
                })
            }
            // Paused: the gated turn ALREADY persisted the pending_approval_request (under
            // `approval_nonce`) and DENIED the action to Codex (its turn aborted) — we only record
            // the loop-vocabulary pause marker (mirroring the loop's `tool.paused:requires_approval`
            // event, incl. the nonce) and surface `Paused`. NOTE: no usage is billed on a pause —
            // a Deny aborts the Codex turn, so `run_codex_gated_turn` returns NO `BilledUsage`
            // (UNLIKE the retired brain, which billed the proposing turn). NS-7 GAP (acceptable,
            // default-OFF): the loop's RequiresApproval arm ALSO writes a Needs-Me activity row
            // (`insert_pending_approval_activity`) when `FRIDAY_ACTIVITY_NEEDS_ME` is on; the gated
            // turn does its own persist WITHOUT that, so a codex pause does not surface a Needs-Me
            // item. Left as a named follow-up (NS-7 is default-off, so this is byte-identical to
            // today for prod) rather than reaching into the gated turn's persist.
            crate::codex_gated_turn::CodexTurnOutcome::Paused {
                action,
                approval_nonce,
            } => {
                agent_run::record_event(
                    self.db.conn(),
                    &ev("outcome"),
                    run_id,
                    &format!("tool.paused:requires_approval:{action}:{approval_nonce}"),
                    now_ms,
                )?;
                Ok(LoopOutcome {
                    status: LoopStatus::Paused,
                    turns: 1,
                    executed_tools: 0,
                    final_message: None,
                    detail: format!("requires_approval:{action}"),
                })
            }
            // Errored: a hard gate Deny (trust-revoked / chat-only grant / risk-ceiling), an
            // unmappable approval request, an authorize-unavailable, or a transport/protocol
            // failure (incl. the flag-OFF `interactive-approval-unsupported`). The `reason` is
            // code-only + secret-free (never the raw command/path). Fail the run closed, mirroring
            // the loop's `agent.error` marker. A Deny that ABORTED the turn yields NO usage, so
            // nothing is billed (never a half-billed row).
            crate::codex_gated_turn::CodexTurnOutcome::Errored { reason } => {
                agent_run::record_event(
                    self.db.conn(),
                    &ev("outcome"),
                    run_id,
                    &format!("agent.error:{reason}"),
                    now_ms,
                )?;
                Ok(LoopOutcome {
                    status: LoopStatus::Errored,
                    turns: 1,
                    executed_tools: 0,
                    final_message: None,
                    detail: format!("codex_errored:{reason}"),
                })
            }
        }
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
        // Bind the owner BEFORE recall so recall's session-derived namespace matches the
        // namespace post-run extraction will store under — even on the FIRST run (recall here
        // precedes `run_session_loop`'s own `ensure_session`). Idempotent + COALESCE: a
        // bound owner is never clobbered. A bind storage error is a SAFE FAILURE (NoAnswer).
        if friday_storage::agent_session::ensure_session_with_owner(
            self.db.conn(),
            session_id,
            &owner,
            now_ms,
        )
        .is_err()
        {
            return AuthedAnswer::NoAnswer {
                run_id: run_id.to_string(),
            };
        }

        // The owner's confirmed-memory recall preamble — keyed on the SESSION-DERIVED
        // composite namespace (ALIGNED with how post-run extraction STORES candidates), NOT
        // the raw `--owner`. A recall failure is a SAFE FAILURE (body-free NoAnswer); an
        // unresolvable namespace recalls NOTHING (empty preamble, never an error).
        let recall_preamble = match self.recall_preamble_for_session(session_id, run_id, now_ms) {
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
            None, // cancel: the sessioned entry is not cancellable (C2-1 is sessionless)
            None, // steer: the sessioned entry is not steerable (C2-2 is sessionless)
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
        let answer = project_answer_for_authed(self.db.conn(), run_id, caller)
            .with_counts(outcome.turns, outcome.executed_tools);
        // (NS8-WIRE-1, Loop5) Fire post-run memory extraction (flag-gated, default-OFF; only on
        // Finished; result discarded; failure-isolated) AFTER the owner-gated answer is bound +
        // projected. See `maybe_extract_memory_post_run`.
        self.maybe_extract_memory_post_run(session_id, run_id, &outcome, now_ms);
        answer
    }

    /// (C2) Pin a SPECIFIC provider for a SESSIONED FOLLOW-UP turn (no-fallback) — the
    /// SESSIONED parity of [`Self::run_task_pinned`]. A session follow-up turn (e.g.
    /// "make it shorter" or an approval-resume continuation on an already-bound session) routes
    /// to + BILLS the pinned provider, instead of the deepseek-hardcoded
    /// [`Self::run_session_task_with_overrides`]. HONEST SCOPE: this is a FOLLOW-UP turn, NOT
    /// in-flight "steer/interrupt" of a running turn (§3 flow #8 steer/interrupt is DEFERRED —
    /// there is no mid-turn channel in `run_loop`); do not read this entry as steer coverage.
    ///
    /// ## Routing — the SAME resolve() chokepoint as the sessionless pinned entry
    /// It builds a pinned [`RouteRequest`] (`preferred_provider: Some(provider_id)`), selects the
    /// route via [`crate::routing::select_route`], and resolves the live client through the SAME
    /// [`ProviderClientResolver::resolve`] chokepoint the routed loop uses. A non-dispatchable pin
    /// (e.g. `claude` while DARK) FAILS CLOSED at `resolve()` with
    /// [`RoutedLoopError::NoClientForProvider`] — NEVER a silent reroute, and (critically) BEFORE
    /// any `agent_run` row is created or any token is billed, so a dark pin bills NOTHING. A pin to
    /// an UNREGISTERED/unavailable provider surfaces [`RoutedLoopError::Route`] from `select_route`,
    /// also before any write.
    ///
    /// ## Everything else is byte-identical to [`Self::run_session_task_with_overrides`]
    /// Once the client is resolved, this drives the EXISTING [`run_session_loop`] with the RESOLVED
    /// `&dyn AgentLlmClient` in place of `&self.deepseek` — owner-binding (the authenticated
    /// `caller`, NEVER the client-asserted `session_id`), the memory-recall preamble, the session
    /// history fold, the gate-mandatory loop, and the owner-gated body projection are all
    /// UNCHANGED. The sessionless-overrides body is left byte-untouched (additive).
    ///
    /// Returns the [`RoutedSelection`] (so the caller can assert WHO answered — `provider_id`)
    /// alongside the owner-gated [`AuthedAnswer`]. A storage failure inside the loop is a SAFE
    /// FAILURE: `Ok((selection, AuthedAnswer::NoAnswer))` — never a panic, never a partial body.
    ///
    /// DARK: like the rest of C2, the live Claude leg needs `FRIDAY_CLAUDE_ROUTE_ENABLED` + a live
    /// Anthropic key (the gated `live()` path); the deterministic in-crate proof wires the route +
    /// a stub metered client with NO key. NOT v1 GO.
    #[allow(clippy::too_many_arguments)]
    pub fn run_session_task_pinned(
        &self,
        caller: &AuthedPrincipal,
        run_id: &str,
        session_id: &str,
        task: &str,
        provider_id: &str,
        now_ms: i64,
    ) -> Result<(RoutedSelection, AuthedAnswer), RoutedLoopError> {
        // (1) ROUTE + RESOLVE FIRST — the same chokepoint as the routed loop, BEFORE any write.
        // A dark/unavailable pin fails closed here (NoClientForProvider / Route), so a dark Claude
        // pin creates NO run row and bills NOTHING.
        let request = RouteRequest {
            preferred_provider: Some(provider_id.to_string()),
            ..RouteRequest::any()
        };
        let route = crate::routing::select_route(&self.routes, &request)?;
        let selection = RoutedSelection {
            provider_id: route.provider_id.clone(),
            model: route.model.clone(),
            model_size: route.model_size,
            backend_kind: route.backend_kind,
        };
        let client = self
            .resolve(route)
            .ok_or_else(|| RoutedLoopError::NoClientForProvider(route.provider_id.clone()))?;

        // (2) From here this is byte-identical to `run_session_task_with_overrides` (the pre-C2
        // sessioned body) EXCEPT the loop runs on the RESOLVED `client` instead of `&self.deepseek`.
        // No per-run policy/max-turns override (the boot config applies, like `run_task_pinned`).
        let policy = &self.policy;
        let max_turns = self.max_turns;

        // Create the run row FIRST (run_session_loop only ensure_sessions). A create failure is a
        // SAFE FAILURE (body-free NoAnswer). The route is already resolved, so this only runs for a
        // dispatchable pin — a dark pin already returned above without creating a row.
        if agent_run::create_run(self.db.conn(), run_id, task, now_ms).is_err() {
            return Ok((
                selection,
                AuthedAnswer::NoAnswer {
                    run_id: run_id.to_string(),
                },
            ));
        }

        // Owner-scoping: bind the session owner to the AUTHENTICATED caller (INV-5/INV-7), NEVER
        // the client-asserted session_id.
        let owner = SessionOwner {
            user_id: Some(caller.principal().to_string()),
            ..SessionOwner::default()
        };
        // Bind the owner BEFORE recall so recall's session-derived namespace matches the
        // namespace post-run extraction stores under, even on the first run (idempotent +
        // COALESCE; a bound owner is never clobbered). A bind error is a SAFE FAILURE.
        if friday_storage::agent_session::ensure_session_with_owner(
            self.db.conn(),
            session_id,
            &owner,
            now_ms,
        )
        .is_err()
        {
            return Ok((
                selection,
                AuthedAnswer::NoAnswer {
                    run_id: run_id.to_string(),
                },
            ));
        }

        // The owner's confirmed-memory recall preamble — keyed on the SESSION-DERIVED
        // composite namespace (ALIGNED with how post-run extraction STORES candidates), same
        // source as the unpinned sessioned entry. Unresolvable namespace ⇒ empty recall.
        let recall_preamble = match self.recall_preamble_for_session(session_id, run_id, now_ms) {
            Ok(p) => p,
            Err(_) => {
                return Ok((
                    selection,
                    AuthedAnswer::NoAnswer {
                        run_id: run_id.to_string(),
                    },
                ));
            }
        };

        // Drive the EXISTING session loop AS the bound owner on the RESOLVED client (the ONLY
        // change from the deepseek-hardcoded entry). The billing — a token_ledger row attributed to
        // the client's own provider_kind/host — happens INSIDE the loop from the client's metered
        // step, so a Claude client bills an anthropic row with NO extra wiring.
        let approve = |req: &MutatingActionRequest| self.approval.approve(req);
        let outcome = match run_session_loop(
            client,
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
            None, // cancel: the sessioned entry is not cancellable (C2-1 is sessionless)
            None, // steer: the sessioned entry is not steerable (C2-2 is sessionless)
            now_ms,
        ) {
            Ok(outcome) => outcome,
            Err(_) => {
                return Ok((
                    selection,
                    AuthedAnswer::NoAnswer {
                        run_id: run_id.to_string(),
                    },
                ));
            }
        };

        // Release the body ONLY to the authenticated owner, then attach the loop's counts.
        let answer = project_answer_for_authed(self.db.conn(), run_id, caller)
            .with_counts(outcome.turns, outcome.executed_tools);
        // (NS8-WIRE-1, Loop5) Fire post-run memory extraction (flag-gated, default-OFF; only on
        // Finished; result discarded; failure-isolated) AFTER the owner-gated answer is bound +
        // projected. See `maybe_extract_memory_post_run`.
        self.maybe_extract_memory_post_run(session_id, run_id, &outcome, now_ms);
        Ok((selection, answer))
    }

    /// (NS8-WIRE-1, Loop5) Fire POST-RUN session-memory extraction from the LIVE sessioned run
    /// loop — the missing TRIGGER that closes the Memory loop. This is the CALLER for the already
    /// merged producer [`crate::memory_extraction::extract_inline`] (#726); it does NOT reimplement
    /// extraction.
    ///
    /// ## When it fires (and when it does NOT)
    /// - **Flag-gated, default-OFF.** Reads [`ENV_RUN_LOOP_MEMORY_EXTRACTION`] ONCE here. OFF (the
    ///   prod default — unset / empty / `"0"` / anything but the exact `"1"`) ⇒ this returns
    ///   IMMEDIATELY before any work: NO extraction call, NO query, NO provider call. The run is
    ///   BYTE-IDENTICAL to today.
    /// - **Only on `Finished`.** A `Paused` / `Errored` / `Bounded` / `Blocked` / `Interrupted`
    ///   outcome returns without firing (those carry no deliverable answer; `Paused` belongs to the
    ///   resume completion leg). This mirrors the owner-wiring `persist_run_result` gate.
    ///
    /// ## Why it can NEVER change the run's outcome/status/answer
    /// - **Sequenced AFTER the answer is bound + projected.** Both call sites invoke this only after
    ///   `persist_run_result` (the owner-gated answer bind, inside `run_session_loop`) AND
    ///   `project_answer_for_authed` have materialized the [`AuthedAnswer`]. The answer the caller
    ///   returns is already in hand; this runs purely for its candidate side effect.
    /// - **Result DISCARDED via `let _`.** The [`crate::memory_extraction::ExtractionOutcome`] (and
    ///   any [`crate::memory_extraction::ExtractionError`]) is dropped. It is never inspected, never
    ///   propagated, and never folded into the answer — so it CANNOT flip Delivered→NoAnswer.
    /// - **Failure-isolated.** Extraction writes ONLY `token_ledger` / `memory_item` (candidate) /
    ///   (NS-8-flag-gated) `activity` rows — NEVER the `run_result` row the answer projection reads.
    ///   An extraction ERROR (provider failure, unresolvable namespace, parse, storage) is swallowed
    ///   by the `let _`: the run already succeeded and stays `Finished`; the answer/status/ledger of
    ///   the RUN are unchanged. The candidates it records are NON-DURABLE `Candidate` rows, gated on
    ///   a separate operator confirm (Needs-Me) surface — NOT this trigger.
    ///
    /// `&self` is sufficient: the producer takes a SHARED `&Db` (NS8-WIRE-1 relaxed it from
    /// `&mut Db`; the whole path uses only `&self`/`&Connection` storage ops), and the raw
    /// structured-inference client comes from `self.deepseek.inner()`. The id-prefix / ledger-id
    /// mirror the `hub_extract_memory` bin.
    ///
    /// Reads [`ENV_RUN_LOOP_MEMORY_EXTRACTION`] ONCE here and threads the resulting bool into the
    /// pure-on-the-bool inner [`Self::maybe_extract_memory_post_run_flagged`] — the program-standard
    /// "split env-read from pure logic" idiom (mirroring `passport_mint` / `workitem_guarded`), so
    /// behavioral tests inject the bool directly and never race `std::env`.
    fn maybe_extract_memory_post_run(
        &self,
        session_id: &str,
        run_id: &str,
        outcome: &LoopOutcome,
        now_ms: i64,
    ) {
        let enabled = run_loop_memory_extraction_from(
            std::env::var(ENV_RUN_LOOP_MEMORY_EXTRACTION)
                .ok()
                .as_deref(),
        );
        self.maybe_extract_memory_post_run_flagged(session_id, run_id, outcome, now_ms, enabled);
    }

    /// The flag-parameterized inner (pure on `enabled`, env-race-free for tests). DEFAULT-OFF:
    /// `enabled == false` ⇒ return before ANY work, byte-identical to the pre-NS8-WIRE-1 baseline
    /// (no extraction call, no query, no provider call). Only fires on
    /// [`LoopStatus::Finished`]. The result is DISCARDED + the call is failure-isolated via `let _`
    /// (see the parent doc): it can NEVER flip the run's answer/status or break the run.
    fn maybe_extract_memory_post_run_flagged(
        &self,
        session_id: &str,
        run_id: &str,
        outcome: &LoopOutcome,
        now_ms: i64,
        enabled: bool,
    ) {
        // Flag-gated, default-OFF: OFF ⇒ return before ANY work (byte-identical to today).
        if !enabled {
            return;
        }
        // Only on Finished (NOT Paused / Errored / Bounded / Blocked / Interrupted).
        if outcome.status != LoopStatus::Finished {
            return;
        }
        let id_prefix = format!("{session_id}:extract:{now_ms}");
        let ledger_id = format!("led:{run_id}:{now_ms}");
        // Result DISCARDED + failure-isolated: `let _` drops the Ok(outcome) AND swallows any
        // Err — extraction can NEVER flip the run's answer/status or break the run.
        let _ = crate::memory_extraction::extract_inline(
            &self.db,
            session_id,
            self.deepseek.inner(),
            crate::memory_extraction::DEFAULT_MAX_ITEMS,
            &id_prefix,
            &ledger_id,
            now_ms,
        );
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
        // Boot policy / ceiling (no per-run override) — the byte-identical pre-NS-4 body.
        self.run_agent_loop_for_mission_with_overrides(
            mission_lookup,
            session_id,
            run_id,
            task,
            None,
            None,
            now_ms,
        )
    }

    /// (NS-4) [`Self::run_agent_loop_for_mission`] with an OPTIONAL per-run policy + max-turns
    /// override threaded onto the composed loop — the Mission-bound parity of
    /// [`Self::run_task_with_overrides`]. `None`/`None` ⇒ the boot policy/ceiling, byte-identical
    /// to the pre-NS-4 entry. `Some(p)` ⇒ the COMPOSED only-tighten policy the live WS dispatch
    /// arm built via [`crate::agent_run_control::effective_run_policy_over`].
    ///
    /// WHY this exists: the live mission-bound seam ([`crate::run_authed_agent_loop_mission_bound`])
    /// is reached on the SAME dispatch arm that applies a peer's per-run CONSTRAINTS. The unbound
    /// path threads those onto its loop; the Mission-bound loop MUST enforce the IDENTICAL
    /// tightening (read-only / disabled-tools / max-turns) or a constraint asserted on a
    /// mission-bound run would be silently dropped. The override CANNOT relax the run — it only
    /// tightens — and it never re-binds the owner (the FIX-Q2 owner gate is orthogonal, enforced
    /// at the seam before this is ever called).
    #[allow(clippy::too_many_arguments)]
    pub fn run_agent_loop_for_mission_with_overrides(
        &self,
        mission_lookup: MissionContextLookup,
        session_id: &str,
        run_id: &str,
        task: &str,
        policy_override: Option<&RunPolicy>,
        max_turns_override: Option<u64>,
        now_ms: i64,
    ) -> Result<MissionBoundLoopOutcome, RoutedLoopError> {
        // NS-6: read the DARK passport-mint flag ONCE here (the only env read; semantics in
        // [`passport_mint_from`]) and thread the resulting bool into the private flagged inner
        // fn — the codebase's "split env-read from pure logic" idiom (mirroring NS-7's
        // `activity_needs_me_from`), so the behavioral tests inject the bool directly and never
        // race `std::env`. DEFAULT-OFF: when off the body is BYTE-IDENTICAL to the pre-NS-6
        // baseline (no passport minted, no new query, normal `Ran`/`Blocked`).
        let passport_mint = passport_mint_from(std::env::var(ENV_PASSPORT_MINT).ok().as_deref());
        // WI-1 (M-6): read the DARK WorkItem guarded-transition flag ONCE here (the only env read;
        // semantics in [`workitem_guarded_transition_from`]) and thread the resulting bool into the
        // private flagged inner fn — the same split-env-read idiom as `passport_mint`. DEFAULT-OFF:
        // when off the WorkItem status advance is BYTE-IDENTICAL to the pre-WI-1 inline write.
        let workitem_guarded = workitem_guarded_transition_from(
            std::env::var(ENV_WORKITEM_GUARDED_TRANSITION)
                .ok()
                .as_deref(),
        );
        self.run_agent_loop_for_mission_with_overrides_flagged(
            mission_lookup,
            session_id,
            run_id,
            task,
            policy_override,
            max_turns_override,
            passport_mint,
            workitem_guarded,
            now_ms,
        )
    }

    /// (NS-6) [`Self::run_agent_loop_for_mission_with_overrides`] with the DARK passport-mint
    /// flag threaded in as a pure bool — the env read lives ONLY in the public wrapper (the
    /// "split env-read from pure logic" idiom), so the behavioral tests drive this directly with
    /// `true`/`false` and never touch `std::env`. The public signature is unchanged so every
    /// live caller compiles untouched.
    ///
    /// `passport_mint = false` (the prod default) is BYTE-IDENTICAL to the pre-NS-6 body: the
    /// mint block is SKIPPED ENTIRELY (no `build_context_passport`, no recall query for items,
    /// no `ContextPassport` row, no extra mission_link), and the run proceeds exactly as before.
    ///
    /// `passport_mint = true` mints a destination-bound [`friday_core::ContextPassport`] for THIS
    /// handoff AFTER the preflight envelope is Ready and BEFORE the run executes, from a REAL
    /// item source: the recalled-confirmed-memory items this run carries into its prompt
    /// (`recall_confirmed → rank_recall`, the SAME chain `recall_preamble` renders), converted to
    /// `PassportItem`s exactly as [`crate::cognition::gate_and_render_recall`] does. The
    /// destination is the envelope's RESOLVED lane/target (the route decision), not a literal.
    /// Because [`crate::mission_preflight::attach_context_passport_ref`] builds through
    /// [`friday_core::build_context_passport`] (which runs `gate_transfer`), a context that
    /// carries a secret / raw-token / unapproved-sensitive item makes the build FAIL — the
    /// passport is NEVER minted/persisted and the handoff FAILS CLOSED (`Blocked`), so the run
    /// NEVER executes and no model call happens. When the real source yields ZERO items the mint
    /// is SKIPPED (an empty passport carries nothing) and the run proceeds normally.
    ///
    /// The passport is gated as ONE transfer unit (all-or-nothing): ANY sensitive item in the
    /// recalled set blocks the WHOLE handoff (nothing partially carried) — DELIBERATELY tighter
    /// than the per-item recall path. See [`Self::mint_handoff_passport`] for the full semantics.
    #[allow(clippy::too_many_arguments)]
    fn run_agent_loop_for_mission_with_overrides_flagged(
        &self,
        mission_lookup: MissionContextLookup,
        session_id: &str,
        run_id: &str,
        task: &str,
        policy_override: Option<&RunPolicy>,
        max_turns_override: Option<u64>,
        passport_mint: bool,
        workitem_guarded: bool,
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

        // NS-6 (DARK, default-OFF): mint + persist + link a destination-bound Context Passport
        // for THIS handoff, BEFORE the run executes. Flag OFF ⇒ this whole block is skipped (the
        // pre-NS-6 byte-identical path). Flag ON + a secret/raw-token/unapproved-sensitive item
        // ⇒ `attach_context_passport_ref` returns a `context_passport_blocked:*` outcome and we
        // FAIL CLOSED here: return `Blocked` BEFORE `run_task`, so the run never executes, no
        // model call happens, and nothing (no passport row, no link, no secret string) persists.
        if passport_mint {
            if let Some(outcome) = self.mint_handoff_passport(&envelope, run_id, now_ms)? {
                return Ok(outcome);
            }
        }

        // Run the SAME composed loop as the unbound entry (no divergence), threading the
        // (effective) per-run policy + ceiling so a mission-bound run enforces the IDENTICAL
        // tightening the unbound dispatch arm applies. Absent override ⇒ boot config unchanged.
        let (selection, outcome) = self.run_task_with_overrides(
            run_id,
            task,
            policy_override,
            max_turns_override,
            now_ms,
        )?;

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
            // WI-1 (M-6): DARK-flag bool threaded from the entrypoint env read. OFF ⇒ the inline
            // status-advance write (byte-identical); ON ⇒ each hop goes through the guarded
            // `transition_work_item_status` primitive, adding the atomic hash-chained audit row.
            workitem_guarded,
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

    /// (NS-6) The real handoff item-source → mint. Collects the REAL context items THIS run
    /// carries into its prompt — the recalled-confirmed-memory items (`recall_confirmed →
    /// rank_recall`, the SAME chain [`Self::recall_preamble`] renders, keyed on the SAME
    /// `self.policy.principal_id()`) — converts each to a [`friday_core::PassportItem`] EXACTLY
    /// as [`crate::cognition::gate_and_render_recall`] does (`kind: MemorySnippet`, `label:
    /// content`, `included: true`, `sensitive: m.sensitive`), and mints a destination-bound
    /// passport for the envelope's RESOLVED lane/target via
    /// [`crate::mission_preflight::attach_context_passport_ref`] (which re-gates through
    /// `build_context_passport`).
    ///
    /// The pre-gate `sensitive`/`included` flags are PRESERVED so the gate re-runs on the
    /// stored set (a `sensitive` item ⇒ a `context_passport_blocked:*` outcome under v1 deny-all,
    /// the faithful secret-bearing fail-closed path). The `passport_id` encodes THIS `run_id`
    /// (`context-passport:agent-loop:{run_id}`), so the persisted `MissionLinkKind::ContextPassport`
    /// link + the `mission.context_passport_refs` entry both bind the passport to this run — no
    /// invented field.
    ///
    /// AGGREGATE (whole-unit) GATING — read this before assuming this mirrors the recall path.
    /// The per-ITEM `PassportItem` field conversion (`kind`/`label`/`included`/`sensitive`)
    /// matches `gate_and_render_recall`, BUT the resulting set is gated DIFFERENTLY: every item is
    /// handed to `build_context_passport` with `included: true` and the passport is gated as a
    /// SINGLE TRANSFER UNIT (all-or-nothing). If ANY recalled item is sensitive-and-unapproved
    /// under v1 deny-all, the ENTIRE passport build fails and the whole handoff fails closed
    /// (`Blocked`) — NOTHING persists, so a benign item sharing the set with a sensitive one is
    /// NOT partially carried. This is DELIBERATELY MORE RESTRICTIVE than the prompt path
    /// (`gate_and_render_recall`), which drops sensitive items PER-ITEM and injects the rest.
    /// Rationale: a Context Passport is ONE transfer artifact, so a fail-closed whole-unit block
    /// is the correct boundary (never a leak — strictly tighter than the per-item drop).
    ///
    /// CALLER CAVEAT: the returned `Blocked { blockers }` reason embeds the offending item's
    /// PII-redacted label (it originates from `gate_transfer`'s message). It is NOT persisted
    /// (the canary-scan test confirms no transfer artifact carries the secret), but callers MUST
    /// NOT log `blockers` verbatim — it is the same exposure class as recall content reaching the
    /// prompt.
    ///
    /// Returns:
    /// - `Ok(None)` ⇒ the run should PROCEED. Either nothing was minted because the real source
    ///   yielded ZERO items (an empty passport carries nothing), or the passport was minted +
    ///   persisted + linked successfully.
    /// - `Ok(Some(Blocked))` ⇒ FAIL CLOSED. The build was blocked by the transfer gate (secret /
    ///   raw-token / unapproved-sensitive item); nothing persisted (no passport row, no link, no
    ///   ref) and the caller must return this BEFORE the run executes.
    fn mint_handoff_passport(
        &self,
        envelope: &MissionRuntimeEnvelope,
        run_id: &str,
        now_ms: i64,
    ) -> Result<Option<MissionBoundLoopOutcome>, RoutedLoopError> {
        // The REAL item source: the confirmed-memory recall this run carries into its prompt.
        // No owner principal ⇒ no recall ⇒ no items (fail-closed: nothing to transfer).
        let Some(principal) = self.policy.principal_id() else {
            return Ok(None);
        };
        let rows = friday_storage::memory::recall_confirmed(self.db.conn(), principal)?;
        let ranked = crate::cognition::rank_recall(
            &rows,
            now_ms,
            crate::cognition::DEFAULT_RECALL_TOP_K,
            crate::cognition::DEFAULT_HALF_LIFE_MS,
        );
        // Convert each recalled memory to a PassportItem EXACTLY as gate_and_render_recall does —
        // PRE-gate (keep `sensitive`/`included`) so `build_context_passport` re-gates the set.
        let items: Vec<friday_core::PassportItem> = ranked
            .iter()
            .map(|m| friday_core::PassportItem {
                kind: friday_core::PassportItemKind::MemorySnippet,
                label: m.content.clone(),
                included: true,
                sensitive: m.sensitive,
            })
            .collect();

        // Zero real items ⇒ nothing to carry; skip the mint (an empty passport is meaningless).
        if items.is_empty() {
            return Ok(None);
        }

        // Destination = the envelope's RESOLVED route (not a literal): the lane/target the
        // preflight already validated + upserted as the route decision for this handoff.
        let destination_lane = envelope.route_decision.selected_lane;
        let destination_target = envelope
            .route_decision
            .selected_provider_or_agent
            .as_deref();

        // The passport_id encodes the run so the link + ref bind to THIS handoff.
        let passport_id = format!("context-passport:agent-loop:{run_id}");
        let attach = crate::mission_preflight::attach_context_passport_ref(
            &self.db,
            &envelope.context.mission_id,
            &passport_id,
            Some(envelope.context.work_item_id.as_str()),
            destination_lane,
            destination_target,
            items,
            // v1 deny-all: no sensitive-transfer approval is wired (same as recall_preamble_for),
            // so a `sensitive` item makes the build fail-closed here.
            false,
            now_ms,
        )?;

        match attach {
            // Minted + persisted + linked + ref pushed: proceed with the run.
            MissionAttachmentOutcome::Attached { .. }
            | MissionAttachmentOutcome::MissionLinked { .. } => Ok(None),
            // The transfer gate blocked the build (secret / raw-token / unapproved-sensitive) — or
            // any other attach blocker. FAIL CLOSED: nothing persisted, the run must NOT execute.
            MissionAttachmentOutcome::Blocked { blockers } => {
                Ok(Some(MissionBoundLoopOutcome::Blocked { blockers }))
            }
        }
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

    /// SESSION-SCOPED memory-recall preamble — the recall axis ALIGNED with how the
    /// sessioned loop's post-run extraction STORES candidates. Closes the storage↔recall
    /// key MISALIGNMENT: [`crate::memory_extraction::extract_inline`] keys a candidate's
    /// `principal_id` on the COMPOSITE memory namespace
    /// (`tenant.<account>.channel.<channel>.user.<user>.shared`) DERIVED from the session
    /// OWNER, so recall must read under that SAME composite namespace — NOT the raw
    /// `--owner` string [`Self::recall_preamble`] uses. Before this, a sessioned run stored
    /// under the composite namespace but recalled under the raw owner ⇒ a confirmed
    /// candidate was NEVER recalled.
    ///
    /// It derives the namespace from the EXACT same inputs extraction uses, so the two keys
    /// are byte-aligned for every session shape (direct userId, DM-chatId fallback, subagent
    /// parent-walk, non-default account/channel):
    ///   1. [`friday_storage::agent_session::load_session_owner`] — the session's owner axes.
    ///   2. [`crate::session_namespace::resolve_effective_user_id`] — the TS
    ///      `resolveEffectiveUserId` port (direct → DM-chatId → subagent parent-walk).
    ///   3. [`crate::session_namespace::resolve_session_memory_namespace_candidates`] — the
    ///      ORDERED dual-read namespace list (`[hardened, legacy]` under F5.5, or a single
    ///      legacy namespace by default) → [`crate::recall_preamble_for_principals`] →
    ///      [`friday_storage::memory::recall_confirmed_multi`].
    ///
    /// NO CROSS-OWNER LEAK (the binding constraint): every candidate namespace encodes the
    /// session's OWN user/principal segment and the per-principal SQL stays exact-match, so a
    /// different owner's session can never recall this owner's rows. The list is the SAME
    /// session's dual-read candidates, NEVER a cross-owner set, and there is NO fallback to
    /// the raw `--owner` principal (composite-or-nothing — a raw fallback would be the leak).
    ///
    /// FAIL-CLOSED, ASYMMETRIC WITH EXTRACTION: an UNRESOLVABLE namespace (no derivable
    /// userId) or an ABSENT session owner ⇒ EMPTY preamble (recall NOTHING), NOT an error.
    /// This is deliberately asymmetric with extraction (which Errs fail-closed — storing
    /// under a wrong scope is dangerous): reading nothing is the safe fail-closed shape, and
    /// the sessioned caller maps a recall `Err` to `NoAnswer`, so erroring here would KILL
    /// runs that currently proceed (a regression). A real storage error (locked/corrupt DB)
    /// from `load_session_owner` / `recall_confirmed_multi` still PROPAGATES (never swallowed
    /// as "no owner").
    fn recall_preamble_for_session(
        &self,
        session_id: &str,
        run_id: &str,
        now_ms: i64,
    ) -> Result<String, RoutedLoopError> {
        // Load the session's owner axes (same source extraction uses). An absent session row
        // ⇒ no owner ⇒ unresolvable ⇒ empty recall. A real storage error PROPAGATES.
        let owner =
            match friday_storage::agent_session::load_session_owner(self.db.conn(), session_id)? {
                Some(owner) => owner,
                // No session row yet ⇒ nothing stored under any namespace ⇒ recall nothing.
                None => return Ok(String::new()),
            };
        // Resolve the EFFECTIVE userId (direct → DM-chatId → subagent parent-walk) exactly as
        // extraction does. A `lookup` storage error PROPAGATES; an underivable userId yields
        // `None`, which the candidates resolver below turns into the unresolvable (empty) case.
        let effective_user_id =
            crate::session_namespace::resolve_effective_user_id(&owner, &mut |key: &str| {
                friday_storage::agent_session::load_session_owner(self.db.conn(), key)
            })?;
        // The ORDERED dual-read candidate namespaces (the SAME resolver inputs extraction's
        // write keyed on). An UNRESOLVABLE namespace (no userId) ⇒ EMPTY preamble, NOT an Err
        // — recall reads nothing, never the raw owner, never a broad match (fail-closed).
        let candidates = match crate::session_namespace::resolve_session_memory_namespace_candidates(
            owner.account_id.as_deref(),
            owner.channel.as_deref(),
            effective_user_id.as_deref(),
        ) {
            Ok(c) => c,
            Err(crate::session_namespace::NamespaceError::UnresolvableNoUserId) => {
                return Ok(String::new())
            }
        };
        let principal_refs: Vec<&str> = candidates.iter().map(String::as_str).collect();
        let preamble = crate::recall_preamble_for_principals(
            &self.db,
            &principal_refs,
            &format!("{run_id}:memory-recall"),
            now_ms,
        )?;
        Ok(preamble)
    }

    /// Read access to the composed DB (for evidence/inspection: agent_run events, audit chain).
    pub fn db(&self) -> &Db {
        &self.db
    }

    /// (C2-4) OWNER-SCOPED list of the FRIDAY routed agent_sessions owned by `caller` —
    /// the sessions [`Self::run_session_task_pinned`] populates (which carry REAL provider
    /// `token_ledger` rows, e.g. an `anthropic` row per Claude turn). Scopes on the SAME
    /// authenticated principal the sessioned entry binds the session owner to (NEVER a
    /// client-asserted id), so a caller sees ONLY their own sessions — a different principal's
    /// list is EMPTY (INV-5/INV-7 fail-closed). Most-recently-active first.
    ///
    /// This reads the routed sessions DELIBERATELY, NOT the `provider_session_link`
    /// claude_control mirror (`Db::list_provider_session_projections`) — that local mirror
    /// has no owner axis and no real billing, so surfacing it here would be a fake. ADDITIVE,
    /// read-only accessor: no write, no live behavior change.
    pub fn list_sessions_for_owner(
        &self,
        caller: &AuthedPrincipal,
    ) -> Result<Vec<friday_storage::SessionListItem>, StorageError> {
        friday_storage::list_sessions_for_owner(self.db.conn(), caller.principal())
    }

    /// (C2-4) OWNER-SCOPED open/read of one routed session's folded user/assistant transcript:
    /// `Some(messages)` ONLY when `caller` owns `agent_session_id`, else `None`. The
    /// fail-closed open half — a guessed session id cannot bypass the owner check (a non-owner,
    /// an owner-less session, and an absent id all read back `None`). ADDITIVE, read-only.
    pub fn open_session_for_owner(
        &self,
        caller: &AuthedPrincipal,
        agent_session_id: &str,
    ) -> Result<Option<Vec<friday_storage::StoredSessionMessage>>, StorageError> {
        friday_storage::open_session_for_owner(self.db.conn(), caller.principal(), agent_session_id)
    }

    /// (C2-6) EXPLICIT owner-authed ARCHIVE of one routed session: set `status='archived'` +
    /// `archived_at` and write a hash-chained audit receipt, scoped to the AUTHENTICATED `caller`
    /// (the SAME `agent_session.user_id` axis as [`Self::open_session_for_owner`], NEVER a
    /// client-asserted id). Only the bound owner can archive — a non-owner / owner-less session /
    /// absent id is REFUSED fail-closed ([`friday_storage::ArchiveOutcome`] `accepted=false`,
    /// `status="not_owner"`) with NO state change and NO audit row. Idempotent: re-archiving an
    /// already-archived session is an accepted no-op.
    ///
    /// This is the EXPLICIT counterpart to the time-based `session_lifecycle` sweep (which archives
    /// only after the idle timeout) — it never invokes the sweep, and writes only the lifecycle
    /// columns the sweep also uses, so an explicitly-archived session reads back identically to a
    /// swept one. Metadata-only: NO model call and NO `token_ledger` row (archiving is not a metered
    /// turn). After a successful archive the session no longer appears in
    /// [`Self::list_sessions_for_owner`] (the active/owner list is archive-aware). ADDITIVE accessor.
    pub fn archive_session_for_owner(
        &self,
        caller: &AuthedPrincipal,
        agent_session_id: &str,
        now_ms: i64,
    ) -> Result<friday_storage::ArchiveOutcome, StorageError> {
        friday_storage::archive_session_for_owner(
            self.db.conn(),
            caller.principal(),
            agent_session_id,
            now_ms,
        )
    }

    /// (C2-7) EXPLICIT owner-authed FORK of one routed session: create a NEW owned session
    /// (fresh id, `forked_from` = the parent id, bound to the AUTHENTICATED `caller` — the SAME
    /// `agent_session.user_id` axis as [`Self::open_session_for_owner`], NEVER a client-asserted
    /// id) seeded with a COPY of the parent's messages, and write a hash-chained audit receipt.
    /// Only the bound owner can fork — a non-owner / owner-less parent / absent parent id is
    /// REFUSED fail-closed ([`friday_storage::ForkOutcome`] `accepted=false`, `status="not_owner"`)
    /// with NO child created, NO message copied, and NO audit row.
    ///
    /// Metadata-only: the fork makes NO model call and writes NO `token_ledger` row (forking is
    /// not a metered turn). A LATER turn on the forked session (via [`Self::run_session_task_pinned`])
    /// routes + bills its OWN row exactly like any routed session, so the fork is a REAL branch of a
    /// metered session — never a synthesized/mirror clone of a `provider_session_link` claude_control
    /// link. ADDITIVE accessor.
    pub fn fork_session_for_owner(
        &self,
        caller: &AuthedPrincipal,
        parent_session_id: &str,
        now_ms: i64,
    ) -> Result<friday_storage::ForkOutcome, StorageError> {
        friday_storage::fork_session_for_owner(
            self.db.conn(),
            caller.principal(),
            parent_session_id,
            now_ms,
        )
    }

    /// (C2-8) OWNER-GATED refs-only LINK-STATE projection for one routed session: the
    /// connectivity/staleness label (`fresh`/`stale`/`offline`) DERIVED from the session's
    /// last-activity timestamp (`agent_session.updated_at`, which the metered turn's folded
    /// `append_session_message` bumps) vs the injected `now_ms`. `Some(snapshot)` ONLY when
    /// `caller` owns `agent_session_id`, else `None` (fail-closed — a non-owner cannot read
    /// another's link-state by guessing the id; the SAME owner axis as
    /// [`Self::open_session_for_owner`]). DARK / pure clock-driven compute: no model call, no
    /// ledger row, no write — the state keys off the REAL routed session's activity, never a
    /// claude_control mirror heartbeat. ADDITIVE, read-only accessor.
    pub fn project_session_link_state(
        &self,
        caller: &AuthedPrincipal,
        agent_session_id: &str,
        now_ms: i64,
    ) -> Result<Option<serde_json::Value>, String> {
        crate::run_readback_projection::project_session_link_state(
            &self.db,
            caller.principal(),
            agent_session_id,
            now_ms,
        )
    }

    /// (C2-5) OWNER-GATED refs-only FILE-VIEW for one run: the workspace file refs the run's
    /// `read_file` tool receipts recorded, keyed to `run_id`. `Some(snapshot)` ONLY when `caller`
    /// is the run's bound OWNER, else `None` (fail-closed — a non-owner cannot read another's
    /// file-view by guessing the run_id; the SAME owner axis as [`Self::open_session_for_owner`]
    /// and the D1-Q1 answer-body projection). The file refs are anchored to the REAL
    /// `read_file` receipt of a metered turn (a claude turn proposing `read_file` bills an
    /// `anthropic` row AND co-commits the receipt event) — never a synthesized/mirror file event.
    /// Class-2 read: no model call, no ledger row, no write. ADDITIVE, read-only accessor.
    pub fn file_view_for_owner(
        &self,
        caller: &AuthedPrincipal,
        run_id: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        crate::run_readback_projection::project_run_file_view(&self.db, caller.principal(), run_id)
    }

    /// (C2-9) OWNER-SCOPED Activity / Needs-Me projection for one PAUSED, claude-pinned run: the
    /// run's `AskReceipt` activity rows (one per metered turn) PLUS a Needs-Me item surfacing the
    /// pending operator approval the run Paused on. `Some(snapshot)` ONLY when `caller` is the
    /// paused run's bound OWNER, else `None` (fail-closed — a non-owner cannot read another's
    /// activity by guessing the run_id). Scopes on `caller.principal()`, NEVER a client-asserted id.
    ///
    /// The owner axis is the paused run's pending-row principal (`resolve_run_owner`), NOT the
    /// C2-4/C2-5 `get_run_answer_for_principal` gate — a paused run has no `run_result` for that
    /// gate to key on, so the SAME owner concept is taken from the pending approval row (the SAME
    /// source the owner-authed `reject`/`cancel` control ops gate on). The Needs-Me item is anchored
    /// to a REAL `pending_approval_request` via `detect_pause` and the AskReceipts to REAL metered
    /// turns via `Db::list_activity` — never a synthesized inbox entry. Class-2 read: no model call,
    /// no ledger row, no write. ADDITIVE, read-only accessor.
    pub fn activity_needs_me_for_owner(
        &self,
        caller: &AuthedPrincipal,
        run_id: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        crate::run_readback_projection::project_activity_needs_me(
            &self.db,
            caller.principal(),
            run_id,
        )
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
        //
        // C1-3 — then the DARK Codex route, behind its OWN default-OFF gate
        // (`FRIDAY_CODEX_ROUTE_ENABLED`). Codex attach is INFALLIBLE (it reads no credential —
        // the local app-server is spawned lazily, per-turn / at validate), so it chains after
        // the fallible Claude attach without its own `?`.
        Ok(runtime
            .maybe_attach_claude_from_env()?
            .maybe_attach_codex_from_env())
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

    /// C1 PR-B — read the default-OFF Codex gate and, only when it is on, build the live Codex
    /// EXECUTOR (a [`crate::LocalCodexGatedTurnExecutor`]) and attach it (DARK). This is the
    /// REWIRE: the retired "brain" [`crate::CodexAgentLlmClient`] (which drove the conn-less
    /// `run_text_turn` and Friday-side re-executed) is NO LONGER wired into the live route —
    /// the executor drives [`crate::codex_gated_turn::run_codex_gated_turn`] instead, the
    /// CORRECT model (the brain type is kept only for its deterministic in-crate tests). MIRRORS
    /// [`Self::maybe_attach_claude_from_env`]'s dark discipline, with ONE divergence: this is
    /// INFALLIBLE (`-> Self`, not `Result`). Codex reads NO credential at attach — the local
    /// app-server is spawned lazily (per turn, and at [`Self::validate_and_enable_codex`]) — so
    /// there is no "gate ON + missing credential = hard boot error" analog of the Claude path.
    /// A missing/empty gate ⇒ OFF ⇒ unchanged. Even when the gate is on, the `codex` route is
    /// promoted `available: true` in THIS runtime only; `validation_ok` STAYS false until
    /// `validate_and_enable_codex()` succeeds, so a gated boot is fail-closed (spawns nothing).
    fn maybe_attach_codex_from_env(self) -> Self {
        if !codex_route_enabled_from_env() {
            return self;
        }
        // Gate is ON: build the real Codex executor over the production per-turn app-server
        // (no credential read here — the spawn is lazy). `cwd: None` lets the app-server
        // default; the model id matches the `codex` route (`gpt-5-codex`).
        let executor = crate::LocalCodexGatedTurnExecutor::new(
            CODEX_APP_SERVER_PROGRAM,
            CODEX_CLIENT_NAME,
            CODEX_CLIENT_VERSION,
            None,
            CODEX_ROUTE_MODEL,
        );
        let mut me = self.with_codex(Box::new(executor));
        // (C1-3) Promote the codex route to `available: true` in THIS runtime's IN-PROCESS
        // registry ONLY (the autonomous baseline stays `available: false` — prod default
        // unchanged). Gated-only: reached solely because the default-OFF
        // `FRIDAY_CODEX_ROUTE_ENABLED` gate is on. `validation_ok` STAYS false here, so the
        // route is NOT dispatchable until `validate_and_enable_codex()` runs the creds-light
        // app-server health_check — a gated boot spawns no app-server.
        me.mark_route_available("codex");
        me
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

/// C1-3 — the default-OFF environment gate that governs whether [`HubRuntime::live`] wires
/// the DARK Codex route. MIRRORS [`ENV_CLAUDE_ROUTE_ENABLED`]: ON only when
/// `FRIDAY_CODEX_ROUTE_ENABLED` is exactly `"1"` (after trimming). UNSET / empty / `"0"` / any
/// other value ⇒ OFF (unchanged prod default). Kept narrow + explicit so the dark path cannot
/// be enabled by accident.
pub const ENV_CODEX_ROUTE_ENABLED: &str = "FRIDAY_CODEX_ROUTE_ENABLED";

fn codex_route_enabled_from_env() -> bool {
    matches!(std::env::var(ENV_CODEX_ROUTE_ENABLED), Ok(v) if v.trim() == "1")
}

/// NS-6 — the default-OFF environment gate that governs whether the mission-bound agent
/// handoff MINTS + PERSISTS + LINKS a destination-bound Context Passport for the WorkItem's
/// lane/target. ON only when `FRIDAY_PASSPORT_MINT` is exactly `"1"` (after trimming). UNSET /
/// empty / `"0"` / any other value ⇒ OFF (unchanged prod default: the handoff is BYTE-IDENTICAL
/// to the pre-NS-6 baseline — no passport minted, no extra query, no new mission_link). Kept
/// narrow + explicit so this security-sensitive run-path change cannot be enabled by accident.
pub const ENV_PASSPORT_MINT: &str = "FRIDAY_PASSPORT_MINT";

/// Pure flag-matcher for [`ENV_PASSPORT_MINT`] (env read split out so it is unit-testable
/// without `set_var` — the env-race-free idiom this file uses, mirroring NS-7's
/// `activity_needs_me_from`). DEFAULT-OFF: `None` (unset) ⇒ false; ON only for the exact
/// opt-in value `"1"` (trimmed); everything else ⇒ false.
fn passport_mint_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// (WI-1, M-6) Env var for the DARK WorkItem guarded-transition flag. Default-OFF. When ON, a
/// mission-bound run's WorkItem status advance is routed through the canonical guarded primitive
/// `friday_storage::Db::transition_work_item_status` so each transition also writes a
/// hash-chained `audit_ledger` lifecycle row atomically. Flag-OFF is byte-identical to the
/// pre-WI-1 inline status-advance write (no primitive call, no audit row).
pub const ENV_WORKITEM_GUARDED_TRANSITION: &str = "FRIDAY_WORKITEM_GUARDED_TRANSITION";

/// Pure flag-matcher for [`ENV_WORKITEM_GUARDED_TRANSITION`] (env read split out so it is
/// unit-testable without `set_var` — the program-standard env-race-free idiom this file uses).
/// DEFAULT-OFF: `None` (unset) ⇒ false; ON only for the exact opt-in value `"1"` (trimmed);
/// everything else ⇒ false.
fn workitem_guarded_transition_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// (NS8-WIRE-1, Loop5) The default-OFF env gate that fires POST-RUN session-memory extraction
/// from the LIVE sessioned run loop — the missing TRIGGER for the Memory closed loop. When ON,
/// a `Finished` sessioned run, AFTER its owner-gated answer is bound + projected, fires the
/// existing producer [`crate::memory_extraction::extract_inline`] for the session (the result is
/// DISCARDED — see [`HubRuntime::maybe_extract_memory_post_run`]). ON only when
/// `FRIDAY_RUN_LOOP_MEMORY_EXTRACTION` is exactly `"1"` (after trimming). UNSET / empty / `"0"` /
/// any other value ⇒ OFF (unchanged prod default: the run is BYTE-IDENTICAL to today — no
/// extraction call, no extra query, no provider call). Kept narrow + explicit so this run-path
/// change cannot be enabled by accident.
pub const ENV_RUN_LOOP_MEMORY_EXTRACTION: &str = "FRIDAY_RUN_LOOP_MEMORY_EXTRACTION";

/// Pure flag-matcher for [`ENV_RUN_LOOP_MEMORY_EXTRACTION`] (env read split out so it is
/// unit-testable without `set_var` — the program-standard env-race-free idiom this file uses).
/// DEFAULT-OFF: `None` (unset) ⇒ false; ON only for the exact opt-in value `"1"` (trimmed);
/// everything else ⇒ false.
fn run_loop_memory_extraction_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// C1-3 — the local Codex app-server program the route spawns (default CLI binary on PATH).
/// Shared between the attach (`maybe_attach_codex_from_env`) and the creds-light validate
/// (`validate_and_enable_codex`) so both probe the SAME app-server.
const CODEX_APP_SERVER_PROGRAM: &str = "codex";
/// The client identity Friday presents on the Codex app-server `initialize` handshake. This
/// is a cosmetic identity string (reached only at a real validate-time spawn, never in tests);
/// `"0.0.1"` matches the `codex_appserver` health KAT's identity for consistency.
const CODEX_CLIENT_NAME: &str = "friday";
const CODEX_CLIENT_VERSION: &str = "0.0.1";
/// The model id the `codex` route bills against (matches the autonomous-baseline `codex`
/// route model). The Codex app-server `turn/completed` does not report a model, so the
/// adapter takes the route model from here.
const CODEX_ROUTE_MODEL: &str = "gpt-5-codex";

impl<T: Transport> ProviderClientResolver for HubRuntime<T> {
    /// The live `deepseek` provider always has a wired client. The `claude` provider has
    /// one ONLY when the DARK route was enabled (`self.claude` is `Some` — see
    /// [`HubRuntime::with_claude`] / [`HubRuntime::live`]'s `FRIDAY_CLAUDE_ROUTE_ENABLED`
    /// gate); when disabled (the default) it returns `None`. Any other route returns
    /// `None` → fail-closed `NoClientForProvider` (a defensive backstop; the route registry
    /// already prevents selecting unavailable providers — `claude`/`codex` are
    /// `available: false` in the baseline — so this never fires on the happy path).
    /// Routing decides WHO answers; classification stays the trusted chokepoint
    /// regardless — this resolver confers no classification authority.
    ///
    /// C1 PR-B: `codex` is DELIBERATELY ABSENT here — it is NOT a `dyn AgentLlmClient`. A codex
    /// route is SPECIAL-CASED in `run_with_request` (which drives the gated turn) BEFORE
    /// `resolve()` is reached, so this resolver never sees `"codex"`; if a future caller ever
    /// resolved a codex route here it correctly fail-closes via the `_ => None` arm
    /// (NoClientForProvider) rather than driving the WRONG conn-less path.
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

    // ── TP-PR2 (H-1): the live boot AgentActionContext PRODUCER ──────────────────────────
    //
    // TP-PR2 attaches a live `AgentActionContext` (agent_id = config.principal_id, workspace =
    // workspace_root, tool = None) at the boot RunPolicy so the default-OFF
    // `FRIDAY_TRUST_GRANT_ENFORCE` flag stops being a brick. These tests prove: (a) flag-OFF is
    // byte-identical whether the ctx is attached or not (the producer ships the ctx but the
    // chokepoint consumes it ONLY in the flag-gated enforce arm); (b) the produced ctx carries the
    // configured principal as `agent_id` (and NO ctx when principal is None); (c) the ctx survives
    // `tightened_by` / `effective_run_policy_over` verbatim; (d) flag-ON the producer makes the
    // flag satisfiable when a grant exists (and a no-grant flip Denies `trust_no_active_grant`).

    /// Build a runtime whose boot config binds a principal (so the producer attaches a ctx).
    fn runtime_with_principal(
        tag: &str,
        principal: Option<&str>,
    ) -> (HubRuntime<ScriptTransport>, TempDir) {
        let ws = TempDir::new(tag);
        let transport = ScriptTransport::new(&["{\"tool\":\"none\"}"]);
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 6,
                principal_id: principal.map(|p| p.to_string()),
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

    /// A `ToolExecutor` wrapper that counts `execute` calls — the no-hidden-side-effect probe
    /// (the byte-identical test compares the count with vs without the producer ctx).
    struct Tp2CountingExecutor<'a> {
        inner: &'a dyn crate::ToolExecutor,
        calls: Cell<usize>,
    }
    impl crate::ToolExecutor for Tp2CountingExecutor<'_> {
        fn execute(
            &self,
            action: &str,
            params: &[(String, String)],
        ) -> Result<crate::ToolReceipt, crate::ExecError> {
            self.calls.set(self.calls.get() + 1);
            self.inner.execute(action, params)
        }
    }

    /// The owner-approval seam withholding every approval (so a mutating action's existing
    /// step-(2) decision is RequiresApproval, not Allow — proving the trust producer never
    /// upgrades it).
    fn tp2_no_approval() -> impl Fn(&MutatingActionRequest) -> Option<CanonicalApproval> {
        |_req| None
    }

    /// A mutating tool call (`write_file`) — the trust chokepoint's enforce arm is mutating-only,
    /// so this is the action that actually exercises the consumed `action_context()` path.
    fn tp2_write() -> crate::RawToolCall {
        crate::RawToolCall {
            action: "write_file".to_string(),
            params: vec![
                ("path".to_string(), "out.txt".to_string()),
                ("content".to_string(), "X".to_string()),
            ],
        }
    }

    /// An UNSCOPED within-boundaries grant for `principal`: `write_file` allowed, NO workspace
    /// boundary (so the producer's populated `ctx.workspace` cannot deny on the workspace
    /// dimension — this test isolates SATISFIABILITY, not the workspace-prefix arm), a Critical
    /// risk ceiling. The sole authority gate is the grant's existence + tool allowlist.
    fn tp2_grant_allows_write(principal: &str) -> friday_core::TrustGrant {
        friday_core::TrustGrant {
            grant_id: "g-tp2-write".to_string(),
            agent_id: principal.to_string(),
            granted_at: 1,
            expires_at: None,
            revoked: false,
            revoked_at: None,
            boundaries: friday_core::TrustBoundaries {
                workspace: None,
                risk_ceiling: friday_core::Risk::Critical,
                token_ceiling: None,
                max_runs: None,
                allowed_channels: vec![],
                allowed_providers: vec![],
                allowed_tools: vec!["write_file".to_string()],
                allowed_workflow_families: vec![],
                allowed_skill_families: vec![],
            },
        }
    }

    #[test]
    fn tp2_producer_attaches_ctx_with_configured_principal_and_workspace() {
        // (b) The boot policy's action_context() is Some, agent_id == config.principal_id,
        // workspace == the boot workspace root, tool == None (enriched per-action by TP-PR1),
        // and every per-ingress dim is None (the named follow-up).
        let (rt, ws) = runtime_with_principal("tp2-attach", Some("friday-owner"));
        let ctx = rt
            .policy()
            .action_context()
            .expect("the producer attaches a ctx when a principal is configured");
        assert_eq!(
            ctx.agent_id, "friday-owner",
            "agent_id must be the configured principal (the bound owner / --owner allowlist entry)"
        );
        assert_eq!(
            ctx.workspace.as_deref(),
            Some(ws.0.to_string_lossy().as_ref()),
            "workspace must be the boot workspace root so a workspace-scoped grant is satisfiable"
        );
        assert_eq!(
            ctx.tool, None,
            "tool is enriched per-action at the chokepoint (TP-PR1), not at boot"
        );
        assert_eq!(ctx.provider, None);
        assert_eq!(ctx.channel, None);
        assert_eq!(ctx.workflow_family, None);
        assert_eq!(ctx.skill_family, None);
    }

    #[test]
    fn tp2_producer_attaches_no_ctx_when_principal_is_none() {
        // (b) No owner ⇒ no authority ⇒ NO context. Under flag-ON the chokepoint's None-arm
        // correctly Denies every mutating action (verified behaviorally in `tp2_flag_*` below).
        let (rt, _ws) = runtime_with_principal("tp2-noprincipal", None);
        assert_eq!(
            rt.policy().action_context(),
            None,
            "no configured principal ⇒ no attached context (no owner, no authority)"
        );
    }

    #[test]
    fn tp2_ctx_survives_tightened_by_and_effective_run_policy_over() {
        // (2) A per-run A1 constraint restricts WHAT a run may do, NEVER its identity/context —
        // the producer's owner context must survive policy tightening verbatim.
        let (rt, _ws) = runtime_with_principal("tp2-tighten", Some("friday-owner"));
        let boot = rt.policy();
        let attached = boot
            .action_context()
            .expect("producer attached the boot ctx")
            .clone();

        // Direct `tightened_by`.
        let tightened = boot.tightened_by(true, &["delete_file".to_string()]);
        assert_eq!(
            tightened.action_context(),
            Some(&attached),
            "tightening must preserve the producer's action context verbatim"
        );
        assert!(tightened.is_read_only(), "the tightening added read_only");

        // The live-dispatch composition entry the WS arm uses.
        let constraints = friday_protocol::AgentRunConstraintsWire {
            read_only: true,
            disabled_tools: vec!["delete_file".to_string()],
            max_turns: None,
        };
        let composed =
            crate::agent_run_control::effective_run_policy_over(boot, Some(&constraints));
        assert_eq!(
            composed.action_context(),
            Some(&attached),
            "effective_run_policy_over must preserve the producer's action context verbatim"
        );
        // And the None-constraints clone path preserves it too.
        let cloned = crate::agent_run_control::effective_run_policy_over(boot, None);
        assert_eq!(cloned.action_context(), Some(&attached));
    }

    #[test]
    fn tp2_flag_off_is_byte_identical_ctx_attached_vs_absent() {
        // (1) HARD INVARIANT: with FRIDAY_TRUST_GRANT_ENFORCE OFF, a run whose policy carries the
        // producer's ctx behaves BYTE-IDENTICALLY to one without it — same gate verdict AND same
        // side-effects — on a MUTATING action (a read never reaches the trust arm, so the mutating
        // action is what actually exercises the consumed action_context() path). The trust
        // chokepoint consumes action_context() ONLY in the `enforce_trust && mutating()` arm, so
        // flag-OFF skips it entirely.
        use crate::{AuthzMode, GateDispatch};

        // WITH the producer ctx (principal configured ⇒ ctx attached).
        let (rt_with, ws_with) = runtime_with_principal("tp2-off-with", Some("friday-owner"));
        assert!(
            rt_with.policy().action_context().is_some(),
            "sanity: the producer attached a ctx"
        );
        let fs_with = FsToolExecutor::new(ws_with.0.clone());
        let exec_with = Tp2CountingExecutor {
            inner: &fs_with,
            calls: Cell::new(0),
        };
        let approve = tp2_no_approval();
        let out_with = crate::gate_dispatch_with_policy_enforced(
            rt_with.db().conn(),
            &exec_with,
            &tp2_write(),
            AuthzMode::DenyAll,
            &approve,
            rt_with.policy(),
            1000,
            false, // flag OFF
        )
        .unwrap();

        // WITHOUT the ctx — same boot config but a policy with NO action context. We build a
        // matching policy directly (same principal, same restrictions) sans the attach.
        let (rt_without, ws_without) =
            runtime_with_principal("tp2-off-without", Some("friday-owner"));
        let policy_no_ctx = RunPolicy::new(
            Some("friday-owner".to_string()),
            Vec::<String>::new(),
            false,
        );
        assert_eq!(
            policy_no_ctx.action_context(),
            None,
            "sanity: the comparison policy carries NO context"
        );
        let fs_without = FsToolExecutor::new(ws_without.0.clone());
        let exec_without = Tp2CountingExecutor {
            inner: &fs_without,
            calls: Cell::new(0),
        };
        let out_without = crate::gate_dispatch_with_policy_enforced(
            rt_without.db().conn(),
            &exec_without,
            &tp2_write(),
            AuthzMode::DenyAll,
            &approve,
            &policy_no_ctx,
            1000,
            false, // flag OFF
        )
        .unwrap();

        // Identical gate verdict (both Denied with the SAME reason — DenyAll Pauses the mutating
        // write the same way regardless of the carried-but-unconsumed ctx).
        match (&out_with, &out_without) {
            (GateDispatch::Denied(a), GateDispatch::Denied(b)) => {
                assert_eq!(
                    a, b,
                    "flag-OFF: identical Denied reason with vs without the ctx"
                )
            }
            (GateDispatch::Executed(_), GateDispatch::Executed(_)) => {}
            (GateDispatch::RequiresApproval, GateDispatch::RequiresApproval) => {}
            _ => panic!(
                "flag-OFF must yield the SAME GateDispatch variant with vs without the producer ctx"
            ),
        }
        // Identical side-effects: the executor was reached the same number of times.
        assert_eq!(
            exec_with.calls.get(),
            exec_without.calls.get(),
            "flag-OFF: identical executor-call count (no extra side-effect from the carried ctx)"
        );
    }

    #[test]
    fn tp2_flag_on_makes_flag_satisfiable_with_grant_and_bricks_without() {
        // (d) The PRODUCER PURPOSE: with the flag ON, the producer's boot ctx makes the trust
        // check SATISFIABLE when a grant exists — and a flip WITHOUT a grant Denies
        // `trust_no_active_grant` (the brick is runtime STATE, by design fail-closed). We drive
        // the chokepoint with the REAL produced ctx (`rt.policy()`), not a hand-built one.
        use crate::{AuthzMode, GateDispatch};
        let approve = tp2_no_approval();

        // -- No grant ⇒ Denied trust_no_active_grant (the fail-closed brick; correct by design).
        let (rt_brick, ws_brick) = runtime_with_principal("tp2-on-brick", Some("friday-owner"));
        let fs_brick = FsToolExecutor::new(ws_brick.0.clone());
        let exec_brick = Tp2CountingExecutor {
            inner: &fs_brick,
            calls: Cell::new(0),
        };
        let brick = crate::gate_dispatch_with_policy_enforced(
            rt_brick.db().conn(),
            &exec_brick,
            &tp2_write(),
            AuthzMode::DenyAll,
            &approve,
            rt_brick.policy(), // the REAL produced ctx
            1000,
            true, // flag ON
        )
        .unwrap();
        match brick {
            GateDispatch::Denied(reason) => assert_eq!(
                reason, "trust_no_active_grant",
                "flag-ON + no grant ⇒ fail-closed Deny (brick is runtime state, by design)"
            ),
            _ => panic!("expected the no-grant fail-closed Deny, got a non-Deny dispatch"),
        }
        assert_eq!(
            exec_brick.calls.get(),
            0,
            "no executor call on the fail-closed brick"
        );

        // -- A seeded grant for the SAME principal ⇒ the flag is SATISFIABLE (the trust layer
        //    raises no objection, so we fall through to the unchanged step (2) — NOT a
        //    trust_grant Deny). The producer's ctx supplied the agent_id that loaded the grant.
        let (rt_ok, ws_ok) = runtime_with_principal("tp2-on-ok", Some("friday-owner"));
        friday_storage::grant_trust(
            rt_ok.db().conn(),
            &tp2_grant_allows_write("friday-owner"),
            1,
        )
        .unwrap();
        let fs_ok = FsToolExecutor::new(ws_ok.0.clone());
        let exec_ok = Tp2CountingExecutor {
            inner: &fs_ok,
            calls: Cell::new(0),
        };
        let ok = crate::gate_dispatch_with_policy_enforced(
            rt_ok.db().conn(),
            &exec_ok,
            &tp2_write(),
            AuthzMode::DenyAll,
            &approve,
            rt_ok.policy(), // the REAL produced ctx
            1000,
            true, // flag ON
        )
        .unwrap();
        // Satisfiable = the trust layer did NOT brick it. Under DenyAll + no approval the
        // unchanged step (2) Pauses the mutating write — the key point is it is NOT a
        // trust_grant Deny (so a grant makes the flag non-brick). It must never be the
        // trust_no_active_grant / any trust_grant_* Deny.
        // A RequiresApproval / Executed both mean the trust layer let it through (satisfiable);
        // only a Deny needs scrutiny — it must NOT be a trust_* Deny.
        if let GateDispatch::Denied(reason) = ok {
            assert!(
                !reason.starts_with("trust_"),
                "with a matching grant the trust layer must NOT object \
                 (got a trust Deny: {reason}) — the producer makes the flag satisfiable"
            );
        }
    }

    #[test]
    fn tp2_workspace_scoped_grant_passes_because_ctx_carries_the_root() {
        // (d, workspace dimension) The REASON the producer sets `ctx.workspace`: a grant scoped
        // to the hub's workspace ROOT must PASS the `check_grant` workspace-prefix arm. With
        // `ctx.workspace == None` this same grant would DENY `trust_grant_workspace_out_of_scope`
        // (trust.rs: the `_ => deny` arm fires when a workspace-scoped grant meets a None path).
        // This proves the populated dim is not just present but FUNCTIONAL — and guards against a
        // trailing-slash / format mismatch between `workspace_root` and the grant prefix that
        // would otherwise silently brick a workspace-scoped grant.
        //
        // Granularity (documented): the dimension confines at RUN-ROOT level — the grant prefix
        // must CONTAIN the hub's `workspace_root` (root-or-broader). A grant scoped NARROWER than
        // the root denies fail-closed; per-file-path confinement is `FsToolExecutor`, not this.
        use crate::{AuthzMode, GateDispatch};
        let approve = tp2_no_approval();

        let (rt, ws) = runtime_with_principal("tp2-ws-scoped", Some("friday-owner"));
        let root = ws.0.to_string_lossy().into_owned();
        // The producer attached exactly this root as `ctx.workspace`.
        assert_eq!(
            rt.policy().action_context().unwrap().workspace.as_deref(),
            Some(root.as_str()),
            "sanity: the producer attached the workspace root"
        );
        // A grant scoped to the SAME root, allowing write_file (so the SOLE gate that could fire
        // is the workspace-prefix arm).
        let mut grant = tp2_grant_allows_write("friday-owner");
        grant.boundaries.workspace = Some(root.clone());
        friday_storage::grant_trust(rt.db().conn(), &grant, 1).unwrap();

        let fs = FsToolExecutor::new(ws.0.clone());
        let exec = Tp2CountingExecutor {
            inner: &fs,
            calls: Cell::new(0),
        };
        let out = crate::gate_dispatch_with_policy_enforced(
            rt.db().conn(),
            &exec,
            &tp2_write(),
            AuthzMode::DenyAll,
            &approve,
            rt.policy(), // the REAL produced ctx — carries the workspace root
            1000,
            true, // flag ON
        )
        .unwrap();
        // The workspace dimension PASSED (the produced root matches the grant prefix): the trust
        // layer raises NO objection, so we fall through to step (2). It must NOT be the
        // workspace-out-of-scope Deny (nor any other trust_* Deny).
        if let GateDispatch::Denied(reason) = out {
            assert!(
                !reason.starts_with("trust_"),
                "a grant scoped to the producer's workspace root must NOT deny on the workspace \
                 dimension (got a trust Deny: {reason}) — the populated ctx.workspace is what makes \
                 a workspace-scoped grant satisfiable"
            );
        }
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

    // ---- C2-3: control-op binding to a claude-pinned+metered run (DARK, deterministic) -------
    //
    // A dedicated child module of `mod tests` so it inherits `super::*` (StubClaudeMeteredClient /
    // tmp / TempDir / SECRET / DenyAllApprovals / the route-promotion helpers) while keeping the
    // C2-3 binding tests cleanly grouped and `cargo test c2_control`-selectable.
    mod c2_control {
        use super::*;

        // C2-3 closes the routed_claude_parity.rs "approve / reject / resume … WIRING NEEDED"
        // DEFERRED note for the reject + cancel ops: it proves the EXISTING control substrate
        // (`agent_run_control::{reject, cancel}`) acts on a genuinely CLAUDE-PINNED + METERED run
        // (the one `claude_mutating_turn_bills_anthropic_row_then_pauses_for_approval` produces — a
        // claude turn that bills EXACTLY ONE anthropic row, then Pauses on a pending approval) and
        // that each control op records its OWN audit receipt while minting NO new model turn.
        //
        // THE ANTI-FAKE ("NO new anthropic row"). approve/reject/resume/cancel are Class-2 control
        // mechanics layered on top of an ALREADY-metered claude turn — they are NEVER themselves
        // metered. So after each control op these tests assert the run's token ledger is BYTE-FOR-BYTE
        // (`RunTokenUsageRow` is `PartialEq`) the same single proposing-turn anthropic row it was
        // BEFORE the op — not merely the same length — AND that the WHOLE ledger still has exactly one
        // row (no hidden, non-run-scoped call). A control op that silently minted a model turn would
        // add a row and fail here.
        //
        // SCOPE / honesty. reject (a) + cancel (c) are proven DETERMINISTICALLY here (no key, no
        // network): they carry no operator signature, so they need only the run's bound OWNER. The
        // RESUME leg (b) needs BOTH a test-minted operator Ed25519 approval (forbidden in `src/**` by
        // the operator-signing-key self-mint source-scan — see `operator_vk.rs`) AND the crate-private
        // `mark_route_*` claude route-promotion (no public no-key route-enable exists — the dark
        // invariant), which cannot coexist in one file. Resume's faithful binding therefore lives as a
        // LIVE `#[ignore]`'d test in `tests/routed_claude_parity.rs`
        // (`resume_completes_claude_pinned_mutation_no_new_anthropic_row`), gated on the live model
        // genuinely Pausing on a mutation. Resume's deterministic execute-and-receipt is already proven
        // (just not on a metered run) by `tests/a1_run_control.rs::resume_executes_the_approved_mutation`.

        /// Build a claude-wired runtime BOUND to `owner` (`principal_id: Some(owner)`) so the paused
        /// run carries an owner principal — what the owner-authed control ops (`reject`/`cancel`)
        /// require. Otherwise identical to [`runtime_with_claude_wired`] (DARK Claude client +
        /// crate-private route promotion, no key/network). `operator_vk` stays `None` so a mutating
        /// turn Pauses fail-closed (the metered claude turn + a pending approval — the substrate the
        /// control op acts on).
        fn runtime_with_owned_claude_wired(
            tag: &str,
            owner: &str,
            steps: Vec<AgentStep>,
        ) -> (HubRuntime<ScriptTransport>, TempDir) {
            let ws = TempDir::new(tag);
            let transport = ScriptTransport::new(&["{\"tool\":\"none\"}"]);
            let client = DeepSeekClient::with_transport(transport, "k".into());
            let agent = DeepSeekAgentLlmClient::new(client);
            let mut rt = HubRuntime::new(
                HubConfig {
                    db_path: tmp(tag),
                    workspace_root: ws.0.clone(),
                    secret: SECRET.to_vec(),
                    max_turns: 6,
                    principal_id: Some(owner.to_string()),
                    disabled_tools: vec![],
                    read_only: false,
                    operator_vk: None, // fail-closed Pause on a mutating action (no auto-approve)
                },
                agent,
                Box::new(DenyAllApprovals),
            )
            .unwrap();
            rt = rt.with_claude(Box::new(StubClaudeMeteredClient::new(steps, 11, 8)));
            rt.mark_route_available("claude");
            rt.mark_route_validated("claude");
            (rt, ws)
        }

        /// Drive an OWNED, claude-pinned MUTATING turn to its Pause and assert the metered substrate the
        /// control op acts on is genuinely there: routed to claude, status `Paused`, EXACTLY ONE
        /// anthropic row, exactly one pending approval. Returns `(rt, ws, owner, nonce, ledger_before)`
        /// — `ledger_before` is the proposing-turn row(s) the anti-fake compares against after the op.
        fn paused_owned_claude_run(
            tag: &str,
            owner: &str,
            run_id: &str,
        ) -> (
            HubRuntime<ScriptTransport>,
            TempDir,
            String,
            Vec<friday_storage::RunTokenUsageRow>,
        ) {
            let (rt, ws) = runtime_with_owned_claude_wired(
                tag,
                owner,
                vec![AgentStep::Tool(crate::RawToolCall {
                    action: "write_file".to_string(),
                    params: vec![
                        ("path".to_string(), "out.txt".to_string()),
                        ("content".to_string(), "C2".to_string()),
                    ],
                })],
            );
            let (selection, outcome) = rt
                .run_task_pinned(run_id, "write a file", "claude", 2_000)
                .expect("pinned claude runs through the runtime");
            assert_eq!(selection.provider_id, "claude", "the pin routed to claude");
            assert_eq!(
                outcome.status,
                LoopStatus::Paused,
                "no operator key ⇒ the mutating action Pauses (RequiresApproval), never executes"
            );

            // The metered substrate: EXACTLY ONE anthropic row (the proposing claude turn was billed).
            let ledger_before = rt.db().list_run_token_usage(run_id).unwrap();
            assert_eq!(
                ledger_before.len(),
                1,
                "the proposing claude turn was billed exactly one row"
            );
            assert_eq!(ledger_before[0].provider_kind, "anthropic");
            assert_eq!(ledger_before[0].base_url_host, "api.anthropic.com");
            assert_eq!(ledger_before[0].model, friday_anthropic::DEFAULT_MODEL);
            assert!(!ledger_before[0].fallback);
            // Whole-ledger agreement: no hidden, non-run-scoped row exists.
            assert_eq!(rt.db().list_token_usage().unwrap().len(), 1);

            // Exactly one pending approval (the nonce the control op targets / the run paused on).
            let pending =
                friday_storage::list_pending_requests_for_run(rt.db().conn(), run_id).unwrap();
            assert_eq!(pending.len(), 1, "one pending approval recorded");
            let nonce = pending[0].approval_id.clone();
            assert_eq!(pending[0].status, "pending");

            (rt, ws, nonce, ledger_before)
        }

        /// THE ANTI-FAKE assertion: after a Class-2 control op the run's token ledger is BYTE-FOR-BYTE
        /// (`RunTokenUsageRow` is `PartialEq`) the `before` snapshot — the SAME single proposing-turn
        /// anthropic row, NO new row — and the WHOLE ledger still has exactly that one row. A control
        /// op that silently minted a model turn would add a row and fail here.
        fn assert_no_new_anthropic_row(
            rt: &HubRuntime<ScriptTransport>,
            run_id: &str,
            before: &[friday_storage::RunTokenUsageRow],
        ) {
            let after = rt.db().list_run_token_usage(run_id).unwrap();
            assert_eq!(
            after, before,
            "NO new anthropic row: the control op is Class-2 (never a metered model turn) — the \
             ledger must be byte-identical to the proposing-turn snapshot"
        );
            assert_eq!(
                rt.db().list_token_usage().unwrap().len(),
                1,
                "the whole ledger still has exactly the one proposing-turn row (no hidden call)"
            );
        }

        #[test]
        fn reject_on_claude_pinned_paused_run_records_receipt_no_new_anthropic_row() {
            // (a) REJECT a claude-pinned+metered paused run. The owner refuses the pending approval:
            // status flips to 'rejected', a control receipt is written, and — the anti-fake — NO new
            // anthropic row is billed (reject is Class-2 control mechanics, never a model turn).
            const OWNER: &str = "owner:c2-3-reject";
            const RUN: &str = "run-c2-3-reject";
            let (rt, _ws, nonce, ledger_before) =
                paused_owned_claude_run("c2-3-reject", OWNER, RUN);

            let r = crate::agent_run_control::reject(rt.db().conn(), RUN, &nonce, OWNER, 3_000)
                .unwrap();
            assert!(r.accepted, "the owner's reject is accepted");
            assert_eq!(r.status, "rejected", "the pending approval is now rejected");
            assert!(r.audit_ref.is_some(), "an accepted reject writes a receipt");

            // The pending row is genuinely 'rejected' (the substrate op ran, not a stub).
            assert_eq!(
                friday_storage::get_pending_request(rt.db().conn(), &nonce)
                    .unwrap()
                    .unwrap()
                    .status,
                "rejected"
            );
            // THE ANTI-FAKE: still EXACTLY the 1 proposing-turn anthropic row, byte-for-byte.
            assert_no_new_anthropic_row(&rt, RUN, &ledger_before);
        }

        #[test]
        fn cancel_on_claude_pinned_paused_run_records_receipt_no_new_anthropic_row() {
            // (c) CANCEL a claude-pinned+metered paused run. The owner terminally stops the run:
            // state='cancelled', a control receipt is written, and — the anti-fake — NO new anthropic
            // row is billed (cancel is Class-2 control mechanics, never a model turn).
            const OWNER: &str = "owner:c2-3-cancel";
            const RUN: &str = "run-c2-3-cancel";
            let (rt, _ws, _nonce, ledger_before) =
                paused_owned_claude_run("c2-3-cancel", OWNER, RUN);

            let r =
                crate::agent_run_control::cancel(rt.db().conn(), RUN, OWNER, Some("done"), 3_000)
                    .unwrap();
            assert!(r.accepted, "the owner's cancel is accepted");
            assert_eq!(r.status, "cancelled", "the run is terminally cancelled");
            assert!(r.audit_ref.is_some(), "an accepted cancel writes a receipt");

            // The run is genuinely cancelled (the substrate op ran, not a stub).
            assert!(agent_run::is_cancelled(rt.db().conn(), RUN).unwrap());
            // THE ANTI-FAKE: still EXACTLY the 1 proposing-turn anthropic row, byte-for-byte.
            assert_no_new_anthropic_row(&rt, RUN, &ledger_before);
        }

        #[test]
        fn reject_then_cancel_on_one_claude_pinned_run_never_bills_a_new_anthropic_row() {
            // The two Class-2 ops applied to the SAME claude-pinned+metered run, in sequence: reject
            // the pending approval, then cancel the run. After EACH op the ledger is re-asserted
            // byte-for-byte — neither control op ever mints a model turn. This is the strongest single
            // statement of the Class-2 invariant: a run accrues exactly the model rows its model turns
            // produced, and control mechanics layered on top add NONE.
            const OWNER: &str = "owner:c2-3-seq";
            const RUN: &str = "run-c2-3-seq";
            let (rt, _ws, nonce, ledger_before) = paused_owned_claude_run("c2-3-seq", OWNER, RUN);

            let r = crate::agent_run_control::reject(rt.db().conn(), RUN, &nonce, OWNER, 3_000)
                .unwrap();
            assert!(r.accepted && r.status == "rejected");
            assert_no_new_anthropic_row(&rt, RUN, &ledger_before);

            let r =
                crate::agent_run_control::cancel(rt.db().conn(), RUN, OWNER, None, 4_000).unwrap();
            assert!(r.accepted && r.status == "cancelled");
            assert_no_new_anthropic_row(&rt, RUN, &ledger_before);
        }

        // ---- C2-5: owner-gated file-view bound to a claude run's read_file receipt ------------
        #[test]
        fn c2_5_file_view_bound_to_a_claude_read_file_receipt_owner_gated() {
            // C2-5 FAITHFUL DARK PROOF. A claude-pinned SESSIONED run whose stub script proposes
            // `read_file` (a read-type tool the gate Allows directly inside the loop) → finish.
            //   - the read_file turn bills a REAL anthropic row (provider_kind=anthropic,
            //     api.anthropic.com, fallback=false) AND co-commits a `tool.executed:read_file`
            //     audit receipt + its run-keyed `tool.executed:read N bytes from <ref>` event;
            //   - the owner's file-view returns that file ref KEYED to the run;
            //   - reading the view writes NO new ledger row (it reads existing receipts);
            //   - a DIFFERENT principal's view is fail-closed `None` (owner-gated).
            // The file-view is anchored to the REAL receipt of the metered turn, NOT a mirror.
            // NO key, NO network — the claude stub bills the anthropic rows.
            const OWNER: &str = "principal:c2-5-owner";
            const RUN: &str = "run-c2-5";
            const SESS: &str = "sess-c2-5";

            // Build with HubConfig.principal_id = OWNER so the run's `run_result.owner_principal`
            // (set from `policy.principal_id()`) equals OWNER — the file-view's owner axis. The
            // authed caller below uses the SAME principal, so every owner axis agrees.
            let (rt, ws) = runtime_with_owned_claude_wired(
                "c2-5-file-view",
                OWNER,
                vec![
                    AgentStep::Tool(crate::RawToolCall {
                        action: "read_file".to_string(),
                        params: vec![("path".to_string(), "notes.md".to_string())],
                    }),
                    AgentStep::Finish {
                        message: "PONG".to_string(),
                    },
                ],
            );
            // Seed the workspace file so the gate-Allowed read_file EXECUTES (a missing path would
            // record `tool.exec_error`, not a receipt — see the storage parse contract).
            std::fs::write(ws.0.join("notes.md"), b"composed e2e note").unwrap();

            let owner = authed_caller(OWNER);
            let other = authed_caller("principal:c2-5-intruder");

            let (selection, _answer) = rt
                .run_session_task_pinned(&owner, RUN, SESS, "read the notes", "claude", 5_000)
                .expect("the claude-pinned sessioned read_file run executes");
            assert_eq!(selection.provider_id, "claude", "the pin routed to claude");

            // --- the read_file turn billed a REAL anthropic row -------------------------------
            // `[read_file, Finish]` is TWO metered claude turns (the read_file proposal bills +
            // executes, then Finish bills) ⇒ exactly two anthropic rows.
            let rows = rt.db().list_run_token_usage(RUN).unwrap();
            assert_eq!(
                rows.len(),
                2,
                "two metered claude turns: read_file then finish"
            );
            for row in &rows {
                assert_eq!(row.provider_kind, "anthropic", "NOT mis-attributed");
                assert_eq!(row.base_url_host, "api.anthropic.com");
                assert_eq!(row.model, friday_anthropic::DEFAULT_MODEL);
                assert!(!row.fallback, "the claude route is never a fallback");
            }
            // The no-new-ledger BASELINE is the two rows the metered turns billed.
            let ledger_baseline = rt.db().list_token_usage().unwrap().len();
            assert_eq!(ledger_baseline, 2);

            // --- the run recorded a REAL read_file receipt (the anchor, not a mirror) ----------
            // The Allowed+executed read_file co-commits a hash-chained audit receipt
            // (action='tool.executed:read_file') in the SAME tx as its run-keyed event. Assert the
            // receipt exists and the chain verifies — proving it's the genuine metered turn's
            // receipt the file-view anchors to.
            let receipt_rows: i64 = rt
                .db()
                .conn()
                .query_row(
                    "SELECT count(*) FROM audit_ledger WHERE action = 'tool.executed:read_file'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                receipt_rows, 1,
                "exactly one read_file receipt was recorded"
            );
            assert!(
                friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok(),
                "the read_file receipt is on a verified hash chain"
            );

            // --- the OWNER's file-view returns that file ref, keyed to the run -----------------
            let view = rt
                .file_view_for_owner(&owner, RUN)
                .unwrap()
                .expect("the owner reads her own file-view");
            assert_eq!(view["run_id"], RUN, "the view is keyed to the run");
            assert_eq!(
                view["file_refs"],
                serde_json::json!(["notes.md"]),
                "the file-view surfaces the read_file receipt's file ref"
            );
            assert_eq!(view["file_view_count"], 1);
            // Refs-only: the view never carries the run task body or the answer.
            let rendered = serde_json::to_string(&view).unwrap();
            assert!(!rendered.contains("read the notes"), "no run task body");
            assert!(!rendered.contains("PONG"), "no answer body");

            // --- a DIFFERENT principal's view is fail-closed None (owner-gated) ----------------
            assert_eq!(
                rt.file_view_for_owner(&other, RUN).unwrap(),
                None,
                "a non-owner cannot read another's file-view (fail-closed, no oracle)"
            );

            // --- THE ANTI-FAKE: reading the file-view wrote NO new ledger row ------------------
            // (twice — once per principal — it is a pure read over existing receipts).
            assert_eq!(
                rt.db().list_token_usage().unwrap().len(),
                ledger_baseline,
                "the file-view is a Class-2 read: no new ledger row from the view"
            );
        }

        // ---- C2-9: owner-scoped Activity / Needs-Me projection over a paused metered run -------
        #[test]
        fn c2_9_activity_needs_me_surfaces_paused_claude_run_owner_scoped_no_new_ledger_row() {
            // C2-9 FAITHFUL DARK PROOF. Reuse the C2-3 setup (`paused_owned_claude_run`): a
            // claude-pinned MUTATING turn that bills EXACTLY ONE anthropic row then Pauses on a real
            // pending approval. The Activity/Needs-Me projection then surfaces, OWNER-SCOPED:
            //   - the AskReceipt activity row of the metered turn (`{RUN}:t0:askreceipt`,
            //     "{n} tokens via {model}" — the real metered turn, never synthesized);
            //   - a Needs-Me item for the pending approval, anchored to the REAL nonce
            //     (`detect_pause`) — provider=claude, kind=approval, status=awaiting_approval,
            //     `ref_id` = the live `pending_approval_request.approval_id`;
            //   - a DIFFERENT principal's projection is fail-closed `None` (owner-gated);
            //   - reading the projection writes NO new ledger row (Class-2 read).
            // NO key, NO network — the claude stub bills the anthropic row; NO ns-7
            // FRIDAY_ACTIVITY_NEEDS_ME flag is set (the Needs-Me item is COMPUTED from detect_pause
            // at read time, decoupled from the persisted-activity path).
            const OWNER: &str = "principal:c2-9-owner";
            const RUN: &str = "run-c2-9";
            let (rt, _ws, nonce, ledger_before) = paused_owned_claude_run("c2-9", OWNER, RUN);

            let owner = authed_caller(OWNER);
            let other = authed_caller("principal:c2-9-intruder");

            // --- the OWNER's projection surfaces the AskReceipt + the Needs-Me item ------------
            let view = rt
                .activity_needs_me_for_owner(&owner, RUN)
                .unwrap()
                .expect("the owner reads her own paused-run Activity/Needs-Me projection");
            assert_eq!(view["run_id"], RUN, "the projection is keyed to the run");

            // The AskReceipt of the ONE metered claude turn, keyed by the bill_model_call scheme.
            assert_eq!(
                view["ask_receipt_count"], 1,
                "exactly one metered-turn receipt"
            );
            let receipts = view["ask_receipts"].as_array().expect("ask_receipts array");
            assert_eq!(receipts.len(), 1);
            assert_eq!(
                receipts[0]["activity_id"],
                format!("{RUN}:t0:askreceipt"),
                "the receipt is the proposing metered turn's real AskReceipt row"
            );
            assert_eq!(receipts[0]["kind"], "ask_receipt");
            assert_eq!(receipts[0]["state"], "done");
            assert!(
                receipts[0]["summary"]
                    .as_str()
                    .unwrap()
                    .contains("tokens via"),
                "the AskReceipt summary is the metered turn's body-free token receipt"
            );

            // The Needs-Me item, anchored to the REAL pending approval (the detect_pause nonce).
            let needs_me = &view["needs_me"];
            assert!(!needs_me.is_null(), "a paused run surfaces a Needs-Me item");
            assert_eq!(
                needs_me["ref_id"], nonce,
                "the Needs-Me item points at the REAL pending_approval_request nonce, not a \
                 synthesized inbox entry"
            );
            assert_eq!(needs_me["provider"], "claude", "the run is claude-pinned");
            assert_eq!(needs_me["kind"], "approval");
            assert_eq!(needs_me["priority"], "high");
            assert_eq!(needs_me["status"], "awaiting_approval");
            assert_eq!(needs_me["friday_session_id"], RUN);

            // Refs-only: the projection never carries the run task body or any answer.
            let rendered = serde_json::to_string(&view).unwrap();
            assert!(!rendered.contains("write a file"), "no run task body");

            // --- a DIFFERENT principal's projection is fail-closed None (owner-gated) ----------
            assert_eq!(
                rt.activity_needs_me_for_owner(&other, RUN).unwrap(),
                None,
                "a non-owner cannot read another's Activity/Needs-Me (fail-closed, no oracle)"
            );

            // --- THE ANTI-FAKE: the projection wrote NO new ledger row (projection-only) -------
            // (read once per principal — a pure compute over existing activity + pending rows).
            assert_no_new_anthropic_row(&rt, RUN, &ledger_before);
        }
    } // mod c2_control

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

    // ---- C1 PR-B: routed Codex route wiring (DARK, deterministic, no creds) ------
    //
    // These tests are the DETERMINISTIC, no-creds proof that the dark Codex route is wired into
    // the runtime through the REWIRED gated path: they drive the REAL public
    // `HubRuntime::run_task_pinned("codex", ..)` entry — through `with_codex` + the in-process
    // route promotion the gated `live()` path uses — to a STUB
    // [`crate::CodexTurnExecutor`] that returns a scripted [`crate::codex_gated_turn::CodexTurnOutcome`]
    // EXACTLY as the live `LocalCodexGatedTurnExecutor` would after a real `run_codex_gated_turn`.
    // They prove the runtime's `CodexTurnOutcome → LoopOutcome` MAPPING + the single-biller
    // billing — NOT the gate itself (that is `codex_gated_turn.rs`'s KATs, driven over recorded
    // byte-streams). NO codex CLI, NO creds, NO network/spawn is needed (the route promotion uses
    // the private `mark_route_*` helpers).

    /// A stub Codex executor: each `run_gated_turn` returns the next scripted
    /// [`crate::codex_gated_turn::CodexTurnOutcome`] (Finished/Paused/Errored) EXACTLY as the live
    /// `LocalCodexGatedTurnExecutor` maps from a real gated app-server turn. A Finished outcome
    /// carries a Codex-kind [`crate::BilledUsage`] (the bits the runtime bills through the single
    /// biller). Once the script is exhausted it Finishes. The stub does NOT touch the gate/DB — it
    /// stands in for the WHOLE gated turn (the gate's own behavior is proven in `codex_gated_turn.rs`).
    struct StubCodexGatedExecutor {
        outcomes: Vec<crate::codex_gated_turn::CodexTurnOutcome>,
        calls: Cell<usize>,
    }
    impl StubCodexGatedExecutor {
        /// A Finished-with-usage outcome carrying the C1-row token counts (13 prompt + 5 completion).
        fn finished(answer: &str) -> crate::codex_gated_turn::CodexTurnOutcome {
            crate::codex_gated_turn::CodexTurnOutcome::Finished {
                answer: answer.to_string(),
                usage: crate::BilledUsage {
                    provider_kind: friday_core::ProviderKind::Codex,
                    model: CODEX_ROUTE_MODEL.to_string(),
                    prompt_tokens: 13,
                    completion_tokens: 5,
                },
            }
        }
        fn new(outcomes: Vec<crate::codex_gated_turn::CodexTurnOutcome>) -> Self {
            Self {
                outcomes,
                calls: Cell::new(0),
            }
        }
    }
    impl crate::CodexTurnExecutor for StubCodexGatedExecutor {
        fn run_gated_turn(
            &self,
            _conn: &rusqlite::Connection,
            _policy: &RunPolicy,
            _secret: &[u8],
            _approve: &dyn Fn(
                &friday_core::gate::MutatingActionRequest,
            ) -> Option<friday_core::gate::CanonicalApproval>,
            _task: &str,
            _run_id: &str,
            _now_ms: i64,
        ) -> Result<
            crate::codex_gated_turn::CodexTurnOutcome,
            crate::codex_gated_turn::CodexGatedTurnError,
        > {
            let i = self.calls.get();
            self.calls.set(i + 1);
            Ok(self
                .outcomes
                .get(i)
                .cloned()
                .unwrap_or_else(|| Self::finished("done")))
        }
    }

    /// Build a runtime with the DARK Codex executor WIRED and its in-process route promoted to
    /// dispatchable — the SAME two flips the gated `live()` path performs (`with_codex` +
    /// `mark_route_available` + `mark_route_validated`), but WITHOUT any creds (no
    /// `validate_and_enable_codex` app-server spawn). Legal in-crate because the test module is a
    /// child of the impl, so it may call the private route-promotion helpers; it adds NO public
    /// no-creds route-enable (the dark/default-off invariant is untouched — the autonomous
    /// baseline still marks `codex` `available:false`). MIRRORS `runtime_with_claude_wired`.
    fn runtime_with_codex_wired(
        tag: &str,
        outcomes: Vec<crate::codex_gated_turn::CodexTurnOutcome>,
        approval: Box<dyn ApprovalPolicy>,
    ) -> (HubRuntime<ScriptTransport>, TempDir) {
        let ws = TempDir::new(tag);
        // The DeepSeek transport is present (required by the runtime type) but never reached:
        // the codex pin routes to the wired Codex executor, not deepseek.
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
        rt = rt.with_codex(Box::new(StubCodexGatedExecutor::new(outcomes)));
        // The gated `live()` path does these two flips behind FRIDAY_CODEX_ROUTE_ENABLED + the
        // creds-light health_check; we do them directly (no creds) for the deterministic proof.
        rt.mark_route_available("codex");
        rt.mark_route_validated("codex");
        (rt, ws)
    }

    #[test]
    fn run_task_pinned_codex_routes_through_runtime_and_writes_codex_row() {
        // (1) CHAT FLOW: a `run_task_pinned("codex")` through the REAL HubRuntime entry routes to
        // the wired Codex client, finishes, and records EXACTLY ONE run-scoped token_ledger row
        // attributed to Codex — provider_kind="codex", the LOCAL app-server host, the gpt-5-codex
        // model, fallback=false. NO creds, NO spawn, NO network.
        let (rt, _ws) = runtime_with_codex_wired(
            "c1-3-pinned-codex-chat",
            vec![StubCodexGatedExecutor::finished("PONG")],
            Box::new(DenyAllApprovals),
        );
        let (selection, outcome) = rt
            .run_task_pinned("run-c1-3-chat", "say pong", "codex", 1_000)
            .expect("pinned codex runs through the runtime");
        assert_eq!(selection.provider_id, "codex", "the pin routed to codex");
        assert_eq!(outcome.status, LoopStatus::Finished);

        let rows = rt.db().list_run_token_usage("run-c1-3-chat").unwrap();
        assert_eq!(rows.len(), 1, "one codex row for the single codex turn");
        let row = &rows[0];
        assert_eq!(
            row.provider_kind, "codex",
            "NOT mis-attributed as deepseek/anthropic"
        );
        assert_eq!(
            row.base_url_host, "provider_app_server_local",
            "the LOCAL Codex app-server host label (never a remote API host)"
        );
        assert_eq!(row.model, CODEX_ROUTE_MODEL);
        assert_eq!(row.total_tokens, 18, "13 + 5 (summed by the ledger)");
        assert!(!row.fallback, "the codex route is never a fallback");

        // The whole-ledger projection agrees (only this codex row exists; no hidden call).
        let all = rt.db().list_token_usage().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].provider_kind, "codex");
    }

    #[test]
    fn codex_mutating_turn_pauses_for_approval_and_bills_nothing() {
        // (2) APPROVAL-REQUEST FLOW (gated turn): a codex-pinned turn whose gated turn resolves to
        // `Paused` (the HUB gate RequiresApproval — `run_codex_gated_turn` DENIED the action to
        // Codex, aborting its turn, AND persisted the pending row) maps to `LoopStatus::Paused`.
        //
        // MIGRATED from the pre-rewire `..._bills_codex_row_then_pauses` (brain) semantics: the
        // retired brain billed the proposing turn THEN paused; the GATED turn's Deny ABORTS the
        // Codex turn, so it carries NO `BilledUsage` on a Paused outcome ⇒ the rewired path bills
        // NOTHING on a pause. (The pending_approval_request persistence + the gate decision itself
        // are proven over recorded byte-streams in `codex_gated_turn.rs` KAT (c); this test proves
        // the runtime's `Paused → LoopStatus::Paused` MAPPING + no-bill, with a stub gated turn.)
        let (rt, _ws) = runtime_with_codex_wired(
            "c1-prb-pinned-codex-approval",
            vec![crate::codex_gated_turn::CodexTurnOutcome::Paused {
                action: "write_file".to_string(),
                approval_nonce: "nonce-prb".to_string(),
            }],
            Box::new(DenyAllApprovals),
        );
        let (selection, outcome) = rt
            .run_task_pinned("run-c1-prb-appr", "write a file", "codex", 2_000)
            .expect("pinned codex runs through the runtime");
        assert_eq!(selection.provider_id, "codex", "the pin routed to codex");
        assert_eq!(
            outcome.status,
            LoopStatus::Paused,
            "a gate RequiresApproval ⇒ the run Pauses (resumable once the operator signs)"
        );

        // NO bill on a pause: the Deny aborted the Codex turn, so the gated turn returned no usage.
        assert!(
            rt.db()
                .list_run_token_usage("run-c1-prb-appr")
                .unwrap()
                .is_empty(),
            "a paused (denied-to-codex) turn bills nothing — no half-billed row"
        );

        // The pause was recorded in the loop's vocabulary, carrying the gated turn's nonce, so the
        // run is recoverable (the resume leg reads the pending row the gated turn persisted).
        let paused_event: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run_event WHERE run_id = 'run-c1-prb-appr' \
                 AND kind = 'tool.paused:requires_approval:write_file:nonce-prb'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(paused_event, 1, "the pause outcome event was recorded");

        // No run_result persisted on a Pause (the resume completion leg owns that slot).
        let results: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM run_result WHERE run_id = 'run-c1-prb-appr'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(results, 0, "no run_result on a Pause");
    }

    #[test]
    fn codex_route_error_fails_run_closed_and_bills_nothing() {
        // (3) ERROR HANDLING: a codex gated turn that resolves to `Errored` (e.g. a transport
        // failure, an unmappable approval request, a hard gate Deny, or the flag-OFF
        // `interactive-approval-unsupported`) fails the run CLOSED (`LoopStatus::Errored`) with NO
        // reroute to deepseek and NO ledger row (an aborted turn produced no usage). NO creds.
        let (rt, _ws) = runtime_with_codex_wired(
            "c1-prb-codex-route-error",
            vec![crate::codex_gated_turn::CodexTurnOutcome::Errored {
                reason: "codex_transport:app-server-spawn".to_string(),
            }],
            Box::new(DenyAllApprovals),
        );

        let (selection, outcome) = rt
            .run_task_pinned("run-c1-3-err", "say pong", "codex", 1_000)
            .expect("a codex route error is a loop outcome, not a routing error");
        assert_eq!(
            selection.provider_id, "codex",
            "the pin routed to codex (no reroute)"
        );
        assert_eq!(
            outcome.status,
            LoopStatus::Errored,
            "a model-call error fails the run closed"
        );
        // A failed call produced no usage ⇒ NO ledger row (never a half-billed row).
        assert!(
            rt.db()
                .list_run_token_usage("run-c1-3-err")
                .unwrap()
                .is_empty(),
            "a route error bills nothing"
        );
    }

    #[test]
    fn pin_codex_dark_is_requested_unavailable_and_bills_nothing() {
        // (4) DARK PIN: a plain runtime (gate OFF ⇒ codex route stays `available:false` in the
        // baseline, never promoted; the codex CLIENT is `None`). `run_task_pinned(.., "codex", ..)`
        // FAILS CLOSED with RequestedProviderUnavailable("codex") — refused at select_route, NO
        // reroute to deepseek, NO model call, bills NOTHING. NO creds, NO spawn. Mirrors the
        // Claude `pin_claude_dark_is_requested_unavailable`.
        let (rt, _ws, post_calls) = runtime_with(
            "c1-3-pin-codex-dark",
            &["{\"tool\":\"none\"}"],
            Box::new(DenyAllApprovals),
        );
        let err = rt
            .run_task_pinned("run-c1-3-dark", "ask codex", "codex", 1_000)
            .expect_err("a dark codex pin must fail closed");
        assert!(
            matches!(
                err,
                RoutedLoopError::Route(RouteError::RequestedProviderUnavailable(ref p)) if p == "codex"
            ),
            "expected RequestedProviderUnavailable(codex), got {err:?}"
        );
        // Selection refused at select_route — no model/chat call was ever made (no reroute to
        // deepseek). (The shared `run_with_request` body creates the run row BEFORE select_route,
        // so a row may exist; the no-degrade invariant that matters is that NOTHING was billed
        // and NO provider was dispatched.)
        assert_eq!(
            post_calls.get(),
            0,
            "no provider call on a refused pin (no reroute to deepseek)"
        );
        // Bills NOTHING — the refusal is before any model call, so no ledger row.
        assert!(
            rt.db()
                .list_run_token_usage("run-c1-3-dark")
                .unwrap()
                .is_empty(),
            "a dark codex pin bills nothing"
        );
        // No run_result was persisted (the run never Finished — it failed closed at routing).
        let results: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM run_result WHERE run_id = 'run-c1-3-dark'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(results, 0, "no run_result persisted for the refused pin");
    }

    #[test]
    fn codex_route_gate_is_off_by_default_and_on_only_for_exactly_1() {
        // The default-off Codex gate is the only thing that lets `live()` wire Codex. Mirror the
        // exact-`"1"` predicate WITHOUT mutating the process env (drive the matcher directly), and
        // confirm the real helper reports OFF in the test process (the prod default).
        let on = |v: &str| v.trim() == "1";
        assert!(on("1"), "exactly \"1\" enables");
        assert!(on(" 1 "), "trimmed \"1\" enables");
        for off in ["", "0", "true", "yes", "01", "1 0", "enabled"] {
            assert!(!on(off), "{off:?} must NOT enable the dark route");
        }
        assert!(
            !codex_route_enabled_from_env(),
            "FRIDAY_CODEX_ROUTE_ENABLED must be unset/off in the test env"
        );
    }

    #[test]
    fn codex_executor_is_none_when_dark_some_when_wired_and_never_an_agentllm_route() {
        // C1 PR-B: codex is NOT an `AgentLlmClient` route anymore — it is SPECIAL-CASED through
        // the gated executor. Two invariants:
        //   (a) `resolve("codex")` is ALWAYS `None` (codex is deliberately absent from the
        //       `ProviderClientResolver` match) — so even a wired codex never drives the WRONG
        //       conn-less `next_step_metered` path; the special-case branch intercepts it first.
        //   (b) the `codex` EXECUTOR field is `None` by default (dark) and flips to `Some` ONLY via
        //       `with_codex` (what the gated `live()` path does). MIRRORS the Claude dark backstop,
        //       but on the executor field rather than the resolver.
        let (rt, _ws, _c) = runtime_with(
            "codex-dark",
            &["{\"tool\":\"none\"}"],
            Box::new(DenyAllApprovals),
        );
        let baseline = RouteRegistry::autonomous_baseline();
        let codex_route = baseline
            .get("codex")
            .expect("baseline has a codex route")
            .clone();

        // (a) codex is never resolvable as an AgentLlmClient — by default AND once wired.
        assert!(
            rt.resolve(&codex_route).is_none(),
            "codex must never resolve as an AgentLlmClient (special-cased, not resolved)"
        );
        assert!(
            !codex_route.is_dispatchable(),
            "codex route stays available:false (CLI auth-gated)"
        );

        // (b) the executor field: None by default (dark), Some once wired.
        assert!(
            rt.codex.is_none(),
            "codex executor must be None by default (dark/off)"
        );
        let wired = rt.with_codex(Box::new(StubCodexGatedExecutor::new(vec![])));
        assert!(
            wired.codex.is_some(),
            "codex executor is Some once attached via with_codex"
        );
        assert!(
            wired.resolve(&codex_route).is_none(),
            "even a WIRED codex never resolves as an AgentLlmClient (special-cased)"
        );
    }

    #[test]
    fn session_pinned_codex_dark_fails_closed_and_bills_nothing() {
        // NEGATIVE (sessioned): the `codex` route is DISPATCHABLE (available+validated, as the
        // gated `live()` path promotes it) but the Codex CLIENT is NOT wired (no `with_codex` — the
        // resolver's documented dark backstop). A sessioned pin to "codex" then FAILS CLOSED at the
        // resolve() chokepoint with NoClientForProvider — NEVER a silent reroute — and bills
        // NOTHING (no run row, no ledger row). Mirrors the Claude sessioned dark backstop. NO creds.
        let (mut rt, _ws, post_calls) = runtime_with(
            "c1-3-session-dark",
            &["{\"tool\":\"none\"}"],
            Box::new(DenyAllApprovals),
        );
        // Promote the route to dispatchable WITHOUT wiring the client (codex stays None) — so the
        // fail-closed is at resolve() (NoClientForProvider), not at select_route.
        rt.mark_route_available("codex");
        rt.mark_route_validated("codex");
        let caller = authed_caller("principal:session-owner");
        let err = rt
            .run_session_task_pinned(
                &caller,
                "run-c1-3-session-dark",
                "sess-c1-3-dark-1",
                "make it shorter",
                "codex",
                4_000,
            )
            .expect_err("a dark codex pin must fail closed, never reroute");
        match err {
            RoutedLoopError::NoClientForProvider(p) => {
                assert_eq!(
                    p, "codex",
                    "fail-closed names the dark provider, no reroute"
                )
            }
            other => panic!("expected NoClientForProvider(codex), got {other:?}"),
        }
        assert_eq!(post_calls.get(), 0, "no reroute — deepseek never called");
        assert!(
            rt.db()
                .list_run_token_usage("run-c1-3-session-dark")
                .unwrap()
                .is_empty(),
            "a dark pin bills nothing"
        );
        let run_rows: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run WHERE run_id = 'run-c1-3-session-dark'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(run_rows, 0, "no agent_run row was created for the dark pin");
    }

    // ---- C2 session-control routing: a SESSIONED follow-up/steer turn routes + bills ----------

    /// Build an authenticated caller bound to `principal` over a freshly paired sealed session —
    /// the SAME mechanism `hub_server`'s own tests use (ECDH-pair two DeviceKeypairs, seal the
    /// agreed challenge, `AuthedPrincipal::authenticate`). The runtime treats this `caller` exactly
    /// as the WS dispatch arm's authenticated principal.
    fn authed_caller(principal: &str) -> AuthedPrincipal {
        use friday_crypto::{seal, DeviceKeypair};
        const AAD: &[u8] = b"c2-session-pinned-test-aad";
        const CHALLENGE: &[u8] = b"c2-session-pinned-test-challenge";
        let hub = DeviceKeypair::generate();
        let phone = DeviceKeypair::generate();
        let hub_session = hub.agree(&phone.public_bytes());
        let caller_session = phone.agree(&hub.public_bytes());
        let sealed = seal(&caller_session, CHALLENGE, AAD).unwrap();
        AuthedPrincipal::authenticate(&hub_session, &sealed, AAD, CHALLENGE, principal).unwrap()
    }

    #[test]
    fn session_followup_turn_routes_to_claude_and_bills_anthropic() {
        // POSITIVE: a SESSIONED FOLLOW-UP turn pinned to "claude" — a NEW pinned turn on an
        // already-bound session (e.g. "make it shorter"), NOT in-flight steering — routes through
        // the REAL `run_session_task_pinned` entry to the wired Claude stub, finishes, and records
        // EXACTLY ONE token_ledger row attributed to Anthropic (host api.anthropic.com,
        // fallback=false) — NOT mis-attributed as deepseek. NO key, NO network. The sessioned
        // parity of `run_task_pinned_claude_routes_through_runtime_and_writes_anthropic_row`.
        //
        // HONEST SCOPE: this is a follow-up TURN, not a steer/interrupt. §3's "steer running turn"
        // and "interrupt / stop" remain genuinely DEFERRED — there is no mid-turn channel in
        // `run_loop` (the loop is single-shot per `run_session_task_pinned` call), so this test
        // does NOT prove steering; covering steer/interrupt via a follow-up turn would be a fake.
        let (rt, _ws) = runtime_with_claude_wired(
            "c2-session-pinned-claude",
            vec![AgentStep::Finish {
                message: "PONG (follow-up)".to_string(),
            }],
            Box::new(DenyAllApprovals),
        );
        let caller = authed_caller("principal:session-owner");
        let (selection, _answer) = rt
            .run_session_task_pinned(
                &caller,
                "run-c2-session",
                "sess-c2-1",
                "make it shorter", // a session FOLLOW-UP turn (NOT in-flight steering)
                "claude",
                3_000,
            )
            .expect("a dispatchable claude pin runs through the sessioned entry");
        assert_eq!(
            selection.provider_id, "claude",
            "the session follow-up turn resolved to claude"
        );
        // NOTE on the answer: `runtime_with_claude_wired` configures `principal_id: None`, so
        // `run_session_loop`'s owner-wiring records NO owner ⇒ the body projection releases nothing
        // (single-owner-v1 fail-closed: a run with no bound owner is unreadable). That is the
        // CORRECT documented behavior and is ORTHOGONAL to the C2 routing+billing claim, which is
        // what this KAT asserts: the run reached the wired CLAUDE client and billed an anthropic
        // row. (Body delivery to a matching owner is covered by the sessionless owner-gating tests.)

        // EXACTLY ONE anthropic row for the single claude turn — billed to anthropic, not deepseek.
        let rows = rt.db().list_run_token_usage("run-c2-session").unwrap();
        assert_eq!(
            rows.len(),
            1,
            "one anthropic row for the single claude turn"
        );
        let row = &rows[0];
        assert_eq!(
            row.provider_kind, "anthropic",
            "session turn billed to anthropic (NOT mis-attributed as deepseek)"
        );
        assert_eq!(row.base_url_host, "api.anthropic.com");
        assert_eq!(row.model, friday_anthropic::DEFAULT_MODEL);
        assert!(!row.fallback, "the claude route is never a fallback");
        // Whole-ledger agrees: only this one anthropic row exists (no hidden deepseek call).
        let all = rt.db().list_token_usage().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].provider_kind, "anthropic");
    }

    #[test]
    fn c2_4_owner_scoped_list_open_read_of_routed_sessions() {
        // C2-4 FAITHFUL DARK PROOF: run TWO claude-pinned SESSIONED turns through the REAL
        // `run_session_task_pinned` entry (each billing one anthropic row — ASSERTED), then prove
        // the owner-scoped read API over the FRIDAY ROUTED `agent_session` rows:
        //   - `list_sessions_for_owner(owner)` returns BOTH sessions, bound to the authed owner,
        //     most-recently-active first;
        //   - open returns the right session's folded user/assistant transcript;
        //   - a DIFFERENT principal's list is owner-scoped EMPTY and its open is None
        //     (INV-5/INV-7 fail-closed — the load-bearing security assertion);
        //   - list/open/read write NO new ledger row (pure read; the count stays at the 2 the runs
        //     wrote);
        //   - the NOT-A-MIRROR / two-session trap: each listed session's message `refs` is its
        //     run_id, and that run_id carries the REAL anthropic ledger rows — never a
        //     claude_control mirror link.
        // NO key, NO network — the claude stub bills the anthropic rows.
        let (rt, _ws) = runtime_with_claude_wired(
            "c2-4-owner-scoped-read",
            // Each `run_session_task_pinned` call drives a FRESH single-shot loop on a fresh stub
            // (the stub's `calls` counter resets per runtime build is not needed — both turns reuse
            // THIS runtime's single stub, whose script is `[Finish]`, so every call Finishes).
            vec![AgentStep::Finish {
                message: "PONG".to_string(),
            }],
            Box::new(DenyAllApprovals),
        );
        let owner = authed_caller("principal:c2-4-owner");
        let other = authed_caller("principal:c2-4-intruder");

        // --- two claude-pinned sessioned turns (two DISTINCT sessions, DISTINCT now_ms) ---------
        let (sel1, _a1) = rt
            .run_session_task_pinned(
                &owner,
                "run-c2-4-a",
                "sess-c2-4-a",
                "first turn",
                "claude",
                3_000,
            )
            .expect("first claude sessioned turn runs");
        assert_eq!(sel1.provider_id, "claude");
        let (sel2, _a2) = rt
            .run_session_task_pinned(
                &owner,
                "run-c2-4-b",
                "sess-c2-4-b",
                "second turn",
                "claude",
                4_000,
            )
            .expect("second claude sessioned turn runs");
        assert_eq!(sel2.provider_id, "claude");

        // ASSERT the REAL anthropic rows: one per run, billed to anthropic / api.anthropic.com.
        for run_id in ["run-c2-4-a", "run-c2-4-b"] {
            let rows = rt.db().list_run_token_usage(run_id).unwrap();
            assert_eq!(
                rows.len(),
                1,
                "{run_id}: one anthropic row for the single claude turn"
            );
            assert_eq!(
                rows[0].provider_kind, "anthropic",
                "{run_id}: NOT mis-attributed as deepseek"
            );
            assert_eq!(rows[0].base_url_host, "api.anthropic.com");
            assert!(!rows[0].fallback, "the claude route is never a fallback");
        }
        // The no-new-ledger BASELINE is 2 (the two runs already billed two anthropic rows).
        let ledger_baseline = rt.db().list_token_usage().unwrap().len();
        assert_eq!(
            ledger_baseline, 2,
            "two claude turns billed two anthropic rows"
        );

        // --- list: the owner sees BOTH, most-recently-updated first (sess-b @4000 before -a @3000) ---
        let listed = rt.list_sessions_for_owner(&owner).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|s| s.agent_session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["sess-c2-4-b", "sess-c2-4-a"],
            "owner list returns both routed sessions, most-recently-active first"
        );

        // --- the DIFFERENT principal's list is owner-scoped EMPTY (the load-bearing assertion) ---
        assert!(
            rt.list_sessions_for_owner(&other).unwrap().is_empty(),
            "a different principal sees NONE of the owner's sessions (INV-5/INV-7 fail-closed)"
        );

        // --- open: the owner reads the right session's folded user/assistant transcript ----------
        let msgs_a = rt
            .open_session_for_owner(&owner, "sess-c2-4-a")
            .unwrap()
            .expect("the owner can open her own session");
        // run_session_loop folds a "user" turn (the task, refs=run_id) + an "assistant" turn on
        // Finished (refs=run_id).
        assert_eq!(
            msgs_a.len(),
            2,
            "user task + assistant answer folded into the session"
        );
        assert_eq!(msgs_a[0].role, "user");
        assert_eq!(msgs_a[0].content, "first turn");
        assert_eq!(msgs_a[1].role, "assistant");

        // --- the DIFFERENT principal cannot open a guessed session id (fail-closed open) ---------
        assert_eq!(
            rt.open_session_for_owner(&other, "sess-c2-4-a").unwrap(),
            None,
            "a guessed session id does not bypass owner-scoping"
        );

        // --- NOT-A-MIRROR / two-session trap: the listed session's message refs IS the run_id ----
        // that carries the REAL anthropic rows — never a claude_control mirror link. Prove it for
        // each listed session.
        for item in &listed {
            let msgs = rt
                .open_session_for_owner(&owner, &item.agent_session_id)
                .unwrap()
                .expect("owner opens her listed session");
            let run_id = msgs[0]
                .refs
                .as_deref()
                .expect("the folded turn soft-links its producing run_id");
            let rows = rt.db().list_run_token_usage(run_id).unwrap();
            assert_eq!(
                rows.len(),
                1,
                "the listed session's run carries a REAL anthropic row"
            );
            assert_eq!(
                rows[0].provider_kind, "anthropic",
                "the listed session ties to anthropic billing, never a mirror link"
            );
            assert_eq!(rows[0].base_url_host, "api.anthropic.com");
        }
        // The two sessions map to the two DISTINCT billed runs (no session points at the wrong run).
        let run_a = rt
            .open_session_for_owner(&owner, "sess-c2-4-a")
            .unwrap()
            .unwrap()[0]
            .refs
            .clone()
            .unwrap();
        let run_b = rt
            .open_session_for_owner(&owner, "sess-c2-4-b")
            .unwrap()
            .unwrap()[0]
            .refs
            .clone()
            .unwrap();
        assert_eq!(run_a, "run-c2-4-a");
        assert_eq!(run_b, "run-c2-4-b");
        assert_ne!(run_a, run_b, "the two sessions carry DISTINCT billed runs");

        // --- PURE READ: list/open/read wrote NO new ledger row (count unchanged from baseline) ---
        assert_eq!(
            rt.db().list_token_usage().unwrap().len(),
            ledger_baseline,
            "list/open/read are pure reads — no new ledger row"
        );
    }

    #[test]
    fn c2_8_offline_stale_link_state_keys_off_the_real_metered_turn() {
        // C2-8 FAITHFUL DARK PROOF: drive ONE claude-pinned SESSIONED turn through the REAL
        // `run_session_task_pinned` entry at a recorded last-turn time T. The metered turn folds
        // its `append_session_message`, bumping `agent_session.updated_at = T`, AND bills the
        // anthropic ledger row (ASSERTED) — so the link-state keys off the REAL routed session's
        // metered-turn activity, NOT a synthesized mirror heartbeat.
        //
        // Then compute the owner-gated link-state at three INJECTED `now`s and prove the pure
        // clock-driven transitions:
        //   - now just after the turn          → fresh
        //   - now past the stale threshold      → stale
        //   - now past the offline bound        → offline
        // Assert NO new ledger row across all three reads (the state is computed, never a model
        // call), and that a DIFFERENT principal cannot read the link-state (fail-closed).
        // NO key, NO network — the claude stub bills the anthropic row.
        use friday_storage::agent_session::{LINK_OFFLINE_AFTER_MS, LINK_STALE_AFTER_MS};

        let (rt, _ws) = runtime_with_claude_wired(
            "c2-8-link-state",
            vec![AgentStep::Finish {
                message: "PONG".to_string(),
            }],
            Box::new(DenyAllApprovals),
        );
        let owner = authed_caller("principal:c2-8-owner");
        let other = authed_caller("principal:c2-8-intruder");

        let last_turn = 2_000_000_i64;
        let (sel, _a) = rt
            .run_session_task_pinned(
                &owner,
                "run-c2-8",
                "sess-c2-8",
                "first turn",
                "claude",
                last_turn,
            )
            .expect("claude sessioned turn runs");
        assert_eq!(sel.provider_id, "claude");

        // ASSERT the REAL anthropic ledger row exists (the session is genuinely metered — this is
        // what makes the link-state's timestamp the REAL routed turn's, not a synthesized one).
        let rows = rt.db().list_run_token_usage("run-c2-8").unwrap();
        assert_eq!(
            rows.len(),
            1,
            "one anthropic row for the single claude turn"
        );
        assert_eq!(
            rows[0].provider_kind, "anthropic",
            "the session ties to a REAL anthropic turn, never a mirror link"
        );
        assert_eq!(rows[0].base_url_host, "api.anthropic.com");
        assert!(!rows[0].fallback, "the claude route is never a fallback");

        // The no-new-ledger BASELINE is 1 (the one metered turn billed one anthropic row).
        let ledger_baseline = rt.db().list_token_usage().unwrap().len();
        assert_eq!(
            ledger_baseline, 1,
            "one claude turn billed one anthropic row"
        );

        // --- fresh → stale → offline on the injected clock (the metered turn set updated_at=T) ---
        let fresh = rt
            .project_session_link_state(&owner, "sess-c2-8", last_turn + 1)
            .unwrap()
            .expect("the owner reads her own link-state");
        assert_eq!(fresh["link_state"], "fresh", "just after the turn → fresh");
        assert_eq!(fresh["stale_after_ms"], LINK_STALE_AFTER_MS);
        assert_eq!(fresh["offline_after_ms"], LINK_OFFLINE_AFTER_MS);

        let stale = rt
            .project_session_link_state(&owner, "sess-c2-8", last_turn + LINK_STALE_AFTER_MS)
            .unwrap()
            .expect("owner read");
        assert_eq!(
            stale["link_state"], "stale",
            "past the stale threshold → stale"
        );

        let offline = rt
            .project_session_link_state(&owner, "sess-c2-8", last_turn + LINK_OFFLINE_AFTER_MS)
            .unwrap()
            .expect("owner read");
        assert_eq!(
            offline["link_state"], "offline",
            "past the offline bound → offline"
        );

        // --- a DIFFERENT principal cannot read the link-state (fail-closed, no state oracle) -----
        assert_eq!(
            rt.project_session_link_state(&other, "sess-c2-8", last_turn + 1)
                .unwrap(),
            None,
            "a guessed session id does not let a non-owner read the link-state"
        );

        // --- NO new ledger row across ALL transitions (state is computed, never a model call) ----
        assert_eq!(
            rt.db().list_token_usage().unwrap().len(),
            ledger_baseline,
            "link-state reads are pure compute — no new ledger row across fresh/stale/offline"
        );
    }

    #[test]
    fn c2_6_owner_authed_archive_op_distinct_from_the_sweep() {
        // C2-6 FAITHFUL DARK PROOF: drive ONE claude-pinned SESSIONED turn through the REAL
        // `run_session_task_pinned` entry (billing one anthropic row — ASSERTED, so the archived
        // session is the REAL routed session that carries metered claude rows, never a mirror).
        // Then EXPLICITLY archive that session as the BOUND owner and prove:
        //   - status transitions to 'archived' (+ archived_at set), distinct from the time-based
        //     `session_lifecycle` sweep (which only archives after the 7d idle timeout);
        //   - the session no longer appears in the C2-4 active/owner list (it was there before);
        //   - an audit receipt is written and the hash chain verifies (action='session.archived');
        //   - `list_run_token_usage` is UNCHANGED — archive is metadata, not a model turn;
        //   - a DIFFERENT principal CANNOT archive it (owner mismatch → fail-closed refusal): no
        //     state change, the session STILL listed, and NO new audit row.
        // NO key, NO network — the claude stub bills the anthropic row.
        let (rt, _ws) = runtime_with_claude_wired(
            "c2-6-archive-op",
            vec![AgentStep::Finish {
                message: "PONG".to_string(),
            }],
            Box::new(DenyAllApprovals),
        );
        let owner = authed_caller("principal:c2-6-owner");
        let other = authed_caller("principal:c2-6-intruder");

        // --- one claude-pinned sessioned turn → a REAL routed session with a metered anthropic row ---
        let run_id = "run-c2-6";
        let sess = "sess-c2-6";
        let (sel, _a) = rt
            .run_session_task_pinned(&owner, run_id, sess, "first turn", "claude", 5_000)
            .expect("the claude-pinned sessioned turn runs");
        assert_eq!(sel.provider_id, "claude", "the pin routed to claude");

        // ASSERT the REAL anthropic ledger row (the archived session carries metered claude billing).
        let ledger_before = rt.db().list_run_token_usage(run_id).unwrap();
        assert_eq!(
            ledger_before.len(),
            1,
            "one anthropic row for the single claude turn"
        );
        assert_eq!(ledger_before[0].provider_kind, "anthropic");
        assert_eq!(ledger_before[0].base_url_host, "api.anthropic.com");
        assert!(
            !ledger_before[0].fallback,
            "the claude route is never a fallback"
        );
        let ledger_baseline = rt.db().list_token_usage().unwrap().len();
        assert_eq!(
            ledger_baseline, 1,
            "one claude turn billed one anthropic row"
        );

        // No archive receipt exists yet (it is written only by the archive op).
        let archive_receipts = |rt: &HubRuntime<ScriptTransport>| -> i64 {
            rt.db()
                .conn()
                .query_row(
                    "SELECT count(*) FROM audit_ledger WHERE action = 'session.archived'",
                    [],
                    |r| r.get(0),
                )
                .unwrap()
        };
        assert_eq!(archive_receipts(&rt), 0, "no archive receipt before the op");

        // --- BEFORE archive: the session IS in the owner's active list, status is 'active' --------
        assert_eq!(
            rt.list_sessions_for_owner(&owner)
                .unwrap()
                .iter()
                .map(|s| s.agent_session_id.as_str())
                .collect::<Vec<_>>(),
            vec![sess],
            "the active session is listed before archiving"
        );
        let status_of = |rt: &HubRuntime<ScriptTransport>| -> String {
            rt.db()
                .conn()
                .query_row(
                    "SELECT status FROM agent_session WHERE agent_session_id = ?1",
                    [sess],
                    |r| r.get::<_, String>(0),
                )
                .unwrap()
        };
        assert_eq!(status_of(&rt), "active", "freshly-routed session is active");

        // --- OWNER-MISMATCH first: a DIFFERENT principal cannot archive (fail-closed refusal) -----
        let refused = rt
            .archive_session_for_owner(&other, sess, 6_000)
            .expect("the archive call itself does not error");
        assert!(!refused.accepted, "a non-owner archive is refused");
        assert_eq!(refused.status, "not_owner");
        assert_eq!(
            refused.audit_ref, None,
            "a refused archive writes no receipt"
        );
        // The refusal changed NOTHING: still active, still listed, no audit row written.
        assert_eq!(
            status_of(&rt),
            "active",
            "owner mismatch left the status unchanged"
        );
        assert_eq!(
            rt.list_sessions_for_owner(&owner).unwrap().len(),
            1,
            "owner mismatch left the session in the active list"
        );
        assert_eq!(
            archive_receipts(&rt),
            0,
            "a refused (non-owner) archive writes NO audit row (the real fail-closed proof)"
        );

        // --- the BOUND OWNER archives the session -------------------------------------------------
        let archive_at = 7_000;
        let outcome = rt
            .archive_session_for_owner(&owner, sess, archive_at)
            .expect("the owner's archive runs");
        assert!(outcome.accepted, "the bound owner's archive is accepted");
        assert_eq!(outcome.status, "archived");
        assert!(
            outcome.audit_ref.is_some(),
            "an accepted archive writes a receipt"
        );

        // status → 'archived' (+ archived_at = now); status_changed_at + updated_at bumped to now.
        let (status, archived_at_col, status_changed_at, updated_at): (
            String,
            Option<i64>,
            Option<i64>,
            i64,
        ) = rt
            .db()
            .conn()
            .query_row(
                "SELECT status, archived_at, status_changed_at, updated_at
                 FROM agent_session WHERE agent_session_id = ?1",
                [sess],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(status, "archived", "status transitions to archived");
        assert_eq!(
            archived_at_col,
            Some(archive_at),
            "archived_at is stamped at now"
        );
        assert_eq!(status_changed_at, Some(archive_at));
        assert_eq!(updated_at, archive_at);

        // --- the session no longer appears in the C2-4 active/owner list --------------------------
        assert!(
            rt.list_sessions_for_owner(&owner).unwrap().is_empty(),
            "an archived session is hidden from the active/owner list"
        );

        // --- an audit receipt was written and the hash chain verifies -----------------------------
        assert_eq!(
            archive_receipts(&rt),
            1,
            "exactly one session.archived receipt was recorded"
        );
        assert!(
            friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok(),
            "the archive receipt is on a verified hash chain"
        );

        // --- THE ANTI-FAKE: archive billed NO new ledger row (metadata, not a model turn) ---------
        assert_eq!(
            rt.db().list_run_token_usage(run_id).unwrap(),
            ledger_before,
            "archive is metadata: the run's token ledger is byte-identical (no new anthropic row)"
        );
        assert_eq!(
            rt.db().list_token_usage().unwrap().len(),
            ledger_baseline,
            "archive wrote no new token_ledger row (no model call)"
        );

        // --- idempotent: re-archiving the owner's already-archived session is an accepted no-op ----
        let again = rt
            .archive_session_for_owner(&owner, sess, 8_000)
            .expect("re-archive runs");
        assert!(again.accepted, "re-archive is an accepted no-op");
        assert_eq!(again.status, "already_archived");
        assert_eq!(again.audit_ref, None, "re-archive writes no new receipt");
        assert_eq!(
            archive_receipts(&rt),
            1,
            "re-archive did not stack a second receipt"
        );
        // updated_at was NOT bumped by the no-op re-archive (it stays at the real archive time).
        let updated_after_rearchive: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT updated_at FROM agent_session WHERE agent_session_id = ?1",
                [sess],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            updated_after_rearchive, archive_at,
            "the idempotent re-archive does not bump updated_at"
        );
    }

    #[test]
    fn c2_7_owner_authed_fork_is_a_real_branch_of_a_metered_session() {
        // C2-7 FAITHFUL DARK PROOF: drive ONE claude-pinned SESSIONED turn through the REAL
        // `run_session_task_pinned` entry (billing one anthropic row — ASSERTED, so the PARENT
        // is the REAL routed session that carries metered claude billing, never a mirror). Then
        // FORK that parent as the BOUND owner and prove:
        //   - a NEW session exists, distinct from the parent, with the parent's messages COPIED
        //     (role/content/refs preserved verbatim — a copied turn legitimately still refs the
        //     PARENT's run_id);
        //   - the child's `forked_from` points back at the parent;
        //   - the child is bound to the SAME owner (it appears in the owner's C2-4 active list);
        //   - an audit receipt is written (action='session.forked') and the hash chain verifies;
        //   - NO new ledger row at fork time (forking is metadata, not a model turn) — the whole
        //     ledger stays at the 1 the parent turn wrote.
        // THEN run ONE claude-pinned turn on the FORKED session and prove:
        //   - it bills a NEW anthropic row on the CHILD run (the fork is a REAL branch of a
        //     metered session, not a mirror clone) — the whole ledger is now 2;
        //   - `forked_from` SURVIVES the child turn (the run-entry's ON CONFLICT bump never
        //     names it).
        // Owner MISMATCH: a DIFFERENT principal CANNOT fork (fail-closed refusal) — no child,
        // no copy, no audit row, and the `agent_session` row count is unchanged.
        // NO key, NO network — the claude stub bills the anthropic rows.
        let (rt, _ws) = runtime_with_claude_wired(
            "c2-7-fork-op",
            vec![AgentStep::Finish {
                message: "PONG".to_string(),
            }],
            Box::new(DenyAllApprovals),
        );
        let owner = authed_caller("principal:c2-7-owner");
        let other = authed_caller("principal:c2-7-intruder");

        // --- one claude-pinned sessioned turn → a REAL routed PARENT with a metered anthropic row ---
        let parent_run = "run-c2-7-parent";
        let parent_sess = "sess-c2-7-parent";
        let (sel, _a) = rt
            .run_session_task_pinned(
                &owner,
                parent_run,
                parent_sess,
                "first turn",
                "claude",
                5_000,
            )
            .expect("the claude-pinned sessioned turn runs");
        assert_eq!(sel.provider_id, "claude", "the pin routed to claude");

        // ASSERT the REAL anthropic ledger row on the PARENT run.
        let parent_ledger = rt.db().list_run_token_usage(parent_run).unwrap();
        assert_eq!(
            parent_ledger.len(),
            1,
            "one anthropic row for the parent turn"
        );
        assert_eq!(parent_ledger[0].provider_kind, "anthropic");
        assert_eq!(parent_ledger[0].base_url_host, "api.anthropic.com");
        assert!(
            !parent_ledger[0].fallback,
            "the claude route is never a fallback"
        );
        assert_eq!(
            rt.db().list_token_usage().unwrap().len(),
            1,
            "exactly one anthropic row exists before the fork"
        );

        // PRECONDITION: the parent has ≥1 message (else "messages COPIED" would prove nothing).
        let parent_msgs = rt
            .open_session_for_owner(&owner, parent_sess)
            .unwrap()
            .expect("the owner can open its own parent session");
        assert!(
            !parent_msgs.is_empty(),
            "the metered turn folded ≥1 message into the parent (the copy source)"
        );

        let fork_receipts = |rt: &HubRuntime<ScriptTransport>| -> i64 {
            rt.db()
                .conn()
                .query_row(
                    "SELECT count(*) FROM audit_ledger WHERE action = 'session.forked'",
                    [],
                    |r| r.get(0),
                )
                .unwrap()
        };
        let session_count = |rt: &HubRuntime<ScriptTransport>| -> i64 {
            rt.db()
                .conn()
                .query_row("SELECT count(*) FROM agent_session", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(fork_receipts(&rt), 0, "no fork receipt before the op");
        let sessions_before_fork = session_count(&rt);

        // --- OWNER-MISMATCH first: a DIFFERENT principal cannot fork (fail-closed refusal) -------
        let refused = rt
            .fork_session_for_owner(&other, parent_sess, 6_000)
            .expect("the fork call itself does not error");
        assert!(!refused.accepted, "a non-owner fork is refused");
        assert_eq!(refused.status, "not_owner");
        assert_eq!(
            refused.child_session_id, None,
            "a refused fork mints no child"
        );
        assert_eq!(refused.audit_ref, None, "a refused fork writes no receipt");
        assert_eq!(
            session_count(&rt),
            sessions_before_fork,
            "owner mismatch created NO child (agent_session count unchanged)"
        );
        assert_eq!(
            fork_receipts(&rt),
            0,
            "a refused (non-owner) fork writes NO audit row (the real fail-closed proof)"
        );

        // --- the BOUND OWNER forks the parent ----------------------------------------------------
        let fork_at = 7_000;
        let outcome = rt
            .fork_session_for_owner(&owner, parent_sess, fork_at)
            .expect("the owner's fork runs");
        assert!(outcome.accepted, "the bound owner's fork is accepted");
        assert_eq!(outcome.status, "forked");
        assert!(
            outcome.audit_ref.is_some(),
            "an accepted fork writes a receipt"
        );
        let child_sess = outcome
            .child_session_id
            .clone()
            .expect("an accepted fork mints a child id");
        assert_ne!(
            child_sess, parent_sess,
            "the child is a NEW, distinct session"
        );

        // A new session row exists (parent + child).
        assert_eq!(
            session_count(&rt),
            sessions_before_fork + 1,
            "the accepted fork created exactly one new session"
        );

        // The child's `forked_from` points back at the parent.
        let child_forked_from: Option<String> = rt
            .db()
            .conn()
            .query_row(
                "SELECT forked_from FROM agent_session WHERE agent_session_id = ?1",
                [&child_sess],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            child_forked_from.as_deref(),
            Some(parent_sess),
            "the child's forked_from points at the parent"
        );

        // The child carries a COPY of the parent's messages (role/content/refs verbatim, in order).
        let child_msgs = rt
            .open_session_for_owner(&owner, &child_sess)
            .unwrap()
            .expect("the owner can open its own forked child session");
        assert_eq!(
            child_msgs.len(),
            parent_msgs.len(),
            "the child copied EVERY parent message"
        );
        for (c, pm) in child_msgs.iter().zip(parent_msgs.iter()) {
            assert_eq!(c.role, pm.role, "copied role matches");
            assert_eq!(c.content, pm.content, "copied content matches");
            assert_eq!(
                c.refs, pm.refs,
                "copied refs match VERBATIM (a copied turn still refs the PARENT's run_id)"
            );
        }

        // The child is bound to the SAME owner: it appears in the owner's C2-4 active list...
        assert!(
            rt.list_sessions_for_owner(&owner)
                .unwrap()
                .iter()
                .any(|s| s.agent_session_id == child_sess),
            "the forked child is listed under the SAME owner"
        );
        // ...and a DIFFERENT principal sees neither (owner-scoped empty for the intruder is the
        // same fail-closed axis — the child was bound to the real owner, never the caller's claim).
        assert!(
            rt.open_session_for_owner(&other, &child_sess)
                .unwrap()
                .is_none(),
            "a non-owner cannot open the forked child (bound to the real owner)"
        );

        // An audit receipt was written and the hash chain verifies.
        assert_eq!(
            fork_receipts(&rt),
            1,
            "exactly one session.forked receipt was recorded"
        );
        assert!(
            friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok(),
            "the fork receipt is on a verified hash chain"
        );

        // THE ANTI-FAKE (fork is metadata): NO new ledger row at fork time.
        assert_eq!(
            rt.db().list_token_usage().unwrap().len(),
            1,
            "the fork billed NO new ledger row (forking is not a model turn)"
        );

        // --- THEN: one claude-pinned turn on the FORKED CHILD bills a NEW anthropic row ----------
        // The fork is a REAL branch of a metered session — a turn on the child meters its OWN row.
        let child_run = "run-c2-7-child";
        let (csel, _ca) = rt
            .run_session_task_pinned(
                &owner,
                child_run,
                &child_sess,
                "branch turn",
                "claude",
                9_000,
            )
            .expect("the claude-pinned turn on the forked child runs");
        assert_eq!(
            csel.provider_id, "claude",
            "the child turn routed to claude"
        );

        let child_ledger = rt.db().list_run_token_usage(child_run).unwrap();
        assert_eq!(
            child_ledger.len(),
            1,
            "ONE NEW anthropic row on the CHILD run (the fork is a real metered branch)"
        );
        assert_eq!(child_ledger[0].provider_kind, "anthropic");
        assert_eq!(child_ledger[0].base_url_host, "api.anthropic.com");
        assert!(
            !child_ledger[0].fallback,
            "the child claude route is never a fallback"
        );

        // The whole ledger is now 2: the parent row + the child's NEW row (no mis-attribution).
        assert_eq!(
            rt.db().list_token_usage().unwrap().len(),
            2,
            "two anthropic rows total: the parent turn + the child branch turn"
        );

        // `forked_from` SURVIVES the child turn (the run-entry's ON CONFLICT bump never names it).
        let child_forked_from_after: Option<String> = rt
            .db()
            .conn()
            .query_row(
                "SELECT forked_from FROM agent_session WHERE agent_session_id = ?1",
                [&child_sess],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            child_forked_from_after.as_deref(),
            Some(parent_sess),
            "forked_from survives the child's metered turn (never erased by the run entry)"
        );
    }

    #[test]
    fn session_pinned_claude_dark_fails_closed_and_bills_nothing() {
        // NEGATIVE: the `claude` route is DISPATCHABLE (available+validated, as the gated `live()`
        // path promotes it) but the Claude CLIENT is NOT wired (no `with_claude` — the resolver's
        // documented dark backstop). A sessioned pin to "claude" then FAILS CLOSED at the resolve()
        // chokepoint with NoClientForProvider — NEVER a silent reroute to deepseek — and bills
        // NOTHING (no run row, no ledger row), because the failure is BEFORE any write. This is the
        // sessioned mirror of the resolver's dark backstop; NO key, NO network.
        let (mut rt, _ws, post_calls) = runtime_with(
            "c2-session-dark",
            &["{\"tool\":\"none\"}"],
            Box::new(DenyAllApprovals),
        );
        // Promote the route to dispatchable WITHOUT wiring the client (claude stays None) — so the
        // fail-closed is at resolve() (NoClientForProvider), not at select_route.
        rt.mark_route_available("claude");
        rt.mark_route_validated("claude");
        let caller = authed_caller("principal:session-owner");
        let err = rt
            .run_session_task_pinned(
                &caller,
                "run-c2-session-dark",
                "sess-c2-dark-1",
                "make it shorter",
                "claude",
                4_000,
            )
            .expect_err("a dark claude pin must fail closed, never reroute");
        match err {
            RoutedLoopError::NoClientForProvider(p) => {
                assert_eq!(
                    p, "claude",
                    "fail-closed names the dark provider, no reroute"
                )
            }
            other => panic!("expected NoClientForProvider(claude), got {other:?}"),
        }
        // No reroute to deepseek: the deepseek transport was never called.
        assert_eq!(post_calls.get(), 0, "no reroute — deepseek never called");
        // Nothing was billed AND no run row was created (the fail-closed happened before any write).
        assert!(
            rt.db()
                .list_run_token_usage("run-c2-session-dark")
                .unwrap()
                .is_empty(),
            "a dark pin bills nothing"
        );
        let run_rows: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run WHERE run_id = 'run-c2-session-dark'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(run_rows, 0, "no agent_run row was created for the dark pin");
    }

    // ---- C2-1 interrupt / stop: cooperative cancellation in the routed loop ----------------
    //
    // The §3 "interrupt / stop" flow the routed-claude parity harness lists as DEFERRED
    // ("there is no cancel handle on run_task_pinned. WIRING NEEDED: a cancellation token
    // threaded into the routed loop"). This is the GENUINE interrupt: a real metered claude
    // turn is billed, then a hard cancel trips at the turn boundary and the loop stops with NO
    // further model call and NOTHING billed after the trip — NOT a claude_control mirror event,
    // NOT a follow-up turn. NO key, NO network. The `#[ignore]`'d live mirror lives in
    // `tests/routed_claude_parity.rs`.

    /// A cancel-AWARE Claude stub: each metered step surfaces an Anthropic-kind [`BilledUsage`]
    /// (the bits the live `ClaudeAgentLlmClient` maps from a real chat) plus the next scripted
    /// step, AND — to make a single-threaded interrupt deterministic — TRIPS the shared
    /// [`CancelToken`] once it has served `trip_after_calls` steps. So after turn 1 returns, the
    /// token is set; the loop checks it at the TOP of turn 2 and stops BEFORE calling this stub
    /// again. `calls` is an externally-observable `Rc<Cell<usize>>` so the test can assert the
    /// stub was NEVER called for turn 2 (no model call after the trip). This MIRRORS the
    /// existing `StubClaudeMeteredClient` shape; it does NOT modify it (other tests depend on it).
    struct CancelOnCallClaudeStub {
        steps: Vec<AgentStep>,
        prompt_tokens: i64,
        completion_tokens: i64,
        model: String,
        calls: Rc<Cell<usize>>,
        cancel: CancelToken,
        trip_after_calls: usize,
    }
    impl crate::AgentLlmClient for CancelOnCallClaudeStub {
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
            // Trip the token AFTER serving the Nth step — so the just-served turn completes and
            // is billed normally, and the NEXT turn boundary observes the cancel. (`calls` was
            // just incremented to `i+1`, the count of steps served.)
            if self.calls.get() == self.trip_after_calls {
                self.cancel.cancel();
            }
            Ok((Ok(step), Some(usage)))
        }
    }

    /// Build a Claude-wired runtime around a [`CancelOnCallClaudeStub`] and hand back the SAME
    /// flips `runtime_with_claude_wired` performs, plus the externally-observable `calls` handle
    /// and the shared [`CancelToken`]. Mirrors how `runtime_with` returns `post_calls`. Leaves
    /// `runtime_with_claude_wired` / `StubClaudeMeteredClient` untouched (NO-DEGRADE for the
    /// existing harness).
    fn cancellable_claude_runtime(
        tag: &str,
        steps: Vec<AgentStep>,
        trip_after_calls: usize,
    ) -> (
        HubRuntime<ScriptTransport>,
        TempDir,
        CancelToken,
        Rc<Cell<usize>>,
    ) {
        let ws = TempDir::new(tag);
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
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        let calls = Rc::new(Cell::new(0usize));
        let cancel = CancelToken::new();
        rt = rt.with_claude(Box::new(CancelOnCallClaudeStub {
            steps,
            prompt_tokens: 11,
            completion_tokens: 8,
            model: friday_anthropic::DEFAULT_MODEL.to_string(),
            calls: calls.clone(),
            cancel: cancel.clone(),
            trip_after_calls,
        }));
        rt.mark_route_available("claude");
        rt.mark_route_validated("claude");
        (rt, ws, cancel, calls)
    }

    #[test]
    fn run_task_pinned_cancellable_interrupts_claude_loop_after_one_billed_turn() {
        // INTERRUPT / STOP (routed + metered): a claude-pinned run with a MULTI-step script —
        // turn 1 is a read-only tool that CONTINUES the loop (so a turn 2 is scripted), and the
        // cancel token trips right after turn 1 returns. At the TOP of turn 2 the loop observes
        // the cancel and stops with `Interrupted`: it makes NO turn-2 model call and bills
        // NOTHING after the trip. This is the genuine interrupt — a real metered claude turn,
        // then a hard cancel — NOT a claude_control mirror, NOT a follow-up turn.
        //
        // The workspace has `notes.md` so turn 1's `read_file` is a clean Allowed+Executed
        // CONTINUE (read-only needs no approval); turn 2's scripted `Finish` must NEVER be
        // consumed (calls == 1). Step 0 deliberately is NOT a Finish — a Finish would terminate
        // before the turn-2 cancel check ever ran.
        let (rt, ws, cancel, calls) = cancellable_claude_runtime(
            "c2-1-interrupt",
            vec![
                // turn 1: read-only tool → Allowed + Executed → loop CONTINUES to turn 2
                AgentStep::Tool(crate::RawToolCall {
                    action: "read_file".to_string(),
                    params: vec![("path".to_string(), "notes.md".to_string())],
                }),
                // turn 2: would Finish — but the cancel (tripped after turn 1) stops the loop
                // at the turn-2 boundary BEFORE this step is ever requested.
                AgentStep::Finish {
                    message: "SHOULD NEVER BE REACHED".to_string(),
                },
            ],
            1, // trip the cancel after the stub has served 1 step (i.e. after turn 1)
        );
        std::fs::write(ws.join("notes.md"), b"hello").unwrap();

        let (selection, outcome) = rt
            .run_task_pinned_cancellable(
                "run-c2-1-int",
                "do a thing then stop",
                "claude",
                &cancel,
                1_000,
            )
            .expect("the cancellable pinned claude run drives the routed loop");

        // The pin really routed to claude (no reroute).
        assert_eq!(selection.provider_id, "claude", "the pin routed to claude");
        // Terminal status is the NEW Interrupted variant — stopped at the turn-2 boundary.
        assert_eq!(
            outcome.status,
            LoopStatus::Interrupted,
            "the tripped cancel stops the loop with Interrupted"
        );
        // turns == 1: turn 1's model call happened (counted); turn 2's did NOT (the cancel
        // check is BEFORE the model call, so it does not count) — the honest turns==model-calls
        // accounting.
        assert_eq!(outcome.turns, 1, "exactly one model call was made (turn 1)");
        assert_eq!(
            outcome.executed_tools, 1,
            "turn 1's read_file executed before the cancel"
        );

        // THE no-model-call-after-trip proof: the stub was called EXACTLY ONCE. Turn 2's
        // scripted Finish step was NEVER consumed.
        assert_eq!(
            calls.get(),
            1,
            "no model call after the trip — turn 2's scripted step was never consumed"
        );

        // THE bill-nothing-after-trip proof: EXACTLY ONE anthropic ledger row — turn 1's billed
        // claude turn — and nothing after. (provider_kind anthropic, api.anthropic.com,
        // fallback=false: a real metered claude turn, never mis-attributed as deepseek.)
        let rows = rt.db().list_run_token_usage("run-c2-1-int").unwrap();
        assert_eq!(
            rows.len(),
            1,
            "exactly one anthropic row (turn 1); nothing billed after the cancel trip"
        );
        let row = &rows[0];
        assert_eq!(
            row.provider_kind, "anthropic",
            "NOT mis-attributed as deepseek"
        );
        assert_eq!(row.base_url_host, "api.anthropic.com");
        assert!(!row.fallback, "the claude route is never a fallback");
        // Whole-ledger agrees: only the one anthropic row exists (no hidden call).
        let all = rt.db().list_token_usage().unwrap();
        assert_eq!(all.len(), 1, "no hidden model call anywhere in the ledger");
        assert_eq!(all[0].provider_kind, "anthropic");
    }

    #[test]
    fn run_task_pinned_cancellable_untripped_token_is_byte_identical_to_run_task_pinned() {
        // NO-DEGRADE: an un-tripped cancel token reproduces `run_task_pinned` EXACTLY — the run
        // Finishes, billing one anthropic row. The cancel check at each turn boundary is a pure
        // no-op when the token is never tripped (and `None`, the default path, skips it
        // entirely — proven by the unchanged existing `run_task_pinned_*` claude tests).
        let (rt, _ws, cancel, calls) = cancellable_claude_runtime(
            "c2-1-untripped",
            vec![AgentStep::Finish {
                message: "PONG".to_string(),
            }],
            usize::MAX, // never trip
        );
        let (selection, outcome) = rt
            .run_task_pinned_cancellable("run-c2-1-noop", "say pong", "claude", &cancel, 2_000)
            .expect("an un-tripped cancellable run behaves like run_task_pinned");
        assert_eq!(selection.provider_id, "claude");
        assert_eq!(
            outcome.status,
            LoopStatus::Finished,
            "an un-tripped token does not change the terminal status"
        );
        assert_eq!(outcome.turns, 1);
        assert_eq!(calls.get(), 1, "the single Finish turn ran");
        assert!(!cancel.is_cancelled(), "the token was never tripped");
        let rows = rt.db().list_run_token_usage("run-c2-1-noop").unwrap();
        assert_eq!(
            rows.len(),
            1,
            "one anthropic row for the single finished turn"
        );
        assert_eq!(rows[0].provider_kind, "anthropic");
    }

    // ---- C2-2 steer turn: mid-loop re-prompt as an additional metered turn --------------------
    //
    // The §3 "steer / inject mid-loop" flow: an operator instruction folded into the NEXT turn as
    // a REAL additional metered claude turn (NOT the provider-workspace `SteerTurn=Unsupported`
    // mirror, which is no metered turn at all). This is the DETERMINISTIC, no-key dark proof — it
    // drives the REAL public `HubRuntime::run_task_pinned_steerable("claude", ..)` entry to a stub
    // that (a) CAPTURES the prompt it is handed on every call into an externally-observable handle,
    // and (b) injects the steer into the shared `SteerHandle` right after turn 1 — the same
    // single-threaded determinism the C2-1 cancel stub uses. The make-or-break assertion is the
    // DELTA: turn 1's captured prompt does NOT contain the steer; turn 2's DOES — proving the loop
    // folded the injected instruction into the next metered turn, not that the string was always
    // there. Paired with rows 1→2 (an extra billed anthropic row for the steered turn).

    /// A steer-AWARE Claude stub: each metered step surfaces an Anthropic-kind [`BilledUsage`]
    /// (the bits the live `ClaudeAgentLlmClient` maps from a real chat) plus the next scripted
    /// step, CAPTURES the `task` (prompt) it is handed into a shared `Rc<RefCell<Vec<String>>>`
    /// (so the test can assert what the model actually received on each turn), AND — to make a
    /// single-threaded steer deterministic — INJECTS `steer_instruction` into the shared
    /// [`crate::SteerHandle`] once it has served `steer_after_calls` steps. So after turn 1
    /// returns, the handle holds the instruction; the loop drains it at the TOP of turn 2 and
    /// folds it into turn 2's prompt BEFORE calling this stub again — which then captures the
    /// steered prompt as `captured[1]`. MIRRORS the `CancelOnCallClaudeStub` shape; it does NOT
    /// modify the existing stubs (other tests depend on them).
    struct SteerOnCallClaudeStub {
        steps: Vec<AgentStep>,
        prompt_tokens: i64,
        completion_tokens: i64,
        model: String,
        calls: Rc<Cell<usize>>,
        captured: Rc<std::cell::RefCell<Vec<String>>>,
        steer: crate::SteerHandle,
        steer_after_calls: usize,
        steer_instruction: String,
    }
    impl crate::AgentLlmClient for SteerOnCallClaudeStub {
        fn propose_tool_call(&self, _task: &str) -> Result<crate::RawToolCall, crate::AgentError> {
            unreachable!("routed loop uses next_step_metered")
        }
        fn next_step_metered(
            &self,
            task: &str,
            _history: &[crate::TurnTrace],
        ) -> Result<crate::MeteredStep, crate::AgentError> {
            // Capture the EXACT prompt this turn was handed (the load-bearing observation: the
            // steered turn's prompt must contain the injected instruction, the prior turn's must not).
            self.captured.borrow_mut().push(task.to_string());
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
            // Inject the steer AFTER serving the Nth step — so the just-served turn is NOT steered
            // and the NEXT turn boundary drains + folds it. (`calls` was just incremented to `i+1`,
            // the count of steps served.)
            if self.calls.get() == self.steer_after_calls {
                self.steer.steer(self.steer_instruction.clone());
            }
            Ok((Ok(step), Some(usage)))
        }
    }

    /// Build a Claude-wired runtime around a [`SteerOnCallClaudeStub`] and hand back the SAME
    /// flips `runtime_with_claude_wired` performs, plus the externally-observable `calls` and
    /// `captured` handles and the shared [`crate::SteerHandle`]. Mirrors `cancellable_claude_runtime`.
    /// Leaves `runtime_with_claude_wired` / the existing stubs untouched (NO-DEGRADE).
    #[allow(clippy::type_complexity)]
    fn steerable_claude_runtime(
        tag: &str,
        steps: Vec<AgentStep>,
        steer_after_calls: usize,
        steer_instruction: &str,
    ) -> (
        HubRuntime<ScriptTransport>,
        TempDir,
        crate::SteerHandle,
        Rc<Cell<usize>>,
        Rc<std::cell::RefCell<Vec<String>>>,
    ) {
        let ws = TempDir::new(tag);
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
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        let calls = Rc::new(Cell::new(0usize));
        let captured = Rc::new(std::cell::RefCell::new(Vec::new()));
        let steer = crate::SteerHandle::new();
        rt = rt.with_claude(Box::new(SteerOnCallClaudeStub {
            steps,
            prompt_tokens: 11,
            completion_tokens: 8,
            model: friday_anthropic::DEFAULT_MODEL.to_string(),
            calls: calls.clone(),
            captured: captured.clone(),
            steer: steer.clone(),
            steer_after_calls,
            steer_instruction: steer_instruction.to_string(),
        }));
        rt.mark_route_available("claude");
        rt.mark_route_validated("claude");
        (rt, ws, steer, calls, captured)
    }

    #[test]
    fn run_task_pinned_steerable_folds_steer_into_an_additional_metered_claude_turn() {
        // STEER (routed + metered): a claude-pinned run with a MULTI-step script — turn 1 is a
        // read-only tool that CONTINUES the loop (so a turn 2 is scripted), and the operator steer
        // is injected right after turn 1 returns. At the TOP of turn 2 the loop DRAINS the steer
        // and folds it into turn 2's prompt, so turn 2 is a REAL additional metered claude turn
        // whose chat carries the injected instruction. This is the genuine steer — an extra billed
        // claude turn grounded on the injection — NOT a `SteerTurn=Unsupported` mirror.
        //
        // The workspace has `notes.md` so turn 1's `read_file` is a clean Allowed+Executed CONTINUE
        // (read-only needs no approval); turn 2's scripted `Finish` ends the run AFTER the steered
        // metered call. Step 0 deliberately is NOT a Finish — a Finish would terminate before any
        // turn-2 boundary, so the steer would have no next turn to fold into (an honest property:
        // steer changes the CONTENT of an already-continuing turn, it does not resurrect a finished
        // loop).
        const STEER: &str = "ACTUALLY: also summarize the file in one line";
        let (rt, ws, steer, calls, captured) = steerable_claude_runtime(
            "c2-2-steer",
            vec![
                // turn 1: read-only tool → Allowed + Executed → loop CONTINUES to turn 2
                AgentStep::Tool(crate::RawToolCall {
                    action: "read_file".to_string(),
                    params: vec![("path".to_string(), "notes.md".to_string())],
                }),
                // turn 2: Finish — this is the STEERED metered turn (its prompt carries the steer),
                // then the loop ends with the answer.
                AgentStep::Finish {
                    message: "STEERED DONE".to_string(),
                },
            ],
            1, // inject the steer after the stub has served 1 step (i.e. after turn 1)
            STEER,
        );
        std::fs::write(ws.join("notes.md"), b"hello").unwrap();

        let (selection, outcome) = rt
            .run_task_pinned_steerable("run-c2-2-steer", "read the file", "claude", &steer, 1_000)
            .expect("the steerable pinned claude run drives the routed loop");

        // The pin really routed to claude (no reroute).
        assert_eq!(selection.provider_id, "claude", "the pin routed to claude");
        // The run ran the FULL two turns (turn 1 tool, turn 2 the steered Finish) — the steer added
        // a real continuing turn, it did not interrupt.
        assert_eq!(
            outcome.status,
            LoopStatus::Finished,
            "the steered turn finished the run"
        );
        assert_eq!(
            outcome.turns, 2,
            "two model calls: turn 1 + the extra steered turn 2"
        );
        assert_eq!(
            calls.get(),
            2,
            "the stub was called for BOTH turns — the steered turn is a REAL extra model call"
        );
        // The steer was consumed (drained) — it folds into exactly one turn, not silently re-applied.
        assert!(
            steer.drain().is_none(),
            "the steer was consumed by the steered turn (the handle is empty after)"
        );

        // THE faithfulness proof — the DELTA: turn 1's prompt does NOT carry the steer, turn 2's
        // DOES. This proves the loop FOLDED the injected instruction into the next metered turn,
        // not that the string happened to be in the prompt all along. (Captured straight off the
        // stub's `task` argument on each call — what the model actually received.)
        let captured = captured.borrow();
        assert_eq!(captured.len(), 2, "both turns' prompts were captured");
        assert!(
            !captured[0].contains(STEER),
            "turn 1's prompt must NOT contain the steer (it was injected only AFTER turn 1): {:?}",
            captured[0]
        );
        assert!(
            captured[1].contains(STEER),
            "turn 2's prompt MUST contain the folded steer — the stub OBSERVED the injection: {:?}",
            captured[1]
        );

        // THE extra-billed-turn proof: rows grow 1→2, an ADDITIONAL anthropic row for the steered
        // turn. BOTH rows are anthropic / api.anthropic.com / non-fallback — the steered turn is a
        // real metered claude turn, never mis-attributed as deepseek and never a fallback.
        let rows = rt.db().list_run_token_usage("run-c2-2-steer").unwrap();
        assert_eq!(
            rows.len(),
            2,
            "two anthropic rows: turn 1 + the EXTRA billed steered turn 2"
        );
        for row in &rows {
            assert_eq!(
                row.provider_kind, "anthropic",
                "NOT mis-attributed as deepseek"
            );
            assert_eq!(row.base_url_host, "api.anthropic.com");
            assert!(!row.fallback, "the claude route is never a fallback");
        }
        // Whole-ledger agrees: exactly the two anthropic rows exist (no hidden call).
        let all = rt.db().list_token_usage().unwrap();
        assert_eq!(all.len(), 2, "no hidden model call anywhere in the ledger");
        assert!(all.iter().all(|r| r.provider_kind == "anthropic"));
    }

    #[test]
    fn run_task_pinned_steerable_empty_handle_is_byte_identical_to_run_task_pinned() {
        // NO-DEGRADE: an EMPTY steer handle (nothing ever steered) reproduces `run_task_pinned`
        // EXACTLY — the run Finishes in one turn, billing one anthropic row, and the single
        // captured prompt is UNchanged (no `[operator steer]` fold). The drain at each turn
        // boundary is a pure no-op when nothing is pending (and `None`, the default path, skips
        // it entirely — proven by the unchanged existing `run_task_pinned_*` claude tests).
        let (rt, _ws, steer, calls, captured) = steerable_claude_runtime(
            "c2-2-empty",
            vec![AgentStep::Finish {
                message: "PONG".to_string(),
            }],
            usize::MAX, // never inject a steer
            "UNREACHED",
        );
        let (selection, outcome) = rt
            .run_task_pinned_steerable("run-c2-2-empty", "say pong", "claude", &steer, 2_000)
            .expect("an un-steered steerable run behaves like run_task_pinned");
        assert_eq!(selection.provider_id, "claude");
        assert_eq!(
            outcome.status,
            LoopStatus::Finished,
            "an empty steer handle does not change the terminal status"
        );
        assert_eq!(outcome.turns, 1);
        assert_eq!(calls.get(), 1, "the single Finish turn ran");
        // The prompt the model saw is unchanged — no steer was folded in.
        let captured = captured.borrow();
        assert_eq!(captured.len(), 1);
        assert!(
            !captured[0].contains("[operator steer]"),
            "no steer fold on the un-steered path: {:?}",
            captured[0]
        );
        let rows = rt.db().list_run_token_usage("run-c2-2-empty").unwrap();
        assert_eq!(
            rows.len(),
            1,
            "one anthropic row for the single finished turn"
        );
        assert_eq!(rows[0].provider_kind, "anthropic");
    }

    #[test]
    fn steer_is_folded_once_then_remains_in_context_for_the_rest_of_the_run() {
        // The PERSISTS-IN-CONTEXT property (the corrected semantics): the steer is DRAINED/folded
        // exactly ONCE, but having been folded into `prompt_task` it REMAINS in the model's context
        // for every subsequent turn — BY DESIGN, since `TurnTrace` history has no slot to carry a
        // free-form operator instruction (dropping it after one turn would make the model forget the
        // steer mid-task). A 3-step script (tool, tool, Finish) with the steer injected after turn 1
        // pins this: turn 1's prompt has NO steer; turns 2 AND 3 both carry it; and each carries
        // EXACTLY ONE copy (not an accumulating re-append) — the drain fired once.
        const STEER: &str = "ACTUALLY: number each step";
        let (rt, ws, steer, calls, captured) = steerable_claude_runtime(
            "c2-2-steer-persist",
            vec![
                // turn 1: read-only tool → CONTINUE
                AgentStep::Tool(crate::RawToolCall {
                    action: "read_file".to_string(),
                    params: vec![("path".to_string(), "notes.md".to_string())],
                }),
                // turn 2: another read-only tool → CONTINUE (the steered turn)
                AgentStep::Tool(crate::RawToolCall {
                    action: "read_file".to_string(),
                    params: vec![("path".to_string(), "notes.md".to_string())],
                }),
                // turn 3: Finish — the steer must STILL be in this turn's prompt.
                AgentStep::Finish {
                    message: "DONE".to_string(),
                },
            ],
            1, // inject the steer after turn 1
            STEER,
        );
        std::fs::write(ws.join("notes.md"), b"hello").unwrap();

        let (_selection, outcome) = rt
            .run_task_pinned_steerable("run-c2-2-persist", "read the file", "claude", &steer, 1_000)
            .expect("the steerable pinned claude run drives the routed loop");
        assert_eq!(outcome.status, LoopStatus::Finished);
        assert_eq!(outcome.turns, 3, "three metered turns");
        assert_eq!(calls.get(), 3, "the stub was called for all three turns");

        let captured = captured.borrow();
        assert_eq!(captured.len(), 3, "all three turns' prompts were captured");
        assert!(
            !captured[0].contains(STEER),
            "turn 1 (pre-injection) has no steer"
        );
        assert!(
            captured[1].contains(STEER),
            "turn 2 (the steered turn) carries the folded steer"
        );
        assert!(
            captured[2].contains(STEER),
            "turn 3 STILL carries the steer — it remains in context for the rest of the run"
        );
        // Folded in exactly ONCE: each post-steer turn carries EXACTLY ONE copy of the instruction,
        // never an accumulating re-append (which a per-turn re-fold would produce).
        assert_eq!(
            captured[1].matches(STEER).count(),
            1,
            "turn 2 carries exactly one copy of the steer"
        );
        assert_eq!(
            captured[2].matches(STEER).count(),
            1,
            "turn 3 carries exactly one copy — the drain fired once, no re-append per turn"
        );
        // The handle is empty after — the steer was consumed (drained) exactly once.
        assert!(steer.drain().is_none(), "the steer was consumed once");
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

    // ---- session-scoped recall ↔ extraction namespace ALIGNMENT (the fix) ----
    //
    // The defect: the sessioned loop STORES a candidate under the SESSION-DERIVED composite
    // namespace (`tenant.<account>.channel.<channel>.user.<user>.shared`) but the old
    // `recall_preamble` read under the RAW `--owner` string — so a confirmed candidate was
    // NEVER recalled. `recall_preamble_for_session` derives the SAME composite namespace from
    // the session owner, so storage and recall keys are byte-aligned. These tests exercise
    // that private method directly (the runtime half of the storage-layer round-trip already
    // proven in `memory_extraction::extract_persists_candidates_and_recall_reads_them_back…`).

    /// The composite namespace a session owned by `user` (with the sessioned loop's bound
    /// axes: account/channel UNSET → "default"/"unknown") resolves to. This is EXACTLY what
    /// `extract_inline` keys `principal_id` on for such a session — so seeding a candidate
    /// here byte-matches what the live extraction would store.
    fn sessioned_ns(user: &str) -> String {
        crate::session_namespace::resolve_session_memory_namespace(None, None, Some(user)).unwrap()
    }

    /// Bind a session to owner `user` (the sessioned loop's `SessionOwner { user_id: .. }`
    /// shape: account/channel unset), exactly as `run_session_task_*` does before recall.
    fn bind_session_owner(rt: &HubRuntime<CaptureTransport>, session_id: &str, user: &str) {
        friday_storage::agent_session::ensure_session_with_owner(
            rt.db().conn(),
            session_id,
            &SessionOwner {
                user_id: Some(user.to_string()),
                ..SessionOwner::default()
            },
            1,
        )
        .unwrap();
    }

    #[test]
    fn session_recall_round_trips_a_confirmed_candidate_under_the_composite_namespace() {
        // ROUND-TRIP: a candidate stored under owner O's SESSION-DERIVED composite namespace
        // (as extraction stores it) → confirmed → `recall_preamble_for_session` for O's
        // session surfaces it. Before the fix, recall keyed on the raw "alice" and this
        // composite-namespace row was never matched (empty preamble).
        let (rt, _ws, _bodies) = recall_runtime("session-recall-rt", Some("alice"));
        bind_session_owner(&rt, "sess-rt", "alice");
        // Seed a CONFIRMED candidate under the composite namespace (NOT the raw "alice").
        let ns = sessioned_ns("alice");
        assert_eq!(ns, "tenant.default.channel.unknown.user.alice.shared");
        seed_confirmed(&rt, "m-rt", "MEMMARKER-alice-composite", &ns, false);

        let preamble = rt
            .recall_preamble_for_session("sess-rt", "run-rt", 100)
            .expect("session recall composes");
        assert!(
            preamble.contains("MEMMARKER-alice-composite"),
            "the confirmed candidate stored under the composite namespace must be recalled \
             by the session-scoped recall, got preamble: {preamble:?}"
        );

        // CONTROL: the OLD raw-keyed recall would NOT have found it (proves the row is keyed
        // on the composite namespace, not the raw owner — the misalignment the fix closes).
        let raw_preamble = rt
            .recall_preamble("run-rt-raw", 100)
            .expect("raw recall composes");
        assert!(
            !raw_preamble.contains("MEMMARKER-alice-composite"),
            "the raw-owner recall must NOT match a composite-namespace row (the defect)"
        );
    }

    #[test]
    fn session_recall_is_owner_isolated_no_cross_owner_leak() {
        // NO-LEAK (the CRITICAL guard): a confirmed candidate under owner O's composite
        // namespace is NEVER recalled for a DIFFERENT owner O2's session. The composite
        // namespace encodes O's user segment, and the per-principal SQL stays exact-match, so
        // O2's session-derived namespace can never match O's rows.
        let (rt, _ws, _bodies) = recall_runtime("session-recall-noleak", Some("alice"));
        // O = alice, O2 = mallory — distinct principals/users.
        bind_session_owner(&rt, "sess-O", "alice");
        bind_session_owner(&rt, "sess-O2", "mallory");
        let ns_o = sessioned_ns("alice");
        let ns_o2 = sessioned_ns("mallory");
        assert_ne!(ns_o, ns_o2, "distinct owners derive distinct namespaces");
        // Store + confirm a candidate ONLY under O's namespace.
        seed_confirmed(&rt, "m-O", "MEMMARKER-alice-private-O", &ns_o, false);

        // O recalls it (positive control, so the negative below is non-vacuous)...
        let preamble_o = rt
            .recall_preamble_for_session("sess-O", "run-O", 100)
            .expect("O's session recall composes");
        assert!(
            preamble_o.contains("MEMMARKER-alice-private-O"),
            "O must recall its own confirmed candidate"
        );

        // ...but O2's session recalls NOTHING (the load-bearing assertion: NO cross-owner leak).
        let preamble_o2 = rt
            .recall_preamble_for_session("sess-O2", "run-O2", 100)
            .expect("O2's session recall composes");
        assert!(
            preamble_o2.is_empty(),
            "CROSS-OWNER LEAK: O2's session recalled O's confirmed memory: {preamble_o2:?}"
        );
        assert!(
            !preamble_o2.contains("MEMMARKER-alice-private-O"),
            "CROSS-OWNER LEAK: O's private marker reached O2's preamble"
        );
    }

    #[test]
    fn session_recall_fails_closed_on_unresolvable_namespace_returns_empty_not_err() {
        // FAIL-CLOSED: a session whose owner has NO derivable userId (unresolvable namespace)
        // recalls NOTHING — an EMPTY preamble, NEVER an Err and NEVER a broad/raw match. (An
        // Err here would map to NoAnswer in the sessioned caller, killing runs that should
        // proceed — the asymmetry-with-extraction the fix deliberately preserves.)
        let (rt, _ws, _bodies) = recall_runtime("session-recall-failclosed", Some("alice"));
        // Bind a session with account/channel but NO user_id (and no DM/subagent fallback) →
        // the namespace is unresolvable.
        friday_storage::agent_session::ensure_session_with_owner(
            rt.db().conn(),
            "sess-nouser",
            &SessionOwner {
                account_id: Some("default".into()),
                channel: Some("discord".into()),
                user_id: None,
                ..SessionOwner::default()
            },
            1,
        )
        .unwrap();
        // Even if a row happens to exist under SOME composite namespace, an unresolvable
        // session must not match it.
        seed_confirmed(
            &rt,
            "m-x",
            "MEMMARKER-should-not-leak",
            &sessioned_ns("alice"),
            false,
        );
        let preamble = rt
            .recall_preamble_for_session("sess-nouser", "run-nouser", 100)
            .expect("unresolvable namespace recalls empty, never errors");
        assert!(
            preamble.is_empty(),
            "an unresolvable-namespace session must recall NOTHING (fail-closed): {preamble:?}"
        );

        // An ABSENT session row (no owner at all) is likewise empty, not an error.
        let absent = rt
            .recall_preamble_for_session("no-such-session", "run-absent", 100)
            .expect("absent session recalls empty, never errors");
        assert!(absent.is_empty(), "an absent session recalls nothing");
    }

    #[test]
    fn session_recall_derives_namespace_via_dm_chat_id_fallback() {
        // The recall namespace tracks extraction's DM-chatId fallback: a `chat_kind == "dm"`
        // conversation with NO user_id keys on the CHAT-ID-derived namespace (TS parts.chatId)
        // — so a candidate stored under that namespace is recalled, proving recall uses the
        // SAME `resolve_effective_user_id` path extraction uses (not a raw-principal shortcut).
        let (rt, _ws, _bodies) = recall_runtime("session-recall-dm", Some("ignored-owner"));
        friday_storage::agent_session::ensure_session_with_owner(
            rt.db().conn(),
            "dm-sess",
            &SessionOwner {
                account_id: Some("default".into()),
                channel: Some("telegram".into()),
                user_id: None,
                chat_kind: Some("dm".into()),
                chat_id: Some("dm-user-7".into()),
                session_kind: Some("conversation".into()),
                ..SessionOwner::default()
            },
            1,
        )
        .unwrap();
        // The namespace extraction would store under (chat-id as the user segment).
        let ns = crate::session_namespace::resolve_session_memory_namespace(
            Some("default"),
            Some("telegram"),
            Some("dm-user-7"),
        )
        .unwrap();
        seed_confirmed(&rt, "m-dm", "MEMMARKER-dm-derived", &ns, false);
        let preamble = rt
            .recall_preamble_for_session("dm-sess", "run-dm", 100)
            .expect("dm session recall composes");
        assert!(
            preamble.contains("MEMMARKER-dm-derived"),
            "recall must derive the DM-chatId namespace (same as extraction), got: {preamble:?}"
        );
    }

    // ---- THE END-TO-END MEMORY-LOOP GATE: extract → confirm → recall ---------
    //
    // The marquee proof that the loop is CLOSED on the live agent-run ingress: a sessioned run
    // as alice MINTS a candidate under alice's COMPOSITE namespace (extraction), the LIVE confirm
    // handler `memory_decision_result_for_db` (scoped by the AUTHENTICATED owner, NOT the body
    // field) CONFIRMS it, and a LATER sessioned run as alice RECALLS the content. Plus the
    // confirm-side owner-isolation negative (mallory cannot confirm alice's candidate).

    /// Decode a `Message::MemoryDecisionResult` from the confirm handler's reply envelope.
    fn decode_decision(
        env: &friday_protocol::Envelope,
    ) -> friday_protocol::MemoryDecisionResultWire {
        match &env.message {
            friday_protocol::Message::MemoryDecisionResult { result } => result.clone(),
            other => panic!("expected MemoryDecisionResult, got {other:?}"),
        }
    }

    #[test]
    fn memory_loop_end_to_end_extract_confirm_recall_closes_on_agent_run_ingress() {
        // FULL LOOP (the gate). One ScriptTransport serves, in order: post[0] = the agent loop's
        // Finish answer; post[1] = the extraction `run_friday_ask` JSON (one item referencing the
        // session's user turn `<session>:m0`). The session owner is the AUTHENTICATED caller alice
        // (user_id set ⇒ a resolvable composite namespace), so extraction stores under alice's
        // composite namespace — exactly the namespace recall + confirm derive.
        let owner = "alice";
        let session_id = "run-loop-alice"; // the EPHEMERAL per-run session id the None arm uses
        let items = extraction_items_json(&format!("{session_id}:m0"));
        let (rt, _ws, _c) = runtime_with_owner(
            "memloop-e2e",
            owner,
            &["{\"tool\":\"none\",\"answer\":\"PONG\"}", &items],
        );

        // ---- 1. EXTRACT: run a sessioned run as alice, then fire post-run extraction. ----
        let caller = authed_caller(owner);
        let answer =
            rt.run_session_task(&caller, "run-loop-alice", session_id, "remember me", 5_000);
        let delivered_body = match &answer {
            AuthedAnswer::Delivered { answer, status, .. } => {
                assert_eq!(status, "finished", "the run finished");
                answer.clone()
            }
            other => panic!("expected a Delivered answer, got {other:?}"),
        };
        assert_eq!(
            rt.db().count("memory_item").unwrap(),
            0,
            "the run's OWN internal extraction is flag-OFF in the test env (no candidate yet)"
        );
        // Drive the flagged inner with a Finished outcome (env-race-free) ⇒ extraction fires,
        // serving post[1] (the items JSON).
        let outcome = LoopOutcome {
            status: LoopStatus::Finished,
            turns: 1,
            executed_tools: 0,
            final_message: Some(delivered_body),
            detail: String::new(),
        };
        rt.maybe_extract_memory_post_run_flagged(
            session_id,
            "run-loop-alice",
            &outcome,
            6_000,
            true,
        );

        // A Candidate was minted, keyed on alice's COMPOSITE namespace (NOT the raw "alice").
        assert_eq!(
            rt.db().count("memory_item").unwrap(),
            1,
            "extraction recorded exactly one candidate"
        );
        let composite_ns =
            crate::session_namespace::resolve_session_memory_namespace(None, None, Some(owner))
                .unwrap();
        assert_eq!(
            composite_ns, "tenant.default.channel.unknown.user.alice.shared",
            "the composite namespace is the session-derived scope, not the raw principal"
        );
        // Find the minted candidate id + assert its principal_id is the composite namespace.
        let cand_id: String = rt
            .db()
            .conn()
            .query_row("SELECT memory_id FROM memory_item", [], |r| r.get(0))
            .unwrap();
        let cand = friday_storage::memory::get(rt.db().conn(), &cand_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            cand.principal_id.as_deref(),
            Some(composite_ns.as_str()),
            "the candidate is keyed on alice's composite namespace (the recall+confirm scope)"
        );
        assert_eq!(
            cand.state,
            friday_core::MemoryState::Candidate,
            "freshly extracted ⇒ pending Candidate (not yet recallable)"
        );

        // ---- 2. CONFIRM via the LIVE handler, scoped by authenticated_owner=Some("alice"). ----
        // The raw body owner_principal is DELIBERATELY junk to prove it is no longer the scope
        // source; the Rust-derived authenticated owner is what scopes.
        let env = crate::hub_server::memory_decision_result_for_db(
            rt.db(),
            "msg-loop-confirm",
            friday_protocol::MemoryDecisionRequestWire {
                memory_id: cand_id.clone(),
                owner_principal: "ignored-body-field".into(),
                decision: "confirm".into(),
            },
            Some(owner),
            7_000,
        );
        let result = decode_decision(&env);
        assert_eq!(
            result.status, "confirmed",
            "the live confirm handler confirmed it"
        );
        assert_eq!(result.state, "confirmed");
        assert!(
            result.recallable,
            "the confirmed candidate must report recallable (recompute via recall_confirmed_multi)"
        );
        assert!(result.blocker.is_none());

        // ---- 3. RECALL: a LATER sessioned run as alice surfaces the confirmed content. ----
        // Recall is owner-namespace-keyed (not session-keyed): a DIFFERENT (later) session bound
        // to alice recalls the candidate across runs — the loop closed across the run boundary.
        bind_session_owner_st(&rt, "later-sess-alice", owner);
        let preamble = rt
            .recall_preamble_for_session("later-sess-alice", "run-later", 8_000)
            .expect("a later alice session recall composes");
        assert!(
            preamble.contains("User wants concise answers."),
            "the confirmed candidate's content must be recalled by a LATER alice session, \
             got preamble: {preamble:?}"
        );
    }

    /// Bind a session to owner `user` on a ScriptTransport runtime (the sessioned loop's
    /// `SessionOwner { user_id: .. }` shape: account/channel unset), as `run_session_task_*` does.
    fn bind_session_owner_st(rt: &HubRuntime<ScriptTransport>, session_id: &str, user: &str) {
        friday_storage::agent_session::ensure_session_with_owner(
            rt.db().conn(),
            session_id,
            &SessionOwner {
                user_id: Some(user.to_string()),
                ..SessionOwner::default()
            },
            1,
        )
        .unwrap();
    }

    #[test]
    fn memory_confirm_is_owner_isolated_mallory_cannot_confirm_alices_candidate() {
        // CONFIRM OWNER-ISOLATION (the no-cross-owner-leak guard on the confirm side): seed a
        // PENDING candidate under alice's composite namespace; mallory (authenticated) tries to
        // confirm it ⇒ blocked owner_scope_mismatch, candidate UNCHANGED. Positive control: alice
        // (authenticated) confirms the SAME candidate.
        let (rt, _ws, _c) =
            runtime_with_owner("memloop-isolation", "alice", &["{\"tool\":\"none\"}"]);
        let alice_ns =
            crate::session_namespace::resolve_session_memory_namespace(None, None, Some("alice"))
                .unwrap();
        let mallory_ns =
            crate::session_namespace::resolve_session_memory_namespace(None, None, Some("mallory"))
                .unwrap();
        assert_ne!(
            alice_ns, mallory_ns,
            "distinct owners ⇒ distinct namespaces"
        );
        // Seed a PENDING (Candidate-state), content-bearing row under alice's composite namespace.
        // record_candidate ONLY (NOT confirm) so the positive control below is decidable.
        friday_storage::memory::record_candidate(
            rt.db().conn(),
            &friday_storage::memory::NewMemoryCandidate {
                memory_id: "mem-iso",
                scope: friday_core::MemoryScope::Global,
                content_ref: None,
                content: Some("alice's private fact"),
                principal_id: Some(alice_ns.as_str()),
                sensitive: false,
                created_at: 1,
            },
        )
        .unwrap();

        // mallory CANNOT confirm: her namespace candidate list never contains alice's namespace.
        let env = crate::hub_server::memory_decision_result_for_db(
            rt.db(),
            "msg-iso-mallory",
            friday_protocol::MemoryDecisionRequestWire {
                memory_id: "mem-iso".into(),
                owner_principal: "alice".into(), // even spoofing alice in the body can't help
                decision: "confirm".into(),
            },
            Some("mallory"),
            100,
        );
        let blocked = decode_decision(&env);
        assert_eq!(blocked.status, "blocked", "mallory must be blocked");
        assert_eq!(blocked.blocker.as_deref(), Some("owner_scope_mismatch"));
        assert!(!blocked.recallable);
        // UNCHANGED: still a pending Candidate; recallable by no one.
        assert_eq!(
            friday_storage::memory::get(rt.db().conn(), "mem-iso")
                .unwrap()
                .unwrap()
                .state,
            friday_core::MemoryState::Candidate,
            "the candidate is UNCHANGED after the blocked cross-owner confirm"
        );

        // POSITIVE CONTROL: alice (authenticated) confirms the SAME candidate ⇒ confirmed.
        let env = crate::hub_server::memory_decision_result_for_db(
            rt.db(),
            "msg-iso-alice",
            friday_protocol::MemoryDecisionRequestWire {
                memory_id: "mem-iso".into(),
                owner_principal: "ignored-body-field".into(),
                decision: "confirm".into(),
            },
            Some("alice"),
            101,
        );
        let confirmed = decode_decision(&env);
        assert_eq!(
            confirmed.status, "confirmed",
            "alice (the true owner) confirms her own candidate"
        );
        assert!(confirmed.recallable);
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

    // ---- NS-6: DARK flag-gated Context-Passport mint at the mission-bound handoff -----

    /// The pure NS-6 flag-matcher: DEFAULT-OFF, ON only for the exact opt-in `"1"` (trimmed),
    /// everything else OFF. Driven directly (no `set_var`) — the file's env-race-free idiom.
    #[test]
    fn passport_mint_flag_is_off_by_default_and_on_only_for_exactly_1() {
        assert!(!passport_mint_from(None), "unset ⇒ OFF (prod default)");
        assert!(passport_mint_from(Some("1")), "exactly \"1\" ⇒ ON");
        assert!(passport_mint_from(Some(" 1 ")), "trimmed \"1\" ⇒ ON");
        for off in ["", "0", "true", "yes", "01", "1 0", "enabled", "TRUE"] {
            assert!(
                !passport_mint_from(Some(off)),
                "{off:?} must NOT enable the mint"
            );
        }
        // Sanity: the live env var is unset in the test process ⇒ the real read reports OFF.
        assert!(
            !passport_mint_from(std::env::var(ENV_PASSPORT_MINT).ok().as_deref()),
            "FRIDAY_PASSPORT_MINT must be unset/off in the test env (prod default)"
        );
    }

    /// (WI-1, M-6) The pure WorkItem-guarded-transition flag-matcher: DEFAULT-OFF, ON only for the
    /// exact opt-in `"1"` (trimmed), everything else OFF. Driven directly (no `set_var`) — the
    /// program-standard env-race-free idiom.
    #[test]
    fn workitem_guarded_transition_flag_is_off_by_default_and_on_only_for_exactly_1() {
        assert!(
            !workitem_guarded_transition_from(None),
            "unset ⇒ OFF (prod default)"
        );
        assert!(
            workitem_guarded_transition_from(Some("1")),
            "exactly \"1\" ⇒ ON"
        );
        assert!(
            workitem_guarded_transition_from(Some(" 1 ")),
            "trimmed \"1\" ⇒ ON"
        );
        for off in ["", "0", "true", "yes", "01", "1 0", "enabled", "TRUE"] {
            assert!(
                !workitem_guarded_transition_from(Some(off)),
                "{off:?} must NOT enable the guarded transition"
            );
        }
        // Sanity: the live env var is unset in the test process ⇒ the real read reports OFF.
        assert!(
            !workitem_guarded_transition_from(
                std::env::var(ENV_WORKITEM_GUARDED_TRANSITION)
                    .ok()
                    .as_deref()
            ),
            "FRIDAY_WORKITEM_GUARDED_TRANSITION must be unset/off in the test env (prod default)"
        );
    }

    // ── NS8-WIRE-1 (Loop5): post-run memory-extraction TRIGGER from the live sessioned loop ──

    #[test]
    fn run_loop_memory_extraction_flag_matcher_is_exact_one_default_off() {
        // The DEFAULT-OFF exact-"1" matcher idiom (mirrors the claude/passport/workitem gates).
        assert!(
            !run_loop_memory_extraction_from(None),
            "unset ⇒ OFF (prod default)"
        );
        assert!(
            run_loop_memory_extraction_from(Some("1")),
            "exactly \"1\" ⇒ ON"
        );
        assert!(
            run_loop_memory_extraction_from(Some(" 1 ")),
            "trimmed \"1\" ⇒ ON"
        );
        for off in ["", "0", "true", "yes", "01", "1 0", "enabled", "TRUE"] {
            assert!(
                !run_loop_memory_extraction_from(Some(off)),
                "{off:?} must NOT enable post-run extraction"
            );
        }
        // Sanity: the live env var is unset in the test process ⇒ the real read reports OFF.
        assert!(
            !run_loop_memory_extraction_from(
                std::env::var(ENV_RUN_LOOP_MEMORY_EXTRACTION)
                    .ok()
                    .as_deref()
            ),
            "FRIDAY_RUN_LOOP_MEMORY_EXTRACTION must be unset/off in the test env (prod default)"
        );
    }

    /// The extraction JSON the producer's `run_friday_ask` chat returns (one valid candidate
    /// referencing the session's user turn id `<run>:m0`). A safe (non-sensitive) item.
    fn extraction_items_json(source_msg_id: &str) -> String {
        serde_json::json!({
            "items": [{
                "kind": "preference",
                "content": "User wants concise answers.",
                "sourceMessageIds": [source_msg_id],
            }]
        })
        .to_string()
    }

    #[test]
    fn post_run_extraction_flag_on_finished_fires_and_never_changes_the_run() {
        // KAT (flag-ON + Finished): the post-run extraction TRIGGER fires the existing producer,
        // its result is DISCARDED, and the RUN's answer/status/run_result row are UNCHANGED.
        //
        // Sequence on ONE up-front-scripted transport: post[0] = the agent loop's Finish; post[1]
        // = the extraction `run_friday_ask` chat (the candidate JSON, referencing the session's
        // user turn `sess-ns8wire:m0` — `append_session_message` mints `<session>:m<seq>`). The
        // session owner is the authenticated caller (user_id set ⇒ a resolvable memory namespace),
        // so extraction does NOT fail closed on namespace.
        let owner = "owner-ns8wire";
        let items = extraction_items_json("sess-ns8wire:m0");
        let (rt, _ws, _c) = runtime_with_owner(
            "ns8wire-on",
            owner,
            &["{\"tool\":\"none\",\"answer\":\"PONG\"}", &items],
        );
        // The first run drives the loop to Finish (post[0]); the test process env is OFF, so the
        // run's OWN internal `maybe_extract_memory_post_run` is a no-op (verified: zero extraction).
        let caller = authed_caller(owner);
        let answer = rt.run_session_task(&caller, "run-ns8wire", "sess-ns8wire", "say pong", 5_000);
        // The run Delivered an owned answer.
        let delivered_body = match &answer {
            AuthedAnswer::Delivered { answer, status, .. } => {
                assert_eq!(status, "finished", "the run finished");
                answer.clone()
            }
            other => panic!("expected a Delivered answer, got {other:?}"),
        };
        // Snapshot the run_result row + DB counts BEFORE the (flag-ON) extraction step.
        let before = friday_storage::get_run_result(rt.db().conn(), "run-ns8wire")
            .unwrap()
            .expect("a finished run has a run_result row");
        assert_eq!(before.status, "finished");
        let ledger_before = rt.db().count("token_ledger").unwrap();
        let mem_before = rt.db().count("memory_item").unwrap();
        assert_eq!(
            mem_before, 0,
            "flag-OFF internal call created NO candidate (byte-identical baseline)"
        );

        // Fire the flagged inner directly with a Finished outcome (the env-race-free idiom — no
        // set_var). The extraction is the NEXT chat POST → the transport serves post[1] (items).
        let outcome = LoopOutcome {
            status: LoopStatus::Finished,
            turns: 1,
            executed_tools: 0,
            final_message: Some(delivered_body.clone()),
            detail: String::new(),
        };
        rt.maybe_extract_memory_post_run_flagged(
            "sess-ns8wire",
            "run-ns8wire",
            &outcome,
            6_000,
            true, // flag ON
        );

        // PROOF extraction FIRED: it billed a token_ledger row AND recorded a Candidate.
        assert_eq!(
            rt.db().count("token_ledger").unwrap(),
            ledger_before + 1,
            "the extraction call was ledgered (it fired)"
        );
        assert_eq!(
            rt.db().count("memory_item").unwrap(),
            mem_before + 1,
            "the extraction recorded a Candidate (it fired)"
        );
        // PROOF the RUN is UNCHANGED: the run_result row (status + answer body) is byte-identical;
        // extraction writes token_ledger/memory_item only, NEVER run_result, so it cannot flip
        // Delivered→NoAnswer.
        let after = friday_storage::get_run_result(rt.db().conn(), "run-ns8wire")
            .unwrap()
            .expect("the run_result row still exists");
        assert_eq!(
            after.status, before.status,
            "status unchanged (still finished)"
        );
        assert_eq!(after.answer, before.answer, "answer body unchanged");
        assert_eq!(
            after.answer, delivered_body,
            "the delivered answer is exactly the persisted answer (unaffected by extraction)"
        );
    }

    #[test]
    fn post_run_extraction_not_fired_on_non_finished_outcomes() {
        // KAT (flag-ON + Paused/Errored/etc.): extraction is gated on Finished ONLY. A non-Finished
        // outcome fires NOTHING — no provider call, no ledger row, no candidate.
        let owner = "owner-ns8wire-np";
        let (rt, _ws, _c) =
            runtime_with_owner("ns8wire-nonfinished", owner, &["{\"tool\":\"none\"}"]);
        // Seed an owned session WITH a pending message so extraction COULD fire if it were not
        // gated — proving the gate (not an empty session) is what blocks it.
        friday_storage::ensure_session_with_owner(
            rt.db().conn(),
            "sess-np",
            &SessionOwner {
                user_id: Some(owner.to_string()),
                ..SessionOwner::default()
            },
            1,
        )
        .unwrap();
        friday_storage::append_session_message(
            rt.db().conn(),
            "sess-np",
            &friday_storage::SessionMessage::new("user", "remember this", None),
            2,
        )
        .unwrap();
        let ledger_before = rt.db().count("token_ledger").unwrap();
        let mem_before = rt.db().count("memory_item").unwrap();

        for status in [
            LoopStatus::Paused,
            LoopStatus::Errored,
            LoopStatus::Bounded,
            LoopStatus::Blocked,
            LoopStatus::Interrupted,
        ] {
            let outcome = LoopOutcome {
                status,
                turns: 1,
                executed_tools: 0,
                final_message: None,
                detail: String::new(),
            };
            rt.maybe_extract_memory_post_run_flagged("sess-np", "run-np", &outcome, 3_000, true);
        }
        assert_eq!(
            rt.db().count("token_ledger").unwrap(),
            ledger_before,
            "no non-Finished outcome may fire extraction (no ledger row)"
        );
        assert_eq!(
            rt.db().count("memory_item").unwrap(),
            mem_before,
            "no non-Finished outcome may record a candidate"
        );
    }

    #[test]
    fn post_run_extraction_flag_off_is_byte_identical_even_on_finished() {
        // KAT (flag-OFF): the DEFAULT. Even on a Finished outcome with a pending-message,
        // owned (namespace-resolvable) session — i.e. extraction WOULD fire were the flag on —
        // the OFF path returns before ANY work: no provider call, no token_ledger row, no
        // candidate. Byte-identical to the pre-NS8-WIRE-1 baseline. A PanicTransport proves zero
        // provider contact.
        struct PanicTransport;
        impl Transport for PanicTransport {
            fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
                panic!("flag-OFF must make NO provider call (discover)");
            }
            fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
                panic!("flag-OFF must make NO provider call (chat)");
            }
        }
        let owner = "owner-ns8wire-off";
        let tag = "ns8wire-off";
        let ws = TempDir::new(tag);
        let client = DeepSeekClient::with_transport(PanicTransport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 6,
                principal_id: Some(owner.to_string()),
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        // An owned session WITH a pending message (extraction would fire if the flag were on).
        friday_storage::ensure_session_with_owner(
            rt.db().conn(),
            "sess-off",
            &SessionOwner {
                user_id: Some(owner.to_string()),
                ..SessionOwner::default()
            },
            1,
        )
        .unwrap();
        friday_storage::append_session_message(
            rt.db().conn(),
            "sess-off",
            &friday_storage::SessionMessage::new("user", "remember this", None),
            2,
        )
        .unwrap();
        let ledger_before = rt.db().count("token_ledger").unwrap();
        let mem_before = rt.db().count("memory_item").unwrap();

        let outcome = LoopOutcome {
            status: LoopStatus::Finished,
            turns: 1,
            executed_tools: 0,
            final_message: Some("PONG".to_string()),
            detail: String::new(),
        };
        // enabled = false ⇒ the OFF path. The PanicTransport guarantees it never touches the
        // provider; the counts prove it never touched storage either.
        rt.maybe_extract_memory_post_run_flagged("sess-off", "run-off", &outcome, 3_000, false);

        assert_eq!(
            rt.db().count("token_ledger").unwrap(),
            ledger_before,
            "flag-OFF fires NO extraction (no ledger row) — byte-identical baseline"
        );
        assert_eq!(
            rt.db().count("memory_item").unwrap(),
            mem_before,
            "flag-OFF records NO candidate — byte-identical baseline"
        );
    }

    /// A transport that serves a Finish on the FIRST chat POST (the agent loop) but FAILS every
    /// later chat POST (the extraction `run_friday_ask` call) with a transient provider error —
    /// the failure-isolation probe. `/models` (GET) always succeeds (discovery is not the failure).
    struct FailExtractionTransport {
        post_calls: Rc<Cell<usize>>,
    }
    impl FailExtractionTransport {
        fn new() -> Self {
            Self {
                post_calls: Rc::new(Cell::new(0)),
            }
        }
    }
    impl Transport for FailExtractionTransport {
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
            if n == 0 {
                // The agent loop's turn: Finish with an answer.
                Ok(serde_json::json!({
                    "model":"deepseek-v4-flash",
                    "choices":[{"message":{"content":"{\"tool\":\"none\",\"answer\":\"PONG\"}"},"finish_reason":"stop"}],
                    "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
                }))
            } else {
                // The extraction call FAILS — a transient provider-unavailable error.
                Err(DeepSeekError::ProviderUnavailable("extraction down".into()))
            }
        }
    }

    #[test]
    fn post_run_extraction_failure_is_isolated_run_stays_finished() {
        // KAT (failure-isolation): the extraction call ERRORS (provider unavailable on the
        // extraction POST). The `let _` swallows it — the RUN already Finished and its run_result
        // row is UNCHANGED; no candidate is recorded. An extraction error can NEVER break the run.
        let owner = "owner-ns8wire-fail";
        let tag = "ns8wire-fail";
        let ws = TempDir::new(tag);
        let transport = FailExtractionTransport::new();
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 6,
                principal_id: Some(owner.to_string()),
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();

        let caller = authed_caller(owner);
        let answer = rt.run_session_task(&caller, "run-fail", "sess-fail", "say pong", 5_000);
        let delivered_body = match &answer {
            AuthedAnswer::Delivered { answer, status, .. } => {
                assert_eq!(status, "finished");
                answer.clone()
            }
            other => panic!("expected Delivered, got {other:?}"),
        };
        let before = friday_storage::get_run_result(rt.db().conn(), "run-fail")
            .unwrap()
            .expect("finished run has a result");
        let mem_before = rt.db().count("memory_item").unwrap();

        let outcome = LoopOutcome {
            status: LoopStatus::Finished,
            turns: 1,
            executed_tools: 0,
            final_message: Some(delivered_body.clone()),
            detail: String::new(),
        };
        // The extraction call (post[1]) returns Err — this MUST NOT panic / propagate / break.
        // The `let _` in `maybe_extract_memory_post_run_flagged` isolates the failure.
        rt.maybe_extract_memory_post_run_flagged("sess-fail", "run-fail", &outcome, 6_000, true);

        // The extraction failed BEFORE recording any candidate (no partial state).
        assert_eq!(
            rt.db().count("memory_item").unwrap(),
            mem_before,
            "a failed extraction records NO candidate"
        );
        // The RUN is UNCHANGED: still finished, same answer body. Failure isolated.
        let after = friday_storage::get_run_result(rt.db().conn(), "run-fail")
            .unwrap()
            .expect("the run_result row survives a failed extraction");
        assert_eq!(after.status, "finished", "the run stays Finished");
        assert_eq!(after.answer, before.answer, "the answer body is unchanged");
    }

    /// A runtime whose run-owner principal is `principal` (so the confirmed-memory recall — the
    /// NS-6 real item source — is enabled and keyed on it). Mirrors `runtime_with` but sets the
    /// owner instead of `None`.
    fn runtime_with_owner(
        tag: &str,
        owner: &str,
        contents: &[&str],
    ) -> (HubRuntime<ScriptTransport>, TempDir, Rc<Cell<usize>>) {
        let ws = TempDir::new(tag);
        let transport = ScriptTransport::new(contents);
        let post_calls = transport.post_calls.clone();
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 6,
                principal_id: Some(owner.to_string()),
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        (rt, ws, post_calls)
    }

    /// Seed a CONFIRMED, content-bearing memory row owned by `principal` (so `recall_confirmed`
    /// returns it). `sensitive` marks it as the secret-bearing test vector — under v1 deny-all
    /// (no transfer approval) a sensitive item makes `build_context_passport` fail-closed, the
    /// faithful `context_passport_blocked` path. Returns the row's content (the secret canary).
    fn seed_confirmed_memory(db: &Db, id: &str, principal: &str, content: &str, sensitive: bool) {
        friday_storage::memory::record_candidate(
            db.conn(),
            &friday_storage::memory::NewMemoryCandidate {
                memory_id: id,
                scope: friday_core::MemoryScope::Global,
                content_ref: None,
                content: Some(content),
                principal_id: Some(principal),
                sensitive,
                created_at: 900_000_000_000,
            },
        )
        .unwrap();
        friday_storage::memory::confirm(db.conn(), id, 950_000_000_000).unwrap();
    }

    fn context_passport_link_count(rt: &HubRuntime<ScriptTransport>, mission_id: &str) -> usize {
        rt.db()
            .list_mission_links(mission_id)
            .unwrap()
            .iter()
            .filter(|l| l.link_kind == friday_core::MissionLinkKind::ContextPassport)
            .count()
    }

    /// NS-6 (flag ON + BENIGN context): the handoff mints a real destination-bound passport from
    /// the recalled-memory items, PERSISTS the `ContextPassport` row, creates a ContextPassport
    /// `MissionLink`, pushes the `passport_id` to `mission.context_passport_refs`, THEN the run
    /// proceeds normally (`Ran`).
    #[test]
    fn passport_mint_on_benign_mints_persists_links_then_runs() {
        let (rt, root, _post) = runtime_with_owner(
            "ns6-benign",
            "owner-1",
            &[
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"none\"}",
            ],
        );
        std::fs::write(root.join("notes.md"), b"mission-bound note").unwrap();
        seed_loop_mission(
            rt.db(),
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );
        // A REAL benign confirmed-memory item the run carries into its prompt (the item source).
        seed_confirmed_memory(
            rt.db(),
            "mem-benign",
            "owner-1",
            "prefers concise summaries",
            false,
        );

        let run_id = "run-ns6-benign";
        let outcome = rt
            .run_agent_loop_for_mission_with_overrides_flagged(
                loop_lookup(),
                "friday-hub-session",
                run_id,
                "read the notes",
                None,
                None,
                /* passport_mint = */ true,
                /* workitem_guarded = */ false,
                1000,
            )
            .unwrap();

        // The run proceeded normally.
        assert!(
            matches!(outcome, MissionBoundLoopOutcome::Ran { .. }),
            "benign mint must proceed to a normal run, got {outcome:?}"
        );
        assert_eq!(agent_run_count(&rt, run_id), 1, "the loop ran");

        // A ContextPassport ROW was persisted, bound to THIS run + the resolved destination.
        let passport_id = format!("context-passport:agent-loop:{run_id}");
        let passport = rt
            .db()
            .get_context_passport(&passport_id)
            .unwrap()
            .expect("a ContextPassport row must be persisted on the benign mint");
        assert_eq!(passport.mission_id, "mission-loop");
        assert_eq!(passport.work_item_id.as_deref(), Some("work-loop"));
        assert_eq!(passport.destination_lane, WorkLane::DeepSeek);
        assert_eq!(passport.destination_target.as_deref(), Some("deepseek"));
        assert!(
            passport
                .items
                .iter()
                .any(|i| i.label == "prefers concise summaries"),
            "the passport carries the REAL recalled item, got {:?}",
            passport.items
        );

        // A ContextPassport MissionLink exists.
        assert_eq!(
            context_passport_link_count(&rt, "mission-loop"),
            1,
            "exactly one ContextPassport mission_link must exist"
        );

        // The passport_id was pushed to mission.context_passport_refs.
        let mission = rt.db().get_mission("mission-loop").unwrap().unwrap();
        assert!(
            mission.context_passport_refs.contains(&passport_id),
            "mission.context_passport_refs must contain the minted passport_id, got {:?}",
            mission.context_passport_refs
        );
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    /// NS-6 (flag ON + SECRET context): a `sensitive` (secret-bearing) recalled item makes
    /// `build_context_passport` fail-closed via `gate_transfer`, so the handoff returns `Blocked`
    /// with a `context_passport_blocked` reason. The run NEVER executes (no agent_run, no model
    /// call), NOTHING persists (no passport row, no ContextPassport link, no new ref), and the
    /// secret string appears in NO persisted row.
    #[test]
    fn passport_mint_on_secret_item_fails_closed_no_run_no_persist() {
        const SECRET_CANARY: &str = "SECRET-CANARY-ns6-must-never-persist-sk-live-abc123";
        let (rt, root, post) =
            runtime_with_owner("ns6-secret", "owner-1", &["{\"tool\":\"none\"}"]);
        std::fs::write(root.join("notes.md"), b"x").unwrap();
        seed_loop_mission(
            rt.db(),
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );
        // A SENSITIVE (secret-bearing) confirmed memory — MemoryRow.sensitive is documented as
        // the "PII/secret-bearing marker"; under v1 deny-all it cannot clear the transfer gate.
        seed_confirmed_memory(rt.db(), "mem-secret", "owner-1", SECRET_CANARY, true);

        let run_id = "run-ns6-secret";
        let outcome = rt
            .run_agent_loop_for_mission_with_overrides_flagged(
                loop_lookup(),
                "friday-hub-session",
                run_id,
                "do work",
                None,
                None,
                /* passport_mint = */ true,
                /* workitem_guarded = */ false,
                1000,
            )
            .unwrap();

        // FAIL CLOSED: Blocked, carrying the passport-blocked reason.
        let MissionBoundLoopOutcome::Blocked { blockers } = outcome else {
            panic!("a secret-bearing context must FAIL CLOSED (Blocked), got {outcome:?}");
        };
        assert!(
            blockers
                .iter()
                .any(|b| b.contains("context_passport_blocked")),
            "the blocker must name the passport-blocked reason, got {blockers:?}"
        );

        // The run NEVER executed: no agent_run row, no model call.
        assert_eq!(
            agent_run_count(&rt, run_id),
            0,
            "no run on the blocked handoff"
        );
        assert_eq!(post.get(), 0, "no model call on the blocked handoff");

        // NOTHING persisted: no passport row, no ContextPassport mission_link, no new ref.
        let passport_id = format!("context-passport:agent-loop:{run_id}");
        assert!(
            rt.db()
                .get_context_passport(&passport_id)
                .unwrap()
                .is_none(),
            "no ContextPassport row may persist on the blocked handoff"
        );
        assert_eq!(
            context_passport_link_count(&rt, "mission-loop"),
            0,
            "no ContextPassport mission_link may persist on the blocked handoff"
        );
        let mission = rt.db().get_mission("mission-loop").unwrap().unwrap();
        assert!(
            mission.context_passport_refs.is_empty(),
            "no passport ref may be pushed on the blocked handoff, got {:?}",
            mission.context_passport_refs
        );

        // The secret string appears in NO persisted TRANSFER artifact. The secret legitimately
        // lives ONLY in `memory_item` (the Hub-held source we seeded — that is where confirmed
        // memory rightfully rests); the fail-closed proof is that it NEVER escaped into any
        // transfer-surface row (the passport object/items, the mission_link, the run, the audit).
        let leaked = secret_string_present_in_db(rt.db(), SECRET_CANARY, &["memory_item"]);
        assert!(
            !leaked,
            "the secret canary must NOT appear in any transfer artifact (it stays Hub-held in memory_item only)"
        );
    }

    /// NS-6 (flag ON + MIXED context — 1 benign + 1 sensitive recalled item): PINS the
    /// all-or-nothing whole-unit semantics. `mint_handoff_passport` hands the WHOLE recalled set
    /// (every item `included: true`) to `build_context_passport`, which gates the set as ONE
    /// transfer artifact: the lone sensitive item makes the ENTIRE build fail-closed under v1
    /// deny-all, so the whole handoff is `Blocked` and the benign item is NOT carried (no partial
    /// passport persists). This is DELIBERATELY MORE RESTRICTIVE than the per-item recall path
    /// (`gate_and_render_recall`), which would drop only the sensitive item and inject the benign
    /// one — here a context CONTAINING a secret item blocks the whole transfer unit, never leaks.
    /// The run NEVER executes (no agent_run, no model call), NOTHING persists (no passport row, no
    /// ContextPassport link, no new ref), and the secret string lands in no transfer artifact.
    #[test]
    fn passport_mint_mixed_set_one_sensitive_blocks_whole_handoff_fail_closed() {
        const SECRET_CANARY: &str = "SECRET-CANARY-ns6-mixed-must-never-persist-sk-live-xyz789";
        let (rt, root, post) = runtime_with_owner("ns6-mixed", "owner-1", &["{\"tool\":\"none\"}"]);
        std::fs::write(root.join("notes.md"), b"x").unwrap();
        seed_loop_mission(
            rt.db(),
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );
        // A MIXED recall set for the SAME principal: one benign + one sensitive confirmed memory,
        // both content-bearing so both survive `recall_confirmed → rank_recall` (top_k = 8) and
        // both land in the single `PassportItem` set handed to `build_context_passport`.
        seed_confirmed_memory(
            rt.db(),
            "mem-mixed-benign",
            "owner-1",
            "prefers concise summaries",
            false,
        );
        seed_confirmed_memory(rt.db(), "mem-mixed-secret", "owner-1", SECRET_CANARY, true);

        let run_id = "run-ns6-mixed";
        let outcome = rt
            .run_agent_loop_for_mission_with_overrides_flagged(
                loop_lookup(),
                "friday-hub-session",
                run_id,
                "do work",
                None,
                None,
                /* passport_mint = */ true,
                /* workitem_guarded = */ false,
                1000,
            )
            .unwrap();

        // WHOLE-UNIT FAIL CLOSED: a single sensitive item blocks the ENTIRE passport build.
        let MissionBoundLoopOutcome::Blocked { blockers } = outcome else {
            panic!(
                "a mixed set with ANY sensitive item must FAIL CLOSED (Blocked), got {outcome:?}"
            );
        };
        assert!(
            blockers
                .iter()
                .any(|b| b.contains("context_passport_blocked")),
            "the blocker must name the passport-blocked reason, got {blockers:?}"
        );

        // The run NEVER executed: no agent_run row, no model call.
        assert_eq!(
            agent_run_count(&rt, run_id),
            0,
            "no run on the blocked mixed-set handoff"
        );
        assert_eq!(
            post.get(),
            0,
            "no model call on the blocked mixed-set handoff"
        );

        // NOTHING persisted — the benign item is NOT carried because the WHOLE unit is blocked.
        let passport_id = format!("context-passport:agent-loop:{run_id}");
        assert!(
            rt.db()
                .get_context_passport(&passport_id)
                .unwrap()
                .is_none(),
            "no ContextPassport row may persist — the benign item is NOT partially carried"
        );
        assert_eq!(
            context_passport_link_count(&rt, "mission-loop"),
            0,
            "no ContextPassport mission_link may persist on the blocked mixed-set handoff"
        );
        let mission = rt.db().get_mission("mission-loop").unwrap().unwrap();
        assert!(
            mission.context_passport_refs.is_empty(),
            "no passport ref may be pushed on the blocked mixed-set handoff, got {:?}",
            mission.context_passport_refs
        );

        // The secret string lands in NO transfer artifact (it stays Hub-held in `memory_item`).
        let leaked = secret_string_present_in_db(rt.db(), SECRET_CANARY, &["memory_item"]);
        assert!(
            !leaked,
            "the secret canary must NOT appear in any transfer artifact (it stays Hub-held in memory_item only)"
        );
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    /// NS-6 (flag OFF — the prod default): BYTE-IDENTICAL to the pre-NS-6 baseline — the run
    /// proceeds normally (`Ran`) and NO passport is minted (no row, no ContextPassport link, no
    /// ref), even with a benign recallable item present that WOULD mint under the flag.
    #[test]
    fn passport_mint_flag_off_is_byte_identical_no_mint() {
        let (rt, root, _post) = runtime_with_owner(
            "ns6-off",
            "owner-1",
            &[
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"none\"}",
            ],
        );
        std::fs::write(root.join("notes.md"), b"mission-bound note").unwrap();
        seed_loop_mission(
            rt.db(),
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );
        seed_confirmed_memory(
            rt.db(),
            "mem-off",
            "owner-1",
            "prefers concise summaries",
            false,
        );

        let run_id = "run-ns6-off";
        let outcome = rt
            .run_agent_loop_for_mission_with_overrides_flagged(
                loop_lookup(),
                "friday-hub-session",
                run_id,
                "read the notes",
                None,
                None,
                /* passport_mint = */ false,
                /* workitem_guarded = */ false,
                1000,
            )
            .unwrap();

        // Normal run (the pre-NS-6 outcome), and NO passport machinery touched.
        assert!(
            matches!(outcome, MissionBoundLoopOutcome::Ran { .. }),
            "flag-OFF must be the normal run, got {outcome:?}"
        );
        assert_eq!(agent_run_count(&rt, run_id), 1, "the loop ran (unchanged)");
        let passport_id = format!("context-passport:agent-loop:{run_id}");
        assert!(
            rt.db()
                .get_context_passport(&passport_id)
                .unwrap()
                .is_none(),
            "flag-OFF must mint NO ContextPassport row"
        );
        assert_eq!(
            context_passport_link_count(&rt, "mission-loop"),
            0,
            "flag-OFF must create NO ContextPassport mission_link"
        );
        let mission = rt.db().get_mission("mission-loop").unwrap().unwrap();
        assert!(
            mission.context_passport_refs.is_empty(),
            "flag-OFF must push NO passport ref"
        );
    }

    /// Scan every TEXT column of every table (except `exclude` — the legitimate Hub-held source
    /// tables) for `needle` — the leak canary the secret-path test uses to prove the secret
    /// string never lands in a persisted TRANSFER artifact.
    fn secret_string_present_in_db(db: &Db, needle: &str, exclude: &[&str]) -> bool {
        let conn = db.conn();
        let tables: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                )
                .unwrap();
            let collected = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            collected
        };
        for table in tables {
            if exclude.contains(&table.as_str()) {
                continue;
            }
            let mut stmt = conn.prepare(&format!("SELECT * FROM \"{table}\"")).unwrap();
            let col_count = stmt.column_count();
            let mut rows = stmt.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                for i in 0..col_count {
                    // Pull the value as text where possible; non-text columns yield None.
                    if let Ok(Some(v)) = row.get::<_, Option<String>>(i) {
                        if v.contains(needle) {
                            return true;
                        }
                    }
                }
            }
        }
        false
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
