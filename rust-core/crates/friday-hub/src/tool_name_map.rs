//! Canonical TS↔Rust tool-name (and param-schema) reconciliation — the SINGLE SOURCE OF
//! TRUTH for translating a TS-shaped tool name into its Rust [`crate::ToolRegistry`]
//! action name.
//!
//! ## Why this exists (security pre-requisite for the executeRun-replacement)
//! The future executeRun-replacement will route production agent-runs through the Rust
//! loop, threading a per-run disabled/enabled-tool set (the TS oracle's
//! `disabledToolNames`). The TS tool surface and the Rust [`crate::ToolRegistry`] do NOT
//! share a name space:
//!
//! | TS tool | Rust registry action | note |
//! |---------|----------------------|------|
//! | `read`  | `read_file`          | fs read |
//! | `write` | `write_file`         | fs create/replace |
//! | `edit`  | `edit_file`          | fs first-occurrence replace |
//! | `exec`  | `run_command`        | shell |
//!
//! The dev bridge does NO translation. So today a TS-shaped name in `disabledToolNames`
//! (e.g. `exec`) would NOT match the Rust action the loop actually dispatches
//! (`run_command`) — [`crate::RunPolicy::is_tool_disabled`] is an exact-string check
//! against the raw Rust action, so a disabled-set entry `exec` silently FAILS to disable
//! `run_command`. That is a fail-OPEN: a tool the operator meant to disable stays enabled.
//! This module + [`crate::RunPolicy::resolve_tool`] close that hazard BEFORE any routing
//! slice consumes it.
//!
//! ## The two roles of this map
//! 1. **Translation (the load-bearing one).** [`canonical_rust_name`] maps a TS alias OR a
//!    Rust name to its canonical Rust action. The resolver canonicalizes BOTH the queried
//!    action and every disabled-set entry, so a disabled-set `exec` correctly disables a
//!    dispatched `run_command`. Without this the map would be mere documentation and the
//!    hazard would stay open.
//! 2. **Fail-closed on the unknown.** A name that is neither a known Rust action nor a
//!    known TS alias returns `None` ⇒ the resolver yields [`crate::ToolGate::UnknownFailClosed`],
//!    NEVER "allowed". A foreign / mistyped name can therefore never weaken the disabled
//!    set by sneaking through as "not disabled".
//!
//! ## Coverage of the full TS surface (no silent drops)
//! The four fs+exec tools above are the ones present on BOTH sides. The rest of the TS
//! tool surface (browser, web search/fetch, memory, desktop, nodes, skills, subagents, …)
//! has NO Rust executor yet; those are recorded EXPLICITLY in [`TS_ONLY_UNMAPPED`] (the
//! `unmapped` direction), not silently dropped — a `disabledToolNames` entry for one of
//! them is unenforceable Rust-side but fail-closed (`UnknownFailClosed`) if ever dispatched.
//! Conversely, Rust actions with no TS alias are recorded in [`RUST_ONLY_ACTIONS`].
//!
//! ## Param-schema diffs (recorded for the future routing slice; see [`PARAM_SCHEMA_DIFFS`])
//! Translating the NAME is necessary but not sufficient for a future slice that forwards
//! params: the on-both-sides tools also differ in their param schema. These are recorded
//! here (the "param-schema map" half) so the future slice has a single truth source:
//!   - `edit`: TS camelCase `oldText`/`newText` vs Rust snake_case `old_text`/`new_text`.
//!   - `exec`: TS has `workdir`/`env`/`timeoutMs`/`background`; Rust `run_command` takes
//!     `command` ONLY (the extras have no Rust executor surface yet → would be dropped).
//!   - `read`/`write`: param names already align (`path`, `content`).
//!
//! ## Truth labels
//! Dark substrate for the executeRun-replacement. `rust_wired` at best: the map + resolver
//! compile and are unit-tested, but NOTHING consumes them yet (no production route, no
//! flag, no loop behavior change). NOT a v1 GO.

