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

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, ActorKind, ApprovalDecision,
    CanonicalApproval, GateDecision, MutatingActionRequest, Resource, CANONICAL_GATE_ISSUER,
};
use friday_core::{is_destructive_request, shell_risk, Risk};
use friday_storage::{agent_run, authorize_mutating_action, StorageError};
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
    /// The model/transport call itself failed (network, auth, bad response).
    Model(String),
    /// The model replied, but its output did not parse as a single valid tool-call
    /// object per the contract (prose, multiple objects, missing `tool`, bad JSON).
    Parse(String),
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentError::Model(m) => write!(f, "model_error: {m}"),
            AgentError::Parse(m) => write!(f, "parse_error: {m}"),
        }
    }
}

/// One step the model takes in a multi-turn loop: either propose a tool call
/// (untrusted) or declare the task finished. Termination is the model's `Finish` (the
/// `{"tool":"none"}` contract), bounded by `max_turns` in [`run_loop`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentStep {
    /// Propose an (untrusted) tool call — classified by the Hub, not trusted as-is.
    Tool(RawToolCall),
    /// The model considers the task complete; the loop stops (not a tool, not a no-op).
    Finish { message: String },
}

/// A record of one completed turn, threaded back to the model as conversation history
/// so the next step is informed by what already happened. `outcome` is a short,
/// Hub-authored summary (never raw secret material).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnTrace {
    pub action: String,
    pub params: Vec<(String, String)>,
    pub outcome: String,
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

impl<T: friday_deepseek::Transport> AgentLlmClient for DeepSeekAgentLlmClient<T> {
    fn propose_tool_call(&self, task: &str) -> Result<RawToolCall, AgentError> {
        let models = self
            .client
            .discover_models()
            .map_err(|e| AgentError::Model(format!("{e:?}")))?;
        let model = friday_deepseek::select_model(&models)
            .ok_or_else(|| AgentError::Model("no model available".to_string()))?;
        let prompt = build_tool_prompt(task);
        // 512 tokens is ample for one tool-call JSON object.
        let outcome = self
            .client
            .chat(&model, &prompt, 512)
            .map_err(|e| AgentError::Model(format!("{e:?}")))?;
        parse_tool_call(&outcome.content)
    }

    /// History-aware multi-turn step: the prompt includes prior turns + their outcomes
    /// so the model can build on them or finish. `{"tool":"none"}` parses to `Finish`.
    fn next_step(&self, task: &str, history: &[TurnTrace]) -> Result<AgentStep, AgentError> {
        let models = self
            .client
            .discover_models()
            .map_err(|e| AgentError::Model(format!("{e:?}")))?;
        let model = friday_deepseek::select_model(&models)
            .ok_or_else(|| AgentError::Model("no model available".to_string()))?;
        let prompt = build_loop_prompt(task, history);
        let outcome = self
            .client
            .chat(&model, &prompt, 512)
            .map_err(|e| AgentError::Model(format!("{e:?}")))?;
        parse_agent_step(&outcome.content)
    }
}

/// Tools advertised to the model. MUST stay aligned with `tool_spec` (the trusted
/// allow-list): a tool the model is told about but that `tool_spec` does not register
/// would be refused at `build_request`; a registered tool not advertised here simply
/// won't be proposed. The model can still NAME anything — the registry is the gate.
const ADVERTISED_TOOLS: &[(&str, &str)] = &[
    ("read_file", "read a file's contents (params: path)"),
    ("list_dir", "list a directory's entries (params: path)"),
    (
        "write_file",
        "create or replace a file (params: path, content)",
    ),
    ("edit_file", "modify part of a file (params: path, ...)"),
    ("delete_file", "delete a file (params: path)"),
    ("run_command", "run a shell command (params: command)"),
];

