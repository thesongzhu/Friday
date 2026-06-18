//! Trust-grant baseline — the per-agent capability envelope (north-star doc 55 §4,
//! the 9 boundaries; loop closure commit 3).
//!
//! A [`TrustGrant`] is a scoped, revocable, expiring authorization for ONE agent
//! ("friday" | "codex" | "claude" | "workflow:<id>" | "skill:<id>") to act WITHIN a
//! set of [`TrustBoundaries`]. This is PURE policy (no I/O): [`check_grant`] decides
//! whether a single requested action falls inside the grant's envelope. Persistence
//! (issue/revoke/active-lookup) and the restrictive compose with the mutating-action
//! gate live in `friday-storage`.
//!
//! Fail-closed posture:
//! - an EMPTY allowlist is DENY-ALL for the dimension it scopes (a grant must
//!   explicitly enumerate what it permits — "no tools listed" never means "all tools");
//! - a deny on revoked / expired / agent-mismatch / risk-over-ceiling /
//!   workspace-prefix-miss / out-of-allowlist short-circuits;
//! - the only `Allow` is `"trust_grant_within_boundaries"`, and it means "no trust
//!   objection" — it is NEVER an upgrade (the storage compose feeds it to the mutating
//!   gate, which can still require approval).
//!
//! Storage-enforced outside this PURE check: `max_runs` and action-time
//! `token_ceiling` use the `friday-storage` compose plus a `(grant_id, run_id)`
//! usage ledger. This pure check still ignores counters because it has no I/O.

use crate::gate::GateDecision;
use crate::tool_policy::Risk;

/// The scoping envelope of a trust grant — north-star doc 55 §4's boundaries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustBoundaries {
    /// Workspace path PREFIX the grant is confined to. `None` = unscoped (any path).
    pub workspace: Option<String>,
    /// The maximum risk an action may carry. An effective risk ABOVE this is denied.
    pub risk_ceiling: Risk,
    /// Storage-enforced outside the pure check: action-time token spend ceiling.
    pub token_ceiling: Option<i64>,
    /// Storage-enforced outside the pure check: max distinct run ids under this grant.
    pub max_runs: Option<i64>,
    /// Allowlists. EMPTY = DENY-ALL for that dimension (fail-closed).
    pub allowed_channels: Vec<String>,
    pub allowed_providers: Vec<String>,
    pub allowed_tools: Vec<String>,
    pub allowed_workflow_families: Vec<String>,
    pub allowed_skill_families: Vec<String>,
}

/// A scoped, revocable, expiring authorization for one agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustGrant {
    pub grant_id: String,
    /// "friday" | "codex" | "claude" | "workflow:<id>" | "skill:<id>".
    pub agent_id: String,
    pub granted_at: i64,
    /// `None` = no expiry. Otherwise the grant is dead once `now >= expires_at`.
    pub expires_at: Option<i64>,
    pub revoked: bool,
    pub revoked_at: Option<i64>,
    pub boundaries: TrustBoundaries,
}

/// One action's request dimensions, checked against a grant. A dimension carried as
/// `Some(..)` is checked against its allowlist; a `None` dimension is not part of this
/// action and is not checked (so a tool-only grant does not deny a tool-only request
/// just because `allowed_providers` is empty).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GrantCheck {
    pub agent_id: String,
    pub now: i64,
    /// The action's EFFECTIVE risk (the gate's derived `.risk`, not a re-derivation).
    pub effective_risk: Risk,
    /// The workspace path the action touches (checked against the prefix boundary).
    pub workspace: Option<String>,
    pub tool: Option<String>,
    pub provider: Option<String>,
    pub channel: Option<String>,
    pub workflow_family: Option<String>,
    pub skill_family: Option<String>,
}

/// Whether `value` is permitted by `allowlist`. EMPTY allowlist = DENY-ALL.
fn allowed(allowlist: &[String], value: &str) -> bool {
    allowlist.iter().any(|a| a == value)
}

