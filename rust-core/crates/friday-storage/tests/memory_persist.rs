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
use memory::NewMemoryCandidate;

/// A bare candidate (no recall content/principal) — for the trust-lifecycle tests
/// that exercise the state machine, where ownership/content are irrelevant.
fn cand<'a>(
    memory_id: &'a str,
    scope: MemoryScope,
    content_ref: Option<&'a str>,
    created_at: i64,
) -> NewMemoryCandidate<'a> {
    NewMemoryCandidate {
        memory_id,
        scope,
        content_ref,
        content: None,
        principal_id: None,
        sensitive: false,
        created_at,
    }
}

/// A recallable candidate: carries inline `content` + an owning `principal_id`
/// (the fields a recall needs). Used by the recall/cross-principal tests.
fn owned_cand<'a>(
    memory_id: &'a str,
    content: &'a str,
    principal_id: &'a str,
    sensitive: bool,
    created_at: i64,
) -> NewMemoryCandidate<'a> {
    NewMemoryCandidate {
        memory_id,
        scope: MemoryScope::Global,
        content_ref: None,
        content: Some(content),
        principal_id: Some(principal_id),
        sensitive,
        created_at,
    }
}

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

    // Reopen pinned to v3 (the migration under test) -> forward-migrate to v3 (adds
    // `state` + backfills). Truncating keeps this test independent of later migrations
    // (v4+), exactly like the v1->v2 workflow-persist test.
    let mut migs3 = hub_migrations();
    migs3.truncate(3);
    let db = Db::open(&p, Profile::Hub, &migs3, "v3").unwrap();
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
    drop(db);

    // And it round-trips through the repo as a durable, auto-usable fact. The repo
    // targets the CURRENT schema, so read on a fully-migrated DB (the additive v4–v6
    // migrations preserve the state/confidence the v3 backfill wrote).
    let db = Db::open_hub(&p).unwrap();
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
    {
        let mut migs3 = hub_migrations();
        migs3.truncate(3);
        let db = Db::open(&p, Profile::Hub, &migs3, "v3").unwrap();
        assert_eq!(
            db.version().unwrap(),
            3,
            "the v3 migration under test applied"
        );
    }
    // Read back via the repo on the CURRENT schema (additive v4–v6 preserve the
    // state/confidence the v3 migration normalized).
    let db = Db::open_hub(&p).unwrap();

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
    memory::record_candidate(db.conn(), &cand("m1", MemoryScope::Global, Some("x"), 1)).unwrap();
    memory::confirm(db.conn(), "m1", 2).unwrap();
    // A second record_candidate for the same id must ERROR (PK violation), never
    // silently clobber an already-confirmed memory back to a candidate.
    assert!(
        memory::record_candidate(db.conn(), &cand("m1", MemoryScope::Global, Some("y"), 3))
            .is_err()
    );
    assert_eq!(state_of(&db, "m1"), "confirmed");
}

#[test]
fn pending_review_tie_break_is_stable_by_memory_id() {
    let p = temp_db_path("mem-tie");
    let db = Db::open_hub(&p).unwrap();
    // Identical created_at: the secondary memory_id sort makes order deterministic.
    memory::record_candidate(db.conn(), &cand("b", MemoryScope::Global, None, 5)).unwrap();
    memory::record_candidate(db.conn(), &cand("a", MemoryScope::Global, None, 5)).unwrap();
    memory::record_candidate(db.conn(), &cand("c", MemoryScope::Global, None, 5)).unwrap();
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

    memory::record_candidate(
        db.conn(),
        &cand("m1", MemoryScope::Project, Some("a fact"), 10),
    )
    .unwrap();

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
    memory::record_candidate(
        db.conn(),
        &cand("m1", MemoryScope::Global, Some("fact"), 10),
    )
    .unwrap();

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
    memory::record_candidate(db.conn(), &cand("m1", MemoryScope::Session, None, 10)).unwrap();

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
    memory::record_candidate(db.conn(), &cand("c", MemoryScope::Global, Some("x"), 1)).unwrap();
    memory::confirm(db.conn(), "c", 2).unwrap();
    assert!(memory::reject(db.conn(), "c", 3).is_err());
    assert!(memory::confirm(db.conn(), "c", 3).is_err());
    assert_eq!(state_of(&db, "c"), "confirmed");

    // Rejected cannot be re-decided (no silent promotion to confirmed).
    memory::record_candidate(db.conn(), &cand("r", MemoryScope::Global, Some("y"), 1)).unwrap();
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
    memory::record_candidate(db.conn(), &cand("old", MemoryScope::Global, None, 10)).unwrap();
    memory::record_candidate(db.conn(), &cand("mid", MemoryScope::Global, None, 20)).unwrap();
    memory::record_candidate(db.conn(), &cand("new", MemoryScope::Global, None, 30)).unwrap();
    // Confirm the middle one -> it leaves the queue.
    memory::confirm(db.conn(), "mid", 25).unwrap();

    let queue: Vec<String> = memory::pending_review(db.conn())
        .unwrap()
        .into_iter()
        .map(|m| m.memory_id)
        .collect();
    assert_eq!(queue, vec!["old".to_string(), "new".to_string()]);
}

