//! SMOOTH-001 provider-timeline persistence substrate: a REAL forward migration adds
//! the `provider_timeline` + `provider_timeline_event` + `provider_timeline_pending`
//! tables (preserving existing data), those tables are Hub-only (absent from the phone
//! profile, asserted both ways), and the migration applies cleanly on a fresh Hub DB.
//!
//! Version note: this PR's migration is version 19. The expected post-migration version
//! is DERIVED from `hub_migrations()` (not hardcoded), so these assertions survive other
//! additive migrations landing concurrently.

mod common;

use common::temp_db_path;
use friday_core::SessionState;
use friday_storage::{
    hub_migrations, load_timeline_by_session, persist_event, persist_timeline, upsert_pending, Db,
    PendingActionRow, PersistEventOutcome, Profile, TimelineEventRow, TimelineState,
    HUB_ONLY_TABLES,
};

/// The max migration version the current hub migration set reaches.
fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

const TIMELINE_TABLES: [&str; 3] = [
    "provider_timeline",
    "provider_timeline_event",
    "provider_timeline_pending",
];

#[test]
fn forward_migration_adds_timeline_tables_preserving_data() {
    let p = temp_db_path("timeline-mig");
    // Open at v1 only (init_hub) and seed a row that must survive the migration.
    {
        let mut migs = hub_migrations();
        migs.truncate(1); // keep only 0001_init_hub
        let db = Db::open(&p, Profile::Hub, &migs, "v1").unwrap();
        assert_eq!(db.version().unwrap(), 1);
        for t in TIMELINE_TABLES {
            assert!(
                !db.table_names().unwrap().iter().any(|x| x == t),
                "timeline tables must not exist at v1: {t}"
            );
        }
        db.insert_session(
            "s1",
            "friday_ask",
            "hi",
            SessionState::Created,
            1,
            1,
            "mac_live",
        )
        .unwrap();
    }
    // Reopen with the full hub set -> forward-migrate up to the provider_timeline migration.
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    let tables = db.table_names().unwrap();
    for t in TIMELINE_TABLES {
        assert!(tables.iter().any(|x| x == t), "{t} missing: {tables:?}");
    }
    // Pre-existing data survived the additive migration.
    assert_eq!(db.count("session").unwrap(), 1);
}

#[test]
fn migration_applies_cleanly_on_a_fresh_hub_db_and_tables_exist() {
    // The migration applies cleanly on a brand-new Hub DB and the three tables exist.
    let p = temp_db_path("timeline-fresh");
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    let tables = db.table_names().unwrap();
    for t in TIMELINE_TABLES {
        assert!(tables.iter().any(|x| x == t), "{t} missing: {tables:?}");
        // Fresh tables exist and are empty.
        assert_eq!(db.count(t).unwrap(), 0);
    }
}

#[test]
fn timeline_tables_are_hub_only_and_absent_from_phone() {
    // All three new tables are registered Hub-only.
    for t in TIMELINE_TABLES {
        assert!(HUB_ONLY_TABLES.contains(&t), "{t} not in HUB_ONLY_TABLES");
    }

    // Present on the Hub profile...
    let hp = temp_db_path("timeline-hub");
    let hub = Db::open_hub(&hp).unwrap();
    let htables = hub.table_names().unwrap();
    for t in TIMELINE_TABLES {
        assert!(htables.iter().any(|x| x == t), "{t} missing on hub");
    }

    // ...and ABSENT from the phone profile.
    let pp = temp_db_path("timeline-phone");
    let phone = Db::open_phone(&pp).unwrap();
    let ptables = phone.table_names().unwrap();
    for t in TIMELINE_TABLES {
        assert!(
            !ptables.iter().any(|x| x == t),
            "{t} must not exist on a phone: {ptables:?}"
        );
    }
}

#[test]
fn persist_load_roundtrip_through_a_real_hub_db() {
    // End-to-end through the public crate API on a real (on-disk) Hub DB: persist the
    // parent scalars + an ordered event log + a pending action, then rehydrate.
    let p = temp_db_path("timeline-e2e");
    let db = Db::open_hub(&p).unwrap();

    persist_timeline(db.conn(), "s1", &TimelineState::new(4, 1, 6), 1000).unwrap();
    for i in 1..=3 {
        let ev = TimelineEventRow {
            seq: i,
            revision: i,
            event_kind: "assistant_message".into(),
            actor: "provider".into(),
            body_ref: Some(format!("body://{i}")),
            provider_event_id: None,
        };
        assert_eq!(
            persist_event(db.conn(), "s1", &ev, 1000 + i).unwrap(),
            PersistEventOutcome::Persisted
        );
    }
    let pending = PendingActionRow {
        request_id: "r1".into(),
        client_msg_id: "c1".into(),
        action: "send_turn".into(),
        state: "accepted_by_hub".into(),
        dispatch_ref: Some("friday://d/1".into()),
        blocker: None,
        base_revision: 4,
        updated_at_revision: 6,
    };
    upsert_pending(db.conn(), "s1", &pending, 1100).unwrap();

    let loaded = load_timeline_by_session(db.conn(), "s1").unwrap().unwrap();
    assert_eq!(loaded.events.len(), 3);
    assert_eq!(
        loaded.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    // The persisted revision (6) survives even though it exceeds the last event's (3).
    assert_eq!(loaded.state.revision, 6);
    assert_eq!(loaded.state.next_seq, 4);
    assert_eq!(loaded.pending.len(), 1);
    assert_eq!(loaded.pending[0].state, "accepted_by_hub");
    assert_eq!(
        loaded.pending[0].dispatch_ref.as_deref(),
        Some("friday://d/1")
    );
}
