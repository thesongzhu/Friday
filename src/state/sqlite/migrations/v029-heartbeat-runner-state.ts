import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V029_HEARTBEAT_RUNNER_STATE_SQL = `
-- V029: Heartbeat runner state and run history

CREATE TABLE IF NOT EXISTS friday_heartbeat_state (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  last_run_at TEXT,
  last_action_at TEXT,
  cooldown_until TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO friday_heartbeat_state (id, last_run_at, last_action_at, cooldown_until, updated_at)
VALUES ('singleton', NULL, NULL, NULL, CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS friday_heartbeat_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'skipped', 'error')),
  reason TEXT,
  action_required INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  response_text TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friday_heartbeat_runs_started_at
  ON friday_heartbeat_runs (started_at DESC);
`;

const V029_CHECKSUM = computeFridayMigrationChecksum(V029_HEARTBEAT_RUNNER_STATE_SQL);

export const V029_HEARTBEAT_RUNNER_STATE_MIGRATION: FridaySqliteMigration = {
  version: 29,
  name: "v029-heartbeat-runner-state",
  sql: V029_HEARTBEAT_RUNNER_STATE_SQL,
  checksum: V029_CHECKSUM,
};

