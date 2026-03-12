import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayApiRuntime } from "#api";
import type { FridayProviderService } from "#providers";
import type { FridayMemoryService } from "#memory";
import type { FridayAgentRuntime } from "#agent";

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

  it("avoids duplicating latest user message in history when sessions.run derives task from history", async () => {
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
      body: {},
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
});
