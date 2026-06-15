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
//!   * `ProviderRouted` is where a run that PAUSED for operator approval sits — the signed-mutation
//!     resume path (`resume_agent_loop_for_mission`, #755) drives `ProviderRouted -> ProviderWaiting
//!     -> CompletedWithProof`. WAITING, never reconcile.
//!   * `ProviderWaiting` is where a run actively waits on the provider; it has NO operator-approval
//!     row by design (approval-presence is therefore the WRONG discriminator). There is no durable
//!     run-level "actively executing" flag (`agent_run.state` is the PlanState planning machine, not
//!     an execution marker), so a crash-orphaned `ProviderWaiting` CANNOT be told apart from a
//!     legitimately-waiting one — reconciling it risks aborting a live run = a degrade. WAITING,
//!     never reconcile. (Crash-orphaned `ProviderRouted`/`ProviderWaiting` rows are an EXPLICIT
//!     deferred limitation: no-degrade beats completeness, and catching them needs a durable
//!     run-execution state this codebase does not yet carry.)
//!   * `WaitingForUser` is awaiting the user (the awaiting-clarification flow); `Draft` /
//!     `PreflightBlocked` are owned by preflight; `ReadyToDispatch` by dispatch; `FailedRetryable`
//!     by the retry path. None is an in-flight hub hop and each has its own owner. WAITING.
//!   * the five terminal statuses are never in the scan set (`list_active_work_items` excludes
//!     them) and are never touched.
//!
//! ## No-degrade posture
//!   * **Flag-OFF is byte-identical.** [`crash_recovery_enabled_from`] is the pure matcher; the
//!     server reads `FRIDAY_CRASH_RECOVERY` ONCE at boot and, when OFF (default / anything but the
//!     exact trimmed `"1"`), NEVER calls [`reconcile_orphaned_work_items`] — no scan, no write.
//!   * **Best-effort + fail-safe.** Reconciliation runs BEFORE the server accepts connections, but
//!     a reconcile error is LOGGED (category only) and SWALLOWED — it MUST NEVER block boot (the
//!     server coming up is load-bearing; this is cleanup). A per-row transition failure is logged
//!     and skipped; one bad row never aborts the sweep.
//!   * **Only advances DEAD rows.** Only `Dispatched` / `HubAccepted` are touched; every other row
//!     (waiting + terminal) is left byte-for-byte unchanged.
//!   * **Idempotent.** After the first sweep the orphans are `FailedTerminal` ⇒ excluded from the
//!     scan ⇒ a second boot finds nothing (a no-op).
//!
//! DARK: gated default-OFF; deploying the binary changes NO live behavior until the operator flips
//! `FRIDAY_CRASH_RECOVERY=1`.

use friday_core::WorkItemStatus;
use friday_storage::{Db, StorageError};

/// The env flag that gates boot-time crash-recovery reconciliation. DEFAULT-OFF.
pub const FRIDAY_CRASH_RECOVERY: &str = "FRIDAY_CRASH_RECOVERY";

/// The actor recorded on the lifecycle audit row for a crash-recovery abort.
const CRASH_RECOVERY_ACTOR: &str = "crash-recovery";

/// The marker written as BOTH the transition `reason` (⇒ the lifecycle audit action) and the
/// row's `blocking_reason`, so the abort is queryable from either the audit chain or the row.
pub const CRASH_RECOVERY_MARKER: &str = "crash_recovery_abort";

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
        if !is_orphaned_in_flight(item.status) {
            // Waiting (or otherwise not-orphaned) — leave it byte-for-byte unchanged.
            continue;
        }

        // (1) Stamp the row-level `blocking_reason` marker WITHOUT changing status, so it survives
        //     `transition_work_item_status`'s fresh re-read of the row. A status-preserving upsert
        //     is legal (no state-machine hop). On failure, skip this row (do NOT proceed to the
        //     terminal transition with an unmarked row).
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
        //     is queryable from the audit chain too. A failed transition (e.g. a racing terminal
        //     write) is logged + skipped; the sweep continues.
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
        // The reconcile relies on `Dispatched->FailedTerminal` and `HubAccepted->FailedTerminal`
        // being legal hops in the core state machine; assert that contract so a future state-machine
        // edit that breaks it fails HERE (not silently at runtime, where it would be a logged skip).
        assert!(WorkItemStatus::Dispatched.can_transition_to(WorkItemStatus::FailedTerminal));
        assert!(WorkItemStatus::HubAccepted.can_transition_to(WorkItemStatus::FailedTerminal));
    }
}
