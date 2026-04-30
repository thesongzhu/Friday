import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V075_REFLEX_LOOP_ONBOARDING_SQL = `
-- V075: Friday Reflex Loop candidates and day-0 onboarding state.

CREATE TABLE IF NOT EXISTS friday_reflex_candidates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('memory', 'preference', 'recipe', 'skill', 'workflow', 'fix', 'test_policy')),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'testing', 'ready_for_review', 'approved', 'rejected', 'dismissed', 'failed', 'superseded')),
  origin TEXT NOT NULL CHECK (origin IN ('onboarding', 'channel', 'operate', 'post_run', 'cold_start', 'import', 'curator')),
  source_run_id TEXT,
  session_key TEXT,
  channel_kind TEXT,
  channel_user_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0,
  risk_tier INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_friday_reflex_candidates_user_status
  ON friday_reflex_candidates (user_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_friday_reflex_candidates_user_kind
  ON friday_reflex_candidates (user_id, kind, updated_at);

CREATE INDEX IF NOT EXISTS idx_friday_reflex_candidates_source_run
  ON friday_reflex_candidates (source_run_id);

CREATE TABLE IF NOT EXISTS friday_reflex_onboarding_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not_started', 'active', 'completed', 'dismissed')),
  active_question_id TEXT,
  primary_channel_kind TEXT,
  primary_channel_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  dismissed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_reflex_onboarding_sessions_user
  ON friday_reflex_onboarding_sessions (user_id);

CREATE TABLE IF NOT EXISTS friday_reflex_onboarding_answers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('answered', 'skipped')),
  answer_json TEXT NOT NULL,
  source_surface TEXT NOT NULL CHECK (source_surface IN ('channel', 'operate', 'review_center')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES friday_reflex_onboarding_sessions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_reflex_onboarding_answers_session_question
  ON friday_reflex_onboarding_answers (session_id, question_id);

CREATE INDEX IF NOT EXISTS idx_friday_reflex_onboarding_answers_user_question
  ON friday_reflex_onboarding_answers (user_id, question_id);
`;

const V075_CHECKSUM = computeFridayMigrationChecksum(V075_REFLEX_LOOP_ONBOARDING_SQL);

export const V075_REFLEX_LOOP_ONBOARDING_MIGRATION: FridaySqliteMigration = {
  version: 75,
  name: "v075-reflex-loop-onboarding",
  sql: V075_REFLEX_LOOP_ONBOARDING_SQL,
  checksum: V075_CHECKSUM,
};
