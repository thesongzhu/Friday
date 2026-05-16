import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V084_TASK_WORKFLOW_CLI_HANDOFFS_SQL = `
-- V084: Phase 13.5C CLI backend adapter — persist normalized CLI handoffs.
--
-- task_workflow_cli_handoffs records the normalized handoff produced by
-- friday-task-workflow-cli-adapter.ts whenever a CLI lane invokes its
-- bounded text executor / reviewer flow. The handoff is always stored
-- with verified=false; verifier verdict promotion remains refused for
-- CLI verifier lanes by the task workflow service. Persistence here is
-- the "stored unconfirmed" step required by module_26c CSV (CLI handoff
-- -> stored unconfirmed -> verifier fresh-read -> verdict persisted ->
-- closeout labels source truth).
--
-- The table never stores raw provider/CLI credentials; it stores only the
-- normalized adapter output (status, draft summary, machine-readable
-- capability label, repair-attempt count, elapsed time, failure reason).
-- The capability label is persisted as JSON so closeout / future
-- supervisor surfaces can re-read it without re-running the CLI.

CREATE TABLE IF NOT EXISTS task_workflow_cli_handoffs (
  id                     TEXT PRIMARY KEY NOT NULL,
  workflow_id            TEXT NOT NULL REFERENCES task_workflows(id) ON DELETE CASCADE,
  lane_id                TEXT NOT NULL REFERENCES task_workflow_lanes(id) ON DELETE CASCADE,
  backend_id             TEXT NOT NULL CHECK (backend_id IN ('codex-cli','claude-cli')),
  status                 TEXT NOT NULL CHECK (status IN ('handoff_ready','repair_failed','timeout','unavailable','auth_missing')),
  summary_draft          TEXT NOT NULL,
  capability_label_json  TEXT NOT NULL,
  repair_attempts        INTEGER NOT NULL CHECK (repair_attempts >= 0),
  elapsed_ms             INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  failure_reason         TEXT,
  produced_at            TEXT NOT NULL,
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_workflow_cli_handoffs_workflow
  ON task_workflow_cli_handoffs (workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_workflow_cli_handoffs_lane
  ON task_workflow_cli_handoffs (lane_id, created_at DESC);
`;

const V084_CHECKSUM = computeFridayMigrationChecksum(
  V084_TASK_WORKFLOW_CLI_HANDOFFS_SQL,
);

export const V084_TASK_WORKFLOW_CLI_HANDOFFS_MIGRATION: FridaySqliteMigration = {
  version: 84,
  name: "v084-task-workflow-cli-handoffs",
  sql: V084_TASK_WORKFLOW_CLI_HANDOFFS_SQL,
  checksum: V084_CHECKSUM,
};
