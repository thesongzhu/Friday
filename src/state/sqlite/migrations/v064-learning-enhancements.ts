import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V064_LEARNING_ENHANCEMENTS_SQL = `
-- V064: Add emotional valence and situational metadata to preference facts,
-- plus a tracking table for memory consolidation.

ALTER TABLE preference_facts ADD COLUMN emotional_valence REAL DEFAULT NULL;
ALTER TABLE preference_facts ADD COLUMN metadata_json TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS friday_consolidated_episodes (
  episode_id TEXT PRIMARY KEY,
  consolidated_at TEXT NOT NULL,
  target_memory_id TEXT,
  FOREIGN KEY (episode_id) REFERENCES friday_episodes(id) ON DELETE CASCADE
);
`;

const V064_CHECKSUM = computeFridayMigrationChecksum(V064_LEARNING_ENHANCEMENTS_SQL);

export const V064_LEARNING_ENHANCEMENTS_MIGRATION: FridaySqliteMigration = {
  version: 64,
  name: "v064-learning-enhancements",
  sql: V064_LEARNING_ENHANCEMENTS_SQL,
  checksum: V064_CHECKSUM,
};
