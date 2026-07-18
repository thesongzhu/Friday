import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFridayMemoryRoutes } from "#api";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
import type {
  FridayMemoryItem,
  FridayMemoryService,
  FridayMemoryGuardServiceFactory,
} from "#memory";

// ─── SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 round-2 (the Advisor HIGH) ────────────────────────
// `FridayMemoryItem.source` is a FREE-FORM persisted string. The shared output filter
// (`filterItemImpl`) redacted content/metadata/tags but PRESERVED `source`, so a legacy/older-writer
// row that stored PII or a credential VALUE inside `source` leaked RAW on every read-back — including
// the public HTTP `memory.get` (GET /v1/memory/items/:id) and `memory.list` (GET /v1/memory/items),
// both of which return `outputFilter.filterItem(item)`. Round-2 routes `source` through the SAME
// canonical PII + secret-VALUE transform INSIDE `filterItemImpl`, so these routes inherit it with no
// route-level change. RED on the pre-fix tree (raw `source` in the response); GREEN after. A benign
// `source` is asserted byte-preserved. Every credential is assembled from PARTS so no contiguous
// literal token sits in this file (GitHub push protection / detect-secrets). ───────────────────────

const NOW = "2026-07-17T10:00:00.000Z";
const SECRET_MARKER = "[REDACTED_SECRET]";

// Assembled at runtime so no contiguous literal token appears in SOURCE.
const EMAIL = ["leak", "evil.com"].join("@");
const HF_BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz01234567"; // pragma: allowlist secret — 34 base62 chars
const HF = ["hf", HF_BODY].join("_"); // pragma: allowlist secret — HuggingFace user token shape
const SK_BODY = "Abcdef0123456789Ghijkl"; // pragma: allowlist secret — 22 chars ≥ 16
const SK = ["sk", SK_BODY].join("-"); // pragma: allowlist secret — provider hyphen key shape

// The sensitive value lives ONLY in `source`; content/tags/metadata are benign.
function makeSensitiveSourceItem(overrides: Partial<FridayMemoryItem> = {}): FridayMemoryItem {
  return {
    id: "m-legacy-source",
    namespace: "default",
    key: "k-legacy",
    content: "benign note",
    source: `imported from ${EMAIL} using ${HF} and ${SK}`,
    tags: ["ok"],
    metadata: { note: "keep" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("FridayMemoryRoutes — free-form `source` secret/PII egress (round-2)", () => {
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

  beforeEach(() => {
    memoryService = {
      store: vi.fn(),
      search: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      prune: vi.fn(),
    } as unknown as FridayMemoryService;
    memoryGuardFactory = {
      forPrincipal: vi.fn().mockReturnValue(memoryService),
      forContext: vi.fn().mockReturnValue(memoryService),
    } as unknown as FridayMemoryGuardServiceFactory;
    routes = createFridayMemoryRoutes({ memoryGuardFactory });
  });

  it("redacts a sensitive `source` on the single-item GET (memory.get)", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(makeSensitiveSourceItem());
    const res = (await findRoute("memory.get").handler(
      makeCtx({ params: { id: "m-legacy-source" } }),
    )) as { item: FridayMemoryItem };

    expect(res.item.source).toContain("[EMAIL]");
    expect(res.item.source).toContain(SECRET_MARKER);
    const json = JSON.stringify(res);
    expect(json).not.toContain(EMAIL);
    expect(json).not.toContain(HF);
    expect(json).not.toContain(HF_BODY);
    expect(json).not.toContain(SK);
    expect(json).not.toContain(SK_BODY);
  });

  it("redacts a sensitive `source` on the LIST route (memory.list) and byte-preserves a benign `source`", async () => {
    const benign = makeSensitiveSourceItem({
      id: "m-benign-source",
      source: "channel:telegram",
    });
    (memoryService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeSensitiveSourceItem(),
      benign,
    ]);

    const res = (await findRoute("memory.list").handler(makeCtx())) as { items: FridayMemoryItem[] };

    const leaked = res.items.find((i) => i.id === "m-legacy-source")!;
    expect(leaked.source).toContain("[EMAIL]");
    expect(leaked.source).toContain(SECRET_MARKER);

    // A benign source identifier is returned BYTE-IDENTICAL (no over-redaction).
    const clean = res.items.find((i) => i.id === "m-benign-source")!;
    expect(clean.source).toBe("channel:telegram");

    const json = JSON.stringify(res);
    expect(json).not.toContain(EMAIL);
    expect(json).not.toContain(HF);
    expect(json).not.toContain(HF_BODY);
    expect(json).not.toContain(SK);
    expect(json).not.toContain(SK_BODY);
  });
});
