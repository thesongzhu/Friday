//! Workflow run + step persistence (Unit 9; gate `21` §9, `08`, `10` §6). Hub-only.
//!
//! Composes `friday-core`'s `WorkflowRunState` machine and the evidence-gated
//! step-completion invariant: a side-effect step is persisted `Verified` only
//! with deterministic evidence; otherwise `ProofPending` — a model self-claim
//! never marks it verified (`08` §6 / `10` §6).

use crate::error::{Result, StorageError};
use friday_core::{
    resolve_step_completion, run_is_complete, StepStatus, StepView, WorkflowRunState,
};
use rusqlite::{params, Connection, OptionalExtension};

fn parse_run_state(s: &str) -> WorkflowRunState {
    match s {
        "pending" => WorkflowRunState::Pending,
        "running" => WorkflowRunState::Running,
        "awaiting_checkpoint" => WorkflowRunState::AwaitingCheckpoint,
        "done" => WorkflowRunState::Done,
        // R2 slice-2: `cancelled` is a NEW first-class state. It MUST parse back to
        // `Cancelled` (NOT fall through to the `_ => Failed` catch-all) — otherwise
        // a cancel write would silently read back as `Failed`, reintroducing the
        // cancelled/failed erasure the hard rules forbid. The compiler does NOT
        // enforce this arm (the catch-all absorbs it), so it is explicit + tested.
        "cancelled" => WorkflowRunState::Cancelled,
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

/// `(run_id, name)` for every run in `state`, most-recently-updated first (uses
/// `idx_workflow_run_state`). The data-layer query that backs the Needs-Me inbox's
/// workflow source (`08` §2) — e.g. all `AwaitingCheckpoint` runs awaiting the user.
pub fn runs_in_state(conn: &Connection, state: WorkflowRunState) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT run_id, name FROM workflow_run WHERE state = ?1 ORDER BY updated_at DESC, run_id",
    )?;
    let rows = stmt.query_map([state.as_str()], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// The seq of the run's first `Pending` step (the paused checkpoint of an
/// `AwaitingCheckpoint` run), or `None` if it has no pending step. Used to label the
/// Needs-Me item with the exact step awaiting the user.
pub fn first_pending_seq(conn: &Connection, run_id: &str) -> Result<Option<i64>> {
    let seq: Option<i64> = conn
        .query_row(
            "SELECT seq FROM workflow_step WHERE run_id = ?1 AND status = ?2 ORDER BY seq LIMIT 1",
            params![run_id, StepStatus::Pending.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    Ok(seq)
}

/// Load every step of a run as a `StepView` (side-effect flag + status). This is
/// the input to the run-completion gate; it is the single read used by
/// `set_run_state` to decide whether a `-> Done` transition is allowed.
fn step_views(conn: &Connection, run_id: &str) -> Result<Vec<StepView>> {
    let mut stmt = conn.prepare(
        "SELECT has_side_effect, status FROM workflow_step WHERE run_id = ?1 ORDER BY seq",
    )?;
    let rows = stmt.query_map([run_id], |r| {
        Ok(StepView {
            has_side_effect: r.get::<_, i64>(0)? != 0,
            status: parse_step_status(&r.get::<_, String>(1)?),
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StorageError::from)
}

/// Transition a run's state, validated by the `friday-core` state machine
/// (an invalid transition is rejected).
///
/// Beyond the per-run state-machine check, a transition **to `Done`** is gated by
/// `run_is_complete` (`08` §6 / `10` §6 / `32` deferral): a run cannot be reported
/// `Done` while any side-effect step is still `ProofPending` (evidence not yet
/// arrived) or `Failed`. Because this is the single write API for run state, a
/// `Done` run with an unverified side-effect step is **unrepresentable through the
/// API** — not merely discouraged (the Unit-9 divergent-pair resolution discipline).
/// A run whose side-effect step has `Failed` must be transitioned to `Failed`, not
/// forced `Done`.
pub fn set_run_state(
    conn: &Connection,
    run_id: &str,
    next: WorkflowRunState,
    now: i64,
) -> Result<()> {
    let cur = run_state(conn, run_id)?
        .ok_or_else(|| StorageError::Unsupported(format!("workflow_run '{run_id}' not found")))?;
    let next = cur.try_transition(next)?; // CoreError -> StorageError

    // Run-completion gate: refuse `-> Done` while a side-effect step is unverified.
    if next == WorkflowRunState::Done {
        let steps = step_views(conn, run_id)?;
        if !run_is_complete(&steps) {
            return Err(StorageError::Unsupported(format!(
                "workflow_run '{run_id}' cannot be marked Done: a side-effect step is not Verified \
                 (proof_pending or failed). Attach evidence to verify it, or transition the run to Failed."
            )));
        }
    }

    conn.execute(
        "UPDATE workflow_run SET state = ?1, updated_at = ?2 WHERE run_id = ?3",
        params![next.as_str(), now, run_id],
    )?;
    Ok(())
}

/// How a run's current state classifies for run-CONTROL (R2): the read-only
/// projection the dark run-control plane needs to fail-closed BEFORE attempting
/// any transition. It carries the run's current [`WorkflowRunState`] and the two
/// control-relevant predicates derived from the *same* `friday-core` state
/// machine that [`set_run_state`] enforces — so the control layer never
/// hand-rolls a second, divergent transition table.
///
/// `resumable` is exactly "the run is `AwaitingCheckpoint`" — a *resume* is the
/// re-entry of a paused (checkpoint) run. The core machine also allows `Pending
/// -> Running`, but that is a fresh START, not a resume, so `resumable` is NOT
/// "any `-> Running` is legal"; it is precisely the `AwaitingCheckpoint` predicate
/// the engine's [`crate::workflow`]-driven `resume_workflow` already enforces.
/// `terminal` is the core `is_terminal()` (`Done`/`Failed`). This is purely
/// additive read-only metadata; it performs NO write and changes no existing
/// behavior.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunControlState {
    pub state: WorkflowRunState,
    /// `true` iff a `-> Running` resume transition is permitted from `state`
    /// (i.e. `state == AwaitingCheckpoint`). Mirrors the `friday-core` machine.
    pub resumable: bool,
    /// `true` iff `state` is a terminal run state (`Done`/`Failed`).
    pub terminal: bool,
}

/// Read a run's [`RunControlState`] — the fail-closed precheck the dark R2
/// run-control plane consults before attempting a control transition. Returns
/// `None` for an unknown `run_id` (the control layer surfaces a not-found error);
/// never writes. `resumable` is the `AwaitingCheckpoint` predicate — a paused run
/// that the `friday-core` machine permits `-> Running` re-entry from — matching
/// exactly what the engine's `resume_workflow` already requires, so the control
/// layer cannot accept a resume the engine would reject.
pub fn run_control_state(conn: &Connection, run_id: &str) -> Result<Option<RunControlState>> {
    let Some(state) = run_state(conn, run_id)? else {
        return Ok(None);
    };
    Ok(Some(RunControlState {
        state,
        // Resume = re-entry of a PAUSED run, i.e. exactly AwaitingCheckpoint
        // (the engine's resume_workflow rejects any other state). `Pending ->
        // Running` is a fresh start, not a resume, so it is deliberately NOT
        // counted resumable here even though the core machine allows that edge.
        resumable: matches!(state, WorkflowRunState::AwaitingCheckpoint),
        terminal: state.is_terminal(),
    }))
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

// --- R2 slice-2: run-CONTROL persistence (retry / cancel). Hub-only, additive. ---
//
// These compose the same `friday-core` machine `set_run_state` enforces; they add
// NO second transition table. They are the storage primitives the dark R2
// run-control plane (`friday-hub::workflow_run_control`) delegates to, mirroring
// the TS `friday-workflow-execution-service` `retryRun`/`cancelRun` writes.

/// The persisted retry-attempt count of a step (the `attempt` column, m0027). `1`
/// is the base attempt (matching TS, which starts a node at `attempt = 1` and a
/// retry at `attempt + 1`). Returns `None` for an unknown `step_id`.
pub fn step_attempt(conn: &Connection, step_id: &str) -> Result<Option<i64>> {
    let a: Option<i64> = conn
        .query_row(
            "SELECT attempt FROM workflow_step WHERE step_id = ?1",
            [step_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(a)
}

/// REOPEN the non-terminal frontier step of a failed run for retry (the retry
/// primitive). Mirrors TS `retryRun`'s per-node retry-attempt creation: it returns
/// the step to `Pending` and bumps `attempt` (the m0027 column) so a re-drive
/// re-dispatches it through the gate and `complete_step` accepts it again.
///
/// Unlike TS — which INSERTs a new attempt *row* (its `workflow_run_node` keys on
/// `(runId, nodeId, attempt)`) — the Rust `workflow_step` keys on a single
/// `step_id` PK, so this is an in-place UPDATE that bumps the attempt counter
/// (inserting a new row would collide on the PK). The attempt counter still
/// records the retry, faithful to the TS `attempt + 1` semantics, without a schema
/// reshape outside m0027's additive column.
///
/// ## Which step state is the retry frontier (HONEST — the engine never writes a
/// `Failed` *step* status)
/// A failed run's frontier step is NOT `StepStatus::Failed` — the engine has no
/// path that persists that status. Tracing the failure arms in
/// [`crate::workflow_exec`]: an exec-error on a side-effect step persists
/// `ProofPending` (`complete_step(None,..)`), an exec-error on a non-side-effect
/// step leaves it `Running`, and a denied/unregistered checkpoint leaves it
/// `Pending` (it was registered but never executed). So this reopens any
/// **non-`Verified`** step (`Pending`/`Running`/`ProofPending`/the injected-only
/// `Failed`) — the real engine-produced frontier. It REFUSES a `Verified` step:
/// completed (evidence-verified) side-effect work must never be silently redone
/// (that would be the data-fudge the hard rules forbid). Returns the new attempt.
pub fn reopen_failed_step(conn: &Connection, step_id: &str, now: i64) -> Result<i64> {
    let cur: Option<String> = conn
        .query_row(
            "SELECT status FROM workflow_step WHERE step_id = ?1",
            [step_id],
            |r| r.get(0),
        )
        .optional()?;
    let cur = cur
        .ok_or_else(|| StorageError::Unsupported(format!("workflow_step '{step_id}' not found")))?;
    if parse_step_status(&cur) == StepStatus::Verified {
        return Err(StorageError::Unsupported(format!(
            "workflow_step '{step_id}' is 'verified'; completed work is not re-driveable on retry"
        )));
    }
    // Reopen: -> Pending, attempt += 1, clear any stale evidence_ref (a failed/partial
    // attempt's ref is invalid — a fresh attempt re-earns it).
    conn.execute(
        "UPDATE workflow_step
            SET status = ?1, attempt = attempt + 1, evidence_ref = NULL, updated_at = ?2
          WHERE step_id = ?3",
        params![StepStatus::Pending.as_str(), now, step_id],
    )?;
    let new_attempt: i64 = conn.query_row(
        "SELECT attempt FROM workflow_step WHERE step_id = ?1",
        [step_id],
        |r| r.get(0),
    )?;
    Ok(new_attempt)
}

/// CANCEL a run terminally, recording the reason (the cancel primitive). Mirrors
/// TS `cancelRun`'s `finalizeRun(runId, "cancelled", …, {message: reason})`: it
/// transitions the run to the terminal `Cancelled` state THROUGH the `friday-core`
/// machine (so `{Pending,Running,AwaitingCheckpoint} -> Cancelled` is validated and
/// a terminal `Done`/`Failed`/`Cancelled` run is REFUSED — never reopened) and
/// writes `cancel_reason` (m0027) in the SAME statement (atomic state+reason).
///
/// This NEVER coerces a run onto `Failed` — the cancelled/failed distinction is
/// preserved end-to-end (the write is `Cancelled`, and `parse_run_state` reads it
/// back as `Cancelled`). Fail-closed: an unknown run, or a run in a non-cancellable
/// (terminal) state, returns an error and writes nothing.
pub fn cancel_run(conn: &Connection, run_id: &str, reason: Option<&str>, now: i64) -> Result<()> {
    let cur = run_state(conn, run_id)?
        .ok_or_else(|| StorageError::Unsupported(format!("workflow_run '{run_id}' not found")))?;
    // Validate the transition through the SAME core machine set_run_state uses — a
    // terminal run (Done/Failed/Cancelled) has no -> Cancelled edge and fails here.
    let next = cur.try_transition(WorkflowRunState::Cancelled)?;
    conn.execute(
        "UPDATE workflow_run SET state = ?1, cancel_reason = ?2, updated_at = ?3 WHERE run_id = ?4",
        params![next.as_str(), reason, now, run_id],
    )?;
    Ok(())
}

/// Read a run's `cancel_reason` (m0027), or `None` if unset / the run is unknown.
/// A non-cancelled run carries `NULL` (the column defaults NULL); only a cancel
/// writes it.
pub fn run_cancel_reason(conn: &Connection, run_id: &str) -> Result<Option<String>> {
    let r: Option<Option<String>> = conn
        .query_row(
            "SELECT cancel_reason FROM workflow_run WHERE run_id = ?1",
            [run_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(r.flatten())
}
