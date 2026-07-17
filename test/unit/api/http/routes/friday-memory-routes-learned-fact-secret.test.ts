import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFridayMemoryRoutes } from "#api";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
import type {
  FridayMemoryItem,
  FridayMemorySearchResult,
  FridayMemoryService,
  FridayMemoryGuardServiceFactory,
} from "#memory";

// ─── SEC-EVENT-REDACTION-001 round-15: the /memory HTTP routes (GET /v1/memory/items list, POST
//     /v1/memory/search) apply the SAME production output filter (`filterItem` / `filterSearchResult`)
//     to every returned item — including STORED-item `metadata` (redactDeep leg) and appended
//     learned-fact `content` (scanAndTransform string leg). This drives the REAL route handlers and
//     asserts: (a) a value under a sensitive KEY NAME in stored METADATA is key-name-nuked (the
//     round-15 parity), and (b) a SHAPED secret embedded in stringified learned-fact content is
//     shape-redacted. RED on 14e4c4f4 for (a); GREEN after the object branch wires the key-name nuke. ───

const NOW = "2026-07-17T10:00:00.000Z";
const M = "[REDACTED_SECRET]";
const PLAIN_PW = "hunter2plainword"; // pragma: allowlist secret
const OPAQUE_TOKEN = "opaquevaluewithnoshape"; // pragma: allowlist secret
// Built at runtime so no literal `sk_live_…` appears in source (GitHub push protection).
const SK_LIVE = ["sk_live", "0123456789abcdefghijABCDwxyz"].join("_"); // pragma: allowlist secret

describe("FridayMemoryRoutes — SECRET egress (round-15 key-name parity)", () => {
  let memoryService: FridayMemoryService;
  let memoryGuardFactory: FridayMemoryGuardServiceFactory;
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];

  function makeCtx(
    overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
  ): FridayHttpContext<unknown, unknown, unknown> {
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

  // A STORED item whose metadata carries a value under a sensitive KEY NAME (the round-15 nuke leg)
  // plus a Stripe underscore secret; and a benign sibling that must survive.
  const storedItem: FridayMemoryItem = {
    id: "m-1",
    namespace: "default",
    key: "k-1",
    content: "benign content",
    source: "test",
    tags: [],
    metadata: { password: PLAIN_PW, apiKey: SK_LIVE, note: "keep" },
    createdAt: NOW,
    updatedAt: NOW,
  };

  // A learned fact whose value carries a SHAPED secret — stringified into content, caught by the shape
  // leg on the /memory list projection.
  const learnedFacts = [
    { key: "creds", value: { apiKey: SK_LIVE }, confidence: 0.9, evidenceCount: 3, lastConfirmedAt: NOW },
  ];

  beforeEach(() => {
    memoryService = {
      store: vi.fn(),
      search: vi.fn().mockResolvedValue([] as FridayMemorySearchResult[]),
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([storedItem] as FridayMemoryItem[]),
      delete: vi.fn(),
      prune: vi.fn(),
    } as unknown as FridayMemoryService;
    memoryGuardFactory = {
      forPrincipal: vi.fn().mockReturnValue(memoryService),
      forContext: vi.fn().mockReturnValue(memoryService),
    } as unknown as FridayMemoryGuardServiceFactory;
    routes = createFridayMemoryRoutes({
      memoryGuardFactory,
      listLearnedFacts: () => learnedFacts,
    });
  });

  it("memory.list NUKES a sensitive-key value in stored item METADATA (filterItem.metadata → redactDeep)", async () => {
    const route = findRoute("memory.list");
    const res = (await route.handler(makeCtx({ query: {} }))) as { items: FridayMemoryItem[] };
    const stored = res.items.find((i) => i.id === "m-1")!;
    const md = stored.metadata as { password: string; apiKey: string; note: string };
    expect(md.password).toBe(M);
    expect(md.apiKey).toBe(M);
    expect(md.note).toBe("keep");
    // The appended learned fact's SHAPED secret is redacted in the stringified content (shape leg).
    const json = JSON.stringify(res);
    expect(json).not.toContain(PLAIN_PW);
    expect(json).not.toContain(SK_LIVE);
  });

  it("memory.search NUKES a sensitive-key value in stored item METADATA and leaks no credential", async () => {
    memoryService.search = vi.fn().mockResolvedValue([
      { item: storedItem, score: 1, ftsScore: 1, semanticScore: 0, matchedBy: ["fts"], snippet: "benign" },
    ] as FridayMemorySearchResult[]);
    const route = findRoute("memory.search");
    const res = (await route.handler(makeCtx({ body: { query: "k" } }))) as {
      items: FridayMemorySearchResult[];
    };
    const stored = res.items.find((r) => r.item.id === "m-1")!;
    const md = stored.item.metadata as { password: string; apiKey: string };
    expect(md.password).toBe(M);
    expect(md.apiKey).toBe(M);
    expect(JSON.stringify(res)).not.toContain(PLAIN_PW);
    expect(JSON.stringify(res)).not.toContain(OPAQUE_TOKEN);
  });
});
