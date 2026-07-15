//! Rust-owned RETENTION sweep for the unbounded ARTIFACT tables (registry gap #25, DARK).
//!
//! The session-lifecycle [`crate::session_lifecycle::sweep_lifecycle`] reaper prunes ONLY
//! `agent_session` (+ its child messages). The other artifact tables — `token_ledger`,
//! `surface_event`, `provider_session_event`, stale provider/process observation rows, terminal
//! mission-spine child rows, terminal `mission`/`work_item`, and rejected/expired memory
//! CANDIDATES — grow UNBOUNDED (memory-extraction + surface_event/provider session observation
//! rows are written per-run). This module adds an
//! age-AND-state-bounded sweep for them, driven from the EXISTING reaper tick behind its OWN
//! default-off flag (`FRIDAY_RETENTION_SWEEP`) so deploying the new binary deletes NOTHING until
//! the operator explicitly flips it. The flag read lives in the hub bin; this module is a pure
//! storage primitive (no env read here).
//!
//! ## Operator-approved default windows (the named constants below)
//!   * `token_ledger`  — 90d  (billing/observability history; keyed on `created_at`).
//!   * `run_result` — 365d (final answer body store; keyed on `created_at`).
//!   * `surface_event` — 90d  (timeline observability; keyed on `created_at_ms`).
//!   * `provider_session_event` — 90d (provider app-server observation firehose; keyed on
//!     `observed_at`).
//!   * `provider_session_link` — 90d after last provider sighting, once its events/leases are
//!     gone (keyed on `last_provider_seen_at`).
//!   * `process_observation` — 90d (process observation firehose; keyed on `observed_at_ms`).
//!   * terminal `agent_run` + `agent_run_event` — 365d (keyed on `agent_run.updated_at`
//!     and `agent_run_event.created_at`; only hard-terminal states).
//!   * terminal `mission` / `work_item` — 365d (keyed on `updated_at_ms`).
//!   * terminal mission-spine child rows — 365d, only when attached to terminal+aged parents.
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
//!      Likewise, an `agent_run` live hold such as `awaiting_clarification` is never
//!      retention-terminal; run lifecycle rows match only hard-terminal labels (`finished`,
//!      `mutation_completed`, `errored`, `bounded`, `blocked`, `interrupted`, `cancelled`).
//!   2. **FK-safe parent deletes (no orphans, no FK crash).** `mission` and `work_item` are
//!      RESTRICT-referenced (no `ON DELETE CASCADE`) by child tables and `foreign_keys` is ON on
//!      every connection. `mission` is referenced by `work_item`, `surface_event`,
//!      `surface_thread`, `mission_link`, `route_decision`, `route_decision_control`,
//!      `workspace_claim`, `process_lease`; `work_item` is referenced by `surface_event`,
//!      `mission_link`, `route_decision`, `route_decision_control`, `workspace_claim`,
//!      `process_lease`. (`process_observation` reaches them only TRANSITIVELY via
//!      `workspace_claim`, so it is not a direct guard; and the v1 `mission_link` was rebuilt
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
use rusqlite::Transaction;

// ─── DATA-RETENTION-001 policy primitive (default-permanent + fail-closed) ───
//
// This module MIRRORS the TS retention policy landed in PR #1608
// (`src/jobs/retention/friday-retention.types.ts` + `resolveCutoff`) INTO the Rust sweep.
// DATA-RETENTION-001 / U9-DATA-RETENTION: local user data is PERMANENT by default until the user
// explicitly deletes it; automatic time-based cleanup is DEFAULT-OFF and opt-in per category; any
// invalid/missing/corrupt config FAILS CLOSED (delete nothing). Every CONTENT category below is
// therefore a discriminated policy that DEFAULTS to `Permanent`; `AfterDays(n>0)` is the ONLY way
// to enable a time-based sweep, and [`resolve_cutoff`] is the single fail-closed gate every DELETE
// consults. A magic sentinel (e.g. an "infinite" numeric window) is deliberately NOT used — "off"
// is a clean, structurally-distinct `Permanent` variant, so a corrupt/unknown config can never be
// misread as "delete after N days".

/// One CONTENT category's retention policy. `Permanent` (the default) means "never auto-delete".
/// `AfterDays(n)` enables a time-based sweep that deletes rows older than `n` days — but ONLY when
/// `n` is a positive integer whose cutoff is in range; anything else fails closed via
/// [`resolve_cutoff`]. Mirrors the TS `CategoryRetention` union (`{mode:"permanent"} |
/// {mode:"after_days",days:n}`) from PR #1608.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CategoryRetention {
    /// Retain forever (DATA-RETENTION-001 default). The sweep skips this category entirely.
    Permanent,
    /// Opt-in: delete rows older than `days` days. A non-positive or overflowing `days` fails
    /// closed (see [`resolve_cutoff`]) — it is NEVER treated as "delete everything".
    AfterDays(i64),
}

impl CategoryRetention {
    /// FAIL-CLOSED constructor from a serialized `(mode, days)` pair — the Rust mirror of the TS
    /// `resolveCutoff` input validation (#1608). This is the boundary where an untrusted/persisted
    /// config (env / JSON / DB) becomes a typed policy. ANY unrecognized/empty mode, or
    /// `after_days` with a missing / zero / negative `days`, yields `Permanent` (delete nothing).
    /// Only a well-formed `("after_days", Some(n>0))` enables a sweep.
    pub fn from_config(mode: &str, days: Option<i64>) -> CategoryRetention {
        match mode {
            "after_days" => match days {
                Some(d) if d > 0 => CategoryRetention::AfterDays(d),
                // missing / zero / negative days ⇒ fail closed.
                _ => CategoryRetention::Permanent,
            },
            "permanent" => CategoryRetention::Permanent,
            // unknown / corrupt / empty mode ⇒ fail closed.
            _ => CategoryRetention::Permanent,
        }
    }
}

/// One day in milliseconds. The sweep keys on epoch-ms timestamps.
pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// FAIL-CLOSED cutoff evaluator — the single gate every per-category DELETE consults. Returns
/// `Some(cutoff_ms)` ONLY for an explicitly-enabled, well-formed `AfterDays(n>0)` whose cutoff is
/// representable; `Permanent` and ANY invalid input (n ≤ 0, or a multiply/subtract that overflows
/// `i64`) return `None`, which the caller treats as "skip this category (delete 0)". NEVER panics.
/// This is the Rust mirror of the TS `resolveCutoff` (#1608): invalid ⇒ permanent ⇒ delete nothing.
pub fn resolve_cutoff(now_ms: i64, policy: CategoryRetention) -> Option<i64> {
    match policy {
        CategoryRetention::Permanent => None,
        CategoryRetention::AfterDays(days) => {
            if days <= 0 {
                return None; // zero / negative ⇒ fail closed
            }
            // Compute in i128 then range-check back to i64 so an overflowing window fails closed
            // (returns None) instead of wrapping into a bogus (possibly future) cutoff.
            let age_ms = (days as i128).checked_mul(DAY_MS as i128)?;
            let cutoff = (now_ms as i128).checked_sub(age_ms)?;
            if cutoff < i64::MIN as i128 || cutoff > i64::MAX as i128 {
                return None; // out-of-range ⇒ fail closed
            }
            Some(cutoff as i64)
        }
    }
}

// ─── Operator-approved OPT-IN retention windows (day counts) ───
//
// These are NOT the default (the default is `Permanent`); they are the values an operator would set
// if they DELIBERATELY enable per-category time-based cleanup (surfaced via
// [`RetentionWindows::operator_windows`]). The `*_MAX_AGE_MS` constants are derived from the day
// counts so existing age-boundary tests keep a single source of truth.

/// `token_ledger`: opt-in window is 90 days (keyed on `created_at`).
pub const TOKEN_LEDGER_MAX_AGE_DAYS: i64 = 90;
/// `run_result`: opt-in window is 365 days (keyed on `created_at`).
pub const RUN_RESULT_MAX_AGE_DAYS: i64 = 365;
/// `surface_event`: opt-in window is 90 days (keyed on `created_at_ms`).
pub const SURFACE_EVENT_MAX_AGE_DAYS: i64 = 90;
/// `provider_session_event`: opt-in window is 90 days (keyed on `observed_at`).
pub const PROVIDER_SESSION_EVENT_MAX_AGE_DAYS: i64 = 90;
/// Terminal `agent_run`: opt-in window is 365 days.
pub const AGENT_RUN_MAX_AGE_DAYS: i64 = 365;
/// Terminal `mission`: opt-in window is 365 days (keyed on `updated_at_ms`).
pub const MISSION_MAX_AGE_DAYS: i64 = 365;
/// Terminal `work_item`: opt-in window is 365 days (keyed on `updated_at_ms`).
pub const WORK_ITEM_MAX_AGE_DAYS: i64 = 365;
/// Rejected/expired memory CANDIDATES: opt-in window is 30 days. CONFIRMED memory is NEVER pruned.
pub const MEMORY_CANDIDATE_MAX_AGE_DAYS: i64 = 30;

