import { describe, expect, it, vi } from "vitest";

import { createFridaySetupRecipeExecutor } from "../../../src/setup/friday-setup-recipe-executor.js";
import type {
  FridayEnvironmentScanner,
  FridaySetupRecipe,
  FridaySetupRecipeRegistry,
} from "../../../src/setup/friday-setup.types.js";
import type { FridayAutonomousEngine } from "../../../src/agent/autonomous/friday-autonomous.types.js";

function nowIso(): string {
  return "2026-03-11T10:00:00.000Z";
}

function idGeneratorFactory(): () => string {
  let counter = 0;
  return () => `id-${++counter}`;
}

function createScanner(): FridayEnvironmentScanner {
  return {
    isInstalled: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue("1.0.0"),
    isReachable: vi.fn().mockResolvedValue(true),
    fileExists: vi.fn().mockResolvedValue(true),
    getEnvVar: vi.fn().mockReturnValue("value"),
    getOs: vi.fn().mockReturnValue("darwin"),
    scan: vi.fn().mockResolvedValue({
      os: "darwin",
      arch: "arm64",
      nodeVersion: "22.0.0",
      npmVersion: "10.0.0",
      pythonVersion: "3.12.0",
      gitVersion: "2.43.0",
      dockerVersion: null,
      installedBrowsers: ["chrome"],
      networkConnectivity: true,
    }),
  };
}

function createRegistry(recipe: FridaySetupRecipe): FridaySetupRecipeRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockImplementation((recipeId: string) => recipeId === recipe.id ? recipe : null),
    list: vi.fn().mockReturnValue([recipe]),
    getByTarget: vi.fn().mockReturnValue([recipe]),
  };
}

function createEngine(): FridayAutonomousEngine {
  return {
    executeGoal: vi.fn().mockResolvedValue({
      goalId: "goal-1",
      status: "completed",
      summary: "done",
      iterationCount: 1,
      durationMs: 10,
      extractedOutputs: { token: "abc123" },
    }),
    resumeGoal: vi.fn().mockResolvedValue({
      goalId: "goal-1",
      status: "completed",
      summary: "done",
      iterationCount: 1,
      durationMs: 10,
      extractedOutputs: { token: "abc123" },
    }),
    cancelGoal: vi.fn(),
    getGoal: vi.fn(),
    listGoals: vi.fn().mockReturnValue([]),
    getIterations: vi.fn().mockReturnValue([]),
  };
}

describe("createFridaySetupRecipeExecutor", () => {
  it("maps cli steps to exec domain hints", async () => {
    const recipe: FridaySetupRecipe = {
      id: "recipe-cli",
      name: "CLI setup",
      description: "Configure a CLI integration",
      category: "environment",
      version: "1.0.0",
      targetService: "node",
      prerequisites: [],
      steps: [
        {
          id: "step-1",
          index: 0,
          domain: "cli",
          risk: "low",
          instruction: "Install Node.js",
          guidance: "Install Node.js via the terminal.",
          requiresApproval: false,
          maxRetries: 1,
          outputKeys: ["token"],
        },
      ],
      outputs: [{ key: "token", label: "Token", sensitive: false }],
    };
    const autonomousEngine = createEngine();
    const executor = createFridaySetupRecipeExecutor({
      registry: createRegistry(recipe),
      autonomousEngine,
      environmentScanner: createScanner(),
      idGenerator: idGeneratorFactory(),
      nowIso,
    });

    const execution = await executor.execute({
      recipeId: recipe.id,
      skipPrerequisites: true,
    });

    expect(execution.status).toBe("completed");
    expect(autonomousEngine.executeGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeContext: expect.objectContaining({
          domainHints: ["exec"],
        }),
      }),
    );
  });

  it("fails deterministically for unsupported api steps without invoking the engine", async () => {
    const recipe: FridaySetupRecipe = {
      id: "recipe-api",
      name: "API setup",
      description: "Configure an API-only integration",
      category: "integration",
      version: "1.0.0",
      targetService: "service",
      prerequisites: [],
      steps: [
        {
          id: "step-1",
          index: 0,
          domain: "api",
          risk: "low",
          instruction: "Call remote API",
          guidance: "Configure the service over its API.",
          requiresApproval: false,
          maxRetries: 1,
        },
      ],
      outputs: [],
    };
    const autonomousEngine = createEngine();
    const executor = createFridaySetupRecipeExecutor({
      registry: createRegistry(recipe),
      autonomousEngine,
      environmentScanner: createScanner(),
      idGenerator: idGeneratorFactory(),
      nowIso,
    });

    const execution = await executor.execute({
      recipeId: recipe.id,
      skipPrerequisites: true,
    });

    expect(execution.status).toBe("failed");
    expect(execution.failureReason).toContain('domain "api" is not supported');
    expect(autonomousEngine.executeGoal).not.toHaveBeenCalled();
  });

  it("pauses manual or approval-gated steps instead of reporting them as failed", async () => {
    const recipe: FridaySetupRecipe = {
      id: "recipe-manual",
      name: "Manual setup",
      description: "Needs user action",
      category: "integration",
      version: "1.0.0",
      targetService: "service",
      prerequisites: [],
      steps: [
        {
          id: "step-1",
          index: 0,
          domain: "manual",
          risk: "high",
          instruction: "Paste the API key into Friday settings",
          guidance: "The user must create and paste the key.",
          requiresApproval: true,
          maxRetries: 1,
        },
      ],
      outputs: [],
    };
    const autonomousEngine = createEngine();
    const executor = createFridaySetupRecipeExecutor({
      registry: createRegistry(recipe),
      autonomousEngine,
      environmentScanner: createScanner(),
      idGenerator: idGeneratorFactory(),
      nowIso,
    });

    const execution = await executor.execute({
      recipeId: recipe.id,
      skipPrerequisites: true,
    });

    expect(execution.status).toBe("paused_for_approval");
    expect(execution.failureReason).toContain("Manual setup step requires user action");
    expect(execution.stepResults[0]?.status).toBe("paused_for_approval");
    expect(execution.stepResults[0]?.approvalInstruction).toBe("Paste the API key into Friday settings");
    expect(autonomousEngine.executeGoal).not.toHaveBeenCalled();
  });
});
