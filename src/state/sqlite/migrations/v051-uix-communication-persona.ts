import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V051_UIX_COMMUNICATION_PERSONA_SQL = `
-- V051: persist UIX communication persona preferences.

CREATE TABLE IF NOT EXISTS uix_user_preferences (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_uix_user_preferences_principal_category_key
ON uix_user_preferences(principal_id, category, key);

CREATE INDEX IF NOT EXISTS idx_uix_user_preferences_principal_category
ON uix_user_preferences(principal_id, category);
`;

const V051_CHECKSUM = computeFridayMigrationChecksum(V051_UIX_COMMUNICATION_PERSONA_SQL);

export const V051_UIX_COMMUNICATION_PERSONA_MIGRATION: FridaySqliteMigration = {
  version: 51,
  name: "v051-uix-communication-persona",
  sql: V051_UIX_COMMUNICATION_PERSONA_SQL,
  checksum: V051_CHECKSUM,
};
