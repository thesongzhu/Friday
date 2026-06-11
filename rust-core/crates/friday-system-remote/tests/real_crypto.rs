//! A8 REAL-crypto round-trip KATs over [`friday_system_remote::RealWebAuthn`].
//!
//! These do NOT use the `cfg(test)` `AcceptingTestVerifier` (which proves only
//! the device store, never the cryptography). They drive a PURE-SOFTWARE FIDO2
//! authenticator (`webauthn-authenticator-rs`'s `SoftPasskey`, which performs
//! real ES256 key generation + signing) through the genuine ceremony:
//!
//!   start_passkey_registration → SoftPasskey.do_registration → finish_registration
//!   start_passkey_authentication → SoftPasskey.do_authentication → finish_assertion
//!
//! This is the proof that the real path verifies real cryptography end-to-end —
//! the "prove a new integration seam end-to-end" discipline (a mocked verifier
//! proves nothing about the real default path).

use friday_system_remote::{
    DeviceStore, RealWebAuthn, RemoteError, SessionStore, StoredCredential,
};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_rs::prelude::Url;

const RP_ID: &str = "friday.local";
const RP_ORIGIN: &str = "https://friday.local";
const OWNER: &str = "operator-1";

/// Build an engine whose ONLY operator-authorized owner is `OWNER` (the
/// first-device bootstrap trust root).
fn engine() -> RealWebAuthn {
    RealWebAuthn::new(RP_ID, RP_ORIGIN, vec![OWNER.to_string()]).expect("valid RP identity")
}

/// Drive a full REAL registration round-trip with the software authenticator,
/// returning the verified attestation's stored credential + the (still-live)
/// authenticator so the same key can authenticate later.
fn real_register(
    engine: &mut RealWebAuthn,
    authenticator: &mut WebauthnAuthenticator<SoftPasskey>,
    owner: &str,
) -> StoredCredential {
    let (ceremony_id, ccr) = engine
        .begin_registration(owner, "Operator Device", &[])
        .expect("authorized owner begins registration");
    let origin = Url::parse(RP_ORIGIN).unwrap();
    // The authenticator mints a real credential + attestation over the challenge.
    let reg = authenticator
        .do_registration(origin, ccr)
        .expect("software authenticator performs registration");
    let (_attestation, stored) = engine
        .finish_registration(&ceremony_id, &reg)
        .expect("real attestation verifies");
    stored
}

/// Drive a full REAL assertion round-trip; returns the verified new sign-count
/// and the UPDATED stored credential (counter folded forward) the caller would
/// persist as the next baseline.
fn real_assert(
    engine: &mut RealWebAuthn,
    authenticator: &mut WebauthnAuthenticator<SoftPasskey>,
    owner: &str,
    stored: &StoredCredential,
) -> Result<(u32, StoredCredential), RemoteError> {
    let (ceremony_id, rcr) = engine.begin_assertion(owner, stored)?;
    let origin = Url::parse(RP_ORIGIN).unwrap();
    let pkc = authenticator
        .do_authentication(origin, rcr)
        .expect("software authenticator performs assertion");
    engine
        .finish_assertion(&ceremony_id, &pkc)
        .map(|(_, updated)| (updated.sign_count(), updated))
}

#[test]
fn real_registration_then_assertion_round_trip() {
    let mut engine = engine();
    let mut auth = WebauthnAuthenticator::new(SoftPasskey::new(true));

    // REAL registration: a genuine ES256 credential is minted and the attestation
    // is cryptographically verified (RP-ID/origin/challenge binding all checked
    // by webauthn-rs). The stored blob carries public material only.
    let stored = real_register(&mut engine, &mut auth, OWNER);
    assert!(!stored.credential_id().is_empty());
    assert!(!stored.public_key().is_empty());
    // No private key leaks into the stored public credential JSON.
    let json = stored.passkey_json();
    assert!(
        !json.to_lowercase().contains("private") && !json.contains("\"d\""),
        "stored credential must hold no private-key material: {json}"
    );

    // The ceremony state was consumed (single-use): no pending registrations left.
    assert_eq!(engine.pending_registration_count(), 0);

    // REAL assertion: the same authenticator signs a fresh challenge; the
    // signature is verified over authenticatorData || sha256(clientDataJSON).
    let (count, _updated) =
        real_assert(&mut engine, &mut auth, OWNER, &stored).expect("a genuine assertion verifies");
    // SoftPasskey increments its counter per auth: first auth ⇒ 1 (> the stored 0).
    assert_eq!(count, 1);
    assert_eq!(engine.pending_assertion_count(), 0);
}

