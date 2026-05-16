import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V083_TASK_WORKFLOW_LANE_CLI_ROLE_SQL = `
-- V083: Phase 13.5C CLI backend adapter — permit lane_role='cli'.
--
-- v082 created task_workflow_lanes with a CHECK constraint that only allowed
-- lane_role IN ('native','provider'). Phase 13.5C introduces a bounded
-- text executor / reviewer lane backed by Friday's existing CLI text
-- completion primitive. SQLite cannot ALTER an existing CHECK constraint,
-- so this migration recreates the table with the relaxed enum and copies
-- existing rows verbatim.
--
-- Lane semantics for laneRole='cli':
--   - CLI lanes are bounded text executor or reviewer lanes only.
--   - The task workflow service refuses verifier verdict promotion for
--     CLI verifier lanes at all risk levels with a clear fail-closed
--     error (TASK_WORKFLOW_CLI_VERIFIER_LANE_REFUSED). High-risk
--     workflows still require an independent non-CLI verifier lane.
--   - CLI summaries remain draft / unverified until a Friday native or
--     provider verifier lane fresh-reads referenced evidence.
--
-- The migration is additive with respect to data: every existing row is
-- preserved, and any consumer that already wrote 'native' or 'provider'
-- continues to validate cleanly.

ALTER TABLE task_workflow_lanes RENAME TO task_workflow_lanes_v082_legacy;

CREATE TABLE task_workflow_lanes (
  id                          TEXT PRIMARY KEY NOT NULL,
  workflow_id                 TEXT NOT NULL REFERENCES task_workflows(id) ON DELETE CASCADE,
  lane_kind                   TEXT NOT NULL CHECK (lane_kind IN ('executor','verifier')),
  lane_role                   TEXT NOT NULL CHECK (lane_role IN ('native','provider','cli')),
  parent_lane_id              TEXT,
  status                      TEXT NOT NULL CHECK (status IN ('open','in_progress','completed','blocked')),
  independence                TEXT NOT NULL CHECK (independence IN ('independent','degraded_unavailable','degraded_same_provider','not_applicable')),
  executor_run_ref            TEXT,
  provider_id                 TEXT,
  route_trace_ref             TEXT,
  context_snapshot_hash       TEXT NOT NULL,
  context_snapshot_spec_hash  TEXT NOT NULL,
  fallback_availability       TEXT CHECK (fallback_availability IN ('not_used','used_same_provider','used_alternate_provider')),
  blocker                     TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

INSERT INTO task_workflow_lanes (
  id,
  workflow_id,
  lane_kind,
  lane_role,
  parent_lane_id,
  status,
  independence,
  executor_run_ref,
  provider_id,
  route_trace_ref,
  context_snapshot_hash,
  context_snapshot_spec_hash,
  fallback_availability,
  blocker,
  created_at,
  updated_at
)
SELECT
  id,
  workflow_id,
  lane_kind,
  lane_role,
  parent_lane_id,
  status,
  independence,
  executor_run_ref,
  provider_id,
  route_trace_ref,
  context_snapshot_hash,
  context_snapshot_spec_hash,
  fallback_availability,
  blocker,
  created_at,
  updated_at
FROM task_workflow_lanes_v082_legacy;

DROP TABLE task_workflow_lanes_v082_legacy;

CREATE INDEX IF NOT EXISTS idx_task_workflow_lanes_workflow
  ON task_workflow_lanes (workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_workflow_lanes_kind
  ON task_workflow_lanes (workflow_id, lane_kind);
CREATE INDEX IF NOT EXISTS idx_task_workflow_lanes_parent
  ON task_workflow_lanes (parent_lane_id);
`;

const V083_CHECKSUM = computeFridayMigrationChecksum(
  V083_TASK_WORKFLOW_LANE_CLI_ROLE_SQL,
);

export const V083_TASK_WORKFLOW_LANE_CLI_ROLE_MIGRATION: FridaySqliteMigration = {
  version: 83,
  name: "v083-task-workflow-lane-cli-role",
  sql: V083_TASK_WORKFLOW_LANE_CLI_ROLE_SQL,
  checksum: V083_CHECKSUM,
};
