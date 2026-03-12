import type Database from "better-sqlite3";
import type {
  FridayMemoryGuardNamespaceUsage,
  FridayMemoryGuardPruneExpiredResult,
  FridayMemoryGuardQuotaRepository,
} from "../model/friday-memory-guard.types.js";

interface UsageRow {
  item_count: number;
  total_bytes: number;
  expired_item_count: number;
  expired_bytes: number;
}

interface NamespaceRow {
  namespace: string;
}

interface ExpiredRow {
  id: string;
  content_bytes: number;
}

export function createFridayMemoryGuardQuotaRepository(): FridayMemoryGuardQuotaRepository {
  return {
    getNamespaceUsage(db: Database.Database, namespace: string, nowIso: string): FridayMemoryGuardNamespaceUsage {
      const row = db.prepare(`
        SELECT
          COUNT(*) AS item_count,
          COALESCE(SUM(LENGTH(CAST(COALESCE(content_text, '') AS BLOB))), 0) AS total_bytes,
          COALESCE(SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END), 0) AS expired_item_count,
          COALESCE(SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN LENGTH(CAST(COALESCE(content_text, '') AS BLOB)) ELSE 0 END), 0) AS expired_bytes
        FROM memory_items
        WHERE namespace = ?
      `).get(nowIso, nowIso, namespace) as UsageRow | undefined;

      return {
        namespace,
        itemCount: row?.item_count ?? 0,
        totalBytes: row?.total_bytes ?? 0,
        expiredItemCount: row?.expired_item_count ?? 0,
        expiredBytes: row?.expired_bytes ?? 0,
      };
    },

    listNamespacesByPrefix(db: Database.Database, prefix: string, limit: number): string[] {
      const rows = db.prepare(`
        SELECT DISTINCT namespace
        FROM memory_items
        WHERE namespace = ? OR namespace LIKE ? || '.%'
        ORDER BY namespace
        LIMIT ?
      `).all(prefix, prefix, limit) as NamespaceRow[];

      return rows.map((r) => r.namespace);
    },

    pruneExpiredOldest(db: Database.Database, input: { namespace: string; nowIso: string; limit: number }): FridayMemoryGuardPruneExpiredResult {
      // Find oldest expired items
      const rows = db.prepare(`
        SELECT id, LENGTH(CAST(COALESCE(content_text, '') AS BLOB)) AS content_bytes
        FROM memory_items
        WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at ASC
        LIMIT ?
      `).all(input.namespace, input.nowIso, input.limit) as ExpiredRow[];

      if (rows.length === 0) {
        return { deletedCount: 0, deletedBytes: 0, deletedIds: [] };
      }

      const ids = rows.map((r) => r.id);
      const totalBytes = rows.reduce((sum, r) => sum + r.content_bytes, 0);

      // Delete the expired rows
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM memory_items WHERE id IN (${placeholders})`).run(...ids);

      return {
        deletedCount: ids.length,
        deletedBytes: totalBytes,
        deletedIds: ids,
      };
    },
  };
}
