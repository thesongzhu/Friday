import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V060_UIX_ONBOARDING_SESSIONS_SQL = `
-- V060: Persist onboarding session progress so it survives process restarts.

CREATE TABLE IF NOT EXISTS uix_onboarding_sessions (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started',
  step_progress TEXT NOT NULL DEFAULT '[]',
  current_step_index INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_uix_onboarding_flow_principal
  ON uix_onboarding_sessions(flow_id, principal_id);
`;

const V060_CHECKSUM = computeFridayMigrationChecksum(V060_UIX_ONBOARDING_SESSIONS_SQL);

export const V060_UIX_ONBOARDING_SESSIONS_MIGRATION: FridaySqliteMigration = {
  version: 60,
  name: "v060-uix-onboarding-sessions",
  sql: V060_UIX_ONBOARDING_SESSIONS_SQL,
  checksum: V060_CHECKSUM,
};
