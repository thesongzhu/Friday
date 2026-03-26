import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V057_AGENT_RUN_CONTEXT_PROFILE_SQL = `
-- V057: Persist agent context-cost summary and resolved task profile
ALTER TABLE friday_agent_runs ADD COLUMN context_cost_summary_json TEXT;
ALTER TABLE friday_agent_runs ADD COLUMN task_profile_json TEXT;
`;

const V057_CHECKSUM = computeFridayMigrationChecksum(V057_AGENT_RUN_CONTEXT_PROFILE_SQL);

export const V057_AGENT_RUN_CONTEXT_PROFILE_MIGRATION: FridaySqliteMigration = {
  version: 57,
  name: "v057-agent-run-context-profile",
  sql: V057_AGENT_RUN_CONTEXT_PROFILE_SQL,
  checksum: V057_CHECKSUM,
};
