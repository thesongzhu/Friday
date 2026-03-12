import type { FridayWorkflowEntity, FridayWorkflowStatus, WorkflowRunStatus, NodeAttemptStatus } from "@/lib/api/types";

// ─── Derive workflow status from entity ───

export function deriveWorkflowStatus(workflow: FridayWorkflowEntity): FridayWorkflowStatus {
  if (workflow.isArchived) return "archived";
  if (workflow.publishedVersionNumber != null && workflow.publishedVersionNumber > 0) return "published";
  return "draft";
}

// ─── Run terminal check ───

const TERMINAL_RUN_STATUSES = new Set<WorkflowRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export function isRunTerminal(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

// ─── Cancellable run check ───

const CANCELLABLE_RUN_STATUSES = new Set<WorkflowRunStatus>([
  "queued",
  "running",
  "pausing",
  "compensating",
]);

export function isRunCancellable(status: WorkflowRunStatus): boolean {
  return CANCELLABLE_RUN_STATUSES.has(status);
}

// ─── Resumable run check ───

export function isRunResumable(status: WorkflowRunStatus): boolean {
  return status === "paused";
}

// ─── Node terminal check ───

const TERMINAL_NODE_STATUSES = new Set<NodeAttemptStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export function isNodeTerminal(status: NodeAttemptStatus): boolean {
  return TERMINAL_NODE_STATUSES.has(status);
}
