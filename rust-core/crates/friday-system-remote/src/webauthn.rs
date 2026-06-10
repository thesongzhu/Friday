//! WebAuthn ceremony SHAPE as typed state machines (R5 slice-1).
//!
//! This module models the two WebAuthn ceremonies — **registration**
//! (`navigator.credentials.create`, attestation) and **assertion**
//! (`navigator.credentials.get`, authentication) — as typed state machines:
//!
//! ```text
//!   register:  RegistrationChallenge --(verify attestation)--> VerifiedAttestation
//!   assert:    AssertionChallenge     --(verify assertion)----> VerifiedAssertion
//! ```
//!
//! ## What is REAL vs STUB this slice
//! * REAL: the typed ceremony states, the legal transitions, and the
//!   verification SEAM (the [`WebAuthnVerifier`] trait).
//! * STUB (deferred): the actual cryptographic verification — COSE key parsing,
//!   attestation-statement validation, signature checks over
//!   `authenticatorData || sha256(clientDataJSON)`, sign-count regression
//!   checks, RP-ID / origin / challenge binding. None of that is implemented
//!   here. The provided [`DeferredVerifier`] FAILS CLOSED: it returns
//!   `Err(RemoteError::WebAuthnVerifierNotWired)` for every ceremony.
//!
//! ## Fail-closed by construction (typestate)
//! [`VerifiedAttestation`] and [`VerifiedAssertion`] have NO public constructor.
//! The ONLY way to obtain one is as the `Ok` result of a [`WebAuthnVerifier`]
//! method. A caller therefore cannot fabricate a "verified" token and hand it to
//! the device/session store: an unverified ceremony is unrepresentable as a
//! verified value. Swapping in a real verifier is the only thing that makes the
//! accept-path reachable — exactly the seam this slice defines.

use crate::error::{RemoteError, Result};

/// Opaque bytes carried through a ceremony (challenge, client data, attestation
/// object, authenticator data, signature). We do not interpret them this slice;
/// a real verifier will. Stored as owned `Vec<u8>` to keep the states `'static`.
pub type Bytes = Vec<u8>;

/// Server-issued registration challenge (the `create()` ceremony, step 1).
///
/// In a real flow the RP generates a fresh random `challenge`, scopes it to
/// `rp_id` + `owner`, and remembers it pending the client's attestation. Here it
/// is an inert typed token; the transition to [`VerifiedAttestation`] only
/// happens through a [`WebAuthnVerifier`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistrationChallenge {
    /// Owner principal the eventual credential will be bound to.
    pub owner: String,
    /// Relying-party id (effective domain) the credential is scoped to.
    pub rp_id: String,
    /// Fresh server-random challenge bytes the authenticator must sign over.
    pub challenge: Bytes,
}

/// The client's attestation response to a [`RegistrationChallenge`] (step 2,
/// pre-verification). This is UNTRUSTED input straight off the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestationResponse {
    /// Credential id the authenticator minted.
    pub credential_id: Bytes,
    /// CBOR attestation object (`fmt`, `attStmt`, `authData`). Opaque here.
    pub attestation_object: Bytes,
    /// `clientDataJSON` the authenticator signed over. Opaque here.
    pub client_data_json: Bytes,
}

/// A registration attestation that a [`WebAuthnVerifier`] has ACCEPTED. No
/// public constructor — only [`WebAuthnVerifier::verify_registration`] can mint
/// one. Carries the verified credential material a device row is built from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedAttestation {
    owner: String,
    rp_id: String,
    credential_id: Bytes,
    /// The credential public key extracted/verified from the attestation. A real
    /// verifier fills this from the COSE key in `authData`; the stub never
    /// reaches here.
    public_key: Bytes,
}

impl VerifiedAttestation {
    pub fn owner(&self) -> &str {
        &self.owner
    }
    pub fn rp_id(&self) -> &str {
        &self.rp_id
    }
    pub fn credential_id(&self) -> &[u8] {
        &self.credential_id
    }
    pub fn public_key(&self) -> &[u8] {
        &self.public_key
    }
}

/// Server-issued assertion challenge (the `get()` ceremony, step 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssertionChallenge {
    /// Owner principal expected to satisfy this challenge.
    pub owner: String,
    pub rp_id: String,
    /// The credential id the server expects to authenticate (allow-list of one).
    pub expected_credential_id: Bytes,
    pub challenge: Bytes,
}

/// The client's assertion response to an [`AssertionChallenge`] (step 2,
/// pre-verification). UNTRUSTED input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssertionResponse {
    pub credential_id: Bytes,
    pub authenticator_data: Bytes,
    pub client_data_json: Bytes,
    pub signature: Bytes,
}

