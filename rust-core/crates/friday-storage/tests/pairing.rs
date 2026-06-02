//! Authenticated pairing / revoke / key-rotation tests (`09` §2/§7, gate `21`
//! §4.2). The MITM-rejection test discharges the active-MITM property that the
//! E2E session module defers to authenticated pairing.

mod common;

use common::temp_db_path;
use friday_crypto::pairing_proof;
use friday_storage::{audit, pairing, Db, StorageError};

#[test]
fn authenticated_pairing_records_trusted_device() {
    let p = temp_db_path("pair-ok");
    let mut db = Db::open_hub(&p).unwrap();
    let secret = b"qr-one-time-secret";
    let pubkey = [9u8; 32];
    let proof = pairing_proof(secret, &pubkey);

    pairing::pair_device(
        db.conn_mut(),
        secret,
        "dev-1",
        &pubkey,
        &proof,
        100,
        "au-pair-1",
    )
    .unwrap();
    assert!(pairing::is_trusted(db.conn(), "dev-1").unwrap());
    assert_eq!(db.count("trusted_device").unwrap(), 1);
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 1);
}

#[test]
fn mitm_substituted_pubkey_is_rejected() {
    // A relay forwards the (public) proof but swaps in its OWN device pubkey.
    // Without the out-of-band QR secret it cannot forge a matching proof, so the
    // Hub rejects it and trusts nothing.
    let p = temp_db_path("pair-mitm");
    let mut db = Db::open_hub(&p).unwrap();
    let secret = b"qr-one-time-secret";
    let proof_for_real_key = pairing_proof(secret, &[9u8; 32]);
    let attacker_pubkey = [7u8; 32];

    let res = pairing::pair_device(
        db.conn_mut(),
        secret,
        "dev-evil",
        &attacker_pubkey,
        &proof_for_real_key,
        100,
        "au-x",
    );
    assert!(matches!(res, Err(StorageError::PairingDenied(_))));
    assert_eq!(
        db.count("trusted_device").unwrap(),
        0,
        "nothing trusted on denied pairing"
    );
    assert_eq!(
        db.count("audit_ledger").unwrap(),
        0,
        "no audit entry on denied pairing"
    );
}

#[test]
fn wrong_secret_is_rejected() {
    let p = temp_db_path("pair-wrong-secret");
    let mut db = Db::open_hub(&p).unwrap();
    let pubkey = [9u8; 32];
    let proof = pairing_proof(b"the-real-secret", &pubkey);
    let res = pairing::pair_device(
        db.conn_mut(),
        b"a-guessed-secret",
        "dev-1",
        &pubkey,
        &proof,
        1,
        "au",
    );
    assert!(matches!(res, Err(StorageError::PairingDenied(_))));
}

#[test]
fn revoke_blocks_device_and_is_audited() {
    let p = temp_db_path("pair-revoke");
    let mut db = Db::open_hub(&p).unwrap();
    let secret = b"s";
    let pubkey = [1u8; 32];
    let proof = pairing_proof(secret, &pubkey);
    pairing::pair_device(
        db.conn_mut(),
        secret,
        "dev-1",
        &pubkey,
        &proof,
        1,
        "au-pair",
    )
    .unwrap();
    assert!(pairing::is_trusted(db.conn(), "dev-1").unwrap());

    pairing::revoke_device(db.conn_mut(), "dev-1", 2, "au-revoke").unwrap();
    assert!(!pairing::is_trusted(db.conn(), "dev-1").unwrap());

    // Cannot revoke twice.
    assert!(pairing::revoke_device(db.conn_mut(), "dev-1", 3, "au-revoke2").is_err());
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 2); // pair + revoke
}

#[test]
fn key_rotation_updates_pubkey_and_audits() {
    let p = temp_db_path("pair-rotate");
    let mut db = Db::open_hub(&p).unwrap();
    let secret = b"s";
    let k1 = [1u8; 32];
    let proof = pairing_proof(secret, &k1);
    pairing::pair_device(db.conn_mut(), secret, "dev-1", &k1, &proof, 1, "au-pair").unwrap();

    let k2 = [2u8; 32];
    pairing::rotate_device_key(db.conn_mut(), "dev-1", &k2, 5, "au-rot").unwrap();
    assert_eq!(
        pairing::device_pubkey(db.conn(), "dev-1").unwrap().unwrap(),
        k2.to_vec()
    );
    let rotated_at: Option<i64> = db
        .conn()
        .query_row(
            "SELECT key_rotated_at FROM trusted_device WHERE device_id = 'dev-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rotated_at, Some(5));
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 2); // pair + rotation

    // A revoked device cannot be rotated.
    pairing::revoke_device(db.conn_mut(), "dev-1", 6, "au-rev").unwrap();
    assert!(pairing::rotate_device_key(db.conn_mut(), "dev-1", &[3u8; 32], 7, "au-rot2").is_err());
}
