//! Friday operator-signing CLI — library half (slice S6c of the asymmetric
//! approval spine).
//!
//! Truth label: this is the OFFLINE OPERATOR side. It holds the operator's PRIVATE
//! Ed25519 signing key (loaded from a file the operator keeps OUTSIDE the Hub) and
//! produces an operator-signed `CanonicalApproval`. The HUB holds ONLY the matching
//! PUBLIC verify key (S6b verify-only policy), so the Hub — where the agent runs —
//! can VERIFY an approval but can NEVER MINT one. This is the cryptographic half of
//! the operator's hard rule "the agent must never self-approve."
//!
//! Scope: this crate adds the keygen + sign tool ONLY. It does NOT wire into the
//! live gate/resume (that is S6d), does NOT edit `friday-core::gate` or
//! `friday-storage` (S6b owns them), and does NOT decide key CUSTODY (who generates
//! / holds the operator key for the S6e proof — a Directive-0d operator gate). It
//! merely loads a key from a path and signs. No network. PROOF-ONLY; NOT v1 GO.
//!
//! ## The crypto contract (why the Hub will accept what this emits)
//!
//! The signed bytes are produced by exactly ONE path —
//! [`canonical_bytes`] — which builds a `friday_core::gate::CanonicalApproval` and
//! calls the REAL `friday_core::gate::canonical_approval_signature_bytes`. Because
//! sign-time and verify-time both go through that same gate function, the bytes the
//! Hub recomputes are byte-identical to what this crate signed — divergence is
//! impossible by construction. The signature is then produced with S6a's
//! [`friday_crypto::OperatorSigningKey::sign`] and verifies with
//! [`friday_crypto::verify_ed25519_approval`].
//!
//! Principal / action / surface / resource / parameters are bound TRANSITIVELY
//! through `action_digest` (the gate hashes them into it). This CLI therefore takes
//! the `action_digest` the Hub already computed (carried in S6b's pending request)
//! rather than recomputing it — the operator signs the digest the Hub will compare
//! against. The human-readable context fields are echoed for operator review and
//! are explicitly NOT part of the signature.

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use friday_core::gate::{
    canonical_approval_signature_bytes, ApprovalDecision, CanonicalApproval, CANONICAL_GATE_ISSUER,
};
use friday_crypto::ed25519_approval::{SEED_LEN, VERIFYING_KEY_LEN};
use friday_crypto::OperatorSigningKey;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroize;

/// The asymmetric scheme tag carried in emitted approvals (mirrors S6a's
/// `ApprovalScheme::Ed25519`).
pub const SCHEME_ED25519: &str = "ed25519";

/// Failures are fail-closed and never echo key material. Error messages are
/// deliberately generic about the key file so a malformed file's bytes (which
/// contain the secret seed) are never logged.
#[derive(Debug, Error)]
pub enum CliError {
    #[error("operator key file already exists; refusing to overwrite (delete it first to re-key)")]
    KeyFileExists,
    #[error("could not write operator key file")]
    WriteKeyFile,
    #[error("could not read operator key file")]
    ReadKeyFile,
    #[error("invalid operator key file: expected a 64-char hex Ed25519 seed (32 bytes)")]
    BadKeyFile,
    #[error("invalid request: {0}")]
    BadRequest(String),
    #[error("invalid decision {0:?}: expected \"approved\" or \"denied\"")]
    BadDecision(String),
    #[error("invalid action_digest: expected 64 lowercase hex chars (a SHA-256 digest)")]
    BadActionDigest,
}

/// The pending-request the operator signs. Shaped to match what S6b persists when a
/// mutating action Pauses (the fields needed to reconstruct the approval's canonical
/// bytes), plus optional human-readable context for operator review. Unknown fields
/// are tolerated so a richer S6b pending-request can be fed in unchanged.
#[derive(Debug, Clone, Deserialize)]
pub struct PendingRequest {
    /// Single-use nonce — the gate's `approval_id` / replay key.
    pub approval_id: String,
    /// Hex SHA-256 of the live request's canonical action bytes, as the Hub computed
    /// it. Principal/action/surface/resource/parameters are bound TRANSITIVELY here.
    pub action_digest: String,
    /// Epoch ms after which the approval is expired. Required — the gate rejects an
    /// approval with no expiry (fail-closed).
    pub expires_at: i64,
    /// Operator's decision: `"approved"` or `"denied"`.
    pub decision: String,
    /// Issuer string; defaults to the canonical gate issuer when omitted.
    #[serde(default)]
    pub issuer: Option<String>,

    // ---- context-only (operator review); NOT part of the signature ----
    /// Principal the action runs as (review only — bound via `action_digest`).
    #[serde(default)]
    pub principal: Option<String>,
    /// Action verb (review only — bound via `action_digest`).
    #[serde(default)]
    pub action: Option<String>,
    /// Surface (review only — bound via `action_digest`).
    #[serde(default)]
    pub surface: Option<String>,
}