/// An assertion that a [`WebAuthnVerifier`] has ACCEPTED. No public constructor —
/// only [`WebAuthnVerifier::verify_assertion`] can mint one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedAssertion {
    owner: String,
    credential_id: Bytes,
}

impl VerifiedAssertion {
    pub fn owner(&self) -> &str {
        &self.owner
    }
    pub fn credential_id(&self) -> &[u8] {
        &self.credential_id
    }
}

/// The verification SEAM. A real WebAuthn implementation (e.g. a future port
/// over the `webauthn-rs` crate) implements this trait; the device/session layer
/// depends only on the trait, never on a concrete verifier. The trait is the
/// single choke point through which a verified token can come into existence.
pub trait WebAuthnVerifier {
    /// Verify a registration attestation against the challenge it answers.
    /// Returns a [`VerifiedAttestation`] ONLY on cryptographic success.
    fn verify_registration(
        &self,
        challenge: &RegistrationChallenge,
        response: &AttestationResponse,
    ) -> Result<VerifiedAttestation>;

    /// Verify an authentication assertion against the challenge it answers and
    /// the stored credential public key. Returns a [`VerifiedAssertion`] ONLY on
    /// cryptographic success.
    fn verify_assertion(
        &self,
        challenge: &AssertionChallenge,
        response: &AssertionResponse,
        stored_public_key: &[u8],
    ) -> Result<VerifiedAssertion>;
}

/// The DEFERRED verifier shipped this slice. It implements the seam but performs
/// NO cryptography: every ceremony is REJECTED with
/// [`RemoteError::WebAuthnVerifierNotWired`]. This is the fail-closed default —
/// until a real verifier is wired, no attestation or assertion can be accepted,
/// so no device can be registered and no remote session can be created through
/// the verified path.
///
/// It returns `Err`, never `panic!`/`todo!()`: a missing verifier is a REFUSAL,
/// not a crash.
#[derive(Clone, Copy, Debug, Default)]
pub struct DeferredVerifier;

impl WebAuthnVerifier for DeferredVerifier {
    fn verify_registration(
        &self,
        _challenge: &RegistrationChallenge,
        _response: &AttestationResponse,
    ) -> Result<VerifiedAttestation> {
        // DEFERRED: real attestation verification (fmt/attStmt validation, COSE
        // key extraction, challenge/origin/rp-id binding) is not implemented.
        // Fail closed.
        Err(RemoteError::WebAuthnVerifierNotWired)
    }

    fn verify_assertion(
        &self,
        _challenge: &AssertionChallenge,
        _response: &AssertionResponse,
        _stored_public_key: &[u8],
    ) -> Result<VerifiedAssertion> {
        // DEFERRED: real assertion verification (signature over
        // authenticatorData||sha256(clientDataJSON), sign-count regression,
        // challenge/origin/rp-id binding) is not implemented. Fail closed.
        Err(RemoteError::WebAuthnVerifierNotWired)
    }
}

/// Issue a registration challenge. Validates the owner/rp-id/challenge are
/// non-empty (a real RP would generate `challenge` from a CSPRNG; here the caller
/// supplies bytes and we only enforce non-emptiness — fail closed on empty).
pub fn begin_registration(
    owner: &str,
    rp_id: &str,
    challenge: Bytes,
) -> Result<RegistrationChallenge> {
    if owner.trim().is_empty() {
        return Err(RemoteError::InvalidInput("owner is empty".into()));
    }
    if rp_id.trim().is_empty() {
        return Err(RemoteError::InvalidInput("rp_id is empty".into()));
    }
    if challenge.is_empty() {
        return Err(RemoteError::InvalidInput("challenge is empty".into()));
    }
    Ok(RegistrationChallenge {
        owner: owner.to_string(),
        rp_id: rp_id.to_string(),
        challenge,
    })
}

/// Issue an assertion challenge for a known credential id.
pub fn begin_assertion(
    owner: &str,
    rp_id: &str,
    expected_credential_id: Bytes,
    challenge: Bytes,
) -> Result<AssertionChallenge> {
    if owner.trim().is_empty() {
        return Err(RemoteError::InvalidInput("owner is empty".into()));
    }
    if rp_id.trim().is_empty() {
        return Err(RemoteError::InvalidInput("rp_id is empty".into()));
    }
    if expected_credential_id.is_empty() {
        return Err(RemoteError::InvalidInput(
            "expected_credential_id is empty".into(),
        ));
    }
    if challenge.is_empty() {
        return Err(RemoteError::InvalidInput("challenge is empty".into()));
    }
    Ok(AssertionChallenge {
        owner: owner.to_string(),
        rp_id: rp_id.to_string(),
        expected_credential_id,
        challenge,
    })
}

