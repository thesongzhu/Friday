//! L2-4 memory-as-tool — expose the already-built memory spine (extract→confirm→recall) as
//! two explicit AGENT tools, on the same L2 composite-executor pattern as web_fetch / web_search
//! / image_analysis (#771/#774/#775).
//!
//! Ported from the TS oracle `src/agent/tools/friday-agent-memory-tools.ts` (`memory_search` +
//! `memory_store`). This is the FOURTH L2 capability tool family. It lets the agent EXPLICITLY
//! recall the owner's confirmed memory (read) and propose a new memory CANDIDATE (owner-scoped),
//! ON TOP OF the unchanged auto-extraction (`memory_extraction::extract_inline`) + auto-recall
//! (the runtime's recall preamble). This module ADDS explicit agent control; it changes NEITHER
//! auto path.
//!
//! ## Reuse, NOT reimplementation (the binding constraint)
//! Every memory primitive is the EXISTING spine — this module is a thin adapter:
//!   - **recall** delegates to [`friday_storage::memory::recall_confirmed`] (same-principal +
//!     Confirmed + content-bearing SQL filter) → [`crate::cognition::rank_recall`] (recency-decay
//!     top-k + PII redaction) → [`crate::cognition::gate_and_render_recall`] (the per-item Context
//!     Passport gate — a `sensitive` memory drops itself under v1 deny-all). This is the IDENTICAL
//!     chain the runtime's auto-recall preamble renders ([`crate::recall_preamble_for`]); the only
//!     difference is the agent triggers it on demand. NO new ranking / redaction / gate logic.
//!   - **store** delegates to [`friday_storage::memory::record_candidate`] (writes
//!     `state = Candidate`, NON-durable) — the SAME primitive `memory_extraction::extract_inline`
//!     uses to persist an auto-extracted candidate. A candidate is recallable ONLY after explicit
//!     owner-confirm ([`friday_storage::memory::confirm`]); the store tool mints the candidate, it
//!     does NOT make it a fact. The sensitivity guard ([`crate::sensitive_guard`]) runs BEFORE the
//!     store, exactly as extraction's `filter_sensitive` does, so a sensitive item is never even
//!     stored as a candidate.
//!
//! ## Owner-scoping (load-bearing — NO cross-owner read/write)
//! BOTH actions key on the run's AUTHENTICATED principal — `self.policy.principal_id()` carried
//! into [`MemoryToolExecutor::principal`] at construction — NEVER a model-supplied owner/namespace.
//! The TS oracle's model-controlled `namespace` param is DELIBERATELY DROPPED (see the parity note
//! on [`MemoryToolExecutor::store`]): a model can never widen its scope. Recall's per-principal SQL
//! stays `principal_id = ?` EXACT-MATCH (the [`recall_confirmed`] boundary), and store writes the
//! candidate's `principal_id` to the SAME authenticated principal, so a different principal can
//! neither read nor write this owner's rows. A run with NO bound principal recalls NOTHING
//! (fail-closed) and store REFUSES (a candidate with no owner would be unrecallable + unscoped).
//!
//! ## Wiring + flag
//! Both `memory_recall` + `memory_store` are REGISTERED in [`crate::ToolRegistry::default`]
//! (`mutating:false, Risk::ReadOnly` — see the registry comment + the classification justification
//! on [`MemoryToolExecutor::store`]), but REFUSED by the gate-dispatch chokepoint unless
//! `FRIDAY_MEMORY_TOOL_ENABLED` is exactly `"1"` (default-OFF → DARK → flag-OFF byte-identical) AND
//! HIDDEN from the model menu while off — the SAME posture as #771/#774/#775.
//! [`crate::http_tools::CompositeToolExecutor`] routes `memory_recall`/`memory_store` here;
//! everything else stays on the inner fs / web / vision executors.

use crate::{ExecError, ToolExecutor, ToolReceipt};
use friday_core::MemoryScope;
use friday_storage::memory::{record_candidate, NewMemoryCandidate};
use rusqlite::Connection;

/// Max recall results returned to the model in one `memory_recall` call. Bounds how much
/// recalled context one explicit call may inject (the auto-recall preamble uses
/// [`crate::cognition::DEFAULT_RECALL_TOP_K`]; the explicit tool honors a model-supplied `limit`
/// clamped to this ceiling). Mirrors the TS oracle's default `limit` of 10 capped for safety.
pub const MAX_RECALL_RESULTS: usize = 10;

