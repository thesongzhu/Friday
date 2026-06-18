//! L2 `subagent` capability tool — bounded sub-task delegation + the FIRST in-product
//! scoped trust-MINT (closes parity-registry #7's missing producer).
//!
//! ## Why this exists (the #7 producer)
//! registry #7 (trust mint→enforce) had a faithful ENFORCE gate (`friday_core::check_grant`
//! + the `friday_storage::authorize_agent_action` compose) but NO in-product mint — only the
//! offline operator CLI issued grants. So `FRIDAY_TRUST_GRANT_ENFORCE`-ON would brick (no
//! grants exist ⇒ every mutating action denies `trust_no_active_grant`). The `subagent` tool
//! is the natural first in-product minter: spawning a sub-agent ISSUES a [`TrustGrant`] whose
//! [`TrustBoundaries`] are the INTERSECTION of the parent's grant with the requested scope —
//! never a superset, by construction. This module owns ONLY the PURE mint computation
//! ([`mint_child_boundaries`] / [`build_child_grant`]) + param parsing; the I/O (load the
//! parent grant, persist the child via `friday_storage::grant_trust`, recurse into the loop)
//! lives at the dispatch seam in `lib.rs::run_loop_with_policy_inner`. Persistence reuses the
//! EXISTING `friday-storage` trust-issue path — this module does NOT write a second writer.
//!
//! ## The tool (synchronous, bounded, owner-scoped)
//! The running agent delegates ONE bounded sub-task to a fresh nested agent loop and gets the
//! sub-agent's final message back as the tool result. Params (model-supplied, all validated):
//! `{ task: string (required), tools?: comma-list (subset to grant; default = read-only
//! subset of parent's), max_turns?: int (clamped) }`. There is deliberately NO `owner` param —
//! the sub-agent runs under the parent's authenticated principal (see guard 5 in the build-spec);
//! a model-supplied owner is impossible to assert (the field does not exist) and so cannot escalate.
//!
//! ## Security guards realized HERE (pure) vs at the seam
//! - **Guard 2 (mint ⊆ parent, the #7 core):** [`mint_child_boundaries`] intersects EVERY
//!   dimension DOWN — `workspace` at-or-under the parent prefix, `risk_ceiling = min`,
//!   allowlists = `requested ∩ parent` (an EMPTY allowlist stays DENY-ALL), `expires_at =
//!   min(parent, now + SHORT_TTL)`. A fabricated broad request can never widen.
//! - **Guard 3 (depth cap by the grant):** the child boundaries' `allowed_tools` NEVER contain
//!   `subagent` (stripped here), so a sub-agent's spawn is gate-denied independent of any flag;
//!   the seam ALSO adds `subagent` to the child `RunPolicy.disabled_tools` (belt-and-suspenders).
//! - **Guard 4 (count + turns cap):** [`SUBAGENT_MAX_COUNT`] / [`clamp_max_turns`] are enforced
//!   at the seam (the count is loop-local; the turn clamp is pure here).
//! The remaining guards (owner inheritance, mutating-gate re-evaluation, billing, prompt-injection
//! posture) are properties of the recursion at the seam and are documented there.

use friday_core::{Risk, TrustBoundaries, TrustGrant};

/// Short time-to-live for a minted sub-agent grant (5 minutes). A sub-agent grant must not
/// outlive the turn that spawned it, so the child `expires_at` is `min(parent.expires_at,
/// now + SUBAGENT_SHORT_TTL_MS)` — never longer than the parent, and never long-lived.
pub const SUBAGENT_SHORT_TTL_MS: i64 = 5 * 60 * 1000;

/// Max sub-agents a single parent run may spawn (count cap, guard 4). The (N+1)-th spawn
/// returns an error result to the model (not a panic, not a silent no-op). Enforced loop-local
/// at the dispatch seam.
pub const SUBAGENT_MAX_COUNT: u64 = 3;

/// Hard ceiling on a sub-agent's `max_turns` (guard 4). The requested `max_turns` is clamped to
/// `[1, SUBAGENT_MAX_TURNS]` AND additionally to the parent's remaining budget at the seam.
pub const SUBAGENT_MAX_TURNS: u64 = 4;

/// The tool action name — the SINGLE source of truth used EVERYWHERE (registry key, menu line,
/// dispatch-seam interception match, the child `disabled_tools` entry, the chokepoint flag-gate).
/// Keeping one string means no alias can slip past interception into classify.
pub const SUBAGENT_TOOL: &str = "subagent";

