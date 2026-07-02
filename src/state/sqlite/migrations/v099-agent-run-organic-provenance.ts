import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V099_AGENT_RUN_ORGANIC_PROVENANCE_SQL = `
-- V099: Persist verified operator-signature organic provenance on agent runs.

ALTER TABLE friday_agent_runs ADD COLUMN organic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE friday_agent_runs ADD COLUMN organic_principal TEXT;
ALTER TABLE friday_agent_runs ADD COLUMN organic_source TEXT;
ALTER TABLE friday_agent_runs ADD COLUMN organic_attestation_ref TEXT;
`;

const V099_CHECKSUM = computeFridayMigrationChecksum(
  V099_AGENT_RUN_ORGANIC_PROVENANCE_SQL,
);

export const V099_AGENT_RUN_ORGANIC_PROVENANCE_MIGRATION: FridaySqliteMigration = {
  version: 99,
  name: "v099-agent-run-organic-provenance",
  sql: V099_AGENT_RUN_ORGANIC_PROVENANCE_SQL,
  checksum: V099_CHECKSUM,
};