/// Executes the `memory_recall` (read) + `memory_store` (propose a candidate) actions by
/// delegating to the EXISTING memory spine. Holds a borrowed DB [`Connection`], the run's
/// AUTHENTICATED principal (the owner-scope — NEVER a model-supplied owner), `now_ms` (the run
/// clock, for the candidate's `created_at`), and an `id_prefix` to mint deterministic candidate
/// ids. Constructed PER-DISPATCH by the runtime (which has `self.db.conn()`,
/// `policy.principal_id()`, and `now_ms` all in scope) and wired into the
/// [`crate::http_tools::CompositeToolExecutor`]. Implements [`ToolExecutor`] for ONLY the two
/// memory actions.
pub struct MemoryToolExecutor<'c> {
    conn: &'c Connection,
    /// The ORDERED dual-read recall principals (`[hardened, legacy]` under F5.5, or a single
    /// namespace by default) — recall reads the UNION over these via [`recall_confirmed_multi`],
    /// IDENTICAL to how the sessioned auto-recall preamble reads. EMPTY ⇒ recall returns nothing +
    /// store refuses (fail-closed: no owner ⇒ a candidate would be unrecallable). The STORE always
    /// keys on `recall_principals[0]` — the PRIMARY (hardened-when-on) namespace, the SAME target
    /// auto-extraction writes under — so the store↔recall keys stay aligned.
    recall_principals: Vec<String>,
    /// The run clock (the candidate's `created_at`; the recall recency-decay anchor).
    now_ms: i64,
    /// Prefix for the minted candidate `memory_id` (e.g. `"<run_id>:memtool"`), so distinct calls
    /// in one run never collide. A per-call monotonic counter is appended.
    id_prefix: String,
    /// Per-call counter appended to `id_prefix` so two stores in one dispatch get distinct ids.
    /// `Cell` because [`ToolExecutor::execute`] takes `&self`.
    counter: std::cell::Cell<u64>,
}

impl<'c> MemoryToolExecutor<'c> {
    /// Construct from the run's borrowed DB connection, the AUTHENTICATED principal (the
    /// owner-scope, a SINGLE namespace), the run clock, and an id prefix. Used by the
    /// SESSIONLESS/routed entry where recall keys on `policy.principal_id()` (one namespace, no
    /// dual-read). `principal == None` is the fail-closed no-owner shape (recall reads nothing,
    /// store refuses). For the SESSIONED entries' dual-read candidate list use
    /// [`MemoryToolExecutor::with_recall_principals`].
    pub fn new(
        conn: &'c Connection,
        principal: Option<&str>,
        now_ms: i64,
        id_prefix: impl Into<String>,
    ) -> Self {
        Self::with_recall_principals(
            conn,
            principal.into_iter().map(str::to_string).collect(),
            now_ms,
            id_prefix,
        )
    }

    /// Construct with the ORDERED dual-read recall principals (the
    /// [`crate::session_namespace::resolve_session_memory_namespace_candidates`] output the
    /// SESSIONED auto-recall reads over). Recall reads the UNION (via [`recall_confirmed_multi`]),
    /// so a tool-recall surfaces the SAME set auto-recall does even after the F5.5 hardening flag is
    /// flipped (legacy rows still recalled). STORE keys on the PRIMARY (`recall_principals[0]`). An
    /// EMPTY list is the fail-closed no-owner shape (recall nothing, store refuse).
    pub fn with_recall_principals(
        conn: &'c Connection,
        recall_principals: Vec<String>,
        now_ms: i64,
        id_prefix: impl Into<String>,
    ) -> Self {
        Self {
            conn,
            recall_principals,
            now_ms,
            id_prefix: id_prefix.into(),
            counter: std::cell::Cell::new(0),
        }
    }

    fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// `memory_recall` — query the owner's CONFIRMED memory (READ-ONLY). Delegates to the EXISTING
    /// recall chain ([`recall_confirmed_multi`] over the dual-read candidate namespaces →
    /// [`rank_recall`] → [`gate_and_render_recall`]) — the IDENTICAL chain the runtime's auto-recall
    /// preamble renders ([`crate::recall_preamble_for_principals`]). Reading the dual-read UNION (not
    /// just the primary) means a tool-recall surfaces the SAME set auto-recall does even after the
    /// F5.5 hardening flag is flipped (legacy-namespace rows still recalled — no destructive re-key).
    /// The `query` param is accepted for TS parity but does NOT drive a new ranking: the spine ranks
    /// by recency-decay (no FTS/lexical layer exists in the Rust spine yet — a faithful, disclosed
    /// deviation; the recall set is the owner's most-recent confirmed memory). PII is redacted + the
    /// Passport gate is applied by the reused primitives — NOT re-implemented here.
    ///
    /// EMPTY recall-principals (no bound owner) ⇒ EMPTY result (fail-closed: recall nothing). The
    /// result is the rendered preamble lines as the model-facing content; the summary is REFS-ONLY
    /// (a count, NEVER the recalled bodies — the recall content is PII-redacted but still owner data,
    /// kept off the audit-summary surface, mirroring web_fetch keeping the body off the ledger).
    fn recall(&self, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        // `limit`: TS-parity, clamped to MAX_RECALL_RESULTS. An absent/invalid limit ⇒ the cap.
        let limit = Self::param(params, "limit")
            .and_then(|s| s.trim().parse::<usize>().ok())
            .unwrap_or(MAX_RECALL_RESULTS)
            .clamp(1, MAX_RECALL_RESULTS);

        // No bound recall principal(s) ⇒ recall NOTHING (fail-closed — never a wildcard/'' match).
        if self.recall_principals.is_empty() {
            return Ok(ToolReceipt {
                action: "memory_recall".to_string(),
                summary: "memory_recall: 0 result(s) (no bound owner)".to_string(),
                content: Some(NO_RECALL_RESULTS.to_string()),
            });
        }

        // REUSE the spine: the dual-read UNION over the ORDERED candidate namespaces. Each
        // per-principal SQL inside `recall_confirmed_multi` stays `principal_id = ?` EXACT-MATCH
        // (the union + dedup happen in memory), so this can never widen to another owner's rows.
        // Then recency-decay + PII redaction (rank_recall) → per-item Passport gate
        // (gate_and_render_recall). NO new ranking/redaction/gate logic here.
        let principal_refs: Vec<&str> = self.recall_principals.iter().map(String::as_str).collect();
        let rows = friday_storage::memory::recall_confirmed_multi(self.conn, &principal_refs)
            .map_err(ExecError::Memory)?;
        let ranked = crate::cognition::rank_recall(
            &rows,
            self.now_ms,
            limit,
            crate::cognition::DEFAULT_HALF_LIFE_MS,
        );
        // v1 deny-all: no sensitive-transfer approval is wired (same as the auto-recall preamble),
        // so a `sensitive` memory drops itself per-item and the rest still render.
        let (preamble, receipt) = crate::cognition::gate_and_render_recall(&ranked, false);

        // model-facing content: the rendered recall lines (already PII-redacted + Passport-gated),
        // or the no-results marker. summary: REFS-ONLY counts (never the bodies).
        let content = if preamble.is_empty() {
            NO_RECALL_RESULTS.to_string()
        } else {
            preamble
        };
        let summary = format!(
            "memory_recall: {} result(s) ({} gated)",
            receipt.injected, receipt.gated_sensitive
        );
        Ok(ToolReceipt {
            action: "memory_recall".to_string(),
            summary,
            content: Some(content),
        })
    }