// --- Memory-confirmation loop: edit / re-propose (successor, not mutation) ---

#[test]
fn k3_edit_candidate_rejects_old_and_creates_new_candidate() {
    let p = temp_db_path("mem-edit");
    let db = Db::open_hub(&p).unwrap();
    // A pending candidate the user wants to revise.
    memory::record_candidate(
        db.conn(),
        &cand("orig", MemoryScope::Global, Some("typo: lieks rust"), 1),
    )
    .unwrap();
    assert_eq!(state_of(&db, "orig"), "candidate");

    // Edit it: the edit is a NEW candidate; the old becomes Rejected (reversible
    // by a successor, NOT an in-place row mutation).
    let new_id = memory::edit_candidate(
        db.conn(),
        "orig",
        &cand("edited", MemoryScope::Global, Some("likes rust"), 2),
        100,
    )
    .unwrap();
    assert_eq!(new_id, "edited");

    // The OLD candidate is now a terminal Rejected row (still present, untouched
    // content) — reversibility = coexisting rows, not a rewrite.
    let old = memory::get(db.conn(), "orig").unwrap().unwrap();
    assert_eq!(old.state, MemoryState::Rejected);
    assert_eq!(old.content_ref.as_deref(), Some("typo: lieks rust"));
    assert!(!old.state.is_durable());

    // A NEW Candidate row exists with the edited content, pending the user's decision.
    let new = memory::get(db.conn(), "edited").unwrap().unwrap();
    assert_eq!(new.state, MemoryState::Candidate);
    assert_eq!(new.content_ref.as_deref(), Some("likes rust"));
    // The new candidate is in the review queue; the old rejected one is not.
    let queue: Vec<String> = memory::pending_review(db.conn())
        .unwrap()
        .into_iter()
        .map(|m| m.memory_id)
        .collect();
    assert_eq!(queue, vec!["edited".to_string()]);
}

#[test]
fn k3_edit_is_pending_only_confirmed_edit_is_refused_deferred_ac() {
    // Editing a CONFIRMED memory (retire-on-confirm) is the EXPLICIT deferred AC —
    // it must be refused, and refused ATOMICALLY (no new row leaks in).
    let p = temp_db_path("mem-edit-confirmed");
    let db = Db::open_hub(&p).unwrap();
    memory::record_candidate(db.conn(), &cand("c", MemoryScope::Global, Some("fact"), 1)).unwrap();
    memory::confirm(db.conn(), "c", 10).unwrap();
    assert_eq!(state_of(&db, "c"), "confirmed");

    let res = memory::edit_candidate(
        db.conn(),
        "c",
        &cand("c_edited", MemoryScope::Global, Some("revised fact"), 2),
        20,
    );
    assert!(
        res.is_err(),
        "editing a CONFIRMED memory must be refused (deferred AC)"
    );
    // Atomicity: the confirmed source is untouched AND the would-be new row never landed.
    assert_eq!(state_of(&db, "c"), "confirmed");
    assert!(memory::get(db.conn(), "c_edited").unwrap().is_none());
    // The confirmed memory is still auto-usable (not collaterally rejected).
    assert!(memory::auto_usable(db.conn())
        .unwrap()
        .iter()
        .any(|m| m.memory_id == "c"));
}

