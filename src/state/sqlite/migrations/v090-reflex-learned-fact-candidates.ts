import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V090_REFLEX_LEARNED_FACT_CANDIDATES_SQL = `
-- V090: Permit dedicated learned_fact Reflex review candidates.
--
-- V075 created friday_reflex_candidates.kind with a CHECK constraint over the
-- then-known candidate kinds. SQLite cannot ALTER an existing CHECK
-- constraint, so this migration recreates the table with learned_fact added and
-- copies existing rows verbatim. Approval behavior remains review-gated in the
-- Reflex service; this only makes the storage layer accept queued suggestions.

ALTER TABLE friday_reflex_candidates RENAME TO friday_reflex_candidates_v089_legacy;

CREATE TABLE friday_reflex_candidates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('memory', 'learned_fact', 'preference', 'recipe', 'skill', 'workflow', 'fix', 'test_policy')),
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

INSERT INTO friday_reflex_candidates (
  id,
  user_id,
  kind,
  status,
  origin,
  source_run_id,
  session_key,
  channel_kind,
  channel_user_id,
  title,
  summary,
  payload_json,
  evidence_json,
  confidence,
  risk_tier,
  created_at,
  updated_at,
  decided_at
)
SELECT
  id,
  user_id,
  kind,
  status,
  origin,
  source_run_id,
  session_key,
  channel_kind,
  channel_user_id,
  title,
  summary,
  payload_json,
  evidence_json,
  confidence,
  risk_tier,
  created_at,
  updated_at,
  decided_at
FROM friday_reflex_candidates_v089_legacy;

DROP TABLE friday_reflex_candidates_v089_legacy;

CREATE INDEX IF NOT EXISTS idx_friday_reflex_candidates_user_status
  ON friday_reflex_candidates (user_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_friday_reflex_candidates_user_kind
  ON friday_reflex_candidates (user_id, kind, updated_at);

CREATE INDEX IF NOT EXISTS idx_friday_reflex_candidates_source_run
  ON friday_reflex_candidates (source_run_id);
`;

const V090_CHECKSUM = computeFridayMigrationChecksum(
  V090_REFLEX_LEARNED_FACT_CANDIDATES_SQL,
);

export const V090_REFLEX_LEARNED_FACT_CANDIDATES_MIGRATION: FridaySqliteMigration = {
  version: 90,
  name: "v090-reflex-learned-fact-candidates",
  sql: V090_REFLEX_LEARNED_FACT_CANDIDATES_SQL,
  checksum: V090_CHECKSUM,
};