/// A parsed, validated `subagent` tool request (the model-controlled params, trusted only as
/// STRINGS — the trusted booleans/scopes are derived by Hub code here, never asserted by the model).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentRequest {
    /// The sub-task delegated to the nested agent (required, non-empty).
    pub task: String,
    /// The REQUESTED tool subset to grant the child. Intersected with the parent's
    /// `allowed_tools` at mint time (a tool the parent lacks is dropped, never granted). `None`
    /// ⇒ default to the read-only subset of the parent's tools (see [`default_child_tools`]).
    pub requested_tools: Option<Vec<String>>,
    /// The REQUESTED max turns (clamped at the seam). `None` ⇒ the default clamp.
    pub requested_max_turns: Option<u64>,
}

/// Why a `subagent` request could not be parsed/validated (a model contract violation). Surfaced
/// to the model as a tool error result so it can adapt — never a panic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubagentParamError {
    /// The required `task` param is missing or empty/whitespace.
    MissingTask,
}

impl std::fmt::Display for SubagentParamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SubagentParamError::MissingTask => write!(f, "subagent_missing_task"),
        }
    }
}

/// Parse the model-supplied `subagent` params (string KV pairs) into a validated
/// [`SubagentRequest`]. The `tools` param is a comma-separated list (the dev-bridge flattens a
/// model array this way); empties are dropped. An `owner`/`principal`/`agent_id` param — if the
/// model fabricates one — is SILENTLY IGNORED (never read), so it cannot escalate (guard 5).
pub fn parse_subagent_params(
    params: &[(String, String)],
) -> Result<SubagentRequest, SubagentParamError> {
    let get = |key: &str| -> Option<&str> {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    };
    let task = get("task").map(str::trim).unwrap_or("");
    if task.is_empty() {
        return Err(SubagentParamError::MissingTask);
    }
    let requested_tools = get("tools").map(|raw| {
        raw.split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    });
    let requested_max_turns = get("max_turns").and_then(|s| s.trim().parse::<u64>().ok());
    Ok(SubagentRequest {
        task: task.to_string(),
        requested_tools,
        requested_max_turns,
    })
}

/// The READ-ONLY subset of the parent's allowed tools — the DEFAULT child tool grant when the
/// model omits `tools`. A sub-agent should be read-only-by-default; the model must explicitly
/// request a mutating tool (and even then it is intersected with the parent + re-gated at every
/// call). The read-only set mirrors the registry's `mutating:false, Risk::ReadOnly` built-ins;
/// `subagent` is excluded unconditionally (guard 3 — no recursion).
pub fn default_child_tools(parent_tools: &[String]) -> Vec<String> {
    const READ_ONLY_BUILTINS: &[&str] = &["read_file", "list_dir", "stat_file", "search"];
    parent_tools
        .iter()
        .filter(|t| READ_ONLY_BUILTINS.contains(&t.as_str()))
        .cloned()
        .collect()
}

/// Intersect one allowlist with another — `requested ∩ parent`, preserving `parent` order and
/// dropping duplicates. A tool/channel/provider in `requested` but NOT in `parent` is DROPPED
/// (never granted). An EMPTY result stays empty = DENY-ALL (fail-closed) — never widened.
fn intersect(requested: &[String], parent: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in parent {
        if requested.iter().any(|r| r == p) && !out.contains(p) {
            out.push(p.clone());
        }
    }
    out
}

