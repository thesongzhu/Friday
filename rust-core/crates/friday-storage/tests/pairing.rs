//! Authenticated pairing / revoke / key-rotation tests (`09` §2/§7, gate `21`
//! §4.2). The MITM-rejection test discharges the active-MITM property that the
//! E2E session module defers to authenticated pairing.

mod common;

use common::temp_db_path;
use friday_core::{
    DeviceRole, FridayPairPayload, PairAuthority, PairTransportHint, PairTransportKind,
    CURRENT_PAIR_PAYLOAD_VERSION,
};
use friday_crypto::pairing_proof;
use friday_storage::{audit, pairing, Db, StorageError};

fn sample_payload(expires_at: i64) -> FridayPairPayload {
    FridayPairPayload::new(
        CURRENT_PAIR_PAYLOAD_VERSION,
        "hub-mac-mini",
        "pair-1",
        "friday-pairing-secret-32-bytes",
        "Jarvis Mac mini",
        vec![PairTransportHint::new(
            PairTransportKind::LanWebSocket,
            "ws://192.168.1.8:4477",
            "LAN WebSocket",
        )
        .unwrap()],
        expires_at,
        vec![PairAuthority::StatusOnly, PairAuthority::Approvals],
    )
    .unwrap()
}

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
        DeviceRole::Ios,
        "Jarvis iPhone",
        &pubkey,
        &proof,
        100,
        "au-pair-1",
    )
    .unwrap();
    assert!(pairing::is_trusted(db.conn(), "dev-1").unwrap());
    assert_eq!(db.count("device_identity").unwrap(), 1);
    assert_eq!(db.count("trusted_device").unwrap(), 1);
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 1);
}

#[test]
fn complete_qr_pairing_uses_payload_secret_and_records_redacted_projection() {
    let p = temp_db_path("pair-payload-ok");
    let mut db = Db::open_hub(&p).unwrap();
    let payload = sample_payload(200);
    let pubkey = [9u8; 32];
    let proof = pairing_proof(payload.pairing_secret.expose_for_qr().as_bytes(), &pubkey);

    db.complete_qr_pairing(&payload, "dev-1", &pubkey, &proof, 100, "au-pair-payload")
        .unwrap();

    assert!(pairing::is_trusted(db.conn(), "dev-1").unwrap());
    assert_eq!(db.count("device_identity").unwrap(), 1);
    let identity: (String, Vec<u8>, String) = db
        .conn()
        .query_row(
            "SELECT role, public_key, display_name FROM device_identity WHERE device_id = 'dev-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(identity, ("ios".into(), pubkey.to_vec(), "dev-1".into()));
    let devices = db.list_trusted_device_projections().unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].device_id, "dev-1");
    assert_eq!(devices[0].revoked_at, None);
    assert_eq!(devices[0].pubkey_fingerprint.matches(':').count(), 7);
    let projection = format!("{:?}", devices[0]);
    assert!(!projection.contains("9, 9, 9"));
    assert_eq!(audit::verify_audit_chain(db.conn()).unwrap(), 1);
}

#[test]
fn expired_payload_and_phone_profile_cannot_complete_qr_pairing() {
    let p = temp_db_path("pair-payload-expired");
    let mut db = Db::open_hub(&p).unwrap();
    let payload = sample_payload(100);
    let pubkey = [9u8; 32];
    let proof = pairing_proof(payload.pairing_secret.expose_for_qr().as_bytes(), &pubkey);

    assert!(db
        .complete_qr_pairing(&payload, "dev-1", &pubkey, &proof, 100, "au-expired")
        .is_err());
    assert_eq!(db.count("device_identity").unwrap(), 0);
    assert_eq!(db.count("trusted_device").unwrap(), 0);
    assert_eq!(db.count("audit_ledger").unwrap(), 0);

    let phone_path = temp_db_path("pair-payload-phone");
    let mut phone_db = Db::open_phone(&phone_path).unwrap();
    assert!(phone_db
        .complete_qr_pairing(
            &sample_payload(200),
            "dev-1",
            &pubkey,
            &proof,
            100,
            "au-phone"
        )
        .is_err());
    assert!(phone_db.list_trusted_device_projections().is_err());
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
        DeviceRole::Ios,
        "Evil Phone",
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
        db.count("device_identity").unwrap(),
        0,
        "no identity on denied pairing"
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
        DeviceRole::Ios,
        "Jarvis iPhone",
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
        DeviceRole::Ios,
        "Jarvis iPhone",
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
    pairing::pair_device(
        db.conn_mut(),
        secret,
        "dev-1",
        DeviceRole::Ios,
        "Jarvis iPhone",
        &k1,
        &proof,
        1,
        "au-pair",
    )
    .unwrap();

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
