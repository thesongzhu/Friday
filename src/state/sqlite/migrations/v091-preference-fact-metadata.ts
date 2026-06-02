import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V091_PREFERENCE_FACT_METADATA_SQL = `
-- V091: Preference fact provenance metadata.
--
-- Preference facts already expose confidence/evidence boundaries, but the
-- durable table had no place to preserve approval provenance. This nullable
-- JSON column lets Review Center-approved learned facts carry their review
-- boundary without changing legacy rows.

ALTER TABLE preference_facts
  ADD COLUMN metadata_json TEXT;
`;

const V091_CHECKSUM = computeFridayMigrationChecksum(
  V091_PREFERENCE_FACT_METADATA_SQL,
);

export const V091_PREFERENCE_FACT_METADATA_MIGRATION: FridaySqliteMigration = {
  version: 91,
  name: "v091-preference-fact-metadata",
  sql: V091_PREFERENCE_FACT_METADATA_SQL,
  checksum: V091_CHECKSUM,
};
