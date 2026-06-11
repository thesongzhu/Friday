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
//! `name` IS returned (a free-form definition-name label) — callers MUST treat
//! it as body-adjacent and project it bounded (hash + length), never verbatim,
//! and still run everything through an output guard before emitting off-process.
//!
//! ## DB strings are NOT trusted (fail-closed re-validation)
//! [`list_workflow_step_summaries`] re-validates the two step fields that flow
//! into projections as strings: `status` must be in the engine's CLOSED
//! [`StepStatus`] vocabulary, and `step_id` must have the engine's
//! `<run_id>:s<seq>` shape. A row that violates either fails the WHOLE listing
//! CLOSED (error, not passthrough) — a tampered-DB-only channel, but cheap to
//! close at the projection layer rather than relying on downstream guards.

use crate::error::{Result, StorageError};
use friday_core::StepStatus;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

/// The engine's CLOSED step-status vocabulary, derived from [`StepStatus`]
/// itself (never a hand-maintained string list, so it cannot drift).
fn is_engine_step_status(s: &str) -> bool {
    const VOCAB: [StepStatus; 5] = [
        StepStatus::Pending,
        StepStatus::Running,
        StepStatus::ProofPending,
        StepStatus::Verified,
        StepStatus::Failed,
    ];
    VOCAB.iter().any(|v| v.as_str() == s)
}

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
    /// Re-validated against that exact shape at read time (fail-closed).
    pub step_id: String,
    pub seq: i64,
    pub has_side_effect: bool,
    /// The persisted `StepStatus` string. Re-validated at read time against the
    /// engine's CLOSED vocabulary (fail-closed) — never a free-form passthrough.
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
///
/// Fail-closed re-validation (DB strings are not trusted): every row's `status`
/// must be in the engine's closed [`StepStatus`] vocabulary and its `step_id`
/// must be exactly `<run_id>:s<seq>`. One bad row fails the WHOLE listing —
/// the tampered value is deliberately NOT quoted in the error (it is the
/// untrusted content being rejected).
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
        let s: WorkflowStepSummary = row?;
        if !is_engine_step_status(&s.status) {
            return Err(StorageError::Unsupported(format!(
                "workflow_step seq {} of run '{run_id}' has a status outside the \
                 engine vocabulary (fail-closed; refusing to project)",
                s.seq
            )));
        }
        if s.step_id != format!("{run_id}:s{}", s.seq) {
            return Err(StorageError::Unsupported(format!(
                "workflow_step seq {} of run '{run_id}' has a step_id that is not \
                 '<run_id>:s<seq>'-shaped (fail-closed; refusing to project)",
                s.seq
            )));
        }
        out.push(s);
    }
    Ok(out)
}

/// A bounded, refs-only FINGERPRINT of a step's `evidence_ref` text — the only
/// projection of the evidence content this layer ever produces. The raw
/// `evidence_ref` string (a tool-receipt summary that can embed a relative
/// filename, i.e. body-adjacent content) is NEVER carried out of the storage
/// function: it is hashed and measured INSIDE [`list_evidence_export`] and only
/// the `sha256` hex + UTF-8 byte `len` (or `None` for an absent ref) cross the
/// API boundary. This is STRICTER than the run-`name` projection (where the raw
/// name does cross into the caller), matching how the module already singles
/// `evidence_ref` out as the most body-adjacent column.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvidenceFingerprint {
    /// Lowercase sha256 hex of the evidence-ref bytes — an opaque content
    /// identifier, never the text. Used to attest "evidence X is present and is
    /// THIS exact receipt" without disclosing the receipt itself.
    pub sha256: String,
    /// The UTF-8 byte length of the evidence-ref text.
    pub len: usize,
}

/// One row of the refs-only EVIDENCE-EXPORT MANIFEST for a run
/// (`workflows.runs.evidence.export`). This is an evidence-centric audit
/// inventory — distinct from [`WorkflowStepSummary`] (run-state readback): it
/// pairs the evidence-GATING obligation (`has_side_effect`) against what is
/// actually attached (`fingerprint`), and carries the m0027 `attempt` counter so
/// a retried step's evidence provenance is visible.
///
/// ## `has_side_effect` IS the persisted evidence-gating obligation
/// The engine persists no separate `evidence_required` column on `workflow_step`
/// (that is a DEFINITION-level attribute the engine consumes to decide gating);
/// the persisted obligation on the run/step row is `has_side_effect` (see
/// [`crate::workflow::add_step`]: "`has_side_effect` decides evidence-gating"). So
/// a side-effect step is the one expected to carry a verified `evidence_ref`; the
/// export pairs that obligation against the attached `fingerprint`.
///
/// ## Manifest, NOT body retrieval
/// "Export" here is the manifest/inventory of evidence (presence + fingerprint +
/// gating + attempt), NOT retrieval of the evidence BODY. Body retrieval is a
/// separate, gated surface (a refs-only manifest cannot hand back receipt text);
/// it is a deferred sub-AC, not implied here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowStepEvidence {
    /// The engine's step id (`<run_id>:s<seq>`). Re-validated against that exact
    /// shape at read time (fail-closed), identical to [`WorkflowStepSummary`].
    pub step_id: String,
    pub seq: i64,
    /// Whether the step is a mutating/side-effect step — the persisted
    /// evidence-gating OBLIGATION half (see the type docs).
    pub has_side_effect: bool,
    /// The persisted `StepStatus` string. Re-validated at read time against the
    /// engine's CLOSED vocabulary (fail-closed) — never a free-form passthrough.
    pub status: String,
    /// The retry-attempt counter (m0027). `1` is the base attempt; a retried step
    /// reads back `2`, `3`, ... so evidence provenance across retries is visible.
    pub attempt: i64,
    /// The bounded fingerprint of the attached evidence, or `None` if no
    /// `evidence_ref` is attached. The raw text is NEVER carried here (see
    /// [`EvidenceFingerprint`]). The COMPLIANCE half: pair with `has_side_effect`
    /// to see whether a gated step actually attached verified evidence.
    pub fingerprint: Option<EvidenceFingerprint>,
}

