import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { FridayApprovalRequestRepository } from "../persistence/friday-approval-request-repository.js";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { ISODateTime, UUID } from "../model/friday-learning.types.js";
import type {
  FridayApprovalRequestEntity,
  FridayAutoFixActionEntity,
  FridayAutoFixExecutionResult,
} from "../model/friday-auto-fix.types.js";

export interface FridayApprovalWorkflowService {
  createRequestForAction(input: {
    action: FridayAutoFixActionEntity;
    runId?: UUID;
    description: string;
    nowIso: ISODateTime;
    expiresAt: ISODateTime;
  }): FridayApprovalRequestEntity;

  approve(input: {
    requestId: UUID;
    respondedBy: UUID;
    reason?: string;
    nowIso: ISODateTime;
  }): FridayApprovalRequestEntity;

  approveAndExecute(input: {
    requestId: UUID;
    respondedBy: UUID;
    reason?: string;
    nowIso: ISODateTime;
  }): Promise<{ approval: FridayApprovalRequestEntity; execution: FridayAutoFixExecutionResult }>;

  reject(input: {
    requestId: UUID;
    respondedBy: UUID;
    reason?: string;
    nowIso: ISODateTime;
  }): FridayApprovalRequestEntity;

  expirePending(input: {
    nowIso: ISODateTime;
    limit?: number;
  }): FridayApprovalRequestEntity[];
}

export interface CreateApprovalWorkflowServiceDeps {
  db: FridaySqliteLayer;
  approvalRepo: FridayApprovalRequestRepository;
  actionRepo: FridayAutoFixActionRepository;
  idGenerator: () => string;
  executionService?: {
    execute(actionId: UUID): Promise<FridayAutoFixExecutionResult>;
  };
}

export function createFridayApprovalWorkflowService(
  deps: CreateApprovalWorkflowServiceDeps,
): FridayApprovalWorkflowService {
  return {
    createRequestForAction(input) {
      const { action, runId, description, nowIso, expiresAt } = input;

      const request: FridayApprovalRequestEntity = {
        requestId: deps.idGenerator(),
        actionId: action.actionId,
        runId,
        userId: action.userId,
        description,
        riskTier: 2,
        plan: action.plan,
        requestedAt: nowIso,
        expiresAt,
        status: "pending",
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      return deps.db.withWriteTransaction((db) => {
        deps.approvalRepo.insert(db, request);
        return request;
      });
    },

    approve(input) {
      const { requestId, respondedBy, reason, nowIso } = input;

      return deps.db.withWriteTransaction((db) => {
        const resolved = deps.approvalRepo.resolvePending(
          db,
          requestId,
          "approved",
          respondedBy,
          reason,
          nowIso,
        );
        if (!resolved) {
          throw new FridayDomainError(
            "APPROVAL_REQUEST_NOT_FOUND",
            `Approval request ${requestId} not found or not pending`,
            { httpStatus: 404 },
          );
        }
        return resolved;
      });
    },

    async approveAndExecute(input) {
      const { requestId, respondedBy, reason, nowIso } = input;

      const approved = deps.db.withWriteTransaction((db) => {
        const resolved = deps.approvalRepo.resolvePending(
          db,
          requestId,
          "approved",
          respondedBy,
          reason,
          nowIso,
        );
        if (!resolved) {
          throw new FridayDomainError(
            "APPROVAL_REQUEST_NOT_FOUND",
            `Approval request ${requestId} not found or not pending`,
            { httpStatus: 404 },
          );
        }
        return resolved;
      });

      if (!deps.executionService) {
        throw new FridayDomainError("APPROVAL_EXECUTION_NOT_CONFIGURED", "Execution service not configured for approveAndExecute", { httpStatus: 500 });
      }

      // Saga pattern: approval is committed (the human approved it).
      // If execution fails, approval stays approved but we surface the failure.
      try {
        const execution = await deps.executionService.execute(approved.actionId);
        return { approval: approved, execution };
      } catch (executionError) {
        // Saga pattern: approval stays committed. Retrieve the actual action
        // state so we return a valid FridayAutoFixExecutionResult.
        const action = deps.db.withWriteTransaction((db) =>
          deps.actionRepo.getById(db, approved.actionId),
        );
        return {
          approval: approved,
          execution: {
            action: action!,
            success: false,
            verificationPassed: false,
            rollbackAttempted: false,
            rollbackSucceeded: false,
            errorMessage: `Execution failed after approval: ${executionError instanceof Error ? executionError.message : String(executionError)}`,
          },
        };
      }
    },

    reject(input) {
      const { requestId, respondedBy, reason, nowIso } = input;

      return deps.db.withWriteTransaction((db) => {
        const resolved = deps.approvalRepo.resolvePending(
          db,
          requestId,
          "rejected",
          respondedBy,
          reason,
          nowIso,
        );
        if (!resolved) {
          throw new FridayDomainError(
            "APPROVAL_REQUEST_NOT_FOUND",
            `Approval request ${requestId} not found or not pending`,
            { httpStatus: 404 },
          );
        }

        // Mark linked action as rejected
        const actionId = resolved.actionId;
        deps.actionRepo.markRejected(db, actionId, nowIso);

        return resolved;
      });
    },

    expirePending(input) {
      const { nowIso, limit } = input;

      return deps.db.withWriteTransaction((db) => {
        const expired = deps.approvalRepo.expirePending(db, nowIso, limit);

        // Mark linked actions as rejected
        deps.actionRepo.markRejectedByIds(
          db,
          expired.map((request) => request.actionId),
          nowIso,
        );

        return expired;
      });
    },
  };
}
