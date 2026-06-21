//! Refs-only A1 run-outcome learning candidates (Hub-only, DARK).
//!
//! These rows are governance candidates produced after a completed agent loop. They
//! deliberately store only run/session refs and coarse counts: no answer body, no
//! hidden durable memory write, and no auto-recall path. A candidate becomes terminal
//! only through an explicit confirm/reject call.

use crate::error::{Result, StorageError};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunOutcomeLearningKind {
    Preference,
    Reflex,
    WorldModel,
}

impl RunOutcomeLearningKind {
    pub const ALL: [Self; 3] = [Self::Preference, Self::Reflex, Self::WorldModel];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preference => "preference",
            Self::Reflex => "reflex",
            Self::WorldModel => "world_model",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunOutcomeLearningState {
    Pending,
    Confirmed,
    Rejected,
}

impl RunOutcomeLearningState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
        }
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Confirmed | Self::Rejected)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunOutcomeLearningCandidateRow {
    pub candidate_id: String,
    pub run_id: String,
    pub session_id: Option<String>,
    pub kind: RunOutcomeLearningKind,
    pub state: RunOutcomeLearningState,
    pub evidence_ref: String,
    pub summary: String,
    pub turns: i64,
    pub executed_tools: i64,
    pub created_at_ms: i64,
    pub decided_at_ms: Option<i64>,
    pub decision_reason: Option<String>,
}

fn parse_kind(value: &str) -> Result<RunOutcomeLearningKind> {
    match value {
        "preference" => Ok(RunOutcomeLearningKind::Preference),
        "reflex" => Ok(RunOutcomeLearningKind::Reflex),
        "world_model" => Ok(RunOutcomeLearningKind::WorldModel),
        other => Err(StorageError::Unsupported(format!(
            "unknown run-outcome learning kind '{other}'"
        ))),
    }
}

fn parse_state(value: &str) -> Result<RunOutcomeLearningState> {
    match value {
        "pending" => Ok(RunOutcomeLearningState::Pending),
        "confirmed" => Ok(RunOutcomeLearningState::Confirmed),
        "rejected" => Ok(RunOutcomeLearningState::Rejected),
        other => Err(StorageError::Unsupported(format!(
            "unknown run-outcome learning state '{other}'"
        ))),
    }
}

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<RunOutcomeLearningCandidateRow> {
    let kind: String = r.get("kind")?;
    let state: String = r.get("state")?;
    Ok(RunOutcomeLearningCandidateRow {
        candidate_id: r.get("candidate_id")?,
        run_id: r.get("run_id")?,
        session_id: r.get("session_id")?,
        kind: parse_kind(&kind).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?,
        state: parse_state(&state).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?,
        evidence_ref: r.get("evidence_ref")?,
        summary: r.get("summary")?,
        turns: r.get("turns")?,
        executed_tools: r.get("executed_tools")?,
        created_at_ms: r.get("created_at_ms")?,
        decided_at_ms: r.get("decided_at_ms")?,
        decision_reason: r.get("decision_reason")?,
    })
}

const SELECT_COLS: &str = "candidate_id, run_id, session_id, kind, state, evidence_ref, summary, \
     turns, executed_tools, created_at_ms, decided_at_ms, decision_reason";

const MIN_CONFIRMED_TURNS: i64 = 1;
const MIN_CONFIRMED_EXECUTED_TOOLS: i64 = 1;
const MAX_ELIGIBILITY_SCAN_LIMIT: i64 = 256;
pub const MAX_CONFIRMED_SIGNAL_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

fn run_outcome_candidate_summary(
    kind: RunOutcomeLearningKind,
    turns: i64,
    executed_tools: i64,
) -> String {
    let signal = match kind {
        RunOutcomeLearningKind::Preference => {
            "candidate_kind=preference; consumer=recall-preference; confirm_required=true"
        }
        RunOutcomeLearningKind::Reflex => {
            "candidate_kind=reflex; consumer=governance-only; confirm_required=true"
        }
        RunOutcomeLearningKind::WorldModel => {
            "candidate_kind=world_model; consumer=recall-world-model; confirm_required=true"
        }
    };
    format!("{signal}; turns={turns}; executed_tools={executed_tools}; refs_only=true")
}