#[test]
fn persisted_baseline_advances_across_real_assertions_and_catches_a_lagging_clone() {
    // Closes the persistence loop the apply/persist contract claims: each real
    // assertion returns an UPDATED StoredCredential whose counter has advanced;
    // persisting it and re-deriving the next baseline from it advances the
    // regression baseline ACROSS ceremonies (0 → 1 → 2 here, all real). Then a
    // cloned/lagging authenticator (its counter behind the persisted baseline)
    // producing a fresh, challenge-valid assertion is rejected on the COUNTER.
    let mut engine = engine();
    let mut auth = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let stored0 = real_register(&mut engine, &mut auth, OWNER); // baseline counter 0
    assert_eq!(stored0.sign_count(), 0);

    // First real assertion: counter 0 → 1; persist the advanced blob.
    let (c1, stored1) = real_assert(&mut engine, &mut auth, OWNER, &stored0).unwrap();
    assert_eq!(c1, 1);
    assert_eq!(stored1.sign_count(), 1);

    // Second real assertion AGAINST THE PERSISTED blob: counter 1 → 2. This is the
    // proof the baseline genuinely advanced across calls — webauthn-rs accepted
    // 2 > 1 only because the baseline it compared against was the persisted 1.
    let (c2, stored2) = real_assert(&mut engine, &mut auth, OWNER, &stored1).unwrap();
    assert_eq!(c2, 2);
    assert_eq!(stored2.sign_count(), 2);

    // Now model a CLONE that lags the persisted baseline: a credential blob at the
    // advanced baseline (2) is what the server holds, but a cloned authenticator
    // presents a LOWER counter. We drive a fresh, challenge-valid assertion whose
    // baseline blob is bumped ABOVE what the authenticator will present, so the
    // genuine signature is rejected purely on the sign-count regression.
    let lagging_view = bump_stored_counter(&stored2, 50);
    let cloned = real_assert(&mut engine, &mut auth, OWNER, &lagging_view);
    assert_eq!(
        cloned,
        Err(RemoteError::ClonedAuthenticator),
        "an assertion whose counter lags the persisted baseline must be rejected as a clone"
    );
}

#[test]
fn real_attestation_drives_device_store_registration() {
    // The real verifier mints the SAME VerifiedAttestation typestate token the
    // DeviceStore::register accepts — so the real path registers a device, and the
    // store seeds its sign-count regression baseline from the attestation.
    let mut engine = engine();
    let mut auth = WebauthnAuthenticator::new(SoftPasskey::new(true));

    let (ceremony_id, ccr) = engine
        .begin_registration(OWNER, "Operator Device", &[])
        .unwrap();
    let reg = auth
        .do_registration(Url::parse(RP_ORIGIN).unwrap(), ccr)
        .unwrap();
    let (attestation, _stored) = engine.finish_registration(&ceremony_id, &reg).unwrap();

    let mut devices = DeviceStore::new();
    let dev = devices
        .register("dev-1", &attestation, "Operator Phone", 1_000)
        .expect("real attestation registers a device");
    assert_eq!(dev.owner, OWNER);
    assert_eq!(dev.rp_id, RP_ID);
    assert_eq!(dev.sign_count, 0); // baseline at registration
    assert_eq!(dev.credential_id, attestation.credential_id());

    // And a remote session can be opened against the now-registered real device.
    let mut sessions = SessionStore::new();
    let s = sessions
        .create(&devices, "sess-1", "dev-1", OWNER, 2_000, 1_000)
        .expect("session opens against a real registered device");
    assert_eq!(s.device_id, "dev-1");
}

#[test]
fn cloned_authenticator_sign_count_regression_is_rejected() {
    // THE A8 hardening KAT, with REAL crypto. A cryptographically-valid assertion
    // whose sign-count does NOT strictly increase over the stored value is the
    // W3C cloned-authenticator signal and MUST be rejected.
    let mut engine = engine();
    let mut auth = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let stored = real_register(&mut engine, &mut auth, OWNER);

    // Forge a stored credential whose sign-count is artificially HIGH (as if the
    // server had already observed a higher counter from this credential — the
    // genuine authenticator). The next REAL assertion the authenticator produces
    // will present a LOWER counter (its own in-memory counter, starting at 1),
    // exactly modelling a cloned/lagging authenticator. The signature itself is
    // valid; the rejection is purely the sign-count regression check.
    let bumped = bump_stored_counter(&stored, 100);

    let result = real_assert(&mut engine, &mut auth, OWNER, &bumped);
    assert_eq!(
        result,
        Err(RemoteError::ClonedAuthenticator),
        "a valid signature with a regressed (<=) sign-count must be rejected as a possible clone"
    );
    // The ceremony state was still consumed (single-use), so a retry cannot replay.
    assert_eq!(engine.pending_assertion_count(), 0);
}

#[test]
fn unknown_or_replayed_ceremony_id_is_rejected() {
    let mut engine = engine();
    let mut auth = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let stored = real_register(&mut engine, &mut auth, OWNER);

    // A finish against a ceremony id that was never issued ⇒ fail-closed.
    let (ceremony_id, rcr) = engine.begin_assertion(OWNER, &stored).unwrap();
    let pkc = auth
        .do_authentication(Url::parse(RP_ORIGIN).unwrap(), rcr)
        .unwrap();
    // First finish consumes the ceremony (succeeds).
    engine
        .finish_assertion(&ceremony_id, &pkc)
        .expect("first finish succeeds");
    // Replaying the SAME ceremony id ⇒ UnknownCeremony (single-use).
    let replay = engine.finish_assertion(&ceremony_id, &pkc);
    assert!(matches!(replay, Err(RemoteError::UnknownCeremony(_))));
    // A wholly unknown ceremony id ⇒ UnknownCeremony.
    let bogus = engine.finish_assertion("ceremony-99999", &pkc);
    assert!(matches!(bogus, Err(RemoteError::UnknownCeremony(_))));
}