/// Compute the child's [`TrustBoundaries`] as the INTERSECTION of `parent` with `req` — the #7
/// mint core (guard 2). EVERY dimension is clamped DOWN, never widened:
/// - `workspace`: inherit the parent's concrete prefix (a child is confined at-or-under the
///   parent's workspace; an unscoped `None` parent stays `None`). The model cannot widen it —
///   there is no `workspace` request param, so the child is exactly the parent's workspace scope.
/// - `risk_ceiling`: `min(parent, requested)` where the requested ceiling is `Risk::ReadOnly`
///   when the model omitted `tools` (read-only default) else the parent's ceiling (the per-call
///   gate + the intersected allowlist already bound what a tool may do; the ceiling never EXCEEDS
///   the parent's).
/// - `allowed_tools`: `requested ∩ parent.allowed_tools` (default = the read-only subset of the
///   parent's), with `subagent` ALWAYS stripped (guard 3). A tool the parent lacks → dropped.
/// - `allowed_channels`/`providers`/`workflow_families`/`skill_families`: inherited from the
///   parent VERBATIM (there is no request param for these dimensions), so the child gets EXACTLY
///   the parent's set — child == parent for these dims, which is ⊆ parent (never a superset). The
///   sub-agent gets NO new channels/providers/families the parent lacked. (NOT emptied to a
///   DENY-ALL: verbatim inheritance — the parent's set intersected with itself — is already the
///   conservative ⊆-parent choice; emptying would needlessly strip the envelope.)
/// - `token_ceiling`/`max_runs`: DEFERRED (stored, not enforced — same as the parent); carried as
///   the parent's value (never raised).
///
/// PURE — no clock, no I/O. `now`/`SHORT_TTL` feed `expires_at` via [`build_child_grant`].
pub fn mint_child_boundaries(parent: &TrustBoundaries, req: &SubagentRequest) -> TrustBoundaries {
    // The requested tool set: explicit request, else the read-only subset of the parent's.
    let requested_tools = match &req.requested_tools {
        Some(tools) => tools.clone(),
        None => default_child_tools(&parent.allowed_tools),
    };
    // requested ∩ parent — drop anything the parent lacks. Then STRIP `subagent` unconditionally
    // (guard 3: a minted child grant must never permit spawning, independent of any flag).
    let mut allowed_tools = intersect(&requested_tools, &parent.allowed_tools);
    allowed_tools.retain(|t| t != SUBAGENT_TOOL);

    // The requested risk ceiling: read-only when the model defaulted the tool set (no explicit
    // tools), else the parent's ceiling. Clamp DOWN to the parent's ceiling regardless.
    let requested_risk = if req.requested_tools.is_some() {
        parent.risk_ceiling
    } else {
        Risk::ReadOnly
    };
    let risk_ceiling = requested_risk.min(parent.risk_ceiling);

    TrustBoundaries {
        // Inherit the parent's workspace prefix verbatim (at-or-under by definition; `None`
        // stays `None`). There is no widening path — no request param can move it outward.
        workspace: parent.workspace.clone(),
        risk_ceiling,
        // DEFERRED dims carried from the parent (never raised).
        token_ceiling: parent.token_ceiling,
        max_runs: parent.max_runs,
        auto_allow_reversible_ceiling: parent.auto_allow_reversible_ceiling,
        // Non-tool allowlists: the parent's set intersected with itself = the parent's set
        // (never a superset). A sub-agent inherits the SAME non-tool envelope, no wider.
        allowed_channels: parent.allowed_channels.clone(),
        allowed_providers: parent.allowed_providers.clone(),
        allowed_tools,
        allowed_workflow_families: parent.allowed_workflow_families.clone(),
        allowed_skill_families: parent.allowed_skill_families.clone(),
    }
}

/// The child grant's stable `agent_id`: `friday:subagent:<parent_run_id>:<seq>`. `check_grant`
/// matches `agent_id` by EXACT string equality (no splitting/route-parsing anywhere — verified),
/// so this scheme is a distinct identity that only the child's own `RunPolicy.action_context`
/// will carry. The child's `active_grant(agent_id)` lookup therefore resolves ONLY this grant.
pub fn child_agent_id(parent_run_id: &str, seq: u64) -> String {
    format!("{SUBAGENT_TOOL}:{parent_run_id}:{seq}")
}

/// The child's derived sub-run id: `<parent_run_id>:sub<seq>`. Distinct from the parent's
/// `run_id` so the per-turn ledger/activity/audit ids (`{run_id}:t{turn_index}:...`) never
/// collide with the parent's (guard 7 — no double-bill). The child bills to the SAME owner via
/// the inherited principal on its `RunPolicy`, through the same `record_run_model_call` path.
pub fn child_run_id(parent_run_id: &str, seq: u64) -> String {
    format!("{parent_run_id}:sub{seq}")
}

