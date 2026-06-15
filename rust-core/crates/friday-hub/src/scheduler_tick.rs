//! S10-B — the workflow SCHEDULER TICK engine (DARK, default-OFF). The firing
//! half of the scheduler the S10-A substrate (`crate::scheduler` parser/evaluator
//! + `friday_storage::schedule` rows/lease/control/receipts) was built FOR but
//! never wired: today schedules NEVER fire (there is a `sweep_lifecycle` reaper
//! tick but no cron-tick/heartbeat engine). This module is that engine — a bounded
//! tick that, when the operator flips `FRIDAY_SCHEDULER_TICK_ENABLED`, scans the
//! ENABLED schedules, fires the ones that are DUE, and never double-fires.
//!
//! ## What this builds ON (nothing reinvented)
//! * the cron subset parser + `is_due` / `slot_floor_ms` / `scheduled_run_id`
//!   (`crate::scheduler`),
//! * the stored-schedule rows + monotonic watermark + per-slot fire receipts +
//!   the single-instance lease + the pause kill-switch
//!   (`friday_storage::schedule`),
//! * the manual workflow-run dispatch seam `run_stored_published_workflow`
//!   (`crate::workflow_run`) — the engine, gate posture, and at-most-once
//!   `create_run` PK are all INHERITED, never re-implemented.
//!
//! ## The at-most-once design (idempotent across crash/restart)
//! The HARD at-most-once guarantee is the engine's deterministic-run-id
//! `create_run` PRIMARY KEY (`scheduler.rs` docs) — NOT the receipt and NOT the
//! lease. The tick dispatches a due slot with the DETERMINISTIC run id
//! `sched:<schedule_id>:<slot_ts>`; the engine's first act is `create_run` with
//! that id as the PK, so two daemons (or a tick replayed after a crash) racing the
//! SAME slot produce exactly one winning INSERT and the loser fails closed on the
//! dup PK. Around that anchor the tick orders its writes so NEITHER crash window
//! double-fires NOR loses a fire:
//!
//!   per due slot S of schedule X:
//!     1. if a receipt already exists for (X, S) → the slot was already CONSIDERED
//!        (fired or skipped); skip it (idempotent re-consider).
//!     2. else if a run already exists for `scheduled_run_id(X,S)` → a PRIOR tick
//!        dispatched it but crashed BEFORE writing the receipt; do NOT re-dispatch
//!        (the PK would reject it anyway). Heal forward: record the `fired`
//!        receipt now. (recovery window A)
//!     3. else dispatch the published workflow with the deterministic run id, THEN
//!        record the `fired` receipt. A crash AFTER dispatch but BEFORE the receipt
//!        lands in case (2) on the next tick — the run is NOT lost and NOT
//!        re-created. A crash BEFORE dispatch leaves no run and no receipt — the
//!        slot is simply reconsidered next tick (still within the watermark window,
//!        see below). (recovery window B)
//!   then: advance the watermark to the floored-now slot UNCONDITIONALLY.
//!
//! Receipt-before-watermark vs run-before-receipt are deliberately ordered so the
//! ONLY thing a crash can cost is a *re-consideration* (cheap, deduped), never a
//! double-fire (PK) and never a silently-dropped fire (recovery window A).
//!
//! ## The catch-up STORM guard (the runaway risk this lane exists to contain)
//! A daemon down for hours against a `* * * * *` schedule has THOUSANDS of elapsed
//! due slots. Firing them all would be a runaway. The tick fires AT MOST the single
//! MOST-RECENT due slot at-or-before now (a `grace` window of one slot); every
//! OLDER due slot in the watermark→now window is recorded `skipped_missed` (capped),
//! and the watermark is advanced to floored-now REGARDLESS — so the backlog is
//! considered exactly once and never rescanned. A per-tick fire CAP alone would not
//! help: capped-but-unconsidered slots would just fire on the next tick.
//!
//! ## The busy-spine / serialization guard (no stampede)
//! The mission spine SERIALIZES work (`mission_context.rs` refuses concurrent work
//! items). A scheduled workflow run is keyed by `run_id` only and creates NO mission
//! work item (`workflow_run` docs), so that exact check does not literally apply —
//! but the PRINCIPLE (do not pile onto a still-running prior fire) is honored at the
//! grain the substrate gives us: if the SAME schedule's last `fired` run is still
//! NON-TERMINAL (`pending`/`running`/`awaiting_checkpoint`), this slot is recorded
//! `skipped_previous_awaiting` and NOT fired. (Bonus safety the engine already
//! gives: under the default deny-all approval policy a fired workflow PAUSES at its
//! first mutating step — `AwaitingCheckpoint` — so an unattended scheduled run can
//! NEVER execute a side effect; read-only workflows run, mutating ones checkpoint.)
//!
//! ## Bounds (no runaway, crash-safe)
//! * `max_fires_per_tick` — hard cap on real dispatches per tick.
//! * `max_considered_per_tick` — hard cap on receipts written per tick (the
//!   storm-skip cap), so even a pathological backlog cannot write unbounded rows.
//! * the watermark is the durable last-tick marker: a restart resumes from it, a
//!   missed tick is absorbed by the storm guard, a backwards clock is refused by
//!   `set_last_slot`.
//! * a per-schedule error NEVER aborts the tick or crashes the daemon (logged via
//!   the `error` receipt, the loop moves on) — mirroring the reaper.
//!
//! Truth label: DARK — `FRIDAY_SCHEDULER_TICK_ENABLED` is DEFAULT-OFF; flag-OFF the
//! tick thread is never spawned and NOTHING fires, byte-identical to today. The
//! live enable (deploy + WAL flip + enrol the lease holder + flip the flag) is an
//! operator DEPLOY-GO decision. NOT v1 GO.

use friday_storage::schedule::{
    get_control, get_fire, list_enabled_schedules, record_fire, set_last_slot, RecordFireOutcome,
    ScheduleRow,
};
use friday_storage::workflow::run_state;
use friday_storage::Db;
use rusqlite::Connection;

use crate::scheduler::{is_due, parse_cron, scheduled_run_id, slot_floor_ms};

/// Milliseconds in one minute (one slot). Mirrors `scheduler::MIN_MS` (private).
const MIN_MS: i64 = 60_000;

