import { computeFridayMigrationChecksum } from "./friday-migration.types.js";

import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V006_SESSION_MEMORY_EXTRACTION_SQL = `
-- V006: Session memory extraction jobs (auto + manual + retry pipeline)

CREATE TABLE IF NOT EXISTS session_memory_extraction_jobs (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('auto','manual','retry')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  requested_message_ids_json TEXT,
  batch_size INTEGER NOT NULL,
  max_batches INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_mem_extract_jobs_status_next
  ON session_memory_extraction_jobs(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_session_mem_extract_jobs_session_created
  ON session_memory_extraction_jobs(session_key, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_mem_extract_jobs_auto_open
  ON session_memory_extraction_jobs(session_key)
  WHERE trigger = 'auto' AND status IN ('queued','running');
`;

const V006_CHECKSUM = computeFridayMigrationChecksum(V006_SESSION_MEMORY_EXTRACTION_SQL);

export const V006_SESSION_MEMORY_EXTRACTION_MIGRATION: FridaySqliteMigration = {
  version: 6,
  name: "v006-session-memory-extraction",
  sql: V006_SESSION_MEMORY_EXTRACTION_SQL,
  checksum: V006_CHECKSUM,
};
