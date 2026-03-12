import { computeFridayMigrationChecksum } from "./friday-migration.types.js";

import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V007_SESSION_FORKS_SQL = `
-- V007: Session fork support — inherited message columns + indexes

ALTER TABLE session_messages ADD COLUMN is_inherited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_messages ADD COLUMN inherited_from_session_key TEXT;
ALTER TABLE session_messages ADD COLUMN inherited_from_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_session_messages_session_inherited_sequence
  ON session_messages(session_key, is_inherited, sequence DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_parent_status_activity
  ON sessions(parent_session_key, status, last_activity_at DESC);
`;

const V007_CHECKSUM = computeFridayMigrationChecksum(V007_SESSION_FORKS_SQL);

export const V007_SESSION_FORKS_MIGRATION: FridaySqliteMigration = {
  version: 7,
  name: "v007-session-forks",
  sql: V007_SESSION_FORKS_SQL,
  checksum: V007_CHECKSUM,
};
