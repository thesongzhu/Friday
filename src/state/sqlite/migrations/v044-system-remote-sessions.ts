import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V044_SYSTEM_REMOTE_SESSIONS_SQL = `
-- V044: Friday system remote session persistence and lifecycle tracking.

CREATE TABLE IF NOT EXISTS friday_system_remote_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT,
  closed_reason TEXT,
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_friday_system_remote_sessions_device
  ON friday_system_remote_sessions (device_id, connected_at DESC);

CREATE INDEX IF NOT EXISTS idx_friday_system_remote_sessions_status
  ON friday_system_remote_sessions (status, last_seen_at DESC);
`;

const V044_CHECKSUM = computeFridayMigrationChecksum(V044_SYSTEM_REMOTE_SESSIONS_SQL);

export const V044_SYSTEM_REMOTE_SESSIONS_MIGRATION: FridaySqliteMigration = {
  version: 44,
  name: "v044-system-remote-sessions",
  sql: V044_SYSTEM_REMOTE_SESSIONS_SQL,
  checksum: V044_CHECKSUM,
};
