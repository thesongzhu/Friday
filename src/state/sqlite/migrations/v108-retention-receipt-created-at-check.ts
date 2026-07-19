import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

/**
 * V108: enforce a CANONICAL `created_at` at the STORAGE boundary for
 * `retention_recovery_receipts` (RETENTION-R3d — whole-row receipt invariant).
 *
 * WHY (DATA-RETENTION-001 truthfulness / U9):
 *   The auditLogs-category reaper expires receipts with a lexicographic
 *   `created_at < cutoff` string compare. A row whose `created_at` is a
 *   non-canonical value (e.g. `"zzzz"`, or the impossible `9999-99-99T…`) sorts
 *   AFTER every real ISO cutoff, so a finite-retention sweep returns
 *   `deletedRetentionReceipts = 0` and the row SILENTLY SURVIVES the window the
 *   user opted into — a "successful zero-deletion sweep silently surviving a finite
 *   retention policy". This migration blocks a direct-DB `created_at` tamper at the
 *   STORAGE boundary so a non-canonical timestamp can never be INSERTed/UPDATEd via
 *   the SQLite engine in the first place (the reaper's finite-sweep QUARANTINE and
 *   the read/serve strict round-trip check are the defence-in-depth for a row that
 *   entered before this guard existed or via a raw sqlite-file edit that bypasses
 *   engine-enforced constraints).
 *
 * HOW (SQLite can't ALTER-ADD a CHECK): recreate the table WITH a `created_at`
 * CHECK, copy every existing row, drop the old table, rename, and re-create both
 * v107 indexes. The copy is UNCONDITIONAL — every row is written by the canonical
 * write path (`new Date().toISOString()`), so it always satisfies the CHECK and the
 * migration never bricks a legitimately-written database. The CHECK is a SHAPE
 * GLOB (SQLite has no date type): tightened component ranges (month `[0-1]`, day
 * `[0-3]`, hour `[0-2]`, min/sec `[0-5]`) reject `"zzzz"` AND `9999-99-99T…` while
 * accepting every real `toISOString()`. The exact instant gate (round-trip) lives
 * in the read/serve path; the SAME GLOB is shared with the reaper quarantine so
 * storage + reap agree on "non-canonical".
 *
 * The GLOB literal is INLINED here on purpose: a migration's SQL/checksum is a
 * FROZEN historical artifact and must not interpolate a mutable constant. A guard
 * test asserts this inlined CHECK agrees with the exported
 * `FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB` (the reaper + repository consume that
 * constant), so the storage bound and the runtime bound can never silently diverge.
 *
 * Forward-only + additive: v107 is untouched; only the receipt table is rebuilt.
 */
export const V108_RETENTION_RECEIPT_CREATED_AT_CHECK_SQL = `
CREATE TABLE retention_recovery_receipts__v108 (
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
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z')
);

INSERT INTO retention_recovery_receipts__v108 (
  receipt_id, principal_id, tenant_id, correlation_id, audit_id,
  recovery_key_hash, payload_digest, before_json, after_json,
  changed_categories_json, applied_updates_json, created_at
)
SELECT
  receipt_id, principal_id, tenant_id, correlation_id, audit_id,
  recovery_key_hash, payload_digest, before_json, after_json,
  changed_categories_json, applied_updates_json, created_at
FROM retention_recovery_receipts;

DROP TABLE retention_recovery_receipts;

ALTER TABLE retention_recovery_receipts__v108 RENAME TO retention_recovery_receipts;

CREATE INDEX IF NOT EXISTS idx_retention_recovery_receipts_principal_recovery_key
ON retention_recovery_receipts(principal_id, recovery_key_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_retention_recovery_receipts_created_at
ON retention_recovery_receipts(created_at);
`;

const V108_CHECKSUM = computeFridayMigrationChecksum(
  V108_RETENTION_RECEIPT_CREATED_AT_CHECK_SQL,
);

export const V108_RETENTION_RECEIPT_CREATED_AT_CHECK_MIGRATION: FridaySqliteMigration = {
  version: 108,
  name: "v108-retention-receipt-created-at-check",
  sql: V108_RETENTION_RECEIPT_CREATED_AT_CHECK_SQL,
  checksum: V108_CHECKSUM,
};
