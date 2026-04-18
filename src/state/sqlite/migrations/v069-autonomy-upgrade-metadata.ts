import type Database from "better-sqlite3";

import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

const V069_AUTONOMY_UPGRADE_METADATA_SQL = `
-- V069: Persist autonomy upgrade metadata for upgrade-capable subjects.
`;

function hasTableColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function addColumnIfMissing(
  db: Database.Database,
  tableName: string,
  columnName: string,
  columnSql: string,
): void {
  if (hasTableColumn(db, tableName, columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql};`);
}

function applyV069AutonomyUpgradeMetadata(db: Database.Database): void {
  const sharedColumns = [
    ["last_verified_at", "last_verified_at TEXT"],
    ["last_verified_runtime_version", "last_verified_runtime_version TEXT"],
    ["last_verified_provider_model", "last_verified_provider_model TEXT"],
    ["compatibility_status", "compatibility_status TEXT NOT NULL DEFAULT 'unknown'"],
    ["promotion_channel", "promotion_channel TEXT NOT NULL DEFAULT 'none'"],
    ["shadow_version_id", "shadow_version_id TEXT"],
    ["canary_stats_json", "canary_stats_json TEXT NOT NULL DEFAULT '{}'"],
  ] as const;

  for (const [columnName, columnSql] of sharedColumns) {
    addColumnIfMissing(db, "skills", columnName, columnSql);
    addColumnIfMissing(db, "workflows", columnName, columnSql);
    addColumnIfMissing(db, "provider_profiles", columnName, columnSql);
  }

  for (const [columnName, columnSql] of sharedColumns.slice(1)) {
    addColumnIfMissing(db, "plugins", columnName, columnSql);
  }
}

const V069_CHECKSUM = computeFridayMigrationChecksum(V069_AUTONOMY_UPGRADE_METADATA_SQL);

export const V069_AUTONOMY_UPGRADE_METADATA_MIGRATION: FridaySqliteMigration = {
  version: 69,
  name: "v069-autonomy-upgrade-metadata",
  sql: V069_AUTONOMY_UPGRADE_METADATA_SQL,
  checksum: V069_CHECKSUM,
  apply: applyV069AutonomyUpgradeMetadata,
};
