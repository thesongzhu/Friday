import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V040_SETUP_STATE_REVISION_SQL = `
-- V040: Add revision tracking and hash to setup state for config drift detection (OC-003).
ALTER TABLE friday_setup_state ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE friday_setup_state ADD COLUMN config_hash TEXT;
`;

const V040_CHECKSUM = computeFridayMigrationChecksum(V040_SETUP_STATE_REVISION_SQL);

export const V040_SETUP_STATE_REVISION_MIGRATION: FridaySqliteMigration = {
  version: 40,
  name: "v040-setup-state-revision",
  sql: V040_SETUP_STATE_REVISION_SQL,
  checksum: V040_CHECKSUM,
};
