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
//!   * `ProviderRouted`/`ProviderWaiting` are the COMMON mid-call crash states (#24b). A run that
//!     PAUSED for operator approval sits at `ProviderRouted` (the signed-mutation resume path
//!     `resume_agent_loop_for_mission`, #755, drives it to completion); a run actively waiting on
//!     the provider sits at `ProviderWaiting` (it has NO operator-approval row by design, so
//!     approval-presence is the WRONG discriminator). #767 left BOTH untouched because, with no
//!     durable run-execution marker, a crash-orphaned one could not be told apart from a
//!     legitimately-waiting one — reconciling blindly would abort a live run (a degrade).
//!
//!     **PASS-2 (#24b) closes that exact gap with a DURABLE execution marker.** The agent loop now
//!     SETs `work_item.executing = 1` + `last_heartbeat_ms = now` JUST BEFORE each model call and
//!     CLEARs `executing = 0` at EVERY loop exit. PASS-2 reconciles a `ProviderRouted`/
//!     `ProviderWaiting` row ONLY when it is `executing == 1` AND `last_heartbeat_ms` is STALE
//!     (older than [`EXECUTION_STATE_STALE_THRESHOLD_MS`] = 5 min, which strictly exceeds the
//!     longest legit single model call) — i.e. the process that set the marker DIED mid-call. A
//!     row with `executing == 0` (legit-paused/awaiting/finished), or a FRESH heartbeat (a
//!     slow-but-LIVE call), is NEVER touched. Both `ProviderRouted -> FailedTerminal` and
//!     `ProviderWaiting -> FailedTerminal` are legal hops, so PASS-2 uses the SAME legal
//!     `transition_work_item_status` primitive + `crash_recovery_abort` marker as PASS-1.
//!   * `WaitingForUser` is awaiting the user (the awaiting-clarification flow); `Draft` /
//!     `PreflightBlocked` are owned by preflight; `ReadyToDispatch` by dispatch; `FailedRetryable`
//!     by the retry path. None is an in-flight hub hop and each has its own owner. WAITING.
//!   * the five terminal statuses are never in the scan set (`list_active_work_items` excludes
//!     them) and are never touched.
//!
//! ## No-degrade posture
//!   * **Flag-OFF ⇒ no PASS-2 reconcile (no scan, no write).** [`crash_recovery_enabled_from`] is
//!     the pure matcher; the server reads `FRIDAY_CRASH_RECOVERY` ONCE at boot and, when OFF
//!     (default / anything but the exact trimmed `"1"`), NEVER calls
//!     [`reconcile_orphaned_work_items`]. NOTE — the two #24b loop-side changes are FLAG-INDEPENDENT
//!     (they run on every mission-bound run, flag on or off): (1) the work_item reaches
//!     `ProviderRouted` BEFORE the model call (pre-#24b it reached it AFTER), and (2) the
//!     `executing`/`last_heartbeat_ms` columns are written. So flag-OFF is BYTE-IDENTICAL for
//!     NON-mission runs, and END-STATE- + AUDIT-IDENTICAL for mission-bound runs (only the timing of
//!     the ProviderRouted hop moves + two columns no read path consults are written) — proven by the
//!     full mission_runtime/runtime/resume/surface-event suites staying green. This is a deliberate,
//!     no-degrade reorder, NOT dark-until-flipped: deploying the binary moves the mission-bound
//!     dispatch timing regardless of the flag; only the boot reconcile is gated.
//!   * **Best-effort + fail-safe.** Reconciliation runs BEFORE the server accepts connections, but
//!     a reconcile error is LOGGED (category only) and SWALLOWED — it MUST NEVER block boot (the
//!     server coming up is load-bearing; this is cleanup). A per-row transition failure is logged
//!     and skipped; one bad row never aborts the sweep.
//!   * **Only advances DEAD rows.** PASS-1 touches only `Dispatched` / `HubAccepted`; PASS-2 touches
//!     a `ProviderRouted` / `ProviderWaiting` row ONLY when it is `executing == 1` with a STALE
//!     heartbeat. Every other row — a paused/awaiting `executing == 0` provider row, a fresh-heartbeat
//!     LIVE row, every other waiting status, and every terminal row — is left byte-for-byte unchanged.
//!   * **Idempotent.** After the first sweep the orphans are `FailedTerminal` ⇒ excluded from the
//!     scan ⇒ a second boot finds nothing (a no-op).
//!
//! ## Residual limitations (named honestly, like #767 named its deferral — NOT fixed here)
//!   * **The pre-dispatch→first-SET window.** Between the pre-dispatch binding (`ProviderRouted`,
//!     `executing == 0`) and the loop's first heartbeat SET, a crash leaves
//!     `ProviderRouted + executing == 0` — indistinguishable from a legit pause, so unreconciled.
//!     The window is narrow (no model call happens in it), but it is the SAME orphan class #767
//!     deferred. Setting `executing = 1` inside the pre-dispatch binding would close it.
//!   * **The codex mission-bound path.** Codex runs bypass `run_loop_with_policy` (the special-cased
//!     gated-turn path), so they NEVER write the heartbeat — a codex mission-bound run crashing
//!     mid-turn leaves `ProviderRouted + executing == 0`, also unreconciled. Dark today (codex
//!     unavailable in the autonomous baseline); named for when it is wired.
//!
//! GATING: the boot PASS-1+PASS-2 reconcile is default-OFF (`FRIDAY_CRASH_RECOVERY`). The loop-side
//! marker writes + the pre-dispatch reorder are flag-INDEPENDENT (see the no-degrade posture above).

