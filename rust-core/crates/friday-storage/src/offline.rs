//! Offline-queue execution engine (product decision `02` §15; gate `21` §2.1/§4.4).
//!
//! Load-bearing invariants, all enforced here:
//! - **An ack is not completion.** A queued action goes `Queued -> Acked ->
//!   Executed`; execution requires `Acked`, and only `Executed` is complete.
//! - **Auto-execute only if the original approval is still valid and scoped.**
//!   If the approval is no longer valid, the action fails closed (no execution).
//! - **Exactly once.** A re-delivered command (same `msg_id`) does not create a
//!   second row, and a second execute on an already-executed action is skipped.
//! - **A result is a receipt.** Execution writes an `offline_result` activity
//!   item atomically with the state flip.
//!
//! Scope: sequential, single-connection (matches the foundation). Robust
//! exactly-once against a crash *between* an external side effect and the commit
//! requires the live transport's 2-phase handling — deferred to the Unit-4
//! networked transport sub-slice; not claimed here.

use crate::error::{Result, StorageError};
use friday_core::{ActivityState, ActivityType, OfflineQueueState};
use rusqlite::{params, Connection, OptionalExtension};

fn parse_state(s: &str) -> OfflineQueueState {
    match s {
        "queued" => OfflineQueueState::Queued,
        "acked" => OfflineQueueState::Acked,
        "executed" => OfflineQueueState::Executed,
        _ => OfflineQueueState::Failed,
    }
}

/// Outcome of an `execute_once` call.
#[derive(Debug, PartialEq, Eq)]
pub enum ExecOutcome {
    /// The action ran and is now complete (a receipt was written).
    Executed,
    /// The action was already executed; this call was a no-op (idempotent).
    AlreadyExecuted,
    /// The original approval is no longer valid/scoped; failed closed, no run.
    ApprovalInvalid,
}

/// Enqueue a user-confirmed offline action. Idempotent on `msg_id`: a resend of
/// the same command does not create a second row. Returns the queue_id that
/// holds the action (the existing one on a resend).
#[allow(clippy::too_many_arguments)]
pub fn enqueue(
    conn: &Connection,
    queue_id: &str,
    action_kind: &str,
    msg_id: &str,
    payload_ref: Option<&str>,
    approval_scope_ref: Option<&str>,
    created_at: i64,
) -> Result<String> {
    if let Some(existing) = conn
        .query_row(
            "SELECT queue_id FROM offline_queue WHERE msg_id = ?1",
            [msg_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(existing); // resend of an already-queued command
    }
    conn.execute(
        "INSERT INTO offline_queue
            (queue_id, action_kind, payload_ref, msg_id, approval_scope_ref, state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            queue_id,
            action_kind,
            payload_ref,
            msg_id,
            approval_scope_ref,
            OfflineQueueState::Queued.as_str(),
            created_at
        ],
    )?;
    Ok(queue_id.to_string())
}

pub fn get_state(conn: &Connection, queue_id: &str) -> Result<Option<OfflineQueueState>> {
    let s: Option<String> = conn
        .query_row(
            "SELECT state FROM offline_queue WHERE queue_id = ?1",
            [queue_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(s.map(|x| parse_state(&x)))
}

fn current(conn: &Connection, queue_id: &str) -> Result<OfflineQueueState> {
    get_state(conn, queue_id)?
        .ok_or_else(|| StorageError::Unsupported(format!("offline_queue '{queue_id}' not found")))
}

/// Hub acknowledged receipt on reconnect: `Queued -> Acked`. Not completion.
pub fn ack(conn: &Connection, queue_id: &str) -> Result<()> {
    let cur = current(conn, queue_id)?;
    let next = cur.try_transition(OfflineQueueState::Acked)?; // CoreError -> StorageError
    conn.execute(
        "UPDATE offline_queue SET state = ?1 WHERE queue_id = ?2",
        params![next.as_str(), queue_id],
    )?;
    Ok(())
}

/// Execute an acked action exactly once. `approval_valid` reflects whether the
/// original approval still holds (`02` §15). `exec` performs the side effect and
/// returns an execution-proof result summary (or an error string).
pub fn execute_once<F>(
    conn: &mut Connection,
    queue_id: &str,
    approval_valid: bool,
    now: i64,
    exec: F,
) -> Result<ExecOutcome>
where
    F: FnOnce() -> std::result::Result<String, String>,
{
    let cur = current(conn, queue_id)?;

    // Idempotent: a second execute on an already-complete action is a no-op.
    if cur == OfflineQueueState::Executed {
        return Ok(ExecOutcome::AlreadyExecuted);
    }
    // Ack is not completion: you cannot execute something that wasn't acked.
    if cur != OfflineQueueState::Acked {
        return Err(StorageError::Unsupported(format!(
            "execute requires Acked (an ack is not completion); state = {}",
            cur.as_str()
        )));
    }
    // Fail closed if the original approval no longer holds.
    if !approval_valid {
        let next = cur.try_transition(OfflineQueueState::Failed)?;
        conn.execute(
            "UPDATE offline_queue SET state = ?1 WHERE queue_id = ?2",
            params![next.as_str(), queue_id],
        )?;
        return Ok(ExecOutcome::ApprovalInvalid);
    }

    // Run the side effect (produces the execution-proof result).
    let result =
        exec().map_err(|e| StorageError::Unsupported(format!("offline exec failed: {e}")))?;

    // Flip to Executed and write the receipt atomically.
    let next = cur.try_transition(OfflineQueueState::Executed)?;
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE offline_queue SET state = ?1 WHERE queue_id = ?2",
        params![next.as_str(), queue_id],
    )?;
    tx.execute(
        "INSERT INTO activity_item
            (activity_id, session_id, type, state, summary, created_at, updated_at, deep_link)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            format!("offline-result-{queue_id}"),
            Option::<String>::None,
            ActivityType::OfflineResult.as_str(),
            ActivityState::Done.as_str(),
            result,
            now,
            now,
            Option::<String>::None
        ],
    )?;
    tx.commit()?;
    Ok(ExecOutcome::Executed)
}