/// Default cap on REAL dispatches per tick (the at-most-one-recent-slot policy
/// already caps fires to 1-per-schedule-per-tick; this bounds the TOTAL across all
/// enabled schedules so a tick can never fan out into an unbounded dispatch burst).
pub const DEFAULT_MAX_FIRES_PER_TICK: usize = 8;

/// Default cap on receipts CONSIDERED (written) per tick — the storm-skip cap. Even
/// a daemon down for years against a per-minute schedule writes at most this many
/// `skipped_missed` receipts per tick; the watermark still advances to now, so the
/// remainder is dropped (never rescanned), never fired, and the table never grows
/// unbounded in one tick.
pub const DEFAULT_MAX_CONSIDERED_PER_TICK: usize = 256;

/// What the tick decided + did for ONE schedule on ONE tick. Refs-only counts +
/// closed-vocab outcome tokens (never workflow bodies / engine free text) — the
/// shape the loop logs and the tests assert over.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScheduleTickReport {
    pub schedule_id: String,
    /// slots newly recorded `skipped_missed` (older backlog under the storm guard).
    pub skipped_missed: usize,
    /// the slot (if any) that was newly FIRED this tick (a run was dispatched or a
    /// crash-orphaned run was healed-forward).
    pub fired_slot: Option<i64>,
    /// `true` iff the most-recent due slot was skipped because the SAME schedule's
    /// previous fire is still non-terminal (the serialization guard).
    pub skipped_previous_awaiting: bool,
    /// `true` iff the stored cron failed the every-tick re-parse (the slice-B second
    /// guard); the slot is recorded `invalid_schedule` and never fired.
    pub invalid: bool,
    /// `true` iff the most-recent due slot was skipped because the workflow has no
    /// published version to dispatch.
    pub skipped_no_published: bool,
    /// `true` iff a non-fatal error was recorded for this schedule's recent slot.
    pub errored: bool,
}

/// Aggregate of one tick across all enabled schedules. `considered`/`fired` are the
/// bound-tracking totals the loop logs; `paused` short-circuits the whole tick.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TickOutcome {
    /// `true` iff the tick short-circuited because the scheduler was PAUSED (the
    /// kill-switch) — no schedule was scanned, nothing fired.
    pub paused: bool,
    /// total real dispatches (fires) this tick across all schedules.
    pub fired: usize,
    /// total slots considered (receipts written) this tick across all schedules.
    pub considered: usize,
    /// per-schedule reports (only schedules that did SOMETHING are included).
    pub reports: Vec<ScheduleTickReport>,
}

impl TickOutcome {
    /// `true` iff nothing happened (quiet tick) — the loop stays silent on these to
    /// avoid log spam, exactly like the reaper's empty sweep.
    pub fn is_empty(&self) -> bool {
        !self.paused && self.fired == 0 && self.considered == 0
    }
}

/// The result of dispatching ONE scheduled workflow run, as the tick needs to
/// classify it. The dispatch closure (real or test) maps the engine outcome into
/// this closed set; the tick NEVER sees engine free text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DispatchOutcome {
    /// A run was created + executed (it may be `done`, paused at a checkpoint, or
    /// failed — all are a FIRED slot; the receipt records `fired` and the run row
    /// carries the engine's own terminal/awaiting state).
    Fired,
    /// The workflow has no published version to dispatch — record
    /// `skipped_no_published`, do NOT fire, advance the watermark.
    NoPublishedVersion,
    /// A non-fatal dispatch error (e.g. a transient storage error). Record `error`,
    /// do NOT crash the tick; the slot is CONSIDERED (watermark advances) so it is
    /// not retried in a tight loop.
    Error,
}

/// Bounds + behavior knobs for one tick (so tests can drive a tiny cap).
#[derive(Clone, Copy, Debug)]
pub struct TickBounds {
    pub max_fires_per_tick: usize,
    pub max_considered_per_tick: usize,
}

impl Default for TickBounds {
    fn default() -> Self {
        Self {
            max_fires_per_tick: DEFAULT_MAX_FIRES_PER_TICK,
            max_considered_per_tick: DEFAULT_MAX_CONSIDERED_PER_TICK,
        }
    }
}

/// The detail-token closed vocabulary written into a fire receipt's `detail_token`
/// column (NEVER engine free text). Bounded labels only.
mod detail {
    pub const PARSE_FAILED: &str = "cron_parse_failed";
    pub const NO_PUBLISHED: &str = "no_published_version";
    pub const PREVIOUS_AWAITING: &str = "previous_fire_non_terminal";
    pub const DISPATCH_ERROR: &str = "dispatch_error";
    pub const MISSED_BACKLOG: &str = "missed_backlog_slot";
    pub const RECOVERED_ORPHAN: &str = "recovered_orphan_run";
}

/// Run ONE tick over all ENABLED schedules. PURE of any thread/sleep/clock — the
/// caller supplies `now_ms`; the firing is delegated to `dispatch` so the loop
/// logic is fully testable (and so the crash/restart idempotency test can run the
/// tick twice over one DB with no real thread). Never panics; a per-schedule error
/// is captured as a receipt, not propagated.
///
/// `dispatch(workflow_id, run_id, now_ms) -> DispatchOutcome` is the firing seam.
/// In production it calls `run_stored_published_workflow`; in tests it is a stub
/// that records what it was asked to fire. The deterministic `run_id` it receives
/// is the at-most-once anchor — the closure MUST pass it through to the engine's
/// `create_run` unchanged.
pub fn run_one_tick<F>(
    conn: &Connection,
    bounds: &TickBounds,
    now_ms: i64,
    mut dispatch: F,
) -> Result<TickOutcome, friday_storage::StorageError>
where
    F: FnMut(&str, &str, i64) -> DispatchOutcome,
{
    let mut outcome = TickOutcome::default();

    // (1) The PAUSE kill-switch is checked FIRST, before reading any schedule. A
    // paused scheduler considers NOTHING and advances NO watermark — a clean drain
    // that resumes exactly where it left off (the storm guard absorbs the gap on
    // resume). `get_control` fails closed (a missing singleton is an Err), so a
    // hand-rebuilt DB never silently runs.
    if get_control(conn)?.paused {
        outcome.paused = true;
        return Ok(outcome);
    }

    let now_slot = slot_floor_ms(now_ms);

    // Fairness under a saturated per-tick fire cap: process the STALEST schedules
    // first (oldest watermark, NULL = never-ticked = stalest), so that when more
    // schedules are due than the fire cap allows, no schedule is starved across
    // successive ticks (an always-alphabetically-late schedule would otherwise never
    // win a contested tick). NULLs (freshly enabled) sort first; ties break by id
    // for determinism.
    let mut schedules = list_enabled_schedules(conn)?;
    schedules.sort_by(|a, b| {
        let ka = a.last_slot_ts.unwrap_or(i64::MIN);
        let kb = b.last_slot_ts.unwrap_or(i64::MIN);
        ka.cmp(&kb).then_with(|| a.schedule_id.cmp(&b.schedule_id))
    });

    for sched in schedules {
        // Stop the WHOLE tick once the per-tick FIRE cap is hit (the dispatch
        // budget is global, not per-schedule). Schedules not reached this tick are
        // simply considered on the NEXT tick (their watermark did not advance), so
        // nothing is lost — only deferred. We do NOT advance watermarks for the
        // skipped schedules (that would drop their backlog unconsidered).
        if outcome.fired >= bounds.max_fires_per_tick {
            break;
        }
        let report =
            tick_one_schedule(conn, &sched, now_slot, bounds, &mut outcome, &mut dispatch)?;
        if report != ScheduleTickReport::default() {
            outcome.reports.push(report);
        }
    }

    Ok(outcome)
}

