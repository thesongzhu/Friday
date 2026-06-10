//! Remote-session lifecycle + in-memory store (R5 slice-1).
//!
//! A `RemoteSession` is a live remote-control session bound to a registered
//! device and its owner. Lifecycle: **create → heartbeat (refresh expiry) →
//! delete**, with explicit expiry. The expiry discipline mirrors the
//! lease/watermark discipline in `friday-storage::schedule` (monotonic, refuses
//! to rewind, an expired holder is dead).
//!
//! ## Expiry semantics (fail-closed)
//! * `create(now, ttl)` sets `expires_at = now + ttl`.
//! * `heartbeat(now, ttl)` on a LIVE session (now < expires_at) extends
//!   `expires_at = now + ttl` and bumps `heartbeat_at`.
//! * `heartbeat(now, ttl)` on an EXPIRED session (now >= expires_at) is REFUSED
//!   with [`RemoteError::SessionExpired`] — an expired session is DEAD and cannot
//!   be revived; it can only be deleted. This is the fail-closed rule the KAT
//!   pins.
//! * Any read/op on an expired session is treated as expired (fail-closed),
//!   never as a still-live session.
//!
//! ## Storage choice
//! In-memory only; persistence deferred (see `lib.rs`), same rationale as
//! [`crate::device`].

use crate::device::DeviceStore;
use crate::error::{RemoteError, Result};
use std::collections::HashMap;

/// Lifecycle state of a remote session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    /// Created and within its expiry window.
    Active,
    /// Past `expires_at` (computed against a supplied clock). Terminal for
    /// liveness — only deletion is valid.
    Expired,
}

/// A remote-control session row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteSession {
    pub session_id: String,
    /// The registered device this session controls.
    pub device_id: String,
    /// Owner principal (must match the device's owner at create time).
    pub owner: String,
    pub created_at: i64,
    /// Last heartbeat timestamp (starts equal to `created_at`).
    pub heartbeat_at: i64,
    /// Absolute expiry (ms since epoch). `now >= expires_at` ⇒ expired.
    pub expires_at: i64,
}

impl RemoteSession {
    /// Derive the lifecycle state against a clock. An expired session reports
    /// [`SessionState::Expired`] (fail-closed; never silently Active).
    pub fn state_at(&self, now: i64) -> SessionState {
        if now >= self.expires_at {
            SessionState::Expired
        } else {
            SessionState::Active
        }
    }

    /// Convenience: is this session expired at `now`?
    pub fn is_expired_at(&self, now: i64) -> bool {
        self.state_at(now) == SessionState::Expired
    }
}

/// In-memory remote-session store keyed by `session_id`.
#[derive(Debug, Default)]
pub struct SessionStore {
    by_id: HashMap<String, RemoteSession>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a remote session for a registered device. Fails closed if:
    /// * the device is not registered ([`RemoteError::DeviceNotFound`]);
    /// * the device is owned by a different principal
    ///   ([`RemoteError::OwnerMismatch`]) — a session cannot be opened against
    ///   another owner's device;
    /// * the `ttl_ms` is non-positive ([`RemoteError::InvalidInput`]);
    /// * the `session_id` is empty or already exists.
    ///
    /// The `devices` store is consulted to bind the session to a REAL,
    /// owner-matched device — a session id alone never grants control.
    pub fn create(
        &mut self,
        devices: &DeviceStore,
        session_id: &str,
        device_id: &str,
        owner: &str,
        now: i64,
        ttl_ms: i64,
    ) -> Result<RemoteSession> {
        if session_id.trim().is_empty() {
            return Err(RemoteError::InvalidInput("session_id is empty".into()));
        }
        if ttl_ms <= 0 {
            return Err(RemoteError::InvalidInput("ttl_ms must be positive".into()));
        }
        // Bind to a real, owner-matched device.
        let device = devices
            .get(device_id)
            .ok_or_else(|| RemoteError::DeviceNotFound(device_id.to_string()))?;
        if device.owner != owner {
            return Err(RemoteError::OwnerMismatch);
        }
        if self.by_id.contains_key(session_id) {
            return Err(RemoteError::InvalidInput(format!(
                "session_id '{session_id}' already exists"
            )));
        }
        let expires_at = now.saturating_add(ttl_ms);
        let session = RemoteSession {
            session_id: session_id.to_string(),
            device_id: device_id.to_string(),
            owner: owner.to_string(),
            created_at: now,
            heartbeat_at: now,
            expires_at,
        };
        self.by_id.insert(session_id.to_string(), session.clone());
        Ok(session)
    }

