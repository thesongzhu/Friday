import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V028_SUBAGENT_LIFECYCLE_SESSION_SEND_POLICY_SQL = `
-- V028: Sub-agent lifecycle fields + session send policy

-- Sub-agent lifecycle: requester session linkage, cleanup flags, archival deadline
ALTER TABLE friday_subagent_runs ADD COLUMN requester_session_key TEXT;
ALTER TABLE friday_subagent_runs ADD COLUMN root_run_id TEXT;
ALTER TABLE friday_subagent_runs ADD COLUMN cleanup_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE friday_subagent_runs ADD COLUMN archival_deadline TEXT;

CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_requester_session
  ON friday_subagent_runs (requester_session_key);

CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_root_run
  ON friday_subagent_runs (root_run_id);

-- Session send policy
ALTER TABLE sessions ADD COLUMN send_policy TEXT;
`;

const V028_CHECKSUM = computeFridayMigrationChecksum(V028_SUBAGENT_LIFECYCLE_SESSION_SEND_POLICY_SQL);

export const V028_SUBAGENT_LIFECYCLE_SESSION_SEND_POLICY_MIGRATION: FridaySqliteMigration = {
  version: 28,
  name: "v028-subagent-lifecycle-session-send-policy",
  sql: V028_SUBAGENT_LIFECYCLE_SESSION_SEND_POLICY_SQL,
  checksum: V028_CHECKSUM,
};
