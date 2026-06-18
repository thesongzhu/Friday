import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V094_WORKFLOW_BUILDER_ANCILLARY_REHOME_SQL = `
-- V094: Rehome workflow-builder ancillary stores out of memory_items.
--
-- Templates, published spec snapshots, and persisted builder test runs are
-- product state, not durable-memory facts. New writes move to dedicated tables.
-- Valid legacy rows are copied forward and then removed from memory_items so
-- the live repositories no longer need memory_items write/delete legs.

CREATE TABLE IF NOT EXISTS workflow_builder_templates (
  template_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  owner_user_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  source_skill_id TEXT,
  spec_json TEXT NOT NULL,
  visual_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_builder_templates_scope_owner
  ON workflow_builder_templates(scope, owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_builder_spec_versions (
  workflow_version_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_builder_spec_versions_workflow
  ON workflow_builder_spec_versions(workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_builder_test_runs (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  draft_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  passed INTEGER NOT NULL,
  case_results_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_workflow_builder_test_runs_draft
  ON workflow_builder_test_runs(draft_id, started_at DESC);

INSERT OR IGNORE INTO workflow_builder_templates (
  template_id, kind, scope, owner_user_id, name, description, tags_json,
  source_skill_id, spec_json, visual_json, created_at, updated_at
)
SELECT
  json_extract(value_json, '$.templateId'),
  json_extract(value_json, '$.kind'),
  json_extract(value_json, '$.scope'),
  json_extract(value_json, '$.ownerUserId'),
  json_extract(value_json, '$.name'),
  json_extract(value_json, '$.description'),
  COALESCE(json_extract(value_json, '$.tags'), '[]'),
  json_extract(value_json, '$.sourceSkillId'),
  json_extract(value_json, '$.spec'),
  json_extract(value_json, '$.visual'),
  json_extract(value_json, '$.createdAt'),
  json_extract(value_json, '$.updatedAt')
FROM memory_items
WHERE namespace = 'workflow_builder_templates'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.templateId') IS NOT NULL
  AND json_extract(value_json, '$.kind') IS NOT NULL
  AND json_extract(value_json, '$.scope') IS NOT NULL
  AND json_extract(value_json, '$.name') IS NOT NULL
  AND json_extract(value_json, '$.spec') IS NOT NULL
  AND json_extract(value_json, '$.visual') IS NOT NULL
  AND json_extract(value_json, '$.createdAt') IS NOT NULL
  AND json_extract(value_json, '$.updatedAt') IS NOT NULL;

DELETE FROM memory_items
WHERE namespace = 'workflow_builder_templates'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.templateId') IN (
    SELECT template_id FROM workflow_builder_templates
  );

INSERT OR IGNORE INTO workflow_builder_spec_versions (
  workflow_version_id, workflow_id, spec_json, checksum, created_at
)
SELECT
  json_extract(value_json, '$.workflowVersionId'),
  json_extract(value_json, '$.workflowId'),
  json_extract(value_json, '$.spec'),
  json_extract(value_json, '$.checksum'),
  json_extract(value_json, '$.createdAt')
FROM memory_items
WHERE namespace = 'workflow_builder_spec_versions'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.workflowVersionId') IS NOT NULL
  AND json_extract(value_json, '$.workflowId') IS NOT NULL
  AND json_extract(value_json, '$.spec') IS NOT NULL
  AND json_extract(value_json, '$.checksum') IS NOT NULL
  AND json_extract(value_json, '$.createdAt') IS NOT NULL;

DELETE FROM memory_items
WHERE namespace = 'workflow_builder_spec_versions'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.workflowVersionId') IN (
    SELECT workflow_version_id FROM workflow_builder_spec_versions
  );

INSERT OR IGNORE INTO workflow_builder_test_runs (
  run_id, workflow_id, draft_id, started_at, finished_at, passed, case_results_json
)
SELECT
  json_extract(value_json, '$.runId'),
  json_extract(value_json, '$.workflowId'),
  json_extract(value_json, '$.draftId'),
  json_extract(value_json, '$.startedAt'),
  json_extract(value_json, '$.finishedAt'),
  CASE WHEN json_extract(value_json, '$.passed') THEN 1 ELSE 0 END,
  COALESCE(json_extract(value_json, '$.caseResults'), '[]')
FROM memory_items
WHERE namespace = 'workflow_builder_test_runs'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.runId') IS NOT NULL
  AND json_extract(value_json, '$.workflowId') IS NOT NULL
  AND json_extract(value_json, '$.startedAt') IS NOT NULL
  AND json_extract(value_json, '$.finishedAt') IS NOT NULL;

DELETE FROM memory_items
WHERE namespace = 'workflow_builder_test_runs'
  AND json_valid(value_json)
  AND json_extract(value_json, '$.runId') IN (
    SELECT run_id FROM workflow_builder_test_runs
  );
`;

const V094_CHECKSUM = computeFridayMigrationChecksum(
  V094_WORKFLOW_BUILDER_ANCILLARY_REHOME_SQL,
);

export const V094_WORKFLOW_BUILDER_ANCILLARY_REHOME_MIGRATION: FridaySqliteMigration = {
  version: 94,
  name: "v094-workflow-builder-ancillary-rehome",
  sql: V094_WORKFLOW_BUILDER_ANCILLARY_REHOME_SQL,
  checksum: V094_CHECKSUM,
};
