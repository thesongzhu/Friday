import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

/**
 * V026: Memory file sync — external-sync bookkeeping.
 *
 * Adds columns to memory_file_sync_state for tracking file mtime and
 * exported hash, enabling loop suppression when the file watcher detects
 * changes that the service itself wrote.
 */
export const V026_MEMORY_FILE_SYNC_EXTERNAL_SQL = `
-- V026: External sync bookkeeping for file watcher loop suppression

ALTER TABLE memory_file_sync_state ADD COLUMN last_exported_hash TEXT;
ALTER TABLE memory_file_sync_state ADD COLUMN last_exported_mtime_ms INTEGER;
`;

const V026_CHECKSUM = computeFridayMigrationChecksum(V026_MEMORY_FILE_SYNC_EXTERNAL_SQL);

export const V026_MEMORY_FILE_SYNC_EXTERNAL_MIGRATION: FridaySqliteMigration = {
  version: 26,
  name: "v026-memory-file-sync-external",
  sql: V026_MEMORY_FILE_SYNC_EXTERNAL_SQL,
  checksum: V026_CHECKSUM,
};