/// Tick ONE schedule. Returns its per-schedule report; mutates `outcome.fired` /
/// `outcome.considered` for the global caps. Never panics; classifies every branch
/// into a closed-vocab receipt.
fn tick_one_schedule<F>(
    conn: &Connection,
    sched: &ScheduleRow,
    now_slot: i64,
    bounds: &TickBounds,
    outcome: &mut TickOutcome,
    dispatch: &mut F,
) -> Result<ScheduleTickReport, friday_storage::StorageError>
where
    F: FnMut(&str, &str, i64) -> DispatchOutcome,
{
    let mut report = ScheduleTickReport {
        schedule_id: sched.schedule_id.clone(),
        ..Default::default()
    };

    // (2) The slice-B SECOND guard: re-parse the STORED cron on every tick. A row
    // that somehow holds an expression the evaluator would choke on (defence in
    // depth behind the create-time parse) is recorded `invalid_schedule` for the
    // current slot and NEVER fired; the watermark advances so it is not rescanned.
    let cron = match parse_cron(&sched.cron_expr) {
        Ok(c) => c,
        Err(_) => {
            report.invalid = true;
            consider(
                conn,
                outcome,
                &sched.schedule_id,
                now_slot,
                "invalid_schedule",
                None,
                Some(detail::PARSE_FAILED),
                now_slot,
            )?;
            advance_watermark(conn, &sched.schedule_id, now_slot)?;
            return Ok(report);
        }
    };

    // The window of slots to CONSIDER: strictly after the watermark, up to and
    // including now. `None` watermark (never ticked) starts one slot before now so
    // exactly the current slot is the candidate (we never reach back before the
    // schedule was first seen — a freshly enabled schedule does not fire for the
    // past).
    let start_after = sched.last_slot_ts.unwrap_or(now_slot - MIN_MS);

    // (3) The catch-up STORM guard. Enumerate due slots in (start_after, now_slot],
    // but fire AT MOST the single MOST-RECENT one. Every older due slot is recorded
    // `skipped_missed` (capped by `max_considered_per_tick`); the watermark then
    // jumps to now_slot regardless, so the backlog is considered once and dropped.
    let mut due_slots: Vec<i64> = Vec::new();
    let mut slot = slot_floor_ms(start_after) + MIN_MS;
    let mut scanned = 0usize;
    // A hard scan ceiling independent of the consider cap: never iterate more than
    // a bounded number of minute slots even on a wildly stale watermark / future
    // clock (defensive — the watermark monotonicity normally keeps this small).
    const MAX_SCAN_SLOTS: i64 = 8 * 366 * 24 * 60; // matches scheduler::next_due bound
    let mut iterated: i64 = 0;
    while slot <= now_slot && iterated < MAX_SCAN_SLOTS {
        if is_due(&cron, slot) {
            due_slots.push(slot);
            scanned += 1;
            // Cap how many due slots we hold (the most-recent ones matter); keep
            // only the tail so an enormous backlog cannot balloon memory.
            if scanned > bounds.max_considered_per_tick {
                due_slots.remove(0);
            }
        }
        slot += MIN_MS;
        iterated += 1;
    }

    if due_slots.is_empty() {
        // Nothing due in the window — still advance the watermark to now so the
        // empty window is not rescanned. (Quiet: no receipt, mirrors the reaper's
        // empty sweep staying silent.)
        advance_watermark(conn, &sched.schedule_id, now_slot)?;
        return Ok(report);
    }

    // The most-recent due slot is the only FIRE candidate; all earlier ones are
    // missed backlog.
    let fire_slot = *due_slots.last().expect("non-empty checked above");
    let missed = &due_slots[..due_slots.len() - 1];

    // Record the missed backlog as skipped (capped + idempotent via receipt PK).
    //
    // CROSS-MINUTE crash recovery (recovery window A, generalized): a missed slot
    // can ALSO be a slot a PRIOR tick dispatched but crashed before its receipt —
    // and on a restart that crossed a minute boundary, THAT slot is now part of the
    // backlog, not the fire candidate. So before recording `skipped_missed`, check
    // whether a run already exists under the slot's deterministic id; if so, heal it
    // FORWARD to a `fired` receipt (it really did fire) instead of mislabeling it
    // `skipped_missed`. This makes orphan reconciliation correct regardless of how
    // many minutes the restart crossed. (The PK still guarantees at-most-once: each
    // distinct slot fired at most once; this only labels the receipt truthfully.)
    for &m in missed {
        if outcome.considered >= bounds.max_considered_per_tick {
            break;
        }
        let orphan_run = scheduled_run_id(&sched.schedule_id, m);
        let (token, run_ref, detail_tok) = if run_state(conn, &orphan_run)?.is_some() {
            ("fired", Some(orphan_run.as_str()), detail::RECOVERED_ORPHAN)
        } else {
            ("skipped_missed", None, detail::MISSED_BACKLOG)
        };
        let wrote = consider(
            conn,
            outcome,
            &sched.schedule_id,
            m,
            token,
            run_ref,
            Some(detail_tok),
            now_slot,
        )?;
        if wrote {
            if token == "fired" {
                report.fired_slot = Some(m);
                outcome.fired += 1;
            } else {
                report.skipped_missed += 1;
            }
        }
    }

    // (4) Decide the MOST-RECENT slot. If its receipt already exists, it was already
    // considered (idempotent re-consider after a crash/restart) — do nothing and
    // still advance the watermark.
    if get_fire(conn, &sched.schedule_id, fire_slot)?.is_some() {
        advance_watermark(conn, &sched.schedule_id, now_slot)?;
        return Ok(report);
    }

    // (4a) PAUSE was already checked at tick top, but re-checking is unnecessary;
    // the serialization guard is checked here: is the SAME schedule's PREVIOUS fire
    // still non-terminal? If so, do not stampede — skip this slot.
    if previous_fire_non_terminal(conn, sched)? {
        report.skipped_previous_awaiting = true;
        consider(
            conn,
            outcome,
            &sched.schedule_id,
            fire_slot,
            "skipped_previous_awaiting",
            None,
            Some(detail::PREVIOUS_AWAITING),
            now_slot,
        )?;
        advance_watermark(conn, &sched.schedule_id, now_slot)?;
        return Ok(report);
    }

    // (4b) Global fire cap: if firing this slot would exceed the per-tick dispatch
    // budget, leave the slot UNCONSIDERED (no receipt, no watermark advance) so it
    // is the candidate again next tick — deferred, not dropped, not fired.
    if outcome.fired >= bounds.max_fires_per_tick {
        return Ok(report);
    }

    let run_id = scheduled_run_id(&sched.schedule_id, fire_slot);

    // (4c) Recovery window A: a PRIOR tick dispatched this exact run but crashed
    // BEFORE writing the receipt. The run row already exists under the deterministic
    // id. Do NOT re-dispatch (the PK would reject it); heal forward by recording the
    // `fired` receipt now. This is what makes a mid-fire crash NOT double-fire AND
    // NOT lose the fire.
    if run_state(conn, &run_id)?.is_some() {
        let wrote = consider(
            conn,
            outcome,
            &sched.schedule_id,
            fire_slot,
            "fired",
            Some(&run_id),
            Some(detail::RECOVERED_ORPHAN),
            now_slot,
        )?;
        if wrote {
            report.fired_slot = Some(fire_slot);
            outcome.fired += 1;
        }
        advance_watermark(conn, &sched.schedule_id, now_slot)?;
        return Ok(report);
    }

    // (4d) The normal path: dispatch the published workflow with the deterministic
    // run id (the engine's `create_run` PK is the at-most-once anchor), THEN record
    // the receipt, THEN advance the watermark. A crash between dispatch and receipt
    // lands in recovery window A next tick.
    match dispatch(&sched.workflow_id, &run_id, now_slot) {
        DispatchOutcome::Fired => {
            let wrote = consider(
                conn,
                outcome,
                &sched.schedule_id,
                fire_slot,
                "fired",
                Some(&run_id),
                None,
                now_slot,
            )?;
            if wrote {
                report.fired_slot = Some(fire_slot);
                outcome.fired += 1;
            }
        }
        DispatchOutcome::NoPublishedVersion => {
            report.skipped_no_published = true;
            consider(
                conn,
                outcome,
                &sched.schedule_id,
                fire_slot,
                "skipped_no_published",
                None,
                Some(detail::NO_PUBLISHED),
                now_slot,
            )?;
        }
        DispatchOutcome::Error => {
            report.errored = true;
            consider(
                conn,
                outcome,
                &sched.schedule_id,
                fire_slot,
                "error",
                None,
                Some(detail::DISPATCH_ERROR),
                now_slot,
            )?;
        }
    }

    advance_watermark(conn, &sched.schedule_id, now_slot)?;
    Ok(report)
}

