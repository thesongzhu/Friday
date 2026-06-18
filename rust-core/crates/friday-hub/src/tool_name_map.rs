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
//! The dev bridge does NO translation. So a TS-shaped name in `disabledToolNames`
//! (e.g. `exec`) does NOT, by itself, match the Rust action the loop actually dispatches
//! (`run_command`). A trim-only exact-string check against the raw Rust action would let a
//! disabled-set entry `exec` silently FAIL to disable `run_command` — a fail-OPEN: a tool
//! the operator meant to disable stays enabled. [`crate::RunPolicy::is_tool_disabled`] (the
//! check the LIVE gate chokepoint consults) now canonicalizes BOTH sides through this map to
//! close that hazard; [`crate::RunPolicy::resolve_tool`] does the same and additionally fails
//! CLOSED on an unknown name for the future routing slice.
//!
//! ## The two roles of this map
//! 1. **Translation (the load-bearing one).** [`canonical_rust_name`] maps a TS alias OR a
//!    Rust name to its canonical Rust action. Both [`crate::RunPolicy::is_tool_disabled`] and
//!    [`crate::RunPolicy::resolve_tool`] canonicalize BOTH the queried action and every
//!    disabled-set entry, so a disabled-set `exec` correctly disables a dispatched
//!    `run_command`. Without this the map would be mere documentation and the hazard would
//!    stay open.
//! 2. **Fail-closed on the unknown.** A name that is neither a known Rust action nor a
//!    known TS alias returns `None` ⇒ the resolver yields [`crate::ToolGate::UnknownFailClosed`],
//!    NEVER "allowed". A foreign / mistyped name can therefore never weaken the disabled
//!    set by sneaking through as "not disabled".
//!
//! ## Coverage of the TS surface
//! The four fs+exec tools above are the ones present on BOTH sides. The rest of the TS
//! tool surface (browser, web search/fetch, memory, desktop, nodes, skills, subagents, …)
//! has NO Rust executor yet; those are recorded in [`TS_ONLY_UNMAPPED`] (the `unmapped`
//! direction). NOTE: that list is a best-effort INVENTORY of the known TS surface, NOT a
//! compiler-guaranteed-exhaustive enumeration of the live TS tool registry (the live
//! surface evolves; e.g. `request_tool_pack`/`tool_search` were added late) — so do NOT
//! rely on it for completeness. **The SECURITY guarantee does not depend on this list being
//! complete:** the resolver consults ONLY [`TS_RUST_PAIRS`] + [`RUST_ONLY_ACTIONS`], so ANY
//! name absent from both — whether or not it appears in [`TS_ONLY_UNMAPPED`] — canonicalizes
//! to nothing and fail-closes (`UnknownFailClosed`) if dispatched. The unmapped list is
//! documentation/ledger for the future routing slice, not a security boundary.
//! Conversely, Rust actions with no TS alias are recorded in [`RUST_ONLY_ACTIONS`].
//!
//! ## Param-schema diffs (recorded for the future routing slice; see [`PARAM_SCHEMA_DIFFS`])
//! Translating the NAME is necessary but not sufficient for a future slice that forwards
//! params: the on-both-sides tools also differ in their param schema. These are recorded
//! here (the "param-schema map" half) so the future slice has a single truth source:
//!   - `edit`: TS camelCase `oldText`/`newText` vs Rust snake_case `old_text`/`new_text`.
//!   - `exec`: TS has `workdir`/`env`/`timeoutMs`/`background`; Rust `run_command` takes
//!     `command` ONLY (the extras have no Rust executor surface yet → would be dropped).
//!   - `read`: TS also declares + honors line-window `offset`/`limit`; Rust `read_file`
//!     reads ONLY `path` (the window args have no Rust surface → must fail closed, never
//!     be dropped: dropping them silently reads the WHOLE file instead of a window).
//!   - `write`: param names align (`path`, `content`).
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
    // L2-1: web_fetch is present on BOTH sides under the SAME name (the TS tool name and the
    // Rust registry action are both `web_fetch`), so the alias is an identity row. Listing it
    // here (rather than RUST_ONLY_ACTIONS) keeps a TS-shaped `disabledToolNames` entry of
    // `web_fetch` correctly disabling the dispatched Rust `web_fetch`, AND lets the
    // FRIDAY_WEB_FETCH_ENABLED flag-gate canonicalize an alias of it (there is only the one
    // form today, but the chokepoint canonicalizes through this map regardless).
    ToolNamePair {
        ts: "web_fetch",
        rust: "web_fetch",
    },
    // L2-2: web_search is likewise present on BOTH sides under the SAME name (the TS tool and
    // the Rust registry action are both `web_search`), an identity alias. Listing it here keeps
    // a TS-shaped `disabledToolNames` entry of `web_search` disabling the Rust `web_search`, AND
    // lets the FRIDAY_WEB_SEARCH_ENABLED flag-gate canonicalize an alias of it through this map.
    ToolNamePair {
        ts: "web_search",
        rust: "web_search",
    },
    // L2-3: image_analysis is likewise present on BOTH sides under the SAME name (the TS tool and
    // the Rust registry action are both `image_analysis`), an identity alias. Listing it here
    // keeps a TS-shaped `disabledToolNames` entry of `image_analysis` disabling the Rust
    // `image_analysis`, AND lets the FRIDAY_VISION_ENABLED flag-gate canonicalize an alias of it
    // through this map.
    ToolNamePair {
        ts: "image_analysis",
        rust: "image_analysis",
    },
    // B5 media: TTS and PDF parsing now have Rust Hub executors under the SAME names as their TS
    // tools. Listing them here makes disabledToolNames / trust allowlists canonicalize to the
    // registered Rust actions and lets FRIDAY_MEDIA_TOOL_ENABLED catch aliases at the chokepoint.
    ToolNamePair {
        ts: "tts",
        rust: "tts",
    },
    ToolNamePair {
        ts: "pdf_parse",
        rust: "pdf_parse",
    },
    // L2 subagent: the Rust registry action is `subagent`; this identity row lets the
    // FRIDAY_SUBAGENT_TOOL_ENABLED chokepoint flag-gate canonicalize an alias of it through this
    // map (mirroring the web_fetch/web_search/image_analysis identity rows), AND keeps a
    // `disabledToolNames` entry of `subagent` disabling the dispatched Rust `subagent` — which is
    // load-bearing for the depth cap (a child run's disabled-set entry `subagent` must canonicalize
    // to the dispatched `subagent` so a sub-agent's spawn is refused `tool_disabled_for_run`). The
    // TS spawn tool is named `spawn_subagent` (distinct, no Rust executor) and stays in
    // TS_ONLY_UNMAPPED — this row aliases only the Rust action's own name.
    ToolNamePair {
        ts: "subagent",
        rust: "subagent",
    },
    // L2-4: memory_recall is the Rust recall action; it is present under the SAME name on the
    // Rust side (identity alias), so a TS-shaped `disabledToolNames` entry of `memory_recall`
    // disables it, AND the FRIDAY_MEMORY_TOOL_ENABLED flag-gate canonicalizes it through this map.
    ToolNamePair {
        ts: "memory_recall",
        rust: "memory_recall",
    },
    // L2-4: the TS oracle's recall tool is named `memory_search`; it maps to the Rust
    // `memory_recall` action (the Rust name is `memory_recall` to read as "recall the owner's
    // confirmed memory"). Listing this NON-identity alias keeps a TS-shaped `disabledToolNames`
    // entry of `memory_search` correctly disabling the dispatched Rust `memory_recall`.
    ToolNamePair {
        ts: "memory_search",
        rust: "memory_recall",
    },
    // L2-4: memory_store is present under the SAME name on both sides (identity alias), so a
    // TS-shaped `disabledToolNames` entry of `memory_store` disables the Rust `memory_store`, AND
    // the FRIDAY_MEMORY_TOOL_ENABLED flag-gate canonicalizes it through this map.
    ToolNamePair {
        ts: "memory_store",
        rust: "memory_store",
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
    "ocr_extract",
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
    // L2-3: `image_analysis` now has a Rust executor (vision_tools::VisionExecutor) and is a
    // TS_RUST_PAIRS identity alias above — removed from the unmapped list.
    "list_subagents",
    "mcp",
    "memory_extract",
    // L2-4: `memory_search` (the TS recall tool) now maps to the Rust `memory_recall` executor,
    // and `memory_store` now has a Rust executor (memory_tools::MemoryToolExecutor) — both are
    // TS_RUST_PAIRS aliases above, removed from the unmapped list. (`memory_extract` stays
    // unmapped: extraction is a job-driven path — memory_extraction::extract_inline — NOT an
    // agent tool.)
    "message",
    "nodes",
    "provider",
    "reflex_candidate_decide",
    "reflex_candidate_list",
    "reflex_preference_update",
    "request_tool_pack",
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
    "tool_search",
    // B5: `tts` and `pdf_parse` now have Rust executors and TS_RUST_PAIRS identity aliases.
    // `ocr_extract` is Rust-only for now: there is no TS agent tool named OCR today.
    // L2-1: `web_fetch` now has a Rust executor (http_tools::WebFetchExecutor) and is a
    // TS_RUST_PAIRS identity alias above — removed from the unmapped list.
    // L2-2: `web_search` likewise now has a Rust executor (web_search::WebSearchExecutor) and
    // is a TS_RUST_PAIRS identity alias above — removed from the unmapped list.
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
        note: "both use `path`, but TS `read` also declares AND honors line-window \
               `offset`/`limit` (1-indexed line slicing); the Rust `read_file` executor \
               reads ONLY `path`, so the window args have no Rust surface — a forwarding \
               slice must fail closed on them (dropping them silently reads the whole file).",
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
    ParamSchemaDiff {
        ts: "web_fetch",
        rust: "web_fetch",
        note: "params align by name: `url`/`method`/`headers`/`body`/`timeoutMs`/`parseHtml`. \
               The Rust executor takes `headers` as a flattened `\"k:v\\nk:v\"` string (the dev \
               bridge serializes the TS object this way) rather than a nested object; \
               everything else matches the TS schema. The Rust side ENFORCES the same caps \
               (512KB read / 100KB model-facing / 30s default timeout) the TS tool documents.",
    },
    ParamSchemaDiff {
        ts: "web_search",
        rust: "web_search",
        note: "params align by name: `query` (required) / `numResults` (1-20, default 5) / \
               `freshness` (day|week|month, optional). The Rust executor reads the provider \
               config (provider + serper/tavily keys) from construction (env in prod) rather \
               than tool params — same as the TS factory options — and applies the same 15s \
               timeout + the same multi-provider routing (auto→keyless when premium keys are \
               absent; explicit serper/tavily without its key fails closed with a warning, NO \
               silent fallback). It returns snippets only (never fetches result pages).",
    },
    ParamSchemaDiff {
        ts: "image_analysis",
        rust: "image_analysis",
        note: "params align by name: `prompt` (required) / `images` (required: workspace-path / \
               http(s)-url / data:URI) / `model` (optional) / `detail` low|high|auto (optional) / \
               `maxTokens` (optional). The Rust executor takes `images` as a flattened newline-\
               separated string (the dev bridge serializes the TS string[] this way) rather than \
               a nested array; everything else matches the TS schema. TWO deliberate Rust-side \
               behaviors: (1) `detail` is OpenAI-shaped and has NO Anthropic image-block field, \
               so it is VALIDATED for parity but NOT forwarded to the Claude API (a no-op for \
               the Claude route — documented honest gap); (2) the vision provider key is read \
               from env (FRIDAY_ANTHROPIC_API_KEY) at call time, not a tool param — same as the \
               TS factory's injected vision-model fn. The Rust side ENFORCES image-input \
               validation the TS tool documents: workspace-root scoping for local paths, SSRF on \
               URL images, data-uri base64 + media-type (image/*) + decoded-size caps, and \
               image-count/total-size bounds.",
    },
    ParamSchemaDiff {
        ts: "tts",
        rust: "tts",
        note: "params align by name: `text` (required) / `voice` / `format` mp3|wav|opus / \
               `speed` / `model`. Rust DARK runtime currently returns audio metadata only and \
               does NOT persist an audio artifact path; live provider/file-output parity remains \
               a later operator-gated slice. `tts` is registered mutating because it produces an \
               audio output/cost surface, matching the TS risk posture.",
    },
    ParamSchemaDiff {
        ts: "pdf_parse",
        rust: "pdf_parse",
        note: "params align by name: `path` (required) / `maxPages` / `maxChars` (Rust also \
               accepts snake_case aliases). Rust opens the PDF through the hardened workspace-root \
               safe-open and delegates text extraction to friday-pdf's conservative embedded-text \
               extractor; it does not import the TS pdfjs engine.",
    },
    ParamSchemaDiff {
        ts: "subagent",
        rust: "subagent",
        note: "params: `task` (required, the sub-task) / `tools` (optional comma-list subset to \
               grant the child; default = the read-only subset of the parent's) / `max_turns` \
               (optional, clamped). There is deliberately NO `owner`/`principal` param — the \
               sub-agent inherits the parent's authenticated principal (a model-supplied owner is \
               impossible to assert and so cannot escalate). Unlike the other L2 tools this is NOT \
               a CompositeToolExecutor action: it is INTERCEPTED at the loop dispatch seam, which \
               mints a ⊆-parent TrustGrant (via the existing friday-storage trust-issue path) and \
               recurses into a bounded nested `run_loop_with_policy` under a child RunPolicy.",
    },
    ParamSchemaDiff {
        ts: "memory_recall",
        rust: "memory_recall",
        note: "params align by name: `query` / `limit` (1-10). DELIBERATE Rust-side scoping: the \
               TS oracle's model-controlled `namespace` param is DROPPED — recall keys ONLY on \
               the run's AUTHENTICATED principal (no cross-owner read). The Rust spine ranks by \
               recency-decay (no FTS/lexical layer yet), so `query` is accepted for parity but \
               does not drive a new ranking — the recall set is the owner's most-recent confirmed \
               memory (the SAME set auto-recall injects), PII-redacted + Passport-gated.",
    },
    ParamSchemaDiff {
        ts: "memory_search",
        rust: "memory_recall",
        note: "the TS recall tool is named `memory_search`; it maps to the Rust `memory_recall` \
               action. Same param schema as the `memory_recall`→`memory_recall` row (`query` / \
               `limit`, model-supplied `namespace` DROPPED, recall keyed on the authenticated \
               principal). The two pairs differ only in the TS-side name.",
    },
    ParamSchemaDiff {
        ts: "memory_store",
        rust: "memory_store",
        note: "params align by name: `content` (required) / `tags`. The Rust executor takes \
               `tags` as a flattened newline-separated string (the dev bridge serializes the TS \
               string[] this way) and uses them ONLY for the sensitivity check (the Rust \
               memory_item row has no tags column — same disclosed deviation as extraction). \
               DELIBERATE Rust-side scoping: the TS oracle's model-controlled `namespace` param \
               is DROPPED — the candidate's owner is the run's AUTHENTICATED principal (no \
               cross-owner write). Unlike the TS oracle's direct durable store, the Rust store \
               mints a CANDIDATE (state=Candidate, non-durable) that is recallable only after the \
               owner confirms it (the spine's extract→confirm→recall lifecycle).",
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
