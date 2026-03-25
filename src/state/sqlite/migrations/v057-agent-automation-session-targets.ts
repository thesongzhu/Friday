import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V057_AGENT_AUTOMATION_SESSION_TARGETS_SQL = `
-- V057: Persist automation session-target intent for isolated, named,
-- and current-session-aware agent automation runs.

ALTER TABLE friday_agent_automations
  ADD COLUMN session_target_kind TEXT
    CHECK (session_target_kind IN ('isolated', 'named', 'current'));
ALTER TABLE friday_agent_automations
  ADD COLUMN session_target_session_key TEXT;

UPDATE friday_agent_automations
SET session_target_kind = 'isolated'
WHERE session_target_kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_friday_agent_automations_session_target_kind
  ON friday_agent_automations (session_target_kind);
`;

const V057_CHECKSUM = computeFridayMigrationChecksum(V057_AGENT_AUTOMATION_SESSION_TARGETS_SQL);

export const V057_AGENT_AUTOMATION_SESSION_TARGETS_MIGRATION: FridaySqliteMigration = {
  version: 57,
  name: "v057-agent-automation-session-targets",
  sql: V057_AGENT_AUTOMATION_SESSION_TARGETS_SQL,
  checksum: V057_CHECKSUM,
};
