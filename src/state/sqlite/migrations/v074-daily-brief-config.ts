import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V074_DAILY_BRIEF_CONFIG_SQL = `
-- V074: Daily voice brief — per-user configuration (single-user system stores one row).

CREATE TABLE IF NOT EXISTS friday_brief_config (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  cron_expression TEXT NOT NULL DEFAULT '0 20 * * *',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  length TEXT NOT NULL DEFAULT 'normal' CHECK (length IN ('short','normal','long')),
  include_transcript INTEGER NOT NULL DEFAULT 0,
  language_override TEXT NOT NULL DEFAULT '',
  fallback_order_json TEXT NOT NULL DEFAULT '["wecom","telegram","email"]',
  sources_json TEXT NOT NULL,
  channels_json TEXT NOT NULL,
  tts_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const V074_CHECKSUM = computeFridayMigrationChecksum(V074_DAILY_BRIEF_CONFIG_SQL);

export const V074_DAILY_BRIEF_CONFIG_MIGRATION: FridaySqliteMigration = {
  version: 74,
  name: "v074-daily-brief-config",
  sql: V074_DAILY_BRIEF_CONFIG_SQL,
  checksum: V074_CHECKSUM,
};
