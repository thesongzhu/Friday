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

use friday_core::{ConnState, NeedsMeItem};

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

/// A cross-source "Needs Me" action item for the Activity inbox (`08` §1/§2),
/// projected for native UI. Carries the provider detail (reason/destination) so
/// nothing is silently dropped.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NeedsMeItemFfi {
    pub source: String,
    pub id: String,
    pub reason: String,
    /// Higher = more urgent.
    pub priority: u8,
    pub destination: String,
}

impl From<NeedsMeItem> for NeedsMeItemFfi {
    fn from(i: NeedsMeItem) -> Self {
        NeedsMeItemFfi {
            source: i.source,
            id: i.id,
            reason: i.reason,
            priority: i.priority,
            destination: i.destination,
        }
    }
}

impl From<NeedsMeItemFfi> for NeedsMeItem {
    fn from(i: NeedsMeItemFfi) -> Self {
        NeedsMeItem {
            source: i.source,
            id: i.id,
            reason: i.reason,
            priority: i.priority,
            destination: i.destination,
        }
    }
}

/// Aggregate Needs-Me items urgency-first (highest priority first, stable within
/// equal priority), via the `friday-core` logic. Exposed to native UI (`08` §1).
#[uniffi::export]
pub fn aggregate_needs_me(items: Vec<NeedsMeItemFfi>) -> Vec<NeedsMeItemFfi> {
    friday_core::aggregate_needs_me(items.into_iter().map(Into::into).collect())
        .into_iter()
        .map(Into::into)
        .collect()
}

/// A representative Needs-Me inbox, built and aggregated in Rust — a UI fixture
/// so the native shells can render the prioritized Activity list before the
/// persisted Activity store (Unit 9) is wired to the phone. NOT live data.
#[uniffi::export]
pub fn sample_activity_inbox() -> Vec<NeedsMeItemFfi> {
    aggregate_needs_me(vec![
        NeedsMeItemFfi {
            source: "claude".into(),
            id: "c1".into(),
            reason: "Question: which API key to use?".into(),
            priority: 9,
            destination: "session/claude-1".into(),
        },
        NeedsMeItemFfi {
            source: "codex".into(),
            id: "x1".into(),
            reason: "Approve: run DB migration".into(),
            priority: 7,
            destination: "session/codex-1".into(),
        },
        NeedsMeItemFfi {
            source: "workflow".into(),
            id: "w1".into(),
            reason: "Checkpoint: confirm deploy".into(),
            priority: 7,
            destination: "wf/deploy".into(),
        },
        NeedsMeItemFfi {
            source: "memory".into(),
            id: "m1".into(),
            reason: "Review: 2 new memory candidates".into(),
            priority: 3,
            destination: "memory/review".into(),
        },
    ])
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

    #[test]
    fn ffi_needs_me_aggregation_is_urgency_first_and_stable() {
        let item = |src: &str, id: &str, p: u8| NeedsMeItemFfi {
            source: src.into(),
            id: id.into(),
            reason: String::new(),
            priority: p,
            destination: String::new(),
        };
        let sorted = aggregate_needs_me(vec![
            item("a", "1", 5),
            item("b", "2", 9),
            item("c", "3", 5),
        ]);
        assert_eq!(sorted[0].id, "2"); // priority 9 first
                                       // equal priority (5) keeps arrival order: 1 before 3
        assert_eq!(sorted[1].id, "1");
        assert_eq!(sorted[2].id, "3");
    }

    #[test]
    fn ffi_needs_me_item_round_trips_losslessly() {
        let ffi = NeedsMeItemFfi {
            source: "claude".into(),
            id: "c1".into(),
            reason: "a question".into(),
            priority: 7,
            destination: "session/x".into(),
        };
        let core: NeedsMeItem = ffi.clone().into();
        let back: NeedsMeItemFfi = core.into();
        assert_eq!(ffi, back); // every field survives both conversions
    }

    #[test]
    fn ffi_sample_inbox_is_nonempty_and_urgency_ordered() {
        let inbox = sample_activity_inbox();
        assert!(!inbox.is_empty());
        for w in inbox.windows(2) {
            assert!(w[0].priority >= w[1].priority, "must be urgency-first");
        }
        assert_eq!(inbox[0].source, "claude"); // highest priority (9)
                                               // detail is carried, never dropped.
        assert!(!inbox[0].reason.is_empty() && !inbox[0].destination.is_empty());
    }
}
