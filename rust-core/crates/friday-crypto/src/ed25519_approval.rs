//! Ed25519 **asymmetric** canonical-approval signatures (S6a).
//!
//! Today approvals use the symmetric HMAC path in [`crate::approval`]: the verify
//! key IS the mint key, so any process that can verify (the Hub, where the agent
//! runs) can also mint — the agent could structurally self-mint. This module adds
//! the ASYMMETRIC alternative:
//!
//! - the **OPERATOR** holds the Ed25519 PRIVATE signing key, OFF the Hub (an
//!   offline CLI signs approvals — that wiring is S6c), and
//! - the **HUB** holds ONLY the PUBLIC verify key.
//!
//! The Hub can therefore VERIFY an operator-signed approval but can NEVER MINT
//! one — the cryptographic foundation of the operator's hard rule "the agent must
//! NEVER self-approve." This is the missing half-property of the HMAC scheme.
//!
//! Domain-free, exactly like [`crate::approval`]: `sign`/`verify` operate on the
//! caller-provided canonical approval bytes — in production
//! `friday-core::gate::canonical_approval_signature_bytes(approval)`, the SAME
//! bytes the HMAC path covers, so nothing the HMAC path binds is left unbound
//! here. Those bytes bind (length-prefixed) the decision, `approval_id` (the
//! single-use nonce), the `action_digest` (= SHA-256 of `canonical_action_bytes`,
//! which itself binds principal / actor / surface / resource(scope) / mutating /
//! derived-risk / parameters / plan_digest / idempotency_key), the `expires_at`
//! (expiry), and the issuer. Principal and scope are bound TRANSITIVELY through
//! the action digest — the same property the HMAC path has.
//!
//! Scope (truth label): S6a adds the primitive + its verification + adversarial
//! tests ONLY. It does NOT wire into `friday-core::gate` (that is S6b), adds NO
//! ingestion entrypoint (S6d) and NO signing CLI (S6c). It is a STATELESS crypto
//! verify: it (correctly) accepts the same (bytes, signature) twice — replay
//! prevention is the gate's single-use `approval_id` store (S6b), which the signed
//! `approval_id` here is what ENABLES. PROOF-ONLY; NOT v1 GO.
//!
//! Key types deliberately do not derive `Debug`, mirroring the rest of the crate,
//! so secret bytes cannot be accidentally logged.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use thiserror::Error;

// `chacha20poly1305` re-exports a rand_core 0.6 `OsRng`, the same one
// `session.rs` uses for X25519 keygen; it is compatible with ed25519-dalek 2.x's
// `SigningKey::generate`. This is OS entropy (getrandom), not the JS sandbox RNG.
use chacha20poly1305::aead::OsRng;

/// Length of an Ed25519 secret seed (operator private key material).
pub const SEED_LEN: usize = ed25519_dalek::SECRET_KEY_LENGTH; // 32
/// Length of an Ed25519 public verify key.
pub const VERIFYING_KEY_LEN: usize = ed25519_dalek::PUBLIC_KEY_LENGTH; // 32
/// Length of an Ed25519 signature.
pub const SIGNATURE_LEN: usize = ed25519_dalek::SIGNATURE_LENGTH; // 64

/// Failure to parse externally-supplied Ed25519 key/signature bytes. Construction
/// fails closed; it never panics on malformed input.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum Ed25519Error {
    #[error("verifying-key bytes are not a valid Ed25519 public key")]
    BadVerifyingKey,
    #[error("signature bytes are not a valid Ed25519 signature")]
    BadSignature,
}

/// The OPERATOR's Ed25519 PRIVATE signing key. Held OFFLINE by the operator (the
/// S6c CLI), NEVER on the Hub. No `Debug` (key bytes cannot be logged); the inner
/// `SigningKey` zeroizes on drop (ed25519-dalek `zeroize` feature).
///
/// This is the ONLY type that can produce a signature. There is no path from an
/// [`OperatorVerifyingKey`] to this type, so holding only the verify key (as the
/// Hub does) structurally cannot mint an approval.
pub struct OperatorSigningKey(SigningKey);

impl OperatorSigningKey {
    /// Generate a fresh keypair from the OS CSPRNG (operator's machine).
    pub fn generate() -> Self {
        OperatorSigningKey(SigningKey::generate(&mut OsRng))
    }

