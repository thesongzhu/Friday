import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFridayMemoryRoutes } from "#api";
import type { FridayMemoryService } from "#memory";
import type { FridayMemoryGuardServiceFactory } from "#memory";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
import type { FridayMemoryItem, FridayMemorySearchResult } from "#memory";
import { FridayDomainError } from "#errors";

describe("FridayMemoryGuardRoutes — Guard Factory Wiring", () => {
  let memoryService: FridayMemoryService;
  let memoryGuardFactory: FridayMemoryGuardServiceFactory;
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
  const NOW = "2026-02-17T10:00:00.000Z";

  function makeCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
    return {
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {},
      headers: {},
      principal: {
        principalType: "user" as const,
        principalId: "user-1",
        userId: "user-1",
        role: "admin" as const,
        scopes: ["hub.admin" as const],
        tokenId: "tok-1",
        tokenKind: "access" as const,
        issuedAt: NOW,
      },
      ...overrides,
    };
  }

  function findRoute(operationId: string) {
    return routes.find((r) => r.operationId === operationId)!;
  }

  const mockItem: FridayMemoryItem = {
    id: "item-1",
    namespace: "test",
    key: "key-1",
    content: "Hello world",
    source: "system",
    tags: [],
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    memoryService = {
      store: vi.fn().mockResolvedValue(mockItem),
      search: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(mockItem),
      list: vi.fn().mockResolvedValue([mockItem]),
      delete: vi.fn().mockResolvedValue(true),
      prune: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [], dryRun: false }),
    };
    memoryGuardFactory = {
      forPrincipal: vi.fn().mockReturnValue(memoryService),
      forContext: vi.fn().mockReturnValue(memoryService),
    };
    routes = createFridayMemoryRoutes({ memoryGuardFactory });
  });

  // ─── Guard factory wiring ───

  it("calls forPrincipal with ctx.principal on store", async () => {
    const ctx = makeCtx({
      body: { namespace: "test-ns", content: "Hello" },
    });
    await findRoute("memory.store").handler(ctx);
    expect(memoryGuardFactory.forPrincipal).toHaveBeenCalledWith(ctx.principal);
  });

  it("calls forPrincipal with ctx.principal on search", async () => {
    const ctx = makeCtx({ body: { query: "hello" } });
    await findRoute("memory.search").handler(ctx);
    expect(memoryGuardFactory.forPrincipal).toHaveBeenCalledWith(ctx.principal);
  });

  it("calls forPrincipal with ctx.principal on get", async () => {
    const ctx = makeCtx({ params: { id: "item-1" } });
    await findRoute("memory.get").handler(ctx);
    expect(memoryGuardFactory.forPrincipal).toHaveBeenCalledWith(ctx.principal);
  });

  it("calls forPrincipal with ctx.principal on list", async () => {
    const ctx = makeCtx({ query: {} });
    await findRoute("memory.list").handler(ctx);
    expect(memoryGuardFactory.forPrincipal).toHaveBeenCalledWith(ctx.principal);
  });

  it("calls forPrincipal with ctx.principal on delete", async () => {
    const ctx = makeCtx({ params: { id: "item-1" } });
    await findRoute("memory.delete").handler(ctx);
    expect(memoryGuardFactory.forPrincipal).toHaveBeenCalledWith(ctx.principal);
  });

  it("calls forPrincipal with ctx.principal on prune", async () => {
    const ctx = makeCtx({ body: {} });
    await findRoute("memory.prune").handler(ctx);
    expect(memoryGuardFactory.forPrincipal).toHaveBeenCalledWith(ctx.principal);
  });

  it("calls forPrincipal with null principal", async () => {
    const ctx = makeCtx({
      principal: null,
      body: { namespace: "test-ns", content: "Hello" },
    });
    await findRoute("memory.store").handler(ctx);
    expect(memoryGuardFactory.forPrincipal).toHaveBeenCalledWith(null);
  });

  // ─── Integer validation (CX R2 fix) ───

  it("rejects non-integer limit on search", async () => {
    const ctx = makeCtx({ body: { query: "hello", limit: 3.5 } });
    await expect(findRoute("memory.search").handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("rejects string limit on search", async () => {
    const ctx = makeCtx({ body: { query: "hello", limit: "abc" } });
    await expect(findRoute("memory.search").handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("accepts integer limit on search", async () => {
    const ctx = makeCtx({ body: { query: "hello", limit: 10 } });
    await expect(findRoute("memory.search").handler(ctx)).resolves.toBeDefined();
  });

  it("rejects non-integer ttlSeconds on store", async () => {
    const ctx = makeCtx({
      body: { namespace: "test", content: "hi", ttlSeconds: 3.5 },
    });
    await expect(findRoute("memory.store").handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("rejects string ttlSeconds on store", async () => {
    const ctx = makeCtx({
      body: { namespace: "test", content: "hi", ttlSeconds: "300" },
    });
    await expect(findRoute("memory.store").handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("accepts integer ttlSeconds on store", async () => {
    const ctx = makeCtx({
      body: { namespace: "test", content: "hi", ttlSeconds: 300 },
    });
    await expect(findRoute("memory.store").handler(ctx)).resolves.toBeDefined();
  });

  it("rejects non-integer limit on list (query param)", async () => {
    const ctx = makeCtx({ query: { limit: "3.5" } });
    await expect(findRoute("memory.list").handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("rejects non-numeric limit on list (query param)", async () => {
    const ctx = makeCtx({ query: { limit: "abc" } });
    await expect(findRoute("memory.list").handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("accepts integer limit on list (query param)", async () => {
    const ctx = makeCtx({ query: { limit: "10" } });
    await expect(findRoute("memory.list").handler(ctx)).resolves.toBeDefined();
  });
});
