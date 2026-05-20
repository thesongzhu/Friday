import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V088_AUTO_FIX_ROLLBACK_RECEIPT_SQL = `
-- V088: Phase 21D module_34d - durable auto-fix rollback attempt receipt.
--
-- Failed rollback attempts previously returned immediate response fields but
-- were not persisted on auto_fix_actions, so a later GET could look as though
-- rollback had never been attempted. These nullable fields are additive:
--
--   * rollback_attempted       - whether rollback has been attempted.
--   * rollback_attempted_at    - when rollback was last attempted.
--   * rollback_succeeded       - whether the latest attempt succeeded.
--   * rollback_error_message   - failure detail when the latest attempt failed.
--
-- Existing rows remain valid and rehydrate with no attempted rollback receipt.

ALTER TABLE auto_fix_actions
  ADD COLUMN rollback_attempted INTEGER NOT NULL DEFAULT 0;

ALTER TABLE auto_fix_actions
  ADD COLUMN rollback_attempted_at TEXT;

ALTER TABLE auto_fix_actions
  ADD COLUMN rollback_succeeded INTEGER NOT NULL DEFAULT 0;

ALTER TABLE auto_fix_actions
  ADD COLUMN rollback_error_message TEXT;
`;

const V088_CHECKSUM = computeFridayMigrationChecksum(
  V088_AUTO_FIX_ROLLBACK_RECEIPT_SQL,
);

export const V088_AUTO_FIX_ROLLBACK_RECEIPT_MIGRATION: FridaySqliteMigration = {
  version: 88,
  name: "v088-auto-fix-rollback-receipt",
  sql: V088_AUTO_FIX_ROLLBACK_RECEIPT_SQL,
  checksum: V088_CHECKSUM,
};
