//! Registered-device data model + in-memory store (R5 slice-1).
//!
//! A `RegisteredDevice` is a WebAuthn-credentialed device bound to an owner
//! principal. This is DISTINCT from `friday-storage`'s `trusted_device` /
//! QR-pairing surface: that is out-of-band QR-secret pairing; this is the
//! `system.remote.*` WebAuthn/passkey surface (register/assert/delete). The two
//! are intentionally not merged — they are different ceremonies with different
//! trust roots.
//!
//! ## Storage choice (this slice)
//! In-memory only. Persistence (a `friday-storage` migration `m00NN` registering
//! `remote_device` in `HUB_ONLY_TABLES` with a forward-migration KAT) is an
//! EXPLICIT deferred slice — see `lib.rs`. Keeping it in-crate means this dark
//! lane touches no shared schema file and cannot collide with concurrent
//! migration lanes.
//!
//! ## Fail-closed
//! [`DeviceStore::register`] accepts ONLY a [`VerifiedAttestation`] — a value
//! that, by the `webauthn` typestate, can only have come from a successful
//! [`crate::webauthn::WebAuthnVerifier`]. There is no `register_unverified`. With
//! the [`crate::webauthn::DeferredVerifier`] in place, no attestation verifies,
//! so no device can be registered yet — fail closed.

use crate::error::{RemoteError, Result};
use crate::webauthn::{VerifiedAssertion, VerifiedAttestation};
use std::collections::HashMap;

/// A registered WebAuthn device row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegisteredDevice {
    /// Stable device id (caller-assigned; unique within the store).
    pub device_id: String,
    /// Owner principal the device is bound to.
    pub owner: String,
    /// Relying-party id the credential is scoped to.
    pub rp_id: String,
    /// WebAuthn credential id (from the verified attestation).
    pub credential_id: Vec<u8>,
    /// Credential public key (from the verified attestation). A real verifier
    /// extracts this from the COSE key in `authData`.
    pub public_key: Vec<u8>,
    /// The authenticator sign-count regression baseline (A8). Seeded from the
    /// verified attestation at registration and advanced (forward-only) on each
    /// verified assertion. A real verifier (see [`crate::real`]) rejects an
    /// assertion whose presented sign-count does not strictly increase over this
    /// stored value (a cloned-authenticator signal); this field is that stored
    /// value. Many synced passkeys keep it 0 forever (spec-legal; see
    /// [`crate::real`]).
    pub sign_count: u32,
    /// Optional human label (e.g. "Jarvis's iPhone").
    pub label: String,
    /// Creation timestamp (ms since epoch; caller-supplied clock).
    pub created_at: i64,
    /// Last time the device was seen (an assertion succeeded / a session
    /// heartbeat referenced it). Starts equal to `created_at`.
    pub last_seen_at: i64,
}

/// In-memory registered-device store keyed by `device_id`.
#[derive(Debug, Default)]
pub struct DeviceStore {
    by_id: HashMap<String, RegisteredDevice>,
}

