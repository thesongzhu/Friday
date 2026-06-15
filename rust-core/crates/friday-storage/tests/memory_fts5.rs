//! Hybrid-recall v34 migration: the `memory_fts` FTS5 index over confirmed memory text,
//! its sync triggers, and the backfill. Proves the index tracks EXACTLY the confirmed +
//! content-bearing rows the recall SQL reads (a candidate is never indexed; a confirm
//! indexes; a delete de-indexes), and that `fts_keyword_scores` returns a `bm25` rank
//! (more-negative = better) for matches and an empty map for a blank query.

mod common;

use common::temp_db_path;
use friday_storage::{hub_migrations, memory, Db, Profile};
use memory::NewMemoryCandidate;

fn owned_cand<'a>(
    memory_id: &'a str,
    content: &'a str,
    principal_id: &'a str,
    created_at: i64,
) -> NewMemoryCandidate<'a> {
    NewMemoryCandidate {
        memory_id,
        scope: friday_core::MemoryScope::Global,
        content_ref: None,
        content: Some(content),
        principal_id: Some(principal_id),
        sensitive: false,
        created_at,
    }
}

/// Row count in the FTS index for a given memory_id (direct shadow-aware query).
fn fts_count(db: &Db, memory_id: &str) -> i64 {
    db.conn()
        .query_row(
            "SELECT count(*) FROM memory_fts WHERE memory_id = ?1",
            [memory_id],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn migration_creates_memory_fts_table() {
    let p = temp_db_path("fts-create");
    let db = Db::open_hub(&p).unwrap();
    let tables = db.table_names().unwrap();
    assert!(
        tables.iter().any(|t| t == "memory_fts"),
        "v34 must create the memory_fts virtual table: {tables:?}"
    );
}

#[test]
fn candidate_not_indexed_confirm_indexes_via_trigger() {
    let p = temp_db_path("fts-trigger");
    let db = Db::open_hub(&p).unwrap();
    let now = 1_000;

    // Record a candidate (NOT confirmed) — it must NOT be indexed (it is not recallable).
    memory::record_candidate(
        db.conn(),
        &owned_cand("m1", "prefers the rust async runtime", "alice", now),
    )
    .unwrap();
    assert_eq!(fts_count(&db, "m1"), 0, "a candidate must not be indexed");

    // Confirm it — the AFTER UPDATE trigger indexes it.
    memory::confirm(db.conn(), "m1", now + 1).unwrap();
    assert_eq!(fts_count(&db, "m1"), 1, "a confirmed row must be indexed");

    // Keyword query surfaces it; an unrelated query does not.
    let hit = memory::fts_keyword_scores(db.conn(), "\"rust\"").unwrap();
    assert!(
        hit.contains_key("m1"),
        "keyword match must return m1: {hit:?}"
    );
    assert!(
        hit["m1"] < 0.0,
        "bm25 is more-negative-better, got {}",
        hit["m1"]
    );
    let miss = memory::fts_keyword_scores(db.conn(), "\"kubernetes\"").unwrap();
    assert!(
        !miss.contains_key("m1"),
        "non-matching query returns nothing"
    );
}

#[test]
fn rejected_candidate_is_never_indexed() {
    let p = temp_db_path("fts-reject");
    let db = Db::open_hub(&p).unwrap();
    memory::record_candidate(db.conn(), &owned_cand("r1", "some rust note", "alice", 1)).unwrap();
    memory::reject(db.conn(), "r1", 2).unwrap();
    assert_eq!(
        fts_count(&db, "r1"),
        0,
        "a rejected row must never be indexed"
    );
    let hit = memory::fts_keyword_scores(db.conn(), "\"rust\"").unwrap();
    assert!(!hit.contains_key("r1"));
}

#[test]
fn delete_trigger_deindexes() {
    let p = temp_db_path("fts-delete");
    let db = Db::open_hub(&p).unwrap();
    memory::record_candidate(
        db.conn(),
        &owned_cand("d1", "rust ownership rules", "alice", 1),
    )
    .unwrap();
    memory::confirm(db.conn(), "d1", 2).unwrap();
    assert_eq!(fts_count(&db, "d1"), 1);
    // Directly delete the source row (simulating any future delete path) — the AFTER DELETE
    // trigger must drop the index entry so it can never go stale.
    db.conn()
        .execute("DELETE FROM memory_item WHERE memory_id = ?1", ["d1"])
        .unwrap();
    assert_eq!(fts_count(&db, "d1"), 0, "delete trigger must de-index");
}

#[test]
fn backfill_indexes_preexisting_confirmed_rows() {
    // Seed a hub DB MISSING the v34 migration (apply only up to v33), insert a confirmed row
    // directly, then apply the full migration set — the v34 backfill must index the row.
    let p = temp_db_path("fts-backfill");
    {
        // Open with a truncated migration set (<= v33) so memory_fts does not yet exist.
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 33);
        let db = Db::open(&p, Profile::Hub, &migs, "v33").unwrap();
        assert_eq!(db.version().unwrap(), 33);
        assert!(
            !db.table_names().unwrap().iter().any(|t| t == "memory_fts"),
            "memory_fts must not exist before v34"
        );
        // A pre-existing confirmed, content-bearing row (the backfill target).
        db.conn()
            .execute(
                "INSERT INTO memory_item
                    (memory_id, scope, content_ref, content, principal_id, sensitive,
                     confidence, state, created_at, confirmed_at)
                 VALUES ('b1', 'global', NULL, 'legacy rust fact', 'alice', 0,
                         'confirmed', 'confirmed', 1, 2)",
                [],
            )
            .unwrap();
        // An empty-content confirmed row must NOT be backfilled (never recallable).
        db.conn()
            .execute(
                "INSERT INTO memory_item
                    (memory_id, scope, content_ref, content, principal_id, sensitive,
                     confidence, state, created_at, confirmed_at)
                 VALUES ('b2', 'global', NULL, '', 'alice', 0,
                         'confirmed', 'confirmed', 1, 2)",
                [],
            )
            .unwrap();
    }
    // Re-open with the FULL migration set → v34 runs the backfill.
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(
        fts_count(&db, "b1"),
        1,
        "backfill must index a pre-existing confirmed row"
    );
    assert_eq!(
        fts_count(&db, "b2"),
        0,
        "empty-content rows are never indexed"
    );
    let hit = memory::fts_keyword_scores(db.conn(), "\"rust\"").unwrap();
    assert!(
        hit.contains_key("b1"),
        "backfilled row must be queryable: {hit:?}"
    );
}

#[test]
fn blank_query_returns_empty_without_querying() {
    let p = temp_db_path("fts-blank");
    let db = Db::open_hub(&p).unwrap();
    assert!(memory::fts_keyword_scores(db.conn(), "")
        .unwrap()
        .is_empty());
    assert!(memory::fts_keyword_scores(db.conn(), "   ")
        .unwrap()
        .is_empty());
}

#[test]
fn phone_profile_has_no_memory_fts() {
    // memory_fts is Hub-only (memory_item is Hub-only); the phone profile must not have it.
    let p = temp_db_path("fts-phone");
    let phone = Db::open_phone(&p).unwrap();
    assert_eq!(phone.profile(), Profile::Phone);
    let tables = phone.table_names().unwrap();
    assert!(
        !tables.iter().any(|t| t == "memory_fts"),
        "phone must NOT have the hub-only memory_fts: {tables:?}"
    );
}
