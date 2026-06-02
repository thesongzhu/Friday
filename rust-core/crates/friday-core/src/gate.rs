//! Canonical mutating-action gate — **decision core** (file 39 §2 group A, PR-3a;
//! UNW-001 / cat-10 `security_approval_bound_principal_gate`). A faithful port of
//! the TS oracle's `friday-mutating-action-gate.ts` *decision* logic only.
//!
//! Pure: no I/O, no crypto, no SHA-256. It encodes the approval-required **policy**
//! and the bound-principal rule, and is **fail-closed by construction** — there is
//! NO `canonical_approval` field and NO approval→`Allow` path here, so a mutating
//! or `risk >= High` action can only ever resolve to `RequiresApproval` (or `Deny`),
//! **never `Allow`**. The cryptographic approval *binding* (digest match, HMAC
//! signature, expiry, single-use replay) that can upgrade `RequiresApproval` to
//! `Allow` lands in PR-3b (`friday-crypto` + `friday-storage`); only after that, and
//! after PR-6 enforces `evaluate` before every tool dispatch, is the mutating-action
//! gate (UNW-001/cat-10) wired. Nothing calls `evaluate` yet — this adds the tested
//! policy, not runtime protection.

use crate::tool_policy::Risk;

/// The gate's decision (TS `allow | deny | requires_approval`). Reused for a
/// local guard's claim decision (same value set).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateDecision {
    Allow,
    Deny,
    RequiresApproval,
}

impl GateDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            GateDecision::Allow => "allow",
            GateDecision::Deny => "deny",
            GateDecision::RequiresApproval => "requires_approval",
        }
    }
}

/// Who is requesting the action. Only the `Agent` kind is bound by the
/// reserved-approval-action rule; `Owner`/`Api`/`Channel` are not.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActorKind {
    Owner,
    Agent,
    Api,
    Channel,
}

/// The requesting principal.
#[derive(Clone, Debug)]
pub struct Actor {
    pub kind: ActorKind,
    pub id: String,
    pub principal_id: Option<String>,
}

/// A local guard's claim about an action (TS `FridayMutatingActionLocalClaim`).
/// Only `Deny`, `risk`, and `RequiresApproval` are read by the gate — a local
/// `Allow` claim is NEVER an allow-override (a hostile/buggy guard cannot
/// downgrade a mutating or high-risk action).
#[derive(Clone, Debug)]
pub struct LocalClaim {
    pub guard_id: String,
    pub decision: GateDecision,
    pub risk: Option<Risk>,
    pub reason: Option<String>,
}

/// The resource an action targets. Bound into the action digest so an approval
/// authorizes the action on THIS resource, not the same verb on another.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Resource {
    pub resource_type: String,
    pub id: Option<String>,
    pub digest: Option<String>,
}

/// A request to perform a (possibly mutating) action (TS `FridayMutatingActionRequest`,
/// minus the `canonicalApproval` field — see the module-level fail-closed note).
///
/// `resource` / `parameters` / `idempotency_key` / `plan_digest` are bound into the
/// action digest (`canonical_action_bytes`): they distinguish one authorized action
/// from another, so a canonical approval (PR-3b) is bound to the exact action — the
/// same verb on a different resource produces a different digest and is not authorized.
#[derive(Clone, Debug)]
pub struct MutatingActionRequest {
    pub action: String,
    pub actor: Actor,
    pub surface: String,
    pub mutating: bool,
    pub risk: Option<Risk>,
    pub local_claims: Vec<LocalClaim>,
    pub resource: Option<Resource>,
    /// Caller-supplied canonical serialization of the action parameters (opaque to
    /// the gate; bound into the digest). The caller is responsible for determinism.
    pub parameters: Option<String>,
    pub idempotency_key: Option<String>,
    pub plan_digest: Option<String>,
}

