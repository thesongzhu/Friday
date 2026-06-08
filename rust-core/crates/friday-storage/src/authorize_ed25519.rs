//! Ed25519 **verify-only** mutating-action authorization (S6b). The asymmetric
//! counterpart to the symmetric HMAC [`crate::authorize::authorize_mutating_action`].
//!
//! ## The downgrade defense (the #1 S6b obligation)
//! `friday_core::gate::canonical_approval_signature_bytes` is byte-identical for the
//! HMAC and Ed25519 schemes — the scheme tag is NOT inside the signed bytes. The HMAC
//! scheme is symmetric (the Hub holds the same secret that verifies AND mints), so if a
//! protected/mutating action could be Allowed by an HMAC-signed approval, the Hub could
//! self-mint and the "the agent can never approve" guarantee collapses.
//!
//! This path closes that hole **structurally**, not by a runtime branch:
//! - it takes **NO HMAC secret** — there is no argument to consult, so no HMAC code
//!   path exists in this function;
//! - for the protected (`RequiresApproval`) branch it **ALWAYS** verifies the approval
//!   signature as Ed25519 under the operator's PUBLIC key
//!   ([`friday_crypto::verify_ed25519_approval_hex`]). It never reads a scheme field and
//!   never derives the scheme from an untrusted wire/storage value.
//!
//! An HMAC-signed approval over the SAME canonical bytes therefore cannot be accepted:
//! an HMAC hex (64 chars / 32 bytes) is not a 64-byte Ed25519 signature, and even a
//! correctly-sized attacker value is not a valid Ed25519 signature without the
//! operator's OFFLINE private key. The Hub holds only [`OperatorVerifyingKey`] — it can
//! verify but can never mint (S6a's type-level key separation).
//!
//! ## Scope (truth label)
//! S6b adds the verify-only policy + its single-use replay enforcement + adversarial
//! tests, and the pending-request persistence ([`crate::pending_request`]). It is NOT
//! wired into the live agent loop (the loop still calls the HMAC authorize behind the
//! default `DenyAllApprovals`, which grants nothing). Reaching this path from a live
//! resume entrypoint is S6d; the operator-signing CLI is S6c. The production default is
//! unchanged: every mutating action still Pauses. PROOF-ONLY; NOT v1 GO.

