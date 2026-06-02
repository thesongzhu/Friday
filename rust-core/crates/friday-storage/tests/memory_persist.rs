//! Unit-10 memory persistence: the forward migration that adds the `state`
//! lifecycle column must BACKFILL (a pre-existing confirmed memory stays
//! confirmed, never silently demoted); the single-writer repo enforces the
//! trust invariants — no silent long-term write, only confirmed is auto-usable,
//! a terminal decision is final, and `confidence` is always consistent with
//! `state` (`07` §6/§7/§9, `02` §11/§12).

mod common;

use common::temp_db_path;
use friday_core::{Confidence, MemoryScope, MemoryState};
use friday_storage::{hub_migrations, memory, Db, Profile};

/// Insert a memory_item directly at the PRE-migration (v2) schema, which has no
/// `state` column. `confirmed_at` is the authoritative pre-migration "confirmed"
/// signal that the backfill keys on. `confidence` is `Option` because the v1 DDL
/// made it nullable and there was no repo enforcing consistency before v3.
fn seed_v2_memory(db: &Db, id: &str, confidence: Option<&str>, confirmed_at: Option<i64>) {
    db.conn()
        .execute(
            "INSERT INTO memory_item
                (memory_id, scope, content_ref, confidence, created_at, confirmed_at)
             VALUES (?1, 'global', ?2, ?3, 1, ?4)",
            rusqlite::params![id, format!("ref://{id}"), confidence, confirmed_at],
        )
        .unwrap();
}

fn state_of(db: &Db, id: &str) -> String {
    db.conn()
        .query_row(
            "SELECT state FROM memory_item WHERE memory_id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn forward_migration_v2_to_v3_backfills_confirmed_and_defaults_candidate() {
    let p = temp_db_path("mem-mig");
    // Open at v2 only (no `state` column), seed a CONFIRMED row and a pending one.
    {
        let mut migs = hub_migrations();
        migs.truncate(2); // [0001_init_hub, 0002_workflow] — memory_item w/o `state`
        let db = Db::open(&p, Profile::Hub, &migs, "v2").unwrap();
        assert_eq!(db.version().unwrap(), 2);
        // The `state` column must not exist yet.
        let has_state: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM pragma_table_info('memory_item') WHERE name = 'state'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_state, 0, "state column must not exist at v2");

        // A user-confirmed memory (confirmed_at set) and a never-confirmed one.
        seed_v2_memory(&db, "confirmed1", Some("confirmed"), Some(42));
        seed_v2_memory(&db, "pending1", Some("candidate"), None);
    }

    // Reopen with the full set -> forward-migrate to v3 (adds `state` + backfills).
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), 3);

    // THE discriminating assertion: the pre-existing confirmed memory was NOT
    // demoted to a candidate by the column default — it is still confirmed.
    assert_eq!(
        state_of(&db, "confirmed1"),
        "confirmed",
        "a confirmed memory must survive the migration as confirmed (not demoted)"
    );
    // The never-confirmed row took the safe default.
    assert_eq!(state_of(&db, "pending1"), "candidate");

    // And it round-trips through the repo as a durable, auto-usable fact.
    let confirmed = memory::get(db.conn(), "confirmed1").unwrap().unwrap();
    assert_eq!(confirmed.state, MemoryState::Confirmed);
    assert!(confirmed.state.is_durable());
    let usable = memory::auto_usable(db.conn()).unwrap();
    assert!(usable.iter().any(|m| m.memory_id == "confirmed1"));
    assert!(!usable.iter().any(|m| m.memory_id == "pending1"));
}

