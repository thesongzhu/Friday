import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V004_MEMORY_CORE_SQL = `
-- ============================================================
-- V004: Core memory storage + hybrid search
-- Extends existing v001 memory_items table for compatibility.
-- ============================================================

ALTER TABLE memory_items ADD COLUMN content_text TEXT;
ALTER TABLE memory_items ADD COLUMN source TEXT NOT NULL DEFAULT 'system';
ALTER TABLE memory_items ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE memory_items ADD COLUMN ttl_seconds INTEGER;
ALTER TABLE memory_items ADD COLUMN expires_at TEXT;
ALTER TABLE memory_items ADD COLUMN tags_text TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_memory_items_namespace_updated
  ON memory_items(namespace, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_items_source_updated
  ON memory_items(source, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_items_expires_at
  ON memory_items(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_embeddings (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(item_id, provider_id, model)
);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_item
  ON memory_embeddings(item_id);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model
  ON memory_embeddings(model);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model_updated
  ON memory_embeddings(model, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts
USING fts5(
  content_text,
  tags_text,
  namespace UNINDEXED,
  source UNINDEXED,
  content='memory_items',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_insert
AFTER INSERT ON memory_items
BEGIN
  INSERT INTO memory_items_fts(rowid, content_text, tags_text, namespace, source)
  VALUES (
    NEW.rowid,
    COALESCE(NEW.content_text, ''),
    COALESCE(NEW.tags_text, ''),
    NEW.namespace,
    NEW.source
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_update
AFTER UPDATE OF content_text, tags_text, namespace, source ON memory_items
BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, content_text, tags_text, namespace, source)
  VALUES ('delete', OLD.rowid, OLD.content_text, OLD.tags_text, OLD.namespace, OLD.source);

  INSERT INTO memory_items_fts(rowid, content_text, tags_text, namespace, source)
  VALUES (
    NEW.rowid,
    COALESCE(NEW.content_text, ''),
    COALESCE(NEW.tags_text, ''),
    NEW.namespace,
    NEW.source
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_delete
AFTER DELETE ON memory_items
BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, content_text, tags_text, namespace, source)
  VALUES ('delete', OLD.rowid, OLD.content_text, OLD.tags_text, OLD.namespace, OLD.source);
END;

-- Backfill: ensure pre-existing rows have content_text/tags_text populated
UPDATE memory_items
SET content_text = COALESCE(content_text, value_json),
    tags_text = COALESCE(NULLIF(tags_text, ''), '')
WHERE content_text IS NULL;

-- Rebuild FTS index to include any pre-existing rows
INSERT INTO memory_items_fts(memory_items_fts) VALUES('rebuild');
`;

const V004_CHECKSUM = computeFridayMigrationChecksum(V004_MEMORY_CORE_SQL);

export const V004_MEMORY_CORE_MIGRATION: FridaySqliteMigration = {
  version: 4,
  name: "v004-memory-core",
  sql: V004_MEMORY_CORE_SQL,
  checksum: V004_CHECKSUM,
};
