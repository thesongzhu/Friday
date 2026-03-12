import { describe, expect, it, vi } from "vitest";
import { createFridayUixRoutes } from "#api";
import type { FridayHttpContext } from "#api";
import type { FridayUixSurfaceService } from "../../../../src/uix/services/friday-uix-surface-service.js";
import type { FridayCommunicationPersona } from "../../../../src/uix/services/friday-communication-persona.js";

const NOW = "2026-03-07T10:00:00.000Z";

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: { userId: "user-1" } as never,
    ...overrides,
  };
}

function makeService(): FridayUixSurfaceService {
  return {
    resolveIntent: vi.fn(() => ({
      intent: "generate_workflow",
      confidence: 0.92,
      summary: "Generate a workflow directly.",
      routeTarget: "/assistant",
      suggestedTemplateIds: ["generate-workflow"],
    })),
    listTemplates: vi.fn(() => [
      {
        id: "generate-workflow",
        label: "Generate a workflow",
        description: "Turn a goal into a deploy-ready workflow draft.",
        category: "workflows",
        parameters: [],
      },
    ]),
    listPreferences: vi.fn(() => ({
      items: [
        {
          id: "pref-1",
          principalId: "user-1",
          category: "communication",
          key: "persona.tone",
          value: "warm",
          source: "explicit",
          confidence: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      nextCursor: undefined,
    })),
    updatePreferences: vi.fn(() => ({
      preferences: [
        {
          id: "pref-1",
          principalId: "user-1",
          category: "communication",
          key: "persona.tone",
          value: "warm",
          source: "explicit",
          confidence: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      created: 1,
      updated: 0,
    })),
    deletePreference: vi.fn(() => ({
      deleted: true,
      preferenceId: "pref-1",
    })),
    getPersona: vi.fn((): FridayCommunicationPersona => ({
      category: "communication",
      mbti: "INFJ",
      settings: {
        tone: "warm",
        verbosity: "balanced",
        structure: "structured",
        questionStyle: "guided",
        directness: "balanced",
        emojiStyle: "light",
        jargonTolerance: "medium",
        assumptionStyle: "balanced",
        confirmationStyle: "explicit",
      },
      inheritedFrom: {
        mbti: "INFJ",
        settings: {
          tone: "template",
          verbosity: "template",
          structure: "template",
          questionStyle: "template",
          directness: "template",
          emojiStyle: "template",
          jargonTolerance: "template",
          assumptionStyle: "template",
          confirmationStyle: "template",
        },
      },
      preview: {
        styleLabel: "warm/balanced/structured",
        sampleClarifier: "I can help with that. Which outcome matters most here?",
        sampleBoundary: "This is a high-risk step. I need your approval before I continue.",
      },
    })),
    executeTemplate: vi.fn(async () => ({
      templateId: "generate-workflow",
      status: "executed",
      summary: "Friday prepared the workflow draft.",
      routeTarget: "/assistant",
      result: { sessionId: "sess-1" },
      workflow: {
        kind: "draft_ready",
        workflowName: "Deploy workflow",
        workflowId: "wf-1",
        draftId: "draft-1",
        sessionId: "sess-1",
        summary: "Workflow ready",
        routeTarget: "/workflows",
        deployReady: true,
      },
    })),
    startWizard: vi.fn(() => ({
      wizard: {
        wizardId: "guided-assistant",
        contextId: "ctx-1",
        title: "Guided Assistant",
        status: "awaiting_input",
        currentStepId: "goal",
        steps: [],
        collectedValues: {},
      },
    })),
    continueWizard: vi.fn(async () => ({
      wizard: {
        wizardId: "guided-assistant",
        contextId: "ctx-1",
        title: "Guided Assistant",
        status: "ready",
        currentStepId: "clarification",
        steps: [],
        collectedValues: { goal: "Generate a skill" },
      },
      summary: "Friday needs one clarification.",
    })),
    listIssues: vi.fn(() => [
      {
        id: "issue-1",
        kind: "approval_required",
        incidentId: "incident-1",
        title: "Approve the fix",
        summary: "Friday found a safe mitigation but needs approval.",
        severity: "medium" as const,
        status: "pending",
        createdAt: NOW,
        routeTarget: "/assistant" as const,
      },
    ]),
  };
}

describe("FridayUixRoutes", () => {
  it("creates assistant route definitions", () => {
    const routes = createFridayUixRoutes({ service: makeService() });
    expect(routes).toHaveLength(10);
    expect(routes.map((route) => route.operationId)).toEqual([
      "uix.intents.resolve",
      "uix.templates.list",
      "uix.preferences.list",
      "uix.preferences.update",
      "uix.preferences.delete",
      "uix.persona.get",
      "uix.templates.execute",
      "uix.wizards.start",
      "uix.wizards.continue",
      "uix.issues.list",
    ]);
  });

  it("resolves a beginner intent from plain language", async () => {
    const service = makeService();
    const routes = createFridayUixRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "uix.intents.resolve")!;

    const result = await route.handler(
      makeCtx({ body: { text: "Deploy the release workflow" } }),
    ) as { intent: string; suggestedTemplateIds: string[] };

    expect(service.resolveIntent).toHaveBeenCalledWith({ text: "Deploy the release workflow", userId: "user-1" });
    expect(result.intent).toBe("generate_workflow");
  });

  it("lists and updates communication preferences", async () => {
    const service = makeService();
    const routes = createFridayUixRoutes({ service });
    const listRoute = routes.find((entry) => entry.operationId === "uix.preferences.list")!;
    const updateRoute = routes.find((entry) => entry.operationId === "uix.preferences.update")!;

    const listResult = await listRoute.handler(
      makeCtx({ query: { category: "communication" } }),
    ) as { items: Array<{ key: string }> };

    expect(service.listPreferences).toHaveBeenCalledWith({ userId: "user-1", category: "communication" });
    expect(listResult.items[0]?.key).toBe("persona.tone");

    await updateRoute.handler(
      makeCtx({
        body: {
          preferences: [
            { category: "communication", key: "persona.tone", value: "warm" },
          ],
        },
      }),
    );

    expect(service.updatePreferences).toHaveBeenCalledWith({
      userId: "user-1",
      request: {
        preferences: [
          { category: "communication", key: "persona.tone", value: "warm" },
        ],
      },
    });
  });

  it("returns the resolved communication persona", async () => {
    const service = makeService();
    const routes = createFridayUixRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "uix.persona.get")!;

    const result = await route.handler(makeCtx()) as { persona: FridayCommunicationPersona };

    expect(service.getPersona).toHaveBeenCalledWith({ userId: "user-1" });
    expect(result.persona.mbti).toBe("INFJ");
  });

  it("executes a template with structured parameters", async () => {
    const service = makeService();
    const routes = createFridayUixRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "uix.templates.execute")!;

    await route.handler(
        makeCtx({
        params: { templateId: "generate-workflow" },
        body: { parameters: { goal: "Deploy the release workflow" } },
      }),
    );

    expect(service.executeTemplate).toHaveBeenCalledWith({
      templateId: "generate-workflow",
      userId: "user-1",
      parameters: { goal: "Deploy the release workflow" },
    });
  });

  it("lists beginner issue cards", async () => {
    const service = makeService();
    const routes = createFridayUixRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "uix.issues.list")!;

    const result = await route.handler(
      makeCtx({ query: { limit: "5" } }),
    ) as { items: Array<{ id: string }> };

    expect(service.listIssues).toHaveBeenCalledWith({ userId: "user-1", limit: 5 });
    expect(result.items[0]?.id).toBe("issue-1");
  });
});