#[test]
fn k3_edit_is_atomic_no_half_edit_on_new_id_collision() {
    // If recording the new candidate fails (PK collision on the new id), the
    // rejection of the old candidate must roll back — never a half-edit.
    let p = temp_db_path("mem-edit-atomic");
    let db = Db::open_hub(&p).unwrap();
    memory::record_candidate(db.conn(), &cand("orig", MemoryScope::Global, Some("a"), 1)).unwrap();
    // A pre-existing row that will collide with the edit's new id.
    memory::record_candidate(db.conn(), &cand("taken", MemoryScope::Global, Some("b"), 2)).unwrap();

    let res = memory::edit_candidate(
        db.conn(),
        "orig",
        &cand("taken", MemoryScope::Global, Some("c"), 3), // collides
        50,
    );
    assert!(res.is_err(), "colliding new id must error");
    // ATOMIC: the old candidate was NOT left rejected — the whole edit rolled back.
    assert_eq!(
        state_of(&db, "orig"),
        "candidate",
        "a failed edit must not leave the old candidate Rejected (no half-edit)"
    );
    // The pre-existing "taken" row is unchanged (still its own candidate).
    let taken = memory::get(db.conn(), "taken").unwrap().unwrap();
    assert_eq!(taken.content_ref.as_deref(), Some("b"));
}

#[test]
fn k4_repropose_from_rejected_creates_new_candidate_source_stays_terminal() {
    let p = temp_db_path("mem-repropose");
    let db = Db::open_hub(&p).unwrap();
    // A rejected memory the user changed their mind about.
    memory::record_candidate(
        db.conn(),
        &cand("src", MemoryScope::Global, Some("plays guitar"), 1),
    )
    .unwrap();
    memory::reject(db.conn(), "src", 10).unwrap();
    assert_eq!(state_of(&db, "src"), "rejected");

    // Re-propose: a NEW candidate; the source Rejected row is left UNTOUCHED.
    let new_id = memory::repropose_from_rejected(
        db.conn(),
        "src",
        &cand("repro", MemoryScope::Global, Some("plays guitar"), 2),
        100,
    )
    .unwrap();
    assert_eq!(new_id, "repro");

    // The NEW candidate exists and is pending.
    let new = memory::get(db.conn(), "repro").unwrap().unwrap();
    assert_eq!(new.state, MemoryState::Candidate);

    // THE k4 invariant: the source Rejected row is STILL terminal — re-asserting
    // a decision on it STILL errors (reversibility does NOT resurrect the old row).
    assert_eq!(state_of(&db, "src"), "rejected");
    assert!(
        memory::confirm(db.conn(), "src", 200).is_err(),
        "the source Rejected row must stay terminal (no resurrection)"
    );
    assert!(memory::reject(db.conn(), "src", 200).is_err());
    assert_eq!(state_of(&db, "src"), "rejected");
}

