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

  // ─── SEC-EVENT-REDACTION-001 round-17: a HuggingFace `hf_` token in a STORED item's content / metadata /
  //     tags must be shape-redacted on the REAL public GET routes (`memory.get` single-item AND
  //     `memory.list`), which both funnel through `outputFilter.filterItem`. RED on d2e0e222 (`hf_`+34
  //     returned verbatim); GREEN after the `hf_` pattern is added. Built from parts so no contiguous
  //     literal token appears in SOURCE. ───
  describe("round-17 HuggingFace hf_ egress on the real memory.get / memory.list routes", () => {
    const HF_BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz01234567"; // pragma: allowlist secret — 34 base62 chars
    const HF = ["hf", HF_BODY].join("_"); // pragma: allowlist secret
    const hfItem: FridayMemoryItem = {
      id: "m-hf",
      namespace: "default",
      key: "k-hf",
      content: `auth used ${HF} today`,
      source: "test",
      tags: ["ok", HF, "fine"], // the hf_-shaped tag must be DROPPED
      metadata: { tokenPreview: HF, note: "keep" }, // non-sensitive key → the SHAPE detector must catch it
      createdAt: NOW,
      updatedAt: NOW,
    };

    it("memory.get shape-redacts hf_ in content + metadata and DROPS the hf_-shaped tag", async () => {
      memoryService.get = vi.fn().mockResolvedValue(hfItem);
      const route = findRoute("memory.get");
      const res = (await route.handler(makeCtx({ params: { id: "m-hf" } }))) as { item: FridayMemoryItem };
      const item = res.item;
      expect(item.content).toContain(M);
      expect(item.content).not.toContain(HF);
      expect(item.content).toContain("auth used");
      const md = item.metadata as { tokenPreview: string; note: string };
      expect(md.tokenPreview).toBe(M);
      expect(md.note).toBe("keep");
      expect(item.tags).toEqual(["ok", "fine"]); // hf_-shaped tag dropped, benign tags survive
      expect(JSON.stringify(res)).not.toContain(HF);
      expect(JSON.stringify(res)).not.toContain(HF_BODY);
    });

    it("memory.list shape-redacts hf_ in a stored item's content + metadata", async () => {
      memoryService.list = vi.fn().mockResolvedValue([hfItem] as FridayMemoryItem[]);
      const route = findRoute("memory.list");
      const res = (await route.handler(makeCtx({ query: {} }))) as { items: FridayMemoryItem[] };
      const item = res.items.find((i) => i.id === "m-hf")!;
      expect(item.content).not.toContain(HF);
      expect(item.content).toContain(M);
      expect((item.metadata as { tokenPreview: string }).tokenPreview).toBe(M);
      expect(JSON.stringify(res)).not.toContain(HF);
    });
  });
});
