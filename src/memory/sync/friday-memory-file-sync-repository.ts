import type { FridaySqliteLayer } from "#state";
import type {
  FridayMemoryFileSyncDirtyRow,
  FridayMemoryFileSyncStateRow,
  FridayMemorySyncEntityType,
} from "./friday-memory-file-sync.types.js";

// ─── Raw DB row shapes ───

interface DirtyDbRow {
  entity_type: string;
  entity_key: string;
  first_dirty_at: string;
  last_dirty_at: string;
}

interface StateDbRow {
  entity_type: string;
  entity_key: string;
  file_path: string;
  content_hash: string;
  last_exported_sequence: number | null;
  exported_at: string;
  last_exported_hash: string | null;
  last_exported_mtime_ms: number | null;
}

interface MemoryItemRow {
  id: string;
  namespace: string;
  key: string;
  value_json: string;
  content_text: string | null;
  source: string;
  tags_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface SessionMessageRow {
  id: string;
  session_key: string;
  role: string;
  content_json: string;
  content_text: string | null;
  sequence: number;
  occurred_at: string;
  created_at: string;
}

// ─── Interface ───

export interface FridayMemoryFileSyncRepository {
  /** Count dirty entries. */
  dirtyCount(): number;

  /** Fetch a batch of dirty entries ordered by last_dirty_at. */
  fetchDirtyBatch(limit: number): FridayMemoryFileSyncDirtyRow[];

  /** Remove a dirty entry after it has been synced. */
  removeDirty(entityType: FridayMemorySyncEntityType, entityKey: string): void;

  /** Get the sync state for a given entity. */
  getState(entityType: FridayMemorySyncEntityType, entityKey: string): FridayMemoryFileSyncStateRow | null;

  /** Upsert sync state after writing a file. */
  upsertState(row: FridayMemoryFileSyncStateRow): void;

  /** Delete sync state (when file is removed). */
  deleteState(entityType: FridayMemorySyncEntityType, entityKey: string): void;

  /** Fetch all memory items for a namespace. */
  fetchMemoryItems(namespace: string): MemoryItemRow[];

  /** Fetch session messages, optionally starting after a sequence number. */
  fetchSessionMessages(sessionKey: string, afterSequence?: number): SessionMessageRow[];

  /** Count session messages for a key. */
  countSessionMessages(sessionKey: string): number;

  /** List all tracked sync state rows. */
  listAllStates(): FridayMemoryFileSyncStateRow[];

  /** Upsert memory items from a parsed namespace export file. */
  upsertMemoryItemsFromExport(
    namespace: string,
    items: Array<{
      id: string;
      key: string;
      value_json: string;
      content_text: string | null;
      source: string;
      tags_json: string;
      metadata_json: string;
      created_at: string;
      updated_at: string;
    }>,
  ): { upserted: number; deleted: number };

  /** Delete all memory items in a namespace (used when file is deleted externally). */
  deleteMemoryNamespace(namespace: string): number;
}

// ─── Factory ───

export function createFridayMemoryFileSyncRepository(deps: {
  db: FridaySqliteLayer;
}): FridayMemoryFileSyncRepository {
  const { db } = deps;

  return {
    dirtyCount(): number {
      return db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT COUNT(*) AS cnt FROM memory_file_sync_dirty").get() as { cnt: number };
        return row.cnt;
      });
    },

    fetchDirtyBatch(limit: number): FridayMemoryFileSyncDirtyRow[] {
      return db.withReadConnection((conn) => {
        const rows = conn
          .prepare("SELECT entity_type, entity_key, first_dirty_at, last_dirty_at FROM memory_file_sync_dirty ORDER BY last_dirty_at ASC LIMIT ?")
          .all(limit) as DirtyDbRow[];
        return rows.map(mapDirtyRow);
      });
    },

    removeDirty(entityType: FridayMemorySyncEntityType, entityKey: string): void {
      db.withWriteTransaction((conn) => {
        conn.prepare("DELETE FROM memory_file_sync_dirty WHERE entity_type = ? AND entity_key = ?").run(entityType, entityKey);
      });
    },

    getState(entityType: FridayMemorySyncEntityType, entityKey: string): FridayMemoryFileSyncStateRow | null {
      return db.withReadConnection((conn) => {
        const row = conn
          .prepare("SELECT entity_type, entity_key, file_path, content_hash, last_exported_sequence, exported_at, last_exported_hash, last_exported_mtime_ms FROM memory_file_sync_state WHERE entity_type = ? AND entity_key = ?")
          .get(entityType, entityKey) as StateDbRow | undefined;
        return row ? mapStateRow(row) : null;
      });
    },

