import { FridayDomainError } from "#errors";

/**
 * Setup Recipe Executor — Executes setup recipes using the autonomous engine.
 *
 * Bridges declarative recipes to the autonomous perception-action loop,
 * handling prerequisite checks, step orchestration, output extraction,
 * and error recovery with alternative approaches.
 *
 * @module setup
 */

import type {
  FridayAutonomousEngine,
  FridayAutonomousStepDomain,
} from "../agent/autonomous/friday-autonomous.types.js";

import type {
  FridayEnvironmentScanner,
  FridaySetupExecuteParams,
  FridaySetupExecution,
  FridaySetupExecutionListFilters,
  FridaySetupPrerequisiteResult,
  FridaySetupRecipe,
  FridaySetupRecipeExecutor,
  FridaySetupRecipeRegistry,
  FridaySetupStepDomain,
  FridaySetupStepResult,
  UUID,
} from "./friday-setup.types.js";

// ─── Types ───

export interface CreateFridaySetupRecipeExecutorDeps {
  readonly registry: FridaySetupRecipeRegistry;
  readonly autonomousEngine: FridayAutonomousEngine;
  readonly environmentScanner: FridayEnvironmentScanner;
  readonly idGenerator: () => UUID;
  readonly nowIso: () => string;
}

// ─── Factory ───

