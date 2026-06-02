import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayMemoryService } from "#memory";
import type { FridayMemoryService } from "#memory";
import type { FridayProviderService } from "#providers";
import { FridayDomainError } from "#errors";
import { FRIDAY_MEMORY_ERROR_CODES } from "#memory";

describe("FridayMemoryService", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  let service: FridayMemoryService;
  let mockProviderService: FridayProviderService;
  const NOW = "2026-02-17T10:00:00.000Z";
  const originalFetch = globalThis.fetch;

  function createMockProviderService(opts?: {
    embedFails?: boolean;
    embedVector?: number[];
    embedFailureMessages?: string[];
  }): FridayProviderService {
    const vector = opts?.embedVector ?? [0.1, 0.2, 0.3];
    let failureIndex = 0;

    return {
      listProviders: vi.fn(),
      getProvider: vi.fn(),
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
      deleteProvider: vi.fn(),
      validateProvider: vi.fn(),
      getRoutingConfig: vi.fn(),
      setRoutingConfig: vi.fn(),
      resolveRoute: vi.fn(),
      runWithFallback: vi.fn().mockImplementation(async (params) => {
        if (opts?.embedFails || opts?.embedFailureMessages) {
          const failureMessage = opts?.embedFailureMessages?.[
            Math.min(failureIndex, (opts.embedFailureMessages?.length ?? 1) - 1)
          ] ?? "Embedding failed";
          failureIndex += 1;
          throw new FridayDomainError("EMBEDDING_UNAVAILABLE", failureMessage);
        }
        // Simulate: the `run` function calls fetch which returns an embedding
        // We intercept before that by returning the result directly
        const route = {
          provider: {
            id: "prov-1",
            kind: "openai" as const,
            name: "OpenAI",
            baseUrl: "https://api.openai.com",
            enabled: true,
            config: {
              api: "openai-completions" as const,
              authMode: "api-key" as const,
              keySource: { kind: "none" as const },
              supportedModels: ["text-embedding-3-small"],
            },
            createdAt: NOW,
            updatedAt: NOW,
          },
          model: "text-embedding-3-small",
        };

        // Execute the provided run function to test our code path
        const result = await params.run(route, "sk-test-key");
        return {
          result,
          route,
          attempts: [],
          routingDecision: {
            strategy: "direct" as const,
            reason: "test",
            budget: { withinBudget: true, remainingUsd: 100, monthlyLimitUsd: 100, spentUsd: 0 },
          },
        };
      }),
      recordUsage: vi.fn(),
      getUsageSummary: vi.fn(),
      getBudgetStatus: vi.fn(),
      setBudgetConfig: vi.fn(),
    } as unknown as FridayProviderService;
  }

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    // Mock fetch to return embedding response
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
            model: "text-embedding-3-small",
          }),
          { status: 200 },
        ),
      ),
    ) as typeof fetch;

    mockProviderService = createMockProviderService();
    service = createFridayMemoryService({
      db,
      providerService: mockProviderService,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── Store ───

  it("stores a memory item", async () => {
    const item = await service.store("test-ns", "Hello world");
    expect(item.id).toBe("test-id-0001");
    expect(item.namespace).toBe("test-ns");
    expect(item.content).toBe("Hello world");
    expect(item.source).toBe("system");
  });

  it("stores with metadata", async () => {
    const item = await service.store("ns", "content", {
      source: "agent",
      key: "custom-key",
      tags: ["tag1"],
      metadata: { version: 2 },
      ttlSeconds: 3600,
    });

    expect(item.source).toBe("agent");
    expect(item.key).toBe("custom-key");
    expect(item.tags).toEqual(["tag1"]);
    expect(item.metadata).toEqual({ version: 2 });
    expect(item.ttlSeconds).toBe(3600);
    expect(item.expiresAt).toBeDefined();
  });

  it("rejects durable writes that impersonate synthetic learned-fact memory", async () => {
    await expect(service.store("preference", "Captain Friday", {
      source: "learned_fact",
    })).rejects.toMatchObject({ code: "MEMORY_BOUNDARY_RESERVED" });

    await expect(service.store("preference", "Captain Friday", {
      key: "learned-fact:pref:name",
    })).rejects.toMatchObject({ code: "MEMORY_BOUNDARY_RESERVED" });

    await expect(service.store("preference", "Captain Friday", {
      tags: ["preference_fact"],
    })).rejects.toMatchObject({ code: "MEMORY_BOUNDARY_RESERVED" });

    await expect(service.store("preference", "Captain Friday", {
      metadata: {
        memoryBoundary: "separate_from_durable_memory",
      },
    })).rejects.toMatchObject({ code: "MEMORY_BOUNDARY_RESERVED" });
  });

  it("stores successfully even when embedding fails (graceful fallback)", async () => {
    const failService = createMockProviderService({ embedFails: true });
    const svc = createFridayMemoryService({
      db,
      providerService: failService,
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const item = await svc.store("ns", "Hello world");
    expect(item.id).toBeTruthy();
    expect(item.content).toBe("Hello world");

    // Verify item exists in DB
    const found = await svc.get(item.id);
    expect(found).not.toBeNull();
  });

  it("does not warn when storage falls back because no embedding route is configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const svc = createFridayMemoryService({
      db,
      providerService: createMockProviderService({
        embedFailureMessages: [
          'No enabled providers available for routing: defaultProviderId "route-a" is enabled but was not selected',
          'No enabled providers available for routing: defaultProviderId "route-b" is enabled but was not selected',
        ],
      }),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    await svc.store("ns", "first memory");
    await svc.store("ns", "second memory");

    expect(
      warnSpy.mock.calls.filter(([message]) =>
        String(message).includes("[friday][memory-service] embedding failed: No enabled providers available for routing"),
      ),
    ).toHaveLength(0);
  });

  // ─── Get / List / Delete ───

  it("gets a stored item by ID", async () => {
    const item = await service.store("ns", "content");
    const found = await service.get(item.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(item.id);
  });

  it("returns null for non-existent item", async () => {
    const found = await service.get("nonexistent");
    expect(found).toBeNull();
  });

  it("lists items with filters", async () => {
    await service.store("ns-a", "first item");
    await service.store("ns-b", "second item");

    const items = await service.list({ namespace: "ns-a" });
    expect(items).toHaveLength(1);
    expect(items[0].namespace).toBe("ns-a");
  });

  it("deletes an item", async () => {
    const item = await service.store("ns", "to delete");
    const deleted = await service.delete(item.id);
    expect(deleted).toBe(true);
    const found = await service.get(item.id);
    expect(found).toBeNull();
  });

  it("returns false when deleting non-existent item", async () => {
    const deleted = await service.delete("nonexistent");
    expect(deleted).toBe(false);
  });

  // ─── Search ───

  it("throws on empty search query", async () => {
    await expect(service.search("")).rejects.toThrow(FridayDomainError);
    await expect(service.search("  ")).rejects.toThrow(FridayDomainError);
  });

  it("searches with FTS", async () => {
    await service.store("ns", "The quick brown fox jumps over the lazy dog");
    await service.store("ns", "A completely different sentence about cats");

    const results = await service.search("fox jumps");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].item.content).toContain("fox");
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].matchedBy).toContain("fts");
  });

  it("search falls back to FTS-only when embedding fails", async () => {
    const failService = createMockProviderService({ embedFails: true });
    const svc = createFridayMemoryService({
      db,
      providerService: failService,
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    // Store items (embedding also fails, but store succeeds)
    await svc.store("ns", "The quick brown fox");
    await svc.store("ns", "A sentence about cats");

    // Search — semantic fails but FTS should work
    const results = await svc.search("fox");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].matchedBy).toContain("fts");
  });

  it("filters FTS results by memoryType", async () => {
    const failService = createMockProviderService({ embedFails: true });
    const svc = createFridayMemoryService({
      db,
      providerService: failService,
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    await svc.store("typed-ns", "alpha typed memory", { memoryType: "fact" });
    await svc.store("typed-ns", "alpha typed memory", { memoryType: "preference" });

    const results = await svc.search("alpha typed", {
      namespace: "typed-ns",
      memoryType: "preference",
    });

    expect(results).toHaveLength(1);
    expect(results[0].item.memoryType).toBe("preference");
  });

  it("filters semantic results by memoryType", async () => {
    await service.store("semantic-typed-ns", "The user prefers short summaries", {
      memoryType: "preference",
    });
    await service.store("semantic-typed-ns", "The API endpoint returns JSON", {
      memoryType: "fact",
    });

    // No lexical overlap with either memory; mock embeddings make semantic
    // retrieval deterministic and the repository-level memoryType filter must
    // exclude the fact row before scoring.
    const results = await service.search("compressed response style", {
      namespace: "semantic-typed-ns",
      memoryType: "preference",
    });

    expect(results).toHaveLength(1);
    expect(results[0].matchedBy).toContain("semantic");
    expect(results[0].item.memoryType).toBe("preference");
  });

  it("does not warn when search falls back to FTS because no embedding route is configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const svc = createFridayMemoryService({
      db,
      providerService: createMockProviderService({
        embedFailureMessages: [
          'No enabled providers available for routing: defaultProviderId "store-a" is enabled but was not selected',
          'No enabled providers available for routing: defaultProviderId "store-b" is enabled but was not selected',
          'No enabled providers available for routing: defaultProviderId "query-a" is enabled but was not selected',
          'No enabled providers available for routing: defaultProviderId "query-b" is enabled but was not selected',
        ],
      }),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    await svc.store("ns", "The quick brown fox");
    await svc.store("ns", "Another fox mention");
    const first = await svc.search("fox");
    const second = await svc.search("fox");

    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(second.length).toBeGreaterThanOrEqual(1);
    expect(
      warnSpy.mock.calls.filter(([message]) =>
        String(message).includes("[friday][memory-service] semantic search unavailable: No enabled providers available for routing"),
      ),
    ).toHaveLength(0);
  });

  // ─── Prune ───

  it("prunes expired items", async () => {
    const past = "2025-01-01T00:00:00.000Z";
    await service.store("ns", "expired item", { expiresAt: past });
    await service.store("ns", "valid item");

    const result = await service.prune({ expiredOnly: true });
    expect(result.deletedCount).toBe(1);
    expect(result.dryRun).toBe(false);
  });

  it("supports dry run for prune", async () => {
    const past = "2025-01-01T00:00:00.000Z";
    await service.store("ns", "expired item", { expiresAt: past });

    const result = await service.prune({ expiredOnly: true, dryRun: true });
    expect(result.deletedCount).toBe(1);
    expect(result.dryRun).toBe(true);

    // Item should still exist
    const items = await service.list({ includeExpired: true });
    expect(items).toHaveLength(1);
  });

  it("defaults namespace-scoped prune to expired items only", async () => {
    const past = "2025-01-01T00:00:00.000Z";
    await service.store("ns-a", "expired item", { expiresAt: past });
    await service.store("ns-a", "valid item");
    await service.store("ns-b", "other namespace expired item", { expiresAt: past });

    const result = await service.prune({ namespace: "ns-a" });
    expect(result.deletedCount).toBe(1);

    const nsAItems = await service.list({ namespace: "ns-a", includeExpired: true });
    expect(nsAItems).toHaveLength(1);
    expect(nsAItems[0]?.content).toBe("valid item");

    const nsBItems = await service.list({ namespace: "ns-b", includeExpired: true });
    expect(nsBItems).toHaveLength(1);
    expect(nsBItems[0]?.content).toBe("other namespace expired item");
  });

  // ─── A3: Memory Hybrid Search (service-level) ───

  describe("hybrid search filtering", () => {
    it("semantic hits respect tagsAll filtering", async () => {
      // Store two items in same namespace with different tag sets
      await service.store("search-ns", "neural network training guide", {
        tags: ["ml", "guide"],
      });
      await service.store("search-ns", "neural network inference optimisation", {
        tags: ["ml", "performance"],
      });

      // Use a query that shares NO words with the stored content so FTS returns nothing.
      // The mock embedding always returns the same vector, so semantic search finds both.
      // The tagsAll post-filter on semantic hits should keep only the item with both tags.
      const results = await service.search("deep learning tutorial", {
        namespace: "search-ns",
        tagsAll: ["ml", "guide"],
      });

      // Only the item with both tags should appear (semantic path, post-filtered)
      expect(results.length).toBe(1);
      expect(results[0].item.tags).toContain("ml");
      expect(results[0].item.tags).toContain("guide");
      expect(results[0].item.content).toContain("training guide");
    });

    it("semantic-only result metadata has matchedBy and snippet", async () => {
      // Store an item; use a query that shares NO words so FTS misses completely.
      // The mock embedding always returns the same vector, so semantic search will find it.
      await service.store("meta-ns", "The weather today is sunny and warm");

      // "blazing temperature forecast" shares no tokens with the stored content,
      // so FTS returns nothing. Semantic search (same mock vector) finds it.
      const results = await service.search("blazing temperature forecast", {
        namespace: "meta-ns",
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      const hit = results[0];
      // Must be matched by semantic (not FTS, since no words overlap)
      expect(hit.matchedBy).toContain("semantic");
      expect(hit.matchedBy).not.toContain("fts");
      // Snippet should be populated (either from FTS highlight or content slice)
      expect(hit.snippet).toBeTruthy();
      expect(typeof hit.snippet).toBe("string");
      expect(hit.snippet!.length).toBeGreaterThan(0);
      // Semantic score should be non-zero
      expect(hit.semanticScore).toBeGreaterThan(0);
      expect(hit.score).toBeGreaterThan(0);
    });

    it("namespace substring fallback activates when FTS+semantic are empty", async () => {
      // Use a service where embeddings fail so semantic search returns nothing
      const failService = createMockProviderService({ embedFails: true });
      const svc = createFridayMemoryService({
        db,
        providerService: failService,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      // Store item with content. We'll query a partial substring that FTS won't
      // tokenize as a match (FTS5 uses whole-word tokenisation). The content has
      // "configuration" but we'll search for the partial "configur" which FTS
      // won't match as a prefix unless using the prefix option.
      await svc.store("fallback-ns", "server configuration details here");

      // The substring "figurat" won't match FTS whole-word "configuration"
      // but the substring fallback will find it by scanning content.
      const results = await svc.search("figurat", {
        namespace: "fallback-ns",
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].item.content).toContain("configuration");
      expect(results[0].score).toBeCloseTo(0.1);
    });

    it("namespace substring backfill returns sibling facts when FTS only matches one conflict token", async () => {
      const failService = createMockProviderService({ embedFails: true });
      const svc = createFridayMemoryService({
        db,
        providerService: failService,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      await svc.store("conflict-ns", "The user's workshop accent color is teal");
      await svc.store("conflict-ns", "The user's workshop accent color is navy");

      const results = await svc.search("workshop accent color teal", {
        namespace: "conflict-ns",
        limit: 5,
      });

      const contents = results.map((result) => result.item.content).join("\n");
      expect(contents).toContain("teal");
      expect(contents).toContain("navy");
      expect(results.map((result) => result.item.id)).toEqual(
        Array.from(new Set(results.map((result) => result.item.id))),
      );
    });

    it("namespace substring fallback honors memoryType filtering", async () => {
      const failService = createMockProviderService({ embedFails: true });
      const svc = createFridayMemoryService({
        db,
        providerService: failService,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      await svc.store("fallback-type-ns", "server configuration details here", {
        memoryType: "fact",
      });
      await svc.store("fallback-type-ns", "server configuration preference note", {
        memoryType: "preference",
      });

      const results = await svc.search("figurat", {
        namespace: "fallback-type-ns",
        memoryType: "preference",
      });

      expect(results).toHaveLength(1);
      expect(results[0].item.memoryType).toBe("preference");
      expect(results[0].item.content).toContain("preference note");
    });

    it("substring fallback honors minScore cutoff", async () => {
      const failService = createMockProviderService({ embedFails: true });
      const svc = createFridayMemoryService({
        db,
        providerService: failService,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      await svc.store("cutoff-ns", "server configuration details here");

      // With minScore > 0.1, substring fallback results (score=0.1) should be excluded
      const results = await svc.search("figurat", {
        namespace: "cutoff-ns",
        minScore: 0.2,
      });

      expect(results).toHaveLength(0);
    });
  });

  // ─── B3 access-counter (conservative semantics) ───

  describe("B3 access-counter: search increments, get/list do NOT", () => {
    it("search() increments access_count + sets last_accessed_at only for items in the returned result set", async () => {
      const recorded = await service.store("access-ns", "The quick brown fox jumps");
      // Unrelated item lives in a DIFFERENT namespace so namespace-scoped search
      // excludes it deterministically (independent of mock embedding noise).
      const unrelated = await service.store("other-ns", "Unrelated content");
      expect(recorded.accessCount === 0 || recorded.accessCount === undefined).toBe(true);

      const results = await service.search("fox jumps", { namespace: "access-ns" });
      const returnedIds = new Set(results.map((r) => r.item.id));
      expect(returnedIds.has(recorded.id)).toBe(true);
      expect(returnedIds.has(unrelated.id)).toBe(false);

      const fetchedReturned = await service.get(recorded.id);
      const fetchedUnrelated = await service.get(unrelated.id);

      expect(fetchedReturned!.accessCount).toBe(1);
      expect(fetchedReturned!.lastAccessedAt).toBeDefined();
      // unrelated item was in a different namespace → not in result set →
      // counter must stay 0/undef.
      expect(fetchedUnrelated!.accessCount === 0 || fetchedUnrelated!.accessCount === undefined).toBe(true);
      expect(fetchedUnrelated!.lastAccessedAt).toBeUndefined();
    });

    it("get() does NOT increment access_count (raw repository read)", async () => {
      const stored = await service.store("raw-ns", "Raw read test");

      // Multiple raw gets must not change the counter.
      await service.get(stored.id);
      await service.get(stored.id);
      await service.get(stored.id);

      const final = await service.get(stored.id);
      // accessCount stays at the inserted value (0 / undefined).
      expect(final!.accessCount === 0 || final!.accessCount === undefined).toBe(true);
      expect(final!.lastAccessedAt).toBeUndefined();
    });

    it("repeated search hits accumulate the counter monotonically", async () => {
      const stored = await service.store("monotonic-ns", "monotonic alpha beta gamma");

      await service.search("monotonic", { namespace: "monotonic-ns" });
      await service.search("monotonic", { namespace: "monotonic-ns" });
      await service.search("monotonic", { namespace: "monotonic-ns" });

      const final = await service.get(stored.id);
      expect(final!.accessCount).toBe(3);
      expect(final!.lastAccessedAt).toBeDefined();
    });
  });
});
