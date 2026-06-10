//! Read-only projection helpers for `workflow_run` + `workflow_step` (S9 readback).
//!
//! Additive, READ-ONLY sibling of the write path in [`crate::workflow`] — the
//! exact split [`crate::agent_run_read`] established for `agent_run` (S2). These
//! helpers exist so a refs-only projection (the `hub_workflow_run_readback` dev
//! bin) can read back a workflow run's state by `run_id` WITHOUT touching any
//! write path. Nothing here mutates state; every function only `SELECT`s.
//!
//! ## Refs-only / no-body discipline
//! [`WorkflowStepSummary`] deliberately NEVER carries the `evidence_ref` TEXT —
//! that column holds a tool-receipt summary which can embed a (relative)
//! filename, i.e. body-adjacent content. Only its **presence** is projected
//! (`has_evidence`, computed in SQL as `evidence_ref IS NOT NULL`), so the
//! evidence text is structurally unselectable through this module. The run
//! `name` IS returned (a definition-name label, the same field the S8
//! `hub_workflow_def_inspect` projection already emits), but the caller MUST
//! still run everything through an output guard before emitting off-process.

use crate::error::Result;
use rusqlite::{Connection, OptionalExtension};

/// A read-only summary of a `workflow_run` row. `state` is the persisted
/// `WorkflowRunState` string (a safe closed-vocab label, e.g.
/// `awaiting_checkpoint`); the timestamps are ints; `name` is the workflow
/// definition's name label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowRunSummary {
    pub run_id: String,
    pub name: String,
    pub state: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A read-only summary of one `workflow_step` row. Carries the step's
/// identifiers/labels/flags ONLY — the `evidence_ref` text is unselectable here
/// (see the module docs); its presence is the `has_evidence` bool.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowStepSummary {
    /// The engine's step id (`<run_id>:s<seq>` — an identifier, never a body).
    pub step_id: String,
    pub seq: i64,
    pub has_side_effect: bool,
    /// The persisted `StepStatus` string (closed vocab, e.g. `verified`).
    pub status: String,
    /// Whether deterministic evidence is attached (`evidence_ref IS NOT NULL`).
    /// The evidence text itself is never selected.
    pub has_evidence: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Fetch a workflow run's refs-only summary by id (read-only). `None` if the
/// run is unknown.
pub fn get_workflow_run_summary(
    conn: &Connection,
    run_id: &str,
) -> Result<Option<WorkflowRunSummary>> {
    let row = conn
        .query_row(
            "SELECT run_id, name, state, created_at, updated_at
             FROM workflow_run WHERE run_id = ?1",
            [run_id],
            |r| {
                Ok(WorkflowRunSummary {
                    run_id: r.get(0)?,
                    name: r.get(1)?,
                    state: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// The ordered (by `seq` ascending) refs-only summaries of a run's steps.
/// `evidence_ref` is projected ONLY as the `has_evidence` bool — the text is
/// never selected (refs-only at the SQL layer, not just at the emit layer).
pub fn list_workflow_step_summaries(
    conn: &Connection,
    run_id: &str,
) -> Result<Vec<WorkflowStepSummary>> {
    let mut stmt = conn.prepare(
        "SELECT step_id, seq, has_side_effect, status, evidence_ref IS NOT NULL,
                created_at, updated_at
         FROM workflow_step WHERE run_id = ?1 ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map([run_id], |r| {
        Ok(WorkflowStepSummary {
            step_id: r.get(0)?,
            seq: r.get(1)?,
            has_side_effect: r.get::<_, i64>(2)? != 0,
            status: r.get(3)?,
            has_evidence: r.get::<_, i64>(4)? != 0,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
