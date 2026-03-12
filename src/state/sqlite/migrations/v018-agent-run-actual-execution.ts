import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V018_AGENT_RUN_ACTUAL_EXECUTION_SQL = `
-- V018: Persist actual routed execution metadata (provider/model/cost/usage)
ALTER TABLE friday_agent_runs
ADD COLUMN actual_execution_json TEXT;
`;

const V018_CHECKSUM = computeFridayMigrationChecksum(V018_AGENT_RUN_ACTUAL_EXECUTION_SQL);

export const V018_AGENT_RUN_ACTUAL_EXECUTION_MIGRATION: FridaySqliteMigration = {
  version: 18,
  name: "v018-agent-run-actual-execution",
  sql: V018_AGENT_RUN_ACTUAL_EXECUTION_SQL,
  checksum: V018_CHECKSUM,
};
