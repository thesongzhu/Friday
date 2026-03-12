import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V012_AGENT_RUNTIME_SQL = `
-- V012: Agent runtime — runs and automations

CREATE TABLE IF NOT EXISTS friday_agent_runs (
  id            TEXT PRIMARY KEY,
  task          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  session_key   TEXT NOT NULL,
  provider_id   TEXT,
  model         TEXT,
  attempt       INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  artifacts     TEXT,
  test_results  TEXT,
  error_code    TEXT,
  error_message TEXT,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT,
  duration_ms   INTEGER,
  usage_input   INTEGER,
  usage_output  INTEGER,
  cost_usd      REAL
);

CREATE INDEX IF NOT EXISTS idx_friday_agent_runs_status
  ON friday_agent_runs (status);

CREATE INDEX IF NOT EXISTS idx_friday_agent_runs_created
  ON friday_agent_runs (created_at);

CREATE TABLE IF NOT EXISTS friday_agent_automations (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  source_run_id   TEXT REFERENCES friday_agent_runs(id),
  task_template   TEXT NOT NULL,
  variables       TEXT,
  skill_ids       TEXT,
  workflow_ids    TEXT,
  trigger_id      TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_id     TEXT,
  last_run_at     TEXT,
  run_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friday_agent_automations_enabled
  ON friday_agent_automations (enabled);
`;

const V012_CHECKSUM = computeFridayMigrationChecksum(V012_AGENT_RUNTIME_SQL);

export const V012_AGENT_RUNTIME_MIGRATION: FridaySqliteMigration = {
  version: 12,
  name: "v012-agent-runtime",
  sql: V012_AGENT_RUNTIME_SQL,
  checksum: V012_CHECKSUM,
};
