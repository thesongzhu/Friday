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
//! The Hub is where provider credentials live. `friday-hub` depends on the
//! secret-bearing `friday-deepseek` / `friday-providers`; `friday-ffi` (phone) must
//! NOT. That boundary is the compile-time "no secret on phone" property, asserted
//! by `friday-arch-tests`.

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, ActorKind, ApprovalDecision,
    CanonicalApproval, GateDecision, MutatingActionRequest, Resource, CANONICAL_GATE_ISSUER,
};
use friday_storage::{agent_run, authorize_mutating_action, StorageError};
use rusqlite::Connection;

// --- the LLM seam ------------------------------------------------------------

/// A tool call the model proposes for a turn. (A real client parses this from a
/// model response; the mock returns a canned one.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolCallProposal {
    /// The tool/action name (e.g. `read_file`, `delete_file`).
    pub action: String,
    /// Whether the action mutates state (drives the gate's approval requirement).
    pub mutating: bool,
    /// The resource the action targets (bound into the action digest).
    pub resource: Option<Resource>,
    /// Tool parameters as key/value pairs; serialized deterministically into the
    /// request's `parameters` (so the approval issuer and the live re-check agree).
    pub params: Vec<(String, String)>,
}

/// The model-client seam (mirrors `friday-deepseek`'s `Transport` DI pattern). The
/// turn loop dispatches through this so it is unit-testable with a mock; the live
/// impl over `friday-deepseek` is the runtime-proven slice (not this tracer).
pub trait AgentLlmClient {
    fn propose_tool_call(&self, task: &str) -> ToolCallProposal;
}

/// A mock client that returns a fixed proposal — used by the tracer to prove the
/// composition without a live model call.
pub struct MockAgentLlmClient {
    pub proposal: ToolCallProposal,
}

impl AgentLlmClient for MockAgentLlmClient {
    fn propose_tool_call(&self, _task: &str) -> ToolCallProposal {
        self.proposal.clone()
    }
}

/// Real model-client adapter over `friday-deepseek` (establishes the secret-bearing
/// dependency + is the home of the future live `AgentLlmClient` impl). The live
/// model→tool-call parse is the runtime-proven slice; this tracer does not call it.
pub struct DeepSeekAgentLlmClient<T: friday_deepseek::Transport> {
    client: friday_deepseek::DeepSeekClient<T>,
}

impl<T: friday_deepseek::Transport> DeepSeekAgentLlmClient<T> {
    pub fn new(client: friday_deepseek::DeepSeekClient<T>) -> Self {
        Self { client }
    }
    /// Passthrough to the route's model discovery — the real `friday-deepseek` path
    /// the live client will build on.
    pub fn discover_models(&self) -> Result<Vec<String>, friday_deepseek::DeepSeekError> {
        self.client.discover_models()
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

/// Build the canonical [`MutatingActionRequest`] for a proposal. Deterministic:
/// the same proposal always yields byte-identical `canonical_action_bytes`, so an
/// approval minted over this request matches when the turn re-builds it.
///
/// **SECURITY CONTRACT for the live slice (do NOT trust the model here).** This
/// tracer copies `proposal.mutating` / `resource` / `params` straight from the
/// (mock) proposal. That is safe ONLY because the proposal is a fixed test fixture.
/// The gate keys `requires_approval` on `mutating`, so a live `AgentLlmClient` that
/// set these fields from raw model output could let a destructive action self-declare
/// `mutating=false` and bypass approval. The live `AgentLlmClient`/`ToolExecutor`
/// MUST derive `mutating` (and the risk/resource classification) from a TRUSTED tool
/// policy (e.g. `friday_core::tool_policy` / a per-tool mutating registry), never from
/// model-asserted fields. This is a binding requirement on the deferred runtime slice.
pub fn build_request(proposal: &ToolCallProposal) -> MutatingActionRequest {
    MutatingActionRequest {
        action: proposal.action.clone(),
        actor: friday_core::gate::Actor {
            kind: ActorKind::Agent,
            id: "hub-agent".to_string(),
            principal_id: None,
        },
        surface: "agent".to_string(),
        mutating: proposal.mutating,
        risk: None,
        local_claims: vec![],
        resource: proposal.resource.clone(),
        parameters: Some(canonical_params(&proposal.params)),
        idempotency_key: None,
        plan_digest: None,
    }
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
    // 1. The model proposes a tool call.
    let proposal = client.propose_tool_call(task);

    // 2. Plan classification, recorded as an event. event_id keys on the caller's
    //    monotonic `turn_index` (NOT `now_ms`) so consecutive turns never PK-collide
    //    on `agent_run_event.event_id` — this is what makes run_one_turn safely
    //    loopable (a real loop increments turn_index per turn).
    let plan_kind = friday_core::classify_kind(task).map(|k| k.as_str());
    agent_run::record_event(
        conn,
        &format!("{run_id}:t{turn_index}:plan"),
        run_id,
        &format!("plan.{}", plan_kind.unwrap_or("none")),
        now_ms,
    )?;

    // 3. Build the canonical request (deterministic, so a minted approval matches).
    let request = build_request(&proposal);

    // 4. Authorize — composes the pure gate decision, crypto digest/signature
    //    verification, expiry, and the single-use replay store.
    let record = authorize_mutating_action(conn, &request, approval, secret, now_ms)?;

    // 5. Execute ONLY on Allow (mock executor); record the outcome either way.
    let executed = matches!(record.decision, GateDecision::Allow);
    let outcome_kind = if executed {
        format!("tool.executed:{}", proposal.action)
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

    const SECRET: &[u8] = b"hub-signing-secret";

    fn read_only_proposal() -> ToolCallProposal {
        ToolCallProposal {
            action: "read_file".to_string(),
            mutating: false,
            resource: Some(Resource {
                resource_type: "file".to_string(),
                id: Some("notes.md".to_string()),
                digest: None,
            }),
            params: vec![("path".to_string(), "notes.md".to_string())],
        }
    }

    fn delete_proposal() -> ToolCallProposal {
        ToolCallProposal {
            action: "delete_file".to_string(),
            mutating: true,
            resource: Some(Resource {
                resource_type: "file".to_string(),
                id: Some("backups/old.db".to_string()),
                digest: None,
            }),
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
        let request = build_request(&proposal);
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
        let request = build_request(&proposal);
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
}
