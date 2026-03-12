import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V036_WORKFLOW_INDEXES_SQL = `
-- V036: Add missing indexes on workflow query paths.
-- workflow_runs(workflow_id) is queried for per-workflow run listing.
-- workflow_artifacts(run_id) is queried for artifact lookup and cleanup.

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id
  ON workflow_runs (workflow_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_run_id
  ON workflow_artifacts (run_id);
`;

const V036_CHECKSUM = computeFridayMigrationChecksum(V036_WORKFLOW_INDEXES_SQL);

export const V036_WORKFLOW_INDEXES_MIGRATION: FridaySqliteMigration = {
  version: 36,
  name: "v036-workflow-indexes",
  sql: V036_WORKFLOW_INDEXES_SQL,
  checksum: V036_CHECKSUM,
};