/// Is the SAME schedule's PREVIOUS fired run still NON-TERMINAL? The serialization
/// guard. Finds the schedule's most-recent `fired` receipt, reads that run's state,
/// and returns `true` iff it exists and is not terminal
/// (`pending`/`running`/`awaiting_checkpoint`). A missing run row (e.g. an old
/// receipt whose run was reaped) is treated as terminal (not blocking) — fail OPEN
/// here is correct because the at-most-once PK still prevents a real double-fire of
/// any single slot; this guard only avoids piling a NEW slot onto a LIVE prior run.
fn previous_fire_non_terminal(
    conn: &Connection,
    sched: &ScheduleRow,
) -> Result<bool, friday_storage::StorageError> {
    let last_fired_run: Option<String> = conn
        .query_row(
            "SELECT run_id FROM workflow_schedule_fire
             WHERE schedule_id = ?1 AND outcome = 'fired' AND run_id IS NOT NULL
             ORDER BY slot_ts DESC LIMIT 1",
            rusqlite::params![sched.schedule_id],
            |r| r.get::<_, String>(0),
        )
        .ok();
    let Some(run_id) = last_fired_run else {
        return Ok(false);
    };
    match run_state(conn, &run_id)? {
        Some(state) => Ok(!state.is_terminal()),
        None => Ok(false),
    }
}

/// Record one fire receipt + bump the global `considered` counter. Returns whether
/// a NEW receipt was written (`false` on an idempotent duplicate — the slot was
/// already considered by a prior tick / a racing daemon, the per-slot PK dedupe).
/// A receipt write is bounded by the caller's consider cap.
#[allow(clippy::too_many_arguments)]
fn consider(
    conn: &Connection,
    outcome: &mut TickOutcome,
    schedule_id: &str,
    slot_ts: i64,
    outcome_token: &str,
    run_id: Option<&str>,
    detail_token: Option<&str>,
    now: i64,
) -> Result<bool, friday_storage::StorageError> {
    match record_fire(
        conn,
        schedule_id,
        slot_ts,
        outcome_token,
        run_id,
        detail_token,
        now,
    )? {
        RecordFireOutcome::Recorded => {
            outcome.considered += 1;
            Ok(true)
        }
        // The slot was already considered (a crash-replayed tick or a racing
        // daemon) — the first decision stands, nothing double-counts.
        RecordFireOutcome::Duplicate => Ok(false),
    }
}

