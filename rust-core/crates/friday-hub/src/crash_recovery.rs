//! Crash-recovery for orphaned in-flight WorkItems (registry gap #24, DARK, default-OFF).
//!
//! ## The wedge this closes
//! With auto-dispatch LIVE, the WS server (`hub_agent_run_server`) owns an in-process agent
//! loop while a WorkItem is mid-flight. If that process DIES mid-turn (the SQLITE_BUSY
//! crash-loop history proves this happens), the new process owns NO in-flight run: a WorkItem
//! left in a genuinely-executing hub-internal state is NEVER advanced again, so the Mission
//! wedges FOREVER. This module adds a boot-time, best-effort reconciliation that advances each
//! genuinely-orphaned row to a TERMINAL `FailedTerminal` with a clear marker, via the LEGAL
//! work-item state machine + audit chain.
//!
//! ## The load-bearing correctness point — ORPHANED vs WAITING
//! A graceful/crash restart means the new process owns no in-flight run, so a genuinely-running
//! hub-internal row IS orphaned. But many non-terminal rows are LEGITIMATELY WAITING to be
//! resumed by a LIVE recovery path; reconciling THOSE would BREAK resume = a degrade. The
//! discriminating principle is NOT a status pattern but: *does a live recovery path pick this
//! row up?* If yes ⇒ WAITING (leave it). If provably none ⇒ ORPHANED (reconcile).
//!
//! Applying it to every non-terminal [`WorkItemStatus`]:
//!   * `Dispatched` (`PendingState::SentToHub`) and `HubAccepted` (`AcceptedByHub`) are the
//!     hub-internal in-process hops the dying loop was MID-flight on. No resume / dispatch /
//!     provider-reconnect path re-picks them after the loop dies. **These are the clean
//!     orphans.** Both `Dispatched->FailedTerminal` and `HubAccepted->FailedTerminal` are legal
//!     transitions (`friday_core::WorkItemStatus::can_transition_to`), so the reconcile uses the
//!     standard `transition_work_item_status` primitive (audit row + upsert in one tx).
//!   * `ReadyToDispatch` (PRIMARY PASS-2 state) is where a mission-bound WorkItem RESTS WHILE the
//!     agent loop runs the model call (#24b, panel-fixed): the binding to `ProviderRouted` happens
//!     AFTER the loop returns, so the during-call status is `ReadyToDispatch`. #767 left it untouched
//!     because, with no durable run-execution marker, a crashed-mid-call `ReadyToDispatch` could not
//!     be told apart from a freshly-dispatched-but-not-yet-running one (dispatch's normal hand-off
//!     state) — reconciling blindly would abort a run that never started (a degrade).
//!     `ProviderRouted`/`ProviderWaiting` (DEFENSIVE PASS-2 states) are the legacy provider in-flight
//!     hops: the normal post-loop bind clears `executing` ATOMICALLY at its final hop, so a paused
//!     run never sits there `executing == 1`, but they stay in the candidate set defensively.
//!
//!     **PASS-2 (#24b) closes that exact gap with a DURABLE execution marker.** The agent loop SETs
//!     `work_item.executing = 1` + `last_heartbeat_ms = now` JUST BEFORE each model call AND before
//!     each tool execution, and CLEARs `executing = 0` at EVERY loop exit; the post-loop binding
//!     additionally clears it ATOMICALLY in the same transaction as its final resting-state hop.
//!     PASS-2 reconciles a `ReadyToDispatch`/`ProviderRouted`/`ProviderWaiting` row ONLY when it is
//!     `executing == 1` AND `last_heartbeat_ms` is STALE (older than
//!     [`EXECUTION_STATE_STALE_THRESHOLD_MS`] = 5 min, which strictly exceeds the longest legit
//!     single model call — itself wall-clock-bounded by the friday-deepseek transport timeout) —
//!     i.e. the process that set the marker DIED mid-call. A row with `executing == 0`
//!     (legit-paused/awaiting/finished/not-yet-running), or a FRESH heartbeat (a slow-but-LIVE call),
//!     is NEVER touched. `ReadyToDispatch -> FailedTerminal` (additive #24b edge),
//!     `ProviderRouted -> FailedTerminal`, and `ProviderWaiting -> FailedTerminal` are all legal
//!     hops, so PASS-2 uses the SAME legal `transition_work_item_status` primitive +
//!     `crash_recovery_abort` marker as PASS-1.
//!   * `WaitingForUser` is awaiting the user (the awaiting-clarification flow); `Draft` /
//!     `PreflightBlocked` are owned by preflight; `FailedRetryable` by the retry path. None is an
//!     in-flight hub hop and each has its own owner. WAITING. (`ReadyToDispatch` is owned by dispatch
//!     too — and PASS-2 honors that: a `ReadyToDispatch` row is touched ONLY when `executing == 1 +
//!     stale`, never the normal `executing == 0` dispatch hand-off state.)
//!   * the five terminal statuses are never in the scan set (`list_active_work_items` excludes
//!     them) and are never touched.
//!
//! ## No-degrade posture
//!   * **Flag-OFF ⇒ no PASS-2 reconcile (no scan, no write).** [`crash_recovery_enabled_from`] is
//!     the pure matcher; the server reads `FRIDAY_CRASH_RECOVERY` ONCE at boot and, when OFF
//!     (default / anything but the exact trimmed `"1"`), NEVER calls
//!     [`reconcile_orphaned_work_items`]. NOTE — the #24b loop-side change is FLAG-INDEPENDENT (it
//!     runs on every mission-bound run, flag on or off): the `executing`/`last_heartbeat_ms` columns
//!     are written by the loop. The WorkItem-status TIMING is UNCHANGED vs pre-#24b: the binding is
//!     driven AFTER the loop (the panel-BLOCK fix REVERTED the original pre-dispatch reorder), so an
//!     errored run stays `ReadyToDispatch` (retryable) and the during-call status is `ReadyToDispatch`
//!     exactly as before. So flag-OFF is BYTE-IDENTICAL for NON-mission runs, and END-STATE- +
//!     AUDIT-IDENTICAL for mission-bound runs (only two columns no read path consults are written, +
//!     the final-hop bind clears `executing` in the same tx) — proven by the full
//!     mission_runtime/runtime/resume/surface-event suites staying green. Only the boot reconcile is
//!     gated.
//!   * **Best-effort + fail-safe.** Reconciliation runs BEFORE the server accepts connections, but
//!     a reconcile error is LOGGED (category only) and SWALLOWED — it MUST NEVER block boot (the
//!     server coming up is load-bearing; this is cleanup). A per-row transition failure is logged
//!     and skipped; one bad row never aborts the sweep.
//!   * **Only advances DEAD rows.** PASS-1 touches only `Dispatched` / `HubAccepted`; PASS-2 touches
//!     a `ReadyToDispatch` / `ProviderRouted` / `ProviderWaiting` row ONLY when it is `executing == 1`
//!     with a STALE heartbeat. Every other row — an `executing == 0` ready/paused/awaiting row, a
//!     fresh-heartbeat LIVE row, every other waiting status, and every terminal row — is left
//!     byte-for-byte unchanged.
//!   * **Idempotent.** After the first sweep the orphans are `FailedTerminal` ⇒ excluded from the
//!     scan ⇒ a second boot finds nothing (a no-op).
//!
//! ## Residual limitations (named honestly, like #767 named its deferral — NOT fixed here)
//!   * **The dispatch→first-SET window.** Between a mission-bound run reaching `ReadyToDispatch` and
//!     the loop's first heartbeat SET, a crash leaves `ReadyToDispatch + executing == 0` —
//!     indistinguishable from a freshly-dispatched-not-yet-running row, so unreconciled. The window
//!     is narrow (no model call happens in it), and the dispatch path already owns re-driving a
//!     never-started `ReadyToDispatch`.
//!   * **The codex mission-bound path.** Codex runs bypass `run_loop_with_policy` (the special-cased
//!     gated-turn path), so they NEVER write the heartbeat — a codex mission-bound run crashing
//!     mid-turn leaves `executing == 0`, also unreconciled. Dark today (codex unavailable in the
//!     autonomous baseline); named for when it is wired.
//!
//! GATING: the boot PASS-1+PASS-2 reconcile is default-OFF (`FRIDAY_CRASH_RECOVERY`). The loop-side
//! marker writes are flag-INDEPENDENT (see the no-degrade posture above), but the WorkItem-status
//! timing is UNCHANGED vs pre-#24b (binding driven after the loop).

