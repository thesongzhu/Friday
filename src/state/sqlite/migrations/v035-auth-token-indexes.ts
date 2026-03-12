import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V035_AUTH_TOKEN_INDEXES_SQL = `
-- V035: Add missing indexes on authentication hot-path tables.
-- auth_sessions.refresh_token_hash is queried on every token refresh.
-- api_tokens.token_hash is queried on every API request authentication.
-- auth_sessions(user_id, revoked_at) is used for bulk revocation.

CREATE INDEX IF NOT EXISTS idx_auth_sessions_refresh_token_hash
  ON auth_sessions (refresh_token_hash);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_revoked
  ON auth_sessions (user_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash
  ON api_tokens (token_hash);
`;

const V035_CHECKSUM = computeFridayMigrationChecksum(V035_AUTH_TOKEN_INDEXES_SQL);

export const V035_AUTH_TOKEN_INDEXES_MIGRATION: FridaySqliteMigration = {
  version: 35,
  name: "v035-auth-token-indexes",
  sql: V035_AUTH_TOKEN_INDEXES_SQL,
  checksum: V035_CHECKSUM,
};