/// `token_ledger` opt-in window in ms (keyed on `created_at`).
pub const TOKEN_LEDGER_MAX_AGE_MS: i64 = TOKEN_LEDGER_MAX_AGE_DAYS * DAY_MS;
/// `run_result` opt-in window in ms (keyed on `created_at`).
pub const RUN_RESULT_MAX_AGE_MS: i64 = RUN_RESULT_MAX_AGE_DAYS * DAY_MS;
/// `surface_event` opt-in window in ms (keyed on `created_at_ms`).
pub const SURFACE_EVENT_MAX_AGE_MS: i64 = SURFACE_EVENT_MAX_AGE_DAYS * DAY_MS;
/// `provider_session_event` opt-in window in ms (keyed on `observed_at`).
pub const PROVIDER_SESSION_EVENT_MAX_AGE_MS: i64 = PROVIDER_SESSION_EVENT_MAX_AGE_DAYS * DAY_MS;
/// Terminal `agent_run` opt-in window in ms.
pub const AGENT_RUN_MAX_AGE_MS: i64 = AGENT_RUN_MAX_AGE_DAYS * DAY_MS;
/// Terminal `mission` opt-in window in ms (keyed on `updated_at_ms`).
pub const MISSION_MAX_AGE_MS: i64 = MISSION_MAX_AGE_DAYS * DAY_MS;
/// Terminal `work_item` opt-in window in ms (keyed on `updated_at_ms`).
pub const WORK_ITEM_MAX_AGE_MS: i64 = WORK_ITEM_MAX_AGE_DAYS * DAY_MS;
/// Rejected/expired memory CANDIDATE opt-in window in ms (keyed on `created_at`).
pub const MEMORY_CANDIDATE_MAX_AGE_MS: i64 = MEMORY_CANDIDATE_MAX_AGE_DAYS * DAY_MS;

/// Default max rows deleted per table per sweep (bounds the per-tick work / lock time). At the
/// 120s reaper cadence this drains a large backlog over successive ticks without ever holding a
/// long write lock.
pub const DEFAULT_BATCH_LIMIT: i64 = 5_000;

/// The per-category retention POLICIES + batch cap, passed to [`sweep_retention`]. Each content
/// category is a [`CategoryRetention`] that DEFAULTS to `Permanent` (DATA-RETENTION-001): the
/// runtime default deletes NOTHING. [`RetentionWindows::operator_windows`] gives the explicit
/// opt-in after-days windows. Exposed as named fields so a category can be enabled individually
/// (e.g. in a test) without touching the sweep logic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetentionWindows {
    pub token_ledger: CategoryRetention,
    pub run_result: CategoryRetention,
    pub surface_event: CategoryRetention,
    pub provider_session_event: CategoryRetention,
    pub agent_run: CategoryRetention,
    pub mission: CategoryRetention,
    pub work_item: CategoryRetention,
    pub memory_candidate: CategoryRetention,
    /// Max rows deleted per table per sweep (`> 0`; a non-positive value disables that table's
    /// delete, since the `LIMIT` would select nothing).
    pub batch_limit: i64,
}

impl Default for RetentionWindows {
    /// DATA-RETENTION-001: every user-data CONTENT category defaults to `Permanent` (never
    /// auto-delete). This is what the runtime reaper uses, so deploying/enabling the sweep flag
    /// deletes NOTHING until a category is explicitly opted in.
    fn default() -> Self {
        RetentionWindows {
            token_ledger: CategoryRetention::Permanent,
            run_result: CategoryRetention::Permanent,
            surface_event: CategoryRetention::Permanent,
            provider_session_event: CategoryRetention::Permanent,
            agent_run: CategoryRetention::Permanent,
            mission: CategoryRetention::Permanent,
            work_item: CategoryRetention::Permanent,
            memory_candidate: CategoryRetention::Permanent,
            batch_limit: DEFAULT_BATCH_LIMIT,
        }
    }
}

