//! Friday Hub runtime — **composition root + agent turn loop** (file 39 §6 / file
//! 52 PR-6). Hub-only.
//!
//! ## Scope: this is the PR-6 **tracer bullet**, not the runtime.
//! Every agent-loop substrate mechanism was built and reviewed in ISOLATION
//! (`planning::classify_kind`, `gate::evaluate`, `authorize_mutating_action`,
//! `pathsafe::contained`, `run_is_complete`). The #1 remaining risk is therefore
//! **composition** — whether the seams snap together. [`run_one_turn`] drives
//! exactly ONE composed turn through a **mock** [`AgentLlmClient`] to surface every
//! API-shape mismatch cheaply, before a full loop is built on possibly-wrong seams:
//!
//! ```text
//! mock LLM proposes a tool call
//!   -> planning::classify_kind(task)            (record a plan event)
//!   -> build a canonical MutatingActionRequest  (deterministic parameters)
//!   -> friday_storage::authorize_mutating_action (core gate + crypto + replay)
//!   -> execute ONLY on Allow (mock executor)    (record the outcome event)
//! ```
//!
//! **Honesty label (file 52 §6):** a mock-driven turn proves **composition**, NOT
//! the product. There is no live model call, no real tool execution, no live
//! DeepSeek evidence here. UNW-001/cat-10 (the enforced mutating-action gate) and
//! the agent loop stay **NO-GO** until the live turn loop + a real `ToolExecutor`
//! (with the deferred `pathsafe` syscall safe-open) call this on every dispatch.
//!
//! ## Why this crate carries the provider-secret dependency
//! The Hub is where provider credentials live, so `friday-hub` depends on the
//! provider crates `friday-deepseek` / `friday-providers` (which hold credentials);
//! `friday-ffi` (phone) must NOT. That compile-time no-provider-key-on-phone
//! boundary is asserted by `friday-arch-tests`.

/// UNW-003 — dynamic provider routing (which provider/model answers a request).
/// Routing decides *who answers*; it has zero authority over tool-call
/// classification, which stays the trusted [`build_request`]/`trusted_classify`
/// chokepoint regardless of the routed provider.
pub mod operator_vk;

pub mod resume;

/// A1 — the Rust agent-run RUN-CONTROL plane (pause-surfacing / resume / cancel / reject). DARK +
/// DEPLOY-GO-gated: the sealed-WS server emits/handles these ONLY behind the default-off
/// `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` flag.
pub mod agent_run_control;

pub mod routing;

/// UNW-004 — Hub composition root: wires the built graph (Db + RouteRegistry + live
/// DeepSeek client + FsToolExecutor + secret + approval policy) into one composed
/// [`runtime::HubRuntime::run_task`] entry. Deny-all approval by default; v1 NO-GO.
pub mod runtime;

/// UNW-016 — capability route table + truth-labeled disabled-route stubs + Command Sheet
/// entrypoint resolver. A non-wired capability resolves to a truth-labeled `Disabled`
/// (never silent / fake-ready); an unknown command fails closed. Closes the contract's
/// `menu_command_sheet_entrypoints` orphan. The HTTP route-family half stays NO-GO (no API).
pub mod capability;

/// A-PR4: channel→Hub event wiring (verified inbound → bound principal → Activity+audit).
pub mod channel_event;
/// Channels (UNW-013) — trusted-inbound AUTH for external channels (Telegram-first).
/// A-PR2: fail-closed, authenticate-before-authorize webhook bearer (constant-time HMAC)
/// + sender allowlist; the per-channel secret lives ONLY in the Hub secure store,
/// reachable through an opaque `kc://…` store handle (the binding never holds material).
/// Channel-origin actions do not yet reach the gate; see the module's reserved-action
/// DECISION note (to be enforced in A-PR4 before any channel action is dispatched).
pub mod channels;

/// Phase-1 runtime bridge — headless Hub serve-loop. Composes the existing mechanisms
/// (pairing session, DeepSeek route via `record_friday_ask`, gate/ledger/audit/activity)
/// into a local headless runtime a future UI can consume: connect/status/refresh/list/
/// reconnect are pure (zero model calls); only `AskFridayRequest` reaches DeepSeek; the
/// outbound projection is refs-only. No UI.
pub mod hub_server;

/// Phase-2 runtime truth — connection/offline/reconnect honesty. Time-driven stale
/// evaluator over `friday_core::ConnState`, an honest `PresentationTruth` label (queued/
/// acked/stale never reads as completed/connected), and an offline drain that routes only
/// through the existing `friday_storage::offline::execute_once` gate path (no new dispatch,
/// no run without valid authorization).
pub mod conn_truth;

/// Step-3 — observability/diagnostics (small/medium truth-labeled): composes the wired
/// substrate (token_ledger / audit chain / agent_run) into a [`diagnostics::DiagnosticsSnapshot`]
/// with no fake-zero, same-build (anti-stale) stamping, surfaced chain integrity, and
/// truth-labeled unbuilt-subsystem metrics. Not the XL metrics pipeline (that stays NO-GO).
pub mod diagnostics;

/// R6 — onboarding provider capability-doctor (DARK). The providers analog of
/// [`diagnostics::DiagnosticsSnapshot::collect`]: a hub-LIBRARY aggregate
/// ([`provider_doctor::ProviderDoctor::run`]) that composes the EXISTING parsed
/// per-provider [`friday_providers::ProviderAuthStatus`] (via
/// [`friday_providers::detect`]) into one truth-labeled onboarding-readiness result —
/// previously this multi-provider orchestration was inlined in the
/// `hub_providers_detect` bin and callable by nothing else. No-fallback (per-provider
/// truth, never substituted), no new probing/model call. Built ready-but-NOT-routed:
/// it does NOT flip the live TS `providers.detect` path and is NOT in the
/// [`capability`] route table; confers no v1 GO.
pub mod provider_doctor;

/// R7 — LIVE provider key-validation (`providers.validate`), DARK + secret-bearing.
/// The real impl of the call-free [`friday_providers::key_validation`] seam: it
/// constructs the `friday-anthropic`/`friday-deepseek` clients `from_env` and runs ONE
/// minimal authenticated round-trip, mapping the typed provider error into a
/// [`friday_providers::KeyValidationOutcome`] (no-fallback: only an auth rejection is
/// `Invalid`; a 5xx/429/transport is `Unavailable`, never a bad-key signal). The
/// error→outcome mapping is pure + fully unit-tested; the network side is exercised
/// only by an `#[ignore]`'d live harness. Registers NO route; confers no v1 GO.
pub mod provider_key_validation;

/// R7 — composite capability-doctor (`capabilities.doctor`/`providers.doctor`), DARK.
/// Composes R6's CLI-detect [`provider_doctor::ProviderDoctor`] signal with R7's live
/// key-validation signal into one per-provider truth-labeled readiness report — the
/// two taxonomies (`{Codex, Claude}` CLI logins vs `{DeepSeek, Anthropic}` API keys)
/// reported side-by-side, NEVER collapsed (claude CLI login and the anthropic API key
/// are distinct credentials, surfaced separately). Generic over both probes for
/// mockable testing. Registers NO route; confers no v1 GO.
pub mod capability_doctor;

/// Step-3 — setup-readiness blocker labels (truth-labeled): the runtime analog of the file-57
/// external-prep checklist. Every prep item is `Ready { evidence }` ONLY when verified, else
/// `NotReady { blocker }` — never falsely ready. `is_release_ready()` is the prep half of the
/// release gate (honest `false` in this build).
pub mod setup;

/// Step-4 — memory-recall cognition (PROOF-MEMORY-001): recency-decay ranking +
/// top-k bound + PII redaction over `recall_confirmed`'s rows, before any recalled
/// memory is injected into a provider prompt. Hub-only (recall is Hub-side). No
/// semantic/embedding recall (greenfield NO-GO — not claimed).
pub mod cognition;

/// Step-5 (workflow/skills substrate) — UNW-011: the single canonical retry
/// classifier (Retryable vs Terminal) over the real provider/route error types.
/// No silent fallback (a retry is the SAME route, never a reroute); bounded.
pub mod retry;

/// Step-5 (workflow/skills substrate) — the workflow PLANNER + minimal definition
/// type. Decides per-step auto-advance vs checkpoint, ANCHORED to the trusted
/// classifier (mutating/high-risk ⇒ checkpoint, the gate floor; template may only
/// narrow; unknown ⇒ fail-closed). Pure decision layer — no execution.
pub mod planner;

/// Step-5 — the workflow EXECUTION engine (operator-authorized): drives a definition
/// semi-automatically, auto-advancing gate-safe read-only steps through the SHARED
/// `gate_dispatch` chokepoint and pausing at the first checkpoint. Built-in tools
/// only (no skill/plugin exec). Resume-after-approval is a deferred follow-up.
pub mod workflow_exec;

/// S8 — workflow DEFINITION layer: versioned serde definition (LINEAR-only) +
/// storage CRUD over `friday_storage::workflow_def` + the loader that produces the
/// exact [`planner::WorkflowDefinition`] the EXISTING [`workflow_exec`] engine
/// consumes (no second executor). DARK substrate: no production route, no
/// scheduler (S10, operator-gated); workflow execution remains fenced in TS and is
/// NOT product-replaced; NOT v1 GO.
pub mod workflow_def;

/// R3 — workflow CATALOG mutation + deploy layer (DARK). The per-WORKFLOW catalog
/// ENTRY layer the TS `workflows.*` mutation surface maps to
/// (`workflows.create/update/archive/publish/deploy`), orchestrating
/// [`friday_storage::workflow_catalog`] (the entry) + [`workflow_def`] (the
/// version bodies). `publish` delegates to the S8 single-published flip (the
/// catalog never records the published pointer); `deploy` sets the catalog deploy
/// pointer to the S8-published version WITHOUT firing a runtime trigger (that is
/// R2/S10, gated). DARK substrate: no production route, the live TS `workflows.*`
/// routes are NOT flipped; NOT v1 GO.
pub mod workflow_catalog;

/// S8 — TS published-version → Rust LINEAR-ONLY workflow translator. Any
/// DAG/branch/parallel/unsupported source feature fails CLOSED to an explicit
/// `Unsupported { reasons, preserved_source_meta }` — never a silent flattening,
/// never partial. Dark substrate; NOT v1 GO.
pub mod workflow_ts_translate;

/// S9 — manual workflow-RUN bridge seam: load a STORED definition (S8 loader)
/// and execute it through the EXISTING [`workflow_exec`] engine (no engine
/// change, no second executor; mutating steps stay gate-paused under deny-all).
/// DARK substrate: no production route, no scheduler (S10, operator-gated);
/// workflow execution remains fenced in TS and is NOT product-replaced; NOT v1 GO.
pub mod workflow_run;

/// R2 — workflow RUN-CONTROL plane (DARK): the fail-closed run-control surface
/// (`resume` / `retry` / `cancel`) over the `friday-core`/`friday-storage`
/// 5-state run model. `resume` is a real control bridge that loads the STORED
/// definition and DELEGATES to the existing [`workflow_exec::resume_workflow`]
/// engine entrypoint (S9 has a START bridge but no RESUME bridge); `retry` and
/// `cancel` fail closed with an explicit "not representable in the Rust run
/// model" error because they require a cross-cutting `friday-core` run-state
/// change (a `Failed -> Running` retry edge / a `Cancelled` state) that is
/// outside R2's additive write-set and would touch the LIVE S9 engine. No
/// production route, no scheduler/trigger, no migration, no route flip; TS
/// run-control stays fail-closed/retired and is NOT product-replaced; NOT v1 GO.
pub mod workflow_run_control;

/// S10-A — workflow SCHEDULER substrate (DARK). The hub-layer half of slice A:
/// the restricted CRON-SUBSET parser + the minute-granularity UTC `is_due` /
/// `next_due` evaluator (no `chrono`, UTC-only), the deterministic
/// `scheduled_run_id` helper (the at-most-once anchor for the future tick's
/// `create_run` dup-PK claim), and `create_schedule` — the create boundary that
/// validates the cron expression fail-closed BEFORE it reaches a born-disabled
/// stored row. NO daemon, NO tick loop, NO firing (slices B/C); the storage rows
/// live in `friday_storage::schedule`. WAL flip + plist install + enable are
/// operator-gated. NOT v1 GO.
pub mod scheduler;

/// PAIR-002 — Hub-side local pairing message handler. It consumes the structured
/// QR payload from PAIR-001 and the first-slice protocol `Pair` message, writes a
/// trusted device through the existing authenticated pairing proof, and never
/// dispatches provider/model calls.
pub mod pair_runtime;

/// Provider Workspace runtime projection — maps Codex/Claude UI actions to
/// provider capabilities, sync modes, native actions, and exact blockers before
/// any UI can look ready. Pure projection only; no provider/model calls.
pub mod provider_workspace;

/// PWS-004 — Provider Workspace dispatch adapter seam. Gates an action through
/// [`provider_workspace::guard_action_request`] FIRST, then dispatches an accepted +
/// routed action to a `ProviderDispatchAdapter`, returning dispatch_ref / truth_label /
/// blocker. No adapter call on a non-accepted request; the capability truth_label is
/// never upgraded by a dispatch; secrets stay Hub-side. Real Codex/Claude adapters land
/// in CODEX-LIVE-001 / CLAUDE-MIRROR-001.
pub mod provider_dispatch;

/// Global work graph / session adoption / advisor preflight. Reads stored
/// process/workspace/provider/channel metadata as truth-labeled refs, proposes
/// operator-gated adoption, and blocks duplicate/conflicting work before dispatch.
pub mod global_work_graph;

/// Mission context resolver — fail-closed conversion from surface/provider/workflow hints
/// into canonical `FridayConversation -> Mission -> WorkItem` context, plus a route
/// decision card projection from WorkItem judgment memory. Future live call sites should
/// use this before dispatch instead of guessing from provider/channel ids.
pub mod mission_context;

/// Mission-bound runtime producer wrappers. Channel/workflow product entrypoints use
/// these to require a resolved Mission context + RouteDecisionCard before recording or
/// executing work.
pub mod mission_runtime;

/// SMOOTH-001 — provider session timeline + reconnect harness. One Friday-canonical
/// timeline per session with strictly-monotonic seq + revision-on-every-mutation, a
/// PendingAction state machine where Hub-ack is never provider-completion, dedup by
/// client_msg_id, and a reconnect that returns a bounded delta when the cursor is retained
/// and a snapshot only when it is behind retention (no full-history reload by default).
pub mod provider_timeline;

/// Mission Spine Hub preflight and attachment seam. Stages routed work through the
/// canonical `FridayConversation -> Mission -> WorkItem` graph before dispatch and
/// attaches provider/channel evidence as trace refs, not independent product state.
pub mod mission_preflight;

/// Skill / Capability Catalog / Advisor Bridge. Reads managed skill manifests as
/// truth-labeled catalog entries and advisor inputs; it does not execute skills
/// or grant control.
pub mod skill_catalog;

/// Shared refs-only output guard for the proof bins. Single source of truth for the
/// common secret/path marker set; each bin passes its body-field markers as `extra`.
pub mod refs_guard;

/// Sensitive-learning guard — ported from the TS `friday-sensitive-learning-guard`.
/// Classifies an extracted memory item's text as a high-risk sensitive candidate
/// (passwords/tokens/SSN/medical/financial/… + Chinese equivalents); the extraction
/// engine DROPS a matched item (never stores it), parity with the TS.
pub mod sensitive_guard;

/// FIRST Rust-ownership slice for the session-memory "moat": INLINE manual-trigger
/// extraction for ONE session — read messages → provider extract call (ledgered) →
/// parse + sensitivity-filter → persist CANDIDATES via the existing memory spine
/// (`record_candidate`). Reuses confirm/recall/redact unchanged. The TS extraction
/// path STAYS LIVE (parity pending); queue/auto deferred. PROOF-ONLY, NOT a v1 GO.
pub mod memory_extraction;

/// Session-memory slice-3 (ownership-binding): faithful Rust port of the TS
/// `resolveFridaySessionMemoryNamespace` — the composite memory store SCOPE
/// (`tenant.<account>.channel.<channel>.user.<user>.shared`) DERIVED from a session's
/// owner axes, fail-closed when no userId. This is what binds extraction's store scope to
/// the SESSION (not a caller-supplied principal). DM-chatId + subagent parent-walk userId
/// fallbacks are DEFERRED-PARITY. PROOF-ONLY, NOT a v1 GO.
pub mod session_namespace;

/// executeRun-replacement slice 1 (security pre-req): the canonical TS↔Rust tool-name (and
/// param-schema) reconciliation map — the SINGLE SOURCE OF TRUTH a future routing slice
/// will use to translate a TS-shaped `disabledToolNames` entry (`exec`) into the Rust
/// registry action the loop dispatches (`run_command`). Consumed by
/// [`RunPolicy::resolve_tool`] to make the disabled-set check fail-CLOSED on a foreign name.
/// Dark substrate: `rust_wired`, NOTHING routes through it yet, NOT a v1 GO.
pub mod tool_name_map;

/// execrun-enablement slice 2 (production key-sourcing pre-req): the SHARED, fail-closed
/// master-key reader + the two domain-separated derivations both the `hub_agent_run_server`
/// bin (the FileSecureStore KEK) and the `hub_agent_run_enroll` bin (the client X25519
/// pubkey enrolled into the peer allowlist) depend on. Placed in the friday-hub LIB so BOTH
/// bins import the SAME code (a divergent copy would silently break the enrolled-pubkey ==
/// runtime-handshake-pubkey parity). [`key_source::derive_client_x25519_pubkey`] is the
/// BYTE-EXACT parity contract with the TS client
/// (`deriveRustAgentRunWsClientX25519PublicKey`) — proven by an in-module cross-language KAT.
/// Dark substrate: NOTHING routes through it yet, NOT a v1 GO.
pub mod key_source;

/// R4 — the Rust-owned SYSTEM-INTENT execution domain layer (DARK). Mirrors the
/// fenced TS `friday-system-service.executeIntent` (whose declared replacement is
/// `rust_owned_system_intent_execution_entrypoint_required`): intent dispatch with
/// canonical-gate approval-gating (fail-closed; an agent/channel/remote actor can
/// never self-approve), the control-lease lifecycle, and an honest deferred-OS-action
/// seam. No production route, no runtime caller, no live flip. NOT v1 GO.
pub mod system_intent;

/// **S-R0** — the SHARED sealed-WS transport/auth SUBSTRATE for the UI direct-read seam. The single
/// source of truth for the handshake + S-F peer-pubkey allowlist + low-order check + sealed-proof
/// codec used by BOTH the live agent-run WRITE server and the DARK read-projection server, so the
/// two cannot drift in crypto/auth. Pure refactor for the write path (byte-identical behavior); the
/// read server it enables is itself DARK (no LaunchAgent, no production caller). NOT v1 GO.
pub mod sealed_ws;

/// **S-R1** — the extracted Mission Workbench projection library fn (refs-only, with the forbidden-
/// output guard run INSIDE) so the one-shot `mission_workbench_projection` bin AND the DARK
/// read-projection server share ONE implementation. No model call, no credential, read-only. DARK.
pub mod workbench_projection;

/// **S-R2** — the extracted run-readback projection library fn (refs-only, guard run INSIDE) so the
/// one-shot `hub_run_readback` bin AND the DARK read-projection server share ONE implementation. No
/// model call, no credential, read-only. Token totals are DB-WIDE, never run cost. DARK.
pub mod run_readback_projection;

/// **S-R3** — the extracted providers-doctor projection library fn (refs-only, guard run INSIDE) so
/// the one-shot `hub_providers_detect` bin AND the DARK read-projection server share ONE
/// implementation. NOT a DB read — runs each provider CLI's read-only status command (no model call,
/// no quota, no credential read); provider lanes are conservatively `linked_only`. DARK.
pub mod providers_doctor_projection;

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, ActorKind, ApprovalDecision,
    CanonicalApproval, GateDecision, MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
// The risk-escalation primitives (`shell_risk`/`is_destructive_request`) now live behind
// the sealed `friday_core::gate::classify`; `Resource` is constructed there too.
use friday_core::{ActivityState, ActivityType, Risk};
use friday_crypto::OperatorVerifyingKey;
use friday_storage::{
    agent_run, authorize_mutating_action, authorize_mutating_action_ed25519, ActivityRow,
    AuditEvent, Db, StorageError,
};
use rusqlite::Connection;

// --- the LLM seam ------------------------------------------------------------

/// A tool call as proposed by the model — **untrusted**. It carries ONLY the strings
/// the model can express: the tool `action` name and its `params`. It deliberately
/// has NO `mutating`/`risk`/`resource` field, so a model can never assert that a
/// destructive action is non-mutating — those are DERIVED from a trusted source
/// ([`trusted_classify`]) inside [`build_request`], the single chokepoint. (A real
/// client parses this from a model response; the mock returns a canned one.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawToolCall {
    /// The tool/action name the model asked for (e.g. `read_file`, `delete_file`).
    pub action: String,
    /// Tool parameters as key/value pairs; serialized deterministically into the
    /// request's `parameters` (so the approval issuer and the live re-check agree).
    pub params: Vec<(String, String)>,
}

/// Why the model client could not produce a tool call this turn. The seam is fallible
/// because the live impl does real I/O (the model can be unreachable) and parses
/// untrusted model output (which can violate the tool-call contract). Both are turn
/// failures the caller fail-closes on — never a silent default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentError {
    /// The provider/route call itself failed (network / 5xx / request-timeout / auth /
    /// client-4xx / rate-limit / bad-response / no-models), carrying the STRUCTURED
    /// [`friday_deepseek::DeepSeekError`] instead of stringifying it. This preserves the
    /// variant so the run_loop error site can classify it via
    /// [`crate::retry::RetryDisposition::classify_deepseek`] and BOUND-retry only the
    /// transient (`Retryable`: network/5xx/408) cases — a `Terminal` one (auth / credential /
    /// client-4xx / 429-rate-limit / validation) is surfaced immediately. The error's
    /// `Display`/`Debug` is the
    /// crate's own coarse, secret-free message (status code / kind only; never the API key
    /// or response body — see `map_ureq_err`), so this leaks no more than the prior
    /// `format!("{e:?}")` did.
    Route(friday_deepseek::DeepSeekError),
    /// A model/transport failure that is only available as a string (no structured
    /// `DeepSeekError` to carry — e.g. "no model available" from discovery selection).
    /// Never retried (it is not a transient route failure with a disposition).
    Model(String),
    /// The model replied, but its output did not parse as a single valid tool-call
    /// object per the contract (prose, multiple objects, missing `tool`, bad JSON).
    Parse(String),
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Coarse, secret-free: delegates to DeepSeekError's own thiserror `Display`
            // (status code / kind only — no API key, no response body).
            AgentError::Route(e) => write!(f, "model_error: {e}"),
            AgentError::Model(m) => write!(f, "model_error: {m}"),
            AgentError::Parse(m) => write!(f, "parse_error: {m}"),
        }
    }
}

/// One step the model takes in a multi-turn loop: either propose a tool call
/// (untrusted) or declare the task finished. Termination is the model's `Finish` (the
/// `{"tool":"none","answer":"<final answer>"}` contract), bounded by `max_turns` in
/// [`run_loop`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentStep {
    /// Propose an (untrusted) tool call — classified by the Hub, not trusted as-is.
    Tool(RawToolCall),
    /// The model considers the task complete; the loop stops (not a tool, not a no-op).
    /// `message` carries the model's final natural-language answer (the `answer` field of
    /// the finish object); it is empty if the model omitted one.
    Finish { message: String },
}

/// A record of one completed turn, threaded back to the model as conversation history
/// so the next step is informed by what already happened. `outcome` is the Hub-authored
/// per-turn result: the short summary PLUS, for read-type tools, a BOUNDED head slice of
/// the actual tool-result content (so the model can ground its answer on what it read —
/// see [`format_executed_outcome`]). It is MODEL-CONTEXT only: it is never persisted and
/// never carries Hub secret/approval-key material; the compact `summary` (not `outcome`)
/// is what reaches the event log and the hash-chained audit ledger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnTrace {
    pub action: String,
    pub params: Vec<(String, String)>,
    pub outcome: String,
}

/// One metered loop step (S1.2 billing seam): the parsed-step result PLUS the model-call
/// usage the loop ledgers. The OUTER [`AgentError`] is a route/transport/discovery failure
/// — the model call never produced usage, so NOTHING is billed (the ask path's `Route`
/// error). On the OUTER `Ok`, the inner [`Result<AgentStep, AgentError>`] is the *parse* of
/// a chat that ALREADY succeeded: an inner `Err` means the chat 200'd with real, billable
/// usage but the content failed the tool-call contract — the loop BILLS the call (usage is
/// `Some`) and THEN fails the run closed. This split is what makes the loop bill like the
/// ask path (which has no parse step): a chat that spends tokens is billed even when the
/// reply is unparseable (the S1.1 `parse_error` failure mode would otherwise under-bill).
pub type MeteredStep = (Result<AgentStep, AgentError>, Option<BilledUsage>);

/// (C2) Provider-neutral billed-call usage: the bits the ONE biller
/// ([`bill_model_call`]) needs to write a CORRECT [`friday_core::LedgerEntry`] row,
/// independent of which provider produced the call. Carrying the
/// [`friday_core::ProviderKind`] here (instead of hardwiring `DeepSeek`) is what stops a
/// Claude call from being mis-attributed as DeepSeek — the biller picks the ledger ctor
/// (host + provider_kind) off this enum.
///
/// `total_tokens` is DELIBERATELY absent: the ledger computes it from the parts
/// ([`friday_core::LedgerEntry::new`]), so a stored copy could only ever disagree with
/// the sum. Each provider adapter maps its own outcome into this shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BilledUsage {
    pub provider_kind: friday_core::ProviderKind,
    /// The model id the response REPORTED (ledger the reported model, not the requested
    /// one — same discipline both adapters already follow).
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

impl BilledUsage {
    /// Map a DeepSeek `ModelCallOutcome` into the neutral billed-usage shape. The
    /// tokens + reported model are carried VERBATIM, so the DeepSeek ledger row is
    /// byte-identical to the pre-C2 `outcome.to_ledger_entry(..)` path (the regression
    /// gate proves this).
    pub fn from_deepseek(outcome: &friday_deepseek::ModelCallOutcome) -> Self {
        Self {
            provider_kind: friday_core::ProviderKind::DeepSeek,
            model: outcome.model.clone(),
            prompt_tokens: outcome.prompt_tokens,
            completion_tokens: outcome.completion_tokens,
        }
    }

    /// (C2) Map a Claude/Anthropic `ModelCallOutcome` into the neutral billed-usage
    /// shape. Anthropic's `input_tokens`/`output_tokens` are the prompt/completion
    /// equivalents.
    pub fn from_anthropic(outcome: &friday_anthropic::ModelCallOutcome) -> Self {
        Self {
            provider_kind: friday_core::ProviderKind::Anthropic,
            model: outcome.model.clone(),
            prompt_tokens: outcome.input_tokens,
            completion_tokens: outcome.output_tokens,
        }
    }

    /// (C1) Map a Codex app-server `ModelTurnOutcome` into the neutral billed-usage
    /// shape, tagged [`friday_core::ProviderKind::Codex`] so a routed Codex turn is never
    /// mis-attributed as DeepSeek/Anthropic.
    ///
    /// Unlike the DeepSeek/Anthropic outcomes, [`friday_providers::codex_appserver::ModelTurnOutcome`]
    /// carries NO model field (the app-server's `turn/completed` does not report it), so the
    /// `route_model` is supplied SEPARATELY by the caller (the requested route model). Usage is
    /// `Option`: the `thread/tokenUsage/updated` notification is not guaranteed every turn, so a
    /// turn with no usage bills 0/0 (honest absence — its `total_tokens` is dropped, the ledger
    /// recomputes the total from the parts).
    pub fn from_codex(
        outcome: &friday_providers::codex_appserver::ModelTurnOutcome,
        route_model: &str,
    ) -> Self {
        let (prompt_tokens, completion_tokens) = match &outcome.usage {
            Some(u) => (u.input_tokens, u.output_tokens),
            None => (0, 0),
        };
        Self {
            provider_kind: friday_core::ProviderKind::Codex,
            model: route_model.to_string(),
            prompt_tokens,
            completion_tokens,
        }
    }
}

/// The model-client seam (mirrors `friday-deepseek`'s `Transport` DI pattern). The
/// turn loop dispatches through this so it is unit-testable with a mock; the live impl
/// over `friday-deepseek` is the runtime-proven slice. It returns only the untrusted
/// [`RawToolCall`] (classification is the Hub's job), or an [`AgentError`] — the turn
/// fail-closes on `Err`, it is never treated as a no-op or a non-mutating action.
pub trait AgentLlmClient {
    /// Single-turn proposal (no history). Required.
    fn propose_tool_call(&self, task: &str) -> Result<RawToolCall, AgentError>;

    /// Multi-turn step with conversation `history`; the model MAY finish. The default
    /// wraps [`AgentLlmClient::propose_tool_call`] as a single `Tool` step (ignores
    /// history, never finishes) — degenerate single-turn behavior, safely bounded by
    /// [`run_loop`]'s `max_turns`. A live/scripted client OVERRIDES this for real
    /// history-aware multi-turn + `Finish` termination.
    fn next_step(&self, task: &str, _history: &[TurnTrace]) -> Result<AgentStep, AgentError> {
        Ok(AgentStep::Tool(self.propose_tool_call(task)?))
    }

    /// Like [`AgentLlmClient::next_step`], but ALSO surfaces the model-call usage as a
    /// provider-neutral [`BilledUsage`] (tokens + reported model + provider kind) so
    /// [`run_loop`] can LEDGER the call with the CORRECT provider (S1.2 usage-parity; C2
    /// generalization). See [`MeteredStep`] for the route-vs-parse error split.
    ///
    /// The DEFAULT meters NOTHING: it delegates to [`AgentLlmClient::next_step`] and returns
    /// `(result, None)` — a client that does not report usage (mocks / scripted tests) bills
    /// nothing, the honest default (no usage data ⇒ no ledger row), preserving every existing
    /// loop test. The live [`DeepSeekAgentLlmClient`] OVERRIDES this to surface the real
    /// outcome (and routes its own `next_step` through it, so there is ONE chat call site).
    fn next_step_metered(
        &self,
        task: &str,
        history: &[TurnTrace],
    ) -> Result<MeteredStep, AgentError> {
        Ok((self.next_step(task, history), None))
    }
}

/// A mock client that returns a fixed raw call — used to prove the composition
/// without a live model call.
pub struct MockAgentLlmClient {
    pub proposal: RawToolCall,
}

impl AgentLlmClient for MockAgentLlmClient {
    fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
        Ok(self.proposal.clone())
    }
}

/// Real model-client adapter over `friday-deepseek` (the runtime-proven slice). It
/// builds the tool-call prompt, calls the live model (`fallback=false`), and parses
/// the reply STRICTLY back into a [`RawToolCall`]. The model output is untrusted: the
/// parse fails closed (an `AgentError`) on any contract violation, and the Hub — not
/// the model — classifies the resulting call via `build_request`/`trusted_classify`.
pub struct DeepSeekAgentLlmClient<T: friday_deepseek::Transport> {
    client: friday_deepseek::DeepSeekClient<T>,
}

impl<T: friday_deepseek::Transport> DeepSeekAgentLlmClient<T> {
    pub fn new(client: friday_deepseek::DeepSeekClient<T>) -> Self {
        Self { client }
    }
    /// Passthrough to the route's model discovery.
    pub fn discover_models(&self) -> Result<Vec<String>, friday_deepseek::DeepSeekError> {
        self.client.discover_models()
    }
}

/// Completion-token budget for the agent-loop reasoning calls (`propose_tool_call` and
/// `next_step`). The routed `deepseek-v4-*` models are REASONING models: their
/// chain-of-thought goes in `reasoning_content` and the answer in `content`, but BOTH
/// share this single `max_tokens` completion budget. At 512, reasoning routinely
/// exhausted the budget → the response truncated (`finish_reason="length"`) with an EMPTY
/// `content`, so parsing `""` produced `agent.error:parse_error: not a single JSON object:
/// EOF`. 4096 is coordinator-proven (flash & pro live matrix) to eliminate the truncation
/// — it comfortably holds the reasoning plus a tool-call object or a short finish answer.
/// This is the agent-loop path ONLY; the single-shot mission-ask (`run_friday_ask`)
/// carries its own caller-supplied budget and is unaffected.
const AGENTLOOP_MAX_TOKENS: u32 = 4096;

impl<T: friday_deepseek::Transport> AgentLlmClient for DeepSeekAgentLlmClient<T> {
    fn propose_tool_call(&self, task: &str) -> Result<RawToolCall, AgentError> {
        let models = self.client.discover_models().map_err(AgentError::Route)?;
        let model = friday_deepseek::select_model(&models)
            .ok_or_else(|| AgentError::Model("no model available".to_string()))?;
        let prompt = build_tool_prompt(task);
        let outcome = self
            .client
            .chat(&model, &prompt, AGENTLOOP_MAX_TOKENS)
            .map_err(AgentError::Route)?;
        parse_tool_call(&outcome.content)
    }

    /// History-aware multi-turn step: the prompt includes prior turns + their outcomes
    /// so the model can build on them or finish. `{"tool":"none","answer":"<final answer>"}`
    /// parses to `Finish { message: "<final answer>" }`.
    ///
    /// Routed through [`DeepSeekAgentLlmClient::next_step_metered`] so there is exactly ONE
    /// chat call site (no drift between the metered and unmetered paths); the usage is
    /// discarded here, surfaced there.
    fn next_step(&self, task: &str, history: &[TurnTrace]) -> Result<AgentStep, AgentError> {
        self.next_step_metered(task, history)?.0
    }

    /// Metered multi-turn step (S1.2): does the SAME discover → select → chat as
    /// [`DeepSeekAgentLlmClient::next_step`], then parses the reply — but returns the chat's
    /// [`friday_deepseek::ModelCallOutcome`] (tokens + reported model) ALONGSIDE the parse
    /// result so [`run_loop`] can ledger the call. A discover/select/chat failure is an OUTER
    /// `Err` (route failure: nothing billed). A successful chat whose content does not parse
    /// is an INNER `Err` with `Some(outcome)` — the chat spent tokens, so the loop bills it
    /// and then fails the run closed. See [`MeteredStep`].
    fn next_step_metered(
        &self,
        task: &str,
        history: &[TurnTrace],
    ) -> Result<MeteredStep, AgentError> {
        let models = self.client.discover_models().map_err(AgentError::Route)?;
        let model = friday_deepseek::select_model(&models)
            .ok_or_else(|| AgentError::Model("no model available".to_string()))?;
        let prompt = build_loop_prompt(task, history);
        let outcome = self
            .client
            .chat(&model, &prompt, AGENTLOOP_MAX_TOKENS)
            .map_err(AgentError::Route)?;
        // The chat SUCCEEDED — `outcome` carries real, billable usage even if the content
        // below fails to parse. Surface it (mapped to the neutral `BilledUsage`, DeepSeek
        // kind) so the loop bills the call regardless of parse — byte-identical row.
        let step = parse_agent_step(&outcome.content);
        Ok((step, Some(BilledUsage::from_deepseek(&outcome))))
    }
}

/// S7 — Real model-client adapter over `friday-anthropic` (the Claude/Anthropic
/// route), the SECOND live provider, mirroring [`DeepSeekAgentLlmClient`]. It builds
/// the SAME tool-call / loop prompts, calls the live Claude model (`POST /v1/messages`,
/// no fallback), and parses the reply STRICTLY back into a [`RawToolCall`]/[`AgentStep`].
///
/// **DARK / default-off.** This adapter is constructed only behind an explicit,
/// default-OFF selection (see [`crate::runtime::HubRuntime::live`], env gate
/// `FRIDAY_CLAUDE_ROUTE_ENABLED`). It is reachable from the routed loop ONLY when a
/// `claude`-kind route is selected, which the autonomous baseline marks
/// `available: false`. Prod default behavior is UNCHANGED; the DeepSeek path is untouched.
///
/// **No-fallback contract:** identical to DeepSeek — a route failure is an
/// [`AgentError`], never a silent substitute. The model id is supplied by the caller
/// (from the route), so there is no model-discovery step.
///
/// **Error mapping (retry-classification DEFERRED).** [`AgentError::Route`] carries a
/// concrete `friday_deepseek::DeepSeekError`, so a [`friday_anthropic::ClaudeError`]
/// cannot go there. The lowest-blast-radius mapping for this dark, never-selected path
/// is the existing string-bearing [`AgentError::Model`] (never retried by the run-loop's
/// `classify_deepseek`). A future non-dark slice that actually selects Claude would add
/// an `AgentError::ClaudeRoute(ClaudeError)` variant + a classifier arm; out of scope here.
///
/// **Ledger/metering (C2).** This adapter OVERRIDES `next_step_metered` to surface its
/// chat usage as a provider-neutral [`BilledUsage`] tagged [`friday_core::ProviderKind::Anthropic`]
/// (mapping Anthropic's `input_tokens`/`output_tokens`), so the ONE biller
/// ([`bill_model_call`]) records a `provider_kind="anthropic"` row via
/// [`friday_core::LedgerEntry::anthropic_route`] (host `api.anthropic.com`) — NEVER
/// mis-attributing a Claude call as DeepSeek. Its `next_step` routes THROUGH
/// `next_step_metered` so there is exactly ONE chat call site (mirroring the DeepSeek
/// adapter). The `friday-anthropic` crate is UNCHANGED.
pub struct ClaudeAgentLlmClient<T: friday_anthropic::Transport> {
    client: friday_anthropic::ClaudeClient<T>,
    /// The model id this adapter dispatches to (from the route; e.g. `claude-opus-4-8`).
    /// Claude has no `/models` discovery step, so the model is supplied here.
    model: String,
}

impl<T: friday_anthropic::Transport> ClaudeAgentLlmClient<T> {
    pub fn new(client: friday_anthropic::ClaudeClient<T>, model: impl Into<String>) -> Self {
        Self {
            client,
            model: model.into(),
        }
    }
}

impl<T: friday_anthropic::Transport> AgentLlmClient for ClaudeAgentLlmClient<T> {
    fn propose_tool_call(&self, task: &str) -> Result<RawToolCall, AgentError> {
        let prompt = build_tool_prompt(task);
        let outcome = self
            .client
            .chat(&self.model, &prompt, AGENTLOOP_MAX_TOKENS)
            // ClaudeError → string-bearing AgentError::Model (retry-classification deferred;
            // see the adapter doc). Coarse, secret-free Display.
            .map_err(|e| AgentError::Model(e.to_string()))?;
        parse_tool_call(&outcome.content)
    }

    /// History-aware multi-turn step, identical contract to the DeepSeek adapter's
    /// `next_step`. `{"tool":"none","answer":"<final>"}` parses to `Finish`.
    ///
    /// Routed through [`ClaudeAgentLlmClient::next_step_metered`] so there is exactly ONE
    /// chat call site (mirroring the DeepSeek adapter); the usage is discarded here,
    /// surfaced there.
    fn next_step(&self, task: &str, history: &[TurnTrace]) -> Result<AgentStep, AgentError> {
        self.next_step_metered(task, history)?.0
    }

    /// (C2) Metered multi-turn step: the SAME `build_loop_prompt → chat → parse_agent_step`
    /// as [`ClaudeAgentLlmClient::next_step`], but returns the chat usage mapped to a
    /// neutral [`BilledUsage`] tagged [`friday_core::ProviderKind::Anthropic`] ALONGSIDE
    /// the parse result, so [`run_loop`] ledgers the call as `provider_kind="anthropic"`.
    /// A chat failure is an OUTER `Err` (nothing billed). A successful chat whose content
    /// does not parse is an INNER `Err` with `Some(BilledUsage)` — the chat spent tokens,
    /// so the loop bills it and then fails the run closed. See [`MeteredStep`].
    fn next_step_metered(
        &self,
        task: &str,
        history: &[TurnTrace],
    ) -> Result<MeteredStep, AgentError> {
        let prompt = build_loop_prompt(task, history);
        let outcome = self
            .client
            .chat(&self.model, &prompt, AGENTLOOP_MAX_TOKENS)
            // ClaudeError → string-bearing AgentError::Model (retry-classification deferred;
            // see the adapter doc). Coarse, secret-free Display.
            .map_err(|e| AgentError::Model(e.to_string()))?;
        // The chat SUCCEEDED — `outcome` carries real, billable usage even if the content
        // below fails to parse. Surface it (neutral `BilledUsage`, Anthropic kind) so the
        // loop bills the call with the CORRECT provider regardless of parse.
        let step = parse_agent_step(&outcome.content);
        Ok((step, Some(BilledUsage::from_anthropic(&outcome))))
    }
}

/// (C1-2) THIN model-client adapter over a [`friday_providers::codex_appserver::CodexTurnSource`]
/// — the Codex app-server route, mirroring [`DeepSeekAgentLlmClient`]/[`ClaudeAgentLlmClient`]
/// so a Codex model turn flows through the SAME `AgentLlmClient` path. It builds the SAME
/// loop / tool-call prompts, runs ONE Codex turn via the injected source, and parses the
/// authoritative agent-message text STRICTLY back into a [`RawToolCall`]/[`AgentStep`].
///
/// **DARK / not wired.** Nothing routes to this adapter yet — C1-3 wires it into the
/// route registry. It is purely additive: the DeepSeek/Claude clients and the existing
/// `AgentLlmClient` behavior are untouched, and no creds are required to construct it.
///
/// **Thin by construction.** ALL the protocol work (spawn/handshake/`run_turn` parse,
/// authoritative-text assembly, token-usage projection) lives in `friday-providers`; this
/// adapter only maps prompt → [`friday_providers::codex_appserver::ModelTurnOutcome`] →
/// [`AgentStep`] + neutral [`BilledUsage`]. The `CodexTurnSource` seam is `&self` and the
/// production source spawns a fresh app-server per turn (stateless), so this adapter holds
/// no interior `!Sync` process across turns — it stays clean for a future boxed
/// `dyn AgentLlmClient` (today `Box<dyn AgentLlmClient>` has no `Send + Sync` bound, so
/// this is a forward-clean choice, not a worked-around compile error).
///
/// **Error mapping.** [`AgentError::Route`] carries a `friday_deepseek::DeepSeekError`, so
/// a [`friday_providers::codex_appserver::CodexAppServerError`] cannot go there; the
/// lowest-blast-radius mapping for this dark path is the string-bearing
/// [`AgentError::Model`] (never retried), whose `Display` is the providers crate's coarse,
/// secret-free message. A future non-dark slice would add a structured Codex route variant.
///
/// **Ledger/metering (C2).** `next_step_metered` surfaces the turn usage as a neutral
/// [`BilledUsage`] tagged [`friday_core::ProviderKind::Codex`] (via [`BilledUsage::from_codex`],
/// model = `self.model`), so the ONE biller records a `provider_kind="codex"` row — never
/// mis-attributing a Codex turn. `next_step` routes THROUGH `next_step_metered` so there is
/// exactly ONE turn call site (mirroring DeepSeek/Claude).
pub struct CodexAgentLlmClient<S: friday_providers::codex_appserver::CodexTurnSource> {
    source: S,
    /// The model id this adapter bills against. The Codex app-server `turn/completed` does
    /// NOT report a model, so [`BilledUsage::from_codex`] takes the route model from here.
    model: String,
}

impl<S: friday_providers::codex_appserver::CodexTurnSource> CodexAgentLlmClient<S> {
    pub fn new(source: S, model: impl Into<String>) -> Self {
        Self {
            source,
            model: model.into(),
        }
    }
}

impl<S: friday_providers::codex_appserver::CodexTurnSource> AgentLlmClient
    for CodexAgentLlmClient<S>
{
    fn propose_tool_call(&self, task: &str) -> Result<RawToolCall, AgentError> {
        let prompt = build_tool_prompt(task);
        let outcome = self
            .source
            .run_text_turn(&prompt)
            // CodexAppServerError → string-bearing AgentError::Model (coarse, secret-free
            // Display; retry-classification deferred for this dark path).
            .map_err(|e| AgentError::Model(e.to_string()))?;
        parse_tool_call(&outcome.content)
    }

    /// History-aware multi-turn step, identical contract to the DeepSeek/Claude adapters.
    /// Routed THROUGH [`CodexAgentLlmClient::next_step_metered`] so there is exactly ONE
    /// turn call site; the usage is discarded here, surfaced there.
    fn next_step(&self, task: &str, history: &[TurnTrace]) -> Result<AgentStep, AgentError> {
        self.next_step_metered(task, history)?.0
    }

    /// (C1-2) Metered multi-turn step: the SAME `build_loop_prompt → run_text_turn →
    /// parse_agent_step` shape as the DeepSeek/Claude adapters, returning the turn usage
    /// mapped to a neutral [`BilledUsage`] tagged [`friday_core::ProviderKind::Codex`]
    /// ALONGSIDE the parse result. The [`MeteredStep`] split mirrors them EXACTLY: a turn
    /// that FAILS to run is an OUTER `Err` (nothing billed); a turn that COMPLETED (even a
    /// `status:"failed"` turn — no status-inspection branch, the empty/unparseable content
    /// simply falls through) but whose authoritative content does not parse is an INNER
    /// `Err` with `Some(BilledUsage)` — the turn ran, so the loop bills it and then fails
    /// the run closed.
    fn next_step_metered(
        &self,
        task: &str,
        history: &[TurnTrace],
    ) -> Result<MeteredStep, AgentError> {
        let prompt = build_loop_prompt(task, history);
        let outcome = self
            .source
            .run_text_turn(&prompt)
            // CodexAppServerError → string-bearing AgentError::Model (coarse, secret-free
            // Display; retry-classification deferred for this dark path).
            .map_err(|e| AgentError::Model(e.to_string()))?;
        // The turn RAN — `outcome` carries real, billable usage even if the authoritative
        // content below fails to parse. Surface it (neutral `BilledUsage`, Codex kind, model
        // from `self.model`) so the loop bills the turn with the CORRECT provider regardless
        // of parse.
        let step = parse_agent_step(&outcome.content);
        Ok((step, Some(BilledUsage::from_codex(&outcome, &self.model))))
    }
}

/// The process-wide DEFAULT (built-in) tool registry, built once and reused. The free
/// `trusted_classify`/`build_tool_prompt` chokepoints call this on every turn; caching
/// avoids rebuilding the `BTreeMap` + its ~10 `String`s per call (the UNW-002 reviewer
/// perf NIT). The registry is immutable after init, so a shared `&'static` is safe; a
/// CUSTOM registry (tool packs) is still constructed per-caller via [`ToolRegistry::default`]
/// + [`ToolRegistry::register`].
fn default_registry() -> &'static ToolRegistry {
    static DEFAULT: std::sync::OnceLock<ToolRegistry> = std::sync::OnceLock::new();
    DEFAULT.get_or_init(ToolRegistry::default)
}

/// Build the tool-call prompt for the DEFAULT (built-in) tool registry. (For a custom
/// tool set — tool packs / skills, UNW-002 — use [`build_tool_prompt_with`].)
pub fn build_tool_prompt(task: &str) -> String {
    build_tool_prompt_with(task, default_registry())
}

/// Build the tool-call prompt: the `registry`'s tool menu (so the advertised tools and
/// the classification allow-list are the SAME source of truth) + the EXACT
/// single-JSON-object output contract the [`parse_tool_call`] reader enforces. The
/// model can still NAME anything; the registry is the gate. Pure + deterministic.
pub fn build_tool_prompt_with(task: &str, registry: &ToolRegistry) -> String {
    let mut s = String::from(
        "You are Friday's tool-using agent. Pick exactly ONE tool to make progress.\n\
         Available tools:\n",
    );
    for (name, desc) in registry.advertised() {
        s.push_str(&format!("- {name}: {desc}\n"));
    }
    s.push_str(
        "\nReply with EXACTLY ONE JSON object and nothing else (no prose, no code fence \
         is required but tolerated), of the form:\n\
         {\"tool\": \"<tool name>\", \"parameters\": {\"<key>\": \"<value>\"}}\n\
         All parameter values must be strings. When the task is complete (or no tool is \
         needed), reply with a finish object that INCLUDES your final answer:\n\
         {\"tool\": \"none\", \"answer\": \"<your final answer in natural language>\"}\n\n",
    );
    s.push_str("Task: ");
    s.push_str(task);
    s.push('\n');
    s
}

/// Strip a leading triple-backtick code fence (optionally tagged, e.g. json) and its
/// closing fence if present, returning the inner body; otherwise the trimmed input
/// unchanged. Models commonly wrap JSON in a fence; the contract tolerates it.
fn strip_code_fence(s: &str) -> &str {
    let t = s.trim();
    let Some(after_open) = t.strip_prefix("```") else {
        return t;
    };
    // Skip an optional language tag up to (and including) the first newline.
    let body_start = after_open
        .find('\n')
        .map(|i| i + 1)
        .unwrap_or(after_open.len());
    let body = &after_open[body_start..];
    match body.rfind("```") {
        Some(i) => body[..i].trim(),
        None => body.trim(),
    }
}

/// STRICTLY parse a model reply into a [`RawToolCall`]. Fail-closed by design: the
/// de-fenced content must be EXACTLY one JSON object (serde_json rejects trailing
/// data, so prose after the object is a parse error — not a best-effort first match),
/// with a string `tool` and an optional `parameters` object whose values are all
/// strings. Any violation is an [`AgentError::Parse`]; the model can never coax a
/// partial/over-broad match. (`tool: "none"` parses to `action == "none"`, which the
/// registry treats as an unregistered tool → the turn fail-closes; the richer
/// "no tool / finish" control flow is the full-loop slice.)
pub fn parse_tool_call(content: &str) -> Result<RawToolCall, AgentError> {
    let trimmed = strip_code_fence(content);
    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|e| AgentError::Parse(format!("not a single JSON object: {e}")))?;
    let obj = value
        .as_object()
        .ok_or_else(|| AgentError::Parse("top-level value is not a JSON object".to_string()))?;
    let action = obj
        .get("tool")
        .and_then(|t| t.as_str())
        .ok_or_else(|| AgentError::Parse("missing or non-string `tool`".to_string()))?
        .to_string();
    let mut params = Vec::new();
    if let Some(p) = obj.get("parameters") {
        let pobj = p
            .as_object()
            .ok_or_else(|| AgentError::Parse("`parameters` is not an object".to_string()))?;
        for (k, v) in pobj {
            let vs = v.as_str().ok_or_else(|| {
                AgentError::Parse(format!("parameter `{k}` value is not a string"))
            })?;
            params.push((k.clone(), vs.to_string()));
        }
    }
    Ok(RawToolCall { action, params })
}

/// Build the MULTI-TURN prompt: the tool menu + the EXACT JSON contract + the
/// conversation history (prior actions + Hub-authored outcome summaries) so the model
/// can build on what already happened or finish. Pure + deterministic.
pub fn build_loop_prompt(task: &str, history: &[TurnTrace]) -> String {
    let mut s = build_tool_prompt(task);
    // Root-listing hint (unconditional — the loop calls this on turn 1 with EMPTY history,
    // which is exactly when the model first tries to list the workspace). Pass path `"."`
    // EXPLICITLY: an omitted `path` param errors (MissingParam), so steer to `"."`/empty
    // rather than telling the model to drop the param.
    s.push_str(
        "Note: to list the workspace ROOT directory, call list_dir with path \".\" \
         (an empty path \"\" also denotes the root).\n",
    );
    if !history.is_empty() {
        s.push_str(
            "\nSo far this run (each line is a completed step; any text after \"content:\" \
             is the ACTUAL tool result — read and USE it to answer, do NOT re-run the same \
             tool just to see it again):\n",
        );
        for (i, t) in history.iter().enumerate() {
            s.push_str(&format!("{}. {} → {}\n", i + 1, t.action, t.outcome));
        }
        s.push_str(
            "If the task is now complete, reply with your final answer in a finish object: \
             {\"tool\": \"none\", \"answer\": \"<your final answer>\"}.\n",
        );
    }
    s
}

/// Parse a model reply into an [`AgentStep`]: a strict [`parse_tool_call`] whose
/// sentinel `"none"` action (the finish contract) maps to [`AgentStep::Finish`], with the
/// model's final answer lifted from the top-level `answer` field into `Finish.message`;
/// every other (parsed) tool is a [`AgentStep::Tool`]. Fail-closed identically to
/// `parse_tool_call` on any contract violation.
///
/// The `answer` extraction is deliberately LENIENT (and never panics): a finish object
/// that omits `answer`, or whose `answer` is non-string, still parses to a `Finish` with
/// an empty `message` — a missing answer is an honest empty answer, not a parse error.
/// (`parse_tool_call` already validated the de-fenced content is exactly one JSON object,
/// so the second parse here is guaranteed to succeed; `.ok()` keeps it total regardless.)
pub fn parse_agent_step(content: &str) -> Result<AgentStep, AgentError> {
    let raw = parse_tool_call(content)?;
    if raw.action == "none" {
        let message = serde_json::from_str::<serde_json::Value>(strip_code_fence(content))
            .ok()
            .as_ref()
            .and_then(|v| v.get("answer"))
            .and_then(|a| a.as_str())
            .unwrap_or_default()
            .to_string();
        Ok(AgentStep::Finish { message })
    } else {
        Ok(AgentStep::Tool(raw))
    }
}

/// Provider auth-readiness, delegating to `friday-providers` (establishes that
/// secret-bearing dependency on the Hub side). The Hub uses this to decide whether
/// a provider route is usable before driving a turn through it.
pub fn provider_auth<P: friday_providers::ProviderProbe>(
    probe: &P,
    provider: friday_providers::Provider,
) -> friday_providers::ProviderAuthStatus {
    friday_providers::detect(probe, provider)
}

// --- deterministic parameter serialization (advisor must-nail #2) ------------

/// Deterministically serialize tool parameters: sort by (key, value), then
/// length-prefix each pair so the encoding is order-independent AND unambiguous.
/// The approval ISSUER and the live RE-CHECK must produce byte-identical
/// `canonical_action_bytes`; routing both through this (never a `HashMap` iteration
/// order) is what keeps an issued approval's digest matching at execution time.
pub fn canonical_params(pairs: &[(String, String)]) -> String {
    let mut sorted = pairs.to_vec();
    sorted.sort();
    let mut out = String::new();
    for (k, v) in &sorted {
        out.push_str(&k.len().to_string());
        out.push(':');
        out.push_str(k);
        out.push('=');
        out.push_str(&v.len().to_string());
        out.push(':');
        out.push_str(v);
        out.push(';');
    }
    out
}

/// A tool the Hub is willing to run, and its TRUSTED classification. The registry is
/// an allow-list: an action not in it is refused ([`ToolError::UnknownTool`]) — never
/// executed, never auto-allowed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolSpec {
    /// Whether the action mutates state. This is the load-bearing bit the gate keys
    /// `requires_approval` on, and it comes from HERE, never from model output.
    pub mutating: bool,
    /// The tool's inherent risk floor (param inspection can only RAISE it).
    pub base_risk: Risk,
    /// One-line purpose, advertised to the model in the tool-call prompt.
    pub description: String,
}

/// A LATE-BOUND, data-driven tool allow-list (UNW-002): maps a tool action name to its
/// TRUSTED [`ToolSpec`]. Built-ins come from [`ToolRegistry::default`]; runtime tool
/// packs / skills add more via [`ToolRegistry::register`]. The registry — never model
/// output — decides whether a tool exists and whether it mutates. Classification and
/// request-building are methods on it, so a Hub can drive a turn against a CUSTOM tool
/// set without recompiling. The free [`trusted_classify`]/[`build_request`] keep using
/// the default registry, so existing callers are unchanged.
#[derive(Clone, Debug)]
pub struct ToolRegistry {
    tools: std::collections::BTreeMap<String, ToolSpec>,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        let mut r = ToolRegistry {
            tools: std::collections::BTreeMap::new(),
        };
        // Built-in Hub tools (descriptions mirror the model-facing prompt menu).
        r.register(
            "read_file",
            false,
            Risk::ReadOnly,
            "read a file's contents (params: path)",
        );
        r.register(
            "list_dir",
            false,
            Risk::ReadOnly,
            "list a directory's entries (params: path)",
        );
        r.register(
            "stat_file",
            false,
            Risk::ReadOnly,
            "stat a file (params: path)",
        );
        r.register(
            "search",
            false,
            Risk::ReadOnly,
            "search the workspace (params: query)",
        );
        r.register(
            "write_file",
            true,
            Risk::Medium,
            "create or replace a file (params: path, content)",
        );
        r.register(
            "edit_file",
            true,
            Risk::Medium,
            "replace the first occurrence of old_text with new_text in a file (params: path, old_text, new_text)",
        );
        r.register(
            "append_file",
            true,
            Risk::Medium,
            "append to a file (params: path, content)",
        );
        r.register(
            "delete_file",
            true,
            Risk::High,
            "delete a file (params: path)",
        );
        r.register(
            "move_file",
            true,
            Risk::High,
            "move/rename a file (params: path, target)",
        );
        r.register(
            "run_command",
            true,
            Risk::High,
            "run a shell command (params: command)",
        );
        r
    }
}

impl ToolRegistry {
    /// Register (or override) a tool. Runtime tool packs / skills call this to extend
    /// the allow-list. `mutating`/`base_risk` are the TRUSTED classification — they
    /// come from the registrant (Hub-trusted code), never from the model.
    pub fn register(
        &mut self,
        action: impl Into<String>,
        mutating: bool,
        base_risk: Risk,
        description: impl Into<String>,
    ) {
        self.tools.insert(
            action.into(),
            ToolSpec {
                mutating,
                base_risk,
                description: description.into(),
            },
        );
    }

    /// Look up a tool's trusted spec (`None` = unregistered → refused).
    pub fn spec(&self, action: &str) -> Option<&ToolSpec> {
        self.tools.get(action)
    }

    /// Registered tools as `(action, description)`, sorted (deterministic prompt menu).
    pub fn advertised(&self) -> Vec<(&str, &str)> {
        self.tools
            .iter()
            .map(|(a, s)| (a.as_str(), s.description.as_str()))
            .collect()
    }

    /// Classify a raw tool call against THIS registry (see [`trusted_classify`] for the
    /// trust contract). The registry supplies the trusted per-tool spec (`mutating` +
    /// `base_risk`); the never-lowered risk escalation + resource extraction live in the
    /// sealed [`friday_core::gate::classify`], so the result is a `Classification` that
    /// can only have come from classification — not a forgeable struct literal (task #29).
    pub fn classify(
        &self,
        action: &str,
        params: &[(String, String)],
    ) -> Result<friday_core::gate::Classification, ToolError> {
        let spec = self
            .spec(action)
            .ok_or_else(|| ToolError::UnknownTool(action.to_string()))?;
        Ok(friday_core::gate::classify(
            spec.mutating,
            spec.base_risk,
            action,
            params,
        ))
    }
}

/// Why a raw tool call could not be turned into an authorizable request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolError {
    /// The action is not in the trusted registry — refuse (fail closed).
    UnknownTool(String),
}

/// The trusted classification of a tool call: the sealed gate-decision trio from
/// `friday-core` ([`friday_core::gate::Classification`]). Aliased here for continuity;
/// it is derived from the registry spec + an inspection of the (model-controlled)
/// params, NEVER from model-asserted fields, and its fields are read via getters
/// (`mutating()`/`risk()`/`resource()`) — there is no forgeable struct literal.
pub type Classified = friday_core::gate::Classification;

/// Classify a raw tool call against the DEFAULT (built-in) tool registry. `mutating`
/// comes from the registry; `risk` is the registry floor RAISED (never lowered) by what
/// the params actually do (a destructive `run_command`, or any `tool_policy`-flagged
/// param, escalates); `resource` from a path/target param. An unregistered action is
/// refused. This is the trusted oracle for `mutating`/`risk`/`resource`; the model
/// contributes only strings. For a CUSTOM tool set (tool packs / skills, UNW-002), use
/// [`ToolRegistry::classify`] on your own registry.
pub fn trusted_classify(
    action: &str,
    params: &[(String, String)],
) -> Result<Classified, ToolError> {
    default_registry().classify(action, params)
}

/// Per-run authority policy threaded into the gate-mandatory dispatch (S4): WHO the run
/// is for (`principal_id`, bound into the gate [`friday_core::gate::Actor`] and thus the
/// action digest — a real capability AND the S6 approval-binding prerequisite), plus the
/// per-run RESTRICTIONS (`disabled_tools`, `read_only`) the dispatch enforces BEFORE a
/// tool can execute.
///
/// **Strictly fail-safe.** [`RunPolicy::default`] (no principal, nothing disabled, not
/// read-only) reproduces the pre-S4 behavior EXACTLY; a populated policy can only ever
/// NARROW authority (bind a principal — which never grants approval, see
/// [`build_request_with_policy`] — and block more tools), never widen it. An unknown
/// principal / empty disabled-set therefore defaults to current behavior, never looser.
///
/// Mirrors the TS `executeRun` run-config (`principalId` / `disabledToolNames` /
/// `constraints.readOnly`); `disabled_tools` is normalized like the oracle's
/// `normalizeToolNameSet` (trim, drop empties). Authorization `scopes` (TS
/// `constraints`/`scopes` for policy routing) are a DEFERRED follow-up — the Rust gate
/// models no scope→action policy yet, so wiring one here would balloon scope.
#[derive(Clone, Debug, Default)]
pub struct RunPolicy {
    principal_id: Option<String>,
    disabled_tools: std::collections::BTreeSet<String>,
    read_only: bool,
    /// (NS-1) The run's action-context dimensions
    /// (`agent_id`/`workspace`/`tool`/`provider`/`channel`/`workflow_family`/`skill_family`),
    /// carried verbatim so the gate-dispatch chokepoint can later construct a
    /// [`friday_storage::AgentActionContext`] for the NS-2 trust check. PURE PLUMBING:
    /// this field is CARRIED to the chokepoint ([`gate_dispatch_with_policy`] already
    /// receives `&RunPolicy`) but is NOT consulted by ANY gate logic in this PR — no gate
    /// decision (Allow/RequiresApproval/Deny) reads it, so a populated context is
    /// byte-identical to `None` at the gate. `None` (the default everywhere it is not
    /// supplied) is exactly the pre-NS-1 behavior. Distinct from `principal_id` (WHO the
    /// run is for): NS-1 carries the context unchanged; whether/how `agent_id` converges
    /// with `principal_id` is an NS-2 design decision, NOT plumbing.
    action_context: Option<friday_storage::AgentActionContext>,
}

/// The fail-closed outcome of resolving a tool action against a run's disabled-set, AFTER
/// canonicalizing TS↔Rust names ([`tool_name_map::canonical_rust_name`]) — the typed path
/// the executeRun-replacement will consume so a foreign / mistyped tool name can NEVER
/// weaken the disabled-set by sneaking through as "not disabled".
///
/// Three distinct outcomes (vs the boolean [`RunPolicy::is_tool_disabled`]) so the future
/// routing slice can tell "explicitly disabled by policy" apart from "unknown ⇒ denied as a
/// safety floor". Both non-`Allowed` variants mean DO NOT RUN.
///
/// Dark substrate: `rust_wired`, no caller yet, NOT a v1 GO.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolGate {
    /// The action canonicalized to a known Rust tool AND is not in the (canonicalized)
    /// disabled-set ⇒ the run MAY proceed to classify/authorize/execute it.
    Allowed,
    /// The action canonicalized to a known Rust tool that IS in the disabled-set (matched
    /// after canonicalization, so a TS-shaped disabled entry like `exec` correctly disables
    /// the dispatched `run_command`). DO NOT RUN.
    DisabledByPolicy,
    /// The action did not canonicalize to ANY known Rust tool (foreign / mistyped / a
    /// TS name with no Rust executor). Fail-CLOSED: treated as denied — NEVER `Allowed`.
    UnknownFailClosed,
}

impl RunPolicy {
    /// Build a policy. `disabled_tools` is normalized (trimmed, empties dropped) to match
    /// the TS oracle's `normalizeToolNameSet`. A `(None, [], false)` triple is exactly
    /// [`RunPolicy::default`] (pre-S4 behavior).
    pub fn new(
        principal_id: Option<String>,
        disabled_tools: impl IntoIterator<Item = String>,
        read_only: bool,
    ) -> Self {
        let disabled_tools = disabled_tools
            .into_iter()
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .collect();
        RunPolicy {
            principal_id,
            disabled_tools,
            read_only,
            // (NS-1) No action context by default — every existing `new`/`default` caller is
            // unchanged (and behaves identically: the field is carried, never consulted by
            // the gate). A context is attached via `with_action_context`.
            action_context: None,
        }
    }

    /// The run's bound principal (WHO the run is for). `None` ⇒ no principal bound — the
    /// gate Actor's `principal_id` stays `None` (the pre-S4 default).
    pub fn principal_id(&self) -> Option<&str> {
        self.principal_id.as_deref()
    }

    /// (NS-1) Attach the run's action-context dimensions, returning the policy with the
    /// context carried. Additive builder (consumes + returns `self`) so existing
    /// `new`/`default` callers are untouched — they keep a `None` context. The context is
    /// stored VERBATIM (already shaped as a [`friday_storage::AgentActionContext`]:
    /// `agent_id`/`workspace`/`tool`/`provider`/`channel`/`workflow_family`/`skill_family`).
    ///
    /// PURE PLUMBING (NS-1): attaching a context does NOT change any gate decision — the
    /// field is carried to the gate-dispatch chokepoint but never consulted by gate logic
    /// in this PR. The NS-2 trust check ([`friday_storage::authorize_agent_action`]) will
    /// read it back via [`RunPolicy::action_context`]; NS-1 only delivers it there.
    pub fn with_action_context(mut self, ctx: friday_storage::AgentActionContext) -> Self {
        self.action_context = Some(ctx);
        self
    }

    /// (NS-1) The run's action context, as carried to the gate-dispatch chokepoint —
    /// the thin accessor NS-2 reads to build the [`friday_storage::AgentActionContext`]
    /// for the trust check. `None` ⇒ no context attached (every pre-NS-1 caller).
    ///
    /// This is the READ-BACK seam this PR adds: NS-1 plumbs the context HERE; it does NOT
    /// call [`friday_storage::authorize_agent_action`] (that is NS-2). No gate logic reads
    /// this accessor in this PR, so the gate decision is byte-identical whether a context
    /// is attached or not.
    pub fn action_context(&self) -> Option<&friday_storage::AgentActionContext> {
        self.action_context.as_ref()
    }

    /// True if `action` is disabled for this run (compared trim-insensitively against the
    /// normalized set). A disabled tool is REJECTED before classification/execution.
    pub fn is_tool_disabled(&self, action: &str) -> bool {
        self.disabled_tools.contains(action.trim())
    }

    /// True if this run is constrained read-only (a mutating tool is blocked before
    /// execution — strictly stricter than the gate's default Pause-pending-approval).
    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    /// (A1) Return a NEW policy that is THIS policy TIGHTENED by per-run constraints — never
    /// loosened. It is the COMPOSITION (not a replacement) of the boot policy with a wire-
    /// asserted per-run restriction, so the only-tighten invariant holds UNCONDITIONALLY,
    /// independent of whether the boot config is itself unconstrained:
    ///   - `read_only` is the LOGICAL-OR (`self || constraint`) — a read-only run can never be
    ///     un-read-onlied by a constraint that omits the flag;
    ///   - `disabled_tools` is the UNION (`self ∪ constraint`) — a tool the boot policy disables
    ///     STAYS disabled even when the per-run constraint does not name it;
    ///   - the bound `principal_id` is taken VERBATIM from `self` (a constraint is a restriction
    ///     of WHAT the run may do, NEVER a re-binding of WHO it runs as — the owner is the
    ///     authenticated caller the runtime is configured with, unchanged by any constraint).
    ///
    /// The `disabled_tools` arg is normalized exactly as [`RunPolicy::new`] (trim, drop empties),
    /// so an empty/whitespace entry can never widen the set. Passing `read_only:false` + an empty
    /// list yields a policy EQUAL to `self` (no widening) — the absent-constraint case the caller
    /// instead represents as `None` (no override at all), but this still composes safely.
    pub fn tightened_by(&self, read_only: bool, disabled_tools: &[String]) -> RunPolicy {
        let mut merged: std::collections::BTreeSet<String> = self.disabled_tools.clone();
        for n in disabled_tools {
            let trimmed = n.trim();
            if !trimmed.is_empty() {
                merged.insert(trimmed.to_string());
            }
        }
        RunPolicy {
            principal_id: self.principal_id.clone(),
            disabled_tools: merged,
            // OR: a constraint can only ADD read-only, never remove a boot-configured one.
            read_only: self.read_only || read_only,
            // (NS-1) Carried VERBATIM from `self`: a tightening constraint restricts WHAT a
            // run may do, NEVER its identity/context — the same rule already applied to
            // `principal_id` above. The action context is a property of the run, not a
            // restriction, so it is preserved unchanged through any tightening.
            action_context: self.action_context.clone(),
        }
    }

    /// Fail-closed, name-reconciled resolution of a tool action against this run's
    /// disabled-set (executeRun-replacement slice 1 — security pre-req).
    ///
    /// Unlike the EXACT-string [`RunPolicy::is_tool_disabled`] (which the live S4 path
    /// still uses, unchanged), this canonicalizes BOTH `action` and every disabled-set
    /// entry through [`tool_name_map::canonical_rust_name`] FIRST, then compares on the
    /// canonical Rust name. Two consequences, both strictly TIGHTENING:
    ///   - **Translation closes the fail-open hazard.** A TS-shaped disabled entry (`exec`)
    ///     canonicalizes to `run_command`, so resolving the dispatched `run_command`
    ///     returns [`ToolGate::DisabledByPolicy`]. With the raw exact-match, `exec` would
    ///     NOT match `run_command` and the operator-disabled tool would silently run.
    ///   - **The unknown fails CLOSED.** An `action` that canonicalizes to nothing (foreign
    ///     / mistyped / a TS name with no Rust executor) returns
    ///     [`ToolGate::UnknownFailClosed`] — NEVER `Allowed`. A foreign name can therefore
    ///     never weaken the disabled-set by sneaking through as "not disabled".
    ///
    /// **No-op for already-matching names.** For an all-Rust input (the only kind the
    /// current loop produces), `Allowed`/`DisabledByPolicy` agree exactly with
    /// `!is_tool_disabled`/`is_tool_disabled`. This method is dead until a future routing
    /// slice consumes it; it adds a typed safety floor without changing any live path.
    pub fn resolve_tool(&self, action: &str) -> ToolGate {
        let canon = match tool_name_map::canonical_rust_name(action) {
            Some(rust) => rust,
            // Unknown ⇒ fail-closed: never reported as runnable.
            None => return ToolGate::UnknownFailClosed,
        };
        let disabled = self
            .disabled_tools
            .iter()
            .any(|entry| tool_name_map::canonical_rust_name(entry) == Some(canon));
        if disabled {
            ToolGate::DisabledByPolicy
        } else {
            ToolGate::Allowed
        }
    }
}

/// Build the canonical [`MutatingActionRequest`] for a raw tool call with the pre-S4
/// default policy (no principal bound). Thin wrapper over [`build_request_with_policy`];
/// existing callers/tests that do not bind a per-run principal are unchanged.
pub fn build_request(raw: &RawToolCall) -> Result<MutatingActionRequest, ToolError> {
    build_request_with_policy(raw, &RunPolicy::default())
}

/// Build the canonical [`MutatingActionRequest`] for a raw tool call, binding the run's
/// PRINCIPAL (S4) from `policy` into the gate [`friday_core::gate::Actor`]. Deterministic:
/// the same call+policy always yields byte-identical `canonical_action_bytes`, so an
/// approval minted over this request matches when the turn re-builds it.
///
/// **The principal is bound into the action digest.** `canonical_action_bytes`
/// length-prefixes `actor.principal_id`, so a request for principal `A` and the SAME
/// action for principal `B` (or `None`) produce DIFFERENT digests — this is both a real
/// capability (a run is scoped to a principal) and the S6 prerequisite (an operator
/// approval binds to a specific principal). The actor KIND stays [`ActorKind::Agent`]:
/// S4 records WHO the run is for, it does NOT grant approval authority — an Agent actor
/// can STILL never self-approve (the bound-principal rule in `friday-core::gate` is
/// untouched). `policy.principal_id() == None` reproduces the pre-S4 `principal_id: None`
/// actor exactly.
///
/// **This is the single chokepoint that closes UNW-001.** `mutating`/`risk`/`resource`
/// come from [`trusted_classify`] (the registry + param inspection), NEVER from the
/// model — and [`RawToolCall`] has no such fields, so a model cannot even express the
/// "this destructive action is non-mutating" lie. As of task #29 this is enforced by
/// the type system: those fields are private on `MutatingActionRequest` and can only be
/// set from the sealed [`Classified`] via [`MutatingActionRequest::from_classification`],
/// so no other code can construct a request that skips classification. An unregistered
/// action is refused here ([`ToolError::UnknownTool`]) and the turn never authorizes it.
pub fn build_request_with_policy(
    raw: &RawToolCall,
    policy: &RunPolicy,
) -> Result<MutatingActionRequest, ToolError> {
    let classified = trusted_classify(&raw.action, &raw.params)?;
    Ok(MutatingActionRequest::from_classification(
        classified,
        raw.action.clone(),
        friday_core::gate::Actor {
            kind: ActorKind::Agent,
            id: "hub-agent".to_string(),
            // S4: bind the run's principal (WHO the run is for) — None reproduces the
            // pre-S4 actor. This flows into `canonical_action_bytes`, so the digest binds
            // the principal (S6 prereq). KIND stays Agent → still cannot self-approve.
            principal_id: policy.principal_id.clone(),
        },
        "agent".to_string(),
        vec![],
        Some(canonical_params(&raw.params)),
        None,
        None,
    ))
}

// --- Hub-side approval minting (advisor must-nail #3, Hub side) --------------

/// Mint a signed canonical approval for `request` (the Hub-side trust flow: the Hub
/// holds the signing `secret` — in production `friday-crypto::SecureStore` — and,
/// after the owner approves, mints the signed approval bound to THIS exact action).
/// This tracer demonstrates the Hub signing seam; the phone-side owner-approval UX
/// is out of scope here.
pub fn mint_approval(
    request: &MutatingActionRequest,
    approval_id: &str,
    secret: &[u8],
    expires_at_ms: i64,
) -> CanonicalApproval {
    let digest = friday_crypto::action_digest(&canonical_action_bytes(request));
    let mut approval = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: approval_id.to_string(),
        action_digest: digest,
        expires_at: Some(expires_at_ms),
        issuer: Some(CANONICAL_GATE_ISSUER.to_string()),
        signature: None,
    };
    approval.signature = Some(friday_crypto::sign_approval(
        &canonical_approval_signature_bytes(&approval),
        secret,
    ));
    approval
}

// --- model-call → ledger → audit coupling (audit 10A Q1) ---------------------

/// Why persisting a Friday-route model call failed.
#[derive(Debug)]
pub enum RecordAskError {
    /// The model/transport call failed — NOTHING is persisted (no half-billed row).
    Route(friday_deepseek::DeepSeekError),
    /// The atomic ledger+activity+audit write failed (all-or-nothing rollback).
    Storage(StorageError),
}

impl std::fmt::Display for RecordAskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecordAskError::Route(e) => write!(f, "route_error: {e:?}"),
            RecordAskError::Storage(e) => write!(f, "storage_error: {e}"),
        }
    }
}

/// Run a Friday-route DeepSeek ask AND persist it as ONE atomic ledger+activity+audit
/// record — the call→ledger→audit COUPLING the token-safety audit (file 10A Q1, gaps
/// 1a/1b) requires. The route ([`friday_deepseek`]) builds the `LedgerEntry` (total
/// recomputed, `fallback=false`); the Hub (composition root) persists it via
/// `record_model_call` so EVERY billable call leaves exactly ONE ledger row + ONE
/// activity receipt + ONE hash-chained audit entry, all-or-nothing. On a route failure
/// nothing is written (no half-billed row); discovery (`GET /models`) is non-billable
/// and writes nothing — only the `POST /chat` produces the row.
///
/// The caller MUST supply a fresh `ledger_id` per ask: reusing one fails CLOSED — the
/// `token_ledger` PK collision (the first insert in `record_model_call`'s tx) rolls the
/// whole transaction back, so a reused id yields `Err(Storage)` with no double-bill and
/// no partial row, never a second charge (Reviewer-A).
#[allow(clippy::too_many_arguments)]
pub fn record_friday_ask<T: friday_deepseek::Transport>(
    db: &mut Db,
    client: &friday_deepseek::DeepSeekClient<T>,
    ledger_id: &str,
    session_id: &str,
    activity_id: &str,
    prompt: &str,
    max_tokens: u32,
    now_ms: i64,
) -> Result<friday_deepseek::ModelCallOutcome, RecordAskError> {
    let (outcome, entry) = client
        .run_friday_ask(
            ledger_id,
            session_id,
            activity_id,
            prompt,
            max_tokens,
            now_ms,
        )
        .map_err(RecordAskError::Route)?;
    let activity = ActivityRow {
        activity_id: activity_id.to_string(),
        session_id: Some(session_id.to_string()),
        kind: ActivityType::AskReceipt,
        state: ActivityState::Done,
        summary: format!("{} tokens via {}", entry.total_tokens, entry.model),
        created_at: now_ms,
        updated_at: now_ms,
        deep_link: None,
    };
    let audit = AuditEvent {
        audit_id: format!("{ledger_id}:modelcall"),
        actor: "hub".to_string(),
        action: "friday_ask.model_call".to_string(),
        payload_ref: Some(ledger_id.to_string()),
        created_at: now_ms,
    };
    db.record_model_call(&entry, &activity, &audit)
        .map_err(RecordAskError::Storage)?;
    Ok(outcome)
}

/// Build the memory-recall prompt preamble for `principal` and record its hash-chained
/// receipt (PROOF-MEMORY-001). The SINGLE recall composition shared by both surfaces:
/// `recall_confirmed` (same-principal + Confirmed + content, SQL layer) →
/// [`cognition::rank_recall`] (recency-decay + top-k + PII) →
/// [`cognition::gate_and_render_recall`] (the per-item Context Passport gate — sensitive
/// drops itself under v1 deny-all). Sharing this guarantees the agent loop and the
/// `friday_ask` surface apply the SAME gate (no bypass). When anything was recalled, a
/// `memory.recalled` audit event (`receipt_audit_id`) records the recalled/injected/gated
/// counts + injected ids. `None` principal ⇒ empty preamble, no recall.
pub fn recall_preamble_for(
    db: &Db,
    principal: Option<&str>,
    receipt_audit_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let Some(principal) = principal else {
        return Ok(String::new());
    };
    let rows = friday_storage::memory::recall_confirmed(db.conn(), principal)?;
    let ranked = cognition::rank_recall(
        &rows,
        now_ms,
        cognition::DEFAULT_RECALL_TOP_K,
        cognition::DEFAULT_HALF_LIFE_MS,
    );
    // v1 deny-all: no sensitive-transfer approval is wired, so sensitive memory never injects.
    let (preamble, receipt) = cognition::gate_and_render_recall(&ranked, false);
    if receipt.recalled > 0 {
        let tx = db
            .conn()
            .unchecked_transaction()
            .map_err(StorageError::from)?;
        friday_storage::audit::append_audit(
            &tx,
            receipt_audit_id,
            principal,
            &format!(
                "memory.recalled:recalled={} injected={} gated_sensitive={}",
                receipt.recalled, receipt.injected, receipt.gated_sensitive
            ),
            Some(&receipt.injected_ids.join(",")),
            now_ms,
        )
        .map_err(StorageError::from)?;
        tx.commit().map_err(StorageError::from)?;
    }
    Ok(preamble)
}

/// A Friday ask (single ledgered model call) FED BY MEMORY RECALL — the full
/// PROOF-MEMORY-001 trace on ONE surface: `principal`'s confirmed memory is recalled +
/// Passport-gated (via [`recall_preamble_for`]), prepended to the question, and the model
/// call returns an ANSWER ([`friday_deepseek::ModelCallOutcome::content`]) that is
/// token-LEDGERED + AUDITED by [`record_friday_ask`]. So a recall-fed answer here carries
/// the trace the agent loop cannot (the loop has no free-text answer channel + no token
/// ledger). `None` principal ⇒ a plain ask (no recall). The recalled marker reaches the
/// answer ONLY if the model actually uses the injected memory — that is the live proof.
#[allow(clippy::too_many_arguments)]
pub fn record_friday_ask_with_recall<T: friday_deepseek::Transport>(
    db: &mut Db,
    client: &friday_deepseek::DeepSeekClient<T>,
    principal: Option<&str>,
    ledger_id: &str,
    session_id: &str,
    activity_id: &str,
    question: &str,
    max_tokens: u32,
    now_ms: i64,
) -> Result<friday_deepseek::ModelCallOutcome, RecordAskError> {
    let preamble =
        recall_preamble_for(db, principal, &format!("{ledger_id}:memory-recall"), now_ms)
            .map_err(RecordAskError::Storage)?;
    let prompt = if preamble.is_empty() {
        question.to_string()
    } else {
        format!("{preamble}{question}")
    };
    record_friday_ask(
        db,
        client,
        ledger_id,
        session_id,
        activity_id,
        &prompt,
        max_tokens,
        now_ms,
    )
}

// --- the one composed turn ---------------------------------------------------

/// The outcome of one composed turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnOutcome {
    pub decision: GateDecision,
    pub reason: String,
    /// True iff the (mock) executor ran — i.e. the gate returned `Allow`.
    pub executed: bool,
    /// The planning classification of the task (`None` = the gate was bypassed).
    pub plan_kind: Option<&'static str>,
}

/// Drive ONE composed agent turn over an existing run (`agent_run::create_run` the
/// run first). Proves the seam chain: LLM proposal → `classify_kind` →
/// `MutatingActionRequest` → `authorize_mutating_action` → (mock) execute on
/// `Allow` → `record_event`. Every step is real substrate; only the model and the
/// executor are mocked.
// Consistent with `friday-storage`'s `add_step`: the turn driver legitimately
// threads several distinct values; the live-loop slice may bundle them into a
// `TurnContext`, but for the tracer an explicit signature is clearer.
#[allow(clippy::too_many_arguments)]
pub fn run_one_turn(
    client: &dyn AgentLlmClient,
    conn: &Connection,
    run_id: &str,
    turn_index: u64,
    task: &str,
    secret: &[u8],
    approval: Option<&CanonicalApproval>,
    now_ms: i64,
) -> Result<TurnOutcome, StorageError> {
    // 1. Plan classification (on the TASK, independent of the proposal), recorded as an
    //    event. event_id keys on the caller's monotonic `turn_index` (NOT `now_ms`) so
    //    consecutive turns never PK-collide on `agent_run_event.event_id` — this is what
    //    makes run_one_turn safely loopable (a real loop increments turn_index per turn).
    let plan_kind = friday_core::classify_kind(task).map(|k| k.as_str());
    agent_run::record_event(
        conn,
        &format!("{run_id}:t{turn_index}:plan"),
        run_id,
        &format!("plan.{}", plan_kind.unwrap_or("none")),
        now_ms,
    )?;

    // 2. The model proposes a tool call (untrusted: action + params only). A model or
    //    parse failure fail-closes to Deny — never a silent no-op or non-mutating action.
    let raw = match client.propose_tool_call(task) {
        Ok(raw) => raw,
        Err(e) => {
            agent_run::record_event(
                conn,
                &format!("{run_id}:t{turn_index}:outcome"),
                run_id,
                &format!("agent.error:{e}"),
                now_ms,
            )?;
            return Ok(TurnOutcome {
                decision: GateDecision::Deny,
                reason: format!("agent_error:{e}"),
                executed: false,
                plan_kind,
            });
        }
    };

    // 3. Build the canonical request — the trusted chokepoint. An unregistered tool is
    //    refused HERE (fail closed): it is never authorized and never executed.
    let request = match build_request(&raw) {
        Ok(request) => request,
        Err(ToolError::UnknownTool(action)) => {
            agent_run::record_event(
                conn,
                &format!("{run_id}:t{turn_index}:outcome"),
                run_id,
                &format!("tool.rejected:unregistered:{action}"),
                now_ms,
            )?;
            return Ok(TurnOutcome {
                decision: GateDecision::Deny,
                reason: "unregistered_tool".to_string(),
                executed: false,
                plan_kind,
            });
        }
    };

    // 4. Authorize — composes the pure gate decision, crypto digest/signature
    //    verification, expiry, and the single-use replay store.
    let record = authorize_mutating_action(conn, &request, approval, secret, now_ms)?;

    // 5. Execute ONLY on Allow (mock executor); record the outcome either way.
    let executed = matches!(record.decision, GateDecision::Allow);
    let outcome_kind = if executed {
        format!("tool.executed:{}", raw.action)
    } else {
        format!(
            "tool.blocked:{}:{}",
            record.decision.as_str(),
            record.reason
        )
    };
    agent_run::record_event(
        conn,
        &format!("{run_id}:t{turn_index}:outcome"),
        run_id,
        &outcome_kind,
        now_ms,
    )?;

    Ok(TurnOutcome {
        decision: record.decision,
        reason: record.reason,
        executed,
        plan_kind,
    })
}

// --- the tool executor (real, friday-fs-backed dispatch) ---------------------

/// A receipt of a tool execution: what ran + a short outcome `summary`, plus the OPTIONAL
/// real tool-result `content` (e.g. the bytes a `read_file` produced).
///
/// `summary` is the short, Hub-authored, log-safe line ("read 47 bytes from notes.md");
/// it — and ONLY it — is recorded to the agent_run event log AND the hash-chained audit
/// ledger. `content` is the actual result the model needs to USE what a tool produced;
/// it is fed back into the model's next-turn context (bounded) via [`TurnTrace::outcome`]
/// and is NEVER written to the event log or audit ledger (so the ledger stays a compact,
/// content-free chain). `content` is `None` for tools with nothing meaningful to feed
/// back (e.g. `write_file`, whose `summary` already says what happened).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolReceipt {
    pub action: String,
    pub summary: String,
    /// The real tool-result payload to thread back to the model (bounded at feed-back
    /// time, see [`MAX_FEEDBACK_CONTENT_BYTES`]); `None` when there is nothing to feed back.
    pub content: Option<String>,
}

/// Why a tool EXECUTION failed — distinct from the GATE refusing it. The gate runs
/// first; the executor is only ever reached on `Allow`. Fail-closed: an unsupported
/// or malformed call errors, never a silent no-op.
#[derive(Debug)]
pub enum ExecError {
    /// A required parameter was absent.
    MissingParam(String),
    /// The action is registered but this executor does not implement it (yet).
    Unsupported(String),
    /// The hardened safe-open rejected the path (containment/symlink/not-found/...).
    Fs(friday_fs::FsError),
    /// A read/write I/O error after a successful safe-open.
    Io(std::io::Error),
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecError::MissingParam(p) => write!(f, "missing_param:{p}"),
            ExecError::Unsupported(a) => write!(f, "unsupported_tool:{a}"),
            ExecError::Fs(e) => write!(f, "fs_error:{e}"),
            ExecError::Io(e) => write!(f, "io_error:{e}"),
        }
    }
}

/// Executes an APPROVED tool call. The turn loop reaches an executor ONLY after the
/// gate returns `Allow` ([`run_one_turn_with_executor`]), so the gate is mandatory
/// before every dispatch by construction — there is no path from a model proposal to
/// an executor that skips it (this is the UNW-001 non-optional-DI property).
pub trait ToolExecutor {
    fn execute(&self, action: &str, params: &[(String, String)]) -> Result<ToolReceipt, ExecError>;
}

/// The real executor: every file operation goes through a `friday-fs` hardened
/// safe-open primitive, contained to a workspace `root` (NEVER `std::fs` on an
/// agent-supplied path). Wired tools (S3-wiring):
///   - **read-type** (`mutating=false` in the registry → gate `Allow`s directly): `read_file`,
///     `list_dir`, `stat_file`, `search`. Each sets [`ToolReceipt::content`] with its result (file
///     bytes / entry names / stat line / matching lines) so the loop feeds it back to the model
///     (bounded — see [`MAX_FEEDBACK_CONTENT_BYTES`]).
///   - **mutating** (`mutating=true` → the gate withholds them pending owner approval; under the
///     default deny-all policy they Pause, never execute here): `write_file`, `append_file`,
///     `edit_file`, `delete_file`, `move_file`. They set `content: None`.
///
/// The executor is reached ONLY on a gate `Allow` (see [`gate_dispatch`]), so a mutating arm runs
/// IFF a signed approval was minted — the executor itself never decides; the gate does.
/// `search` is a read-type tool wired to `friday_fs::search_within_root` (sets `content` with the
/// matches; `summary` is a count only). `run_command` (the highest-risk arm) is wired to
/// `friday_fs::run_command_in_root` — shell-FREE direct-argv exec, env-scrubbed, cwd-contained,
/// timeout+kill, output-bounded; `content` carries the bounded output, `summary` is REFS-ONLY
/// (exit code + byte count, NEVER the output or command). It is `mutating=true, Risk::High`, so
/// the gate withholds it pending a single-use Ed25519 approval of the exact command and it never
/// executes here without one. Fail-closed in every arm.
pub struct FsToolExecutor {
    root: std::path::PathBuf,
}

impl FsToolExecutor {
    pub fn new(root: impl Into<std::path::PathBuf>) -> Self {
        Self { root: root.into() }
    }
    fn param<'a>(params: &'a [(String, String)], key: &str) -> Result<&'a str, ExecError> {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .ok_or_else(|| ExecError::MissingParam(key.to_string()))
    }
}

impl ToolExecutor for FsToolExecutor {
    fn execute(&self, action: &str, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        use std::io::Read;
        match action {
            "read_file" => {
                let path = Self::param(params, "path")?;
                let mut file =
                    friday_fs::open_read_within_root(&self.root, path).map_err(ExecError::Fs)?;
                let mut buf = String::new();
                let n = file.read_to_string(&mut buf).map_err(ExecError::Io)?;
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!("read {n} bytes from {path}"),
                    // Carry the ACTUAL file content so the loop can feed it back to the
                    // model (bounded at feed-back time); the byte-count `summary` alone is
                    // what made the model re-read & hallucinate (S1.2 grounding bug).
                    content: Some(buf),
                })
            }
            "write_file" => {
                let path = Self::param(params, "path")?;
                let content = Self::param(params, "content")?;
                // Atomic temp+rename (task #30b): a mid-write failure leaves the original
                // file intact rather than a truncated partial — the target is replaced by
                // a single rename, never truncated in place.
                friday_fs::write_file_within_root(&self.root, path, content.as_bytes())
                    .map_err(ExecError::Fs)?;
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!("wrote {} bytes to {path}", content.len()),
                    // A write has no result payload to feed back; the summary suffices.
                    content: None,
                })
            }
            // --- read-type tools (non-mutating → gate Allows → execute here) ---
            "list_dir" => {
                let path = Self::param(params, "path")?;
                let entries =
                    friday_fs::list_dir_within_root(&self.root, path).map_err(ExecError::Fs)?;
                let names: Vec<String> = entries
                    .iter()
                    .map(|e| e.to_string_lossy().into_owned())
                    .collect();
                Ok(ToolReceipt {
                    action: action.to_string(),
                    // summary = count ONLY (it reaches the hash-chained audit ledger); the
                    // entry NAMES go in `content` (model-facing feedback, never the ledger) —
                    // mirrors read_file keeping the file bytes out of the ledger summary.
                    summary: format!("listed {} entries in {path}", names.len()),
                    content: Some(names.join("\n")),
                })
            }
            "stat_file" => {
                let path = Self::param(params, "path")?;
                let st =
                    friday_fs::stat_file_within_root(&self.root, path).map_err(ExecError::Fs)?;
                let kind = match st.kind {
                    friday_fs::FileKind::File => "file",
                    friday_fs::FileKind::Dir => "dir",
                    friday_fs::FileKind::Other => "other",
                };
                // stat metadata is small + non-sensitive, so the same line is both the log
                // summary and the model-facing content (read-type ⇒ content MUST be set).
                let detail = format!(
                    "{path}: {kind}, {} bytes, mode {:o}{}",
                    st.len,
                    st.mode,
                    if st.readonly { ", readonly" } else { "" }
                );
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!("stat {detail}"),
                    content: Some(detail),
                })
            }
            "search" => {
                let query = Self::param(params, "query")?;
                // Optional scope: a contained sub-directory or single file. Absent ⇒ whole
                // workspace root. (The backend REJECTS an absolute/`..`/out-of-root/symlink
                // subpath via the same containment pipeline.)
                let subpath = Self::param(params, "path").ok();
                let hits = friday_fs::search_within_root(&self.root, query, subpath)
                    .map_err(ExecError::Fs)?;
                // Read-type ⇒ the matches are model-facing `content`; the `summary` (which
                // reaches the hash-chained audit ledger) is a COUNT ONLY — the matched lines
                // never enter the ledger, mirroring list_dir/read_file keeping their payload
                // out of the summary. Each match renders as `relpath:line:text` (the model's
                // grep-style grounding; bounded by the backend caps + feed-back truncation).
                let content = hits
                    .iter()
                    .map(|h| format!("{}:{}:{}", h.relative_path, h.line_number, h.line_text))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!("search matched {} line(s)", hits.len()),
                    content: Some(content),
                })
            }
            // --- mutating tools (gate withholds under deny-all; reached ONLY on Allow) ---
            "append_file" => {
                let path = Self::param(params, "path")?;
                let content = Self::param(params, "content")?;
                friday_fs::append_file_within_root(&self.root, path, content.as_bytes())
                    .map_err(ExecError::Fs)?;
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!("appended {} bytes to {path}", content.len()),
                    content: None,
                })
            }
            "edit_file" => {
                let path = Self::param(params, "path")?;
                let old_text = Self::param(params, "old_text")?;
                let new_text = Self::param(params, "new_text")?;
                // First-occurrence replace via the atomic (temp+rename) friday-fs edit.
                friday_fs::edit_file_within_root(&self.root, path, old_text, new_text)
                    .map_err(ExecError::Fs)?;
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!(
                        "edited {path}: replaced {} bytes with {} bytes",
                        old_text.len(),
                        new_text.len()
                    ),
                    content: None,
                })
            }
            "delete_file" => {
                let path = Self::param(params, "path")?;
                friday_fs::delete_file_within_root(&self.root, path).map_err(ExecError::Fs)?;
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!("deleted {path}"),
                    content: None,
                })
            }
            "move_file" => {
                let path = Self::param(params, "path")?;
                let target = Self::param(params, "target")?;
                friday_fs::move_file_within_root(&self.root, path, target)
                    .map_err(ExecError::Fs)?;
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!("moved {path} to {target}"),
                    content: None,
                })
            }
            // run_command: the HIGHEST-RISK arm. mutating + Risk::High in the registry; a command
            // with shell metacharacters is classified Critical → gate DENY; the exact command is
            // bound into the action_digest. So this arm is reached ONLY after an operator's
            // single-use Ed25519 approval of THIS command. friday_fs::run_command_in_root runs it
            // SHELL-FREE (direct argv exec), env-SCRUBBED (no FRIDAY_* secret inheritance),
            // cwd-CONTAINED to root, with a TIMEOUT+kill and an OUTPUT cap. Fail-closed: a
            // tokenize/spawn failure is an ExecError::Fs(CommandInvalid|CommandSpawn) with a
            // STATIC message (no path/command/secret).
            "run_command" => {
                let command = Self::param(params, "command")?;
                let result =
                    friday_fs::run_command_in_root(&self.root, command).map_err(ExecError::Fs)?;
                // content (model-facing): the bounded output + an exit/timeout status line.
                let status_line = if result.timed_out {
                    "[run_command: timed out, child killed]".to_string()
                } else {
                    format!("[run_command: exit {:?}]", result.exit_code)
                };
                let content = if result.output.is_empty() {
                    status_line
                } else {
                    format!("{}\n{}", result.output, status_line)
                };
                // summary (REFS-ONLY → hash-chained audit ledger): exit code + byte count +
                // truncation/timeout flags ONLY. NEVER the output text, NEVER the command string
                // (the command already lives in the audit action label + action_digest), NEVER
                // any env/secret. Mirrors read_file/list_dir/search keeping their payload out of
                // the ledger summary — here it is security-critical (command output can be secret).
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!(
                        "run_command: exit {:?}, {} bytes{}{}",
                        result.exit_code,
                        result.output.len(),
                        if result.output_truncated {
                            " (truncated)"
                        } else {
                            ""
                        },
                        if result.timed_out { " (timed out)" } else { "" }
                    ),
                    content: Some(content),
                })
            }
            other => Err(ExecError::Unsupported(other.to_string())),
        }
    }
}

/// Drive ONE composed agent turn with a REAL [`ToolExecutor`] — the runtime-proven
/// dispatch. Identical to [`run_one_turn`] through authorization, then: the executor
/// is reached ONLY on a gate `Allow` (the gate is mandatory before every dispatch —
/// UNW-001), and a successful execution is recorded both as an agent_run event and as
/// a HASH-CHAINED audit receipt. A tool-execution error is recorded but does not flip
/// the gate decision (the gate WAS enforced; the tool merely failed) — `executed`
/// reflects whether the tool actually completed.
///
/// Ledger consistency (task #30): the outcome `agent_run` event AND the hash-chained
/// audit receipt are written in ONE transaction, so the event log can never get ahead
/// of the hash-chained ledger on a partial commit; and BOTH the success and the error
/// paths record a receipt (`tool.exec_failed:*` on error) so the audit chain reflects
/// every gate-Allowed dispatch attempt. This makes the LEDGER internally consistent — it
/// does NOT make the file write and the ledger atomic (`execute()` commits the file side
/// effect before the tx opens). Remaining (tracked, #30b): `write_file` truncates-on-open
/// (friday-fs `set_len(0)`), so a mid-write I/O failure AFTER a successful open can leave
/// a truncated file; the fix is a temp-file + atomic-rename write in friday-fs.
#[allow(clippy::too_many_arguments)]
pub fn run_one_turn_with_executor(
    client: &dyn AgentLlmClient,
    executor: &dyn ToolExecutor,
    conn: &Connection,
    run_id: &str,
    turn_index: u64,
    task: &str,
    secret: &[u8],
    approval: Option<&CanonicalApproval>,
    now_ms: i64,
) -> Result<TurnOutcome, StorageError> {
    let plan_kind = friday_core::classify_kind(task).map(|k| k.as_str());
    agent_run::record_event(
        conn,
        &format!("{run_id}:t{turn_index}:plan"),
        run_id,
        &format!("plan.{}", plan_kind.unwrap_or("none")),
        now_ms,
    )?;

    let raw = match client.propose_tool_call(task) {
        Ok(raw) => raw,
        Err(e) => {
            agent_run::record_event(
                conn,
                &format!("{run_id}:t{turn_index}:outcome"),
                run_id,
                &format!("agent.error:{e}"),
                now_ms,
            )?;
            return Ok(TurnOutcome {
                decision: GateDecision::Deny,
                reason: format!("agent_error:{e}"),
                executed: false,
                plan_kind,
            });
        }
    };

    let request = match build_request(&raw) {
        Ok(request) => request,
        Err(ToolError::UnknownTool(action)) => {
            agent_run::record_event(
                conn,
                &format!("{run_id}:t{turn_index}:outcome"),
                run_id,
                &format!("tool.rejected:unregistered:{action}"),
                now_ms,
            )?;
            return Ok(TurnOutcome {
                decision: GateDecision::Deny,
                reason: "unregistered_tool".to_string(),
                executed: false,
                plan_kind,
            });
        }
    };

    let record = authorize_mutating_action(conn, &request, approval, secret, now_ms)?;

    // The gate is the ONLY path to the executor: dispatch happens IFF Allow.
    if !matches!(record.decision, GateDecision::Allow) {
        agent_run::record_event(
            conn,
            &format!("{run_id}:t{turn_index}:outcome"),
            run_id,
            &format!(
                "tool.blocked:{}:{}",
                record.decision.as_str(),
                record.reason
            ),
            now_ms,
        )?;
        return Ok(TurnOutcome {
            decision: record.decision,
            reason: record.reason,
            executed: false,
            plan_kind,
        });
    }

    // Allow → real dispatch. The outcome event AND the hash-chained audit receipt are
    // written in ONE transaction (task #30) so the event log can never get ahead of the
    // hash-chained ledger on a partial commit. Both success AND error now record a
    // receipt (`tool.exec_failed:*` on error) so the audit chain reflects every
    // gate-Allowed dispatch attempt. (NOTE: the file side effect is committed by
    // `execute()` BEFORE this tx opens — this makes the LEDGER internally consistent, it
    // does NOT make the file write and the ledger atomic; durable file atomicity is the
    // separate temp+rename follow-up, #30b.)
    let event_id = format!("{run_id}:t{turn_index}:outcome");
    let receipt_id = format!("{run_id}:t{turn_index}:receipt");
    match executor.execute(&raw.action, &raw.params) {
        Ok(receipt) => {
            let tx = conn.unchecked_transaction()?;
            agent_run::record_event(
                &tx,
                &event_id,
                run_id,
                &format!("tool.executed:{}", receipt.summary),
                now_ms,
            )?;
            friday_storage::audit::append_audit(
                &tx,
                &receipt_id,
                "hub-agent",
                &format!("tool.executed:{}", receipt.action),
                Some(&receipt.summary),
                now_ms,
            )?;
            tx.commit()?;
            Ok(TurnOutcome {
                decision: GateDecision::Allow,
                reason: record.reason,
                executed: true,
                plan_kind,
            })
        }
        Err(e) => {
            let err_text = format!("{e}");
            let tx = conn.unchecked_transaction()?;
            agent_run::record_event(
                &tx,
                &event_id,
                run_id,
                &format!("tool.exec_error:{err_text}"),
                now_ms,
            )?;
            friday_storage::audit::append_audit(
                &tx,
                &receipt_id,
                "hub-agent",
                &format!("tool.exec_failed:{}", raw.action),
                Some(&err_text),
                now_ms,
            )?;
            tx.commit()?;
            Ok(TurnOutcome {
                decision: GateDecision::Allow,
                reason: format!("exec_error:{err_text}"),
                executed: false,
                plan_kind,
            })
        }
    }
}

// --- the multi-turn run loop -------------------------------------------------

/// (C2-1) A cooperative cancellation handle for the routed run loop. The loop checks
/// [`CancelToken::is_cancelled`] at the TOP of each turn (BEFORE the model call), so a
/// tripped token stops the loop cleanly with [`LoopStatus::Interrupted`] — making NO
/// further model call and billing NOTHING after the trip. Cooperative (between-turns),
/// NOT a mid-turn abort: a turn already in flight runs to completion; the cancel takes
/// effect at the next turn boundary. Clone-cheap (`Arc`); holder and loop share the SAME
/// flag, so [`CancelToken::cancel`] from any holder is observed by the loop.
///
/// DARK: this is the interrupt/stop substrate the routed-claude parity harness's
/// `interrupt / stop` flow needs (see `tests/routed_claude_parity.rs`'s DEFERRED note —
/// "there is no cancel handle on run_task_pinned. WIRING NEEDED: a cancellation token
/// threaded into the routed loop"). The no-key in-crate test is its deterministic proof.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl CancelToken {
    /// A fresh, un-tripped token.
    pub fn new() -> Self {
        Self::default()
    }

    /// Request cancellation. Idempotent — observed by the loop at the next turn boundary
    /// (no effect on a turn already in flight; that turn completes and is billed normally).
    pub fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// (C2-2) A cooperative STEER handle for the routed run loop: an OPTIONAL slot holding at most
/// ONE pending operator instruction. The loop [`SteerHandle::drain`]s it at the TOP of each turn
/// (AFTER the [`CancelToken`] check, BEFORE the model call), and a drained instruction is folded
/// into the prompt the model sees for that turn — so the NEXT `next_step_metered` carries it and
/// produces a REAL extra billed turn whose chat is grounded on the steer. It is NOT a no-op
/// mirror event and NOT a follow-up of its own: it changes the CONTENT of the turn the loop was
/// already about to take. Cooperative/between-turns like the cancel: a turn already in flight is
/// not re-prompted; the steer lands at the NEXT turn boundary the loop reaches. (It therefore
/// cannot resurrect a loop that has already `Finish`ed — there is no next boundary.)
///
/// Clone-cheap (`Arc<Mutex<..>>`); the holder keeps a clone and calls [`SteerHandle::steer`] from
/// another point (in a single-threaded test the stub injects it between scripted turns; the live
/// test injects from a background thread, the same way the cancel is tripped). [`SteerHandle::drain`]
/// returns `None` when empty — the no-op the no-steer path relies on. A drained instruction is
/// consumed (`take`) so it is FOLDED IN exactly ONCE (the drain never re-fires on a later turn);
/// having been folded into the prompt it then REMAINS in the model's context for the rest of the
/// run, BY DESIGN — the loop's history (`TurnTrace`) has no slot to carry a free-form instruction,
/// so dropping it after a single turn would make the model forget the operator's steer mid-task.
///
/// DARK: this is the steer substrate the routed-claude parity harness needs (the provider-workspace
/// `SteerTurn=Unsupported` mirror is NOT a metered turn — this is). The no-key in-crate test, which
/// asserts the stub OBSERVED the injected instruction in its `task` argument on the steered turn and
/// NOT before, is its deterministic proof.
#[derive(Clone, Debug, Default)]
pub struct SteerHandle(std::sync::Arc<std::sync::Mutex<Option<String>>>);

impl SteerHandle {
    /// A fresh, empty steer handle (no pending instruction).
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue an operator instruction to fold into the model's NEXT turn. Replaces any prior
    /// un-drained instruction (the slot holds at most one — the latest steer wins). Observed by
    /// the loop at the next turn boundary; no effect on a turn already in flight.
    pub fn steer(&self, instruction: impl Into<String>) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(instruction.into());
        }
    }

    /// Take the pending instruction if any, leaving the slot empty. Returns `None` (a no-op)
    /// when empty — the no-steer path. A poisoned lock is treated as empty (fail-closed: no
    /// fabricated steer), never a panic in the hot loop.
    pub fn drain(&self) -> Option<String> {
        self.0.lock().ok().and_then(|mut slot| slot.take())
    }
}

/// How a [`run_loop`] ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopStatus {
    /// The model declared the task finished (`AgentStep::Finish`).
    Finished,
    /// A mutating tool needs owner approval the loop did not have — paused (the owner
    /// approval leg is operator-relayed; the loop stops here, resumable later).
    Paused,
    /// A tool was denied (replay, deny, or an unregistered tool) — hard stop.
    Blocked,
    /// `max_turns` reached without the model finishing — bounded stop.
    Bounded,
    /// The model client errored (transport/parse) — fail-closed stop.
    Errored,
    /// (C2-1) A cooperative [`CancelToken`] was tripped at a turn boundary — the loop
    /// stopped BEFORE the next model call. Terminal: no further model call is made and
    /// NOTHING is billed after the trip. Carries no deliverable answer (like `Bounded`),
    /// so the post-loop owner-wiring tail (which persists only on `Finished`) skips it.
    Interrupted,
}

/// The outcome of a whole [`run_loop`]. `executed_tools` is the count of tools that
/// actually ran (gate `Allow` + executor `Ok`) — a `Finished` with `executed_tools==0`
/// is an HONEST "model finished without doing anything", never a fabricated success.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoopOutcome {
    pub status: LoopStatus,
    /// Turns taken = model `next_step` calls made (the no-hidden-call invariant: the
    /// loop makes EXACTLY this many model calls, none outside the loop body).
    pub turns: u64,
    pub executed_tools: u64,
    pub final_message: Option<String>,
    pub detail: String,
}

/// The outcome of dispatching ONE raw tool call through the gate-mandatory path.
/// This is the SINGLE source of truth for "classify → authorize → execute ONLY on
/// `Allow`", shared by [`run_loop`] (the model-driven agent loop) and
/// [`workflow_exec::run_workflow`] (the definition-driven workflow engine), so the
/// two drivers cannot drift on the security-critical dispatch. The caller records
/// the outcome (event log / step state / history) in its own vocabulary.
pub(crate) enum GateDispatch {
    /// Gate `Allow`ed AND the executor ran successfully.
    Executed(ToolReceipt),
    /// Gate `Allow`ed but the executor returned an error (one executor call, not run).
    ExecError(ExecError),
    /// Gate withheld the action pending owner approval (`RequiresApproval`). Not executed.
    RequiresApproval,
    /// Gate `Deny`. Not executed; carries the reason.
    Denied(String),
    /// The action is not a registered tool — fail-closed; never executed.
    Unregistered(String),
}

/// How a protected (`RequiresApproval`) action is authorized at the dispatch chokepoint.
/// This makes the authorization scheme EXPLICIT at each call site — there is no implicit
/// fallback that could let a protected action be Allowed by the wrong scheme.
///
/// S6d switched the LOOP to [`AuthzMode::Ed25519`] / [`AuthzMode::DenyAll`] — the loop's
/// protected path is NEVER [`AuthzMode::Hmac`], so it can never be Allowed by an HMAC
/// approval (the latent self-Allow is closed). The legacy symmetric [`AuthzMode::Hmac`]
/// remains ONLY for the separate `workflow_exec` driver (its Ed25519 switch is a follow-up
/// lane); the loop never selects it.
#[derive(Clone, Copy)]
pub(crate) enum AuthzMode<'a> {
    /// S6d loop path: verify a protected action's approval as Ed25519 under the operator's
    /// PUBLIC key (verify-only — the Hub can never mint). No HMAC code path is reachable.
    Ed25519(&'a OperatorVerifyingKey),
    /// S6d loop path, unprovisioned: NO operator key ⇒ fail-closed. The base gate decision
    /// stands and a `RequiresApproval` is NEVER upgraded — a protected action Pauses.
    DenyAll,
    /// Legacy symmetric HMAC authorize (the `workflow_exec` driver only). Retained so this
    /// slice does not change workflow behavior; the loop NEVER uses this variant.
    Hmac(&'a [u8]),
}

/// Classify → authorize → execute-ONLY-on-`Allow`, the gate-mandatory dispatch for a
/// single raw tool call. The executor is invoked EXACTLY once, and ONLY on a gate
/// `Allow`; `RequiresApproval`/`Deny`/unregistered never reach the executor. Records
/// nothing itself (the caller does) — this is purely the security-critical decision +
/// execution, so [`run_loop`] and [`workflow_exec::run_workflow`] share ONE copy.
pub(crate) fn gate_dispatch(
    conn: &Connection,
    executor: &dyn ToolExecutor,
    raw: &RawToolCall,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    now_ms: i64,
) -> Result<GateDispatch, StorageError> {
    // Pre-S4 default policy (no principal bound, nothing disabled). The `workflow_exec`
    // driver keeps its existing legacy HMAC authorization (S6d switched the LOOP, not the
    // workflow driver — that is a separate follow-up lane). Behavior here is unchanged.
    gate_dispatch_with_policy(
        conn,
        executor,
        raw,
        AuthzMode::Hmac(secret),
        approve,
        &RunPolicy::default(),
        now_ms,
    )
}

/// [`gate_dispatch`] with a per-run [`RunPolicy`] (S4): binds the run's PRINCIPAL into the
/// request (and thus the action digest) and enforces the run's RESTRICTIONS BEFORE
/// execution. The two restriction checks are fail-closed and applied ahead of the gate, so
/// they can only NARROW authority (block more), never widen it:
///   1. a tool DISABLED for this run (`disabledToolNames`) is refused outright — it never
///      reaches classification/authorization/execution (`tool_disabled_for_run:*`);
///   2. under a READ-ONLY run constraint, a mutating tool (per the TRUSTED registry
///      classification, never model-asserted) is refused before execution
///      (`run_is_read_only:*`) — strictly stricter than the gate's default (Pause pending
///      approval). Both surface as [`GateDispatch::Denied`] so the shared callers
///      ([`run_loop_with_policy`], `workflow_exec`) need no new arm.
///
/// ## S6d — the protected-path authorization, made explicit ([`AuthzMode`])
/// `authz` selects HOW a protected (`RequiresApproval`) action is authorized:
///   - [`AuthzMode::Ed25519`] (the LOOP, operator key provisioned): the approval signature
///     is ALWAYS verified as Ed25519 under the operator's PUBLIC key
///     ([`authorize_mutating_action_ed25519`]). An HMAC-signed approval over the same
///     canonical bytes is REJECTED (an HMAC hex is not a 64-byte Ed25519 signature, and
///     even a right-sized value is invalid without the operator's offline private key) —
///     closing the latent self-Allow (the Hub holds only a verify key + the HMAC secret,
///     yet cannot get a protected action Allowed).
///   - [`AuthzMode::DenyAll`] (the LOOP, unprovisioned): fail-closed — the base gate
///     decision stands and a `RequiresApproval` is NEVER upgraded, so a protected action
///     Pauses. No approval, no HMAC path.
///   - [`AuthzMode::Hmac`] (the `workflow_exec` driver ONLY): the legacy symmetric
///     authorize, unchanged by this slice. The loop NEVER selects this variant.
///
/// The base decision ([`friday_core::gate::evaluate`]) is authoritative for read-only
/// (Allow) / reserved (Deny) and the bound-principal rule (an Agent/Channel can never
/// self-approve) — decided BEFORE any signature is examined, in every mode.
///
/// Everything else is identical to the pre-S4 path: authorize → execute ONLY on `Allow`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn gate_dispatch_with_policy(
    conn: &Connection,
    executor: &dyn ToolExecutor,
    raw: &RawToolCall,
    authz: AuthzMode<'_>,
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    policy: &RunPolicy,
    now_ms: i64,
) -> Result<GateDispatch, StorageError> {
    // (NS-1) The run's action context is now carried HERE on `policy`
    // (`policy.action_context()`), constructible into a `friday_storage::AgentActionContext`
    // for the NS-2 trust check. NS-1 is PURE PLUMBING: nothing below reads it, so every gate
    // decision is byte-identical to the pre-NS-1 path whether a context is attached or not.
    // NS-2 will add the `authorize_agent_action` call that consumes it — NOT here, NOT now.
    //
    // (0) disabledToolNames — fail-closed, BEFORE classify/authorize/execute. A tool not
    //     available to this run must never run; refusing here (it never reaches the gate)
    //     is strictly stricter than any gate decision.
    if policy.is_tool_disabled(&raw.action) {
        return Ok(GateDispatch::Denied(format!(
            "tool_disabled_for_run:{}",
            raw.action
        )));
    }
    let request = match build_request_with_policy(raw, policy) {
        Ok(request) => request,
        Err(ToolError::UnknownTool(action)) => return Ok(GateDispatch::Unregistered(action)),
    };
    // (1) read-only run constraint — a mutating tool (TRUSTED `mutating()`, never the
    //     model's word) is blocked before execution. Stricter than the gate (which would
    //     Pause it); never looser.
    if policy.is_read_only() && request.mutating() {
        return Ok(GateDispatch::Denied(format!(
            "run_is_read_only:{}",
            raw.action
        )));
    }
    // (2) S6d protected-path authorization (explicit per `authz`):
    let record = match authz {
        // LOOP: verify a protected action's approval as Ed25519 under the operator's key.
        // An HMAC-signed approval over the same bytes is rejected here (downgrade closed).
        AuthzMode::Ed25519(vk) => {
            let approval = approve(&request);
            authorize_mutating_action_ed25519(conn, &request, approval.as_ref(), vk, now_ms)?
        }
        // LOOP, unprovisioned: DenyAll-equivalent. The base decision stands; a
        // RequiresApproval is never upgraded (no approval consulted, no HMAC path), so a
        // protected action Pauses. Read-only Allows, reserved/agent-self-approve Denies.
        AuthzMode::DenyAll => friday_core::gate::evaluate(&request),
        // workflow_exec ONLY: the legacy symmetric HMAC authorize, unchanged by S6d.
        AuthzMode::Hmac(secret) => {
            let approval = approve(&request);
            authorize_mutating_action(conn, &request, approval.as_ref(), secret, now_ms)?
        }
    };
    Ok(match record.decision {
        // Execute ONLY on Allow — the single chokepoint both drivers rely on.
        GateDecision::Allow => match executor.execute(&raw.action, &raw.params) {
            Ok(receipt) => GateDispatch::Executed(receipt),
            Err(e) => GateDispatch::ExecError(e),
        },
        GateDecision::RequiresApproval => GateDispatch::RequiresApproval,
        GateDecision::Deny => GateDispatch::Denied(record.reason),
    })
}

/// Max bytes of real tool-result CONTENT fed back into the model's next-turn context
/// (the [`TurnTrace::outcome`] history). Read-type tools (e.g. `read_file`) load the
/// whole file, but only this BOUNDED head slice is threaded back so the model can USE
/// what it read WITHOUT re-creating the completion-budget / cost blow-up an unbounded
/// feedback would cause. 2 KiB comfortably covers a notes / config file's salient head;
/// anything larger is truncated with [`FEEDBACK_TRUNCATION_MARKER`].
const MAX_FEEDBACK_CONTENT_BYTES: usize = 2048;

/// TTL (ms) for a `pending_approval_request` the loop persists when a mutating action
/// Pauses (S6d): the `expires_at` the OFFLINE operator signs over and the resume
/// entrypoint re-checks (an expired approval is fail-closed Denied). 24h gives the
/// operator a realistic offline-signing window without leaving an approval valid
/// indefinitely.
const PENDING_APPROVAL_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// Appended to fed-back content when it was truncated to [`MAX_FEEDBACK_CONTENT_BYTES`],
/// so the model knows the file continues beyond what it can see.
const FEEDBACK_TRUNCATION_MARKER: &str = " …[content truncated]";

/// The largest UTF-8 prefix of `s` whose byte length is `<= max_bytes`, and whether any
/// bytes were dropped. Never splits a multi-byte char: walks back to the nearest char
/// boundary, so the returned slice is always valid `&str` and never panics.
fn head_slice(s: &str, max_bytes: usize) -> (&str, bool) {
    if s.len() <= max_bytes {
        return (s, false);
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (&s[..end], true)
}

/// Format a completed tool execution into the [`TurnTrace::outcome`] threaded back to the
/// model as conversation history. The byte-count `summary` is ALWAYS included (it is what
/// the audit ledger also records). When the executor returned real `content` (e.g. the
/// bytes a `read_file` produced), a BOUNDED head slice of that content is appended so the
/// model can actually USE what it read — WITHOUT this the model sees only "read N bytes
/// from X", re-reads the same file, and hallucinates (the S1.2 grounding bug). The content
/// is capped at [`MAX_FEEDBACK_CONTENT_BYTES`] on a UTF-8 char boundary, with a clear
/// truncation marker. `summary` (and thus the audit/event log) is NEVER widened — raw
/// content lives ONLY in the model-facing history outcome, never on the hash-chained ledger.
fn format_executed_outcome(receipt: &ToolReceipt) -> String {
    match receipt.content.as_deref() {
        Some(content) => {
            let (head, truncated) = head_slice(content, MAX_FEEDBACK_CONTENT_BYTES);
            if truncated {
                format!(
                    "executed: {} | content (first {} bytes shown):\n{head}{FEEDBACK_TRUNCATION_MARKER}",
                    receipt.summary,
                    head.len()
                )
            } else {
                format!("executed: {} | content:\n{head}", receipt.summary)
            }
        }
        None => format!("executed: {}", receipt.summary),
    }
}

/// Max bytes of prior-session conversation CONTENT rendered into the model prompt
/// preamble (S5 inbound history). Keeps the multi-turn context BOUNDED so a long
/// session can never blow the completion-token budget — the session-level mirror of
/// [`MAX_FEEDBACK_CONTENT_BYTES`] for per-turn tool content. The MOST RECENT messages
/// are preserved; older ones are dropped (with [`SESSION_HISTORY_OMISSION_MARKER`])
/// once the budget is exceeded.
const MAX_SESSION_HISTORY_BYTES: usize = 6144;

/// Per-message cap inside the session-history preamble: a single oversized message is
/// head-sliced to this many bytes (with [`FEEDBACK_TRUNCATION_MARKER`]) so one huge
/// turn cannot by itself exhaust [`MAX_SESSION_HISTORY_BYTES`]. Strictly smaller than
/// the history budget, so the most-recent message ALWAYS fits.
const MAX_SESSION_MESSAGE_BYTES: usize = 1024;

/// Prepended to the rendered session history when older messages were dropped to fit
/// [`MAX_SESSION_HISTORY_BYTES`], so the model knows the conversation began earlier.
const SESSION_HISTORY_OMISSION_MARKER: &str = "[earlier session messages omitted]\n";

/// Render a session's prior conversation messages (S5 inbound history) into a BOUNDED
/// prompt preamble, prepended ahead of the recall preamble + task so the model sees
/// the multi-turn context that preceded this run. Pure + deterministic.
///
/// Two bounding layers ensure a long/large session can never blow the completion
/// budget: each message's content is head-sliced to [`MAX_SESSION_MESSAGE_BYTES`],
/// and messages are then accumulated MOST-RECENT-FIRST only while the running total
/// stays within [`MAX_SESSION_HISTORY_BYTES`] — older messages that do not fit are
/// dropped (oldest first), flagged with [`SESSION_HISTORY_OMISSION_MARKER`]. The kept
/// messages are emitted in chronological (oldest-first) order under a label that marks
/// them as CONTEXT, not the current task. An empty history renders the empty string
/// (no preamble — the single-shot prompt is unchanged).
///
/// Like the recall preamble and the tool-result feedback, the rendered history is
/// MODEL-CONTEXT only: it never reaches the event/audit log, and the UNW-001 gate
/// still evaluates EVERY subsequent tool call regardless of what a prior message said
/// (the prompt-injection-inward backstop — prior conversation is not a mutation path).
pub fn render_session_history(messages: &[friday_storage::StoredSessionMessage]) -> String {
    if messages.is_empty() {
        return String::new();
    }
    // Build each line (role + bounded content), keeping most-recent-first within the
    // byte budget so recency survives truncation; reversed back to chronological order.
    let mut kept: Vec<String> = Vec::new();
    let mut total: usize = 0;
    let mut dropped = false;
    for msg in messages.iter().rev() {
        let (head, truncated) = head_slice(&msg.content, MAX_SESSION_MESSAGE_BYTES);
        let line = if truncated {
            format!("{}: {head}{FEEDBACK_TRUNCATION_MARKER}\n", msg.role)
        } else {
            format!("{}: {head}\n", msg.role)
        };
        // Always keep at least the most recent message (its content is capped below
        // the history budget, so one line never overflows on its own).
        if !kept.is_empty() && total + line.len() > MAX_SESSION_HISTORY_BYTES {
            dropped = true;
            break;
        }
        total += line.len();
        kept.push(line);
    }
    kept.reverse();
    let mut s = String::from(
        "Prior conversation in this session (oldest first — this is CONTEXT from \
         earlier turns, NOT the current task):\n",
    );
    if dropped {
        s.push_str(SESSION_HISTORY_OMISSION_MARKER);
    }
    for line in kept {
        s.push_str(&line);
    }
    s.push('\n');
    s
}

/// Ledger ONE agent-loop model call exactly as the ask path ledgers a single ask
/// (`record_friday_ask`): build the provider-correct [`friday_core::LedgerEntry`] from the
/// call's neutral [`BilledUsage`] (C2 — the `provider_kind` picks `friday_route`/DeepSeek vs
/// `anthropic_route`/Claude; the RESPONSE-reported model is ledgered, never the requested
/// one — no stale-model claims), an [`ActivityType::AskReceipt`] receipt
/// (the same receipt shape the ask surface emits), and an `agent_loop.model_call` audit
/// event, then write all three ATOMICALLY with the owning `run_id` via
/// [`friday_storage::record_run_model_call`]. Per-turn ids are derived from
/// `run_id`/`turn_index`, so N model calls leave N distinct, run-attributed rows.
///
/// The loop run is used as the ledger `session_id` (a loop run has no separate session; the
/// AUTHORITATIVE run-attribution is the dedicated `run_id` column added in S1.2). Cost is
/// left unestimated (`None`), matching the ask path. A construction failure (only possible
/// on negative/overflowing usage — a hostile/buggy provider response) maps to a
/// [`StorageError`] and fails the run closed; it never persists a malformed bill.
fn bill_model_call(
    conn: &Connection,
    run_id: &str,
    turn_index: u64,
    outcome: &BilledUsage,
    now_ms: i64,
) -> Result<(), StorageError> {
    let ledger_id = format!("{run_id}:t{turn_index}:ledger");
    let activity_id = format!("{run_id}:t{turn_index}:askreceipt");
    let audit_id = format!("{run_id}:t{turn_index}:modelcall");
    // (C2) Pick the ledger ctor — provider_kind + host — off the neutral usage's enum, so
    // a Claude call records `provider_kind="anthropic"`/`api.anthropic.com` and a DeepSeek
    // call stays byte-identical (`deepseek`/`api.deepseek.com`). `cost_estimate: None` for
    // both (the loop biller has no per-provider pricing table — the honest value, as the
    // ask path passes). The DeepSeek arm is the SAME `friday_route` the pre-C2
    // `outcome.to_ledger_entry(..)` resolved to.
    let entry = match outcome.provider_kind {
        friday_core::ProviderKind::DeepSeek => friday_core::LedgerEntry::friday_route(
            ledger_id.as_str(),
            run_id,
            activity_id.as_str(),
            &outcome.model,
            outcome.prompt_tokens,
            outcome.completion_tokens,
            None,
            None,
            now_ms,
        ),
        friday_core::ProviderKind::Anthropic => friday_core::LedgerEntry::anthropic_route(
            ledger_id.as_str(),
            run_id,
            activity_id.as_str(),
            &outcome.model,
            outcome.prompt_tokens,
            outcome.completion_tokens,
            None,
            None,
            now_ms,
        ),
        // (C1) A Codex turn records `provider_kind="codex"` + the LOCAL app-server host
        // label via `codex_route`, so it is never mis-attributed as DeepSeek/Anthropic.
        friday_core::ProviderKind::Codex => friday_core::LedgerEntry::codex_route(
            ledger_id.as_str(),
            run_id,
            activity_id.as_str(),
            &outcome.model,
            outcome.prompt_tokens,
            outcome.completion_tokens,
            None,
            None,
            now_ms,
        ),
    }
    .map_err(|e| StorageError::Unsupported(format!("loop ledger entry: {e:?}")))?;
    let activity = ActivityRow {
        activity_id,
        session_id: Some(run_id.to_string()),
        kind: ActivityType::AskReceipt,
        state: ActivityState::Done,
        summary: format!("{} tokens via {}", entry.total_tokens, entry.model),
        created_at: now_ms,
        updated_at: now_ms,
        deep_link: None,
    };
    let audit = AuditEvent {
        audit_id,
        actor: "hub-agent".to_string(),
        action: "agent_loop.model_call".to_string(),
        payload_ref: Some(ledger_id),
        created_at: now_ms,
    };
    friday_storage::record_run_model_call(conn, run_id, &entry, &activity, &audit)
}

/// Drive a MULTI-TURN agent loop with the pre-S4 default policy (no per-run principal
/// bound, no disabled tools, not read-only). Thin wrapper over [`run_loop_with_policy`];
/// existing callers/tests are unchanged.
///
/// S6d: this wrapper fail-closes with NO operator verify key (`operator_vk = None`), so a
/// mutating action Pauses (DenyAll-equivalent) — the pre-S6d behavior for callers that do
/// not provision an operator key. The legacy HMAC `_secret` is no longer consulted on the
/// dispatch path. Callers that DO provision an operator key drive
/// [`run_loop_with_policy`] directly with `Some(vk)`.
#[allow(clippy::too_many_arguments)]
pub fn run_loop(
    client: &dyn AgentLlmClient,
    executor: &dyn ToolExecutor,
    conn: &Connection,
    run_id: &str,
    task: &str,
    recall_preamble: &str,
    _secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    max_turns: u64,
    now_ms: i64,
) -> Result<LoopOutcome, StorageError> {
    run_loop_with_policy(
        client,
        executor,
        conn,
        run_id,
        task,
        recall_preamble,
        None, // operator_vk: unprovisioned ⇒ fail-closed Pause for protected actions
        approve,
        &RunPolicy::default(),
        max_turns,
        None, // cancel: no cancellation handle — pre-C2-1 behavior, byte-identical
        None, // steer: no steer handle — pre-C2-2 behavior, byte-identical
        now_ms,
    )
}

/// Drive a MULTI-TURN agent loop: repeatedly ask the model for the next step (with
/// conversation history), and for each proposed tool run the SAME gate-mandatory
/// dispatch as [`run_one_turn_with_executor`] (authorize → execute only on `Allow` →
/// hash-chained receipt), threading the outcome back into history. The loop ends when
/// the model `Finish`es, a tool is `Paused`(RequiresApproval)/`Blocked`(Deny/unknown),
/// the client errors, or `max_turns` is hit (the bound — a runaway model cannot loop
/// forever).
///
/// `policy` (S4) makes the loop principal/scope/constraint-aware: the run's PRINCIPAL is
/// bound into every gate request's `Actor` (and thus the action digest), and the run's
/// RESTRICTIONS (`disabled_tools`, `read_only`) reject a tool before it can execute —
/// enforced inside the SHARED [`gate_dispatch_with_policy`] chokepoint. A
/// [`RunPolicy::default`] reproduces the pre-S4 behavior exactly.
///
/// `operator_vk` (S6d) is the operator's PUBLIC Ed25519 verify key. When `Some`, a
/// protected (mutating) action authorizes against it via the Ed25519 verify-only policy —
/// NEVER the legacy HMAC authorize (an HMAC approval over the same bytes is rejected). On
/// the Pause path the loop persists a `pending_approval_request` (CSPRNG nonce + the exact
/// tool call) so the OFFLINE operator can sign an approval the resume entrypoint
/// re-executes. When `None`, no operator key is provisioned ⇒ fail-closed: every mutating
/// action Pauses, none is ever Allowed.
///
/// `approve` is the in-loop approval seam: given a mutating request, it returns a
/// [`CanonicalApproval`] iff one is available WITHOUT pausing (in production this is
/// deny-all `None` — the operator approves OFFLINE, ingested by the resume entrypoint; in
/// tests it can mint an operator-Ed25519 approval to exercise the Allow path). A read-only
/// action needs no approval (the gate `Allow`s it directly).
///
/// No-hidden-call invariant: the model is called EXACTLY once per loop turn (via
/// `next_step` — count == `turns`), and the executor EXACTLY once per `Allow`ed tool;
/// nothing calls the model or a tool outside this body. Note `executed_tools` counts
/// only Allowed tools that ALSO executed without error (so executor-calls == `executed_tools`
/// only when no exec error occurs — an erroring Allow is one executor call, zero
/// `executed_tools`, by deliberate honest accounting). All observable in the
/// `agent_run_event` log.
/// TOTAL provider-call attempts per loop turn before the turn fails closed. The FIRST try
/// plus up to `N-1` BOUNDED retries — so `3` means at most 3 calls to `next_step_metered`.
/// A retry happens ONLY when the failure is an `AgentError::Route(e)` whose
/// [`crate::retry::RetryDisposition::classify_deepseek`] is `Retryable` (transient network /
/// 5xx / rate-limit); `Terminal` route errors (auth / credential / bad-response / no-models),
/// non-`Route` errors, and an exhausted budget all fail closed immediately. This wraps ONLY
/// the provider call — it is BEFORE the gate dispatch, so no gate outcome
/// (RequiresApproval / Pause / Deny) is ever reachable from this retry. A persistently-failing
/// provider gives up after this many attempts (no unbounded retry / runaway spend). Retries
/// are the SAME turn: they do NOT consume `max_turns`, and because a failed (Route) attempt
/// produces NO usage, it bills NOTHING and writes NO audit/event — only the successful
/// attempt (or the final exhausted failure) is recorded once, OUTSIDE this inner loop.
const RUN_LOOP_MAX_PROVIDER_ATTEMPTS: u32 = 3;

/// `cancel` (C2-1) is an OPTIONAL cooperative cancellation handle checked at the TOP of
/// each turn, BEFORE the model call. When `Some` and already tripped at a turn boundary,
/// the loop stops with [`LoopStatus::Interrupted`]: it makes NO further model call and
/// bills NOTHING after the trip. `None` (the default for every existing caller) is the
/// pre-C2-1 behavior, BYTE-IDENTICAL — no check, no new stop. Cooperative/between-turns:
/// a turn already in flight completes and is billed normally; the cancel takes effect at
/// the NEXT turn boundary only.
///
/// `steer` (C2-2) is an OPTIONAL cooperative steer handle drained at the TOP of each turn,
/// AFTER the cancel check and BEFORE the model call. When `Some` and holding a pending
/// instruction at a turn boundary, the instruction is folded into the prompt for THIS turn —
/// so the turn's `next_step_metered` carries it and produces a REAL billed model call grounded
/// on the steer (an additional metered turn if the loop was continuing). `None`/empty (the
/// default for every existing caller, and any turn with nothing pending) is BYTE-IDENTICAL to
/// pre-C2-2: the drain is a no-op and `prompt_task` is unchanged. Cooperative/between-turns:
/// a turn already in flight is not re-prompted; the steer lands at the next boundary. It folds
/// into exactly one turn (the drain consumes it), and it cannot revive a `Finish`ed loop (there
/// is no next boundary). It changes the prompt the model sees, never the run row / classification
/// / billing attribution — the billed row is the ordinary per-turn anthropic/deepseek row.
#[allow(clippy::too_many_arguments)]
pub fn run_loop_with_policy(
    client: &dyn AgentLlmClient,
    executor: &dyn ToolExecutor,
    conn: &Connection,
    run_id: &str,
    task: &str,
    recall_preamble: &str,
    operator_vk: Option<&OperatorVerifyingKey>,
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    policy: &RunPolicy,
    max_turns: u64,
    cancel: Option<&CancelToken>,
    steer: Option<&SteerHandle>,
    now_ms: i64,
) -> Result<LoopOutcome, StorageError> {
    // Plan classification recorded ONCE (it is a property of the task, constant across
    // turns). Uses the CLEAN `task` — the recall preamble below augments only the prompt,
    // never the run row / classification / events.
    let plan_kind = friday_core::classify_kind(task).map(|k| k.as_str());
    agent_run::record_event(
        conn,
        &format!("{run_id}:plan"),
        run_id,
        &format!("plan.{}", plan_kind.unwrap_or("none")),
        now_ms,
    )?;

    // The prompt the model sees = recall preamble (PROOF-MEMORY-001; already
    // Passport-gated + PII-redacted by the caller) + the clean task. Built once
    // (constant across turns). Empty preamble ⇒ prompt_task == task (recall disabled).
    // NOTE this enters the agent's INSTRUCTION context — a prompt-injection-inward
    // surface. The backstop is genuine: the UNW-001 mutating-action gate evaluates EVERY
    // tool call regardless of prompt text, and the recalled memory is user-CONFIRMED
    // (not raw channel text), so it is trusted context, not arbitrary injection.
    // The bounded tool-result CONTENT now threaded back into history (the S1.2 grounding
    // fix, see `format_executed_outcome`) is ANOTHER prompt-injection-inward surface — a
    // read file could contain adversarial instructions. The SAME backstop holds: that
    // content only ever reaches the prompt, and the gate still evaluates every subsequent
    // tool call regardless of what the file said; it is not a new mutation path.
    // (C2-2) `mut` so a drained steer instruction can be folded in at a turn boundary below.
    // Absent any steer (every pre-C2-2 caller, and any turn with nothing pending) this is never
    // reassigned, so the prompt is byte-identical to before.
    let mut prompt_task = if recall_preamble.is_empty() {
        task.to_string()
    } else {
        format!("{recall_preamble}{task}")
    };

    let mut history: Vec<TurnTrace> = Vec::new();
    let mut executed_tools: u64 = 0;

    // S6d: the loop's protected path authorizes via the operator's Ed25519 verify key when
    // provisioned, else fail-closed (DenyAll). The loop NEVER uses the HMAC authorize, so a
    // protected action can never be Allowed by an HMAC approval.
    let authz = match operator_vk {
        Some(vk) => AuthzMode::Ed25519(vk),
        None => AuthzMode::DenyAll,
    };

    for turn_index in 0..max_turns {
        let ev = |suffix: &str| format!("{run_id}:t{turn_index}:{suffix}");

        // (C2-1) Cooperative cancellation, checked at the TOP of the turn — BEFORE the
        // model call below — so a tripped token stops the loop with NO further model call
        // and NOTHING billed after the trip. `turns: turn_index` (NOT `+1`): this turn's
        // `next_step_metered` has NOT happened, so it must NOT count toward the
        // turns==model-calls invariant (the previous turn's call is `turn_index`). When
        // `cancel` is `None` (every pre-C2-1 caller) this is a no-op and the loop is
        // byte-identical to before. Records a refs-only audit event (no ledger row),
        // mirroring the `agent.loop_bounded` terminal marker.
        if cancel.is_some_and(CancelToken::is_cancelled) {
            agent_run::record_event(
                conn,
                &ev("interrupted"),
                run_id,
                "agent.interrupted",
                now_ms,
            )?;
            return Ok(LoopOutcome {
                status: LoopStatus::Interrupted,
                turns: turn_index,
                executed_tools,
                final_message: None,
                detail: format!("interrupted:turn={turn_index}"),
            });
        }

        // (C2-2) Cooperative steer, drained at the TOP of the turn — AFTER the cancel check
        // (never re-prompt a turn an interrupt is about to cancel) and BEFORE the model call —
        // so a pending operator instruction is folded into THIS turn's prompt and carried by
        // `next_step_metered` below, producing a REAL billed model call grounded on the steer.
        // The drain CONSUMES the instruction so it is folded in exactly ONCE (the drain never
        // re-fires on a later turn). NOTE `prompt_task` is mutated IN PLACE and that mutation
        // PERSISTS for the rest of the run — having been folded in, the steer REMAINS in the
        // model's context on every subsequent turn, BY DESIGN (the loop's `history`/`TurnTrace`
        // has no slot to carry a free-form instruction, so dropping it after one turn would make
        // the model forget the operator's steer mid-task). When `steer` is `None` (every pre-C2-2
        // caller) OR holds nothing, `drain()` returns `None`, `prompt_task` is left untouched, and
        // this turn is byte-identical to before — billing/accounting/status unchanged (non-steered).
        // The steer enters the agent's INSTRUCTION context (a prompt-injection-inward surface, like
        // the recall preamble and the threaded-back tool-result content): the UNW-001 gate still
        // evaluates EVERY subsequent tool call regardless of the steer text, so it is not a new
        // mutation path. A refs-only `agent.steered` marker is recorded (NO ledger row — the
        // billing is the ordinary per-turn row written below); this marker is evidence, NOT the
        // metered turn itself.
        if let Some(instruction) = steer.and_then(SteerHandle::drain) {
            if !instruction.is_empty() {
                prompt_task = format!("{prompt_task}\n\n[operator steer]: {instruction}");
                agent_run::record_event(conn, &ev("steered"), run_id, "agent.steered", now_ms)?;
            }
        }

        // S1.2 usage-parity: ONE metered model call per turn. An OUTER `Err` is a
        // route/transport/discovery failure — the chat produced no usage, so NOTHING is
        // billed (exactly the ask path's `Route` error: no half-billed row). The inner
        // parse result is handled AFTER billing below.
        //
        // BOUNDED provider retry (UNW-011 wiring): the provider call is the ONLY thing
        // retried, and ONLY for a transient `AgentError::Route(e)` (classified `Retryable`
        // by the SINGLE canonical classifier). This inner loop writes NO audit/event and
        // bills NOTHING per attempt — a failed Route attempt yields no usage — so a retried
        // turn does not double-write the hash chain or inflate the token ledger. It is the
        // SAME turn (no `max_turns` consumption), and it is reached BEFORE the gate dispatch,
        // so no gate outcome (RequiresApproval / Pause / Deny) is ever reachable from here.
        // A `Terminal` route error, any non-`Route` error, or an exhausted attempt budget
        // fails closed EXACTLY as before — the original `Err(e)` is surfaced to the single
        // error site below. `attempts` counts attempts ALREADY made (incl. the just-failed
        // one) so the bound is TOTAL attempts == `RUN_LOOP_MAX_PROVIDER_ATTEMPTS`.
        let metered_result = {
            let mut attempts: u32 = 0;
            loop {
                let outcome = client.next_step_metered(&prompt_task, &history);
                match &outcome {
                    Err(AgentError::Route(e)) => {
                        attempts += 1;
                        let disposition = crate::retry::RetryDisposition::classify_deepseek(e);
                        if crate::retry::should_retry(
                            disposition,
                            attempts,
                            RUN_LOOP_MAX_PROVIDER_ATTEMPTS,
                        ) {
                            // Transient route failure with attempts remaining: retry the SAME
                            // provider call (never a reroute). No backoff/sleep — the path has
                            // no injected clock, so a real sleep would only flake tests without
                            // changing the bounded security property.
                            continue;
                        }
                        // Terminal, or the attempt budget is exhausted → fail closed.
                        break outcome;
                    }
                    // A successful call, an already-billed inner parse error, a non-route
                    // `Model`/`Parse` error: never retried — surface immediately.
                    _ => break outcome,
                }
            }
        };
        let (step_result, usage) = match metered_result {
            Ok(metered) => metered,
            Err(e) => {
                agent_run::record_event(
                    conn,
                    &ev("outcome"),
                    run_id,
                    &format!("agent.error:{e}"),
                    now_ms,
                )?;
                return Ok(LoopOutcome {
                    status: LoopStatus::Errored,
                    turns: turn_index + 1,
                    executed_tools,
                    final_message: None,
                    detail: format!("agent_error:{e}"),
                });
            }
        };

        // BILL the call like the ask path: a chat that returned usage writes exactly ONE
        // run-attributed token_ledger row + ONE AskReceipt receipt + ONE hash-chained audit
        // event, atomically — REGARDLESS of how the loop then treats the step (finish, tool,
        // block) or whether the reply even parsed (the S1.1 parse-error mode still spent
        // tokens). A client that does not meter (mocks/tests) yields `None` and bills
        // nothing — the honest default (no usage data ⇒ no ledger row).
        if let Some(outcome) = usage {
            bill_model_call(conn, run_id, turn_index, &outcome, now_ms)?;
        }

        let step = match step_result {
            Ok(step) => step,
            Err(e) => {
                // Chat SUCCEEDED (already billed above) but the reply violated the tool-call
                // contract — fail the run closed; the model call stays ledgered.
                agent_run::record_event(
                    conn,
                    &ev("outcome"),
                    run_id,
                    &format!("agent.error:{e}"),
                    now_ms,
                )?;
                return Ok(LoopOutcome {
                    status: LoopStatus::Errored,
                    turns: turn_index + 1,
                    executed_tools,
                    final_message: None,
                    detail: format!("agent_error:{e}"),
                });
            }
        };

        let raw = match step {
            AgentStep::Finish { message } => {
                agent_run::record_event(conn, &ev("finish"), run_id, "agent.finished", now_ms)?;
                return Ok(LoopOutcome {
                    status: LoopStatus::Finished,
                    turns: turn_index + 1,
                    executed_tools,
                    final_message: Some(message),
                    detail: "finished".to_string(),
                });
            }
            AgentStep::Tool(raw) => raw,
        };

        // Gate-mandatory dispatch via the SHARED chokepoint (same as run_workflow):
        // (disabled/read-only restriction) → bind principal → classify → authorize →
        // execute ONLY on Allow. run_loop owns the recording. S6d: the protected path
        // authorizes via `authz` (Ed25519 verify-only or fail-closed), never HMAC.
        match gate_dispatch_with_policy(conn, executor, &raw, authz, approve, policy, now_ms)? {
            GateDispatch::Unregistered(action) => {
                agent_run::record_event(
                    conn,
                    &ev("outcome"),
                    run_id,
                    &format!("tool.rejected:unregistered:{action}"),
                    now_ms,
                )?;
                return Ok(LoopOutcome {
                    status: LoopStatus::Blocked,
                    turns: turn_index + 1,
                    executed_tools,
                    final_message: None,
                    detail: format!("unregistered_tool:{action}"),
                });
            }
            GateDispatch::Executed(receipt) => {
                {
                    // Outcome event + hash-chained receipt in ONE tx (task #30): the
                    // event log can't get ahead of the ledger on a partial commit.
                    let tx = conn.unchecked_transaction()?;
                    agent_run::record_event(
                        &tx,
                        &ev("outcome"),
                        run_id,
                        &format!("tool.executed:{}", receipt.summary),
                        now_ms,
                    )?;
                    friday_storage::audit::append_audit(
                        &tx,
                        &ev("receipt"),
                        "hub-agent",
                        &format!("tool.executed:{}", receipt.action),
                        Some(&receipt.summary),
                        now_ms,
                    )?;
                    tx.commit()?;
                    executed_tools += 1;
                    history.push(TurnTrace {
                        action: raw.action.clone(),
                        params: raw.params.clone(),
                        // Feed the REAL (bounded) tool-result content back to the model so it
                        // can ground its answer on what the tool produced — not just the
                        // byte-count summary recorded above to the event log / audit ledger.
                        outcome: format_executed_outcome(&receipt),
                    });
                }
            }
            GateDispatch::ExecError(e) => {
                {
                    // A tool error is informative, not fatal: thread it back and let the
                    // model adapt on the next turn (still bounded by max_turns). The error
                    // event + an `exec_failed` receipt are written in ONE tx so a
                    // gate-Allowed-but-failed dispatch is still on the hash-chained ledger.
                    let err_text = format!("{e}");
                    let tx = conn.unchecked_transaction()?;
                    agent_run::record_event(
                        &tx,
                        &ev("outcome"),
                        run_id,
                        &format!("tool.exec_error:{err_text}"),
                        now_ms,
                    )?;
                    friday_storage::audit::append_audit(
                        &tx,
                        &ev("receipt"),
                        "hub-agent",
                        &format!("tool.exec_failed:{}", raw.action),
                        Some(&err_text),
                        now_ms,
                    )?;
                    tx.commit()?;
                    history.push(TurnTrace {
                        action: raw.action.clone(),
                        params: raw.params.clone(),
                        outcome: format!("exec_error: {err_text}"),
                    });
                }
            }
            GateDispatch::RequiresApproval => {
                // S6d Pause persistence: record everything the OFFLINE operator needs to
                // sign an approval for THIS exact action — and everything the resume
                // entrypoint needs to RE-EXECUTE it — and nothing the Hub could use to
                // mint one. The `approval_id` nonce is CSPRNG (unpredictable); the
                // `action_digest` is recomputed from the SAME deterministic request build,
                // so it binds the exact tool call (incl. params + principal). The raw tool
                // call is persisted (Hub-side only) so the resume can replay the one
                // mutation. A persistence failure does NOT fabricate progress — the run
                // still Pauses (resumable once the pending row exists); we record the
                // outcome with the nonce so it is recoverable.
                let nonce = friday_crypto::generate_approval_nonce();
                let pending_recorded = match build_request_with_policy(&raw, policy) {
                    Ok(request) => {
                        let expires_at = now_ms.saturating_add(PENDING_APPROVAL_TTL_MS);
                        let tool_params = serde_json::to_string(&raw.params).ok();
                        let pending = friday_storage::PendingApprovalRequest::for_request(
                            &request, &nonce, run_id, expires_at, now_ms,
                        )
                        .with_tool_params(tool_params);
                        friday_storage::persist_pending_request(conn, &pending).is_ok()
                    }
                    Err(_) => false,
                };
                let outcome = if pending_recorded {
                    format!("tool.paused:requires_approval:{}:{}", raw.action, nonce)
                } else {
                    format!("tool.paused:requires_approval:{}", raw.action)
                };
                agent_run::record_event(conn, &ev("outcome"), run_id, &outcome, now_ms)?;
                return Ok(LoopOutcome {
                    status: LoopStatus::Paused,
                    turns: turn_index + 1,
                    executed_tools,
                    final_message: None,
                    detail: format!("requires_approval:{}", raw.action),
                });
            }
            GateDispatch::Denied(reason) => {
                agent_run::record_event(
                    conn,
                    &ev("outcome"),
                    run_id,
                    &format!("tool.blocked:deny:{reason}"),
                    now_ms,
                )?;
                return Ok(LoopOutcome {
                    status: LoopStatus::Blocked,
                    turns: turn_index + 1,
                    executed_tools,
                    final_message: None,
                    detail: format!("denied:{reason}"),
                });
            }
        }
    }

    agent_run::record_event(
        conn,
        &format!("{run_id}:bounded"),
        run_id,
        "agent.loop_bounded",
        now_ms,
    )?;
    Ok(LoopOutcome {
        status: LoopStatus::Bounded,
        turns: max_turns,
        executed_tools,
        final_message: None,
        detail: format!("max_turns:{max_turns}"),
    })
}

/// Drive a history-aware agent loop WITHIN a session (S5 inbound history + resume).
/// A SESSION groups runs: this loads the session's prior conversation messages,
/// prepends them (BOUNDED) to the prompt so the model sees the multi-turn inbound
/// context, runs the SAME gate-mandatory loop as [`run_loop_with_policy`], then
/// PERSISTS this run's turn(s) back to the session so the NEXT run RESUMES with them.
///
/// Mechanics:
/// * [`friday_storage::ensure_session`] makes the session row exist (idempotent),
///   then [`friday_storage::load_session_messages`] reads the prior turns. The
///   current `task` is loaded BEFORE it is persisted, so it never appears in its own
///   preamble.
/// * The prior messages are rendered by [`render_session_history`] (BOUNDED) and
///   folded AHEAD of `recall_preamble` into the single preamble
///   [`run_loop_with_policy`] already prepends to the task — so NO change to the loop
///   body or its signature is needed, and the session preamble inherits the proven
///   "preamble augments only the prompt, never the run row / classification / events"
///   property. The model sees `[session history][recall preamble][task]`.
/// * After the loop returns, the current `task` is appended as a `user` message and,
///   when the loop `Finish`ed with a final answer, that answer is appended as an
///   `assistant` message — both soft-linked to `run_id` (the `refs`). The message
///   bodies stay Hub-side (like `run_result.answer`); only a REFS-ONLY session event
///   (session id + message count, never the text) is logged. There is NO
///   answer-body-over-wire here (that is the transport lane).
///
/// A non-`Finished` outcome still records the `user` turn (the operator asked it) but
/// no `assistant` answer (there is none). Single-shot runs that never call this keep
/// using [`run_loop`] / [`run_loop_with_policy`] unchanged — no session row is touched.
///
/// ## Owner-wiring (session-memory/D1 parity)
/// * `session_owner`: `Some(owner)` BINDS the session's owner axes at creation via
///   [`friday_storage::ensure_session_with_owner`] (idempotent; an already-bound owner
///   is never clobbered, a NULL axis can be backfilled) — this is what makes a
///   loop-created session's memory namespace RESOLVABLE for the Rust inline extraction.
///   `None` keeps the OWNER-AXIS / session-ensure path exactly as before: it routes to
///   the owner-less [`friday_storage::ensure_session`], the session carries NULL owner
///   axes, and extraction fails closed — unchanged. (NOTE: this "unchanged" scopes to the
///   ensure/owner-axis path only. The new Finished-persist step 5 below runs REGARDLESS of
///   `session_owner` — with `session_owner: None` AND no bound principal it now writes an
///   OWNERLESS `run_result` row the pre-wiring loop did not. That row is fail-closed:
///   `get_run_answer_for_principal` Denies it to EVERYONE (`NoOwnerPrincipal`), so it
///   leaks nothing — see `sessioned_run_without_principal_persists_ownerless_fail_closed_result`.)
/// * A `Finished` outcome now PERSISTS the run's answer Hub-side
///   ([`friday_storage::persist_run_result`]) with the run's BOUND OWNER principal
///   (`policy.principal_id()`) recorded as `owner_principal` — the same D1 owner-wiring
///   [`HubRuntime::run_task`] got in #587 — so the authenticated body projection
///   ([`friday_storage::get_run_answer_for_principal`]) releases a sessioned run's
///   answer ONLY to that owner. A run with NO bound principal records NO owner ⇒ the
///   body stays unreadable to everyone (fail-closed, correct). Persist happens ONLY on
///   `Finished`: a `Paused` run's `run_result` slot belongs to the resume completion
///   leg ([`crate::resume`]), and `Errored`/`Bounded`/`Blocked` carry no deliverable
///   answer (mirrors `run_task`).
///
/// Truth label: parity wiring inside the Rust loop (dev-bridge/test-provable). It does
/// NOT flip any TS-retirement state and is NOT a v1 GO.
/// `cancel` (C2-1) is the OPTIONAL cooperative cancellation handle, threaded VERBATIM into
/// the inner [`run_loop_with_policy`] (checked at each turn boundary). An `Interrupted`
/// outcome is treated EXACTLY like the other non-`Finished` terminals here: the `user`
/// turn is still appended (the operator asked it), but no `assistant` answer and no
/// owner-wired `run_result` (those are gated on `Finished`). `None` (every existing
/// caller) is byte-identical to the pre-C2-1 sessioned behavior.
/// `steer` (C2-2) is the OPTIONAL cooperative steer handle, threaded VERBATIM into the inner
/// [`run_loop_with_policy`] (drained at each turn boundary, folded into that turn's prompt). It
/// affects only the model's PROMPT for the steered turn — the session's persisted `user`/`assistant`
/// messages (the clean `task` and the loop's final answer) are unchanged, so the steer never
/// rewrites the durable session transcript. `None` (every existing caller) is byte-identical to the
/// pre-C2-2 sessioned behavior.
#[allow(clippy::too_many_arguments)]
pub fn run_session_loop(
    client: &dyn AgentLlmClient,
    executor: &dyn ToolExecutor,
    conn: &Connection,
    run_id: &str,
    session_id: &str,
    session_owner: Option<&friday_storage::SessionOwner>,
    task: &str,
    recall_preamble: &str,
    operator_vk: Option<&OperatorVerifyingKey>,
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    policy: &RunPolicy,
    max_turns: u64,
    cancel: Option<&CancelToken>,
    steer: Option<&SteerHandle>,
    now_ms: i64,
) -> Result<LoopOutcome, StorageError> {
    // 1. Ensure the session exists and LOAD its prior turns BEFORE persisting the
    //    current task (so the task is never folded into its own preamble). With a
    //    supplied owner the session is created OWNED (or a NULL axis backfilled);
    //    without one the owner-less ensure keeps the pre-wiring behavior bit-for-bit.
    match session_owner {
        Some(owner) => friday_storage::ensure_session_with_owner(conn, session_id, owner, now_ms)?,
        None => friday_storage::ensure_session(conn, session_id, now_ms)?,
    }
    let prior = friday_storage::load_session_messages(conn, session_id)?;

    // 2. Fold the BOUNDED prior-session history AHEAD of the recall preamble. The loop
    //    already builds `prompt_task = preamble + task`, so passing the combined
    //    preamble threads inbound history into the model WITHOUT any loop change.
    let session_preamble = render_session_history(&prior);
    let combined_preamble = format!("{session_preamble}{recall_preamble}");

    // 3. Run the SAME gate-mandatory loop (principal/scope/operator-key/cancel/steer aware).
    let outcome = run_loop_with_policy(
        client,
        executor,
        conn,
        run_id,
        task,
        &combined_preamble,
        operator_vk,
        approve,
        policy,
        max_turns,
        cancel,
        steer,
        now_ms,
    )?;

    // 4. Persist this run's turn(s) so the next run in the session resumes with them:
    //    the user task always, the assistant answer only when the loop finished with
    //    one. Bodies are Hub-side; the event below is refs-only.
    friday_storage::append_session_message(
        conn,
        session_id,
        &friday_storage::SessionMessage::new("user", task, Some(run_id.to_string())),
        now_ms,
    )?;
    if outcome.status == LoopStatus::Finished {
        if let Some(answer) = outcome.final_message.as_deref() {
            friday_storage::append_session_message(
                conn,
                session_id,
                &friday_storage::SessionMessage::new("assistant", answer, Some(run_id.to_string())),
                now_ms,
            )?;
        }
    }

    // 5. D1 OWNER-WIRING (the run_task #587 parity for the sessioned path): a FINISHED
    //    run produced a deliverable ANSWER; persist it Hub-side keyed by `run_id` with
    //    the run's BOUND OWNER principal recorded (`policy.principal_id()` — the SAME
    //    principal the gate Actor binds), so `get_run_answer_for_principal` releases the
    //    body ONLY to that owner. No bound principal ⇒ NO owner recorded ⇒ the body
    //    stays unreadable to everyone (fail-closed). Persist ONLY on `Finished` —
    //    `Paused` belongs to the resume completion leg, and the other outcomes carry no
    //    deliverable answer (mirrors `run_task`). A fresh `run_id` cannot already hold a
    //    result, so a persist conflict here signals a real bug and is propagated.
    if outcome.status == LoopStatus::Finished {
        let mut result = friday_storage::RunResult::new(
            "finished",
            outcome.final_message.clone().unwrap_or_default(),
            None,
        );
        if let Some(principal) = policy.principal_id() {
            result = result.with_owner_principal(principal);
        }
        friday_storage::persist_run_result(conn, run_id, &result, now_ms)?;
    }

    // Refs-only session outcome event: the session id + the new message COUNT, never
    // any message text (the refs-only / answer-body boundary; no secret/PII logged).
    let count = friday_storage::session_message_count(conn, session_id)?;
    agent_run::record_event(
        conn,
        &format!("{run_id}:session"),
        run_id,
        &format!("session.appended:{session_id}:count={count}"),
        now_ms,
    )?;

    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_storage::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_path(tag: &str) -> String {
        // Unique across runs AND processes: a fixed name would let a prior run's
        // leftover DB (with `r1` already created) collide on reopen — which is
        // exactly what `cargo test --workspace` (a second process after a prior
        // `-p` run) hit. pid + atomic counter make every path fresh.
        let dir = std::env::temp_dir();
        let pid = std::process::id();
        let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.join(format!("friday-hub-tracer-{pid}-{tag}-{n}-{nanos}.sqlite"))
            .to_string_lossy()
            .into_owned()
    }

    const SECRET: &[u8] = b"hub-signing-secret"; // pragma: allowlist secret

    fn read_only_proposal() -> RawToolCall {
        RawToolCall {
            action: "read_file".to_string(),
            params: vec![("path".to_string(), "notes.md".to_string())],
        }
    }

    fn delete_proposal() -> RawToolCall {
        RawToolCall {
            action: "delete_file".to_string(),
            params: vec![("path".to_string(), "backups/old.db".to_string())],
        }
    }

    #[test]
    fn canonical_params_is_order_independent_and_unambiguous() {
        let a = canonical_params(&[("b".into(), "2".into()), ("a".into(), "1".into())]);
        let b = canonical_params(&[("a".into(), "1".into()), ("b".into(), "2".into())]);
        assert_eq!(a, b, "param order must not change the canonical form");
        // Length-prefix prevents the classic ab|c vs a|bc boundary collision.
        let x = canonical_params(&[("ab".into(), "c".into())]);
        let y = canonical_params(&[("a".into(), "bc".into())]);
        assert_ne!(x, y);
    }

    #[test]
    fn read_only_turn_is_allowed_and_executed() {
        let db = Db::open_hub(&temp_path("ro")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read the notes file", 1).unwrap();
        let client = MockAgentLlmClient {
            proposal: read_only_proposal(),
        };
        let out = run_one_turn(
            &client,
            db.conn(),
            "r1",
            0,
            "read the notes file",
            SECRET,
            None,
            1000,
        )
        .unwrap();
        assert_eq!(out.decision, GateDecision::Allow);
        assert!(out.executed);
        // Two events recorded (plan + outcome), seq 1 and 2.
        let n: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run_event WHERE run_id='r1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn mutating_turn_without_approval_requires_approval_and_does_not_execute() {
        let db = Db::open_hub(&temp_path("noappr")).unwrap();
        agent_run::create_run(db.conn(), "r1", "delete the old backup db", 1).unwrap();
        let client = MockAgentLlmClient {
            proposal: delete_proposal(),
        };
        let out = run_one_turn(
            &client,
            db.conn(),
            "r1",
            0,
            "delete the old backup db",
            SECRET,
            None,
            1000,
        )
        .unwrap();
        assert_eq!(out.decision, GateDecision::RequiresApproval);
        assert!(!out.executed);
        // The destructive task escalated to a plan (MajorDecision), recorded.
        assert_eq!(out.plan_kind, Some("major_decision"));
    }

    #[test]
    fn mutating_turn_with_hub_minted_approval_executes_then_replay_is_refused() {
        let db = Db::open_hub(&temp_path("appr")).unwrap();
        agent_run::create_run(db.conn(), "r1", "delete the old backup db", 1).unwrap();
        let proposal = delete_proposal();
        let client = MockAgentLlmClient {
            proposal: proposal.clone(),
        };
        // Hub mints a signed approval bound to the EXACT request the turn will build.
        let request = build_request(&proposal).unwrap();
        let approval = mint_approval(&request, "ap-1", SECRET, 5000);

        // Turn 1 (turn_index 0): approval valid + unspent -> Allow + executed.
        let t1 = run_one_turn(
            &client,
            db.conn(),
            "r1",
            0,
            "delete the old backup db",
            SECRET,
            Some(&approval),
            1000,
        )
        .unwrap();
        assert_eq!(t1.decision, GateDecision::Allow);
        assert!(t1.executed);

        // Turn 2 (turn_index 1): same approval -> single-use replay refused (Deny),
        // not executed. Distinct turn_index keeps the event_ids collision-free.
        let t2 = run_one_turn(
            &client,
            db.conn(),
            "r1",
            1,
            "delete the old backup db",
            SECRET,
            Some(&approval),
            2000,
        )
        .unwrap();
        assert_eq!(t2.decision, GateDecision::Deny);
        assert_eq!(t2.reason, "canonical_approval_replay_refused");
        assert!(!t2.executed);
    }

    #[test]
    fn forged_unsigned_approval_does_not_execute() {
        // A mutating turn with an approval that has a matching digest but NO valid
        // signature must NOT execute (fail-closed through the composed path).
        let db = Db::open_hub(&temp_path("forge")).unwrap();
        agent_run::create_run(db.conn(), "r1", "delete the old backup db", 1).unwrap();
        let proposal = delete_proposal();
        let request = build_request(&proposal).unwrap();
        let mut forged = mint_approval(&request, "ap-x", SECRET, 5000);
        forged.signature = Some("0".repeat(64)); // wrong signature
        let client = MockAgentLlmClient { proposal };
        let out = run_one_turn(
            &client,
            db.conn(),
            "r1",
            0,
            "delete the old backup db",
            SECRET,
            Some(&forged),
            1000,
        )
        .unwrap();
        assert_eq!(out.decision, GateDecision::Deny);
        assert!(!out.executed);
    }

    #[test]
    fn model_cannot_assert_non_mutating_for_a_destructive_tool() {
        // The model can express only action + params (RawToolCall has NO mutating
        // field), and build_request derives `mutating` from the trusted registry. So a
        // destructive tool is ALWAYS mutating=true regardless of anything the model
        // says — the "this destructive action is non-mutating" bypass is unrepresentable
        // by type. This is the UNW-001-relevant property of the chokepoint.
        let request = build_request(&RawToolCall {
            action: "delete_file".to_string(),
            params: vec![("path".to_string(), "x".to_string())],
        })
        .unwrap();
        assert!(
            request.mutating(),
            "delete_file must classify mutating=true"
        );
        // The trusted non-mutating case (read_file) is the only way to mutating=false.
        let ro = build_request(&RawToolCall {
            action: "read_file".to_string(),
            params: vec![],
        })
        .unwrap();
        assert!(!ro.mutating());
    }

    #[test]
    fn run_command_param_drives_risk_escalation() {
        // mutating comes from the registry; risk is RAISED by what the params do. A
        // run_command whose command contains a shell metacharacter is Critical (via the
        // trusted shell-risk scanner), above the tool's High base — the params, not the
        // model, drive the classification.
        let c = trusted_classify(
            "run_command",
            &[("command".to_string(), "rm -rf / | sh".to_string())],
        )
        .unwrap();
        assert!(c.mutating());
        assert_eq!(c.risk(), Some(Risk::Critical));
    }

    #[test]
    fn unregistered_tool_is_refused_fail_closed() {
        // An action not in the trusted registry is refused at build_request and never
        // authorized or executed by the turn.
        let err = build_request(&RawToolCall {
            action: "frobnicate".to_string(),
            params: vec![],
        })
        .unwrap_err();
        assert_eq!(err, ToolError::UnknownTool("frobnicate".to_string()));

        let db = Db::open_hub(&temp_path("unreg")).unwrap();
        agent_run::create_run(db.conn(), "r1", "please frobnicate the thing", 1).unwrap();
        let client = MockAgentLlmClient {
            proposal: RawToolCall {
                action: "frobnicate".to_string(),
                params: vec![],
            },
        };
        let out = run_one_turn(
            &client,
            db.conn(),
            "r1",
            0,
            "please frobnicate the thing",
            SECRET,
            None,
            1000,
        )
        .unwrap();
        assert_eq!(out.decision, GateDecision::Deny);
        assert_eq!(out.reason, "unregistered_tool");
        assert!(!out.executed);
    }

    #[test]
    fn resource_selection_is_param_order_independent() {
        // Reviewer-B NIT: resource is chosen by fixed priority (path→target→file), not
        // input order, so reordering params can never change the derived resource/digest.
        let a = build_request(&RawToolCall {
            action: "write_file".to_string(),
            params: vec![
                ("path".to_string(), "p".to_string()),
                ("target".to_string(), "t".to_string()),
            ],
        })
        .unwrap();
        let b = build_request(&RawToolCall {
            action: "write_file".to_string(),
            params: vec![
                ("target".to_string(), "t".to_string()),
                ("path".to_string(), "p".to_string()),
            ],
        })
        .unwrap();
        assert_eq!(a.resource(), b.resource());
        assert_eq!(a.resource().unwrap().id, Some("p".to_string())); // `path` wins
    }

    // ── S4: per-run principal/scope/constraint awareness ──────────────────────

    /// Unique temp workspace dir for the gate-dispatch executor tests.
    fn temp_ws(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "friday-hub-s4-ws-{}-{}-{}",
            std::process::id(),
            tag,
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn build_request_binds_the_run_principal_into_the_digest() {
        // S6 PREREQUISITE: the SAME action for DIFFERENT principals yields DIFFERENT
        // canonical bytes (so a minted approval is bound to ONE principal), and the same
        // principal is deterministic. This is the principal→digest binding, proven here
        // (it is NOT visible in the refs-only bin output — the coordinator verifies it here).
        let raw = RawToolCall {
            action: "delete_file".to_string(),
            params: vec![("path".to_string(), "/data/x".to_string())],
        };
        let pol =
            |p: Option<&str>| RunPolicy::new(p.map(|s| s.to_string()), Vec::<String>::new(), false);
        let digest = |p: Option<&str>| {
            canonical_action_bytes(&build_request_with_policy(&raw, &pol(p)).unwrap())
        };
        let alice = digest(Some("alice"));
        let bob = digest(Some("bob"));
        let none = digest(None);
        assert_ne!(
            alice, bob,
            "different principals must produce different digests"
        );
        assert_ne!(
            alice, none,
            "a bound principal must differ from the unbound default"
        );
        assert_ne!(bob, none);
        // Deterministic for the same principal (an approval minted for alice re-matches).
        assert_eq!(alice, digest(Some("alice")));
        // The default policy reproduces the legacy `build_request` (no principal bound).
        assert_eq!(none, canonical_action_bytes(&build_request(&raw).unwrap()));
    }

    #[test]
    fn bound_principal_rule_holds_even_with_a_principal_bound() {
        use friday_core::gate::{classify, evaluate, Actor};
        // S4 records WHO the run is for; it does NOT grant approval. An Agent actor WITH a
        // bound principal (exactly the actor build_request_with_policy makes) attempting a
        // reserved approval action is STILL a hard Deny — the bound-principal rule is intact.
        let req = MutatingActionRequest::from_classification(
            classify(false, Risk::ReadOnly, "approve", &[]),
            "approve".to_string(),
            Actor {
                kind: ActorKind::Agent,
                id: "hub-agent".to_string(),
                principal_id: Some("alice".to_string()),
            },
            "agent".to_string(),
            vec![],
            None,
            None,
            None,
        );
        let r = evaluate(&req);
        assert_eq!(r.decision, GateDecision::Deny);
        assert_eq!(r.reason, "agent_cannot_execute_reserved_approval_action");
        // And the request the loop ACTUALLY builds (a registered tool) stays Agent-kind with
        // the principal recorded — so the rule above applies to every loop-built request.
        let built = build_request_with_policy(
            &RawToolCall {
                action: "write_file".to_string(),
                params: vec![
                    ("path".to_string(), "x".to_string()),
                    ("content".to_string(), "y".to_string()),
                ],
            },
            &RunPolicy::new(Some("alice".to_string()), Vec::<String>::new(), false),
        )
        .unwrap();
        assert_eq!(built.actor.kind, ActorKind::Agent);
        assert_eq!(built.actor.principal_id.as_deref(), Some("alice"));
    }

    #[test]
    fn gate_dispatch_blocks_a_disabled_tool_before_execution() {
        let db = Db::open_hub(&temp_path("s4-disabled")).unwrap();
        let ws = temp_ws("s4-disabled");
        std::fs::write(ws.join("notes.md"), b"do-not-read").unwrap();
        let fs = FsToolExecutor::new(ws.clone());
        let exec = CountingExecutor {
            inner: &fs,
            calls: std::cell::Cell::new(0),
        };
        let approve = no_approval();
        let raw = read_only_proposal(); // read_file notes.md (read-only → Allow by default)

        // CONTROL: NOT disabled → executes (read-only Allow), executor reached exactly once.
        let ctrl = gate_dispatch_with_policy(
            db.conn(),
            &exec,
            &raw,
            AuthzMode::DenyAll, // read_file is base-Allow (read-only); authz irrelevant
            &approve,
            &RunPolicy::default(),
            1,
        )
        .unwrap();
        assert!(matches!(ctrl, GateDispatch::Executed(_)));
        assert_eq!(exec.calls.get(), 1);

        // DISABLED: read_file disabled for this run → Denied BEFORE execution; the executor
        // is NOT reached again (the count stays 1).
        let policy = RunPolicy::new(None, ["read_file".to_string()], false);
        let blocked = gate_dispatch_with_policy(
            db.conn(),
            &exec,
            &raw,
            AuthzMode::DenyAll,
            &approve,
            &policy,
            1,
        )
        .unwrap();
        if let GateDispatch::Denied(reason) = blocked {
            assert_eq!(reason, "tool_disabled_for_run:read_file");
        } else {
            panic!("a disabled tool must be Denied");
        }
        assert_eq!(
            exec.calls.get(),
            1,
            "the disabled tool must not reach the executor"
        );
    }

    #[test]
    fn read_only_run_blocks_a_mutating_tool_and_deny_all_still_pauses() {
        let db = Db::open_hub(&temp_path("s4-ro")).unwrap();
        let ws = temp_ws("s4-ro");
        let fs = FsToolExecutor::new(ws.clone());
        let exec = CountingExecutor {
            inner: &fs,
            calls: std::cell::Cell::new(0),
        };
        let approve = no_approval();
        let write = RawToolCall {
            action: "write_file".to_string(),
            params: vec![
                ("path".to_string(), "out.txt".to_string()),
                ("content".to_string(), "X".to_string()),
            ],
        };

        // read_only run → the mutating write is Denied BEFORE execution (stricter than the
        // gate's default Pause); the executor is never reached and no file is created.
        let policy = RunPolicy::new(None, Vec::<String>::new(), true);
        let ro = gate_dispatch_with_policy(
            db.conn(),
            &exec,
            &write,
            AuthzMode::DenyAll,
            &approve,
            &policy,
            1,
        )
        .unwrap();
        if let GateDispatch::Denied(reason) = ro {
            assert_eq!(reason, "run_is_read_only:write_file");
        } else {
            panic!("a mutating tool under a read_only run must be Denied");
        }
        assert_eq!(exec.calls.get(), 0);
        assert!(
            !ws.join("out.txt").exists(),
            "no file written under read_only"
        );

        // CONTROL (deny-all, NOT read_only): the SAME mutating write still PAUSES
        // (RequiresApproval) — the gate's fail-safe default is unchanged; read_only is what
        // upgrades that Pause to a hard block.
        let pause = gate_dispatch_with_policy(
            db.conn(),
            &exec,
            &write,
            AuthzMode::DenyAll, // deny-all (no operator key) ⇒ the mutating write Pauses
            &approve,
            &RunPolicy::default(),
            1,
        )
        .unwrap();
        assert!(matches!(pause, GateDispatch::RequiresApproval));
        assert_eq!(
            exec.calls.get(),
            0,
            "a paused mutating action never executes"
        );
    }

    // ── NS-1: AgentActionContext plumbed to the gate-dispatch chokepoint ──────
    // PURE PLUMBING. These prove (1) attaching a context changes NO gate decision at the
    // chokepoint (byte-identical to the same policy without a context) AND through a REAL
    // run loop (real FsToolExecutor) for Allow / Pause / Deny, and (2) the context
    // round-trips through the thin accessor + survives `tightened_by`. NO trust call (NS-2).

    /// A fully-populated context to attach — every `AgentActionContext` dimension set, so a
    /// regression that drops/garbles any field is caught by the round-trip assert.
    fn ns1_full_ctx() -> friday_storage::AgentActionContext {
        friday_storage::AgentActionContext {
            agent_id: "agent-ns1".to_string(),
            workspace: Some("ws-ns1".to_string()),
            tool: Some("read_file".to_string()),
            provider: Some("deepseek".to_string()),
            channel: Some("telegram".to_string()),
            workflow_family: Some("triage".to_string()),
            skill_family: Some("research".to_string()),
        }
    }

    #[test]
    fn ns1_context_round_trips_through_accessor_and_tightening() {
        // (2) The accessor reads back EXACTLY what was attached.
        let ctx = ns1_full_ctx();
        let policy = RunPolicy::new(Some("alice".to_string()), Vec::<String>::new(), false)
            .with_action_context(ctx.clone());
        assert_eq!(
            policy.action_context(),
            Some(&ctx),
            "the accessor must return the attached context verbatim"
        );
        // The plumbing does not disturb the existing identity/restriction fields.
        assert_eq!(policy.principal_id(), Some("alice"));
        assert!(!policy.is_read_only());

        // Default / `new` carry NO context (every pre-NS-1 caller is unchanged).
        assert_eq!(RunPolicy::default().action_context(), None);
        assert_eq!(
            RunPolicy::new(None, Vec::<String>::new(), false).action_context(),
            None
        );

        // A tightening constraint restricts WHAT, never the context (carried verbatim, same
        // rule as `principal_id`), and never widens read-only/disabled.
        let tightened = policy.tightened_by(true, &["delete_file".to_string()]);
        assert_eq!(
            tightened.action_context(),
            Some(&ctx),
            "tightening must preserve the action context verbatim"
        );
        assert_eq!(tightened.principal_id(), Some("alice"));
        assert!(tightened.is_read_only(), "tightening added read_only");
        assert!(tightened.is_tool_disabled("delete_file"));
    }

    #[test]
    fn ns1_chokepoint_gate_decisions_byte_identical_with_or_without_context() {
        // (1) At the SHARED chokepoint `gate_dispatch_with_policy`, run the THREE canonical
        // scenarios (read→Allow, mutating→Pause, read-only→Deny) TWICE — once with a baseline
        // policy, once with the SAME policy + a populated action context — and assert the
        // outcomes are IDENTICAL. This directly shows the carried context is inert at the gate.
        let db = Db::open_hub(&temp_path("ns1-choke")).unwrap();
        let ws = temp_ws("ns1-choke");
        std::fs::write(ws.join("notes.md"), b"hello").unwrap();
        let fs = FsToolExecutor::new(ws.clone());
        let approve = no_approval();

        // Compare a gate-dispatch outcome to a label, so the two policies' results compare cheaply.
        let label = |d: &GateDispatch| -> String {
            match d {
                GateDispatch::Executed(_) => "executed".to_string(),
                GateDispatch::RequiresApproval => "requires_approval".to_string(),
                GateDispatch::Denied(r) => format!("denied:{r}"),
                GateDispatch::Unregistered(a) => format!("unregistered:{a}"),
                GateDispatch::ExecError(_) => "exec_error".to_string(),
            }
        };

        // The baseline (no context) and the context-populated variant of the SAME policy.
        let dispatch = |policy: &RunPolicy, raw: &RawToolCall| -> String {
            // Fresh counting executor per call so an "executed" never double-mutates the ws.
            let exec = CountingExecutor {
                inner: &fs,
                calls: std::cell::Cell::new(0),
            };
            let out = gate_dispatch_with_policy(
                db.conn(),
                &exec,
                raw,
                AuthzMode::DenyAll,
                &approve,
                policy,
                1000,
            )
            .unwrap();
            label(&out)
        };

        // (a) read tool → Allow (default policy, no read-only). (b) mutating tool under the
        // SAME (non-read-only) policy → RequiresApproval/Pause. (c) the SAME mutating tool
        // under a read-only policy → hard Deny.
        let read = read_only_proposal();
        let write = raw("write_file", &[("path", "out.txt"), ("content", "X")]);

        let base_open = RunPolicy::new(Some("alice".to_string()), Vec::<String>::new(), false);
        let ctx_open = base_open.clone().with_action_context(ns1_full_ctx());
        let base_ro = RunPolicy::new(Some("alice".to_string()), Vec::<String>::new(), true);
        let ctx_ro = base_ro.clone().with_action_context(ns1_full_ctx());

        // (a) Allow
        assert_eq!(dispatch(&base_open, &read), "executed");
        assert_eq!(
            dispatch(&base_open, &read),
            dispatch(&ctx_open, &read),
            "(a) read→Allow must be byte-identical with/without context"
        );
        // (b) RequiresApproval / Pause
        assert_eq!(dispatch(&base_open, &write), "requires_approval");
        assert_eq!(
            dispatch(&base_open, &write),
            dispatch(&ctx_open, &write),
            "(b) mutating→Pause must be byte-identical with/without context"
        );
        // (c) Deny
        assert_eq!(
            dispatch(&base_ro, &write),
            "denied:run_is_read_only:write_file"
        );
        assert_eq!(
            dispatch(&base_ro, &write),
            dispatch(&ctx_ro, &write),
            "(c) read-only→Deny must be byte-identical with/without context"
        );
    }

    #[test]
    fn ns1_run_loop_decisions_byte_identical_with_or_without_context() {
        // (1, loop) Drive a REAL run through `run_loop_with_policy` with the REAL
        // FsToolExecutor for each of Allow / Pause / Deny, comparing the default policy to
        // the SAME policy + a populated action context. The loop OUTCOME (status + executed
        // count + the file-system side effect) must be identical — the carried context never
        // touches the gate.
        let scenario =
            |tag: &str, raw_step: RawToolCall, policy: &RunPolicy| -> (LoopStatus, u64, bool) {
                let root = TempDir::new(tag);
                std::fs::write(root.0.join("notes.md"), b"answer is 47").unwrap();
                let db = Db::open_hub(&temp_path(tag)).unwrap();
                agent_run::create_run(db.conn(), "r1", "do it", 1).unwrap();
                let client = ScriptedAgentLlmClient::new(vec![AgentStep::Tool(raw_step)]);
                let executor = FsToolExecutor::new(&root.0);
                let out = run_loop_with_policy(
                    &client,
                    &executor,
                    db.conn(),
                    "r1",
                    "do it",
                    "",
                    None, // unprovisioned ⇒ fail-closed Pause for mutating actions
                    &no_approval(),
                    policy,
                    5,
                    None,
                    None,
                    1000,
                )
                .unwrap();
                // The write side effect (created or not) is part of the observable outcome.
                let wrote = root.0.join("out.txt").exists();
                (out.status, out.executed_tools, wrote)
            };

        let read = read_only_proposal();
        let write = raw("write_file", &[("path", "out.txt"), ("content", "X")]);

        // (a) read → Allow (open policy). (b) mutating → Pause (open policy, no operator key).
        // (c) mutating under read-only policy → Deny/Blocked.
        let open = RunPolicy::new(Some("alice".to_string()), Vec::<String>::new(), false);
        let open_ctx = open.clone().with_action_context(ns1_full_ctx());
        let ro = RunPolicy::new(Some("alice".to_string()), Vec::<String>::new(), true);
        let ro_ctx = ro.clone().with_action_context(ns1_full_ctx());

        // (a) Allow: the read executes; identical with/without context.
        let a_base = scenario("ns1-loop-a-base", read.clone(), &open);
        let a_ctx = scenario("ns1-loop-a-ctx", read.clone(), &open_ctx);
        assert_eq!(a_base.0, LoopStatus::Finished, "read loop finishes");
        assert_eq!(a_base.1, 1, "the read tool executed once");
        assert_eq!(a_base, a_ctx, "(a) Allow loop outcome unchanged by context");

        // (b) Pause: the mutating write Pauses, never executes; identical with/without context.
        let b_base = scenario("ns1-loop-b-base", write.clone(), &open);
        let b_ctx = scenario("ns1-loop-b-ctx", write.clone(), &open_ctx);
        assert_eq!(b_base.0, LoopStatus::Paused, "mutating write Pauses");
        assert_eq!(b_base.1, 0, "a paused write never executes");
        assert!(!b_base.2, "no file written on Pause");
        assert_eq!(b_base, b_ctx, "(b) Pause loop outcome unchanged by context");

        // (c) Deny: read-only run Blocks the write before execution; identical with/without context.
        let c_base = scenario("ns1-loop-c-base", write.clone(), &ro);
        let c_ctx = scenario("ns1-loop-c-ctx", write.clone(), &ro_ctx);
        assert_eq!(
            c_base.0,
            LoopStatus::Blocked,
            "read-only run Blocks the write"
        );
        assert_eq!(c_base.1, 0, "a denied write never executes");
        assert!(!c_base.2, "no file written on Deny");
        assert_eq!(c_base, c_ctx, "(c) Deny loop outcome unchanged by context");
    }

    // --- §5-PR2: prompt + strict parse (offline) ---

    #[test]
    fn build_tool_prompt_lists_tools_and_the_json_contract() {
        let p = build_tool_prompt("read notes.md");
        assert!(p.contains("read_file"));
        assert!(p.contains("delete_file"));
        assert!(p.contains("\"tool\""));
        assert!(p.contains("\"parameters\""));
        // The finish contract advertises the answer-carrying shape (Fix 2).
        assert!(p.contains("\"answer\""));
        assert!(p.contains("read notes.md")); // the task is included

        // S3-wiring: every newly wired fs tool is advertised to the model (the prompt menu
        // is derived from the SAME registry the executor + gate use), so the model is told
        // the new tools — and their params — exist.
        for tool in [
            "list_dir",
            "stat_file",
            "append_file",
            "edit_file",
            "move_file",
        ] {
            assert!(p.contains(tool), "prompt must advertise {tool}, got: {p}");
        }
        // edit_file's params are spelled out so the model emits the right keys.
        assert!(p.contains("old_text") && p.contains("new_text"));
    }

    #[test]
    fn parse_accepts_a_single_json_object() {
        let r =
            parse_tool_call("{\"tool\":\"read_file\",\"parameters\":{\"path\":\"a.md\"}}").unwrap();
        assert_eq!(r.action, "read_file");
        assert_eq!(r.params, vec![("path".to_string(), "a.md".to_string())]);
    }

    #[test]
    fn parse_tolerates_a_code_fence() {
        let fenced = "```json\n{\"tool\":\"list_dir\",\"parameters\":{\"path\":\"/x\"}}\n```";
        let r = parse_tool_call(fenced).unwrap();
        assert_eq!(r.action, "list_dir");
        assert_eq!(r.params, vec![("path".to_string(), "/x".to_string())]);
        // bare fence (no language tag) too
        let bare = "```\n{\"tool\":\"none\"}\n```";
        assert_eq!(parse_tool_call(bare).unwrap().action, "none");
    }

    #[test]
    fn parse_accepts_no_parameters() {
        let r = parse_tool_call("{\"tool\":\"none\"}").unwrap();
        assert_eq!(r.action, "none");
        assert!(r.params.is_empty());
    }

    #[test]
    fn parse_fails_closed_on_contract_violations() {
        // Prose before/after the object, multiple objects, non-object, missing/wrong-typed
        // fields — every one is a parse error, never a best-effort partial match.
        for bad in [
            "Sure! {\"tool\":\"read_file\"}",            // leading prose
            "{\"tool\":\"read_file\"} now run it",       // trailing prose
            "{\"tool\":\"a\"}{\"tool\":\"b\"}",          // two objects
            "[\"read_file\"]",                           // array, not object
            "\"read_file\"",                             // bare string
            "42",                                        // number
            "{\"parameters\":{}}",                       // missing `tool`
            "{\"tool\":42}",                             // non-string tool
            "{\"tool\":\"x\",\"parameters\":{\"k\":1}}", // non-string param value
            "{\"tool\":\"x\",\"parameters\":[]}",        // parameters not an object
            "",                                          // empty
            "not json at all",
        ] {
            assert!(
                matches!(parse_tool_call(bad), Err(AgentError::Parse(_))),
                "must fail-closed on: {bad:?}"
            );
        }
    }

    #[test]
    fn parse_agent_step_finish_carries_the_answer() {
        // The finish contract `{"tool":"none","answer":"<text>"}` lifts the model's final
        // natural-language answer into `Finish.message` (Fix 2 — the loop's `final_message`
        // is no longer always empty on success).
        let step =
            parse_agent_step("{\"tool\":\"none\",\"answer\":\"all done: 3 files read\"}").unwrap();
        assert_eq!(
            step,
            AgentStep::Finish {
                message: "all done: 3 files read".to_string()
            }
        );
        // A code-fenced finish object is tolerated too (same as tool calls).
        let fenced =
            parse_agent_step("```json\n{\"tool\":\"none\",\"answer\":\"ok\"}\n```").unwrap();
        assert_eq!(
            fenced,
            AgentStep::Finish {
                message: "ok".to_string()
            }
        );
    }

    #[test]
    fn parse_agent_step_finish_is_robust_to_missing_or_nonstring_answer() {
        // ROBUST: a finish object missing `answer`, or whose `answer` is non-string, still
        // parses to a `Finish` with an EMPTY message — never a panic, never a parse error.
        for c in [
            "{\"tool\":\"none\"}",                 // no answer field (old contract shape)
            "{\"tool\":\"none\",\"answer\":42}",   // non-string answer
            "{\"tool\":\"none\",\"answer\":null}", // null answer
        ] {
            assert_eq!(
                parse_agent_step(c).unwrap(),
                AgentStep::Finish {
                    message: String::new()
                },
                "must parse to an empty-message Finish: {c:?}"
            );
        }
    }

    #[test]
    fn parse_agent_step_tool_branch_is_unchanged() {
        // A non-`none` tool call is still a `Tool` step (the answer extraction touches only
        // the finish branch); an `answer` field on a tool call is ignored, not an error.
        let step = parse_agent_step("{\"tool\":\"read_file\",\"parameters\":{\"path\":\"a.md\"}}")
            .unwrap();
        assert_eq!(
            step,
            AgentStep::Tool(RawToolCall {
                action: "read_file".to_string(),
                params: vec![("path".to_string(), "a.md".to_string())],
            })
        );
        // Contract violations still fail-closed through `parse_agent_step`.
        assert!(matches!(
            parse_agent_step("Sure! {\"tool\":\"none\"}"),
            Err(AgentError::Parse(_))
        ));
    }

    #[test]
    fn parsed_call_flows_through_the_trusted_chokepoint() {
        // A parsed destructive call is still classified mutating by the registry — the
        // parse layer feeds the same chokepoint, it does not bypass it.
        let raw =
            parse_tool_call("{\"tool\":\"delete_file\",\"parameters\":{\"path\":\"x\"}}").unwrap();
        assert!(build_request(&raw).unwrap().mutating());
        // An unregistered parsed tool is still refused.
        let unk = parse_tool_call("{\"tool\":\"frobnicate\"}").unwrap();
        assert!(matches!(
            build_request(&unk),
            Err(ToolError::UnknownTool(_))
        ));
    }

    /// LIVE evidence (runtime-proven). Ignored in CI (no `FRIDAY_DEEPSEEK_API_KEY`
    /// there); run manually with the Hub key sourced into the env. Proves a real
    /// DeepSeek reply parses into a RawToolCall that flows through the trusted
    /// chokepoint. fallback=false (discover→select→chat). Never prints the key.
    #[test]
    #[ignore = "live: requires FRIDAY_DEEPSEEK_API_KEY; run manually (see ledger)"]
    fn live_deepseek_proposes_a_parseable_tool_call() {
        let client = friday_deepseek::DeepSeekClient::from_env()
            .expect("FRIDAY_DEEPSEEK_API_KEY must be set");
        let agent = DeepSeekAgentLlmClient::new(client);
        let raw = agent
            .propose_tool_call("read the file notes.md and summarize it")
            .expect("live propose_tool_call");
        assert!(!raw.action.is_empty());
        // It must flow through the trusted chokepoint without panic (Ok or UnknownTool).
        let _ = build_request(&raw);
        eprintln!(
            "LIVE proposed tool call: action={:?} params={:?}",
            raw.action, raw.params
        );
    }

    /// A client that always fails — to exercise `run_one_turn`'s fail-closed `Err`
    /// branch (Reviewer-A CONCERNS: the headline "the seam is now fallible" behavior
    /// was otherwise inspection-only).
    struct ErrAgentLlmClient(AgentError);
    impl AgentLlmClient for ErrAgentLlmClient {
        fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
            Err(self.0.clone())
        }
    }

    #[test]
    fn agent_error_fails_closed_to_deny_and_records_event() {
        let db = Db::open_hub(&temp_path("agenterr")).unwrap();
        agent_run::create_run(db.conn(), "r1", "do something", 1).unwrap();
        let client = ErrAgentLlmClient(AgentError::Model("network down".to_string()));
        let out = run_one_turn(
            &client,
            db.conn(),
            "r1",
            0,
            "do something",
            SECRET,
            None,
            1000,
        )
        .unwrap();
        // Fail-closed: never executes, never Allow.
        assert_eq!(out.decision, GateDecision::Deny);
        assert!(!out.executed);
        assert!(
            out.reason.starts_with("agent_error:"),
            "reason was {:?}",
            out.reason
        );
        // The plan event is recorded FIRST (on the task), then the agent.error outcome.
        let n: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run_event WHERE run_id='r1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2, "plan + agent.error outcome events");
        let kind: String = db
            .conn()
            .query_row(
                "SELECT kind FROM agent_run_event WHERE event_id='r1:t0:outcome'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            kind.starts_with("agent.error:"),
            "outcome kind was {kind:?}"
        );
    }

    // --- §5-PR3: real ToolExecutor over friday-fs, gate mandatory before dispatch ---

    /// A unique temp directory (workspace root for the executor), removed on drop.
    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            static C: AtomicU64 = AtomicU64::new(0);
            let mut p = std::env::temp_dir();
            p.push(format!(
                "friday-hub-exec-{}-{}-{}",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn raw(action: &str, params: &[(&str, &str)]) -> RawToolCall {
        RawToolCall {
            action: action.to_string(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn read_file_executes_on_allow_via_real_fs_with_audit_receipt() {
        let root = TempDir::new("read");
        std::fs::write(root.0.join("notes.md"), b"hello from disk").unwrap();
        let db = Db::open_hub(&temp_path("exec-read")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read notes.md", 1).unwrap();
        let client = MockAgentLlmClient {
            proposal: raw("read_file", &[("path", "notes.md")]),
        };
        let executor = FsToolExecutor::new(&root.0);
        let out = run_one_turn_with_executor(
            &client,
            &executor,
            db.conn(),
            "r1",
            0,
            "read notes.md",
            SECRET,
            None,
            1000,
        )
        .unwrap();
        assert_eq!(out.decision, GateDecision::Allow);
        assert!(out.executed, "read_file is non-mutating → Allow → executes");
        // The outcome event names a real byte count, and a hash-chained audit receipt exists + verifies.
        let kind: String = db
            .conn()
            .query_row(
                "SELECT kind FROM agent_run_event WHERE event_id='r1:t0:outcome'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            kind.contains("read 15 bytes from notes.md"),
            "outcome was {kind:?}"
        );
        let receipts: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE audit_id='r1:t0:receipt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(receipts, 1, "one hash-chained audit receipt");
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    #[test]
    fn write_file_executes_and_reads_back_via_real_fs() {
        let root = TempDir::new("write");
        let db = Db::open_hub(&temp_path("exec-write")).unwrap();
        agent_run::create_run(db.conn(), "r1", "write out.txt", 1).unwrap();
        // write_file is mutating → needs an approval to reach Allow. Mint one over the
        // exact request the turn will build.
        let proposal = raw(
            "write_file",
            &[("path", "out.txt"), ("content", "written by friday")],
        );
        let request = build_request(&proposal).unwrap();
        let approval = mint_approval(&request, "ap-w", SECRET, 5000);
        let client = MockAgentLlmClient { proposal };
        let executor = FsToolExecutor::new(&root.0);
        let out = run_one_turn_with_executor(
            &client,
            &executor,
            db.conn(),
            "r1",
            0,
            "write out.txt",
            SECRET,
            Some(&approval),
            1000,
        )
        .unwrap();
        assert_eq!(out.decision, GateDecision::Allow);
        assert!(out.executed);
        // The bytes really landed on disk inside the root.
        assert_eq!(
            std::fs::read_to_string(root.0.join("out.txt")).unwrap(),
            "written by friday"
        );
    }

    #[test]
    fn mutating_without_approval_never_reaches_the_executor() {
        let root = TempDir::new("noappr");
        let db = Db::open_hub(&temp_path("exec-noappr")).unwrap();
        agent_run::create_run(db.conn(), "r1", "write secret.txt", 1).unwrap();
        let client = MockAgentLlmClient {
            proposal: raw("write_file", &[("path", "secret.txt"), ("content", "X")]),
        };
        let executor = FsToolExecutor::new(&root.0);
        // No approval → mutating write → RequiresApproval → executor NEVER invoked.
        let out = run_one_turn_with_executor(
            &client,
            &executor,
            db.conn(),
            "r1",
            0,
            "write secret.txt",
            SECRET,
            None,
            1000,
        )
        .unwrap();
        assert_eq!(out.decision, GateDecision::RequiresApproval);
        assert!(!out.executed);
        // The gate-before-dispatch property: NO file was written (the executor was not reached).
        assert!(
            !root.0.join("secret.txt").exists(),
            "gate must block dispatch — no file written"
        );
    }

    #[test]
    fn read_tool_exec_error_after_allow_records_failed_receipt() {
        let root = TempDir::new("execerr");
        let db = Db::open_hub(&temp_path("exec-execerr")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read a missing file", 1).unwrap();
        // A read-only tool (read_file) is gate-Allowed, reaches the executor, then FAILS at
        // execution because the named file does not exist (the root exists → resolve_within_root
        // succeeds → open ENOENT → FsError::NotFound → ExecError::Fs). This exercises the
        // gate-Allowed-but-exec-FAILED path: an exec_error is recorded AND a hash-chained
        // exec_failed audit receipt is written atomically with it, and the chain still verifies.
        // (search is now WIRED and would succeed, so it is no longer the exec-failure example.)
        let client = MockAgentLlmClient {
            proposal: raw("read_file", &[("path", "does-not-exist.txt")]),
        };
        let executor = FsToolExecutor::new(&root.0);
        let out = run_one_turn_with_executor(
            &client,
            &executor,
            db.conn(),
            "r1",
            0,
            "list the dir",
            SECRET,
            None,
            1000,
        )
        .unwrap();
        assert_eq!(out.decision, GateDecision::Allow);
        assert!(!out.executed, "the exec failure did not complete");
        assert!(
            out.reason.starts_with("exec_error:") && out.reason.contains("fs_error"),
            "expected an fs exec_error, reason was {:?}",
            out.reason
        );
        // #30: the gate-Allowed-but-failed dispatch records a hash-chained exec_failed
        // receipt (atomic with the error event), and the chain still verifies.
        let failed: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE audit_id='r1:t0:receipt' AND action LIKE 'tool.exec_failed:%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(failed, 1, "an exec_failed audit receipt was recorded");
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    #[test]
    fn executor_read_outside_root_is_refused_by_friday_fs() {
        let root = TempDir::new("escape");
        let executor = FsToolExecutor::new(&root.0);
        // A traversal path is refused by the hardened safe-open, surfaced as ExecError::Fs.
        let err = executor
            .execute(
                "read_file",
                &[("path".to_string(), "../../etc/passwd".to_string())],
            )
            .unwrap_err();
        assert!(
            matches!(err, ExecError::Fs(_)),
            "expected Fs containment error, got {err:?}"
        );
    }

    /// S3-wiring: the read-type tools just wired (`list_dir`, `stat_file`) execute via real
    /// friday-fs and set [`ToolReceipt::content`] with their result, so the loop can feed it
    /// back to the model (the read_file grounding contract, extended to the new read tools).
    /// The `summary` (which reaches the audit ledger) carries a count/metadata line only —
    /// the entry NAMES live in `content`, which never reaches the ledger.
    #[test]
    fn list_dir_and_stat_file_execute_and_carry_content_in_receipt() {
        let root = TempDir::new("readtype");
        std::fs::create_dir(root.0.join("sub")).unwrap();
        std::fs::write(root.0.join("sub/alpha.txt"), b"a").unwrap();
        std::fs::write(root.0.join("sub/beta.txt"), b"bb").unwrap();
        let executor = FsToolExecutor::new(&root.0);

        // list_dir → sorted entry names in `content`; summary is a count only (ledger-safe).
        let r = executor
            .execute("list_dir", &[("path".to_string(), "sub".to_string())])
            .unwrap();
        assert_eq!(r.action, "list_dir");
        assert_eq!(r.summary, "listed 2 entries in sub");
        let content = r.content.expect("list_dir is read-type → content set");
        assert_eq!(content, "alpha.txt\nbeta.txt");
        assert!(
            !r.summary.contains("alpha.txt"),
            "entry names must NOT be in the ledger summary, only in content"
        );

        // stat_file → metadata line in `content` (read-type ⇒ content set).
        let s = executor
            .execute(
                "stat_file",
                &[("path".to_string(), "sub/beta.txt".to_string())],
            )
            .unwrap();
        assert_eq!(s.action, "stat_file");
        let scontent = s.content.expect("stat_file is read-type → content set");
        assert!(
            scontent.contains("sub/beta.txt: file, 2 bytes"),
            "stat content was {scontent:?}"
        );
    }

    /// `search` wiring (this slice): a direct execute returns the matching lines in `content`
    /// (model-facing, `relpath:line:text`) and a COUNT-ONLY `summary` — the matched text never
    /// enters the ledger summary, mirroring list_dir/read_file. Containment is honored by the
    /// underlying friday-fs primitive (proven exhaustively in friday-fs/tests/search_fs.rs).
    #[test]
    fn search_arm_executes_and_carries_matches_in_content_with_count_summary() {
        let root = TempDir::new("search-arm");
        std::fs::create_dir(root.0.join("sub")).unwrap();
        std::fs::write(root.0.join("a.txt"), b"alpha needle one\nbeta\n").unwrap();
        std::fs::write(
            root.0.join("sub/b.txt"),
            b"no match here\nanother needle line\n",
        )
        .unwrap();
        let executor = FsToolExecutor::new(&root.0);

        let r = executor
            .execute("search", &[("query".to_string(), "needle".to_string())])
            .unwrap();
        assert_eq!(r.action, "search");
        // summary is a COUNT ONLY (ledger-safe) — never the matched line text.
        assert_eq!(r.summary, "search matched 2 line(s)");
        assert!(
            !r.summary.contains("needle"),
            "matched text must NOT be in the ledger summary, only in content"
        );
        let content = r.content.expect("search is read-type → content set");
        // Deterministic (sorted by relative_path, then line): a.txt before sub/b.txt.
        assert_eq!(
            content,
            "a.txt:1:alpha needle one\nsub/b.txt:2:another needle line"
        );

        // A query with no matches → empty content, zero count (still a clean read-type receipt).
        let none = executor
            .execute("search", &[("query".to_string(), "zzz-absent".to_string())])
            .unwrap();
        assert_eq!(none.summary, "search matched 0 line(s)");
        assert_eq!(none.content.as_deref(), Some(""));

        // Optional `path` scopes the search to a contained sub-directory.
        let scoped = executor
            .execute(
                "search",
                &[
                    ("query".to_string(), "needle".to_string()),
                    ("path".to_string(), "sub".to_string()),
                ],
            )
            .unwrap();
        assert_eq!(scoped.summary, "search matched 1 line(s)");
        assert_eq!(
            scoped.content.as_deref(),
            Some("sub/b.txt:2:another needle line")
        );
    }

    /// `search` is registered non-mutating + read-only, so it reaches the gate as `Allow` AND
    /// now EXECUTES (the wiring this slice adds) — proven through the FULL turn loop, not just a
    /// direct call. (This replaces the prior `search`-as-Unsupported coverage now that it runs.)
    #[test]
    fn search_through_loop_is_allowed_and_executes() {
        let root = TempDir::new("search-loop");
        std::fs::write(root.0.join("notes.txt"), b"todo: needle here\n").unwrap();
        let db = Db::open_hub(&temp_path("exec-search-loop")).unwrap();
        agent_run::create_run(db.conn(), "r1", "search the workspace", 1).unwrap();
        let client = MockAgentLlmClient {
            proposal: raw("search", &[("query", "needle")]),
        };
        let executor = FsToolExecutor::new(&root.0);
        let out = run_one_turn_with_executor(
            &client,
            &executor,
            db.conn(),
            "r1",
            0,
            "search the workspace",
            SECRET,
            None,
            1000,
        )
        .unwrap();
        assert_eq!(
            out.decision,
            GateDecision::Allow,
            "search is read-only → Allow"
        );
        assert!(
            out.executed,
            "search is wired → it executes (no longer Unsupported)"
        );
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    /// The executor's fall-through `other =>` arm still fails closed for a genuinely-unknown
    /// action. (run_command USED to be the only direct coverage of this arm; now that it is wired,
    /// a bogus action exercises the fail-closed catch-all. Loop-level coverage of unregistered
    /// tools is `unregistered_tool_is_refused_fail_closed`; this is the executor-arm unit.)
    #[test]
    fn executor_unknown_action_is_unsupported() {
        let root = TempDir::new("unsup-unknown");
        let executor = FsToolExecutor::new(&root.0);
        let err = executor.execute("definitely_not_a_tool", &[]).unwrap_err();
        assert!(
            matches!(err, ExecError::Unsupported(ref a) if a == "definitely_not_a_tool"),
            "an unknown action must be Unsupported, got {err:?}"
        );
    }

    /// run_command is NOW WIRED: a DIRECT execute (bypassing the gate — a legitimate unit test of
    /// the arm, exactly as the mutating fs arms are unit-tested) runs the command shell-free,
    /// env-scrubbed, cwd-contained, and returns a ToolReceipt whose `content` carries the output
    /// and whose `summary` is REFS-ONLY (exit + byte count, NO output text, NO command string).
    /// The gate-PAUSE (never-executes-without-approval) property is proven separately in
    /// `each_mutating_fs_tool_pauses_under_deny_all_and_never_executes`.
    #[test]
    fn executor_run_command_runs_and_summary_is_refs_only() {
        let root = TempDir::new("runcmd-exec");
        let executor = FsToolExecutor::new(&root.0);
        let receipt = executor
            .execute(
                "run_command",
                &[("command".to_string(), "echo hello".to_string())],
            )
            .unwrap();
        assert_eq!(receipt.action, "run_command");
        // content (model-facing) carries the actual output + a status line.
        let content = receipt.content.as_deref().unwrap_or("");
        assert!(
            content.contains("hello"),
            "content must carry output: {content:?}"
        );
        assert!(
            content.contains("exit Some(0)"),
            "content must carry exit: {content:?}"
        );
        // summary (→ audit ledger) is REFS-ONLY: it must NOT contain the output text NOR the
        // command string — only exit code + byte count.
        assert!(
            !receipt.summary.contains("hello"),
            "summary must NOT leak output text: {}",
            receipt.summary
        );
        assert!(
            !receipt.summary.contains("echo"),
            "summary must NOT leak the command string: {}",
            receipt.summary
        );
        assert!(
            receipt.summary.starts_with("run_command: exit Some(0)"),
            "summary must be the refs-only exit+bytes form: {}",
            receipt.summary
        );
    }

    /// S3-wiring ARM CORRECTNESS: each newly wired MUTATING arm (append/edit/move/delete)
    /// actually performs its friday-fs side effect when invoked directly (bypassing the gate
    /// — a legitimate unit test of the arm, exactly how `write_file`'s arm is proven). The
    /// gate-PAUSE behavior is proven separately in
    /// `each_mutating_fs_tool_pauses_under_deny_all_and_never_executes`; this is the ONLY
    /// place the EXECUTION wiring of these arms is verified (the coordinator's live proof
    /// only ever PAUSES a mutation, never executes one — that is S6).
    #[test]
    fn mutating_fs_arms_perform_real_side_effects_when_executed() {
        let root = TempDir::new("mutate-arms");
        let executor = FsToolExecutor::new(&root.0);

        // append_file: create-if-absent, then positional append.
        executor
            .execute(
                "append_file",
                &[
                    ("path".to_string(), "log.txt".to_string()),
                    ("content".to_string(), "one\n".to_string()),
                ],
            )
            .unwrap();
        executor
            .execute(
                "append_file",
                &[
                    ("path".to_string(), "log.txt".to_string()),
                    ("content".to_string(), "two\n".to_string()),
                ],
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.0.join("log.txt")).unwrap(),
            "one\ntwo\n"
        );

        // edit_file: replace the FIRST occurrence of old_text with new_text.
        std::fs::write(root.0.join("doc.txt"), b"hello OLD world OLD").unwrap();
        let e = executor
            .execute(
                "edit_file",
                &[
                    ("path".to_string(), "doc.txt".to_string()),
                    ("old_text".to_string(), "OLD".to_string()),
                    ("new_text".to_string(), "NEW".to_string()),
                ],
            )
            .unwrap();
        assert_eq!(e.action, "edit_file");
        assert_eq!(
            std::fs::read_to_string(root.0.join("doc.txt")).unwrap(),
            "hello NEW world OLD"
        );

        // move_file: src → target (src gone, target carries the bytes).
        std::fs::write(root.0.join("from.txt"), b"payload").unwrap();
        executor
            .execute(
                "move_file",
                &[
                    ("path".to_string(), "from.txt".to_string()),
                    ("target".to_string(), "to.txt".to_string()),
                ],
            )
            .unwrap();
        assert!(!root.0.join("from.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.0.join("to.txt")).unwrap(),
            "payload"
        );

        // delete_file: remove the regular file.
        std::fs::write(root.0.join("trash.txt"), b"x").unwrap();
        executor
            .execute(
                "delete_file",
                &[("path".to_string(), "trash.txt".to_string())],
            )
            .unwrap();
        assert!(!root.0.join("trash.txt").exists());
    }

    /// LIVE end-to-end (runtime-proven, the UNW-001 read-only path). Ignored in CI (no
    /// key); run manually with the Hub key. Real DeepSeek proposes → strict parse →
    /// trusted_classify → gate Allow → REAL friday-fs read → hash-chained audit
    /// receipt. The full live dispatch with the gate enforced. Never prints the key.
    #[test]
    #[ignore = "live: requires FRIDAY_DEEPSEEK_API_KEY; run manually (see ledger)"]
    fn live_read_only_turn_executes_through_the_gate_e2e() {
        let root = TempDir::new("live-e2e");
        std::fs::write(root.0.join("notes.md"), b"Friday live e2e note.").unwrap();
        let db = Db::open_hub(&temp_path("live-e2e")).unwrap();
        agent_run::create_run(
            db.conn(),
            "r1",
            "read the file notes.md and summarize it",
            1,
        )
        .unwrap();
        let client = DeepSeekAgentLlmClient::new(
            friday_deepseek::DeepSeekClient::from_env()
                .expect("FRIDAY_DEEPSEEK_API_KEY must be set"),
        );
        let executor = FsToolExecutor::new(&root.0);
        let out = run_one_turn_with_executor(
            &client,
            &executor,
            db.conn(),
            "r1",
            0,
            "read the file notes.md and summarize it",
            SECRET,
            None,
            5000,
        )
        .unwrap();
        eprintln!(
            "LIVE e2e: decision={:?} executed={} reason={}",
            out.decision, out.executed, out.reason
        );
        // If the live model proposed the read_file tool (non-mutating), it Allows,
        // executes via real friday-fs, and leaves a verifiable audit receipt.
        if out.executed {
            assert_eq!(out.decision, GateDecision::Allow);
            assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
        }
    }

    // --- §5-PR5: multi-turn run_loop ---

    /// A scripted multi-turn client: returns pre-set steps in order, COUNTING
    /// `next_step` calls (the no-hidden-call probe). After the script is exhausted it
    /// finishes (so an under-scripted test can't run away).
    struct ScriptedAgentLlmClient {
        steps: Vec<AgentStep>,
        calls: std::cell::Cell<usize>,
    }
    impl ScriptedAgentLlmClient {
        fn new(steps: Vec<AgentStep>) -> Self {
            Self {
                steps,
                calls: std::cell::Cell::new(0),
            }
        }
    }
    impl AgentLlmClient for ScriptedAgentLlmClient {
        fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
            match self.steps.first() {
                Some(AgentStep::Tool(raw)) => Ok(raw.clone()),
                _ => Err(AgentError::Parse(
                    "scripted: first step is not a tool".to_string(),
                )),
            }
        }
        fn next_step(&self, _task: &str, _history: &[TurnTrace]) -> Result<AgentStep, AgentError> {
            let i = self.calls.get();
            self.calls.set(i + 1);
            Ok(self.steps.get(i).cloned().unwrap_or(AgentStep::Finish {
                message: "script exhausted".to_string(),
            }))
        }
    }

    /// Wraps a ToolExecutor counting `execute` calls (the no-hidden-tool-call probe).
    struct CountingExecutor<'a> {
        inner: &'a dyn ToolExecutor,
        calls: std::cell::Cell<usize>,
    }
    impl<'a> ToolExecutor for CountingExecutor<'a> {
        fn execute(
            &self,
            action: &str,
            params: &[(String, String)],
        ) -> Result<ToolReceipt, ExecError> {
            self.calls.set(self.calls.get() + 1);
            self.inner.execute(action, params)
        }
    }

    fn no_approval() -> impl Fn(&MutatingActionRequest) -> Option<CanonicalApproval> {
        |_req| None
    }
    fn mint_for_each() -> impl Fn(&MutatingActionRequest) -> Option<CanonicalApproval> {
        // Owner-approval seam: mint a signed approval bound to THIS request (simulates
        // an instant owner approval). Distinct requests → distinct digests → distinct
        // single-use keys.
        |req| Some(mint_approval(req, "ap-loop", SECRET, 1_000_000))
    }

    /// A scripted client that ALSO captures the exact loop prompt
    /// (`build_loop_prompt(task, history)`) it is handed each turn — so a test can assert
    /// what the model actually SEES, including tool-result content threaded back into
    /// history. (The live `next_step` renders precisely this prompt before calling `chat`.)
    struct CapturingAgentLlmClient {
        steps: Vec<AgentStep>,
        calls: std::cell::Cell<usize>,
        prompts: std::cell::RefCell<Vec<String>>,
    }
    impl CapturingAgentLlmClient {
        fn new(steps: Vec<AgentStep>) -> Self {
            Self {
                steps,
                calls: std::cell::Cell::new(0),
                prompts: std::cell::RefCell::new(Vec::new()),
            }
        }
    }
    impl AgentLlmClient for CapturingAgentLlmClient {
        fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
            Err(AgentError::Parse(
                "capturing: single-turn path unused by run_loop".to_string(),
            ))
        }
        fn next_step(&self, task: &str, history: &[TurnTrace]) -> Result<AgentStep, AgentError> {
            self.prompts
                .borrow_mut()
                .push(build_loop_prompt(task, history));
            let i = self.calls.get();
            self.calls.set(i + 1);
            Ok(self.steps.get(i).cloned().unwrap_or(AgentStep::Finish {
                message: "script exhausted".to_string(),
            }))
        }
    }

    /// A scripted client that ALSO meters each turn (overrides `next_step_metered`) — the
    /// S1.2 billing harness. Each turn returns the next scripted (parse) result PLUS a
    /// synthetic `ModelCallOutcome` with fixed usage, so the loop bills exactly as the live
    /// path would, without a network call. Scripting a `Err(parse)` step with `Some(outcome)`
    /// models a chat that 200'd (billable) but produced unparseable content.
    struct MeteringScriptedClient {
        steps: Vec<Result<AgentStep, AgentError>>,
        calls: std::cell::Cell<usize>,
        prompt_tokens: i64,
        completion_tokens: i64,
    }
    impl MeteringScriptedClient {
        fn new(
            steps: Vec<Result<AgentStep, AgentError>>,
            prompt_tokens: i64,
            completion_tokens: i64,
        ) -> Self {
            Self {
                steps,
                calls: std::cell::Cell::new(0),
                prompt_tokens,
                completion_tokens,
            }
        }
    }
    impl AgentLlmClient for MeteringScriptedClient {
        fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
            Err(AgentError::Parse(
                "metering: single-turn path unused by run_loop".to_string(),
            ))
        }
        fn next_step_metered(
            &self,
            _task: &str,
            _history: &[TurnTrace],
        ) -> Result<MeteredStep, AgentError> {
            let i = self.calls.get();
            self.calls.set(i + 1);
            let step = self.steps.get(i).cloned().unwrap_or(Ok(AgentStep::Finish {
                message: "script exhausted".to_string(),
            }));
            let outcome = BilledUsage {
                provider_kind: friday_core::ProviderKind::DeepSeek,
                model: "deepseek-v4-flash".to_string(),
                prompt_tokens: self.prompt_tokens,
                completion_tokens: self.completion_tokens,
            };
            Ok((step, Some(outcome)))
        }
    }

    #[test]
    fn loop_bills_each_model_call_run_attributed_like_ask_path() {
        // S1.2 usage-parity FLOOR: a loop run with N model calls writes N run-attributed
        // token_ledger rows + N AskReceipt receipts + a verifying hash-chained audit —
        // the same accounting the single-shot ask path produces per call.
        let root = TempDir::new("loop-bill");
        std::fs::write(root.0.join("notes.md"), b"answer is 47").unwrap();
        let db = Db::open_hub(&temp_path("loop-bill")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read notes.md", 1).unwrap();
        // Two model calls: a read tool turn, then a finish turn.
        let client = MeteringScriptedClient::new(
            vec![
                Ok(AgentStep::Tool(raw("read_file", &[("path", "notes.md")]))),
                Ok(AgentStep::Finish {
                    message: "47".to_string(),
                }),
            ],
            10,
            5,
        );
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "read notes.md",
            "",
            SECRET,
            &no_approval(),
            10,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        // N model calls (2) -> N run-attributed token_ledger rows.
        assert_eq!(
            db.count("token_ledger").unwrap(),
            2,
            "one ledger row per model call"
        );
        let n_for_run: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM token_ledger WHERE run_id = 'r1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n_for_run, 2, "both rows attributed to the run");
        // N AskReceipt receipts (the same shape the ask surface emits).
        assert_eq!(db.count("activity_item").unwrap(), 2);
        let n_receipts: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM activity_item WHERE type = 'ask_receipt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n_receipts, 2);
        // Hash-chained audit verifies (2 model-call audits + the tool-receipt audit).
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).unwrap() >= 2);
        let n_modelcall_audits: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE action = 'agent_loop.model_call'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n_modelcall_audits, 2);
        // Run-attributed total == 2 calls * (10 prompt + 5 completion).
        let run_tot = friday_storage::agent_run_read::run_token_totals(db.conn(), "r1").unwrap();
        assert_eq!(run_tot.total, 30);
        assert_eq!(run_tot.prompt, 20);
        assert_eq!(run_tot.completion, 10);
        // Ledgered the RESPONSE-reported model (not the requested one).
        let model: String = db
            .conn()
            .query_row(
                "SELECT model FROM token_ledger WHERE ledger_id = 'r1:t0:ledger'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(model, "deepseek-v4-flash");
    }

    #[test]
    fn deepseek_provider_row_is_byte_identical_post_refactor() {
        // (C2 REGRESSION GATE / no-degrade) The metering generalization (neutral `BilledUsage`
        // + `bill_model_call` picking the ledger ctor off the provider_kind) MUST NOT change the
        // PROVEN DeepSeek loop-billing row. A DeepSeek model call still records EXACTLY the row
        // the pre-C2 `outcome.to_ledger_entry(..)` -> `LedgerEntry::friday_route(..)` produced:
        // provider_kind="deepseek", base_url_host="api.deepseek.com", fallback=false,
        // cost_estimate=NULL, the reported model + the part/total tokens. `list_token_usage`
        // does NOT project `base_url_host`, so the full row (incl. host) is read via direct SQL.
        let root = TempDir::new("ds-byte-identical");
        let db = Db::open_hub(&temp_path("ds-byte-identical")).unwrap();
        agent_run::create_run(db.conn(), "r1", "do it", 1).unwrap();
        // One finishing DeepSeek-tagged metered turn (MeteringScriptedClient is DeepSeek-kind).
        let client = MeteringScriptedClient::new(
            vec![Ok(AgentStep::Finish {
                message: "done".to_string(),
            })],
            11,
            8,
        );
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "do it",
            "",
            SECRET,
            &no_approval(),
            5,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        // Read EVERY persisted ledger field for the single row and assert it byte-for-byte.
        let (provider_kind, model, host, prompt, completion, total, cost, fallback): (
            String,
            String,
            String,
            i64,
            i64,
            i64,
            Option<f64>,
            i64,
        ) = db
            .conn()
            .query_row(
                "SELECT provider_kind, model, base_url_host, prompt_tokens, completion_tokens, \
                 total_tokens, cost_estimate, fallback FROM token_ledger \
                 WHERE ledger_id = 'r1:t0:ledger'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            provider_kind, "deepseek",
            "DeepSeek provider_kind unchanged"
        );
        assert_eq!(model, "deepseek-v4-flash", "reported model unchanged");
        assert_eq!(host, "api.deepseek.com", "DeepSeek host unchanged");
        assert_eq!(prompt, 11);
        assert_eq!(completion, 8);
        assert_eq!(
            total, 19,
            "total = prompt + completion (computed by the ledger)"
        );
        assert_eq!(
            cost, None,
            "loop biller passes no cost estimate (unchanged)"
        );
        assert_eq!(fallback, 0, "Friday route is never a fallback (unchanged)");
    }

    #[test]
    fn billed_usage_from_codex_maps_outcome_and_route_model() {
        // (C1-1) `BilledUsage::from_codex` maps a Codex app-server `ModelTurnOutcome`
        // (which has NO model field) plus a SEPARATELY-supplied route model into the
        // neutral billed-usage shape, tagged ProviderKind::Codex (never DeepSeek/Anthropic).
        // The `tokenUsage.last` breakdown maps input/output -> prompt/completion; the
        // outcome's own `total_tokens` is dropped (the ledger recomputes from the parts).
        let outcome = friday_providers::codex_appserver::ModelTurnOutcome {
            thread_id: "thr-1".to_string(),
            turn_id: "turn-1".to_string(),
            status: "completed".to_string(),
            content: "hi".to_string(),
            usage: Some(friday_providers::codex_appserver::CodexTokenUsage {
                input_tokens: 11,
                output_tokens: 8,
                total_tokens: 19,
            }),
        };
        let billed = BilledUsage::from_codex(&outcome, "gpt-5-codex");
        assert_eq!(billed.provider_kind, friday_core::ProviderKind::Codex);
        assert_eq!(billed.model, "gpt-5-codex"); // taken from the route, not the outcome
        assert_eq!(billed.prompt_tokens, 11);
        assert_eq!(billed.completion_tokens, 8);
    }

    #[test]
    fn billed_usage_from_codex_no_usage_bills_zero() {
        // (C1-1) A turn with no `thread/tokenUsage/updated` notification (usage == None) is
        // NOT a failure — it bills 0/0 (honest absence), still tagged ProviderKind::Codex with
        // the supplied route model.
        let outcome = friday_providers::codex_appserver::ModelTurnOutcome {
            thread_id: "thr-2".to_string(),
            turn_id: "turn-2".to_string(),
            status: "completed".to_string(),
            content: "ok".to_string(),
            usage: None,
        };
        let billed = BilledUsage::from_codex(&outcome, "gpt-5-codex");
        assert_eq!(billed.provider_kind, friday_core::ProviderKind::Codex);
        assert_eq!(billed.model, "gpt-5-codex");
        assert_eq!(billed.prompt_tokens, 0);
        assert_eq!(billed.completion_tokens, 0);
    }

    // ---- C1-2 CodexAgentLlmClient adapter KATs ----
    //
    // These prove the THIN adapter's mapping over the GENUINE Codex `run_turn` parser — NOT
    // a hand-built `ModelTurnOutcome`. The injected `CodexTurnSource` replays a scripted
    // JSON-RPC byte stream through the REAL `JsonLineTransport` + `run_turn` (the SAME
    // fixture shape `friday-providers`' run_turn KATs use: turn/start response +
    // item/completed agentMessage + thread/tokenUsage/updated + turn/completed). So the
    // assertion that `BilledUsage{Codex, tokens-from-fixture, model-from-self.model}` and the
    // parsed `AgentStep` arrive proves the adapter's prompt → run_turn → parse_agent_step →
    // BilledUsage::from_codex mapping is faithful — distinct from C1-3's route-wiring stub.
    //
    // The agentMessage `text` in each fixture is a VALID AgentStep JSON object (the finish /
    // tool-call contract `parse_agent_step` enforces), not prose — `outcome.content` is fed
    // straight into `parse_agent_step`.

    /// A scripted [`friday_providers::codex_appserver::CodexTurnSource`] that drives the REAL
    /// `run_turn` over a fixed byte stream — mirroring the providers `run_turn_client(..)`
    /// helper EXACTLY (construct the client, call `run_turn` directly; NO initialize /
    /// start_thread handshake, since `run_turn`'s `next_id` starts at 1 which is why each
    /// fixture's first line is `"id":1`). Creds-free.
    struct ScriptedCodexTurnSource {
        stream: &'static str,
    }

    impl friday_providers::codex_appserver::CodexTurnSource for ScriptedCodexTurnSource {
        fn run_text_turn(
            &self,
            _prompt: &str,
        ) -> Result<
            friday_providers::codex_appserver::ModelTurnOutcome,
            friday_providers::codex_appserver::CodexAppServerError,
        > {
            use friday_providers::codex_appserver::{CodexAppServerClient, JsonLineTransport};
            let mut client = CodexAppServerClient::new(JsonLineTransport::new(
                self.stream.as_bytes(),
                Vec::<u8>::new(),
            ));
            client.run_turn("thread-1", None, _prompt)
        }
    }

    #[test]
    fn codex_adapter_metered_step_maps_real_run_turn_to_step_and_codex_usage() {
        // The adapter's `next_step_metered` builds the loop prompt, runs the GENUINE
        // run_turn over a scripted stream (a delta that MUST be ignored for content, the
        // authoritative item/completed agentMessage carrying a finish object, a
        // tokenUsage/updated, then turn/completed), and surfaces (a) the parsed Finish step
        // and (b) Some(BilledUsage{Codex, tokens from the fixture's tokenUsage.last, model
        // from self.model}). This is the ADAPTER proof over the real parser.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"i","delta":"ignored-stream-delta"}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":1,"item":{"id":"i","type":"agentMessage","text":"{\"tool\":\"none\",\"answer\":\"codex done\"}"}}}"#,
            "\n",
            r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{"cachedInputTokens":0,"inputTokens":11,"outputTokens":8,"reasoningOutputTokens":0,"totalTokens":19},"total":{"cachedInputTokens":0,"inputTokens":11,"outputTokens":8,"reasoningOutputTokens":0,"totalTokens":19}}}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#,
            "\n",
        );
        let client = CodexAgentLlmClient::new(ScriptedCodexTurnSource { stream }, "gpt-5-codex");
        let (step, usage) = client.next_step_metered("do it", &[]).unwrap();

        // The authoritative item text parsed as the finish step (NOT the ignored delta).
        assert_eq!(
            step.unwrap(),
            AgentStep::Finish {
                message: "codex done".to_string(),
            }
        );
        // The tokenUsage.last projection feeds the billed usage: Codex kind, the fixture's
        // tokens, model from self.model (the app-server reports no model).
        assert_eq!(
            usage,
            Some(BilledUsage {
                provider_kind: friday_core::ProviderKind::Codex,
                model: "gpt-5-codex".to_string(),
                prompt_tokens: 11,
                completion_tokens: 8,
            })
        );
    }

    #[test]
    fn codex_adapter_metered_step_tool_call_no_usage_notification_bills_zero() {
        // None-usage variant: the authoritative item text is a TOOL call (proving the Tool
        // branch through the real parser) and NO tokenUsage/updated arrives. usage MUST be
        // Some(BilledUsage{Codex, 0/0, self.model}) — absence of the notification bills 0/0,
        // NOT a `None` option (the turn ran, so the call is always metered).
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":1,"item":{"id":"i","type":"agentMessage","text":"{\"tool\":\"list_dir\",\"parameters\":{\"path\":\".\"}}"}}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#,
            "\n",
        );
        let client = CodexAgentLlmClient::new(ScriptedCodexTurnSource { stream }, "gpt-5-codex");
        let (step, usage) = client.next_step_metered("list it", &[]).unwrap();

        assert_eq!(
            step.unwrap(),
            AgentStep::Tool(RawToolCall {
                action: "list_dir".to_string(),
                params: vec![("path".to_string(), ".".to_string())],
            })
        );
        assert_eq!(
            usage,
            Some(BilledUsage {
                provider_kind: friday_core::ProviderKind::Codex,
                model: "gpt-5-codex".to_string(),
                prompt_tokens: 0,
                completion_tokens: 0,
            })
        );
    }

    #[test]
    fn codex_adapter_completed_turn_unparseable_content_is_inner_err_with_usage() {
        // The INNER half of the MeteredStep split (mirrors DeepSeek/Claude EXACTLY): a turn
        // that COMPLETED with real billable usage but whose authoritative content is NOT a
        // valid tool-call object (here prose) is an INNER `Err` (parse failure) WITH
        // `Some(usage)` — the turn ran, so the loop bills it and then fails the run closed.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":1,"item":{"id":"i","type":"agentMessage","text":"sorry, just chatting, no JSON here"}}}"#,
            "\n",
            r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{"inputTokens":5,"outputTokens":3,"totalTokens":8}}}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#,
            "\n",
        );
        let client = CodexAgentLlmClient::new(ScriptedCodexTurnSource { stream }, "gpt-5-codex");
        let (step, usage) = client.next_step_metered("chat", &[]).unwrap();

        assert!(matches!(step, Err(AgentError::Parse(_))));
        // Billed despite the parse failure — usage is Some with the fixture's tokens.
        assert_eq!(
            usage,
            Some(BilledUsage {
                provider_kind: friday_core::ProviderKind::Codex,
                model: "gpt-5-codex".to_string(),
                prompt_tokens: 5,
                completion_tokens: 3,
            })
        );
    }

    #[test]
    fn codex_adapter_failed_turn_to_run_is_outer_err_nothing_billed() {
        // The OUTER half of the split: a turn that FAILS to run (here the stream EOFs before
        // turn/completed, a typed transport error from the real run_turn) is an OUTER `Err`
        // — NOTHING is billed (no usage escapes). Mirrors DeepSeek/Claude's route-failure arm.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":1,"item":{"id":"i","type":"agentMessage","text":"{\"tool\":\"none\",\"answer\":\"partial\"}"}}}"#,
            "\n",
        );
        let client = CodexAgentLlmClient::new(ScriptedCodexTurnSource { stream }, "gpt-5-codex");
        let err = client.next_step_metered("do it", &[]).unwrap_err();
        // OUTER Err — no MeteredStep tuple produced, so nothing could be billed. The
        // CodexAppServerError maps to the secret-free string-bearing AgentError::Model.
        assert!(matches!(err, AgentError::Model(_)));
    }

    #[test]
    fn codex_adapter_next_step_routes_through_metered() {
        // `next_step` is the unmetered facade — it must route THROUGH `next_step_metered`
        // (one turn call site) and yield the SAME parsed step.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":1,"item":{"id":"i","type":"agentMessage","text":"{\"tool\":\"none\",\"answer\":\"via next_step\"}"}}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#,
            "\n",
        );
        let client = CodexAgentLlmClient::new(ScriptedCodexTurnSource { stream }, "gpt-5-codex");
        let step = client.next_step("do it", &[]).unwrap();
        assert_eq!(
            step,
            AgentStep::Finish {
                message: "via next_step".to_string(),
            }
        );
    }

    #[test]
    fn codex_adapter_with_local_source_is_sync() {
        // The PR's headline design property, mechanically locked (not just asserted in
        // prose): a `CodexAgentLlmClient` over the production `LocalCodexAppServerTurnSource`
        // is `Sync`. This is what keeps it clean for a future boxed `dyn AgentLlmClient`
        // (C1-3) — the fresh-thread-per-turn source holds only immutable `String`/`Option`
        // config (no interior `!Sync` process across turns), so the whole adapter is `Sync`.
        fn assert_sync<T: Sync>() {}
        assert_sync::<
            CodexAgentLlmClient<friday_providers::codex_appserver::LocalCodexAppServerTurnSource>,
        >();
    }

    #[test]
    fn claude_step_writes_anthropic_provider_row() {
        // (C2 item 2) A Claude-tagged metered step, driven through the ROUTED loop with a
        // hand-built dispatchable `claude` route + a stub client, records a token_ledger row
        // with provider_kind="anthropic" / host="api.anthropic.com" / the claude model — NEVER
        // mis-attributed as DeepSeek. NO key, NO network: the stub returns a synthetic
        // `BilledUsage{Anthropic,..}` + a `Finish` step, exactly as the live Claude adapter's
        // `next_step_metered` would after a real chat. Proves the metering generalization wires
        // the Claude row end-to-end through the SAME biller as DeepSeek.
        use crate::routing::{
            run_routed_loop_with_policy, BackendKind, Capability, ModelSize, ProviderApi,
            ProviderClientResolver, ProviderRoute, RouteRegistry, RouteRequest,
        };
        use std::collections::BTreeSet;

        // A stub Claude client: it never proposes a tool, and its metered step surfaces an
        // Anthropic-kind `BilledUsage` (the bits the live adapter maps from a real chat) plus
        // a finishing step. This is the in-crate stand-in for `ClaudeAgentLlmClient`.
        struct StubClaudeMeteredClient {
            prompt_tokens: i64,
            completion_tokens: i64,
            model: String,
        }
        impl AgentLlmClient for StubClaudeMeteredClient {
            fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
                unreachable!("routed loop uses next_step_metered")
            }
            fn next_step_metered(
                &self,
                _task: &str,
                _history: &[TurnTrace],
            ) -> Result<MeteredStep, AgentError> {
                let usage = BilledUsage {
                    provider_kind: friday_core::ProviderKind::Anthropic,
                    model: self.model.clone(),
                    prompt_tokens: self.prompt_tokens,
                    completion_tokens: self.completion_tokens,
                };
                Ok((
                    Ok(AgentStep::Finish {
                        message: "done".to_string(),
                    }),
                    Some(usage),
                ))
            }
        }

        // A resolver that always returns the stub for the selected route.
        struct FixedResolver<'a> {
            client: &'a dyn AgentLlmClient,
        }
        impl<'a> ProviderClientResolver for FixedResolver<'a> {
            fn resolve(&self, _route: &ProviderRoute) -> Option<&dyn AgentLlmClient> {
                Some(self.client)
            }
        }

        // A hand-built registry with a DISPATCHABLE claude route (available + validated). This
        // is the in-test analogue of the gated-live promotion; the autonomous baseline keeps
        // claude `available:false` — this test never touches the baseline.
        let mut registry = RouteRegistry::new();
        let caps: BTreeSet<Capability> = [Capability::Text].into_iter().collect();
        registry.register(ProviderRoute {
            provider_id: "claude".to_string(),
            api: ProviderApi::AnthropicMessages,
            backend_kind: BackendKind::Http,
            model: "claude-opus-4-8".to_string(),
            model_size: ModelSize::Large,
            capabilities: caps,
            available: true,
            validation_ok: true,
            priority: 0,
        });

        let db = Db::open_hub(&temp_path("claude-anthropic-row")).unwrap();
        agent_run::create_run(db.conn(), "r1", "ask claude", 1).unwrap();
        let root = TempDir::new("claude-anthropic-row");
        let executor = FsToolExecutor::new(&root.0);
        let client = StubClaudeMeteredClient {
            prompt_tokens: 11,
            completion_tokens: 8,
            model: "claude-opus-4-8".to_string(),
        };
        let resolver = FixedResolver { client: &client };
        let request = RouteRequest {
            preferred_provider: Some("claude".to_string()),
            ..RouteRequest::any()
        };
        let (selection, outcome) = run_routed_loop_with_policy(
            &registry,
            &request,
            &resolver,
            &executor,
            db.conn(),
            "r1",
            "ask claude",
            "",
            None,
            &no_approval(),
            &RunPolicy::default(),
            5,
            None, // cancel: not exercised by this test
            None, // steer: not exercised by this test
            1000,
        )
        .expect("routed claude loop runs");
        assert_eq!(selection.provider_id, "claude", "pin routed to claude");
        assert_eq!(outcome.status, LoopStatus::Finished);

        // Exactly one ledger row, correctly attributed to Anthropic (zero mis-attribution).
        let rows = db.list_token_usage().unwrap();
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
        assert_eq!(row.model, "claude-opus-4-8");
        assert_eq!(row.total_tokens, 19, "11 + 8");
        assert!(!row.fallback, "the claude route is never a fallback");
        // The host is not projected by list_token_usage; read it directly to prove the
        // anthropic_route ctor was used (api.anthropic.com), not the deepseek host.
        let host: String = db
            .conn()
            .query_row(
                "SELECT base_url_host FROM token_ledger WHERE ledger_id = 'r1:t0:ledger'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(host, "api.anthropic.com");
    }

    #[test]
    fn loop_bills_a_chat_that_then_failed_to_parse() {
        // A chat that 200'd with usage but produced unparseable content (the S1.1 mode) is
        // STILL billed — the call spent tokens — then the run fails closed. Billing must not
        // hinge on the loop's parse, exactly like the ask path (which has no parse step).
        let root = TempDir::new("loop-bill-parsefail");
        let db = Db::open_hub(&temp_path("loop-bill-parsefail")).unwrap();
        agent_run::create_run(db.conn(), "r1", "do a thing", 1).unwrap();
        let client = MeteringScriptedClient::new(
            vec![Err(AgentError::Parse(
                "not a single JSON object".to_string(),
            ))],
            7,
            3,
        );
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "do a thing",
            "",
            SECRET,
            &no_approval(),
            10,
            1000,
        )
        .unwrap();
        assert_eq!(
            out.status,
            LoopStatus::Errored,
            "unparseable reply fails the run closed"
        );
        // ...but the spent call WAS billed (one run-attributed row); audit chain intact.
        assert_eq!(
            db.count("token_ledger").unwrap(),
            1,
            "the chat that spent tokens is billed even though it didn't parse"
        );
        let tot = friday_storage::agent_run_read::run_token_totals(db.conn(), "r1").unwrap();
        assert_eq!(tot.total, 10);
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).unwrap() >= 1);
    }

    #[test]
    fn loop_with_non_metering_client_bills_nothing() {
        // The honest default: a client without a `next_step_metered` override reports no
        // usage, so the loop writes NO token_ledger rows — billing requires real usage data.
        // (This is why every pre-S1.2 loop test stays green.)
        let root = TempDir::new("loop-nobill");
        std::fs::write(root.0.join("a.md"), b"alpha").unwrap();
        let db = Db::open_hub(&temp_path("loop-nobill")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read a", 1).unwrap();
        let client = ScriptedAgentLlmClient::new(vec![
            AgentStep::Tool(raw("read_file", &[("path", "a.md")])),
            AgentStep::Finish {
                message: "ok".to_string(),
            },
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "read a",
            "",
            SECRET,
            &no_approval(),
            10,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(
            db.count("token_ledger").unwrap(),
            0,
            "non-metering client bills nothing"
        );
        assert_eq!(db.count("activity_item").unwrap(), 0);
    }

    #[test]
    fn head_slice_respects_utf8_boundary() {
        // Under cap: returned whole, not truncated.
        let (whole, t0) = head_slice("hello", 10);
        assert_eq!(whole, "hello");
        assert!(!t0);
        // 'é' is 2 bytes; a cap that lands mid-char must walk back, never split / panic.
        let s = "aé"; // 'a'(1) + 'é'(2) = 3 bytes
        let (slice, truncated) = head_slice(s, 2);
        assert_eq!(slice, "a"); // dropped the partial 'é'
        assert!(truncated);
        let (exact, t2) = head_slice(s, 3);
        assert_eq!(exact, "aé");
        assert!(!t2);
    }

    #[test]
    fn format_executed_outcome_carries_bounded_content() {
        // read-type receipt under cap: summary + the ACTUAL content, no truncation marker.
        let r = ToolReceipt {
            action: "read_file".to_string(),
            summary: "read 26 bytes from notes.md".to_string(),
            content: Some("...Remember the number 47.".to_string()),
        };
        let out = format_executed_outcome(&r);
        assert!(out.contains("read 26 bytes from notes.md"));
        assert!(out.contains("Remember the number 47."));
        assert!(!out.contains(FEEDBACK_TRUNCATION_MARKER));

        // oversized content: capped to <= MAX_FEEDBACK_CONTENT_BYTES, truncation marker present.
        // Sentinel 'Z' is absent from the boilerplate ("executed"/"content"/... ) so its
        // count == exactly the number of fed-back content bytes.
        let big = "Z".repeat(MAX_FEEDBACK_CONTENT_BYTES + 500);
        let r2 = ToolReceipt {
            action: "read_file".to_string(),
            summary: format!("read {} bytes from big.md", big.len()),
            content: Some(big),
        };
        let out2 = format_executed_outcome(&r2);
        assert!(out2.contains(FEEDBACK_TRUNCATION_MARKER));
        // The fed-back content slice never exceeds the cap.
        let fed = out2.chars().filter(|&c| c == 'Z').count();
        assert!(fed > 0 && fed <= MAX_FEEDBACK_CONTENT_BYTES, "fed={fed}");

        // no-content receipt (e.g. write): plain summary only, unchanged from before.
        let r3 = ToolReceipt {
            action: "write_file".to_string(),
            summary: "wrote 8 bytes to out.md".to_string(),
            content: None,
        };
        assert_eq!(
            format_executed_outcome(&r3),
            "executed: wrote 8 bytes to out.md"
        );
    }

    #[test]
    fn loop_feeds_bounded_tool_content_back_into_model_prompt() {
        // The S1.2 grounding fix end-to-end: after a read, the NEXT model turn's prompt
        // must contain the file's ACTUAL content (not just the byte-count summary).
        let root = TempDir::new("loop-grounding");
        std::fs::write(root.0.join("notes.md"), b"...Remember the number 47.").unwrap();
        let db = Db::open_hub(&temp_path("loop-grounding")).unwrap();
        agent_run::create_run(db.conn(), "r1", "what is the number in notes.md", 1).unwrap();
        let client = CapturingAgentLlmClient::new(vec![
            AgentStep::Tool(raw("read_file", &[("path", "notes.md")])),
            AgentStep::Finish {
                message: "47".to_string(),
            },
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "what is the number in notes.md",
            "",
            SECRET,
            &no_approval(),
            10,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.final_message.as_deref(), Some("47"));

        let prompts = client.prompts.borrow();
        assert_eq!(prompts.len(), 2); // turn 1 (read) + turn 2 (finish)
                                      // Turn 1 had no history → no content yet.
        assert!(!prompts[0].contains("Remember the number 47."));
        // Turn 2 (AFTER the read) sees the real file content AND the summary.
        assert!(
            prompts[1].contains("Remember the number 47."),
            "second prompt must carry the read content, got: {}",
            prompts[1]
        );
        assert!(prompts[1].contains("from notes.md"));
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    /// S3-wiring: a read-type `list_dir` result is fed BACK into the next model turn's prompt
    /// (bounded), exactly like `read_file` — so the model can ground its answer on the listing
    /// instead of re-running the tool. (stat_file's content rides the SAME path; this proves
    /// the read-type feedback wiring end-to-end through the loop.)
    #[test]
    fn loop_feeds_list_dir_content_back_into_model_prompt() {
        let root = TempDir::new("loop-listdir");
        std::fs::create_dir(root.0.join("sub")).unwrap();
        std::fs::write(root.0.join("sub/report.md"), b"x").unwrap();
        std::fs::write(root.0.join("sub/budget.csv"), b"y").unwrap();
        let db = Db::open_hub(&temp_path("loop-listdir")).unwrap();
        agent_run::create_run(db.conn(), "r1", "what files are in sub", 1).unwrap();
        let client = CapturingAgentLlmClient::new(vec![
            AgentStep::Tool(raw("list_dir", &[("path", "sub")])),
            AgentStep::Finish {
                message: "report.md, budget.csv".to_string(),
            },
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "what files are in sub",
            "",
            SECRET,
            &no_approval(),
            10,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        let prompts = client.prompts.borrow();
        assert_eq!(prompts.len(), 2);
        // Turn 1 had no history yet.
        assert!(!prompts[0].contains("budget.csv"));
        // Turn 2 (after the list_dir) sees the ACTUAL sorted entries fed back.
        assert!(
            prompts[1].contains("budget.csv") && prompts[1].contains("report.md"),
            "second prompt must carry the listing, got: {}",
            prompts[1]
        );
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    /// S3-wiring SAFETY (the load-bearing test): EACH newly wired mutating fs tool is
    /// classified `mutating` in the registry, so under DenyAllApprovals (`no_approval`) the
    /// gate withholds it (`RequiresApproval`) and `run_loop` PAUSES — the executor is NEVER
    /// invoked (the `CountingExecutor` records ZERO calls) and NO filesystem side effect
    /// occurs. The agent can never self-complete a mutation; only a signed owner approval
    /// (S6) ever reaches the arm. Covers write_file + the four new arms append/edit/move/delete.
    #[test]
    fn each_mutating_fs_tool_pauses_under_deny_all_and_never_executes() {
        // Drive ONE proposed mutating tool through the whole loop under DenyAllApprovals,
        // returning the outcome AND the executor-call count (must be 0 — gate before dispatch).
        fn run_one(root: &std::path::Path, call: RawToolCall) -> (LoopOutcome, usize) {
            let db = Db::open_hub(&temp_path("mutpause")).unwrap();
            agent_run::create_run(db.conn(), "r1", "mutate", 1).unwrap();
            let client = ScriptedAgentLlmClient::new(vec![AgentStep::Tool(call)]);
            let fs_exec = FsToolExecutor::new(root);
            let counting = CountingExecutor {
                inner: &fs_exec,
                calls: std::cell::Cell::new(0),
            };
            let out = run_loop(
                &client,
                &counting,
                db.conn(),
                "r1",
                "mutate",
                "",
                SECRET,
                &no_approval(),
                5,
                1000,
            )
            .unwrap();
            (out, counting.calls.get())
        }

        // write_file: would create a file → must NOT exist after a pause.
        {
            let root = TempDir::new("pause-write");
            let (out, calls) = run_one(
                &root.0,
                raw("write_file", &[("path", "w.txt"), ("content", "X")]),
            );
            assert_eq!(out.status, LoopStatus::Paused, "write_file must pause");
            assert_eq!(calls, 0, "executor never invoked for a withheld mutation");
            assert!(!root.0.join("w.txt").exists(), "no file written");
        }
        // append_file: create-if-absent → the file must NOT exist after a pause.
        {
            let root = TempDir::new("pause-append");
            let (out, calls) = run_one(
                &root.0,
                raw("append_file", &[("path", "a.txt"), ("content", "X")]),
            );
            assert_eq!(out.status, LoopStatus::Paused, "append_file must pause");
            assert_eq!(calls, 0);
            assert!(
                !root.0.join("a.txt").exists(),
                "append must not have created the file"
            );
        }
        // edit_file: an existing file must be byte-for-byte unchanged.
        {
            let root = TempDir::new("pause-edit");
            std::fs::write(root.0.join("e.txt"), b"ORIGINAL").unwrap();
            let (out, calls) = run_one(
                &root.0,
                raw(
                    "edit_file",
                    &[
                        ("path", "e.txt"),
                        ("old_text", "ORIGINAL"),
                        ("new_text", "PWNED"),
                    ],
                ),
            );
            assert_eq!(out.status, LoopStatus::Paused, "edit_file must pause");
            assert_eq!(calls, 0);
            assert_eq!(
                std::fs::read_to_string(root.0.join("e.txt")).unwrap(),
                "ORIGINAL",
                "edit must not have modified the file"
            );
        }
        // delete_file: an existing file must STILL exist.
        {
            let root = TempDir::new("pause-delete");
            std::fs::write(root.0.join("d.txt"), b"KEEP").unwrap();
            let (out, calls) = run_one(&root.0, raw("delete_file", &[("path", "d.txt")]));
            assert_eq!(out.status, LoopStatus::Paused, "delete_file must pause");
            assert_eq!(calls, 0);
            assert!(
                root.0.join("d.txt").exists(),
                "delete must not have removed the file"
            );
        }
        // move_file: source must remain, target must not be created.
        {
            let root = TempDir::new("pause-move");
            std::fs::write(root.0.join("m.txt"), b"DATA").unwrap();
            let (out, calls) = run_one(
                &root.0,
                raw("move_file", &[("path", "m.txt"), ("target", "moved.txt")]),
            );
            assert_eq!(out.status, LoopStatus::Paused, "move_file must pause");
            assert_eq!(calls, 0);
            assert!(
                root.0.join("m.txt").exists(),
                "move must not have moved the source"
            );
            assert!(
                !root.0.join("moved.txt").exists(),
                "move must not have created the target"
            );
        }
        // run_command (highest-risk): a metacharacter-FREE command (`echo hi`) stays at the High
        // base risk (not Critical, which would DENY) → mutating → withheld under deny-all → the
        // loop PAUSES and the executor is NEVER invoked (calls == 0). No command ran without an
        // operator's signed approval — the security-critical gate-pause proof. A drop-marker file
        // would have been the side effect of a real run; we assert via the (more robust) zero
        // executor-call count, the established "no command ran" invariant.
        {
            let root = TempDir::new("pause-runcmd");
            // A command that, IF it ran, would create an observable side effect on disk; we then
            // assert that file is ABSENT (belt-and-suspenders on top of calls == 0). `touch` is on
            // the fixed child PATH and metacharacter-free, so it stays High and Pauses.
            let (out, calls) = run_one(
                &root.0,
                raw("run_command", &[("command", "touch SENTINEL_RAN")]),
            );
            assert_eq!(out.status, LoopStatus::Paused, "run_command must pause");
            assert_eq!(
                calls, 0,
                "executor never invoked for a withheld run_command"
            );
            assert!(
                !root.0.join("SENTINEL_RAN").exists(),
                "run_command must NOT have executed (no side-effect file) without approval"
            );
        }
    }

    #[test]
    fn loop_multi_turn_read_only_finishes_with_no_hidden_calls() {
        let root = TempDir::new("loop-ro");
        std::fs::write(root.0.join("a.md"), b"alpha").unwrap();
        std::fs::write(root.0.join("b.md"), b"bravo!!").unwrap();
        let db = Db::open_hub(&temp_path("loop-ro")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read a then b", 1).unwrap();
        let client = ScriptedAgentLlmClient::new(vec![
            AgentStep::Tool(raw("read_file", &[("path", "a.md")])),
            AgentStep::Tool(raw("read_file", &[("path", "b.md")])),
            AgentStep::Finish {
                message: "done".to_string(),
            },
        ]);
        let fs_exec = FsToolExecutor::new(&root.0);
        let executor = CountingExecutor {
            inner: &fs_exec,
            calls: std::cell::Cell::new(0),
        };
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "read a then b",
            "",
            SECRET,
            &no_approval(),
            10,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.turns, 3); // 2 tools + 1 finish
        assert_eq!(out.executed_tools, 2);
        // No-hidden-call proof: model called exactly `turns` times; executor exactly `executed_tools`.
        assert_eq!(client.calls.get(), out.turns as usize);
        assert_eq!(executor.calls.get(), out.executed_tools as usize);
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    /// S6d HMAC-DOWNGRADE CLOSED + Pause persistence (loop level): `run_loop` provisions NO
    /// operator key, so even with an HMAC-minting `approve` closure a mutating write CANNOT
    /// be Allowed — the read executes (base Allow), the write Pauses (fail-closed), no file
    /// is written, and the loop persists a `pending_approval_request` (CSPRNG nonce) the
    /// offline operator can later sign. The positive Ed25519-approved write is the
    /// integration test `s6d_resume_ingestion` (it needs an operator signing key, banned in
    /// `friday-hub/src/**`).
    #[test]
    fn loop_hmac_minted_approval_cannot_execute_a_mutation_and_pause_persists_pending() {
        let root = TempDir::new("loop-mut");
        std::fs::write(root.0.join("in.md"), b"input").unwrap();
        let db = Db::open_hub(&temp_path("loop-mut")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read input then write output", 1).unwrap();
        let client = ScriptedAgentLlmClient::new(vec![
            AgentStep::Tool(raw("read_file", &[("path", "in.md")])),
            AgentStep::Tool(raw(
                "write_file",
                &[("path", "out.md"), ("content", "produced")],
            )),
            AgentStep::Finish {
                message: "done".to_string(),
            },
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "read input then write output",
            "",
            SECRET,
            &mint_for_each(), // an HMAC-minting owner seam — must NOT drive the mutation
            10,
            1000,
        )
        .unwrap();
        assert_eq!(
            out.status,
            LoopStatus::Paused,
            "the mutating write must Pause (no operator key ⇒ HMAC can't Allow it)"
        );
        assert_eq!(
            out.executed_tools, 1,
            "only the read executed; the write Paused"
        );
        assert!(
            !root.0.join("out.md").exists(),
            "an HMAC approval must not complete the mutating write (downgrade closed)"
        );
        // The Pause persisted a pending request bound to THIS action, with a 64-hex CSPRNG
        // nonce, status pending.
        let (count, nonce_len): (i64, i64) = db
            .conn()
            .query_row(
                "SELECT count(*), COALESCE(length(MAX(approval_id)),0) \
                 FROM pending_approval_request WHERE run_id='r1' AND action='write_file' \
                 AND status='pending'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(nonce_len, 64, "CSPRNG nonce is 32 bytes => 64 hex chars");
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    #[test]
    fn loop_premature_finish_does_no_work_honestly() {
        let root = TempDir::new("loop-prem");
        let db = Db::open_hub(&temp_path("loop-prem")).unwrap();
        agent_run::create_run(db.conn(), "r1", "do the thing", 1).unwrap();
        // Model finishes on turn 0 without doing anything.
        let client = ScriptedAgentLlmClient::new(vec![AgentStep::Finish {
            message: "nothing to do".to_string(),
        }]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "do the thing",
            "",
            SECRET,
            &no_approval(),
            10,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.turns, 1);
        assert_eq!(
            out.executed_tools, 0,
            "premature finish must report ZERO work honestly"
        );
        // No tool.executed event exists — the loop fabricates no success.
        let executed: i64 = db.conn().query_row("SELECT count(*) FROM agent_run_event WHERE run_id='r1' AND kind LIKE 'tool.executed%'", [], |r| r.get(0)).unwrap();
        assert_eq!(executed, 0);
    }

    #[test]
    fn loop_unapproved_mutating_tool_pauses_with_no_mutation() {
        let root = TempDir::new("loop-unappr");
        let db = Db::open_hub(&temp_path("loop-unappr")).unwrap();
        agent_run::create_run(db.conn(), "r1", "write secret.txt", 1).unwrap();
        let client = ScriptedAgentLlmClient::new(vec![
            AgentStep::Tool(raw(
                "write_file",
                &[("path", "secret.txt"), ("content", "X")],
            )),
            AgentStep::Finish {
                message: "done".to_string(),
            }, // never reached
        ]);
        let executor = FsToolExecutor::new(&root.0);
        // No approval available → mutating write → RequiresApproval → Paused.
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "write secret.txt",
            "",
            SECRET,
            &no_approval(),
            10,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Paused);
        assert_eq!(out.executed_tools, 0);
        assert!(
            !root.0.join("secret.txt").exists(),
            "unapproved mutating tool must not reach the executor"
        );
    }

    #[test]
    fn loop_bound_stops_a_runaway_model() {
        let root = TempDir::new("loop-bound");
        std::fs::write(root.0.join("x.md"), b"x").unwrap();
        let db = Db::open_hub(&temp_path("loop-bound")).unwrap();
        agent_run::create_run(db.conn(), "r1", "loop forever", 1).unwrap();
        // A model that never finishes: every step proposes another read.
        let client = ScriptedAgentLlmClient::new(vec![
            AgentStep::Tool(raw("read_file", &[("path", "x.md")])),
            AgentStep::Tool(raw("read_file", &[("path", "x.md")])),
            AgentStep::Tool(raw("read_file", &[("path", "x.md")])),
            AgentStep::Tool(raw("read_file", &[("path", "x.md")])),
            AgentStep::Tool(raw("read_file", &[("path", "x.md")])),
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "loop forever",
            "",
            SECRET,
            &no_approval(),
            3,
            1000,
        )
        .unwrap();
        assert_eq!(
            out.status,
            LoopStatus::Bounded,
            "max_turns must stop a runaway"
        );
        assert_eq!(out.turns, 3);
        assert_eq!(out.executed_tools, 3);
    }

    /// LIVE multi-turn end-to-end (runtime-proven). Ignored in CI; run manually with
    /// the Hub key. Real DeepSeek drives a bounded loop over real friday-fs files;
    /// asserts no panic and (if it finished) a verifiable audit chain. Never prints the key.
    #[test]
    #[ignore = "live: requires FRIDAY_DEEPSEEK_API_KEY; run manually (see ledger)"]
    fn live_multi_turn_loop_e2e() {
        let root = TempDir::new("live-loop");
        std::fs::write(
            root.0.join("notes.md"),
            b"Buy milk. Call Sam. Ship the release.",
        )
        .unwrap();
        let db = Db::open_hub(&temp_path("live-loop")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read notes.md and tell me the tasks", 1).unwrap();
        let client = DeepSeekAgentLlmClient::new(
            friday_deepseek::DeepSeekClient::from_env()
                .expect("FRIDAY_DEEPSEEK_API_KEY must be set"),
        );
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "read notes.md and tell me the tasks",
            "",
            SECRET,
            &mint_for_each(),
            5,
            5000,
        )
        .unwrap();
        eprintln!(
            "LIVE loop: status={:?} turns={} executed_tools={} detail={}",
            out.status, out.turns, out.executed_tools, out.detail
        );
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    // --- §5-PR5: each loop TERMINAL covered by a dedicated run_loop test (Reviewer-A) ---

    #[test]
    fn loop_agent_error_terminates_errored() {
        let root = TempDir::new("loop-err");
        let db = Db::open_hub(&temp_path("loop-err")).unwrap();
        agent_run::create_run(db.conn(), "r1", "do it", 1).unwrap();
        let client = ErrAgentLlmClient(AgentError::Model("transport down".to_string()));
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "do it",
            "",
            SECRET,
            &no_approval(),
            5,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Errored);
        assert_eq!(out.turns, 1);
        assert_eq!(out.executed_tools, 0);
    }

    // --- UNW-011 wiring: BOUNDED provider-call retry via RetryDisposition -----------
    //
    // These six tests prove the retry slice end-to-end at the run_loop level: a transient
    // `Route` error is bounded-retried into success; a `Terminal` route error is never
    // retried; the bound is enforced; the gate path is unreachable from the retry; and a
    // retried turn neither corrupts the audit chain nor double-bills.

    /// A metering client whose OUTER provider result is SCRIPTED per call (drives the retry
    /// loop). Each `next_step_metered` returns the next scripted `Result<MeteredStep, _>` and
    /// COUNTS the call, so a test can assert how many provider attempts the loop made. An
    /// OUTER `Err(Route(..))` exercises the retry path; an `Ok((step, Some(outcome)))` is a
    /// billable success. Once the script is exhausted it repeats the LAST entry (so a
    /// "succeed on attempt N" script that then needs a finish turn keeps returning that
    /// finish). `propose_tool_call` is unused by the loop.
    struct RetryScriptedClient {
        outer: Vec<Result<MeteredStep, AgentError>>,
        calls: std::cell::Cell<usize>,
    }
    impl RetryScriptedClient {
        fn new(outer: Vec<Result<MeteredStep, AgentError>>) -> Self {
            Self {
                outer,
                calls: std::cell::Cell::new(0),
            }
        }
        fn provider_calls(&self) -> usize {
            self.calls.get()
        }
    }
    impl AgentLlmClient for RetryScriptedClient {
        fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
            Err(AgentError::Parse(
                "single-turn path unused by run_loop".to_string(),
            ))
        }
        fn next_step_metered(
            &self,
            _task: &str,
            _history: &[TurnTrace],
        ) -> Result<MeteredStep, AgentError> {
            let i = self.calls.get();
            self.calls.set(i + 1);
            let idx = i.min(self.outer.len().saturating_sub(1));
            // `Result<MeteredStep, AgentError>` is Clone (its members all are), so each
            // scripted attempt is reproducible.
            self.outer[idx].clone()
        }
    }

    /// A billable success step (synthetic usage), used to script the "eventual success" turn.
    fn ok_step(step: AgentStep, prompt_tokens: i64, completion_tokens: i64) -> MeteredStep {
        (
            Ok(step),
            Some(BilledUsage {
                provider_kind: friday_core::ProviderKind::DeepSeek,
                model: "deepseek-v4-flash".to_string(),
                prompt_tokens,
                completion_tokens,
            }),
        )
    }

    /// A transient (Retryable) route error: `ProviderUnavailable` (network/transport,
    /// request-timeout 408, or server-side 5xx) — retrying the SAME route may fix it.
    fn transient_route_err() -> Result<MeteredStep, AgentError> {
        Err(AgentError::Route(
            friday_deepseek::DeepSeekError::ProviderUnavailable("HTTP 503".to_string()),
        ))
    }

    /// A Terminal route error: `Auth` (credential rejected) — must NEVER be retried.
    fn terminal_route_err() -> Result<MeteredStep, AgentError> {
        Err(AgentError::Route(friday_deepseek::DeepSeekError::Auth(401)))
    }

    /// A Terminal client-side route error: a 429 rate-limit (also covers 400/404/422).
    /// Terminal because there is no backoff mechanism here — retrying would only hammer a
    /// rate-limited provider — so it must fail closed after exactly ONE provider attempt.
    fn client_error_route_err(status: u16) -> Result<MeteredStep, AgentError> {
        Err(AgentError::Route(
            friday_deepseek::DeepSeekError::ClientError { status },
        ))
    }

    #[test]
    fn loop_retries_transient_route_error_then_succeeds() {
        // (Test 1) Two transient Route failures, then a billable finish → the turn recovers
        // within the bound (3 attempts) and the run finishes. Exactly 3 provider calls; one
        // billed turn; audit chain intact (no per-attempt writes).
        let root = TempDir::new("retry-transient-ok");
        let db = Db::open_hub(&temp_path("retry-transient-ok")).unwrap();
        agent_run::create_run(db.conn(), "r1", "do it", 1).unwrap();
        let client = RetryScriptedClient::new(vec![
            transient_route_err(),
            transient_route_err(),
            Ok(ok_step(
                AgentStep::Finish {
                    message: "done".to_string(),
                },
                10,
                5,
            )),
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "do it",
            "",
            SECRET,
            &no_approval(),
            5,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished, "recovered after retries");
        assert_eq!(
            out.turns, 1,
            "retries are the SAME turn — max_turns untouched"
        );
        assert_eq!(
            client.provider_calls(),
            3,
            "2 transient failures + 1 success = 3 provider attempts"
        );
        // Billed exactly once (only the successful attempt produced usage).
        assert_eq!(
            db.count("token_ledger").unwrap(),
            1,
            "failed Route attempts produce no usage ⇒ bill once"
        );
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).unwrap() >= 1);
    }

    #[test]
    fn loop_does_not_retry_terminal_route_error() {
        // (Test 2) A Terminal route error (auth) fails closed IMMEDIATELY — no retry — even
        // though attempts remain. Exactly ONE provider call; run Errored; nothing billed.
        let root = TempDir::new("retry-terminal");
        let db = Db::open_hub(&temp_path("retry-terminal")).unwrap();
        agent_run::create_run(db.conn(), "r1", "do it", 1).unwrap();
        let client = RetryScriptedClient::new(vec![
            terminal_route_err(),
            // A success is scripted next, but the loop must NEVER reach it for a Terminal error.
            Ok(ok_step(
                AgentStep::Finish {
                    message: "should-not-reach".to_string(),
                },
                10,
                5,
            )),
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "do it",
            "",
            SECRET,
            &no_approval(),
            5,
            1000,
        )
        .unwrap();
        assert_eq!(
            out.status,
            LoopStatus::Errored,
            "terminal error fails closed"
        );
        assert_eq!(out.turns, 1);
        assert_eq!(
            client.provider_calls(),
            1,
            "a Terminal route error is NOT retried"
        );
        assert_eq!(db.count("token_ledger").unwrap(), 0, "nothing billed");
    }

    #[test]
    fn loop_does_not_retry_terminal_client_4xx_or_429_but_does_retry_503() {
        // (Test 2b) A terminal client error — 429 rate-limit (and 400/404/422) — fails
        // closed IMMEDIATELY: exactly ONE provider call, run Errored, nothing billed. This is
        // the #593 LOW fix: such errors were previously folded into ProviderUnavailable and
        // wastefully retried up to RUN_LOOP_MAX_PROVIDER_ATTEMPTS (hammering a rate-limited
        // provider with no backoff). The boundary partner (a 503) STILL retries — proving the
        // change is a precise re-partition, not a blanket "stop retrying everything".
        for terminal_status in [429u16, 400, 422] {
            let label = format!("retry-client-{terminal_status}");
            let root = TempDir::new(&label);
            let db = Db::open_hub(&temp_path(&label)).unwrap();
            agent_run::create_run(db.conn(), "r1", "do it", 1).unwrap();
            let client = RetryScriptedClient::new(vec![
                client_error_route_err(terminal_status),
                // A success is scripted next; the loop must NEVER reach it for a terminal error.
                Ok(ok_step(
                    AgentStep::Finish {
                        message: "should-not-reach".to_string(),
                    },
                    10,
                    5,
                )),
            ]);
            let executor = FsToolExecutor::new(&root.0);
            let out = run_loop(
                &client,
                &executor,
                db.conn(),
                "r1",
                "do it",
                "",
                SECRET,
                &no_approval(),
                5,
                1000,
            )
            .unwrap();
            assert_eq!(
                out.status,
                LoopStatus::Errored,
                "terminal client error (HTTP {terminal_status}) fails closed"
            );
            assert_eq!(out.turns, 1);
            assert_eq!(
                client.provider_calls(),
                1,
                "a terminal client error (HTTP {terminal_status}) is NOT retried"
            );
            assert_eq!(
                db.count("token_ledger").unwrap(),
                0,
                "nothing billed for HTTP {terminal_status}"
            );
            // The surfaced error string is coarse/secret-free: status + kind only.
            let detail = format!(
                "agent_error:{}",
                AgentError::Route(friday_deepseek::DeepSeekError::ClientError {
                    status: terminal_status
                },)
            );
            assert!(detail.contains(&terminal_status.to_string()));
            assert!(!detail.contains("Bearer") && !detail.contains("Authorization"));
        }

        // Boundary partner: a transient 503 IS still retried (bounded), confirming the
        // re-partition did not over-broaden terminality.
        {
            let root = TempDir::new("retry-503-still-retries");
            let db = Db::open_hub(&temp_path("retry-503-still-retries")).unwrap();
            agent_run::create_run(db.conn(), "r1", "do it", 1).unwrap();
            let client = RetryScriptedClient::new(vec![transient_route_err()]);
            let executor = FsToolExecutor::new(&root.0);
            let out = run_loop(
                &client,
                &executor,
                db.conn(),
                "r1",
                "do it",
                "",
                SECRET,
                &no_approval(),
                5,
                1000,
            )
            .unwrap();
            assert_eq!(
                out.status,
                LoopStatus::Errored,
                "exhausted retries fail closed"
            );
            assert_eq!(
                client.provider_calls() as u32,
                RUN_LOOP_MAX_PROVIDER_ATTEMPTS,
                "a transient 503 IS retried up to the bound (terminality not over-broadened)"
            );
        }
    }

    #[test]
    fn loop_bounds_a_persistently_transient_route_error() {
        // (Test 3) A provider that ALWAYS returns a transient Route error is bounded: the loop
        // makes EXACTLY `RUN_LOOP_MAX_PROVIDER_ATTEMPTS` calls then fails closed (no unbounded
        // retry / runaway spend). Asserting the exact const is the bound proof.
        let root = TempDir::new("retry-bounded");
        let db = Db::open_hub(&temp_path("retry-bounded")).unwrap();
        agent_run::create_run(db.conn(), "r1", "do it", 1).unwrap();
        // Single always-transient entry; the client repeats the last entry, so every attempt
        // fails transiently.
        let client = RetryScriptedClient::new(vec![transient_route_err()]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "do it",
            "",
            SECRET,
            &no_approval(),
            5,
            1000,
        )
        .unwrap();
        assert_eq!(
            out.status,
            LoopStatus::Errored,
            "exhausted retries fail closed"
        );
        assert_eq!(out.turns, 1, "all retries are the SAME (first) turn");
        assert_eq!(
            client.provider_calls() as u32,
            RUN_LOOP_MAX_PROVIDER_ATTEMPTS,
            "exactly the bounded number of provider attempts, then give up"
        );
        assert_eq!(
            db.count("token_ledger").unwrap(),
            0,
            "no failed attempt billed"
        );
    }

    #[test]
    fn loop_never_retries_a_gate_pause_or_deny() {
        // (Test 4) The retry wraps ONLY the provider call — it is BEFORE/SEPARATE from the
        // gate dispatch. A successful provider step whose gate outcome is a PAUSE or a DENY is
        // NOT re-driven: the provider is called EXACTLY once and the gate outcome is unchanged.
        // The retry only ever matches `Err(AgentError::Route(..))`; a gate outcome arrives via
        // the `Ok` provider result and the SEPARATE `gate_dispatch` branch downstream, which is
        // structurally unreachable from the provider-only retry. Both outcomes are proven:
        // Pause directly, and Deny via a read-only RunPolicy on the SAME mutating proposal.

        // (a) PAUSE: mutating delete, no operator key → RequiresApproval → Paused, stays paused.
        {
            let root = TempDir::new("retry-gate-pause");
            std::fs::write(root.0.join("d.txt"), b"KEEP").unwrap();
            let db = Db::open_hub(&temp_path("retry-gate-pause")).unwrap();
            agent_run::create_run(db.conn(), "r1", "delete it", 1).unwrap();
            let client = RetryScriptedClient::new(vec![Ok(ok_step(
                AgentStep::Tool(raw("delete_file", &[("path", "d.txt")])),
                10,
                5,
            ))]);
            let executor = FsToolExecutor::new(&root.0);
            let out = run_loop(
                &client,
                &executor,
                db.conn(),
                "r1",
                "delete it",
                "",
                SECRET,
                &no_approval(),
                5,
                1000,
            )
            .unwrap();
            assert_eq!(
                out.status,
                LoopStatus::Paused,
                "mutating action without approval Pauses — and stays paused"
            );
            assert_eq!(
                client.provider_calls(),
                1,
                "the gate Pause is NOT a provider error — the retry never re-calls the provider"
            );
            assert!(
                root.0.join("d.txt").exists(),
                "a paused mutation never executes (file untouched)"
            );
        }

        // (b) DENY: a READ-ONLY RunPolicy denies the SAME mutating delete BEFORE execution
        // (`run_is_read_only:*`) → Blocked. The Deny is reached via the single downstream
        // gate_dispatch on the single `Ok` provider result — the retry never re-calls the
        // provider, and the Deny outcome is unchanged.
        {
            let root = TempDir::new("retry-gate-deny");
            std::fs::write(root.0.join("d.txt"), b"KEEP").unwrap();
            let db = Db::open_hub(&temp_path("retry-gate-deny")).unwrap();
            agent_run::create_run(db.conn(), "r1", "delete it", 1).unwrap();
            let client = RetryScriptedClient::new(vec![Ok(ok_step(
                AgentStep::Tool(raw("delete_file", &[("path", "d.txt")])),
                10,
                5,
            ))]);
            let executor = FsToolExecutor::new(&root.0);
            let out = run_loop_with_policy(
                &client,
                &executor,
                db.conn(),
                "r1",
                "delete it",
                "",
                None,
                &no_approval(),
                &RunPolicy::new(None, Vec::<String>::new(), true), // read-only ⇒ Deny mutations
                5,
                None, // cancel: not exercised by this test
                None, // steer: not exercised by this test
                1000,
            )
            .unwrap();
            assert_eq!(
                out.status,
                LoopStatus::Blocked,
                "a read-only run DENIES the mutating tool before execution"
            );
            assert!(out.detail.contains("denied:run_is_read_only:delete_file"));
            assert_eq!(
                client.provider_calls(),
                1,
                "the gate Deny is NOT a provider error — the retry never re-calls the provider"
            );
            assert!(
                root.0.join("d.txt").exists(),
                "a denied mutation never executes (file untouched)"
            );
        }
    }

    #[test]
    fn loop_audit_chain_consistent_across_a_retried_turn() {
        // (Test 5) A turn that retried twice before succeeding (read tool) then finishes writes
        // the SAME audit/event records as a non-retried turn — the retry adds NO per-attempt
        // events and does not corrupt the hash chain. The chain verifies, and there is exactly
        // ONE model-call audit per BILLED turn (2), not one per attempt.
        let root = TempDir::new("retry-audit");
        std::fs::write(root.0.join("notes.md"), b"answer is 47").unwrap();
        let db = Db::open_hub(&temp_path("retry-audit")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read notes", 1).unwrap();
        let client = RetryScriptedClient::new(vec![
            // Turn 0: two transient failures, then a successful read tool.
            transient_route_err(),
            transient_route_err(),
            Ok(ok_step(
                AgentStep::Tool(raw("read_file", &[("path", "notes.md")])),
                10,
                5,
            )),
            // Turn 1: finish (the client repeats this last entry).
            Ok(ok_step(
                AgentStep::Finish {
                    message: "47".to_string(),
                },
                7,
                3,
            )),
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "read notes",
            "",
            SECRET,
            &no_approval(),
            5,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.turns, 2, "two TURNS despite the retried provider calls");
        // The hash-chained audit verifies end to end.
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).unwrap() >= 2);
        // Exactly ONE model-call audit per BILLED turn (2), NOT one per provider attempt
        // (there were 3 + 1 = 4 provider calls but only 2 billed successes).
        let n_modelcall_audits: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE action = 'agent_loop.model_call'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            n_modelcall_audits, 2,
            "one model-call audit per BILLED turn, not per retry attempt"
        );
    }

    #[test]
    fn loop_billing_parity_a_retried_turn_counts_tokens_once() {
        // (Test 6) Billing parity: a turn that failed transiently twice before succeeding
        // counts tokens ONCE (only the successful attempt produced usage). The ledger total is
        // the success's usage, NOT inflated by the failed attempts.
        let root = TempDir::new("retry-billing");
        let db = Db::open_hub(&temp_path("retry-billing")).unwrap();
        agent_run::create_run(db.conn(), "r1", "do it", 1).unwrap();
        let client = RetryScriptedClient::new(vec![
            transient_route_err(),
            transient_route_err(),
            Ok(ok_step(
                AgentStep::Finish {
                    message: "done".to_string(),
                },
                10,
                5,
            )),
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "do it",
            "",
            SECRET,
            &no_approval(),
            5,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(client.provider_calls(), 3, "2 fails + 1 success");
        // EXACTLY one ledger row (the success); failed Route attempts billed nothing.
        assert_eq!(
            db.count("token_ledger").unwrap(),
            1,
            "a retried turn writes ONE ledger row, not one per attempt"
        );
        let tot = friday_storage::agent_run_read::run_token_totals(db.conn(), "r1").unwrap();
        assert_eq!(
            tot.total, 15,
            "ledger total is the success's usage (10+5), NOT inflated by retries"
        );
    }

    #[test]
    fn loop_unknown_tool_in_a_later_turn_blocks() {
        let root = TempDir::new("loop-unk");
        std::fs::write(root.0.join("a.md"), b"a").unwrap();
        let db = Db::open_hub(&temp_path("loop-unk")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read then frobnicate", 1).unwrap();
        let client = ScriptedAgentLlmClient::new(vec![
            AgentStep::Tool(raw("read_file", &[("path", "a.md")])), // turn 0: Allow + execute
            AgentStep::Tool(raw("frobnicate", &[])), // turn 1: unregistered → Blocked
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "read then frobnicate",
            "",
            SECRET,
            &no_approval(),
            5,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Blocked);
        assert_eq!(out.executed_tools, 1); // the read ran; the unknown tool was refused
        assert!(out.detail.contains("unregistered_tool:frobnicate"));
    }

    #[test]
    fn loop_exec_error_threads_back_and_continues() {
        let root = TempDir::new("loop-execerr");
        let db = Db::open_hub(&temp_path("loop-execerr")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read missing then finish", 1).unwrap();
        let client = ScriptedAgentLlmClient::new(vec![
            // turn 0: a read-only tool that is Allowed but FAILS at execution (missing file →
            // FsError::NotFound → exec_error) — the loop threads the error back and continues.
            // (search is now wired and would succeed, so read_file-on-missing is the failure.)
            AgentStep::Tool(raw("read_file", &[("path", "does-not-exist.txt")])),
            AgentStep::Finish {
                message: "ok".to_string(),
            }, // turn 1: finish (loop did NOT wedge on the error)
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "read missing then finish",
            "",
            SECRET,
            &no_approval(),
            5,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.turns, 2);
        assert_eq!(out.executed_tools, 0); // the exec_error did not count as executed
        let errs: i64 = db.conn().query_row("SELECT count(*) FROM agent_run_event WHERE run_id='r1' AND kind LIKE 'tool.exec_error%'", [], |r| r.get(0)).unwrap();
        assert_eq!(
            errs, 1,
            "the exec error was recorded and threaded back, not swallowed"
        );
        // #30: the error turn also wrote a hash-chained exec_failed receipt (atomic with
        // the event), so the chain reflects the failed dispatch and still verifies.
        let failed: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE action LIKE 'tool.exec_failed:%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            failed, 1,
            "the exec_error turn recorded one exec_failed receipt"
        );
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    // NOTE: the former `loop_approval_double_spend_across_turns_is_refused` (HMAC-mint
    // executes-once-then-replay-refused at the loop level) is superseded by S6d: the loop's
    // protected path is Ed25519-only, so an HMAC mint can no longer execute a mutation. The
    // execute-once + replay-refused property is now proven with an OPERATOR Ed25519 approval
    // in the integration test `tests/s6d_resume_ingestion.rs` (both at the loop level and
    // via the resume entrypoint) — it requires an operator SIGNING key, which
    // `friday-hub/src/**` is forbidden from referencing (the key-substitution defense).

    #[test]
    fn build_loop_prompt_renders_history() {
        let p = build_loop_prompt(
            "summarize",
            &[TurnTrace {
                action: "read_file".to_string(),
                params: vec![("path".to_string(), "a.md".to_string())],
                outcome: "executed: read 5 bytes from a.md".to_string(),
            }],
        );
        assert!(p.contains("read_file"));
        assert!(p.contains("executed: read 5 bytes from a.md"));
        assert!(p.contains("So far this run"));
        assert!(p.contains("\"none\"")); // the finish hint
                                         // No history → no history section.
        assert!(!build_loop_prompt("t", &[]).contains("So far this run"));
    }

    // --- S5: inbound conversation history + minimal sessions/resume -------------

    fn stored_msg(seq: i64, role: &str, content: &str) -> friday_storage::StoredSessionMessage {
        friday_storage::StoredSessionMessage {
            message_id: format!("s:m{seq}"),
            agent_session_id: "s".to_string(),
            seq,
            role: role.to_string(),
            content: content.to_string(),
            refs: None,
            created_at: seq,
        }
    }

    #[test]
    fn render_session_history_is_bounded_and_drops_oldest() {
        // Empty history → empty preamble (single-shot prompt unchanged).
        assert!(render_session_history(&[]).is_empty());

        // A short history renders both turns, labeled as CONTEXT (not the task).
        let small = render_session_history(&[
            stored_msg(0, "user", "remember 47"),
            stored_msg(1, "assistant", "noted 47"),
        ]);
        assert!(small.contains("Prior conversation in this session"));
        assert!(small.contains("user: remember 47"));
        assert!(small.contains("assistant: noted 47"));
        assert!(!small.contains(SESSION_HISTORY_OMISSION_MARKER));

        // Many LARGE messages → per-message + total caps hold; oldest dropped + flagged.
        let big: Vec<_> = (0..12)
            .map(|i| stored_msg(i, "user", &"Z".repeat(5000)))
            .collect();
        let rendered = render_session_history(&big);
        let zcount = rendered.chars().filter(|&c| c == 'Z').count();
        assert!(
            zcount <= MAX_SESSION_HISTORY_BYTES,
            "rendered history content must stay within the byte budget, got {zcount}"
        );
        assert!(
            rendered.contains(SESSION_HISTORY_OMISSION_MARKER),
            "older messages over budget must be flagged omitted"
        );
        // Per-message content was head-sliced (each 5000-byte message > the per-message
        // cap), so the truncation marker is present.
        assert!(rendered.contains(FEEDBACK_TRUNCATION_MARKER));
    }

    #[test]
    fn session_loop_prepends_prior_history_into_model_prompt() {
        let root = TempDir::new("s5-prompt");
        let db = Db::open_hub(&temp_path("s5-prompt")).unwrap();
        // Seed a session with prior turns (as a prior run would have left them).
        friday_storage::ensure_session(db.conn(), "sess-1", 1).unwrap();
        friday_storage::append_session_message(
            db.conn(),
            "sess-1",
            &friday_storage::SessionMessage::new(
                "user",
                "remember the number 47",
                Some("r0".into()),
            ),
            2,
        )
        .unwrap();
        friday_storage::append_session_message(
            db.conn(),
            "sess-1",
            &friday_storage::SessionMessage::new("assistant", "noted: 47", Some("r0".into())),
            3,
        )
        .unwrap();
        // A new run that finishes on turn 1.
        agent_run::create_run(db.conn(), "r1", "what number did I ask you to remember", 10)
            .unwrap();
        let client = CapturingAgentLlmClient::new(vec![AgentStep::Finish {
            message: "47".into(),
        }]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_session_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "sess-1",
            None,
            "what number did I ask you to remember",
            "",
            None,
            &no_approval(),
            &RunPolicy::default(),
            10,
            None, // cancel: not exercised by this test
            None, // steer: not exercised by this test
            10,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        let prompts = client.prompts.borrow();
        assert_eq!(prompts.len(), 1);
        // The turn-1 prompt carries the prior session history, labeled as context...
        assert!(
            prompts[0].contains("Prior conversation in this session"),
            "got: {}",
            prompts[0]
        );
        assert!(prompts[0].contains("remember the number 47"));
        assert!(prompts[0].contains("noted: 47"));
        // ...AND the current task is still present.
        assert!(prompts[0].contains("what number did I ask you to remember"));
        // This run appended its own user + assistant turns (2 -> 4 total), refs to r1.
        assert_eq!(
            friday_storage::session_message_count(db.conn(), "sess-1").unwrap(),
            4
        );
        let msgs = friday_storage::load_session_messages(db.conn(), "sess-1").unwrap();
        assert_eq!(msgs[2].role, "user");
        assert_eq!(msgs[2].content, "what number did I ask you to remember");
        assert_eq!(msgs[2].refs.as_deref(), Some("r1"));
        assert_eq!(msgs[3].role, "assistant");
        assert_eq!(msgs[3].content, "47");
        // The session event is REFS-ONLY: it carries the count, never the message text.
        let session_ev: String = db
            .conn()
            .query_row(
                "SELECT kind FROM agent_run_event WHERE event_id = 'r1:session'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(session_ev.contains("session.appended:sess-1:count=4"));
        assert!(
            !session_ev.contains("47"),
            "the event must not carry message text"
        );
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    #[test]
    fn session_resume_run2_sees_run1_message() {
        let root = TempDir::new("s5-resume");
        let db = Db::open_hub(&temp_path("s5-resume")).unwrap();
        let ex = FsToolExecutor::new(&root.0);
        // Run 1: fresh session, model finishes with an answer.
        agent_run::create_run(db.conn(), "r1", "remember my budget is 500", 10).unwrap();
        let c1 = CapturingAgentLlmClient::new(vec![AgentStep::Finish {
            message: "got it, budget 500".into(),
        }]);
        let o1 = run_session_loop(
            &c1,
            &ex,
            db.conn(),
            "r1",
            "sess-x",
            None,
            "remember my budget is 500",
            "",
            None,
            &no_approval(),
            &RunPolicy::default(),
            5,
            None, // cancel: not exercised by this test
            None, // steer: not exercised by this test
            10,
        )
        .unwrap();
        assert_eq!(o1.status, LoopStatus::Finished);
        // Run 1's prompt had NO prior history (fresh session).
        assert!(!c1.prompts.borrow()[0].contains("Prior conversation in this session"));

        // Run 2: SAME session, a new run — it must SEE run 1's turns (resume/continue).
        agent_run::create_run(db.conn(), "r2", "what is my budget", 20).unwrap();
        let c2 = CapturingAgentLlmClient::new(vec![AgentStep::Finish {
            message: "your budget is 500".into(),
        }]);
        let o2 = run_session_loop(
            &c2,
            &ex,
            db.conn(),
            "r2",
            "sess-x",
            None,
            "what is my budget",
            "",
            None,
            &no_approval(),
            &RunPolicy::default(),
            5,
            None, // cancel: not exercised by this test
            None, // steer: not exercised by this test
            20,
        )
        .unwrap();
        assert_eq!(o2.status, LoopStatus::Finished);
        let p2 = c2.prompts.borrow();
        assert_eq!(p2.len(), 1);
        // Continuity: run 2's prompt carries run 1's user task AND its assistant answer.
        assert!(
            p2[0].contains("remember my budget is 500"),
            "run 2 must see run 1's user turn, got: {}",
            p2[0]
        );
        assert!(
            p2[0].contains("got it, budget 500"),
            "run 2 must see run 1's assistant turn"
        );
        // Session now holds 4 messages: (user, assistant) x 2 runs, in order.
        let msgs = friday_storage::load_session_messages(db.conn(), "sess-x").unwrap();
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0].content, "remember my budget is 500");
        assert_eq!(msgs[0].refs.as_deref(), Some("r1"));
        assert_eq!(msgs[3].content, "your budget is 500");
        assert_eq!(msgs[3].refs.as_deref(), Some("r2"));
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    #[test]
    fn single_shot_run_loop_creates_no_session_state() {
        // The non-session entrypoint is UNCHANGED: it touches NO agent_session table.
        let root = TempDir::new("s5-single");
        std::fs::write(root.0.join("notes.md"), b"answer is 47").unwrap();
        let db = Db::open_hub(&temp_path("s5-single")).unwrap();
        agent_run::create_run(db.conn(), "r1", "read notes.md", 1).unwrap();
        let client = CapturingAgentLlmClient::new(vec![
            AgentStep::Tool(raw("read_file", &[("path", "notes.md")])),
            AgentStep::Finish {
                message: "47".into(),
            },
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "read notes.md",
            "",
            SECRET,
            &no_approval(),
            10,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        // No session rows created by the single-shot path.
        assert_eq!(db.count("agent_session").unwrap(), 0);
        assert_eq!(db.count("agent_session_message").unwrap(), 0);
        // And no session prompt label leaked into the single-shot prompts.
        assert!(!client.prompts.borrow()[0].contains("Prior conversation in this session"));
    }

    #[test]
    fn session_loop_bounds_oversized_history_in_prompt() {
        // End-to-end bound: a session with many LARGE prior messages must not blow the
        // prompt — the rendered history is capped and the oldest are flagged omitted.
        let root = TempDir::new("s5-bound");
        let db = Db::open_hub(&temp_path("s5-bound")).unwrap();
        friday_storage::ensure_session(db.conn(), "big", 1).unwrap();
        for i in 0..12 {
            friday_storage::append_session_message(
                db.conn(),
                "big",
                &friday_storage::SessionMessage::new("user", "Z".repeat(5000), None),
                2 + i,
            )
            .unwrap();
        }
        agent_run::create_run(db.conn(), "r1", "summarize", 100).unwrap();
        let client = CapturingAgentLlmClient::new(vec![AgentStep::Finish {
            message: "ok".into(),
        }]);
        let ex = FsToolExecutor::new(&root.0);
        run_session_loop(
            &client,
            &ex,
            db.conn(),
            "r1",
            "big",
            None,
            "summarize",
            "",
            None,
            &no_approval(),
            &RunPolicy::default(),
            5,
            None, // cancel: not exercised by this test
            None, // steer: not exercised by this test
            100,
        )
        .unwrap();
        let prompts = client.prompts.borrow();
        let zcount = prompts[0].chars().filter(|&c| c == 'Z').count();
        assert!(
            zcount <= MAX_SESSION_HISTORY_BYTES,
            "oversized session history must be bounded in the prompt, got {zcount}"
        );
        assert!(prompts[0].contains(SESSION_HISTORY_OMISSION_MARKER));
    }

    // ---- owner-wiring (D1 #587 parity for the sessioned path) -----------------

    /// A sessioned run bound to principal P persists its answer with
    /// `owner_principal == P`: the authenticated body projection Grants the body to P
    /// and fail-closed-denies everyone else (mismatch / anonymous). The refs-only
    /// projection stays body-free.
    #[test]
    fn sessioned_finished_run_answer_releasable_only_to_bound_owner() {
        use friday_storage::{AnswerDenyReason, RunAnswerAccess};
        let root = TempDir::new("s5-owner");
        let db = Db::open_hub(&temp_path("s5-owner")).unwrap();
        agent_run::create_run(db.conn(), "r1", "what is the answer", 10).unwrap();
        let client = CapturingAgentLlmClient::new(vec![AgentStep::Finish {
            message: "the answer is 47".into(),
        }]);
        let ex = FsToolExecutor::new(&root.0);
        let policy = RunPolicy::new(Some("alice".to_string()), Vec::<String>::new(), false);
        let out = run_session_loop(
            &client,
            &ex,
            db.conn(),
            "r1",
            "sess-owned",
            None,
            "what is the answer",
            "",
            None,
            &no_approval(),
            &policy,
            5,
            None, // cancel: not exercised by this test
            None, // steer: not exercised by this test
            10,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);

        // The OWNER reads the body back (Granted), with the recorded owner principal.
        match friday_storage::get_run_answer_for_principal(db.conn(), "r1", "alice").unwrap() {
            RunAnswerAccess::Granted(stored) => {
                assert_eq!(stored.answer, "the answer is 47");
                assert_eq!(stored.status, "finished");
                assert_eq!(stored.owner_principal.as_deref(), Some("alice"));
            }
            other => panic!("owner must be Granted the body, got {other:?}"),
        }
        // A NON-owner principal is denied (body withheld).
        assert_eq!(
            friday_storage::get_run_answer_for_principal(db.conn(), "r1", "mallory").unwrap(),
            RunAnswerAccess::Denied(AnswerDenyReason::PrincipalMismatch)
        );
        // An anonymous / public caller never reads a body.
        for anon in ["", "public", "public:default"] {
            assert_eq!(
                friday_storage::get_run_answer_for_principal(db.conn(), "r1", anon).unwrap(),
                RunAnswerAccess::Denied(AnswerDenyReason::AnonymousCaller),
                "anonymous caller {anon:?} must be denied"
            );
        }
        // The refs-only proof projection is unchanged: fingerprint, never the body.
        let r = friday_storage::get_run_result_ref(db.conn(), "r1")
            .unwrap()
            .unwrap();
        assert_eq!(r.answer_len, "the answer is 47".len() as i64);
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

    /// A sessioned run with NO bound principal records NO owner — its persisted answer
    /// body is unreadable by EVERYONE (fail-closed; same as an ownerless legacy row).
    #[test]
    fn sessioned_run_without_principal_persists_ownerless_fail_closed_result() {
        use friday_storage::{AnswerDenyReason, RunAnswerAccess};
        let root = TempDir::new("s5-noowner");
        let db = Db::open_hub(&temp_path("s5-noowner")).unwrap();
        agent_run::create_run(db.conn(), "r1", "say hi", 10).unwrap();
        let client = CapturingAgentLlmClient::new(vec![AgentStep::Finish {
            message: "hi".into(),
        }]);
        let ex = FsToolExecutor::new(&root.0);
        let out = run_session_loop(
            &client,
            &ex,
            db.conn(),
            "r1",
            "sess-anon",
            None,
            "say hi",
            "",
            None,
            &no_approval(),
            &RunPolicy::default(), // no principal bound
            5,
            None, // cancel: not exercised by this test
            None, // steer: not exercised by this test
            10,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        // The result IS persisted (the answer store has the row)...
        let stored = friday_storage::get_run_result(db.conn(), "r1")
            .unwrap()
            .unwrap();
        assert_eq!(stored.owner_principal, None, "no principal ⇒ no owner");
        // ...but the body is releasable to NO ONE — not even a real principal.
        for caller in ["alice", "mallory", ""] {
            assert_eq!(
                friday_storage::get_run_answer_for_principal(db.conn(), "r1", caller).unwrap(),
                RunAnswerAccess::Denied(AnswerDenyReason::NoOwnerPrincipal),
                "ownerless row must deny caller {caller:?}"
            );
        }
    }

    /// A NON-Finished sessioned outcome persists NO run_result: the Paused run's
    /// `run_result` slot belongs to the resume completion leg (collision discipline,
    /// mirrors `run_task`). The user turn is still recorded for the session.
    #[test]
    fn paused_sessioned_run_persists_no_run_result() {
        let root = TempDir::new("s5-paused");
        let db = Db::open_hub(&temp_path("s5-paused")).unwrap();
        agent_run::create_run(db.conn(), "r1", "delete the old backup db", 10).unwrap();
        let client = CapturingAgentLlmClient::new(vec![AgentStep::Tool(raw(
            "delete_file",
            &[("path", "backups/old.db")],
        ))]);
        let ex = FsToolExecutor::new(&root.0);
        let policy = RunPolicy::new(Some("alice".to_string()), Vec::<String>::new(), false);
        let out = run_session_loop(
            &client,
            &ex,
            db.conn(),
            "r1",
            "sess-paused",
            None,
            "delete the old backup db",
            "",
            None,
            &no_approval(),
            &policy,
            5,
            None, // cancel: not exercised by this test
            None, // steer: not exercised by this test
            10,
        )
        .unwrap();
        assert_eq!(
            out.status,
            LoopStatus::Paused,
            "mutation w/o approval pauses"
        );
        assert_eq!(
            friday_storage::get_run_result(db.conn(), "r1").unwrap(),
            None,
            "a paused run must leave its run_result slot to the resume leg"
        );
        // The session still recorded the user turn (the operator asked it).
        assert_eq!(
            friday_storage::session_message_count(db.conn(), "sess-paused").unwrap(),
            1
        );
    }

    /// `session_owner: Some(..)` BINDS the session's owner axes at creation, making the
    /// memory namespace RESOLVABLE for the Rust inline extraction — and a later
    /// owner-less run on the same session does not clobber the bound owner.
    #[test]
    fn session_loop_binds_supplied_owner_and_namespace_resolves() {
        let root = TempDir::new("s5-bind");
        let db = Db::open_hub(&temp_path("s5-bind")).unwrap();
        let ex = FsToolExecutor::new(&root.0);
        let owner = friday_storage::SessionOwner {
            account_id: Some("default".into()),
            channel: Some("discord".into()),
            user_id: Some("alice".into()),
            ..Default::default()
        };
        agent_run::create_run(db.conn(), "r1", "remember 47", 10).unwrap();
        let c1 = CapturingAgentLlmClient::new(vec![AgentStep::Finish {
            message: "noted".into(),
        }]);
        run_session_loop(
            &c1,
            &ex,
            db.conn(),
            "r1",
            "sess-bound",
            Some(&owner),
            "remember 47",
            "",
            None,
            &no_approval(),
            &RunPolicy::default(),
            5,
            None, // cancel: not exercised by this test
            None, // steer: not exercised by this test
            10,
        )
        .unwrap();
        // The session was created OWNED...
        let back = friday_storage::load_session_owner(db.conn(), "sess-bound")
            .unwrap()
            .unwrap();
        assert_eq!(back.user_id.as_deref(), Some("alice"));
        // ...and its memory namespace resolves (the extraction fail-closed gate opens).
        let ns = crate::session_namespace::resolve_session_memory_namespace(
            back.account_id.as_deref(),
            back.channel.as_deref(),
            back.user_id.as_deref(),
        )
        .unwrap();
        assert_eq!(ns, "tenant.default.channel.discord.user.alice.shared");

        // A second, owner-less run on the SAME session keeps the bound owner (no clobber).
        agent_run::create_run(db.conn(), "r2", "and now?", 20).unwrap();
        let c2 = CapturingAgentLlmClient::new(vec![AgentStep::Finish {
            message: "still noted".into(),
        }]);
        run_session_loop(
            &c2,
            &ex,
            db.conn(),
            "r2",
            "sess-bound",
            None,
            "and now?",
            "",
            None,
            &no_approval(),
            &RunPolicy::default(),
            5,
            None, // cancel: not exercised by this test
            None, // steer: not exercised by this test
            20,
        )
        .unwrap();
        let back = friday_storage::load_session_owner(db.conn(), "sess-bound")
            .unwrap()
            .unwrap();
        assert_eq!(
            back.user_id.as_deref(),
            Some("alice"),
            "owner-less re-run must not erase the bound owner"
        );
    }

    /// `session_owner: None` keeps the OWNER-AXIS / session-ensure path bit-for-bit: the
    /// session carries NULL owner axes (extraction stays fail-closed for it). HONEST scope
    /// (review LOW-a): this only covers the ensure/owner-axis path. The Finished-persist
    /// step now writes an OWNERLESS `run_result` row even for `None` — asserted here to be
    /// fail-closed (unreadable to everyone), NOT absent.
    #[test]
    fn session_loop_without_owner_creates_unowned_session_unchanged() {
        let root = TempDir::new("s5-unowned");
        let db = Db::open_hub(&temp_path("s5-unowned")).unwrap();
        let ex = FsToolExecutor::new(&root.0);
        agent_run::create_run(db.conn(), "r1", "hello", 10).unwrap();
        let client = CapturingAgentLlmClient::new(vec![AgentStep::Finish {
            message: "hi".into(),
        }]);
        run_session_loop(
            &client,
            &ex,
            db.conn(),
            "r1",
            "sess-null",
            None,
            "hello",
            "",
            None,
            &no_approval(),
            &RunPolicy::default(),
            5,
            None, // cancel: not exercised by this test
            None, // steer: not exercised by this test
            10,
        )
        .unwrap();
        let back = friday_storage::load_session_owner(db.conn(), "sess-null")
            .unwrap()
            .unwrap();
        assert_eq!(back, friday_storage::SessionOwner::default());
        // The namespace stays UNRESOLVABLE — fail-closed, exactly as before this lane.
        assert!(crate::session_namespace::resolve_session_memory_namespace(
            back.account_id.as_deref(),
            back.channel.as_deref(),
            back.user_id.as_deref(),
        )
        .is_err());
        // HONEST (review LOW-a): with `None` AND no bound principal the Finished-persist DOES
        // write a run_result row (the pre-wiring loop wrote none here) — but it is OWNERLESS
        // and so Denied to EVERYONE (fail-closed/leakless), NOT readable and NOT absent.
        use friday_storage::{AnswerDenyReason, RunAnswerAccess};
        let row = friday_storage::get_run_result(db.conn(), "r1").unwrap();
        assert!(
            row.is_some(),
            "the Finished-persist writes a row even for session_owner: None"
        );
        assert_eq!(row.unwrap().owner_principal, None, "the row is ownerless");
        assert_eq!(
            friday_storage::get_run_answer_for_principal(db.conn(), "r1", "anyone").unwrap(),
            RunAnswerAccess::Denied(AnswerDenyReason::NoOwnerPrincipal),
            "an ownerless row is unreadable by everyone (fail-closed)"
        );
    }
}

#[cfg(test)]
mod ask_coupling_tests {
    use super::*;
    use friday_storage::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "friday-hub-ask-{}-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed),
                nanos
            ))
            .to_string_lossy()
            .into_owned()
    }

    /// Canned DeepSeek transport: GET /models → one model; POST /chat → a completion
    /// with usage (or a route failure when `post_fails`).
    struct MockTransport {
        post_fails: bool,
    }
    impl friday_deepseek::Transport for MockTransport {
        fn get_json(
            &self,
            _url: &str,
            _bearer: &str,
        ) -> Result<serde_json::Value, friday_deepseek::DeepSeekError> {
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &serde_json::Value,
        ) -> Result<serde_json::Value, friday_deepseek::DeepSeekError> {
            if self.post_fails {
                return Err(friday_deepseek::DeepSeekError::ProviderUnavailable(
                    "simulated".to_string(),
                ));
            }
            Ok(serde_json::json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":"hello"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
            }))
        }
    }
    // MockTransport is only used to construct a client; suppress dead-field warning paths.
    impl MockTransport {
        fn new(post_fails: bool) -> Self {
            Self { post_fails }
        }
    }

    #[test]
    fn deepseek_metered_surfaces_usage_even_when_content_does_not_parse() {
        // DeepSeek-client-level proof of bill-on-chat-success: MockTransport's chat 200s
        // with usage {10,5,15} but content "hello" — NOT a tool-call object. The metered
        // seam returns (Err(parse), Some(outcome)) so the loop bills the spent call (the
        // S1.1 parse-error mode) instead of dropping the usage with the parse error.
        let client = DeepSeekAgentLlmClient::new(friday_deepseek::DeepSeekClient::with_transport(
            MockTransport::new(false),
            "k".into(),
        ));
        let (parsed, usage) = client.next_step_metered("task", &[]).unwrap();
        assert!(
            matches!(parsed, Err(AgentError::Parse(_))),
            "non-tool-call content must fail the contract parse"
        );
        let outcome = usage.expect("a successful chat must surface usage to bill");
        // C2: usage is now the neutral `BilledUsage` (no stored `total_tokens` — the ledger
        // computes it from the parts). The DeepSeek adapter tags it DeepSeek.
        assert_eq!(outcome.provider_kind, friday_core::ProviderKind::DeepSeek);
        assert_eq!(outcome.prompt_tokens, 10);
        assert_eq!(outcome.completion_tokens, 5);
        assert_eq!(outcome.prompt_tokens + outcome.completion_tokens, 15);
        assert_eq!(outcome.model, "deepseek-v4-flash");
    }

    #[test]
    fn deepseek_metered_route_failure_surfaces_no_usage() {
        // A transport/route failure is an OUTER Err: no usage produced, nothing to bill
        // (the ask path's `Route` error — no half-billed row). It now carries the STRUCTURED
        // `DeepSeekError` (`AgentError::Route`) so the run_loop can classify it for retry —
        // here the simulated `ProviderUnavailable` is the transient (`Retryable`) kind.
        let client = DeepSeekAgentLlmClient::new(friday_deepseek::DeepSeekClient::with_transport(
            MockTransport::new(true),
            "k".into(),
        ));
        assert!(matches!(
            client.next_step_metered("task", &[]),
            Err(AgentError::Route(
                friday_deepseek::DeepSeekError::ProviderUnavailable(_)
            ))
        ));
    }

    #[test]
    fn record_friday_ask_writes_exactly_one_atomic_ledger_activity_audit() {
        let mut db = Db::open_hub(&tmp("ok")).unwrap();
        let client =
            friday_deepseek::DeepSeekClient::with_transport(MockTransport::new(false), "k".into());
        let out = record_friday_ask(&mut db, &client, "l1", "s1", "a1", "hi", 128, 1000).unwrap();
        assert_eq!(out.total_tokens, 15);
        // The COUPLING: one billable call ⇒ EXACTLY one ledger row + one activity receipt
        // + one hash-chained audit entry (all in one tx). count("token_ledger")==1 is also
        // the discovery-not-billed proof: the GET /models added no row.
        assert_eq!(
            db.count("token_ledger").unwrap(),
            1,
            "exactly one ledger row"
        );
        assert_eq!(
            db.count("activity_item").unwrap(),
            1,
            "one activity receipt"
        );
        assert_eq!(
            friday_storage::audit::verify_audit_chain(db.conn()).unwrap(),
            1,
            "one hash-chained audit entry, chain verifies"
        );
        // Pin the SHAPE (Reviewer-A): the persisted rows are specifically the model-call
        // receipt + audit, not just "some" row.
        let (kind, state): (String, String) = db
            .conn()
            .query_row(
                "SELECT type, state FROM activity_item WHERE activity_id='a1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(kind, "ask_receipt");
        assert_eq!(state, "done");
        let action: String = db
            .conn()
            .query_row(
                "SELECT action FROM audit_ledger WHERE audit_id='l1:modelcall'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(action, "friday_ask.model_call");
    }

    #[test]
    fn route_failure_writes_no_ledger_row() {
        let mut db = Db::open_hub(&tmp("fail")).unwrap();
        let client =
            friday_deepseek::DeepSeekClient::with_transport(MockTransport::new(true), "k".into());
        let err =
            record_friday_ask(&mut db, &client, "l1", "s1", "a1", "hi", 128, 1000).unwrap_err();
        assert!(matches!(err, RecordAskError::Route(_)), "got {err}");
        // No half-billed row / orphan activity / audit on a route failure.
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("activity_item").unwrap(), 0);
        assert_eq!(
            friday_storage::audit::verify_audit_chain(db.conn()).unwrap(),
            0
        );
    }

    /// Token-safety (audit 10A): model DISCOVERY (the `GET /models` round-trip) is NOT
    /// billed. `record_friday_ask`'s one-row test proves discovery added no row *alongside*
    /// a chat; this isolates discovery ON ITS OWN — a `discover_models()` call with NO
    /// chat leaves the token ledger (and the whole billing surface) empty. It is unbillable
    /// by construction: `discover_models` takes no `&Db` and never reaches
    /// `record_model_call`, so only an actual completion (`chat`) can ever write a row.
    #[test]
    fn model_discovery_get_alone_is_not_billed() {
        let db = Db::open_hub(&tmp("discover")).unwrap();
        let client =
            friday_deepseek::DeepSeekClient::with_transport(MockTransport::new(false), "k".into());
        // The GET /models round-trip happens (returns the live model id)…
        let models = client.discover_models().unwrap();
        assert!(
            models.iter().any(|m| m == "deepseek-v4-flash"),
            "discovery returned the model, so the GET really ran"
        );
        // …yet nothing is billed: no ledger row, no activity receipt, no audit entry.
        assert_eq!(
            db.count("token_ledger").unwrap(),
            0,
            "model discovery is a free GET — it must never write a token_ledger row"
        );
        assert_eq!(db.count("activity_item").unwrap(), 0);
        assert_eq!(
            friday_storage::audit::verify_audit_chain(db.conn()).unwrap(),
            0
        );
    }

    // --- PROOF-MEMORY-001 recall-fed ask (answer + ledger + recall on one surface) ----

    /// A transport that ECHOES the outgoing prompt into the answer content. So if the
    /// recalled marker reached the prompt (via the recall preamble), it appears in
    /// `outcome.content` — a deterministic proof of the recall→prompt→answer round-trip
    /// (a REAL model deciding to use the memory is the separate live e2e).
    struct EchoTransport;
    impl friday_deepseek::Transport for EchoTransport {
        fn get_json(
            &self,
            _url: &str,
            _bearer: &str,
        ) -> Result<serde_json::Value, friday_deepseek::DeepSeekError> {
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            body: &serde_json::Value,
        ) -> Result<serde_json::Value, friday_deepseek::DeepSeekError> {
            // Echo the request body (which carries the prompt) back as the answer.
            let echoed = body.to_string();
            Ok(serde_json::json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content": echoed},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
            }))
        }
    }

    fn seed_owned_confirmed(db: &Db, id: &str, content: &str, principal: &str) {
        friday_storage::memory::record_candidate(
            db.conn(),
            &friday_storage::memory::NewMemoryCandidate {
                memory_id: id,
                scope: friday_core::MemoryScope::Global,
                content_ref: None,
                content: Some(content),
                principal_id: Some(principal),
                sensitive: false,
                created_at: 1,
            },
        )
        .unwrap();
        friday_storage::memory::confirm(db.conn(), id, 2).unwrap();
    }

    #[test]
    fn ask_with_recall_answer_carries_marker_and_is_ledgered_and_audited() {
        let mut db = Db::open_hub(&tmp("recall-ask")).unwrap();
        seed_owned_confirmed(&db, "m1", "The codename is FRIDAYMARKER-DET-91A2.", "owner");
        let client = friday_deepseek::DeepSeekClient::with_transport(EchoTransport, "k".into());
        let out = record_friday_ask_with_recall(
            &mut db,
            &client,
            Some("owner"),
            "l1",
            "s1",
            "a1",
            "What is the codename?",
            256,
            1000,
        )
        .unwrap();
        // ANSWER carries the recalled marker (it reached the prompt via recall → echoed back).
        assert!(
            out.content.contains("FRIDAYMARKER-DET-91A2"),
            "recalled marker must reach the answer: {:?}",
            out.content
        );
        // LEDGERED: exactly one token_ledger row for the billable call.
        assert_eq!(db.count("token_ledger").unwrap(), 1);
        // AUDITED: the model-call audit + the memory.recalled receipt are both chained.
        let recall_audit: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE action LIKE 'memory.recalled%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(recall_audit, 1, "a memory.recalled receipt was recorded");
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).unwrap() >= 2);
    }

    #[test]
    fn ask_without_principal_recalls_nothing() {
        let mut db = Db::open_hub(&tmp("recall-ask-none")).unwrap();
        seed_owned_confirmed(&db, "m1", "The codename is FRIDAYMARKER-NONE.", "owner");
        let client = friday_deepseek::DeepSeekClient::with_transport(EchoTransport, "k".into());
        let out = record_friday_ask_with_recall(
            &mut db,
            &client,
            None, // no principal ⇒ no recall
            "l1",
            "s1",
            "a1",
            "What is the codename?",
            256,
            1000,
        )
        .unwrap();
        assert!(!out.content.contains("FRIDAYMARKER-NONE"));
        let recall_audit: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE action LIKE 'memory.recalled%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(recall_audit, 0);
        // a plain ask is still billed (the model call happened, just without recall).
        assert_eq!(db.count("token_ledger").unwrap(), 1);
    }

    #[test]
    fn ask_with_recall_gates_sensitive_memory_out_of_the_answer() {
        // Pins the Passport gate DIRECTLY on the ask surface (defense against a future
        // refactor that bypasses the shared recall_preamble_for chokepoint): a sensitive
        // memory must NOT reach the answer under v1 deny-all, while a non-sensitive one does.
        let mut db = Db::open_hub(&tmp("recall-ask-sens")).unwrap();
        seed_owned_confirmed(&db, "ok", "codename FRIDAYMARKER-OK is public.", "owner");
        friday_storage::memory::record_candidate(
            db.conn(),
            &friday_storage::memory::NewMemoryCandidate {
                memory_id: "sens",
                scope: friday_core::MemoryScope::Global,
                content_ref: None,
                content: Some("home address FRIDAYMARKER-SECRET"),
                principal_id: Some("owner"),
                sensitive: true,
                created_at: 1,
            },
        )
        .unwrap();
        friday_storage::memory::confirm(db.conn(), "sens", 2).unwrap();
        let client = friday_deepseek::DeepSeekClient::with_transport(EchoTransport, "k".into());
        let out = record_friday_ask_with_recall(
            &mut db,
            &client,
            Some("owner"),
            "l1",
            "s1",
            "a1",
            "tell me",
            256,
            1000,
        )
        .unwrap();
        assert!(
            out.content.contains("FRIDAYMARKER-OK"),
            "non-sensitive memory should inject"
        );
        assert!(
            !out.content.contains("FRIDAYMARKER-SECRET"),
            "a sensitive memory must NOT reach the answer under deny-all: {:?}",
            out.content
        );
    }

    #[test]
    #[ignore = "live: requires FRIDAY_DEEPSEEK_API_KEY; run manually (PROOF-MEMORY-001 proof). \
                The locked credential file is /private/tmp/friday-closure-20260530/.deepseek-env; \
                source it, never print the key (07 §2.5)."]
    fn live_ask_with_recall_answer_carries_marker() {
        // SAVE a confirmed memory whose fact is obtainable ONLY via recall, then ASK for it.
        // A recall-fed answer that carries the marker is the full PROOF-MEMORY-001 trace
        // (answer + token-ledger + recall + hash-chained audit) on one surface. If a real
        // model does not use the injected memory, this fails → proof_pending (model
        // behaviour), NOT a mechanism defect.
        let mut db = Db::open_hub(&tmp("live-recall-ask")).unwrap();
        let marker = "FRIDAY-RECALL-PROOF-7F3A9C2D";
        seed_owned_confirmed(
            &db,
            "proof-mem",
            &format!("The project's secret codename is {marker}. Remember it exactly."),
            "owner",
        );
        let client = friday_deepseek::DeepSeekClient::from_env()
            .expect("FRIDAY_DEEPSEEK_API_KEY set (sourced from the locked credential file)");
        let out = record_friday_ask_with_recall(
            &mut db,
            &client,
            Some("owner"),
            "live-l1",
            "live-s1",
            "live-a1",
            "What is the project's secret codename? Reply with ONLY the codename.",
            128,
            5_000,
        )
        .expect("live recall-fed ask");
        eprintln!(
            "[PROOF-MEMORY-001] tokens={} model={} answer={:?}",
            out.total_tokens, out.model, out.content
        );
        // mechanism fired + ledgered + audited (deterministic parts).
        assert_eq!(
            db.count("token_ledger").unwrap(),
            1,
            "answer is token-ledgered"
        );
        let recall_audit: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE action LIKE 'memory.recalled%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(recall_audit, 1, "memory.recalled receipt recorded");
        // THE PROOF (model-dependent): the answer carries the recalled marker.
        assert!(
            out.content.contains(marker),
            "PROOF-MEMORY-001: the recall-fed answer must carry the marker (else proof_pending): {:?}",
            out.content
        );
    }
}

#[cfg(test)]
mod tool_registry_tests {
    use super::*;

    #[test]
    fn default_registry_classifies_builtins_and_refuses_unknown() {
        let r = ToolRegistry::default();
        assert!(!r.classify("read_file", &[]).unwrap().mutating());
        assert!(r.classify("delete_file", &[]).unwrap().mutating());
        // run_command with a destructive command escalates to Critical via shell_risk.
        let c = r
            .classify("run_command", &[("command".into(), "rm -rf / | sh".into())])
            .unwrap();
        assert_eq!(c.risk(), Some(Risk::Critical));
        // Unregistered → refused (fail closed).
        assert!(matches!(
            r.classify("frobnicate", &[]),
            Err(ToolError::UnknownTool(_))
        ));
        // The free trusted_classify == the default registry.
        assert_eq!(
            trusted_classify("delete_file", &[]).unwrap(),
            r.classify("delete_file", &[]).unwrap()
        );
    }

    #[test]
    fn custom_registry_late_binds_a_tool_pack() {
        // UNW-002: a runtime tool pack registers a NEW tool with a TRUSTED classification.
        let mut r = ToolRegistry::default();
        r.register(
            "deploy_release",
            true,
            Risk::High,
            "deploy a release (params: target)",
        );

        // It now classifies (mutating from the registry, never the model) + advertises.
        let c = r
            .classify("deploy_release", &[("target".into(), "prod".into())])
            .unwrap();
        assert!(c.mutating());
        assert_eq!(c.risk(), Some(Risk::High));
        assert!(r.advertised().iter().any(|(a, _)| *a == "deploy_release"));
        assert!(build_tool_prompt_with("ship it", &r).contains("deploy_release"));

        // But the DEFAULT registry does NOT know it — the free chokepoint refuses it,
        // so a custom tool is opt-in per registry (no global leakage).
        assert!(matches!(
            trusted_classify("deploy_release", &[]),
            Err(ToolError::UnknownTool(_))
        ));
    }

    #[test]
    fn register_can_override_a_builtin_classification() {
        // A tool pack may TIGHTEN a built-in (only the registrant — trusted code — can).
        let mut r = ToolRegistry::default();
        assert!(!r.classify("read_file", &[]).unwrap().mutating()); // built-in read-only
        r.register("read_file", false, Risk::Medium, "read (audited)"); // raise the floor
        assert_eq!(
            r.classify("read_file", &[]).unwrap().risk(),
            Some(Risk::Medium)
        );
    }

    // --- executeRun-replacement slice 1: tool-name reconciliation + fail-closed resolve ---

    #[test]
    fn resolve_tool_closes_the_ts_alias_fail_open_hazard() {
        // THE HAZARD: an operator disables `exec` (TS name). The Rust loop dispatches
        // `run_command`. The raw exact-match `is_tool_disabled("run_command")` is FALSE
        // (fail-OPEN — the disabled tool would run). `resolve_tool` canonicalizes the
        // disabled entry `exec`→`run_command`, so the dispatched `run_command` is correctly
        // reported DisabledByPolicy.
        let policy = RunPolicy::new(None, ["exec".to_string()], false);
        assert_eq!(
            policy.resolve_tool("run_command"),
            ToolGate::DisabledByPolicy,
            "a TS-shaped disabled entry `exec` MUST disable the dispatched `run_command`"
        );
        // Proof the raw exact-match is the fail-open this slice closes (regression anchor):
        assert!(
            !policy.is_tool_disabled("run_command"),
            "raw exact-match does NOT catch the TS alias — that is the hazard resolve_tool fixes"
        );
        // Every TS alias closes its hazard the same way.
        for (ts, rust) in [
            ("read", "read_file"),
            ("write", "write_file"),
            ("edit", "edit_file"),
            ("exec", "run_command"),
        ] {
            let p = RunPolicy::new(None, [ts.to_string()], false);
            assert_eq!(
                p.resolve_tool(rust),
                ToolGate::DisabledByPolicy,
                "{ts}→{rust}"
            );
        }
    }

    #[test]
    fn resolve_tool_fails_closed_on_a_foreign_or_unknown_name() {
        // A foreign / mistyped action canonicalizes to nothing ⇒ UnknownFailClosed, NEVER
        // Allowed. It can therefore never sneak through as "not disabled".
        let policy = RunPolicy::default();
        for name in ["frobnicate", "read_file_x", "exe", "ls", ""] {
            assert_eq!(
                policy.resolve_tool(name),
                ToolGate::UnknownFailClosed,
                "foreign `{name}` must fail closed, never Allowed"
            );
        }
    }

    #[test]
    fn resolve_tool_is_a_noop_for_already_matching_rust_names() {
        // No-op proof: for an all-Rust input (the only kind the current loop produces),
        // resolve_tool agrees EXACTLY with the live is_tool_disabled boolean — the new path
        // only ever TIGHTENS, never loosens, an already-matching name.
        let disabled = RunPolicy::new(None, ["run_command".to_string()], false);
        assert_eq!(
            disabled.resolve_tool("run_command"),
            ToolGate::DisabledByPolicy
        );
        assert!(disabled.is_tool_disabled("run_command"));

        // A known Rust tool NOT in the disabled-set ⇒ Allowed, and is_tool_disabled FALSE.
        assert_eq!(disabled.resolve_tool("read_file"), ToolGate::Allowed);
        assert!(!disabled.is_tool_disabled("read_file"));

        // Cross-check over the full registry under an empty policy: Allowed ⇔ !disabled.
        let none = RunPolicy::default();
        for (action, _d) in ToolRegistry::default().advertised() {
            assert_eq!(none.resolve_tool(action), ToolGate::Allowed);
            assert_eq!(
                none.resolve_tool(action) == ToolGate::DisabledByPolicy,
                none.is_tool_disabled(action),
                "resolve_tool must agree with is_tool_disabled for the Rust name `{action}`"
            );
        }
    }

    #[test]
    fn resolve_tool_disabling_a_rust_name_also_matches_its_ts_alias_query() {
        // Symmetric translation: disabling by the RUST name `run_command` also resolves a
        // query for the TS alias `exec` as DisabledByPolicy (both canonicalize equally).
        let policy = RunPolicy::new(None, ["run_command".to_string()], false);
        assert_eq!(policy.resolve_tool("exec"), ToolGate::DisabledByPolicy);
        assert_eq!(
            policy.resolve_tool("run_command"),
            ToolGate::DisabledByPolicy
        );
    }
}
