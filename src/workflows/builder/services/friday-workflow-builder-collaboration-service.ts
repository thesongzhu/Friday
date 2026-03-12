import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import type { UUID } from "../../model/friday-workflow.types.js";
import type {
  FridayWorkflowEditLock,
  FridayWorkflowLockAcquireInput,
  FridayWorkflowLockAcquireResult,
} from "../model/friday-workflow-builder-collaboration.types.js";
import type { FridayWorkflowBuilderLockRepository } from "../persistence/friday-workflow-builder-lock-repository.js";

// ─── Interface ───

export interface FridayWorkflowBuilderCollaborationService {
  acquireLock(input: FridayWorkflowLockAcquireInput): FridayWorkflowLockAcquireResult;
  renewLock(workflowId: UUID, lockToken: string, ttlSec: number): FridayWorkflowEditLock;
  releaseLock(workflowId: UUID, lockToken: string): void;
  getLock(workflowId: UUID): FridayWorkflowEditLock | null;
  assertLock(workflowId: UUID, lockToken: string): void;
  /** Assert lock using a specific DB connection (for use inside write transactions). */
  assertLockOnConnection(db: Database.Database, workflowId: UUID, lockToken: string): void;
}

// ─── Dependencies ───

export interface CreateCollaborationServiceDeps {
  db: FridaySqliteLayer;
  lockRepo: FridayWorkflowBuilderLockRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Factory ───

export function createFridayWorkflowBuilderCollaborationService(
  deps: CreateCollaborationServiceDeps,
): FridayWorkflowBuilderCollaborationService {
  function isExpired(lock: FridayWorkflowEditLock): boolean {
    return lock.expiresAt <= deps.nowIso();
  }

  return {
    acquireLock(input) {
      return deps.db.withWriteTransaction((db) => {
        const existing = deps.lockRepo.getLock(db, input.workflowId);

        // If an unexpired lock is held by a different owner, conflict
        if (existing && !isExpired(existing) && existing.ownerUserId !== input.ownerUserId) {
          return { acquired: false, conflict: existing };
        }

        const now = deps.nowIso();
        const expiresAt = new Date(new Date(now).getTime() + input.ttlSec * 1000).toISOString();

        const lock: FridayWorkflowEditLock = {
          workflowId: input.workflowId,
          lockToken: deps.idGenerator(),
          ownerUserId: input.ownerUserId,
          ownerSessionId: input.ownerSessionId,
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt,
        };

        deps.lockRepo.setLock(db, lock);
        return { acquired: true, lock };
      });
    },

    renewLock(workflowId, lockToken, ttlSec) {
      return deps.db.withWriteTransaction((db) => {
        const existing = deps.lockRepo.getLock(db, workflowId);
        if (!existing || existing.lockToken !== lockToken) {
          throw new FridayDomainError("WORKFLOW_EDIT_LOCK_MISMATCH", "Lock token mismatch", { httpStatus: 409 });
        }

        const now = deps.nowIso();
        const expiresAt = new Date(new Date(now).getTime() + ttlSec * 1000).toISOString();

        const renewed: FridayWorkflowEditLock = {
          ...existing,
          heartbeatAt: now,
          expiresAt,
        };

        deps.lockRepo.setLock(db, renewed);
        return renewed;
      });
    },

    releaseLock(workflowId, lockToken) {
      deps.db.withWriteTransaction((db) => {
        const existing = deps.lockRepo.getLock(db, workflowId);
        if (!existing) return;
        if (existing.lockToken !== lockToken) {
          throw new FridayDomainError("WORKFLOW_EDIT_LOCK_MISMATCH", "Lock token mismatch", { httpStatus: 409 });
        }
        deps.lockRepo.deleteLock(db, workflowId);
      });
    },

    getLock(workflowId) {
      return deps.db.withReadConnection((db) => {
        const lock = deps.lockRepo.getLock(db, workflowId);
        if (lock && isExpired(lock)) return null;
        return lock;
      });
    },

    assertLock(workflowId, lockToken) {
      const lock = deps.db.withReadConnection((db) =>
        deps.lockRepo.getLock(db, workflowId),
      );
      if (!lock) throw new FridayDomainError("WORKFLOW_EDIT_LOCK_REQUIRED", "Lock is required for this operation", { httpStatus: 412 });
      if (isExpired(lock)) throw new FridayDomainError("WORKFLOW_EDIT_LOCK_EXPIRED", "Lock has expired", { httpStatus: 410 });
      if (lock.lockToken !== lockToken) throw new FridayDomainError("WORKFLOW_EDIT_LOCK_MISMATCH", "Lock token mismatch", { httpStatus: 409 });
    },

    assertLockOnConnection(db, workflowId, lockToken) {
      const lock = deps.lockRepo.getLock(db, workflowId);
      if (!lock) throw new FridayDomainError("WORKFLOW_EDIT_LOCK_REQUIRED", "Lock is required for this operation", { httpStatus: 412 });
      if (isExpired(lock)) throw new FridayDomainError("WORKFLOW_EDIT_LOCK_EXPIRED", "Lock has expired", { httpStatus: 410 });
      if (lock.lockToken !== lockToken) throw new FridayDomainError("WORKFLOW_EDIT_LOCK_MISMATCH", "Lock token mismatch", { httpStatus: 409 });
    },
  };
}
