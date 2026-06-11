//! A8 — REAL WebAuthn/FIDO2 passkey verification over `webauthn-rs`.
//!
//! This module replaces the cryptographic gap the slice-1 [`crate::webauthn`]
//! seam deliberately left open. Where the shipped [`crate::webauthn::DeferredVerifier`]
//! REJECTS every ceremony (`WebAuthnVerifierNotWired`), this module performs the
//! genuine ceremonies via the `webauthn-rs` crate:
//!
//! * **registration** (`navigator.credentials.create`): attestation-object CBOR
//!   parse, COSE credential-public-key extraction, RP-ID hash + origin + type +
//!   challenge binding, and (because passkeys use
//!   `AttestationConveyancePreference::None`) no attestation-CA trust anchor.
//! * **assertion** (`navigator.credentials.get`): ES256/RS256/EdDSA signature
//!   verification over `authenticatorData || sha256(clientDataJSON)`, the
//!   RP-ID-hash / origin / type / challenge binding, AND the **sign-count
//!   regression check** (a non-increasing counter ⇒ possible cloned
//!   authenticator ⇒ REJECT).
//!
//! # DARK + flag-gated-OFF, NO route flip (A8 posture)
//! Nothing here is wired to `friday-hub`, any route, or the FFI. The shipped
//! default verifier the public API exposes is STILL [`crate::webauthn::DeferredVerifier`]
//! — the `fail_closed` KATs continue to prove the default production path
//! rejects. A [`RealWebAuthn`] engine only exists if a caller *constructs* one
//! with an explicit relying-party identity; no production code does this yet.
//! This is the gate: the real verifier now EXISTS, but flipping it on is a later,
//! operator-gated, DEPLOY-GO step.
//!
//! # Hub stores ONLY public material (never private keys)
//! By WebAuthn construction the private key never leaves the authenticator — the
//! server never sees it. What this engine surfaces for storage is the
//! [`StoredCredential`] blob: a serialized `webauthn-rs` `Passkey`, which holds
//! the credential id, the COSE *public* key, the sign-count, and registration
//! flags — and nothing secret. A device row persists exactly that.
//!
//! # Strict RP-ID / origin / challenge binding
//! The engine is built from an injected `rp_id` + `rp_origin` (the hub identity —
//! NOT hardcoded; a deploy-gated config). We deliberately do NOT enable
//! `allow_subdomains`, `allow_any_port`, or any extra allowed origin: those
//! relax exactly the origin/`rpIdHash` binding A8 is required to enforce. A
//! `clientDataJSON` whose `origin` or whose authenticator-data `rpIdHash` does
//! not match the configured identity is rejected by `webauthn-rs`.
//!
//! # Challenge handling — single-use, in-memory (this DARK slice)
//! `webauthn-rs` is a two-phase, stateful ceremony: `start_*` returns a pending
//! state the server MUST hold and pair to the `finish_*` call. We hold the
//! pending state in an in-memory [`std::collections::HashMap`] keyed by a
//! server-issued `ceremony_id`, and **consume it on finish (single-use)** — a
//! replayed or unknown `ceremony_id` is [`RemoteError::UnknownCeremony`]. We do
//! NOT enable `webauthn-rs`'s `danger-allow-state-serialisation`: persisting the
//! pending state across process restarts is the deferred persistence slice.
//!
//! # FLAGGED: first-device bootstrap posture
//! Per the A8 brief, the first-device bootstrap path is ambiguous, so we
//! implement the SOUNDEST posture and flag it: **registration is authorized by an
//! already-trusted operator, never self-authorizing.** [`RealWebAuthn::begin_registration`]
//! refuses (`RegistrationNotAuthorized`) unless the target owner principal is in
//! an operator-supplied authorized set. This is the trust root; how the operator
//! seeds that set (CLI, a bootstrap secret, an existing trusted device) is a
//! deploy-gated decision left to the operator — see the PR body's open questions.
//!
//! # FLAGGED: synced-passkey counter exemption (faithful to spec)
//! W3C §verifying-assertion only requires the strictly-increasing check when the
//! counter is nonzero. Many platform/synced passkeys (iCloud Keychain, Google
//! Password Manager) report a counter of 0 forever — they CANNOT be clone-
//! detected by counter, by design. `webauthn-rs` applies the check exactly when
//! `presented > 0 || stored > 0`; we do NOT re-implement or tighten it at the
//! store layer (that would false-reject legitimate synced passkeys). The
//! regression check is therefore real but, for 0/0 passkeys, a no-op — flagged so
//! a reviewer does not read "no rejection for a synced passkey" as a hole.

