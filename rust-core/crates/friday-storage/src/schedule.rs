//! Workflow SCHEDULE persistence (S10-A; Hub-only). DARK substrate.
//!
//! Storage half of the S10 scheduler slice A. This module owns ONLY rows +
//! structural invariants over the four m0024 tables; the SEMANTIC cron
//! validation (the restricted 5-field subset, fail-closed) lives ABOVE this
//! layer in `friday-hub::scheduler` — exactly as `workflow_def`'s linear-only
//! semantic gate lives in the hub layer above the row CHECKs (storage cannot
//! depend on friday-hub, so a fail-closed cron parse cannot run here). Callers
//! that want the create-time cron validation MUST go through the hub
//! `create_schedule`, not `insert_schedule` directly.
//!
//! What storage guarantees here:
//! * **Born disabled**: [`insert_schedule`] always writes `enabled = 0`; enabling
//!   is the separate explicit [`set_enabled`].
//! * **UTC-only**: the row CHECK makes a non-UTC timezone unrepresentable; this
//!   module never writes anything but `'UTC'`.
//! * **Refs-only listing**: [`list_schedules`] returns the operational fields
//!   (id / workflow_id / cron / enabled / watermark / timestamps) — there is no
//!   body to omit (a schedule references a workflow_id, it does not embed a
//!   definition), so the listing is refs-only by construction.
//! * **Watermark monotonicity**: [`set_last_slot`] REFUSES to lower the
//!   watermark (a backwards clock / re-presented slot can never rewind it), the
//!   storage primitive the slice-B tick relies on.
//! * **Lease**: a singleton (`id=1`) acquired/refreshed/released in an IMMEDIATE
//!   transaction; acquire SUPERSEDES an EXPIRED holder but refuses a LIVE one
//!   (the single-instance containment layer — the hard at-most-once guarantee is
//!   the engine's deterministic-run-id `create_run` PK, not this lease).
//! * **Control**: the `scheduler_control` singleton seeded by the migration; a
//!   pause read is always defined.
//!
//! Truth label: DARK substrate — no daemon, no tick loop, no production route
//! consumes this; workflow execution remains fenced in TS and is NOT
//! product-replaced; the WAL flip + plist install + enable are operator-gated;
//! NOT v1 GO.

use crate::error::{Result, StorageError};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

/// Open an IMMEDIATE write transaction on a shared `&Connection`. IMMEDIATE
/// acquires the write lock at BEGIN, so a read-then-write sequence below cannot
/// interleave with another writer between its statements (mirrors
/// `workflow_def::write_tx`).
fn write_tx(conn: &Connection) -> Result<Transaction<'_>> {
    Ok(Transaction::new_unchecked(
        conn,
        TransactionBehavior::Immediate,
    )?)
}

/// A stored schedule row (operational state; refs-only — there is no body).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduleRow {
    pub schedule_id: String,
    pub workflow_id: String,
    pub cron_expr: String,
    /// Always `"UTC"` in v1 (the row CHECK makes anything else unrepresentable).
    pub timezone: String,
    pub enabled: bool,
    /// Watermark: the last UTC-minute slot CONSIDERED (fired or skipped). `None`
    /// until the first tick considers this schedule.
    pub last_slot_ts: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Input to [`insert_schedule`]. No `enabled` field — born disabled is enforced
/// here (enabling is the separate [`set_enabled`]). `cron_expr` is persisted
/// opaquely; the caller (hub `create_schedule`) owns fail-closed cron validation
/// BEFORE calling this (storage cannot run the parser — see module docs).
#[derive(Clone, Copy, Debug)]
pub struct NewSchedule<'a> {
    pub schedule_id: &'a str,
    pub workflow_id: &'a str,
    /// A cron expression the caller has ALREADY validated against the restricted
    /// subset. Storage only structurally guarantees non-emptiness.
    pub cron_expr: &'a str,
}

/// Insert a new schedule, BORN DISABLED. A duplicate `schedule_id` fails closed
/// (PK violation). `timezone` is always `'UTC'` (v1 restriction). `last_slot_ts`
/// starts NULL (no slot considered yet).
pub fn insert_schedule(conn: &Connection, sched: &NewSchedule<'_>, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO workflow_schedule
            (schedule_id, workflow_id, cron_expr, timezone, enabled, last_slot_ts,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, 'UTC', 0, NULL, ?4, ?4)",
        params![sched.schedule_id, sched.workflow_id, sched.cron_expr, now],
    )?;
    Ok(())
}

