//! Rust-owned RETENTION sweep for the unbounded ARTIFACT tables (registry gap #25, DARK).
//!
//! The session-lifecycle [`crate::session_lifecycle::sweep_lifecycle`] reaper prunes ONLY
//! `agent_session` (+ its child messages). The other artifact tables — `token_ledger`,
//! `surface_event`, terminal `mission`/`work_item`, and rejected/expired memory CANDIDATES —
//! grow UNBOUNDED (memory-extraction + surface_event are written per-run). This module adds an
//! age-AND-state-bounded sweep for them, driven from the EXISTING reaper tick behind its OWN
//! default-off flag (`FRIDAY_RETENTION_SWEEP`) so deploying the new binary deletes NOTHING until
//! the operator explicitly flips it. The flag read lives in the hub bin; this module is a pure
//! storage primitive (no env read here).
//!
//! ## Operator-approved default windows (the named constants below)
//!   * `token_ledger`  — 90d  (billing/observability history; keyed on `created_at`).
//!   * `surface_event` — 90d  (timeline observability; keyed on `created_at_ms`).
//!   * terminal `mission` / `work_item` — 365d (keyed on `updated_at_ms`).
//!   * `memory_item` — confirmed kept INDEFINITELY; rejected/expired CANDIDATES pruned at 30d
//!     (keyed on `created_at`).
//!   * `audit_ledger` (the hash-chained audit "chain", [`crate::audit::verify_audit_chain`]) —
//!     **UNTOUCHED.** Its immutability is the whole point; deleting/archiving it is a separate
//!     deferred design, NOT done here. This module never references `audit_ledger`.
//!
//! ## HARD no-degrade rules (each enforced structurally below, not by convention)
//!   1. **Age AND terminal-state only.** Every DELETE carries BOTH an age boundary (strict `<`,
//!      matching the lifecycle reaper) AND, for `mission`/`work_item`/`memory_item`, a
//!      terminal/non-durable STATE predicate grounded in the real enums
//!      ([`friday_core::MissionStatus::is_terminal`] = `done`/`archived`/`merged`;
//!      [`friday_core::WorkItemStatus::is_terminal`] = `completed_with_proof`/`failed_terminal`/
//!      `cancelled`/`merged`/`archived`; [`friday_core::MemoryState`] durable = `confirmed`).
//!      A NON-terminal/active mission or work_item, or a CONFIRMED memory, can NEVER match.
//!   2. **FK-safe parent deletes (no orphans, no FK crash).** `mission` and `work_item` are
//!      RESTRICT-referenced (no `ON DELETE CASCADE`) by child tables and `foreign_keys` is ON on
//!      every connection. `mission` is referenced by `work_item`, `surface_event`,
//!      `surface_thread`, `mission_link`, `route_decision`, `workspace_claim`, `process_lease`;
//!      `work_item` is referenced by `surface_event`, `mission_link`, `route_decision`,
//!      `workspace_claim`, `process_lease`. (`process_observation` reaches them only TRANSITIVELY
//!      via `workspace_claim`, so it is not a direct guard; and the v1 `mission_link` was rebuilt
//!      then RENAMED from `mission_link_new`, so `mission_link` is the live child table.) A
//!      parent DELETE while ANY child still references it would FAIL the FK constraint. So a
//!      parent is deleted ONLY when NO surviving child references it (a `NOT EXISTS` guard across
//!      every referencing table). A terminal+aged parent with a not-yet-aged child simply WAITS
//!      for a later tick after the child ages out — eventually-consistent, never an FK violation,
//!      never an orphan.
//!   3. **Bounded batch per sweep.** Each table deletes at most [`RetentionWindows::batch_limit`]
//!      rows per call (a `rowid IN (SELECT ... LIMIT n)` cap), so one tick can never lock the DB
//!      on a huge backlog; the backlog drains over successive ticks.
//!   4. **Fail-safe + isolated.** Each table is swept in its OWN transaction; a per-table error
//!      (a transient lock, an unexpected FK refusal) is captured into the outcome and the sweep
//!      MOVES ON to the next table — one table's failure never rolls back another and never
//!      propagates. The CALLER (the reaper tick) additionally treats any returned error as
//!      logged-and-swallowed, so a sweep can never crash the reaper or boot.
//!
//! ## Idempotency
//! Every predicate is a stable age+state filter, so a second back-to-back sweep at the SAME
//! `now_ms` finds the same (already-deleted) rows gone and is a no-op. There is no per-row
//! state advance to race.

