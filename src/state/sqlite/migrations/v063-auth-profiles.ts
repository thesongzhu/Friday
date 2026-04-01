import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V063_AUTH_PROFILES_SQL = `
-- V063: Persist provider auth profiles so credential identity and selection can
-- evolve independently from provider config.

CREATE TABLE IF NOT EXISTS auth_profiles (
  id TEXT PRIMARY KEY,
  provider_profile_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  display_label TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  key_source_json TEXT,
  oauth_provider TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON DELETE CASCADE,
  UNIQUE(provider_profile_id, profile_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_profiles_active_provider
  ON auth_profiles(provider_profile_id)
  WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS idx_auth_profiles_provider_updated
  ON auth_profiles(provider_profile_id, updated_at DESC);
`;

const V063_CHECKSUM = computeFridayMigrationChecksum(V063_AUTH_PROFILES_SQL);

export const V063_AUTH_PROFILES_MIGRATION: FridaySqliteMigration = {
  version: 63,
  name: "v063-auth-profiles",
  sql: V063_AUTH_PROFILES_SQL,
  checksum: V063_CHECKSUM,
};
