import type { FridayWorkflowApprovalRequestEntity } from "../model/friday-workflow-engine.types.js";

// ─── Create Input ───

export interface FridayWorkflowApprovalRequestCreateInput {
  workflowId: string;
  workflowVersionId: string;
  runId: string;
  runNodeAttemptId: string;
  nodeId: string;
  approverUserId?: string;
  approverRole?: string;
  requestPayload?: Record<string, unknown>;
  timeoutMs?: number;
}

// ─── List Input ───

export interface FridayWorkflowApprovalListInput {
  approverUserId?: string;
  limit?: number;
  cursor?: string;
}

// ─── Decision Input ───

export interface FridayWorkflowApprovalDecisionInput {
  approvalId: string;
  decidedByUserId: string;
  comment?: string;
}

// ─── Decision Result ───

export interface FridayWorkflowApprovalDecisionResult {
  approval: FridayWorkflowApprovalRequestEntity;
  resumed: boolean;
}

// ─── Service Interface ───

export interface FridayWorkflowApprovalService {
  requestForNode(
    input: FridayWorkflowApprovalRequestCreateInput,
  ): Promise<FridayWorkflowApprovalRequestEntity>;

  listPending(
    input: FridayWorkflowApprovalListInput,
  ): FridayWorkflowApprovalRequestEntity[];

  getById(id: string): FridayWorkflowApprovalRequestEntity | null;

  approve(
    input: FridayWorkflowApprovalDecisionInput,
  ): Promise<FridayWorkflowApprovalDecisionResult>;

  reject(
    input: FridayWorkflowApprovalDecisionInput,
  ): Promise<FridayWorkflowApprovalDecisionResult>;

  expirePending(nowIso: string, limit?: number): Promise<number>;
}

// ─── Factory Deps ───

export interface CreateFridayWorkflowApprovalServiceDeps {
  approvalRepo: {
    insert(
      request: FridayWorkflowApprovalRequestEntity,
    ): FridayWorkflowApprovalRequestEntity;
    getById(id: string): FridayWorkflowApprovalRequestEntity | null;
    listPending(input: {
      approverUserId?: string;
      limit?: number;
      cursor?: string;
    }): FridayWorkflowApprovalRequestEntity[];
    resolvePending(input: {
      id: string;
      status: "approved" | "rejected";
      decidedByUserId: string;
      comment?: string;
      nowIso: string;
    }): FridayWorkflowApprovalRequestEntity | null;
    expirePending(
      nowIso: string,
      limit: number,
    ): FridayWorkflowApprovalRequestEntity[];
  };
  executionService: {
    resumeRun(
      runId: string,
      options?: { approvalDecision?: "approved" | "rejected" },
    ): Promise<unknown>;
    cancelRun(
      runId: string,
      reason?: string,
    ): Promise<unknown>;
  };
  /** Optional callback to resolve a user's role for authorization checks. */
  resolveUserRole?: (userId: string) => string | null;
  idGenerator: () => string;
  nowIso: () => string;
}
