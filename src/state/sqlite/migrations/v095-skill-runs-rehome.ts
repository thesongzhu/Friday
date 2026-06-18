import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V095_SKILL_RUNS_REHOME_SQL = `
-- V095: Rehome skill run snapshots out of memory_items.
--
-- Skill runs are live execution state, not durable-memory facts. New writes move
-- to a dedicated table; valid legacy rows are copied forward and removed from
-- memory_items so retention no longer deletes from the split memory store.

CREATE TABLE IF NOT EXISTS skill_run_snapshots (
  run_id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  current_step_id TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_transition_at TEXT NOT NULL,
  value_json TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_skill_run_snapshots_skill_updated
  ON skill_run_snapshots(skill_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_run_snapshots_status_updated
  ON skill_run_snapshots(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_run_snapshots_user_updated
  ON skill_run_snapshots(user_id, updated_at DESC);

INSERT OR IGNORE INTO skill_run_snapshots (
  run_id, skill_id, version, status, user_id, session_id, channel,
  current_step_id, started_at, updated_at, last_transition_at, value_json, tags_json
)
SELECT
  json_extract(value_json, '$.runId'),
  json_extract(value_json, '$.skillId'),
  json_extract(value_json, '$.version'),
  json_extract(value_json, '$.status'),
  json_extract(value_json, '$.userId'),
  json_extract(value_json, '$.sessionId'),
  json_extract(value_json, '$.channel'),
  json_extract(value_json, '$.currentStepId'),
  json_extract(value_json, '$.startedAt'),
  json_extract(value_json, '$.updatedAt'),
  json_extract(value_json, '$.lastTransitionAt'),
  value_json,
  tags_json
FROM memory_items
WHERE namespace = 'skill_runs'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.runId') IS NOT NULL
  AND json_extract(value_json, '$.skillId') IS NOT NULL
  AND json_extract(value_json, '$.version') IS NOT NULL
  AND json_extract(value_json, '$.status') IS NOT NULL
  AND json_extract(value_json, '$.userId') IS NOT NULL
  AND json_extract(value_json, '$.sessionId') IS NOT NULL
  AND json_extract(value_json, '$.channel') IS NOT NULL
  AND json_extract(value_json, '$.startedAt') IS NOT NULL
  AND json_extract(value_json, '$.updatedAt') IS NOT NULL
  AND json_extract(value_json, '$.lastTransitionAt') IS NOT NULL;

DELETE FROM memory_items
WHERE namespace = 'skill_runs'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.runId') IN (
    SELECT run_id FROM skill_run_snapshots
  );
`;

const V095_CHECKSUM = computeFridayMigrationChecksum(V095_SKILL_RUNS_REHOME_SQL);

export const V095_SKILL_RUNS_REHOME_MIGRATION: FridaySqliteMigration = {
  version: 95,
  name: "v095-skill-runs-rehome",
  sql: V095_SKILL_RUNS_REHOME_SQL,
  checksum: V095_CHECKSUM,
};
