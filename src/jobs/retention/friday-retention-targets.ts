/**
 * INV-DATA-001 — the SINGLE canonical authority for "which physical table does
 * each retention governance category delete from, and who executes that delete".
 *
 * Before this module the category→physical-target mapping was DUPLICATED: the
 * production reaper (`friday-retention-job.ts`) inlined the table name in each
 * `DELETE FROM <table>` (or delegated to a repository whose SQL held the table),
 * while the inventory census oracle hand-maintained a SEPARATE copy of the same
 * mapping. Nothing tied the two together, so changing a real DELETE target could
 * stay false-green in the census.
 *
 * This map is now the ONE source of truth, consumed by BOTH sides:
 *   - `friday-retention-job.ts` derives its SQL-direct `DELETE FROM <table>`
 *     targets from `FRIDAY_RETENTION_CATEGORY_TARGETS[<category>].table`, so
 *     changing a table here changes the ACTUAL production delete target.
 *   - `tools/inventory/data-universe-oracle.ts` derives its census
 *     category→table classification from this same map (no second copy).
 * Both files (plus every repository that owns a repository-routed retention
 * delete) are covered by the census source fingerprint, so a change to any real
 * retention target invalidates the committed snapshot instead of staying invisible.
 *
 * `kind`:
 *   - `"sql-direct"`   — the reaper runs the `DELETE FROM <table>` itself.
 *   - `"repository"`   — the reaper calls `repository` (the named executor),
 *                        whose own SQL owns the physical `DELETE FROM <table>`.
 *     The table declared here MUST match the table that executor deletes from.
 *
 * The type is `Record<keyof FridayRetentionPolicy, …>`, so adding a retention
 * policy field WITHOUT giving it a physical target here is a COMPILE error — the
 * mapping can never silently fall behind the governance policy.
 */
import type { FridayRetentionPolicy } from "./friday-retention.types.js";

/** Every retention governance category = a `FridayRetentionPolicy` field. */
export type FridayRetentionCategory = keyof FridayRetentionPolicy;

/** How the physical delete for a category is executed. */
export type FridayRetentionTargetKind = "sql-direct" | "repository";

export interface FridayRetentionTarget {
  /** The physical SQLite table rows are deleted FROM. */
  table: string;
  /** Whether the reaper deletes inline (`sql-direct`) or via a repository. */
  kind: FridayRetentionTargetKind;
  /**
   * For `kind: "repository"`, the executor that owns the physical DELETE (the
   * reaper calls it; the repository's SQL holds the `DELETE FROM <table>`). The
   * repository source file is part of the census fingerprint so a change to its
   * real delete target invalidates the snapshot.
   */
  repository?: string;
}

/**
 * Canonical category → physical delete-target map. Covers ALL retention
 * governance categories (7 content + 3 security-lifecycle). SINGLE source of
 * truth for the reaper's SQL-direct table names AND the census oracle.
 */
export const FRIDAY_RETENTION_CATEGORY_TARGETS: Record<
  FridayRetentionCategory,
  FridayRetentionTarget
> = {
  // ── CONTENT categories (default-permanent, opt-in) ────────────────────────
  learningEvents: { table: "learning_events", kind: "sql-direct" },
  heartbeats: {
    table: "satellite_heartbeats",
    kind: "repository",
    repository: "FridaySatelliteHeartbeatRepository.deleteBefore",
  },
  skillRunTerminal: {
    table: "skill_run_snapshots",
    kind: "repository",
    repository: "FridaySkillRunStore.pruneTerminalRunsBefore",
  },
  auditLogs: { table: "audit_logs", kind: "sql-direct" },
  agentRuns: { table: "friday_agent_runs", kind: "sql-direct" },
  llmUsageRecords: { table: "llm_usage_records", kind: "sql-direct" },
  errorIncidents: { table: "error_incidents", kind: "sql-direct" },

  // ── SECURITY-LIFECYCLE terminal TTLs (repository-executed) ────────────────
  pairingRequestsDays: {
    table: "satellite_pairing_requests",
    kind: "repository",
    repository: "FridaySatellitePairingRequestRepository.deleteResolvedBefore",
  },
  outboxTerminalDays: {
    table: "outbox_messages",
    kind: "repository",
    repository: "FridayOutboxMessageRepository.deleteTerminalBefore",
  },
  bootstrapNoncesConsumedDays: {
    table: "friday_setup_bootstrap_nonces",
    kind: "repository",
    repository: "FridaySetupBootstrapNonceRepository.sweepExpiredAndRetired",
  },
};
