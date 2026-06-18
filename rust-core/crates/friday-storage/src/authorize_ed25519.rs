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
    self, ApprovalDecision, CanonicalApproval, CanonicalApprovalBatch, GateDecision,
    GateEvidenceRecord, MutatingActionRequest, Reversibility, CANONICAL_GATE_ISSUER,
};
use friday_crypto::OperatorVerifyingKey;
use rusqlite::{params, Connection, Error as SqlErr, ErrorCode};
use std::path::{Component, Path, PathBuf};

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

/// Authorize one action against an operator-signed batch. This is verify-only and dark:
/// callers must opt in explicitly, and the Hub still receives only the public verify key.
pub fn authorize_mutating_action_ed25519_batch(
    conn: &Connection,
    request: &MutatingActionRequest,
    batch: Option<&CanonicalApprovalBatch>,
    operator_vk: &OperatorVerifyingKey,
    now_ms: i64,
) -> Result<GateEvidenceRecord> {
    let base = gate::evaluate(request);
    if base.decision != GateDecision::RequiresApproval {
        return Ok(base);
    }
    if request.reversibility() == Reversibility::Irreversible {
        return Ok(GateEvidenceRecord {
            decision: GateDecision::RequiresApproval,
            reason: "canonical_batch_irreversible_requires_single_approval".to_string(),
            risk: base.risk,
            approval_required: true,
            denied_by: Some("canonical_gate".to_string()),
        });
    }
    let batch = match batch {
        Some(b) => b,
        None => return Ok(base),
    };
    let deny = |reason: &str| GateEvidenceRecord {
        decision: GateDecision::Deny,
        reason: reason.to_string(),
        risk: base.risk,
        approval_required: true,
        denied_by: Some("canonical_gate".to_string()),
    };

    let digest = friday_crypto::action_digest(&gate::canonical_action_bytes(request));
    if !is_valid_digest_hex(&digest) {
        return Ok(deny("canonical_batch_action_digest_invalid"));
    }
    if batch.batch_sign_id.trim().is_empty() {
        return Ok(deny("canonical_batch_id_required"));
    }
    if batch.action_digests.is_empty() {
        return Ok(deny("canonical_batch_empty"));
    }
    if batch.action_digests.iter().any(|d| !is_valid_digest_hex(d)) {
        return Ok(deny("canonical_batch_member_digest_invalid"));
    }
    if !batch.action_digests.iter().any(|d| d == &digest) {
        return Ok(deny("canonical_batch_digest_not_member"));
    }
    if batch.decision == ApprovalDecision::Denied {
        return Ok(deny("canonical_batch_denied"));
    }
    if batch.issuer.as_deref() != Some(CANONICAL_GATE_ISSUER) {
        return Ok(deny("canonical_batch_bad_issuer"));
    }
    let sig = match &batch.signature {
        Some(s) => s,
        None => return Ok(deny("canonical_batch_signature_missing")),
    };
    let sig_bytes = gate::canonical_approval_batch_signature_bytes(batch);
    if !friday_crypto::verify_ed25519_approval_hex(&sig_bytes, &operator_vk.to_bytes(), sig) {
        return Ok(deny("canonical_batch_signature_invalid"));
    }
    let expires_at = match batch.expires_at {
        Some(e) => e,
        None => return Ok(deny("canonical_batch_expiration_required")),
    };
    if expires_at <= now_ms {
        return Ok(deny("canonical_batch_expired"));
    }

    let use_key = format!("ed25519-batch:{}:{}", batch.batch_sign_id, digest);
    let insert = conn.execute(
        "INSERT INTO consumed_approval (use_key, approval_id, action_digest, consumed_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![use_key, batch.batch_sign_id, digest, now_ms],
    );
    match insert {
        Ok(_) => Ok(GateEvidenceRecord {
            decision: GateDecision::Allow,
            reason: "canonical_batch_approval_granted".to_string(),
            risk: base.risk,
            approval_required: true,
            denied_by: None,
        }),
        Err(SqlErr::SqliteFailure(e, _)) if e.code == ErrorCode::ConstraintViolation => {
            Ok(deny("canonical_batch_replay_refused"))
        }
        Err(e) => Err(StorageError::from(e)),
    }
}

fn is_valid_digest_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// DARK D20 W2-S4 driver scope for reversible batch auto-run.
///
/// This does not execute tools. It is the verify-only pre-dispatch guard that proves
/// a signed batch member is confined to the git/worktree space where "reversible"
/// actually means "operator can inspect/revert with git/worktree mechanics". The Hub
/// still verifies only; it never mints the operator signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DialWorktreeScope {
    pub plan_sign_id: String,
    pub active_worktree: PathBuf,
}

