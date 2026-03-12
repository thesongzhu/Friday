import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

/**
 * V025: Fix UPDATE triggers for memory file sync dirty queue.
 *
 * F1 (CX25): The v023 session_messages UPDATE trigger has a top-level
 * `WHEN NEW.session_key IS NOT NULL`, which means updates from non-null
 * to null skip trigger execution entirely and never dirty the OLD key.
 *
 * Similarly, memory_items UPDATE trigger only dirtied NEW.namespace but
 * not OLD.namespace when namespace changes.
 *
 * This forward migration drops and recreates the UPDATE triggers without
 * top-level WHEN, using conditional INSERT inside the trigger body to
 * dirty both OLD and NEW keys when appropriate.
 *
 * v023 is treated as immutable (checksum-safe for applied migrations).
 */
export const V025_MEMORY_FILE_SYNC_TRIGGER_FIXES_SQL = `
-- V025: Fix UPDATE triggers — dirty both OLD and NEW keys

-- ─── memory_items UPDATE: dirty both OLD and NEW namespace ───

DROP TRIGGER IF EXISTS trg_memory_file_sync_dirty_mem_update;

CREATE TRIGGER trg_memory_file_sync_dirty_mem_update
AFTER UPDATE ON memory_items
BEGIN
  -- Always dirty the NEW namespace
  INSERT INTO memory_file_sync_dirty (entity_type, entity_key, first_dirty_at, last_dirty_at)
  VALUES ('memory_namespace', NEW.namespace, datetime('now'), datetime('now'))
  ON CONFLICT(entity_type, entity_key)
  DO UPDATE SET last_dirty_at = datetime('now');

  -- Dirty the OLD namespace when it changed
  INSERT INTO memory_file_sync_dirty (entity_type, entity_key, first_dirty_at, last_dirty_at)
  SELECT 'memory_namespace', OLD.namespace, datetime('now'), datetime('now')
  WHERE OLD.namespace != NEW.namespace
  ON CONFLICT(entity_type, entity_key)
  DO UPDATE SET last_dirty_at = datetime('now');
END;

-- ─── session_messages UPDATE: dirty both OLD and NEW session_key ───

DROP TRIGGER IF EXISTS trg_memory_file_sync_dirty_sess_update;

CREATE TRIGGER trg_memory_file_sync_dirty_sess_update
AFTER UPDATE ON session_messages
BEGIN
  -- Dirty NEW session_key when non-null
  INSERT INTO memory_file_sync_dirty (entity_type, entity_key, first_dirty_at, last_dirty_at)
  SELECT 'session_key', NEW.session_key, datetime('now'), datetime('now')
  WHERE NEW.session_key IS NOT NULL
  ON CONFLICT(entity_type, entity_key)
  DO UPDATE SET last_dirty_at = datetime('now');

  -- Dirty OLD session_key when non-null AND (key changed or NEW is null)
  INSERT INTO memory_file_sync_dirty (entity_type, entity_key, first_dirty_at, last_dirty_at)
  SELECT 'session_key', OLD.session_key, datetime('now'), datetime('now')
  WHERE OLD.session_key IS NOT NULL
    AND (NEW.session_key IS NULL OR OLD.session_key != NEW.session_key)
  ON CONFLICT(entity_type, entity_key)
  DO UPDATE SET last_dirty_at = datetime('now');
END;
`;

const V025_CHECKSUM = computeFridayMigrationChecksum(V025_MEMORY_FILE_SYNC_TRIGGER_FIXES_SQL);

export const V025_MEMORY_FILE_SYNC_TRIGGER_FIXES_MIGRATION: FridaySqliteMigration = {
  version: 25,
  name: "v025-memory-file-sync-trigger-fixes",
  sql: V025_MEMORY_FILE_SYNC_TRIGGER_FIXES_SQL,
  checksum: V025_CHECKSUM,
};
