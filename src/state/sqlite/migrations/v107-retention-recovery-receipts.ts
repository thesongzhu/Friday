import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

/**
 * V107: dedicated owner-scoped retention-policy RECOVERY-RECEIPT store
 * (RETENTION-R3d — governed receipt storage).
 *
 * WHY A DEDICATED, GOVERNED TABLE (DATA-RETENTION-001 / U9-DATA-RETENTION +
 * AUDIT-AUTHENTIC-ANCHOR-001):
 *   Earlier R3d rounds stored the COMPLETE recovery receipt (before/after policy
 *   snapshots, changedCategories, appliedUpdates, payloadDigest, recoveryKeyHash)
 *   inside `security_audit_log.metadata_json` and recovered from there. But the
 *   auditLogs retention job deletes only expired rows from `audit_logs` — NOT from
 *   `security_audit_log` — so an aged receipt SURVIVED a finite-retention advance:
 *   the user's auditLogs deletion policy was silently NOT honored for the receipt
 *   (an operator-locked U9/DATA-RETENTION-001 violation).
 *
 *   The fix separates two concerns:
 *     - `security_audit_log` keeps a CONTENT-MINIMIZED authentic-audit anchor (only
 *       the linkage id + payload digest — no user before/after content), which stays
 *       default-permanent for authentic audit truth (AUDIT-AUTHENTIC-ANCHOR-001).
 *     - THIS table holds the full user-facing receipt facts and is GOVERNED BY the
 *       auditLogs content-retention category: default-PERMANENT (rows survive
 *       forever until the user acts), but the reaper's auditLogs-category sweep
 *       expires rows once the user explicitly opts auditLogs into a finite window
 *       (`after_days`), and a Delete-All can purge the owner's rows via the
 *       repository's `deleteAllForOwner` seam (DATA-DELETE-ALL-001) — so the
 *       receipt is never an untracked permanent data island outside category
 *       governance.
 *
 * OWNER SCOPING (SEC-NET-PRINCIPAL-001): every row is keyed by `principal_id`
 * (the resolved canonical owner). Recovery by `recovery_key_hash` is always scoped
 * to the owner's `principal_id` so a different principal's rows never match.
 *
 * `recovery_key_hash` is the NON-REVERSIBLE sha256 of the client Idempotency-Key
 * (the RAW key is never stored). It is NULLABLE: a PUT with no Idempotency-Key
 * still records a durable receipt (audit fidelity) that simply has no client-known
 * recovery handle. Recovery reads the OLDEST `(principal_id, recovery_key_hash)`
 * row (`created_at ASC`) so — combined with the write-path idempotency/conflict
 * guard — the FIRST committed receipt for a key is immutable (never "latest wins");
 * the index is intentionally NON-unique to preserve that "oldest wins" semantics.
 *
 * Additive + idempotent (CREATE ... IF NOT EXISTS): removes/alters nothing.
 */
export const V107_RETENTION_RECOVERY_RECEIPTS_SQL = `
CREATE TABLE IF NOT EXISTS retention_recovery_receipts (
  receipt_id              TEXT PRIMARY KEY NOT NULL,
  principal_id            TEXT NOT NULL,
  tenant_id               TEXT,
  correlation_id          TEXT NOT NULL,
  audit_id                TEXT NOT NULL,
  recovery_key_hash       TEXT,
  payload_digest          TEXT,
  before_json             TEXT NOT NULL,
  after_json              TEXT NOT NULL,
  changed_categories_json TEXT NOT NULL,
  applied_updates_json    TEXT NOT NULL,
  created_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retention_recovery_receipts_principal_recovery_key
ON retention_recovery_receipts(principal_id, recovery_key_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_retention_recovery_receipts_created_at
ON retention_recovery_receipts(created_at);
`;

const V107_CHECKSUM = computeFridayMigrationChecksum(V107_RETENTION_RECOVERY_RECEIPTS_SQL);

export const V107_RETENTION_RECOVERY_RECEIPTS_MIGRATION: FridaySqliteMigration = {
  version: 107,
  name: "v107-retention-recovery-receipts",
  sql: V107_RETENTION_RECOVERY_RECEIPTS_SQL,
  checksum: V107_CHECKSUM,
};
