import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayApiRuntime } from "#api";
import type { FridayProviderService } from "#providers";
import type { FridayMemoryService } from "#memory";
import { createFridayAgentEventEmitter, type FridayAgentRuntime } from "#agent";

describe("FridayApiRuntime — Session Registration", () => {
  let db: FridaySqliteLayer;
  const NOW = "2026-02-18T10:00:00.000Z";

  function createMockProviderService(): FridayProviderService {
    return {
      listProviders: vi.fn().mockResolvedValue([]),
      getProvider: vi.fn().mockResolvedValue(null),
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
      deleteProvider: vi.fn(),
      validateProvider: vi.fn(),
      getRoutingConfig: vi.fn().mockResolvedValue({
        defaultProviderId: "p1",
        fallbackProviderIds: [],
      }),
      setRoutingConfig: vi.fn(),
      resolveRoute: vi.fn(),
      runWithFallback: vi.fn(),
      recordUsage: vi.fn(),
      getUsageSummary: vi.fn(),
      getBudgetStatus: vi.fn().mockResolvedValue({
        monthlyLimitUsd: 100,
        spentUsd: 0,
        remainingUsd: 100,
        periodStart: NOW,
        periodEnd: NOW,
      }),
      setBudgetConfig: vi.fn(),
    } as unknown as FridayProviderService;
  }

  function createBoundPrincipal() {
    return {
      principalType: "user",
      principalId: "user:bound-1",
      tenantId: "00000000-0000-0000-0000-000000000101",
      userId: "00000000-0000-0000-0000-000000000102",
      role: "admin",
      scopes: ["agent.run", "session.read", "session.write"],
      tokenId: "00000000-0000-0000-0000-000000000103",
      tokenKind: "access",
      issuedAt: NOW,
    };
  }

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("registers session routes", () => {
    const providerService = createMockProviderService();

    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!",
      computeChecksum: (s: string) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });

    const allRoutes = runtime.routes.getRoutes();
    const sessionRouteIds = allRoutes
      .filter((r) => r.operationId.startsWith("sessions."))
      .map((r) => r.operationId);

    expect(sessionRouteIds).toContain("sessions.list");
    expect(sessionRouteIds).toContain("sessions.create");
    expect(sessionRouteIds).toContain("sessions.get");
    expect(sessionRouteIds).toContain("sessions.archive");
    expect(sessionRouteIds).toContain("sessions.prune");
    expect(sessionRouteIds).toContain("sessions.messages.list");
    expect(sessionRouteIds).toContain("sessions.messages.create");
    expect(sessionRouteIds).toContain("sessions.run");
    expect(sessionRouteIds).toContain("sessions.memory.namespace.get");
    expect(sessionRouteIds).toContain("sessions.forks.create");
    expect(sessionRouteIds).toContain("sessions.forks.list");
    expect(sessionRouteIds).toContain("sessions.forks.merge");
  });

  it("sets sessionService on runtime", () => {
    const providerService = createMockProviderService();

    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!",
      computeChecksum: (s: string) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });

    expect(runtime.sessionService).toBeDefined();
  });

  it("session operation IDs are unique across all registered routes", () => {
    const providerService = createMockProviderService();

    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!",
      computeChecksum: (s: string) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });

    const allRoutes = runtime.routes.getRoutes();
    const operationIds = allRoutes.map((r) => r.operationId);
    const uniqueIds = new Set(operationIds);

    expect(uniqueIds.size).toBe(operationIds.length);
  });

  it("registers extraction routes when memoryService is provided", () => {
    const providerService = createMockProviderService();
    const memoryService: FridayMemoryService = {
      store: vi.fn().mockResolvedValue({ id: "m1", namespace: "ns", key: "k", content: "c", source: "s", tags: [], metadata: {}, createdAt: NOW, updatedAt: NOW }),
      search: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
      prune: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [], dryRun: false }),
    };

    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService,
      memoryService,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!",
      computeChecksum: (s: string) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });

    expect(runtime.extractionService).toBeDefined();

    const allRoutes = runtime.routes.getRoutes();
    const extractionRouteIds = allRoutes
      .filter((r) => r.operationId.startsWith("sessions.memory."))
      .map((r) => r.operationId);

    expect(extractionRouteIds).toContain("sessions.memory.extract");
    expect(extractionRouteIds).toContain("sessions.memory.remember");
    expect(extractionRouteIds).toContain("sessions.memory.extraction.get");
    expect(extractionRouteIds).toContain("sessions.memory.extraction.retry");
  });

  it("extractionService is undefined when memoryService is not provided", () => {
    const providerService = createMockProviderService();

    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!",
      computeChecksum: (s: string) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });

    expect(runtime.extractionService).toBeUndefined();
  });

  it("avoids duplicating latest user message in history when sessions.run explicitly reuses history", async () => {
    const providerService = createMockProviderService();
    const executeRun = vi.fn(async () => ({
      runId: "run-1",
      status: "completed" as const,
      response: "ok",
      toolCallCount: 0,
      durationMs: 10,
      usageInput: 1,
      usageOutput: 1,
    }));

    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!",
      computeChecksum: (s: string) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      agentRuntime: {
        executeRun,
      } as unknown as FridayAgentRuntime,
      agentEventEmitter: createFridayAgentEventEmitter(),
      allowTestOnlyAgentRunStartExecution: true,
      allowTestOnlySessionRunExecution: true,
      allowTestOnlySessionExecution: true,
    });

    await runtime.sessionService.addMessage("discord:default:user1", {
      role: "user",
      content: "Reply exactly FRIDAY_E2E_OK",
      contentText: "Reply exactly FRIDAY_E2E_OK",
    });

    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "sessions.run");
    expect(route).toBeDefined();

    await route!.handler({
      params: { sessionKey: "discord:default:user1" },
      body: { useLastUserMessage: true },
      principal: createBoundPrincipal(),
    } as never);

    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "Reply exactly FRIDAY_E2E_OK",
        sessionKey: "discord:default:user1",
        historyMessages: [],
      }),
    );
  });

  it("does not derive tenant provider context from session metadata for public-isolated runs", async () => {
    const providerService = createMockProviderService();
    const executeRun = vi.fn(async () => ({
      runId: "run-public-isolated",
      status: "completed" as const,
      response: "ok",
      toolCallCount: 0,
      durationMs: 10,
      usageInput: 1,
      usageOutput: 1,
    }));

    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!",
      computeChecksum: (s: string) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      agentRuntime: {
        executeRun,
      } as unknown as FridayAgentRuntime,
      agentEventEmitter: createFridayAgentEventEmitter(),
      allowTestOnlyAgentRunStartExecution: true,
      allowTestOnlySessionRunExecution: true,
      allowTestOnlySessionExecution: true,
    });

    await runtime.sessionService.addMessage("discord:private-hub:user1", {
      role: "user",
      content: "Read AGENTS.md",
      contentText: "Read AGENTS.md",
    });
    const addMessageSpy = vi.spyOn(runtime.sessionService, "addMessage");
    const getConversationFocusSpy = vi.spyOn(runtime.sessionService, "getConversationFocus");
    const setConversationFocusSpy = vi.spyOn(runtime.sessionService, "setConversationFocus");

    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "sessions.run");
    expect(route).toBeDefined();

    await route!.handler({
      params: { sessionKey: "discord:private-hub:user1" },
      body: { task: "Read public docs only" },
      principal: null,
    } as never);

    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: undefined,
        constraints: {
          readOnly: true,
          operationalMode: "restricted",
          dataSensitivity: "public",
        },
        disabledToolNames: [
          "read",
          "write",
          "edit",
          "exec",
          "pdf_parse",
          "image_analysis",
          "memory_search",
          "memory_query",
          "memory_get",
          "memory_store",
          "memory_extract",
          "feedback",
        ],
        tenantContext: undefined,
        principalId: undefined,
        scopes: undefined,
        historyMessages: [],
        conversationContext: expect.objectContaining({
          selectedBlocks: [],
          selectionReasons: [],
        }),
      }),
    );
    expect(JSON.stringify(executeRun.mock.calls[0]?.[0])).not.toContain("Read AGENTS.md");
    expect(addMessageSpy).not.toHaveBeenCalled();
    expect(getConversationFocusSpy).not.toHaveBeenCalled();
    expect(setConversationFocusSpy).not.toHaveBeenCalled();
  });

  it("does not replay private session history for public agent runs with a supplied sessionKey", async () => {
    const providerService = createMockProviderService();
    const executeRun = vi.fn(async () => ({
      runId: "run-public-agent-session",
      status: "completed" as const,
      response: "ok",
      toolCallCount: 0,
      durationMs: 10,
      usageInput: 1,
      usageOutput: 1,
    }));

    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!",
      computeChecksum: (s: string) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      agentRuntime: {
        executeRun,
      } as unknown as FridayAgentRuntime,
      agentEventEmitter: createFridayAgentEventEmitter(),
      allowTestOnlyAgentRunStartExecution: true,
      allowTestOnlySessionRunExecution: true,
      allowTestOnlySessionExecution: true,
    });

    await runtime.sessionService.addMessage("chat:private-hub:user1", {
      role: "user",
      content: "PRIVATE_CONTEXT_SHOULD_NOT_REPLAY",
      contentText: "PRIVATE_CONTEXT_SHOULD_NOT_REPLAY",
    });
    const addMessageSpy = vi.spyOn(runtime.sessionService, "addMessage");
    const getConversationFocusSpy = vi.spyOn(runtime.sessionService, "getConversationFocus");
    const setConversationFocusSpy = vi.spyOn(runtime.sessionService, "setConversationFocus");

    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "agent.runs.start");
    expect(route).toBeDefined();

    await route!.handler({
      body: {
        task: "Read public docs only",
        sessionKey: "chat:private-hub:user1",
      },
      principal: null,
    } as never);

    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: undefined,
        historyMessages: [],
        conversationContext: expect.objectContaining({
          selectedBlocks: [],
          selectionReasons: [],
        }),
        constraints: {
          readOnly: true,
          operationalMode: "restricted",
          dataSensitivity: "public",
        },
      }),
    );
    expect(JSON.stringify(executeRun.mock.calls[0]?.[0]))
      .not.toContain("PRIVATE_CONTEXT_SHOULD_NOT_REPLAY");
    expect(addMessageSpy).not.toHaveBeenCalled();
    expect(getConversationFocusSpy).not.toHaveBeenCalled();
    expect(setConversationFocusSpy).not.toHaveBeenCalled();
  });

  it("persists pack context into session metadata before agent execution", async () => {
    const providerService = createMockProviderService();
    let runtimeRef: ReturnType<typeof createFridayApiRuntime>;
    const executeRun = vi.fn(async (params: { sessionKey?: string; executionContext?: { packId?: string } }) => {
      const session = params.sessionKey
        ? await runtimeRef.sessionService.getSession(params.sessionKey)
        : null;
      expect(session?.metadata).toMatchObject({
        packContext: {
          packId: "industry-creator-media",
          surface: "chat",
        },
      });

      return {
        runId: "run-pack-context",
        status: "completed" as const,
        response: "ok",
        toolCallCount: 0,
        durationMs: 10,
        usageInput: 1,
        usageOutput: 1,
      };
    });

    runtimeRef = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!",
      computeChecksum: (s: string) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      agentRuntime: {
        executeRun,
      } as unknown as FridayAgentRuntime,
      agentEventEmitter: createFridayAgentEventEmitter(),
      allowTestOnlyAgentRunStartExecution: true,
      allowTestOnlySessionRunExecution: true,
      allowTestOnlySessionExecution: true,
    });

    const route = runtimeRef.routes
      .getRoutes()
      .find((entry) => entry.operationId === "agent.runs.start");
    expect(route).toBeDefined();

    await route!.handler({
      body: {
        task: "Continue creator workflow",
        sessionKey: "chat:default:pack-context",
        executionContext: {
          surface: "chat",
          interactive: true,
          packId: "industry-creator-media",
        },
      },
      principal: createBoundPrincipal(),
    } as never);

    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "chat:default:pack-context",
        executionContext: expect.objectContaining({
          packId: "industry-creator-media",
        }),
      }),
    );

    const session = await runtimeRef.sessionService.getSession("chat:default:pack-context");
    expect(session?.metadata).toMatchObject({
      packContext: {
        packId: "industry-creator-media",
        surface: "chat",
      },
    });
    expect(typeof (session?.metadata as { packContext?: { updatedAt?: string } } | undefined)?.packContext?.updatedAt).toBe("string");
  });
});
