import { describe, it, expect, vi } from "vitest";
import { createFridayAgentSetupAssistantTool } from "../../../../src/agent/tools/friday-agent-setup-assistant-tool.js";
import type { FridaySetupAssistant } from "../../../../src/setup/friday-setup-assistant.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function createMockAssistant(overrides?: Partial<FridaySetupAssistant>): FridaySetupAssistant {
  return {
    planSetup: vi.fn().mockResolvedValue([
      {
        recipeId: "channel-discord-bot",
        recipeName: "Discord Bot Setup",
        category: "channel",
        targetService: "discord",
        prerequisitesMet: true,
        missingPrerequisites: [],
        enabled: true,
      },
    ]),
    executeSetup: vi.fn().mockResolvedValue({
      phase: "completed",
      totalRecipes: 1,
      completedRecipes: 1,
      failedRecipes: 0,
      pausedRecipes: 0,
      skippedRecipes: 0,
      results: [
        {
          recipeId: "channel-discord-bot",
          recipeName: "Discord Bot Setup",
          status: "completed",
          outputs: { botToken: "test-token-abc123" },
        },
      ],
      durationMs: 5000,
    }),
    getProgress: vi.fn().mockReturnValue({
      phase: "idle",
      totalRecipes: 0,
      completedRecipes: 0,
      failedRecipes: 0,
      pausedRecipes: 0,
      currentRecipeId: null,
      currentRecipeName: null,
      percentComplete: 0,
      onboardingProgress: undefined,
      onboardingChecklist: [],
    }),
    cancel: vi.fn(),
    ...overrides,
  };
}

describe("FridayAgentSetupAssistantTool", () => {
  describe("metadata", () => {
    it("should have correct name", () => {
      const tool = createFridayAgentSetupAssistantTool({
        setupAssistant: createMockAssistant(),
      });
      expect(tool.name).toBe("setup_assistant");
    });

    it("should have description mentioning zero-config", () => {
      const tool = createFridayAgentSetupAssistantTool({
        setupAssistant: createMockAssistant(),
      });
      expect(tool.description).toContain("Zero-config");
    });
  });

  describe("plan_setup", () => {
    it("should return a setup plan", async () => {
      const tool = createFridayAgentSetupAssistantTool({
        setupAssistant: createMockAssistant(),
      });

      const result = await tool.execute({ action: "plan_setup" }, signal());
      expect(result.isError).toBeFalsy();

      const parsed = JSON.parse(result.content);
      expect(parsed.totalRecipes).toBe(1);
      expect(parsed.readyRecipes).toBe(1);
      expect(parsed.plan[0].recipeId).toBe("channel-discord-bot");
    });
  });

  describe("execute_setup", () => {
    it("should execute setup and return results", async () => {
      const assistant = createMockAssistant();
      const tool = createFridayAgentSetupAssistantTool({ setupAssistant: assistant });

      const result = await tool.execute(
        { action: "execute_setup", principalId: "user-1" },
        signal(),
      );

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.phase).toBe("completed");
      expect(parsed.completedRecipes).toBe(1);
    });

    it("should mask sensitive outputs", async () => {
      const tool = createFridayAgentSetupAssistantTool({
        setupAssistant: createMockAssistant(),
      });

      const result = await tool.execute(
        { action: "execute_setup" },
        signal(),
      );

      const parsed = JSON.parse(result.content);
      // Token should be masked
      expect(parsed.results[0].outputs.botToken).toContain("...");
    });
  });

  describe("get_progress", () => {
    it("should return current progress", async () => {
      const tool = createFridayAgentSetupAssistantTool({
        setupAssistant: createMockAssistant(),
      });

      const result = await tool.execute({ action: "get_progress" }, signal());
      expect(result.isError).toBeFalsy();

      const parsed = JSON.parse(result.content);
      expect(parsed.phase).toBe("idle");
    });
  });

  describe("cancel_setup", () => {
    it("should cancel an active setup", async () => {
      const assistant = createMockAssistant();
      const tool = createFridayAgentSetupAssistantTool({ setupAssistant: assistant });

      const result = await tool.execute({ action: "cancel_setup" }, signal());
      expect(result.isError).toBeFalsy();
      expect(assistant.cancel).toHaveBeenCalled();
    });
  });

  describe("invalid action", () => {
    it("should return error for invalid action", async () => {
      const tool = createFridayAgentSetupAssistantTool({
        setupAssistant: createMockAssistant(),
      });

      const result = await tool.execute({ action: "bad_action" }, signal());
      expect(result.isError).toBe(true);
    });
  });
});
