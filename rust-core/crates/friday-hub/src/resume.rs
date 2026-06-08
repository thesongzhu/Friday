//! S6d — the resume/ingestion entrypoint (dev bridge, completion leg).
//!
//! Given a run that Paused on a mutating action (the loop persisted a
//! `pending_approval_request` with a CSPRNG nonce + the exact tool call) and an
//! operator-Ed25519-signed approval (the S6c CLI output), this INGESTS the approval,
//! VERIFIES it against the operator's PUBLIC key (the S6b Ed25519 verify-only policy),
//! executes the ONE approved mutation, and records a truth-labeled, proof-linked result.
//!
//! It NEVER mints — it only verifies + consumes:
//!   - the approval is looked up by its `approval_id` NONCE against the persisted pending
//!     request (an unknown nonce is refused);
//!   - the reconstructed action digest must equal BOTH the pending row's digest AND the
//!     approval's digest (a wrong-digest / wrong-principal approval is refused — the
//!     digest binds principal/scope/params transitively);
//!   - [`authorize_mutating_action_ed25519`] then verifies the signature as Ed25519 under
//!     the operator's key, checks expiry, and CONSUMES the nonce (single-use). A second
//!     ingest of the same approval is replay-refused by the `consumed_approval` store;
//!   - an HMAC-signed approval for the protected action is rejected (it is never a valid
//!     Ed25519 signature) — the same downgrade defense the loop uses.
//!
//! Truth label: operator-approved mutating completion is now WIRED + mechanism-tested.
//! The LIVE proof with a real operator-held key is S6e (key-custody gate); `executeRun`
//! is NOT replaced (this is the dev-bridge completion leg). PROOF-ONLY; NOT v1 GO.

use friday_core::gate::{canonical_action_bytes, CanonicalApproval, GateDecision};
use friday_crypto::OperatorVerifyingKey;
use friday_storage::{
    audit, authorize_mutating_action_ed25519, get_pending_request, persist_run_result,
    set_pending_status, PendingApprovalRequest, RunResult, StorageError,
};
use rusqlite::Connection;

use crate::{build_request_with_policy, RawToolCall, RunPolicy, ToolError, ToolExecutor};

/// The result of an ingest+resume attempt. Refs-friendly: it carries the gate decision,
/// a coarse status, whether the one mutation executed, and a soft link to the audit
/// receipt — never a body. The bin layers the refs-only JSON (sha/len) on top.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumeOutcome {
    pub run_id: String,
    pub approval_id: String,
    /// The gate's decision on the ingested approval (`Allow` ⇒ the mutation ran;
    /// `Deny` ⇒ refused — replay/expired/bad-signature/etc).
    pub decision: GateDecision,
    /// The gate's reason string (e.g. `canonical_approval_granted`,
    /// `canonical_approval_replay_refused`).
    pub reason: String,
    /// True iff the ONE approved mutation executed (gate `Allow` + executor `Ok`).
    pub executed: bool,
    /// Coarse, safe result status persisted to `run_result` (never a body).
    pub result_status: String,
    /// Soft link to the hash-chained audit receipt for this resume.
    pub audit_ref: Option<String>,
}

/// Why an ingest+resume could not be processed at all (distinct from a gate `Deny`, which
/// is a processed-and-refused [`ResumeOutcome`]). Fail-closed: every arm means NO mutation
/// ran.
#[derive(Debug)]
pub enum ResumeError {
    /// No pending request matches the approval's `approval_id` nonce (never persisted, or
    /// already cleared) — nothing to resume.
    UnknownNonce,
    /// The pending row carries no replayable tool call (a pre-S6d row, or absent params).
    NoToolCall,
    /// The persisted tool call is not a registered tool (cannot be rebuilt/executed).
    Unregistered(String),
    /// The reconstructed action digest does not match the pending row and/or the
    /// approval — the approval does not authorize THIS exact action (wrong
    /// digest/principal/scope/params). A hard refusal; no nonce is consumed.
    DigestMismatch,
    Storage(StorageError),
}