/// The gate's evidence record — a **decision-core subset** of the TS
/// `FridayMutatingActionGateEvidenceRecord`. It carries only what the pure decision
/// determines (decision, reason, derived risk, approval-required, denied-by). It
/// deliberately omits the TS echo/clock/ticket fields — `action_digest` (PR-3b's
/// `friday-crypto` computes it; no hashing dep in core), `evaluated_at` (no clock in
/// a pure fn), `ticket_id`/`approval_id` (PR-3b), and the request echoes
/// (`action`/`actor`/`surface`/`resource` — the caller already holds them).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateEvidenceRecord {
    pub decision: GateDecision,
    pub reason: String,
    pub risk: Risk,
    pub approval_required: bool,
    pub denied_by: Option<String>,
}

/// The owner's decision on a canonical approval (TS `FridayCanonicalApprovalDecision`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approved,
    Denied,
}

/// A canonical approval resolution (TS `FridayCanonicalApprovalResolution`) — pure
/// data. PR-3a's pure `evaluate` never reads it (fail-closed); the verified
/// approval→Allow upgrade lives in `friday-storage::authorize_mutating_action`
/// (PR-3b), which composes this with `friday-crypto` (digest/signature) and the
/// single-use replay store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalApproval {
    pub decision: ApprovalDecision,
    pub approval_id: String,
    /// Hex SHA-256 of the request's `canonical_action_bytes` at issue time. Must
    /// match the live request's digest or the approval does not apply to this action.
    pub action_digest: String,
    /// Epoch ms after which the approval is expired. `None` is rejected (an approval
    /// MUST carry an expiry — fail-closed).
    pub expires_at: Option<i64>,
    /// Must be `"friday_canonical_gate"` for a valid approval.
    pub issuer: Option<String>,
    /// Hex HMAC-SHA256 over `canonical_approval_signature_bytes`.
    pub signature: Option<String>,
}

/// The canonical gate issuer string a valid approval must carry.
pub const CANONICAL_GATE_ISSUER: &str = "friday_canonical_gate";

// --- deterministic, collision-resistant serialization (pure; no crypto) ------

fn put_bytes(out: &mut Vec<u8>, field: &[u8]) {
    // fixed-width length prefix so concatenation is unambiguous.
    out.extend_from_slice(&(field.len() as u64).to_le_bytes());
    out.extend_from_slice(field);
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    put_bytes(out, s.as_bytes());
}

fn put_opt_str(out: &mut Vec<u8>, s: &Option<String>) {
    // presence tag so `None` != `Some("")`.
    match s {
        None => out.push(0u8),
        Some(v) => {
            out.push(1u8);
            put_str(out, v);
        }
    }
}

/// Deterministic, length-prefixed byte serialization of the request fields that
/// distinguish one authorized action from another. `friday-crypto::action_digest`
/// hashes these bytes; an approval binds to the resulting digest. This is
/// Rust-internal (it need not match the TS hex) but MUST bind every distinguishing
/// field — incl. `resource`/`parameters`/`idempotency_key`/`plan_digest` — so the
/// same verb on a different resource yields a different digest.
pub fn canonical_action_bytes(request: &MutatingActionRequest) -> Vec<u8> {
    let mut out = Vec::new();
    put_bytes(&mut out, b"friday.mutating_action.v1");
    put_str(&mut out, &request.action);
    // actor
    put_str(&mut out, request.actor.kind.as_str());
    put_str(&mut out, &request.actor.id);
    put_opt_str(&mut out, &request.actor.principal_id);
    put_str(&mut out, &request.surface);
    // resource (presence-tagged)
    match &request.resource {
        None => out.push(0u8),
        Some(r) => {
            out.push(1u8);
            put_str(&mut out, &r.resource_type);
            put_opt_str(&mut out, &r.id);
            put_opt_str(&mut out, &r.digest);
        }
    }
    out.push(request.mutating as u8);
    // Bind the DERIVED effective risk (incl. local-claim escalation), not the raw
    // declared risk — so an approval is scoped to the effective risk assessment and a
    // request a guard later escalates no longer digest-matches (faithful to the oracle).
    put_str(&mut out, derive_risk(request).as_str());
    put_opt_str(&mut out, &request.parameters);
    put_opt_str(&mut out, &request.plan_digest);
    put_opt_str(&mut out, &request.idempotency_key);
    out
}

