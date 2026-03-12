import type { FridayApprovalWorkflowService } from "#learning";
import type { FridayApprovalExpiryJobResult } from "./friday-approval-expiry.types.js";

export interface FridayApprovalExpiryJob {
  run(nowOverride?: string): FridayApprovalExpiryJobResult;
}

export interface CreateApprovalExpiryJobDeps {
  approvalService: FridayApprovalWorkflowService;
  nowIso: () => string;
}

export function createFridayApprovalExpiryJob(
  deps: CreateApprovalExpiryJobDeps,
): FridayApprovalExpiryJob {
  return {
    run(nowOverride?) {
      const nowIso = nowOverride ?? deps.nowIso();
      const expired = deps.approvalService.expirePending({
        nowIso,
        limit: 100,
      });
      return {
        expiredCount: expired.length,
        expired,
      };
    },
  };
}