use friday_core::WorkItemStatus;
use friday_storage::{Db, StorageError};

/// The env flag that gates boot-time crash-recovery reconciliation. DEFAULT-OFF.
pub const FRIDAY_CRASH_RECOVERY: &str = "FRIDAY_CRASH_RECOVERY";

/// The actor recorded on the lifecycle audit row for a crash-recovery abort.
const CRASH_RECOVERY_ACTOR: &str = "crash-recovery";

/// The marker written as BOTH the transition `reason` (⇒ the lifecycle audit action) and the
/// row's `blocking_reason`, so the abort is queryable from either the audit chain or the row.
pub const CRASH_RECOVERY_MARKER: &str = "crash_recovery_abort";

/// (#24b) How stale a durable `executing` heartbeat must be before boot crash-recovery PASS-2
/// treats a `ProviderRouted`/`ProviderWaiting` row as CRASHED-while-executing (vs a slow-but-LIVE
/// model call). 5 MINUTES — chosen to strictly EXCEED the longest legitimate single model call
/// this codebase can make, so a slow-but-live turn is NEVER reconciled:
///   * The agent loop makes ONE `next_step_metered` call per turn, plus up to
///     `RUN_LOOP_MAX_PROVIDER_ATTEMPTS - 1` (= 2) bounded transient-route RETRIES of that SAME
///     call (lib.rs) — at most 3 provider attempts per turn. The heartbeat is RE-SET at the top of
///     EVERY turn (just before the call), so the staleness is measured against ONE turn's model
///     call (+ its retries), not the whole multi-turn run.
///   * The DeepSeek/Claude HTTP transport (ureq) has no multi-minute per-call ceiling, but real
///     completions return in seconds to low-minutes even for long generations; 3 attempts of a
///     slow call stay comfortably under 5 min. For scale: the WS server's per-read timeout is 30s
///     (`READ_TIMEOUT`) and the session reaper interval is 120s — 300s exceeds both by a wide margin.
///
/// So a heartbeat older than 5 min reliably means the process that SET it is DEAD (it never reached
/// the loop's tail clear), not that a live call is still running. Tightening this risks reconciling
/// a slow-but-live run (a degrade); loosening it only delays cleanup of a genuinely-dead row (safe).
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
/// `executing` with a STALE heartbeat — the `ProviderRouted`/`ProviderWaiting` rows #767's PASS-1
/// classifier ([`is_orphaned_in_flight`]) deliberately left untouched because, WITHOUT a durable
/// execution marker, a crash-orphaned one could not be told apart from a legitimately-waiting one.
/// The durable `executing` marker (set by the agent loop just before each model call, cleared at
/// every loop exit) now makes that distinction safe: a row that is `executing == 1` with a
/// heartbeat older than [`EXECUTION_STATE_STALE_THRESHOLD_MS`] is a process that DIED mid-call. A
/// row with `executing == 0` (paused/awaiting/finished) is NEVER in this set's action path.
pub fn is_stale_executing_candidate(status: WorkItemStatus) -> bool {
    matches!(
        status,
        WorkItemStatus::ProviderRouted | WorkItemStatus::ProviderWaiting
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
            // PASS-2 (#24b): a `ProviderRouted`/`ProviderWaiting` row is reconciled ONLY when it is
            // durably `executing == 1` AND its heartbeat is STALE (older than the threshold) — i.e.
            // the process that set the marker DIED mid-model-call. A row with `executing == 0`
            // (legit-paused/awaiting), or one with a FRESH heartbeat (a slow-but-LIVE model call),
            // is NEVER touched. A read error on the execution-state column is FAIL-SAFE: treat the
            // row as NOT a crash candidate (leave it untouched) rather than risk aborting a live run.
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
            // unchanged. Includes a `ProviderRouted`/`ProviderWaiting` row with `executing == 0`
            // (paused/awaiting) or a fresh heartbeat (live).
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
        // `HubAccepted->FailedTerminal` AND the PASS-2 hops `ProviderRouted->FailedTerminal` /
        // `ProviderWaiting->FailedTerminal` being legal in the core state machine; assert that
        // contract so a future state-machine edit that breaks it fails HERE (not silently at
        // runtime, where it would be a logged skip).
        assert!(WorkItemStatus::Dispatched.can_transition_to(WorkItemStatus::FailedTerminal));
        assert!(WorkItemStatus::HubAccepted.can_transition_to(WorkItemStatus::FailedTerminal));
        assert!(WorkItemStatus::ProviderRouted.can_transition_to(WorkItemStatus::FailedTerminal));
        assert!(WorkItemStatus::ProviderWaiting.can_transition_to(WorkItemStatus::FailedTerminal));
    }

    #[test]
    fn stale_executing_candidate_is_only_provider_routed_and_waiting() {
        use WorkItemStatus::*;
        // PASS-2's candidate set: exactly the two provider in-flight states #767 deferred.
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
            ReadyToDispatch,
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
