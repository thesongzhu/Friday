import type { ISODateTime, UUID } from "../../model/friday-workflow.types.js";

// ─── Edit Lock ───

export interface FridayWorkflowEditLock {
  workflowId: UUID;
  lockToken: string;
  ownerUserId: UUID;
  ownerSessionId?: string;
  acquiredAt: ISODateTime;
  heartbeatAt: ISODateTime;
  expiresAt: ISODateTime;
}

// ─── Lock Acquire Input ───

export interface FridayWorkflowLockAcquireInput {
  workflowId: UUID;
  ownerUserId: UUID;
  ownerSessionId?: string;
  ttlSec: number;
}

// ─── Lock Acquire Result ───

export interface FridayWorkflowLockAcquireResult {
  acquired: boolean;
  lock?: FridayWorkflowEditLock;
  conflict?: FridayWorkflowEditLock;
}