/// The ordered (by `seq` ascending) refs-only evidence MANIFEST of a run's steps
/// — the read projection behind `workflows.runs.evidence.export`. For each step
/// it returns the evidence-gating obligation (`has_side_effect`), the persisted
/// status, the m0027 `attempt`, and a BOUNDED fingerprint (`sha256` + byte `len`)
/// of the `evidence_ref` — or `None` when no evidence is attached.
///
/// ## The `evidence_ref` text never crosses this boundary
/// The raw `evidence_ref` is `SELECT`ed into a local, hashed+measured here, and
/// then DROPPED — only the fingerprint leaves the function. So the body-adjacent
/// receipt text is structurally unable to reach any caller (including a future
/// route or proof bin), preserving the module's "refs-only at the SQL/API layer"
/// discipline strictly for the most sensitive column.
///
/// ## DB strings are NOT trusted (fail-closed re-validation)
/// Identical to [`list_workflow_step_summaries`]: every row's `status` must be in
/// the engine's closed [`StepStatus`] vocabulary and its `step_id` must be exactly
/// `<run_id>:s<seq>`. One bad row fails the WHOLE export CLOSED (error, not
/// passthrough). The tampered value is deliberately NOT quoted in the error.
pub fn list_evidence_export(conn: &Connection, run_id: &str) -> Result<Vec<WorkflowStepEvidence>> {
    // The raw `evidence_ref` IS selected here (column 4) — but it is consumed
    // (hashed + measured) inside the row mapper and never returned, so it cannot
    // cross the API boundary. This is the ONE place the text is touched.
    let mut stmt = conn.prepare(
        "SELECT step_id, seq, has_side_effect, status, evidence_ref, attempt
         FROM workflow_step WHERE run_id = ?1 ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map([run_id], |r| {
        let evidence_ref: Option<String> = r.get(4)?;
        // Fingerprint INSIDE the row mapper so the raw text is dropped at the end
        // of this closure — it is never stored on the returned struct.
        let fingerprint = evidence_ref.map(|text| EvidenceFingerprint {
            sha256: sha256_hex(text.as_bytes()),
            len: text.len(),
        });
        Ok(WorkflowStepEvidence {
            step_id: r.get(0)?,
            seq: r.get(1)?,
            has_side_effect: r.get::<_, i64>(2)? != 0,
            status: r.get(3)?,
            attempt: r.get(5)?,
            fingerprint,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        let e: WorkflowStepEvidence = row?;
        if !is_engine_step_status(&e.status) {
            return Err(StorageError::Unsupported(format!(
                "workflow_step seq {} of run '{run_id}' has a status outside the \
                 engine vocabulary (fail-closed; refusing to export)",
                e.seq
            )));
        }
        if e.step_id != format!("{run_id}:s{}", e.seq) {
            return Err(StorageError::Unsupported(format!(
                "workflow_step seq {} of run '{run_id}' has a step_id that is not \
                 '<run_id>:s<seq>'-shaped (fail-closed; refusing to export)",
                e.seq
            )));
        }
        out.push(e);
    }
    Ok(out)
}

/// Lowercase sha256 hex of `bytes` — the bounded fingerprint of an evidence-ref's
/// text (computed INSIDE [`list_evidence_export`] so the raw text never escapes).
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{add_step, complete_step, create_run, reopen_failed_step};
    use crate::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp_db(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-wfevx-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    /// Seed a run with two side-effect steps through the REAL write path: s0
    /// completed WITH an evidence receipt → Verified+ref (a fulfilled gated step),
    /// and s1 left Pending (a gated-but-unfulfilled step). Both `has_side_effect`,
    /// because the engine only attaches+stores an `evidence_ref` for a side-effect
    /// step that reaches Verified (`resolve_step_completion`/`complete_step`).
    /// Returns the open Db.
    fn seed_two_steps(tag: &str) -> (Db, &'static str) {
        let db = Db::open_hub(&tmp_db(tag)).unwrap();
        let conn = db.conn();
        create_run(conn, "r1", "wf", 100).unwrap();
        // s0: side-effect, completed WITH a receipt → Verified, evidence attached.
        add_step(conn, "r1:s0", "r1", 0, true, 100).unwrap();
        let st = complete_step(
            conn,
            "r1:s0",
            Some("wrote 15 bytes to notes.txt"),
            false,
            110,
        )
        .unwrap();
        assert_eq!(st, StepStatus::Verified);
        // s1: side-effect, left Pending (the evidence-gating OBLIGATION, no evidence yet).
        add_step(conn, "r1:s1", "r1", 1, true, 100).unwrap();
        (db, "r1")
    }

    #[test]
    fn export_pairs_gating_obligation_against_attached_fingerprint() {
        // The audit value-add: per step, the obligation (has_side_effect) vs what is
        // actually attached (fingerprint present?). s0 = obligation + evidence
        // present (fulfilled); s1 = obligation + evidence absent (unfulfilled).
        let (db, run) = seed_two_steps("pairing");
        let export = list_evidence_export(db.conn(), run).unwrap();
        assert_eq!(export.len(), 2);

        // s0: side-effect step that DID attach evidence (fulfilled gating).
        assert_eq!(export[0].step_id, "r1:s0");
        assert_eq!(export[0].seq, 0);
        assert!(export[0].has_side_effect, "the gating obligation is set");
        assert_eq!(export[0].status, "verified");
        assert_eq!(export[0].attempt, 1, "base attempt is 1");
        let fp = export[0].fingerprint.as_ref().expect("evidence attached");
        // The fingerprint is the sha256+len of the receipt text — NOT the text.
        assert_eq!(fp.sha256, sha256_hex(b"wrote 15 bytes to notes.txt"));
        assert_eq!(fp.len, "wrote 15 bytes to notes.txt".len());

        // s1: side-effect step (obligation) with NO evidence attached.
        assert_eq!(export[1].step_id, "r1:s1");
        assert!(export[1].has_side_effect, "the gating obligation is set");
        assert_eq!(export[1].status, "pending");
        assert!(
            export[1].fingerprint.is_none(),
            "a gated-but-unfulfilled step has no evidence fingerprint"
        );
    }

    #[test]
    fn raw_evidence_ref_text_never_appears_in_the_export_struct() {
        // STRUCTURAL canary: the receipt text embeds a filename (body-adjacent). The
        // returned manifest, rendered via Debug, must contain ONLY the fingerprint —
        // never the raw text. This proves the text does not cross the API boundary
        // (it is consumed + dropped inside the row mapper).
        let (db, run) = seed_two_steps("canary");
        let export = list_evidence_export(db.conn(), run).unwrap();
        let dumped = format!("{export:?}");
        assert!(
            !dumped.contains("notes.txt") && !dumped.contains("bytes to"),
            "raw evidence_ref text must never be carried out of the storage fn: {dumped}"
        );
        // The fingerprint hex IS present (proving evidence presence is surfaced).
        assert!(dumped.contains(&sha256_hex(b"wrote 15 bytes to notes.txt")));
    }

    #[test]
    fn attempt_counter_reflects_a_retry_reopen() {
        // The m0027 attempt provenance: reopen the side-effect step (as a retry
        // would) → attempt bumps to 2 in the export.
        let (db, run) = seed_two_steps("attempt");
        let conn = db.conn();
        let new_attempt = reopen_failed_step(conn, "r1:s1", 200).unwrap();
        assert_eq!(new_attempt, 2);
        let export = list_evidence_export(conn, run).unwrap();
        assert_eq!(export[1].attempt, 2, "the reopened step's attempt is 2");
        // reopen clears any stale evidence_ref → fingerprint stays None.
        assert!(export[1].fingerprint.is_none());
    }

    #[test]
    fn export_of_an_unknown_run_is_an_empty_manifest() {
        // An unknown run has no step rows → an empty manifest (not an error): the
        // caller (the bin) distinguishes unknown-run via the run summary, exactly
        // like the existing readback.
        let db = Db::open_hub(&tmp_db("unknown")).unwrap();
        assert!(list_evidence_export(db.conn(), "ghost").unwrap().is_empty());
    }

    #[test]
    fn tampered_step_status_fails_the_export_closed() {
        // DB strings are not trusted: a status outside the engine vocabulary fails
        // the WHOLE export closed (never a passthrough), identical to the summary
        // listing's posture.
        let (db, run) = seed_two_steps("tamper-status");
        db.conn()
            .execute(
                "UPDATE workflow_step SET status = 'sk-bogus' WHERE step_id = 'r1:s1'",
                [],
            )
            .unwrap();
        let r = list_evidence_export(db.conn(), run);
        assert!(matches!(r, Err(StorageError::Unsupported(_))), "got {r:?}");
    }

    #[test]
    fn tampered_step_id_shape_fails_the_export_closed() {
        let (db, run) = seed_two_steps("tamper-ref");
        db.conn()
            .execute(
                "UPDATE workflow_step SET step_id = 'Bearer evil' WHERE step_id = 'r1:s1'",
                [],
            )
            .unwrap();
        let r = list_evidence_export(db.conn(), run);
        assert!(matches!(r, Err(StorageError::Unsupported(_))), "got {r:?}");
    }
}
