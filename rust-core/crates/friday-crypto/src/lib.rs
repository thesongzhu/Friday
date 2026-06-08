//! Friday Rust Core — field/blob encryption, key wrapping, and the
//! OS-secure-storage adapter (gate 21 §3).
//!
//! Design:
//! - **AEAD**: XChaCha20-Poly1305 (24-byte random nonce, 256-bit key). Tamper
//!   is detectable because decryption authenticates the ciphertext + AAD.
//! - **Data keys** encrypt sensitive fields/blobs. A data key is itself sealed
//!   ("wrapped") under a key-encryption key (KEK). The KEK lives in OS secure
//!   storage (Keychain/Keystore), never on disk in plaintext.
//! - **Rotation** re-wraps a data key under a new KEK; the old KEK can no
//!   longer unwrap it.
//! - **`SecureStore`** abstracts OS secure storage. Real Keychain/Keystore
//!   backends are native and land with the mobile shells (Unit 5); this crate
//!   ships an in-memory implementation for Hub/dev/tests.
//!
//! Key types deliberately do **not** derive `Debug`, so key bytes cannot be
//! accidentally logged.

use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    Key, XChaCha20Poly1305, XNonce,
};
use std::collections::HashMap;
use thiserror::Error;
use zeroize::ZeroizeOnDrop;

pub mod approval;
pub mod ed25519_approval;
pub mod pairing;
pub mod session;
pub use approval::{action_digest, sign_approval, verify_approval_signature};
pub use ed25519_approval::{
    verify_ed25519_approval, verify_ed25519_approval_hex, ApprovalScheme, ApprovalSig,
    ApprovalSignature, Ed25519Error, OperatorSigningKey, OperatorVerifyingKey,
};
pub use pairing::{pairing_proof, verify_pairing_proof};
pub use session::DeviceKeypair;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const DATA_KEY_WRAP_AAD: &[u8] = b"friday-data-key-wrap-v1";

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CryptoError {
    #[error("encryption failed")]
    Seal,
    #[error("decryption/authentication failed")]
    Open,
    #[error("nonce has wrong length (expected {NONCE_LEN})")]
    BadNonce,
    #[error("unwrapped key has wrong length (expected {KEY_LEN})")]
    BadKey,
}

/// A 256-bit data key used to encrypt sensitive fields/blobs.
#[derive(Clone, PartialEq, Eq, ZeroizeOnDrop)]
pub struct DataKey([u8; KEY_LEN]);

impl DataKey {
    /// Generate a fresh random data key from the OS CSPRNG.
    pub fn generate() -> DataKey {
        let k = XChaCha20Poly1305::generate_key(&mut OsRng);
        let mut bytes = [0u8; KEY_LEN];
        bytes.copy_from_slice(k.as_slice());
        DataKey(bytes)
    }

    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> DataKey {
        DataKey(bytes)
    }
}

/// A key-encryption key (held in OS secure storage). Wraps data keys.
#[derive(Clone, PartialEq, Eq, ZeroizeOnDrop)]
pub struct Kek([u8; KEY_LEN]);

impl Kek {
    pub fn generate() -> Kek {
        let k = XChaCha20Poly1305::generate_key(&mut OsRng);
        let mut bytes = [0u8; KEY_LEN];
        bytes.copy_from_slice(k.as_slice());
        Kek(bytes)
    }

    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Kek {
        Kek(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

/// Ciphertext + the random nonce it was sealed with. Carries no key material.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sealed {
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

/// Encrypt `plaintext` under `key`, authenticating `aad`. A fresh random nonce
/// is generated per call (so identical plaintexts produce different output).
pub fn seal(key: &DataKey, plaintext: &[u8], aad: &[u8]) -> Result<Sealed, CryptoError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.0));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Seal)?;
    Ok(Sealed {
        nonce: nonce.to_vec(),
        ciphertext,
    })
}

/// Decrypt + authenticate. Returns `Open` on any tamper (wrong key, flipped
/// byte, mismatched AAD, truncated tag).
pub fn open(key: &DataKey, sealed: &Sealed, aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if sealed.nonce.len() != NONCE_LEN {
        return Err(CryptoError::BadNonce);
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.0));
    let nonce = XNonce::from_slice(&sealed.nonce);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &sealed.ciphertext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Open)
}

/// Seal a data key under a KEK ("wrap").
pub fn wrap_data_key(kek: &Kek, dk: &DataKey) -> Result<Sealed, CryptoError> {
    seal(&DataKey(kek.0), &dk.0, DATA_KEY_WRAP_AAD)
}