use friday_core::{WorkItemStatus, WorkflowRunState};
use friday_storage::{Db, StorageError};

/// The env flag that gates boot-time crash-recovery reconciliation. DEFAULT-OFF.
pub const FRIDAY_CRASH_RECOVERY: &str = "FRIDAY_CRASH_RECOVERY";

/// The actor recorded on the lifecycle audit row for a crash-recovery abort.
const CRASH_RECOVERY_ACTOR: &str = "crash-recovery";

/// The marker written as BOTH the transition `reason` (⇒ the lifecycle audit action) and the
/// row's `blocking_reason`, so the abort is queryable from either the audit chain or the row.
pub const CRASH_RECOVERY_MARKER: &str = "crash_recovery_abort";

/// (#24b) How stale a durable `executing` heartbeat must be before boot crash-recovery PASS-2
/// treats a `ReadyToDispatch`/`ProviderRouted`/`ProviderWaiting` row as CRASHED-while-executing (vs
/// a slow-but-LIVE model call). 5 MINUTES — chosen to strictly EXCEED the longest legitimate gap
/// between two heartbeat writes this codebase can have, so a slow-but-live turn is NEVER reconciled:
///   * The heartbeat is RE-SET with a FRESH wall-clock timestamp at MULTIPLE points per turn: just
///     before the model call, before EACH bounded transient-route retry attempt, and again just
///     before each tool execution (degrade-4 fix). So the staleness is measured against the gap
///     between ANY two consecutive heartbeat writes, NOT a whole turn and NOT a whole run.
///   * The model HTTP call is now WALL-CLOCK-BOUNDED by the friday-deepseek `UreqTransport` overall
///     request timeout (`DEEPSEEK_REQUEST_TIMEOUT` = 60s; a timed-out call returns a transient
///     `ProviderUnavailable` route error). With the heartbeat re-set before EACH of the ≤3 attempts,
///     the longest gap a model-call group can introduce is ONE attempt ≈ 60s. A single tool
///     execution is local FS/IO (sub-second). So the worst-case gap between heartbeat writes is ~60s
///     — well under the 300s threshold, a ~5x margin. For scale: the WS server's per-read timeout is
///     30s (`READ_TIMEOUT`) and the session reaper interval is 120s; 300s exceeds both by a wide margin.
///
/// So a heartbeat older than 5 min reliably means the process that SET it is DEAD (it never reached
/// the next heartbeat write or the loop's tail clear), not that a live call is still running.
/// Tightening this risks reconciling a slow-but-live run (a degrade); loosening it only delays
/// cleanup of a genuinely-dead row (safe).
pub const EXECUTION_STATE_STALE_THRESHOLD_MS: i64 = 300_000;

