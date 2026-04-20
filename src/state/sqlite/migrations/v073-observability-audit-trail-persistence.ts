import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V073_OBSERVABILITY_AUDIT_TRAIL_PERSISTENCE_SQL = `
-- V073: Persist observability audit trail entries and retention checkpoints.

CREATE TABLE IF NOT EXISTS obs_audit_entries (
  id TEXT PRIMARY KEY,
  sequence_number INTEGER NOT NULL UNIQUE,
  actor_json TEXT NOT NULL,
  action_category TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_json TEXT NOT NULL,
  outcome TEXT NOT NULL,
  description TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  module TEXT NOT NULL,
  trace_id TEXT,
  span_id TEXT,
  integrity_hash TEXT NOT NULL,
  previous_hash TEXT,
  metadata_json TEXT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_audit_entries_recorded_at
  ON obs_audit_entries (recorded_at);

CREATE INDEX IF NOT EXISTS idx_obs_audit_entries_trace_id
  ON obs_audit_entries (trace_id);

CREATE INDEX IF NOT EXISTS idx_obs_audit_entries_module_recorded_at
  ON obs_audit_entries (module, recorded_at);

CREATE TABLE IF NOT EXISTS obs_retention_checkpoints (
  id TEXT PRIMARY KEY,
  last_deleted_sequence_number INTEGER NOT NULL UNIQUE,
  boundary_hash TEXT NOT NULL,
  first_retained_sequence_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_retention_checkpoints_created_at
  ON obs_retention_checkpoints (created_at);
`;

const V073_CHECKSUM = computeFridayMigrationChecksum(
  V073_OBSERVABILITY_AUDIT_TRAIL_PERSISTENCE_SQL,
);

export const V073_OBSERVABILITY_AUDIT_TRAIL_PERSISTENCE_MIGRATION: FridaySqliteMigration = {
  version: 73,
  name: "v073-observability-audit-trail-persistence",
  sql: V073_OBSERVABILITY_AUDIT_TRAIL_PERSISTENCE_SQL,
  checksum: V073_CHECKSUM,
};
