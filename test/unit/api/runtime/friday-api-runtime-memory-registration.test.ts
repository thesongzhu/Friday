import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayApiRuntime } from "#api";
import type { FridayProviderService } from "#providers";
import { createFridayMemoryService, FRIDAY_MEMORY_ERROR_CODES, type FridayMemoryService } from "#memory";

describe("FridayApiRuntime — Memory Registration", () => {
  let db: FridaySqliteLayer;
  const NOW = "2026-02-17T10:00:00.000Z";

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

  function createMockMemoryService(): FridayMemoryService {
    return {
      store: vi.fn(),
      search: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      prune: vi.fn(),
    };
  }

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("registers memory routes when memoryService is provided", () => {
    const providerService = createMockProviderService();
    const memoryService = createMockMemoryService();

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

    const allRoutes = runtime.routes.getRoutes();
    const memoryRouteIds = allRoutes
      .filter((r) => r.operationId.startsWith("memory."))
      .map((r) => r.operationId);

    expect(memoryRouteIds).toContain("memory.store");
    expect(memoryRouteIds).toContain("memory.search");
    expect(memoryRouteIds).toContain("memory.get");
    expect(memoryRouteIds).toContain("memory.list");
    expect(memoryRouteIds).toContain("memory.delete");
    expect(memoryRouteIds).toContain("memory.prune");
  });

  it("does not register memory routes when memoryService is not provided", () => {
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
    // `memory.spine.*` is the always-registered memory-confirmation spine route (503-dark until the
    // dispatch adapter is wired + FRIDAY_MEMORY_CONFIRM flipped), mirroring the mission-spine pattern.
    // It is orthogonal to the memoryService-gated routes (memory.store/search/get/list/delete/prune)
    // this test guards, so it is excluded here.
    const memoryRoutes = allRoutes.filter(
      (r) => r.operationId.startsWith("memory.") && !r.operationId.startsWith("memory.spine."),
    );

    expect(memoryRoutes).toHaveLength(0);
  });

  it("operation IDs are unique across all registered routes", () => {
    const providerService = createMockProviderService();
    const memoryService = createMockMemoryService();

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

    const allRoutes = runtime.routes.getRoutes();
    const operationIds = allRoutes.map((r) => r.operationId);
    const uniqueIds = new Set(operationIds);

    expect(uniqueIds.size).toBe(operationIds.length);
  });

  it("sets memoryService on runtime when provided", () => {
    const providerService = createMockProviderService();
    const memoryService = createMockMemoryService();

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

    expect(runtime.memoryService).toBe(memoryService);
  });

  it("keeps the memory item write route fail-closed by default without adding split rows", async () => {
    const countMemoryItems = (): number =>
      db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as { count: number };
        return row.count;
      });
    const providerService = createMockProviderService();
    const memoryService = createFridayMemoryService({
      db,
      providerService,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      tsMemoryWritesEnabled: false,
    });
    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService,
      memoryService,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!", // pragma: allowlist secret
      computeChecksum: (s: string) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });
    const route = runtime.routes
      .getRoutes()
      .find((candidate) => candidate.operationId === "memory.items.create");
    expect(route).toBeDefined();
    const before = countMemoryItems();

    await expect(route!.handler({
      requestId: "req-d1-memory-route",
      receivedAt: NOW,
      params: {},
      query: {},
      headers: {},
      body: {
        namespace: "d1",
        content: "do not write this into friday.db",
        source: "user",
      },
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        tokenId: "tok-1",
        tokenKind: "access",
        scopes: ["memory.write"],
        issuedAt: NOW,
      },
    })).rejects.toMatchObject({
      code: FRIDAY_MEMORY_ERROR_CODES.TS_RUNTIME_DURABLE_MEMORY_WRITE_RETIRED,
      httpStatus: 503,
      details: { operation: "memory.store" },
    });
    expect(countMemoryItems()).toBe(before);
    expect(providerService.runWithFallback).not.toHaveBeenCalled();
  });
});
