import { describe, expect, it, vi } from "vitest";
import { createFridayUixRoutes } from "#api";
import type { FridayHttpContext } from "#api";
import type { FridayUixSurfaceService } from "../../../../src/uix/services/friday-uix-surface-service.js";
import type { FridayCommunicationPersona } from "../../../../src/uix/services/friday-communication-persona.js";

const NOW = "2026-03-07T10:00:00.000Z";
const ASSISTANT_TENANT_CONTEXT = {
  hubId: "user-1",
  userId: "user-1",
  channelKind: "assistant",
} as const;

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
    getHomeSnapshot: vi.fn(() => ({
      activeNow: [],
      pendingApprovals: [],
      scheduledAutomations: [],
      recentResults: [],
      recommendedToAdd: [],
      runs: [],
    })),
    getAssistantInboxSnapshot: vi.fn(() => ({
      approvals: [],
      alerts: [],
      recentRuns: [],
    })),
    getDiagnostics: vi.fn(() => ({
      generatedAt: NOW,
      taskProfilePresets: [],
      recentRuns: [],
      mcpServerStates: [],
      supportedPreprocessors: [],
    })),
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

function makePreference(input: {
  id: string;
  category: "communication" | "uix";
  key: string;
  value: unknown;
}) {
  return {
    id: input.id,
    principalId: "user-1",
    category: input.category,
    key: input.key,
    value: input.value,
    source: "explicit" as const,
    confidence: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("FridayUixRoutes", () => {
  it("creates assistant route definitions", () => {
    const routes = createFridayUixRoutes({ service: makeService() });
    expect(routes).toHaveLength(18);
    expect(routes.map((route) => route.operationId)).toEqual([
      "uix.intents.resolve",
      "uix.templates.list",
      "uix.home.snapshot.get",
      "uix.assistant.inbox.snapshot.get",
      "uix.diagnostics.get",
      "uix.preferences.list",
      "uix.preferences.update",
      "uix.preferences.delete",
      "uix.persona.get",
      "uix.persona.update",
      "uix.templates.execute",
      "uix.wizards.start",
      "uix.wizards.continue",
      "uix.issues.list",
      "uix.user.profile.get",
      "uix.user.profile.update",
      "uix.investigate",
      "uix.learnedfacts.list",
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

  it("returns assistant diagnostics", async () => {
    const service = makeService();
    const routes = createFridayUixRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "uix.diagnostics.get")!;

    const result = await route.handler(makeCtx()) as {
      assistant: { generatedAt: string };
    };

    expect(service.getDiagnostics).toHaveBeenCalledWith({ userId: "user-1" });
    expect(result.assistant.generatedAt).toBe(NOW);
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
        body: {
          parameters: { goal: "Deploy the release workflow" },
          assistantSessionKey: "ui:assistant:assistant-shell",
        },
      }),
    );

    expect(service.executeTemplate).toHaveBeenCalledWith({
      templateId: "generate-workflow",
      userId: "user-1",
      parameters: { goal: "Deploy the release workflow" },
      assistantSessionKey: "ui:assistant:assistant-shell",
      tenantContext: ASSISTANT_TENANT_CONTEXT,
    });
  });

  it("passes through assistant session binding for wizard start and continue", async () => {
    const service = makeService();
    const routes = createFridayUixRoutes({ service });
    const startRoute = routes.find((entry) => entry.operationId === "uix.wizards.start")!;
    const continueRoute = routes.find((entry) => entry.operationId === "uix.wizards.continue")!;

    await startRoute.handler(
      makeCtx({
        params: { wizardId: "guided-assistant" },
        body: { assistantSessionKey: "ui:assistant:assistant-shell" },
      }),
    );
    await continueRoute.handler(
      makeCtx({
        params: { wizardId: "guided-assistant" },
        body: {
          contextId: "ctx-1",
          values: { goal: "Generate a skill" },
          assistantSessionKey: "ui:assistant:assistant-shell",
        },
      }),
    );

    expect(service.startWizard).toHaveBeenCalledWith({
      wizardId: "guided-assistant",
      userId: "user-1",
      assistantSessionKey: "ui:assistant:assistant-shell",
      tenantContext: ASSISTANT_TENANT_CONTEXT,
    });
    expect(service.continueWizard).toHaveBeenCalledWith({
      wizardId: "guided-assistant",
      contextId: "ctx-1",
      userId: "user-1",
      values: { goal: "Generate a skill" },
      assistantSessionKey: "ui:assistant:assistant-shell",
      tenantContext: ASSISTANT_TENANT_CONTEXT,
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

  it("returns default profile type without mutating onboarding state on read", async () => {
    const service = makeService();
    vi.mocked(service.listPreferences).mockReturnValue({
      items: [],
      nextCursor: undefined,
    });
    const routes = createFridayUixRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "uix.user.profile.get")!;

    const result = await route.handler(makeCtx()) as { profileType: string; onboardedAt: string | null };

    expect(service.updatePreferences).not.toHaveBeenCalled();
    expect(result.profileType).toBe("beginner");
    expect(result.onboardedAt).toBeNull();
  });

  it("returns persisted user-profile values after update", async () => {
    const service = makeService();
    vi.mocked(service.listPreferences).mockReturnValue({
      items: [
        makePreference({ id: "uix-1", category: "uix", key: "user.profile_type", value: "developer" }),
        makePreference({ id: "uix-2", category: "uix", key: "user.onboarded_at", value: NOW }),
      ],
      nextCursor: undefined,
    });
    vi.mocked(service.updatePreferences).mockReturnValue({
      preferences: [],
      created: 1,
      updated: 1,
    });
    const routes = createFridayUixRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "uix.user.profile.update")!;

    const result = await route.handler(
      makeCtx({
        body: {
          profileType: "developer",
          onboardedAt: NOW,
        },
      }),
    ) as { profileType: string; onboardedAt: string };

    expect(service.updatePreferences).toHaveBeenCalledWith({
      userId: "user-1",
      request: {
        preferences: [
          { category: "uix", key: "user.profile_type", value: "developer" },
          { category: "uix", key: "user.onboarded_at", value: NOW },
        ],
      },
    });
    expect(result).toEqual({
      profileType: "developer",
      onboardedAt: NOW,
    });
  });
});