    /// Read a session, owner-scoped. Does NOT consider expiry (caller can check
    /// [`RemoteSession::state_at`]); existence is revealed only after the owner
    /// check passes.
    pub fn get_for_owner(&self, session_id: &str, owner: &str) -> Result<&RemoteSession> {
        let s = self
            .by_id
            .get(session_id)
            .ok_or_else(|| RemoteError::SessionNotFound(session_id.to_string()))?;
        if s.owner != owner {
            return Err(RemoteError::OwnerMismatch);
        }
        Ok(s)
    }

    /// Heartbeat a session: refresh its expiry to `now + ttl_ms` and bump
    /// `heartbeat_at`. Fails closed if:
    /// * the session does not exist ([`RemoteError::SessionNotFound`]);
    /// * the owner does not match ([`RemoteError::OwnerMismatch`]);
    /// * `ttl_ms` is non-positive;
    /// * the session is ALREADY EXPIRED at `now` ([`RemoteError::SessionExpired`])
    ///   — an expired session is dead and cannot be revived by heartbeat;
    /// * the BOUND DEVICE is no longer registered or no longer owner-matched
    ///   ([`RemoteError::DeviceNotFound`] / [`RemoteError::OwnerMismatch`]) — a
    ///   session must not outlive the device it controls. Without this check a
    ///   deleted/revoked device left its sessions heartbeatable-alive forever
    ///   (slice-1 gap). Revoking the device now severs liveness on the next
    ///   heartbeat — fail-closed. The session row itself is NOT mutated when the
    ///   device check fails, so a refused heartbeat leaves the prior expiry intact
    ///   (the session still expires on its own clock and can be deleted).
    pub fn heartbeat(
        &mut self,
        devices: &DeviceStore,
        session_id: &str,
        owner: &str,
        now: i64,
        ttl_ms: i64,
    ) -> Result<RemoteSession> {
        if ttl_ms <= 0 {
            return Err(RemoteError::InvalidInput("ttl_ms must be positive".into()));
        }
        // Read-phase: validate owner, liveness, and the bound device WITHOUT
        // mutating, so any refusal leaves the session row untouched.
        let s = self
            .by_id
            .get(session_id)
            .ok_or_else(|| RemoteError::SessionNotFound(session_id.to_string()))?;
        if s.owner != owner {
            return Err(RemoteError::OwnerMismatch);
        }
        if now >= s.expires_at {
            // Dead. Do not revive. Fail closed.
            return Err(RemoteError::SessionExpired);
        }
        // Re-validate the bound device: it must still be registered AND still
        // owner-matched. A device deleted or re-owned out from under the session
        // severs the session's liveness here (fail-closed) rather than letting an
        // orphaned session be heartbeated indefinitely.
        devices.get_for_owner(&s.device_id, owner)?;
        // Mutate-phase: all checks passed; refresh.
        let s = self
            .by_id
            .get_mut(session_id)
            .ok_or_else(|| RemoteError::SessionNotFound(session_id.to_string()))?;
        s.heartbeat_at = now;
        s.expires_at = now.saturating_add(ttl_ms);
        Ok(s.clone())
    }

    /// Delete a session, owner-scoped. A missing session is
    /// [`RemoteError::SessionNotFound`]; another owner's session is
    /// [`RemoteError::OwnerMismatch`] and is NOT deleted. An EXPIRED session CAN
    /// be deleted (deletion is the valid terminal op for a dead session).
    pub fn delete_for_owner(&mut self, session_id: &str, owner: &str) -> Result<()> {
        match self.by_id.get(session_id) {
            None => Err(RemoteError::SessionNotFound(session_id.to_string())),
            Some(s) if s.owner != owner => Err(RemoteError::OwnerMismatch),
            Some(_) => {
                self.by_id.remove(session_id);
                Ok(())
            }
        }
    }

    /// List an owner's sessions ordered by `created_at` then `session_id`. Never
    /// returns another owner's sessions.
    pub fn list_for_owner(&self, owner: &str) -> Vec<RemoteSession> {
        let mut out: Vec<RemoteSession> = self
            .by_id
            .values()
            .filter(|s| s.owner == owner)
            .cloned()
            .collect();
        out.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        out
    }

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

    /// Build a DeviceStore holding one registered device for `owner`/`device_id`.
    fn store_with_device(owner: &str, device_id: &str) -> DeviceStore {
        let mut devices = DeviceStore::new();
        let chal = begin_registration(owner, "friday.local", vec![1, 2, 3]).unwrap();
        let resp = AttestationResponse {
            credential_id: vec![7, 7, 7],
            attestation_object: vec![0xa0],
            client_data_json: b"{}".to_vec(),
        };
        let att = AcceptingTestVerifier
            .verify_registration(&chal, &resp)
            .unwrap();
        devices.register(device_id, &att, "", 0).unwrap();
        devices
    }

