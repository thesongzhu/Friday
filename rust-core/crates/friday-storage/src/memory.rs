//! Memory-item persistence (Unit 10; gate `21` §9, `07`, `02` §11/§12). Hub-only.
//!
//! Composes `friday-core`'s memory-trust invariants:
//! - **No silent long-term write** (`07` §6/§7): extraction records a *candidate*;
//!   it becomes durable (`Confirmed`) ONLY via an explicit user decision.
//! - **A single authoritative lifecycle column.** `state`
//!   (candidate/confirmed/rejected) drives durability; `confidence` is written
//!   *consistent with* `state` by the same single writer. There is **no raw
//!   setter for `confidence`**, so a row can never carry a contradictory
//!   `(confidence=confirmed, state=rejected)` pair — the illegal combination is
//!   unrepresentable through this API, not merely discouraged.
//! - **Terminal decisions are final.** A `Confirmed`/`Rejected` item is refused
//!   re-decision (no silent re-write, no downgrade); only a `Candidate` is
//!   awaiting the user.

use crate::error::{Result, StorageError};
use friday_core::{decide_candidate, Confidence, MemoryScope, MemoryState};
use rusqlite::{params, Connection, OptionalExtension};

/// A persisted memory item (mirrors `memory_item`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryRow {
    pub memory_id: String,
    pub scope: MemoryScope,
    pub content_ref: Option<String>,
    /// Inline recallable text (the marker a recall injects). `None` for pre-recall
    /// rows — such a row is never recallable (nothing to inject).
    pub content: Option<String>,
    /// Owning principal. The same-principal-only recall keys on this; `None` is an
    /// unowned row that NO principal recalls (fail-closed, `07` §9 / `02` §7).
    pub principal_id: Option<String>,
    /// PII/secret-bearing marker. A recalled `sensitive` item routes through the
    /// Context Passport gate (`07` §10) — under deny-all approval it is not injected.
    pub sensitive: bool,
    pub confidence: Confidence,
    pub state: MemoryState,
    pub created_at: i64,
    pub confirmed_at: Option<i64>,
}

// Defensive parsers. Values are only ever written via the enum `as_str()`, so an
// unknown token cannot arise in normal operation; when one does, fail CLOSED on
// the load-bearing axes — never treat an unparseable row as a durable, auto-usable
// fact (unknown confidence -> Candidate; unknown state -> Candidate; both are
// non-durable and not auto-usable).
fn parse_scope(s: &str) -> MemoryScope {
    match s {
        "global" => MemoryScope::Global,
        "project" => MemoryScope::Project,
        _ => MemoryScope::Session,
    }
}

fn parse_confidence(s: &str) -> Confidence {
    match s {
        "confirmed" => Confidence::Confirmed,
        "high_confidence_context" => Confidence::HighConfidenceContext,
        "inferred" => Confidence::Inferred,
        _ => Confidence::Candidate,
    }
}

fn parse_state(s: &str) -> MemoryState {
    match s {
        "confirmed" => MemoryState::Confirmed,
        "rejected" => MemoryState::Rejected,
        _ => MemoryState::Candidate,
    }
}

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<MemoryRow> {
    let scope: String = r.get("scope")?;
    // `confidence` is nullable in the v1 DDL; a NULL must read as the fail-closed
    // default (Candidate — not durable, not auto-usable), never error the read path.
    let confidence: Option<String> = r.get("confidence")?;
    let state: String = r.get("state")?;
    // `sensitive` is INTEGER NOT NULL DEFAULT 0; read non-zero as true.
    let sensitive: i64 = r.get("sensitive")?;
    Ok(MemoryRow {
        memory_id: r.get("memory_id")?,
        scope: parse_scope(&scope),
        content_ref: r.get("content_ref")?,
        content: r.get("content")?,
        principal_id: r.get("principal_id")?,
        sensitive: sensitive != 0,
        confidence: parse_confidence(confidence.as_deref().unwrap_or("")),
        state: parse_state(&state),
        created_at: r.get("created_at")?,
        confirmed_at: r.get("confirmed_at")?,
    })
}

const SELECT_COLS: &str = "memory_id, scope, content_ref, content, principal_id, sensitive, \
     confidence, state, created_at, confirmed_at";

