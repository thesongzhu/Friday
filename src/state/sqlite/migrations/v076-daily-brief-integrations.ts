import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V076_DAILY_BRIEF_INTEGRATIONS_SQL = `
-- V076: Daily voice brief — per-integration health tracking (last success/failure).

CREATE TABLE IF NOT EXISTS friday_brief_integration_state (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('friday_history','git_repos','slack','mail','calendar','issues')
  ),
  sub_kind TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_kind, sub_kind)
);

CREATE INDEX IF NOT EXISTS idx_friday_brief_integration_state_source
  ON friday_brief_integration_state(source_kind);
`;

const V076_CHECKSUM = computeFridayMigrationChecksum(V076_DAILY_BRIEF_INTEGRATIONS_SQL);

export const V076_DAILY_BRIEF_INTEGRATIONS_MIGRATION: FridaySqliteMigration = {
  version: 76,
  name: "v076-daily-brief-integrations",
  sql: V076_DAILY_BRIEF_INTEGRATIONS_SQL,
  checksum: V076_CHECKSUM,
};
