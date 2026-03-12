import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillValidationIssue } from "./friday-skill-validation.types.js";

/** Validates flow graph integrity when `manifest.flow` is present. */
export function validateFridaySkillStepGraph(
  flow: SkillManifestV2["flow"],
): FridaySkillValidationIssue[] {
  if (!flow) return [];

  const issues: FridaySkillValidationIssue[] = [];
  const { startStep, steps } = flow;

  const stepIds = new Set(steps.map((s) => s.id));

  // Validate startStep exists
  if (!stepIds.has(startStep)) {
    issues.push({
      stage: "step-graph",
      severity: "error",
      code: "STEP_GRAPH_MISSING_START",
      message: `startStep "${startStep}" does not match any step id`,
    });
  }

  // Validate transition targets
  for (const step of steps) {
    const { onSuccess, onFailure } = step.transitions;

    if (onSuccess !== undefined && onSuccess !== null && !stepIds.has(onSuccess)) {
      issues.push({
        stage: "step-graph",
        severity: "error",
        code: "STEP_GRAPH_BAD_TRANSITION",
        message: `Step "${step.id}" references unknown onSuccess target "${onSuccess}"`,
      });
    }

    if (onFailure !== undefined && onFailure !== null && !stepIds.has(onFailure)) {
      issues.push({
        stage: "step-graph",
        severity: "error",
        code: "STEP_GRAPH_BAD_TRANSITION",
        message: `Step "${step.id}" references unknown onFailure target "${onFailure}"`,
      });
    }
  }

  // Check for unreachable steps (BFS from startStep)
  const reachable = new Set<string>();
  const queue = [startStep];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);

    const step = steps.find((s) => s.id === current);
    if (!step) continue;

    const { onSuccess, onFailure } = step.transitions;
    if (onSuccess && !reachable.has(onSuccess)) queue.push(onSuccess);
    if (onFailure && !reachable.has(onFailure)) queue.push(onFailure);
  }

  for (const step of steps) {
    if (!reachable.has(step.id)) {
      issues.push({
        stage: "step-graph",
        severity: "warning",
        code: "STEP_GRAPH_UNREACHABLE",
        message: `Step "${step.id}" is unreachable from startStep "${startStep}"`,
      });
    }
  }

  // Check for terminal path (at least one reachable step with null/undefined onSuccess)
  const hasTerminal = steps.some(
    (s) =>
      reachable.has(s.id) &&
      (s.transitions.onSuccess === null || s.transitions.onSuccess === undefined),
  );

  if (!hasTerminal) {
    issues.push({
      stage: "step-graph",
      severity: "error",
      code: "STEP_GRAPH_NO_TERMINAL",
      message: "No terminal step found (all reachable steps have onSuccess transitions)",
    });
  }

  return issues;
}