/// Build the full child [`TrustGrant`] from the parent grant + the request. `agent_id` is the
/// child scheme; `boundaries` are the [`mint_child_boundaries`] intersection; `expires_at` is
/// `min(parent.expires_at, now + SHORT_TTL)` (short-lived AND never outliving the parent — a
/// `None` parent expiry is treated as "no parent bound" so the short TTL alone applies). PURE.
pub fn build_child_grant(
    parent: &TrustGrant,
    req: &SubagentRequest,
    parent_run_id: &str,
    seq: u64,
    now_ms: i64,
) -> TrustGrant {
    let short_ttl_expiry = now_ms.saturating_add(SUBAGENT_SHORT_TTL_MS);
    let expires_at = Some(match parent.expires_at {
        Some(parent_exp) => parent_exp.min(short_ttl_expiry),
        None => short_ttl_expiry,
    });
    TrustGrant {
        grant_id: format!("{}:{seq}:{now_ms}", child_run_id(parent_run_id, seq)),
        agent_id: child_agent_id(parent_run_id, seq),
        granted_at: now_ms,
        expires_at,
        revoked: false,
        revoked_at: None,
        boundaries: mint_child_boundaries(&parent.boundaries, req),
    }
}

/// Clamp a requested `max_turns` to `[1, SUBAGENT_MAX_TURNS]` AND to `parent_remaining` (the
/// parent's not-yet-spent turn budget). `None` requested ⇒ the default clamp. Always ≥ 1 (a
/// sub-agent gets at least one turn) and never exceeds either bound (guard 4). PURE.
pub fn clamp_max_turns(requested: Option<u64>, parent_remaining: u64) -> u64 {
    let want = requested
        .unwrap_or(SUBAGENT_MAX_TURNS)
        .clamp(1, SUBAGENT_MAX_TURNS);
    // Never exceed the parent's remaining budget, but always allow at least 1 turn.
    want.min(parent_remaining.max(1))
}