/// Authorize one batch member only if its classified resource path is inside the
/// active worktree and not in an explicitly never-revertable space (`~/.friday`,
/// launchd plist, or Friday state DB files). On success, writes a hash-chain audit
/// row in the same transaction as the batch replay consume.
pub fn authorize_reversible_batch_in_worktree(
    conn: &mut Connection,
    request: &MutatingActionRequest,
    batch: Option<&CanonicalApprovalBatch>,
    operator_vk: &OperatorVerifyingKey,
    now_ms: i64,
    scope: &DialWorktreeScope,
) -> Result<GateEvidenceRecord> {
    let tx = conn.unchecked_transaction()?;
    let preflight = worktree_revertable_preflight(request, batch, scope);
    if let Some(reason) = preflight {
        return Ok(GateEvidenceRecord {
            decision: GateDecision::RequiresApproval,
            reason: reason.to_string(),
            risk: gate::evaluate(request).risk,
            approval_required: true,
            denied_by: Some("canonical_gate".to_string()),
        });
    }

    let evidence =
        authorize_mutating_action_ed25519_batch(&tx, request, batch, operator_vk, now_ms)?;
    if evidence.decision == GateDecision::Allow {
        let digest = friday_crypto::action_digest(&gate::canonical_action_bytes(request));
        let audit_id = format!("dial.batch.worktree:{}:{}", scope.plan_sign_id, digest);
        let worktree_ref = dial_worktree_ref(&scope.active_worktree);
        let payload_ref = format!(
            "dial://batch/{}/worktree/{}/action/{}",
            scope.plan_sign_id, worktree_ref, digest
        );
        crate::audit::append_audit(
            &tx,
            &audit_id,
            "friday",
            "dial.batch.worktree_authorized",
            Some(&payload_ref),
            now_ms,
        )?;
    }
    tx.commit()?;
    Ok(evidence)
}

fn worktree_revertable_preflight(
    request: &MutatingActionRequest,
    batch: Option<&CanonicalApprovalBatch>,
    scope: &DialWorktreeScope,
) -> Option<&'static str> {
    if request.reversibility() == Reversibility::Irreversible {
        return Some("dial_worktree_irreversible_requires_single_approval");
    }
    let batch = batch?;
    if batch.batch_sign_id != scope.plan_sign_id {
        return Some("dial_worktree_plan_sign_id_mismatch");
    }
    let resource_path = request.resource()?.id.as_deref()?;
    let real_worktree = match std::fs::canonicalize(&scope.active_worktree) {
        Ok(p) => p,
        Err(_) => return Some("dial_worktree_active_root_unavailable"),
    };
    let real_target = match canonicalize_existing_parent(&real_worktree, resource_path) {
        Ok(p) => p,
        Err(reason) => return Some(reason),
    };
    if is_never_revertable_path(&real_target) {
        return Some("dial_worktree_never_revertable_path");
    }
    if !real_target.starts_with(&real_worktree) {
        return Some("dial_worktree_resource_out_of_scope");
    }
    None
}

fn dial_worktree_ref(active_worktree: &Path) -> String {
    let canonical = std::fs::canonicalize(active_worktree)
        .unwrap_or_else(|_| active_worktree.to_path_buf())
        .to_string_lossy()
        .into_owned();
    friday_crypto::action_digest(canonical.as_bytes())
}

fn canonicalize_existing_parent(
    worktree: &Path,
    path: &str,
) -> std::result::Result<PathBuf, &'static str> {
    let supplied = expand_home(path);
    let candidate = if supplied.is_absolute() {
        supplied
    } else {
        worktree.join(supplied)
    };
    if has_parent_traversal(&candidate) {
        return Err("dial_worktree_resource_path_invalid");
    }
    if let Ok(real) = std::fs::canonicalize(&candidate) {
        return Ok(real);
    }
    let Some(name) = candidate.file_name() else {
        return Err("dial_worktree_resource_path_invalid");
    };
    let Some(parent) = candidate.parent() else {
        return Err("dial_worktree_resource_path_invalid");
    };
    let real_parent =
        std::fs::canonicalize(parent).map_err(|_| "dial_worktree_resource_parent_unavailable")?;
    Ok(real_parent.join(name))
}

fn has_parent_traversal(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(path))
    } else if let Some(rest) = path.strip_prefix("~/") {
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(rest))
            .unwrap_or_else(|| PathBuf::from(path))
    } else {
        PathBuf::from(path)
    }
}

fn is_never_revertable_path(path: &Path) -> bool {
    if std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".friday"))
        .is_some_and(|friday_home| path.starts_with(friday_home))
    {
        return true;
    }
    if path
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|name| {
            matches!(name, "friday.db" | "rust-hub.sqlite") || name.ends_with(".plist")
        })
    {
        return true;
    }
    false
}
