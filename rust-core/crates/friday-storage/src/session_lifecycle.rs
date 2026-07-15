//! Rust-owned session-lifecycle REAPER (DARK substrate).
//!
//! This is the Rust replacement for the retired TypeScript `session-lifecycle-sweep`
//! (`src/sessions/services/friday-session-service.ts` `sweepLifecycle`, now fail-closed;
//! its scheduler job was removed in PR #652). The operator's chosen architecture is that
//! **Rust OWNS session lifecycle, writing to the Hub-only `agent_session` table** — the TS
//! `sessions` table's historical lifecycle data is ABANDONED (not migrated).
//!
//! ## The four transitions (ported from the TS sweep, ONE write transaction)
//! With the ported timeout constants below (mirroring `src/sessions/friday-session.constants.ts`):
//!   1. `active`   → `idle`     when no activity for > [`IDLE_TIMEOUT_MS`]   (30m)
//!   2. `idle`     → `archived` when idle for     > [`ARCHIVE_TIMEOUT_MS`]  (7d)
//!   3. `archived` → `pruned`   when archived for > [`PRUNE_TIMEOUT_MS`]    (30d)
//!   4. `pruned`   → hard-delete when pruned for  > [`HARD_DELETE_TIMEOUT_MS`] (7d after pruned)
//!
//! ## DATA-RETENTION-001 gating (transitions 2–4 are DEFAULT-OFF)
//! Only transition 1 (active→idle) runs under the DEFAULT (permanent) policy. Transitions 2–4 —
//! idle→archived, archived→pruned, and the irreversible pruned→hard-delete — are ALL gated behind an
//! explicit `session_content` retention policy (the fail-closed [`resolve_cutoff`]). The reason:
//! `archived` and `pruned` are EXCLUDED from the owner-discoverable list
//! ([`crate::agent_session::list_sessions_for_owner`]) and there is NO other list/search/export/
//! restore surface for them, so auto-advancing a session into either status by mere time passing
//! SOFT-HIDES it from its owner (a soft-deletion) — barred by DATA-RETENTION-001. `idle` REMAINS in
//! the owner list (a live, resumable conversation), so idling is safe and stays outside the gate. A
//! session therefore stays active/idle — listed + accessible — forever until the user explicitly
//! archives it ([`crate::agent_session::archive_session_for_owner`]) or explicitly enables a
//! session-content retention policy. See [`sweep_lifecycle_with_policy`].
//!
//! Each transition uses a STRICT `<` boundary (faithful to the TS repo's
//! `... < beforeIso` predicates), advances `status`, writes the relevant per-phase
//! timestamp + `status_changed_at` + `updated_at`, and runs INSIDE one transaction
//! (all-or-nothing). Because a freshly-idled row gets `idle_at = now`, it cannot also
//! archive in the SAME tick (the 7d archive boundary is not met) — a session advances at
//! most ONE phase per sweep, which is exactly what gives the sweep its free idempotency:
//! a second back-to-back sweep finds nothing newly-eligible and is a no-op.
//!
//! ## active→idle drives off `COALESCE(last_activity_at, updated_at)`
//! The TS predicate keys on `sessions.last_activity_at`. The Rust `agent_session` gains a
//! `last_activity_at` column (migration v28) but it has NO writer yet — the hot
//! `ensure_session`/`append_session_message` paths bump only `updated_at`. So the reaper
//! coalesces to the genuinely-maintained `updated_at`, which is semantically the TS
//! last-activity (it advances on every ensure + every appended message). When a future
//! slice wires a dedicated last-activity writer, `last_activity_at` simply takes precedence
//! with no change here.
//!
//! ## Hard-delete handles the FK child (no orphans)
//! `agent_session_message` has a `FOREIGN KEY(agent_session_id) REFERENCES agent_session`
//! with NO `ON DELETE CASCADE`, and `foreign_keys` is ON on every connection. So a parent
//! DELETE while children exist would FAIL the FK constraint. The hard-delete therefore
//! DELETEs the doomed sessions' child messages FIRST, then the parent rows — same
//! transaction, no orphan rows.
//!
//! ## OMISSIONS vs the TS sweep (documented, intentional)
//!   * **Fork-archive.** The TS sweep had a 5th step that archived inactive FORK sessions
//!     (`parent_session_key IS NOT NULL`). The Rust `agent_session` has a `parent_session_id`
//!     (the subagent chain pointer, v23) but NONE of the TS FORK markers
//!     (`forked_from_message_id` / `root_session_key` / a fork timeout) — there is no fork
//!     CONCEPT in the Rust schema. So fork-archive is OMITTED (there is nothing to archive
//!     as a fork).
//!   * **Memory-extraction-on-idle.** The TS sweep enqueued memory extraction when a session
//!     went idle. That responsibility is owned by the SEPARATE Rust session-memory surface
//!     (#599–601, `agent_session_message.memory_extract_status` + the inline extractor), NOT
//!     by this reaper — so it is NOT duplicated here.
//!
//! ## Status / wiring
//! DARK: the reaper TICK that calls [`sweep_lifecycle`] on an interval lives in the Hub WS
//! server bin behind a DEFAULT-OFF env flag (`FRIDAY_RUST_SESSION_REAPER_ENABLED`), so
//! deploying the new binary reaps NOTHING until the operator explicitly flips the flag.
//! Wire-live = (rebuild bin + deploy + flip flag) is a SEPARATE operator-gated step.
//! NOT a v1 GO.

use crate::error::Result;
use crate::retention::{resolve_cutoff, CategoryRetention};
use rusqlite::params;
use rusqlite::Connection;

// ─── Ported timeout constants (mirror src/sessions/friday-session.constants.ts) ───

/// active → idle: no activity for longer than 30 minutes.
pub const IDLE_TIMEOUT_MS: i64 = 30 * 60 * 1000;
/// idle → archived: idle for longer than 7 days.
pub const ARCHIVE_TIMEOUT_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// archived → pruned: archived for longer than 30 days.
pub const PRUNE_TIMEOUT_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// pruned → hard-delete: the ORIGINAL 7-day window. Under DATA-RETENTION-001 the hard-delete is now
/// default-OFF (see [`sweep_lifecycle`]); this window applies ONLY when an operator explicitly opts
/// the session-content category in as `CategoryRetention::AfterDays(HARD_DELETE_TIMEOUT_DAYS)`,
/// which reproduces exactly the old `now - HARD_DELETE_TIMEOUT_MS` cutoff.
pub const HARD_DELETE_TIMEOUT_DAYS: i64 = 7;
/// pruned → hard-delete window in ms (derived from [`HARD_DELETE_TIMEOUT_DAYS`]).
pub const HARD_DELETE_TIMEOUT_MS: i64 = HARD_DELETE_TIMEOUT_DAYS * 24 * 60 * 60 * 1000;

/// Per-transition counts from one [`sweep_lifecycle`] call, for observability. The
/// `hard_deleted` count is the number of `agent_session` ROWS removed (each may have
/// taken child messages with it).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SweepOutcome {
    /// active → idle
    pub idled: usize,
    /// idle → archived
    pub archived: usize,
    /// archived → pruned
    pub pruned: usize,
    /// pruned → hard-deleted (rows removed)
    pub hard_deleted: usize,
    /// child `agent_session_message` rows removed alongside hard-deleted sessions.
    pub messages_deleted: usize,
}