impl RetentionWindows {
    /// The operator-approved OPT-IN windows: every content category set to its `AfterDays(n)`
    /// value. This is NOT a default — it is what an operator would choose if they DELIBERATELY
    /// enable per-category time-based cleanup. It is never wired as the runtime default (the
    /// runtime default is [`RetentionWindows::default`] = all-`Permanent`); it exists so the
    /// deletion mechanism can be exercised (tests, or a future operator-supplied policy).
    pub fn operator_windows() -> Self {
        RetentionWindows {
            token_ledger: CategoryRetention::AfterDays(TOKEN_LEDGER_MAX_AGE_DAYS),
            run_result: CategoryRetention::AfterDays(RUN_RESULT_MAX_AGE_DAYS),
            surface_event: CategoryRetention::AfterDays(SURFACE_EVENT_MAX_AGE_DAYS),
            provider_session_event: CategoryRetention::AfterDays(
                PROVIDER_SESSION_EVENT_MAX_AGE_DAYS,
            ),
            agent_run: CategoryRetention::AfterDays(AGENT_RUN_MAX_AGE_DAYS),
            mission: CategoryRetention::AfterDays(MISSION_MAX_AGE_DAYS),
            work_item: CategoryRetention::AfterDays(WORK_ITEM_MAX_AGE_DAYS),
            memory_candidate: CategoryRetention::AfterDays(MEMORY_CANDIDATE_MAX_AGE_DAYS),
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
    pub run_result_deleted: usize,
    pub agent_run_event_deleted: usize,
    pub agent_run_deleted: usize,
    pub surface_event_deleted: usize,
    pub provider_session_event_deleted: usize,
    pub provider_session_link_deleted: usize,
    pub process_observation_deleted: usize,
    pub route_decision_control_deleted: usize,
    pub route_decision_deleted: usize,
    pub mission_link_deleted: usize,
    pub mission_body_snapshot_deleted: usize,
    pub process_lease_deleted: usize,
    pub workspace_claim_deleted: usize,
    pub surface_thread_deleted: usize,
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
            && self.run_result_deleted == 0
            && self.agent_run_event_deleted == 0
            && self.agent_run_deleted == 0
            && self.surface_event_deleted == 0
            && self.provider_session_event_deleted == 0
            && self.provider_session_link_deleted == 0
            && self.process_observation_deleted == 0
            && self.route_decision_control_deleted == 0
            && self.route_decision_deleted == 0
            && self.mission_link_deleted == 0
            && self.mission_body_snapshot_deleted == 0
            && self.process_lease_deleted == 0
            && self.workspace_claim_deleted == 0
            && self.surface_thread_deleted == 0
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

    // Resolve every content category to a FAIL-CLOSED cutoff. `None` = `Permanent` OR an invalid
    // config ⇒ that category's DELETE is SKIPPED entirely (deletes 0). Under the DEFAULT policy
    // every category resolves to `None`, so the whole sweep is a no-op regardless of how far
    // `now_ms` is advanced — the DATA-RETENTION-001 default-permanent guarantee (constraint #3).
    let token_cutoff = resolve_cutoff(now_ms, windows.token_ledger);
    let run_result_cutoff = resolve_cutoff(now_ms, windows.run_result);
    let agent_run_cutoff = resolve_cutoff(now_ms, windows.agent_run);
    let surface_cutoff = resolve_cutoff(now_ms, windows.surface_event);
    let provider_session_cutoff = resolve_cutoff(now_ms, windows.provider_session_event);
    let memory_cutoff = resolve_cutoff(now_ms, windows.memory_candidate);
    let mission_cutoff = resolve_cutoff(now_ms, windows.mission);
    let work_item_cutoff = resolve_cutoff(now_ms, windows.work_item);

    // 1. token_ledger — pure age on created_at. Leaf w.r.t. these FKs (nothing references it).
    if let Some(token_cutoff) = token_cutoff {
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
    }

    // 2. run_result — pure age on created_at. Leaf w.r.t. hard FKs (audit_ref/run_id are soft
    //    refs), and rows exist only for terminal run outcomes, so no state guard is needed.
    if let Some(run_result_cutoff) = run_result_cutoff {
        match delete_bounded(
            conn,
            "DELETE FROM run_result
          WHERE rowid IN (
              SELECT rowid FROM run_result WHERE created_at < ?1
               ORDER BY created_at LIMIT ?2
          )",
            run_result_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.run_result_deleted = n,
            Err(_e) => out.table_errors += 1,
        }
    }

    // 3. agent_run_event — old events for hard-terminal+aged runs, before deleting the run row.
    //    Events for a live hold (`awaiting_clarification`), approval states, or recent terminal
    //    runs stay intact. Orphaned old events are safe to remove because no parent can need them
    //    for a coherent run projection.
    if let Some(agent_run_cutoff) = agent_run_cutoff {
        match delete_bounded(
            conn,
            "DELETE FROM agent_run_event
          WHERE rowid IN (
              SELECT e.rowid FROM agent_run_event e
               WHERE e.created_at < ?1
                 AND (
                     NOT EXISTS (SELECT 1 FROM agent_run ar WHERE ar.run_id = e.run_id)
                     OR EXISTS (
                         SELECT 1 FROM agent_run ar
                          WHERE ar.run_id = e.run_id
                            AND ar.state IN
                                ('finished','mutation_completed','errored','bounded',
                                 'blocked','interrupted','cancelled')
                            AND ar.updated_at < ?1
                     )
                 )
               ORDER BY e.created_at LIMIT ?2
          )",
            agent_run_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.agent_run_event_deleted = n,
            Err(_e) => out.table_errors += 1,
        }

        // 4. agent_run — parent row last, after event rows and any still-retained run_result gone.
        match delete_bounded(
            conn,
            "DELETE FROM agent_run
          WHERE rowid IN (
              SELECT ar.rowid FROM agent_run ar
               WHERE ar.state IN
                     ('finished','mutation_completed','errored','bounded',
                      'blocked','interrupted','cancelled')
                 AND ar.updated_at < ?1
                 AND NOT EXISTS (SELECT 1 FROM agent_run_event e WHERE e.run_id = ar.run_id)
                 AND NOT EXISTS (SELECT 1 FROM run_result r WHERE r.run_id = ar.run_id)
               ORDER BY ar.updated_at LIMIT ?2
          )",
            agent_run_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.agent_run_deleted = n,
            Err(_e) => out.table_errors += 1,
        }
    }

    // 5. surface_event — pure age on created_at_ms. Leaf (no table references surface_event).
    //    Deleted BEFORE work_item/mission so this tick can also free those parents.
    if let Some(surface_cutoff) = surface_cutoff {
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
    }

    // 6. provider_session_event + process_observation — the two firehose leaves, both keyed on the
    //    provider_session category window. This is the provider app-server observation firehose
    //    (metadata/delta receipts), not the token ledger; a leaf w.r.t. Friday's core mission/
    //    work_item FKs, so a bounded age sweep cannot orphan mission state.
    if let Some(provider_session_cutoff) = provider_session_cutoff {
        match delete_bounded(
            conn,
            "DELETE FROM provider_session_event
          WHERE rowid IN (
              SELECT rowid FROM provider_session_event WHERE observed_at < ?1
               ORDER BY observed_at LIMIT ?2
          )",
            provider_session_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.provider_session_event_deleted = n,
            Err(_e) => out.table_errors += 1,
        }

        // process_observation — process-discovery firehose, pure age on observed_at_ms. Deleted
        // before workspace_claim so old matched observations do not pin old released claims.
        match delete_bounded(
            conn,
            "DELETE FROM process_observation
          WHERE rowid IN (
              SELECT rowid FROM process_observation WHERE observed_at_ms < ?1
               ORDER BY observed_at_ms LIMIT ?2
          )",
            provider_session_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.process_observation_deleted = n,
            Err(_e) => out.table_errors += 1,
        }
    }

    // Blocks 6–11: mission/work_item route-trace + child rows. ALL require BOTH the mission AND
    // work_item categories to be explicitly enabled (fail-closed): a permanent/invalid PARENT
    // category ⇒ its trace/child debris is retained too. Under the default policy both resolve to
    // None ⇒ the whole group is skipped.
    if let (Some(mission_cutoff), Some(work_item_cutoff)) = (mission_cutoff, work_item_cutoff) {
        let route_trace_cutoff = work_item_cutoff.min(mission_cutoff);
        // 6. route_decision_control — terminal route trace child rows only. The join back to the
        //    matching route_decision prevents a mismatched but FK-valid control row from being treated
        //    as terminal trace debris for an unrelated parent.
        match delete_bounded4(
            conn,
            "DELETE FROM route_decision_control
          WHERE rowid IN (
              SELECT c.rowid
                FROM route_decision_control c
                JOIN route_decision r
                  ON r.decision_id = c.decision_id
                 AND r.mission_id = c.mission_id
                 AND r.work_item_id = c.work_item_id
                JOIN mission m ON m.mission_id = c.mission_id
                JOIN work_item w ON w.work_item_id = c.work_item_id
               WHERE c.created_at_ms < ?1
                 AND m.status IN ('done','archived','merged')
                 AND m.updated_at_ms < ?2
                 AND w.status IN
                     ('completed_with_proof','failed_terminal','cancelled','merged','archived')
                 AND w.updated_at_ms < ?3
               ORDER BY c.created_at_ms LIMIT ?4
          )",
            route_trace_cutoff,
            mission_cutoff,
            work_item_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.route_decision_control_deleted = n,
            Err(_e) => out.table_errors += 1,
        }

        // 7. route_decision — terminal route trace rows after their controls are gone.
        match delete_bounded4(
            conn,
            "DELETE FROM route_decision
          WHERE rowid IN (
              SELECT r.rowid
                FROM route_decision r
                JOIN mission m ON m.mission_id = r.mission_id
                JOIN work_item w ON w.work_item_id = r.work_item_id
               WHERE r.created_at_ms < ?1
                 AND m.status IN ('done','archived','merged')
                 AND m.updated_at_ms < ?2
                 AND w.status IN
                     ('completed_with_proof','failed_terminal','cancelled','merged','archived')
                 AND w.updated_at_ms < ?3
                 AND NOT EXISTS (
                     SELECT 1 FROM route_decision_control c
                      WHERE c.decision_id = r.decision_id
                 )
               ORDER BY r.created_at_ms LIMIT ?4
          )",
            route_trace_cutoff,
            mission_cutoff,
            work_item_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.route_decision_deleted = n,
            Err(_e) => out.table_errors += 1,
        }

        // 8. mission_link — only route-decision trace links are swept here; proof receipts and other
        //    product evidence links keep their retention semantics and can still pin the parent.
        match delete_bounded4(
            conn,
            "DELETE FROM mission_link
          WHERE rowid IN (
              SELECT l.rowid
                FROM mission_link l
                JOIN mission m ON m.mission_id = l.mission_id
                LEFT JOIN work_item w ON w.work_item_id = l.work_item_id
               WHERE l.created_at_ms < ?1
                 AND l.link_kind = 'route_decision'
                 AND m.status IN ('done','archived','merged')
                 AND m.updated_at_ms < ?2
                 AND (
                     l.work_item_id IS NULL OR
                     (w.status IN
                         ('completed_with_proof','failed_terminal','cancelled','merged','archived')
                      AND w.updated_at_ms < ?3)
                 )
               ORDER BY l.created_at_ms LIMIT ?4
          )",
            route_trace_cutoff,
            mission_cutoff,
            work_item_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.mission_link_deleted = n,
            Err(_e) => out.table_errors += 1,
        }

        // 9. mission_body_snapshot — full-text body snapshot attached to terminal+aged parents.
        match delete_bounded4(
            conn,
            "DELETE FROM mission_body_snapshot
          WHERE rowid IN (
              SELECT b.rowid
                FROM mission_body_snapshot b
                JOIN mission m ON m.mission_id = b.mission_id
                JOIN work_item w ON w.work_item_id = b.work_item_id
               WHERE b.created_at_ms < ?1
                 AND m.status IN ('done','archived','merged')
                 AND m.updated_at_ms < ?2
                 AND w.status IN
                     ('completed_with_proof','failed_terminal','cancelled','merged','archived')
                 AND w.updated_at_ms < ?3
               ORDER BY b.created_at_ms LIMIT ?4
          )",
            route_trace_cutoff,
            mission_cutoff,
            work_item_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.mission_body_snapshot_deleted = n,
            Err(_e) => out.table_errors += 1,
        }

        // 10. process_lease — terminal process ownership rows attached to terminal+aged parents.
        match delete_bounded4(
            conn,
            "DELETE FROM process_lease
          WHERE rowid IN (
              SELECT p.rowid
                FROM process_lease p
                JOIN mission m ON m.mission_id = p.mission_id
                LEFT JOIN work_item w ON w.work_item_id = p.work_item_id
               WHERE p.updated_at_ms < ?1
                 AND p.state IN ('stopped_with_proof','stale')
                 AND m.status IN ('done','archived','merged')
                 AND m.updated_at_ms < ?2
                 AND (
                     p.work_item_id IS NULL OR
                     (w.status IN
                         ('completed_with_proof','failed_terminal','cancelled','merged','archived')
                      AND w.updated_at_ms < ?3)
                 )
               ORDER BY p.updated_at_ms LIMIT ?4
          )",
            route_trace_cutoff,
            mission_cutoff,
            work_item_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.process_lease_deleted = n,
            Err(_e) => out.table_errors += 1,
        }

        // 11. workspace_claim — released/stale claims after process observations and leases are gone.
        match delete_bounded4(
            conn,
            "DELETE FROM workspace_claim
          WHERE rowid IN (
              SELECT c.rowid
                FROM workspace_claim c
                JOIN mission m ON m.mission_id = c.mission_id
                LEFT JOIN work_item w ON w.work_item_id = c.work_item_id
               WHERE c.updated_at_ms < ?1
                 AND c.state IN ('released','stale')
                 AND m.status IN ('done','archived','merged')
                 AND m.updated_at_ms < ?2
                 AND (
                     c.work_item_id IS NULL OR
                     (w.status IN
                         ('completed_with_proof','failed_terminal','cancelled','merged','archived')
                      AND w.updated_at_ms < ?3)
                 )
                 AND NOT EXISTS (
                     SELECT 1 FROM process_lease p WHERE p.claim_id = c.claim_id
                 )
                 AND NOT EXISTS (
                     SELECT 1 FROM process_observation o WHERE o.matched_claim_id = c.claim_id
                 )
               ORDER BY c.updated_at_ms LIMIT ?4
          )",
            route_trace_cutoff,
            mission_cutoff,
            work_item_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.workspace_claim_deleted = n,
            Err(_e) => out.table_errors += 1,
        }
    } // end mission/work_item route-trace group (blocks 6–11)

    // 12. provider_session_link — session mirror rows after old event children and process leases
    //    are gone. A NULL last sighting is kept; only an explicitly old sighting can age out.
    //    Keyed on the provider_session category (with process_lease already gone above).
    if let Some(provider_session_cutoff) = provider_session_cutoff {
        match delete_bounded(
            conn,
            "DELETE FROM provider_session_link
          WHERE rowid IN (
              SELECT l.rowid FROM provider_session_link l
               WHERE l.last_provider_seen_at IS NOT NULL
                 AND l.last_provider_seen_at < ?1
                 AND NOT EXISTS (
                     SELECT 1 FROM provider_session_event e
                      WHERE e.friday_session_id = l.friday_session_id
                 )
                 AND NOT EXISTS (
                     SELECT 1 FROM process_lease p
                      WHERE p.started_by_provider_session_id = l.friday_session_id
                 )
               ORDER BY l.last_provider_seen_at LIMIT ?2
          )",
            provider_session_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.provider_session_link_deleted = n,
            Err(_e) => out.table_errors += 1,
        }
    } // end provider_session_link (block 12)

    // 13. surface_thread — old terminal-mission threads only, after surface events and process
    //    leases are gone. Keyed on the mission category only.
    if let Some(mission_cutoff) = mission_cutoff {
        match delete_bounded3(
            conn,
            "DELETE FROM surface_thread
          WHERE rowid IN (
              SELECT t.rowid
                FROM surface_thread t
                JOIN mission m ON m.mission_id = t.mission_id
               WHERE t.updated_at_ms < ?1
                 AND m.status IN ('done','archived','merged')
                 AND m.updated_at_ms < ?2
                 AND NOT EXISTS (
                     SELECT 1 FROM surface_event e
                      WHERE e.surface_thread_id = t.surface_thread_id
                 )
                 AND NOT EXISTS (
                     SELECT 1 FROM process_lease p
                      WHERE p.started_by_surface_thread_id = t.surface_thread_id
                 )
               ORDER BY t.updated_at_ms LIMIT ?3
          )",
            mission_cutoff,
            mission_cutoff,
            windows.batch_limit,
        ) {
            Ok(n) => out.surface_thread_deleted = n,
            Err(_e) => out.table_errors += 1,
        }
    } // end surface_thread (block 13)

    // 14. memory_item — rejected/expired CANDIDATES only, by created_at. CONFIRMED is excluded by
    //    state, so durable memory is NEVER deleted regardless of age. Leaf (no FK refs into it).
    if let Some(memory_cutoff) = memory_cutoff {
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
    } // end memory_item (block 14)

    // 15. work_item — terminal status AND aged on updated_at_ms, AND FK-safe (no surviving child
    //    in any table that RESTRICT-references work_item). A non-terminal work_item can never
    //    match the status set. Deleted BEFORE mission so an aged-out work_item frees its mission.
    if let Some(work_item_cutoff) = work_item_cutoff {
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
                 AND NOT EXISTS (SELECT 1 FROM route_decision_control c WHERE c.work_item_id = w.work_item_id)
                 AND NOT EXISTS (SELECT 1 FROM mission_body_snapshot c WHERE c.work_item_id = w.work_item_id)
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
    } // end work_item (block 15)

    // 16. mission — terminal status AND aged on updated_at_ms, AND FK-safe (no surviving child in
    //    ANY table that RESTRICT-references mission). A non-terminal (active/waiting/blocked/
    //    paused) mission can never match the status set.
    if let Some(mission_cutoff) = mission_cutoff {
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
                 AND NOT EXISTS (SELECT 1 FROM route_decision_control c WHERE c.mission_id = m.mission_id)
                 AND NOT EXISTS (SELECT 1 FROM mission_body_snapshot c WHERE c.mission_id = m.mission_id)
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
    } // end mission (block 16)

    // M3 receipt: record a CONTENT-FREE, counts-only summary of this sweep into `retention_log`
    // (a SEPARATE table, NOT the hash-chained `audit_ledger`). Written ONLY when the sweep actually
    // DELETED something — gated on the sum of the per-table delete counts, NOT on
    // `RetentionOutcome::is_empty()` (which also folds in `table_errors`). An error-only tick (zero
    // deletions, one or more per-table DELETEs failed) must NOT write a receipt: it would be an
    // all-zero "nothing destroyed" row that hides the error, and — since `retention_log` has no
    // sweep of its own — a persistent per-table error would reintroduce the unbounded per-tick
    // growth this module exists to bound. The error is still surfaced to the caller via the
    // returned `table_errors`; when a receipt IS written, `errors=` records any concurrent failures
    // so the row stays honest. The summary carries integer counts only, never a deleted row's
    // id/body. This is a SEPARATE write AFTER the per-table delete txns (there is no single sweep
    // txn to join), and it must NEVER break the fail-safe contract (this fn never returns Err) — so
    // a receipt-write failure is SWALLOWED here, exactly as the session reaper swallows its own.
    let deleted = out.token_ledger_deleted
        + out.run_result_deleted
        + out.agent_run_event_deleted
        + out.agent_run_deleted
        + out.surface_event_deleted
        + out.provider_session_event_deleted
        + out.provider_session_link_deleted
        + out.process_observation_deleted
        + out.route_decision_control_deleted
        + out.route_decision_deleted
        + out.mission_link_deleted
        + out.mission_body_snapshot_deleted
        + out.process_lease_deleted
        + out.workspace_claim_deleted
        + out.surface_thread_deleted
        + out.memory_item_deleted
        + out.work_item_deleted
        + out.mission_deleted;
    if deleted > 0 {
        let summary = format!(
            "retention.sweep:token_ledger={} run_result={} agent_run_event={} agent_run={} surface_event={} provider_session_event={} provider_session_link={} process_observation={} route_decision_control={} route_decision={} mission_link={} mission_body_snapshot={} process_lease={} workspace_claim={} surface_thread={} memory_item={} work_item={} mission={} errors={}",
            out.token_ledger_deleted,
            out.run_result_deleted,
            out.agent_run_event_deleted,
            out.agent_run_deleted,
            out.surface_event_deleted,
            out.provider_session_event_deleted,
            out.provider_session_link_deleted,
            out.process_observation_deleted,
            out.route_decision_control_deleted,
            out.route_decision_deleted,
            out.mission_link_deleted,
            out.mission_body_snapshot_deleted,
            out.process_lease_deleted,
            out.workspace_claim_deleted,
            out.surface_thread_deleted,
            out.memory_item_deleted,
            out.work_item_deleted,
            out.mission_deleted,
            out.table_errors,
        );
        let _ = insert_retention_log(conn, "retention.sweep", &summary, now_ms);
    }

    out
}

/// Insert ONE content-free [`retention_log`] receipt row (its own bounded busy-retry txn,
/// mirroring [`delete_bounded`]). `summary` is a counts-only string — NEVER a deleted row's
/// id/body. This writes the M3/M4 receipt table, which is DELIBERATELY SEPARATE from the
/// hash-chained `audit_ledger` (gap #25): it is un-chained and never references the audit ledger.
///
/// `tick_kind` is the sweep that produced the row (`"retention.sweep"` for the artifact sweep,
/// `"session.reaper"` for the lifecycle reaper). The id is generated in SQL the same way the
/// tool-usage ledger generates its id, so the caller passes no opaque value.
pub fn insert_retention_log(
    conn: &Connection,
    tick_kind: &str,
    summary: &str,
    now_ms: i64,
) -> Result<()> {
    crate::with_busy_retry(|| {
        let tx = conn.unchecked_transaction()?;
        insert_retention_log_in(&tx, tick_kind, summary, now_ms)?;
        tx.commit()?;
        Ok(())
    })
}

/// No-BEGIN variant of [`insert_retention_log`]: writes the receipt row into a CALLER-OWNED
/// transaction without opening (or committing) its own. SQLite forbids nested `BEGIN`, so a caller
/// that already holds a txn — e.g. the lifecycle reaper, which must record the receipt for an
/// IRREVERSIBLE hard-delete atomically with that delete — folds the INSERT in via this fn and lets
/// its own `tx.commit()` seal both. The `?` propagates a write failure to the caller, which is the
/// POINT for the M4 (irreversible) leg: a receipt failure must roll the whole sweep back so a
/// hard-delete can NEVER commit without its receipt. This is the deliberate MIRROR of the M3
/// (reversible) artifact sweep, where [`insert_retention_log`] is called best-effort AFTER the
/// commit so a receipt failure can never block a reversible expiry.
///
/// Does NOT wrap [`crate::with_busy_retry`]: the caller's txn already carries the crate's single
/// busy-retry policy (or, for `sweep_lifecycle`, re-runs idempotently next tick on `SQLITE_BUSY`),
/// so wrapping here would double-apply it. `summary` is counts-only — NEVER a deleted row's id/body.
pub fn insert_retention_log_in(
    tx: &Transaction<'_>,
    tick_kind: &str,
    summary: &str,
    now_ms: i64,
) -> Result<()> {
    tx.execute(
        "INSERT INTO retention_log (retention_log_id, tick_kind, summary, created_at)
         VALUES ('retlog:' || lower(hex(randomblob(16))), ?1, ?2, ?3)",
        params![tick_kind, summary, now_ms],
    )?;
    Ok(())
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

fn delete_bounded3(
    conn: &Connection,
    sql: &str,
    cutoff1: i64,
    cutoff2: i64,
    limit: i64,
) -> Result<usize> {
    crate::with_busy_retry(|| {
        let tx = conn.unchecked_transaction()?;
        let n = tx.execute(sql, params![cutoff1, cutoff2, limit])?;
        tx.commit()?;
        Ok(n)
    })
}

fn delete_bounded4(
    conn: &Connection,
    sql: &str,
    cutoff1: i64,
    cutoff2: i64,
    cutoff3: i64,
    limit: i64,
) -> Result<usize> {
    crate::with_busy_retry(|| {
        let tx = conn.unchecked_transaction()?;
        let n = tx.execute(sql, params![cutoff1, cutoff2, cutoff3, limit])?;
        tx.commit()?;
        Ok(n)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;
    use crate::{persist_run_result, RunResult};
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

    fn seed_provider_session_link(db: &Db, id: &str, last_seen: i64) {
        db.conn()
            .execute(
                "INSERT INTO provider_session_link
                    (friday_session_id, provider, account_key_hash, workspace_id, cwd,
                     external_session_id, external_thread_id, external_url, sync_mode,
                     capability_snapshot, last_provider_seen_at, last_friday_event_id, truth_label)
                 VALUES (?1, 'codex', 'hash', 'workspace', NULL, 'external-session',
                         'external-thread', NULL, 'provider_app_server_local', '{}', ?2, NULL,
                         'retention_test_provider_session_link')",
                params![id, last_seen],
            )
            .unwrap();
    }

    fn seed_provider_session_event(db: &Db, session_id: &str, event_id: &str, observed_at: i64) {
        db.conn()
            .execute(
                "INSERT INTO provider_session_event
                    (friday_session_id, provider_event_id, provider, event_kind,
                     transcript_item_kind, body_ref, redaction_level, token_ledger_ref,
                     approval_ref, audit_receipt_ref, observed_at)
                 VALUES (?1, ?2, 'codex', 'turn_completed', 'turn', '', 'metadata_only',
                         NULL, NULL, NULL, ?3)",
                params![session_id, event_id, observed_at],
            )
            .unwrap();
    }

    fn seed_process_observation(
        db: &Db,
        id: &str,
        pid: i64,
        observed_at_ms: i64,
        matched_claim_id: Option<&str>,
    ) {
        db.conn()
            .execute(
                "INSERT INTO process_observation
                    (observation_id, pid, ppid, process_kind, cwd_ref, port_bindings,
                     command_hash, observed_at_ms, matched_claim_id, ownership_status)
                 VALUES (?1, ?2, NULL, 'codex_cli', 'cwd:retention-test', '[]',
                         NULL, ?3, ?4, 'observed_unowned')",
                params![id, pid, observed_at_ms, matched_claim_id],
            )
            .unwrap();
    }

    fn seed_agent_run_with_event(
        db: &Db,
        run_id: &str,
        event_id: &str,
        state: &str,
        created_at: i64,
    ) {
        crate::agent_run::create_run(db.conn(), run_id, "retention test task", created_at).unwrap();
        crate::agent_run::record_event(db.conn(), event_id, run_id, "agent.lifecycle", created_at)
            .unwrap();
        db.conn()
            .execute(
                "UPDATE agent_run SET state = ?1, updated_at = ?2 WHERE run_id = ?3",
                params![state, created_at, run_id],
            )
            .unwrap();
    }

    fn seed_audit(db: &Db, id: &str) {
        let tx = db.conn().unchecked_transaction().unwrap();
        crate::audit::append_audit(&tx, id, "owner", "test.action", None, 1).unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn retention_sweep_prunes_old_run_result_answer_rows() {
        let db = Db::open_hub(&tmp("run-result-retention")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;

        persist_run_result(
            db.conn(),
            "rr_old",
            &RunResult::new("finished", "OLD-PII-BODY", None),
            1,
        )
        .unwrap();
        persist_run_result(
            db.conn(),
            "rr_boundary",
            &RunResult::new("finished", "boundary answer", None),
            now - RUN_RESULT_MAX_AGE_MS,
        )
        .unwrap();
        persist_run_result(
            db.conn(),
            "rr_recent",
            &RunResult::new("finished", "recent answer", None),
            now - 1,
        )
        .unwrap();
        assert_eq!(count(&db, "run_result"), 3);

        let out = sweep_retention(db.conn(), now, RetentionWindows::operator_windows());
        assert_eq!(out.table_errors, 0);
        assert_eq!(out.run_result_deleted, 1);

        assert!(
            !exists(&db, "run_result", "run_id", "rr_old"),
            "aged run_result.answer rows should be pruned by retention"
        );
        assert!(
            exists(&db, "run_result", "run_id", "rr_boundary"),
            "strict age boundary is '< cutoff', so exact-boundary rows remain"
        );
        assert!(
            exists(&db, "run_result", "run_id", "rr_recent"),
            "recent run_result rows must remain available"
        );
        assert_eq!(count(&db, "run_result"), 2);
    }

    #[test]
    fn run_result_retention_respects_batch_limit() {
        let db = Db::open_hub(&tmp("run-result-batch")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        let windows = RetentionWindows {
            batch_limit: 2,
            ..RetentionWindows::operator_windows()
        };

        for idx in 0..5 {
            persist_run_result(
                db.conn(),
                &format!("rr_old_{idx}"),
                &RunResult::new("finished", format!("old answer {idx}"), None),
                idx + 1,
            )
            .unwrap();
        }
        assert_eq!(count(&db, "run_result"), 5);

        let first = sweep_retention(db.conn(), now, windows);
        assert_eq!(first.run_result_deleted, 2);
        assert_eq!(count(&db, "run_result"), 3);

        let second = sweep_retention(db.conn(), now, windows);
        assert_eq!(second.run_result_deleted, 2);
        assert_eq!(count(&db, "run_result"), 1);

        let third = sweep_retention(db.conn(), now, windows);
        assert_eq!(third.run_result_deleted, 1);
        assert_eq!(count(&db, "run_result"), 0);
    }

    // --- the consolidated e2e: ON prunes ONLY old-terminal; everything else survives ---

    #[test]
    fn flag_on_sweep_prunes_only_old_terminal_rows_others_untouched() {
        let db = Db::open_hub(&tmp("e2e-on")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64; // ~2000 days, far past every window
        let w = RetentionWindows::operator_windows();

        seed_conversation(&db, "fconv_1");

        // token_ledger: one OLD (prune) + one RECENT (keep).
        seed_token_ledger(&db, "tl_old", now - TOKEN_LEDGER_MAX_AGE_MS - 1);
        seed_token_ledger(&db, "tl_recent", now - 1);

        // run_result: final answer body store; old terminal run answer pruned, recent kept.
        persist_run_result(
            db.conn(),
            "rr_old",
            &RunResult::new("finished", "OLD-PII-BODY", None),
            now - RUN_RESULT_MAX_AGE_MS - 1,
        )
        .unwrap();
        persist_run_result(
            db.conn(),
            "rr_recent",
            &RunResult::new("finished", "recent answer", None),
            now - 1,
        )
        .unwrap();

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

        // provider_session_event: old provider firehose row pruned; recent kept. The parent
        // provider_session_link remains because this sweep bounds events, not session links.
        seed_provider_session_link(&db, "ps_1", now);
        seed_provider_session_event(
            &db,
            "ps_1",
            "pse_old",
            now - PROVIDER_SESSION_EVENT_MAX_AGE_MS - 1,
        );
        seed_provider_session_event(&db, "ps_1", "pse_recent", now - 1);

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

        // run_result: old answer body gone; recent answer survives.
        assert_eq!(out.run_result_deleted, 1);
        assert!(!exists(&db, "run_result", "run_id", "rr_old"));
        assert!(exists(&db, "run_result", "run_id", "rr_recent"));

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

        // provider_session_event: old leaf gone; recent kept; provider_session_link survives.
        assert_eq!(out.provider_session_event_deleted, 1);
        assert!(!exists(
            &db,
            "provider_session_event",
            "provider_event_id",
            "pse_old"
        ));
        assert!(exists(
            &db,
            "provider_session_event",
            "provider_event_id",
            "pse_recent"
        ));
        assert!(exists(
            &db,
            "provider_session_link",
            "friday_session_id",
            "ps_1"
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

        // M3 receipt: a non-empty sweep writes EXACTLY ONE retention_log row whose summary
        // carries the per-table counts (content-free; counts only). It is NOT an audit_ledger
        // row — the audit count above is unchanged.
        assert_eq!(
            count(&db, "retention_log"),
            1,
            "one sweep ⇒ one receipt row"
        );
        let (tick_kind, summary): (String, String) = db
            .conn()
            .query_row("SELECT tick_kind, summary FROM retention_log", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(tick_kind, "retention.sweep");
        assert_eq!(
            summary,
            "retention.sweep:token_ledger=1 run_result=1 agent_run_event=0 agent_run=0 surface_event=1 provider_session_event=1 provider_session_link=0 process_observation=0 route_decision_control=0 route_decision=0 mission_link=0 mission_body_snapshot=0 process_lease=0 workspace_claim=0 surface_thread=0 memory_item=1 work_item=1 mission=2 errors=0",
            "summary records the real per-table counts + the concurrent error count"
        );
    }

    // --- a content-free, counts-only receipt is written ONLY on a non-empty sweep ---

    #[test]
    fn empty_sweep_writes_no_retention_log_row() {
        // The growth fix: an idle tick (nothing eligible) must NOT write a receipt — otherwise
        // retention_log (which has no sweep of its own) would grow unbounded, the very problem
        // this module exists to bound.
        let db = Db::open_hub(&tmp("empty-receipt")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        let out = sweep_retention(db.conn(), now, RetentionWindows::default());
        assert!(out.is_empty(), "no seeded rows ⇒ nothing deleted");
        assert_eq!(
            count(&db, "retention_log"),
            0,
            "an empty sweep writes ZERO receipt rows"
        );
    }

    // --- an error-only sweep (a per-table DELETE failed, nothing deleted) writes NO receipt ---

    #[test]
    fn error_only_sweep_writes_no_retention_log_row() {
        // The receipt is gated on actual DELETIONS, not on `is_empty()` (which folds in
        // `table_errors`). Drop `mission` so its DELETE errors (table_errors += 1) while every
        // other table is empty (0 deletions). The sweep must record NO receipt — an all-zero
        // "nothing destroyed" row would both hide the error and, since retention_log has no sweep
        // of its own, reintroduce unbounded per-tick growth under a persistent per-table error.
        let db = Db::open_hub(&tmp("error-only-receipt")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        db.conn().execute_batch("DROP TABLE mission").unwrap();
        let out = sweep_retention(db.conn(), now, RetentionWindows::operator_windows());
        assert!(out.table_errors >= 1, "the dropped-table DELETE must error");
        assert_eq!(out.mission_deleted, 0, "nothing was deleted");
        assert_eq!(
            count(&db, "retention_log"),
            0,
            "an error-only sweep (0 deletions) writes ZERO receipt rows"
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
        let w = RetentionWindows::operator_windows();
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

    #[test]
    fn route_decision_control_child_keeps_terminal_aged_parents_fk_safe() {
        // Structural guard: route_decision_control is a direct FK child of BOTH mission and
        // work_item. Even if a future caller inserts an unusual but FK-valid control row, the
        // parent sweep must skip instead of relying on the route_decision guard alone.
        let db = Db::open_hub(&tmp("rd-control-fk-safe")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        let w = RetentionWindows::operator_windows();
        seed_conversation(&db, "fconv_1");
        seed_mission(
            &db,
            "m_guarded",
            "fconv_1",
            "done",
            now - MISSION_MAX_AGE_MS - 1,
        );
        seed_work_item(
            &db,
            "w_guarded",
            "m_guarded",
            "completed_with_proof",
            now - WORK_ITEM_MAX_AGE_MS - 1,
        );
        seed_mission(&db, "m_route", "fconv_1", "active", now);
        seed_work_item(&db, "w_route", "m_route", "provider_waiting", now);
        db.conn()
            .execute(
                "INSERT INTO route_decision
                    (decision_id, mission_id, work_item_id, selected_lane,
                     selected_provider_or_agent, why_this_route, created_at_ms)
                 VALUES ('rd_guard', 'm_route', 'w_route', 'codex', 'codex',
                         'seed route decision for control FK guard', ?1)",
                [now],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO route_decision_control
                    (decision_id, mission_id, work_item_id, control_kind, actor_ref, reason,
                     active, created_at_ms)
                 VALUES ('rd_guard', 'm_guarded', 'w_guarded', 'veto', 'operator:test',
                         'retention guard proof', 1, ?1)",
                [now],
            )
            .unwrap();

        let out = sweep_retention(db.conn(), now, w);
        assert_eq!(out.table_errors, 0, "guard skips instead of hitting FK");
        assert_eq!(out.work_item_deleted, 0);
        assert_eq!(out.mission_deleted, 0);
        assert!(exists(&db, "work_item", "work_item_id", "w_guarded"));
        assert!(exists(&db, "mission", "mission_id", "m_guarded"));
    }

    #[test]
    fn terminal_aged_agent_run_events_are_reaped_before_run_row() {
        let db = Db::open_hub(&tmp("agent-run-retention")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        let old = 1_i64;
        let recent = now - 1;

        seed_agent_run_with_event(&db, "run_old_done", "ev_old_done", "finished", old);
        seed_agent_run_with_event(
            &db,
            "run_old_hold",
            "ev_old_hold",
            "awaiting_clarification",
            old,
        );
        seed_agent_run_with_event(&db, "run_recent_done", "ev_recent_done", "finished", recent);

        let out = sweep_retention(db.conn(), now, RetentionWindows::operator_windows());
        assert_eq!(out.table_errors, 0);

        assert!(
            !exists(&db, "agent_run_event", "event_id", "ev_old_done"),
            "old terminal run event should be pruned before its run row"
        );
        assert!(
            !exists(&db, "agent_run", "run_id", "run_old_done"),
            "old terminal run row should be pruned once event rows are gone"
        );

        assert!(
            exists(&db, "agent_run", "run_id", "run_old_hold"),
            "awaiting_clarification is a live hold, not a retention-terminal run"
        );
        assert!(exists(&db, "agent_run_event", "event_id", "ev_old_hold"));
        assert!(exists(&db, "agent_run", "run_id", "run_recent_done"));
        assert!(exists(&db, "agent_run_event", "event_id", "ev_recent_done"));
    }

    #[test]
    fn f2_aged_observe_and_terminal_child_rows_are_reaped_before_parents() {
        let db = Db::open_hub(&tmp("f2-child-reap")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        let w = RetentionWindows::operator_windows();
        let old_session_seen = now - PROVIDER_SESSION_EVENT_MAX_AGE_MS - 1;
        let old_parent_seen = now - MISSION_MAX_AGE_MS - 1;
        seed_conversation(&db, "fconv_f2");

        seed_provider_session_link(&db, "ps_old", old_session_seen);
        seed_provider_session_link(&db, "ps_recent", now - 1);
        seed_process_observation(&db, "obs_old_unowned", 41001, old_session_seen, None);
        seed_process_observation(&db, "obs_recent_unowned", 41002, now - 1, None);

        seed_mission(&db, "m_f2", "fconv_f2", "done", old_parent_seen);
        seed_work_item(&db, "w_f2", "m_f2", "completed_with_proof", old_parent_seen);
        seed_surface_thread(&db, "st_f2", "fconv_f2", "m_f2");
        db.conn()
            .execute(
                "UPDATE surface_thread SET updated_at_ms = ?1 WHERE surface_thread_id = 'st_f2'",
                [old_parent_seen],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO route_decision
                    (decision_id, mission_id, work_item_id, selected_lane,
                     selected_provider_or_agent, why_this_route, created_at_ms)
                 VALUES ('rd_f2', 'm_f2', 'w_f2', 'codex', 'codex',
                         'retention must reap terminal route trace children', ?1)",
                [old_parent_seen],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO route_decision_control
                    (decision_id, mission_id, work_item_id, control_kind, actor_ref, reason,
                     active, created_at_ms)
                 VALUES ('rd_f2', 'm_f2', 'w_f2', 'veto', 'operator:test',
                         'retention must reap terminal route control children', 1, ?1)",
                [old_parent_seen],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO mission_link
                    (link_id, mission_id, work_item_id, link_kind, target_ref, proof_ref,
                     created_at_ms)
                 VALUES ('mlink_f2', 'm_f2', 'w_f2', 'route_decision',
                         'friday://route-decision/rd_f2', NULL, ?1)",
                [old_parent_seen],
            )
            .unwrap();
        let fake_body_sha = "0123456789abcdef".repeat(4);
        db.conn()
            .execute(
                "INSERT INTO mission_body_snapshot
                    (body_ref, owner_principal, mission_id, work_item_id, source_surface,
                     body, body_sha256, body_len, created_at_ms)
                 VALUES ('body_f2', 'owner', 'm_f2', 'w_f2', 'desktop',
                         'terminal body snapshot', ?1, 22, ?2)",
                params![fake_body_sha, old_parent_seen],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO workspace_claim
                    (claim_id, mission_id, work_item_id, owner_principal, owner_agent,
                     workspace_ref, claim_kind, state, reason, safe_release_policy,
                     proof_requirements, proof_refs, created_at_ms, updated_at_ms, released_at_ms)
                 VALUES ('claim_f2', 'm_f2', 'w_f2', 'owner', 'codex',
                         'workspace:f2', 'workspace', 'released', 'retention test',
                         'release_with_proof', '[]', '[\"proof:f2\"]', ?1, ?1, ?1)",
                [old_parent_seen],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO process_lease
                    (lease_id, claim_id, mission_id, work_item_id, pid, process_group_id,
                     process_kind, command_ref, command_hash, cwd_ref, port_bindings,
                     started_by_surface_thread_id, started_by_provider_session_id,
                     health_check_ref, safe_stop_ref, last_observed_at_ms, stale_after_ms,
                     state, proof_refs, created_at_ms, updated_at_ms)
                 VALUES ('lease_f2', 'claim_f2', 'm_f2', 'w_f2', 41003, NULL,
                         'codex_cli', NULL, NULL, 'cwd:retention-test', '[]',
                         'st_f2', NULL, NULL, 'safe-stop:f2', ?1, NULL,
                         'stopped_with_proof', '[\"proof:f2\"]', ?1, ?1)",
                [old_parent_seen],
            )
            .unwrap();
        seed_process_observation(
            &db,
            "obs_old_claimed",
            41003,
            old_session_seen,
            Some("claim_f2"),
        );

        let out = sweep_retention(db.conn(), now, w);
        assert_eq!(out.table_errors, 0);

        for (table, id_col, id) in [
            ("provider_session_link", "friday_session_id", "ps_old"),
            ("process_observation", "observation_id", "obs_old_unowned"),
            ("process_observation", "observation_id", "obs_old_claimed"),
            ("route_decision_control", "decision_id", "rd_f2"),
            ("route_decision", "decision_id", "rd_f2"),
            ("mission_link", "link_id", "mlink_f2"),
            ("mission_body_snapshot", "body_ref", "body_f2"),
            ("process_lease", "lease_id", "lease_f2"),
            ("workspace_claim", "claim_id", "claim_f2"),
            ("surface_thread", "surface_thread_id", "st_f2"),
            ("work_item", "work_item_id", "w_f2"),
            ("mission", "mission_id", "m_f2"),
        ] {
            assert!(
                !exists(&db, table, id_col, id),
                "{table}.{id_col}={id} should be reaped by the F2 retention sweep"
            );
        }
        assert!(
            exists(
                &db,
                "provider_session_link",
                "friday_session_id",
                "ps_recent"
            ),
            "recent provider session links must remain"
        );
        assert!(
            exists(
                &db,
                "process_observation",
                "observation_id",
                "obs_recent_unowned"
            ),
            "recent process observations must remain"
        );
    }

    // --- flag-OFF parity is the CALLER's concern; here prove the empty/boundary behavior ---

    #[test]
    fn empty_db_and_boundary_are_noops() {
        let db = Db::open_hub(&tmp("empty")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        let w = RetentionWindows::operator_windows();
        // Empty DB: nothing to prune.
        assert!(sweep_retention(db.conn(), now, w).is_empty());

        // Exactly-at-boundary rows do NOT prune (strict `<`).
        seed_token_ledger(&db, "tl_at", now - TOKEN_LEDGER_MAX_AGE_MS); // == cutoff, not < cutoff
        seed_provider_session_link(&db, "ps_at", now);
        seed_provider_session_event(
            &db,
            "ps_at",
            "pse_at",
            now - PROVIDER_SESSION_EVENT_MAX_AGE_MS,
        ); // == cutoff, not < cutoff
        let out = sweep_retention(db.conn(), now, w);
        assert_eq!(
            out.token_ledger_deleted, 0,
            "at-exactly-threshold does not fire (strict <)"
        );
        assert_eq!(
            out.provider_session_event_deleted, 0,
            "provider_session_event at threshold does not fire (strict <)"
        );
        assert!(exists(&db, "token_ledger", "ledger_id", "tl_at"));
        assert!(exists(
            &db,
            "provider_session_event",
            "provider_event_id",
            "pse_at"
        ));
    }

    // --- idempotency: a second back-to-back sweep is a no-op ---

    #[test]
    fn second_back_to_back_sweep_is_a_noop() {
        let db = Db::open_hub(&tmp("idem")).unwrap();
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        let w = RetentionWindows::operator_windows();
        seed_conversation(&db, "fconv_1");
        seed_token_ledger(&db, "tl_old", now - TOKEN_LEDGER_MAX_AGE_MS - 1);
        seed_provider_session_link(&db, "ps_idem", now);
        seed_provider_session_event(
            &db,
            "ps_idem",
            "pse_old",
            now - PROVIDER_SESSION_EVENT_MAX_AGE_MS - 1,
        );
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
        assert_eq!(first.provider_session_event_deleted, 1);
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
        let w = RetentionWindows::operator_windows();
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
            ..RetentionWindows::operator_windows()
        };
        for i in 0..5 {
            seed_token_ledger(&db, &format!("tl{i}"), now - TOKEN_LEDGER_MAX_AGE_MS - 1);
        }
        seed_provider_session_link(&db, "ps_batch", now);
        for i in 0..5 {
            seed_provider_session_event(
                &db,
                "ps_batch",
                &format!("pse{i}"),
                now - PROVIDER_SESSION_EVENT_MAX_AGE_MS - 1,
            );
        }
        // Each sweep deletes at most 2; the backlog (5) drains over 3 ticks (2+2+1).
        let first = sweep_retention(db.conn(), now, w);
        assert_eq!(first.token_ledger_deleted, 2);
        assert_eq!(first.provider_session_event_deleted, 2);
        let second = sweep_retention(db.conn(), now, w);
        assert_eq!(second.token_ledger_deleted, 2);
        assert_eq!(second.provider_session_event_deleted, 2);
        let third = sweep_retention(db.conn(), now, w);
        assert_eq!(third.token_ledger_deleted, 1);
        assert_eq!(third.provider_session_event_deleted, 1);
        let fourth = sweep_retention(db.conn(), now, w);
        assert_eq!(fourth.token_ledger_deleted, 0);
        assert_eq!(fourth.provider_session_event_deleted, 0);
        assert_eq!(count(&db, "token_ledger"), 0);
        assert_eq!(count(&db, "provider_session_event"), 0);
    }

    // --- DATA-RETENTION-001: the DEFAULT policy is PERMANENT (deletes nothing) ---

    /// Seed one AGED canonical/user-data row in every category the sweep can touch, at a `now`
    /// far past every operator window, so that under an ENABLED (after-days) policy EVERYTHING
    /// would be eligible for deletion. The default-permanent test asserts that under the DEFAULT
    /// (permanent) policy NONE of it is deleted even with this extreme time-travel.
    fn seed_all_aged_canonical(db: &Db, now: i64) {
        seed_conversation(db, "fconv_1");
        seed_token_ledger(db, "tl_old", now - 10_000 * 24 * 60 * 60 * 1000_i64);
        persist_run_result(
            db.conn(),
            "rr_old",
            &RunResult::new("finished", "OLD-CANONICAL-ANSWER-BODY", None),
            1,
        )
        .unwrap();
        seed_memory(db, "mem_rejected_old", "rejected", "candidate", 1);
        seed_memory(db, "mem_confirmed_old", "confirmed", "confirmed", 1);
        // A terminal+aged mission with a terminal+aged work_item child (both leaf under the FK
        // guards after each other), an aged surface_event, and an aged provider firehose row.
        seed_mission(db, "miss_term_old", "fconv_1", "done", 1);
        seed_mission(db, "miss_for_wi", "fconv_1", "merged", 1);
        seed_work_item(db, "wi_term_old", "miss_for_wi", "completed_with_proof", 1);
        seed_surface_thread(db, "st_1", "fconv_1", "miss_term_old");
        seed_surface_event(db, "se_old", "fconv_1", "miss_term_old", None, "st_1", 1);
        seed_provider_session_link(db, "ps_1", 1);
        seed_provider_session_event(db, "ps_1", "pse_old", 1);
        seed_agent_run_with_event(db, "run_old", "ev_old", "finished", 1);
    }

    #[test]
    fn default_policy_deletes_nothing_even_under_far_future_time_travel() {
        // DATA-RETENTION-001 (constraint #3): under the DEFAULT retention policy AND arbitrary
        // long time-travel, ZERO canonical user-data rows are deleted. Local user data is
        // PERMANENT by default until the user explicitly enables per-category cleanup.
        //
        // RED-FIRST: against the pre-fix code (default = operator after-days windows) this sweep
        // deletes the aged rows, so `is_empty()` is FALSE and this test FAILS. After the fix
        // (default = permanent, fail-closed) the sweep deletes nothing and it PASSES.
        let db = Db::open_hub(&tmp("default-permanent")).unwrap();
        let now = 1_000_000 * 24 * 60 * 60 * 1000_i64; // ~1e6 days into the future
        seed_all_aged_canonical(&db, now);

        let out = sweep_retention(db.conn(), now, RetentionWindows::default());

        assert!(
            out.is_empty(),
            "DEFAULT policy is PERMANENT: no user-data row may be deleted even far in the future \
             (got {out:?})"
        );
        // Every seeded canonical row still present.
        assert!(exists(&db, "token_ledger", "ledger_id", "tl_old"));
        assert!(exists(&db, "run_result", "run_id", "rr_old"));
        assert!(exists(&db, "memory_item", "memory_id", "mem_rejected_old"));
        assert!(exists(&db, "memory_item", "memory_id", "mem_confirmed_old"));
        assert!(exists(&db, "mission", "mission_id", "miss_term_old"));
        assert!(exists(&db, "work_item", "work_item_id", "wi_term_old"));
        assert!(exists(&db, "surface_event", "surface_event_id", "se_old"));
        assert!(exists(
            &db,
            "provider_session_event",
            "provider_event_id",
            "pse_old"
        ));
        assert!(exists(&db, "agent_run", "run_id", "run_old"));
        // No receipt row: nothing was deleted.
        assert_eq!(
            count(&db, "retention_log"),
            0,
            "a permanent-default sweep deletes nothing and writes no receipt"
        );
    }

    // --- DEFAULT = permanent for every category; operator_windows = the opt-in day counts ---

    #[test]
    fn default_windows_are_permanent_and_operator_windows_are_the_approved_values() {
        // DEFAULT = permanent for every content category (DATA-RETENTION-001).
        let d = RetentionWindows::default();
        for cat in [
            d.token_ledger,
            d.run_result,
            d.surface_event,
            d.provider_session_event,
            d.agent_run,
            d.mission,
            d.work_item,
            d.memory_candidate,
        ] {
            assert_eq!(
                cat,
                CategoryRetention::Permanent,
                "every content category defaults to PERMANENT"
            );
        }
        assert_eq!(d.batch_limit, DEFAULT_BATCH_LIMIT);

        // operator_windows() = the explicit opt-in after-days values (NOT a default).
        let w = RetentionWindows::operator_windows();
        assert_eq!(w.token_ledger, CategoryRetention::AfterDays(90));
        assert_eq!(w.surface_event, CategoryRetention::AfterDays(90));
        assert_eq!(w.provider_session_event, CategoryRetention::AfterDays(90));
        assert_eq!(w.agent_run, CategoryRetention::AfterDays(365));
        assert_eq!(w.run_result, CategoryRetention::AfterDays(365));
        assert_eq!(w.mission, CategoryRetention::AfterDays(365));
        assert_eq!(w.work_item, CategoryRetention::AfterDays(365));
        assert_eq!(w.memory_candidate, CategoryRetention::AfterDays(30));
        assert_eq!(w.batch_limit, DEFAULT_BATCH_LIMIT);
    }

    // --- fail-closed: resolve_cutoff / from_config reject every invalid config ---

    #[test]
    fn resolve_cutoff_and_from_config_fail_closed_on_every_invalid_input() {
        let now = 1_000_000 * 24 * 60 * 60 * 1000_i64;
        // permanent → None (skip).
        assert_eq!(resolve_cutoff(now, CategoryRetention::Permanent), None);
        // zero-days → None.
        assert_eq!(resolve_cutoff(now, CategoryRetention::AfterDays(0)), None);
        // negative-days → None.
        assert_eq!(resolve_cutoff(now, CategoryRetention::AfterDays(-5)), None);
        // overflow-days → None (does not panic).
        assert_eq!(
            resolve_cutoff(now, CategoryRetention::AfterDays(i64::MAX)),
            None
        );
        assert_eq!(
            resolve_cutoff(i64::MIN, CategoryRetention::AfterDays(i64::MAX)),
            None
        );
        // a valid positive window resolves to now - n*day.
        assert_eq!(
            resolve_cutoff(now, CategoryRetention::AfterDays(90)),
            Some(now - 90 * DAY_MS)
        );

        // from_config fail-closes on missing / unknown-mode / corrupt / non-positive inputs.
        assert_eq!(
            CategoryRetention::from_config("permanent", None),
            CategoryRetention::Permanent
        );
        assert_eq!(
            CategoryRetention::from_config("after_days", None), // missing days
            CategoryRetention::Permanent
        );
        assert_eq!(
            CategoryRetention::from_config("after_days", Some(0)), // zero
            CategoryRetention::Permanent
        );
        assert_eq!(
            CategoryRetention::from_config("after_days", Some(-3)), // negative
            CategoryRetention::Permanent
        );
        assert_eq!(
            CategoryRetention::from_config("garbage_mode", Some(30)), // unknown / corrupt mode
            CategoryRetention::Permanent
        );
        assert_eq!(
            CategoryRetention::from_config("", None), // empty / missing mode
            CategoryRetention::Permanent
        );
        // only a well-formed after_days enables it.
        assert_eq!(
            CategoryRetention::from_config("after_days", Some(30)),
            CategoryRetention::AfterDays(30)
        );
    }

    #[test]
    fn invalid_per_category_config_deletes_zero_for_that_category() {
        // Enable ONE category (token_ledger) with each invalid config in turn; each must delete 0
        // (fail-closed) while an aged row sits ready. Every OTHER category stays permanent.
        let now = 1_000_000 * 24 * 60 * 60 * 1000_i64;
        for bad in [
            CategoryRetention::AfterDays(0),
            CategoryRetention::AfterDays(-1),
            CategoryRetention::AfterDays(i64::MAX),
            CategoryRetention::from_config("unknown", Some(90)),
            CategoryRetention::from_config("after_days", None),
        ] {
            let db = Db::open_hub(&tmp("failclosed")).unwrap();
            seed_token_ledger(&db, "tl_old", 1);
            let w = RetentionWindows {
                token_ledger: bad,
                ..RetentionWindows::default()
            };
            let out = sweep_retention(db.conn(), now, w);
            assert_eq!(
                out.token_ledger_deleted, 0,
                "invalid config {bad:?} must fail closed (delete 0)"
            );
            assert!(exists(&db, "token_ledger", "ledger_id", "tl_old"));
            assert_eq!(count(&db, "retention_log"), 0);
        }
    }

    // --- positive control: an EXPLICIT opt-in deletes exactly that category, nothing else ---

    #[test]
    fn explicit_single_category_opt_in_deletes_only_that_category() {
        // The mechanism still works when the user genuinely opts in: enable ONLY memory_candidate
        // at after_days(30); leave every other category permanent. Aged rows exist in MANY
        // categories, but ONLY the aged rejected memory candidate is deleted.
        let db = Db::open_hub(&tmp("opt-in-one")).unwrap();
        let now = 1_000_000 * 24 * 60 * 60 * 1000_i64;
        seed_all_aged_canonical(&db, now);

        let w = RetentionWindows {
            memory_candidate: CategoryRetention::AfterDays(30),
            ..RetentionWindows::default()
        };
        let out = sweep_retention(db.conn(), now, w);
        assert_eq!(out.table_errors, 0);

        // Exactly the aged rejected candidate went; the confirmed memory (durable) stayed.
        assert_eq!(out.memory_item_deleted, 1);
        assert!(!exists(&db, "memory_item", "memory_id", "mem_rejected_old"));
        assert!(
            exists(&db, "memory_item", "memory_id", "mem_confirmed_old"),
            "confirmed memory is never deleted, even when the category is enabled"
        );
        // Nothing else was touched (all other categories still permanent).
        assert_eq!(out.token_ledger_deleted, 0);
        assert_eq!(out.run_result_deleted, 0);
        assert_eq!(out.surface_event_deleted, 0);
        assert_eq!(out.provider_session_event_deleted, 0);
        assert_eq!(out.mission_deleted, 0);
        assert_eq!(out.work_item_deleted, 0);
        assert_eq!(out.agent_run_deleted, 0);
        assert!(exists(&db, "token_ledger", "ledger_id", "tl_old"));
        assert!(exists(&db, "run_result", "run_id", "rr_old"));
        assert!(exists(&db, "mission", "mission_id", "miss_term_old"));
        assert!(exists(&db, "work_item", "work_item_id", "wi_term_old"));
    }

    // --- audit_ledger is NEVER swept, under any policy ---

    #[test]
    fn audit_ledger_is_never_swept_under_any_policy() {
        let db = Db::open_hub(&tmp("audit-permanent")).unwrap();
        let now = 1_000_000 * 24 * 60 * 60 * 1000_i64;
        seed_audit(&db, "audit_1");
        seed_audit(&db, "audit_2");
        let before = count(&db, "audit_ledger");
        // Even with EVERY category maximally enabled (operator_windows) + extreme time-travel,
        // the audit hash-chain is untouched (the sweep never references audit_ledger).
        let _ = sweep_retention(db.conn(), now, RetentionWindows::operator_windows());
        assert_eq!(
            count(&db, "audit_ledger"),
            before,
            "audit_ledger row count unchanged"
        );
        assert_eq!(crate::audit::verify_audit_chain(db.conn()).unwrap(), 2);
    }
}
