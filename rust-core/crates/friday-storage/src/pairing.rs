//! Trusted-device pairing, revoke, and key rotation (`09` §2/§7, gate `21` §2.1/§4.2).
//!
//! Pairing is **authenticated**: a `Pair` is accepted only if its proof is a
//! valid `HMAC(qr_secret, device_pubkey)` (`friday-crypto`), so a relay that
//! substitutes its own key without the out-of-band QR secret is rejected — this
//! is what closes the active-MITM gap the E2E session module defers to pairing.
//!
//! Every pairing writes `device_identity` + `trusted_device` and every pair /
//! revoke / rotation writes an `audit_ledger` entry atomically with the trust
//! change. Hub-only (trusted_device is Hub-only).

use crate::audit;
use crate::error::{Result, StorageError};
use friday_core::{DeviceRole, TrustedDeviceProjection};
use friday_crypto::verify_pairing_proof;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

/// Complete a QR pairing handshake. Verifies the proof binds `device_pubkey` to
/// the out-of-band `qr_secret`; on success records the device identity, trusted
/// device, and audit entry; on failure returns `PairingDenied` and writes
/// nothing.
#[allow(clippy::too_many_arguments)]
pub fn pair_device(
    conn: &mut Connection,
    qr_secret: &[u8],
    device_id: &str,
    device_role: DeviceRole,
    display_name: &str,
    device_pubkey: &[u8],
    proof: &[u8],
    paired_at: i64,
    audit_id: &str,
) -> Result<()> {
    if !verify_pairing_proof(qr_secret, device_pubkey, proof) {
        return Err(StorageError::PairingDenied(device_id.to_string()));
    }
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO device_identity
            (device_id, role, public_key, created_at, display_name)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            device_id,
            device_role.as_str(),
            device_pubkey,
            paired_at,
            display_name
        ],
    )?;
    tx.execute(
        "INSERT INTO trusted_device
            (device_id, public_key, paired_at, revoked_at, key_rotated_at, sealed_key_ref, label)
         VALUES (?1, ?2, ?3, NULL, NULL, NULL, '')",
        params![device_id, device_pubkey, paired_at],
    )?;
    audit::append_audit(
        &tx,
        audit_id,
        "operator",
        "pairing",
        Some(device_id),
        paired_at,
    )?;
    tx.commit()?;
    Ok(())
}

/// True iff the device has a trusted row that has not been revoked.
pub fn is_trusted(conn: &Connection, device_id: &str) -> Result<bool> {
    let revoked_at: Option<Option<i64>> = conn
        .query_row(
            "SELECT revoked_at FROM trusted_device WHERE device_id = ?1",
            [device_id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .optional()?;
    Ok(matches!(revoked_at, Some(None)))
}

/// The device's current trusted public key, if any (for rotation checks).
pub fn device_pubkey(conn: &Connection, device_id: &str) -> Result<Option<Vec<u8>>> {
    Ok(conn
        .query_row(
            "SELECT public_key FROM trusted_device WHERE device_id = ?1",
            [device_id],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .optional()?)
}

/// Redacted trusted-device projection for setup/trust UI. It surfaces trust
/// state and a public-key fingerprint, never the raw public key or pairing
/// secret.
pub fn list_trusted_device_projections(conn: &Connection) -> Result<Vec<TrustedDeviceProjection>> {
    let mut stmt = conn.prepare(
        "SELECT device_id, label, paired_at, revoked_at, key_rotated_at, public_key
         FROM trusted_device
         ORDER BY paired_at DESC, device_id",
    )?;
    let rows = stmt.query_map([], |r| {
        let public_key: Vec<u8> = r.get(5)?;
        Ok(TrustedDeviceProjection {
            device_id: r.get(0)?,
            label: r.get(1)?,
            paired_at: r.get(2)?,
            revoked_at: r.get(3)?,
            key_rotated_at: r.get(4)?,
            pubkey_fingerprint: pubkey_fingerprint(&public_key),
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Revoke a trusted device (sets `revoked_at`). A revoked device is no longer
/// trusted and cannot be revoked twice.
pub fn revoke_device(
    conn: &mut Connection,
    device_id: &str,
    revoked_at: i64,
    audit_id: &str,
) -> Result<()> {
    let tx = conn.transaction()?;
    let n = tx.execute(
        "UPDATE trusted_device SET revoked_at = ?1 WHERE device_id = ?2 AND revoked_at IS NULL",
        params![revoked_at, device_id],
    )?;
    if n == 0 {
        return Err(StorageError::Unsupported(format!(
            "device '{device_id}' is not trusted or already revoked"
        )));
    }
    audit::append_audit(
        &tx,
        audit_id,
        "operator",
        "revoke",
        Some(device_id),
        revoked_at,
    )?;
    tx.commit()?;
    Ok(())
}

/// Rotate a trusted device's public key (records `key_rotated_at`). Only valid
/// for a non-revoked device.
pub fn rotate_device_key(
    conn: &mut Connection,
    device_id: &str,
    new_pubkey: &[u8],
    rotated_at: i64,
    audit_id: &str,
) -> Result<()> {
    let tx = conn.transaction()?;
    let n = tx.execute(
        "UPDATE trusted_device SET public_key = ?1, key_rotated_at = ?2
         WHERE device_id = ?3 AND revoked_at IS NULL",
        params![new_pubkey, rotated_at, device_id],
    )?;
    if n == 0 {
        return Err(StorageError::Unsupported(format!(
            "device '{device_id}' is not trusted (cannot rotate)"
        )));
    }
    audit::append_audit(
        &tx,
        audit_id,
        "operator",
        "key_rotation",
        Some(device_id),
        rotated_at,
    )?;
    tx.commit()?;
    Ok(())
}

fn pubkey_fingerprint(public_key: &[u8]) -> String {
    let digest = Sha256::digest(public_key);
    let mut out = String::with_capacity(23);
    for (idx, byte) in digest.iter().take(8).enumerate() {
        if idx > 0 {
            out.push(':');
        }
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