pub fn record_run_outcome_candidates(
    conn: &Connection,
    run_id: &str,
    session_id: Option<&str>,
    turns: i64,
    executed_tools: i64,
    now_ms: i64,
) -> Result<usize> {
    crate::with_busy_retry(|| {
        let tx = conn.unchecked_transaction()?;
        let mut inserted = 0usize;
        for kind in RunOutcomeLearningKind::ALL {
            let candidate_id = format!("a1:{run_id}:{}", kind.as_str());
            let summary = run_outcome_candidate_summary(kind, turns, executed_tools);
            inserted += tx.execute(
                "INSERT OR IGNORE INTO run_outcome_learning_candidate
                    (candidate_id, run_id, session_id, kind, state, evidence_ref, summary,
                     turns, executed_tools, created_at_ms, decided_at_ms, decision_reason)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL)",
                params![
                    candidate_id,
                    run_id,
                    session_id,
                    kind.as_str(),
                    RunOutcomeLearningState::Pending.as_str(),
                    format!("friday://agent-run/{run_id}"),
                    summary,
                    turns,
                    executed_tools,
                    now_ms
                ],
            )?;
        }
        tx.commit()?;
        Ok(inserted)
    })
}

pub fn list_run_outcome_candidates_for_run(
    conn: &Connection,
    run_id: &str,
) -> Result<Vec<RunOutcomeLearningCandidateRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS}
           FROM run_outcome_learning_candidate
          WHERE run_id = ?1
          ORDER BY kind"
    ))?;
    let rows = stmt.query_map([run_id], row_from)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn list_recent_confirmed_run_outcome_candidates(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<RunOutcomeLearningCandidateRow>> {
    let limit = limit.max(1);
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS}
           FROM run_outcome_learning_candidate
          WHERE state = ?1
          ORDER BY COALESCE(decided_at_ms, created_at_ms) DESC, candidate_id
          LIMIT ?2"
    ))?;
    let rows = stmt.query_map(
        params![RunOutcomeLearningState::Confirmed.as_str(), limit],
        row_from,
    )?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn list_recent_eligible_confirmed_run_outcome_candidates(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<RunOutcomeLearningCandidateRow>> {
    list_recent_eligible_confirmed_run_outcome_candidates_at(conn, limit, None)
}

pub fn list_recent_eligible_confirmed_run_outcome_candidates_at(
    conn: &Connection,
    limit: i64,
    now_ms: Option<i64>,
) -> Result<Vec<RunOutcomeLearningCandidateRow>> {
    let limit = limit.max(1);
    let scan_limit = (limit * 4).clamp(limit, MAX_ELIGIBILITY_SCAN_LIMIT);
    let confirmed = list_recent_confirmed_run_outcome_candidates(conn, scan_limit)?;
    let blocked_pairs = reciprocal_contradiction_pairs(&confirmed);
    let mut out = Vec::new();
    for row in confirmed {
        if row.turns < MIN_CONFIRMED_TURNS || row.executed_tools < MIN_CONFIRMED_EXECUTED_TOOLS {
            continue;
        }
        if let Some(pair) = contradiction_pair(&row.summary) {
            if blocked_pairs.contains(&pair) {
                continue;
            }
        }
        if let Some(now_ms) = now_ms {
            let anchor_ms = row.decided_at_ms.unwrap_or(row.created_at_ms);
            if now_ms.saturating_sub(anchor_ms) > MAX_CONFIRMED_SIGNAL_AGE_MS {
                continue;
            }
        }
        out.push(row);
        if out.len() >= limit as usize {
            break;
        }
    }
    Ok(out)
}

fn reciprocal_contradiction_pairs(
    rows: &[RunOutcomeLearningCandidateRow],
) -> HashSet<(String, String)> {
    let pairs: HashSet<(String, String)> = rows
        .iter()
        .filter_map(|row| contradiction_pair(&row.summary))
        .collect();
    pairs
        .iter()
        .filter(|(left, right)| pairs.contains(&(right.clone(), left.clone())))
        .cloned()
        .collect()
}

fn contradiction_pair(summary: &str) -> Option<(String, String)> {
    let (left, right) = summary
        .split_once('→')
        .or_else(|| summary.split_once("->"))?;
    let left = left.trim().to_ascii_lowercase();
    let right = right.trim().to_ascii_lowercase();
    if left.is_empty() || right.is_empty() {
        return None;
    }
    Some((left, right))
}

pub fn get_run_outcome_candidate(
    conn: &Connection,
    candidate_id: &str,
) -> Result<Option<RunOutcomeLearningCandidateRow>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {SELECT_COLS}
                   FROM run_outcome_learning_candidate
                  WHERE candidate_id = ?1"
            ),
            [candidate_id],
            row_from,
        )
        .optional()?)
}

