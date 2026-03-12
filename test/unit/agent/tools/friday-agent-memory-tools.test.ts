import { describe, it, expect, vi } from "vitest";
import { createFridayAgentMemoryTools } from "#agent";
import type { FridayMemoryService } from "#memory";
import type { FridayMemoryItem, FridayMemorySearchResult } from "#memory";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function makeItem(overrides?: Partial<FridayMemoryItem>): FridayMemoryItem {
  return {
    id: "item-1",
    namespace: "agent",
    key: "key-1",
    content: "The weather in Seattle is rainy",
    source: "agent",
    tags: ["weather"],
    metadata: {},
    createdAt: "2026-02-19T00:00:00.000Z",
    updatedAt: "2026-02-19T00:00:00.000Z",
    ...overrides,
  };
}

function makeSearchResult(
  overrides?: Partial<FridayMemorySearchResult>,
): FridayMemorySearchResult {
  return {
    item: makeItem(),
    score: 0.95,
    ftsScore: 0.9,
    semanticScore: 0.85,
    matchedBy: ["fts"],
    snippet: "The weather in Seattle...",
    ...overrides,
  };
}

function mockMemoryService(
  searchResults?: FridayMemorySearchResult[],
  storeItem?: FridayMemoryItem,
  searchError?: Error,
  storeError?: Error,
): FridayMemoryService {
  return {
    search: searchError
      ? vi.fn().mockRejectedValue(searchError)
      : vi.fn().mockResolvedValue(searchResults ?? [makeSearchResult()]),
    store: storeError
      ? vi.fn().mockRejectedValue(storeError)
      : vi.fn().mockResolvedValue(storeItem ?? makeItem()),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(false),
    prune: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [], dryRun: false }),
  };
}

