import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V097_WORKFLOW_GENERATOR_REHOME_SQL = `
-- V097: Rehome workflow-generator sessions, turns, drafts, and approvals out of memory_items.
--
-- Workflow generation state is operational product state, not durable-memory
-- facts. New writes move to dedicated tables; valid legacy rows are copied
-- forward and removed from memory_items.

CREATE TABLE IF NOT EXISTS workflow_generation_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  value_json TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_workflow_generation_sessions_user_updated
  ON workflow_generation_sessions(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_generation_sessions_status_updated
  ON workflow_generation_sessions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_generation_turns (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  value_json TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (session_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_generation_turns_session_created
  ON workflow_generation_turns(session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS workflow_generation_drafts (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  value_json TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS workflow_generation_approvals (
  session_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version_id TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  value_json TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]'
);

INSERT OR IGNORE INTO workflow_generation_sessions (
  session_id, user_id, channel, status, created_at, updated_at, value_json, tags_json
)
SELECT
  json_extract(value_json, '$.sessionId'),
  json_extract(value_json, '$.userId'),
  json_extract(value_json, '$.channel'),
  json_extract(value_json, '$.status'),
  json_extract(value_json, '$.createdAt'),
  json_extract(value_json, '$.updatedAt'),
  value_json,
  tags_json
FROM memory_items
WHERE namespace = 'workflow-generator-session'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.sessionId') IS NOT NULL
  AND json_extract(value_json, '$.userId') IS NOT NULL
  AND json_extract(value_json, '$.channel') IS NOT NULL
  AND json_extract(value_json, '$.status') IS NOT NULL
  AND json_extract(value_json, '$.createdAt') IS NOT NULL
  AND json_extract(value_json, '$.updatedAt') IS NOT NULL;

DELETE FROM memory_items
WHERE namespace = 'workflow-generator-session'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.sessionId') IN (
    SELECT session_id FROM workflow_generation_sessions
  );

INSERT OR IGNORE INTO workflow_generation_turns (
  session_id, turn_id, role, created_at, value_json, tags_json
)
SELECT
  json_extract(value_json, '$.sessionId'),
  json_extract(value_json, '$.turnId'),
  json_extract(value_json, '$.role'),
  json_extract(value_json, '$.createdAt'),
  value_json,
  tags_json
FROM memory_items
WHERE namespace = 'workflow-generator-turn'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.sessionId') IS NOT NULL
  AND json_extract(value_json, '$.turnId') IS NOT NULL
  AND json_extract(value_json, '$.role') IS NOT NULL
  AND json_extract(value_json, '$.createdAt') IS NOT NULL;

DELETE FROM memory_items
WHERE namespace = 'workflow-generator-turn'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.sessionId') || ':' || json_extract(value_json, '$.turnId') IN (
    SELECT session_id || ':' || turn_id FROM workflow_generation_turns
  );

INSERT OR IGNORE INTO workflow_generation_drafts (
  session_id, created_at, updated_at, value_json, tags_json
)
SELECT
  key,
  created_at,
  updated_at,
  value_json,
  tags_json
FROM memory_items
WHERE namespace = 'workflow-generator-draft'
  AND json_valid(value_json);

DELETE FROM memory_items
WHERE namespace = 'workflow-generator-draft'
  AND key IN (
    SELECT session_id FROM workflow_generation_drafts
  );

INSERT OR IGNORE INTO workflow_generation_approvals (
  session_id, workflow_id, workflow_version_id, saved_at, updated_at, value_json, tags_json
)
SELECT
  json_extract(value_json, '$.sessionId'),
  json_extract(value_json, '$.workflowId'),
  json_extract(value_json, '$.workflowVersionId'),
  json_extract(value_json, '$.savedAt'),
  updated_at,
  value_json,
  tags_json
FROM memory_items
WHERE namespace = 'workflow-generator-approval'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.sessionId') IS NOT NULL
  AND json_extract(value_json, '$.workflowId') IS NOT NULL
  AND json_extract(value_json, '$.workflowVersionId') IS NOT NULL
  AND json_extract(value_json, '$.savedAt') IS NOT NULL;

DELETE FROM memory_items
WHERE namespace = 'workflow-generator-approval'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.sessionId') IN (
    SELECT session_id FROM workflow_generation_approvals
  );
`;

const V097_CHECKSUM = computeFridayMigrationChecksum(
  V097_WORKFLOW_GENERATOR_REHOME_SQL,
);

export const V097_WORKFLOW_GENERATOR_REHOME_MIGRATION: FridaySqliteMigration = {
  version: 97,
  name: "v097-workflow-generator-rehome",
  sql: V097_WORKFLOW_GENERATOR_REHOME_SQL,
  checksum: V097_CHECKSUM,
};
