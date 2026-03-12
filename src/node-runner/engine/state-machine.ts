/**
 * NodeRunner State Machine — deterministic execution state transitions.
 *
 * Enforces that executions traverse a strict set of valid transitions.
 * No state can be revisited; every transition is validated before it occurs.
 *
 * @module node-runner/engine
 */

import type {
  FridayNodeExecutionStatus,
  FridayNodeRunnerStateTransition,
} from "../model/friday-node-runner.types.js";

import { FRIDAY_NODE_RUNNER_TRANSITIONS } from "../model/friday-node-runner.types.js";

// ─── Terminal States ───

/** States from which no further transitions are possible. */
const TERMINAL_STATES: ReadonlySet<FridayNodeExecutionStatus> = new Set([
  "completed",
  "failed",
  "timed-out",
  "cancelled",
]);

// ─── Transition Index ───

/** Pre-computed lookup: from → Set<to> for O(1) validation. */
const TRANSITION_INDEX: ReadonlyMap<FridayNodeExecutionStatus, ReadonlySet<FridayNodeExecutionStatus>> =
  buildTransitionIndex(FRIDAY_NODE_RUNNER_TRANSITIONS);

function buildTransitionIndex(
  transitions: readonly FridayNodeRunnerStateTransition[],
): Map<FridayNodeExecutionStatus, Set<FridayNodeExecutionStatus>> {
  const index = new Map<FridayNodeExecutionStatus, Set<FridayNodeExecutionStatus>>();
  for (const { from, to } of transitions) {
    let targets = index.get(from);
    if (!targets) {
      targets = new Set();
      index.set(from, targets);
    }
    targets.add(to);
  }
  return index;
}

// ─── Public API ───

/**
 * Check whether a transition from `from` to `to` is valid.
 */
export function isValidTransition(
  from: FridayNodeExecutionStatus,
  to: FridayNodeExecutionStatus,
): boolean {
  const targets = TRANSITION_INDEX.get(from);
  return targets !== undefined && targets.has(to);
}

/**
 * Check whether a status is terminal (no further transitions possible).
 */
export function isTerminalState(status: FridayNodeExecutionStatus): boolean {
  return TERMINAL_STATES.has(status);
}

/**
 * Transition to a new state, throwing if the transition is invalid.
 *
 * @returns The new state (`to`).
 * @throws Error if the transition is not in the valid set.
 */
export function transition(
  from: FridayNodeExecutionStatus,
  to: FridayNodeExecutionStatus,
): FridayNodeExecutionStatus {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid state transition: "${from}" → "${to}". ` +
        `Valid targets from "${from}": [${getValidTargets(from).join(", ")}]`,
    );
  }
  return to;
}

/**
 * Get all valid target states from a given state.
 */
export function getValidTargets(from: FridayNodeExecutionStatus): FridayNodeExecutionStatus[] {
  const targets = TRANSITION_INDEX.get(from);
  return targets ? [...targets] : [];
}

/**
 * Map a pipeline step name to the execution status that represents
 * "currently executing this step".
 */
export function stepToActiveStatus(
  step: "load" | "pre-validate" | "pre-rules" | "execute" | "post-validate" | "post-rules",
): FridayNodeExecutionStatus {
  switch (step) {
    case "load":
      return "loading";
    case "pre-validate":
      return "validating";
    case "pre-rules":
      return "checking-rules";
    case "execute":
      return "executing";
    case "post-validate":
      return "post-validating";
    case "post-rules":
      return "post-rules";
  }
}
