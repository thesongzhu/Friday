//! Agent run + event-log persistence (PR-5; gate 21 §9). Hub-only.
//!
//! A thin repo over the `agent_run` + `agent_run_event` tables. The run's
//! lifecycle is the `friday-core` [`PlanState`] machine (awaiting-clarification →
//! awaiting-plan-approval → approved/rejected); state transitions are validated
//! by that machine so an illegal transition is rejected, never persisted. The
//! event log is an append-only, per-run monotonic `seq` stream (mirroring the
//! oracle's `runEventRepository.append` seq discipline).

use crate::error::{Result, StorageError};
use friday_core::PlanState;
use rusqlite::{params, Connection, OptionalExtension};

fn parse_plan_state(s: &str) -> Option<PlanState> {
    match s {
        "awaiting_clarification" => Some(PlanState::AwaitingClarification),
        "awaiting_plan_approval" => Some(PlanState::AwaitingPlanApproval),
        "approved" => Some(PlanState::Approved),
        "rejected" => Some(PlanState::Rejected),
        _ => None,
    }
}

/// Create an agent run in `AwaitingClarification` (the gate's entry state).
pub fn create_run(conn: &Connection, run_id: &str, task: &str, created_at: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO agent_run (run_id, task, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![
            run_id,
            task,
            PlanState::AwaitingClarification.as_str(),
            created_at
        ],
    )?;
    Ok(())
}

/// Read a run's current [`PlanState`], or `None` if the run is unknown.
pub fn run_state(conn: &Connection, run_id: &str) -> Result<Option<PlanState>> {
    let s: Option<String> = conn
        .query_row(
            "SELECT state FROM agent_run WHERE run_id = ?1",
            [run_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(s.and_then(|x| parse_plan_state(&x)))
}

/// Transition a run's state, validated by the `friday-core` [`PlanState`]
/// machine. An illegal transition (e.g. clarification → approved, or any
/// transition out of a terminal approved/rejected state) is rejected and NOT
/// persisted — the gate's "no re-decide" invariant holds at the typed-API layer.
pub fn set_run_state(conn: &Connection, run_id: &str, next: PlanState, now: i64) -> Result<()> {
    let cur = run_state(conn, run_id)?
        .ok_or_else(|| StorageError::Unsupported(format!("agent_run '{run_id}' not found")))?;
    let next = cur.try_transition(next)?; // CoreError -> StorageError on illegal transition
    conn.execute(
        "UPDATE agent_run SET state = ?1, updated_at = ?2 WHERE run_id = ?3",
        params![next.as_str(), now, run_id],
    )?;
    Ok(())
}

/// Append an event to a run's log with the next monotonic `seq` (1-based,
/// per-run). Returns the assigned `seq`. The run must exist.
pub fn record_event(
    conn: &Connection,
    event_id: &str,
    run_id: &str,
    kind: &str,
    created_at: i64,
) -> Result<i64> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_run WHERE run_id = ?1)",
        [run_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(StorageError::Unsupported(format!(
            "agent_run '{run_id}' not found; cannot record event"
        )));
    }
    let last_seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM agent_run_event WHERE run_id = ?1",
        [run_id],
        |r| r.get(0),
    )?;
    let seq = last_seq + 1;
    conn.execute(
        "INSERT INTO agent_run_event (event_id, run_id, seq, kind, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![event_id, run_id, seq, kind, created_at],
    )?;
    Ok(seq)
}