use crate::error::{Result, StorageError};
use friday_core::gate::{
    self, ApprovalDecision, CanonicalApproval, GateDecision, GateEvidenceRecord,
    MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use friday_crypto::OperatorVerifyingKey;
use rusqlite::{params, Connection, Error as SqlErr, ErrorCode};

/// A **verify-only** Ed25519 approval policy. It holds ONLY the operator's PUBLIC
/// verify key — no signing key, no HMAC secret — so it can VERIFY an operator-signed
/// approval but has no path to MINT one. This is the opt-in policy a protected/mutating
/// action is authorized against; the production default stays the Hub's
/// `DenyAllApprovals` (in `friday-hub`), which grants nothing.
pub struct Ed25519VerifyOnlyPolicy {
    operator_vk: OperatorVerifyingKey,
}

impl Ed25519VerifyOnlyPolicy {
    /// Construct from the operator's PUBLIC verify key (the only half the Hub holds).
    pub fn new(operator_vk: OperatorVerifyingKey) -> Self {
        Self { operator_vk }
    }

    /// Authorize a (possibly mutating) action against this verify-only policy. Delegates
    /// to [`authorize_mutating_action_ed25519`]; see that function for the full
    /// fail-closed contract and the downgrade defense.
    pub fn authorize(
        &self,
        conn: &Connection,
        request: &MutatingActionRequest,
        approval: Option<&CanonicalApproval>,
        now_ms: i64,
    ) -> Result<GateEvidenceRecord> {
        authorize_mutating_action_ed25519(conn, request, approval, &self.operator_vk, now_ms)
    }
}

/// Authorize a (possibly mutating) action with an **operator-signed Ed25519** approval,
/// verify-only. Takes NO HMAC secret — the protected path can only ever be satisfied by
/// an Ed25519 signature the operator produced OFFLINE with the private key matching
/// `operator_vk`.
///
/// Decision flow (fail-closed throughout):
/// - The pure base decision ([`gate::evaluate`]) is authoritative. A base `Allow`
///   (read-only / non-protected) or `Deny` (reserved-action / local-deny) is FINAL and
///   never consults an approval or the replay store — so the bound-principal rule (an
///   `Agent`/`Channel` can never self-approve) is intact, decided before any signature
///   is even examined.
/// - Only a base `RequiresApproval` (a PROTECTED / mutating / high-risk action) may be
///   upgraded to `Allow`, and ONLY by an approval that is: digest-bound to THIS exact
///   action (the digest transitively binds principal / scope / params / derived-risk),
///   owner-`Approved`, correctly-issued, **Ed25519-signature-valid under `operator_vk`**,
///   unexpired, and not previously spent.
/// - Single-use is keyed on the approval **nonce** (`approval_id`) alone, so the SAME
///   nonce re-signed with a different expiry/decision still collides on its second use
///   (a nonce Allows exactly once).
pub fn authorize_mutating_action_ed25519(
    conn: &Connection,
    request: &MutatingActionRequest,
    approval: Option<&CanonicalApproval>,
    operator_vk: &OperatorVerifyingKey,
    now_ms: i64,
) -> Result<GateEvidenceRecord> {
    // Pure base decision. Allow/Deny are final and never consult an approval or the
    // replay store; only RequiresApproval (a protected action) can be upgraded.
    let base = gate::evaluate(request);
    if base.decision != GateDecision::RequiresApproval {
        return Ok(base);
    }
    let approval = match approval {
        Some(a) => a,
        None => return Ok(base), // no approval presented -> stays RequiresApproval (Pause)
    };

    let risk = base.risk;
    let deny = |reason: &str| GateEvidenceRecord {
        decision: GateDecision::Deny,
        reason: reason.to_string(),
        risk,
        approval_required: true,
        denied_by: Some("canonical_gate".to_string()),
    };

    // (1) Digest binding: the approval must be for THIS exact action. The digest binds
    // principal / actor / surface / resource(scope) / mutating / derived-risk / params /
    // plan_digest / idempotency_key, so a same-verb-different-target/principal approval
    // yields a different digest and does not apply here.
    let digest = friday_crypto::action_digest(&gate::canonical_action_bytes(request));
    if approval.action_digest != digest {
        return Ok(deny("canonical_approval_digest_mismatch"));
    }
    // (2) Explicit owner denial.
    if approval.decision == ApprovalDecision::Denied {
        return Ok(deny("canonical_approval_denied"));
    }
    // (3) Issuer.
    if approval.issuer.as_deref() != Some(CANONICAL_GATE_ISSUER) {
        return Ok(deny("canonical_approval_bad_issuer"));
    }
    // (4) Ed25519 signature — REQUIRED. This is the downgrade defense: the signature is
    // ALWAYS interpreted as Ed25519 and verified under the operator's PUBLIC key. No HMAC
    // secret is in scope; an HMAC-signed approval (or any non-Ed25519 value) over the same
    // canonical bytes fails here. Missing signature fails closed.
    let sig = match &approval.signature {
        Some(s) => s,
        None => return Ok(deny("canonical_approval_signature_missing")),
    };
    let sig_bytes = gate::canonical_approval_signature_bytes(approval);
    if !friday_crypto::verify_ed25519_approval_hex(&sig_bytes, &operator_vk.to_bytes(), sig) {
        return Ok(deny("canonical_approval_signature_invalid"));
    }
    // (5) Expiry — an approval MUST carry one (fail-closed) and must be in the future.
    let expires_at = match approval.expires_at {
        Some(e) => e,
        None => return Ok(deny("canonical_approval_expiration_required")),
    };
    if expires_at <= now_ms {
        return Ok(deny("canonical_approval_expired"));
    }

    // (6) Single-use: INSERT-as-grant, keyed on the NONCE (`approval_id`) alone — a nonce
    // Allows exactly once. We deliberately do NOT key on the signature: keying on the sig
    // would let the SAME nonce, re-signed with a different `expires_at`, be spent twice.
    // The `ed25519:` prefix namespaces these keys away from the HMAC path's composite
    // `use_key`s in the shared table. We reach here ONLY after every crypto/expiry check
    // passed, so a rejected approval never burns the nonce. The PK turns a replay into a
    // uniqueness violation — double-spend is unrepresentable, not a check-then-consume race.
    let use_key = format!("ed25519:{}", approval.approval_id);
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
        // PRIMARY KEY collision == this nonce was already spent.
        Err(SqlErr::SqliteFailure(e, _)) if e.code == ErrorCode::ConstraintViolation => {
            Ok(deny("canonical_approval_replay_refused"))
        }
        Err(e) => Err(StorageError::from(e)),
    }
}