impl SweepOutcome {
    /// Whether this sweep changed anything (any transition fired). Useful for a tick that
    /// only wants to log on a non-empty sweep.
    pub fn is_empty(&self) -> bool {
        self.idled == 0
            && self.archived == 0
            && self.pruned == 0
            && self.hard_deleted == 0
            && self.messages_deleted == 0
    }
}

/// Run the lifecycle transitions with the DEFAULT session-content policy — `Permanent`
/// (DATA-RETENTION-001). This is the entry the runtime reaper calls. Under the permanent default
/// ONLY the active→idle leg runs (idle stays in the owner-discoverable list — a live, resumable
/// conversation). The idle→archived and archived→pruned legs are DEFAULT-OFF because `archived`/
/// `pruned` are excluded from that list (`list_sessions_for_owner`) with no other discovery/restore
/// path, so auto-advancing into them by mere time passing would SOFT-HIDE the session from its
/// owner — a soft-deletion barred by DATA-RETENTION-001. The IRREVERSIBLE pruned→hard-delete leg is
/// likewise SKIPPED. So a session stays active/idle — LISTED + accessible — forever until the user
/// explicitly archives it ([`crate::agent_session::archive_session_for_owner`]) or explicitly
/// enables a session-content retention policy via [`sweep_lifecycle_with_policy`].
pub fn sweep_lifecycle(conn: &Connection, now_ms: i64) -> Result<SweepOutcome> {
    sweep_lifecycle_with_policy(conn, now_ms, CategoryRetention::Permanent)
}