/// Recover a data key from its wrapped form using the KEK ("unwrap").
pub fn unwrap_data_key(kek: &Kek, wrapped: &Sealed) -> Result<DataKey, CryptoError> {
    let bytes = open(&DataKey(kek.0), wrapped, DATA_KEY_WRAP_AAD)?;
    if bytes.len() != KEY_LEN {
        return Err(CryptoError::BadKey);
    }
    let mut b = [0u8; KEY_LEN];
    b.copy_from_slice(&bytes);
    Ok(DataKey(b))
}

/// Rotate: unwrap with the old KEK, re-wrap under the new KEK. After this the
/// old KEK can no longer unwrap the returned blob.
pub fn rotate_data_key(old: &Kek, new: &Kek, wrapped: &Sealed) -> Result<Sealed, CryptoError> {
    let dk = unwrap_data_key(old, wrapped)?;
    wrap_data_key(new, &dk)
}

/// OS secure storage (Keychain on iOS/macOS, Keystore on Android). Holds KEKs
/// and the Friday pairing credential — never SQLite (gate 21 §3).
pub trait SecureStore {
    fn get(&self, id: &str) -> Option<Vec<u8>>;
    fn put(&mut self, id: &str, bytes: &[u8]);
    fn delete(&mut self, id: &str);
}

/// In-memory `SecureStore` for Hub/dev/tests. Native backends land in Unit 5.
#[derive(Default)]
pub struct InMemorySecureStore {
    map: HashMap<String, Vec<u8>>,
}

impl InMemorySecureStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecureStore for InMemorySecureStore {
    fn get(&self, id: &str) -> Option<Vec<u8>> {
        self.map.get(id).cloned()
    }
    fn put(&mut self, id: &str, bytes: &[u8]) {
        self.map.insert(id.to_string(), bytes.to_vec());
    }
    fn delete(&mut self, id: &str) {
        self.map.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let key = DataKey::generate();
        let pt = b"ask-friday prompt payload (sensitive)";
        let aad = b"blob:abc";
        let sealed = seal(&key, pt, aad).unwrap();
        let out = open(&key, &sealed, aad).unwrap();
        assert_eq!(out, pt);
    }

    #[test]
    fn tamper_is_detected() {
        let key = DataKey::generate();
        let mut sealed = seal(&key, b"secret", b"").unwrap();
        sealed.ciphertext[0] ^= 0x01; // flip one bit
        assert_eq!(open(&key, &sealed, b""), Err(CryptoError::Open));
    }

    #[test]
    fn wrong_key_fails() {
        let k1 = DataKey::generate();
        let k2 = DataKey::generate();
        let sealed = seal(&k1, b"secret", b"").unwrap();
        assert_eq!(open(&k2, &sealed, b""), Err(CryptoError::Open));
    }

    #[test]
    fn aad_mismatch_fails() {
        let key = DataKey::generate();
        let sealed = seal(&key, b"secret", b"context-A").unwrap();
        assert_eq!(open(&key, &sealed, b"context-B"), Err(CryptoError::Open));
    }

    #[test]
    fn nonce_is_unique_per_seal() {
        let key = DataKey::generate();
        let a = seal(&key, b"same plaintext", b"").unwrap();
        let b = seal(&key, b"same plaintext", b"").unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn bad_nonce_length_rejected() {
        let key = DataKey::generate();
        let sealed = Sealed {
            nonce: vec![0u8; 12], // wrong length for XChaCha
            ciphertext: vec![0u8; 16],
        };
        assert_eq!(open(&key, &sealed, b""), Err(CryptoError::BadNonce));
    }

    #[test]
    fn wrap_unwrap_round_trip() {
        let kek = Kek::generate();
        let dk = DataKey::generate();
        let wrapped = wrap_data_key(&kek, &dk).unwrap();
        let recovered = unwrap_data_key(&kek, &wrapped).unwrap();
        assert!(recovered == dk);
    }

    #[test]
    fn rotation_invalidates_old_kek() {
        let old = Kek::generate();
        let new = Kek::generate();
        let dk = DataKey::generate();

        let wrapped_old = wrap_data_key(&old, &dk).unwrap();
        let wrapped_new = rotate_data_key(&old, &new, &wrapped_old).unwrap();

        // New KEK recovers the same data key...
        assert!(unwrap_data_key(&new, &wrapped_new).unwrap() == dk);
        // ...and the old KEK can no longer unwrap the rotated blob.
        // (DataKey has no Debug impl by design, so match instead of assert_eq.)
        assert!(matches!(
            unwrap_data_key(&old, &wrapped_new),
            Err(CryptoError::Open)
        ));
    }

    #[test]
    fn secure_store_basic() {
        let mut s = InMemorySecureStore::new();
        assert_eq!(s.get("pairing"), None);
        s.put("pairing", b"pairing-credential-bytes");
        assert_eq!(
            s.get("pairing").as_deref(),
            Some(&b"pairing-credential-bytes"[..])
        );
        s.delete("pairing");
        assert_eq!(s.get("pairing"), None);
    }
}
