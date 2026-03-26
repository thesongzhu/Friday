import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V058_AGENT_RUN_CONTEXT_PROFILE_SQL = `
-- V058: Persist agent context-cost summary and resolved task profile
ALTER TABLE friday_agent_runs ADD COLUMN context_cost_summary_json TEXT;
ALTER TABLE friday_agent_runs ADD COLUMN task_profile_json TEXT;
`;

const V058_CHECKSUM = computeFridayMigrationChecksum(V058_AGENT_RUN_CONTEXT_PROFILE_SQL);

export const V058_AGENT_RUN_CONTEXT_PROFILE_MIGRATION: FridaySqliteMigration = {
  version: 58,
  name: "v058-agent-run-context-profile",
  sql: V058_AGENT_RUN_CONTEXT_PROFILE_SQL,
  checksum: V058_CHECKSUM,
};