#[test]
fn registration_for_unauthorized_owner_is_refused() {
    // First-device bootstrap posture (FLAGGED): registration is authorized by an
    // already-trusted operator, NEVER self-authorizing. An owner not in the
    // authorized set cannot even begin a registration ceremony.
    let mut engine = engine(); // only OWNER is authorized
    let out = engine.begin_registration("intruder", "Rogue Device", &[]);
    assert!(matches!(
        out,
        Err(RemoteError::RegistrationNotAuthorized(_))
    ));
    assert_eq!(engine.pending_registration_count(), 0);
}

#[test]
fn cross_origin_ceremony_fails_closed() {
    // The engine is bound to https://friday.local (rp_id friday.local). A ceremony
    // driven for a DIFFERENT origin must NOT yield a verifiable credential: the
    // origin/rp-id binding is enforced. (Here the SoftPasskey itself refuses to
    // sign for an origin that is not a registrable-domain-suffix of the
    // challenge's rp_id — a real layer of the binding; the server-side
    // clientDataJSON-origin comparison in webauthn-rs is the second layer, covered
    // by webauthn-rs's own suite. Either way the chain fails closed.)
    let mut engine = engine(); // rp_id = friday.local, origin = https://friday.local
    let mut auth = WebauthnAuthenticator::new(SoftPasskey::new(true));

    let (_ceremony_id, ccr) = engine
        .begin_registration(OWNER, "Operator Device", &[])
        .unwrap();
    // Drive the authenticator at an attacker-controlled origin that is NOT a
    // suffix of the challenge rp_id.
    let evil_origin = Url::parse("https://evil.example").unwrap();
    let reg = auth.do_registration(evil_origin, ccr);
    assert!(
        reg.is_err(),
        "a cross-origin ceremony must not produce a verifiable credential (origin binding)"
    );
}

#[test]
fn tampered_assertion_client_data_is_rejected() {
    // Server-side integrity: the signature covers authenticatorData ||
    // sha256(clientDataJSON). Tampering the clientDataJSON (e.g. to substitute a
    // different origin/type/challenge) after signing breaks the signature, and
    // webauthn-rs rejects it. This proves the engine does NOT accept a
    // clientDataJSON that was not the one signed over.
    let mut engine = engine();
    let mut auth = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let stored = real_register(&mut engine, &mut auth, OWNER);

    let (ceremony_id, rcr) = engine.begin_assertion(OWNER, &stored).unwrap();
    let mut pkc = auth
        .do_authentication(Url::parse(RP_ORIGIN).unwrap(), rcr)
        .unwrap();
    // Tamper: flip a byte of the signed clientDataJSON. The stored signature no
    // longer validates over the (now-different) data.
    if let Some(first) = pkc.response.client_data_json.as_mut().first_mut() {
        *first ^= 0xFF;
    }
    let out = engine.finish_assertion(&ceremony_id, &pkc);
    assert!(
        matches!(out, Err(RemoteError::WebAuthnRejected(_))),
        "a tampered clientDataJSON must be rejected, got {out:?}"
    );
}

#[test]
fn invalid_relying_party_origin_is_refused() {
    // A malformed origin never yields a verifier (fail-closed construction).
    let out = RealWebAuthn::new(RP_ID, "not a url", vec![OWNER.to_string()]);
    assert!(matches!(out, Err(RemoteError::InvalidRelyingParty(_))));
    let empty_rp = RealWebAuthn::new("", RP_ORIGIN, vec![OWNER.to_string()]);
    assert!(matches!(empty_rp, Err(RemoteError::InvalidRelyingParty(_))));
}

/// Forge a [`StoredCredential`] copy whose serialized `Passkey` carries a higher
/// sign-count. Used to model a server that has already observed a higher counter
/// for this credential than a (cloned/lagging) authenticator will next present.
fn bump_stored_counter(stored: &StoredCredential, new_counter: u64) -> StoredCredential {
    // The serialized Passkey is `{ "cred": { ... "counter": N ... } }`.
    let mut v: serde_json::Value = serde_json::from_str(stored.passkey_json()).unwrap();
    v["cred"]["counter"] = serde_json::json!(new_counter);
    let bumped_json = serde_json::to_string(&v).unwrap();
    // Rehydrate through the public persistence API (the same path a future
    // storage slice uses to load a stored credential blob back into a verifiable
    // credential).
    StoredCredential::from_passkey_json(&bumped_json).unwrap()
}
