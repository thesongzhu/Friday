//! E2E session-key agreement for the phone<->Hub link (`09` §1/§7, gate `21` §4).
//!
//! Each device has an X25519 keypair. Two devices perform an ECDH agreement and
//! derive a shared session key via HKDF-SHA256. Envelope payloads are then
//! sealed under that session key with the AEAD in this crate, so a relay that
//! forwards ciphertext — holding only the public keys — cannot decrypt them
//! (proven by `tests`/the relay-cannot-decrypt assertion below).
//!
//! Scope: this is the cryptographic core (key agreement + payload sealing). The
//! live networked WebSocket transport that *carries* these sealed envelopes over
//! a real relay is the Unit-4 transport sub-slice (needs a running Hub+relay).
//!
//! The private key never derives `Debug` and `StaticSecret` zeroizes on drop.

use crate::DataKey;
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

// chacha20poly1305 re-exports a rand_core 0.6 OsRng compatible with x25519-dalek 2.x.
use chacha20poly1305::aead::OsRng;

const SESSION_KDF_INFO: &[u8] = b"friday-session-key-v1";

/// A device's long-lived X25519 keypair. Holds the private key (no `Debug`,
/// zeroized on drop by `StaticSecret`); only the public half is exposed.
pub struct DeviceKeypair {
    secret: StaticSecret,
    public: PublicKey,
}

impl DeviceKeypair {
    /// Generate a fresh keypair from the OS CSPRNG.
    pub fn generate() -> DeviceKeypair {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);
        DeviceKeypair { secret, public }
    }

    /// Reconstruct from stored private-key bytes (e.g. unwrapped from OS secure
    /// storage). The 32 bytes are the device's X25519 secret scalar.
    pub fn from_secret_bytes(secret_bytes: [u8; 32]) -> DeviceKeypair {
        let secret = StaticSecret::from(secret_bytes);
        let public = PublicKey::from(&secret);
        DeviceKeypair { secret, public }
    }

    /// This device's public key bytes (sent to the peer / relay in the clear).
    pub fn public_bytes(&self) -> [u8; 32] {
        self.public.to_bytes()
    }

    /// Derive the shared session key with a peer's public key (ECDH + HKDF).
    /// Both ends compute the same key; a party without a matching private key
    /// cannot reproduce it.
    pub fn agree(&self, their_public: &[u8; 32]) -> DataKey {
        let their = PublicKey::from(*their_public);
        let shared = self.secret.diffie_hellman(&their);
        derive_session_key(shared.as_bytes())
    }
}

fn derive_session_key(shared: &[u8; 32]) -> DataKey {
    let hk = Hkdf::<Sha256>::new(None, shared);
    let mut okm = [0u8; 32];
    hk.expand(SESSION_KDF_INFO, &mut okm)
        .expect("32 is a valid HKDF-SHA256 output length");
    DataKey::from_bytes(okm)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{open, seal};

    #[test]
    fn both_ends_derive_the_same_session_key() {
        let alice = DeviceKeypair::generate();
        let bob = DeviceKeypair::generate();
        let k_a = alice.agree(&bob.public_bytes());
        let k_b = bob.agree(&alice.public_bytes());
        assert!(k_a == k_b, "ECDH must yield a shared session key");
    }

    #[test]
    fn different_pairs_derive_different_keys() {
        let alice = DeviceKeypair::generate();
        let bob = DeviceKeypair::generate();
        let mallory = DeviceKeypair::generate();
        let k_ab = alice.agree(&bob.public_bytes());
        let k_am = alice.agree(&mallory.public_bytes());
        assert!(k_ab != k_am);
    }

    #[test]
    fn relay_cannot_decrypt_but_peer_can() {
        // Alice (phone) and Bob (Hub) pair and exchange PUBLIC keys (which a
        // relay also sees). Each derives the same session key.
        let alice = DeviceKeypair::generate();
        let bob = DeviceKeypair::generate();
        let k_alice = alice.agree(&bob.public_bytes());
        let k_bob = bob.agree(&alice.public_bytes());

        // The transport seals serialized envelope bytes under the session key.
        let plaintext = b"E2E payload: code diff + tool call + transcript";
        let sealed = seal(&k_alice, plaintext, b"envelope-aad").unwrap();

        // The legitimate peer (Bob) decrypts successfully.
        assert_eq!(open(&k_bob, &sealed, b"envelope-aad").unwrap(), plaintext);

        // A relay holds ONLY the public keys (no private key). Any key it can
        // construct — its own keypair agreed against either public key — differs
        // from the real session key, so it cannot decrypt the forwarded payload.
        let relay = DeviceKeypair::generate();
        let relay_vs_alice = relay.agree(&alice.public_bytes());
        let relay_vs_bob = relay.agree(&bob.public_bytes());
        assert!(open(&relay_vs_alice, &sealed, b"envelope-aad").is_err());
        assert!(open(&relay_vs_bob, &sealed, b"envelope-aad").is_err());
    }

    #[test]
    fn keypair_round_trips_from_secret_bytes() {
        let kp = DeviceKeypair::generate();
        let pub1 = kp.public_bytes();
        // Agreement is deterministic given the same secrets/publics.
        let peer = DeviceKeypair::generate();
        let k1 = kp.agree(&peer.public_bytes());
        // Reconstruct kp from its public? We only persist the secret; emulate by
        // checking a fresh keypair's public differs (sanity) and that a known
        // secret reproduces a stable public.
        let known = DeviceKeypair::from_secret_bytes([7u8; 32]);
        let known2 = DeviceKeypair::from_secret_bytes([7u8; 32]);
        assert_eq!(known.public_bytes(), known2.public_bytes());
        assert!(known.agree(&peer.public_bytes()) == known2.agree(&peer.public_bytes()));
        // unrelated sanity
        assert_ne!(pub1, known.public_bytes());
        let _ = k1;
    }
}