/// TEST-ONLY accepting verifier. Compiled ONLY under `cfg(test)`, so it is
/// absent from every production build — it can never be the wired verifier in
/// shipped code. It mints verified tokens (via the private constructors that are
/// in-module) so the device/session HAPPY-PATH KATs can exercise the
/// post-verification flow without real cryptography. Its existence does NOT open
/// a public fabrication path: a non-test caller has no way to reach it or to
/// construct a `VerifiedAttestation`/`VerifiedAssertion` directly.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct AcceptingTestVerifier;

#[cfg(test)]
impl WebAuthnVerifier for AcceptingTestVerifier {
    fn verify_registration(
        &self,
        challenge: &RegistrationChallenge,
        response: &AttestationResponse,
    ) -> Result<VerifiedAttestation> {
        Ok(VerifiedAttestation {
            owner: challenge.owner.clone(),
            rp_id: challenge.rp_id.clone(),
            credential_id: response.credential_id.clone(),
            // A real verifier extracts this from the COSE key in authData; the
            // test verifier fabricates a deterministic placeholder.
            public_key: vec![0x04, 0xAA, 0xBB, 0xCC],
        })
    }

    fn verify_assertion(
        &self,
        challenge: &AssertionChallenge,
        response: &AssertionResponse,
        _stored_public_key: &[u8],
    ) -> Result<VerifiedAssertion> {
        // Even the test verifier still enforces the credential-id binding, so the
        // owner-scoping/mismatch KATs are meaningful.
        if response.credential_id != challenge.expected_credential_id {
            return Err(RemoteError::UnknownCredential);
        }
        Ok(VerifiedAssertion {
            owner: challenge.owner.clone(),
            credential_id: response.credential_id.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepting_test_verifier_mints_attestation_for_happy_path() {
        let chal = begin_registration("owner-1", "friday.local", vec![1, 2, 3]).unwrap();
        let resp = AttestationResponse {
            credential_id: vec![7, 7, 7],
            attestation_object: vec![0xa0],
            client_data_json: b"{}".to_vec(),
        };
        let att = AcceptingTestVerifier
            .verify_registration(&chal, &resp)
            .expect("test verifier accepts");
        assert_eq!(att.owner(), "owner-1");
        assert_eq!(att.credential_id(), &[7, 7, 7]);
    }

    fn reg_challenge() -> RegistrationChallenge {
        begin_registration("owner-1", "friday.local", vec![1, 2, 3, 4]).unwrap()
    }

    fn att_response() -> AttestationResponse {
        AttestationResponse {
            credential_id: vec![9, 9, 9],
            attestation_object: vec![0xa0],
            client_data_json: br#"{"type":"webauthn.create"}"#.to_vec(),
        }
    }

    #[test]
    fn deferred_verifier_rejects_registration_fail_closed() {
        let out = DeferredVerifier.verify_registration(&reg_challenge(), &att_response());
        assert_eq!(out, Err(RemoteError::WebAuthnVerifierNotWired));
        assert!(out.is_err(), "deferred verifier must reject, never accept");
    }

    #[test]
    fn deferred_verifier_rejects_assertion_fail_closed() {
        let chal =
            begin_assertion("owner-1", "friday.local", vec![9, 9, 9], vec![5, 6, 7]).unwrap();
        let resp = AssertionResponse {
            credential_id: vec![9, 9, 9],
            authenticator_data: vec![1],
            client_data_json: br#"{"type":"webauthn.get"}"#.to_vec(),
            signature: vec![0xde, 0xad],
        };
        let stored_public_key = [0x04u8, 0x01, 0x02];
        let out = DeferredVerifier.verify_assertion(&chal, &resp, &stored_public_key);
        assert_eq!(out, Err(RemoteError::WebAuthnVerifierNotWired));
        assert!(out.is_err(), "deferred verifier must reject, never accept");
    }

    #[test]
    fn begin_registration_rejects_empty_inputs() {
        assert!(begin_registration("", "rp", vec![1]).is_err());
        assert!(begin_registration("o", "", vec![1]).is_err());
        assert!(begin_registration("o", "rp", vec![]).is_err());
    }

    #[test]
    fn begin_assertion_rejects_empty_inputs() {
        assert!(begin_assertion("", "rp", vec![1], vec![1]).is_err());
        assert!(begin_assertion("o", "rp", vec![], vec![1]).is_err());
        assert!(begin_assertion("o", "rp", vec![1], vec![]).is_err());
    }
}
