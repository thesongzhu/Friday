//! Integration KATs over the PUBLIC API of `friday-system-remote`.
//!
//! These run as an external crate, so they see ONLY the public surface — exactly
//! what a future hub caller would. Crucially, an external crate has NO way to
//! construct a `VerifiedAttestation`/`VerifiedAssertion` (no public constructor)
//! and the test-only accepting verifier is `cfg(test)`-gated INSIDE the crate, so
//! it is invisible here. The only verifier an external caller can reach is the
//! shipped [`DeferredVerifier`], which fails closed. This file pins that the
//! default production path REJECTS.

use friday_system_remote::{
    begin_assertion, begin_registration, AssertionResponse, AttestationResponse, DeferredVerifier,
    DeviceStore, RemoteError, SessionStore, WebAuthnVerifier,
};

#[test]
fn shipped_verifier_rejects_registration_fail_closed() {
    let chal = begin_registration("owner-1", "friday.local", vec![1, 2, 3]).unwrap();
    let resp = AttestationResponse {
        credential_id: vec![7, 7, 7],
        attestation_object: vec![0xa0],
        client_data_json: b"{}".to_vec(),
    };
    let out = DeferredVerifier.verify_registration(&chal, &resp);
    assert_eq!(out, Err(RemoteError::WebAuthnVerifierNotWired));
    assert!(
        out.is_err(),
        "shipped verifier must reject (Err), never accept or panic"
    );
}

#[test]
fn shipped_verifier_rejects_assertion_fail_closed() {
    let chal = begin_assertion("owner-1", "friday.local", vec![7, 7, 7], vec![4, 5, 6]).unwrap();
    let resp = AssertionResponse {
        credential_id: vec![7, 7, 7],
        authenticator_data: vec![1],
        client_data_json: b"{}".to_vec(),
        signature: vec![0xde, 0xad],
    };
    let out = DeferredVerifier.verify_assertion(&chal, &resp, &[0x04, 0x01]);
    assert_eq!(out, Err(RemoteError::WebAuthnVerifierNotWired));
}

#[test]
fn no_device_can_be_registered_through_the_default_path() {
    // An external caller cannot mint a VerifiedAttestation: the verifier they can
    // reach (DeferredVerifier) returns Err, and DeviceStore::register accepts ONLY
    // a VerifiedAttestation. So the device store stays empty — fail closed end to
    // end: no verified attestation ⇒ no registration is even expressible.
    let store = DeviceStore::new();
    assert!(store.is_empty());
    // (We cannot construct a VerifiedAttestation here to even attempt register(),
    // which is the point: the type system blocks the unverified path.)
}

#[test]
fn public_input_validation_rejects_empty() {
    assert!(matches!(
        begin_registration("", "rp", vec![1]),
        Err(RemoteError::InvalidInput(_))
    ));
    assert!(matches!(
        begin_assertion("o", "rp", vec![], vec![1]),
        Err(RemoteError::InvalidInput(_))
    ));
}

#[test]
fn session_store_is_empty_without_a_device() {
    // SessionStore::create requires a real owner-matched device in the DeviceStore;
    // with none registered (the fail-closed default), create yields DeviceNotFound.
    let devices = DeviceStore::new();
    let mut sessions = SessionStore::new();
    let out = sessions.create(&devices, "s", "dev-1", "owner-1", 1, 10);
    assert!(matches!(out, Err(RemoteError::DeviceNotFound(_))));
    assert!(sessions.is_empty());
}
