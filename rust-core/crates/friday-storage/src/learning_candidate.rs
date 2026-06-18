//! Refs-only A1 run-outcome learning candidates (Hub-only, DARK).
//!
//! These rows are governance candidates produced after a completed agent loop. They
//! deliberately store only run/session refs and coarse counts: no answer body, no
//! hidden durable memory write, and no auto-recall path. A candidate becomes terminal
//! only through an explicit confirm/reject call.

use crate::error::{Result, StorageError};
use rusqlite::{params, Connection, OptionalExtension};

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
            let summary =
                format!("refs-only run outcome: turns={turns}; executed_tools={executed_tools}");
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
