import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V072_AUTH_ACCESS_TOKEN_REGISTRY_SQL = `
-- V072: Track issued auth access tokens so tokenId-based revocation can be enforced truthfully.

CREATE TABLE IF NOT EXISTS auth_access_tokens (
  token_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at_epoch INTEGER NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_access_tokens_session_id
  ON auth_access_tokens (session_id);

CREATE INDEX IF NOT EXISTS idx_auth_access_tokens_user_id
  ON auth_access_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_auth_access_tokens_expires_at_epoch
  ON auth_access_tokens (expires_at_epoch);
`;

const V072_CHECKSUM = computeFridayMigrationChecksum(V072_AUTH_ACCESS_TOKEN_REGISTRY_SQL);

export const V072_AUTH_ACCESS_TOKEN_REGISTRY_MIGRATION: FridaySqliteMigration = {
  version: 72,
  name: "v072-auth-access-token-registry",
  sql: V072_AUTH_ACCESS_TOKEN_REGISTRY_SQL,
  checksum: V072_CHECKSUM,
};
