import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V074_CONTROLLED_AUTONOMY_CLOSED_LOOPS_SQL = `
-- V074: Persist controlled autonomy policies, capability acquisition,
-- standing goals, agenda runs, and strategy-only improvement records.

CREATE TABLE IF NOT EXISTS friday_autonomy_policy (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  risk_switches_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  evidence_retention_days INTEGER NOT NULL DEFAULT 90,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS friday_capability_acquisition_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL,
  missing_capabilities_json TEXT NOT NULL,
  matrix_summary_json TEXT NOT NULL,
  policy_snapshot_json TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  human_blockers_json TEXT NOT NULL,
  approval_reasons_json TEXT NOT NULL,
  verification_results_json TEXT NOT NULL,
  registered_capabilities_json TEXT NOT NULL,
  execution_suggestion_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friday_capability_acquisition_runs_user_status
  ON friday_capability_acquisition_runs (user_id, status, updated_at);

CREATE TABLE IF NOT EXISTS friday_standing_goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  triggers_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  risk_policy_json TEXT NOT NULL,
  success_criteria_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friday_standing_goals_user_status
  ON friday_standing_goals (user_id, status, updated_at);

CREATE TABLE IF NOT EXISTS friday_agenda_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  standing_goal_id TEXT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL,
  approval_required INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (standing_goal_id) REFERENCES friday_standing_goals(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_friday_agenda_items_user_status
  ON friday_agenda_items (user_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_friday_agenda_items_standing_goal
  ON friday_agenda_items (standing_goal_id, created_at);

CREATE TABLE IF NOT EXISTS friday_agenda_runs (
  id TEXT PRIMARY KEY,
  agenda_item_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  capability_check_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  cost_json TEXT NOT NULL,
  rollback_json TEXT NOT NULL,
  improvement_records_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (agenda_item_id) REFERENCES friday_agenda_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_friday_agenda_runs_user_status
  ON friday_agenda_runs (user_id, status, started_at);

CREATE INDEX IF NOT EXISTS idx_friday_agenda_runs_item
  ON friday_agenda_runs (agenda_item_id, started_at);

CREATE TABLE IF NOT EXISTS friday_improvement_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_run_id TEXT,
  source_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  summary TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friday_improvement_records_user_created
  ON friday_improvement_records (user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_friday_improvement_records_target
  ON friday_improvement_records (target_type, target_id);
`;

const V074_CHECKSUM = computeFridayMigrationChecksum(
  V074_CONTROLLED_AUTONOMY_CLOSED_LOOPS_SQL,
);

export const V074_CONTROLLED_AUTONOMY_CLOSED_LOOPS_MIGRATION: FridaySqliteMigration = {
  version: 74,
  name: "v074-controlled-autonomy-closed-loops",
  sql: V074_CONTROLLED_AUTONOMY_CLOSED_LOOPS_SQL,
  checksum: V074_CHECKSUM,
};
