//! Authenticated pairing proof (`09` §2, gate `21` §4.2).
//!
//! One-time QR pairing delivers a `qr_secret` out of band (Hub screen -> phone
//! camera). The phone proves possession of that secret AND binds it to its
//! device public key by sending `pairing_proof = HMAC-SHA256(qr_secret,
//! device_pubkey)`. The Hub recomputes and verifies in constant time.
//!
//! This is what prevents an active MITM relay from substituting its own public
//! key: without the out-of-band `qr_secret` it cannot forge a proof over its key,
//! so the Hub rejects it. (This discharges the active-MITM property that the E2E
//! session module — `session.rs` — deferred to pairing.)

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// `HMAC-SHA256(qr_secret, device_pubkey)` — the phone's proof of possession,
/// bound to its public key.
pub fn pairing_proof(qr_secret: &[u8], device_pubkey: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(qr_secret).expect("HMAC accepts any key length");
    mac.update(device_pubkey);
    mac.finalize().into_bytes().to_vec()
}

/// Verify a pairing proof in constant time. `false` for a wrong secret, a
/// substituted pubkey, or a tampered proof.
pub fn verify_pairing_proof(qr_secret: &[u8], device_pubkey: &[u8], proof: &[u8]) -> bool {
    let mut mac = HmacSha256::new_from_slice(qr_secret).expect("HMAC accepts any key length");
    mac.update(device_pubkey);
    mac.verify_slice(proof).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_proof_verifies() {
        let secret = b"qr-one-time-secret";
        let pubkey = [9u8; 32];
        let proof = pairing_proof(secret, &pubkey);
        assert!(verify_pairing_proof(secret, &pubkey, &proof));
    }

    #[test]
    fn wrong_secret_rejected() {
        let pubkey = [9u8; 32];
        let proof = pairing_proof(b"the-real-secret", &pubkey);
        assert!(!verify_pairing_proof(
            b"a-different-secret",
            &pubkey,
            &proof
        ));
    }

    #[test]
    fn substituted_pubkey_rejected() {
        // MITM: a relay keeps the proof but swaps in its OWN pubkey -> rejected.
        let secret = b"qr-one-time-secret";
        let proof = pairing_proof(secret, &[9u8; 32]);
        let attacker_pubkey = [7u8; 32];
        assert!(!verify_pairing_proof(secret, &attacker_pubkey, &proof));
    }

    #[test]
    fn tampered_proof_rejected() {
        let secret = b"qr-one-time-secret";
        let pubkey = [9u8; 32];
        let mut proof = pairing_proof(secret, &pubkey);
        proof[0] ^= 0x01;
        assert!(!verify_pairing_proof(secret, &pubkey, &proof));
    }
}