/// A freshly-extracted memory candidate to persist. Carries the recall fields
/// (`content`, `principal_id`, `sensitive`) alongside the v1 fields so the save
/// path captures everything a later recall needs — there is no second "make it
/// recallable" write that could be forgotten.
#[derive(Clone, Debug)]
pub struct NewMemoryCandidate<'a> {
    pub memory_id: &'a str,
    pub scope: MemoryScope,
    /// Opaque pointer to external content (legacy v1 field; may be `None`).
    pub content_ref: Option<&'a str>,
    /// Inline recallable text. A candidate with `None` content is never recallable.
    pub content: Option<&'a str>,
    /// Owning principal (the same-principal-only recall keys on this).
    pub principal_id: Option<&'a str>,
    /// PII/secret-bearing — a recalled sensitive item routes through the Passport gate.
    pub sensitive: bool,
    pub created_at: i64,
}

/// Record a freshly-extracted memory candidate. NEVER durable: `state=Candidate`,
/// `confidence=Candidate`, `confirmed_at=NULL`. Nothing here makes it a fact
/// (`07` §6/§7 — no silent long-term write); recall still requires explicit
/// confirmation (`state=Confirmed`) AND a matching principal.
pub fn record_candidate(conn: &Connection, c: &NewMemoryCandidate) -> Result<()> {
    conn.execute(
        "INSERT INTO memory_item
            (memory_id, scope, content_ref, content, principal_id, sensitive,
             confidence, state, created_at, confirmed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
        params![
            c.memory_id,
            c.scope.as_str(),
            c.content_ref,
            c.content,
            c.principal_id,
            c.sensitive as i64,
            Confidence::Candidate.as_str(),
            MemoryState::Candidate.as_str(),
            c.created_at
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, memory_id: &str) -> Result<Option<MemoryRow>> {
    let row = conn
        .query_row(
            &format!("SELECT {SELECT_COLS} FROM memory_item WHERE memory_id = ?1"),
            [memory_id],
            row_from,
        )
        .optional()?;
    Ok(row)
}

/// Apply the user's explicit decision to a pending candidate, composing
/// `friday-core::decide_candidate`:
/// - confirm -> durable (`state=Confirmed`, `confidence=Confirmed`, `confirmed_at`
///   set);
/// - reject -> `state=Rejected` (not durable; `confidence` left non-confirmed).
///
/// `confidence` is written CONSISTENT with `state` here — there is no path that
/// sets `confidence` on its own, so a confirmed-confidence/non-confirmed-state
/// row is unrepresentable. A terminal item is refused (no re-write / no
/// downgrade). Returns the resulting state.
pub fn decide(
    conn: &Connection,
    memory_id: &str,
    user_confirmed: bool,
    now: i64,
) -> Result<MemoryState> {
    let cur = current_state(conn, memory_id)?
        .ok_or_else(|| StorageError::Unsupported(format!("memory_item '{memory_id}' not found")))?;
    if cur.is_terminal() {
        return Err(StorageError::Unsupported(format!(
            "memory_item '{memory_id}' is already terminal ({}); refusing to re-decide",
            cur.as_str()
        )));
    }
    let next = decide_candidate(cur, Some(user_confirmed));
    let (confidence, confirmed_at) = match next {
        MemoryState::Confirmed => (Confidence::Confirmed, Some(now)),
        // Rejected / still-Candidate are not durable: confidence stays non-confirmed.
        MemoryState::Rejected | MemoryState::Candidate => (Confidence::Candidate, None),
    };
    conn.execute(
        "UPDATE memory_item SET state = ?1, confidence = ?2, confirmed_at = ?3
         WHERE memory_id = ?4",
        params![next.as_str(), confidence.as_str(), confirmed_at, memory_id],
    )?;
    Ok(next)
}

/// Confirm a candidate (explicit user yes). Durable iff it was a pending candidate.
pub fn confirm(conn: &Connection, memory_id: &str, now: i64) -> Result<MemoryState> {
    decide(conn, memory_id, true, now)
}

/// Reject a candidate (explicit user no). Never durable.
pub fn reject(conn: &Connection, memory_id: &str, now: i64) -> Result<MemoryState> {
    decide(conn, memory_id, false, now)
}

/// Edit a PENDING memory candidate (the Memory-confirmation loop's "edit"
/// action, `07` §6/§7). The edit is modeled as a SUCCESSOR, never an in-place
/// mutation: the old candidate is `reject`-ed (becomes a terminal `Rejected`
/// row, untouched thereafter) and the edited content is recorded as a NEW
/// `Candidate` row. The two rows COEXIST — the prior content is preserved as a
/// terminal Rejected record, so the edit is reversible by a SUCCESSOR
/// (re-propose / a future re-edit) without ever rewriting or resurrecting a
/// terminal row. There is no provenance column (that would need a migration);
/// reversibility lives in the coexisting rows, not a stored edge.
///
/// **PENDING-only by construction.** The edit composes `reject` first, and
/// `reject`/`decide` already refuse a terminal row — so editing a `Confirmed`
/// memory ERRORS (and inserts nothing), which is the EXPLICIT deferred AC
/// (revising a confirmed memory = retire-on-confirm, NOT built here); editing an
/// already-`Rejected` source also errors (use [`repropose_from_rejected`]). No
/// separate state guard is needed — the lifecycle enforces the scope.
///
/// **Atomic.** Both writes run in one transaction: if recording the new
/// candidate fails (e.g. a colliding `new_memory_id`), the rejection of the old
/// candidate is rolled back too — there is never a half-edit that leaves the old
/// candidate Rejected with no replacement.
///
/// Returns the id of the new candidate on success.
pub fn edit_candidate(
    conn: &Connection,
    old_memory_id: &str,
    edited: &NewMemoryCandidate,
    now: i64,
) -> Result<String> {
    let tx = conn.unchecked_transaction()?;
    // Reject the old candidate FIRST: `reject`/`decide` errors on a terminal
    // (Confirmed/Rejected) row, so a Confirmed source is refused here (deferred
    // AC) and a Rejected source is refused (use repropose) — PENDING-only scope
    // falls out of the lifecycle, no extra guard.
    reject(&tx, old_memory_id, now)?;
    // Record the edited content as a brand-new candidate (NEVER durable).
    record_candidate(&tx, edited)?;
    tx.commit()?;
    Ok(edited.memory_id.to_string())
}

/// Re-propose a NEW candidate sourced from a previously-`Rejected` memory (the
/// Memory-confirmation loop's "re-propose" action, `07` §6/§7). This records a
/// fresh `Candidate` row and leaves the source `Rejected` row ENTIRELY UNTOUCHED
/// — the rejection stays terminal and final (re-asserting `decide` on it still
/// errors; a re-propose does NOT resurrect or rewrite the old row). Reversibility
/// is forward-only: a successor candidate is created; the historical Rejected
/// record is preserved as-is.
///
/// A light guard confirms the source exists and is `Rejected` (symmetry with
/// [`edit_candidate`]'s PENDING-only scope: re-propose is the path FROM a
/// terminal Rejected, edit is the path FROM a pending Candidate). The source is
/// only READ, never written. Returns the id of the new candidate.
pub fn repropose_from_rejected(
    conn: &Connection,
    source_memory_id: &str,
    reproposed: &NewMemoryCandidate,
    // Reserved for API symmetry with `edit_candidate(.., now)`. Unused here: the
    // new candidate's timestamp comes from `reproposed.created_at`, and the source
    // Rejected row is never re-stamped (it stays terminal/untouched).
    _now: i64,
) -> Result<String> {
    let src = current_state(conn, source_memory_id)?.ok_or_else(|| {
        StorageError::Unsupported(format!(
            "memory_item '{source_memory_id}' not found; nothing to re-propose"
        ))
    })?;
    if src != MemoryState::Rejected {
        return Err(StorageError::Unsupported(format!(
            "memory_item '{source_memory_id}' is {} (not rejected); re-propose only applies to a \
             rejected memory — edit a pending candidate with edit_candidate instead",
            src.as_str()
        )));
    }
    // Record-only: the source Rejected row is never written here.
    record_candidate(conn, reproposed)?;
    Ok(reproposed.memory_id.to_string())
}

/// Candidates awaiting the user's decision, oldest first (`07` §6/§7) — the
/// data-layer query that **backs** the Memory Review schedule (the schedule's
/// settings/cron/morning-card UI is deferred, `07` §7). These are surfaced for
/// explicit confirm/reject; they are NOT auto-usable until confirmed.
pub fn pending_review(conn: &Connection) -> Result<Vec<MemoryRow>> {
    select_by_state(conn, MemoryState::Candidate)
}

/// Durable, auto-usable long-term memory: only `Confirmed` items (`07` §9,
/// `02` §12). A candidate or rejected item is never returned here. This is the
/// PRINCIPAL-AGNOSTIC view (all owners) — for recall-into-an-answer use
/// [`recall_confirmed`], which additionally enforces the same-principal boundary.
pub fn auto_usable(conn: &Connection) -> Result<Vec<MemoryRow>> {
    let rows = select_by_state(conn, MemoryState::Confirmed)?;
    // Defense-in-depth: the state filter already restricts to Confirmed, but assert
    // the friday-core trust invariant holds for every row we hand back as a fact.
    debug_assert!(rows
        .iter()
        .all(|m| m.state.is_durable() && m.confidence.auto_usable()));
    Ok(rows)
}

/// The recall set for one principal: the `Confirmed`, `content`-bearing memory
/// OWNED BY `principal_id`, most-recently-confirmed first. This is the data-layer
/// half of the save→recall loop (PROOF-MEMORY-001) and enforces every hard
/// boundary at the SQL layer so a non-eligible row never even leaves the DB:
///
/// - **Same-principal only** (`07` §9 / `02` §7): `principal_id = ?1` exact match.
///   A row owned by another principal — or an unowned (`NULL` principal) row — is
///   never returned. Cross-principal recall is structurally impossible here.
/// - **Confirmed only** (`07` §9): a `Candidate`/`Rejected`/inferred item is never
///   recalled as fact.
/// - **Content-bearing only**: a row with `NULL` or empty (`''`) content has
///   nothing to inject and is skipped (fail-closed).
///
/// A blank/empty `principal_id` argument returns an EMPTY set WITHOUT querying —
/// an anonymous/owner-less caller recalls nothing (it must not match `''` rows or
/// act as a wildcard). `sensitive` rows ARE returned (the Context Passport gate,
/// not this query, decides whether a sensitive item is actually injected).
pub fn recall_confirmed(conn: &Connection, principal_id: &str) -> Result<Vec<MemoryRow>> {
    // Fail-closed on a missing principal: no wildcard, no '' match — recall nothing.
    if principal_id.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM memory_item
         WHERE state = ?1 AND principal_id = ?2 AND content IS NOT NULL AND content != ''
         ORDER BY confirmed_at DESC, created_at DESC, memory_id"
    ))?;
    let rows = stmt.query_map(
        params![MemoryState::Confirmed.as_str(), principal_id],
        row_from,
    )?;
    let mut out = Vec::new();
    for r in rows {
        let row = r?;
        out.push(row);
    }
    // Defense-in-depth: every returned row is a durable, AUTO-USABLE, content-bearing
    // fact owned by exactly the requested principal (the SQL enforces it; assert the
    // full trust invariant too — same shape `auto_usable` asserts, plus ownership).
    debug_assert!(out.iter().all(|m| m.state.is_durable()
        && m.confidence.auto_usable()
        && m.content.as_deref().is_some_and(|c| !c.is_empty())
        && m.principal_id.as_deref() == Some(principal_id)));
    Ok(out)
}

/// DUAL-READ recall: the UNION of [`recall_confirmed`] over an ORDERED list of principals,
/// DEDUPED by `memory_id` (first principal in the list wins for a given id). This is the
/// data-layer half of the F5.5 namespace-hardening dual-read — the caller passes the ordered
/// `[hardened, legacy]` namespace list (the
/// `session_namespace::resolve_session_memory_namespace_candidates` output) so memory written
/// under the LEGACY namespace is still recalled after the hardening flag is flipped on. There
/// is NO destructive re-key — the legacy rows are read in place.
///
/// IMPORTANT — the per-principal SQL stays SINGLE-principal: each `recall_confirmed` call
/// enforces `principal_id = ?` exactly (and its single-principal `debug_assert`), so a row
/// owned by an unrelated principal is never returned. The UNION + dedup happen HERE, in
/// memory, NOT in SQL — so this helper can never widen the per-principal isolation boundary.
///
/// Ordering: principals are consulted in order; within the merged set the first principal to
/// own a given `memory_id` wins (so a row re-written under the hardened namespace is preferred
/// over its lingering legacy copy when both exist). An empty list ⇒ empty result. A
/// blank/empty principal in the list contributes nothing (same fail-closed rule as
/// `recall_confirmed`).
pub fn recall_confirmed_multi(conn: &Connection, principals: &[&str]) -> Result<Vec<MemoryRow>> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<MemoryRow> = Vec::new();
    for principal in principals {
        for row in recall_confirmed(conn, principal)? {
            // Dedup by memory_id: the FIRST principal (ordered hardened-first) to own a given
            // id wins; a later (legacy) duplicate of the same id is dropped.
            if seen.insert(row.memory_id.clone()) {
                out.push(row);
            }
        }
    }
    Ok(out)
}