/// Pure flag-matcher (separated from the env read so it is testable without mutating the
/// process-global environment). DEFAULT-OFF: `None` (unset) ⇒ false; ON only for the exact
/// opt-in value `"1"` (trimmed), matching the program's standard flag idiom; everything else
/// (including `"true"`) ⇒ false.
pub fn crash_recovery_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// Whether a non-terminal [`WorkItemStatus`] is a GENUINELY-ORPHANED in-flight hub hop (no live
/// recovery path) that boot crash-recovery may abort — as opposed to a status that is
/// legitimately WAITING to be resumed (which must NEVER be touched). See the module docs for the
/// full classification and its rationale.
///
/// ONLY `Dispatched` and `HubAccepted` are orphaned. Every other status — waiting
/// (`Draft`, `PreflightBlocked`, `WaitingForUser`, `ReadyToDispatch`, `ProviderRouted`,
/// `ProviderWaiting`, `FailedRetryable`) and terminal — returns false.
pub fn is_orphaned_in_flight(status: WorkItemStatus) -> bool {
    matches!(
        status,
        WorkItemStatus::Dispatched | WorkItemStatus::HubAccepted
    )
}

/// (#24b) Whether a non-terminal status is one PASS-2 may reconcile WHEN it is durably
/// `executing` with a STALE heartbeat — the states a process can DIE in while the agent loop is
/// actively running, which #767's PASS-1 classifier ([`is_orphaned_in_flight`]) deliberately left
/// untouched because, WITHOUT a durable execution marker, a crash-orphaned one could not be told
/// apart from a legitimately-waiting one.
///
/// `ReadyToDispatch` is the PRIMARY member: in the panel-BLOCK-fixed #24b design the WorkItem rests
/// at `ReadyToDispatch` WHILE the agent loop runs the model call (the binding to `ProviderRouted`
/// happens AFTER the loop returns, atomically clearing `executing`), so a mid-model-call crash
/// leaves `ReadyToDispatch + executing == 1 + stale`. The additive `ReadyToDispatch ->
/// FailedTerminal` edge (see `friday_core::WorkItemStatus::can_transition_to`) makes reconciling it
/// legal. `ProviderRouted`/`ProviderWaiting` are retained as DEFENSIVE members for any path that
/// leaves an `executing == 1` provider row (the normal post-loop bind clears `executing` atomically
/// at its final hop, so a paused run never sits there `executing == 1`).
///
/// The durable `executing` marker (set by the agent loop just before each model call + before tool
/// execution, cleared at every loop exit AND atomically by the binding's final hop) makes the
/// distinction safe: a row that is `executing == 1` with a heartbeat older than
/// [`EXECUTION_STATE_STALE_THRESHOLD_MS`] is a process that DIED mid-call. A row with
/// `executing == 0` (paused/awaiting/finished/not-yet-running) is NEVER in this set's action path.
pub fn is_stale_executing_candidate(status: WorkItemStatus) -> bool {
    matches!(
        status,
        WorkItemStatus::ReadyToDispatch
            | WorkItemStatus::ProviderRouted
            | WorkItemStatus::ProviderWaiting
    )
}

