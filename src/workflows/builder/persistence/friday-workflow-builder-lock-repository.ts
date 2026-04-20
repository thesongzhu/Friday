import type Database from "better-sqlite3";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowEditLock } from "../model/friday-workflow-builder-collaboration.types.js";

// ─── Interface ───

export interface FridayWorkflowBuilderLockRepository {
  getLock(db: Database.Database, workflowId: UUID): FridayWorkflowEditLock | null;
  setLock(db: Database.Database, lock: FridayWorkflowEditLock): void;
  deleteLock(db: Database.Database, workflowId: UUID): void;
}

// ─── Factory ───

export function createFridayWorkflowBuilderLockRepository(): FridayWorkflowBuilderLockRepository {
  return {
    getLock(db, workflowId) {
      const row = db
        .prepare(
          `SELECT workflow_id, lock_token, owner_user_id, owner_session_id, acquired_at, heartbeat_at, expires_at
           FROM workflow_locks
           WHERE workflow_id = ?
           ORDER BY updated_at DESC, acquired_at DESC
           LIMIT 1`,
        )
        .get(workflowId) as
        | {
            workflow_id: UUID;
            lock_token: string;
            owner_user_id: UUID;
            owner_session_id: string | null;
            acquired_at: string;
            heartbeat_at: string;
            expires_at: string;
          }
        | undefined;

      if (!row) {
        return null;
      }

      return {
        workflowId: row.workflow_id,
        lockToken: row.lock_token,
        ownerUserId: row.owner_user_id,
        ownerSessionId: row.owner_session_id ?? undefined,
        acquiredAt: row.acquired_at,
        heartbeatAt: row.heartbeat_at,
        expiresAt: row.expires_at,
      };
    },

    setLock(db, lock) {
      db.prepare(`DELETE FROM workflow_locks WHERE workflow_id = ?`).run(lock.workflowId);

      db.prepare(
        `INSERT INTO workflow_locks (
           workflow_id,
           lock_token,
           owner_user_id,
           owner_session_id,
           acquired_at,
           heartbeat_at,
           expires_at,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        lock.workflowId,
        lock.lockToken,
        lock.ownerUserId,
        lock.ownerSessionId ?? null,
        lock.acquiredAt,
        lock.heartbeatAt,
        lock.expiresAt,
        lock.acquiredAt,
        lock.heartbeatAt,
      );
    },

    deleteLock(db, workflowId) {
      db.prepare(`DELETE FROM workflow_locks WHERE workflow_id = ?`).run(workflowId);
    },
  };
}