describe("FridayAgentMemoryTools", () => {
  // ─── Creates both tools ───

  it("creates memory_search and memory_store tools", () => {
    const svc = mockMemoryService();
    const tools = createFridayAgentMemoryTools({ memoryService: svc });

    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("memory_search");
    expect(tools[1]!.name).toBe("memory_store");
  });

  // ─── memory_search ───

  describe("memory_search", () => {
    it("has correct parameters", () => {
      const svc = mockMemoryService();
      const [searchTool] = createFridayAgentMemoryTools({ memoryService: svc });

      expect(searchTool!.name).toBe("memory_search");
      expect(searchTool!.description).toBeTruthy();
      expect(searchTool!.parameters).toBeDefined();
    });

    it("returns search results with content and score", async () => {
      const svc = mockMemoryService();
      const [searchTool] = createFridayAgentMemoryTools({ memoryService: svc });

      const result = await searchTool!.execute(
        { query: "seattle weather" },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content) as Array<Record<string, unknown>>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        content: "The weather in Seattle is rainy",
        score: 0.95,
        metadata: {
          id: "item-1",
          namespace: "agent",
          tags: ["weather"],
        },
      });
    });

    it("passes namespace and limit to search", async () => {
      const svc = mockMemoryService();
      const [searchTool] = createFridayAgentMemoryTools({ memoryService: svc });

      await searchTool!.execute(
        { query: "test", namespace: "custom", limit: 5 },
        signal(),
      );

      expect(svc.search).toHaveBeenCalledWith("test", {
        namespace: "custom",
        limit: 5,
      });
    });

    it("defaults limit to 10", async () => {
      const svc = mockMemoryService();
      const [searchTool] = createFridayAgentMemoryTools({ memoryService: svc });

      await searchTool!.execute({ query: "test" }, signal());

      expect(svc.search).toHaveBeenCalledWith("test", {
        namespace: undefined,
        limit: 10,
      });
    });

    it("returns error on search failure", async () => {
      const svc = mockMemoryService(
        undefined,
        undefined,
        new Error("embedding service unavailable"),
      );
      const [searchTool] = createFridayAgentMemoryTools({ memoryService: svc });

      const result = await searchTool!.execute(
        { query: "test" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Memory search failed");
      expect(result.content).toContain("embedding service unavailable");
    });

    it("returns empty array for no matches", async () => {
      const svc = mockMemoryService([]);
      const [searchTool] = createFridayAgentMemoryTools({ memoryService: svc });

      const result = await searchTool!.execute(
        { query: "nonexistent" },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual([]);
    });

    it("throws on missing query", async () => {
      const svc = mockMemoryService();
      const [searchTool] = createFridayAgentMemoryTools({ memoryService: svc });

      await expect(
        searchTool!.execute({ query: "" }, signal()),
      ).rejects.toThrow("query is required");
    });
  });

  // ─── memory_store ───

  describe("memory_store", () => {
    it("has correct parameters", () => {
      const svc = mockMemoryService();
      const tools = createFridayAgentMemoryTools({ memoryService: svc });
      const storeTool = tools[1]!;

      expect(storeTool.name).toBe("memory_store");
      expect(storeTool.description).toBeTruthy();
      expect(storeTool.parameters).toBeDefined();
    });

    it("stores content and returns itemId", async () => {
      const svc = mockMemoryService();
      const tools = createFridayAgentMemoryTools({ memoryService: svc });
      const storeTool = tools[1]!;

      const result = await storeTool.execute(
        { content: "Important fact" },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        itemId: "item-1",
        stored: true,
      });
    });

    it("passes namespace, tags, and expiresAt to store", async () => {
      const svc = mockMemoryService();
      const tools = createFridayAgentMemoryTools({ memoryService: svc });
      const storeTool = tools[1]!;

      await storeTool.execute(
        {
          content: "data",
          namespace: "custom-ns",
          tags: ["tag1", "tag2"],
          expiresAt: "2026-12-31T00:00:00.000Z",
        },
        signal(),
      );

      expect(svc.store).toHaveBeenCalledWith("custom-ns", "data", {
        source: "agent",
        tags: ["tag1", "tag2"],
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    });

    it("defaults namespace to 'agent'", async () => {
      const svc = mockMemoryService();
      const tools = createFridayAgentMemoryTools({ memoryService: svc });
      const storeTool = tools[1]!;

      await storeTool.execute({ content: "data" }, signal());

      expect(svc.store).toHaveBeenCalledWith("agent", "data", {
        source: "agent",
        tags: [],
        expiresAt: undefined,
      });
    });

    it("filters non-string tags", async () => {
      const svc = mockMemoryService();
      const tools = createFridayAgentMemoryTools({ memoryService: svc });
      const storeTool = tools[1]!;

      await storeTool.execute(
        { content: "data", tags: ["valid", 42, null, "also-valid"] },
        signal(),
      );

      expect(svc.store).toHaveBeenCalledWith(
        "agent",
        "data",
        expect.objectContaining({
          tags: ["valid", "also-valid"],
        }),
      );
    });

    it("returns error on store failure", async () => {
      const svc = mockMemoryService(
        undefined,
        undefined,
        undefined,
        new Error("database full"),
      );
      const tools = createFridayAgentMemoryTools({ memoryService: svc });
      const storeTool = tools[1]!;

      const result = await storeTool.execute(
        { content: "data" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Memory store failed");
      expect(result.content).toContain("database full");
    });

    it("throws on missing content", async () => {
      const svc = mockMemoryService();
      const tools = createFridayAgentMemoryTools({ memoryService: svc });
      const storeTool = tools[1]!;

      await expect(
        storeTool.execute({ content: "" }, signal()),
      ).rejects.toThrow("content is required");
    });
  });

  describe("session-scoped namespace", () => {
    it("scopes namespace with deps.sessionId when provided", async () => {
      const svc = mockMemoryService();
      const [searchTool, storeTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        sessionId: "session-A",
      });

      await storeTool!.execute({ content: "hello", namespace: "agent" }, signal());
      await searchTool!.execute({ query: "hello", namespace: "agent" }, signal());

      expect(svc.store).toHaveBeenCalledWith("agent:session-A", "hello", expect.any(Object));
      expect(svc.search).toHaveBeenCalledWith("hello", {
        namespace: "agent:session-A",
        limit: 10,
      });
    });

    it("prefers runtime-injected __sessionId over deps.sessionId", async () => {
      const svc = mockMemoryService();
      const [searchTool, storeTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        sessionId: "session-default",
      });

      await storeTool!.execute(
        { content: "hello", namespace: "agent", __sessionId: "session-from-runtime" },
        signal(),
      );
      await searchTool!.execute(
        { query: "hello", namespace: "agent", __sessionId: "session-from-runtime" },
        signal(),
      );

      expect(svc.store).toHaveBeenCalledWith("agent:session-from-runtime", "hello", expect.any(Object));
      expect(svc.search).toHaveBeenCalledWith("hello", {
        namespace: "agent:session-from-runtime",
        limit: 10,
      });
    });
  });
});
