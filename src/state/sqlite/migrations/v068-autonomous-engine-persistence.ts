import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V068_AUTONOMOUS_ENGINE_PERSISTENCE_SQL = `
-- V068: Persist autonomous engine goals, steps, and iterations to survive restarts.

CREATE TABLE IF NOT EXISTS friday_autonomous_goals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'normal',
  source TEXT NOT NULL DEFAULT 'user',
  description TEXT NOT NULL,
  success_criteria_json TEXT,
  max_iterations INTEGER NOT NULL DEFAULT 50,
  timeout_ms INTEGER NOT NULL DEFAULT 300000,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  step_ids_json TEXT NOT NULL DEFAULT '[]',
  current_step_index INTEGER NOT NULL DEFAULT 0,
  parent_goal_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_autonomous_goals_status ON friday_autonomous_goals(status);
CREATE INDEX IF NOT EXISTS idx_autonomous_goals_parent ON friday_autonomous_goals(parent_goal_id);

CREATE TABLE IF NOT EXISTS friday_autonomous_steps (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  domain TEXT NOT NULL,
  instruction TEXT NOT NULL,
  planned_action_json TEXT,
  verification_json TEXT,
  max_retries INTEGER NOT NULL DEFAULT 3,
  retry_count INTEGER NOT NULL DEFAULT 0,
  observations_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT,
  completed_at TEXT,
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_autonomous_steps_goal ON friday_autonomous_steps(goal_id);

CREATE TABLE IF NOT EXISTS friday_autonomous_iterations (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  observations_json TEXT NOT NULL DEFAULT '[]',
  reasoning TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  result_json TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  usage_input INTEGER,
  usage_output INTEGER
);
CREATE INDEX IF NOT EXISTS idx_autonomous_iterations_goal ON friday_autonomous_iterations(goal_id);
CREATE INDEX IF NOT EXISTS idx_autonomous_iterations_step ON friday_autonomous_iterations(step_id);
`;

const V068_CHECKSUM = computeFridayMigrationChecksum(
  V068_AUTONOMOUS_ENGINE_PERSISTENCE_SQL,
);

export const V068_AUTONOMOUS_ENGINE_PERSISTENCE_MIGRATION: FridaySqliteMigration = {
  version: 68,
  name: "v068-autonomous-engine-persistence",
  sql: V068_AUTONOMOUS_ENGINE_PERSISTENCE_SQL,
  checksum: V068_CHECKSUM,
};
