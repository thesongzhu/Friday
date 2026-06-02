//! friday-ffi — phone-side FFI surface for Swift (iOS) / Kotlin (Android), via UniFFI.
//!
//! Unit 5a: this crate now exposes a first-slice UniFFI interface (gate `21` §5)
//! and generates idiomatic Swift + Kotlin bindings from one Rust definition
//! (`cargo run -p friday-ffi --bin uniffi-bindgen -- generate --library <cdylib>
//! --language swift|kotlin`). The exposed ops are pure, FFI-safe projections of
//! the slice's connection-state + protocol version-negotiation logic; the
//! model-calling `ask_friday` streaming op and the native app shells land with
//! the Unit-5 native build (operator-gated tooling).
//!
//! Trust boundary: this is the phone-side library. It links `friday-core`,
//! `friday-storage`, `friday-crypto`, `friday-protocol` and deliberately does NOT
//! depend on `friday-deepseek` or a Hub crate, so "no provider secret on phone"
//! is a compile-time property (gate `21` §1/§3), asserted by `friday-arch-tests`.

use friday_core::ConnState;

uniffi::setup_scaffolding!();

/// Connection state of the phone<->Hub link, projected for the UI (gate `21` §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ConnStateFfi {
    Disconnected,
    Connecting,
    Direct,
    Relay,
    Stale,
}

impl From<ConnState> for ConnStateFfi {
    fn from(c: ConnState) -> Self {
        match c {
            ConnState::Disconnected => ConnStateFfi::Disconnected,
            ConnState::Connecting => ConnStateFfi::Connecting,
            ConnState::Direct => ConnStateFfi::Direct,
            ConnState::Relay => ConnStateFfi::Relay,
            ConnState::Stale => ConnStateFfi::Stale,
        }
    }
}

impl ConnStateFfi {
    fn to_core(self) -> ConnState {
        match self {
            ConnStateFfi::Disconnected => ConnState::Disconnected,
            ConnStateFfi::Connecting => ConnState::Connecting,
            ConnStateFfi::Direct => ConnState::Direct,
            ConnStateFfi::Relay => ConnState::Relay,
            ConnStateFfi::Stale => ConnState::Stale,
        }
    }
}

/// Connection state a freshly launched client starts in (exposed to native UI).
#[uniffi::export]
pub fn initial_connection_state() -> ConnStateFfi {
    ConnState::Disconnected.into()
}

/// Whether a connection state is a live, usable link (no model call).
#[uniffi::export]
pub fn connection_is_online(state: ConnStateFfi) -> bool {
    state.to_core().is_online()
}

/// Whether the UI must show a stale/offline truth label (`05` §10).
#[uniffi::export]
pub fn connection_is_stale_or_offline(state: ConnStateFfi) -> bool {
    state.to_core().is_stale_or_offline()
}

/// The wire schema version this build speaks (gate `21` §4.1).
#[uniffi::export]
pub fn protocol_schema_version() -> u16 {
    friday_protocol::CURRENT_SCHEMA_VERSION
}

/// Highest schema version both sides support, or `None` if incompatible
/// (capability negotiation, gate `21` §4.4). Never silently downgrades.
#[uniffi::export]
pub fn negotiate_schema_version(
    local_min: u16,
    local_max: u16,
    remote_min: u16,
    remote_max: u16,
) -> Option<u16> {
    friday_protocol::negotiate_version(
        friday_protocol::VersionRange {
            min: local_min,
            max: local_max,
        },
        friday_protocol::VersionRange {
            min: remote_min,
            max: remote_max,
        },
    )
    .ok()
}

// --- internal (non-FFI) helpers retained for the phone-side runtime/tests ---

/// Open a phone-profile database. The phone schema omits the Hub-only
/// secret/audit tables entirely (gate `21` §2).
pub fn open_phone_db(path: &str) -> friday_storage::Result<friday_storage::Db> {
    friday_storage::Db::open_phone(path)
}

/// Generate a fresh phone-side field-encryption data key.
pub fn new_data_key() -> friday_crypto::DataKey {
    friday_crypto::DataKey::generate()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_db_opens_with_phone_profile_schema() {
        let db = open_phone_db(":memory:").unwrap();
        assert_eq!(db.profile(), friday_storage::Profile::Phone);
        let tables = db.table_names().unwrap();
        assert!(!tables.iter().any(|t| t == "audit_ledger"));
        assert!(tables.iter().any(|t| t == "offline_queue"));
    }

    #[test]
    fn ffi_connection_state_helpers() {
        assert_eq!(initial_connection_state(), ConnStateFfi::Disconnected);
        assert!(connection_is_online(ConnStateFfi::Direct));
        assert!(connection_is_online(ConnStateFfi::Relay));
        assert!(!connection_is_online(ConnStateFfi::Stale));
        assert!(connection_is_stale_or_offline(ConnStateFfi::Stale));
        assert!(connection_is_stale_or_offline(ConnStateFfi::Disconnected));
        let _ = new_data_key();
    }

    #[test]
    fn ffi_protocol_version_helpers() {
        assert_eq!(protocol_schema_version(), 1);
        assert_eq!(negotiate_schema_version(1, 3, 2, 5), Some(3));
        assert_eq!(negotiate_schema_version(1, 1, 2, 4), None);
    }
}