use crate::error::{RemoteError, Result};
use crate::webauthn::{VerifiedAssertion, VerifiedAttestation};
use std::collections::HashMap;
use webauthn_rs::prelude::{
    CreationChallengeResponse, Passkey, PasskeyAuthentication, PasskeyRegistration,
    PublicKeyCredential, RegisterPublicKeyCredential, RequestChallengeResponse, Url, Uuid,
    Webauthn, WebauthnBuilder, WebauthnError,
};

/// The opaque, server-issued id that pairs a `start_*` ceremony to its `finish_*`
/// call. Single-use: consumed (removed) on finish.
pub type CeremonyId = String;

/// A credential record fit for a device row: the serialized `webauthn-rs`
/// `Passkey`. It carries the credential id, the COSE PUBLIC key, the current
/// sign-count and registration flags — NO private key (the private key never
/// leaves the authenticator). A future persistence slice stores this blob's
/// bytes; the engine reconstructs the `Passkey` from it to verify assertions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCredential {
    /// The WebAuthn credential id (raw bytes) — the device-row key.
    credential_id: Vec<u8>,
    /// The serialized `Passkey` (JSON). Public material only.
    passkey_json: String,
    /// The COSE public key bytes (serialized), surfaced for the device row's
    /// `public_key` column. Derived from the same `Passkey`.
    public_key: Vec<u8>,
    /// The current stored sign-count (the regression baseline).
    sign_count: u32,
}

impl StoredCredential {
    pub fn credential_id(&self) -> &[u8] {
        &self.credential_id
    }
    /// The serialized public credential blob (no secret material) for persistence.
    pub fn passkey_json(&self) -> &str {
        &self.passkey_json
    }
    pub fn public_key(&self) -> &[u8] {
        &self.public_key
    }
    pub fn sign_count(&self) -> u32 {
        self.sign_count
    }

    /// Rehydrate a stored credential from its serialized `Passkey` JSON blob —
    /// the inverse of [`StoredCredential::passkey_json`]. A persistence slice
    /// loads a device row's stored credential bytes back into a verifiable
    /// credential through this; the engine's [`RealWebAuthn::begin_assertion`]
    /// then reconstructs the `Passkey` from it. Fail-closed: malformed JSON or a
    /// blob that is not a valid public credential is [`RemoteError::WebAuthnRejected`].
    pub fn from_passkey_json(passkey_json: &str) -> Result<Self> {
        let passkey: Passkey = serde_json::from_str(passkey_json)
            .map_err(|e| RemoteError::WebAuthnRejected(format!("deserialize passkey: {e}")))?;
        Self::from_passkey(&passkey)
    }

    fn from_passkey(passkey: &Passkey) -> Result<Self> {
        let passkey_json = serde_json::to_string(passkey)
            .map_err(|e| RemoteError::WebAuthnRejected(format!("serialize passkey: {e}")))?;
        let public_key = serde_json::to_vec(passkey.get_public_key())
            .map_err(|e| RemoteError::WebAuthnRejected(format!("serialize COSE key: {e}")))?;
        Ok(Self {
            credential_id: passkey.cred_id().as_ref().to_vec(),
            passkey_json,
            public_key,
            sign_count: counter_of(passkey),
        })
    }

    fn to_passkey(&self) -> Result<Passkey> {
        serde_json::from_str(&self.passkey_json)
            .map_err(|e| RemoteError::WebAuthnRejected(format!("deserialize passkey: {e}")))
    }
}

/// The pending registration challenge state (held server-side between
/// `begin_registration` and `finish_registration`). Bound to the target owner so
/// the finished credential is attributed to the operator-authorized principal,
/// not to free caller input.
struct PendingReg {
    owner: String,
    state: PasskeyRegistration,
}

/// The pending assertion challenge state, bound to the stored credential it
/// authenticates and its owner. Carries the `Passkey` whose counter was the
/// regression baseline for THIS ceremony, so `finish_assertion` can fold the
/// verified advance back into an updated [`StoredCredential`] (the credential's
/// system of record) and the caller can persist it.
struct PendingAuth {
    owner: String,
    credential_id: Vec<u8>,
    /// The baseline passkey (counter = the value the regression check compared
    /// against). Advanced via `Passkey::update_credential` on a verified result.
    baseline_passkey: Passkey,
    state: PasskeyAuthentication,
}

