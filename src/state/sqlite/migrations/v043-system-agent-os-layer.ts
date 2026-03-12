import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V043_SYSTEM_AGENT_OS_LAYER_SQL = `
-- V043: Friday system / agent-os persistence (approvals, devices, leases, state journal).

CREATE TABLE IF NOT EXISTS friday_system_approval_rules (
  id TEXT PRIMARY KEY,
  app_identifier TEXT,
  action TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_friday_system_approval_rules_action
  ON friday_system_approval_rules (action, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_friday_system_approval_rules_app
  ON friday_system_approval_rules (app_identifier, updated_at DESC);

CREATE TABLE IF NOT EXISTS friday_system_remote_devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  credential_id TEXT,
  trust_scope TEXT NOT NULL,
  status TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_system_remote_devices_fingerprint
  ON friday_system_remote_devices (fingerprint);

CREATE INDEX IF NOT EXISTS idx_friday_system_remote_devices_status
  ON friday_system_remote_devices (status, registered_at DESC);

CREATE TABLE IF NOT EXISTS friday_system_control_leases (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  reason TEXT,
  acquired_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_friday_system_control_leases_active
  ON friday_system_control_leases (revoked_at, expires_at, acquired_at DESC);

CREATE TABLE IF NOT EXISTS friday_system_state_journal (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  emitted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friday_system_state_journal_seq
  ON friday_system_state_journal (seq);

CREATE INDEX IF NOT EXISTS idx_friday_system_state_journal_event
  ON friday_system_state_journal (event_name, emitted_at DESC);
`;

const V043_CHECKSUM = computeFridayMigrationChecksum(V043_SYSTEM_AGENT_OS_LAYER_SQL);

export const V043_SYSTEM_AGENT_OS_LAYER_MIGRATION: FridaySqliteMigration = {
  version: 43,
  name: "v043-system-agent-os-layer",
  sql: V043_SYSTEM_AGENT_OS_LAYER_SQL,
  checksum: V043_CHECKSUM,
};
