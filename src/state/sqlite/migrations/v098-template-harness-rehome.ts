import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V098_TEMPLATE_HARNESS_REHOME_SQL = `
-- V098: Rehome template-harness artifacts out of memory_items.
--
-- Template harness artifacts are operational product state, not durable-memory
-- facts. New writes move to a dedicated table; valid legacy rows are copied
-- forward and removed from memory_items.

CREATE TABLE IF NOT EXISTS template_harness_artifacts (
  artifact_kind TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  value_json TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (artifact_kind, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_template_harness_artifacts_scope_updated
  ON template_harness_artifacts(scope_kind, scope_id, updated_at DESC);

INSERT OR IGNORE INTO template_harness_artifacts (
  artifact_kind, artifact_id, scope_kind, scope_id, created_at, updated_at, value_json, tags_json
)
SELECT
  namespace,
  json_extract(value_json, '$.artifactId'),
  json_extract(value_json, '$.scopeKind'),
  json_extract(value_json, '$.scopeId'),
  json_extract(value_json, '$.createdAt'),
  json_extract(value_json, '$.updatedAt'),
  value_json,
  tags_json
FROM memory_items
WHERE namespace IN (
    'template-harness-planning-spec',
    'template-harness-delivery-contract',
    'template-harness-qa-verdict',
    'template-harness-handoff'
  )
  AND json_valid(value_json)
  AND json_extract(value_json, '$.artifactId') IS NOT NULL
  AND json_extract(value_json, '$.scopeKind') IS NOT NULL
  AND json_extract(value_json, '$.scopeId') IS NOT NULL
  AND json_extract(value_json, '$.createdAt') IS NOT NULL
  AND json_extract(value_json, '$.updatedAt') IS NOT NULL;

DELETE FROM memory_items
WHERE namespace IN (
    'template-harness-planning-spec',
    'template-harness-delivery-contract',
    'template-harness-qa-verdict',
    'template-harness-handoff'
  )
  AND json_valid(value_json)
  AND namespace || ':' || json_extract(value_json, '$.artifactId') IN (
    SELECT artifact_kind || ':' || artifact_id FROM template_harness_artifacts
  );
`;

const V098_CHECKSUM = computeFridayMigrationChecksum(
  V098_TEMPLATE_HARNESS_REHOME_SQL,
);

export const V098_TEMPLATE_HARNESS_REHOME_MIGRATION: FridaySqliteMigration = {
  version: 98,
  name: "v098-template-harness-rehome",
  sql: V098_TEMPLATE_HARNESS_REHOME_SQL,
  checksum: V098_CHECKSUM,
};