/// The real WebAuthn engine: a configured relying party + the in-memory pending
/// ceremony state + the operator-authorized owner trust root.
///
/// NOTE: this is NOT a [`crate::webauthn::WebAuthnVerifier`] implementation. That
/// trait is single-shot (`verify(challenge, response)`) and cannot carry the
/// two-phase pending state `webauthn-rs` requires; forcing it through that seam
/// would have meant smuggling the challenge state out-of-band. Instead this
/// engine is the privileged MINTER of the existing typestate tokens
/// ([`VerifiedAttestation`]/[`VerifiedAssertion`]) — the same fail-closed
/// guarantee (only a verifier can mint one) holds, now backed by real crypto.
/// The `WebAuthnVerifier` trait + [`crate::webauthn::DeferredVerifier`] remain as
/// the shipped fail-closed default seam.
pub struct RealWebAuthn {
    webauthn: Webauthn,
    rp_id: String,
    /// Owner principals an operator has authorized to register a device. The
    /// first-device bootstrap trust root (FLAGGED — see module docs).
    authorized_owners: Vec<String>,
    pending_reg: HashMap<CeremonyId, PendingReg>,
    pending_auth: HashMap<CeremonyId, PendingAuth>,
    /// Monotonic ceremony-id source (in-memory; a real deployment uses a CSPRNG
    /// token — deferred with the rest of the hub wiring).
    next_id: u64,
}

impl RealWebAuthn {
    /// Construct the engine for a relying party. `rp_id` is the effective domain
    /// (e.g. `friday.local`); `rp_origin` is the full origin the client is served
    /// from (e.g. `https://friday.local`). Both come from the hub identity — a
    /// deploy-gated config, never hardcoded. `authorized_owners` is the operator-
    /// supplied registration trust root (may start with exactly the operator's
    /// own principal for the first-device bootstrap).
    ///
    /// Fails closed ([`RemoteError::InvalidRelyingParty`]) if the origin is not a
    /// valid URL or the builder rejects the identity. We do NOT relax any origin
    /// binding (no subdomains, no any-port, no extra origins).
    pub fn new(rp_id: &str, rp_origin: &str, authorized_owners: Vec<String>) -> Result<Self> {
        if rp_id.trim().is_empty() {
            return Err(RemoteError::InvalidRelyingParty("rp_id is empty".into()));
        }
        let origin = Url::parse(rp_origin)
            .map_err(|e| RemoteError::InvalidRelyingParty(format!("rp_origin not a URL: {e}")))?;
        let webauthn = WebauthnBuilder::new(rp_id, &origin)
            .map_err(map_webauthn_err)?
            // STRICT: no allow_subdomains / allow_any_port / append_allowed_origin.
            .rp_name("Friday")
            .build()
            .map_err(map_webauthn_err)?;
        Ok(Self {
            webauthn,
            rp_id: rp_id.to_string(),
            authorized_owners,
            pending_reg: HashMap::new(),
            pending_auth: HashMap::new(),
            next_id: 0,
        })
    }

    fn issue_ceremony_id(&mut self) -> CeremonyId {
        self.next_id = self.next_id.wrapping_add(1);
        format!("ceremony-{}", self.next_id)
    }

    fn is_authorized(&self, owner: &str) -> bool {
        self.authorized_owners.iter().any(|o| o == owner)
    }