impl From<StorageError> for ResumeError {
    fn from(e: StorageError) -> Self {
        ResumeError::Storage(e)
    }
}

impl std::fmt::Display for ResumeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResumeError::UnknownNonce => write!(f, "unknown_nonce"),
            ResumeError::NoToolCall => write!(f, "no_tool_call"),
            ResumeError::Unregistered(a) => write!(f, "unregistered_tool:{a}"),
            ResumeError::DigestMismatch => write!(f, "digest_mismatch"),
            ResumeError::Storage(e) => write!(f, "storage:{e}"),
        }
    }
}

impl std::error::Error for ResumeError {}

/// Reconstruct the exact [`RawToolCall`] a run Paused on from its persisted pending
/// request (the raw key/value params stored as JSON).
fn reconstruct_tool_call(pending: &PendingApprovalRequest) -> Result<RawToolCall, ResumeError> {
    let json = pending
        .tool_params
        .as_deref()
        .ok_or(ResumeError::NoToolCall)?;
    let params: Vec<(String, String)> =
        serde_json::from_str(json).map_err(|_| ResumeError::NoToolCall)?;
    Ok(RawToolCall {
        action: pending.action.clone(),
        params,
    })
}

/// Ingest an operator-signed approval and resume the paused run: verify (digest /
/// principal / expiry / nonce, single-use) against the operator's PUBLIC verify key, then
/// execute the ONE approved mutation and record a truth-labeled, proof-linked result.
///
/// `operator_vk` MUST come from an operator-controlled source ([`crate::operator_vk`]) —
/// this function only ever VERIFIES with it (never mints). Returns a [`ResumeOutcome`]
/// (gate `Allow` ⇒ executed; gate `Deny` ⇒ refused) or a [`ResumeError`] for a structural
/// failure (unknown nonce / unreplayable call / digest mismatch). In every refusal path,
/// NO mutation runs.
pub fn resume_with_approval(
    conn: &Connection,
    executor: &dyn ToolExecutor,
    operator_vk: &OperatorVerifyingKey,
    approval: &CanonicalApproval,
    now_ms: i64,
) -> Result<ResumeOutcome, ResumeError> {
    // (1) Look up the pending request by the approval's NONCE. An unknown nonce is a hard
    //     refusal — there is no paused action this approval applies to.
    let pending =
        get_pending_request(conn, &approval.approval_id)?.ok_or(ResumeError::UnknownNonce)?;
    let run_id = pending.run_id.clone();

    // (2) Reconstruct the EXACT tool call + request (with the run's bound principal, so the
    //     digest binds the principal the loop bound). build_request_with_policy is
    //     deterministic, so the rebuilt digest equals what the loop authorized.
    let raw = reconstruct_tool_call(&pending)?;
    let policy = RunPolicy::new(pending.principal_id.clone(), Vec::<String>::new(), false);
    let request = match build_request_with_policy(&raw, &policy) {
        Ok(r) => r,
        Err(ToolError::UnknownTool(action)) => return Err(ResumeError::Unregistered(action)),
    };

    // (3) Digest cross-check: the reconstructed action digest must equal BOTH the persisted
    //     pending digest AND the approval's digest. This is defense-in-depth on top of the
    //     authorize digest check: a tampered tool_params (different mutation) cannot match,
    //     and an approval for a different action/principal is refused before any signature
    //     verification touches the nonce.
    let digest = friday_crypto::action_digest(&canonical_action_bytes(&request));
    if digest != pending.action_digest || approval.action_digest != pending.action_digest {
        return Err(ResumeError::DigestMismatch);
    }

    // (4) Authorize via the Ed25519 verify-only policy: verify the signature as Ed25519
    //     under the operator's key, check expiry, and CONSUME the nonce (single-use). NEVER
    //     mints. A replay/expired/HMAC/forged approval returns Deny here.
    let record =
        authorize_mutating_action_ed25519(conn, &request, Some(approval), operator_vk, now_ms)?;

    // A per-ATTEMPT CSPRNG tag keys the event/receipt ids so repeated resume attempts on the
    // same nonce (e.g. a replay that is refused, or a wrong-key retry) never PK-collide on
    // `agent_run_event.event_id` — each refused attempt still leaves its own audit trail.
    let attempt = friday_crypto::generate_approval_nonce();
    let event_id = format!("{run_id}:resume:{attempt}:outcome");
    let receipt_id = format!("{run_id}:resume:{attempt}:receipt");

    if record.decision != GateDecision::Allow {
        // Processed but refused (replay/expired/bad-signature/owner-denied). No execution.
        // The refusal IS audited (its own receipt), but we deliberately do NOT touch the
        // pending status or the run_result: a replay refusal must not relabel an already
        // `consumed` pending or clobber a completed run's immutable result, and an
        // expired/bad-signature refusal leaves the request `pending` so the operator can
        // re-sign a fresh (future-dated, correctly-signed) approval on the SAME nonce.
        let summary = format!("resume.refused:{}", record.reason);
        write_receipt(conn, &event_id, &receipt_id, &run_id, &summary, now_ms)?;
        return Ok(ResumeOutcome {
            run_id,
            approval_id: approval.approval_id.clone(),
            decision: record.decision,
            reason: record.reason,
            executed: false,
            result_status: "approval_refused".to_string(),
            audit_ref: Some(receipt_id),
        });
    }

    // (5) Allow → execute the ONE approved mutation. The nonce is already consumed, so a
    //     second ingest of this approval is replay-refused regardless of what happens here.
    match executor.execute(&raw.action, &raw.params) {
        Ok(receipt) => {
            let summary = format!("resume.executed:{}", receipt.summary);
            write_receipt(conn, &event_id, &receipt_id, &run_id, &summary, now_ms)?;
            set_pending_status(conn, &approval.approval_id, "consumed")?;
            persist_run_result(
                conn,
                &run_id,
                &RunResult::new(
                    "mutation_completed",
                    &receipt.summary,
                    Some(receipt_id.clone()),
                ),
                now_ms,
            )?;
            Ok(ResumeOutcome {
                run_id,
                approval_id: approval.approval_id.clone(),
                decision: GateDecision::Allow,
                reason: record.reason,
                executed: true,
                result_status: "mutation_completed".to_string(),
                audit_ref: Some(receipt_id),
            })
        }
        Err(e) => {
            let err_text = format!("{e}");
            let summary = format!("resume.exec_failed:{err_text}");
            write_receipt(conn, &event_id, &receipt_id, &run_id, &summary, now_ms)?;
            set_pending_status(conn, &approval.approval_id, "consumed")?;
            persist_run_result(
                conn,
                &run_id,
                &RunResult::new("mutation_exec_failed", &err_text, Some(receipt_id.clone())),
                now_ms,
            )?;
            Ok(ResumeOutcome {
                run_id,
                approval_id: approval.approval_id.clone(),
                decision: GateDecision::Allow,
                reason: format!("exec_error:{err_text}"),
                executed: false,
                result_status: "mutation_exec_failed".to_string(),
                audit_ref: Some(receipt_id),
            })
        }
    }
}

/// Write the event-log line + the hash-chained audit receipt in ONE transaction (so the
/// event log can never get ahead of the ledger on a partial commit) — the same coupling
/// the loop uses for an executed tool.
fn write_receipt(
    conn: &Connection,
    event_id: &str,
    receipt_id: &str,
    run_id: &str,
    summary: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction()?;
    friday_storage::agent_run::record_event(&tx, event_id, run_id, summary, now_ms)?;
    audit::append_audit(
        &tx,
        receipt_id,
        "operator-resume",
        summary,
        Some(run_id),
        now_ms,
    )?;
    tx.commit()?;
    Ok(())
}
