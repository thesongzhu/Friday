import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V011_ACCESS_TOKEN_REVOCATION_SQL = `
-- V011: Persistent access token revocation (SEC-005)

CREATE TABLE IF NOT EXISTS revoked_access_tokens (
  token_id TEXT PRIMARY KEY,
  expires_at_epoch INTEGER NOT NULL,
  revoked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_access_tokens_expires
  ON revoked_access_tokens (expires_at_epoch);
`;

const V011_CHECKSUM = computeFridayMigrationChecksum(V011_ACCESS_TOKEN_REVOCATION_SQL);

export const V011_ACCESS_TOKEN_REVOCATION_MIGRATION: FridaySqliteMigration = {
  version: 11,
  name: "v011-access-token-revocation",
  sql: V011_ACCESS_TOKEN_REVOCATION_SQL,
  checksum: V011_CHECKSUM,
};