/// Deterministic byte serialization of the approval fields that are SIGNED (all
/// fields except the signature itself). `friday-crypto::{sign,verify}_approval`
/// HMACs these bytes.
pub fn canonical_approval_signature_bytes(approval: &CanonicalApproval) -> Vec<u8> {
    let mut out = Vec::new();
    put_bytes(&mut out, b"friday.canonical_approval.v1");
    out.push(match approval.decision {
        ApprovalDecision::Approved => 1u8,
        ApprovalDecision::Denied => 0u8,
    });
    put_str(&mut out, &approval.approval_id);
    put_str(&mut out, &approval.action_digest);
    match approval.expires_at {
        None => out.push(0u8),
        Some(v) => {
            out.push(1u8);
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    put_opt_str(&mut out, &approval.issuer);
    out
}

impl ActorKind {
    fn as_str(&self) -> &'static str {
        match self {
            ActorKind::Owner => "owner",
            ActorKind::Agent => "agent",
            ActorKind::Api => "api",
            ActorKind::Channel => "channel",
        }
    }
}

/// Reserved approval actions an `Agent` actor may never self-execute (TS
/// `AGENT_RESERVED_APPROVAL_ACTIONS`).
const AGENT_RESERVED_APPROVAL_ACTIONS: &[&str] =
    &["approve", "deny", "system.approve", "system.deny"];

/// Zero-width / format chars an action could be padded with to look unlike a
/// reserved word while a normalizing dispatcher still resolves it to one.
const ZERO_WIDTH_FORMAT: &[char] = &[
    '\u{200B}', // zero-width space
    '\u{200C}', // zero-width non-joiner
    '\u{200D}', // zero-width joiner
    '\u{FEFF}', // BOM / zero-width no-break space
    '\u{00AD}', // soft hyphen
    '\u{2060}', // word joiner
];

/// Canonicalize an action name for the reserved-set check: drop ALL whitespace,
/// control, and zero-width/format chars, then lowercase. This **hardens beyond the
/// TS oracle's `trim().toLowerCase()`**, which leaves a seam (`ap prove`,
/// `appro\u{200B}ve`, `\u{FEFF}approve`, `appro\u{00AD}ve` would evade it). The
/// hardening is strictly fail-safe: it only ever ADDS denials for names that
/// canonicalize to a reserved verb, never removes one — so a downstream dispatcher
/// that normalizes action names cannot be tricked into letting an agent self-approve.
fn normalize_reserved_action(action: &str) -> String {
    action
        .chars()
        .filter(|c| !(c.is_whitespace() || c.is_control() || ZERO_WIDTH_FORMAT.contains(c)))
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// True if `request` is an `Agent` actor attempting a reserved approval action —
/// the bound-principal rule (an agent can never approve/deny on its own behalf).
pub fn is_reserved_approval_action_for_actor(request: &MutatingActionRequest) -> bool {
    if request.actor.kind != ActorKind::Agent {
        return false;
    }
    let normalized = normalize_reserved_action(&request.action);
    AGENT_RESERVED_APPROVAL_ACTIONS.contains(&normalized.as_str())
}

/// Derive the effective risk: the request's declared risk (defaulting to `Medium`
/// for a mutating action, `ReadOnly` otherwise), raised by the highest local-claim
/// risk (TS `deriveFridayMutatingActionRisk`). A local claim can only RAISE risk.
fn derive_risk(request: &MutatingActionRequest) -> Risk {
    let mut risk = request.risk.unwrap_or(if request.mutating {
        Risk::Medium
    } else {
        Risk::ReadOnly
    });
    for claim in &request.local_claims {
        if let Some(r) = claim.risk {
            if r > risk {
                risk = r;
            }
        }
    }
    risk
}

/// Whether canonical approval is required (TS `requiresCanonicalApproval`): any
/// mutating action, OR `risk >= High`, OR a local claim that itself requires approval.
fn requires_approval(request: &MutatingActionRequest, risk: Risk) -> bool {
    request.mutating
        || risk >= Risk::High
        || request
            .local_claims
            .iter()
            .any(|c| c.decision == GateDecision::RequiresApproval)
}

/// Evaluate the gate's decision for a request. Check order is load-bearing
/// (TS `evaluate`): (1) an agent attempting a reserved approval action is a hard
/// `Deny` — checked FIRST, before anything else; (2) any local guard `Deny` is a
/// `Deny`; (3) if approval is not required, `Allow`; (4) otherwise
/// `RequiresApproval`. There is no `Allow`-for-a-mutating-action path: this core
/// never grants a mutating/high-risk action (PR-3b's verified canonical approval does).
pub fn evaluate(request: &MutatingActionRequest) -> GateEvidenceRecord {
    let risk = derive_risk(request);

    // (1) Bound-principal rule, FIRST: an agent cannot self-execute approve/deny.
    if is_reserved_approval_action_for_actor(request) {
        return GateEvidenceRecord {
            decision: GateDecision::Deny,
            reason: "agent_cannot_execute_reserved_approval_action".to_string(),
            risk,
            approval_required: false,
            denied_by: Some("canonical_gate".to_string()),
        };
    }

    // (2) A local guard Deny is authoritative. (An `Allow` claim is NOT read here —
    // it can never downgrade the action.)
    if let Some(deny) = request
        .local_claims
        .iter()
        .find(|c| c.decision == GateDecision::Deny)
    {
        return GateEvidenceRecord {
            decision: GateDecision::Deny,
            reason: deny
                .reason
                .clone()
                .unwrap_or_else(|| "local_guard_denied".to_string()),
            risk,
            approval_required: false,
            denied_by: Some(deny.guard_id.clone()),
        };
    }

    // (3) No approval needed -> allow (read-only, low/medium-risk, no requiring claim).
    // Reason string matches the TS oracle verbatim (`read_only_action_allowed_without_ticket`)
    // so audit labels are identical across the port; "ticket" refers to the PR-3b canonical
    // approval ticket (not present in this decision core).
    if !requires_approval(request, risk) {
        return GateEvidenceRecord {
            decision: GateDecision::Allow,
            reason: "read_only_action_allowed_without_ticket".to_string(),
            risk,
            approval_required: false,
            denied_by: None,
        };
    }

    // (4) Approval required -> RequiresApproval. (PR-3b's verified canonical approval
    // is the ONLY thing that upgrades this to Allow; this core never does.)
    GateEvidenceRecord {
        decision: GateDecision::RequiresApproval,
        reason: "canonical_approval_required".to_string(),
        risk,
        approval_required: true,
        denied_by: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(kind: ActorKind) -> Actor {
        Actor {
            kind,
            id: "a1".to_string(),
            principal_id: None,
        }
    }

    fn req(action: &str, kind: ActorKind, mutating: bool) -> MutatingActionRequest {
        MutatingActionRequest {
            action: action.to_string(),
            actor: actor(kind),
            surface: "system".to_string(),
            mutating,
            risk: None,
            local_claims: vec![],
            resource: None,
            parameters: None,
            idempotency_key: None,
            plan_digest: None,
        }
    }

    #[test]
    fn canonical_action_bytes_binds_distinguishing_fields() {
        // The same verb/actor/surface but a DIFFERENT resource MUST yield different
        // bytes (so a different digest, so an approval cannot cross-authorize).
        let mut a = req("delete_file", ActorKind::Owner, true);
        a.resource = Some(Resource {
            resource_type: "file".into(),
            id: Some("/data/a.txt".into()),
            digest: None,
        });
        let mut b = req("delete_file", ActorKind::Owner, true);
        b.resource = Some(Resource {
            resource_type: "file".into(),
            id: Some("/data/b.txt".into()),
            digest: None,
        });
        assert_ne!(canonical_action_bytes(&a), canonical_action_bytes(&b));
        // Identical requests -> identical bytes (deterministic).
        assert_eq!(
            canonical_action_bytes(&a),
            canonical_action_bytes(&a.clone())
        );
        // None resource != Some(empty-ish) — presence tag prevents collision.
        let c = req("delete_file", ActorKind::Owner, true);
        assert_ne!(canonical_action_bytes(&a), canonical_action_bytes(&c));
        // parameters / idempotency_key also distinguish.
        let mut d = c.clone();
        d.parameters = Some("force=true".into());
        assert_ne!(canonical_action_bytes(&c), canonical_action_bytes(&d));
        let mut e = c.clone();
        e.idempotency_key = Some("k1".into());
        assert_ne!(canonical_action_bytes(&c), canonical_action_bytes(&e));
        // The DERIVED effective risk is bound: a risk-escalating local claim changes
        // the digest, so an approval can't survive a later guard escalation.
        let mut f = req("inspect", ActorKind::Owner, false); // non-mutating -> ReadOnly base
        let base_bytes = canonical_action_bytes(&f);
        f.local_claims.push(LocalClaim {
            guard_id: "risk".into(),
            decision: GateDecision::Allow,
            risk: Some(Risk::High),
            reason: None,
        });
        assert_ne!(base_bytes, canonical_action_bytes(&f));
    }

    #[test]
    fn non_mutating_low_risk_is_allowed() {
        let r = evaluate(&req("read_file", ActorKind::Agent, false));
        assert_eq!(r.decision, GateDecision::Allow);
        assert_eq!(r.risk, Risk::ReadOnly);
        assert!(!r.approval_required);
        // Lock the audit reason string to the oracle's verbatim label.
        assert_eq!(r.reason, "read_only_action_allowed_without_ticket");
    }

    #[test]
    fn mutating_action_always_requires_approval_never_allows() {
        // Fail-closed: a mutating action can NEVER be Allow in the decision core.
        for kind in [
            ActorKind::Owner,
            ActorKind::Agent,
            ActorKind::Api,
            ActorKind::Channel,
        ] {
            let r = evaluate(&req("write_file", kind, true));
            assert_eq!(r.decision, GateDecision::RequiresApproval, "kind={kind:?}");
            assert_ne!(r.decision, GateDecision::Allow);
            assert!(r.approval_required);
            assert_eq!(r.risk, Risk::Medium); // mutating default
        }
    }

    #[test]
    fn high_risk_non_mutating_requires_approval() {
        let mut request = req("inspect", ActorKind::Owner, false);
        request.risk = Some(Risk::High);
        let r = evaluate(&request);
        assert_eq!(r.decision, GateDecision::RequiresApproval);
        // Critical too.
        request.risk = Some(Risk::Critical);
        assert_eq!(evaluate(&request).decision, GateDecision::RequiresApproval);
        // Medium does NOT (non-mutating).
        request.risk = Some(Risk::Medium);
        assert_eq!(evaluate(&request).decision, GateDecision::Allow);
    }

    #[test]
    fn agent_cannot_self_execute_reserved_approval_action() {
        for action in [
            "approve",
            "deny",
            "system.approve",
            "system.deny",
            "  Approve  ",
        ] {
            let r = evaluate(&req(action, ActorKind::Agent, false));
            assert_eq!(r.decision, GateDecision::Deny, "action={action}");
            assert_eq!(r.reason, "agent_cannot_execute_reserved_approval_action");
            assert_eq!(r.denied_by.as_deref(), Some("canonical_gate"));
        }
        // A non-agent actor (owner) MAY approve — not reserved.
        assert_eq!(
            evaluate(&req("approve", ActorKind::Owner, false)).decision,
            GateDecision::Allow
        );
        // A non-reserved action by an agent is fine.
        assert_eq!(
            evaluate(&req("read_file", ActorKind::Agent, false)).decision,
            GateDecision::Allow
        );
    }

    #[test]
    fn reserved_action_check_resists_canonicalization_evasion() {
        // Hardening beyond the oracle (Reviewer B): an agent action padded with
        // zero-width/format chars or internal whitespace that a normalizing
        // dispatcher would resolve to a reserved verb must still be Deny.
        for action in [
            "appro\u{200B}ve", // zero-width space
            "approve\u{200B}", // trailing ZWSP
            "\u{FEFF}approve", // leading BOM
            "appro\u{00AD}ve", // soft hyphen
            "ap prove",        // internal ASCII space
            "system .approve", // whitespace in dotted form
            "AP\tPROVE",       // tab + case
            "de\u{2060}ny",    // word joiner
        ] {
            assert_eq!(
                evaluate(&req(action, ActorKind::Agent, false)).decision,
                GateDecision::Deny,
                "agent action {action:?} canonicalizes to a reserved verb -> must Deny"
            );
        }
        // A genuinely different action that merely CONTAINS a reserved word is allowed.
        assert_eq!(
            evaluate(&req("approve_budget_request", ActorKind::Agent, false)).decision,
            GateDecision::Allow
        );
    }

    #[test]
    fn reserved_action_deny_is_checked_before_approval() {
        // An agent's reserved action that is ALSO mutating must be a hard Deny,
        // not RequiresApproval — check order is load-bearing.
        let r = evaluate(&req("approve", ActorKind::Agent, true));
        assert_eq!(r.decision, GateDecision::Deny);
        assert_eq!(r.reason, "agent_cannot_execute_reserved_approval_action");
    }

    #[test]
    fn local_deny_claim_denies() {
        let mut request = req("write_file", ActorKind::Owner, true);
        request.local_claims.push(LocalClaim {
            guard_id: "path_guard".to_string(),
            decision: GateDecision::Deny,
            risk: None,
            reason: Some("escapes_workspace_root".to_string()),
        });
        let r = evaluate(&request);
        assert_eq!(r.decision, GateDecision::Deny);
        assert_eq!(r.reason, "escapes_workspace_root");
        assert_eq!(r.denied_by.as_deref(), Some("path_guard"));
    }

    #[test]
    fn local_allow_claim_does_not_downgrade_a_mutating_action() {
        // A hostile/buggy guard claiming `allow` must NOT downgrade a mutating action.
        let mut request = req("write_file", ActorKind::Owner, true);
        request.local_claims.push(LocalClaim {
            guard_id: "rogue_guard".to_string(),
            decision: GateDecision::Allow,
            risk: None,
            reason: Some("looks fine to me".to_string()),
        });
        assert_eq!(evaluate(&request).decision, GateDecision::RequiresApproval);
    }

    #[test]
    fn local_claim_risk_escalates_and_requires_can_force_approval() {
        // A local claim's risk raises the effective risk to High -> RequiresApproval,
        // even for a non-mutating action.
        let mut request = req("inspect", ActorKind::Owner, false);
        request.local_claims.push(LocalClaim {
            guard_id: "risk_guard".to_string(),
            decision: GateDecision::Allow, // allow, but it carries a High risk
            risk: Some(Risk::High),
            reason: None,
        });
        let r = evaluate(&request);
        assert_eq!(r.decision, GateDecision::RequiresApproval);
        assert_eq!(r.risk, Risk::High);

        // A requires_approval claim alone forces approval on a non-mutating low-risk action.
        let mut request2 = req("inspect", ActorKind::Owner, false);
        request2.local_claims.push(LocalClaim {
            guard_id: "ask_guard".to_string(),
            decision: GateDecision::RequiresApproval,
            risk: None,
            reason: None,
        });
        assert_eq!(evaluate(&request2).decision, GateDecision::RequiresApproval);
    }

    #[test]
    fn deny_claim_beats_requires_approval_claim() {
        let mut request = req("inspect", ActorKind::Owner, false);
        request.local_claims.push(LocalClaim {
            guard_id: "ask".to_string(),
            decision: GateDecision::RequiresApproval,
            risk: None,
            reason: None,
        });
        request.local_claims.push(LocalClaim {
            guard_id: "block".to_string(),
            decision: GateDecision::Deny,
            risk: None,
            reason: Some("blocked".to_string()),
        });
        let r = evaluate(&request);
        assert_eq!(r.decision, GateDecision::Deny);
        assert_eq!(r.denied_by.as_deref(), Some("block"));
    }
}
