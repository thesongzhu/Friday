import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V002_PHASE8_API_FOUNDATION_SQL = `
-- ============================================================
-- V002: Phase 8 – API Foundation tables
-- ============================================================

-- Realtime event stream persistence
CREATE TABLE IF NOT EXISTS realtime_events (
  event_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  emitted_at TEXT NOT NULL,
  correlation_id TEXT,
  state_version_json TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_events_stream_seq
  ON realtime_events(stream_id, seq);

CREATE INDEX IF NOT EXISTS idx_realtime_events_emitted
  ON realtime_events(emitted_at);

-- Realtime client checkpoint storage
CREATE TABLE IF NOT EXISTS realtime_checkpoints (
  principal_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  last_acked_seq INTEGER NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1,
  cursor TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, stream_id)
);

-- Rate limit counters
CREATE TABLE IF NOT EXISTS api_rate_limit_counters (
  bucket_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_window
  ON api_rate_limit_counters(window_start);

-- Workflow conflict records
CREATE TABLE IF NOT EXISTS workflow_conflicts (
  conflict_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  base_workflow_version_id TEXT,
  head_workflow_version_id TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_user_id TEXT,
  summary TEXT NOT NULL,
  patches_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_conflicts_workflow
  ON workflow_conflicts(workflow_id, status);

CREATE INDEX IF NOT EXISTS idx_workflow_conflicts_draft
  ON workflow_conflicts(draft_id);

-- Workflow collaboration locks
CREATE TABLE IF NOT EXISTS workflow_locks (
  workflow_id TEXT NOT NULL,
  lock_token TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_session_id TEXT,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, lock_token)
);

CREATE INDEX IF NOT EXISTS idx_workflow_locks_workflow
  ON workflow_locks(workflow_id);

-- Workflow builder drafts
CREATE TABLE IF NOT EXISTS workflow_builder_drafts (
  draft_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL DEFAULT 1,
  spec_json TEXT NOT NULL DEFAULT '{}',
  visual_json TEXT NOT NULL DEFAULT '{}',
  owner_user_id TEXT,
  base_workflow_version_id TEXT,
  lock_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  autosave_enabled INTEGER NOT NULL DEFAULT 0,
  autosave_interval_ms INTEGER NOT NULL DEFAULT 30000
);

CREATE INDEX IF NOT EXISTS idx_builder_drafts_workflow
  ON workflow_builder_drafts(workflow_id);
`;

const V002_CHECKSUM = computeFridayMigrationChecksum(V002_PHASE8_API_FOUNDATION_SQL);

export const V002_PHASE8_API_FOUNDATION_MIGRATION: FridaySqliteMigration = {
  version: 2,
  name: "v002-phase8-api-foundation",
  sql: V002_PHASE8_API_FOUNDATION_SQL,
  checksum: V002_CHECKSUM,
};