    upsertState(row: FridayMemoryFileSyncStateRow): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `INSERT INTO memory_file_sync_state (entity_type, entity_key, file_path, content_hash, last_exported_sequence, exported_at, last_exported_hash, last_exported_mtime_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(entity_type, entity_key)
             DO UPDATE SET file_path = excluded.file_path,
                           content_hash = excluded.content_hash,
                           last_exported_sequence = excluded.last_exported_sequence,
                           exported_at = excluded.exported_at,
                           last_exported_hash = excluded.last_exported_hash,
                           last_exported_mtime_ms = excluded.last_exported_mtime_ms`,
          )
          .run(
            row.entityType,
            row.entityKey,
            row.filePath,
            row.contentHash,
            row.lastExportedSequence,
            row.exportedAt,
            row.lastExportedHash ?? null,
            row.lastExportedMtimeMs ?? null,
          );
      });
    },

    deleteState(entityType: FridayMemorySyncEntityType, entityKey: string): void {
      db.withWriteTransaction((conn) => {
        conn.prepare("DELETE FROM memory_file_sync_state WHERE entity_type = ? AND entity_key = ?").run(entityType, entityKey);
      });
    },

    fetchMemoryItems(namespace: string): MemoryItemRow[] {
      return db.withReadConnection((conn) => {
        return conn
          .prepare(
            `SELECT id, namespace, key, value_json, content_text, source, tags_json, metadata_json, created_at, updated_at
             FROM memory_items WHERE namespace = ? ORDER BY key ASC`,
          )
          .all(namespace) as MemoryItemRow[];
      });
    },

    fetchSessionMessages(sessionKey: string, afterSequence?: number): SessionMessageRow[] {
      return db.withReadConnection((conn) => {
        if (afterSequence != null) {
          return conn
            .prepare(
              `SELECT id, session_key, role, content_json, content_text, sequence, occurred_at, created_at
               FROM session_messages WHERE session_key = ? AND sequence > ? ORDER BY sequence ASC`,
            )
            .all(sessionKey, afterSequence) as SessionMessageRow[];
        }
        return conn
          .prepare(
            `SELECT id, session_key, role, content_json, content_text, sequence, occurred_at, created_at
             FROM session_messages WHERE session_key = ? ORDER BY sequence ASC`,
          )
          .all(sessionKey) as SessionMessageRow[];
      });
    },

    countSessionMessages(sessionKey: string): number {
      return db.withReadConnection((conn) => {
        const row = conn
          .prepare("SELECT COUNT(*) AS cnt FROM session_messages WHERE session_key = ?")
          .get(sessionKey) as { cnt: number };
        return row.cnt;
      });
    },

    listAllStates(): FridayMemoryFileSyncStateRow[] {
      return db.withReadConnection((conn) => {
        const rows = conn
          .prepare("SELECT entity_type, entity_key, file_path, content_hash, last_exported_sequence, exported_at, last_exported_hash, last_exported_mtime_ms FROM memory_file_sync_state ORDER BY entity_type, entity_key")
          .all() as StateDbRow[];
        return rows.map(mapStateRow);
      });
    },

    upsertMemoryItemsFromExport(namespace, items) {
      return db.withWriteTransaction((conn) => {
        // Get existing items for this namespace
        const existingRows = conn
          .prepare("SELECT id FROM memory_items WHERE namespace = ?")
          .all(namespace) as Array<{ id: string }>;
        const existingIds = new Set(existingRows.map((r) => r.id));

        const importedIds = new Set<string>();
        let upserted = 0;

        const upsertStmt = conn.prepare(
          `INSERT INTO memory_items (id, namespace, key, value_json, content_text, source, tags_json, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id)
           DO UPDATE SET key = excluded.key,
                         value_json = excluded.value_json,
                         content_text = excluded.content_text,
                         source = excluded.source,
                         tags_json = excluded.tags_json,
                         metadata_json = excluded.metadata_json,
                         updated_at = excluded.updated_at`,
        );

        for (const item of items) {
          upsertStmt.run(
            item.id,
            namespace,
            item.key,
            item.value_json,
            item.content_text,
            item.source,
            item.tags_json,
            item.metadata_json,
            item.created_at,
            item.updated_at,
          );
          importedIds.add(item.id);
          upserted++;
        }

        // Delete items that exist in DB but not in the imported file
        let deleted = 0;
        const deleteStmt = conn.prepare("DELETE FROM memory_items WHERE id = ?");
        for (const existingId of existingIds) {
          if (!importedIds.has(existingId)) {
            deleteStmt.run(existingId);
            deleted++;
          }
        }

        return { upserted, deleted };
      });
    },

    deleteMemoryNamespace(namespace: string): number {
      return db.withWriteTransaction((conn) => {
        const info = conn.prepare("DELETE FROM memory_items WHERE namespace = ?").run(namespace);
        return info.changes;
      });
    },
  };
}

// ─── Mappers ───

function mapDirtyRow(row: DirtyDbRow): FridayMemoryFileSyncDirtyRow {
  return {
    entityType: row.entity_type as FridayMemorySyncEntityType,
    entityKey: row.entity_key,
    firstDirtyAt: row.first_dirty_at,
    lastDirtyAt: row.last_dirty_at,
  };
}

function mapStateRow(row: StateDbRow): FridayMemoryFileSyncStateRow {
  return {
    entityType: row.entity_type as FridayMemorySyncEntityType,
    entityKey: row.entity_key,
    filePath: row.file_path,
    contentHash: row.content_hash,
    lastExportedSequence: row.last_exported_sequence,
    exportedAt: row.exported_at,
    lastExportedHash: row.last_exported_hash,
    lastExportedMtimeMs: row.last_exported_mtime_ms,
  };
}
