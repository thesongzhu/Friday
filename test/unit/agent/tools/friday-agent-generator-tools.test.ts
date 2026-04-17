import { describe, expect, it, vi } from "vitest";

import { createFridayAgentSkillGeneratorTool } from "../../../../src/agent/tools/friday-agent-skill-generator-tool.js";
import { createFridayAgentWorkflowGeneratorTool } from "../../../../src/agent/tools/friday-agent-workflow-generator-tool.js";
import { normalizeAgentRequestedModel } from "../../../../src/agent/tools/friday-agent-tool-helpers.js";

import type { FridaySkillGeneratorService } from "../../../../src/skills/generator/services/friday-skill-generator-service.types.js";
import type { FridayWorkflowGeneratorService } from "../../../../src/workflows/generator/services/friday-workflow-generator-service.types.js";

describe("normalizeAgentRequestedModel", () => {
  it("maps provider-kind aliases to concrete default models", () => {
    expect(normalizeAgentRequestedModel("openai")).toBe("gpt-4o");
    expect(normalizeAgentRequestedModel("anthropic")).toBe("claude-sonnet-4-20250514");
    expect(normalizeAgentRequestedModel("anthropic-messages")).toBe("claude-sonnet-4-20250514");
    expect(normalizeAgentRequestedModel("default")).toBeUndefined();
  });
});

function createMockSkillGeneratorService(): FridaySkillGeneratorService {
  return {
    startSession: vi.fn().mockResolvedValue({
      mode: "ready_for_review",
      questions: [],
      session: {
        sessionId: "skill-session-1",
        goal: "Build skill",
        status: "ready_for_review",
        openQuestions: [],
        decisions: [],
        specSummary: "summary",
      },
    }),
    submitTurn: vi.fn(),
    getSession: vi.fn().mockResolvedValue({
      session: {
        sessionId: "skill-session-1",
        goal: "Build skill",
        status: "ready_for_review",
        openQuestions: [],
        decisions: [],
        specSummary: "summary",
      },
      turns: [],
      draft: {
        manifest: {
          id: "generated-skill",
          name: "generated-skill",
          description: "generated",
          version: "1.0.0",
          kind: "conversation",
          category: "utility",
          author: { name: "Friday" },
          tags: [],
          runtime: {
            kind: "node",
            entrypoint: "index.mjs",
            minHubVersion: "1.0.0",
            apiVersion: "1",
            timeoutMsDefault: 30000,
          },
          triggers: { intents: [], phrases: [], channels: ["*"] },
          invocation: { userInvocable: true, modelInvocable: true, priority: 50, modes: ["intent"] },
          requirements: { bins: [], env: [], config: [], os: ["darwin"], mcpServers: [] },
          inputs: [{ key: "topic", type: "string", required: true, label: "Topic" }],
          outputs: [{ key: "markdownBullets", type: "string", description: "Bullets" }],
          permissions: { grants: [], promptOn: [] },
          schemas: null,
          flow: null,
          executionTargets: { allowedSatelliteTypes: ["desktop"], requiredCapabilities: [] },
          telemetry: { events: [] },
        },
        runtimeKind: "node",
        files: [],
        uiSchema: null,
        validation: { ok: true, issues: [] },
      },
    }),
    generateDraft: vi.fn(),
    recordExplicitTestResult: vi.fn(),
    getQaVerdict: vi.fn(),
    getHarnessSummary: vi.fn(),
    approveAndSave: vi.fn().mockResolvedValue({
      sessionId: "skill-session-1",
      skillId: "generated-skill",
      skillDir: "/tmp/generated-skill",
      savedFiles: ["skill.manifest.json", "index.mjs"],
      registryRefreshed: true,
      promotionStage: "stabilized",
      promotedManifestTags: ["generated"],
      evidence: {
        packageLoaded: true,
        packageValidated: true,
        registryRefreshed: true,
      },
    }),
    cancelSession: vi.fn(),
  } as unknown as FridaySkillGeneratorService;
}

function createMockWorkflowGeneratorService(): FridayWorkflowGeneratorService {
  return {
    startSession: vi.fn().mockResolvedValue({
      mode: "ready_for_review",
      questions: [],
      session: {
        sessionId: "workflow-session-1",
        goal: "Build workflow",
        status: "ready_for_review",
        openQuestions: [],
        decisions: [],
      },
    }),
    submitTurn: vi.fn(),
    getSession: vi.fn(),
    generateDraft: vi.fn(),
    approveAndSave: vi.fn(),
    cancelSession: vi.fn(),
  } as unknown as FridayWorkflowGeneratorService;
}

describe("generator tools", () => {
  it("normalizes skill_generate model aliases before calling the service", async () => {
    const generatorService = createMockSkillGeneratorService();
    const tool = createFridayAgentSkillGeneratorTool({ generatorService });

    await tool.execute({
      action: "start",
      goal: "Build a topic bullet skill",
      model: "openai",
    });

    expect(generatorService.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedModel: "gpt-4o",
      }),
    );
  });

  it("normalizes workflow_generate model aliases before calling the service", async () => {
    const generatorService = createMockWorkflowGeneratorService();
    const tool = createFridayAgentWorkflowGeneratorTool({ generatorService });

    await tool.execute({
      action: "start",
      goal: "Build a workflow",
      model: "anthropic",
    });

    expect(generatorService.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedModel: "claude-sonnet-4-20250514",
      }),
    );
  });

  it("returns required input hints after skill approval", async () => {
    const generatorService = createMockSkillGeneratorService();
    const tool = createFridayAgentSkillGeneratorTool({ generatorService });

    const result = await tool.execute({
      action: "approve",
      sessionId: "skill-session-1",
    });

    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.requiredInputs).toEqual([
      { key: "topic", type: "string", label: "Topic" },
    ]);
    expect(parsed.exampleRunInput).toEqual({ topic: "<topic>" });
    expect(parsed.nextRecommendedAction).toEqual({
      tool: "skill_run",
      skillId: "generated-skill",
      input: { topic: "<topic>" },
    });
  });
});
