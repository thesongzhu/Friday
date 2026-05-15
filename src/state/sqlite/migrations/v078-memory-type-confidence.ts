import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V078_MEMORY_TYPE_CONFIDENCE_SQL = `
-- V078: Add memory_type and confidence columns to memory_items.
--
-- Initiative D.1 defined memoryType and confidence in TypeScript types
-- but the DB schema and persistence path never included them.  This
-- migration adds the columns so they survive persistence round-trips.

ALTER TABLE memory_items ADD COLUMN memory_type TEXT;
ALTER TABLE memory_items ADD COLUMN confidence REAL;
ALTER TABLE memory_items ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_items ADD COLUMN last_accessed_at TEXT;
`;

const V078_CHECKSUM = computeFridayMigrationChecksum(V078_MEMORY_TYPE_CONFIDENCE_SQL);

export const V078_MEMORY_TYPE_CONFIDENCE_MIGRATION: FridaySqliteMigration = {
  version: 78,
  name: "v078-memory-type-confidence",
  sql: V078_MEMORY_TYPE_CONFIDENCE_SQL,
  checksum: V078_CHECKSUM,
};
