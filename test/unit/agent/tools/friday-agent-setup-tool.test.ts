import { describe, it, expect, vi } from "vitest";
import { createFridayAgentSetupTool } from "../../../../src/agent/tools/friday-agent-setup-tool.js";
import type { FridaySetupRecipeRegistry, FridaySetupRecipeExecutor, FridayEnvironmentScanner } from "../../../../src/setup/friday-setup.types.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function createMockRegistry(): FridaySetupRecipeRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue({
      id: "channel-discord-bot",
      name: "Discord Bot Setup",
      description: "Set up a Discord bot",
      category: "channel",
      targetService: "discord",
      steps: [{ id: "s1" }, { id: "s2" }],
      outputs: [{ key: "botToken", label: "Bot Token" }],
    }),
    list: vi.fn().mockReturnValue([
      {
        id: "channel-discord-bot",
        name: "Discord Bot Setup",
        description: "Set up a Discord bot",
        category: "channel",
        targetService: "discord",
        steps: [{ id: "s1" }],
        outputs: [{ key: "botToken", label: "Bot Token" }],
      },
    ]),
    getByTarget: vi.fn(),
  };
}

function createMockExecutor(): FridaySetupRecipeExecutor {
  return {
    execute: vi.fn().mockResolvedValue({
      id: "exec-001",
      recipeId: "channel-discord-bot",
      status: "completed",
      currentStepIndex: 1,
      stepResults: [{ stepId: "s1", status: "completed" }],
      outputs: { botToken: "test-token-abc123" },
      prerequisiteResults: [],
      createdAt: "2026-03-11T10:00:00Z",
      completedAt: "2026-03-11T10:05:00Z",
    }),
    checkPrerequisites: vi.fn().mockResolvedValue([
      { type: "network_reachable", target: "https://discord.com", met: true, actual: "reachable" },
    ]),
    getExecution: vi.fn().mockReturnValue(null),
    cancelExecution: vi.fn(),
    listExecutions: vi.fn().mockReturnValue([]),
  };
}

function createMockScanner(): FridayEnvironmentScanner {
  return {
    isInstalled: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue("22.0.0"),
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
      dockerVersion: "25.0.0",
      installedBrowsers: ["chrome", "safari"],
      networkConnectivity: true,
    }),
  };
}

describe("FridayAgentSetupTool", () => {
  describe("metadata", () => {
    it("should have correct name", () => {
      const tool = createFridayAgentSetupTool({
        recipeRegistry: createMockRegistry(),
        recipeExecutor: createMockExecutor(),
        environmentScanner: createMockScanner(),
      });
      expect(tool.name).toBe("setup");
    });
  });

  describe("list_recipes", () => {
    it("should list available recipes", async () => {
      const tool = createFridayAgentSetupTool({
        recipeRegistry: createMockRegistry(),
        recipeExecutor: createMockExecutor(),
        environmentScanner: createMockScanner(),
      });

      const result = await tool.execute({ action: "list_recipes" }, signal());
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.count).toBeGreaterThan(0);
      expect(parsed.recipes[0].id).toBe("channel-discord-bot");
    });
  });

  describe("check_prerequisites", () => {
    it("should check prerequisites for a recipe", async () => {
      const executor = createMockExecutor();
      const tool = createFridayAgentSetupTool({
        recipeRegistry: createMockRegistry(),
        recipeExecutor: executor,
        environmentScanner: createMockScanner(),
      });

      const result = await tool.execute(
        { action: "check_prerequisites", recipeId: "channel-discord-bot" },
        signal(),
      );

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.allMet).toBe(true);
      expect(parsed.results).toHaveLength(1);
    });
  });

  describe("execute_recipe", () => {
    it("should execute a recipe", async () => {
      const executor = createMockExecutor();
      const tool = createFridayAgentSetupTool({
        recipeRegistry: createMockRegistry(),
        recipeExecutor: executor,
        environmentScanner: createMockScanner(),
      });

      const result = await tool.execute(
        { action: "execute_recipe", recipeId: "channel-discord-bot" },
        signal(),
      );

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.executionId).toBe("exec-001");
      expect(parsed.status).toBe("completed");
    });

    it("should mask sensitive outputs in response", async () => {
      const tool = createFridayAgentSetupTool({
        recipeRegistry: createMockRegistry(),
        recipeExecutor: createMockExecutor(),
        environmentScanner: createMockScanner(),
      });

      const result = await tool.execute(
        { action: "execute_recipe", recipeId: "channel-discord-bot" },
        signal(),
      );

      const parsed = JSON.parse(result.content);
      // Token should be masked (first 4 + last 4 chars)
      expect(parsed.outputs.botToken).toContain("...");
    });
  });

  describe("scan_environment", () => {
    it("should return environment scan results", async () => {
      const tool = createFridayAgentSetupTool({
        recipeRegistry: createMockRegistry(),
        recipeExecutor: createMockExecutor(),
        environmentScanner: createMockScanner(),
      });

      const result = await tool.execute({ action: "scan_environment" }, signal());
      expect(result.isError).toBeFalsy();

      const parsed = JSON.parse(result.content);
      expect(parsed.os).toBe("darwin");
      expect(parsed.nodeVersion).toBe("22.0.0");
      expect(parsed.installedBrowsers).toContain("chrome");
    });
  });

  describe("invalid action", () => {
    it("should return error for invalid action", async () => {
      const tool = createFridayAgentSetupTool({
        recipeRegistry: createMockRegistry(),
        recipeExecutor: createMockExecutor(),
        environmentScanner: createMockScanner(),
      });

      const result = await tool.execute({ action: "bad" }, signal());
      expect(result.isError).toBe(true);
    });
  });
});
