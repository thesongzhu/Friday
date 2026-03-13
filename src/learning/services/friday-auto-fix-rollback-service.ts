import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { UUID } from "../model/friday-learning.types.js";
import type { FridayAutoFixExecutionResult } from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixRollbackService {
  rollback(actionId: UUID, reason: string): Promise<FridayAutoFixExecutionResult>;
}

export interface CreateAutoFixRollbackServiceDeps {
  db: FridaySqliteLayer;
  actionRepo: FridayAutoFixActionRepository;
  nowIso: () => string;
}

export function createFridayAutoFixRollbackService(
  deps: CreateAutoFixRollbackServiceDeps,
): FridayAutoFixRollbackService {
  return {
    async rollback(actionId, reason) {
      const nowIso = deps.nowIso();

      const action = deps.db.withReadConnection((db) =>
        deps.actionRepo.getById(db, actionId),
      );

      if (!action) {
        throw new FridayDomainError("AUTOFIX_ACTION_NOT_FOUND", `Action ${actionId} not found`, { httpStatus: 404 });
      }

      if (action.status !== "applied" && action.status !== "planned") {
        throw new FridayDomainError(
          "AUTOFIX_ACTION_INVALID_STATUS",
          `Action ${actionId} is '${action.status}', cannot rollback`,
          { httpStatus: 409 },
        );
      }

      const rollbackPlan = action.rollbackPlan ?? action.plan.rollbackPlan;
      if (!rollbackPlan) {
        // No rollback plan: do NOT transition to rolled_back.
        // Preserve current status and fail explicitly.
        return {
          action,
          success: false,
          verificationPassed: false,
          rollbackAttempted: true,
          rollbackSucceeded: false,
          errorMessage: `Rollback requested (${reason}) but no rollback plan available`,
        };
      }

      // Execute rollback: mark the action as rolled back in the database.
      // The rollback plan steps are recorded but not individually executed
      // in the base implementation — callers should inject richer rollback
      // executors for production use. The return value reflects that the
      // database state was updated successfully (rollbackSucceeded) even
      // though the overall auto-fix action did not succeed (success: false).
      return deps.db.withWriteTransaction((db) => {
        const rolledBack = deps.actionRepo.markRolledBack(
          db,
          actionId,
          nowIso,
        )!;
        return {
          action: rolledBack,
          success: false,
          verificationPassed: false,
          rollbackAttempted: true,
          rollbackSucceeded: true,
          errorMessage: `Rollback requested (${reason}): action status reverted to rolled_back`,
        };
      });
    },
  };
}
