import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V009_WORKFLOW_ENGINE_TRIGGERS_APPROVALS_SQL = `
-- V009: Workflow engine triggers and approvals

ALTER TABLE workflow_versions ADD COLUMN editor_graph_json TEXT;
ALTER TABLE workflow_versions ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE workflow_runs ADD COLUMN trigger_node_id TEXT;
ALTER TABLE workflow_runs ADD COLUMN timeout_ms INTEGER;
ALTER TABLE workflow_runs ADD COLUMN deadline_at TEXT;
ALTER TABLE workflow_runs ADD COLUMN paused_at TEXT;
ALTER TABLE workflow_runs ADD COLUMN resumed_at TEXT;

ALTER TABLE workflow_run_nodes ADD COLUMN node_type TEXT;
ALTER TABLE workflow_run_nodes ADD COLUMN timeout_ms INTEGER;
ALTER TABLE workflow_run_nodes ADD COLUMN approval_request_id TEXT;

CREATE TABLE IF NOT EXISTS workflow_trigger_registrations (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
  trigger_node_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('cron','webhook','event')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  cron_expression TEXT,
  cron_timezone TEXT,
  webhook_path_token TEXT,
  webhook_secret_ref TEXT,
  webhook_signature_header TEXT,
  event_source TEXT,
  event_name TEXT,
  event_filter_expr TEXT,
  plugin_id TEXT REFERENCES plugins(id) ON DELETE SET NULL,
  dedupe_window_sec INTEGER NOT NULL DEFAULT 300,
  last_fired_at TEXT,
  next_fire_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workflow_version_id, trigger_node_id),
  UNIQUE(webhook_path_token)
);

CREATE INDEX IF NOT EXISTS idx_workflow_trigger_registrations_due
  ON workflow_trigger_registrations(trigger_type, enabled, next_fire_at);

CREATE INDEX IF NOT EXISTS idx_workflow_trigger_registrations_event
  ON workflow_trigger_registrations(event_source, event_name, enabled);

CREATE TABLE IF NOT EXISTS workflow_trigger_deliveries (
  id TEXT PRIMARY KEY,
  trigger_registration_id TEXT NOT NULL REFERENCES workflow_trigger_registrations(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','duplicate','failed')),
  error_code TEXT,
  error_message TEXT,
  delivered_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trigger_registration_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS workflow_run_checkpoints (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  checkpoint_seq INTEGER NOT NULL,
  run_status TEXT NOT NULL,
  active_node_ids_json TEXT NOT NULL DEFAULT '[]',
  completed_node_ids_json TEXT NOT NULL DEFAULT '[]',
  failed_node_ids_json TEXT NOT NULL DEFAULT '[]',
  waiting_approval_node_ids_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  last_node_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_checkpoints_status
  ON workflow_run_checkpoints(run_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_approval_requests (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  run_node_attempt_id TEXT NOT NULL REFERENCES workflow_run_nodes(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  approver_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approver_role TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  request_payload_json TEXT NOT NULL DEFAULT '{}',
  timeout_at TEXT,
  decided_at TEXT,
  decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision_comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_node_attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_approval_requests_approver
  ON workflow_approval_requests(approver_user_id, status, timeout_at);

CREATE INDEX IF NOT EXISTS idx_workflow_approval_requests_run
  ON workflow_approval_requests(run_id, status);
`;

const V009_CHECKSUM = computeFridayMigrationChecksum(V009_WORKFLOW_ENGINE_TRIGGERS_APPROVALS_SQL);

export const V009_WORKFLOW_ENGINE_TRIGGERS_APPROVALS_MIGRATION: FridaySqliteMigration = {
  version: 9,
  name: "v009-workflow-engine-triggers-approvals",
  sql: V009_WORKFLOW_ENGINE_TRIGGERS_APPROVALS_SQL,
  checksum: V009_CHECKSUM,
};
