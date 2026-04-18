import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V071_AUTONOMOUS_STEP_VERIFICATION_PROVENANCE_SQL = `
-- V071: Persist autonomous step verification provenance for deterministic-vs-LLM readback.

ALTER TABLE friday_autonomous_steps ADD COLUMN verification_method TEXT;
ALTER TABLE friday_autonomous_steps ADD COLUMN verification_actual TEXT;
ALTER TABLE friday_autonomous_steps ADD COLUMN verification_pattern_family TEXT;
`;

const V071_CHECKSUM = computeFridayMigrationChecksum(
  V071_AUTONOMOUS_STEP_VERIFICATION_PROVENANCE_SQL,
);

export const V071_AUTONOMOUS_STEP_VERIFICATION_PROVENANCE_MIGRATION: FridaySqliteMigration = {
  version: 71,
  name: "v071-autonomous-step-verification-provenance",
  sql: V071_AUTONOMOUS_STEP_VERIFICATION_PROVENANCE_SQL,
  checksum: V071_CHECKSUM,
};
