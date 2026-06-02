//! Encrypted blob store (gate 21 §2.1 / §3).
//!
//! `blob_index` holds metadata + access policy + nonce only; ciphertext bytes
//! live in `blob_store`. Plaintext is sealed with a `friday-crypto` data key,
//! using the `blob_id` as AEAD associated data so a ciphertext cannot be moved
//! to a different id without detection.

use crate::error::Result;
use friday_crypto::{DataKey, Sealed};
use rusqlite::Connection;

pub const ENC_ALG: &str = "XChaCha20Poly1305";

/// Encrypt `plaintext` and store its ciphertext + index row atomically.
pub fn store_blob(
    conn: &mut Connection,
    blob_id: &str,
    kind: &str,
    access_policy: &str,
    key: &DataKey,
    plaintext: &[u8],
    created_at: i64,
) -> Result<()> {
    let sealed = friday_crypto::seal(key, plaintext, blob_id.as_bytes())?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO blob_index
            (blob_id, kind, enc_alg, nonce, size, access_policy, created_at, path_or_ref)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            blob_id,
            kind,
            ENC_ALG,
            sealed.nonce,
            plaintext.len() as i64,
            access_policy,
            created_at,
            blob_id
        ],
    )?;
    tx.execute(
        "INSERT INTO blob_store (blob_id, ciphertext) VALUES (?1, ?2)",
        rusqlite::params![blob_id, sealed.ciphertext],
    )?;
    tx.commit()?;
    Ok(())
}

/// Load + decrypt a blob by id.
pub fn load_blob(conn: &Connection, blob_id: &str, key: &DataKey) -> Result<Vec<u8>> {
    let nonce: Vec<u8> = conn.query_row(
        "SELECT nonce FROM blob_index WHERE blob_id = ?1",
        [blob_id],
        |r| r.get(0),
    )?;
    let ciphertext: Vec<u8> = conn.query_row(
        "SELECT ciphertext FROM blob_store WHERE blob_id = ?1",
        [blob_id],
        |r| r.get(0),
    )?;
    let sealed = Sealed { nonce, ciphertext };
    Ok(friday_crypto::open(key, &sealed, blob_id.as_bytes())?)
}
