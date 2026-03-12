import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V020_AGENT_RUN_CONSTRAINTS_SQL = `
-- V020: Persist per-run execution constraints
ALTER TABLE friday_agent_runs
ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '{}';
`;

const V020_CHECKSUM = computeFridayMigrationChecksum(V020_AGENT_RUN_CONSTRAINTS_SQL);

export const V020_AGENT_RUN_CONSTRAINTS_MIGRATION: FridaySqliteMigration = {
  version: 20,
  name: "v020-agent-run-constraints",
  sql: V020_AGENT_RUN_CONSTRAINTS_SQL,
  checksum: V020_CHECKSUM,
};