    #[test]
    fn create_heartbeat_expire_delete_lifecycle() {
        let devices = store_with_device("owner-1", "dev-1");
        let mut sessions = SessionStore::new();

        // create: expires_at = now + ttl
        let s = sessions
            .create(&devices, "sess-1", "dev-1", "owner-1", 1_000, 500)
            .unwrap();
        assert_eq!(s.expires_at, 1_500);
        assert_eq!(s.state_at(1_400), SessionState::Active);

        // heartbeat while live: refresh expiry forward, bump heartbeat_at.
        let s2 = sessions
            .heartbeat(&devices, "sess-1", "owner-1", 1_400, 500)
            .unwrap();
        assert_eq!(s2.heartbeat_at, 1_400);
        assert_eq!(s2.expires_at, 1_900);

        // at/after expires_at ⇒ Expired (fail-closed read).
        let s3 = sessions.get_for_owner("sess-1", "owner-1").unwrap();
        assert_eq!(s3.state_at(1_900), SessionState::Expired);
        assert!(s3.is_expired_at(2_000));

        // delete the (now-dead) session.
        sessions.delete_for_owner("sess-1", "owner-1").unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn heartbeat_on_expired_session_is_refused() {
        let devices = store_with_device("owner-1", "dev-1");
        let mut sessions = SessionStore::new();
        sessions
            .create(&devices, "sess-1", "dev-1", "owner-1", 1_000, 100)
            .unwrap();
        // expires_at = 1_100; heartbeat at exactly 1_100 (>=) ⇒ expired, refused.
        assert_eq!(
            sessions.heartbeat(&devices, "sess-1", "owner-1", 1_100, 100),
            Err(RemoteError::SessionExpired)
        );
        // and well past expiry too.
        assert_eq!(
            sessions.heartbeat(&devices, "sess-1", "owner-1", 5_000, 100),
            Err(RemoteError::SessionExpired)
        );
        // An expired session can still be DELETED (valid terminal op).
        sessions.delete_for_owner("sess-1", "owner-1").unwrap();
    }

    #[test]
    fn create_requires_real_owner_matched_device() {
        let devices = store_with_device("owner-1", "dev-1");
        let mut sessions = SessionStore::new();
        // Unknown device ⇒ DeviceNotFound.
        assert!(matches!(
            sessions.create(&devices, "s", "nope", "owner-1", 1, 10),
            Err(RemoteError::DeviceNotFound(_))
        ));
        // Real device, WRONG owner ⇒ OwnerMismatch (cannot open a session against
        // another owner's device).
        assert_eq!(
            sessions.create(&devices, "s", "dev-1", "owner-2", 1, 10),
            Err(RemoteError::OwnerMismatch)
        );
        assert!(sessions.is_empty());
    }

    #[test]
    fn create_rejects_bad_inputs_and_duplicate() {
        let devices = store_with_device("owner-1", "dev-1");
        let mut sessions = SessionStore::new();
        // empty session id
        assert!(matches!(
            sessions.create(&devices, "", "dev-1", "owner-1", 1, 10),
            Err(RemoteError::InvalidInput(_))
        ));
        // non-positive ttl
        assert!(matches!(
            sessions.create(&devices, "s", "dev-1", "owner-1", 1, 0),
            Err(RemoteError::InvalidInput(_))
        ));
        assert!(matches!(
            sessions.create(&devices, "s", "dev-1", "owner-1", 1, -5),
            Err(RemoteError::InvalidInput(_))
        ));
        // duplicate id
        sessions
            .create(&devices, "s", "dev-1", "owner-1", 1, 10)
            .unwrap();
        assert!(matches!(
            sessions.create(&devices, "s", "dev-1", "owner-1", 1, 10),
            Err(RemoteError::InvalidInput(_))
        ));
    }

    #[test]
    fn session_ops_are_owner_scoped() {
        let devices = store_with_device("owner-1", "dev-1");
        let mut sessions = SessionStore::new();
        sessions
            .create(&devices, "sess-1", "dev-1", "owner-1", 1_000, 1_000)
            .unwrap();
        // Wrong owner cannot read, heartbeat, or delete.
        assert_eq!(
            sessions.get_for_owner("sess-1", "owner-2"),
            Err(RemoteError::OwnerMismatch)
        );
        assert_eq!(
            sessions.heartbeat(&devices, "sess-1", "owner-2", 1_100, 1_000),
            Err(RemoteError::OwnerMismatch)
        );
        assert_eq!(
            sessions.delete_for_owner("sess-1", "owner-2"),
            Err(RemoteError::OwnerMismatch)
        );
        // still present
        assert_eq!(sessions.len(), 1);
    }

    #[test]
    fn heartbeat_and_delete_missing_session_fail_closed() {
        let devices = DeviceStore::new();
        let mut sessions = SessionStore::new();
        assert!(matches!(
            sessions.heartbeat(&devices, "ghost", "owner-1", 1, 10),
            Err(RemoteError::SessionNotFound(_))
        ));
        assert!(matches!(
            sessions.delete_for_owner("ghost", "owner-1"),
            Err(RemoteError::SessionNotFound(_))
        ));
    }

    #[test]
    fn list_for_owner_isolates_owners() {
        let mut devices = store_with_device("owner-1", "dev-1");
        // second device for owner-2
        let chal = begin_registration("owner-2", "friday.local", vec![9]).unwrap();
        let resp = AttestationResponse {
            credential_id: vec![8],
            attestation_object: vec![0xa0],
            client_data_json: b"{}".to_vec(),
        };
        let att = AcceptingTestVerifier
            .verify_registration(&chal, &resp)
            .unwrap();
        devices.register("dev-2", &att, "", 0).unwrap();

        let mut sessions = SessionStore::new();
        sessions
            .create(&devices, "s1", "dev-1", "owner-1", 1, 100)
            .unwrap();
        sessions
            .create(&devices, "s2", "dev-2", "owner-2", 2, 100)
            .unwrap();
        assert_eq!(sessions.list_for_owner("owner-1").len(), 1);
        assert_eq!(sessions.list_for_owner("owner-2").len(), 1);
        assert!(sessions
            .list_for_owner("owner-1")
            .iter()
            .all(|s| s.owner == "owner-1"));
    }

    // ---- slice-2: heartbeat re-validates the bound device (fail-closed) ----

    #[test]
    fn heartbeat_refused_after_bound_device_is_deleted() {
        let mut devices = store_with_device("owner-1", "dev-1");
        let mut sessions = SessionStore::new();
        sessions
            .create(&devices, "sess-1", "dev-1", "owner-1", 1_000, 1_000)
            .unwrap();
        // While the device is live, heartbeat works.
        sessions
            .heartbeat(&devices, "sess-1", "owner-1", 1_100, 1_000)
            .unwrap();
        // Revoke (delete) the device the session controls.
        devices.delete_for_owner("dev-1", "owner-1").unwrap();
        // The session is still within its own expiry window, but its bound device
        // is gone ⇒ heartbeat is now REFUSED (fail-closed); a revoked device must
        // not keep its sessions alive.
        assert!(matches!(
            sessions.heartbeat(&devices, "sess-1", "owner-1", 1_200, 1_000),
            Err(RemoteError::DeviceNotFound(_))
        ));
        // The refused heartbeat did NOT mutate the session; it still expires on
        // its prior clock and can be deleted (the valid terminal op).
        let s = sessions.get_for_owner("sess-1", "owner-1").unwrap();
        assert_eq!(s.expires_at, 2_100); // from the 1_100 heartbeat, unchanged
        sessions.delete_for_owner("sess-1", "owner-1").unwrap();
    }

    #[test]
    fn heartbeat_refused_when_device_reowned() {
        // Device re-owned out from under a session ⇒ OwnerMismatch on heartbeat.
        // (Modelled by deleting dev-1 and re-registering the same device_id to a
        // different owner; the session still references owner-1.)
        let mut devices = store_with_device("owner-1", "dev-1");
        let mut sessions = SessionStore::new();
        sessions
            .create(&devices, "sess-1", "dev-1", "owner-1", 1_000, 1_000)
            .unwrap();
        devices.delete_for_owner("dev-1", "owner-1").unwrap();
        // Re-register the same device_id under owner-2.
        let chal = begin_registration("owner-2", "friday.local", vec![1, 2, 3]).unwrap();
        let resp = AttestationResponse {
            credential_id: vec![7, 7, 7],
            attestation_object: vec![0xa0],
            client_data_json: b"{}".to_vec(),
        };
        let att = AcceptingTestVerifier
            .verify_registration(&chal, &resp)
            .unwrap();
        devices.register("dev-1", &att, "", 0).unwrap();
        // owner-1's session can no longer heartbeat the now-owner-2 device.
        assert_eq!(
            sessions.heartbeat(&devices, "sess-1", "owner-1", 1_200, 1_000),
            Err(RemoteError::OwnerMismatch)
        );
    }
}