/// Build the tool-call prompt: the tool menu + the EXACT single-JSON-object output
/// contract the [`parse_tool_call`] reader enforces. Pure + deterministic.
pub fn build_tool_prompt(task: &str) -> String {
    let mut s = String::from(
        "You are Friday's tool-using agent. Pick exactly ONE tool to make progress.\n\
         Available tools:\n",
    );
    for (name, desc) in ADVERTISED_TOOLS {
        s.push_str(&format!("- {name}: {desc}\n"));
    }
    s.push_str(
        "\nReply with EXACTLY ONE JSON object and nothing else (no prose, no code fence \
         is required but tolerated), of the form:\n\
         {\"tool\": \"<tool name>\", \"parameters\": {\"<key>\": \"<value>\"}}\n\
         All parameter values must be strings. If no tool is needed, reply {\"tool\": \"none\"}.\n\n",
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
    if !history.is_empty() {
        s.push_str("\nSo far this run:\n");
        for (i, t) in history.iter().enumerate() {
            s.push_str(&format!("{}. {} → {}\n", i + 1, t.action, t.outcome));
        }
        s.push_str("If the task is now complete, reply {\"tool\": \"none\"}.\n");
    }
    s
}

/// Parse a model reply into an [`AgentStep`]: a strict [`parse_tool_call`] whose
/// sentinel `"none"` action (the finish contract) maps to [`AgentStep::Finish`];
/// every other (parsed) tool is a [`AgentStep::Tool`]. Fail-closed identically to
/// `parse_tool_call` on any contract violation.
pub fn parse_agent_step(content: &str) -> Result<AgentStep, AgentError> {
    let raw = parse_tool_call(content)?;
    if raw.action == "none" {
        Ok(AgentStep::Finish {
            message: String::new(),
        })
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

/// A tool the Hub is willing to run, and its TRUSTED risk classification. The
/// registry ([`tool_spec`]) is an allow-list: an action not in it is refused
/// ([`ToolError::UnknownTool`]) — never executed, never auto-allowed.
struct ToolSpec {
    /// Whether the action mutates state. This is the load-bearing bit the gate keys
    /// `requires_approval` on, and it comes from HERE, never from model output.
    mutating: bool,
    /// The tool's inherent risk floor (param inspection can only RAISE it).
    base_risk: Risk,
}

/// The trusted tool registry. Returns `None` for an unregistered action.
fn tool_spec(action: &str) -> Option<ToolSpec> {
    Some(match action {
        "read_file" | "list_dir" | "stat_file" | "search" => ToolSpec {
            mutating: false,
            base_risk: Risk::ReadOnly,
        },
        "write_file" | "edit_file" | "append_file" => ToolSpec {
            mutating: true,
            base_risk: Risk::Medium,
        },
        "delete_file" | "move_file" => ToolSpec {
            mutating: true,
            base_risk: Risk::High,
        },
        "run_command" => ToolSpec {
            mutating: true,
            base_risk: Risk::High,
        },
        _ => return None,
    })
}

/// Why a raw tool call could not be turned into an authorizable request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolError {
    /// The action is not in the trusted registry — refuse (fail closed).
    UnknownTool(String),
}

/// The trusted classification of a tool call: derived from the registry + an
/// inspection of the (model-controlled) params, NEVER from model-asserted fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classified {
    pub mutating: bool,
    pub risk: Option<Risk>,
    pub resource: Option<Resource>,
}

/// Classify a raw tool call from a TRUSTED source. `mutating` comes from the registry;
/// `risk` is the registry floor RAISED (never lowered) by what the params actually do
/// — a `run_command` whose command is destructive, or any param that the shared
/// `tool_policy` flags, escalates. `resource` is taken from a path/target param (bound
/// into the action digest). An unregistered action is refused. This is the single
/// trusted oracle for `mutating`/`risk`/`resource`; the model contributes only strings.
pub fn trusted_classify(
    action: &str,
    params: &[(String, String)],
) -> Result<Classified, ToolError> {
    let spec = tool_spec(action).ok_or_else(|| ToolError::UnknownTool(action.to_string()))?;
    let mut risk = spec.base_risk;
    for (key, value) in params {
        // A run_command's command argument is classified by the shell-risk scanner. A
        // shell metachar there is `ShellRisk::Blocked` → `Risk::Critical`, which the
        // gate maps to RequiresApproval (owner-approvable), not auto-Deny — consistent
        // with the gate's deliberate "this core never auto-grants/auto-denies a
        // mutating/high-risk action" design (the shell classifier's "refuse outright"
        // wording is about a single shell token, not the planning gate's decision).
        if action == "run_command" && (key == "command" || key == "cmd" || key == "argv") {
            let r = shell_risk(value).risk();
            if r > risk {
                risk = r;
            }
        }
        // Any param whose VALUE describes a destructive action raises risk to at least
        // High — applied to EVERY tool's params (incl. read-only ones) ON PURPOSE: a
        // destructive-looking argument is escalated regardless of the nominal tool, and
        // it can only ever RAISE risk (fail-safe over-planning, never a downgrade).
        if is_destructive_request(value) && risk < Risk::High {
            risk = Risk::High;
        }
    }
    // Resource id by a FIXED priority (path → target → file), NOT input-param order, so
    // it is order-independent like `canonical_params` (Reviewer-B NIT): reordering the
    // params can never change the derived resource / digest.
    let resource = ["path", "target", "file"]
        .iter()
        .find_map(|want| params.iter().find(|(k, _)| k == want))
        .map(|(_, v)| Resource {
            resource_type: "file".to_string(),
            id: Some(v.clone()),
            digest: None,
        });
    Ok(Classified {
        mutating: spec.mutating,
        risk: Some(risk),
        resource,
    })
}

/// Build the canonical [`MutatingActionRequest`] for a raw tool call. Deterministic:
/// the same call always yields byte-identical `canonical_action_bytes`, so an approval
/// minted over this request matches when the turn re-builds it.
///
/// **This is the single chokepoint that closes UNW-001.** `mutating`/`risk`/`resource`
/// come from [`trusted_classify`] (the registry + param inspection), NEVER from the
/// model — and [`RawToolCall`] has no such fields, so a model cannot even express the
/// "this destructive action is non-mutating" lie. An unregistered action is refused
/// here ([`ToolError::UnknownTool`]) and the turn never authorizes or executes it.
pub fn build_request(raw: &RawToolCall) -> Result<MutatingActionRequest, ToolError> {
    let classified = trusted_classify(&raw.action, &raw.params)?;
    Ok(MutatingActionRequest {
        action: raw.action.clone(),
        actor: friday_core::gate::Actor {
            kind: ActorKind::Agent,
            id: "hub-agent".to_string(),
            principal_id: None,
        },
        surface: "agent".to_string(),
        mutating: classified.mutating,
        risk: classified.risk,
        local_claims: vec![],
        resource: classified.resource,
        parameters: Some(canonical_params(&raw.params)),
        idempotency_key: None,
        plan_digest: None,
    })
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

/// A receipt of a tool execution: what ran + a short outcome summary. Recorded to the
/// agent_run event log AND the hash-chained audit ledger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolReceipt {
    pub action: String,
    pub summary: String,
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

/// The real executor: file reads/writes go through `friday-fs` hardened safe-open,
/// contained to a workspace `root` (NEVER `std::fs` on an agent-supplied path). This
/// slice implements `read_file` + the replace-write `write_file`; higher-risk
/// registered tools (`delete_file`, `run_command`, `list_dir`, ...) are intentionally
/// `Unsupported` here — they get their own safe primitives + adverse tests in a later
/// slice. Fail-closed in every arm.
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
        use std::io::{Read, Write};
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
                })
            }
            "write_file" => {
                let path = Self::param(params, "path")?;
                let content = Self::param(params, "content")?;
                let mut file = friday_fs::open_write_within_root(&self.root, path, true)
                    .map_err(ExecError::Fs)?;
                file.write_all(content.as_bytes()).map_err(ExecError::Io)?;
                Ok(ToolReceipt {
                    action: action.to_string(),
                    summary: format!("wrote {} bytes to {path}", content.len()),
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
/// Known error-path limitations (Reviewer-A NITs, tracked follow-up — happy path is
/// clean): (1) the outcome `agent_run` event autocommits BEFORE the audit-receipt tx,
/// so a SQLite error during the receipt commit leaves the event log ahead of the
/// hash-chained ledger; (2) `write_file` truncates-on-open (friday-fs `set_len(0)`),
/// so a mid-write I/O failure AFTER a successful open can leave a truncated file with
/// an event but no audit receipt (a missing-param write errors before the open, so it
/// does not truncate). The follow-up records an `exec_failed` audit receipt on the
/// error path and writes via temp+rename for atomicity.
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

    // Allow → real dispatch. Record the outcome event + a hash-chained audit receipt.
    match executor.execute(&raw.action, &raw.params) {
        Ok(receipt) => {
            agent_run::record_event(
                conn,
                &format!("{run_id}:t{turn_index}:outcome"),
                run_id,
                &format!("tool.executed:{}", receipt.summary),
                now_ms,
            )?;
            let tx = conn.unchecked_transaction()?;
            friday_storage::audit::append_audit(
                &tx,
                &format!("{run_id}:t{turn_index}:receipt"),
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
            agent_run::record_event(
                conn,
                &format!("{run_id}:t{turn_index}:outcome"),
                run_id,
                &format!("tool.exec_error:{e}"),
                now_ms,
            )?;
            Ok(TurnOutcome {
                decision: GateDecision::Allow,
                reason: format!("exec_error:{e}"),
                executed: false,
                plan_kind,
            })
        }
    }
}

// --- the multi-turn run loop -------------------------------------------------

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

/// Drive a MULTI-TURN agent loop: repeatedly ask the model for the next step (with
/// conversation history), and for each proposed tool run the SAME gate-mandatory
/// dispatch as [`run_one_turn_with_executor`] (authorize → execute only on `Allow` →
/// hash-chained receipt), threading the outcome back into history. The loop ends when
/// the model `Finish`es, a tool is `Paused`(RequiresApproval)/`Blocked`(Deny/unknown),
/// the client errors, or `max_turns` is hit (the bound — a runaway model cannot loop
/// forever).
///
/// `approve` is the owner-approval seam: given a mutating request, it returns a signed
/// [`CanonicalApproval`] iff the owner approved THIS action (in production this is the
/// phone-relayed owner-approval leg + Hub mint; in tests it mints-or-`None`). A
/// read-only action needs no approval (the gate `Allow`s it directly).
///
/// No-hidden-call invariant: the model is called EXACTLY once per loop turn (via
/// `next_step` — count == `turns`), and the executor EXACTLY once per `Allow`ed tool;
/// nothing calls the model or a tool outside this body. Note `executed_tools` counts
/// only Allowed tools that ALSO executed without error (so executor-calls == `executed_tools`
/// only when no exec error occurs — an erroring Allow is one executor call, zero
/// `executed_tools`, by deliberate honest accounting). All observable in the
/// `agent_run_event` log.
#[allow(clippy::too_many_arguments)]
pub fn run_loop(
    client: &dyn AgentLlmClient,
    executor: &dyn ToolExecutor,
    conn: &Connection,
    run_id: &str,
    task: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    max_turns: u64,
    now_ms: i64,
) -> Result<LoopOutcome, StorageError> {
    // Plan classification recorded ONCE (it is a property of the task, constant across
    // turns).
    let plan_kind = friday_core::classify_kind(task).map(|k| k.as_str());
    agent_run::record_event(
        conn,
        &format!("{run_id}:plan"),
        run_id,
        &format!("plan.{}", plan_kind.unwrap_or("none")),
        now_ms,
    )?;

    let mut history: Vec<TurnTrace> = Vec::new();
    let mut executed_tools: u64 = 0;

    for turn_index in 0..max_turns {
        let ev = |suffix: &str| format!("{run_id}:t{turn_index}:{suffix}");

        let step = match client.next_step(task, &history) {
            Ok(step) => step,
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

        let request = match build_request(&raw) {
            Ok(request) => request,
            Err(ToolError::UnknownTool(action)) => {
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
        };

        let approval = approve(&request);
        let record = authorize_mutating_action(conn, &request, approval.as_ref(), secret, now_ms)?;

        match record.decision {
            GateDecision::Allow => match executor.execute(&raw.action, &raw.params) {
                Ok(receipt) => {
                    agent_run::record_event(
                        conn,
                        &ev("outcome"),
                        run_id,
                        &format!("tool.executed:{}", receipt.summary),
                        now_ms,
                    )?;
                    let tx = conn.unchecked_transaction()?;
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
                        outcome: format!("executed: {}", receipt.summary),
                    });
                }
                Err(e) => {
                    agent_run::record_event(
                        conn,
                        &ev("outcome"),
                        run_id,
                        &format!("tool.exec_error:{e}"),
                        now_ms,
                    )?;
                    // A tool error is informative, not fatal: thread it back and let the
                    // model adapt on the next turn (still bounded by max_turns).
                    history.push(TurnTrace {
                        action: raw.action.clone(),
                        params: raw.params.clone(),
                        outcome: format!("exec_error: {e}"),
                    });
                }
            },
            GateDecision::RequiresApproval => {
                agent_run::record_event(
                    conn,
                    &ev("outcome"),
                    run_id,
                    &format!("tool.paused:requires_approval:{}", raw.action),
                    now_ms,
                )?;
                return Ok(LoopOutcome {
                    status: LoopStatus::Paused,
                    turns: turn_index + 1,
                    executed_tools,
                    final_message: None,
                    detail: format!("requires_approval:{}", raw.action),
                });
            }
            GateDecision::Deny => {
                agent_run::record_event(
                    conn,
                    &ev("outcome"),
                    run_id,
                    &format!("tool.blocked:deny:{}", record.reason),
                    now_ms,
                )?;
                return Ok(LoopOutcome {
                    status: LoopStatus::Blocked,
                    turns: turn_index + 1,
                    executed_tools,
                    final_message: None,
                    detail: format!("denied:{}", record.reason),
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
        dir.join(format!("friday-hub-tracer-{pid}-{tag}-{n}.sqlite"))
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
        assert!(request.mutating, "delete_file must classify mutating=true");
        // The trusted non-mutating case (read_file) is the only way to mutating=false.
        let ro = build_request(&RawToolCall {
            action: "read_file".to_string(),
            params: vec![],
        })
        .unwrap();
        assert!(!ro.mutating);
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
        assert!(c.mutating);
        assert_eq!(c.risk, Some(Risk::Critical));
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
        assert_eq!(a.resource, b.resource);
        assert_eq!(a.resource.unwrap().id, Some("p".to_string())); // `path` wins
    }

    // --- §5-PR2: prompt + strict parse (offline) ---

    #[test]
    fn build_tool_prompt_lists_tools_and_the_json_contract() {
        let p = build_tool_prompt("read notes.md");
        assert!(p.contains("read_file"));
        assert!(p.contains("delete_file"));
        assert!(p.contains("\"tool\""));
        assert!(p.contains("\"parameters\""));
        assert!(p.contains("read notes.md")); // the task is included
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
    fn parsed_call_flows_through_the_trusted_chokepoint() {
        // A parsed destructive call is still classified mutating by the registry — the
        // parse layer feeds the same chokepoint, it does not bypass it.
        let raw =
            parse_tool_call("{\"tool\":\"delete_file\",\"parameters\":{\"path\":\"x\"}}").unwrap();
        assert!(build_request(&raw).unwrap().mutating);
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
    fn unsupported_tool_errors_after_allow_without_panicking() {
        let root = TempDir::new("unsup");
        let db = Db::open_hub(&temp_path("exec-unsup")).unwrap();
        agent_run::create_run(db.conn(), "r1", "list the dir", 1).unwrap();
        // list_dir is registered + read-only → Allow → executor returns Unsupported.
        let client = MockAgentLlmClient {
            proposal: raw("list_dir", &[("path", ".")]),
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
        assert!(!out.executed, "unsupported tool did not complete");
        assert!(
            out.reason.starts_with("exec_error:"),
            "reason was {:?}",
            out.reason
        );
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

    #[test]
    fn loop_mutating_with_approval_across_turns_writes_to_disk() {
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
            SECRET,
            &mint_for_each(),
            10,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.executed_tools, 2); // a read AND an approved mutating write, across two turns
        assert_eq!(
            std::fs::read_to_string(root.0.join("out.md")).unwrap(),
            "produced"
        );
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
        agent_run::create_run(db.conn(), "r1", "list then finish", 1).unwrap();
        let client = ScriptedAgentLlmClient::new(vec![
            AgentStep::Tool(raw("list_dir", &[("path", ".")])), // turn 0: Allow but Unsupported → exec_error → continue
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
            "list then finish",
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
    }

    #[test]
    fn loop_approval_double_spend_across_turns_is_refused() {
        // Reviewer-B's highest-value gap: ONE pre-minted approval reused for two
        // IDENTICAL mutating writes on turns 0 and 1. Turn 0 writes; turn 1's same
        // single-use key is replay-refused → Deny → Blocked. One execution, one receipt.
        let root = TempDir::new("loop-dup");
        let db = Db::open_hub(&temp_path("loop-dup")).unwrap();
        agent_run::create_run(db.conn(), "r1", "write twice", 1).unwrap();
        let write = raw("write_file", &[("path", "x.txt"), ("content", "C")]);
        let request = build_request(&write).unwrap();
        let appr = mint_approval(&request, "ap-dup", SECRET, 1_000_000);
        let approve = move |_req: &MutatingActionRequest| Some(appr.clone());
        let client = ScriptedAgentLlmClient::new(vec![
            AgentStep::Tool(write.clone()),
            AgentStep::Tool(write.clone()),
            AgentStep::Finish {
                message: "x".to_string(),
            }, // never reached
        ]);
        let executor = FsToolExecutor::new(&root.0);
        let out = run_loop(
            &client,
            &executor,
            db.conn(),
            "r1",
            "write twice",
            SECRET,
            &approve,
            5,
            1000,
        )
        .unwrap();
        assert_eq!(out.status, LoopStatus::Blocked);
        assert_eq!(
            out.executed_tools, 1,
            "the single-use approval executes once; the replay is refused"
        );
        assert!(out.detail.contains("replay_refused"));
        let receipts: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE audit_id LIKE 'r1:t%:receipt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            receipts, 1,
            "exactly one receipt — the replayed turn produced none"
        );
        assert_eq!(std::fs::read_to_string(root.0.join("x.txt")).unwrap(), "C");
        assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());
    }

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
}
