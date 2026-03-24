import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V056_INCENTIVE_ALIGNMENT_FOUNDATION_SQL = `
-- V056: Incentive-alignment foundation for outcome receipts, reuse scoring,
-- marketplace proof-of-use ranking, and learning metrics expansion.

ALTER TABLE friday_agent_automations
  ADD COLUMN estimated_time_saved_minutes INTEGER NOT NULL DEFAULT 15;
ALTER TABLE friday_agent_automations
  ADD COLUMN reuse_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE friday_agent_automations
  ADD COLUMN promotion_state TEXT NOT NULL DEFAULT 'private'
    CHECK (promotion_state IN ('private', 'team', 'public_boost_eligible', 'public'));
ALTER TABLE friday_agent_automations
  ADD COLUMN last_outcome_score REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_friday_agent_automations_promotion_state
  ON friday_agent_automations (promotion_state);

ALTER TABLE learning_metrics
  ADD COLUMN activation_rate REAL;
ALTER TABLE learning_metrics
  ADD COLUMN save_rate REAL;
ALTER TABLE learning_metrics
  ADD COLUMN reuse_rate REAL;
ALTER TABLE learning_metrics
  ADD COLUMN promotion_rate REAL;
ALTER TABLE learning_metrics
  ADD COLUMN support_conversion_rate REAL;
ALTER TABLE learning_metrics
  ADD COLUMN request_fulfillment_rate REAL;

CREATE TABLE learning_events_new (
  event_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'user_message',
    'assistant_message',
    'tool_result',
    'user_correction',
    'error_incident',
    'workflow_outcome',
    'automation_saved',
    'automation_reused',
    'asset_promoted',
    'asset_published',
    'asset_supported',
    'request_fulfilled',
    'outcome_confirmed'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO learning_events_new (
  event_id,
  ts,
  user_id,
  session_id,
  run_id,
  kind,
  payload_json,
  created_at
)
SELECT
  event_id,
  ts,
  user_id,
  session_id,
  run_id,
  kind,
  payload_json,
  created_at
FROM learning_events;

DROP TABLE learning_events;
ALTER TABLE learning_events_new RENAME TO learning_events;

CREATE INDEX IF NOT EXISTS idx_learning_events_user_ts
  ON learning_events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_learning_events_kind
  ON learning_events(kind);
CREATE INDEX IF NOT EXISTS idx_learning_events_run
  ON learning_events(run_id);
`;

const V056_CHECKSUM = computeFridayMigrationChecksum(V056_INCENTIVE_ALIGNMENT_FOUNDATION_SQL);

export const V056_INCENTIVE_ALIGNMENT_FOUNDATION_MIGRATION: FridaySqliteMigration = {
  version: 56,
  name: "v056-incentive-alignment-foundation",
  sql: V056_INCENTIVE_ALIGNMENT_FOUNDATION_SQL,
  checksum: V056_CHECKSUM,
};
