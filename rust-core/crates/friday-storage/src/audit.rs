//! Hash-chained, append-only audit ledger (gate 21 §2.1 / §2.3 / §8).
//!
//! Each row stores `entry_hash = SHA-256(prev_hash || canonical(row))`, where
//! `prev_hash` is the previous row's `entry_hash` (genesis = 32 zero bytes).
//! Any modification or deletion of a prior row breaks the recomputed chain, so
//! tampering is detectable by `verify_audit_chain`.
//!
//! Scope honesty: this guarantees **sequential** append integrity (the Hub
//! writes audit entries inside one transaction at a time in the foundation).
//! True multi-writer concurrency (WAL + multiple connections) is exercised by
//! the Hub runtime in Unit 4, not claimed here.

use crate::error::{Result, StorageError};
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

pub const GENESIS_PREV_HASH: [u8; 32] = [0u8; 32];

/// Length-prefixed, unambiguous encoding of the auditable fields. Length
/// prefixes prevent field-boundary ambiguity; the trailing tag distinguishes
/// `payload_ref = None` from `Some("")`.
fn canonical(
    audit_id: &str,
    actor: &str,
    action: &str,
    payload_ref: Option<&str>,
    created_at: i64,
) -> Vec<u8> {
    let mut buf = Vec::new();
    for field in [
        audit_id.as_bytes(),
        actor.as_bytes(),
        action.as_bytes(),
        payload_ref.unwrap_or("").as_bytes(),
    ] {
        buf.extend_from_slice(&(field.len() as u64).to_le_bytes());
        buf.extend_from_slice(field);
    }
    buf.extend_from_slice(&created_at.to_le_bytes());
    buf.push(u8::from(payload_ref.is_some()));
    buf
}

fn hash_entry(prev: &[u8; 32], canon: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(prev);
    h.update(canon);
    let out = h.finalize();
    let mut r = [0u8; 32];
    r.copy_from_slice(&out);
    r
}

fn last_hash(conn: &Connection) -> rusqlite::Result<[u8; 32]> {
    let row: Option<Vec<u8>> = conn
        .query_row(
            "SELECT entry_hash FROM audit_ledger ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match row {
        Some(v) if v.len() == 32 => {
            let mut a = [0u8; 32];
            a.copy_from_slice(&v);
            a
        }
        _ => GENESIS_PREV_HASH,
    })
}

/// Append one audit entry, extending the hash chain. Must be called within the
/// same transaction as any state change it records, so the read of the prior
/// hash and the insert are atomic (gate 21 §2.3).
pub fn append_audit(
    conn: &Connection,
    audit_id: &str,
    actor: &str,
    action: &str,
    payload_ref: Option<&str>,
    created_at: i64,
) -> rusqlite::Result<[u8; 32]> {
    let prev = last_hash(conn)?;
    let canon = canonical(audit_id, actor, action, payload_ref, created_at);
    let entry = hash_entry(&prev, &canon);
    conn.execute(
        "INSERT INTO audit_ledger
            (audit_id, prev_hash, entry_hash, actor, action, payload_ref, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            audit_id,
            &prev[..],
            &entry[..],
            actor,
            action,
            payload_ref,
            created_at
        ],
    )?;
    Ok(entry)
}

/// Recompute the chain from genesis and confirm every stored `prev_hash` and
/// `entry_hash` matches. Returns the number of verified rows, or
/// `AuditChainBroken(audit_id)` at the first inconsistency.
pub fn verify_audit_chain(conn: &Connection) -> Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT audit_id, prev_hash, entry_hash, actor, action, payload_ref, created_at
         FROM audit_ledger ORDER BY rowid ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, Vec<u8>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, i64>(6)?,
        ))
    })?;

    let mut prev = GENESIS_PREV_HASH;
    let mut count = 0usize;
    for row in rows {
        let (audit_id, prev_hash, entry_hash, actor, action, payload_ref, created_at) = row?;
        if prev_hash.as_slice() != prev.as_slice() {
            return Err(StorageError::AuditChainBroken(audit_id));
        }
        let canon = canonical(
            &audit_id,
            &actor,
            &action,
            payload_ref.as_deref(),
            created_at,
        );
        let expected = hash_entry(&prev, &canon);
        if entry_hash.as_slice() != expected.as_slice() {
            return Err(StorageError::AuditChainBroken(audit_id));
        }
        prev = expected;
        count += 1;
    }
    Ok(count)
}
