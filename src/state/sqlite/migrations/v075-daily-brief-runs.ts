import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V075_DAILY_BRIEF_RUNS_SQL = `
-- V075: Daily voice brief — persistent run records with retained text transcripts.

CREATE TABLE IF NOT EXISTS friday_brief_runs (
  id TEXT PRIMARY KEY,
  triggered_by TEXT NOT NULL CHECK (
    triggered_by IN ('scheduled','manual_http','manual_cli','replay')
  ),
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending','collecting','summarizing','synthesizing','delivering','delivered','skipped','failed')
  ),
  skip_reason TEXT,
  transcript TEXT,
  language TEXT,
  source_results_json TEXT NOT NULL DEFAULT '[]',
  delivery_attempts_json TEXT NOT NULL DEFAULT '[]',
  audio_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friday_brief_runs_created_at
  ON friday_brief_runs(created_at);

CREATE INDEX IF NOT EXISTS idx_friday_brief_runs_status_created_at
  ON friday_brief_runs(status, created_at);
`;

const V075_CHECKSUM = computeFridayMigrationChecksum(V075_DAILY_BRIEF_RUNS_SQL);

export const V075_DAILY_BRIEF_RUNS_MIGRATION: FridaySqliteMigration = {
  version: 75,
  name: "v075-daily-brief-runs",
  sql: V075_DAILY_BRIEF_RUNS_SQL,
  checksum: V075_CHECKSUM,
};
