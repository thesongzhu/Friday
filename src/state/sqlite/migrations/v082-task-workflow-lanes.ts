import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V082_TASK_WORKFLOW_LANES_SQL = `
-- V082: Phase 13.5B executor/verifier lane persistence.
--
-- Adds task_workflow_lanes to record native/provider executor and verifier
-- lane state on top of the Phase 13.5A task workflow policy primitives.
-- Each lane records a deterministic context snapshot hash and the workflow
-- spec hash captured at lane open so closeout can block honestly when the
-- lane context is missing or out of sync. Verifier verdicts are still
-- promoted through the task workflow service; this table only records the
-- lane identity, parent executor lane, independence label, fallback
-- availability label, and provider/route trace refs (no raw payloads).
--
-- Adds verifier_lane_id to task_workflow_claims so verified claims can
-- be traced back to the verifier lane that produced the verdict. The
-- column is nullable so existing 13.5A claims migrate cleanly; it is
-- only set when the service-mediated verifier verdict path is used.

CREATE TABLE IF NOT EXISTS task_workflow_lanes (
  id                          TEXT PRIMARY KEY NOT NULL,
  workflow_id                 TEXT NOT NULL REFERENCES task_workflows(id) ON DELETE CASCADE,
  lane_kind                   TEXT NOT NULL CHECK (lane_kind IN ('executor','verifier')),
  lane_role                   TEXT NOT NULL CHECK (lane_role IN ('native','provider')),
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

CREATE INDEX IF NOT EXISTS idx_task_workflow_lanes_workflow
  ON task_workflow_lanes (workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_workflow_lanes_kind
  ON task_workflow_lanes (workflow_id, lane_kind);
CREATE INDEX IF NOT EXISTS idx_task_workflow_lanes_parent
  ON task_workflow_lanes (parent_lane_id);

ALTER TABLE task_workflow_claims ADD COLUMN verifier_lane_id TEXT;
`;

const V082_CHECKSUM = computeFridayMigrationChecksum(V082_TASK_WORKFLOW_LANES_SQL);

export const V082_TASK_WORKFLOW_LANES_MIGRATION: FridaySqliteMigration = {
  version: 82,
  name: "v082-task-workflow-lanes",
  sql: V082_TASK_WORKFLOW_LANES_SQL,
  checksum: V082_CHECKSUM,
};
