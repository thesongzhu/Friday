import type Database from "better-sqlite3";

import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

const V070_AUTONOMY_SUBJECT_UPGRADE_STATE_SQL = `
-- V070: Persist upgrade metadata for runtime-only autonomy subjects.
`;

function applyV070AutonomySubjectUpgradeState(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS autonomy_subject_upgrade_state (
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      last_verified_at TEXT,
      last_verified_runtime_version TEXT,
      last_verified_provider_model TEXT,
      compatibility_status TEXT NOT NULL DEFAULT 'unknown',
      promotion_channel TEXT NOT NULL DEFAULT 'none',
      shadow_version_id TEXT,
      canary_stats_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subject_kind, subject_id)
    );

    CREATE INDEX IF NOT EXISTS idx_autonomy_subject_upgrade_state_kind
      ON autonomy_subject_upgrade_state(subject_kind);
  `);
}

const V070_CHECKSUM = computeFridayMigrationChecksum(V070_AUTONOMY_SUBJECT_UPGRADE_STATE_SQL);

export const V070_AUTONOMY_SUBJECT_UPGRADE_STATE_MIGRATION: FridaySqliteMigration = {
  version: 70,
  name: "v070-autonomy-subject-upgrade-state",
  sql: V070_AUTONOMY_SUBJECT_UPGRADE_STATE_SQL,
  checksum: V070_CHECKSUM,
  apply: applyV070AutonomySubjectUpgradeState,
};
