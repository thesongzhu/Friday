import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V010_PROVIDER_OAUTH_CREDENTIALS_SQL = `
-- V010: OAuth credentials for provider profiles

CREATE TABLE IF NOT EXISTS oauth_credentials (
  id TEXT PRIMARY KEY,
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  oauth_provider TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  scope TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_profile_id, oauth_provider)
);

CREATE INDEX IF NOT EXISTS idx_oauth_credentials_provider_profile
  ON oauth_credentials(provider_profile_id);

CREATE INDEX IF NOT EXISTS idx_oauth_credentials_expires_at
  ON oauth_credentials(expires_at);
`;

const V010_CHECKSUM = computeFridayMigrationChecksum(V010_PROVIDER_OAUTH_CREDENTIALS_SQL);

export const V010_PROVIDER_OAUTH_CREDENTIALS_MIGRATION: FridaySqliteMigration = {
  version: 10,
  name: "v010-provider-oauth-credentials",
  sql: V010_PROVIDER_OAUTH_CREDENTIALS_SQL,
  checksum: V010_CHECKSUM,
};