use crate::error::Result;
use rusqlite::params;
use rusqlite::Connection;

// ─── Operator-approved default retention windows (ms) ───

/// `token_ledger` rows older than 90 days are pruned (keyed on `created_at`).
pub const TOKEN_LEDGER_MAX_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// `surface_event` rows older than 90 days are pruned (keyed on `created_at_ms`).
pub const SURFACE_EVENT_MAX_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// Terminal `mission` rows older than 365 days are pruned (keyed on `updated_at_ms`).
pub const MISSION_MAX_AGE_MS: i64 = 365 * 24 * 60 * 60 * 1000;
/// Terminal `work_item` rows older than 365 days are pruned (keyed on `updated_at_ms`).
pub const WORK_ITEM_MAX_AGE_MS: i64 = 365 * 24 * 60 * 60 * 1000;
/// Rejected/expired memory CANDIDATES older than 30 days are pruned (keyed on `created_at`).
/// CONFIRMED memory is NEVER pruned regardless of age.
pub const MEMORY_CANDIDATE_MAX_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Default max rows deleted per table per sweep (bounds the per-tick work / lock time). At the
/// 120s reaper cadence this drains a large backlog over successive ticks without ever holding a
/// long write lock.
pub const DEFAULT_BATCH_LIMIT: i64 = 5_000;

/// The retention windows + batch cap, passed to [`sweep_retention`]. Constructed from the
/// operator-approved constants via [`RetentionWindows::default`]; exposed as named fields so the
/// windows are trivially adjustable (e.g. in a test) without touching the sweep logic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetentionWindows {
    pub token_ledger_max_age_ms: i64,
    pub surface_event_max_age_ms: i64,
    pub mission_max_age_ms: i64,
    pub work_item_max_age_ms: i64,
    pub memory_candidate_max_age_ms: i64,
    /// Max rows deleted per table per sweep (`> 0`; a non-positive value disables that table's
    /// delete, since the `LIMIT` would select nothing).
    pub batch_limit: i64,
}

impl Default for RetentionWindows {
    fn default() -> Self {
        RetentionWindows {
            token_ledger_max_age_ms: TOKEN_LEDGER_MAX_AGE_MS,
            surface_event_max_age_ms: SURFACE_EVENT_MAX_AGE_MS,
            mission_max_age_ms: MISSION_MAX_AGE_MS,
            work_item_max_age_ms: WORK_ITEM_MAX_AGE_MS,
            memory_candidate_max_age_ms: MEMORY_CANDIDATE_MAX_AGE_MS,
            batch_limit: DEFAULT_BATCH_LIMIT,
        }
    }
}

/// Per-table delete counts from one [`sweep_retention`] call, for observability (refs-only — a
/// count, never a row body). A `*_error` flag is set when that table's isolated transaction
/// failed and was skipped (the sweep moved on); the count for a failed table is 0.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RetentionOutcome {
    pub token_ledger_deleted: usize,
    pub surface_event_deleted: usize,
    pub mission_deleted: usize,
    pub work_item_deleted: usize,
    pub memory_item_deleted: usize,
    /// Number of per-table transactions that errored and were skipped (fail-safe).
    pub table_errors: usize,
}

impl RetentionOutcome {
    /// Whether this sweep deleted anything (used by the tick to log only on a non-empty sweep).
    pub fn is_empty(&self) -> bool {
        self.token_ledger_deleted == 0
            && self.surface_event_deleted == 0
            && self.mission_deleted == 0
            && self.work_item_deleted == 0
            && self.memory_item_deleted == 0
            && self.table_errors == 0
    }
}

