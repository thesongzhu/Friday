import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V001_INITIAL_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hub_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT,
  is_local_only INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE TABLE IF NOT EXISTS config_revisions (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE,
  patch_json TEXT NOT NULL,
  full_snapshot_json TEXT NOT NULL,
  changed_keys_json TEXT NOT NULL DEFAULT '[]',
  changed_by_user_id TEXT REFERENCES users(id),
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_config_revisions_revision
  ON config_revisions(revision DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  refresh_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  device_label TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  principal_type TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS satellites (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  pairing_status TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  public_key TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  local_ip TEXT,
  external_ip TEXT,
  transport TEXT NOT NULL DEFAULT 'ws',
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  app_version TEXT NOT NULL,
  node_version TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_satellites_pairing_status ON satellites(pairing_status);
CREATE INDEX IF NOT EXISTS idx_satellites_last_seen ON satellites(last_seen_at);

CREATE TABLE IF NOT EXISTS satellite_capabilities (
  id TEXT PRIMARY KEY,
  satellite_id TEXT NOT NULL REFERENCES satellites(id),
  key TEXT NOT NULL,
  available INTEGER NOT NULL,
  metadata_json TEXT,
  limits_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(satellite_id, key)
);

CREATE TABLE IF NOT EXISTS satellite_pairing_requests (
  id TEXT PRIMARY KEY,
  satellite_id TEXT REFERENCES satellites(id),
  code TEXT NOT NULL,
  nonce TEXT NOT NULL,
  requested_by_ip TEXT,
  requested_by_user_agent TEXT,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  resolver_user_id TEXT REFERENCES users(id),
  satellite_payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pairing_status_expires
  ON satellite_pairing_requests(status, expires_at);

CREATE TABLE IF NOT EXISTS satellite_heartbeats (
  id TEXT PRIMARY KEY,
  satellite_id TEXT NOT NULL REFERENCES satellites(id),
  ts TEXT NOT NULL,
  status TEXT NOT NULL,
  cpu_percent REAL,
  memory_percent REAL,
  load_avg_1m REAL,
  queue_depth INTEGER,
  active_runs INTEGER,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_sat_ts
  ON satellite_heartbeats(satellite_id, ts DESC);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY,
  satellite_id TEXT NOT NULL REFERENCES satellites(id),
  queue_key TEXT NOT NULL,
  message_type TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  key_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  deliver_after TEXT,
  expires_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  leased_until TEXT,
  acked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_sat_status
  ON outbox_messages(satellite_id, status, deliver_after);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_sat_idempotency
  ON outbox_messages(satellite_id, idempotency_key);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  chat_kind TEXT NOT NULL,
  owner_satellite_id TEXT REFERENCES satellites(id),
  owner_lease_expires_at TEXT,
  owner_lease_epoch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  summary TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_owner_lease
  ON sessions(owner_satellite_id, owner_lease_expires_at);

CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  source_satellite_id TEXT REFERENCES satellites(id),
  idempotency_key TEXT,
  token_usage_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_idempotency
  ON session_messages(session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_messages_session_created
  ON session_messages(session_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts
USING fts5(session_id, content_text, content='session_messages', content_rowid='rowid', tokenize='unicode61');

CREATE TRIGGER IF NOT EXISTS trg_session_messages_fts_insert
AFTER INSERT ON session_messages
BEGIN
  INSERT INTO session_messages_fts(rowid, session_id, content_text)
  VALUES (NEW.rowid, NEW.session_id, NEW.content_json);
END;

CREATE TRIGGER IF NOT EXISTS trg_session_messages_fts_update
AFTER UPDATE OF content_json ON session_messages
BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, session_id, content_text)
  VALUES ('delete', OLD.rowid, OLD.session_id, OLD.content_json);
  INSERT INTO session_messages_fts(rowid, session_id, content_text)
  VALUES (NEW.rowid, NEW.session_id, NEW.content_json);
END;

CREATE TRIGGER IF NOT EXISTS trg_session_messages_fts_delete
AFTER DELETE ON session_messages
BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, session_id, content_text)
  VALUES ('delete', OLD.rowid, OLD.session_id, OLD.content_json);
END;

-- Recovery reindex procedure (run manually if FTS index becomes inconsistent):
-- INSERT INTO session_messages_fts(session_messages_fts) VALUES('rebuild');

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  owner_user_id TEXT REFERENCES users(id),
  latest_version_number INTEGER NOT NULL DEFAULT 1,
  published_version_number INTEGER,
  is_archived INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  version_number INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  is_published INTEGER NOT NULL DEFAULT 0,
  change_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workflow_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow
  ON workflow_versions(workflow_id, version_number DESC);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_payload_json TEXT,
  started_by_user_id TEXT REFERENCES users(id),
  started_by_satellite_id TEXT REFERENCES satellites(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  correlation_id TEXT,
  context_json TEXT,
  failure_code TEXT,
  failure_message TEXT,
  failure_details_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_started
  ON workflow_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS workflow_run_nodes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL,
  satellite_id TEXT REFERENCES satellites(id),
  lease_owner TEXT,
  lease_expires_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  input_json TEXT,
  output_json TEXT,
  error_json TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, node_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_nodes_run_status
  ON workflow_run_nodes(run_id, status);

CREATE TABLE IF NOT EXISTS workflow_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  uri TEXT NOT NULL,
  checksum TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'managed',
  publisher TEXT,
  latest_version TEXT,
  installed_version TEXT,
  status TEXT NOT NULL,
  current_manifest_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  package_url TEXT,
  signature_key_id TEXT,
  signature_algorithm TEXT,
  signature_value TEXT,
  manifest_json TEXT NOT NULL,
  released_at TEXT NOT NULL,
  yanked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(skill_id, version)
);

CREATE TABLE IF NOT EXISTS skill_installations (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  version TEXT NOT NULL,
  satellite_id TEXT REFERENCES satellites(id),
  status TEXT NOT NULL,
  permissions_granted_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_installs_sat_status
  ON skill_installations(satellite_id, status);

CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  endpoint_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  default_model TEXT,
  config_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  key_id TEXT NOT NULL,
  expires_at TEXT,
  rotated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, ref_key)
);

-- ============================================================
-- Unified learning + diagnosis + approval schema
-- (Authoritative DDL — merged from both design documents)
-- ============================================================

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  embedding_vector_ref TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_memory_namespace_key
  ON memory_items(namespace, key);

CREATE TABLE IF NOT EXISTS learning_events (
  event_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'user_message',
    'assistant_message',
    'tool_result',
    'user_correction',
    'error_incident',
    'workflow_outcome'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_events_user_ts
  ON learning_events(user_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_learning_events_kind
  ON learning_events(kind);

CREATE INDEX IF NOT EXISTS idx_learning_events_run
  ON learning_events(run_id);

CREATE TABLE IF NOT EXISTS preference_facts (
  fact_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  evidence_count INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TEXT NOT NULL,
  source_event_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_preference_facts_user
  ON preference_facts(user_id);

CREATE TABLE IF NOT EXISTS error_incidents (
  incident_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  node_id TEXT,
  ts TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('tool', 'model', 'routing', 'config', 'workflow')),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  signature TEXT NOT NULL,
  context_json TEXT NOT NULL,
  auto_fix_eligible INTEGER NOT NULL DEFAULT 0 CHECK (auto_fix_eligible IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'mitigated', 'resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_error_incidents_signature
  ON error_incidents(signature);

CREATE INDEX IF NOT EXISTS idx_error_incidents_user
  ON error_incidents(user_id);

CREATE INDEX IF NOT EXISTS idx_error_incidents_run
  ON error_incidents(run_id);

CREATE TABLE IF NOT EXISTS diagnosis_records (
  id TEXT PRIMARY KEY,
  incident_id TEXT REFERENCES error_incidents(incident_id) ON DELETE SET NULL,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  node_id TEXT,
  error_fingerprint TEXT NOT NULL,
  confidence REAL NOT NULL,
  diagnosis_json TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diagnosis_fingerprint
  ON diagnosis_records(error_fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_diagnosis_incident
  ON diagnosis_records(incident_id);

CREATE TABLE IF NOT EXISTS learned_lessons (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  cause TEXT NOT NULL,
  fix TEXT NOT NULL,
  mitigation_json TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  source_incident_id TEXT REFERENCES error_incidents(incident_id) ON DELETE SET NULL,
  source_diagnosis_id TEXT REFERENCES diagnosis_records(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lessons_last_seen
  ON learned_lessons(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS auto_fix_actions (
  action_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES error_incidents(incident_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  risk_tier INTEGER NOT NULL CHECK (risk_tier IN (0, 1, 2)),
  plan_json TEXT NOT NULL,
  rollback_plan_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'applied', 'rolled_back', 'rejected')),
  outcome TEXT CHECK (outcome IN ('success', 'failed') OR outcome IS NULL),
  applied_at TEXT,
  rolled_back_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auto_fix_actions_incident
  ON auto_fix_actions(incident_id);

CREATE INDEX IF NOT EXISTS idx_auto_fix_actions_user
  ON auto_fix_actions(user_id);

CREATE INDEX IF NOT EXISTS idx_auto_fix_actions_status
  ON auto_fix_actions(status);

CREATE TABLE IF NOT EXISTS approval_requests (
  request_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES auto_fix_actions(action_id) ON DELETE CASCADE,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  risk_tier INTEGER NOT NULL CHECK (risk_tier = 2),
  plan_json TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  response_reason TEXT,
  responded_at TEXT,
  responded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_user_status
  ON approval_requests(user_id, status);

CREATE INDEX IF NOT EXISTS idx_approval_requests_action
  ON approval_requests(action_id);

CREATE TABLE IF NOT EXISTS learning_metrics (
  day TEXT PRIMARY KEY,
  success_rate REAL,
  auto_fix_success_rate REAL,
  rollback_rate REAL,
  incidents_total INTEGER NOT NULL DEFAULT 0,
  facts_updated INTEGER NOT NULL DEFAULT 0,
  actions_executed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- End unified learning/approval schema
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  ip TEXT,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_type, actor_id, ts DESC);
`;

/** V001 baseline schema migration (authoritative §10.2 DDL). */
export const V001_INITIAL_MIGRATION: FridaySqliteMigration = {
  version: 1,
  name: "v001-initial",
  sql: V001_INITIAL_SQL,
  checksum: computeFridayMigrationChecksum(V001_INITIAL_SQL),
  acceptedChecksums: ["7112f07518cf1832235a246943dad280fd65e721bf85e41b16b29913f759c2af"], // pragma: allowlist secret
};
