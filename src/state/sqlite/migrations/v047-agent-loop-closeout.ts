import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V047_AGENT_LOOP_CLOSEOUT_SQL = `
-- V047: supervised autonomous agent loop persistence.

CREATE TABLE IF NOT EXISTS friday_agent_loop_policy (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  auto_apply_low_risk INTEGER NOT NULL DEFAULT 1,
  max_attempts_per_fingerprint INTEGER NOT NULL DEFAULT 3,
  cooldown_minutes INTEGER NOT NULL DEFAULT 30,
  require_rollback_plan INTEGER NOT NULL DEFAULT 1,
  require_acceptance_check INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS friday_agent_loop_runs (
  loop_run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  action_id TEXT,
  fingerprint TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_tier INTEGER NOT NULL,
  approval_required INTEGER NOT NULL DEFAULT 0,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  verification_passed INTEGER,
  rollback_attempted INTEGER NOT NULL DEFAULT 0,
  rollback_succeeded INTEGER NOT NULL DEFAULT 0,
  halt_reason TEXT,
  last_error TEXT,
  lesson_id TEXT,
  correlation_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  cancelled_at TEXT,
  cooldown_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friday_agent_loop_runs_user_created
  ON friday_agent_loop_runs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_friday_agent_loop_runs_incident
  ON friday_agent_loop_runs (incident_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_friday_agent_loop_runs_action
  ON friday_agent_loop_runs (action_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_friday_agent_loop_runs_status
  ON friday_agent_loop_runs (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_friday_agent_loop_runs_fingerprint
  ON friday_agent_loop_runs (user_id, fingerprint, created_at DESC);
`;

const V047_CHECKSUM = computeFridayMigrationChecksum(V047_AGENT_LOOP_CLOSEOUT_SQL);

export const V047_AGENT_LOOP_CLOSEOUT_MIGRATION: FridaySqliteMigration = {
  version: 47,
  name: "v047-agent-loop-closeout",
  sql: V047_AGENT_LOOP_CLOSEOUT_SQL,
  checksum: V047_CHECKSUM,
};