/// The operator-signed approval emitted to stdout. JSON the Hub-side S6d ingestion
/// will parse; the `signature` is an Ed25519 signature (hex) over [`canonical_bytes`].
/// The PUBLIC verify key is deliberately NOT carried here — the Hub MUST verify
/// against its own provisioned key (from `keygen`), never one supplied alongside the
/// signature.
#[derive(Debug, Clone, Serialize)]
pub struct SignedApproval {
    /// Always `"ed25519"` (operator-signed / Hub-verify-only).
    pub scheme: String,
    /// `"approved"` or `"denied"` (normalized).
    pub decision: String,
    pub approval_id: String,
    pub action_digest: String,
    pub expires_at: i64,
    pub issuer: String,
    /// Hex Ed25519 signature (64 bytes -> 128 hex chars) over the canonical bytes.
    pub signature: String,
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(b.len() / 2);
    let mut i = 0;
    while i < b.len() {
        let hi = hex_val(b[i])?;
        let lo = hex_val(b[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Some(out)
}

/// Parse the operator decision string into the gate enum. Fail-closed: only the two
/// exact spellings are accepted.
pub fn parse_decision(s: &str) -> Result<ApprovalDecision, CliError> {
    match s {
        "approved" => Ok(ApprovalDecision::Approved),
        "denied" => Ok(ApprovalDecision::Denied),
        other => Err(CliError::BadDecision(other.to_string())),
    }
}

fn decision_str(d: ApprovalDecision) -> &'static str {
    match d {
        ApprovalDecision::Approved => "approved",
        ApprovalDecision::Denied => "denied",
    }
}

fn validate_action_digest(s: &str) -> Result<(), CliError> {
    // The Hub's digest is lowercase 64-hex SHA-256 (friday_crypto::action_digest).
    // We must sign the EXACT form the Hub compares against, so require lowercase.
    let ok = s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
    if ok {
        Ok(())
    } else {
        Err(CliError::BadActionDigest)
    }
}

/// The single shared path that produces the bytes a signature covers. Builds a
/// `CanonicalApproval` (with `signature: None` — the gate function does not read it)
/// and calls the REAL gate serializer, so these are byte-identical to what the Hub
/// recomputes at verify time.
pub fn canonical_bytes(
    decision: ApprovalDecision,
    approval_id: &str,
    action_digest: &str,
    expires_at: i64,
    issuer: &str,
) -> Vec<u8> {
    let approval = CanonicalApproval {
        decision,
        approval_id: approval_id.to_string(),
        action_digest: action_digest.to_string(),
        expires_at: Some(expires_at),
        issuer: Some(issuer.to_string()),
        signature: None,
    };
    canonical_approval_signature_bytes(&approval)
}

/// Write the operator's PRIVATE seed (hex) to `path`, created fresh with `0o600`
/// perms. `create_new` both refuses to clobber an existing key and guarantees the
/// restrictive mode is applied at creation (no umask race, no chmod-after-write
/// window). The seed/hex buffers are zeroized after the write.
fn write_private_seed(path: &Path, seed: &[u8; SEED_LEN]) -> Result<(), CliError> {
    let mut hex = to_hex(seed);
    hex.push('\n');
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    CliError::KeyFileExists
                } else {
                    CliError::WriteKeyFile
                }
            })?;
        f.write_all(hex.as_bytes())
            .map_err(|_| CliError::WriteKeyFile)?;
        f.flush().map_err(|_| CliError::WriteKeyFile)
    })();
    hex.zeroize();
    result
}

/// Load the operator's PRIVATE signing key from `path`. Transient secret buffers
/// (file contents, decoded bytes, seed array) are zeroized before returning. The
/// error path NEVER includes the file's bytes.
fn read_signing_key(path: &Path) -> Result<OperatorSigningKey, CliError> {
    let mut contents = fs::read_to_string(path).map_err(|_| CliError::ReadKeyFile)?;
    let mut bytes = match from_hex(contents.trim()) {
        Some(b) => b,
        None => {
            contents.zeroize();
            return Err(CliError::BadKeyFile);
        }
    };
    let result = match <[u8; SEED_LEN]>::try_from(bytes.as_slice()) {
        Ok(mut seed) => {
            let sk = OperatorSigningKey::from_seed_bytes(&seed);
            seed.zeroize();
            Ok(sk)
        }
        Err(_) => Err(CliError::BadKeyFile),
    };
    bytes.zeroize();
    contents.zeroize();
    result
}

/// keygen: generate an operator keypair, persist the PRIVATE seed to `key_path`
/// (`0o600`), and RETURN the PUBLIC verifying key as hex (the only half handed to
/// the Hub). The private key is never returned, printed, or logged.
pub fn keygen_to_path(key_path: &Path) -> Result<String, CliError> {
    let sk = OperatorSigningKey::generate();
    let vk_hex = to_hex(&sk.verifying_key().to_bytes());
    let mut seed = sk.to_seed_bytes();
    let result = write_private_seed(key_path, &seed);
    seed.zeroize();
    result.map(|()| vk_hex)
}

