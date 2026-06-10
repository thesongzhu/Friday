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
use crate::webauthn::VerifiedAttestation;
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
        let device = RegisteredDevice {
            device_id: device_id.to_string(),
            owner: attestation.owner().to_string(),
            rp_id: attestation.rp_id().to_string(),
            credential_id: attestation.credential_id().to_vec(),
            public_key: attestation.public_key().to_vec(),
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
        begin_registration, AcceptingTestVerifier, AttestationResponse, WebAuthnVerifier,
    };

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
}
