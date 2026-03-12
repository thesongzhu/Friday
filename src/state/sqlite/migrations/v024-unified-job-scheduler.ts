import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V024_UNIFIED_JOB_SCHEDULER_SQL = `
-- V024: Unified job scheduler — persistent job state

CREATE TABLE IF NOT EXISTS friday_scheduler_jobs (
  id TEXT PRIMARY KEY,
  interval_ms INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 600000,
  catch_up_runs INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  running_at TEXT,
  last_run_at TEXT,
  last_status TEXT CHECK (last_status IN ('ok', 'error', 'timeout')),
  last_error TEXT,
  last_duration_ms INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friday_scheduler_jobs_due
  ON friday_scheduler_jobs(enabled, next_run_at);
`;

const V024_CHECKSUM = computeFridayMigrationChecksum(V024_UNIFIED_JOB_SCHEDULER_SQL);

export const V024_UNIFIED_JOB_SCHEDULER_MIGRATION: FridaySqliteMigration = {
  version: 24,
  name: "v024-unified-job-scheduler",
  sql: V024_UNIFIED_JOB_SCHEDULER_SQL,
  checksum: V024_CHECKSUM,
};