/// Run the artifact-retention sweep at logical time `now_ms` (epoch ms). Each table is pruned in
/// its OWN transaction by age AND (where applicable) terminal/non-durable state, bounded to
/// `windows.batch_limit` rows. A per-table failure is isolated (recorded in
/// [`RetentionOutcome::table_errors`], that table skipped) so the sweep is FAIL-SAFE end-to-end:
/// this function never returns `Err` and the reaper tick treats it as best-effort.
///
/// SWEEP ORDER is child→parent (`surface_event` before `work_item` before `mission`) so that
/// aging-out children free their parents for deletion in the SAME tick when both are eligible;
/// the FK-safe `NOT EXISTS` parent guards make the order a latency optimization, not a
/// correctness requirement (a wrong order would just defer a parent to the next tick).
///
/// `audit_ledger` is intentionally NEVER referenced here (hash-chain immutability, gap #25).
pub fn sweep_retention(
    conn: &Connection,
    now_ms: i64,
    windows: RetentionWindows,
) -> RetentionOutcome {
    let mut out = RetentionOutcome::default();

    // 1. token_ledger — pure age on created_at. Leaf w.r.t. these FKs (nothing references it).
    let token_cutoff = now_ms - windows.token_ledger_max_age_ms;
    match delete_bounded(
        conn,
        "DELETE FROM token_ledger
          WHERE rowid IN (
              SELECT rowid FROM token_ledger WHERE created_at < ?1
               ORDER BY created_at LIMIT ?2
          )",
        token_cutoff,
        windows.batch_limit,
    ) {
        Ok(n) => out.token_ledger_deleted = n,
        Err(_e) => out.table_errors += 1,
    }

    // 2. surface_event — pure age on created_at_ms. Leaf (no table references surface_event).
    //    Deleted BEFORE work_item/mission so this tick can also free those parents.
    let surface_cutoff = now_ms - windows.surface_event_max_age_ms;
    match delete_bounded(
        conn,
        "DELETE FROM surface_event
          WHERE rowid IN (
              SELECT rowid FROM surface_event WHERE created_at_ms < ?1
               ORDER BY created_at_ms LIMIT ?2
          )",
        surface_cutoff,
        windows.batch_limit,
    ) {
        Ok(n) => out.surface_event_deleted = n,
        Err(_e) => out.table_errors += 1,
    }

    // 3. memory_item — rejected/expired CANDIDATES only, by created_at. CONFIRMED is excluded by
    //    state, so durable memory is NEVER deleted regardless of age. Leaf (no FK refs into it).
    let memory_cutoff = now_ms - windows.memory_candidate_max_age_ms;
    match delete_bounded(
        conn,
        "DELETE FROM memory_item
          WHERE rowid IN (
              SELECT rowid FROM memory_item
               WHERE state IN ('candidate', 'rejected')
                 AND created_at < ?1
               ORDER BY created_at LIMIT ?2
          )",
        memory_cutoff,
        windows.batch_limit,
    ) {
        Ok(n) => out.memory_item_deleted = n,
        Err(_e) => out.table_errors += 1,
    }

    // 4. work_item — terminal status AND aged on updated_at_ms, AND FK-safe (no surviving child
    //    in any table that RESTRICT-references work_item). A non-terminal work_item can never
    //    match the status set. Deleted BEFORE mission so an aged-out work_item frees its mission.
    let work_item_cutoff = now_ms - windows.work_item_max_age_ms;
    match delete_bounded(
        conn,
        "DELETE FROM work_item
          WHERE rowid IN (
              SELECT w.rowid FROM work_item w
               WHERE w.status IN
                     ('completed_with_proof','failed_terminal','cancelled','merged','archived')
                 AND w.updated_at_ms < ?1
                 AND NOT EXISTS (SELECT 1 FROM surface_event  c WHERE c.work_item_id = w.work_item_id)
                 AND NOT EXISTS (SELECT 1 FROM mission_link    c WHERE c.work_item_id = w.work_item_id)
                 AND NOT EXISTS (SELECT 1 FROM route_decision  c WHERE c.work_item_id = w.work_item_id)
                 AND NOT EXISTS (SELECT 1 FROM workspace_claim c WHERE c.work_item_id = w.work_item_id)
                 AND NOT EXISTS (SELECT 1 FROM process_lease   c WHERE c.work_item_id = w.work_item_id)
               ORDER BY w.updated_at_ms LIMIT ?2
          )",
        work_item_cutoff,
        windows.batch_limit,
    ) {
        Ok(n) => out.work_item_deleted = n,
        Err(_e) => out.table_errors += 1,
    }

    // 5. mission — terminal status AND aged on updated_at_ms, AND FK-safe (no surviving child in
    //    ANY table that RESTRICT-references mission). A non-terminal (active/waiting/blocked/
    //    paused) mission can never match the status set.
    let mission_cutoff = now_ms - windows.mission_max_age_ms;
    match delete_bounded(
        conn,
        "DELETE FROM mission
          WHERE rowid IN (
              SELECT m.rowid FROM mission m
               WHERE m.status IN ('done','archived','merged')
                 AND m.updated_at_ms < ?1
                 AND NOT EXISTS (SELECT 1 FROM work_item       c WHERE c.mission_id = m.mission_id)
                 AND NOT EXISTS (SELECT 1 FROM surface_event   c WHERE c.mission_id = m.mission_id)
                 AND NOT EXISTS (SELECT 1 FROM surface_thread  c WHERE c.mission_id = m.mission_id)
                 AND NOT EXISTS (SELECT 1 FROM mission_link    c WHERE c.mission_id = m.mission_id)
                 AND NOT EXISTS (SELECT 1 FROM route_decision  c WHERE c.mission_id = m.mission_id)
                 AND NOT EXISTS (SELECT 1 FROM workspace_claim c WHERE c.mission_id = m.mission_id)
                 AND NOT EXISTS (SELECT 1 FROM process_lease   c WHERE c.mission_id = m.mission_id)
               ORDER BY m.updated_at_ms LIMIT ?2
          )",
        mission_cutoff,
        windows.batch_limit,
    ) {
        Ok(n) => out.mission_deleted = n,
        Err(_e) => out.table_errors += 1,
    }

    out
}