/// Raw FTS5 keyword relevance for a `MATCH` query, over the `memory_fts` index (v34).
/// Returns `(memory_id, bm25)` pairs for every indexed row that matches `match_query`, where
/// `bm25` is SQLite's `bm25()` rank — MORE-NEGATIVE = BETTER match (the caller normalizes the
/// sign + scale before blending).
///
/// SECURITY — this NEVER widens the recall boundary. It returns scores keyed by `memory_id`;
/// the caller intersects them with the OWNER-SCOPED candidate set
/// ([`recall_confirmed`]/[`recall_confirmed_multi`]) so a score for a row the owner does not
/// own can never cause an injection (only a candidate row can inject; this only RE-RANKS the
/// candidates). The FTS index is global (cross-owner), so `bm25`'s IDF term is computed over
/// all owners' documents — that subtly influences ranking WITHIN an owner's candidate set, but
/// no other owner's CONTENT ever crosses (it is never a candidate). The caller is responsible
/// for that intersection; this helper is owner-agnostic by design (it has no principal to scope
/// to — the `memory_fts` index does not carry the owner axis).
///
/// `match_query` MUST already be a SAFE FTS5 MATCH expression (tokenized, each token quoted,
/// joined with `OR`) — see `cognition::build_fts_match_query`. Passing raw user text risks an
/// `fts5: syntax error`; an empty/blank query returns an empty map WITHOUT querying.
pub fn fts_keyword_scores(
    conn: &Connection,
    match_query: &str,
) -> Result<std::collections::HashMap<String, f64>> {
    let mut out = std::collections::HashMap::new();
    if match_query.trim().is_empty() {
        return Ok(out);
    }
    let mut stmt = conn.prepare(
        "SELECT memory_id, bm25(memory_fts) AS rank FROM memory_fts
         WHERE memory_fts MATCH ?1",
    )?;
    let rows = stmt.query_map(params![match_query], |r| {
        Ok((r.get::<_, String>("memory_id")?, r.get::<_, f64>("rank")?))
    })?;
    for r in rows {
        let (id, rank) = r?;
        // If the same memory_id somehow appears twice (it cannot under our triggers, which
        // DELETE-then-INSERT by id), keep the BEST (most-negative) rank.
        out.entry(id)
            .and_modify(|cur: &mut f64| {
                if rank < *cur {
                    *cur = rank;
                }
            })
            .or_insert(rank);
    }
    Ok(out)
}

// --- helpers ---------------------------------------------------------------

fn current_state(conn: &Connection, memory_id: &str) -> Result<Option<MemoryState>> {
    let s: Option<String> = conn
        .query_row(
            "SELECT state FROM memory_item WHERE memory_id = ?1",
            [memory_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(s.map(|x| parse_state(&x)))
}

fn select_by_state(conn: &Connection, state: MemoryState) -> Result<Vec<MemoryRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM memory_item WHERE state = ?1 ORDER BY created_at, memory_id"
    ))?;
    let rows = stmt.query_map([state.as_str()], row_from)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