/// Pure flag-matcher for the `FRIDAY_SUBAGENT_TOOL_ENABLED` env var (env read split out for
/// race-free unit tests, mirroring the L2 capability-flag idiom). ONLY the literal `"1"`
/// (trimmed) enables; everything else (incl. `"true"`) is OFF (DARK default).
pub(crate) fn subagent_tool_enabled_from(raw: Option<String>) -> bool {
    matches!(raw, Some(v) if v.trim() == "1")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent_boundaries() -> TrustBoundaries {
        TrustBoundaries {
            workspace: Some("/work/friday".into()),
            risk_ceiling: Risk::High,
            token_ceiling: Some(1000),
            max_runs: Some(5),
            auto_allow_reversible_ceiling: None,
            allowed_channels: vec!["telegram".into()],
            allowed_providers: vec!["deepseek".into()],
            // parent CAN spawn + read + write
            allowed_tools: vec![
                "read_file".into(),
                "list_dir".into(),
                "write_file".into(),
                "run_command".into(),
                SUBAGENT_TOOL.into(),
            ],
            allowed_workflow_families: vec!["nightly".into()],
            allowed_skill_families: vec![],
        }
    }

    fn parent_grant() -> TrustGrant {
        TrustGrant {
            grant_id: "parent-g".into(),
            agent_id: "friday".into(),
            granted_at: 1,
            expires_at: Some(1_000_000),
            revoked: false,
            revoked_at: None,
            boundaries: parent_boundaries(),
        }
    }

    #[test]
    fn parse_requires_task() {
        assert_eq!(
            parse_subagent_params(&[]).unwrap_err(),
            SubagentParamError::MissingTask
        );
        assert_eq!(
            parse_subagent_params(&[("task".into(), "   ".into())]).unwrap_err(),
            SubagentParamError::MissingTask
        );
        let req = parse_subagent_params(&[
            ("task".into(), "summarize notes".into()),
            ("tools".into(), "read_file, list_dir ,".into()),
            ("max_turns".into(), "2".into()),
        ])
        .unwrap();
        assert_eq!(req.task, "summarize notes");
        assert_eq!(
            req.requested_tools,
            Some(vec!["read_file".into(), "list_dir".into()])
        );
        assert_eq!(req.requested_max_turns, Some(2));
    }

    #[test]
    fn owner_spoof_param_is_ignored() {
        // GUARD 5: a fabricated owner/principal/agent_id param is never read — there is no field
        // for it on SubagentRequest, so it cannot reach the child policy.
        let req = parse_subagent_params(&[
            ("task".into(), "do x".into()),
            ("owner".into(), "attacker".into()),
            ("principal".into(), "root".into()),
            ("agent_id".into(), "friday".into()),
        ])
        .unwrap();
        assert_eq!(req.task, "do x");
        assert_eq!(req.requested_tools, None);
        // No surface anywhere on the parsed request carries the spoofed owner.
        let dbg = format!("{req:?}");
        assert!(
            !dbg.contains("attacker") && !dbg.contains("root"),
            "spoof leaked: {dbg}"
        );
    }

    #[test]
    fn mint_default_is_read_only_subset_and_never_spawns() {
        // GUARD 2 + 3: default (no `tools`) ⇒ the read-only subset of the parent's tools; the
        // child can NEVER spawn (subagent stripped) and the ceiling drops to ReadOnly.
        let req = SubagentRequest {
            task: "t".into(),
            requested_tools: None,
            requested_max_turns: None,
        };
        let child = mint_child_boundaries(&parent_boundaries(), &req);
        assert_eq!(
            child.allowed_tools,
            vec!["read_file".to_string(), "list_dir".to_string()]
        );
        assert!(
            !child.allowed_tools.contains(&SUBAGENT_TOOL.to_string()),
            "child must not spawn"
        );
        assert!(
            !child.allowed_tools.contains(&"write_file".to_string()),
            "default is read-only"
        );
        assert_eq!(
            child.risk_ceiling,
            Risk::ReadOnly,
            "default ceiling drops to read-only"
        );
        // Workspace inherited at-or-under the parent.
        assert_eq!(child.workspace, Some("/work/friday".into()));
    }

    #[test]
    fn mint_clamps_every_dimension_down_no_widening() {
        // GUARD 2 (the #7 core): a FABRICATED BROAD request never widens any dimension.
        let req = SubagentRequest {
            task: "t".into(),
            // request tools the parent has + tools the parent LACKS + subagent (recursion attempt)
            requested_tools: Some(vec![
                "read_file".into(),   // parent has → kept
                "write_file".into(),  // parent has → kept
                "delete_file".into(), // parent LACKS → dropped (not granted)
                "move_file".into(),   // parent LACKS → dropped
                SUBAGENT_TOOL.into(), // recursion attempt → stripped
            ]),
            requested_max_turns: Some(9999),
        };
        let parent = parent_boundaries();
        let child = mint_child_boundaries(&parent, &req);

        // allowed_tools = requested ∩ parent, minus subagent. delete_file/move_file dropped.
        assert_eq!(
            child.allowed_tools,
            vec!["read_file".to_string(), "write_file".to_string()]
        );
        assert!(
            !child.allowed_tools.contains(&"delete_file".to_string()),
            "parent-lacked tool must be dropped"
        );
        assert!(
            !child.allowed_tools.contains(&SUBAGENT_TOOL.to_string()),
            "subagent must be stripped"
        );

        // risk_ceiling = min(parent High, requested) — never above the parent.
        assert!(
            child.risk_ceiling <= parent.risk_ceiling,
            "ceiling never exceeds parent"
        );

        // workspace inherited (at-or-under) — no widening.
        assert_eq!(child.workspace, parent.workspace);

        // non-tool allowlists are the parent's (intersection with itself), never a superset.
        assert_eq!(child.allowed_channels, parent.allowed_channels);
        assert_eq!(child.allowed_providers, parent.allowed_providers);
        assert_eq!(
            child.allowed_workflow_families,
            parent.allowed_workflow_families
        );
        // deferred dims carried, not raised.
        assert_eq!(child.token_ceiling, parent.token_ceiling);
        assert_eq!(child.max_runs, parent.max_runs);

        // Every child allowlist entry is a subset of the parent's (the universal ⊆ property).
        for t in &child.allowed_tools {
            assert!(parent.allowed_tools.contains(t), "tool {t} not ⊆ parent");
        }
    }

    #[test]
    fn requesting_a_tool_the_parent_lacks_never_grants_it() {
        // Even a read-only-looking parent: a child cannot gain a tool the parent never had.
        let mut parent = parent_boundaries();
        parent.allowed_tools = vec!["read_file".into()]; // parent ONLY reads
        let req = SubagentRequest {
            task: "t".into(),
            requested_tools: Some(vec![
                "read_file".into(),
                "run_command".into(),
                "delete_file".into(),
            ]),
            requested_max_turns: None,
        };
        let child = mint_child_boundaries(&parent, &req);
        assert_eq!(
            child.allowed_tools,
            vec!["read_file".to_string()],
            "only the parent-held tool survives"
        );
    }

    #[test]
    fn empty_parent_tools_stays_deny_all() {
        // GUARD 2: an EMPTY parent allowlist is DENY-ALL; the intersection stays empty (never widened).
        let mut parent = parent_boundaries();
        parent.allowed_tools = vec![];
        let req = SubagentRequest {
            task: "t".into(),
            requested_tools: Some(vec!["read_file".into(), "write_file".into()]),
            requested_max_turns: None,
        };
        let child = mint_child_boundaries(&parent, &req);
        assert!(
            child.allowed_tools.is_empty(),
            "empty parent ⇒ empty child (DENY-ALL)"
        );
    }

    #[test]
    fn expiry_is_min_of_parent_and_short_ttl() {
        // GUARD 2: short-lived AND never outliving the parent.
        let now = 100_000;
        // (a) parent expires SOONER than now+TTL ⇒ child = parent's expiry.
        let mut p = parent_grant();
        p.expires_at = Some(now + 1000); // sooner than now + 5min
        let child = build_child_grant(
            &p,
            &SubagentRequest {
                task: "t".into(),
                requested_tools: None,
                requested_max_turns: None,
            },
            "run1",
            0,
            now,
        );
        assert_eq!(
            child.expires_at,
            Some(now + 1000),
            "bounded by the sooner parent expiry"
        );

        // (b) parent expires LATER than now+TTL ⇒ child = now + SHORT_TTL (short-lived).
        let mut p2 = parent_grant();
        p2.expires_at = Some(now + 10 * 60 * 1000); // 10 min, later than the 5min TTL
        let child2 = build_child_grant(
            &p2,
            &SubagentRequest {
                task: "t".into(),
                requested_tools: None,
                requested_max_turns: None,
            },
            "run1",
            0,
            now,
        );
        assert_eq!(
            child2.expires_at,
            Some(now + SUBAGENT_SHORT_TTL_MS),
            "bounded by the short TTL"
        );

        // (c) parent has NO expiry ⇒ child STILL bounded by the short TTL (never unbounded).
        let mut p3 = parent_grant();
        p3.expires_at = None;
        let child3 = build_child_grant(
            &p3,
            &SubagentRequest {
                task: "t".into(),
                requested_tools: None,
                requested_max_turns: None,
            },
            "run1",
            0,
            now,
        );
        assert_eq!(
            child3.expires_at,
            Some(now + SUBAGENT_SHORT_TTL_MS),
            "no-expiry parent still short-lived"
        );
    }

    #[test]
    fn child_ids_are_distinct_and_stable() {
        assert_eq!(child_agent_id("run1", 0), "subagent:run1:0");
        assert_eq!(child_run_id("run1", 0), "run1:sub0");
        assert_eq!(child_run_id("run1", 2), "run1:sub2");
        // child run id is distinct from the parent ⇒ no ledger id collision (guard 7).
        assert_ne!(child_run_id("run1", 0), "run1");
    }

    #[test]
    fn max_turns_clamps_to_ceiling_and_remaining() {
        // GUARD 4: clamp to [1, SUBAGENT_MAX_TURNS] and to the parent's remaining budget.
        assert_eq!(
            clamp_max_turns(Some(9999), 100),
            SUBAGENT_MAX_TURNS,
            "clamped to the hard ceiling"
        );
        assert_eq!(clamp_max_turns(Some(0), 100), 1, "always at least 1");
        assert_eq!(
            clamp_max_turns(None, 100),
            SUBAGENT_MAX_TURNS,
            "default = ceiling"
        );
        assert_eq!(
            clamp_max_turns(Some(3), 2),
            2,
            "clamped to the parent's remaining budget"
        );
        assert_eq!(
            clamp_max_turns(Some(3), 0),
            1,
            "remaining 0 still yields ≥1"
        );
    }

    #[test]
    fn flag_matcher_only_literal_one() {
        assert!(subagent_tool_enabled_from(Some("1".into())));
        assert!(subagent_tool_enabled_from(Some(" 1 ".into())));
        assert!(!subagent_tool_enabled_from(Some("true".into())));
        assert!(!subagent_tool_enabled_from(Some("0".into())));
        assert!(!subagent_tool_enabled_from(None));
    }
}
