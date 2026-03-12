import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V013_SUBAGENT_RUNS_SQL = `
-- V013: Sub-agent runs

CREATE TABLE IF NOT EXISTS friday_subagent_runs (
  id                  TEXT PRIMARY KEY,
  parent_run_id       TEXT NOT NULL,
  parent_session_key  TEXT NOT NULL,
  child_run_id        TEXT NOT NULL DEFAULT '',
  child_session_key   TEXT NOT NULL,
  task                TEXT NOT NULL,
  label               TEXT,
  model               TEXT,
  depth               INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  outcome             TEXT,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT,
  duration_ms         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_parent
  ON friday_subagent_runs (parent_run_id);

CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_status
  ON friday_subagent_runs (status);

CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_created
  ON friday_subagent_runs (created_at);

CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_child
  ON friday_subagent_runs (child_run_id);
`;

const V013_CHECKSUM = computeFridayMigrationChecksum(V013_SUBAGENT_RUNS_SQL);

export const V013_SUBAGENT_RUNS_MIGRATION: FridaySqliteMigration = {
  version: 13,
  name: "v013-subagent-runs",
  sql: V013_SUBAGENT_RUNS_SQL,
  checksum: V013_CHECKSUM,
};