/// Run ONE bounded DELETE inside its OWN transaction and return the deleted row count. The whole
/// table is all-or-nothing for THIS sweep (commit on success; the txn drops → rolls back on any
/// error), and the error is returned to the caller so it can be ISOLATED to this table without
/// affecting the others.
///
/// The body is wrapped in the crate's ONE bounded busy-retry idiom ([`crate::with_busy_retry`]) —
/// the SAME wrapper the writable-Hub open and the run-billing write txn use, never a second
/// policy. This is required because the reaper sweeps on a SEPARATE connection while N billers
/// commit concurrently: a deferred write txn can hit `SQLITE_BUSY` (notably `SQLITE_BUSY_SNAPSHOT`,
/// which `busy_timeout` does NOT auto-retry — only an app-level retry recovers it), and any of the
/// five per-table deletes can surface it under WAL contention. After #786 the `memory_fts_ad`
/// AFTER-DELETE trigger added an extra `memory_fts` write inside the `memory_item` delete txn,
/// which made that path the most likely to hit it — but the wrap is at the SHARED helper so every
/// table is uniformly resilient, not just the one the trigger made probable.
///
/// On a BUSY the failed txn has ALREADY rolled back (NOTHING committed), so each retry re-opens a
/// fresh `unchecked_transaction` and re-runs the bounded DELETE cleanly — no half-delete, no
/// double-count. NO-DEGRADE: the retry fires ONLY on [`crate::is_storage_busy`] (transient
/// lock/snapshot contention); a GENUINE FK/constraint violation is NOT busy-classed, so it
/// propagates on the FIRST attempt with zero delay and is still surfaced to the caller (counted in
/// [`RetentionOutcome::table_errors`]). With no contention the closure runs EXACTLY ONCE and the
/// result is byte-identical to the pre-wrap single-txn path.
fn delete_bounded(conn: &Connection, sql: &str, cutoff: i64, limit: i64) -> Result<usize> {
    crate::with_busy_retry(|| {
        let tx = conn.unchecked_transaction()?;
        let n = tx.execute(sql, params![cutoff, limit])?;
        tx.commit()?;
        Ok(n)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "friday-retention-{}-{}-{}-{nanos}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed),
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn count(db: &Db, table: &str) -> i64 {
        db.conn()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn exists(db: &Db, table: &str, id_col: &str, id: &str) -> bool {
        db.conn()
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {id_col} = ?1)"),
                [id],
                |r| r.get::<_, bool>(0),
            )
            .unwrap()
    }

    // --- minimal real-row seeders (grounded in the live schema) ---------------

    fn seed_token_ledger(db: &Db, id: &str, created_at: i64) {
        db.conn()
            .execute(
                "INSERT INTO token_ledger
                    (ledger_id, session_id, activity_id, provider_kind, model, base_url_host,
                     prompt_tokens, completion_tokens, total_tokens, cost_estimate, fallback,
                     result_link, created_at)
                 VALUES (?1, NULL, NULL, 'deepseek', 'deepseek-chat', 'api.deepseek.com',
                         1, 1, 2, NULL, 0, NULL, ?2)",
                params![id, created_at],
            )
            .unwrap();
    }

    fn seed_memory(db: &Db, id: &str, state: &str, confidence: &str, created_at: i64) {
        db.conn()
            .execute(
                "INSERT INTO memory_item
                    (memory_id, scope, content_ref, content, principal_id, sensitive,
                     confidence, state, created_at, confirmed_at)
                 VALUES (?1, 'session', NULL, 'c', 'owner', 0, ?2, ?3, ?4, NULL)",
                params![id, confidence, state, created_at],
            )
            .unwrap();
    }

    fn seed_conversation(db: &Db, id: &str) {
        db.conn()
            .execute(
                "INSERT OR IGNORE INTO friday_conversation
                    (friday_conversation_id, owner_principal, truth_status, created_at_ms, updated_at_ms)
                 VALUES (?1, 'owner', 'proven', 1, 1)",
                [id],
            )
            .unwrap();
    }

    fn seed_mission(db: &Db, id: &str, conv: &str, status: &str, updated_at_ms: i64) {
        db.conn()
            .execute(
                "INSERT INTO mission
                    (mission_id, friday_conversation_id, intent, status, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'do a thing', ?3, 1, ?4)",
                params![id, conv, status, updated_at_ms],
            )
            .unwrap();
    }

    fn seed_work_item(db: &Db, id: &str, mission: &str, status: &str, updated_at_ms: i64) {
        db.conn()
            .execute(
                "INSERT INTO work_item
                    (work_item_id, mission_id, lane, status, risk_level, approval_state,
                     created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'friday_hub', ?3, 'read_only', 'not_required', 1, ?4)",
                params![id, mission, status, updated_at_ms],
            )
            .unwrap();
    }

    fn seed_surface_thread(db: &Db, id: &str, conv: &str, mission: &str) {
        // surface_thread CHECK requires a known surface_kind; mission_id is the FK we age against.
        db.conn()
            .execute(
                "INSERT INTO surface_thread
                    (surface_thread_id, friday_conversation_id, mission_id, surface_kind,
                     visibility_policy, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, 'desktop', 'status_only', 1, 1)",
                params![id, conv, mission],
            )
            .unwrap();
    }

    fn seed_surface_event(
        db: &Db,
        id: &str,
        conv: &str,
        mission: &str,
        work_item: Option<&str>,
        surface_thread: &str,
        created_at_ms: i64,
    ) {
        db.conn()
            .execute(
                "INSERT INTO surface_event
                    (surface_event_id, friday_conversation_id, mission_id, work_item_id,
                     surface_thread_id, source_surface, event_kind, body_ref, visibility_policy,
                     proof_ref, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'desktop', 'system_status', NULL, 'status_only',
                         NULL, ?6)",
                params![id, conv, mission, work_item, surface_thread, created_at_ms],
            )
            .unwrap();
    }

    fn seed_audit(db: &Db, id: &str) {
        let tx = db.conn().unchecked_transaction().unwrap();
        crate::audit::append_audit(&tx, id, "owner", "test.action", None, 1).unwrap();
        tx.commit().unwrap();
    }

    // --- the consolidated e2e: ON prunes ONLY old-terminal; everything else survives ---

    #[test]
    fn flag_on_sweep_prunes_only_old_terminal_rows_others_untouched() {
        let db = Db::open_hub(&tmp("e2e-on")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64; // ~2000 days, far past every window
        let w = RetentionWindows::default();

        seed_conversation(&db, "fconv_1");

        // token_ledger: one OLD (prune) + one RECENT (keep).
        seed_token_ledger(&db, "tl_old", now - TOKEN_LEDGER_MAX_AGE_MS - 1);
        seed_token_ledger(&db, "tl_recent", now - 1);

        // memory: confirmed-old (KEEP forever) + rejected-old (prune) + candidate-recent (keep).
        seed_memory(
            &db,
            "mem_confirmed",
            "confirmed",
            "confirmed",
            now - MEMORY_CANDIDATE_MAX_AGE_MS - 10,
        );
        seed_memory(
            &db,
            "mem_rejected_old",
            "rejected",
            "candidate",
            now - MEMORY_CANDIDATE_MAX_AGE_MS - 1,
        );
        seed_memory(
            &db,
            "mem_candidate_recent",
            "candidate",
            "candidate",
            now - 1,
        );

        // mission: an OLD-TERMINAL leaf mission (prune) + an ACTIVE old mission (NEVER prune).
        seed_mission(
            &db,
            "miss_term_old",
            "fconv_1",
            "done",
            now - MISSION_MAX_AGE_MS - 1,
        );
        seed_mission(
            &db,
            "miss_active_old",
            "fconv_1",
            "active",
            now - MISSION_MAX_AGE_MS - 1,
        );

        // work_item: an OLD-TERMINAL leaf under a SEPARATE old-terminal parent, plus a parent that
        // will be freed only after this work_item goes. Use a dedicated mission so its own FK-safe
        // delete is independent.
        seed_mission(
            &db,
            "miss_for_wi",
            "fconv_1",
            "merged",
            now - MISSION_MAX_AGE_MS - 1,
        );
        seed_work_item(
            &db,
            "wi_term_old",
            "miss_for_wi",
            "completed_with_proof",
            now - WORK_ITEM_MAX_AGE_MS - 1,
        );
        // a NON-terminal work_item that is old — must NEVER be deleted.
        seed_work_item(
            &db,
            "wi_active_old",
            "miss_active_old",
            "provider_waiting",
            now - WORK_ITEM_MAX_AGE_MS - 1,
        );

        // surface_event: an OLD leaf (prune) hanging off an active mission (the mission stays;
        // only the event ages out) + a RECENT event (keep).
        seed_surface_thread(&db, "st_1", "fconv_1", "miss_active_old");
        seed_surface_event(
            &db,
            "se_old",
            "fconv_1",
            "miss_active_old",
            None,
            "st_1",
            now - SURFACE_EVENT_MAX_AGE_MS - 1,
        );
        seed_surface_event(
            &db,
            "se_recent",
            "fconv_1",
            "miss_active_old",
            None,
            "st_1",
            now - 1,
        );

        // audit chain — UNTOUCHED across the sweep.
        seed_audit(&db, "audit_1");
        seed_audit(&db, "audit_2");
        assert_eq!(crate::audit::verify_audit_chain(db.conn()).unwrap(), 2);
        let audit_before = count(&db, "audit_ledger");

        let out = sweep_retention(db.conn(), now, w);
        assert_eq!(out.table_errors, 0, "no per-table failure");

        // token_ledger: only the old row gone.
        assert_eq!(out.token_ledger_deleted, 1);
        assert!(!exists(&db, "token_ledger", "ledger_id", "tl_old"));
        assert!(exists(&db, "token_ledger", "ledger_id", "tl_recent"));

        // memory: rejected-old gone; confirmed + recent candidate survive.
        assert_eq!(out.memory_item_deleted, 1);
        assert!(!exists(&db, "memory_item", "memory_id", "mem_rejected_old"));
        assert!(
            exists(&db, "memory_item", "memory_id", "mem_confirmed"),
            "confirmed memory kept forever"
        );
        assert!(exists(
            &db,
            "memory_item",
            "memory_id",
            "mem_candidate_recent"
        ));

        // surface_event: old leaf gone; recent kept.
        assert_eq!(out.surface_event_deleted, 1);
        assert!(!exists(&db, "surface_event", "surface_event_id", "se_old"));
        assert!(exists(
            &db,
            "surface_event",
            "surface_event_id",
            "se_recent"
        ));

        // work_item: terminal-old leaf gone; non-terminal-old survives.
        assert_eq!(out.work_item_deleted, 1);
        assert!(!exists(&db, "work_item", "work_item_id", "wi_term_old"));
        assert!(
            exists(&db, "work_item", "work_item_id", "wi_active_old"),
            "non-terminal work_item never deleted"
        );

        // mission: only the OLD-TERMINAL LEAF mission gone. miss_for_wi is now childless (its
        // work_item went in this same tick, child-before-parent order) so it ALSO goes. The active
        // mission stays (non-terminal); miss_active_old also stays (non-terminal) and still has a
        // recent surface_event child anyway.
        assert!(!exists(&db, "mission", "mission_id", "miss_term_old"));
        assert!(
            !exists(&db, "mission", "mission_id", "miss_for_wi"),
            "freed by child work_item in same tick"
        );
        assert!(
            exists(&db, "mission", "mission_id", "miss_active_old"),
            "active mission never deleted"
        );
        assert_eq!(out.mission_deleted, 2);

        // audit chain — bit-for-bit untouched + still verifies clean.
        assert_eq!(
            count(&db, "audit_ledger"),
            audit_before,
            "audit_ledger row count unchanged"
        );
        assert_eq!(
            crate::audit::verify_audit_chain(db.conn()).unwrap(),
            2,
            "audit chain still clean"
        );
    }

    // --- a terminal+aged parent with a NOT-yet-aged child is NOT deleted (FK-safe) ---

    #[test]
    fn terminal_aged_mission_with_surviving_child_is_kept_then_freed_next_tick() {
        // FK-safety + eventual-consistency: a terminal+aged mission is NOT deleted while ANY child
        // still references it (no FK crash, no orphan); once the child ages out the SAME-tick
        // child-before-parent order frees the mission. We use a work_item child (it has its own
        // age+terminal window) so the whole progression is driven by the sweep, not test surgery.
        let db = Db::open_hub(&tmp("fk-safe")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        let w = RetentionWindows::default();
        seed_conversation(&db, "fconv_1");

        // Terminal + very old mission whose ONLY child is a NON-terminal work_item (never
        // pruneable yet). The mission must NOT be deleted (FK to the surviving work_item).
        seed_mission(&db, "m", "fconv_1", "done", now - MISSION_MAX_AGE_MS - 1);
        seed_work_item(
            &db,
            "w",
            "m",
            "provider_waiting",
            now - WORK_ITEM_MAX_AGE_MS - 1,
        );

        let out1 = sweep_retention(db.conn(), now, w);
        assert_eq!(
            out1.table_errors, 0,
            "no FK crash — the parent is simply skipped"
        );
        assert_eq!(
            out1.work_item_deleted, 0,
            "non-terminal work_item never pruned"
        );
        assert_eq!(
            out1.mission_deleted, 0,
            "mission kept while a child survives"
        );
        assert!(exists(&db, "mission", "mission_id", "m"));
        assert!(exists(&db, "work_item", "work_item_id", "w"));

        // The work_item reaches a TERMINAL state (the normal lifecycle). Now a sweep prunes the
        // (terminal+aged, childless) work_item AND, in the same tick (child-before-parent), the
        // now-childless terminal mission.
        db.conn()
            .execute(
                "UPDATE work_item SET status = 'completed_with_proof' WHERE work_item_id = 'w'",
                [],
            )
            .unwrap();
        let out2 = sweep_retention(db.conn(), now, w);
        assert_eq!(out2.table_errors, 0);
        assert_eq!(
            out2.work_item_deleted, 1,
            "the now-terminal+aged work_item is pruned"
        );
        assert_eq!(
            out2.mission_deleted, 1,
            "the childless terminal mission is freed same tick"
        );
        assert!(!exists(&db, "work_item", "work_item_id", "w"));
        assert!(!exists(&db, "mission", "mission_id", "m"));
    }

    // --- flag-OFF parity is the CALLER's concern; here prove the empty/boundary behavior ---

    #[test]
    fn empty_db_and_boundary_are_noops() {
        let db = Db::open_hub(&tmp("empty")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        let w = RetentionWindows::default();
        // Empty DB: nothing to prune.
        assert!(sweep_retention(db.conn(), now, w).is_empty());

        // Exactly-at-boundary rows do NOT prune (strict `<`).
        seed_token_ledger(&db, "tl_at", now - TOKEN_LEDGER_MAX_AGE_MS); // == cutoff, not < cutoff
        let out = sweep_retention(db.conn(), now, w);
        assert_eq!(
            out.token_ledger_deleted, 0,
            "at-exactly-threshold does not fire (strict <)"
        );
        assert!(exists(&db, "token_ledger", "ledger_id", "tl_at"));
    }

    // --- idempotency: a second back-to-back sweep is a no-op ---

    #[test]
    fn second_back_to_back_sweep_is_a_noop() {
        let db = Db::open_hub(&tmp("idem")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        let w = RetentionWindows::default();
        seed_conversation(&db, "fconv_1");
        seed_token_ledger(&db, "tl_old", now - TOKEN_LEDGER_MAX_AGE_MS - 1);
        seed_memory(
            &db,
            "mem_rej",
            "rejected",
            "candidate",
            now - MEMORY_CANDIDATE_MAX_AGE_MS - 1,
        );
        seed_mission(
            &db,
            "m_term",
            "fconv_1",
            "archived",
            now - MISSION_MAX_AGE_MS - 1,
        );

        let first = sweep_retention(db.conn(), now, w);
        assert_eq!(first.table_errors, 0);
        assert_eq!(first.token_ledger_deleted, 1);
        assert_eq!(first.memory_item_deleted, 1);
        assert_eq!(first.mission_deleted, 1);

        let second = sweep_retention(db.conn(), now, w);
        assert!(
            second.is_empty(),
            "second back-to-back sweep deletes nothing"
        );
    }

    // --- non-terminal rows of EVERY non-terminal status are never deleted (no-degrade) ---

    #[test]
    fn no_non_terminal_mission_or_work_item_is_ever_deleted_even_when_ancient() {
        let db = Db::open_hub(&tmp("non-terminal")).unwrap();
        let ancient = 1_i64; // updated_at_ms = 1 → maximally old
        let now = 5_000 * 24 * 60 * 60 * 1000_i64;
        let w = RetentionWindows::default();
        seed_conversation(&db, "fconv_1");

        // Every NON-terminal mission status.
        for (i, s) in ["active", "waiting_for_user", "blocked", "paused"]
            .iter()
            .enumerate()
        {
            seed_mission(&db, &format!("m{i}"), "fconv_1", s, ancient);
        }
        // Every NON-terminal work_item status (under one active mission so the FK holds).
        seed_mission(&db, "m_host", "fconv_1", "active", ancient);
        for (i, s) in [
            "draft",
            "preflight_blocked",
            "waiting_for_user",
            "ready_to_dispatch",
            "dispatched",
            "hub_accepted",
            "provider_routed",
            "provider_waiting",
            "failed_retryable",
        ]
        .iter()
        .enumerate()
        {
            seed_work_item(&db, &format!("w{i}"), "m_host", s, ancient);
        }

        let out = sweep_retention(db.conn(), now, w);
        assert_eq!(out.table_errors, 0);
        assert_eq!(out.mission_deleted, 0, "no non-terminal mission deleted");
        assert_eq!(
            out.work_item_deleted, 0,
            "no non-terminal work_item deleted"
        );
        assert_eq!(count(&db, "mission"), 5);
        assert_eq!(count(&db, "work_item"), 9);
    }

    // --- bounded batch: a sweep deletes at most batch_limit rows per table per call ---

    #[test]
    fn batch_limit_caps_rows_per_sweep_and_backlog_drains_over_ticks() {
        let db = Db::open_hub(&tmp("batch")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        let w = RetentionWindows {
            batch_limit: 2,
            ..RetentionWindows::default()
        };
        for i in 0..5 {
            seed_token_ledger(&db, &format!("tl{i}"), now - TOKEN_LEDGER_MAX_AGE_MS - 1);
        }
        // Each sweep deletes at most 2; the backlog (5) drains over 3 ticks (2+2+1).
        assert_eq!(sweep_retention(db.conn(), now, w).token_ledger_deleted, 2);
        assert_eq!(sweep_retention(db.conn(), now, w).token_ledger_deleted, 2);
        assert_eq!(sweep_retention(db.conn(), now, w).token_ledger_deleted, 1);
        assert_eq!(sweep_retention(db.conn(), now, w).token_ledger_deleted, 0);
        assert_eq!(count(&db, "token_ledger"), 0);
    }

    // --- the default windows ARE the operator-approved constants ---

    #[test]
    fn default_windows_are_the_operator_approved_values() {
        let w = RetentionWindows::default();
        assert_eq!(w.token_ledger_max_age_ms, 90 * 24 * 60 * 60 * 1000);
        assert_eq!(w.surface_event_max_age_ms, 90 * 24 * 60 * 60 * 1000);
        assert_eq!(w.mission_max_age_ms, 365 * 24 * 60 * 60 * 1000);
        assert_eq!(w.work_item_max_age_ms, 365 * 24 * 60 * 60 * 1000);
        assert_eq!(w.memory_candidate_max_age_ms, 30 * 24 * 60 * 60 * 1000);
        assert_eq!(w.batch_limit, DEFAULT_BATCH_LIMIT);
    }
}