    /// Reconstruct from a stored 32-byte secret seed (operator-side persistence,
    /// e.g. unsealed from the operator's secure storage). Infallible: any 32 bytes
    /// is a valid Ed25519 seed.
    pub fn from_seed_bytes(seed: &[u8; SEED_LEN]) -> Self {
        OperatorSigningKey(SigningKey::from_bytes(seed))
    }

    /// The 32-byte secret seed, for sealing into the OPERATOR's secure storage.
    /// (Operator side only — the Hub never holds a signing key and never calls this.)
    pub fn to_seed_bytes(&self) -> [u8; SEED_LEN] {
        self.0.to_bytes()
    }

    /// The matching PUBLIC verify key — the ONLY half handed to the Hub.
    pub fn verifying_key(&self) -> OperatorVerifyingKey {
        OperatorVerifyingKey(self.0.verifying_key())
    }

    /// OPERATOR side: sign an approval's canonical bytes. `canonical_bytes` MUST be
    /// `friday-core::gate::canonical_approval_signature_bytes(approval)` — the exact
    /// bytes the HMAC path covers — so every bound field is signed. Ed25519 hashes
    /// the message internally; the bytes are signed directly with no extra layer
    /// (identical to the HMAC path's raw-bytes input).
    pub fn sign(&self, canonical_bytes: &[u8]) -> ApprovalSig {
        ApprovalSig(self.0.sign(canonical_bytes))
    }
}

/// The OPERATOR's Ed25519 PUBLIC verify key. The Hub holds ONLY this.
///
/// Its API surface is deliberately minimal — `from_bytes` / `to_bytes` / `verify`
/// — with NO method that yields a secret seed, an [`OperatorSigningKey`], or a
/// signature. That minimal surface IS the structural "the Hub can verify but can
/// never mint" guarantee (it is a type-level property, not a runtime check).
#[derive(Clone)]
pub struct OperatorVerifyingKey(VerifyingKey);

impl OperatorVerifyingKey {
    /// Parse a 32-byte public key. Fails closed (`BadVerifyingKey`) for bytes that
    /// are not a valid Ed25519 point. Never panics.
    pub fn from_bytes(bytes: &[u8; VERIFYING_KEY_LEN]) -> Result<Self, Ed25519Error> {
        VerifyingKey::from_bytes(bytes)
            .map(OperatorVerifyingKey)
            .map_err(|_| Ed25519Error::BadVerifyingKey)
    }

    /// The 32-byte public key, e.g. to persist on the Hub.
    pub fn to_bytes(&self) -> [u8; VERIFYING_KEY_LEN] {
        self.0.to_bytes()
    }

    /// HUB side: verify `sig` over `canonical_bytes`. Uses `verify_strict`, which
    /// rejects non-canonical encodings and small-order / torsion points (stronger
    /// than the permissive `verify`). Verification is constant-time in the library.
    /// Returns `false` on any verification failure — fails closed, never panics.
    pub fn verify(&self, canonical_bytes: &[u8], sig: &ApprovalSig) -> bool {
        self.0.verify_strict(canonical_bytes, &sig.0).is_ok()
    }
}

/// An Ed25519 signature over an approval's canonical bytes. 64 bytes on the wire.
#[derive(Clone)]
pub struct ApprovalSig(Signature);

impl ApprovalSig {
    /// The 64 raw signature bytes (e.g. to store in `CanonicalApproval.signature`).
    pub fn to_bytes(&self) -> [u8; SIGNATURE_LEN] {
        self.0.to_bytes()
    }

    /// Construct from exactly 64 bytes. Infallible — any 64 bytes is a syntactic
    /// signature; semantic validity is decided by [`OperatorVerifyingKey::verify`].
    pub fn from_bytes(bytes: &[u8; SIGNATURE_LEN]) -> Self {
        ApprovalSig(Signature::from_bytes(bytes))
    }

