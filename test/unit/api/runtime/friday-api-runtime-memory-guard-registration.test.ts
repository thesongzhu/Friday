import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayApiRuntime } from "#api";
import type { FridayProviderService } from "#providers";
import type { FridayMemoryService } from "#memory";

describe("FridayApiRuntime — Memory Guard Registration", () => {
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

  it("creates memoryGuardFactory when memoryService is provided", () => {
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

    expect(runtime.memoryGuardFactory).toBeDefined();
    expect(runtime.memoryGuardFactory!.forPrincipal).toBeTypeOf("function");
    expect(runtime.memoryGuardFactory!.forContext).toBeTypeOf("function");
  });

  it("memoryGuardFactory is undefined when memoryService is not provided", () => {
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

    expect(runtime.memoryGuardFactory).toBeUndefined();
  });

  it("registers memory routes via guard factory", () => {
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

  it("forPrincipal returns a working guarded service for an authenticated principal", () => {
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

    const guardedService = runtime.memoryGuardFactory!.forPrincipal({
      principalType: "user",
      principalId: "principal-1",
      userId: "user-1",
      tenantId: "tenant-1",
      role: "owner",
      scopes: ["memory.write"],
      tokenId: "token-1",
      tokenKind: "access",
      issuedAt: NOW,
    });
    expect(guardedService.store).toBeTypeOf("function");
    expect(guardedService.search).toBeTypeOf("function");
    expect(guardedService.get).toBeTypeOf("function");
    expect(guardedService.list).toBeTypeOf("function");
    expect(guardedService.delete).toBeTypeOf("function");
    expect(guardedService.prune).toBeTypeOf("function");
  });

  it("forPrincipal rejects null principals instead of granting system memory scope", () => {
    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService: createMockProviderService(),
      memoryService: createMockMemoryService(),
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!",
      computeChecksum: (s: string) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });

    expect(() => runtime.memoryGuardFactory!.forPrincipal(null)).toThrow("authenticated principal");
  });

  it("forContext returns a working guarded service", () => {
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

    const guardedService = runtime.memoryGuardFactory!.forContext({
      subject: { hubId: "hub1", userId: "user1", accessLevel: "tenant" },
      principalId: "p1",
    });
    expect(guardedService.store).toBeTypeOf("function");
    expect(guardedService.search).toBeTypeOf("function");
  });

  it("operation IDs remain unique after guard integration", () => {
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
});
