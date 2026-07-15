import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFridayMemoryRoutes } from "#api";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
import type {
  FridayMemoryItem,
  FridayMemorySearchResult,
  FridayMemoryService,
  FridayMemoryGuardServiceFactory,
} from "#memory";

// ─── Regression: learned facts appended AFTER the memory guard/output-filter must still be
//     PII-redacted at the route egress. Full-width (U+FF10–FF19) credit-card digits in a
//     learned fact were returned verbatim through GET /v1/memory/items (list) and
//     POST /v1/memory/search (content + snippet). These route-level tests exercise the real
//     route handler and assert on the returned JSON. ───

const NOW = "2026-02-18T10:00:00.000Z";
// toFullwidth("4111111111111111") — Luhn-valid Visa test number in full-width digits.
const FULLWIDTH_CARD = "４１１１１１１１１１１１１１１１";

describe("FridayMemoryRoutes — learned-fact PII egress (full-width)", () => {
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

  // A learned fact whose value is a full-width credit card (the leaking payload).
  const learnedFacts = [
    {
      key: "card",
      value: `カード番号は${FULLWIDTH_CARD}です`,
      confidence: 0.9,
      evidenceCount: 3,
      lastConfirmedAt: NOW,
    },
  ];

  beforeEach(() => {
    memoryService = {
      store: vi.fn(),
      // No stored items — the payload under test is the appended learned fact.
      search: vi.fn().mockResolvedValue([] as FridayMemorySearchResult[]),
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([] as FridayMemoryItem[]),
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

  it("memory.search redacts full-width card in appended learned-fact content AND snippet", async () => {
    const route = findRoute("memory.search");
    const res = (await route.handler(makeCtx({ body: { query: "card" } }))) as {
      items: FridayMemorySearchResult[];
    };
    expect(res.items.length).toBeGreaterThanOrEqual(1);
    const learned = res.items[0];
    expect(learned.item.content).toContain("[CREDIT_CARD]");
    expect(learned.item.content).not.toContain(FULLWIDTH_CARD);
    expect(learned.snippet).toContain("[CREDIT_CARD]");
    expect(learned.snippet).not.toContain(FULLWIDTH_CARD);
  });

  it("memory.list redacts full-width card in appended learned-fact content", async () => {
    const route = findRoute("memory.list");
    const res = (await route.handler(makeCtx({ query: {} }))) as { items: FridayMemoryItem[] };
    expect(res.items.length).toBeGreaterThanOrEqual(1);
    const learned = res.items[0];
    expect(learned.content).toContain("[CREDIT_CARD]");
    expect(learned.content).not.toContain(FULLWIDTH_CARD);
  });

  it("memory.search does not leak the raw full-width digits in ANY returned field", async () => {
    const route = findRoute("memory.search");
    const res = (await route.handler(makeCtx({ body: { query: "card" } }))) as {
      items: FridayMemorySearchResult[];
    };
    expect(JSON.stringify(res)).not.toContain(FULLWIDTH_CARD);
  });

  it("memory.list does not leak the raw full-width digits in ANY returned field", async () => {
    const route = findRoute("memory.list");
    const res = (await route.handler(makeCtx({ query: {} }))) as { items: FridayMemoryItem[] };
    expect(JSON.stringify(res)).not.toContain(FULLWIDTH_CARD);
  });
});