    /// Begin a registration ceremony for an operator-authorized owner. Returns a
    /// single-use `ceremony_id` and the `CreationChallengeResponse` to hand to the
    /// client (`navigator.credentials.create`).
    ///
    /// Fail-closed: an owner not in the operator-authorized set is REFUSED
    /// ([`RemoteError::RegistrationNotAuthorized`]) — registration is never self-
    /// authorizing (FLAGGED bootstrap posture).
    ///
    /// `exclude_credential_ids` is the set of credential ids already registered to
    /// this owner; passing them prevents the authenticator from minting a second
    /// credential for an already-registered device.
    pub fn begin_registration(
        &mut self,
        owner: &str,
        user_display_name: &str,
        exclude_credential_ids: &[Vec<u8>],
    ) -> Result<(CeremonyId, CreationChallengeResponse)> {
        if owner.trim().is_empty() {
            return Err(RemoteError::InvalidInput("owner is empty".into()));
        }
        if !self.is_authorized(owner) {
            return Err(RemoteError::RegistrationNotAuthorized(owner.to_string()));
        }
        // Deterministic per-owner user handle (a real deployment maps owner→stable
        // uuid; here we derive one from the owner principal so re-registration is
        // consistent within a run). SHA-256 the owner and take the first 16 bytes
        // as the uuid — avoids pulling the uuid `v5` feature into the graph.
        let user_unique_id = owner_user_handle(owner);
        let exclude = if exclude_credential_ids.is_empty() {
            None
        } else {
            Some(
                exclude_credential_ids
                    .iter()
                    .map(|id| id.clone().into())
                    .collect(),
            )
        };
        let (ccr, state) = self
            .webauthn
            .start_passkey_registration(user_unique_id, owner, user_display_name, exclude)
            .map_err(map_webauthn_err)?;
        let ceremony_id = self.issue_ceremony_id();
        self.pending_reg.insert(
            ceremony_id.clone(),
            PendingReg {
                owner: owner.to_string(),
                state,
            },
        );
        Ok((ceremony_id, ccr))
    }

    /// Finish a registration ceremony. Consumes the pending state (single-use),
    /// verifies the attestation cryptographically (RP-ID hash / origin / type /
    /// challenge binding; COSE key extraction), and mints a [`VerifiedAttestation`]
    /// — the typestate token a [`crate::device::DeviceStore::register`] accepts —
    /// plus the [`StoredCredential`] blob to persist.
    ///
    /// Fail-closed: an unknown/already-consumed `ceremony_id` is
    /// [`RemoteError::UnknownCeremony`]; any cryptographic failure is
    /// [`RemoteError::WebAuthnRejected`].
    pub fn finish_registration(
        &mut self,
        ceremony_id: &str,
        credential: &RegisterPublicKeyCredential,
    ) -> Result<(VerifiedAttestation, StoredCredential)> {
        // Consume the pending state (single-use). Unknown/replayed ⇒ fail-closed.
        let pending = self
            .pending_reg
            .remove(ceremony_id)
            .ok_or_else(|| RemoteError::UnknownCeremony(ceremony_id.to_string()))?;
        let passkey = self
            .webauthn
            .finish_passkey_registration(credential, &pending.state)
            .map_err(map_webauthn_err)?;
        let stored = StoredCredential::from_passkey(&passkey)?;
        let attestation = VerifiedAttestation::new_verified(
            pending.owner,
            self.rp_id.clone(),
            stored.credential_id.clone(),
            stored.public_key.clone(),
            stored.sign_count,
        );
        Ok((attestation, stored))
    }

    /// Begin an assertion ceremony against a previously-stored credential. Returns
    /// a single-use `ceremony_id` and the `RequestChallengeResponse` for the
    /// client (`navigator.credentials.get`).
    pub fn begin_assertion(
        &mut self,
        owner: &str,
        stored: &StoredCredential,
    ) -> Result<(CeremonyId, RequestChallengeResponse)> {
        if owner.trim().is_empty() {
            return Err(RemoteError::InvalidInput("owner is empty".into()));
        }
        let passkey = stored.to_passkey()?;
        let (rcr, state) = self
            .webauthn
            .start_passkey_authentication(std::slice::from_ref(&passkey))
            .map_err(map_webauthn_err)?;
        let ceremony_id = self.issue_ceremony_id();
        self.pending_auth.insert(
            ceremony_id.clone(),
            PendingAuth {
                owner: owner.to_string(),
                credential_id: stored.credential_id.clone(),
                baseline_passkey: passkey,
                state,
            },
        );
        Ok((ceremony_id, rcr))
    }