#[test]
fn forward_migration_normalizes_confidence_so_no_divergent_pair_survives() {
    // The migration is a SECOND writer of (state, confidence); it must uphold the
    // same consistency the repo guarantees. A pre-v3 row could carry confirmed_at
    // with a non-confirmed/NULL confidence (no repo enforced it before v3), or a
    // stale 'confirmed' confidence on a never-confirmed row. After migration NO
    // divergent (confidence='confirmed' XOR state='confirmed') pair may survive.
    let p = temp_db_path("mem-mig-confidence");
    {
        let mut migs = hub_migrations();
        migs.truncate(2); // v2: memory_item without `state`
        let db = Db::open(&p, Profile::Hub, &migs, "v2").unwrap();
        seed_v2_memory(&db, "conf_inferred", Some("inferred"), Some(7)); // confirmed, stale conf
        seed_v2_memory(&db, "conf_null", None, Some(8)); // confirmed, NULL conf
        seed_v2_memory(&db, "stale_confirmed", Some("confirmed"), None); // not confirmed, stale 'confirmed'
        seed_v2_memory(&db, "cand_null", None, None); // not confirmed, NULL conf
    }
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), 3);

    // Genuinely-confirmed rows: state AND confidence both normalized to confirmed.
    for id in ["conf_inferred", "conf_null"] {
        let row = memory::get(db.conn(), id).unwrap().unwrap();
        assert_eq!(row.state, MemoryState::Confirmed, "{id} state");
        assert_eq!(row.confidence, Confidence::Confirmed, "{id} confidence");
    }
    // Non-confirmed rows: a stale/NULL 'confirmed' confidence is cleared, so no
    // (confidence=confirmed, state!=confirmed) divergent pair remains.
    for id in ["stale_confirmed", "cand_null"] {
        let row = memory::get(db.conn(), id).unwrap().unwrap();
        assert_eq!(row.state, MemoryState::Candidate, "{id} state");
        assert_ne!(
            row.confidence,
            Confidence::Confirmed,
            "{id} must not keep a confirmed confidence"
        );
    }

    // auto_usable returns exactly the genuinely-confirmed rows, and its internal
    // (confidence,state) consistency debug_assert does NOT trip (would panic here
    // in this debug/test build if the migration had left a divergent pair).
    let usable: Vec<String> = memory::auto_usable(db.conn())
        .unwrap()
        .into_iter()
        .map(|m| m.memory_id)
        .collect();
    assert_eq!(usable.len(), 2);
    assert!(usable.contains(&"conf_inferred".to_string()));
    assert!(usable.contains(&"conf_null".to_string()));
}

#[test]
fn unknown_state_or_confidence_tokens_read_fail_closed() {
    let p = temp_db_path("mem-failclosed");
    let db = Db::open_hub(&p).unwrap(); // v3
                                        // Hand-insert a malformed row (bypasses the typed repo) with garbage tokens
                                        // AND confirmed_at set: a defensive read must NEVER treat it as a durable fact.
    db.conn()
        .execute(
            "INSERT INTO memory_item
                (memory_id, scope, content_ref, confidence, state, created_at, confirmed_at)
             VALUES ('bogus', 'global', NULL, 'garbage', 'garbage', 1, 99)",
            [],
        )
        .unwrap();
    let row = memory::get(db.conn(), "bogus").unwrap().unwrap();
    assert_eq!(row.confidence, Confidence::Candidate); // unknown -> least-trusted tier
    assert_eq!(row.state, MemoryState::Candidate);
    assert!(!row.state.is_durable());
    assert!(!row.confidence.auto_usable());
    // Never surfaced as a durable, auto-usable fact despite confirmed_at being set.
    assert!(memory::auto_usable(db.conn()).unwrap().is_empty());
}

#[test]
fn duplicate_record_candidate_errors_no_silent_clobber() {
    let p = temp_db_path("mem-dup");
    let db = Db::open_hub(&p).unwrap();
    memory::record_candidate(db.conn(), "m1", MemoryScope::Global, Some("x"), 1).unwrap();
    memory::confirm(db.conn(), "m1", 2).unwrap();
    // A second record_candidate for the same id must ERROR (PK violation), never
    // silently clobber an already-confirmed memory back to a candidate.
    assert!(memory::record_candidate(db.conn(), "m1", MemoryScope::Global, Some("y"), 3).is_err());
    assert_eq!(state_of(&db, "m1"), "confirmed");
}

