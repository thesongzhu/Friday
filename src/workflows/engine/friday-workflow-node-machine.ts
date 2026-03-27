import { FridayDomainError } from "#errors";
import type { NodeAttemptStatus } from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowNodeMachine {
  canTransition(from: NodeAttemptStatus, to: NodeAttemptStatus): boolean;
  assertTransition(from: NodeAttemptStatus, to: NodeAttemptStatus): void;
  isTerminal(status: NodeAttemptStatus): boolean;
}

// ─── Valid transition table ───

const VALID_TRANSITIONS: ReadonlyMap<
  NodeAttemptStatus,
  ReadonlySet<NodeAttemptStatus>
> = new Map([
  [
    "queued",
    new Set<NodeAttemptStatus>(["running", "cancelled", "blocked_offline"]),
  ],
  [
    "running",
    new Set<NodeAttemptStatus>([
      "completed",
      "failed",
      "cancelled",
      "blocked_offline",
    ]),
  ],
  [
    "retrying",
    new Set<NodeAttemptStatus>(["running", "cancelled", "blocked_offline"]),
  ],
  // failed can transition to retrying when retry policy allows
  ["failed", new Set<NodeAttemptStatus>(["retrying"])],
  [
    "blocked_offline",
    new Set<NodeAttemptStatus>(["running", "completed", "cancelled", "failed"]),
  ],
  ["completed", new Set<NodeAttemptStatus>([])],
  ["cancelled", new Set<NodeAttemptStatus>([])],
]);

// P2: "failed" is included as terminal for DAG scheduling purposes (predecessor is "done").
// However, `failed` can transition to `retrying` when a retry policy triggers — this is
// handled by the retry manager BEFORE the DAG scheduler re-evaluates, so the semantics
// are consistent: "terminal" means "current attempt is done", not "can never change".
const TERMINAL_STATUSES: ReadonlySet<NodeAttemptStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// ─── Factory ───

export function createFridayWorkflowNodeMachine(): FridayWorkflowNodeMachine {
  return {
    canTransition(from, to) {
      const allowed = VALID_TRANSITIONS.get(from);
      return allowed ? allowed.has(to) : false;
    },

    assertTransition(from, to) {
      if (!this.canTransition(from, to)) {
        throw new FridayDomainError(
          "INVALID_NODE_TRANSITION",
          `INVALID_NODE_TRANSITION: cannot transition from '${from}' to '${to}'`,
          { httpStatus: 400 },
        );
      }
    },

    isTerminal(status) {
      return TERMINAL_STATUSES.has(status);
    },
  };
}