/// The outcome of one boot reconciliation sweep — refs-only counts (never row bodies), suitable
/// for a single log line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReconcileOutcome {
    /// Non-terminal rows scanned.
    pub scanned: usize,
    /// Genuinely-orphaned rows advanced to `FailedTerminal` with the crash-recovery marker.
    pub aborted: usize,
    /// Orphaned rows whose legal transition failed (logged + skipped; the sweep continues).
    pub skipped: usize,
}

impl ReconcileOutcome {
    pub fn is_empty(&self) -> bool {
        self.aborted == 0 && self.skipped == 0
    }
}

/// Scan the active (non-terminal) WorkItems and advance every GENUINELY-ORPHANED in-flight row
/// (`Dispatched` / `HubAccepted`) to a terminal `FailedTerminal`, marking it
/// `blocking_reason = CRASH_RECOVERY_MARKER` AND recording the same marker on the lifecycle audit
/// row — via the LEGAL `transition_work_item_status` state machine (which writes the hash-chained
/// audit row + upsert in one transaction). WAITING rows (paused/awaiting/provider-waiting/etc.) and
/// terminal rows are left untouched.
///
/// FAIL-SAFE: a scan-level read error returns `Err` to the caller (which LOGS + SWALLOWS it — boot
/// is never blocked). A per-row failure (e.g. a concurrent terminal transition racing in) is logged
/// via the `skipped` count and the sweep continues. IDEMPOTENT: an already-`FailedTerminal` row is
/// excluded from the scan, so a second sweep finds nothing.
///
/// The `blocking_reason` row marker is set by a status-PRESERVING upsert FIRST (so it survives the
/// transition fn's fresh re-read), then the legal terminal transition is applied; if the upsert
/// fails the row is skipped (never half-marked into a terminal state by some other path).
pub fn reconcile_orphaned_work_items(
    db: &Db,
    now_ms: i64,
) -> Result<ReconcileOutcome, StorageError> {
    let active = db.list_active_work_items()?;
    let mut outcome = ReconcileOutcome {
        scanned: active.len(),
        ..ReconcileOutcome::default()
    };

    for item in active {
        // PASS-1 (#767): the clean orphans — `Dispatched`/`HubAccepted`, the hub-internal hops a
        // dying loop was mid-flight on with no live recovery path. Reconciled unconditionally.
        let abort = if is_orphaned_in_flight(item.status) {
            true
        } else if is_stale_executing_candidate(item.status) {
            // PASS-2 (#24b): a `ReadyToDispatch` (the mid-model-call crash state in the no-reorder
            // design) / `ProviderRouted` / `ProviderWaiting` row is reconciled ONLY when it is
            // durably `executing == 1` AND its heartbeat is STALE (older than the threshold) — i.e.
            // the process that set the marker DIED mid-model-call. A row with `executing == 0`
            // (a not-yet-running ready row, a legit-paused/awaiting run), or one with a FRESH
            // heartbeat (a slow-but-LIVE model call), is NEVER touched. A read error on the
            // execution-state column is FAIL-SAFE: treat the row as NOT a crash candidate (leave it
            // untouched) rather than risk aborting a live run.
            match db.get_work_item_execution_state(&item.work_item_id) {
                Ok(Some(state)) => {
                    state.executing
                        && state.last_heartbeat_ms.is_some_and(|hb| {
                            now_ms.saturating_sub(hb) >= EXECUTION_STATE_STALE_THRESHOLD_MS
                        })
                }
                // No row (raced to terminal) or a read error ⇒ do not reconcile (fail-safe).
                Ok(None) | Err(_) => false,
            }
        } else {
            // Every other non-terminal status (waiting / not-orphaned) — leave it byte-for-byte
            // unchanged. Includes a `ReadyToDispatch`/`ProviderRouted`/`ProviderWaiting` row with
            // `executing == 0` (ready/paused/awaiting) or a fresh heartbeat (live).
            false
        };

        if !abort {
            continue;
        }

        // (1) Stamp the row-level `blocking_reason` marker WITHOUT changing status, so it survives
        //     `transition_work_item_status`'s fresh re-read of the row. A status-preserving upsert
        //     is legal (no state-machine hop). On failure, skip this row (do NOT proceed to the
        //     terminal transition with an unmarked row). NOTE: `upsert_work_item` does NOT write the
        //     `executing`/`last_heartbeat_ms` columns (they are managed only by
        //     `set_work_item_executing`), so this re-upsert preserves the execution marker as-is.
        let mut marked = item.clone();
        marked.blocking_reason = Some(CRASH_RECOVERY_MARKER.to_string());
        marked.updated_at_ms = now_ms;
        if let Err(_e) = db.upsert_work_item(&marked) {
            // Category only — never the row body / id contents.
            eprintln!(
                "hub_agent_run_server: crash-recovery could not mark an orphaned WorkItem (skipping)"
            );
            outcome.skipped += 1;
            continue;
        }

        // (2) Advance to the terminal `FailedTerminal` via the LEGAL transition primitive. The same
        //     marker is recorded as the audit `reason` (⇒ the lifecycle action string), so the abort
        //     is queryable from the audit chain too. Both `Dispatched`/`HubAccepted` AND
        //     `ProviderRouted`/`ProviderWaiting` have a legal `-> FailedTerminal` hop in the core
        //     state machine. A failed transition (e.g. a racing terminal write) is logged + skipped;
        //     the sweep continues.
        match db.transition_work_item_status(
            &item.work_item_id,
            WorkItemStatus::FailedTerminal,
            CRASH_RECOVERY_ACTOR,
            CRASH_RECOVERY_MARKER,
            None,
            now_ms,
        ) {
            Ok(_) => outcome.aborted += 1,
            Err(_e) => {
                eprintln!(
                    "hub_agent_run_server: crash-recovery could not abort an orphaned WorkItem (skipping)"
                );
                outcome.skipped += 1;
            }
        }
    }

    Ok(outcome)
}

