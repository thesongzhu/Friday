//! Canonical mutating-action authorization (PR-3b of the agent-loop cluster, file
//! 39 §2 group A; UNW-001 / cat-10). Composes the three layers:
//!   - `friday-core::gate::evaluate` — the pure decision (PR-3a);
//!   - `friday-crypto` — SHA-256 action digest + constant-time HMAC signature verify;
//!   - this storage layer — the single-use replay store (`consumed_approval`).
//!
//! Only a `RequiresApproval` base decision consults an approval; a base `Allow`
//! (read-only) or `Deny` (reserved/local-deny) passes through untouched and never
//! touches the replay table. The upgrade `RequiresApproval -> Allow` happens ONLY
//! when a presented canonical approval is: digest-bound to THIS exact action,
//! signature-valid, unexpired, and not previously spent. Fail-closed throughout —
//! a missing/None field, a bad signature, or a stale base never yields `Allow`.

use crate::error::{Result, StorageError};
use friday_core::gate::{
    self, ApprovalDecision, CanonicalApproval, GateDecision, GateEvidenceRecord,
    MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use rusqlite::{params, Connection, Error as SqlErr, ErrorCode};

/// Authorize a (possibly mutating) action. `now_ms` is the caller's clock (this
/// layer stays pure of wall-clock). Returns the gate decision; only a valid,
/// unspent, digest-bound, signature-valid, unexpired approval upgrades a
/// `RequiresApproval` action to `Allow`.
pub fn authorize_mutating_action(
    conn: &Connection,
    request: &MutatingActionRequest,
    approval: Option<&CanonicalApproval>,
    secret: &[u8],
    now_ms: i64,
) -> Result<GateEvidenceRecord> {
    // Pure base decision. Allow/Deny are final and never consult an approval or the
    // replay store; only RequiresApproval can be upgraded.
    let base = gate::evaluate(request);
    if base.decision != GateDecision::RequiresApproval {
        return Ok(base);
    }
    let approval = match approval {
        Some(a) => a,
        None => return Ok(base), // no approval presented -> stays RequiresApproval
    };

    let risk = base.risk;
    let deny = |reason: &str| GateEvidenceRecord {
        decision: GateDecision::Deny,
        reason: reason.to_string(),
        risk,
        approval_required: true,
        denied_by: Some("canonical_gate".to_string()),
    };

    // (1) Digest binding: the approval must be for THIS exact action (same verb on a
    // different resource/params yields a different digest).
    let digest = friday_crypto::action_digest(&gate::canonical_action_bytes(request));
    if approval.action_digest != digest {
        return Ok(deny("canonical_approval_digest_mismatch"));
    }
    // (2) Explicit owner denial.
    if approval.decision == ApprovalDecision::Denied {
        return Ok(deny("canonical_approval_denied"));
    }
    // (3) Issuer + constant-time signature. Missing issuer/signature fails closed.
    if approval.issuer.as_deref() != Some(CANONICAL_GATE_ISSUER) {
        return Ok(deny("canonical_approval_bad_issuer"));
    }
    let sig = match &approval.signature {
        Some(s) => s,
        None => return Ok(deny("canonical_approval_signature_missing")),
    };
    let sig_bytes = gate::canonical_approval_signature_bytes(approval);
    if !friday_crypto::verify_approval_signature(&sig_bytes, secret, sig) {
        return Ok(deny("canonical_approval_signature_invalid"));
    }
    // (4) Expiry — an approval MUST carry one (fail-closed) and must be in the future.
    let expires_at = match approval.expires_at {
        Some(e) => e,
        None => return Ok(deny("canonical_approval_expiration_required")),
    };
    if expires_at <= now_ms {
        return Ok(deny("canonical_approval_expired"));
    }

    // (5) Single-use: INSERT-as-grant. We reach here ONLY after every crypto/expiry
    // check passed, so a rejected approval never burns the key. The `use_key` PK turns
    // a replay into a uniqueness violation — double-spend is unrepresentable, not a
    // check-then-consume race.
    let use_key = format!(
        "{}:{}:{}:{}",
        approval.approval_id,
        approval.action_digest,
        CANONICAL_GATE_ISSUER,
        sig.to_ascii_lowercase()
    );
    let insert = conn.execute(
        "INSERT INTO consumed_approval (use_key, approval_id, action_digest, consumed_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            use_key,
            approval.approval_id,
            approval.action_digest,
            now_ms
        ],
    );
    match insert {
        Ok(_) => Ok(GateEvidenceRecord {
            decision: GateDecision::Allow,
            reason: "canonical_approval_granted".to_string(),
            risk,
            approval_required: true,
            denied_by: None,
        }),
        // PRIMARY KEY collision == this exact approval was already spent.
        Err(SqlErr::SqliteFailure(e, _)) if e.code == ErrorCode::ConstraintViolation => {
            Ok(deny("canonical_approval_replay_refused"))
        }
        Err(e) => Err(StorageError::from(e)),
    }
}