fn schedule_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduleRow> {
    Ok(ScheduleRow {
        schedule_id: r.get(0)?,
        workflow_id: r.get(1)?,
        cron_expr: r.get(2)?,
        timezone: r.get(3)?,
        enabled: r.get::<_, i64>(4)? != 0,
        last_slot_ts: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

const SCHEDULE_COLUMNS: &str =
    "schedule_id, workflow_id, cron_expr, timezone, enabled, last_slot_ts, created_at, updated_at";

/// Read one schedule by id, or `None`.
pub fn get_schedule(conn: &Connection, schedule_id: &str) -> Result<Option<ScheduleRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {SCHEDULE_COLUMNS} FROM workflow_schedule WHERE schedule_id = ?1"),
            params![schedule_id],
            schedule_from_row,
        )
        .optional()?)
}

/// List every schedule (refs-only), ordered by `schedule_id`.
pub fn list_schedules(conn: &Connection) -> Result<Vec<ScheduleRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SCHEDULE_COLUMNS} FROM workflow_schedule ORDER BY schedule_id"
    ))?;
    let rows = stmt.query_map([], schedule_from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// List only the ENABLED schedules (refs-only) — the set a future tick reads.
pub fn list_enabled_schedules(conn: &Connection) -> Result<Vec<ScheduleRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SCHEDULE_COLUMNS} FROM workflow_schedule WHERE enabled = 1 ORDER BY schedule_id"
    ))?;
    let rows = stmt.query_map([], schedule_from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Enable/disable a schedule. A missing `schedule_id` is `NotFound` (never a
/// silent no-op). Bumps `updated_at`.
pub fn set_enabled(conn: &Connection, schedule_id: &str, enabled: bool, now: i64) -> Result<()> {
    let changed = conn.execute(
        "UPDATE workflow_schedule SET enabled = ?2, updated_at = ?3 WHERE schedule_id = ?1",
        params![schedule_id, enabled as i64, now],
    )?;
    if changed != 1 {
        return Err(StorageError::NotFound(format!(
            "workflow_schedule '{schedule_id}' (cannot set enabled on a missing schedule)"
        )));
    }
    Ok(())
}

/// Advance the watermark to `slot_ts`, REFUSING to lower it (watermark
/// monotonicity). The current value is read and the UPDATE applied in ONE
/// IMMEDIATE transaction, so a concurrent advance cannot slip between the read
/// and the write. A backwards move (a re-presented / clock-skewed slot) is
/// `Unsupported` and the row is left untouched; equal is a no-op success (an
/// idempotent re-consider of the same slot). A missing schedule is `NotFound`.
///
/// This is the storage primitive the slice-B tick uses to record "last slot
/// considered"; slice A neither calls it from a loop nor fires anything.
pub fn set_last_slot(conn: &Connection, schedule_id: &str, slot_ts: i64, now: i64) -> Result<()> {
    let tx = write_tx(conn)?;
    let current: Option<Option<i64>> = tx
        .query_row(
            "SELECT last_slot_ts FROM workflow_schedule WHERE schedule_id = ?1",
            params![schedule_id],
            |r| r.get(0),
        )
        .optional()?;
    match current {
        None => Err(StorageError::NotFound(format!(
            "workflow_schedule '{schedule_id}' (cannot advance the watermark of a missing schedule)"
        ))),
        Some(existing) => {
            if let Some(prev) = existing {
                if slot_ts < prev {
                    // drop(tx) rolls back (nothing was written anyway).
                    return Err(StorageError::Unsupported(format!(
                        "workflow_schedule '{schedule_id}' watermark would move backwards \
                         ({prev} -> {slot_ts}); refusing to lower it"
                    )));
                }
            }
            tx.execute(
                "UPDATE workflow_schedule SET last_slot_ts = ?2, updated_at = ?3
                 WHERE schedule_id = ?1",
                params![schedule_id, slot_ts, now],
            )?;
            tx.commit()?;
            Ok(())
        }
    }
}

/// Delete a schedule. A missing `schedule_id` is `NotFound` (never a silent
/// no-op success). Per-slot fire receipts are intentionally NOT cascaded — the
/// receipt history is an append-only audit trail keyed by `(schedule_id,
/// slot_ts)` and outlives the schedule row (no FK is declared, so a fire row is
/// not orphaned into an integrity error).
pub fn delete_schedule(conn: &Connection, schedule_id: &str) -> Result<()> {
    let changed = conn.execute(
        "DELETE FROM workflow_schedule WHERE schedule_id = ?1",
        params![schedule_id],
    )?;
    if changed != 1 {
        return Err(StorageError::NotFound(format!(
            "workflow_schedule '{schedule_id}'"
        )));
    }
    Ok(())
}

// --- per-slot fire receipts -------------------------------------------------

/// A per-slot fire receipt (refs-only). `run_id` is set only when `outcome ==
/// "fired"`; `detail_token` is a bounded closed-vocab token (never engine free
/// text), enforced by the slice-B writer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FireReceipt {
    pub schedule_id: String,
    pub slot_ts: i64,
    pub outcome: String,
    pub run_id: Option<String>,
    pub detail_token: Option<String>,
    pub created_at: i64,
}

/// Outcome of [`record_fire`]: a fresh receipt was written, or a receipt for
/// this `(schedule_id, slot_ts)` already existed and was refused idempotently
/// (nothing written). The PK makes the duplicate a uniqueness violation, so the
/// per-slot decision is recorded AT MOST ONCE even under a daemon race.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordFireOutcome {
    Recorded,
    Duplicate,
}