#[test]
fn k4_repropose_only_from_a_rejected_source() {
    let p = temp_db_path("mem-repropose-guard");
    let db = Db::open_hub(&p).unwrap();
    // From a non-existent source: error, no silent create.
    assert!(memory::repropose_from_rejected(
        db.conn(),
        "ghost",
        &cand("x", MemoryScope::Global, None, 1),
        10
    )
    .is_err());
    assert!(memory::get(db.conn(), "x").unwrap().is_none());

    // From a still-PENDING candidate: refused (use edit_candidate, not re-propose).
    memory::record_candidate(db.conn(), &cand("pend", MemoryScope::Global, Some("p"), 1)).unwrap();
    assert!(memory::repropose_from_rejected(
        db.conn(),
        "pend",
        &cand("y", MemoryScope::Global, None, 2),
        10
    )
    .is_err());
    assert!(memory::get(db.conn(), "y").unwrap().is_none());
    assert_eq!(state_of(&db, "pend"), "candidate"); // source untouched

    // From a CONFIRMED memory: also refused (re-propose is from a Rejected source only).
    memory::record_candidate(db.conn(), &cand("conf", MemoryScope::Global, Some("c"), 1)).unwrap();
    memory::confirm(db.conn(), "conf", 5).unwrap();
    assert!(memory::repropose_from_rejected(
        db.conn(),
        "conf",
        &cand("z", MemoryScope::Global, None, 3),
        10
    )
    .is_err());
    assert!(memory::get(db.conn(), "z").unwrap().is_none());
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

// --- PROOF-MEMORY-001 recall (data layer) ----------------------------------

/// Seed a memory_item at the PRE-recall (v5) schema, which has `state` but not the
/// recall columns (`content`/`principal_id`/`sensitive`).
fn seed_v5_confirmed(db: &Db, id: &str) {
    db.conn()
        .execute(
            "INSERT INTO memory_item
                (memory_id, scope, content_ref, confidence, state, created_at, confirmed_at)
             VALUES (?1, 'global', ?2, 'confirmed', 'confirmed', 1, 42)",
            rusqlite::params![id, format!("ref://{id}")],
        )
        .unwrap();
}

#[test]
fn forward_migration_v5_to_v6_is_additive_and_old_rows_are_not_recallable() {
    let p = temp_db_path("mem-mig-v6");
    // Open at v5 (no recall columns) and seed a genuinely-confirmed memory.
    {
        let mut migs = hub_migrations();
        migs.truncate(5);
        let db = Db::open(&p, Profile::Hub, &migs, "v5").unwrap();
        assert_eq!(db.version().unwrap(), 5);
        for col in ["content", "principal_id", "sensitive"] {
            let has: i64 = db
                .conn()
                .query_row(
                    "SELECT count(*) FROM pragma_table_info('memory_item') WHERE name = ?1",
                    [col],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(has, 0, "{col} must not exist at v5");
        }
        seed_v5_confirmed(&db, "legacy1");
    }

    // Forward-migrate to v6 (the migration under test).
    let mut migs6 = hub_migrations();
    migs6.truncate(6);
    let db = Db::open(&p, Profile::Hub, &migs6, "v6").unwrap();
    assert_eq!(db.version().unwrap(), 6);

    // New columns + the recall index exist.
    for col in ["content", "principal_id", "sensitive"] {
        let has: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM pragma_table_info('memory_item') WHERE name = ?1",
                [col],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has, 1, "{col} must exist at v6");
    }
    let has_index: i64 = db
        .conn()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_memory_principal_state'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_index, 1);

    // The pre-existing confirmed row is PRESERVED (still confirmed) but backfilled
    // to NULL content / NULL principal / sensitive=0 — so it is NOT recallable
    // (no captured content, no owner). Additive, fail-closed.
    let legacy = memory::get(db.conn(), "legacy1").unwrap().unwrap();
    assert_eq!(legacy.state, MemoryState::Confirmed);
    assert_eq!(legacy.content, None);
    assert_eq!(legacy.principal_id, None);
    assert!(!legacy.sensitive);
    // It is still in the principal-agnostic auto_usable view...
    assert!(memory::auto_usable(db.conn())
        .unwrap()
        .iter()
        .any(|m| m.memory_id == "legacy1"));
    // ...but NO principal recalls it (unowned + no content).
    assert!(memory::recall_confirmed(db.conn(), "alice")
        .unwrap()
        .is_empty());
}

#[test]
fn recall_confirmed_returns_only_same_principal_confirmed_content() {
    let p = temp_db_path("mem-recall-principal");
    let db = Db::open_hub(&p).unwrap();
    // alice's confirmed memory, and bob's confirmed memory.
    memory::record_candidate(
        db.conn(),
        &owned_cand("a1", "alice likes rust", "alice", false, 1),
    )
    .unwrap();
    memory::confirm(db.conn(), "a1", 10).unwrap();
    memory::record_candidate(
        db.conn(),
        &owned_cand("b1", "bob likes go", "bob", false, 2),
    )
    .unwrap();
    memory::confirm(db.conn(), "b1", 11).unwrap();

    // alice recalls ONLY her own confirmed memory.
    let alice = memory::recall_confirmed(db.conn(), "alice").unwrap();
    assert_eq!(alice.len(), 1);
    assert_eq!(alice[0].memory_id, "a1");
    assert_eq!(alice[0].content.as_deref(), Some("alice likes rust"));
    assert_eq!(alice[0].principal_id.as_deref(), Some("alice"));

    // ADVERSE (the core security invariant): bob's memory NEVER appears for alice,
    // and alice's NEVER appears for bob. Cross-principal recall is impossible.
    assert!(alice.iter().all(|m| m.memory_id != "b1"));
    let bob = memory::recall_confirmed(db.conn(), "bob").unwrap();
    assert_eq!(bob.len(), 1);
    assert_eq!(bob[0].memory_id, "b1");
    assert!(bob.iter().all(|m| m.memory_id != "a1"));
    // A third principal with no memory recalls nothing.
    assert!(memory::recall_confirmed(db.conn(), "carol")
        .unwrap()
        .is_empty());
}

#[test]
fn recall_excludes_unconfirmed_unowned_and_contentless() {
    let p = temp_db_path("mem-recall-excludes");
    let db = Db::open_hub(&p).unwrap();

    // (1) alice's CANDIDATE (never confirmed) — must NOT recall as fact (`07` §9).
    memory::record_candidate(
        db.conn(),
        &owned_cand("cand", "unconfirmed fact", "alice", false, 1),
    )
    .unwrap();
    // (2) alice's confirmed but CONTENT-LESS memory — nothing to inject.
    memory::record_candidate(
        db.conn(),
        &NewMemoryCandidate {
            memory_id: "nocontent",
            scope: MemoryScope::Global,
            content_ref: Some("ref://x"),
            content: None,
            principal_id: Some("alice"),
            sensitive: false,
            created_at: 2,
        },
    )
    .unwrap();
    memory::confirm(db.conn(), "nocontent", 20).unwrap();
    // (3) an UNOWNED (NULL principal) confirmed memory with content — no owner recalls it.
    memory::record_candidate(
        db.conn(),
        &NewMemoryCandidate {
            memory_id: "unowned",
            scope: MemoryScope::Global,
            content_ref: None,
            content: Some("ownerless fact"),
            principal_id: None,
            sensitive: false,
            created_at: 3,
        },
    )
    .unwrap();
    memory::confirm(db.conn(), "unowned", 21).unwrap();
    // (4) alice's explicitly-REJECTED memory — a terminal non-fact, never recalled.
    memory::record_candidate(
        db.conn(),
        &owned_cand("rejected", "rejected fact", "alice", false, 4),
    )
    .unwrap();
    memory::reject(db.conn(), "rejected", 22).unwrap();
    // (5) alice's confirmed but EMPTY-STRING content — still nothing to inject.
    memory::record_candidate(db.conn(), &owned_cand("empty", "", "alice", false, 5)).unwrap();
    memory::confirm(db.conn(), "empty", 23).unwrap();
    // (6) a genuinely-recallable control row.
    memory::record_candidate(db.conn(), &owned_cand("ok", "real fact", "alice", false, 6)).unwrap();
    memory::confirm(db.conn(), "ok", 24).unwrap();

    let recalled: Vec<String> = memory::recall_confirmed(db.conn(), "alice")
        .unwrap()
        .into_iter()
        .map(|m| m.memory_id)
        .collect();
    // ONLY the control row recalls; the candidate, content-less, unowned, rejected,
    // and empty-content rows are all excluded.
    assert_eq!(recalled, vec!["ok".to_string()]);
}

#[test]
fn recall_blank_or_empty_principal_recalls_nothing() {
    let p = temp_db_path("mem-recall-blank");
    let db = Db::open_hub(&p).unwrap();
    // A confirmed memory that was (defensively) stored with an empty-string principal.
    memory::record_candidate(db.conn(), &owned_cand("e1", "fact", "", false, 1)).unwrap();
    memory::confirm(db.conn(), "e1", 10).unwrap();
    memory::record_candidate(
        db.conn(),
        &owned_cand("a1", "alice fact", "alice", false, 2),
    )
    .unwrap();
    memory::confirm(db.conn(), "a1", 11).unwrap();

    // An empty / whitespace principal is fail-closed: it recalls NOTHING (no wildcard,
    // no '' match) — it must never act as a master key over the whole store.
    assert!(memory::recall_confirmed(db.conn(), "").unwrap().is_empty());
    assert!(memory::recall_confirmed(db.conn(), "   ")
        .unwrap()
        .is_empty());
}

#[test]
fn recall_orders_most_recently_confirmed_first_and_returns_sensitive() {
    let p = temp_db_path("mem-recall-order");
    let db = Db::open_hub(&p).unwrap();
    memory::record_candidate(db.conn(), &owned_cand("old", "old fact", "alice", false, 1)).unwrap();
    memory::confirm(db.conn(), "old", 100).unwrap();
    memory::record_candidate(db.conn(), &owned_cand("new", "new fact", "alice", false, 2)).unwrap();
    memory::confirm(db.conn(), "new", 200).unwrap();
    // A sensitive (PII) confirmed memory — the recall query RETURNS it; the Context
    // Passport gate (not this query) decides whether it is actually injected.
    memory::record_candidate(db.conn(), &owned_cand("pii", "ssn 123", "alice", true, 3)).unwrap();
    memory::confirm(db.conn(), "pii", 300).unwrap();

    let recalled = memory::recall_confirmed(db.conn(), "alice").unwrap();
    let ids: Vec<&str> = recalled.iter().map(|m| m.memory_id.as_str()).collect();
    // Most-recently-confirmed first.
    assert_eq!(ids, vec!["pii", "new", "old"]);
    // The sensitive flag round-trips and the sensitive row IS in the recall set.
    let pii = recalled.iter().find(|m| m.memory_id == "pii").unwrap();
    assert!(pii.sensitive);
}

// ─── F5.5 dual-read recall (recall_confirmed_multi) ───

#[test]
fn recall_confirmed_multi_unions_dedups_and_preserves_single_principal_isolation() {
    let p = temp_db_path("mem-recall-dual");
    let db = Db::open_hub(&p).unwrap();

    // The HARDENED namespace (new write target) and the LEGACY namespace (where pre-flip
    // memory lives). A row written under the legacy namespace must still be recalled when
    // we dual-read [hardened, legacy].
    let hardened = "tenant.a.channel.discord.user.user-example-com.shared";
    let legacy = "tenant.a.channel.discord.user.user-example.com.shared";
    // A foreign principal whose memory must NEVER leak into the dual-read.
    let foreign = "tenant.a.channel.discord.user.someone-else.shared";

    // One row in EACH bucket: a new hardened-write, a pre-flip legacy-write, a foreign one.
    memory::record_candidate(
        db.conn(),
        &owned_cand("h1", "hardened fact", hardened, false, 1),
    )
    .unwrap();
    memory::confirm(db.conn(), "h1", 30).unwrap();
    memory::record_candidate(
        db.conn(),
        &owned_cand("l1", "legacy fact", legacy, false, 2),
    )
    .unwrap();
    memory::confirm(db.conn(), "l1", 20).unwrap();
    memory::record_candidate(
        db.conn(),
        &owned_cand("f1", "foreign fact", foreign, false, 3),
    )
    .unwrap();
    memory::confirm(db.conn(), "f1", 10).unwrap();

    // DUAL-READ: the union of the hardened + legacy buckets. The legacy fact IS recalled.
    let dual = memory::recall_confirmed_multi(db.conn(), &[hardened, legacy]).unwrap();
    let ids: Vec<&str> = dual.iter().map(|m| m.memory_id.as_str()).collect();
    assert!(ids.contains(&"h1"), "hardened-bucket memory recalled");
    assert!(
        ids.contains(&"l1"),
        "legacy-bucket memory recalled (no data loss)"
    );
    // ISOLATION (the core invariant the dual-read must NOT widen): the foreign principal's
    // memory NEVER appears even though we passed two namespaces.
    assert!(
        !ids.contains(&"f1"),
        "foreign-principal memory must never leak"
    );
    assert_eq!(dual.len(), 2);

    // FLAG-OFF parity: a single-element list is exactly `recall_confirmed`.
    let single = memory::recall_confirmed_multi(db.conn(), &[legacy]).unwrap();
    assert_eq!(single, memory::recall_confirmed(db.conn(), legacy).unwrap());
    assert_eq!(
        single
            .iter()
            .map(|m| m.memory_id.as_str())
            .collect::<Vec<_>>(),
        vec!["l1"]
    );

    // Empty list ⇒ empty result.
    assert!(memory::recall_confirmed_multi(db.conn(), &[])
        .unwrap()
        .is_empty());
}

#[test]
fn recall_confirmed_multi_dedups_a_row_present_in_both_buckets_first_principal_wins() {
    let p = temp_db_path("mem-recall-dual-dedup");
    let db = Db::open_hub(&p).unwrap();
    let hardened = "tenant.a.channel.discord.user.u-h.shared";
    let legacy = "tenant.a.channel.discord.user.u.h.shared";

    // The SAME memory_id cannot exist twice (PK), so a true cross-bucket duplicate of one id
    // is not storable; the dedup guards the case where ordered iteration would otherwise
    // re-emit an id. Here we store DISTINCT ids per bucket and assert no duplication and
    // that hardened (first principal) ordering leads.
    memory::record_candidate(db.conn(), &owned_cand("h1", "h fact", hardened, false, 1)).unwrap();
    memory::confirm(db.conn(), "h1", 50).unwrap();
    memory::record_candidate(db.conn(), &owned_cand("l1", "l fact", legacy, false, 2)).unwrap();
    memory::confirm(db.conn(), "l1", 40).unwrap();

    let dual = memory::recall_confirmed_multi(db.conn(), &[hardened, legacy]).unwrap();
    let ids: Vec<&str> = dual.iter().map(|m| m.memory_id.as_str()).collect();
    // Hardened bucket consulted first ⇒ its row appears before the legacy row.
    assert_eq!(ids, vec!["h1", "l1"]);
    // No id appears twice.
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(
        sorted.len(),
        ids.len(),
        "no duplicate ids in the dual-read union"
    );
}
