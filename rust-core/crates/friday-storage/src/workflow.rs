//! Workflow run + step persistence (Unit 9; gate `21` §9, `08`, `10` §6). Hub-only.
//!
//! Composes `friday-core`'s `WorkflowRunState` machine and the evidence-gated
//! step-completion invariant: a side-effect step is persisted `Verified` only
//! with deterministic evidence; otherwise `ProofPending` — a model self-claim
//! never marks it verified (`08` §6 / `10` §6).

use crate::error::{Result, StorageError};
use friday_core::{resolve_step_completion, StepStatus, WorkflowRunState};
use rusqlite::{params, Connection, OptionalExtension};

fn parse_run_state(s: &str) -> WorkflowRunState {
    match s {
        "pending" => WorkflowRunState::Pending,
        "running" => WorkflowRunState::Running,
        "awaiting_checkpoint" => WorkflowRunState::AwaitingCheckpoint,
        "done" => WorkflowRunState::Done,
        _ => WorkflowRunState::Failed,
    }
}

fn parse_step_status(s: &str) -> StepStatus {
    match s {
        "pending" => StepStatus::Pending,
        "running" => StepStatus::Running,
        "proof_pending" => StepStatus::ProofPending,
        "verified" => StepStatus::Verified,
        _ => StepStatus::Failed,
    }
}

/// Create a workflow run in `Pending`.
pub fn create_run(conn: &Connection, run_id: &str, name: &str, created_at: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO workflow_run (run_id, name, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![run_id, name, WorkflowRunState::Pending.as_str(), created_at],
    )?;
    Ok(())
}

pub fn run_state(conn: &Connection, run_id: &str) -> Result<Option<WorkflowRunState>> {
    let s: Option<String> = conn
        .query_row(
            "SELECT state FROM workflow_run WHERE run_id = ?1",
            [run_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(s.map(|x| parse_run_state(&x)))
}

/// Transition a run's state, validated by the `friday-core` state machine
/// (an invalid transition is rejected).
pub fn set_run_state(
    conn: &Connection,
    run_id: &str,
    next: WorkflowRunState,
    now: i64,
) -> Result<()> {
    let cur = run_state(conn, run_id)?
        .ok_or_else(|| StorageError::Unsupported(format!("workflow_run '{run_id}' not found")))?;
    let next = cur.try_transition(next)?; // CoreError -> StorageError
    conn.execute(
        "UPDATE workflow_run SET state = ?1, updated_at = ?2 WHERE run_id = ?3",
        params![next.as_str(), now, run_id],
    )?;
    Ok(())
}

/// Add a step (status `Pending`). `has_side_effect` decides evidence-gating.
#[allow(clippy::too_many_arguments)]
pub fn add_step(
    conn: &Connection,
    step_id: &str,
    run_id: &str,
    seq: i64,
    has_side_effect: bool,
    created_at: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO workflow_step
            (step_id, run_id, seq, has_side_effect, status, evidence_ref, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
        params![
            step_id,
            run_id,
            seq,
            has_side_effect as i64,
            StepStatus::Pending.as_str(),
            created_at
        ],
    )?;
    Ok(())
}

pub fn step_status(conn: &Connection, step_id: &str) -> Result<Option<StepStatus>> {
    let s: Option<String> = conn
        .query_row(
            "SELECT status FROM workflow_step WHERE step_id = ?1",
            [step_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(s.map(|x| parse_step_status(&x)))
}

/// Resolve + persist a step's completion via the evidence-gating invariant. A
/// side-effect step is persisted `Verified` only when deterministic evidence is
/// supplied (`evidence_ref`); otherwise `ProofPending` (even if the model claimed
/// done). Returns the persisted status.
///
/// Evidence presence is the presence of `evidence_ref` — there is no separate
/// `has_evidence` flag to diverge from it, so a step can never be persisted
/// `Verified` while carrying a NULL `evidence_ref` (the invariant is enforced by
/// the API shape, not just by caller discipline). A step already in a terminal
/// state (`Verified`/`Failed`) is refused — completion cannot be downgraded;
/// `ProofPending` is non-terminal, so late-arriving evidence still verifies it.
pub fn complete_step(
    conn: &Connection,
    step_id: &str,
    evidence_ref: Option<&str>,
    model_claimed_done: bool,
    now: i64,
) -> Result<StepStatus> {
    let (has_side_effect, cur_status) = conn
        .query_row(
            "SELECT has_side_effect, status FROM workflow_step WHERE step_id = ?1",
            [step_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| StorageError::Unsupported(format!("workflow_step '{step_id}' not found")))?;

    // A terminal step cannot be re-completed (no Verified -> ProofPending downgrade).
    if parse_step_status(&cur_status).is_terminal() {
        return Err(StorageError::Unsupported(format!(
            "workflow_step '{step_id}' is already terminal ({cur_status}); refusing to re-complete"
        )));
    }

    // Evidence presence IS the ref's presence: no divergent (has_evidence, ref) pair.
    let has_evidence = evidence_ref.is_some();
    let status = resolve_step_completion(has_side_effect != 0, has_evidence, model_claimed_done);
    // Only attach an evidence_ref when the step is actually verified by evidence.
    let stored_ref = if matches!(status, StepStatus::Verified) {
        evidence_ref
    } else {
        None
    };
    conn.execute(
        "UPDATE workflow_step SET status = ?1, evidence_ref = ?2, updated_at = ?3 WHERE step_id = ?4",
        params![status.as_str(), stored_ref, now, step_id],
    )?;
    Ok(status)
}
