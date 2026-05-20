import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { UUID } from "../model/friday-learning.types.js";
import type { FridayAutoFixExecutionResult, FridayAutoFixPlan } from "../model/friday-auto-fix.types.js";
import {
  DEFAULT_EXECUTORS,
  DEFAULT_VERIFIERS,
} from "./friday-auto-fix-execution-service.js";
import type {
  StepExecutor,
  StepVerifier,
} from "./friday-auto-fix-execution-service.js";
import type { FridayAutoFixStepKind } from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixRollbackService {
  rollback(actionId: UUID, reason: string): Promise<FridayAutoFixExecutionResult>;
}

export interface CreateAutoFixRollbackServiceDeps {
  db: FridaySqliteLayer;
  actionRepo: FridayAutoFixActionRepository;
  nowIso: () => string;
  stepExecutors?: Partial<Record<FridayAutoFixStepKind, StepExecutor>>;
  stepVerifiers?: Partial<Record<FridayAutoFixStepKind, StepVerifier>>;
}

export function createFridayAutoFixRollbackService(
  deps: CreateAutoFixRollbackServiceDeps,
): FridayAutoFixRollbackService {
  function persistRollbackEvidence(
    actionId: UUID,
    rollbackPlan: NonNullable<FridayAutoFixPlan["rollbackPlan"]>,
    nowIso: string,
  ): void {
    deps.db.withWriteTransaction((db) => {
      deps.actionRepo.setRollbackPlan(db, actionId, rollbackPlan, nowIso);
    });
  }

  return {
    async rollback(actionId, reason) {
      const nowIso = deps.nowIso();

      const recordRollbackAttempt = (input: {
        succeeded: boolean;
        errorMessage?: string;
      }): FridayAutoFixExecutionResult["action"] => {
        const updated = deps.db.withWriteTransaction((db) =>
          deps.actionRepo.recordRollbackAttempt(db, actionId, {
            attemptedAt: nowIso,
            succeeded: input.succeeded,
            errorMessage: input.errorMessage,
          }, nowIso),
        );
        if (!updated) {
          throw new FridayDomainError("AUTOFIX_ACTION_NOT_FOUND", `Action ${actionId} not found during rollback receipt write`, { httpStatus: 404 });
        }
        return updated;
      };

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
        const errorMessage = `Rollback requested (${reason}) but no rollback plan available`;
        return {
          action: recordRollbackAttempt({ succeeded: false, errorMessage }),
          success: false,
          verificationPassed: false,
          rollbackAttempted: true,
          rollbackSucceeded: false,
          errorMessage,
        };
      }

      const executors: Partial<Record<FridayAutoFixStepKind, StepExecutor>> = {
        ...DEFAULT_EXECUTORS,
        ...deps.stepExecutors,
      };
      const verifiers: Partial<Record<FridayAutoFixStepKind, StepVerifier>> = {
        ...DEFAULT_VERIFIERS,
        ...deps.stepVerifiers,
      };

      for (const step of rollbackPlan.steps) {
        const executor = executors[step.kind];
        if (!executor) {
          persistRollbackEvidence(actionId, rollbackPlan, nowIso);
          const errorMessage = `Rollback requested (${reason}) but step '${step.stepId}' (${step.kind}) has no executor`;
          return {
            action: recordRollbackAttempt({ succeeded: false, errorMessage }),
            success: false,
            verificationPassed: false,
            rollbackAttempted: true,
            rollbackSucceeded: false,
            errorMessage,
          };
        }
        if (!await executor(step)) {
          persistRollbackEvidence(actionId, rollbackPlan, nowIso);
          const errorMessage = `Rollback requested (${reason}) but step '${step.stepId}' (${step.kind}) failed during execution`;
          return {
            action: recordRollbackAttempt({ succeeded: false, errorMessage }),
            success: false,
            verificationPassed: false,
            rollbackAttempted: true,
            rollbackSucceeded: false,
            errorMessage,
          };
        }
        const verifier = verifiers[step.kind];
        if (verifier && !await verifier(step)) {
          persistRollbackEvidence(actionId, rollbackPlan, nowIso);
          const errorMessage = `Rollback requested (${reason}) but step '${step.stepId}' (${step.kind}) failed verification`;
          return {
            action: recordRollbackAttempt({ succeeded: false, errorMessage }),
            success: false,
            verificationPassed: false,
            rollbackAttempted: true,
            rollbackSucceeded: false,
            errorMessage,
          };
        }
      }

      persistRollbackEvidence(actionId, rollbackPlan, nowIso);
      recordRollbackAttempt({ succeeded: true });

      return deps.db.withWriteTransaction((db) => {
        const rolledBack = deps.actionRepo.markRolledBack(
          db,
          actionId,
          nowIso,
        );
        if (!rolledBack) throw new FridayDomainError("AUTOFIX_ACTION_NOT_FOUND", `Action ${actionId} not found during rollback`, { httpStatus: 404 });
        return {
          action: rolledBack,
          success: false,
          verificationPassed: false,
          rollbackAttempted: true,
          rollbackSucceeded: true,
          errorMessage: `Rollback requested (${reason}): rollback plan executed successfully`,
        };
      });
    },
  };
}
