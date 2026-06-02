//! Canonical-approval crypto (PR-3b of the agent-loop cluster, file 39 §2 group A):
//! the SHA-256 **action digest** an approval binds to, plus an HMAC-SHA256 approval
//! **signature** with constant-time verification. Mirrors `pairing.rs`'s HMAC +
//! `verify_slice` (constant-time) pattern.
//!
//! No `friday-core` dependency: these operate on caller-provided canonical byte
//! strings (`friday-core::gate::canonical_action_bytes` /
//! `canonical_approval_signature_bytes` build them), keeping the crypto layer free
//! of domain types and the digest/HMAC out of pure `friday-core`.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

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

/// Decode exactly 64 hex chars (a 32-byte SHA-256/HMAC output). `None` for any other
/// length or a non-hex char — so a malformed signature fails closed before the compare.
fn from_hex_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        let hi = hex_val(b[2 * i])?;
        let lo = hex_val(b[2 * i + 1])?;
        *slot = (hi << 4) | lo;
    }
    Some(out)
}

/// Lowercase-hex SHA-256 of a request's canonical action bytes — the digest an
/// approval is bound to (a different action → different bytes → different digest).
pub fn action_digest(canonical_action_bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(canonical_action_bytes);
    to_hex(&h.finalize())
}

/// Lowercase-hex HMAC-SHA256 over an approval's canonical signature bytes, keyed by
/// the gate's signing secret.
pub fn sign_approval(signature_bytes: &[u8], secret: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(signature_bytes);
    to_hex(&mac.finalize().into_bytes())
}

/// Constant-time verify of a hex HMAC approval signature. Returns `false` for a
/// non-64-hex signature, a wrong secret, or tampered bytes. Fails closed.
pub fn verify_approval_signature(
    signature_bytes: &[u8],
    secret: &[u8],
    signature_hex: &str,
) -> bool {
    let raw = match from_hex_32(signature_hex) {
        Some(r) => r,
        None => return false,
    };
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(signature_bytes);
    mac.verify_slice(&raw).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_digest_is_deterministic_and_distinguishing() {
        assert_eq!(action_digest(b"abc"), action_digest(b"abc"));
        assert_ne!(action_digest(b"abc"), action_digest(b"abd"));
        assert_eq!(action_digest(b"abc").len(), 64); // 32-byte hex
        assert!(action_digest(b"abc").bytes().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        let payload = b"approval-canonical-bytes";
        let secret = b"gate-signing-secret";
        let sig = sign_approval(payload, secret);
        assert_eq!(sig.len(), 64);
        assert!(verify_approval_signature(payload, secret, &sig));
        // Uppercase hex still verifies (normalized on decode).
        assert!(verify_approval_signature(
            payload,
            secret,
            &sig.to_uppercase()
        ));
    }

    #[test]
    fn wrong_secret_rejected() {
        let payload = b"approval-canonical-bytes";
        let sig = sign_approval(payload, b"the-real-secret");
        assert!(!verify_approval_signature(
            payload,
            b"a-different-secret",
            &sig
        ));
    }

    #[test]
    fn tampered_payload_rejected() {
        let secret = b"gate-signing-secret";
        let sig = sign_approval(b"original-payload", secret);
        assert!(!verify_approval_signature(
            b"tampered-payload",
            secret,
            &sig
        ));
    }

    #[test]
    fn malformed_signature_fails_closed() {
        let payload = b"p";
        let secret = b"s";
        assert!(!verify_approval_signature(payload, secret, "")); // empty
        assert!(!verify_approval_signature(payload, secret, "abcd")); // too short
        assert!(!verify_approval_signature(payload, secret, &"z".repeat(64))); // non-hex
        assert!(!verify_approval_signature(payload, secret, &"a".repeat(63))); // 63 chars
        assert!(!verify_approval_signature(payload, secret, &"a".repeat(65))); // 65 chars
    }
}
