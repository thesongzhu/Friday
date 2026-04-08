import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V067_CAPABILITY_GRANTS_SQL = `
-- V067: Persist capability grants for fine-grained tool approval tracking.
CREATE TABLE IF NOT EXISTS capability_grants (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_key TEXT,
  target TEXT NOT NULL,
  surface TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  approval_provenance TEXT NOT NULL DEFAULT 'user_approval',
  tool_name TEXT,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_capability_grants_principal ON capability_grants(principal_id);
CREATE INDEX IF NOT EXISTS idx_capability_grants_active ON capability_grants(revoked_at) WHERE revoked_at IS NULL;
`;

const V067_CHECKSUM = computeFridayMigrationChecksum(
  V067_CAPABILITY_GRANTS_SQL,
);

export const V067_CAPABILITY_GRANTS_MIGRATION: FridaySqliteMigration = {
  version: 67,
  name: "v067-capability-grants",
  sql: V067_CAPABILITY_GRANTS_SQL,
  checksum: V067_CHECKSUM,
};
