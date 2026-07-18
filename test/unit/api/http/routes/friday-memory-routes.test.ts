import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFridayMemoryRoutes } from "#api";
import { createFridayMemoryService, FRIDAY_MEMORY_ERROR_CODES } from "#memory";
import type { FridayMemoryService } from "#memory";
import type { FridayMemoryGuardServiceFactory } from "#memory";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
import type { FridayMemoryItem, FridayMemorySearchResult } from "#memory";
import { FridayDomainError } from "#errors";
import { hashIdempotencyPayload } from "../../../../../src/api/http/routes/friday-route-idempotency.js";
import { createTestDb } from "../../../satellites/_helpers/create-test-db.helper.js";

describe("FridayMemoryRoutes", () => {
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

  // ─── Route registration ───

  it("registers 7 memory routes", () => {
    expect(routes).toHaveLength(7);
  });

  it("has correct operation IDs", () => {
    const ids = routes.map((r) => r.operationId);
    expect(ids).toContain("memory.store");
    expect(ids).toContain("memory.search");
    expect(ids).toContain("memory.get");
    expect(ids).toContain("memory.list");
    expect(ids).toContain("memory.delete");
    expect(ids).toContain("memory.prune");
  });

  it("every route declares public auth (auth-boundary product invariant)", () => {
    for (const route of routes) {
      expect(route.auth).toEqual({ public: true });
    }
  });

  it("uses correct HTTP methods", () => {
    expect(findRoute("memory.store").method).toBe("POST");
    expect(findRoute("memory.search").method).toBe("POST");
    expect(findRoute("memory.get").method).toBe("GET");
    expect(findRoute("memory.list").method).toBe("GET");
    expect(findRoute("memory.delete").method).toBe("DELETE");
    expect(findRoute("memory.prune").method).toBe("POST");
  });

  it("uses correct paths", () => {
    expect(findRoute("memory.store").path).toBe("/v1/memory/store");
    expect(findRoute("memory.search").path).toBe("/v1/memory/search");
    expect(findRoute("memory.get").path).toBe("/v1/memory/items/:id");
    expect(findRoute("memory.list").path).toBe("/v1/memory/items");
    expect(findRoute("memory.delete").path).toBe("/v1/memory/items/:id");
    expect(findRoute("memory.prune").path).toBe("/v1/memory/prune");
  });

  // ─── Store handler ───

  it("store handler calls service.store with correct args", async () => {
    const route = findRoute("memory.store");
    const ctx = makeCtx({
      body: {
        namespace: "test-ns",
        content: "Hello world",
        source: "agent",
        tags: ["t1"],
        memoryType: "fact",
        confidence: 0.85,
      },
    });

    const result = await route.handler(ctx) as { item: FridayMemoryItem };
    expect(result.item).toBe(mockItem);
    expect(memoryService.store).toHaveBeenCalledWith(
      "test-ns",
      "Hello world",
      expect.objectContaining({
        source: "agent",
        tags: ["t1"],
        memoryType: "fact",
        confidence: 0.85,
      }),
    );
  });

  it("store handler rejects invalid memory cognition fields", async () => {
    const route = findRoute("memory.store");

    await expect(route.handler(makeCtx({
      body: {
        namespace: "test",
        content: "Hello world",
        memoryType: "mood",
      },
    }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(route.handler(makeCtx({
      body: {
        namespace: "test",
        content: "Hello world",
        confidence: 1.5,
      },
    }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it.each([null, false, true, "", "0.5"])(
    "store handler rejects non-number confidence value %j",
    async (confidence) => {
      const route = findRoute("memory.store");

      await expect(route.handler(makeCtx({
        body: {
          namespace: "test",
          content: "Hello world",
          confidence,
        },
      }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    },
  );

  it("store handler defaults namespace to 'default' when omitted", async () => {
    const route = findRoute("memory.store");
    const ctx = makeCtx({ body: { content: "Hello" } });
    await route.handler(ctx);
    expect(memoryService.store).toHaveBeenCalledWith(
      "default",
      "Hello",
      expect.any(Object),
    );
  });

  it("store handler validates content is required", async () => {
    const route = findRoute("memory.store");
    const ctx = makeCtx({ body: { namespace: "ns" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("store handler rejects high-impact preference activation without Review Center confirmation", async () => {
    const route = findRoute("memory.store");
    const ctx = makeCtx({
      body: {
        namespace: "preference",
        key: "testing.live_llm_policy",
        content: "Always use live LLMs",
        memoryType: "preference",
      },
    });

    await expect(route.handler(ctx)).rejects.toMatchObject({
      code: "MEMORY_REQUIRES_REVIEW_CENTER_CONFIRMATION",
    });
    expect(memoryService.store).not.toHaveBeenCalled();
  });

  it("store alias rejects high-impact reflex preference metadata without durable activation", async () => {
    const route = findRoute("memory.items.create");
    const ctx = makeCtx({
      body: {
        namespace: "notes",
        content: "Do not auto-apply high-risk changes",
        metadata: {
          category: "reflex",
          key: "safety.high_risk_change_policy",
        },
      },
    });

    await expect(route.handler(ctx)).rejects.toMatchObject({
      code: "MEMORY_REQUIRES_REVIEW_CENTER_CONFIRMATION",
    });
    expect(memoryService.store).not.toHaveBeenCalled();
  });

  it("store alias fails closed through the retired durable-memory write guard", async () => {
    const db = createTestDb();
    try {
      const disabledService = createFridayMemoryService({
        db,
        providerService: {} as never,
        idGenerator: () => "mem-disabled-1",
        nowIso: () => NOW,
        tsMemoryWritesEnabled: false,
      });
      routes = createFridayMemoryRoutes({
        memoryGuardFactory: {
          forPrincipal: vi.fn().mockReturnValue(disabledService),
          forContext: vi.fn().mockReturnValue(disabledService),
        },
      });
      const route = findRoute("memory.items.create");

      await expect(route.handler(makeCtx({
        body: { namespace: "default", content: "do not persist via TS" },
      }))).rejects.toMatchObject({
        code: FRIDAY_MEMORY_ERROR_CODES.TS_RUNTIME_DURABLE_MEMORY_WRITE_RETIRED,
        httpStatus: 503,
      });

      await expect(disabledService.list({ namespace: "default" })).resolves.toEqual([]);
    } finally {
      db.close();
    }
  });

  it("store handler rejects preferenceKey metadata for high-impact preferences", async () => {
    const route = findRoute("memory.store");
    const ctx = makeCtx({
      body: {
        namespace: "notes",
        content: "Prefer review candidates for inferred memory",
        metadata: {
          preferenceKey: "memory.inferred_preference_policy",
        },
      },
    });

    await expect(route.handler(ctx)).rejects.toMatchObject({
      code: "MEMORY_REQUIRES_REVIEW_CENTER_CONFIRMATION",
    });
    expect(memoryService.store).not.toHaveBeenCalled();
  });

  it("store handler replays an existing item when Idempotency-Key matches", async () => {
    const replayItem: FridayMemoryItem = {
      ...mockItem,
      metadata: {
        apiRequest: {
          operationId: "memory.items.create",
          principalId: "user-1",
          idempotencyKey: "idem-1",
          payloadHash: hashIdempotencyPayload({
            namespace: "default",
            content: "Hello",
          }),
          receivedAt: NOW,
        },
      },
    };
    routes = createFridayMemoryRoutes({
      memoryGuardFactory,
      findStoreReplay: vi.fn(() => replayItem),
    });
    const route = findRoute("memory.store");

    const result = await route.handler(makeCtx({
      body: { content: "Hello" },
      headers: { "idempotency-key": "idem-1" },
    })) as { item: FridayMemoryItem };

    expect(result.item).toEqual(replayItem);
    expect(memoryService.store).not.toHaveBeenCalled();
  });

  it("store handler rejects an Idempotency-Key replay with a different payload", async () => {
    const replayItem: FridayMemoryItem = {
      ...mockItem,
      metadata: {
        apiRequest: {
          operationId: "memory.items.create",
          principalId: "user-1",
          idempotencyKey: "idem-1",
          payloadHash: "different-hash",
          receivedAt: NOW,
        },
      },
    };
    routes = createFridayMemoryRoutes({
      memoryGuardFactory,
      findStoreReplay: vi.fn(() => replayItem),
    });
    const route = findRoute("memory.store");

    await expect(route.handler(makeCtx({
      body: { content: "Hello" },
      headers: { "idempotency-key": "idem-1" },
    }))).rejects.toThrow("Idempotency-Key 'idem-1'");
  });

  // ─── Search handler ───

  it("search handler calls service.search", async () => {
    const searchResult: FridayMemorySearchResult = {
      item: mockItem,
      score: 0.9,
      ftsScore: 0.8,
      semanticScore: 1.0,
      matchedBy: ["fts", "semantic"],
      snippet: "Hello world",
    };
    vi.mocked(memoryService.search).mockResolvedValue([searchResult]);

    const route = findRoute("memory.search");
    const ctx = makeCtx({
      body: {
        query: "hello",
        memoryType: ["preference", "correction"],
        boostByConfidence: true,
        boostByAccess: true,
        applyRetentionDecay: true,
        retentionHalfLifeDays: 30,
      },
    });
    const result = await route.handler(ctx) as { items: FridayMemorySearchResult[] };
    expect(result.items).toHaveLength(1);
    expect(result.items[0].score).toBe(0.9);
    expect(memoryService.search).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        memoryType: ["preference", "correction"],
        boostByConfidence: true,
        boostByAccess: true,
        applyRetentionDecay: true,
        retentionHalfLifeDays: 30,
      }),
    );
  });

  it("search handler rejects invalid memory cognition filters", async () => {
    const route = findRoute("memory.search");

    await expect(route.handler(makeCtx({
      body: {
        query: "hello",
        memoryType: ["preference", "unknown"],
      },
    }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(route.handler(makeCtx({
      body: {
        query: "hello",
        boostByConfidence: "yes",
      },
    }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(route.handler(makeCtx({
      body: {
        query: "hello",
        boostByAccess: "yes",
      },
    }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(route.handler(makeCtx({
      body: {
        query: "hello",
        applyRetentionDecay: "yes",
      },
    }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(route.handler(makeCtx({
      body: {
        query: "hello",
        retentionHalfLifeDays: 0,
      },
    }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("search handler validates query is required", async () => {
    const route = findRoute("memory.search");
    const ctx = makeCtx({ body: { query: "" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("search handler merges learned facts into the public memory surface", async () => {
    routes = createFridayMemoryRoutes({
      memoryGuardFactory,
      listLearnedFacts: () => [{
        key: "pref:display_name",
        value: "Captain Friday",
        confidence: 0.8,
        evidenceCount: 1,
        lastConfirmedAt: NOW,
      }],
    });
    const route = findRoute("memory.search");
    const result = await route.handler(makeCtx({ body: { query: "call me" } })) as { items: FridayMemorySearchResult[] };

    expect(result.items.some((entry) => entry.item.source === "learned_fact")).toBe(true);
    const learned = result.items.find((entry) => entry.item.source === "learned_fact")!;
    expect(learned.item.metadata).toMatchObject({
      trustLevel: "confidence_scored_learning",
      memoryBoundary: "separate_from_durable_memory",
      evidenceBoundary: "preference_fact_evidence",
      contextUseBoundary: "learning_context_service_gated",
      promptInjectionBoundary: "not_direct_prompt_injection",
      reviewBoundary: "not_review_center_confirmed",
      revocationBoundary: "clear_delete_or_synthetic_memory_delete",
    });
  });

  it("search handler excludes learned facts when memoryType excludes preference", async () => {
    routes = createFridayMemoryRoutes({
      memoryGuardFactory,
      listLearnedFacts: () => [{
        key: "pref:display_name",
        value: "Captain Friday",
        confidence: 0.8,
        evidenceCount: 1,
        lastConfirmedAt: NOW,
      }],
    });
    const route = findRoute("memory.search");
    const result = await route.handler(makeCtx({
      body: {
        query: "call me",
        memoryType: "fact",
      },
    })) as { items: FridayMemorySearchResult[] };

    expect(result.items.some((entry) => entry.item.source === "learned_fact")).toBe(false);
  });

  // ─── Get handler ───

  it("get handler returns the item through the egress output filter (benign item unchanged in value)", async () => {
    const route = findRoute("memory.get");
    const ctx = makeCtx({ params: { id: "item-1" } });
    const result = await route.handler(ctx) as { item: FridayMemoryItem };
    // Value-identical for a benign item, but a NEW object — memory.get now applies `filterItem`
    // (round-16 leak fix) exactly as `memory.list` does, so it is no longer the raw stored reference.
    expect(result.item).toEqual(mockItem);
  });

  // SEC-EVENT-REDACTION-001 round-16: the public single-item GET `memory.get` previously returned the
  // stored item VERBATIM — a secret / PII / secret-shaped tag in an item written before the store-time
  // guard leaked here while `memory.list` redacted the SAME item (a defense-in-depth gap). It now routes
  // through the SAME `outputFilter.filterItem`. RED on 473053f1 (`return { item }`), GREEN after.
  it("get handler REDACTS a secret in content, a PII metadata value, and DROPS a secret tag", async () => {
    const seg = (...p: string[]): string => p.join(""); // pragma: allowlist secret
    const secret = seg("sk-", "abcdefghijklmnopqrstuv0123456789"); // pragma: allowlist secret
    const leaky: FridayMemoryItem = {
      ...mockItem,
      content: `deploy used ${secret} to auth`,
      tags: ["keep", secret],
      metadata: { email: "alice@example.com", note: "ok" },
    };
    vi.mocked(memoryService.get).mockResolvedValue(leaky);
    const route = findRoute("memory.get");
    const result = await route.handler(makeCtx({ params: { id: "item-1" } })) as { item: FridayMemoryItem };
    expect(result.item.content).toContain("[REDACTED_SECRET]");
    expect(result.item.content).not.toContain(secret);
    expect(result.item.tags).toEqual(["keep"]); // secret-shaped tag dropped
    expect((result.item.metadata as { email: string; note: string }).email).toBe("[EMAIL]");
    expect((result.item.metadata as { email: string; note: string }).note).toBe("ok");
    const json = JSON.stringify(result.item);
    expect(json).not.toContain(secret);
    expect(json).not.toContain("alice@example.com");
  });

  it("get handler throws 404 when not found", async () => {
    vi.mocked(memoryService.get).mockResolvedValue(null);
    const route = findRoute("memory.get");
    const ctx = makeCtx({ params: { id: "nonexistent" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  // ─── Delete handler ───

  it("delete handler returns deleted: true", async () => {
    const route = findRoute("memory.delete");
    const ctx = makeCtx({ params: { id: "item-1" } });
    const result = await route.handler(ctx) as { deleted: boolean };
    expect(result.deleted).toBe(true);
  });

  it("delete handler throws 404 when not found", async () => {
    vi.mocked(memoryService.delete).mockResolvedValue(false);
    const route = findRoute("memory.delete");
    const ctx = makeCtx({ params: { id: "nonexistent" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("delete handler removes learned facts through synthetic memory ids", async () => {
    const deleteLearnedFact = vi.fn(() => true);
    routes = createFridayMemoryRoutes({
      memoryGuardFactory,
      deleteLearnedFact,
    });
    const route = findRoute("memory.delete");
    const result = await route.handler(
      makeCtx({ params: { id: "learned-fact:pref:display_name" } }),
    ) as { deleted: boolean };

    expect(result.deleted).toBe(true);
    expect(deleteLearnedFact).toHaveBeenCalledWith({ userId: "user-1", key: "pref:display_name" });
  });

  it("delete handler fails closed for learned fact ids when the revocation writer is unavailable", async () => {
    const route = findRoute("memory.delete");

    await expect(
      route.handler(makeCtx({ params: { id: "learned-fact:pref:display_name" } })),
    ).rejects.toMatchObject({
      code: "MEMORY_LEARNED_FACT_REVOCATION_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("delete handler keeps learned fact not-found distinct when the revocation writer is wired", async () => {
    const deleteLearnedFact = vi.fn(() => false);
    routes = createFridayMemoryRoutes({
      memoryGuardFactory,
      deleteLearnedFact,
    });
    const route = findRoute("memory.delete");

    await expect(
      route.handler(makeCtx({ params: { id: "learned-fact:pref:display_name" } })),
    ).rejects.toMatchObject({
      code: FRIDAY_MEMORY_ERROR_CODES.NOT_FOUND,
      httpStatus: 404,
    });
    expect(deleteLearnedFact).toHaveBeenCalledWith({ userId: "user-1", key: "pref:display_name" });
  });

  // ─── List handler ───

  it("list handler returns items", async () => {
    const route = findRoute("memory.list");
    const ctx = makeCtx({ query: { namespace: "test" } });
    const result = await route.handler(ctx) as { items: FridayMemoryItem[] };
    expect(result.items).toHaveLength(1);
  });

  it("list handler includes learned facts in the preference surface", async () => {
    routes = createFridayMemoryRoutes({
      memoryGuardFactory,
      listLearnedFacts: () => [{
        key: "pref:display_name",
        value: "Captain Friday",
        confidence: 0.8,
        evidenceCount: 1,
        lastConfirmedAt: NOW,
      }],
    });
    const route = findRoute("memory.list");
    const result = await route.handler(makeCtx()) as { items: FridayMemoryItem[] };

    expect(result.items.some((entry) => entry.id === "learned-fact:pref:display_name")).toBe(true);
    const learned = result.items.find((entry) => entry.id === "learned-fact:pref:display_name")!;
    expect(learned.metadata).toMatchObject({
      trustLevel: "confidence_scored_learning",
      memoryBoundary: "separate_from_durable_memory",
      evidenceBoundary: "preference_fact_evidence",
      contextUseBoundary: "learning_context_service_gated",
      promptInjectionBoundary: "not_direct_prompt_injection",
      reviewBoundary: "not_review_center_confirmed",
      revocationBoundary: "clear_delete_or_synthetic_memory_delete",
    });
  });

  // ─── Prune handler ───

  it("prune handler calls service.prune", async () => {
    const route = findRoute("memory.prune");
    const ctx = makeCtx({ body: { expiredOnly: true, dryRun: true } });
    const result = await route.handler(ctx) as { result: { deletedCount: number } };
    expect(result.result.deletedCount).toBe(0);
    expect(memoryService.prune).toHaveBeenCalledWith(
      expect.objectContaining({ expiredOnly: true, dryRun: true }),
    );
  });

  // ─── Prune body validation (CX R2) ───

  it("prune handler rejects array body", async () => {
    const route = findRoute("memory.prune");
    const ctx = makeCtx({ body: [{ namespace: "evil" }] });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
    try {
      await route.handler(ctx);
    } catch (e) {
      expect((e as FridayDomainError).code).toBe("VALIDATION_ERROR");
      expect((e as FridayDomainError).message).toContain("plain object");
    }
  });

  it("prune handler rejects string body", async () => {
    const route = findRoute("memory.prune");
    const ctx = makeCtx({ body: "not-an-object" });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
    try {
      await route.handler(ctx);
    } catch (e) {
      expect((e as FridayDomainError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("prune handler rejects number body", async () => {
    const route = findRoute("memory.prune");
    const ctx = makeCtx({ body: 42 });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
    try {
      await route.handler(ctx);
    } catch (e) {
      expect((e as FridayDomainError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("prune handler accepts null body (prune all in scope)", async () => {
    const route = findRoute("memory.prune");
    const ctx = makeCtx({ body: null });
    // null body triggers the default {} in the handler: `const rawBody = ctx.body ?? {};`
    const result = await route.handler(ctx) as { result: { deletedCount: number } };
    expect(result.result.deletedCount).toBe(0);
  });

  it("prune handler accepts empty object body", async () => {
    const route = findRoute("memory.prune");
    const ctx = makeCtx({ body: {} });
    const result = await route.handler(ctx) as { result: { deletedCount: number } };
    expect(result.result.deletedCount).toBe(0);
  });
});