    /// `memory_store` — propose a memory CANDIDATE owned by the AUTHENTICATED principal. Delegates
    /// to the EXISTING [`record_candidate`] primitive (writes `state = Candidate`, NON-durable),
    /// the SAME primitive auto-extraction uses. A candidate is recallable ONLY after explicit
    /// owner-confirm ([`friday_storage::memory::confirm`]) — this tool mints the candidate, it does
    /// NOT make it a fact.
    ///
    /// ## Classification justification (`mutating:false, Risk::ReadOnly` in the registry)
    /// A candidate is NOT a live/durable mutation: it is non-durable (`07` §6/§7 — no silent
    /// long-term write), invisible to recall until the owner explicitly confirms it, and surfaced
    /// for review via the Needs-Me / Memory-Review loop. This is EXACTLY how the spine treats
    /// candidate-creation: `memory_extraction::extract_inline` records candidates with NO approval
    /// gate — the owner-confirm step IS the gate. Classifying the store as `mutating:true` would
    /// route it to the Ed25519 approval-PAUSE gate (the wrong control: it would block the agent
    /// from proposing memory at all under deny-all, when the candidate already has its own
    /// downstream owner-confirm gate). So `mutating:false` matches the spine's own treatment of
    /// candidate-creation. The TOOL is still flag-gated OFF by default + owner-scoped + sensitivity-
    /// guarded, so a candidate can never be a covert durable/cross-owner write.
    ///
    /// ## Owner-scoping (NO cross-owner write)
    /// The candidate's `principal_id` is the run's AUTHENTICATED principal — NEVER a model-supplied
    /// owner. A `None` principal REFUSES the store (an owner-less candidate would be unrecallable +
    /// unscoped — fail-closed). The TS oracle's model-controlled `namespace` param is DROPPED: a
    /// model can never steer the candidate into another scope.
    ///
    /// ## Sensitivity guard (parity with extraction + the TS oracle)
    /// Before storing, the content + tags run through [`crate::sensitive_guard`] (the SAME guard
    /// extraction's `filter_sensitive` + the TS `isFridaySensitiveLearningCandidate` use). A match
    /// REFUSES the store (a result CARRYING the rejection — the model SEES it, never a silent skip),
    /// so a sensitive item is never even stored as a candidate. (Non-keyword PII is left for
    /// RECALL-time redaction by `rank_recall`, faithful to the TS + extraction.)
    fn store(&self, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        let content = Self::param(params, "content")
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .ok_or_else(|| ExecError::MissingParam("content".to_string()))?;

        // tags: TS-parity. The dev bridge flattens the TS string[] to one tag per line (mirrors
        // web_fetch's flattened headers). Kept only for the sensitivity check (NOT persisted — the
        // Rust memory_item row has no tags column, same as extraction's disclosed deviation).
        let tags: Vec<&str> = Self::param(params, "tags")
            .map(|raw| {
                raw.lines()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        // No bound owner ⇒ REFUSE (an owner-less candidate is unrecallable + unscoped). A result
        // CARRYING the refusal (the model SEES it), never an Err that hides it. STORE keys on the
        // PRIMARY (hardened-when-on) namespace — `recall_principals[0]` — the SAME target
        // auto-extraction writes under, so the store↔recall keys stay aligned (a new candidate is
        // recallable both by this tool and by auto-recall).
        let Some(principal) = self.recall_principals.first().map(String::as_str) else {
            return Ok(ToolReceipt {
                action: "memory_store".to_string(),
                summary: "memory_store: refused (no bound owner)".to_string(),
                content: Some(NO_OWNER_REFUSAL.to_string()),
            });
        };

        // SENSITIVITY guard (reuse the spine's guard): drop a sensitive item BEFORE storing — never
        // persist it as a candidate. The values joined are content + tags (the SAME set extraction
        // joins, minus source-message texts which an agent-supplied store has none of).
        let mut guard_values: Vec<&str> = vec![content];
        guard_values.extend(tags.iter().copied());
        if crate::sensitive_guard::is_sensitive_learning_candidate(&guard_values) {
            return Ok(ToolReceipt {
                action: "memory_store".to_string(),
                summary: "memory_store: refused (sensitive content not persisted)".to_string(),
                content: Some(crate::sensitive_guard::SENSITIVE_LEARNING_REJECTION.to_string()),
            });
        }

        // Mint a deterministic, per-call-unique candidate id, then REUSE record_candidate (the SAME
        // primitive auto-extraction uses). state=Candidate (non-durable); recallable only after the
        // owner confirms it. principal_id = the AUTHENTICATED principal (owner-scope). content is
        // stored RAW (non-keyword PII is redacted at RECALL time by rank_recall, parity with the TS
        // + extraction); a keyword-sensitive item was already refused above.
        let n = self.counter.get();
        self.counter.set(n + 1);
        let memory_id = format!("{}:c{n}", self.id_prefix);
        record_candidate(
            self.conn,
            &NewMemoryCandidate {
                memory_id: &memory_id,
                scope: MemoryScope::Session,
                content_ref: None,
                content: Some(content),
                principal_id: Some(principal),
                // Sensitive items are REFUSED above (never stored), so this is always false.
                sensitive: false,
                created_at: self.now_ms,
            },
        )
        .map_err(ExecError::Memory)?;

        Ok(ToolReceipt {
            action: "memory_store".to_string(),
            // REFS-ONLY summary: the candidate id (a safe ref) + the state, NEVER the content.
            summary: format!(
                "memory_store: candidate {memory_id} recorded (pending owner confirm)"
            ),
            content: Some(format!(
                "Stored a memory CANDIDATE ({memory_id}). It is pending and will become recallable \
                 only after the owner confirms it."
            )),
        })
    }
}

/// The model-facing content when `memory_recall` finds nothing (no owner, or no confirmed memory).
const NO_RECALL_RESULTS: &str = "No confirmed memory found for this owner.";

/// The model-facing refusal when `memory_store` is called on a run with no bound owner.
const NO_OWNER_REFUSAL: &str =
    "memory_store is unavailable: this run has no bound owner, so a memory candidate cannot be \
     scoped to anyone. Refusing to store an unowned, unrecallable candidate.";

impl ToolExecutor for MemoryToolExecutor<'_> {
    fn execute(&self, action: &str, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        match action {
            "memory_recall" => self.recall(params),
            "memory_store" => self.store(params),
            other => Err(ExecError::Unsupported(other.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_storage::memory::{confirm, pending_review, recall_confirmed};
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
                "friday-mem-tool-{}-{}-{}-{nanos}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed),
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn p(action: &str, kv: &[(&str, &str)]) -> Vec<(String, String)> {
        let _ = action;
        kv.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn store_proposes_a_candidate_owner_scoped_recall_after_confirm() {
        // The store→confirm→recall loop through the EXPLICIT tools, owner-scoped on the
        // authenticated principal. A different principal recalls nothing (isolation).
        let db = Db::open_hub(&tmp("store-recall")).unwrap();
        let exec = MemoryToolExecutor::new(db.conn(), Some("alice"), 100, "run1:memtool");

        // memory_store proposes a CANDIDATE (non-durable) owned by alice.
        let r = exec
            .execute(
                "memory_store",
                &p(
                    "memory_store",
                    &[("content", "Project codename is Falcon.")],
                ),
            )
            .unwrap();
        assert_eq!(r.action, "memory_store");
        assert!(r.summary.contains("candidate"), "summary: {}", r.summary);

        // It is a pending candidate (NOT durable yet), owned by alice.
        let pending = pending_review(db.conn()).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].memory_id, "run1:memtool:c0");
        assert_eq!(pending[0].principal_id.as_deref(), Some("alice"));
        // recall returns NOTHING until confirmed.
        assert!(recall_confirmed(db.conn(), "alice").unwrap().is_empty());
        let recall_before = exec
            .execute("memory_recall", &p("memory_recall", &[]))
            .unwrap();
        assert_eq!(
            recall_before.content.as_deref(),
            Some(NO_RECALL_RESULTS),
            "recall returns nothing before confirm"
        );

        // Owner confirms via the EXISTING confirm path → it becomes recallable under alice.
        confirm(db.conn(), "run1:memtool:c0", 200).unwrap();
        let recalled = exec
            .execute("memory_recall", &p("memory_recall", &[]))
            .unwrap();
        let content = recalled.content.unwrap();
        assert!(
            content.contains("Project codename is Falcon."),
            "recall must return the confirmed candidate: {content}"
        );
        assert!(
            recalled.summary.contains("1 result"),
            "summary: {}",
            recalled.summary
        );
    }

    #[test]
    fn cross_owner_store_and_recall_are_isolated() {
        // alice stores + confirms; mallory (a DIFFERENT authenticated principal) can neither read
        // alice's confirmed memory NOR write into alice's scope (store is keyed on mallory's own
        // principal, never a model-supplied owner).
        let db = Db::open_hub(&tmp("cross-owner")).unwrap();
        let alice = MemoryToolExecutor::new(db.conn(), Some("alice"), 100, "run-a:memtool");
        let mallory = MemoryToolExecutor::new(db.conn(), Some("mallory"), 100, "run-m:memtool");

        let stored = alice
            .execute(
                "memory_store",
                &p(
                    "memory_store",
                    &[("content", "Alice's project is codenamed Falcon.")],
                ),
            )
            .unwrap();
        assert!(
            stored.summary.contains("candidate"),
            "alice's benign store must record a candidate: {}",
            stored.summary
        );
        confirm(db.conn(), "run-a:memtool:c0", 200).unwrap();

        // mallory recalls NOTHING (alice's row is scoped to alice).
        let m_recall = mallory
            .execute("memory_recall", &p("memory_recall", &[]))
            .unwrap();
        assert_eq!(
            m_recall.content.as_deref(),
            Some(NO_RECALL_RESULTS),
            "a different owner must not recall alice's memory"
        );
        // Hard SQL boundary: alice's principal owns the row; mallory's does not.
        assert_eq!(recall_confirmed(db.conn(), "mallory").unwrap().len(), 0);
        assert_eq!(recall_confirmed(db.conn(), "alice").unwrap().len(), 1);

        // mallory's OWN store writes under mallory (never alice). Even if mallory passed a
        // `namespace`/owner-like param, it is IGNORED (the tool drops it), so no cross-owner write.
        mallory
            .execute(
                "memory_store",
                &p(
                    "memory_store",
                    &[
                        ("content", "Mallory's own note."),
                        ("namespace", "alice"), // model-supplied — MUST be ignored
                    ],
                ),
            )
            .unwrap();
        confirm(db.conn(), "run-m:memtool:c0", 200).unwrap();
        // The candidate landed under mallory, NOT alice.
        assert_eq!(recall_confirmed(db.conn(), "mallory").unwrap().len(), 1);
        assert_eq!(
            recall_confirmed(db.conn(), "alice").unwrap().len(),
            1,
            "alice's scope still has ONLY her own row — no cross-owner write"
        );
    }

    #[test]
    fn recall_applies_pii_redaction_from_the_spine() {
        // A non-keyword PII value (an email) is stored raw (parity with the TS + extraction) and the
        // EXISTING recall chain (rank_recall) redacts it — proving the tool reuses the spine's
        // redaction, not a new one.
        let db = Db::open_hub(&tmp("pii")).unwrap();
        let exec = MemoryToolExecutor::new(db.conn(), Some("carol"), 100, "run-c:memtool");
        exec.execute(
            "memory_store",
            &p(
                "memory_store",
                &[("content", "Reach me at alice@example.com anytime.")],
            ),
        )
        .unwrap();
        confirm(db.conn(), "run-c:memtool:c0", 200).unwrap();
        let recalled = exec
            .execute("memory_recall", &p("memory_recall", &[]))
            .unwrap();
        let content = recalled.content.unwrap();
        assert!(
            content.contains("[EMAIL]"),
            "email must be redacted: {content}"
        );
        assert!(
            !content.contains("alice@example.com"),
            "raw email must NOT leak into recall: {content}"
        );
    }

    #[test]
    fn store_refuses_sensitive_content_never_persists() {
        // The sensitivity guard (reused from the spine) refuses a keyword-sensitive item BEFORE
        // storing — never even a candidate row.
        let db = Db::open_hub(&tmp("sensitive")).unwrap();
        let exec = MemoryToolExecutor::new(db.conn(), Some("bob"), 100, "run-b:memtool");
        let r = exec
            .execute(
                "memory_store",
                &p(
                    "memory_store",
                    &[("content", "My API key is sk-live-abc123 rotate monthly.")],
                ),
            )
            .unwrap();
        assert!(
            r.summary.contains("sensitive"),
            "a sensitive store must be refused: {}",
            r.summary
        );
        // Nothing persisted — no candidate row at all.
        assert_eq!(db.count("memory_item").unwrap(), 0);
        assert!(pending_review(db.conn()).unwrap().is_empty());
    }

    #[test]
    fn store_without_owner_is_refused_and_recall_is_empty() {
        // A run with NO bound principal: store REFUSES (an owner-less candidate is unrecallable),
        // recall returns NOTHING. Both fail-closed.
        let db = Db::open_hub(&tmp("no-owner")).unwrap();
        let exec = MemoryToolExecutor::new(db.conn(), None, 100, "run-x:memtool");

        let store = exec
            .execute(
                "memory_store",
                &p("memory_store", &[("content", "anything")]),
            )
            .unwrap();
        assert!(
            store.summary.contains("no bound owner"),
            "owner-less store must refuse: {}",
            store.summary
        );
        assert_eq!(db.count("memory_item").unwrap(), 0, "no candidate stored");

        let recall = exec
            .execute("memory_recall", &p("memory_recall", &[]))
            .unwrap();
        assert_eq!(recall.content.as_deref(), Some(NO_RECALL_RESULTS));
    }

    #[test]
    fn store_missing_content_is_a_missing_param() {
        let db = Db::open_hub(&tmp("missing")).unwrap();
        let exec = MemoryToolExecutor::new(db.conn(), Some("alice"), 100, "run1:memtool");
        let err = exec
            .execute("memory_store", &p("memory_store", &[]))
            .unwrap_err();
        assert!(matches!(err, ExecError::MissingParam(c) if c == "content"));
        // A blank content is also a missing param (trim → empty).
        let err2 = exec
            .execute("memory_store", &p("memory_store", &[("content", "   ")]))
            .unwrap_err();
        assert!(matches!(err2, ExecError::MissingParam(c) if c == "content"));
    }

    #[test]
    fn unsupported_action_on_memory_executor() {
        let db = Db::open_hub(&tmp("unsupported")).unwrap();
        let exec = MemoryToolExecutor::new(db.conn(), Some("alice"), 100, "run1:memtool");
        let err = exec
            .execute("read_file", &p("read_file", &[("path", "x")]))
            .unwrap_err();
        assert!(matches!(err, ExecError::Unsupported(_)));
    }

    #[test]
    fn recall_limit_is_clamped() {
        // A model-supplied limit is clamped to [1, MAX_RECALL_RESULTS]; store 3, recall with a huge
        // limit returns all 3 (clamped, but >= 3), and a limit of 0 still returns >= 1 worth.
        let db = Db::open_hub(&tmp("limit")).unwrap();
        let exec = MemoryToolExecutor::new(db.conn(), Some("alice"), 100, "run1:memtool");
        for i in 0..3 {
            exec.execute(
                "memory_store",
                &p("memory_store", &[("content", &format!("fact number {i}"))]),
            )
            .unwrap();
            confirm(db.conn(), &format!("run1:memtool:c{i}"), 200 + i as i64).unwrap();
        }
        let recalled = exec
            .execute("memory_recall", &p("memory_recall", &[("limit", "9999")]))
            .unwrap();
        let content = recalled.content.unwrap();
        // All three confirmed facts recall (limit clamped to MAX_RECALL_RESULTS >= 3).
        assert!(content.contains("fact number 0"));
        assert!(content.contains("fact number 1"));
        assert!(content.contains("fact number 2"));
    }

    #[test]
    fn recall_reads_the_dual_read_union_store_targets_the_primary() {
        // Dual-read parity with auto-recall (F5.5): with a `[hardened, legacy]` candidate list,
        // recall surfaces rows under EITHER namespace (the union via recall_confirmed_multi), and
        // a tool-store lands under the PRIMARY (hardened) — so a tool-stored candidate is recalled
        // by both this tool and the (dual-read) auto-recall, and pre-flip legacy rows are not lost.
        let db = Db::open_hub(&tmp("dual-read")).unwrap();
        // Seed a CONFIRMED row under the LEGACY namespace directly (as if written pre-hardening).
        record_candidate(
            db.conn(),
            &NewMemoryCandidate {
                memory_id: "legacy:c0",
                scope: MemoryScope::Session,
                content_ref: None,
                content: Some("legacy-namespace fact"),
                principal_id: Some("legacy-ns"),
                sensitive: false,
                created_at: 50,
            },
        )
        .unwrap();
        confirm(db.conn(), "legacy:c0", 60).unwrap();

        // The executor reads over [hardened, legacy] and stores under the primary (hardened).
        let exec = MemoryToolExecutor::with_recall_principals(
            db.conn(),
            vec!["hardened-ns".to_string(), "legacy-ns".to_string()],
            100,
            "run1:memtool",
        );
        // Store lands under the PRIMARY (hardened-ns), NOT the legacy tail.
        exec.execute(
            "memory_store",
            &p("memory_store", &[("content", "hardened-namespace fact")]),
        )
        .unwrap();
        confirm(db.conn(), "run1:memtool:c0", 200).unwrap();
        assert_eq!(
            recall_confirmed(db.conn(), "hardened-ns").unwrap().len(),
            1,
            "store targets the PRIMARY (hardened) namespace"
        );

        // Recall surfaces BOTH the hardened (just-stored) AND the legacy (pre-flip) rows — the
        // dual-read union, matching auto-recall.
        let recalled = exec
            .execute("memory_recall", &p("memory_recall", &[]))
            .unwrap();
        let content = recalled.content.unwrap();
        assert!(
            content.contains("hardened-namespace fact"),
            "recall must surface the primary row: {content}"
        );
        assert!(
            content.contains("legacy-namespace fact"),
            "recall must ALSO surface the legacy-namespace row (dual-read union): {content}"
        );
    }
}
