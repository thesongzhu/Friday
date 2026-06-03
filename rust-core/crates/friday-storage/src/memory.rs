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
