import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V021_AGENT_RUN_RESPONSE_TEXT_SUMMARY_SQL = `
-- V021: Persist final agent response text and summary
ALTER TABLE friday_agent_runs ADD COLUMN response_text TEXT;
ALTER TABLE friday_agent_runs ADD COLUMN summary TEXT;
`;

const V021_CHECKSUM = computeFridayMigrationChecksum(V021_AGENT_RUN_RESPONSE_TEXT_SUMMARY_SQL);

export const V021_AGENT_RUN_RESPONSE_TEXT_SUMMARY_MIGRATION: FridaySqliteMigration = {
  version: 21,
  name: "v021-agent-run-response-text-summary",
  sql: V021_AGENT_RUN_RESPONSE_TEXT_SUMMARY_SQL,
  checksum: V021_CHECKSUM,
};
