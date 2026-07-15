import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

/**
 * V105: owner-bound per-category retention SETTINGS (RETENTION-R3a).
 *
 * DATA-RETENTION-001 / U9-DATA-RETENTION: local data is default-PERMANENT until
 * the user deletes it; automatic time-based cleanup is default-OFF and opt-in
 * PER CONTENT CATEGORY. This table stores ONLY the explicit owner opt-ins:
 *
 *   - A row's mere EXISTENCE means the owner enabled a time-based sweep for that
 *     content category with `after_days = N` (N a POSITIVE integer, enforced by
 *     `CHECK (after_days > 0)`).
 *   - The ABSENCE of a row is the clean disabled state = PERMANENT ("off").
 *     "Off" is therefore represented by row-absence — NEVER by a magic sentinel
 *     number (not 0, -1, 30, nor an oversized value). The schema makes a sentinel
 *     structurally impossible: `after_days` is NOT NULL and must be `> 0`.
 *
 * Owner scoping mirrors `uix_user_preferences` (v051): every row is keyed by
 * `principal_id`; the unique `(principal_id, content_category)` index gives one
 * override per owner per category with upsert-on-conflict. Deliberately a
 * DEDICATED table (not a reserved `uix_user_preferences` category) so the typed,
 * validated retention control surface is fully isolated from the generic
 * `/v1/uix/preferences` list/delete endpoints (which cast a raw `?category=`
 * string) and from the closed `FridayUserPreferenceCategory` union.
 *
 * Additive + idempotent (CREATE ... IF NOT EXISTS): removes/alters nothing.
 */
export const V105_RETENTION_SETTINGS_SQL = `
CREATE TABLE IF NOT EXISTS friday_retention_settings (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  content_category TEXT NOT NULL,
  after_days INTEGER NOT NULL CHECK (after_days > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_retention_settings_principal_category
ON friday_retention_settings(principal_id, content_category);

CREATE INDEX IF NOT EXISTS idx_friday_retention_settings_principal
ON friday_retention_settings(principal_id);
`;

const V105_CHECKSUM = computeFridayMigrationChecksum(V105_RETENTION_SETTINGS_SQL);

export const V105_RETENTION_SETTINGS_MIGRATION: FridaySqliteMigration = {
  version: 105,
  name: "v105-retention-settings",
  sql: V105_RETENTION_SETTINGS_SQL,
  checksum: V105_CHECKSUM,
};