/// One canonical reconciliation row for a tool that exists on BOTH the TS surface and the
/// Rust [`crate::ToolRegistry`]. `ts` is the TS tool name; `rust` is the canonical Rust
/// registry action it maps to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToolNamePair {
    /// The TS-surface tool name (what a TS-shaped `disabledToolNames` entry would carry).
    pub ts: &'static str,
    /// The canonical Rust [`crate::ToolRegistry`] action name.
    pub rust: &'static str,
}

/// The TS↔Rust name map for the tools present on BOTH sides — the fs read/write/edit set
/// plus shell exec. This is the EXHAUSTIVE set of cross-language aliases; everything else
/// is either a Rust-only action (see [`RUST_ONLY_ACTIONS`]) or foreign (fail-closed).
///
/// Kept tiny and `const` on purpose: it is the security-critical translation table, so it
/// must be auditable at a glance and free of any runtime/model input.
pub const TS_RUST_PAIRS: &[ToolNamePair] = &[
    ToolNamePair {
        ts: "read",
        rust: "read_file",
    },
    ToolNamePair {
        ts: "write",
        rust: "write_file",
    },
    ToolNamePair {
        ts: "edit",
        rust: "edit_file",
    },
    ToolNamePair {
        ts: "exec",
        rust: "run_command",
    },
];

/// Rust [`crate::ToolRegistry`] actions that have NO TS disable-alias today, recorded
/// EXPLICITLY (not silently dropped) for exhaustiveness honesty. In the TS surface these
/// capabilities are reached differently — e.g. delete/move/append happen via the `exec`
/// shell tool rather than dedicated tools, and there is no TS `list_dir`/`stat`/`search`
/// tool whose name a `disabledToolNames` could carry. A future routing slice that wants
/// these to be disable-able from a TS-shaped set must add the alias here (a known gap, NOT
/// fixed by this slice).
pub const RUST_ONLY_ACTIONS: &[&str] = &[
    "list_dir",
    "stat_file",
    "search",
    "append_file",
    "delete_file",
    "move_file",
];

/// TS-surface tool names that have NO Rust [`crate::ToolRegistry`] executor today, recorded
/// EXPLICITLY as `unmapped` (NOT silently dropped). These are the agent-tools beyond the
/// fs+exec set (browser, web search/fetch, memory, desktop, nodes, skills, subagents,
/// providers, workflows, …). A `disabledToolNames` entry naming one of these is currently
/// UNENFORCEABLE on the Rust side: the action has no Rust executor, so if a future routing
/// slice ever tried to dispatch it, [`canonical_rust_name`] returns `None` and
/// [`crate::RunPolicy::resolve_tool`] yields [`crate::ToolGate::UnknownFailClosed`] — denied
/// (fail-closed), never silently allowed. Each becomes a real [`TS_RUST_PAIRS`] alias only
/// when a Rust executor for it lands (a known gap, NOT fixed by this slice).
///
/// Source: the TS `src/agent/tools/*` tool surface (`name:` fields), minus the four fs+exec
/// tools already in [`TS_RUST_PAIRS`].
pub const TS_ONLY_UNMAPPED: &[&str] = &[
    "agents_list",
    "autonomous",
    "browser",
    "canvas",
    "capabilities",
    "controlled_autonomy",
    "cron",
    "desktop",
    "feedback",
    "gateway",
    "get_subagent",
    "guide_lens",
    "image_analysis",
    "list_subagents",
    "mcp",
    "memory_extract",
    "memory_search",
    "memory_store",
    "message",
    "nodes",
    "pdf_parse",
    "provider",
    "reflex_candidate_decide",
    "reflex_candidate_list",
    "reflex_preference_update",
    "sessions",
    "setup",
    "setup_assistant",
    "skill_generate",
    "skill_import",
    "skill_run",
    "skills_list",
    "spawn_subagent",
    "system",
    "task_status",
    "tts",
    "web_fetch",
    "web_search",
    "workflow_generate",
    "workflow_list",
    "workflow_run",
    "xhs",
];

/// A recorded param-schema difference between a TS tool and its Rust action — the
/// "param-schema map" half of the reconciliation. Documentation-only in THIS slice (the
/// resolver is name-only); the future param-forwarding slice consumes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParamSchemaDiff {
    /// The TS tool the diff is about.
    pub ts: &'static str,
    /// The canonical Rust action.
    pub rust: &'static str,
    /// Human-readable description of how the param schemas differ.
    pub note: &'static str,
}

