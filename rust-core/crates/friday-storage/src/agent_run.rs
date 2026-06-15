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

/// (A1 run-controls) The terminal `agent_run.state` written when a run is CANCELLED. The
/// `agent_run.state` column is free-form `TEXT` (no CHECK in [`crate::schema`] `DDL_AGENT_RUN`),
/// so this string writes WITHOUT a migration. It is DELIBERATELY OUTSIDE the [`PlanState`]
/// closed vocab ([`parse_plan_state`] returns `None` for it) so that:
///   - a cancelled run can never be "re-decided" through the [`PlanState`] transition machine
///     ([`set_run_state`] would reject any transition out of it, because the current state does
///     not parse to a `PlanState` and that fn requires the current state to be a known one); and
///   - any closed-vocab reader that round-trips through [`parse_plan_state`] sees `None` (run has
///     no PlanState), distinct from a run that does not exist (the row read returns `None` too —
///     see [`is_cancelled`] / [`run_state_string`] for the unambiguous distinguishers a control
///     reader should use instead of conflating "no PlanState" with "no row").
pub const STATE_CANCELLED: &str = "cancelled";

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

/// The terminal `agent_run.state` value for a run that REACHED A RESULT but did
/// NOT flow through the [`PlanState`] plan-approval machine (the common case: an
/// ordinary Q&A / read-only task `Finished`, or a resumed mutation `mutation_completed`).
///
/// ## Why this exists (the stuck-state defect it fixes)
/// `create_run` seeds every run at `awaiting_clarification` (the gate's entry
/// state). The live agent loop records terminal *events* (`agent.finished`,
/// `agent.outcome:*`) and persists a terminal `run_result`, but NOTHING moved the
/// `agent_run.state` column off its `create_run` value — `set_run_state` (the
/// [`PlanState`] machine) has zero live callers, and the loop never reaches the
/// plan-approval lifecycle. So a finished run's `agent_run.state` stayed stuck at
/// `awaiting_clarification` forever, contradicting both its terminal `run_result`
/// AND the event-log-derived status the readback already reports. This is the
/// chokepoint that completes the lifecycle, mirroring how [`cancel_run`] writes a
/// terminal out-of-vocab state directly.
///
/// ## Vocabulary + no migration
/// Like [`STATE_CANCELLED`], the written string is the `run_result.status` LABEL
/// (`finished` / `mutation_completed` / `errored` / `bounded` / …) — DELIBERATELY
/// OUTSIDE the closed [`PlanState`] vocab so [`parse_plan_state`] returns `None`
/// (a terminal run has no live PlanState, exactly like a cancelled one). The
/// `agent_run.state` column is free-form `TEXT` (no CHECK), so this writes WITHOUT
/// a migration. Keeping the column value equal to `run_result.status` makes the
/// readback (`run_state`) COHERENT with the stored result + the derived status.
///
/// ## Fail-closed, gate-preserving, cancel-safe (NO-DEGRADE)
///   - It is a NO-OP for the `awaiting_clarification` status: a run genuinely held
///     by the clarification gate (terminal `LoopStatus::AwaitingClarification`,
///     ZERO model calls) keeps its `awaiting_clarification` column verbatim — the
///     gate hold is structurally untouched (the only legitimate persisted
///     `awaiting_clarification` is a genuine hold).
///   - It NEVER clobbers [`STATE_CANCELLED`]: a run cancelled out-of-band keeps its
///     terminal `cancelled` flag even if a late result is persisted (mirrors
///     [`cancel_run`]'s "never touches `run_result`" half — the two terminal
///     writers do not fight).
///   - It is a no-op when the run row does not exist (`UPDATE … WHERE` affects 0
///     rows) and when the column already holds the same terminal value (idempotent
///     re-persist).
///
/// Intended to be called INSIDE the same transaction that persists the
/// `run_result` (see [`crate::run_result::persist_run_result`]) so the result and
/// the lifecycle state move atomically together.
pub fn mark_run_terminal_state(
    conn: &Connection,
    run_id: &str,
    status: &str,
    now: i64,
) -> Result<()> {
    // A genuine clarification HOLD is the one legitimate non-terminal persisted
    // status: leave the `create_run` `awaiting_clarification` column verbatim so the
    // gate hold is structurally preserved (NO-DEGRADE). Any other status is terminal.
    if status == PlanState::AwaitingClarification.as_str() {
        return Ok(());
    }
    // Move the column to the terminal status string, EXCEPT when the run was cancelled
    // out-of-band — a `cancelled` flag is never clobbered by a late result persist.
    // `WHERE run_id = ?` over a missing row is a harmless 0-row update.
    conn.execute(
        "UPDATE agent_run SET state = ?1, updated_at = ?2 \
         WHERE run_id = ?3 AND state != ?4",
        params![status, now, run_id, STATE_CANCELLED],
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

/// (A1 run-controls) Read a run's RAW `state` string (whatever is stored), or `None` if the run
/// row does not exist. Unlike [`run_state`], this does NOT parse to a [`PlanState`], so it can
/// observe the out-of-vocab terminal [`STATE_CANCELLED`] (which `run_state` would map to `None`,
/// indistinguishable from a missing row). A control reader uses THIS to tell "cancelled run"
/// (`Some("cancelled")`) apart from "no such run" (`None`).
pub fn run_state_string(conn: &Connection, run_id: &str) -> Result<Option<String>> {
    let s: Option<String> = conn
        .query_row(
            "SELECT state FROM agent_run WHERE run_id = ?1",
            [run_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(s)
}

/// (A1 run-controls) True iff the run exists AND its `state` is the terminal [`STATE_CANCELLED`].
/// `false` for a missing run or any non-cancelled state.
pub fn is_cancelled(conn: &Connection, run_id: &str) -> Result<bool> {
    Ok(run_state_string(conn, run_id)?.as_deref() == Some(STATE_CANCELLED))
}

/// The outcome of [`cancel_run`] — distinguishing the THREE fail-closed-safe cases the control
/// plane must report differently (mirrors the workflow run-control vocabulary).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelOutcome {
    /// The run existed and was non-terminal: its `state` is now [`STATE_CANCELLED`].
    Cancelled,
    /// The run was ALREADY [`STATE_CANCELLED`]: idempotent no-op success (no second write).
    AlreadyCancelled,
    /// The run does not exist (no row to cancel): fail-closed, nothing written.
    UnknownRun,
}

/// (A1 run-controls) CANCEL a run by writing the terminal [`STATE_CANCELLED`] `agent_run.state`,
/// bypassing the [`PlanState`] transition machine (cancel is an out-of-band terminal stop, not a
/// plan transition; the free-form TEXT column admits it with NO migration). Fail-closed and
/// idempotent:
///   - an UNKNOWN run writes nothing and returns [`CancelOutcome::UnknownRun`];
///   - an ALREADY-cancelled run writes nothing and returns [`CancelOutcome::AlreadyCancelled`];
///   - otherwise the state becomes `cancelled` and the fn returns [`CancelOutcome::Cancelled`].
///
/// **It NEVER touches `run_result`.** A run that already produced a terminal answer keeps it (the
/// caller should refuse to cancel a completed run BEFORE calling this — see the control handler —
/// but even if called, this only sets the `agent_run.state` flag and never clobbers a stored
/// answer body/fingerprint). This is a state flag the LOOP and READERS can observe; it does not
/// itself interrupt an in-flight loop mid-turn (the loop is synchronous per dispatch — cancel is
/// observed between dispatches / on the next control read).
pub fn cancel_run(conn: &Connection, run_id: &str, now: i64) -> Result<CancelOutcome> {
    match run_state_string(conn, run_id)? {
        None => Ok(CancelOutcome::UnknownRun),
        Some(s) if s == STATE_CANCELLED => Ok(CancelOutcome::AlreadyCancelled),
        Some(_) => {
            conn.execute(
                "UPDATE agent_run SET state = ?1, updated_at = ?2 WHERE run_id = ?3",
                params![STATE_CANCELLED, now, run_id],
            )?;
            Ok(CancelOutcome::Cancelled)
        }
    }
}

#[cfg(test)]
mod cancel_tests {
    use super::*;
    use crate::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-agent-run-cancel-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn cancel_unknown_run_is_fail_closed_no_write() {
        let db = Db::open_hub(&tmp("unknown")).unwrap();
        assert_eq!(
            cancel_run(db.conn(), "nope", 100).unwrap(),
            CancelOutcome::UnknownRun
        );
        // Still no row (cancel never CREATES a run).
        assert_eq!(run_state_string(db.conn(), "nope").unwrap(), None);
        assert!(!is_cancelled(db.conn(), "nope").unwrap());
    }

    #[test]
    fn cancel_live_run_writes_terminal_state_and_is_idempotent() {
        let db = Db::open_hub(&tmp("live")).unwrap();
        create_run(db.conn(), "r1", "do something", 1).unwrap();
        // First cancel transitions the live run.
        assert_eq!(
            cancel_run(db.conn(), "r1", 2).unwrap(),
            CancelOutcome::Cancelled
        );
        assert!(is_cancelled(db.conn(), "r1").unwrap());
        assert_eq!(
            run_state_string(db.conn(), "r1").unwrap().as_deref(),
            Some(STATE_CANCELLED)
        );
        // Second cancel is an idempotent no-op success.
        assert_eq!(
            cancel_run(db.conn(), "r1", 3).unwrap(),
            CancelOutcome::AlreadyCancelled
        );
        assert!(is_cancelled(db.conn(), "r1").unwrap());
    }

    #[test]
    fn cancelled_state_is_outside_planstate_vocab_and_blocks_re_decide() {
        // STATE_CANCELLED is NOT a PlanState ⇒ run_state() reads it back as None (no PlanState),
        // and set_run_state can never transition out of it (the current state does not parse).
        let db = Db::open_hub(&tmp("vocab")).unwrap();
        create_run(db.conn(), "r1", "do something", 1).unwrap();
        cancel_run(db.conn(), "r1", 2).unwrap();
        assert_eq!(run_state(db.conn(), "r1").unwrap(), None);
        // A re-decide attempt fails closed (current state unparseable ⇒ Unsupported), never
        // resurrecting a cancelled run into the approval flow.
        let err = set_run_state(db.conn(), "r1", PlanState::Approved, 4);
        assert!(err.is_err(), "must not transition out of cancelled");
        // The cancelled flag is intact after the refused transition.
        assert!(is_cancelled(db.conn(), "r1").unwrap());
    }

    #[test]
    fn run_state_string_distinguishes_cancelled_from_missing() {
        let db = Db::open_hub(&tmp("distinguish")).unwrap();
        create_run(db.conn(), "r1", "do something", 1).unwrap();
        cancel_run(db.conn(), "r1", 2).unwrap();
        // Cancelled run: Some("cancelled"); missing run: None — the control plane can tell them
        // apart even though run_state() maps BOTH to None.
        assert_eq!(
            run_state_string(db.conn(), "r1").unwrap().as_deref(),
            Some(STATE_CANCELLED)
        );
        assert_eq!(run_state_string(db.conn(), "ghost").unwrap(), None);
    }
}
