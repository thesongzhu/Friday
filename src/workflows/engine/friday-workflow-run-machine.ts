import { FridayDomainError } from "#errors";
import type { WorkflowRunStatus } from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowRunMachine {
  canTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean;
  assertTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void;
  isTerminal(status: WorkflowRunStatus): boolean;
}

// ─── Valid transition table ───

const VALID_TRANSITIONS: ReadonlyMap<
  WorkflowRunStatus,
  ReadonlySet<WorkflowRunStatus>
> = new Map([
  ["queued", new Set<WorkflowRunStatus>(["running", "cancelled"])],
  [
    "running",
    new Set<WorkflowRunStatus>([
      "pausing",
      "completed",
      "failed",
      "cancelled",
      "compensating",
    ]),
  ],
  [
    "pausing",
    new Set<WorkflowRunStatus>(["paused", "failed", "cancelled"]),
  ],
  ["paused", new Set<WorkflowRunStatus>(["running", "cancelled"])],
  [
    "compensating",
    new Set<WorkflowRunStatus>(["completed", "failed", "cancelled"]),
  ],
  // failed can transition to running (retry)
  ["failed", new Set<WorkflowRunStatus>(["running"])],
  ["completed", new Set<WorkflowRunStatus>([])],
  ["cancelled", new Set<WorkflowRunStatus>([])],
]);

const TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// ─── Factory ───

export function createFridayWorkflowRunMachine(): FridayWorkflowRunMachine {
  return {
    canTransition(from, to) {
      const allowed = VALID_TRANSITIONS.get(from);
      return allowed ? allowed.has(to) : false;
    },

    assertTransition(from, to) {
      if (!this.canTransition(from, to)) {
        throw new FridayDomainError(
          "INVALID_RUN_TRANSITION",
          `INVALID_RUN_TRANSITION: cannot transition from '${from}' to '${to}'`,
          { httpStatus: 400 },
        );
      }
    },

    isTerminal(status) {
      return TERMINAL_STATUSES.has(status);
    },
  };
}
