import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V062_UIX_GUIDED_CONTEXTS_SQL = `
-- V062: Persist /assistant guided wizard contexts so they survive process restarts.

CREATE TABLE IF NOT EXISTS uix_guided_contexts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step_index INTEGER NOT NULL DEFAULT 0,
  completed_steps_json TEXT NOT NULL DEFAULT '[]',
  session_data_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_uix_guided_contexts_principal_updated
  ON uix_guided_contexts(principal_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_uix_guided_contexts_workflow_status
  ON uix_guided_contexts(workflow_id, status);
`;

const V062_CHECKSUM = computeFridayMigrationChecksum(V062_UIX_GUIDED_CONTEXTS_SQL);

export const V062_UIX_GUIDED_CONTEXTS_MIGRATION: FridaySqliteMigration = {
  version: 62,
  name: "v062-uix-guided-contexts",
  sql: V062_UIX_GUIDED_CONTEXTS_SQL,
  checksum: V062_CHECKSUM,
};
