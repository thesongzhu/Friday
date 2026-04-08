import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V066_AGENT_RUN_METADATA_SQL = `
-- V066: Persist machine-readable agent run metadata for pack/session attribution.
ALTER TABLE friday_agent_runs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
`;

const V066_CHECKSUM = computeFridayMigrationChecksum(
  V066_AGENT_RUN_METADATA_SQL,
);

export const V066_AGENT_RUN_METADATA_MIGRATION: FridaySqliteMigration = {
  version: 66,
  name: "v066-agent-run-metadata",
  sql: V066_AGENT_RUN_METADATA_SQL,
  checksum: V066_CHECKSUM,
};
