import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V041_CHANNEL_AGENT_BINDINGS_SQL = `
-- V041: Channel-to-agent routing bindings (OC-017).
CREATE TABLE IF NOT EXISTS channel_agent_bindings (
  id              TEXT PRIMARY KEY,
  channel_kind    TEXT NOT NULL,
  channel_id      TEXT NOT NULL DEFAULT '*',
  agent_config_key TEXT NOT NULL DEFAULT 'default',
  priority        INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(channel_kind, channel_id)
);
`;

const V041_CHECKSUM = computeFridayMigrationChecksum(V041_CHANNEL_AGENT_BINDINGS_SQL);

export const V041_CHANNEL_AGENT_BINDINGS_MIGRATION: FridaySqliteMigration = {
  version: 41,
  name: "v041-channel-agent-bindings",
  sql: V041_CHANNEL_AGENT_BINDINGS_SQL,
  checksum: V041_CHECKSUM,
};
