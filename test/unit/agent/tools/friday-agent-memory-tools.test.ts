import { describe, it, expect, vi } from "vitest";
import { createFridayAgentMemoryTools } from "#agent";
import type { FridayMemoryGuardServiceFactory, FridayMemoryService } from "#memory";
import type { FridayMemoryItem, FridayMemorySearchResult } from "#memory";
import type { FridayProviderTenantContext } from "#providers";
import { attachFridayAgentToolExecutionContext } from "../../../../src/agent/runtime/friday-agent-tool-execution-context.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function signalWithPrincipal(principalId: string): AbortSignal {
  return signalWithContext({ principalId });
}

function signalWithContext(input: {
  principalId?: string;
  taskPrompt?: string;
  sessionKey?: string;
  tenantContext?: FridayProviderTenantContext;
}): AbortSignal {
  return attachFridayAgentToolExecutionContext(new AbortController().signal, {
    runId: "run-1",
    sessionKey: input.sessionKey ?? "agent:run:run-1",
    readOnly: false,
    principalId: input.principalId,
    taskPrompt: input.taskPrompt,
    tenantContext: input.tenantContext,
  });
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

function mockMemoryGuardFactory(memoryService: FridayMemoryService): FridayMemoryGuardServiceFactory {
  return {
    forPrincipal: vi.fn().mockReturnValue(memoryService),
    forContext: vi.fn().mockReturnValue(memoryService),
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
        namespace: "agent.custom",
        limit: 5,
      });
    });

    it("defaults limit to 10", async () => {
      const svc = mockMemoryService();
      const [searchTool] = createFridayAgentMemoryTools({ memoryService: svc });

      await searchTool!.execute({ query: "test" }, signal());

      expect(svc.search).toHaveBeenCalledWith("test", {
        namespace: "agent",
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

    it("does not return current-session fallback memories when the query has zero lexical overlap", async () => {
      const sessionKey = "channel:feishu:chat";
      const sessionNamespace = "tenant.default.channel.feishu.user.chat.shared";
      const unrelatedSessionMemory = makeItem({
        id: "approval-memory",
        namespace: sessionNamespace,
        content: "涉及敏感操作时，用户可通过审批卡片操作或回复“批准 <编号>”/“拒绝 <编号>”。",
        source: `session:${sessionKey}`,
        tags: [`session:${sessionKey}`, "approval"],
      });
      const svc = mockMemoryService([]);
      vi.mocked(svc.list).mockResolvedValue([unrelatedSessionMemory]);
      const [searchTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        resolveSessionMemoryNamespace: async () => sessionNamespace,
      });

      const result = await searchTool!.execute(
        { query: "codename", namespace: "user", limit: 1 },
        signalWithContext({ sessionKey }),
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual([]);
    });

    it("includes learned facts for the current principal when search finds none", async () => {
      const svc = mockMemoryService([]);
      const [searchTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        listLearnedFacts: () => [{
          key: "pref:display_name",
          value: "Captain Friday",
          confidence: 0.8,
          evidenceCount: 1,
          lastConfirmedAt: "2026-02-19T00:00:00.000Z",
        }],
      });

      const result = await searchTool!.execute(
        { query: "what should you call me" },
        signalWithPrincipal("user-1"),
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toMatchObject([
        {
          content: "Captain Friday",
          metadata: {
            id: "learned-fact:pref:display_name",
            source: "learned_fact",
            trustLevel: "confidence_scored_learning",
            memoryBoundary: "separate_from_durable_memory",
            evidenceBoundary: "preference_fact_evidence",
            contextUseBoundary: "learning_context_service_gated",
            promptInjectionBoundary: "not_direct_prompt_injection",
            reviewBoundary: "not_review_center_confirmed",
            revocationBoundary: "clear_delete_or_synthetic_memory_delete",
          },
        },
      ]);
    });

    it("normalizes user preference namespace aliases before searching", async () => {
      const svc = mockMemoryService([]);
      const [searchTool] = createFridayAgentMemoryTools({ memoryService: svc });

      await searchTool!.execute(
        { query: "preferred name", namespace: "user-preferences", limit: 5 },
        signal(),
      );

      expect(svc.search).toHaveBeenCalledWith("preferred name", {
        namespace: "agent.preference",
        limit: 5,
      });
    });

    it("never searches without a namespace", async () => {
      const svc = mockMemoryService([]);
      const [searchTool] = createFridayAgentMemoryTools({ memoryService: svc });

      await searchTool!.execute({ query: "anything" }, signal());

      const [, options] = vi.mocked(svc.search).mock.calls[0]!;
      expect(options?.namespace).toBeDefined();
    });

    it("rejects reserved namespaces instead of searching them", async () => {
      const svc = mockMemoryService([]);
      const [searchTool] = createFridayAgentMemoryTools({ memoryService: svc });

      const result = await searchTool!.execute(
        { query: "secret", namespace: "tenant.default.user.other" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("reserved");
      expect(svc.search).not.toHaveBeenCalled();
    });

    it("includes current-principal guarded API memory on default searches", async () => {
      const svc = mockMemoryService([]);
      const guardedSvc = mockMemoryService([
        makeSearchResult({
          item: makeItem({
            id: "api-memory-1",
            namespace: "tenant.admin-001.user.admin-001.five-scenario-proof",
            content: "The proof run project codename is BARB-phase-22d.",
            source: "five-scenario-real-proof",
            tags: ["five-scenario", "preference"],
          }),
          score: 0.91,
        }),
      ]);
      const memoryGuardFactory = mockMemoryGuardFactory(guardedSvc);
      const [searchTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        memoryGuardFactory,
      });

      const result = await searchTool!.execute(
        { query: "proof run project codename", limit: 3 },
        signalWithContext({
          principalId: "admin-001",
          tenantContext: { hubId: "admin-001", userId: "admin-001" },
        }),
      );

      expect(result.isError).toBeUndefined();
      expect(memoryGuardFactory.forContext).toHaveBeenCalledWith({
        principalId: "admin-001",
        subject: {
          hubId: "admin-001",
          userId: "admin-001",
          accessLevel: "tenant",
        },
      });
      expect(guardedSvc.search).toHaveBeenCalledWith("proof run project codename", {
        limit: 6,
      });
      expect(JSON.parse(result.content)).toMatchObject([
        {
          content: "The proof run project codename is BARB-phase-22d.",
          metadata: {
            id: "api-memory-1",
            namespace: "tenant.admin-001.user.admin-001.five-scenario-proof",
          },
        },
      ]);
    });

    it("does not search guarded API memory for explicit agent namespace", async () => {
      const svc = mockMemoryService([]);
      const guardedSvc = mockMemoryService([makeSearchResult()]);
      const memoryGuardFactory = mockMemoryGuardFactory(guardedSvc);
      const [searchTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        memoryGuardFactory,
      });

      await searchTool!.execute(
        { query: "proof run project codename", namespace: "agent", limit: 3 },
        signalWithContext({
          principalId: "admin-001",
          tenantContext: { hubId: "admin-001", userId: "admin-001" },
        }),
      );

      expect(memoryGuardFactory.forContext).not.toHaveBeenCalled();
      expect(guardedSvc.search).not.toHaveBeenCalled();
    });

    it("matches learned facts through token overlap when the model phrases the query differently", async () => {
      const svc = mockMemoryService([]);
      const [searchTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        listLearnedFacts: () => [{
          key: "pref:name",
          value: "Captain Friday",
          confidence: 0.8,
          evidenceCount: 1,
          lastConfirmedAt: "2026-02-19T00:00:00.000Z",
        }],
      });

      const result = await searchTool!.execute(
        { query: "What should I call you?", namespace: "agent" },
        signalWithPrincipal("user-1"),
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toMatchObject([
        {
          content: "Captain Friday",
          metadata: {
            id: "learned-fact:pref:name",
            source: "learned_fact",
          },
        },
      ]);
    });

    it("matches learned display-name facts for Chinese name-recall questions", async () => {
      const svc = mockMemoryService([]);
      const [searchTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        listLearnedFacts: () => [{
          key: "pref:user_name",
          value: "测试名",
          confidence: 1,
          evidenceCount: 1,
          lastConfirmedAt: "2026-02-19T00:00:00.000Z",
        }],
      });

      const result = await searchTool!.execute(
        { query: "我叫什么名字", namespace: "user", limit: 1 },
        signalWithPrincipal("user-1"),
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toMatchObject([
        {
          content: "测试名",
          metadata: {
            id: "learned-fact:pref:user_name",
            source: "learned_fact",
          },
        },
      ]);
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
      const tools = createFridayAgentMemoryTools({
        memoryService: svc,
        nowIso: () => "2026-02-19T00:00:00.000Z",
      });
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

      expect(svc.store).toHaveBeenCalledWith("agent.custom-ns", "data", {
        source: "agent",
        tags: ["tag1", "tag2"],
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    });

    it("ignores past expiresAt values so memory is not stored already expired", async () => {
      const svc = mockMemoryService();
      const tools = createFridayAgentMemoryTools({
        memoryService: svc,
        nowIso: () => "2026-04-19T18:09:43.000Z",
      });
      const storeTool = tools[1]!;

      await storeTool.execute(
        {
          content: "data",
          expiresAt: "2023-11-23T04:44:20.000Z",
        },
        signal(),
      );

      expect(svc.store).toHaveBeenCalledWith("agent", "data", {
        source: "agent",
        tags: [],
        expiresAt: undefined,
      });
    });

    it("preserves explicit far-future expiresAt strings instead of normalizing them past year 9999", async () => {
      const svc = mockMemoryService();
      const tools = createFridayAgentMemoryTools({
        memoryService: svc,
        nowIso: () => "2026-04-19T18:09:43.000Z",
      });
      const storeTool = tools[1]!;

      await storeTool.execute(
        {
          content: "data",
          expiresAt: "9999-12-31T23:59:59",
        },
        signal(),
      );

      expect(svc.store).toHaveBeenCalledWith("agent", "data", {
        source: "agent",
        tags: [],
        expiresAt: "9999-12-31T23:59:59",
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

    it("rejects reserved namespaces instead of storing to them", async () => {
      const svc = mockMemoryService();
      const tools = createFridayAgentMemoryTools({ memoryService: svc });
      const storeTool = tools[1]!;

      const result = await storeTool.execute(
        { content: "secret", namespace: "system.config" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("reserved");
      expect(svc.store).not.toHaveBeenCalled();
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

    it("mirrors name preferences from memory_store into learning events when the model stores them directly", async () => {
      const svc = mockMemoryService();
      const learningEventWriter = vi.fn();
      const tools = createFridayAgentMemoryTools({
        memoryService: svc,
        learningEventWriter,
        idGenerator: () => "event-1",
        nowIso: () => "2026-02-19T10:00:00.000Z",
      });
      const storeTool = tools[1]!;

      await storeTool.execute(
        {
          content: '用户希望被称为 "Captain Friday"',
          tags: ["user_preference", "name"],
        },
        signalWithContext({
          principalId: "user-1",
          taskPrompt: "Call me Captain Friday.",
        }),
      );

      expect(learningEventWriter).toHaveBeenCalledWith([
        expect.objectContaining({
          eventId: "event-1",
          userId: "user-1",
          runId: "run-1",
          kind: "user_correction",
          payload: expect.objectContaining({
            correctedField: "user_name",
            newValue: "Captain Friday",
            value: "Captain Friday",
          }),
        }),
      ]);
    });

    it("mirrors Chinese name preferences from memory_store into learning events", async () => {
      const svc = mockMemoryService();
      const learningEventWriter = vi.fn();
      const tools = createFridayAgentMemoryTools({
        memoryService: svc,
        learningEventWriter,
        idGenerator: () => "event-zh-1",
        nowIso: () => "2026-02-19T10:00:00.000Z",
      });
      const storeTool = tools[1]!;

      await storeTool.execute(
        {
          content: "用户希望被称为 测试名",
          tags: ["user_preference", "name"],
        },
        signalWithContext({
          principalId: "user-1",
          taskPrompt: "我的名字是 测试名，以后叫我 测试名。",
        }),
      );

      expect(learningEventWriter).toHaveBeenCalledWith([
        expect.objectContaining({
          eventId: "event-zh-1",
          userId: "user-1",
          runId: "run-1",
          kind: "user_correction",
          payload: expect.objectContaining({
            correctedField: "user_name",
            newValue: "测试名",
            value: "测试名",
          }),
        }),
      ]);
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
    it("scopes the implicit default store namespace with deps.sessionId when provided", async () => {
      const svc = mockMemoryService();
      const [searchTool, storeTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        sessionId: "session-A",
      });

      await storeTool!.execute({ content: "hello" }, signal());
      await searchTool!.execute({ query: "hello" }, signal());

      expect(svc.store).toHaveBeenCalledWith("agent:session-A", "hello", expect.any(Object));
      expect(svc.search).toHaveBeenCalledWith("hello", {
        namespace: "agent:session-A",
        limit: 10,
      });
    });

    it("scopes explicit agent namespace to the current session key", async () => {
      const svc = mockMemoryService();
      const [searchTool, storeTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        sessionId: "session-A",
      });

      await storeTool!.execute(
        { content: "hello", namespace: "agent" },
        signal(),
      );
      await searchTool!.execute(
        { query: "hello", namespace: "agent" },
        signal(),
      );

      expect(svc.store).toHaveBeenCalledWith("agent:session-A", "hello", expect.any(Object));
      expect(svc.search).toHaveBeenCalledWith("hello", {
        namespace: "agent:session-A",
        limit: 10,
      });
    });

    it("prefers runtime-injected __sessionId over deps.sessionId for implicit defaults", async () => {
      const svc = mockMemoryService();
      const [searchTool, storeTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        sessionId: "session-default",
      });

      await storeTool!.execute(
        { content: "hello", __sessionId: "session-from-runtime" },
        signal(),
      );
      await searchTool!.execute(
        { query: "hello", __sessionId: "session-from-runtime" },
        signal(),
      );

      expect(svc.store).toHaveBeenCalledWith("agent:session-from-runtime", "hello", expect.any(Object));
      expect(svc.search).toHaveBeenCalledWith("hello", {
        namespace: "agent:session-from-runtime",
        limit: 10,
      });
    });

    it("prefers attached execution context over internal session args", async () => {
      const svc = mockMemoryService();
      const [searchTool] = createFridayAgentMemoryTools({
        memoryService: svc,
      });

      await searchTool!.execute(
        { query: "hello", __sessionId: "attacker-session" },
        signalWithContext({ sessionKey: "trusted-session" }),
      );

      expect(svc.search).toHaveBeenCalledWith("hello", {
        namespace: "agent:trusted-session",
        limit: 10,
      });
    });

    it("prefers attached execution context over internal principal args", async () => {
      const svc = mockMemoryService([]);
      const observedUserIds: string[] = [];
      const [searchTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        listLearnedFacts: (input) => {
          observedUserIds.push(input.userId);
          return [{
            key: "pref:name",
            value: "Trusted User",
            confidence: 0.8,
            evidenceCount: 1,
            lastConfirmedAt: "2026-02-19T00:00:00.000Z",
          }];
        },
      });

      await searchTool!.execute(
        { query: "name", __principalId: "attacker-user" },
        signalWithContext({ principalId: "trusted-user" }),
      );

      expect(observedUserIds).toEqual(["trusted-user"]);
    });

    it("stores user-facing aliases in the resolved session namespace", async () => {
      const svc = mockMemoryService();
      const [, storeTool] = createFridayAgentMemoryTools({
        memoryService: svc,
        resolveSessionMemoryNamespace: async () => "tenant.default.channel.webchat.user.user-1.shared",
      });

      const result = await storeTool!.execute(
        {
          content: "My preferred editor is Vim",
          namespace: "preference",
        },
        signalWithContext({
          principalId: "user-1",
          sessionKey: "webchat:default:chat-1",
          taskPrompt: "I prefer Vim.",
        }),
      );

      expect(result.isError).toBeUndefined();
      expect(svc.store).toHaveBeenCalledWith(
        "tenant.default.channel.webchat.user.user-1.shared",
        "My preferred editor is Vim",
        expect.any(Object),
      );
    });
  });
});
