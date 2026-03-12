import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V049_ACCEPTANCE_RETRY_ADVANCED_SQL = `
-- V049: acceptance lifecycle persistence and retry advanced runtime persistence.

CREATE TABLE IF NOT EXISTS acceptance_tests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  artifact_type TEXT NOT NULL,
  check_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  short_circuit INTEGER NOT NULL DEFAULT 0,
  rule_policy_bundle_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL,
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_acceptance_tests_artifact_enabled
  ON acceptance_tests (artifact_type, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS acceptance_test_versions (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL REFERENCES acceptance_tests(id),
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  changed_by TEXT,
  change_note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acceptance_test_versions_test
  ON acceptance_test_versions (test_id, version DESC);

CREATE TABLE IF NOT EXISTS acceptance_runs (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  artifact_uri TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  overall_verdict TEXT NOT NULL,
  overall_severity TEXT NOT NULL,
  state TEXT NOT NULL,
  checks_total INTEGER NOT NULL,
  checks_passed INTEGER NOT NULL,
  checks_failed INTEGER NOT NULL,
  checks_warned INTEGER NOT NULL,
  checks_skipped INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acceptance_runs_artifact_created
  ON acceptance_runs (artifact_uri, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_acceptance_runs_execution_created
  ON acceptance_runs (execution_id, created_at DESC);

CREATE TABLE IF NOT EXISTS retry_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  tags_json TEXT NOT NULL DEFAULT '[]',
  cost_budget_json TEXT NOT NULL,
  strategies_json TEXT NOT NULL,
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_retry_policies_enabled_updated
  ON retry_policies (enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS retry_policy_versions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES retry_policies(id),
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  changed_by TEXT,
  change_note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retry_policy_versions_policy
  ON retry_policy_versions (policy_id, version DESC);

CREATE TABLE IF NOT EXISTS retry_traces (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  original_failure_category TEXT NOT NULL,
  original_error_code TEXT,
  original_error_message TEXT,
  attempts_json TEXT NOT NULL DEFAULT '[]',
  total_attempts INTEGER NOT NULL DEFAULT 0,
  cost_summary_json TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  first_failure_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retry_traces_run_node
  ON retry_traces (run_id, node_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_retry_traces_status_updated
  ON retry_traces (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS retry_attempts (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES retry_traces(id),
  attempt_number INTEGER NOT NULL,
  classified_failure_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  delay_ms INTEGER NOT NULL DEFAULT 0,
  execution_id TEXT,
  outcome TEXT NOT NULL,
  cost_record_json TEXT,
  rules_result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_retry_attempts_trace_attempt
  ON retry_attempts (trace_id, attempt_number ASC);

CREATE TABLE IF NOT EXISTS retry_cost_records (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES retry_traces(id),
  attempt_number INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  cost_tokens INTEGER NOT NULL DEFAULT 0,
  cost_api_calls INTEGER NOT NULL DEFAULT 0,
  cost_compute_ms INTEGER NOT NULL DEFAULT 0,
  cumulative_tokens INTEGER NOT NULL DEFAULT 0,
  cumulative_api_calls INTEGER NOT NULL DEFAULT 0,
  cumulative_compute_ms INTEGER NOT NULL DEFAULT 0,
  per_attempt_budget_exceeded INTEGER NOT NULL DEFAULT 0,
  total_budget_exceeded INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retry_cost_records_trace_attempt
  ON retry_cost_records (trace_id, attempt_number ASC);

CREATE TABLE IF NOT EXISTS retry_escalations (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES retry_traces(id),
  target TEXT NOT NULL,
  channel TEXT NOT NULL,
  reason TEXT NOT NULL,
  failure_category TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  total_cost_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_api_calls INTEGER NOT NULL DEFAULT 0,
  total_cost_compute_ms INTEGER NOT NULL DEFAULT 0,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  escalated_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_retry_escalations_ack
  ON retry_escalations (acknowledged, escalated_at DESC);

CREATE TABLE IF NOT EXISTS retry_circuit_breakers (
  target_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  failure_threshold INTEGER NOT NULL,
  last_opened_at TEXT,
  trip_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retry_circuit_breakers_state_updated
  ON retry_circuit_breakers (state, updated_at DESC);
`;

const V049_CHECKSUM = computeFridayMigrationChecksum(
  V049_ACCEPTANCE_RETRY_ADVANCED_SQL,
);

export const V049_ACCEPTANCE_RETRY_ADVANCED_MIGRATION: FridaySqliteMigration = {
  version: 49,
  name: "v049-acceptance-retry-advanced",
  sql: V049_ACCEPTANCE_RETRY_ADVANCED_SQL,
  checksum: V049_CHECKSUM,
};