/// Insert one per-slot receipt. ONLY a duplicate `(schedule_id, slot_ts)` PK is
/// benign — it returns [`RecordFireOutcome::Duplicate`] (the slot was already
/// considered; the first decision stands), the per-slot at-most-once complement
/// to the engine's deterministic-run-id `create_run` PK. Every OTHER constraint
/// failure propagates: in particular an `outcome` outside the closed vocabulary
/// fails CLOSED (the CHECK error is NOT swallowed — `INSERT OR IGNORE` is
/// deliberately avoided here precisely because it would mask a bad-vocab CHECK as
/// a no-op).
pub fn record_fire(
    conn: &Connection,
    schedule_id: &str,
    slot_ts: i64,
    outcome: &str,
    run_id: Option<&str>,
    detail_token: Option<&str>,
    now: i64,
) -> Result<RecordFireOutcome> {
    let res = conn.execute(
        "INSERT INTO workflow_schedule_fire
            (schedule_id, slot_ts, outcome, run_id, detail_token, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![schedule_id, slot_ts, outcome, run_id, detail_token, now],
    );
    match res {
        Ok(_) => Ok(RecordFireOutcome::Recorded),
        // Only the `(schedule_id, slot_ts)` PRIMARY KEY conflict is the benign
        // already-considered case. A CHECK (bad outcome vocab) propagates; and a
        // future UNIQUE index MUST also fail closed rather than be masked as an
        // idempotent Duplicate — so match the PK extended-code ONLY, never UNIQUE.
        Err(rusqlite::Error::SqliteFailure(err, _))
            if err.code == rusqlite::ErrorCode::ConstraintViolation
                && err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY =>
        {
            Ok(RecordFireOutcome::Duplicate)
        }
        Err(e) => Err(e.into()),
    }
}

/// Read one fire receipt for a `(schedule_id, slot_ts)`, or `None`.
pub fn get_fire(conn: &Connection, schedule_id: &str, slot_ts: i64) -> Result<Option<FireReceipt>> {
    Ok(conn
        .query_row(
            "SELECT schedule_id, slot_ts, outcome, run_id, detail_token, created_at
             FROM workflow_schedule_fire WHERE schedule_id = ?1 AND slot_ts = ?2",
            params![schedule_id, slot_ts],
            |r| {
                Ok(FireReceipt {
                    schedule_id: r.get(0)?,
                    slot_ts: r.get(1)?,
                    outcome: r.get(2)?,
                    run_id: r.get(3)?,
                    detail_token: r.get(4)?,
                    created_at: r.get(5)?,
                })
            },
        )
        .optional()?)
}

// --- scheduler control (pause kill-switch) ----------------------------------

/// The `scheduler_control` singleton (id=1). `paused` is the runtime
/// kill-switch a future tick checks BEFORE reading due schedules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchedulerControl {
    pub paused: bool,
    pub reason: Option<String>,
    pub updated_at: i64,
}