export function createFridaySetupRecipeExecutor(
  deps: CreateFridaySetupRecipeExecutorDeps,
): FridaySetupRecipeExecutor {
  const {
    registry,
    autonomousEngine,
    environmentScanner,
    idGenerator,
    nowIso,
  } = deps;

  const executions = new Map<UUID, FridaySetupExecution>();

  // ─── Prerequisite checking ───

  async function checkPrerequisitesInternal(
    recipe: FridaySetupRecipe,
  ): Promise<FridaySetupPrerequisiteResult[]> {
    const results: FridaySetupPrerequisiteResult[] = [];

    for (const prereq of recipe.prerequisites) {
      let met = false;
      let actual: string | undefined;

      switch (prereq.type) {
        case "software_installed": {
          met = await environmentScanner.isInstalled(prereq.target);
          actual = met ? "installed" : "not installed";
          break;
        }
        case "software_version": {
          const version = await environmentScanner.getVersion(prereq.target);
          actual = version ?? "not installed";
          if (version && prereq.expected) {
            met = satisfiesVersion(version, prereq.expected);
          }
          break;
        }
        case "network_reachable": {
          met = await environmentScanner.isReachable(prereq.target);
          actual = met ? "reachable" : "unreachable";
          break;
        }
        case "file_exists": {
          met = await environmentScanner.fileExists(prereq.target);
          actual = met ? "exists" : "not found";
          break;
        }
        case "env_var_set": {
          const value = environmentScanner.getEnvVar(prereq.target);
          met = value != null && value.length > 0;
          actual = met ? "(set)" : "(unset)";
          break;
        }
        case "os_matches": {
          const os = environmentScanner.getOs();
          met = os === prereq.target || prereq.target === "*";
          actual = os;
          break;
        }
        case "recipe_completed": {
          // Check if this recipe has been executed successfully
          const prevExecutions = Array.from(executions.values())
            .filter((e) => e.recipeId === prereq.target && e.status === "completed");
          met = prevExecutions.length > 0;
          actual = met ? "completed" : "not executed";
          break;
        }
      }

      results.push({
        type: prereq.type,
        target: prereq.target,
        met,
        actual,
        fixInstruction: met ? undefined : prereq.fixInstruction,
      });
    }

    return results;
  }

  // ─── Step execution ───

  function mapSetupDomainToAutonomousDomain(
    domain: FridaySetupStepDomain,
  ): FridayAutonomousStepDomain | null {
    switch (domain) {
      case "browser":
      case "desktop":
      case "file":
        return domain;
      case "cli":
        return "exec";
      case "api":
      case "manual":
        return null;
    }
  }

  function buildStepGoalDescription(
    recipe: FridaySetupRecipe,
    step: (typeof recipe.steps)[number],
    inputs: Readonly<Record<string, string>>,
    previousOutputs: Readonly<Record<string, string>>,
  ): string {
    let description = step.guidance;

    // Substitute input/output references in the guidance
    const allValues = { ...inputs, ...previousOutputs };
    for (const [key, value] of Object.entries(allValues)) {
      description = description.replaceAll(`{{${key}}}`, value);
    }

    return `[Setup: ${recipe.name} - Step ${step.index + 1}] ${description}`;
  }

  async function executeStep(
    recipe: FridaySetupRecipe,
    step: (typeof recipe.steps)[number],
    inputs: Readonly<Record<string, string>>,
    previousOutputs: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<FridaySetupStepResult> {
    const startedAt = nowIso();
    let approachIndex = 0;

    if (step.requiresApproval || step.domain === "manual") {
      return {
        stepId: step.id,
        status: "paused_for_approval",
        outputs: {},
        startedAt,
        completedAt: nowIso(),
        approachIndex,
        approvalInstruction: step.instruction,
        failureReason: step.domain === "manual"
          ? `Manual setup step requires user action: ${step.instruction}`
          : `Approval required before executing setup step: ${step.instruction}`,
      };
    }

    // Try primary approach
    const goalDescription = buildStepGoalDescription(recipe, step, inputs, previousOutputs);
    const primaryDomain = mapSetupDomainToAutonomousDomain(step.domain);

    if (!primaryDomain) {
      return {
        stepId: step.id,
        status: "failed",
        outputs: {},
        startedAt,
        completedAt: nowIso(),
        approachIndex,
        failureReason: `Setup step domain "${step.domain}" is not supported by the autonomous engine.`,
      };
    }

    const goalResult = await autonomousEngine.executeGoal({
      description: goalDescription,
      source: "recipe",
      priority: "high",
      config: {
        maxIterationsPerGoal: 20,
        maxTimePerGoalMs: 120_000,
      },
      signal,
      recipeContext: {
        recipeId: recipe.id,
        recipeStepIndex: step.index,
        domainHints: [primaryDomain],
      },
    });

    if (goalResult.status === "completed") {
      return {
        stepId: step.id,
        status: "completed",
        outputs: goalResult.extractedOutputs ?? {},
        startedAt,
        completedAt: nowIso(),
        approachIndex,
      };
    }

    // Try alternative approaches
    if (step.alternatives) {
      for (let altIndex = 0; altIndex < step.alternatives.length; altIndex++) {
        if (signal.aborted) break;
        approachIndex = altIndex + 1;

        const alt = step.alternatives[altIndex];
        const altDomain = mapSetupDomainToAutonomousDomain(alt.domain);
        if (!altDomain) {
          continue;
        }
        const altGoalDescription =
          `[Setup: ${recipe.name} - Step ${step.index + 1} (Alternative ${altIndex + 1})] ${alt.guidance}`;

        const altResult = await autonomousEngine.executeGoal({
          description: altGoalDescription,
          source: "recipe",
          priority: "high",
          config: {
            maxIterationsPerGoal: 15,
            maxTimePerGoalMs: 90_000,
          },
          signal,
          recipeContext: {
            recipeId: recipe.id,
            recipeStepIndex: step.index,
            domainHints: [altDomain],
          },
        });

        if (altResult.status === "completed") {
          return {
            stepId: step.id,
            status: "completed",
            outputs: altResult.extractedOutputs ?? {},
            startedAt,
            completedAt: nowIso(),
            approachIndex,
          };
        }
      }
    }

    return {
      stepId: step.id,
      status: "failed",
      outputs: {},
      startedAt,
      completedAt: nowIso(),
      failureReason: goalResult.failureReason ?? "All approaches failed",
      approachIndex,
    };
  }

  // ─── Execution update ───

  function updateExecution(
    executionId: UUID,
    updates: Partial<FridaySetupExecution>,
  ): FridaySetupExecution {
    const current = executions.get(executionId);
    if (!current) throw new FridayDomainError("NOT_FOUND", `Execution ${executionId} not found`, { httpStatus: 404 });
    const updated = { ...current, ...updates } as FridaySetupExecution;
    executions.set(executionId, updated);
    return updated;
  }

  // ─── Public interface ───

  return {
    async execute(params: FridaySetupExecuteParams): Promise<FridaySetupExecution> {
      const recipe = registry.get(params.recipeId);
      if (!recipe) {
        throw new FridayDomainError("NOT_FOUND", `Recipe "${params.recipeId}" not found`, { httpStatus: 404 });
      }

      const executionId = idGenerator();
      const execution: FridaySetupExecution = {
        id: executionId,
        recipeId: recipe.id,
        status: "pending",
        currentStepIndex: 0,
        stepResults: [],
        outputs: {},
        prerequisiteResults: [],
        createdAt: nowIso(),
      };
      executions.set(executionId, execution);

      const signal = params.signal ?? new AbortController().signal;

      try {
        // ─── Check prerequisites ───
        if (!params.skipPrerequisites) {
          updateExecution(executionId, { status: "checking_prerequisites" });
          const prereqResults = await checkPrerequisitesInternal(recipe);
          updateExecution(executionId, { prerequisiteResults: prereqResults });

          const blockers = prereqResults.filter(
            (r) => !r.met && recipe.prerequisites.find((p) => p.target === r.target)?.blocking,
          );

          if (blockers.length > 0) {
            const reasons = blockers
              .map((b) => `${b.target}: ${b.fixInstruction ?? "not met"}`)
              .join("; ");
            return updateExecution(executionId, {
              status: "failed",
              completedAt: nowIso(),
              failureReason: `Prerequisite check failed: ${reasons}`,
            });
          }
        }

        // ─── Execute steps ───
        updateExecution(executionId, { status: "executing", startedAt: nowIso() });
        const inputs = params.inputs ?? {};
        const accumulatedOutputs: Record<string, string> = {};
        const stepResults: FridaySetupStepResult[] = [];

        for (let i = 0; i < recipe.steps.length; i++) {
          if (signal.aborted) break;

          const step = recipe.steps[i];
          updateExecution(executionId, { currentStepIndex: i });

          const stepResult = await executeStep(
            recipe,
            step,
            inputs,
            accumulatedOutputs,
            signal,
          );

          stepResults.push(stepResult);
          updateExecution(executionId, { stepResults });

          if (stepResult.status === "completed") {
            // Accumulate outputs
            Object.assign(accumulatedOutputs, stepResult.outputs);
            updateExecution(executionId, { outputs: { ...accumulatedOutputs } });
          } else if (stepResult.status === "paused_for_approval") {
            return updateExecution(executionId, {
              status: "paused_for_approval",
              completedAt: nowIso(),
              failureReason: stepResult.failureReason,
            });
          } else {
            // Step failed — fail the execution
            return updateExecution(executionId, {
              status: "failed",
              completedAt: nowIso(),
              failureReason: `Step ${i + 1} failed: ${stepResult.failureReason}`,
            });
          }
        }

        if (signal.aborted) {
          return updateExecution(executionId, {
            status: "cancelled",
            completedAt: nowIso(),
          });
        }

        return updateExecution(executionId, {
          status: "completed",
          completedAt: nowIso(),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return updateExecution(executionId, {
          status: "failed",
          completedAt: nowIso(),
          failureReason: reason,
        });
      }
    },

    async checkPrerequisites(recipeId: string): Promise<readonly FridaySetupPrerequisiteResult[]> {
      const recipe = registry.get(recipeId);
      if (!recipe) throw new FridayDomainError("NOT_FOUND", `Recipe "${recipeId}" not found`, { httpStatus: 404 });
      return checkPrerequisitesInternal(recipe);
    },

    getExecution(executionId: UUID): FridaySetupExecution | null {
      return executions.get(executionId) ?? null;
    },

    cancelExecution(executionId: UUID): void {
      const execution = executions.get(executionId);
      if (
        execution &&
        execution.status !== "completed" &&
        execution.status !== "failed" &&
        execution.status !== "cancelled"
      ) {
        // Cancel the autonomous goal if running
        if (execution.autonomousGoalId) {
          autonomousEngine.cancelGoal(execution.autonomousGoalId);
        }
        updateExecution(executionId, { status: "cancelled", completedAt: nowIso() });
      }
    },

    listExecutions(filters?: FridaySetupExecutionListFilters): readonly FridaySetupExecution[] {
      let result = Array.from(executions.values());
      if (filters?.recipeId) result = result.filter((e) => e.recipeId === filters.recipeId);
      if (filters?.status) result = result.filter((e) => e.status === filters.status);
      if (filters?.limit) result = result.slice(0, filters.limit);
      return result;
    },
  };
}

// ─── Helpers ───

/**
 * Simple semver satisfaction check.
 * Supports ">=x.y.z", "^x.y.z", and exact match.
 */
function satisfiesVersion(actual: string, expected: string): boolean {
  const actualParts = actual.split(".").map(Number);
  const cleanExpected = expected.replace(/^[>=^~]+/, "");
  const expectedParts = cleanExpected.split(".").map(Number);

  if (expected.startsWith(">=")) {
    for (let i = 0; i < Math.max(actualParts.length, expectedParts.length); i++) {
      const a = actualParts[i] ?? 0;
      const e = expectedParts[i] ?? 0;
      if (a > e) return true;
      if (a < e) return false;
    }
    return true; // Equal
  }

  if (expected.startsWith("^")) {
    // Major version must match, minor.patch must be >= expected
    return actualParts[0] === expectedParts[0] && (
      (actualParts[1] ?? 0) > (expectedParts[1] ?? 0) ||
      ((actualParts[1] ?? 0) === (expectedParts[1] ?? 0) && (actualParts[2] ?? 0) >= (expectedParts[2] ?? 0))
    );
  }

  // Exact match
  return actual === cleanExpected;
}
