import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V016_XHS_COOKIE_ENCRYPTION_SQL = `
-- V016: Encrypt XHS session cookies at rest
-- Add encrypted column and redact all legacy plaintext cookies_json values.

ALTER TABLE xhs_sessions ADD COLUMN cookies_encrypted TEXT;

UPDATE xhs_sessions
SET cookies_json = '[REDACTED]';
`;

const V016_CHECKSUM = computeFridayMigrationChecksum(V016_XHS_COOKIE_ENCRYPTION_SQL);

export const V016_XHS_COOKIE_ENCRYPTION_MIGRATION: FridaySqliteMigration = {
  version: 16,
  name: "v016-xhs-cookie-encryption",
  sql: V016_XHS_COOKIE_ENCRYPTION_SQL,
  checksum: V016_CHECKSUM,
};
