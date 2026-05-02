import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V076_PROVIDER_OAUTH_USER_SCOPE_SQL = `
-- V076: Scope OAuth provider credentials to the authenticated Friday user.
--
-- v010 keyed OAuth credentials by provider_profile_id + oauth_provider, which made
-- one connected account global for every user of the same provider profile. Rebuild
-- the table with owner_user_id in the unique key and copy existing rows as legacy
-- global credentials.

ALTER TABLE oauth_credentials RENAME TO oauth_credentials_v010_legacy;

CREATE TABLE oauth_credentials (
  id TEXT PRIMARY KEY,
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL DEFAULT '__global__',
  oauth_provider TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  scope TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_profile_id, oauth_provider, owner_user_id)
);

INSERT INTO oauth_credentials (
  id,
  provider_profile_id,
  owner_user_id,
  oauth_provider,
  access_token_encrypted,
  refresh_token_encrypted,
  token_type,
  scope,
  expires_at,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  id,
  provider_profile_id,
  '__global__',
  oauth_provider,
  access_token_encrypted,
  refresh_token_encrypted,
  token_type,
  scope,
  expires_at,
  '{}',
  created_at,
  updated_at
FROM oauth_credentials_v010_legacy;

CREATE INDEX IF NOT EXISTS idx_oauth_credentials_provider_profile
  ON oauth_credentials(provider_profile_id);

CREATE INDEX IF NOT EXISTS idx_oauth_credentials_owner_user
  ON oauth_credentials(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_credentials_expires_at
  ON oauth_credentials(expires_at);
`;

const V076_CHECKSUM = computeFridayMigrationChecksum(V076_PROVIDER_OAUTH_USER_SCOPE_SQL);

export const V076_PROVIDER_OAUTH_USER_SCOPE_MIGRATION: FridaySqliteMigration = {
  version: 76,
  name: "v076-provider-oauth-user-scope",
  sql: V076_PROVIDER_OAUTH_USER_SCOPE_SQL,
  checksum: V076_CHECKSUM,
};
