import { FridayDomainError } from "#errors";
import type {
  SkillLifecycleOperation,
  SkillLifecycleStatus,
} from "../model/friday-skill-lifecycle.types.js";

export interface FridaySkillLifecycleTransitionResult {
  previous: SkillLifecycleStatus;
  operation: SkillLifecycleOperation;
  next: SkillLifecycleStatus;
  changed: boolean;
}

/**
 * Transition table: maps [currentStatus][operation] → nextStatus.
 * Only valid transitions are present.
 */
const TRANSITION_TABLE: Record<
  SkillLifecycleStatus,
  Partial<Record<SkillLifecycleOperation, SkillLifecycleStatus>>
> = {
  not_installed: {
    discover: "not_installed",
    install: "installed",
  },
  installed: {
    verify: "installed",
    activate: "installed",
    disable: "disabled",
    uninstall: "not_installed",
    mark_error: "error",
    detect_upgrade: "upgrade_available",
  },
  disabled: {
    enable: "installed",
    uninstall: "not_installed",
    mark_error: "error",
    detect_upgrade: "upgrade_available",
  },
  error: {
    install: "installed",
    uninstall: "not_installed",
    mark_error: "error",
  },
  upgrade_available: {
    update: "installed",
    disable: "disabled",
    uninstall: "not_installed",
    mark_error: "error",
    clear_upgrade: "installed",
  },
};

/** Returns true when lifecycle operation is valid from current status. */
export function canApplyFridaySkillLifecycleOperation(
  current: SkillLifecycleStatus,
  operation: SkillLifecycleOperation,
): boolean {
  const transitions = TRANSITION_TABLE[current];
  return operation in transitions;
}

/** Applies lifecycle operation and returns deterministic next status. */
export function applyFridaySkillLifecycleOperation(
  current: SkillLifecycleStatus,
  operation: SkillLifecycleOperation,
): FridaySkillLifecycleTransitionResult {
  const transitions = TRANSITION_TABLE[current];
  const next = transitions[operation];

  if (next === undefined) {
    throw new FridayDomainError(
      "LIFECYCLE_INVALID_TRANSITION",
      `Invalid lifecycle operation "${operation}" from status "${current}"`,
      { httpStatus: 400 },
    );
  }

  return {
    previous: current,
    operation,
    next,
    changed: current !== next,
  };
}
