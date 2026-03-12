import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V022_AGENT_RUN_ARTIFACT_DIR_SQL = `
-- V022: Persist run artifact directory
ALTER TABLE friday_agent_runs ADD COLUMN artifact_dir TEXT;
`;

const V022_CHECKSUM = computeFridayMigrationChecksum(V022_AGENT_RUN_ARTIFACT_DIR_SQL);

export const V022_AGENT_RUN_ARTIFACT_DIR_MIGRATION: FridaySqliteMigration = {
  version: 22,
  name: "v022-agent-run-artifact-dir",
  sql: V022_AGENT_RUN_ARTIFACT_DIR_SQL,
  checksum: V022_CHECKSUM,
};