impl DeviceStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a device from a VERIFIED attestation. Because the only source of
    /// a [`VerifiedAttestation`] is a successful verifier run, an unverified
    /// ceremony can never reach here. A duplicate `device_id` fails closed
    /// (registration is not an upsert).
    ///
    /// The device's `owner`/`rp_id`/`credential_id`/`public_key` come from the
    /// verified attestation, NOT from caller-supplied free input — the caller
    /// cannot smuggle a different owner past verification.
    pub fn register(
        &mut self,
        device_id: &str,
        attestation: &VerifiedAttestation,
        label: &str,
        now: i64,
    ) -> Result<RegisteredDevice> {
        if device_id.trim().is_empty() {
            return Err(RemoteError::InvalidInput("device_id is empty".into()));
        }
        if self.by_id.contains_key(device_id) {
            return Err(RemoteError::DeviceAlreadyRegistered(device_id.to_string()));
        }
        // Credential ids are minted unique by the authenticator. Enforce that
        // uniqueness in the store too, so the credential-id reverse lookup
        // ([`Self::get_by_credential_for_owner`]) is unambiguous (this is the
        // invariant a future persistence slice expresses as a UNIQUE index on the
        // credential column). A second device claiming an already-registered
        // credential id is REFUSED — fail-closed.
        let new_credential_id = attestation.credential_id();
        if self
            .by_id
            .values()
            .any(|d| d.credential_id == new_credential_id)
        {
            return Err(RemoteError::DeviceAlreadyRegistered(format!(
                "credential already registered for device '{device_id}'"
            )));
        }
        let device = RegisteredDevice {
            device_id: device_id.to_string(),
            owner: attestation.owner().to_string(),
            rp_id: attestation.rp_id().to_string(),
            credential_id: attestation.credential_id().to_vec(),
            public_key: attestation.public_key().to_vec(),
            // Seed the sign-count regression baseline from the verified attestation.
            sign_count: attestation.sign_count(),
            label: label.to_string(),
            created_at: now,
            last_seen_at: now,
        };
        self.by_id.insert(device_id.to_string(), device.clone());
        Ok(device)
    }

    /// Look up a device, enforcing owner-scoping. A device that exists but is
    /// owned by a different principal is [`RemoteError::OwnerMismatch`], NOT
    /// found-vs-not-found ambiguity that depends on ownership — existence is only
    /// revealed after the owner check passes.
    pub fn get_for_owner(&self, device_id: &str, owner: &str) -> Result<&RegisteredDevice> {
        let device = self
            .by_id
            .get(device_id)
            .ok_or_else(|| RemoteError::DeviceNotFound(device_id.to_string()))?;
        if device.owner != owner {
            return Err(RemoteError::OwnerMismatch);
        }
        Ok(device)
    }

    /// Internal owner-agnostic lookup (used by the session layer, which has
    /// already established the owner via its own check). Not public.
    pub(crate) fn get(&self, device_id: &str) -> Option<&RegisteredDevice> {
        self.by_id.get(device_id)
    }

    /// List a single owner's devices, ordered by `created_at` then `device_id`.
    /// Never returns another owner's devices.
    pub fn list_for_owner(&self, owner: &str) -> Vec<RegisteredDevice> {
        let mut out: Vec<RegisteredDevice> = self
            .by_id
            .values()
            .filter(|d| d.owner == owner)
            .cloned()
            .collect();
        out.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.device_id.cmp(&b.device_id))
        });
        out
    }

    /// Update `last_seen_at` (forward-only — refuses to move it backwards, so a
    /// stale/replayed timestamp cannot rewind it). Owner-scoped.
    pub fn touch_for_owner(&mut self, device_id: &str, owner: &str, now: i64) -> Result<()> {
        let device = self
            .by_id
            .get_mut(device_id)
            .ok_or_else(|| RemoteError::DeviceNotFound(device_id.to_string()))?;
        if device.owner != owner {
            return Err(RemoteError::OwnerMismatch);
        }
        if now > device.last_seen_at {
            device.last_seen_at = now;
        }
        Ok(())
    }

    /// Resolve the registered device for a WebAuthn `credential_id`, owner-scoped.
    /// A WebAuthn assertion identifies the authenticator by credential id (not by
    /// our internal `device_id`), so the assert path needs this reverse lookup.
    ///
    /// Returns:
    /// * [`RemoteError::UnknownCredential`] if NO device with that credential id
    ///   is registered — fail-closed, and the `UnknownCredential` variant (already
    ///   in the taxonomy) is exactly the right "no such credential" signal;
    /// * [`RemoteError::OwnerMismatch`] if a device with that credential id exists
    ///   but is owned by a different principal — cross-owner resolution is refused
    ///   (existence is revealed only after the owner check passes).
    ///
    /// Credential ids are unique within the store ([`Self::register`] refuses a
    /// duplicate live credential id), so the in-memory scan's first match is
    /// unambiguous.
    pub fn get_by_credential_for_owner(
        &self,
        credential_id: &[u8],
        owner: &str,
    ) -> Result<&RegisteredDevice> {
        let device = self
            .by_id
            .values()
            .find(|d| d.credential_id == credential_id)
            .ok_or(RemoteError::UnknownCredential)?;
        if device.owner != owner {
            return Err(RemoteError::OwnerMismatch);
        }
        Ok(device)
    }

    /// Apply a VERIFIED assertion: advance the matching device's `last_seen_at`
    /// (forward-only) and return the device. This is the assert-path counterpart
    /// of [`DeviceStore::register`]'s verify→register: only a successful
    /// [`crate::webauthn::WebAuthnVerifier::verify_assertion`] can mint a
    /// [`VerifiedAssertion`] (no public constructor), so an unverified assertion
    /// can never reach here — the same typestate fail-closed guarantee as
    /// registration.
    ///
    /// Resolution is by the assertion's `credential_id`, scoped to the assertion's
    /// own `owner`. If no device matches the credential id the call fails closed
    /// ([`RemoteError::UnknownCredential`]); a credential owned by a different
    /// principal is [`RemoteError::OwnerMismatch`]. The owner is taken from the
    /// verified assertion itself, NOT from caller free-input, so a caller cannot
    /// smuggle a different owner past verification.
    pub fn apply_assertion(
        &mut self,
        assertion: &VerifiedAssertion,
        now: i64,
    ) -> Result<RegisteredDevice> {
        // Locate the device id under an owner-scoped, fail-closed lookup first so
        // we never touch a cross-owner device. (An immutable borrow that ends
        // before the mutation below.)
        let device_id = self
            .get_by_credential_for_owner(assertion.credential_id(), assertion.owner())?
            .device_id
            .clone();
        // We just resolved this id under the assertion's owner, so the mutable
        // re-borrow is guaranteed present and owner-matched. Advance last_seen_at
        // forward-only (a stale/replayed assertion timestamp cannot rewind it),
        // then return the updated row — no `expect`/`unwrap` on any path.
        let device = self
            .by_id
            .get_mut(&device_id)
            .ok_or_else(|| RemoteError::DeviceNotFound(device_id.clone()))?;
        if now > device.last_seen_at {
            device.last_seen_at = now;
        }
        // Advance this row's sign-count PROJECTION (forward-only). IMPORTANT: this
        // `RegisteredDevice.sign_count` is a human-/audit-facing projection, NOT
        // the value the real verifier compares against. The verifier
        // (crate::real::RealWebAuthn) checks the counter inside the credential blob
        // (`StoredCredential` / the serialized `Passkey`) it is handed at
        // `begin_assertion`; the loop that actually enforces regression across
        // ceremonies is "persist the updated `StoredCredential` that
        // `finish_assertion` returns, then re-derive the next baseline from it".
        // Where the authoritative blob lives in a device row (and whether this
        // `u32` is folded into it or dropped) is a deferred persistence-schema
        // decision — see this crate's open questions. Forward-only here so a stale
        // value cannot rewind the projection.
        let asserted = assertion.new_sign_count();
        if asserted > device.sign_count {
            device.sign_count = asserted;
        }
        Ok(device.clone())
    }

    /// Delete a device, owner-scoped. A missing device is
    /// [`RemoteError::DeviceNotFound`]; another owner's device is
    /// [`RemoteError::OwnerMismatch`] and is NOT deleted.
    pub fn delete_for_owner(&mut self, device_id: &str, owner: &str) -> Result<()> {
        match self.by_id.get(device_id) {
            None => Err(RemoteError::DeviceNotFound(device_id.to_string())),
            Some(d) if d.owner != owner => Err(RemoteError::OwnerMismatch),
            Some(_) => {
                self.by_id.remove(device_id);
                Ok(())
            }
        }
    }

    /// Number of registered devices (all owners). Test/introspection helper.
    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webauthn::{
        begin_assertion, begin_registration, AcceptingTestVerifier, AssertionResponse,
        AttestationResponse, WebAuthnVerifier,
    };

    /// Mint a VerifiedAssertion for `owner`/`cred` via the test verifier (the only
    /// in-crate path to a verified token). The verifier enforces the credential-id
    /// binding, so this mirrors a real successful assertion.
    fn verified_assertion(owner: &str, cred: Vec<u8>) -> VerifiedAssertion {
        let chal = begin_assertion(owner, "friday.local", cred.clone(), vec![5, 6, 7]).unwrap();
        let resp = AssertionResponse {
            credential_id: cred,
            authenticator_data: vec![1],
            client_data_json: br#"{"type":"webauthn.get"}"#.to_vec(),
            signature: vec![0xde, 0xad],
        };
        AcceptingTestVerifier
            .verify_assertion(&chal, &resp, &[0x04, 0x01, 0x02])
            .expect("test verifier accepts a matching credential")
    }

    fn verified_attestation(owner: &str, cred: Vec<u8>) -> VerifiedAttestation {
        let chal = begin_registration(owner, "friday.local", vec![1, 2, 3]).unwrap();
        let resp = AttestationResponse {
            credential_id: cred,
            attestation_object: vec![0xa0],
            client_data_json: b"{}".to_vec(),
        };
        AcceptingTestVerifier
            .verify_registration(&chal, &resp)
            .expect("test verifier accepts")
    }

    #[test]
    fn register_then_lookup_happy_path() {
        let mut store = DeviceStore::new();
        let att = verified_attestation("owner-1", vec![7, 7, 7]);
        let dev = store.register("dev-1", &att, "Phone", 1000).unwrap();
        assert_eq!(dev.owner, "owner-1");
        assert_eq!(dev.credential_id, vec![7, 7, 7]);
        assert_eq!(dev.created_at, 1000);
        assert_eq!(dev.last_seen_at, 1000);
        // Lookup by the right owner succeeds.
        let got = store.get_for_owner("dev-1", "owner-1").unwrap();
        assert_eq!(got.device_id, "dev-1");
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn register_rejects_duplicate_device_id() {
        let mut store = DeviceStore::new();
        let att = verified_attestation("owner-1", vec![1]);
        store.register("dev-1", &att, "", 1).unwrap();
        let att2 = verified_attestation("owner-1", vec![2]);
        assert_eq!(
            store.register("dev-1", &att2, "", 2),
            Err(RemoteError::DeviceAlreadyRegistered("dev-1".into()))
        );
    }

    #[test]
    fn register_rejects_duplicate_credential_id() {
        let mut store = DeviceStore::new();
        let att = verified_attestation("owner-1", vec![7, 7, 7]);
        store.register("dev-1", &att, "", 1).unwrap();
        // A different device_id but the SAME credential id is refused — credential
        // ids are unique within the store (fail-closed), even across owners.
        let att_same_cred = verified_attestation("owner-2", vec![7, 7, 7]);
        assert!(matches!(
            store.register("dev-2", &att_same_cred, "", 2),
            Err(RemoteError::DeviceAlreadyRegistered(_))
        ));
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn register_rejects_empty_device_id() {
        let mut store = DeviceStore::new();
        let att = verified_attestation("owner-1", vec![1]);
        assert!(matches!(
            store.register("", &att, "", 1),
            Err(RemoteError::InvalidInput(_))
        ));
    }

    #[test]
    fn lookup_other_owner_is_mismatch_not_found() {
        let mut store = DeviceStore::new();
        let att = verified_attestation("owner-1", vec![1]);
        store.register("dev-1", &att, "", 1).unwrap();
        // Wrong owner ⇒ OwnerMismatch (refused), not a leak of existence as found.
        assert_eq!(
            store.get_for_owner("dev-1", "owner-2"),
            Err(RemoteError::OwnerMismatch)
        );
        // Missing id ⇒ DeviceNotFound.
        assert!(matches!(
            store.get_for_owner("nope", "owner-1"),
            Err(RemoteError::DeviceNotFound(_))
        ));
    }

    #[test]
    fn touch_is_forward_only_and_owner_scoped() {
        let mut store = DeviceStore::new();
        let att = verified_attestation("owner-1", vec![1]);
        store.register("dev-1", &att, "", 100).unwrap();
        // Backwards timestamp does not rewind last_seen_at.
        store.touch_for_owner("dev-1", "owner-1", 50).unwrap();
        assert_eq!(
            store
                .get_for_owner("dev-1", "owner-1")
                .unwrap()
                .last_seen_at,
            100
        );
        // Forward timestamp advances it.
        store.touch_for_owner("dev-1", "owner-1", 200).unwrap();
        assert_eq!(
            store
                .get_for_owner("dev-1", "owner-1")
                .unwrap()
                .last_seen_at,
            200
        );
        // Wrong owner refused.
        assert_eq!(
            store.touch_for_owner("dev-1", "owner-2", 300),
            Err(RemoteError::OwnerMismatch)
        );
    }

    #[test]
    fn delete_owner_scoped() {
        let mut store = DeviceStore::new();
        let att = verified_attestation("owner-1", vec![1]);
        store.register("dev-1", &att, "", 1).unwrap();
        // Another owner cannot delete it.
        assert_eq!(
            store.delete_for_owner("dev-1", "owner-2"),
            Err(RemoteError::OwnerMismatch)
        );
        assert_eq!(store.len(), 1);
        // The real owner can.
        store.delete_for_owner("dev-1", "owner-1").unwrap();
        assert!(store.is_empty());
        // Re-delete ⇒ not found.
        assert!(matches!(
            store.delete_for_owner("dev-1", "owner-1"),
            Err(RemoteError::DeviceNotFound(_))
        ));
    }

    #[test]
    fn list_for_owner_isolates_owners() {
        let mut store = DeviceStore::new();
        store
            .register("a", &verified_attestation("owner-1", vec![1]), "", 1)
            .unwrap();
        store
            .register("b", &verified_attestation("owner-2", vec![2]), "", 2)
            .unwrap();
        store
            .register("c", &verified_attestation("owner-1", vec![3]), "", 3)
            .unwrap();
        let o1 = store.list_for_owner("owner-1");
        assert_eq!(o1.len(), 2);
        assert!(o1.iter().all(|d| d.owner == "owner-1"));
        assert_eq!(store.list_for_owner("owner-2").len(), 1);
        assert_eq!(store.list_for_owner("owner-3").len(), 0);
    }

    // ---- slice-2: assert-path linkage (credential resolve + apply_assertion) ----

    #[test]
    fn get_by_credential_for_owner_resolves_and_scopes() {
        let mut store = DeviceStore::new();
        store
            .register(
                "dev-1",
                &verified_attestation("owner-1", vec![7, 7, 7]),
                "",
                1,
            )
            .unwrap();
        // Correct owner + credential ⇒ resolves to the device.
        let d = store
            .get_by_credential_for_owner(&[7, 7, 7], "owner-1")
            .unwrap();
        assert_eq!(d.device_id, "dev-1");
        // Unknown credential ⇒ UnknownCredential (fail-closed).
        assert_eq!(
            store.get_by_credential_for_owner(&[0, 0, 0], "owner-1"),
            Err(RemoteError::UnknownCredential)
        );
        // Right credential, WRONG owner ⇒ OwnerMismatch (cross-owner refused).
        assert_eq!(
            store.get_by_credential_for_owner(&[7, 7, 7], "owner-2"),
            Err(RemoteError::OwnerMismatch)
        );
    }

    #[test]
    fn apply_assertion_touches_matching_device_forward_only() {
        let mut store = DeviceStore::new();
        store
            .register(
                "dev-1",
                &verified_attestation("owner-1", vec![7, 7, 7]),
                "",
                100,
            )
            .unwrap();
        // A verified assertion for the registered credential advances last_seen_at.
        let assertion = verified_assertion("owner-1", vec![7, 7, 7]);
        let touched = store.apply_assertion(&assertion, 500).unwrap();
        assert_eq!(touched.device_id, "dev-1");
        assert_eq!(touched.last_seen_at, 500);
        // Forward-only: a stale/replayed assertion timestamp cannot rewind it.
        let stale = verified_assertion("owner-1", vec![7, 7, 7]);
        let again = store.apply_assertion(&stale, 200).unwrap();
        assert_eq!(again.last_seen_at, 500);
    }

    #[test]
    fn apply_assertion_advances_sign_count_forward_only() {
        // A8: the store advances its sign-count regression baseline to the
        // verified assertion's value (forward-only). The verifier (crate::real)
        // already proved the strict increase; this pins the store's persistence of
        // it. We mint VerifiedAssertions directly via the pub(crate) constructor to
        // control the sign-count (the AcceptingTestVerifier always emits 0).
        let mut store = DeviceStore::new();
        store
            .register(
                "dev-1",
                &verified_attestation("owner-1", vec![7, 7, 7]),
                "",
                100,
            )
            .unwrap();
        assert_eq!(
            store.get_for_owner("dev-1", "owner-1").unwrap().sign_count,
            0
        );

        // Assertion presenting sign-count 5 advances the baseline to 5.
        let a5 = VerifiedAssertion::new_verified("owner-1".into(), vec![7, 7, 7], 5);
        let d = store.apply_assertion(&a5, 200).unwrap();
        assert_eq!(d.sign_count, 5);

        // A later assertion presenting a LOWER count (3) does NOT rewind the stored
        // baseline (forward-only, belt-and-braces). (The real verifier would have
        // rejected such an assertion outright as a clone before it ever reached
        // here; this guards a verifier that returned a stale value.)
        let a3 = VerifiedAssertion::new_verified("owner-1".into(), vec![7, 7, 7], 3);
        let d = store.apply_assertion(&a3, 300).unwrap();
        assert_eq!(d.sign_count, 5, "stored sign-count must not rewind");
    }

    #[test]
    fn apply_assertion_for_unregistered_credential_fails_closed() {
        let mut store = DeviceStore::new();
        store
            .register(
                "dev-1",
                &verified_attestation("owner-1", vec![7, 7, 7]),
                "",
                1,
            )
            .unwrap();
        // Verified assertion, but for a credential that is NOT registered.
        let assertion = verified_assertion("owner-1", vec![9, 9, 9]);
        assert_eq!(
            store.apply_assertion(&assertion, 10),
            Err(RemoteError::UnknownCredential)
        );
    }

    #[test]
    fn apply_assertion_cannot_touch_another_owners_device() {
        let mut store = DeviceStore::new();
        // Device with credential [7,7,7] is owned by owner-1.
        store
            .register(
                "dev-1",
                &verified_attestation("owner-1", vec![7, 7, 7]),
                "",
                1,
            )
            .unwrap();
        // A (verified) assertion that claims owner-2 for the SAME credential id is
        // refused — the owner is bound into the verified assertion, and the device
        // belongs to owner-1, so resolution fails closed with OwnerMismatch. The
        // device is NOT touched.
        let assertion = verified_assertion("owner-2", vec![7, 7, 7]);
        assert_eq!(
            store.apply_assertion(&assertion, 999),
            Err(RemoteError::OwnerMismatch)
        );
        assert_eq!(
            store
                .get_for_owner("dev-1", "owner-1")
                .unwrap()
                .last_seen_at,
            1
        );
    }
}
