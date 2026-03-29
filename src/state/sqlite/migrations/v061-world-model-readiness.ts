import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V061_WORLD_MODEL_READINESS_SQL = `
-- V061: World Model Readiness — episodic memory, world entities,
-- state snapshots, and learned patterns.
--
-- These tables form the data foundation for Friday's evolution
-- toward personal World AI. All tables are append-only by default
-- and store only non-sensitive summaries (no raw tool arguments
-- or user content).

-- ── Episodes (structured action→observation trajectories) ───────

CREATE TABLE IF NOT EXISTS friday_episodes (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  task_intent        TEXT NOT NULL,
  task_profile       TEXT,
  outcome            TEXT NOT NULL CHECK (outcome IN ('success','failure','partial')),
  steps_json         TEXT NOT NULL DEFAULT '[]',
  tool_sequence_json TEXT NOT NULL DEFAULT '[]',
  duration_ms        INTEGER NOT NULL DEFAULT 0,
  context_files_json TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_episodes_user_created
  ON friday_episodes(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_episodes_outcome
  ON friday_episodes(outcome);
CREATE INDEX IF NOT EXISTS idx_episodes_run
  ON friday_episodes(run_id);

-- ── World Entities (structured knowledge about user's world) ────

CREATE TABLE IF NOT EXISTS friday_world_entities (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  type            TEXT NOT NULL,
  name            TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  relations_json  TEXT NOT NULL DEFAULT '[]',
  last_mentioned  TEXT NOT NULL DEFAULT (datetime('now')),
  mention_count   INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_world_entities_user_type
  ON friday_world_entities(user_id, type);
CREATE INDEX IF NOT EXISTS idx_world_entities_user_name
  ON friday_world_entities(user_id, name);

-- ── World State Snapshots (point-in-time state captures) ────────

CREATE TABLE IF NOT EXISTS friday_world_state_snapshots (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_world_state_user
  ON friday_world_state_snapshots(user_id, created_at);

-- ── Learned Patterns (extracted from episode trajectories) ──────

CREATE TABLE IF NOT EXISTS friday_learned_patterns (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('tool_sequence','failure_mode','temporal','preference')),
  description  TEXT NOT NULL,
  pattern_json TEXT NOT NULL DEFAULT '{}',
  confidence   REAL NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learned_patterns_user_kind
  ON friday_learned_patterns(user_id, kind);
`;

const V061_CHECKSUM = computeFridayMigrationChecksum(V061_WORLD_MODEL_READINESS_SQL);

export const V061_WORLD_MODEL_READINESS_MIGRATION: FridaySqliteMigration = {
  version: 61,
  name: "v061-world-model-readiness",
  sql: V061_WORLD_MODEL_READINESS_SQL,
  checksum: V061_CHECKSUM,
};
