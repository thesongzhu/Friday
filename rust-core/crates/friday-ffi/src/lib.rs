//! friday-ffi — phone-side FFI surface (Swift/Kotlin).
//!
//! **Unit-2 status: dependency-boundary stub.** It links the phone-side crates
//! (`friday-core`, `friday-storage`, `friday-crypto`) and deliberately does NOT
//! depend on `friday-deepseek` or a Hub crate, so "no provider secret on phone"
//! is a compile-time property (gate 21 §1/§3), asserted by `friday-arch-tests`.
//!
//! The UniFFI bindings and the first-slice client API (pairing, connection
//! state, ask-friday, ledger/activity reads, offline state) land in **Unit 5**.

use friday_core::ConnState;

/// Open a phone-profile database. The phone schema omits the Hub-only
/// secret/audit tables entirely (gate 21 §2).
pub fn open_phone_db(path: &str) -> friday_storage::Result<friday_storage::Db> {
    friday_storage::Db::open_phone(path)
}

/// Generate a fresh phone-side field-encryption data key.
pub fn new_data_key() -> friday_crypto::DataKey {
    friday_crypto::DataKey::generate()
}

/// Connection state a freshly launched client starts in.
pub fn initial_conn_state() -> ConnState {
    ConnState::Disconnected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_db_opens_with_phone_profile_schema() {
        // In-memory phone DB: no Hub-only tables exist here.
        let db = open_phone_db(":memory:").unwrap();
        assert_eq!(db.profile(), friday_storage::Profile::Phone);
        let tables = db.table_names().unwrap();
        assert!(!tables.iter().any(|t| t == "audit_ledger"));
        assert!(tables.iter().any(|t| t == "offline_queue"));
    }

    #[test]
    fn initial_state_is_disconnected() {
        assert_eq!(initial_conn_state(), ConnState::Disconnected);
        let _ = new_data_key();
    }
}
