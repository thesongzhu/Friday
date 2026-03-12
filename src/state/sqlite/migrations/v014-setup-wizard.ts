import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V014_SETUP_WIZARD_SQL = `
-- V014: Setup wizard state

CREATE TABLE IF NOT EXISTS friday_setup_state (
  id                  TEXT PRIMARY KEY DEFAULT 'singleton',
  setup_completed_at  TEXT,
  completed_steps     TEXT NOT NULL DEFAULT '[]',
  skipped_steps       TEXT NOT NULL DEFAULT '[]',
  network_mode        TEXT NOT NULL DEFAULT 'local',
  network_host        TEXT NOT NULL DEFAULT '127.0.0.1',
  network_port        INTEGER NOT NULL DEFAULT 3141,
  channels_json       TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Seed the singleton row so GET queries always return a result
INSERT OR IGNORE INTO friday_setup_state (id, created_at, updated_at)
  VALUES ('singleton', datetime('now'), datetime('now'));
`;

const V014_CHECKSUM = computeFridayMigrationChecksum(V014_SETUP_WIZARD_SQL);

export const V014_SETUP_WIZARD_MIGRATION: FridaySqliteMigration = {
  version: 14,
  name: "v014-setup-wizard",
  sql: V014_SETUP_WIZARD_SQL,
  checksum: V014_CHECKSUM,
};