/// The deterministic id PREFIX of a scheduled workflow run (`sched:<schedule_id>:<slot_ts>` —
/// see `crate::scheduler::scheduled_run_id`). Boot crash-recovery scopes its scheduled-run
/// reconcile to EXACTLY this prefix so it never touches a manually-dispatched workflow run
/// (which has no scheduler-tick owner and a different id shape).
const SCHEDULED_RUN_ID_PREFIX: &str = "sched:";

/// Reconcile orphaned SCHEDULED workflow runs at boot (registry gap #784(b) — the scheduler-tick
/// flip-precondition).
///
/// A scheduled workflow run is keyed by the deterministic id `sched:<schedule_id>:<slot_ts>` and
/// executes SYNCHRONOUSLY inside ONE scheduler tick (`scheduler_tick::run_one_tick_live` calls
/// `run_stored_published_workflow` inline; the run reaches `Done` / `Failed` / `AwaitingCheckpoint`
/// before that tick returns). So `Pending`/`Running` is NEVER a durable rest state for a scheduled
/// run — a scheduled run found in `Pending`/`Running` at boot is one the daemon was mid-tick on when
/// it DIED. Unlike a mission WorkItem (which `reconcile_orphaned_work_items` covers), an orphaned
/// scheduled run has NO reconciliation path today: the tick's receipt layer heals the FIRE RECEIPT
/// forward (`recovered_orphan_run`) but never the orphaned `workflow_run` row, so it stays
/// non-terminal forever. That PERMANENTLY WEDGES the schedule, because the tick's serialization guard
/// (`previous_fire_non_terminal`) reads the prior fire's run state and refuses to fire while it is
/// non-terminal — every future slot becomes `skipped_previous_awaiting`. This sweep closes that gap
/// by advancing each such orphan to the terminal `Failed` state via the LEGAL `set_run_state`
/// transition (`Pending -> Failed` / `Running -> Failed` are both valid core edges), so the next tick
/// is free to fire again. This is fail-STOPPED (a wedge stops firing — it never double-fires nor
/// loses data), so the reconcile is a robustness precondition, not a safety hole.
///
/// SCOPE (NO-DEGRADE):
/// * Only `Pending`/`Running` — `AwaitingCheckpoint` is a LEGITIMATE pause (a deny-all-approved
///   mutating step under the dark scheduler's deny-all policy), NOT a crash artifact, and is left
///   untouched. The read filter excludes it in SQL.
/// * Only the `sched:` id prefix — a manually-dispatched workflow run is never touched.
/// * UNCONDITIONAL on age (no staleness window). This sweep runs ONCE at boot, BEFORE the scheduler
///   tick thread is spawned (see `run_boot_crash_recovery` ordering), so THIS daemon owns NO live
///   tick yet — any `Pending`/`Running` `sched:` run that already exists in the DB is unambiguously a
///   DEAD orphan from a prior process, never a run a live tick is currently driving. A staleness
///   window would be WRONG here: the common crash is a FAST launchd restart (the `SQLITE_BUSY` /
///   `init_failed` crash-loop restarts in seconds), so a freshly-orphaned run (`updated_at` only
///   seconds old) is the NORMAL case and MUST be reconciled — skipping it on an age threshold would
///   re-wedge the schedule exactly when this fix is supposed to unwedge it. Prod is a SINGLE launchd
///   hub (a second concurrent hub against the same DB is a forbidden config), so there is no live
///   peer tick to protect from at boot; the single-instance scheduler lease + the boot-before-tick
///   ordering already cover the supported topology. (A genuine multi-daemon-safe reconcile would be a
///   separate lease-aware design, not this slice.)
///
/// FAIL-SAFE: a scan-level read error returns `Err` (the caller LOGS + SWALLOWS it — boot is never
/// blocked). A per-row transition failure (e.g. a racing terminal write) is logged + counted in
/// `skipped`; the sweep continues. IDEMPOTENT: a reconciled run is now `Failed` (terminal), so a
/// second sweep finds nothing.
pub fn reconcile_orphaned_scheduled_runs(
    db: &Db,
    now_ms: i64,
) -> Result<ReconcileOutcome, StorageError> {
    // Reconcile every in-flight `sched:` run that exists at boot — UNCONDITIONAL on age. The cutoff is
    // `now_ms` (not `now_ms - threshold`): no existing row can have a future `updated_at`, so this
    // catches a run orphaned even a fraction of a second ago (the fast-restart crash-loop case). At
    // boot this daemon owns no live tick, so a fresh `Pending`/`Running` run is a dead orphan, not a
    // live one to spare. (Reusing the bounded helper keeps the `Pending`/`Running`-only + `sched:`
    // filters in one tested SQL read.)
    let orphans = friday_storage::workflow::in_flight_runs_with_prefix_before(
        db.conn(),
        SCHEDULED_RUN_ID_PREFIX,
        now_ms,
    )?;
    let mut outcome = ReconcileOutcome {
        scanned: orphans.len(),
        ..ReconcileOutcome::default()
    };

    for (run_id, _state, _updated_at) in orphans {
        // Advance to the terminal `Failed` via the LEGAL core transition (`Pending`/`Running ->
        // Failed`). `set_run_state` re-reads the current state and validates the edge, so a row that
        // a racing tick just drove terminal (Done/Failed/Cancelled) is refused here and counted
        // `skipped` — never a double-write or an illegal hop.
        match friday_storage::workflow::set_run_state(
            db.conn(),
            &run_id,
            WorkflowRunState::Failed,
            now_ms,
        ) {
            Ok(()) => outcome.aborted += 1,
            Err(_e) => {
                // Category only — never the run id / row contents.
                eprintln!(
                    "hub_agent_run_server: crash-recovery could not abort an orphaned scheduled run (skipping)"
                );
                outcome.skipped += 1;
            }
        }
    }

    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_matcher_is_default_off_and_exact_one() {
        // Default-OFF: unset.
        assert!(!crash_recovery_enabled_from(None));
        // ON only for the exact trimmed "1".
        assert!(crash_recovery_enabled_from(Some("1")));
        assert!(crash_recovery_enabled_from(Some("  1  ")));
        // Everything else (including "true", "0", "yes", garbage) ⇒ OFF.
        for off in [
            "", " ", "0", "true", "TRUE", "yes", "on", "11", "1 0", "enabled",
        ] {
            assert!(
                !crash_recovery_enabled_from(Some(off)),
                "must be OFF for {off:?}"
            );
        }
    }

    #[test]
    fn orphan_classifier_is_only_dispatched_and_hub_accepted() {
        use WorkItemStatus::*;
        // The two genuine orphans.
        assert!(is_orphaned_in_flight(Dispatched));
        assert!(is_orphaned_in_flight(HubAccepted));
        // Every WAITING status is NOT an orphan — these must never be reconciled.
        for waiting in [
            Draft,
            PreflightBlocked,
            WaitingForUser,
            ReadyToDispatch,
            ProviderRouted,
            ProviderWaiting,
            FailedRetryable,
        ] {
            assert!(
                !is_orphaned_in_flight(waiting),
                "WAITING status must not be classified orphaned: {waiting:?}"
            );
        }
        // No terminal status is an orphan (also they never appear in the active scan).
        for terminal in [
            CompletedWithProof,
            FailedTerminal,
            Cancelled,
            Merged,
            Archived,
        ] {
            assert!(
                !is_orphaned_in_flight(terminal),
                "terminal status must not be classified orphaned: {terminal:?}"
            );
            assert!(terminal.is_terminal());
        }
    }

    #[test]
    fn every_orphan_has_a_legal_failed_terminal_transition() {
        // The reconcile relies on the PASS-1 hops `Dispatched->FailedTerminal` /
        // `HubAccepted->FailedTerminal` AND the PASS-2 hops `ReadyToDispatch->FailedTerminal` (the
        // mid-model-call crash state in the panel-fixed no-reorder design) /
        // `ProviderRouted->FailedTerminal` / `ProviderWaiting->FailedTerminal` being legal in the
        // core state machine; assert that contract so a future state-machine edit that breaks it
        // fails HERE (not silently at runtime, where it would be a logged skip).
        assert!(WorkItemStatus::Dispatched.can_transition_to(WorkItemStatus::FailedTerminal));
        assert!(WorkItemStatus::HubAccepted.can_transition_to(WorkItemStatus::FailedTerminal));
        assert!(WorkItemStatus::ReadyToDispatch.can_transition_to(WorkItemStatus::FailedTerminal));
        assert!(WorkItemStatus::ProviderRouted.can_transition_to(WorkItemStatus::FailedTerminal));
        assert!(WorkItemStatus::ProviderWaiting.can_transition_to(WorkItemStatus::FailedTerminal));
        // The happy-path dispatch edge is UNCHANGED (additive-only state-machine change).
        assert!(WorkItemStatus::ReadyToDispatch.can_transition_to(WorkItemStatus::Dispatched));
    }

    #[test]
    fn stale_executing_candidate_is_ready_to_dispatch_and_provider_states() {
        use WorkItemStatus::*;
        // PASS-2's candidate set: the mid-model-call crash state `ReadyToDispatch` (the panel-fixed
        // no-reorder during-call status) plus the two defensive provider in-flight states.
        assert!(is_stale_executing_candidate(ReadyToDispatch));
        assert!(is_stale_executing_candidate(ProviderRouted));
        assert!(is_stale_executing_candidate(ProviderWaiting));
        // The PASS-1 orphans are NOT PASS-2 candidates (they are caught unconditionally by PASS-1).
        assert!(!is_stale_executing_candidate(Dispatched));
        assert!(!is_stale_executing_candidate(HubAccepted));
        // No other waiting status, and no terminal status, is a PASS-2 candidate.
        for other in [
            Draft,
            PreflightBlocked,
            WaitingForUser,
            FailedRetryable,
            CompletedWithProof,
            FailedTerminal,
            Cancelled,
            Merged,
            Archived,
        ] {
            assert!(
                !is_stale_executing_candidate(other),
                "must not be a PASS-2 candidate: {other:?}"
            );
        }
        // The two classifiers are DISJOINT — a row is never both a PASS-1 orphan and a PASS-2
        // candidate (so the reconcile's if/else-if can never double-count).
        for s in [
            Dispatched,
            HubAccepted,
            ReadyToDispatch,
            ProviderRouted,
            ProviderWaiting,
            Draft,
            WaitingForUser,
        ] {
            assert!(
                !(is_orphaned_in_flight(s) && is_stale_executing_candidate(s)),
                "classifiers must be disjoint for {s:?}"
            );
        }
    }
}