    /// Parse from an arbitrary-length slice (e.g. wire / ingestion bytes). `None`
    /// for any length other than 64 — fails closed, never panics (this is what
    /// makes empty / truncated / over-long signatures a clean reject upstream).
    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        Signature::try_from(bytes).ok().map(ApprovalSig)
    }

    /// Lowercase hex of the 64 signature bytes (128 chars). The OPERATOR / S6c CLI
    /// uses this to carry an Ed25519 signature in the existing
    /// `CanonicalApproval.signature: Option<String>` field (same field the HMAC path
    /// uses, only a different encoding — 128 hex chars vs the HMAC path's 64). The
    /// gate's Ed25519 verify-only authorize path (S6b) decodes it with
    /// [`verify_ed25519_approval_hex`].
    pub fn to_hex(&self) -> String {
        hex_encode(&self.to_bytes())
    }
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_encode(bytes: &[u8]) -> String {
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

/// Decode an even-length hex string. `None` for an odd length or any non-hex char —
/// fails closed (never panics) so malformed wire/storage hex is a clean upstream reject.
fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(b.len() / 2);
    for pair in b.chunks_exact(2) {
        let hi = hex_val(pair[0])?;
        let lo = hex_val(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

/// HUB-side verify of an Ed25519 approval signature carried as a HEX STRING (the
/// encoding [`ApprovalSig::to_hex`] produces and the gate stores in
/// `CanonicalApproval.signature`). Returns `false` — never panics — for malformed
/// hex (odd length / non-hex), a hex string that does not decode to exactly 64
/// signature bytes (e.g. a 64-char **HMAC** hex decodes to 32 bytes ⇒ rejected), a
/// malformed verifying key, or a signature that does not verify under `vk`.
/// Internally `verify_strict`. Fails closed.
///
/// This is the SINGLE entry the Ed25519 verify-only gate path calls: it ALWAYS
/// interprets the signature as Ed25519 and verifies it under the operator's public
/// key — there is no scheme branch and no HMAC code path, so an HMAC-signed approval
/// over the same canonical bytes can never be accepted here.
pub fn verify_ed25519_approval_hex(
    canonical_bytes: &[u8],
    verifying_key_bytes: &[u8],
    signature_hex: &str,
) -> bool {
    match hex_decode(signature_hex) {
        Some(sig_bytes) => {
            verify_ed25519_approval(canonical_bytes, verifying_key_bytes, &sig_bytes)
        }
        None => false,
    }
}

/// HUB-side robust verify directly from raw bytes (e.g. an approval carried over
/// the wire / read from storage). Returns `false` — never panics — for a malformed
/// public key (wrong length / invalid point) or a malformed / empty / truncated /
/// over-long signature. Internally `verify_strict`. Fails closed.
pub fn verify_ed25519_approval(
    canonical_bytes: &[u8],
    verifying_key_bytes: &[u8],
    signature_bytes: &[u8],
) -> bool {
    let vk_arr: [u8; VERIFYING_KEY_LEN] = match verifying_key_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let vk = match OperatorVerifyingKey::from_bytes(&vk_arr) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let sig = match ApprovalSig::from_slice(signature_bytes) {
        Some(s) => s,
        None => return false,
    };
    vk.verify(canonical_bytes, &sig)
}

/// Which signature scheme bound a canonical approval.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalScheme {
    /// Symmetric HMAC-SHA256 ([`crate::approval`]): the verify key IS the mint key,
    /// so any process that can verify can also mint.
    Hmac,
    /// Asymmetric Ed25519 (this module): the operator holds the private mint key;
    /// the Hub holds ONLY the public verify key → the Hub cannot self-mint.
    Ed25519,
}

/// A canonical approval's signature, TAGGED by scheme. Verification requires the
/// key material matching the scheme, so an HMAC verify can never accept an Ed25519
/// signature and an Ed25519 verify can never accept an HMAC signature: the
/// mismatched-scheme call returns `false` without even consulting the key. This is
/// the type-safe variant the gate (S6b) will branch on; S6a only defines + verifies
/// it (it is NOT yet read by `friday-core::gate`).
#[derive(Clone)]
pub enum ApprovalSignature {
    /// Hex HMAC-SHA256 (the existing [`crate::approval`] representation).
    Hmac(String),
    /// Ed25519 signature.
    Ed25519(ApprovalSig),
}

impl ApprovalSignature {
    /// The scheme this signature was produced with.
    pub fn scheme(&self) -> ApprovalScheme {
        match self {
            ApprovalSignature::Hmac(_) => ApprovalScheme::Hmac,
            ApprovalSignature::Ed25519(_) => ApprovalScheme::Ed25519,
        }
    }

    /// Verify ONLY as HMAC, using the symmetric `secret`. An `Ed25519` variant
    /// returns `false` (no cross-scheme acceptance) without consulting `secret`.
    pub fn verify_hmac(&self, canonical_bytes: &[u8], secret: &[u8]) -> bool {
        match self {
            ApprovalSignature::Hmac(hex) => {
                crate::approval::verify_approval_signature(canonical_bytes, secret, hex)
            }
            ApprovalSignature::Ed25519(_) => false,
        }
    }

    /// Verify ONLY as Ed25519, using the operator's public verify key. An `Hmac`
    /// variant returns `false` (no cross-scheme acceptance): a symmetric secret can
    /// never satisfy the asymmetric path.
    pub fn verify_ed25519(&self, canonical_bytes: &[u8], vk: &OperatorVerifyingKey) -> bool {
        match self {
            ApprovalSignature::Ed25519(sig) => vk.verify(canonical_bytes, sig),
            ApprovalSignature::Hmac(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MSG: &[u8] = b"friday.canonical_approval.v1|approved|ap-1|<digest>|<expiry>";

    // ---- valid path -------------------------------------------------------

    #[test]
    fn valid_signature_verifies() {
        let sk = OperatorSigningKey::generate();
        let vk = sk.verifying_key();
        let sig = sk.sign(MSG);
        assert!(vk.verify(MSG, &sig), "matching key must accept");
        // Robust raw-bytes path agrees.
        assert!(verify_ed25519_approval(
            MSG,
            &vk.to_bytes(),
            &sig.to_bytes()
        ));
    }

    #[test]
    fn verifying_key_round_trips_through_bytes() {
        let sk = OperatorSigningKey::generate();
        let vk = sk.verifying_key();
        let vk2 = OperatorVerifyingKey::from_bytes(&vk.to_bytes()).unwrap();
        let sig = sk.sign(MSG);
        assert!(vk2.verify(MSG, &sig));
    }

    #[test]
    fn signing_key_round_trips_through_seed() {
        let sk = OperatorSigningKey::generate();
        let seed = sk.to_seed_bytes();
        let sk2 = OperatorSigningKey::from_seed_bytes(&seed);
        // Same seed → same public key → signatures from either verify under either.
        assert_eq!(
            sk.verifying_key().to_bytes(),
            sk2.verifying_key().to_bytes()
        );
        let sig = sk2.sign(MSG);
        assert!(sk.verifying_key().verify(MSG, &sig));
    }

    // ---- forgery ----------------------------------------------------------

    #[test]
    fn random_garbage_signature_rejected() {
        let vk = OperatorSigningKey::generate().verifying_key();
        // 64 arbitrary (attacker-chosen) bytes are not a valid signature.
        let garbage = [0xABu8; SIGNATURE_LEN];
        assert!(!verify_ed25519_approval(MSG, &vk.to_bytes(), &garbage));
        assert!(!vk.verify(MSG, &ApprovalSig::from_bytes(&garbage)));
    }

    #[test]
    fn signature_from_a_different_key_rejected() {
        let operator = OperatorSigningKey::generate();
        let attacker = OperatorSigningKey::generate();
        let sig = attacker.sign(MSG);
        // Verifying the attacker's signature under the OPERATOR's key fails.
        assert!(!operator.verifying_key().verify(MSG, &sig));
        // And the operator's own signature does not verify under the attacker's key.
        let real = operator.sign(MSG);
        assert!(!attacker.verifying_key().verify(MSG, &real));
    }

    // ---- tamper (bytes level; field-level tamper is the integration test) --

    #[test]
    fn any_flipped_message_byte_rejected() {
        let sk = OperatorSigningKey::generate();
        let vk = sk.verifying_key();
        let sig = sk.sign(MSG);
        for i in 0..MSG.len() {
            let mut tampered = MSG.to_vec();
            tampered[i] ^= 0x01;
            assert!(
                !vk.verify(&tampered, &sig),
                "flipping byte {i} of the signed message must reject"
            );
        }
    }

    // ---- malleability / malformed input (must not panic) ------------------

    #[test]
    fn empty_truncated_overlong_and_zero_signatures_rejected() {
        let vk = OperatorSigningKey::generate().verifying_key();
        let vkb = vk.to_bytes();
        assert!(!verify_ed25519_approval(MSG, &vkb, b"")); // empty
        assert!(!verify_ed25519_approval(MSG, &vkb, &[0u8; 32])); // truncated (too short)
        assert!(!verify_ed25519_approval(MSG, &vkb, &[0u8; 63])); // 63 bytes
        assert!(!verify_ed25519_approval(MSG, &vkb, &[0u8; 65])); // 65 bytes (over-long)
        assert!(!verify_ed25519_approval(MSG, &vkb, &[0u8; SIGNATURE_LEN])); // all-zero
                                                                             // from_slice also fails closed on the wrong length.
        assert!(ApprovalSig::from_slice(b"").is_none());
        assert!(ApprovalSig::from_slice(&[0u8; 63]).is_none());
        assert!(ApprovalSig::from_slice(&[0u8; 65]).is_none());
    }

    #[test]
    fn malformed_verifying_key_bytes_rejected() {
        let sig = OperatorSigningKey::generate().sign(MSG).to_bytes();
        assert!(!verify_ed25519_approval(MSG, b"", &sig)); // empty key
        assert!(!verify_ed25519_approval(MSG, &[0u8; 16], &sig)); // wrong length
        assert!(!verify_ed25519_approval(MSG, &[0u8; 33], &sig)); // wrong length
                                                                  // An all-zero 32-byte string IS a valid (low-order) Ed25519 point, so
                                                                  // from_bytes may succeed; verify_strict then rejects it for a real message.
        assert!(!verify_ed25519_approval(MSG, &[0u8; 32], &sig));
    }

    /// Beyond the task's literal "malformed" list: TRUE signature malleability.
    /// A valid signature is (R, S); replacing S with the non-canonical S + L (L =
    /// the curve group order) satisfies the PERMISSIVE verification equation but is
    /// a different 64-byte string. `verify_strict` rejects a non-canonical S, so the
    /// malleated signature must NOT verify. Constructed + asserted empirically.
    #[test]
    fn non_canonical_s_malleability_rejected_by_verify_strict() {
        // Little-endian encoding of L = 2^252 + 27742317777372353535851937790883648493.
        const L_LE: [u8; 32] = [
            0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9,
            0xde, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x10,
        ];
        let sk = OperatorSigningKey::generate();
        let vk = sk.verifying_key();
        let sig = sk.sign(MSG);
        let mut bytes = sig.to_bytes(); // [0..32]=R, [32..64]=S (LE)

        // S' = S + L over the low 32 bytes (S < L < 2^253, so S+L < 2^254 fits).
        let mut carry = 0u16;
        for i in 0..32 {
            let sum = bytes[32 + i] as u16 + L_LE[i] as u16 + carry;
            bytes[32 + i] = (sum & 0xff) as u8;
            carry = sum >> 8;
        }

        let malleated = ApprovalSig::from_bytes(&bytes);
        // The mutated signature is a distinct byte string...
        assert_ne!(bytes, sig.to_bytes());
        // ...and verify_strict rejects the non-canonical S.
        assert!(
            !vk.verify(MSG, &malleated),
            "verify_strict must reject a non-canonical (S + L) signature"
        );
    }

    // ---- key separation (structural; this is a NEGATIVE test) -------------

    /// NEGATIVE test (the real guarantee is STRUCTURAL — see the type docs):
    /// `OperatorVerifyingKey`'s API exposes only {from_bytes, to_bytes, verify}, so
    /// there is no code path from the Hub's public key to a signing key or a
    /// signature. We cannot runtime-prove the absence of a mint path; we can show
    /// that anything an attacker derives from ONLY the public key (here: the public
    /// key bytes themselves, used as a candidate signature/seed) cannot mint.
    #[test]
    fn holding_only_the_verify_key_cannot_mint() {
        let vk = OperatorSigningKey::generate().verifying_key();
        let vkb = vk.to_bytes();

        // Attacker has only vk bytes. Candidate "signatures" derived from them:
        let mut padded = [0u8; SIGNATURE_LEN];
        padded[..32].copy_from_slice(&vkb); // pubkey || zeros
        assert!(!verify_ed25519_approval(MSG, &vkb, &padded));
        let doubled = {
            let mut b = [0u8; SIGNATURE_LEN];
            b[..32].copy_from_slice(&vkb);
            b[32..].copy_from_slice(&vkb); // pubkey || pubkey
            b
        };
        assert!(!verify_ed25519_approval(MSG, &vkb, &doubled));

        // And re-deriving a SIGNING key from a fresh seed yields an UNRELATED public
        // key — i.e. the attacker cannot reconstruct the operator's signer to forge.
        let unrelated = OperatorSigningKey::generate();
        assert_ne!(unrelated.verifying_key().to_bytes(), vkb);
        assert!(!vk.verify(MSG, &unrelated.sign(MSG)));
    }

    // ---- scheme separation (HMAC vs Ed25519 cannot be confused) -----------

    #[test]
    fn scheme_tag_is_reported() {
        let sig = OperatorSigningKey::generate().sign(MSG);
        assert_eq!(
            ApprovalSignature::Ed25519(sig).scheme(),
            ApprovalScheme::Ed25519
        );
        assert_eq!(
            ApprovalSignature::Hmac("deadbeef".into()).scheme(),
            ApprovalScheme::Hmac
        );
    }

    #[test]
    fn ed25519_signature_is_not_accepted_by_hmac_verify() {
        let sk = OperatorSigningKey::generate();
        let sig = sk.sign(MSG);
        let tagged = ApprovalSignature::Ed25519(sig);
        // Even with any HMAC secret, the Ed25519-tagged signature fails the HMAC verify.
        assert!(!tagged.verify_hmac(MSG, b"any-hmac-secret"));
        assert!(!tagged.verify_hmac(MSG, b""));
    }

    #[test]
    fn hmac_signature_is_not_accepted_by_ed25519_verify() {
        let secret = b"gate-signing-secret";
        let hmac_hex = crate::approval::sign_approval(MSG, secret);
        let tagged = ApprovalSignature::Hmac(hmac_hex);
        let vk = OperatorSigningKey::generate().verifying_key();
        // The HMAC-tagged signature fails the Ed25519 verify under any public key.
        assert!(!tagged.verify_ed25519(MSG, &vk));
    }

    // ---- hex carrier (S6b: signature stored as hex in CanonicalApproval.signature) ----

    #[test]
    fn hex_carrier_round_trips_and_verifies() {
        let sk = OperatorSigningKey::generate();
        let vk = sk.verifying_key();
        let sig = sk.sign(MSG);
        let hex = sig.to_hex();
        assert_eq!(hex.len(), SIGNATURE_LEN * 2); // 128 hex chars
        assert!(hex.bytes().all(|c| c.is_ascii_hexdigit()));
        // The hex carrier verifies under the matching key...
        assert!(verify_ed25519_approval_hex(MSG, &vk.to_bytes(), &hex));
        // ...and uppercase hex is accepted (decoded case-insensitively).
        assert!(verify_ed25519_approval_hex(
            MSG,
            &vk.to_bytes(),
            &hex.to_uppercase()
        ));
        // A flipped message byte fails.
        let mut tampered = MSG.to_vec();
        tampered[0] ^= 0x01;
        assert!(!verify_ed25519_approval_hex(
            &tampered,
            &vk.to_bytes(),
            &hex
        ));
    }

    #[test]
    fn hex_carrier_rejects_hmac_length_and_malformed_hex() {
        let vk = OperatorSigningKey::generate().verifying_key();
        let vkb = vk.to_bytes();
        // An HMAC hex is 64 chars (32 bytes) — NOT a 64-byte Ed25519 sig ⇒ rejected.
        assert!(!verify_ed25519_approval_hex(MSG, &vkb, &"a".repeat(64)));
        // Malformed hex: empty, odd-length, non-hex, over/under-long — all fail closed.
        assert!(!verify_ed25519_approval_hex(MSG, &vkb, ""));
        assert!(!verify_ed25519_approval_hex(MSG, &vkb, "abc")); // odd length
        assert!(!verify_ed25519_approval_hex(MSG, &vkb, &"z".repeat(128))); // non-hex
        assert!(!verify_ed25519_approval_hex(MSG, &vkb, &"a".repeat(126))); // 63 bytes
        assert!(!verify_ed25519_approval_hex(MSG, &vkb, &"a".repeat(130))); // 65 bytes
    }

    #[test]
    fn correctly_tagged_signatures_verify_under_their_own_scheme() {
        // Ed25519 tag + Ed25519 key → accept.
        let sk = OperatorSigningKey::generate();
        let vk = sk.verifying_key();
        let ed = ApprovalSignature::Ed25519(sk.sign(MSG));
        assert!(ed.verify_ed25519(MSG, &vk));
        assert!(!ed.verify_hmac(MSG, b"secret"));

        // HMAC tag + HMAC secret → accept.
        let secret = b"gate-signing-secret";
        let hm = ApprovalSignature::Hmac(crate::approval::sign_approval(MSG, secret));
        assert!(hm.verify_hmac(MSG, secret));
        assert!(!hm.verify_ed25519(MSG, &vk));
    }
}
