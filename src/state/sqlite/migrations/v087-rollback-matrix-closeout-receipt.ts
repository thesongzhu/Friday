import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_SQL = `
-- V087: Phase 14.5D module_28d — rollback matrix and closeout receipt.
--
-- Adds three nullable columns to task_workflow_closeout_receipts so the
-- closeout receipt can disclose the per-workflow worst-case rollback
-- class derived deterministically from verified/blocked-claim evidence
-- ref sources:
--
--   * rollback_class        — text label ('reversible_local',
--                             'compensating_action_required',
--                             'non_reversible_external',
--                             'not_applicable'). Legacy rows
--                             rehydrate as 'not_applicable'.
--   * compensating_action   — text summary, required when
--                             rollback_class='compensating_action_required',
--                             null otherwise.
--   * non_reversible_reason — text summary, required when
--                             rollback_class='non_reversible_external',
--                             null otherwise.
--
-- All three columns are nullable so existing closeout receipts continue
-- to load unchanged. The service writes the new fields on every new
-- closeout. Rollback disclosure is honest reporting — not release proof —
-- so the migration intentionally adds no new NOT NULL constraint or
-- defaulting trigger.

ALTER TABLE task_workflow_closeout_receipts
  ADD COLUMN rollback_class TEXT;

ALTER TABLE task_workflow_closeout_receipts
  ADD COLUMN compensating_action TEXT;

ALTER TABLE task_workflow_closeout_receipts
  ADD COLUMN non_reversible_reason TEXT;
`;

const V087_CHECKSUM = computeFridayMigrationChecksum(
  V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_SQL,
);

export const V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_MIGRATION: FridaySqliteMigration = {
  version: 87,
  name: "v087-rollback-matrix-closeout-receipt",
  sql: V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_SQL,
  checksum: V087_CHECKSUM,
};
