import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V086_WORKFLOW_EVIDENCE_FAIL_CLOSED_SQL = `
-- V086: Phase 14.5C — Workflow evidence fail-closed.
--
-- Adds:
--   * workflow_runs.proof_required             — opt-in fail-closed flag.
--   * task_workflow_closeout_receipts.evidence_durability — worst-case
--     evidence status across referenced workflow runs at closeout time.
--   * task_workflow_closeout_receipts.proof_claimable — true iff every
--     required gate (incl. workflow_run_evidence_durable) passed AND
--     evidence_durability resolved to 'available'.
--
-- All three columns are nullable so legacy rows continue to work. Default
-- values preserve current behavior: proof_required defaults to 0 (ordinary
-- workflow), evidence_durability defaults to 'available', proof_claimable
-- defaults to 0 (cannot claim).

ALTER TABLE workflow_runs
  ADD COLUMN proof_required INTEGER DEFAULT 0;

ALTER TABLE task_workflow_closeout_receipts
  ADD COLUMN evidence_durability TEXT DEFAULT 'available';

ALTER TABLE task_workflow_closeout_receipts
  ADD COLUMN proof_claimable INTEGER DEFAULT 0;
`;

const V086_CHECKSUM = computeFridayMigrationChecksum(
  V086_WORKFLOW_EVIDENCE_FAIL_CLOSED_SQL,
);

export const V086_WORKFLOW_EVIDENCE_FAIL_CLOSED_MIGRATION: FridaySqliteMigration = {
  version: 86,
  name: "v086-workflow-evidence-fail-closed",
  sql: V086_WORKFLOW_EVIDENCE_FAIL_CLOSED_SQL,
  checksum: V086_CHECKSUM,
};