/// Read the control singleton. The migration seeds the row, so this is always
/// defined; a missing row (hand-rebuilt DB) fails closed as `NotFound` rather
/// than defaulting to "running".
pub fn get_control(conn: &Connection) -> Result<SchedulerControl> {
    conn.query_row(
        "SELECT paused, reason, updated_at FROM scheduler_control WHERE id = 1",
        [],
        |r| {
            Ok(SchedulerControl {
                paused: r.get::<_, i64>(0)? != 0,
                reason: r.get(1)?,
                updated_at: r.get(2)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| {
        StorageError::NotFound(
            "scheduler_control singleton (id=1) is missing; refusing to assume 'running'".into(),
        )
    })
}

/// Set the pause flag + reason on the control singleton. The row is the seeded
/// singleton; a missing row (hand-rebuilt DB) is `NotFound` (never silently
/// recreated under a different state).
pub fn set_paused(conn: &Connection, paused: bool, reason: Option<&str>, now: i64) -> Result<()> {
    let changed = conn.execute(
        "UPDATE scheduler_control SET paused = ?1, reason = ?2, updated_at = ?3 WHERE id = 1",
        params![paused as i64, reason, now],
    )?;
    if changed != 1 {
        return Err(StorageError::NotFound(
            "scheduler_control singleton (id=1) is missing; cannot set pause state".into(),
        ));
    }
    Ok(())
}

// --- scheduler lease (single-instance containment) --------------------------

/// The `scheduler_lease` singleton (id=1): an opaque holder token + expiry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchedulerLease {
    pub holder: String,
    pub expires_at: i64,
    pub updated_at: i64,
}

/// Outcome of [`acquire_lease`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseAcquireOutcome {
    /// The lease was free (no row) or EXPIRED and is now held by the caller.
    Acquired,
    /// A DIFFERENT holder's lease is still LIVE (`expires_at > now`); the caller
    /// must refuse to boot. The containment layer's "refuse a second instance".
    HeldByOther,
}

/// Acquire (or supersede an EXPIRED) lease for `holder`, expiring at
/// `expires_at`. Runs the read-decide-write in ONE IMMEDIATE transaction so two
/// racing acquirers cannot both observe "free" and both win — IMMEDIATE
/// serializes them and exactly one acquires.
///
/// Rules:
/// * No lease row → INSERT (Acquired).
/// * Existing row, same `holder` → refresh expiry (Acquired; idempotent
///   re-acquire by the live owner).
/// * Existing row, DIFFERENT holder, `expires_at <= now` (EXPIRED) → supersede
///   (Acquired; a crashed holder is reclaimed without operator surgery).
/// * Existing row, DIFFERENT holder, still LIVE → `HeldByOther` (no write).
pub fn acquire_lease(
    conn: &Connection,
    holder: &str,
    expires_at: i64,
    now: i64,
) -> Result<LeaseAcquireOutcome> {
    let tx = write_tx(conn)?;
    let existing: Option<(String, i64)> = tx
        .query_row(
            "SELECT holder, expires_at FROM scheduler_lease WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match existing {
        None => {
            tx.execute(
                "INSERT INTO scheduler_lease (id, holder, expires_at, updated_at)
                 VALUES (1, ?1, ?2, ?3)",
                params![holder, expires_at, now],
            )?;
            tx.commit()?;
            Ok(LeaseAcquireOutcome::Acquired)
        }
        Some((cur_holder, cur_expires)) => {
            if cur_holder != holder && cur_expires > now {
                // Live lease held by another instance → refuse (no write).
                return Ok(LeaseAcquireOutcome::HeldByOther);
            }
            // Same holder (refresh) OR a different but EXPIRED holder (supersede).
            tx.execute(
                "UPDATE scheduler_lease SET holder = ?1, expires_at = ?2, updated_at = ?3
                 WHERE id = 1",
                params![holder, expires_at, now],
            )?;
            tx.commit()?;
            Ok(LeaseAcquireOutcome::Acquired)
        }
    }
}

/// Refresh the lease expiry for `holder` (a heartbeat). Succeeds only if the
/// caller STILL holds the lease; if another instance superseded it (the caller's
/// holder no longer matches), this is `NotFound` and the caller should stand
/// down rather than keep running believing it holds the lease.
pub fn refresh_lease(conn: &Connection, holder: &str, expires_at: i64, now: i64) -> Result<()> {
    let changed = conn.execute(
        "UPDATE scheduler_lease SET expires_at = ?2, updated_at = ?3
         WHERE id = 1 AND holder = ?1",
        params![holder, expires_at, now],
    )?;
    if changed != 1 {
        return Err(StorageError::NotFound(format!(
            "scheduler_lease is not held by '{holder}' (superseded or absent); refusing to refresh"
        )));
    }
    Ok(())
}

/// Release the lease IF `holder` still holds it (a clean shutdown). Releasing a
/// lease the caller no longer holds is a no-op success (it was already
/// superseded — nothing to release). Returns whether a row was deleted.
pub fn release_lease(conn: &Connection, holder: &str) -> Result<bool> {
    let changed = conn.execute(
        "DELETE FROM scheduler_lease WHERE id = 1 AND holder = ?1",
        params![holder],
    )?;
    Ok(changed == 1)
}

/// Read the lease singleton (refs-only), or `None` if unheld.
pub fn get_lease(conn: &Connection) -> Result<Option<SchedulerLease>> {
    Ok(conn
        .query_row(
            "SELECT holder, expires_at, updated_at FROM scheduler_lease WHERE id = 1",
            [],
            |r| {
                Ok(SchedulerLease {
                    holder: r.get(0)?,
                    expires_at: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            },
        )
        .optional()?)
}