/// Decide whether `check`'s action falls inside `grant`'s envelope. Returns the
/// decision plus a stable reason label. The ONLY `Allow` reason is
/// `"trust_grant_within_boundaries"`; every other branch is a `Deny` with a
/// dimension-specific reason. Pure — no clock, no I/O (the caller supplies `now`).
pub fn check_grant(grant: &TrustGrant, check: &GrantCheck) -> (GateDecision, &'static str) {
    let deny = |reason: &'static str| (GateDecision::Deny, reason);

    if grant.revoked {
        return deny("trust_grant_revoked");
    }
    if let Some(expires_at) = grant.expires_at {
        if check.now >= expires_at {
            return deny("trust_grant_expired");
        }
    }
    if grant.agent_id != check.agent_id {
        return deny("trust_grant_agent_mismatch");
    }

    // Risk ceiling: an effective risk ABOVE the ceiling is denied.
    if check.effective_risk > grant.boundaries.risk_ceiling {
        return deny("trust_grant_risk_over_ceiling");
    }

    // Workspace prefix. A bounded grant confines actions to a path prefix; an action
    // that touches a path outside it (or omits a path when the grant is workspace-
    // scoped) is denied. An unscoped grant (`None`) skips this.
    //
    // BOUNDARY-AWARE prefix (NOT a raw `starts_with`): a grant for `/work/friday`
    // authorizes `/work/friday` itself and any path under `/work/friday/...`, but
    // MUST NOT authorize a sibling like `/work/friday-secret` (a raw starts_with
    // would fail OPEN there). The trailing-slash compare enforces a path-component
    // boundary; `trim_end_matches('/')` normalizes a prefix that already ends in `/`.
    if let Some(prefix) = grant.boundaries.workspace.as_deref() {
        let prefix_norm = prefix.trim_end_matches('/');
        match check.workspace.as_deref() {
            Some(path) if path == prefix_norm || path.starts_with(&format!("{prefix_norm}/")) => {}
            _ => return deny("trust_grant_workspace_out_of_scope"),
        }
    }

    // Per-dimension allowlists — checked ONLY for the dimensions this action carries.
    if let Some(tool) = check.tool.as_deref() {
        if !allowed(&grant.boundaries.allowed_tools, tool) {
            return deny("trust_grant_tool_not_allowed");
        }
    }
    if let Some(provider) = check.provider.as_deref() {
        if !allowed(&grant.boundaries.allowed_providers, provider) {
            return deny("trust_grant_provider_not_allowed");
        }
    }
    if let Some(channel) = check.channel.as_deref() {
        if !allowed(&grant.boundaries.allowed_channels, channel) {
            return deny("trust_grant_channel_not_allowed");
        }
    }
    if let Some(family) = check.workflow_family.as_deref() {
        if !allowed(&grant.boundaries.allowed_workflow_families, family) {
            return deny("trust_grant_workflow_family_not_allowed");
        }
    }
    if let Some(family) = check.skill_family.as_deref() {
        if !allowed(&grant.boundaries.allowed_skill_families, family) {
            return deny("trust_grant_skill_family_not_allowed");
        }
    }

    (GateDecision::Allow, "trust_grant_within_boundaries")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boundaries() -> TrustBoundaries {
        TrustBoundaries {
            workspace: Some("/work/friday".into()),
            risk_ceiling: Risk::Medium,
            token_ceiling: Some(1000),
            max_runs: Some(5),
            allowed_channels: vec!["telegram".into()],
            allowed_providers: vec!["deepseek".into()],
            allowed_tools: vec!["read_file".into()],
            allowed_workflow_families: vec![],
            allowed_skill_families: vec![],
        }
    }

    fn grant() -> TrustGrant {
        TrustGrant {
            grant_id: "g1".into(),
            agent_id: "friday".into(),
            granted_at: 1,
            expires_at: Some(1_000),
            revoked: false,
            revoked_at: None,
            boundaries: boundaries(),
        }
    }

    fn check() -> GrantCheck {
        GrantCheck {
            agent_id: "friday".into(),
            now: 100,
            effective_risk: Risk::ReadOnly,
            workspace: Some("/work/friday/src".into()),
            tool: Some("read_file".into()),
            provider: None,
            channel: None,
            workflow_family: None,
            skill_family: None,
        }
    }

    #[test]
    fn within_boundaries_allows() {
        let (d, r) = check_grant(&grant(), &check());
        assert_eq!(d, GateDecision::Allow);
        assert_eq!(r, "trust_grant_within_boundaries");
    }

    #[test]
    fn revoked_denies() {
        let mut g = grant();
        g.revoked = true;
        let (d, r) = check_grant(&g, &check());
        assert_eq!(d, GateDecision::Deny);
        assert_eq!(r, "trust_grant_revoked");
    }

    #[test]
    fn expired_denies() {
        let mut c = check();
        c.now = 1_000; // now >= expires_at
        let (d, r) = check_grant(&grant(), &c);
        assert_eq!(d, GateDecision::Deny);
        assert_eq!(r, "trust_grant_expired");
    }

    #[test]
    fn agent_mismatch_denies() {
        let mut c = check();
        c.agent_id = "codex".into();
        let (d, r) = check_grant(&grant(), &c);
        assert_eq!(d, GateDecision::Deny);
        assert_eq!(r, "trust_grant_agent_mismatch");
    }

    #[test]
    fn risk_over_ceiling_denies() {
        let mut c = check();
        c.effective_risk = Risk::High; // > Medium ceiling
        let (d, r) = check_grant(&grant(), &c);
        assert_eq!(d, GateDecision::Deny);
        assert_eq!(r, "trust_grant_risk_over_ceiling");
    }

    #[test]
    fn workspace_outside_prefix_denies() {
        let mut c = check();
        c.workspace = Some("/etc/passwd".into());
        let (d, r) = check_grant(&grant(), &c);
        assert_eq!(d, GateDecision::Deny);
        assert_eq!(r, "trust_grant_workspace_out_of_scope");
    }

    #[test]
    fn workspace_sibling_prefix_does_not_fail_open() {
        // grant() is scoped to "/work/friday". A raw starts_with would FAIL OPEN on
        // the sibling "/work/friday-secret"; the boundary-aware check must DENY it,
        // while still allowing the exact dir and any path under it.
        let g = grant();

        let mut sibling = check();
        sibling.workspace = Some("/work/friday-secret/leak".into());
        let (d, r) = check_grant(&g, &sibling);
        assert_eq!(d, GateDecision::Deny, "sibling prefix must NOT fail open");
        assert_eq!(r, "trust_grant_workspace_out_of_scope");

        let mut exact = check();
        exact.workspace = Some("/work/friday".into());
        assert_eq!(
            check_grant(&g, &exact).0,
            GateDecision::Allow,
            "exact dir allowed"
        );

        let mut child = check();
        child.workspace = Some("/work/friday/src/main.rs".into());
        assert_eq!(
            check_grant(&g, &child).0,
            GateDecision::Allow,
            "sub-path allowed"
        );
    }

    #[test]
    fn tool_not_in_allowlist_denies() {
        let mut c = check();
        c.tool = Some("delete_file".into());
        let (d, r) = check_grant(&grant(), &c);
        assert_eq!(d, GateDecision::Deny);
        assert_eq!(r, "trust_grant_tool_not_allowed");
    }

    #[test]
    fn empty_allowlist_is_deny_all_for_a_checked_dimension() {
        // allowed_workflow_families is empty -> ANY workflow-family action denies.
        let mut c = check();
        c.workflow_family = Some("nightly".into());
        let (d, r) = check_grant(&grant(), &c);
        assert_eq!(d, GateDecision::Deny);
        assert_eq!(r, "trust_grant_workflow_family_not_allowed");
    }

    #[test]
    fn empty_allowlist_does_not_deny_an_unchecked_dimension() {
        // allowed_providers is non-empty but the request carries NO provider; a
        // tool-only request must NOT be denied for the absent provider dimension.
        let c = check(); // provider = None, tool = read_file (allowed)
        let (d, _) = check_grant(&grant(), &c);
        assert_eq!(d, GateDecision::Allow);

        // And an empty allowlist on an UN-checked dimension is still a non-issue: a
        // grant with empty allowed_skill_families allows a non-skill action.
        let (d2, _) = check_grant(&grant(), &c);
        assert_eq!(d2, GateDecision::Allow);
    }

    #[test]
    fn unscoped_workspace_grant_skips_the_prefix_check() {
        let mut g = grant();
        g.boundaries.workspace = None;
        let mut c = check();
        c.workspace = Some("/anywhere".into());
        let (d, _) = check_grant(&g, &c);
        assert_eq!(d, GateDecision::Allow);
    }
}