pub fn decide_run_outcome_candidate(
    conn: &Connection,
    candidate_id: &str,
    confirmed: bool,
    now_ms: i64,
    reason: Option<&str>,
) -> Result<RunOutcomeLearningState> {
    crate::with_busy_retry(|| {
        let row = get_run_outcome_candidate(conn, candidate_id)?.ok_or_else(|| {
            StorageError::Unsupported(format!(
                "run_outcome_learning_candidate '{candidate_id}' not found"
            ))
        })?;
        if row.state.is_terminal() {
            return Err(StorageError::Unsupported(format!(
                "run_outcome_learning_candidate '{candidate_id}' is already terminal ({})",
                row.state.as_str()
            )));
        }
        let next = if confirmed {
            RunOutcomeLearningState::Confirmed
        } else {
            RunOutcomeLearningState::Rejected
        };
        conn.execute(
            "UPDATE run_outcome_learning_candidate
                SET state = ?1, decided_at_ms = ?2, decision_reason = ?3
              WHERE candidate_id = ?4",
            params![next.as_str(), now_ms, reason, candidate_id],
        )?;
        Ok(next)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);

    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-a1-learning-candidate-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn confirm_preference(db: &Db, run_id: &str, turns: i64, executed_tools: i64, now: i64) {
        record_run_outcome_candidates(
            db.conn(),
            run_id,
            Some("sess-a1"),
            turns,
            executed_tools,
            now,
        )
        .unwrap();
        decide_run_outcome_candidate(
            db.conn(),
            &format!("a1:{run_id}:preference"),
            true,
            now + 1,
            Some("operator confirmed"),
        )
        .unwrap();
    }

    fn insert_confirmed_summary(db: &Db, id: &str, summary: &str, now: i64) {
        db.conn()
            .execute(
                "INSERT INTO run_outcome_learning_candidate
                    (candidate_id, run_id, session_id, kind, state, evidence_ref, summary,
                     turns, executed_tools, created_at_ms, decided_at_ms, decision_reason)
                 VALUES (?1, ?2, ?3, 'preference', 'confirmed', ?4, ?5, 2, 1, ?6, ?7, 'test')",
                params![
                    id,
                    format!("run-{id}"),
                    "sess-a1",
                    format!("friday://agent-run/run-{id}"),
                    summary,
                    now,
                    now + 1,
                ],
            )
            .unwrap();
    }

    #[test]
    fn eligible_confirmed_candidates_enforce_min_evidence() {
        let db = Db::open_hub(&tmp("min-evidence")).unwrap();
        confirm_preference(&db, "low", 3, 0, 100);
        confirm_preference(&db, "ok", 3, 1, 200);

        let ids: Vec<_> = list_recent_eligible_confirmed_run_outcome_candidates(db.conn(), 10)
            .unwrap()
            .into_iter()
            .map(|row| row.candidate_id)
            .collect();
        assert_eq!(ids, vec!["a1:ok:preference"]);
    }

    #[test]
    fn eligible_confirmed_candidates_drop_reciprocal_contradictions() {
        let db = Db::open_hub(&tmp("contradiction")).unwrap();
        insert_confirmed_summary(&db, "ab", "A→B", 100);
        insert_confirmed_summary(&db, "ba", "B→A", 200);
        insert_confirmed_summary(&db, "ac", "A→C", 300);

        let rows = list_recent_eligible_confirmed_run_outcome_candidates(db.conn(), 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].candidate_id, "ac");
    }

    #[test]
    fn eligible_confirmed_candidates_are_capped_to_recent_rows() {
        let db = Db::open_hub(&tmp("cap")).unwrap();
        for i in 0..5 {
            confirm_preference(&db, &format!("run-{i}"), 2, 1, 100 + i);
        }

        let ids: Vec<_> = list_recent_eligible_confirmed_run_outcome_candidates(db.conn(), 3)
            .unwrap()
            .into_iter()
            .map(|row| row.candidate_id)
            .collect();
        assert_eq!(
            ids,
            vec![
                "a1:run-4:preference",
                "a1:run-3:preference",
                "a1:run-2:preference",
            ]
        );
    }

    #[test]
    fn eligible_confirmed_candidates_enforce_freshness_cap_when_clocked() {
        let db = Db::open_hub(&tmp("freshness")).unwrap();
        let now = 1_000_000_000_000_i64;
        confirm_preference(&db, "stale", 2, 1, now - MAX_CONFIRMED_SIGNAL_AGE_MS - 10);
        confirm_preference(&db, "fresh", 2, 1, now - MAX_CONFIRMED_SIGNAL_AGE_MS + 10);

        let ids: Vec<_> =
            list_recent_eligible_confirmed_run_outcome_candidates_at(db.conn(), 10, Some(now))
                .unwrap()
                .into_iter()
                .map(|row| row.candidate_id)
                .collect();
        assert_eq!(ids, vec!["a1:fresh:preference"]);
    }
}
