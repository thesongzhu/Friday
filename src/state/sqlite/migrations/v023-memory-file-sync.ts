import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V023_MEMORY_FILE_SYNC_SQL = `
-- V023: Memory file sync — dirty queue, state table, and triggers

-- Dirty queue: deduped by (entity_type, entity_key)
CREATE TABLE IF NOT EXISTS memory_file_sync_dirty (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('memory_namespace', 'session_key')),
  entity_key TEXT NOT NULL,
  first_dirty_at TEXT NOT NULL,
  last_dirty_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_file_sync_dirty_last
  ON memory_file_sync_dirty(last_dirty_at);

-- State table: tracks exported file path, content hash, last sequence
CREATE TABLE IF NOT EXISTS memory_file_sync_state (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('memory_namespace', 'session_key')),
  entity_key TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  last_exported_sequence INTEGER,
  exported_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_key)
);

-- Trigger: memory_items INSERT -> dirty memory_namespace
CREATE TRIGGER IF NOT EXISTS trg_memory_file_sync_dirty_mem_insert
AFTER INSERT ON memory_items
BEGIN
  INSERT INTO memory_file_sync_dirty (entity_type, entity_key, first_dirty_at, last_dirty_at)
  VALUES ('memory_namespace', NEW.namespace, datetime('now'), datetime('now'))
  ON CONFLICT(entity_type, entity_key)
  DO UPDATE SET last_dirty_at = datetime('now');
END;

-- Trigger: memory_items UPDATE -> dirty memory_namespace
CREATE TRIGGER IF NOT EXISTS trg_memory_file_sync_dirty_mem_update
AFTER UPDATE ON memory_items
BEGIN
  INSERT INTO memory_file_sync_dirty (entity_type, entity_key, first_dirty_at, last_dirty_at)
  VALUES ('memory_namespace', NEW.namespace, datetime('now'), datetime('now'))
  ON CONFLICT(entity_type, entity_key)
  DO UPDATE SET last_dirty_at = datetime('now');
END;

-- Trigger: memory_items DELETE -> dirty memory_namespace
CREATE TRIGGER IF NOT EXISTS trg_memory_file_sync_dirty_mem_delete
AFTER DELETE ON memory_items
BEGIN
  INSERT INTO memory_file_sync_dirty (entity_type, entity_key, first_dirty_at, last_dirty_at)
  VALUES ('memory_namespace', OLD.namespace, datetime('now'), datetime('now'))
  ON CONFLICT(entity_type, entity_key)
  DO UPDATE SET last_dirty_at = datetime('now');
END;

-- Trigger: session_messages INSERT -> dirty session_key
CREATE TRIGGER IF NOT EXISTS trg_memory_file_sync_dirty_sess_insert
AFTER INSERT ON session_messages
WHEN NEW.session_key IS NOT NULL
BEGIN
  INSERT INTO memory_file_sync_dirty (entity_type, entity_key, first_dirty_at, last_dirty_at)
  VALUES ('session_key', NEW.session_key, datetime('now'), datetime('now'))
  ON CONFLICT(entity_type, entity_key)
  DO UPDATE SET last_dirty_at = datetime('now');
END;

-- Trigger: session_messages UPDATE -> dirty session_key
CREATE TRIGGER IF NOT EXISTS trg_memory_file_sync_dirty_sess_update
AFTER UPDATE ON session_messages
WHEN NEW.session_key IS NOT NULL
BEGIN
  INSERT INTO memory_file_sync_dirty (entity_type, entity_key, first_dirty_at, last_dirty_at)
  VALUES ('session_key', NEW.session_key, datetime('now'), datetime('now'))
  ON CONFLICT(entity_type, entity_key)
  DO UPDATE SET last_dirty_at = datetime('now');
END;

-- Trigger: session_messages DELETE -> dirty session_key
CREATE TRIGGER IF NOT EXISTS trg_memory_file_sync_dirty_sess_delete
AFTER DELETE ON session_messages
WHEN OLD.session_key IS NOT NULL
BEGIN
  INSERT INTO memory_file_sync_dirty (entity_type, entity_key, first_dirty_at, last_dirty_at)
  VALUES ('session_key', OLD.session_key, datetime('now'), datetime('now'))
  ON CONFLICT(entity_type, entity_key)
  DO UPDATE SET last_dirty_at = datetime('now');
END;
`;

const V023_CHECKSUM = computeFridayMigrationChecksum(V023_MEMORY_FILE_SYNC_SQL);

export const V023_MEMORY_FILE_SYNC_MIGRATION: FridaySqliteMigration = {
  version: 23,
  name: "v023-memory-file-sync",
  sql: V023_MEMORY_FILE_SYNC_SQL,
  checksum: V023_CHECKSUM,
};
