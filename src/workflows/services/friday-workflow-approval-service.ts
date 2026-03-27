import { FridayDomainError } from "#errors";
import type { FridayWorkflowApprovalRequestEntity } from "../model/friday-workflow-engine.types.js";
import type {
  CreateFridayWorkflowApprovalServiceDeps,
  FridayWorkflowApprovalService,
} from "./friday-workflow-approval-service.types.js";

// ─── Default timeout: 24h ───

const FRIDAY_WORKFLOW_APPROVAL_DEFAULT_TIMEOUT_MS = 86_400_000;

// ─── Role hierarchy (lower index = less privilege) ───

const FRIDAY_APPROVAL_ROLE_HIERARCHY: readonly string[] = ["operator", "admin", "owner"];

function roleRank(role: string): number {
  const idx = FRIDAY_APPROVAL_ROLE_HIERARCHY.indexOf(role);
  return idx === -1 ? -1 : idx;
}

// ─── Factory ───

export function createFridayWorkflowApprovalService(
  deps: CreateFridayWorkflowApprovalServiceDeps,
): FridayWorkflowApprovalService {

  /**
   * Verify the acting user is authorized to resolve this approval.
   * Checks both userId match (if specified) and role hierarchy.
   */
  function assertApproverAuthorized(
    approval: FridayWorkflowApprovalRequestEntity,
    decidedByUserId: string,
  ): void {
    // Check userId constraint
    if (approval.approverUserId && approval.approverUserId !== decidedByUserId) {
      throw new FridayDomainError(
        "WORKFLOW_APPROVAL_UNAUTHORIZED",
        `User '${decidedByUserId}' is not the designated approver`,
        { httpStatus: 403 },
      );
    }

    // Check role constraint
    if (approval.approverRole && deps.resolveUserRole) {
      const userRole = deps.resolveUserRole(decidedByUserId);
      if (!userRole) {
        throw new FridayDomainError(
          "WORKFLOW_APPROVAL_UNAUTHORIZED",
          `Cannot resolve role for user '${decidedByUserId}'`,
          { httpStatus: 403 },
        );
      }
      const requiredRank = roleRank(approval.approverRole);
      const userRank = roleRank(userRole);
      if (requiredRank === -1 || userRank === -1 || userRank < requiredRank) {
        throw new FridayDomainError(
          "WORKFLOW_APPROVAL_UNAUTHORIZED",
          `User role '${userRole}' is insufficient; requires '${approval.approverRole}' or higher`,
          { httpStatus: 403 },
        );
      }
    }
  }
  return {
    async requestForNode(input) {
      const timeoutMs = input.timeoutMs ?? FRIDAY_WORKFLOW_APPROVAL_DEFAULT_TIMEOUT_MS;
      const nowIso = deps.nowIso();
      const timeoutAt = new Date(
        new Date(nowIso).getTime() + timeoutMs,
      ).toISOString();

      const entity: FridayWorkflowApprovalRequestEntity = {
        id: deps.idGenerator(),
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        runId: input.runId,
        runNodeAttemptId: input.runNodeAttemptId,
        nodeId: input.nodeId,
        approverUserId: input.approverUserId,
        approverRole: input.approverRole,
        status: "pending",
        requestPayload: input.requestPayload ?? {},
        timeoutAt,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      return deps.approvalRepo.insert(entity);
    },

    listPending(input) {
      return deps.approvalRepo.listPending({
        approverUserId: input.approverUserId,
        limit: input.limit,
        cursor: input.cursor,
      });
    },

    getById(id) {
      return deps.approvalRepo.getById(id);
    },

    async approve(input) {
      // 1. Validate approval exists (read-only)
      const pending = deps.approvalRepo.getById(input.approvalId);
      if (!pending || pending.status !== "pending") {
        throw new FridayDomainError(
          "WORKFLOW_APPROVAL_NOT_FOUND",
          "Approval request not found or already resolved",
          { httpStatus: 404 },
        );
      }

      // 2. Assert approver is authorized
      assertApproverAuthorized(pending, input.decidedByUserId);

      // 3. Attempt to resume the run BEFORE committing resolution
      let resumed = false;
      try {
        await deps.executionService.resumeRun(pending.runId, {
          approvalDecision: "approved",
        });
        resumed = true;
      } catch (err) {
        // Only swallow INVALID_RUN_TRANSITION (run already terminal)
        if (err instanceof FridayDomainError && err.code === "INVALID_RUN_TRANSITION") {
          // Run already terminal — proceed to commit resolution anyway
        } else {
          // Transient error — re-throw so approval stays pending
          throw err;
        }
      }

      // 4. Commit resolution
      const resolved = deps.approvalRepo.resolvePending({
        id: input.approvalId,
        status: "approved",
        decidedByUserId: input.decidedByUserId,
        comment: input.comment,
        nowIso: deps.nowIso(),
      });

      if (!resolved) {
        throw new FridayDomainError(
          "WORKFLOW_APPROVAL_NOT_FOUND",
          "Approval request not found or already resolved",
          { httpStatus: 404 },
        );
      }

      return { approval: resolved, resumed };
    },

    async reject(input) {
      // 1. Validate approval exists (read-only)
      const pending = deps.approvalRepo.getById(input.approvalId);
      if (!pending || pending.status !== "pending") {
        throw new FridayDomainError(
          "WORKFLOW_APPROVAL_NOT_FOUND",
          "Approval request not found or already resolved",
          { httpStatus: 404 },
        );
      }

      // 2. Assert approver is authorized
      assertApproverAuthorized(pending, input.decidedByUserId);

      // 3. Attempt to resume the run with rejection BEFORE committing resolution
      let resumed = false;
      try {
        await deps.executionService.resumeRun(pending.runId, {
          approvalDecision: "rejected",
        });
        resumed = true;
      } catch (err) {
        // Only swallow INVALID_RUN_TRANSITION (run already terminal)
        if (err instanceof FridayDomainError && err.code === "INVALID_RUN_TRANSITION") {
          // Run already terminal — proceed to commit resolution anyway
        } else {
          // Transient error — re-throw so approval stays pending
          throw err;
        }
      }

      // 4. Commit resolution
      const resolved = deps.approvalRepo.resolvePending({
        id: input.approvalId,
        status: "rejected",
        decidedByUserId: input.decidedByUserId,
        comment: input.comment,
        nowIso: deps.nowIso(),
      });

      if (!resolved) {
        throw new FridayDomainError(
          "WORKFLOW_APPROVAL_NOT_FOUND",
          "Approval request not found or already resolved",
          { httpStatus: 404 },
        );
      }

      return { approval: resolved, resumed };
    },

    async expirePending(nowIso, limit) {
      const expired = deps.approvalRepo.expirePending(nowIso, limit ?? 100);

      // Unblock paused runs for each expired approval
      for (const approval of expired) {
        try {
          await deps.executionService.resumeRun(approval.runId, {
            approvalDecision: "rejected",
          });
        } catch (err) {
          // Resume failed (e.g. run already terminal) — try cancelling as fallback
          console.warn("[friday][workflow-approval-service] resume failed:", err instanceof Error ? err.message : String(err));
          try {
            await deps.executionService.cancelRun(approval.runId, "Approval expired");
          } catch (err2) {
            // Run may already be in a terminal state — nothing to do
            console.warn("[friday][workflow-approval-service] cancel fallback failed:", err2 instanceof Error ? err2.message : String(err2));
          }
        }
      }

      return expired.length;
    },
  };
}