/// Param-schema diffs for the on-both-sides tools (see module docs). A future slice that
/// forwards params through the Rust loop MUST reconcile these (rename camelCase→snake_case
/// for `edit`; decide what to do with the `exec`-only knobs Rust drops).
pub const PARAM_SCHEMA_DIFFS: &[ParamSchemaDiff] = &[
    ParamSchemaDiff {
        ts: "read",
        rust: "read_file",
        note: "params align: both use `path`.",
    },
    ParamSchemaDiff {
        ts: "write",
        rust: "write_file",
        note: "params align: both use `path`, `content`.",
    },
    ParamSchemaDiff {
        ts: "edit",
        rust: "edit_file",
        note: "TS camelCase `oldText`/`newText` ↔ Rust snake_case `old_text`/`new_text` \
               (both also use `path`); a forwarding slice must rename.",
    },
    ParamSchemaDiff {
        ts: "exec",
        rust: "run_command",
        note: "TS `command` ↔ Rust `command`; TS-only `workdir`/`env`/`timeoutMs`/`background` \
               have no Rust `run_command` surface yet and would be dropped.",
    },
];

/// Canonicalize a tool name to its Rust [`crate::ToolRegistry`] action name.
///
/// Returns `Some(rust_action)` when `name` is EITHER a known Rust registry action (identity
/// — it canonicalizes to itself) OR a known TS alias (mapped via [`TS_RUST_PAIRS`]).
/// Returns `None` for a foreign / unknown / mistyped name — the caller MUST treat that as
/// fail-closed (never "allowed"), see [`crate::RunPolicy::resolve_tool`].
///
/// The input is trimmed to match the TS oracle's `normalizeToolNameSet` (trim) and
/// [`crate::RunPolicy::new`]'s normalization, so a padded `" exec "` still resolves.
///
/// This is the load-bearing translation: it lets a TS-shaped disabled-set entry (`exec`)
/// and the Rust action the loop dispatches (`run_command`) land on the SAME canonical name,
/// which is what actually closes the fail-open hazard.
pub fn canonical_rust_name(name: &str) -> Option<&'static str> {
    let name = name.trim();
    // 1. TS alias → canonical Rust action.
    if let Some(pair) = TS_RUST_PAIRS.iter().find(|p| p.ts == name) {
        return Some(pair.rust);
    }
    // 2. Already a canonical Rust action (identity). We return the &'static str from the
    //    map / Rust-only list so the result is owned by this module, never the caller's
    //    transient input — the resolver compares &'static pointers/strings, never the raw
    //    model-controlled name.
    if let Some(pair) = TS_RUST_PAIRS.iter().find(|p| p.rust == name) {
        return Some(pair.rust);
    }
    if let Some(rust) = RUST_ONLY_ACTIONS.iter().find(|r| **r == name) {
        return Some(rust);
    }
    // 3. Foreign / unknown → fail-closed.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolRegistry;

    #[test]
    fn ts_alias_canonicalizes_to_rust_action() {
        assert_eq!(canonical_rust_name("read"), Some("read_file"));
        assert_eq!(canonical_rust_name("write"), Some("write_file"));
        assert_eq!(canonical_rust_name("edit"), Some("edit_file"));
        assert_eq!(canonical_rust_name("exec"), Some("run_command"));
    }

    #[test]
    fn rust_action_canonicalizes_to_itself_identity() {
        for action in ["read_file", "write_file", "edit_file", "run_command"] {
            assert_eq!(canonical_rust_name(action), Some(action));
        }
        for action in RUST_ONLY_ACTIONS {
            assert_eq!(canonical_rust_name(action), Some(*action));
        }
    }

    #[test]
    fn foreign_name_fails_closed_to_none() {
        // A name that is neither a Rust action nor a TS alias → None (never "allowed").
        for name in [
            "frobnicate",
            "read_file_x",
            "exe",
            "",
            "ls",
            "delete",
            "move",
        ] {
            assert_eq!(
                canonical_rust_name(name),
                None,
                "{name} must not canonicalize"
            );
        }
    }

    #[test]
    fn canonicalization_trims_like_the_oracle() {
        assert_eq!(canonical_rust_name("  exec  "), Some("run_command"));
        assert_eq!(canonical_rust_name("\tread\n"), Some("read_file"));
    }

    #[test]
    fn every_pair_rust_side_is_a_real_registry_action() {
        // Exhaustiveness/consistency: every mapped Rust name MUST exist in the trusted
        // registry, else the map points at a non-existent executor.
        let reg = ToolRegistry::default();
        for pair in TS_RUST_PAIRS {
            assert!(
                reg.spec(pair.rust).is_some(),
                "TS `{}` maps to `{}`, which is not a registered Rust tool",
                pair.ts,
                pair.rust
            );
        }
        for action in RUST_ONLY_ACTIONS {
            assert!(
                reg.spec(action).is_some(),
                "Rust-only `{action}` is not a registered Rust tool"
            );
        }
    }

    #[test]
    fn map_accounts_for_every_registered_rust_tool() {
        // Exhaustiveness the OTHER direction: every action in the default Rust registry is
        // accounted for in the reconciliation — either as a TS-alias pair or as an explicit
        // Rust-only action. A new registry tool that is neither will FAIL this test,
        // forcing a deliberate reconciliation decision (alias vs Rust-only) rather than a
        // silent omission.
        let reg = ToolRegistry::default();
        for (action, _desc) in reg.advertised() {
            let is_pair = TS_RUST_PAIRS.iter().any(|p| p.rust == action);
            let is_rust_only = RUST_ONLY_ACTIONS.contains(&action);
            assert!(
                is_pair ^ is_rust_only,
                "registry tool `{action}` is not accounted for exactly once \
                 (pair={is_pair}, rust_only={is_rust_only}) — add it to TS_RUST_PAIRS or \
                 RUST_ONLY_ACTIONS"
            );
        }
    }

    #[test]
    fn param_schema_diffs_cover_exactly_the_ts_pairs() {
        // The param-schema map is consistent with the name map: one diff row per TS pair.
        assert_eq!(PARAM_SCHEMA_DIFFS.len(), TS_RUST_PAIRS.len());
        for pair in TS_RUST_PAIRS {
            assert!(
                PARAM_SCHEMA_DIFFS
                    .iter()
                    .any(|d| d.ts == pair.ts && d.rust == pair.rust),
                "missing param-schema diff for `{}`→`{}`",
                pair.ts,
                pair.rust
            );
        }
    }

    #[test]
    fn ts_only_unmapped_have_no_rust_executor_and_fail_closed() {
        // The `unmapped` direction (deliverable 1): a TS tool with no Rust executor is
        // recorded explicitly and is fail-closed — it canonicalizes to nothing (so a
        // disabled-set entry for it is unenforceable Rust-side, but DENIED if dispatched,
        // never silently allowed). It is also NOT a registered Rust tool.
        let reg = ToolRegistry::default();
        for ts in TS_ONLY_UNMAPPED {
            assert_eq!(
                canonical_rust_name(ts),
                None,
                "unmapped TS tool `{ts}` must not canonicalize to a Rust action"
            );
            assert!(
                reg.spec(ts).is_none(),
                "unmapped TS tool `{ts}` must not be a registered Rust tool"
            );
        }
    }

    #[test]
    fn ts_surface_is_partitioned_no_silent_drop_no_overlap() {
        // Every TS tool name is EITHER a mapped alias ([`TS_RUST_PAIRS`]) OR explicitly
        // unmapped ([`TS_ONLY_UNMAPPED`]) — never both, never neither. This is the
        // "not silently dropped" guarantee for the TS→Rust direction.
        for pair in TS_RUST_PAIRS {
            assert!(
                !TS_ONLY_UNMAPPED.contains(&pair.ts),
                "TS tool `{}` is both mapped and listed unmapped",
                pair.ts
            );
        }
        // Unmapped entries are unique (no dupes that could mask a real mapping gap).
        for (i, a) in TS_ONLY_UNMAPPED.iter().enumerate() {
            assert!(
                !TS_ONLY_UNMAPPED[i + 1..].contains(a),
                "duplicate unmapped TS tool `{a}`"
            );
        }
    }
}
