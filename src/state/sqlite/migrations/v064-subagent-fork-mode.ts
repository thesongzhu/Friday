import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V064_SUBAGENT_FORK_MODE_SQL = `
-- V064: Persist explicit subagent spawn mode and fork lineage metadata.

ALTER TABLE friday_subagent_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'fresh';
ALTER TABLE friday_subagent_runs ADD COLUMN forked_from_message_id TEXT;
ALTER TABLE friday_subagent_runs ADD COLUMN inherited_message_count INTEGER;
`;

const V064_CHECKSUM = computeFridayMigrationChecksum(V064_SUBAGENT_FORK_MODE_SQL);

export const V064_SUBAGENT_FORK_MODE_MIGRATION: FridaySqliteMigration = {
  version: 64,
  name: "v064-subagent-fork-mode",
  sql: V064_SUBAGENT_FORK_MODE_SQL,
  checksum: V064_CHECKSUM,
};
