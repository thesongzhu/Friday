import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";
import { createFridayMemoryService } from "#memory";
import type { FridayMemoryService } from "#memory";
import type { FridayProviderService } from "#providers";

function createMockProviderService(): FridayProviderService {
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
          createdAt: "2026-02-18T10:00:00.000Z",
          updatedAt: "2026-02-18T10:00:00.000Z",
        },
        model: "text-embedding-3-small",
      };
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

describe("FridayMemoryService Pipeline (Integration)", () => {
  let db: FridaySqliteLayer;
  let service: FridayMemoryService;
  const NOW = "2026-02-18T10:00:00.000Z";
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = createTestDb();

    // Mock fetch for embedding API calls
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

    service = createFridayMemoryService({
      db,
      providerService: createMockProviderService(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── Store ───

  describe("store", () => {
    it("stores a memory item and returns it", async () => {
      const item = await service.store("test-ns", "Hello world");

      expect(item.id).toBeTruthy();
      expect(item.namespace).toBe("test-ns");
      expect(item.content).toBe("Hello world");
      expect(item.source).toBe("system");
    });

    it("stores with custom metadata", async () => {
      const item = await service.store("ns", "Some content", {
        source: "agent",
        key: "my-key",
        tags: ["tag1", "tag2"],
      });

      expect(item.source).toBe("agent");
      expect(item.key).toBe("my-key");
      expect(item.tags).toEqual(["tag1", "tag2"]);
    });
  });

  // ─── Retrieve by ID ───

  describe("get by ID", () => {
    it("retrieves a stored item", async () => {
      const stored = await service.store("ns", "Retrieve me");
      const found = await service.get(stored.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(stored.id);
      expect(found!.content).toBe("Retrieve me");
    });

    it("returns null for non-existent ID", async () => {
      const found = await service.get("nonexistent-id");
      expect(found).toBeNull();
    });
  });

  // ─── List ───

  describe("list", () => {
    it("lists items filtered by namespace", async () => {
      await service.store("ns-a", "item A");
      await service.store("ns-b", "item B");

      const items = await service.list({ namespace: "ns-a" });
      expect(items).toHaveLength(1);
      expect(items[0].namespace).toBe("ns-a");
    });

    it("lists multiple items", async () => {
      await service.store("ns", "item 1");
      await service.store("ns", "item 2");
      await service.store("ns", "item 3");

      const items = await service.list({ namespace: "ns" });
      expect(items).toHaveLength(3);
    });
  });

  // ─── Delete ───

  describe("delete", () => {
    it("deletes a stored item", async () => {
      const item = await service.store("ns", "to delete");
      const deleted = await service.delete(item.id);
      expect(deleted).toBe(true);

      const found = await service.get(item.id);
      expect(found).toBeNull();
    });

    it("returns false for non-existent item", async () => {
      const deleted = await service.delete("nonexistent");
      expect(deleted).toBe(false);
    });
  });

  // ─── TTL / Expiry ───

  describe("TTL expiry behavior", () => {
    it("stores item with expiresAt", async () => {
      const futureDate = "2027-01-01T00:00:00.000Z";
      const item = await service.store("ns", "expiring", { expiresAt: futureDate });

      expect(item.expiresAt).toBe(futureDate);
    });

    it("expired items are excluded by default in list", async () => {
      const pastDate = "2025-01-01T00:00:00.000Z";
      await service.store("ns", "expired", { expiresAt: pastDate });
      await service.store("ns", "valid");

      const items = await service.list({ namespace: "ns" });
      expect(items).toHaveLength(1);
      expect(items[0].content).toBe("valid");
    });

    it("expired items are included when includeExpired is true", async () => {
      const pastDate = "2025-01-01T00:00:00.000Z";
      await service.store("ns", "expired", { expiresAt: pastDate });
      await service.store("ns", "valid");

      const items = await service.list({ namespace: "ns", includeExpired: true });
      expect(items).toHaveLength(2);
    });
  });

  // ─── Prune ───

  describe("prune", () => {
    it("prunes expired items", async () => {
      const pastDate = "2025-01-01T00:00:00.000Z";
      await service.store("ns", "expired item", { expiresAt: pastDate });
      await service.store("ns", "valid item");

      const result = await service.prune({ expiredOnly: true });
      expect(result.deletedCount).toBe(1);
      expect(result.dryRun).toBe(false);

      // Only valid item remains
      const items = await service.list({ namespace: "ns" });
      expect(items).toHaveLength(1);
      expect(items[0].content).toBe("valid item");
    });

    it("supports dry run", async () => {
      const pastDate = "2025-01-01T00:00:00.000Z";
      await service.store("ns", "expired", { expiresAt: pastDate });

      const result = await service.prune({ expiredOnly: true, dryRun: true });
      expect(result.deletedCount).toBe(1);
      expect(result.dryRun).toBe(true);

      // Item should still exist
      const items = await service.list({ namespace: "ns", includeExpired: true });
      expect(items).toHaveLength(1);
    });
  });
});