    /// Finish an assertion ceremony. Consumes the pending state (single-use),
    /// verifies the signature + RP-ID/origin/challenge binding, AND enforces the
    /// sign-count regression check.
    ///
    /// Returns the minted [`VerifiedAssertion`] (carrying the verified,
    /// monotonically-advanced sign-count) AND the **updated [`StoredCredential`]**
    /// — the baseline `Passkey`'s counter (and backup-state flags) folded forward
    /// via `Passkey::update_credential`. The caller MUST persist this updated
    /// credential as the credential's system of record: it is what a SUBSEQUENT
    /// [`RealWebAuthn::begin_assertion`] uses as the next regression baseline, so
    /// persisting it is exactly what makes a later REPLAY of an older (lower-count)
    /// assertion trip [`RemoteError::ClonedAuthenticator`]. Without persisting it,
    /// the baseline never advances across calls and the regression check is
    /// toothless between ceremonies.
    ///
    /// Fail-closed:
    /// * unknown/already-consumed `ceremony_id` ⇒ [`RemoteError::UnknownCeremony`];
    /// * sign-count regression (non-increasing, nonzero) ⇒
    ///   [`RemoteError::ClonedAuthenticator`] — the W3C cloned-authenticator signal
    ///   (`webauthn-rs` raises `CredentialPossibleCompromise`);
    /// * any other cryptographic failure ⇒ [`RemoteError::WebAuthnRejected`].
    pub fn finish_assertion(
        &mut self,
        ceremony_id: &str,
        credential: &PublicKeyCredential,
    ) -> Result<(VerifiedAssertion, StoredCredential)> {
        let pending = self
            .pending_auth
            .remove(ceremony_id)
            .ok_or_else(|| RemoteError::UnknownCeremony(ceremony_id.to_string()))?;
        let auth_result = self
            .webauthn
            .finish_passkey_authentication(credential, &pending.state)
            .map_err(map_webauthn_err)?;
        // Defense-in-depth: the credential the assertion authenticated must be the
        // one this ceremony was issued for. (webauthn-rs scopes the allow-list to
        // the single credential we passed at start, so this is belt-and-braces.)
        if auth_result.cred_id().as_ref() != pending.credential_id.as_slice() {
            return Err(RemoteError::WebAuthnRejected(
                "assertion credential id does not match ceremony".into(),
            ));
        }
        // Fold the verified advance back into the baseline passkey (counter +
        // backup-state). `update_credential` only moves the counter forward and
        // returns None only on a cred-id mismatch (impossible here — we just
        // asserted equality). This produces the credential's NEW system-of-record
        // blob that the caller persists and a later begin_assertion re-derives its
        // baseline from.
        let mut advanced = pending.baseline_passkey;
        let _ = advanced.update_credential(&auth_result);
        let updated_stored = StoredCredential::from_passkey(&advanced)?;
        let assertion = VerifiedAssertion::new_verified(
            pending.owner,
            pending.credential_id,
            updated_stored.sign_count,
        );
        Ok((assertion, updated_stored))
    }

    /// Number of currently-pending registration ceremonies (test/introspection).
    pub fn pending_registration_count(&self) -> usize {
        self.pending_reg.len()
    }

    /// Number of currently-pending assertion ceremonies (test/introspection).
    pub fn pending_assertion_count(&self) -> usize {
        self.pending_auth.len()
    }
}

/// Derive a deterministic per-owner WebAuthn user handle from the owner
/// principal: SHA-256(owner) truncated to the 16 uuid bytes. Deterministic so a
/// re-registration for the same owner uses a stable handle.
fn owner_user_handle(owner: &str) -> Uuid {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(owner.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    Uuid::from_bytes(bytes)
}

/// Read a `Passkey`'s current sign-count by round-tripping its public JSON. We
/// avoid depending on `webauthn-rs`'s `danger-credential-internals` feature
/// (which would expose the inner `Credential`); the serialized form has a
/// top-level `counter` field that is exactly the stored sign-count.
fn counter_of(passkey: &Passkey) -> u32 {
    // The serialized Passkey is `{ "cred": { ... "counter": N ... } }`.
    serde_json::to_value(passkey)
        .ok()
        .and_then(|v| v.get("cred").and_then(|c| c.get("counter")).cloned())
        .and_then(|c| c.as_u64())
        .map(|c| c as u32)
        .unwrap_or(0)
}

/// Map a `webauthn-rs` error to a closed [`RemoteError`]. The cloned-authenticator
/// signal gets its own dedicated variant; everything else is a generic rejection
/// carrying the upstream reason (never an accept, never a panic).
fn map_webauthn_err(e: WebauthnError) -> RemoteError {
    match e {
        WebauthnError::CredentialPossibleCompromise => RemoteError::ClonedAuthenticator,
        other => RemoteError::WebAuthnRejected(format!("{other:?}")),
    }
}
