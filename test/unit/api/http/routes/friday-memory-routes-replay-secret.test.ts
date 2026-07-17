import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFridayMemoryRoutes } from "#api";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
import type {
  FridayMemoryItem,
  FridayMemoryService,
  FridayMemoryGuardServiceFactory,
} from "#memory";
import { hashIdempotencyPayload } from "../../../../../src/api/http/routes/friday-route-idempotency.js";

// ─── SEC-EVENT-REDACTION-001 round-18 (the Advisor HIGH): both idempotency-REPLAY early returns
//     (POST /v1/memory/store `memory.store` AND POST /v1/memory/items `memory.items.create`) returned
//     the RAW persisted row from `findStoreReplay` — which reads the repository row DIRECTLY, bypassing
//     the guard service's read-time `filterItem`. So a secret persisted before the store-time guard
//     existed (or by an older writer) leaked VERBATIM on retry. Round-16 routed the `memory.get` GET
//     egress through `outputFilter.filterItem`; these two POST replay short-circuits were missed.
//
//     RED on 023e35d3 (pre-fix): the raw `hf_` / `sk-` / Bearer credentials in the replay item's
//     content + NESTED metadata + tags are returned verbatim. GREEN after each replay return is routed
//     through the SAME canonical `outputFilter.filterItem`. Every credential is built from PARTS so no
//     contiguous literal token sits in this file (GitHub push protection). ───

const NOW = "2026-07-17T10:00:00.000Z";
const M = "[REDACTED_SECRET]";

// Built at runtime so no contiguous literal token appears in SOURCE.
const HF_BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz01234567"; // pragma: allowlist secret — 34 base62 chars
const HF = ["hf", HF_BODY].join("_"); // pragma: allowlist secret — HuggingFace user token shape
const SK_BODY = "Abcdef0123456789Ghijkl"; // pragma: allowlist secret — 22 chars ≥ 16
const SK = ["sk", SK_BODY].join("-"); // pragma: allowlist secret — provider hyphen key shape
const BEARER_TOKEN = ["ey", "Jabc0123456789defABCDghij"].join(""); // pragma: allowlist secret
const BEARER = ["Bearer", BEARER_TOKEN].join(" "); // pragma: allowlist secret — Authorization credential

const REQUEST_CONTENT = "please persist my note"; // the benign RETRY request body content

// The persisted row `findStoreReplay` returns on retry. Secrets live in (a) content, (b) NESTED
// metadata, (c) tags. A benign idempotency envelope (`metadata.apiRequest`) whose `payloadHash`
// matches the retry request lets the replay succeed WITHOUT tripping the conflict guard; it must be
// returned BYTE-PRESERVED (only the item body is filtered). The stored `payloadHash` mirrors the
// canonical payload the handler hashes for a `{ content }`-only body (namespace defaults to "default").
const matchingPayloadHash = hashIdempotencyPayload({
  namespace: "default",
  content: REQUEST_CONTENT,
});

const idempotencyEnvelope = {
  operationId: "memory.items.create",
  principalId: "user-1",
  idempotencyKey: "idem-legacy-1",
  payloadHash: matchingPayloadHash,
  receivedAt: NOW,
};

function makeReplayItem(): FridayMemoryItem {
  return {
    id: "m-legacy",
    namespace: "default",
    key: "k-legacy",
    content: `auth used ${HF} today`, // hf_ shape embedded in content, benign prefix must survive
    source: "legacy",
    tags: ["ok", HF, "fine"], // the hf_-shaped tag must be DROPPED, benign tags survive
    metadata: {
      note: "keep", // benign metadata under a benign key must survive
      // NESTED secrets under BENIGN keys → caught by the SHAPE detector (redactDeep string-value leg),
      // NOT the sensitive-key-name nuke — so the object structure is preserved and only the shaped
      // VALUE is redacted (the harder detector path this replay egress must also cover).
      nested: { detail: SK, header: BEARER, preview: HF },
      apiRequest: { ...idempotencyEnvelope }, // benign idempotency envelope must be BYTE-PRESERVED
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("FridayMemoryRoutes — idempotency-REPLAY secret egress (round-18)", () => {
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

  function buildRoutes(findStoreReplay: () => FridayMemoryItem | null) {
    routes = createFridayMemoryRoutes({ memoryGuardFactory, findStoreReplay });
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
  });

  // Both replay short-circuits share the identical fix; run the same assertions against each.
  for (const operationId of ["memory.store", "memory.items.create"] as const) {
    describe(`${operationId} replay`, () => {
      it("shape-redacts a legacy secret in content + NESTED metadata + tags on the Idempotency-Key replay", async () => {
        const replayItem = makeReplayItem();
        buildRoutes(vi.fn(() => replayItem));
        const route = findRoute(operationId);

        const res = (await route.handler(makeCtx({
          body: { content: REQUEST_CONTENT },
          headers: { "idempotency-key": "idem-legacy-1" },
        }))) as { item: FridayMemoryItem };
        const item = res.item;

        // (a) content: hf_ redacted, benign prefix survives.
        expect(item.content).toContain(M);
        expect(item.content).not.toContain(HF);
        expect(item.content).toContain("auth used");

        // (b) NESTED metadata: sk- + Bearer + hf_ redacted in place; Bearer scheme kept; benign survives.
        const md = item.metadata as {
          note: string;
          nested: { detail: string; header: string; preview: string };
        };
        expect(md.nested.detail).toBe(M);
        expect(md.nested.header).toBe(`Bearer ${M}`);
        expect(md.nested.preview).toBe(M);
        expect(md.note).toBe("keep");

        // (c) tags: the hf_-shaped tag is DROPPED; benign tags survive.
        expect(item.tags).toEqual(["ok", "fine"]);

        // No raw secret byte survives ANYWHERE in the response.
        const json = JSON.stringify(res);
        expect(json).not.toContain(HF);
        expect(json).not.toContain(HF_BODY);
        expect(json).not.toContain(SK);
        expect(json).not.toContain(SK_BODY);
        expect(json).not.toContain(BEARER_TOKEN);

        // The store path must NOT run — this is a pure replay.
        expect(memoryService.store).not.toHaveBeenCalled();
      });

      it("byte-preserves the benign idempotency envelope on the replay (only the item body is filtered)", async () => {
        const replayItem = makeReplayItem();
        buildRoutes(vi.fn(() => replayItem));
        const route = findRoute(operationId);

        const res = (await route.handler(makeCtx({
          body: { content: REQUEST_CONTENT },
          headers: { "idempotency-key": "idem-legacy-1" },
        }))) as { item: FridayMemoryItem };

        // The whole idempotency envelope (operationId / principalId / idempotencyKey / payloadHash /
        // receivedAt) is returned byte-identical — the filter touches only sensitive VALUES.
        expect((res.item.metadata as { apiRequest: unknown }).apiRequest).toEqual(idempotencyEnvelope);
      });

      it("preserves the existing conflict behaviour: same key + DIFFERENT payload still 409s", async () => {
        const conflictItem = makeReplayItem();
        (conflictItem.metadata as { apiRequest: { payloadHash: string } }).apiRequest.payloadHash =
          "0".repeat(64); // a stored hash that cannot match the retry request's real hash
        buildRoutes(vi.fn(() => conflictItem));
        const route = findRoute(operationId);

        await expect(route.handler(makeCtx({
          body: { content: REQUEST_CONTENT },
          headers: { "idempotency-key": "idem-legacy-1" },
        }))).rejects.toThrow("Idempotency-Key 'idem-legacy-1'");
        expect(memoryService.store).not.toHaveBeenCalled();
      });
    });
  }
});
