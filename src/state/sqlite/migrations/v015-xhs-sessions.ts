import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V015_XHS_SESSIONS_SQL = `
-- V015: Xiaohongshu session persistence

CREATE TABLE IF NOT EXISTS xhs_sessions (
  id              TEXT PRIMARY KEY,
  account_name    TEXT NOT NULL,
  cookies_json    TEXT NOT NULL,
  user_agent      TEXT NOT NULL,
  last_used_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_xhs_sessions_account
  ON xhs_sessions(account_name);
`;

const V015_CHECKSUM = computeFridayMigrationChecksum(V015_XHS_SESSIONS_SQL);

export const V015_XHS_SESSIONS_MIGRATION: FridaySqliteMigration = {
  version: 15,
  name: "v015-xhs-sessions",
  sql: V015_XHS_SESSIONS_SQL,
  checksum: V015_CHECKSUM,
};
