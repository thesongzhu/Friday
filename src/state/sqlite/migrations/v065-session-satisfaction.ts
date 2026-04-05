import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V065_SESSION_SATISFACTION_SQL = `
-- V065: Session satisfaction scoring and digital individuation stage tracking.

CREATE TABLE IF NOT EXISTS friday_session_satisfaction (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0.0,
  signal_count INTEGER NOT NULL DEFAULT 0,
  positive_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  neutral_count INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_satisfaction_user
  ON friday_session_satisfaction(user_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS friday_individuation_state (
  user_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT 'stranger',
  fact_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  average_satisfaction REAL NOT NULL DEFAULT 0.0,
  learned_persona_dimensions INTEGER NOT NULL DEFAULT 0,
  stage_entered_at TEXT NOT NULL,
  previous_stage TEXT,
  computed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const V065_CHECKSUM = computeFridayMigrationChecksum(V065_SESSION_SATISFACTION_SQL);

export const V065_SESSION_SATISFACTION_MIGRATION: FridaySqliteMigration = {
  version: 65,
  name: "v065-session-satisfaction",
  sql: V065_SESSION_SATISFACTION_SQL,
  checksum: V065_CHECKSUM,
};