/// Advance the schedule's watermark to `now_slot` (the durable last-tick marker).
/// `set_last_slot` refuses to LOWER it, so a backwards clock / re-presented slot is
/// a benign refusal — swallowed here (the slot was still considered; we must not let
/// a clock-skew refusal abort the tick). Equal is an idempotent success.
fn advance_watermark(
    conn: &Connection,
    schedule_id: &str,
    now_slot: i64,
) -> Result<(), friday_storage::StorageError> {
    match set_last_slot(conn, schedule_id, now_slot, now_slot) {
        Ok(()) => Ok(()),
        // A backwards move is the only Unsupported here (the schedule exists — it
        // came from `list_enabled_schedules`); treat it as a no-op (the watermark is
        // already at-or-ahead of now, which is fine).
        Err(friday_storage::StorageError::Unsupported(_)) => Ok(()),
        Err(e) => Err(e),
    }
}

/// Convenience: open this thread's OWN DB connection (mirrors the reaper) and run a
/// single tick, dispatching live via `run_stored_published_workflow`. Used by the
/// daemon's tick thread; the `executor`/`secret`/`approve` are the server's. A
/// dispatch error or a no-published-version is mapped to the closed
/// [`DispatchOutcome`] (never propagated as a tick-aborting Err).
///
/// This is the THIN production seam over the pure [`run_one_tick`]: all loop logic,
/// idempotency, storm/serialization guards, and bounds live in `run_one_tick`; this
/// only wires the real engine dispatch closure.
pub fn run_one_tick_live(
    db: &Db,
    bounds: &TickBounds,
    now_ms: i64,
    executor: &dyn crate::ToolExecutor,
    secret: &[u8],
    approve: &dyn Fn(
        &friday_core::gate::MutatingActionRequest,
    ) -> Option<friday_core::gate::CanonicalApproval>,
) -> Result<TickOutcome, friday_storage::StorageError> {
    run_one_tick(
        db.conn(),
        bounds,
        now_ms,
        |workflow_id, run_id, now_slot| {
            match crate::workflow_run::run_stored_published_workflow(
                db.conn(),
                executor,
                workflow_id,
                run_id,
                secret,
                approve,
                now_slot,
            ) {
                Ok(_run) => DispatchOutcome::Fired,
                Err(crate::workflow_def::WorkflowDefError::NotFound(_)) => {
                    // No published version (or no such workflow) — a benign skip.
                    DispatchOutcome::NoPublishedVersion
                }
                // Any other failure (incl. a dup-PK Storage error if a racing daemon /
                // crash-replay beat us to `create_run`) is a non-fatal dispatch error.
                // The recovery-window-A pre-check already caught the common crash case;
                // this catches a genuine race and records `error` without crashing.
                Err(_) => DispatchOutcome::Error,
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::WorkflowRunState;
    use friday_storage::schedule::{insert_schedule, set_enabled, set_paused, NewSchedule};
    use friday_storage::workflow::{create_run, set_run_state};
    use friday_storage::Db;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp_db() -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-sched-tick-{}-{}.sqlite",
                std::process::id(),
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    /// Minutes → epoch-millis slot (slot N = N minutes after the epoch). Lets the
    /// tests reason in clean slot indices rather than wall-clock dates.
    fn slot(n: i64) -> i64 {
        n * MIN_MS
    }

    fn enabled_every_minute(db: &Db, id: &str, wf: &str) {
        insert_schedule(
            db.conn(),
            &NewSchedule {
                schedule_id: id,
                workflow_id: wf,
                cron_expr: "* * * * *",
            },
            0,
        )
        .unwrap();
        set_enabled(db.conn(), id, true, 0).unwrap();
    }

    /// A dispatch stub that records every (workflow_id, run_id) it was asked to
    /// fire and returns a configured outcome. Crucially it also CREATES the run row
    /// under the deterministic id (like the real engine's `create_run` PK) on a
    /// `Fired`, so the crash/restart recovery-window-A path is exercised faithfully.
    struct Recorder<'a> {
        db: &'a Db,
        outcome: DispatchOutcome,
        fired: RefCell<Vec<(String, String)>>,
    }
    impl<'a> Recorder<'a> {
        fn new(db: &'a Db, outcome: DispatchOutcome) -> Self {
            Self {
                db,
                outcome,
                fired: RefCell::new(Vec::new()),
            }
        }
        fn dispatch(&self) -> impl FnMut(&str, &str, i64) -> DispatchOutcome + '_ {
            move |wf: &str, run_id: &str, now: i64| {
                self.fired
                    .borrow_mut()
                    .push((wf.to_string(), run_id.to_string()));
                if self.outcome == DispatchOutcome::Fired {
                    // Emulate the engine creating the run row under the deterministic
                    // id (the at-most-once anchor). A duplicate would fail closed at
                    // the PK exactly like the engine — surface it as Error.
                    if create_run(self.db.conn(), run_id, wf, now).is_err() {
                        return DispatchOutcome::Error;
                    }
                }
                self.outcome
            }
        }
    }

    fn default_bounds() -> TickBounds {
        TickBounds::default()
    }

    // --- no-fire when the flag is OFF is enforced at the SPAWN SITE (the thread is
    // never created); the engine itself has no flag. The byte-identical guarantee is
    // tested by the spawn-site flag matcher test in hub_agent_run_server.rs. Here we
    // prove the ENGINE semantics directly. ---

    #[test]
    fn due_job_is_detected_and_fired_exactly_once() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        enabled_every_minute(&db, "s1", "wf1");
        let rec = Recorder::new(&db, DispatchOutcome::Fired);

        // First tick at slot 10: the most-recent due slot (10) fires exactly once.
        let out = run_one_tick(
            db.conn(),
            &default_bounds(),
            slot(10) + 30_000,
            rec.dispatch(),
        )
        .unwrap();
        assert_eq!(out.fired, 1, "exactly one fire");
        assert_eq!(out.reports.len(), 1);
        assert_eq!(out.reports[0].fired_slot, Some(slot(10)));
        let fired = rec.fired.borrow();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0], ("wf1".into(), "sched:s1:600000".into()));
        // the receipt records `fired` with the deterministic run id
        let r = get_fire(db.conn(), "s1", slot(10)).unwrap().unwrap();
        assert_eq!(r.outcome, "fired");
        assert_eq!(r.run_id.as_deref(), Some("sched:s1:600000"));
        // watermark advanced to the now slot (10)
        let row = friday_storage::schedule::get_schedule(db.conn(), "s1")
            .unwrap()
            .unwrap();
        assert_eq!(row.last_slot_ts, Some(slot(10)));
    }

    #[test]
    fn no_fire_into_a_busy_spine_same_schedule_previous_run_non_terminal() {
        // The serialization guard: the schedule's PREVIOUS fire is still
        // non-terminal (running), so the next due slot must NOT fire — it is
        // recorded skipped_previous_awaiting.
        let db = Db::open_hub(&tmp_db()).unwrap();
        enabled_every_minute(&db, "s1", "wf1");
        let rec = Recorder::new(&db, DispatchOutcome::Fired);

        // Tick 1 at slot 10 → fires, run row created (Pending).
        run_one_tick(db.conn(), &default_bounds(), slot(10), rec.dispatch()).unwrap();
        let prev_run = "sched:s1:600000";
        // Drive the prior run to a NON-terminal running state.
        set_run_state(db.conn(), prev_run, WorkflowRunState::Running, slot(10)).unwrap();

        // Tick 2 at slot 11 → the most-recent due slot (11) is skipped because the
        // prior fire is still running. NO new dispatch.
        let before = rec.fired.borrow().len();
        let out = run_one_tick(db.conn(), &default_bounds(), slot(11), rec.dispatch()).unwrap();
        assert_eq!(out.fired, 0, "must not fire into a busy spine");
        assert!(out.reports[0].skipped_previous_awaiting);
        assert_eq!(rec.fired.borrow().len(), before, "no new dispatch");
        let r = get_fire(db.conn(), "s1", slot(11)).unwrap().unwrap();
        assert_eq!(r.outcome, "skipped_previous_awaiting");

        // Once the prior run goes TERMINAL (done), a later due slot fires again.
        set_run_state(db.conn(), prev_run, WorkflowRunState::Done, slot(11)).unwrap();
        let out = run_one_tick(db.conn(), &default_bounds(), slot(12), rec.dispatch()).unwrap();
        assert_eq!(out.fired, 1, "fires again after the prior run finishes");
        assert_eq!(out.reports[0].fired_slot, Some(slot(12)));
    }

    #[test]
    fn paused_scheduler_fires_nothing_and_advances_no_watermark() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        enabled_every_minute(&db, "s1", "wf1");
        set_paused(db.conn(), true, Some("operator drain"), 0).unwrap();
        let rec = Recorder::new(&db, DispatchOutcome::Fired);

        let out = run_one_tick(db.conn(), &default_bounds(), slot(10), rec.dispatch()).unwrap();
        assert!(out.paused);
        assert_eq!(out.fired, 0);
        assert!(rec.fired.borrow().is_empty(), "paused: nothing dispatched");
        // watermark untouched (NULL) — a clean drain resumes where it left off
        let row = friday_storage::schedule::get_schedule(db.conn(), "s1")
            .unwrap()
            .unwrap();
        assert_eq!(row.last_slot_ts, None);

        // Unpause → the next tick resumes and the storm guard collapses the gap to
        // the single most-recent slot (no backlog fire).
        set_paused(db.conn(), false, None, slot(20)).unwrap();
        let out = run_one_tick(db.conn(), &default_bounds(), slot(20), rec.dispatch()).unwrap();
        assert_eq!(
            out.fired, 1,
            "exactly one (most-recent) slot fires on resume"
        );
        assert_eq!(out.reports[0].fired_slot, Some(slot(20)));
    }

    #[test]
    fn idempotent_no_double_fire_orphan_run_same_slot_restart() {
        // RECOVERY WINDOW A (same-minute restart): a tick dispatched the run
        // (create_run committed) but CRASHED before writing the fire receipt, and
        // the restart lands on the SAME slot. We simulate by creating the run row
        // under the deterministic id WITHOUT a receipt, then running a fresh tick at
        // the same slot. It must NOT re-dispatch (PK would reject), must heal-forward
        // the `fired` receipt, and end with exactly ONE run + ONE receipt.
        let db = Db::open_hub(&tmp_db()).unwrap();
        enabled_every_minute(&db, "s1", "wf1");

        // Simulate the orphaned run: the deterministic id exists, NO receipt.
        let run_id = scheduled_run_id("s1", slot(10));
        create_run(db.conn(), &run_id, "wf1", slot(10)).unwrap();
        assert!(
            get_fire(db.conn(), "s1", slot(10)).unwrap().is_none(),
            "no receipt yet"
        );

        // A dispatch stub that counts calls — proving we never re-dispatch.
        let dispatched = RefCell::new(0usize);
        let out = run_one_tick(db.conn(), &default_bounds(), slot(10), |_wf, _rid, _now| {
            *dispatched.borrow_mut() += 1;
            DispatchOutcome::Fired
        })
        .unwrap();
        assert_eq!(
            *dispatched.borrow(),
            0,
            "an orphaned run is NEVER re-dispatched"
        );
        assert_eq!(out.fired, 1, "healed-forward counts as the (single) fire");
        // exactly one receipt, pointing at the existing run
        let r = get_fire(db.conn(), "s1", slot(10)).unwrap().unwrap();
        assert_eq!(r.outcome, "fired");
        assert_eq!(r.run_id.as_deref(), Some(run_id.as_str()));
        assert_eq!(r.detail_token.as_deref(), Some(detail::RECOVERED_ORPHAN));
    }

    #[test]
    fn idempotent_no_double_fire_orphan_run_cross_minute_restart() {
        // RECOVERY WINDOW A (cross-minute restart — the REALISTIC case): a prior tick
        // at slot 10 dispatched run `sched:s1:slot(10)` and crashed before the
        // receipt. The restart takes time and lands at slot 11, so the orphaned slot
        // 10 is now part of the BACKLOG (not the fire candidate, which is 11). The
        // missed-backlog reconciliation must heal slot 10 FORWARD to `fired` (not
        // mislabel it `skipped_missed`) AND not re-dispatch it; slot 11 fires fresh.
        let db = Db::open_hub(&tmp_db()).unwrap();
        enabled_every_minute(&db, "s1", "wf1");
        // The watermark is at slot 9 (a prior tick), then the crash.
        friday_storage::schedule::set_last_slot(db.conn(), "s1", slot(9), slot(9)).unwrap();
        // The orphaned run from slot 10's crashed tick: run row exists, NO receipt.
        let orphan = scheduled_run_id("s1", slot(10));
        create_run(db.conn(), &orphan, "wf1", slot(10)).unwrap();

        let rec = Recorder::new(&db, DispatchOutcome::Fired);
        let out = run_one_tick(db.conn(), &default_bounds(), slot(11), rec.dispatch()).unwrap();

        // Slot 10 (the orphan, now in the backlog) is healed FORWARD to `fired`, NOT
        // mislabeled `skipped_missed`, and NOT re-dispatched — the core gap this test
        // closes. The orphan's run row is still `Pending` (the crashed tick left it
        // mid-flight; boot crash-recovery reconciles the run state separately).
        let s10 = get_fire(db.conn(), "s1", slot(10)).unwrap().unwrap();
        assert_eq!(
            s10.outcome, "fired",
            "the cross-minute orphan is healed forward, not mislabeled"
        );
        assert_eq!(s10.run_id.as_deref(), Some(orphan.as_str()));
        assert_eq!(s10.detail_token.as_deref(), Some(detail::RECOVERED_ORPHAN));
        assert_eq!(
            out.reports[0].skipped_missed, 0,
            "the orphan is NOT a skipped_missed"
        );

        // Slot 11 (the fire candidate) correctly DEFERS: the just-healed slot-10 fire
        // is still non-terminal (Pending), so the serialization guard refuses to
        // stampede a NEW fire onto the live prior run. NO re-dispatch of the orphan,
        // NO fresh dispatch of slot 11.
        let s11 = get_fire(db.conn(), "s1", slot(11)).unwrap().unwrap();
        assert_eq!(
            s11.outcome, "skipped_previous_awaiting",
            "busy spine: slot 11 defers to the live slot-10 run"
        );
        assert!(
            rec.fired.borrow().is_empty(),
            "the orphan was never re-dispatched and slot 11 deferred"
        );
        // exactly one fire COUNTED this tick — the healed orphan (a distinct due-time
        // that genuinely fired once); at-most-once-per-due-time holds.
        assert_eq!(out.fired, 1);

        // Once the orphan run finishes, a later slot fires fresh — proving the defer
        // was transient (the spine unblocks), not a permanent wedge. (Pending -> Done
        // is not a legal direct edge; drive it through Running like the real engine.)
        set_run_state(db.conn(), &orphan, WorkflowRunState::Running, slot(11)).unwrap();
        set_run_state(db.conn(), &orphan, WorkflowRunState::Done, slot(11)).unwrap();
        let out2 = run_one_tick(db.conn(), &default_bounds(), slot(12), rec.dispatch()).unwrap();
        assert_eq!(out2.fired, 1, "fires again after the orphan run completes");
        assert_eq!(out2.reports[0].fired_slot, Some(slot(12)));
    }

    #[test]
    fn idempotent_re_tick_after_receipt_does_not_reconsider_or_refire() {
        // RECOVERY WINDOW B closed + general replay: a tick fully completed (run +
        // receipt + watermark). Re-running the SAME tick (a replayed/duplicated
        // tick) must do nothing: no re-dispatch, no second receipt, no double-count.
        let db = Db::open_hub(&tmp_db()).unwrap();
        enabled_every_minute(&db, "s1", "wf1");
        let rec = Recorder::new(&db, DispatchOutcome::Fired);

        let out1 = run_one_tick(db.conn(), &default_bounds(), slot(10), rec.dispatch()).unwrap();
        assert_eq!(out1.fired, 1);
        let dispatched_after_first = rec.fired.borrow().len();

        // Re-run the EXACT same tick (same now). Idempotent: nothing new.
        let out2 = run_one_tick(db.conn(), &default_bounds(), slot(10), rec.dispatch()).unwrap();
        assert_eq!(out2.fired, 0, "no re-fire on a replayed tick");
        assert!(out2.is_empty(), "a fully-replayed tick is a quiet no-op");
        assert_eq!(
            rec.fired.borrow().len(),
            dispatched_after_first,
            "no second dispatch"
        );
        // still exactly one receipt for the slot
        assert!(get_fire(db.conn(), "s1", slot(10)).unwrap().is_some());
    }

    #[test]
    fn catch_up_storm_fires_only_the_most_recent_and_skips_the_backlog() {
        // The runaway guard: a watermark far in the past + a per-minute schedule.
        // Only the MOST-RECENT slot fires; every older due slot is skipped_missed;
        // the watermark jumps to now so the backlog is never rescanned.
        let db = Db::open_hub(&tmp_db()).unwrap();
        enabled_every_minute(&db, "s1", "wf1");
        // Pretend a prior tick set the watermark to slot 0 long ago, then the daemon
        // was down. Now it is slot 100 (100 missed per-minute slots).
        friday_storage::schedule::set_last_slot(db.conn(), "s1", slot(0), slot(0)).unwrap();
        let rec = Recorder::new(&db, DispatchOutcome::Fired);

        let out = run_one_tick(db.conn(), &default_bounds(), slot(100), rec.dispatch()).unwrap();
        assert_eq!(out.fired, 1, "exactly ONE fire despite 100 missed slots");
        assert_eq!(out.reports[0].fired_slot, Some(slot(100)));
        assert_eq!(
            out.reports[0].skipped_missed, 99,
            "slots 1..=99 are skipped_missed"
        );
        assert_eq!(rec.fired.borrow().len(), 1, "exactly one real dispatch");
        // a sampled backlog slot is recorded skipped_missed, NOT fired
        let mid = get_fire(db.conn(), "s1", slot(50)).unwrap().unwrap();
        assert_eq!(mid.outcome, "skipped_missed");
        // watermark jumped to now → a follow-up tick at the same now is a quiet no-op
        let row = friday_storage::schedule::get_schedule(db.conn(), "s1")
            .unwrap()
            .unwrap();
        assert_eq!(row.last_slot_ts, Some(slot(100)));
        let out2 = run_one_tick(db.conn(), &default_bounds(), slot(100), rec.dispatch()).unwrap();
        assert!(out2.is_empty(), "backlog is never rescanned");
    }

    #[test]
    fn consider_cap_bounds_the_backlog_receipts_per_tick() {
        // Even a pathological backlog writes at most `max_considered_per_tick`
        // receipts in one tick (the storm-skip cap), and still advances the
        // watermark to now (the remainder is dropped, never fired).
        let db = Db::open_hub(&tmp_db()).unwrap();
        enabled_every_minute(&db, "s1", "wf1");
        friday_storage::schedule::set_last_slot(db.conn(), "s1", slot(0), slot(0)).unwrap();
        let rec = Recorder::new(&db, DispatchOutcome::Fired);
        let bounds = TickBounds {
            max_fires_per_tick: 8,
            max_considered_per_tick: 10,
        };
        let out = run_one_tick(db.conn(), &bounds, slot(1000), rec.dispatch()).unwrap();
        assert_eq!(out.fired, 1, "still exactly one fire");
        assert!(
            out.considered <= 10,
            "considered receipts are capped: {}",
            out.considered
        );
        // watermark still jumped to now (no rescanned backlog)
        let row = friday_storage::schedule::get_schedule(db.conn(), "s1")
            .unwrap()
            .unwrap();
        assert_eq!(row.last_slot_ts, Some(slot(1000)));
    }

    #[test]
    fn fire_cap_bounds_dispatches_across_many_schedules() {
        // Many always-due schedules; the per-tick FIRE cap bounds total dispatches.
        let db = Db::open_hub(&tmp_db()).unwrap();
        for i in 0..20 {
            enabled_every_minute(&db, &format!("s{i:02}"), "wf1");
        }
        let rec = Recorder::new(&db, DispatchOutcome::Fired);
        let bounds = TickBounds {
            max_fires_per_tick: 3,
            max_considered_per_tick: 256,
        };
        let out = run_one_tick(db.conn(), &bounds, slot(10), rec.dispatch()).unwrap();
        assert_eq!(out.fired, 3, "fire cap bounds dispatches per tick");
        assert_eq!(rec.fired.borrow().len(), 3);
        // the un-fired schedules did NOT advance their watermark → fired next tick
        let unfired: Vec<_> = (0..20)
            .map(|i| format!("s{i:02}"))
            .filter(|id| {
                friday_storage::schedule::get_schedule(db.conn(), id)
                    .unwrap()
                    .unwrap()
                    .last_slot_ts
                    .is_none()
            })
            .collect();
        assert_eq!(unfired.len(), 17, "17 schedules deferred to a later tick");
    }

    #[test]
    fn invalid_stored_cron_is_recorded_and_never_fired() {
        // The slice-B second guard: a stored row holding a cron the evaluator would
        // choke on (defence behind the create-time parse) is recorded
        // invalid_schedule and never fired.
        let db = Db::open_hub(&tmp_db()).unwrap();
        // Insert a bad cron via the storage layer directly (bypassing the hub
        // create gate, exactly the corruption the second guard defends against).
        insert_schedule(
            db.conn(),
            &NewSchedule {
                schedule_id: "bad",
                workflow_id: "wf1",
                cron_expr: "not a cron",
            },
            0,
        )
        .unwrap();
        set_enabled(db.conn(), "bad", true, 0).unwrap();
        let rec = Recorder::new(&db, DispatchOutcome::Fired);

        let out = run_one_tick(db.conn(), &default_bounds(), slot(10), rec.dispatch()).unwrap();
        assert_eq!(out.fired, 0, "an invalid schedule never fires");
        assert!(out.reports[0].invalid);
        assert!(rec.fired.borrow().is_empty());
        let r = get_fire(db.conn(), "bad", slot(10)).unwrap().unwrap();
        assert_eq!(r.outcome, "invalid_schedule");
    }

    #[test]
    fn no_published_version_is_skipped_not_fired() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        enabled_every_minute(&db, "s1", "wf-missing");
        let rec = Recorder::new(&db, DispatchOutcome::NoPublishedVersion);

        let out = run_one_tick(db.conn(), &default_bounds(), slot(10), rec.dispatch()).unwrap();
        assert_eq!(out.fired, 0);
        assert!(out.reports[0].skipped_no_published);
        let r = get_fire(db.conn(), "s1", slot(10)).unwrap().unwrap();
        assert_eq!(r.outcome, "skipped_no_published");
        // a follow-up tick does not retry the same slot (it was considered)
        let out2 = run_one_tick(db.conn(), &default_bounds(), slot(10), rec.dispatch()).unwrap();
        assert!(out2.is_empty());
    }

    #[test]
    fn disabled_schedule_is_never_scanned() {
        let db = Db::open_hub(&tmp_db()).unwrap();
        // born disabled, never enabled
        insert_schedule(
            db.conn(),
            &NewSchedule {
                schedule_id: "s1",
                workflow_id: "wf1",
                cron_expr: "* * * * *",
            },
            0,
        )
        .unwrap();
        let rec = Recorder::new(&db, DispatchOutcome::Fired);
        let out = run_one_tick(db.conn(), &default_bounds(), slot(10), rec.dispatch()).unwrap();
        assert!(out.is_empty(), "a disabled schedule is never considered");
        assert!(rec.fired.borrow().is_empty());
        assert!(get_fire(db.conn(), "s1", slot(10)).unwrap().is_none());
    }

    #[test]
    fn freshly_enabled_schedule_does_not_fire_for_the_past() {
        // A schedule enabled NOW (no watermark) considers only the CURRENT slot, not
        // any historical due slot — enabling is not a retroactive backfill.
        let db = Db::open_hub(&tmp_db()).unwrap();
        enabled_every_minute(&db, "s1", "wf1");
        let rec = Recorder::new(&db, DispatchOutcome::Fired);
        // now = slot 1000; a per-minute schedule has 1000 historical due slots, but
        // a fresh schedule (NULL watermark) considers only the current one.
        let out = run_one_tick(db.conn(), &default_bounds(), slot(1000), rec.dispatch()).unwrap();
        assert_eq!(out.fired, 1, "only the current slot fires");
        assert_eq!(out.reports[0].skipped_missed, 0, "no historical backfill");
        assert_eq!(rec.fired.borrow().len(), 1);
    }
}