/// sign: validate the pending request, load the PRIVATE key from `key_path`,
/// reconstruct the canonical bytes, Ed25519-sign them, and return the signed
/// approval. Fail-closed on every malformed input; never panics; never leaks the key.
pub fn sign_request(key_path: &Path, req: &PendingRequest) -> Result<SignedApproval, CliError> {
    let decision = parse_decision(&req.decision)?;
    if req.approval_id.trim().is_empty() {
        return Err(CliError::BadRequest(
            "approval_id must not be empty".to_string(),
        ));
    }
    validate_action_digest(&req.action_digest)?;
    if req.expires_at <= 0 {
        return Err(CliError::BadRequest(
            "expires_at must be a positive epoch-ms".to_string(),
        ));
    }
    let issuer = req
        .issuer
        .clone()
        .unwrap_or_else(|| CANONICAL_GATE_ISSUER.to_string());
    if issuer.trim().is_empty() {
        return Err(CliError::BadRequest("issuer must not be empty".to_string()));
    }

    let sk = read_signing_key(key_path)?;
    let bytes = canonical_bytes(
        decision,
        &req.approval_id,
        &req.action_digest,
        req.expires_at,
        &issuer,
    );
    let sig = sk.sign(&bytes);

    Ok(SignedApproval {
        scheme: SCHEME_ED25519.to_string(),
        decision: decision_str(decision).to_string(),
        approval_id: req.approval_id.clone(),
        action_digest: req.action_digest.clone(),
        expires_at: req.expires_at,
        issuer,
        signature: to_hex(&sig.to_bytes()),
    })
}

/// Decode a `VERIFYING_KEY_LEN`-byte hex verifying key emitted by `keygen` (used by
/// callers/tests that verify an emitted approval). `None` on any malformed input.
pub fn decode_verifying_key_hex(hex: &str) -> Option<[u8; VERIFYING_KEY_LEN]> {
    let bytes = from_hex(hex.trim())?;
    <[u8; VERIFYING_KEY_LEN]>::try_from(bytes.as_slice()).ok()
}

/// Decode a 64-byte hex signature emitted in [`SignedApproval::signature`].
pub fn decode_signature_hex(hex: &str) -> Option<Vec<u8>> {
    from_hex(hex.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_crypto::verify_ed25519_approval;

    fn sample_request() -> PendingRequest {
        PendingRequest {
            approval_id: "ap-nonce-001".to_string(),
            // 64 lowercase hex chars
            action_digest: "a".repeat(64),
            expires_at: 1_900_000_000_000,
            decision: "approved".to_string(),
            issuer: None,
            principal: Some("owner:alice".to_string()),
            action: Some("fs.delete".to_string()),
            surface: Some("desktop".to_string()),
        }
    }

    #[test]
    fn keygen_then_sign_verifies() {
        let dir = std::env::temp_dir().join(format!("op-cli-unit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("operator.key");
        let _ = std::fs::remove_file(&key_path);

        let vk_hex = keygen_to_path(&key_path).unwrap();
        let req = sample_request();
        let signed = sign_request(&key_path, &req).unwrap();

        let decision = parse_decision(&signed.decision).unwrap();
        let bytes = canonical_bytes(
            decision,
            &signed.approval_id,
            &signed.action_digest,
            signed.expires_at,
            &signed.issuer,
        );
        let vk = decode_verifying_key_hex(&vk_hex).unwrap();
        let sig = decode_signature_hex(&signed.signature).unwrap();
        assert!(
            verify_ed25519_approval(&bytes, &vk, &sig),
            "operator-signed approval must verify under the keygen public key"
        );
        // Default issuer is the canonical gate issuer.
        assert_eq!(signed.issuer, CANONICAL_GATE_ISSUER);
        std::fs::remove_file(&key_path).ok();
    }

    #[test]
    fn keygen_refuses_to_overwrite() {
        let dir = std::env::temp_dir().join(format!("op-cli-unit-ow-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("operator.key");
        let _ = std::fs::remove_file(&key_path);
        keygen_to_path(&key_path).unwrap();
        let err = keygen_to_path(&key_path).unwrap_err();
        assert!(matches!(err, CliError::KeyFileExists));
        std::fs::remove_file(&key_path).ok();
    }

    #[test]
    fn bad_key_file_is_a_clean_error() {
        let dir = std::env::temp_dir().join(format!("op-cli-unit-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("garbage.key");
        std::fs::write(&key_path, b"not-a-valid-hex-seed").unwrap();
        let err = sign_request(&key_path, &sample_request()).unwrap_err();
        assert!(matches!(err, CliError::BadKeyFile));
        std::fs::remove_file(&key_path).ok();
    }

    #[test]
    fn malformed_fields_fail_closed() {
        assert!(parse_decision("maybe").is_err());
        assert!(validate_action_digest(&"A".repeat(64)).is_err()); // uppercase rejected
        assert!(validate_action_digest("abc").is_err()); // wrong length
        assert!(validate_action_digest(&"g".repeat(64)).is_err()); // non-hex
    }
}
