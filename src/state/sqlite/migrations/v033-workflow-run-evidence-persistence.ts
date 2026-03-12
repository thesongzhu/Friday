import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V033_WORKFLOW_RUN_EVIDENCE_PERSISTENCE_SQL = `
-- V033: Persist run-level pipeline evidence (events, retry traces, playbook traces, exports)

CREATE TABLE IF NOT EXISTS workflow_run_pipeline_events (
  event_id      TEXT    PRIMARY KEY NOT NULL,
  run_id        TEXT    NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_id   TEXT,
  node_id       TEXT,
  attempt       INTEGER,
  module        TEXT    NOT NULL,
  event_name    TEXT    NOT NULL,
  payload_json  TEXT    NOT NULL DEFAULT '{}',
  trace_id      TEXT,
  span_id       TEXT,
  redacted      INTEGER NOT NULL DEFAULT 0,
  emitted_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_pipeline_events_run_emitted
  ON workflow_run_pipeline_events (run_id, emitted_at ASC);
CREATE INDEX IF NOT EXISTS idx_workflow_run_pipeline_events_run_module
  ON workflow_run_pipeline_events (run_id, module, emitted_at ASC);

CREATE TABLE IF NOT EXISTS workflow_run_retry_traces (
  id            TEXT    PRIMARY KEY NOT NULL,
  run_id        TEXT    NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id       TEXT    NOT NULL,
  attempt       INTEGER NOT NULL,
  category      TEXT    NOT NULL,
  error_code    TEXT    NOT NULL,
  error_message TEXT,
  decision_json TEXT    NOT NULL DEFAULT '{}',
  timestamp     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_retry_traces_run_timestamp
  ON workflow_run_retry_traces (run_id, timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_workflow_run_retry_traces_run_node_attempt
  ON workflow_run_retry_traces (run_id, node_id, attempt);

CREATE TABLE IF NOT EXISTS workflow_run_playbook_traces (
  id            TEXT    PRIMARY KEY NOT NULL,
  run_id        TEXT    NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_id   TEXT    NOT NULL,
  phase         TEXT    NOT NULL,
  intake_json   TEXT,
  feedback_json TEXT,
  timestamp     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_playbook_traces_run_timestamp
  ON workflow_run_playbook_traces (run_id, timestamp ASC);

CREATE TABLE IF NOT EXISTS workflow_run_evidence_exports (
  id            TEXT    PRIMARY KEY NOT NULL,
  run_id        TEXT    NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  artifact_id   TEXT    NOT NULL REFERENCES workflow_artifacts(id) ON DELETE CASCADE,
  uri           TEXT    NOT NULL,
  checksum      TEXT    NOT NULL,
  query_json    TEXT    NOT NULL DEFAULT '{}',
  summary_json  TEXT    NOT NULL DEFAULT '{}',
  payload_json  TEXT    NOT NULL,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_evidence_exports_run_created
  ON workflow_run_evidence_exports (run_id, created_at DESC);
`;

const V033_CHECKSUM = computeFridayMigrationChecksum(
  V033_WORKFLOW_RUN_EVIDENCE_PERSISTENCE_SQL,
);

export const V033_WORKFLOW_RUN_EVIDENCE_PERSISTENCE_MIGRATION: FridaySqliteMigration = {
  version: 33,
  name: "v033-workflow-run-evidence-persistence",
  sql: V033_WORKFLOW_RUN_EVIDENCE_PERSISTENCE_SQL,
  checksum: V033_CHECKSUM,
};