#[test]
fn pending_review_tie_break_is_stable_by_memory_id() {
    let p = temp_db_path("mem-tie");
    let db = Db::open_hub(&p).unwrap();
    // Identical created_at: the secondary memory_id sort makes order deterministic.
    memory::record_candidate(db.conn(), "b", MemoryScope::Global, None, 5).unwrap();
    memory::record_candidate(db.conn(), "a", MemoryScope::Global, None, 5).unwrap();
    memory::record_candidate(db.conn(), "c", MemoryScope::Global, None, 5).unwrap();
    let q: Vec<String> = memory::pending_review(db.conn())
        .unwrap()
        .into_iter()
        .map(|m| m.memory_id)
        .collect();
    assert_eq!(q, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
}

#[test]
fn candidate_is_never_auto_usable_until_explicitly_confirmed() {
    let p = temp_db_path("mem-no-silent");
    let db = Db::open_hub(&p).unwrap();

    memory::record_candidate(db.conn(), "m1", MemoryScope::Project, Some("a fact"), 10).unwrap();

    // Recorded but undecided: it is a pending candidate, NOT durable, NOT usable.
    let row = memory::get(db.conn(), "m1").unwrap().unwrap();
    assert_eq!(row.state, MemoryState::Candidate);
    assert_eq!(row.confidence, Confidence::Candidate);
    assert!(!row.state.is_durable());
    assert!(!row.confidence.auto_usable());
    assert!(row.confirmed_at.is_none());
    assert!(memory::auto_usable(db.conn()).unwrap().is_empty());
    assert!(memory::pending_review(db.conn())
        .unwrap()
        .iter()
        .any(|m| m.memory_id == "m1"));
}

#[test]
fn explicit_confirm_makes_durable_with_consistent_confidence() {
    let p = temp_db_path("mem-confirm");
    let db = Db::open_hub(&p).unwrap();
    memory::record_candidate(db.conn(), "m1", MemoryScope::Global, Some("fact"), 10).unwrap();

    let st = memory::confirm(db.conn(), "m1", 100).unwrap();
    assert_eq!(st, MemoryState::Confirmed);

    let row = memory::get(db.conn(), "m1").unwrap().unwrap();
    assert_eq!(row.state, MemoryState::Confirmed);
    // confidence is written CONSISTENT with state (no divergent pair).
    assert_eq!(row.confidence, Confidence::Confirmed);
    assert!(row.confidence.auto_usable());
    assert_eq!(row.confirmed_at, Some(100));

    // Now usable, and no longer in the review queue.
    assert!(memory::auto_usable(db.conn())
        .unwrap()
        .iter()
        .any(|m| m.memory_id == "m1"));
    assert!(memory::pending_review(db.conn()).unwrap().is_empty());
}

#[test]
fn explicit_reject_is_not_durable_and_not_confirmed_confidence() {
    let p = temp_db_path("mem-reject");
    let db = Db::open_hub(&p).unwrap();
    memory::record_candidate(db.conn(), "m1", MemoryScope::Session, None, 10).unwrap();

    let st = memory::reject(db.conn(), "m1", 100).unwrap();
    assert_eq!(st, MemoryState::Rejected);

    let row = memory::get(db.conn(), "m1").unwrap().unwrap();
    assert_eq!(row.state, MemoryState::Rejected);
    assert!(!row.state.is_durable());
    // A rejected item never carries confirmed confidence.
    assert_ne!(row.confidence, Confidence::Confirmed);
    assert!(!row.confidence.auto_usable());
    assert!(row.confirmed_at.is_none());
    assert!(memory::auto_usable(db.conn()).unwrap().is_empty());
    assert!(memory::pending_review(db.conn()).unwrap().is_empty());
}

#[test]
fn terminal_decision_is_final_no_rewrite_no_downgrade() {
    let p = temp_db_path("mem-terminal");
    let db = Db::open_hub(&p).unwrap();

    // Confirmed cannot be re-decided (no downgrade to rejected).
    memory::record_candidate(db.conn(), "c", MemoryScope::Global, Some("x"), 1).unwrap();
    memory::confirm(db.conn(), "c", 2).unwrap();
    assert!(memory::reject(db.conn(), "c", 3).is_err());
    assert!(memory::confirm(db.conn(), "c", 3).is_err());
    assert_eq!(state_of(&db, "c"), "confirmed");

    // Rejected cannot be re-decided (no silent promotion to confirmed).
    memory::record_candidate(db.conn(), "r", MemoryScope::Global, Some("y"), 1).unwrap();
    memory::reject(db.conn(), "r", 2).unwrap();
    assert!(memory::confirm(db.conn(), "r", 3).is_err());
    assert_eq!(state_of(&db, "r"), "rejected");

    // Deciding a non-existent item is an error, not a silent create.
    assert!(memory::confirm(db.conn(), "ghost", 4).is_err());
}

#[test]
fn memory_review_queue_is_oldest_first_and_only_candidates() {
    let p = temp_db_path("mem-queue");
    let db = Db::open_hub(&p).unwrap();
    memory::record_candidate(db.conn(), "old", MemoryScope::Global, None, 10).unwrap();
    memory::record_candidate(db.conn(), "mid", MemoryScope::Global, None, 20).unwrap();
    memory::record_candidate(db.conn(), "new", MemoryScope::Global, None, 30).unwrap();
    // Confirm the middle one -> it leaves the queue.
    memory::confirm(db.conn(), "mid", 25).unwrap();

    let queue: Vec<String> = memory::pending_review(db.conn())
        .unwrap()
        .into_iter()
        .map(|m| m.memory_id)
        .collect();
    assert_eq!(queue, vec!["old".to_string(), "new".to_string()]);
}

#[test]
fn memory_item_is_hub_only_absent_on_phone() {
    let p = temp_db_path("mem-phone");
    let db = Db::open_phone(&p).unwrap();
    let tables = db.table_names().unwrap();
    assert!(
        !tables.iter().any(|t| t == "memory_item"),
        "memory_item must never exist on a phone profile: have {tables:?}"
    );
}
