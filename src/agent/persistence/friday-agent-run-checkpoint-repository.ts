import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";

export interface FridayAgentRunCheckpointManifestEntry {
  runId: string;
  canonicalPath: string;
  originalPath: string;
  existedBefore: boolean;
  backupPath?: string;
  snapshotAt: string;
  rollbackAvailable: boolean;
  updatedAt: string;
}

interface FridayAgentRunCheckpointRow {
  run_id: string;
  canonical_path: string;
  original_path: string;
  existed_before: number;
  backup_path: string | null;
  snapshot_at: string;
  rollback_available: number;
  updated_at: string;
}

export interface FridayAgentRunCheckpointRepository {
  upsert(entry: FridayAgentRunCheckpointManifestEntry): void;
  listByRunId(runId: string): FridayAgentRunCheckpointManifestEntry[];
  hasAvailable(runId: string): boolean;
  markUnavailable(runId: string, canonicalPath: string, updatedAt: string): void;
  deleteRun(runId: string): void;
  /**
   * List manifest entries whose `snapshot_at` is strictly before `beforeIso`.
   *
   * Used by the TTL prune flow to find expired backup state. Returns entries
   * regardless of `rollbackAvailable` so callers can clean up both rolled-back
   * (unavailable) entries and abandoned (still-available) entries past the
   * retention deadline. Sorted by `snapshot_at` ASC.
   */
  listOlderThan(beforeIso: string): FridayAgentRunCheckpointManifestEntry[];
  /** Delete a single manifest entry by (runId, canonicalPath). */
  deleteEntry(runId: string, canonicalPath: string): void;
}

export interface CreateFridayAgentRunCheckpointRepositoryDeps {
  db: FridaySqliteLayer;
}

function mapRow(
  row: FridayAgentRunCheckpointRow,
): FridayAgentRunCheckpointManifestEntry {
  return {
    runId: row.run_id,
    canonicalPath: row.canonical_path,
    originalPath: row.original_path,
    existedBefore: row.existed_before === 1,
    backupPath: row.backup_path ?? undefined,
    snapshotAt: row.snapshot_at,
    rollbackAvailable: row.rollback_available === 1,
    updatedAt: row.updated_at,
  };
}

function listByRunId(
  db: Database.Database,
  runId: string,
): FridayAgentRunCheckpointManifestEntry[] {
  const rows = db
    .prepare(
      `SELECT run_id, canonical_path, original_path, existed_before, backup_path, snapshot_at, rollback_available, updated_at
         FROM friday_agent_run_checkpoints
        WHERE run_id = ?
        ORDER BY snapshot_at ASC`,
    )
    .all(runId) as FridayAgentRunCheckpointRow[];
  return rows.map(mapRow);
}

export function createFridayAgentRunCheckpointRepository(
  deps: CreateFridayAgentRunCheckpointRepositoryDeps,
): FridayAgentRunCheckpointRepository {
  return {
    upsert(entry) {
      deps.db.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO friday_agent_run_checkpoints (
             run_id,
             canonical_path,
             original_path,
             existed_before,
             backup_path,
             snapshot_at,
             rollback_available,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, canonical_path) DO UPDATE SET
             original_path = excluded.original_path,
             existed_before = excluded.existed_before,
             backup_path = excluded.backup_path,
             snapshot_at = excluded.snapshot_at,
             rollback_available = excluded.rollback_available,
             updated_at = excluded.updated_at`,
        ).run(
          entry.runId,
          entry.canonicalPath,
          entry.originalPath,
          entry.existedBefore ? 1 : 0,
          entry.backupPath ?? null,
          entry.snapshotAt,
          entry.rollbackAvailable ? 1 : 0,
          entry.updatedAt,
        );
      });
    },

    listByRunId(runId) {
      return deps.db.withReadConnection((db) => listByRunId(db, runId));
    },

    hasAvailable(runId) {
      return deps.db.withReadConnection((db) => {
        const row = db
          .prepare(
            `SELECT 1
               FROM friday_agent_run_checkpoints
              WHERE run_id = ?
                AND rollback_available = 1
              LIMIT 1`,
          )
          .get(runId) as { 1: number } | undefined;
        return Boolean(row);
      });
    },

    markUnavailable(runId, canonicalPath, updatedAt) {
      deps.db.withWriteTransaction((db) => {
        db.prepare(
          `UPDATE friday_agent_run_checkpoints
              SET rollback_available = 0,
                  updated_at = ?
            WHERE run_id = ?
              AND canonical_path = ?`,
        ).run(updatedAt, runId, canonicalPath);
      });
    },

    deleteRun(runId) {
      deps.db.withWriteTransaction((db) => {
        db.prepare("DELETE FROM friday_agent_run_checkpoints WHERE run_id = ?").run(runId);
      });
    },

    listOlderThan(beforeIso) {
      return deps.db.withReadConnection((db) => {
        const rows = db
          .prepare(
            `SELECT run_id, canonical_path, original_path, existed_before, backup_path, snapshot_at, rollback_available, updated_at
               FROM friday_agent_run_checkpoints
              WHERE snapshot_at < ?
              ORDER BY snapshot_at ASC`,
          )
          .all(beforeIso) as FridayAgentRunCheckpointRow[];
        return rows.map(mapRow);
      });
    },

    deleteEntry(runId, canonicalPath) {
      deps.db.withWriteTransaction((db) => {
        db.prepare(
          "DELETE FROM friday_agent_run_checkpoints WHERE run_id = ? AND canonical_path = ?",
        ).run(runId, canonicalPath);
      });
    },
  };
}