/// Run the lifecycle transitions over `agent_session` in ONE transaction at logical time `now_ms`
/// (epoch ms), with an explicit `session_content` retention policy. Returns the per-transition
/// [`SweepOutcome`] counts.
///
/// active→idle ALWAYS runs (idle is a live, resumable conversation that REMAINS in the
/// owner-discoverable [`crate::agent_session::list_sessions_for_owner`], so idling never hides a
/// session). The idle→archived, archived→pruned, AND pruned→hard-delete legs are ALL gated by
/// `session_content` through the fail-closed [`resolve_cutoff`] — because `archived`/`pruned` are
/// EXCLUDED from the owner list (with no other discovery/restore surface), so auto-advancing into
/// them by mere time passing SOFT-HIDES the session (a soft-deletion), which DATA-RETENTION-001
/// bars. `Permanent` (the default) or ANY invalid config ⇒ [`resolve_cutoff`] returns None ⇒ NONE
/// of those three legs run (only idle); an explicit, well-formed `AfterDays(n)` ⇒ Some ⇒ all three
/// run on their ported per-phase boundaries, with the hard-delete keyed on the resolved cutoff
/// (`AfterDays(HARD_DELETE_TIMEOUT_DAYS)` reproduces the original 7-day pruned→hard-delete cutoff).
/// This extends PR #1608/#1609's default-permanent + fail-closed policy to the full session
/// lifecycle, not just the irreversible hard-delete.
///
/// The steps run in order; each reads the timestamp the PRIOR step wrote, but a strict `<` boundary
/// plus the per-phase timeouts mean a row advances at most one phase per call (a just-idled row's
/// `idle_at = now` is not `< now - ARCHIVE_TIMEOUT`). The whole sweep is all-or-nothing: any error
/// rolls back every transition (no partial sweep).
pub fn sweep_lifecycle_with_policy(
    conn: &Connection,
    now_ms: i64,
    session_content: CategoryRetention,
) -> Result<SweepOutcome> {
    let tx = conn.unchecked_transaction()?;

    // 1. active → idle: no activity for > IDLE_TIMEOUT. Drive off
    //    COALESCE(last_activity_at, updated_at) — last_activity_at has no writer yet, so
    //    updated_at (genuinely maintained) is the live signal. STRICT `<` boundary. The boundary is
    //    computed with `checked_sub`: an i64 UNDERFLOW (a pathological near-`i64::MIN` now_ms) FAILS
    //    CLOSED — the phase is SKIPPED (idled = 0), never a wrapped/bogus cutoff that could
    //    mis-transition a fresh row (#60's "overflow fail-closed" rule, matching `resolve_cutoff`).
    //    Any sane wall clock (~1.7e12) never underflows, so behaviour is unchanged for real times.
    let idled = match now_ms.checked_sub(IDLE_TIMEOUT_MS) {
        Some(idle_before) => tx.execute(
            "UPDATE agent_session
            SET status = 'idle', idle_at = ?1, status_changed_at = ?1, updated_at = ?1
          WHERE status = 'active'
            AND COALESCE(last_activity_at, updated_at) < ?2",
            params![now_ms, idle_before],
        )?,
        None => 0,
    };

    // DATA-RETENTION-001 SOFT-HIDING GATE (the single fail-closed switch for the non-idle legs).
    // `archived` and `pruned` are BOTH EXCLUDED from the ONLY owner-discovery path —
    // `list_sessions_for_owner` (agent_session.rs: `status NOT IN ('archived','pruned')`) — and
    // there is NO archived/pruned list/search/export/restore surface. So auto-advancing a session
    // into `archived`/`pruned` by mere time passing SOFT-HIDES it from its owner (a soft-deletion),
    // even though the row is not hard-deleted. Therefore the reversible archive/prune legs AND the
    // irreversible hard-delete all bind to the SAME fail-closed `resolve_cutoff` gate the artifact
    // sweep (#1608) and the #1609 hard-delete use: `Permanent` (the default) or ANY invalid config ⇒
    // None ⇒ ONLY the active→idle leg runs, so a session stays active/idle — LISTED + accessible —
    // FOREVER until the user explicitly archives it (`archive_session_for_owner`) or explicitly
    // enables a session-content retention policy. An explicit, well-formed `AfterDays(n)` ⇒ Some ⇒
    // the full lifecycle runs on its ported per-phase boundaries (hard-delete at the resolved cutoff).
    // active→idle is DELIBERATELY outside this gate: idle REMAINS in the owner list (a live,
    // resumable conversation), so idling never hides a session.
    let content_cutoff = resolve_cutoff(now_ms, session_content);

    // 2. idle → archived: GATED + overflow-safe. Runs ONLY under an explicit session-content policy
    //    (content_cutoff is Some); under the permanent default it is SKIPPED (archiving would
    //    soft-hide the session). idle for > ARCHIVE_TIMEOUT (drives off idle_at). STRICT `<`. The
    //    boundary is computed with `checked_sub`, so an i64 UNDERFLOW ALSO fails closed (skip = 0);
    //    `and_then` folds the policy gate AND the overflow check into one Option (#60 overflow rule).
    let archived = match content_cutoff.and_then(|_| now_ms.checked_sub(ARCHIVE_TIMEOUT_MS)) {
        Some(archive_before) => tx.execute(
            "UPDATE agent_session
                SET status = 'archived', archived_at = ?1, status_changed_at = ?1, updated_at = ?1
              WHERE status = 'idle'
                AND idle_at IS NOT NULL
                AND idle_at < ?2",
            params![now_ms, archive_before],
        )?,
        None => 0,
    };

    // 3. archived → pruned: GATED by the SAME gate as archive, and overflow-safe via `checked_sub`
    //    (an i64 UNDERFLOW fails closed = skip = 0). archived for > PRUNE_TIMEOUT (drives off
    //    archived_at). STRICT `<`.
    let pruned = match content_cutoff.and_then(|_| now_ms.checked_sub(PRUNE_TIMEOUT_MS)) {
        Some(prune_before) => tx.execute(
            "UPDATE agent_session
                SET status = 'pruned', pruned_at = ?1, status_changed_at = ?1, updated_at = ?1
              WHERE status = 'archived'
                AND archived_at IS NOT NULL
                AND archived_at < ?2",
            params![now_ms, prune_before],
        )?,
        None => 0,
    };

    // 4. pruned → hard-delete: the IRREVERSIBLE deletion of chat/session USER-DATA, gated by the
    //    SAME `content_cutoff`. `Permanent` (default) or any invalid config ⇒ None ⇒ NO hard-delete
    //    (chat retained forever). When enabled, STRICT `<` on pruned_at; child messages deleted
    //    FIRST (FK has no ON DELETE CASCADE and foreign_keys is ON), then the parent rows — same
    //    txn, no orphans.
    let (messages_deleted, hard_deleted) = match content_cutoff {
        Some(hard_delete_before) => {
            let m = tx.execute(
                "DELETE FROM agent_session_message
          WHERE agent_session_id IN (
              SELECT agent_session_id FROM agent_session
               WHERE status = 'pruned'
                 AND pruned_at IS NOT NULL
                 AND pruned_at < ?1
          )",
                params![hard_delete_before],
            )?;
            let h = tx.execute(
                "DELETE FROM agent_session
          WHERE status = 'pruned'
            AND pruned_at IS NOT NULL
            AND pruned_at < ?1",
                params![hard_delete_before],
            )?;
            (m, h)
        }
        // PERMANENT / fail-closed: chat/session user-data is never destroyed.
        None => (0usize, 0usize),
    };

    // M4 receipt — FOLDED INTO THE SWEEP TXN, before commit, so it is ATOMIC with the irreversible
    // hard-delete. Reversibility rationale: M4's prune leg is IRREVERSIBLE (the rows are gone), so
    // the invariant is "a hard-delete must NEVER commit without its receipt." The receipt INSERT
    // therefore shares this txn and its `?` propagates: a receipt-write failure rolls the WHOLE
    // sweep back, leaving no delete-without-receipt. Rolling back is safe because the reaper is
    // idempotent and re-runs every tick, so a transient `SQLITE_BUSY` simply retries the whole
    // sweep next tick. This is the deliberate MIRROR of M3's artifact sweep (retention.rs), where
    // expiry is REVERSIBLE, so there the receipt is best-effort AFTER the commit and must never
    // block the delete (receipt-must-not-block-delete vs. delete-must-not-happen-without-receipt).
    //
    // Written ONLY on a non-empty sweep so an idle-only tick never grows the log (retention_log has
    // no sweep of its own); a hard-delete is always non-empty, so a real prune is always recorded.
    // The prune leg is today armed-but-dormant (`pruned_at = 0` fires nothing until a session ages
    // through prune), but the receipt path is correct the moment it does.
    let nonempty =
        idled != 0 || archived != 0 || pruned != 0 || hard_deleted != 0 || messages_deleted != 0;
    if nonempty {
        let summary = format!(
            "session.reaper:idled={} archived={} pruned={} hard_deleted={} messages_deleted={}",
            idled, archived, pruned, hard_deleted, messages_deleted,
        );
        crate::insert_retention_log_in(&tx, "session.reaper", &summary, now_ms)?;
    }

    tx.commit()?;

    Ok(SweepOutcome {
        idled,
        archived,
        pruned,
        hard_deleted,
        messages_deleted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_session::{
        append_session_message, ensure_session, ensure_session_with_owner, fork_session_for_owner,
        list_sessions_for_owner, open_session_for_owner, session_message_count_for_owner,
        SessionMessage, SessionOwner,
    };
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
                "friday-session-lifecycle-{}-{}-{}-{nanos}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed),
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn status_of(db: &Db, id: &str) -> String {
        db.conn()
            .query_row(
                "SELECT status FROM agent_session WHERE agent_session_id = ?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
    }

    fn exists(db: &Db, id: &str) -> bool {
        db.conn()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_session WHERE agent_session_id = ?1)",
                [id],
                |r| r.get::<_, bool>(0),
            )
            .unwrap()
    }

    /// Run the sweep with the hard-delete leg EXPLICITLY opted in (the operator-enabled policy that
    /// reproduces the original 7-day pruned→hard-delete cutoff). Tests that exercise the hard-delete
    /// mechanism call this; the DEFAULT-policy [`sweep_lifecycle`] is covered separately (it must
    /// hard-delete NOTHING — DATA-RETENTION-001).
    fn sweep_enabled(conn: &Connection, now_ms: i64) -> Result<SweepOutcome> {
        sweep_lifecycle_with_policy(
            conn,
            now_ms,
            CategoryRetention::AfterDays(HARD_DELETE_TIMEOUT_DAYS),
        )
    }

    /// Hand-place a session in a given phase with explicit timestamps so a boundary test can
    /// pin the exact per-phase timestamp the next transition reads. (active→idle is ALSO
    /// covered via the real `ensure_session` path in its own test so the dead-predicate bug
    /// — a NULL `last_activity_at` with no COALESCE — would be caught.)
    fn seed(
        db: &Db,
        id: &str,
        status: &str,
        idle_at: Option<i64>,
        archived_at: Option<i64>,
        pruned_at: Option<i64>,
        updated_at: i64,
    ) {
        db.conn()
            .execute(
                "INSERT INTO agent_session
                    (agent_session_id, created_at, updated_at, status,
                     idle_at, archived_at, pruned_at, status_changed_at, last_activity_at)
                 VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?2, NULL)",
                params![id, updated_at, status, idle_at, archived_at, pruned_at],
            )
            .unwrap();
    }

    // --- migration v28 ---------------------------------------------------------

    #[test]
    fn migration_v28_reaches_latest_and_adds_lifecycle_columns() {
        let db = Db::open_hub(&tmp("v28")).unwrap();
        // The fresh chain reaches the code's max version (derived, so a later additive
        // migration does not break this).
        let v: i64 = db
            .conn()
            .query_row("SELECT version FROM schema_version WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        let expected = crate::hub_migrations()
            .iter()
            .map(|m| m.version)
            .max()
            .unwrap();
        assert_eq!(v, expected, "fresh migration reaches the latest version");
        assert!(v >= 28, "the v28 lifecycle columns exist");

        // A freshly-ensured session defaults to status 'active' with all lifecycle
        // timestamps NULL — the at-rest never-swept state.
        ensure_session(db.conn(), "s1", 1000).unwrap();
        let (status, idle_at, archived_at, pruned_at, last_activity_at): (
            String,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
        ) = db
            .conn()
            .query_row(
                "SELECT status, idle_at, archived_at, pruned_at, last_activity_at
                 FROM agent_session WHERE agent_session_id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(status, "active");
        assert_eq!(idle_at, None);
        assert_eq!(archived_at, None);
        assert_eq!(pruned_at, None);
        assert_eq!(
            last_activity_at, None,
            "last_activity_at is a NULL forward hook with no writer"
        );
    }

    #[test]
    fn status_check_rejects_unknown_phase() {
        let db = Db::open_hub(&tmp("statuscheck")).unwrap();
        ensure_session(db.conn(), "s1", 1000).unwrap();
        // The CHECK admits only the TS vocabulary.
        let bad = db.conn().execute(
            "UPDATE agent_session SET status = 'zombie' WHERE agent_session_id = 's1'",
            [],
        );
        assert!(bad.is_err(), "an out-of-vocabulary status is rejected");
        for ok in ["active", "idle", "archived", "pruned"] {
            db.conn()
                .execute(
                    "UPDATE agent_session SET status = ?1 WHERE agent_session_id = 's1'",
                    [ok],
                )
                .unwrap();
        }
    }

    // --- per-transition boundary: just-under vs just-over ----------------------

    #[test]
    fn active_to_idle_boundary_via_real_ensure_path() {
        // CRITICAL: build the row via the REAL `ensure_session` path (which writes ONLY
        // updated_at, leaving last_activity_at NULL) and age it via updated_at. If the
        // predicate keyed on a bare `last_activity_at < ?` (NULL ⇒ never matches), this row
        // would NEVER idle and this test would FAIL — catching the dead-predicate bug.
        let db = Db::open_hub(&tmp("idle-real")).unwrap();
        let created = 1_000_000;
        ensure_session(db.conn(), "s1", created).unwrap();

        // Just UNDER the idle timeout: now = created + IDLE_TIMEOUT (not strictly greater).
        let just_under = created + IDLE_TIMEOUT_MS;
        let out = sweep_lifecycle(db.conn(), just_under).unwrap();
        assert_eq!(
            out.idled, 0,
            "at-exactly-threshold does not fire (strict <)"
        );
        assert_eq!(status_of(&db, "s1"), "active");

        // Just OVER: now = created + IDLE_TIMEOUT + 1.
        let just_over = created + IDLE_TIMEOUT_MS + 1;
        let out = sweep_lifecycle(db.conn(), just_over).unwrap();
        assert_eq!(
            out.idled, 1,
            "past-threshold idles via COALESCE(updated_at)"
        );
        assert_eq!(status_of(&db, "s1"), "idle");
        // The transition wrote idle_at + status_changed_at + updated_at = now.
        let (idle_at, sca, upd): (i64, i64, i64) = db
            .conn()
            .query_row(
                "SELECT idle_at, status_changed_at, updated_at
                 FROM agent_session WHERE agent_session_id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((idle_at, sca, upd), (just_over, just_over, just_over));
    }

    #[test]
    fn last_activity_at_takes_precedence_when_set() {
        // When last_activity_at IS set, it (not updated_at) drives the idle predicate —
        // proving the COALESCE precedence. updated_at is OLD (would idle) but last_activity_at
        // is RECENT, so the session stays active.
        let db = Db::open_hub(&tmp("idle-precedence")).unwrap();
        let old = 1_000_000;
        ensure_session(db.conn(), "s1", old).unwrap();
        let recent = old + IDLE_TIMEOUT_MS; // recent activity
        db.conn()
            .execute(
                "UPDATE agent_session SET last_activity_at = ?1 WHERE agent_session_id = 's1'",
                [recent],
            )
            .unwrap();
        // Sweep just past the OLD updated_at's idle boundary but within the recent activity's.
        let now = old + IDLE_TIMEOUT_MS + 1;
        let out = sweep_lifecycle(db.conn(), now).unwrap();
        assert_eq!(
            out.idled, 0,
            "recent last_activity_at keeps the session active despite old updated_at"
        );
        assert_eq!(status_of(&db, "s1"), "active");
    }

    #[test]
    fn idle_to_archived_boundary() {
        // The idle→archived transition is now DEFAULT-OFF (DATA-RETENTION-001: archiving soft-hides
        // the session). This boundary test exercises the MECHANISM, so it runs the EXPLICIT-policy
        // entry (`sweep_enabled`); the default-policy behaviour (archive does NOT fire) is asserted
        // separately by the soft-hiding tests.
        let db = Db::open_hub(&tmp("archive")).unwrap();
        let now = 100_000_000_000_i64;
        // idle_at just UNDER the archive timeout (not strictly past) → not archived.
        seed(
            &db,
            "under",
            "idle",
            Some(now - ARCHIVE_TIMEOUT_MS),
            None,
            None,
            1,
        );
        // idle_at just OVER → archived.
        seed(
            &db,
            "over",
            "idle",
            Some(now - ARCHIVE_TIMEOUT_MS - 1),
            None,
            None,
            1,
        );
        let out = sweep_enabled(db.conn(), now).unwrap();
        assert_eq!(out.archived, 1);
        assert_eq!(status_of(&db, "under"), "idle");
        assert_eq!(status_of(&db, "over"), "archived");
        let archived_at: i64 = db
            .conn()
            .query_row(
                "SELECT archived_at FROM agent_session WHERE agent_session_id = 'over'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(archived_at, now, "archived_at stamped at now");
    }

    #[test]
    fn archived_to_pruned_boundary() {
        // The archived→pruned transition is now DEFAULT-OFF (gated with archive). This boundary test
        // exercises the MECHANISM, so it runs the EXPLICIT-policy entry (`sweep_enabled`).
        let db = Db::open_hub(&tmp("prune")).unwrap();
        let now = 100_000_000_000_i64;
        seed(
            &db,
            "under",
            "archived",
            None,
            Some(now - PRUNE_TIMEOUT_MS),
            None,
            1,
        );
        seed(
            &db,
            "over",
            "archived",
            None,
            Some(now - PRUNE_TIMEOUT_MS - 1),
            None,
            1,
        );
        let out = sweep_enabled(db.conn(), now).unwrap();
        assert_eq!(out.pruned, 1);
        assert_eq!(status_of(&db, "under"), "archived");
        assert_eq!(status_of(&db, "over"), "pruned");
        let pruned_at: i64 = db
            .conn()
            .query_row(
                "SELECT pruned_at FROM agent_session WHERE agent_session_id = 'over'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pruned_at, now, "pruned_at stamped at now");
    }

    #[test]
    fn pruned_to_hard_delete_boundary() {
        let db = Db::open_hub(&tmp("harddelete")).unwrap();
        let now = 100_000_000_000_i64;
        // pruned_at just UNDER the hard-delete timeout → NOT deleted.
        seed(
            &db,
            "keep",
            "pruned",
            None,
            None,
            Some(now - HARD_DELETE_TIMEOUT_MS),
            1,
        );
        // pruned_at just OVER → hard-deleted.
        seed(
            &db,
            "gone",
            "pruned",
            None,
            None,
            Some(now - HARD_DELETE_TIMEOUT_MS - 1),
            1,
        );
        let out = sweep_enabled(db.conn(), now).unwrap();
        assert_eq!(out.hard_deleted, 1);
        assert!(
            exists(&db, "keep"),
            "not-yet-expired pruned session is kept"
        );
        assert!(
            !exists(&db, "gone"),
            "past-timeout pruned session is removed"
        );
    }

    // --- hard-delete safety: only past-timeout pruned rows go -------------------

    #[test]
    fn hard_delete_only_removes_expired_pruned_not_other_phases() {
        let db = Db::open_hub(&tmp("hd-safety")).unwrap();
        let now = 100_000_000_000_i64;
        // A row in each non-pruned phase, all old enough to be deleted IF the predicate were
        // wrong — none should be touched by hard-delete (they advance at most one phase).
        seed(&db, "act", "active", None, None, None, 1);
        seed(&db, "idl", "idle", Some(1), None, None, 1);
        seed(&db, "arc", "archived", None, Some(1), None, 1);
        // A pruned row NOT yet past the hard-delete timeout.
        seed(&db, "fresh-pruned", "pruned", None, None, Some(now - 1), 1);
        // A pruned row past the timeout.
        seed(
            &db,
            "old-pruned",
            "pruned",
            None,
            None,
            Some(now - HARD_DELETE_TIMEOUT_MS - 1),
            1,
        );
        let out = sweep_enabled(db.conn(), now).unwrap();
        assert_eq!(
            out.hard_deleted, 1,
            "only the expired pruned row is deleted"
        );
        assert!(exists(&db, "fresh-pruned"));
        assert!(!exists(&db, "old-pruned"));
        // The other-phase rows DID advance (they were aged), but none was DELETED.
        assert!(exists(&db, "act"));
        assert!(exists(&db, "idl"));
        assert!(exists(&db, "arc"));
    }

    // --- hard-delete cleans child messages (no orphans) ------------------------

    #[test]
    fn hard_delete_removes_child_messages_no_orphan() {
        let db = Db::open_hub(&tmp("hd-children")).unwrap();
        let now = 100_000_000_000_i64;
        // A pruned-and-expired session WITH child messages, and a sibling pruned session
        // that is NOT yet expired (its messages must survive).
        seed(
            &db,
            "gone",
            "pruned",
            None,
            None,
            Some(now - HARD_DELETE_TIMEOUT_MS - 1),
            1,
        );
        seed(&db, "keep", "pruned", None, None, Some(now - 1), 1);
        append_session_message(
            db.conn(),
            "gone",
            &SessionMessage::new("user", "secret", None),
            10,
        )
        .unwrap();
        append_session_message(
            db.conn(),
            "gone",
            &SessionMessage::new("assistant", "reply", None),
            11,
        )
        .unwrap();
        append_session_message(
            db.conn(),
            "keep",
            &SessionMessage::new("user", "still here", None),
            10,
        )
        .unwrap();
        // NOTE: append bumps updated_at to 11; that does not matter for hard-delete
        // (it keys on pruned_at), and the pre-set pruned_at survives the append's
        // updated_at bump.

        let out = sweep_enabled(db.conn(), now).unwrap();
        assert_eq!(out.hard_deleted, 1);
        assert_eq!(
            out.messages_deleted, 2,
            "both child messages of 'gone' removed"
        );
        assert!(!exists(&db, "gone"));
        // No orphan messages for the deleted session.
        let orphans: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM agent_session_message WHERE agent_session_id = 'gone'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0, "no orphaned child rows for the deleted session");
        // The kept session's message survives.
        assert!(exists(&db, "keep"));
        let kept: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM agent_session_message WHERE agent_session_id = 'keep'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, 1, "the non-expired session keeps its message");
    }

    // --- M4 receipt: the reaper records the irreversible-prune counts -----------

    fn retention_log_count(db: &Db) -> i64 {
        db.conn()
            .query_row("SELECT COUNT(*) FROM retention_log", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn hard_delete_writes_session_reaper_receipt_with_prune_counts() {
        // M4: the hard-delete leg is the IRREVERSIBLE prune. A non-empty sweep must leave a
        // content-free `session.reaper` receipt in `retention_log` carrying the hard_deleted /
        // messages_deleted counts (the audit of the prune). It is NOT an audit_ledger row.
        let db = Db::open_hub(&tmp("reaper-receipt")).unwrap();
        let now = 100_000_000_000_i64;
        seed(
            &db,
            "gone",
            "pruned",
            None,
            None,
            Some(now - HARD_DELETE_TIMEOUT_MS - 1),
            1,
        );
        append_session_message(
            db.conn(),
            "gone",
            &SessionMessage::new("user", "secret", None),
            10,
        )
        .unwrap();
        append_session_message(
            db.conn(),
            "gone",
            &SessionMessage::new("assistant", "reply", None),
            11,
        )
        .unwrap();

        let out = sweep_enabled(db.conn(), now).unwrap();
        assert_eq!(out.hard_deleted, 1);
        assert_eq!(out.messages_deleted, 2);

        assert_eq!(
            retention_log_count(&db),
            1,
            "one non-empty sweep ⇒ one receipt"
        );
        let (tick_kind, summary): (String, String) = db
            .conn()
            .query_row("SELECT tick_kind, summary FROM retention_log", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(tick_kind, "session.reaper");
        assert_eq!(
            summary, "session.reaper:idled=0 archived=0 pruned=0 hard_deleted=1 messages_deleted=2",
            "receipt carries the irreversible-prune counts"
        );
    }

    #[test]
    fn receipt_failure_rolls_back_hard_delete() {
        // M4 atomicity invariant: the irreversible hard-delete must NEVER commit without its
        // receipt. The receipt INSERT is folded into the sweep txn, so if it fails the WHOLE sweep
        // rolls back. We force a deterministic receipt failure by dropping `retention_log` before
        // the sweep: `insert_retention_log_in` then errors, `?` propagates, and the txn unwinds.
        // The eligible session + its messages must SURVIVE (no delete-without-receipt).
        let db = Db::open_hub(&tmp("reaper-receipt-fail")).unwrap();
        let now = 100_000_000_000_i64;
        seed(
            &db,
            "survivor",
            "pruned",
            None,
            None,
            Some(now - HARD_DELETE_TIMEOUT_MS - 1),
            1,
        );
        append_session_message(
            db.conn(),
            "survivor",
            &SessionMessage::new("user", "secret", None),
            10,
        )
        .unwrap();

        // Remove the receipt table so the folded INSERT cannot succeed.
        db.conn().execute_batch("DROP TABLE retention_log").unwrap();

        let res = sweep_enabled(db.conn(), now);
        assert!(
            res.is_err(),
            "a receipt-write failure must surface as an Err, not a silently-committed prune"
        );
        assert!(
            exists(&db, "survivor"),
            "hard-delete must roll back when its receipt cannot be written"
        );
        let msgs: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM agent_session_message WHERE agent_session_id = 'survivor'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(msgs, 1, "child messages must roll back with the parent");
    }

    #[test]
    fn empty_reaper_sweep_writes_no_receipt() {
        // Growth fix: an idle tick (nothing eligible) writes NO receipt — retention_log has no
        // sweep of its own, so an all-zero row every tick would grow unbounded.
        let db = Db::open_hub(&tmp("reaper-empty")).unwrap();
        let out = sweep_lifecycle(db.conn(), 100_000_000_000_i64).unwrap();
        assert!(out.is_empty(), "no seeded rows ⇒ nothing swept");
        assert_eq!(
            retention_log_count(&db),
            0,
            "empty reaper sweep ⇒ no receipt"
        );
    }

    // --- idempotency: second back-to-back sweep is a no-op ---------------------

    #[test]
    fn second_sweep_is_a_noop() {
        let db = Db::open_hub(&tmp("idem")).unwrap();
        let now = 100_000_000_000_i64;
        // One row per phase, each just-eligible to advance exactly one step.
        seed(
            &db,
            "a",
            "active",
            None,
            None,
            None,
            now - IDLE_TIMEOUT_MS - 1,
        );
        seed(
            &db,
            "i",
            "idle",
            Some(now - ARCHIVE_TIMEOUT_MS - 1),
            None,
            None,
            1,
        );
        seed(
            &db,
            "r",
            "archived",
            None,
            Some(now - PRUNE_TIMEOUT_MS - 1),
            None,
            1,
        );
        seed(
            &db,
            "p",
            "pruned",
            None,
            None,
            Some(now - HARD_DELETE_TIMEOUT_MS - 1),
            1,
        );

        let first = sweep_enabled(db.conn(), now).unwrap();
        assert_eq!(first.idled, 1);
        assert_eq!(first.archived, 1);
        assert_eq!(first.pruned, 1);
        assert_eq!(first.hard_deleted, 1);
        // 'a' idled (idle_at = now); it cannot ALSO archive this tick (7d boundary unmet).
        assert_eq!(status_of(&db, "a"), "idle");

        // Second sweep at the SAME now: nothing is newly eligible → no-op.
        let second = sweep_enabled(db.conn(), now).unwrap();
        assert!(
            second.is_empty(),
            "second back-to-back sweep changes nothing"
        );
    }

    // --- fresh-DB / all-active no-op -------------------------------------------

    #[test]
    fn all_active_fresh_db_is_a_noop() {
        let db = Db::open_hub(&tmp("fresh")).unwrap();
        let now = 100_000_000_000_i64;
        // Three freshly-ensured active sessions whose updated_at is RECENT (within the idle
        // window) → no transition fires.
        ensure_session(db.conn(), "s1", now).unwrap();
        ensure_session(db.conn(), "s2", now - 1).unwrap();
        ensure_session(db.conn(), "s3", now - IDLE_TIMEOUT_MS).unwrap(); // exactly at boundary
        let out = sweep_lifecycle(db.conn(), now).unwrap();
        assert!(
            out.is_empty(),
            "fresh all-active DB → zero transitions, zero deletes"
        );
        assert_eq!(status_of(&db, "s1"), "active");
        assert_eq!(status_of(&db, "s2"), "active");
        assert_eq!(status_of(&db, "s3"), "active");
    }

    #[test]
    fn empty_db_sweep_is_a_noop() {
        let db = Db::open_hub(&tmp("emptydb")).unwrap();
        let out = sweep_lifecycle(db.conn(), 100_000_000_000).unwrap();
        assert!(out.is_empty());
    }

    // --- full lifecycle across ticks (single-step-per-tick) --------------------

    #[test]
    fn one_session_walks_the_whole_lifecycle_one_phase_per_tick() {
        let db = Db::open_hub(&tmp("walk")).unwrap();
        let t0 = 1_000_000_000_i64;
        ensure_session(db.conn(), "s", t0).unwrap();

        // Tick 1: past idle → idle.
        let t1 = t0 + IDLE_TIMEOUT_MS + 1;
        assert_eq!(sweep_enabled(db.conn(), t1).unwrap().idled, 1);
        assert_eq!(status_of(&db, "s"), "idle");

        // Tick 2: past archive (idle_at was t1) → archived.
        let t2 = t1 + ARCHIVE_TIMEOUT_MS + 1;
        assert_eq!(sweep_enabled(db.conn(), t2).unwrap().archived, 1);
        assert_eq!(status_of(&db, "s"), "archived");

        // Tick 3: past prune (archived_at was t2) → pruned.
        let t3 = t2 + PRUNE_TIMEOUT_MS + 1;
        assert_eq!(sweep_enabled(db.conn(), t3).unwrap().pruned, 1);
        assert_eq!(status_of(&db, "s"), "pruned");

        // Tick 4: past hard-delete (pruned_at was t3) → gone.
        let t4 = t3 + HARD_DELETE_TIMEOUT_MS + 1;
        assert_eq!(sweep_enabled(db.conn(), t4).unwrap().hard_deleted, 1);
        assert!(!exists(&db, "s"));
    }

    // --- DATA-RETENTION-001: the DEFAULT session-content policy never hard-deletes chat ---

    #[test]
    fn default_policy_never_hard_deletes_chat_even_under_far_future_time_travel() {
        // The pruned→hard-delete leg destroys chat/session USER-DATA. DATA-RETENTION-001: that
        // deletion is PERMANENT-by-default (default-OFF), so `sweep_lifecycle` (the default-policy
        // entry the runtime reaper calls) must hard-delete NOTHING even far in the future.
        //
        // RED-FIRST: against the pre-fix code (hard-delete keyed only on pruned_at age) this
        // deletes the expired pruned session, so `hard_deleted == 1` and this test FAILS. After
        // the fix (default session-content policy = permanent, fail-closed) it hard-deletes
        // nothing and PASSES. The status transitions (idle/archive/prune) are NON-destructive
        // lifecycle and are unaffected.
        let db = Db::open_hub(&tmp("session-default-permanent")).unwrap();
        let now = 1_000_000 * 24 * 60 * 60 * 1000_i64; // ~1e6 days into the future
                                                       // A long-pruned session WITH chat messages — maximally eligible under an age-only rule.
        seed(&db, "old_pruned", "pruned", None, None, Some(1), 1);
        append_session_message(
            db.conn(),
            "old_pruned",
            &SessionMessage::new("user", "CANONICAL-CHAT-CONTENT", None),
            10,
        )
        .unwrap();

        let out = sweep_lifecycle(db.conn(), now).unwrap();

        assert_eq!(
            out.hard_deleted, 0,
            "DEFAULT policy is PERMANENT: chat/session user-data is never hard-deleted"
        );
        assert_eq!(
            out.messages_deleted, 0,
            "chat messages are never destroyed by default"
        );
        assert!(
            exists(&db, "old_pruned"),
            "the pruned session + its chat survive the default (permanent) reaper forever"
        );
        let msgs: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM agent_session_message WHERE agent_session_id = 'old_pruned'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            msgs, 1,
            "chat content is retained until the user explicitly deletes"
        );
    }

    #[test]
    fn default_policy_idles_but_never_archives_prunes_or_hard_deletes() {
        // DATA-RETENTION-001 (corrected): under the DEFAULT (permanent) policy the reaper advances a
        // session active→idle ONLY. It must NOT auto-archive or auto-prune — `archived`/`pruned` are
        // excluded from the owner-discoverable list, so advancing into them would SOFT-HIDE the
        // session (a soft-deletion). And it never hard-deletes. So a session idles once and then
        // stays `idle` — LISTED + accessible — forever, no matter how far time advances.
        let db = Db::open_hub(&tmp("default-idle-only")).unwrap();
        let t0 = 1_000_000_000_i64;
        ensure_session(db.conn(), "s", t0).unwrap();

        // active→idle DOES fire (idle is safe: it stays in the owner list).
        let t1 = t0 + IDLE_TIMEOUT_MS + 1;
        assert_eq!(
            sweep_lifecycle(db.conn(), t1).unwrap().idled,
            1,
            "active→idle still fires under the default policy"
        );
        assert_eq!(status_of(&db, "s"), "idle");

        // Far past the old 7d archive boundary: idle→archived is DEFAULT-OFF, so it does NOT fire.
        let t2 = t1 + ARCHIVE_TIMEOUT_MS + 1;
        let out2 = sweep_lifecycle(db.conn(), t2).unwrap();
        assert_eq!(
            out2.archived, 0,
            "idle→archived is default-OFF (archiving would soft-hide the session)"
        );
        assert_eq!(out2.pruned, 0);
        assert_eq!(
            status_of(&db, "s"),
            "idle",
            "the session stays idle (listed)"
        );

        // Far past the old prune + hard-delete windows combined: still idle, still present.
        let t3 = t2 + PRUNE_TIMEOUT_MS + HARD_DELETE_TIMEOUT_MS * 1000 + 1;
        let out3 = sweep_lifecycle(db.conn(), t3).unwrap();
        assert!(
            out3.archived == 0 && out3.pruned == 0 && out3.hard_deleted == 0,
            "default policy never archives/prunes/hard-deletes, no matter how far time advances"
        );
        assert!(
            exists(&db, "s"),
            "the session survives forever under the permanent default"
        );
        assert_eq!(
            status_of(&db, "s"),
            "idle",
            "it stays idle — the owner keeps normal discovery + access forever"
        );
    }

    // --- DATA-RETENTION-001: the DEFAULT policy must NOT SOFT-HIDE a session from its owner ---
    //
    // The Advisor defect this PR fixes: under the permanent default the reaper still auto-advanced a
    // session active→idle→ARCHIVED→PRUNED by mere time passing. `archived`/`pruned` are EXCLUDED from
    // the ONLY owner-discovery path — `list_sessions_for_owner` (agent_session.rs:
    // `WHERE user_id = ?1 AND status NOT IN ('archived','pruned')`) — and there is NO archived/pruned
    // list/search/export/restore surface. So even though the DB row is NOT hard-deleted, the owner
    // AUTOMATICALLY loses the normal discovery + access path to their own session once time passes.
    // That is SOFT-HIDING = soft-deletion, which VIOLATES DATA-RETENTION-001 (local data stays
    // PERMANENT + ACCESSIBLE until the user explicitly deletes; auto time-based lifecycle is
    // default-OFF / user-controlled).
    //
    // ORACLE = the REAL owner-facing functions, NOT "DB row exists". This drives TWO real DEFAULT
    // `sweep_lifecycle` ticks across time (the exact call the production reaper makes,
    // hub_agent_run_server.rs) and asserts the session stays discoverable + readable + resumable
    // through `list_sessions_for_owner` / `open_session_for_owner` / `fork_session_for_owner`.
    //
    // RED-FIRST: against the pre-fix code the second tick ARCHIVES the session, so
    // `list_sessions_for_owner` returns [] and the discovery assertion FAILS. After the fix (archive
    // is default-OFF, only idle auto-runs) the session stays `idle` — which IS in the owner list —
    // and every owner-path assertion PASSES.
    #[test]
    fn default_permanent_keeps_session_discoverable_via_owner_list_forever() {
        let db = Db::open_hub(&tmp("softhide-default-discoverable")).unwrap();
        let owner = SessionOwner {
            user_id: Some("owner-u1".into()),
            ..Default::default()
        };
        let t0 = 1_000_000_000_i64;
        ensure_session_with_owner(db.conn(), "s1", &owner, t0).unwrap();
        append_session_message(
            db.conn(),
            "s1",
            &SessionMessage::new("user", "CANONICAL-OWNER-CHAT", None),
            t0,
        )
        .unwrap();

        // Precondition: a fresh owned session is discoverable via the owner list.
        assert!(
            list_sessions_for_owner(db.conn(), "owner-u1")
                .unwrap()
                .iter()
                .any(|s| s.agent_session_id == "s1"),
            "precondition: a fresh owned session is discoverable"
        );

        // Tick 1 (DEFAULT policy): active→idle. An idle session REMAINS in the owner list (a live,
        // resumable conversation), so discovery is unaffected.
        let t1 = t0 + IDLE_TIMEOUT_MS + 1;
        sweep_lifecycle(db.conn(), t1).unwrap();
        assert_eq!(status_of(&db, "s1"), "idle");
        assert!(
            list_sessions_for_owner(db.conn(), "owner-u1")
                .unwrap()
                .iter()
                .any(|s| s.agent_session_id == "s1"),
            "an idle session is still discoverable in the owner list"
        );

        // Tick 2 (DEFAULT policy), far past the 7d archive boundary. Pre-fix: this ARCHIVES the
        // session (idle_at is > 7d old) and it VANISHES from the owner list. Post-fix: archive is
        // default-OFF, so it stays idle and STAYS discoverable.
        let t2 = t1 + ARCHIVE_TIMEOUT_MS + PRUNE_TIMEOUT_MS + 1;
        let out = sweep_lifecycle(db.conn(), t2).unwrap();
        assert_eq!(
            out.archived, 0,
            "DEFAULT (permanent) policy must NOT auto-archive: archiving soft-hides the session"
        );
        assert_eq!(out.pruned, 0, "DEFAULT policy must NOT auto-prune");
        assert_eq!(out.hard_deleted, 0, "DEFAULT policy never hard-deletes");
        assert_eq!(
            status_of(&db, "s1"),
            "idle",
            "the session stays in an owner-LISTED status forever under the permanent default"
        );

        // (1) DISCOVERABLE — the load-bearing RED assertion: still returned by the owner LIST query.
        let listed = list_sessions_for_owner(db.conn(), "owner-u1").unwrap();
        assert!(
            listed.iter().any(|s| s.agent_session_id == "s1"),
            "SOFT-HIDING defect: the owner must STILL discover their own session via the normal list"
        );

        // (2) READABLE / EXPORTABLE — get-by-id via the normal owner path returns the chat body.
        let opened = open_session_for_owner(db.conn(), "owner-u1", "s1")
            .unwrap()
            .expect("owner can open their own session");
        assert_eq!(opened.len(), 1);
        assert_eq!(opened[0].content, "CANONICAL-OWNER-CHAT");
        assert_eq!(
            session_message_count_for_owner(db.conn(), "owner-u1", "s1").unwrap(),
            Some(1),
            "the owner can export/count the session content via the normal path"
        );

        // (3) RESTORABLE / ACCESSIBLE — the owner can resume the conversation (fork it into a fresh
        // ACTIVE branch), and that branch is itself discoverable in the owner list.
        let fork = fork_session_for_owner(db.conn(), "owner-u1", "s1", t2 + 1).unwrap();
        assert!(
            fork.accepted,
            "the owner can restore/resume their session by forking it"
        );
        let child = fork.child_session_id.expect("fork mints a child session");
        let listed_after = list_sessions_for_owner(db.conn(), "owner-u1").unwrap();
        assert!(
            listed_after.iter().any(|s| s.agent_session_id == child),
            "the restored (forked) branch is discoverable in the owner list"
        );
    }

    // --- DATA-RETENTION-001 positive control: an EXPLICIT session-content policy opts IN ---
    //
    // The mirror of the RED test: when the user EXPLICITLY enables a session-content retention policy
    // (`AfterDays(n)`), the archived/pruned/hard-delete legs run PER that policy — gated by the SAME
    // `resolve_cutoff` the artifact sweep and the #1609 hard-delete already use. This asserts the
    // transition only affects the opted-IN category (archive/prune fire ONLY under the explicit
    // policy, NEVER under the Permanent default) and only PAST the cutoff (a not-yet-eligible session
    // is untouched even with the policy on).
    #[test]
    fn explicit_session_policy_archives_prunes_and_hard_deletes_only_past_cutoff() {
        let now = 100_000_000_000_i64;
        let policy = CategoryRetention::AfterDays(HARD_DELETE_TIMEOUT_DAYS);

        // --- opted-IN db: the explicit AfterDays policy runs the FULL lifecycle on the ported
        //     per-phase boundaries, but ONLY past each cutoff. ---
        let db = Db::open_hub(&tmp("optin-enabled")).unwrap();
        // NOT past the archive cutoff (idle_at exactly at the boundary, strict `<`) → stays idle.
        seed(
            &db,
            "young_idle",
            "idle",
            Some(now - ARCHIVE_TIMEOUT_MS),
            None,
            None,
            1,
        );
        // Each past its respective cutoff → advances exactly one phase this tick.
        seed(
            &db,
            "old_idle",
            "idle",
            Some(now - ARCHIVE_TIMEOUT_MS - 1),
            None,
            None,
            1,
        );
        seed(
            &db,
            "old_archived",
            "archived",
            None,
            Some(now - PRUNE_TIMEOUT_MS - 1),
            None,
            1,
        );
        seed(
            &db,
            "old_pruned",
            "pruned",
            None,
            None,
            Some(now - HARD_DELETE_TIMEOUT_MS - 1),
            1,
        );

        let out = sweep_lifecycle_with_policy(db.conn(), now, policy).unwrap();
        assert_eq!(
            out.archived, 1,
            "explicit policy archives the eligible idle session"
        );
        assert_eq!(
            out.pruned, 1,
            "explicit policy prunes the eligible archived session"
        );
        assert_eq!(
            out.hard_deleted, 1,
            "explicit policy hard-deletes the eligible pruned session"
        );
        assert_eq!(
            status_of(&db, "young_idle"),
            "idle",
            "not past the archive cutoff → untouched even with the policy on"
        );
        assert_eq!(status_of(&db, "old_idle"), "archived");
        assert_eq!(status_of(&db, "old_archived"), "pruned");
        assert!(
            !exists(&db, "old_pruned"),
            "past the hard-delete cutoff → removed under the explicit policy"
        );

        // --- category gate: the SAME fixtures under the DEFAULT (Permanent) policy fire NOTHING —
        //     archive/prune/hard-delete are opt-in per the session-content category. ---
        let default_db = Db::open_hub(&tmp("optin-default-contrast")).unwrap();
        seed(
            &default_db,
            "old_idle",
            "idle",
            Some(now - ARCHIVE_TIMEOUT_MS - 1),
            None,
            None,
            1,
        );
        seed(
            &default_db,
            "old_archived",
            "archived",
            None,
            Some(now - PRUNE_TIMEOUT_MS - 1),
            None,
            1,
        );
        seed(
            &default_db,
            "old_pruned",
            "pruned",
            None,
            None,
            Some(now - HARD_DELETE_TIMEOUT_MS - 1),
            1,
        );
        let default_out = sweep_lifecycle(default_db.conn(), now).unwrap();
        assert_eq!(
            default_out.archived, 0,
            "default policy does NOT archive (opt-in only) — no soft-hiding"
        );
        assert_eq!(
            default_out.pruned, 0,
            "default policy does NOT prune (opt-in only)"
        );
        assert_eq!(
            default_out.hard_deleted, 0,
            "default policy never hard-deletes"
        );
        assert_eq!(
            status_of(&default_db, "old_idle"),
            "idle",
            "stays discoverable (idle) under the default"
        );
        assert_eq!(
            status_of(&default_db, "old_archived"),
            "archived",
            "no further advance under the default"
        );
        assert!(
            exists(&default_db, "old_pruned"),
            "pruned row retained under the default"
        );
    }

    // --- #60 overflow rule: each per-phase cutoff fails CLOSED on an i64 underflow -------------
    //
    // The three per-phase boundaries (`now_ms - IDLE_TIMEOUT_MS` / `- ARCHIVE_TIMEOUT_MS` /
    // `- PRUNE_TIMEOUT_MS`) are computed with `checked_sub`, so a pathological near-`i64::MIN`
    // now_ms UNDERFLOWS → that phase is SKIPPED (does 0), never a wrapped/bogus cutoff that could
    // mis-transition a fresh row — matching `resolve_cutoff`'s fail-closed math. A real wall clock
    // (~1.7e12) never reaches here; this only guards a future refactor from silently reintroducing
    // unchecked subtraction (which would also PANIC in a debug build at this input).
    #[test]
    fn per_phase_boundary_underflow_fails_closed_and_never_mistransitions() {
        let db = Db::open_hub(&tmp("overflow-failclosed")).unwrap();
        // A brand-new ACTIVE session with a normal updated_at.
        ensure_session(db.conn(), "s", 1_000).unwrap();

        // DEFAULT policy at i64::MIN: `i64::MIN - IDLE_TIMEOUT_MS` underflows → idle phase skipped.
        let out = sweep_lifecycle(db.conn(), i64::MIN).unwrap();
        assert_eq!(
            out.idled, 0,
            "idle phase fails closed on underflow (no wrapped cutoff)"
        );
        assert_eq!(
            status_of(&db, "s"),
            "active",
            "the session is NOT mis-transitioned by an overflowing clock"
        );

        // EXPLICIT policy at i64::MIN: the archive/prune boundaries also fail closed (no panic, 0),
        // and no row is destroyed.
        let out2 = sweep_enabled(db.conn(), i64::MIN).unwrap();
        assert_eq!(out2.idled, 0);
        assert_eq!(out2.archived, 0);
        assert_eq!(out2.pruned, 0);
        assert_eq!(out2.hard_deleted, 0);
        assert!(
            exists(&db, "s"),
            "no row destroyed under an overflowing clock"
        );
    }
}
