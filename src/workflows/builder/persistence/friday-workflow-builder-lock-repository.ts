import type Database from "better-sqlite3";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowEditLock } from "../model/friday-workflow-builder-collaboration.types.js";

// ─── Interface ───

export interface FridayWorkflowBuilderLockRepository {
  getLock(db: Database.Database, workflowId: UUID): FridayWorkflowEditLock | null;
  setLock(db: Database.Database, lock: FridayWorkflowEditLock): void;
  deleteLock(db: Database.Database, workflowId: UUID): void;
}

// ─── Constants ───

function lockKey(workflowId: UUID): string {
  return `workflow_builder_lock:${workflowId}`;
}

// ─── Factory ───

export function createFridayWorkflowBuilderLockRepository(): FridayWorkflowBuilderLockRepository {
  return {
    getLock(db, workflowId) {
      const row = db
        .prepare(`SELECT value_json FROM hub_settings WHERE key = ?`)
        .get(lockKey(workflowId)) as { value_json: string } | undefined;
      return row ? (JSON.parse(row.value_json) as FridayWorkflowEditLock) : null;
    },

    setLock(db, lock) {
      const key = lockKey(lock.workflowId);
      const json = JSON.stringify(lock);
      const now = lock.acquiredAt;

      // Upsert into hub_settings
      const existing = db
        .prepare(`SELECT key FROM hub_settings WHERE key = ?`)
        .get(key) as { key: string } | undefined;

      if (existing) {
        db.prepare(
          `UPDATE hub_settings SET value_json = ?, revision = revision + 1, updated_at = ?, updated_by = ?
           WHERE key = ?`,
        ).run(json, now, lock.ownerUserId, key);
      } else {
        db.prepare(
          `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, 1, ?, ?, ?, ?)`,
        ).run(key, json, now, now, lock.ownerUserId, lock.ownerUserId);
      }
    },

    deleteLock(db, workflowId) {
      db.prepare(`DELETE FROM hub_settings WHERE key = ?`).run(lockKey(workflowId));
    },
  };
}
