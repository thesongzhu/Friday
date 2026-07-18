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
// AWS access-key id shape (`AKIA` + 16 upper-alnum) and a pure-digit Luhn-valid card — both ADMITTED
// by the key regex `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`, both assembled from PARTS.
const AKIA = ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""); // pragma: allowlist secret — AWS access-key id (AKIA + 16)
const CARD = ["4111", "1111", "1111", "1111"].join(""); // pragma: allowlist secret — pure-digit Luhn card
// Zero-width (U+200B) splice inside the hf_ body: the raw bytes are obfuscated, but the filter's
// Unicode detection copy folds the ZWSP away and still recognizes the credential.
const ZWSP = "​";
// pragma: allowlist secret — zero-width-spliced hf_ token
const HF_ZW = ["hf", HF_BODY.slice(0, 12) + ZWSP + HF_BODY.slice(12)].join("_");
// Contiguous run that leaks pre-fix (the ZWSP is spliced AFTER it) — a RED/GREEN discriminator.
const HF_ZW_LEAK_PROBE = ["hf", HF_BODY.slice(0, 12)].join("_");

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

// ─── SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 round-3 (field-enumeration follow-up) ─────────────
// The field-enumeration lens found MORE free-form serialized fields that `filterItemImpl` passed
// RAW (it spread `{...item}` and only overrode content/source/metadata/tags):
//   • `key` — user-writable; `validateKey` (`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`) ADMITS
//     hf_/sk-/ghp_/AKIA/pure-digit-card and the HTTP `validateStoreBody` does NO key check, so a
//     client POSTs `key="hf_…"` and reads it back RAW on memory.get / memory.list / idempotency-replay.
//   • `namespace` — free-form; egresses as `item.namespace` on HTTP (legacy-pre-guard row class).
//   • `expiresAt` — free-form string; the HTTP store applies NO validation (timestamp-semantic → a
//     real timestamp is a redaction no-op, so redacting it is SAFE).
// Round-3 routes all three through the SAME canonical value-redaction INSIDE `filterItemImpl`, so the
// HTTP routes inherit it with no route-level change. RED on the pre-fix tree (raw field in the
// response), GREEN after. Benign key / namespace / valid-ISO expiresAt are asserted byte-preserved.
// ───────────────────────────────────────────────────────────────────────────────────────────
describe("FridayMemoryRoutes — free-form key/namespace/expiresAt secret/PII egress (round-3)", () => {
  let memoryService: FridayMemoryService;
  let memoryGuardFactory: FridayMemoryGuardServiceFactory;
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
  let replayItem: FridayMemoryItem | null;

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

  function makeItem(overrides: Partial<FridayMemoryItem> = {}): FridayMemoryItem {
    return {
      id: "m-1",
      namespace: "default",
      key: "k-benign",
      content: "benign note",
      source: "agent",
      tags: ["ok"],
      metadata: { note: "keep" },
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
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
    replayItem = null;
    routes = createFridayMemoryRoutes({
      memoryGuardFactory,
      findStoreReplay: () => replayItem,
    });
  });

  // ── key ──────────────────────────────────────────────────────────────────────────────────
  it("redacts a credential that lives ONLY in `key` on memory.get (raw + zero-width)", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({ id: "m-key-secret", key: HF }),
    );
    const res = (await findRoute("memory.get").handler(
      makeCtx({ params: { id: "m-key-secret" } }),
    )) as { item: FridayMemoryItem };
    expect(res.item.key).toContain(SECRET_MARKER);
    const json = JSON.stringify(res);
    expect(json).not.toContain(HF);
    expect(json).not.toContain(HF_BODY);

    // Zero-width-obfuscated credential in `key` is de-obfuscated and redacted too.
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({ id: "m-key-zw", key: HF_ZW }),
    );
    const resZw = (await findRoute("memory.get").handler(
      makeCtx({ params: { id: "m-key-zw" } }),
    )) as { item: FridayMemoryItem };
    expect(resZw.item.key).toContain(SECRET_MARKER);
    expect(JSON.stringify(resZw)).not.toContain(HF_ZW_LEAK_PROBE);
  });

  it("redacts every admitted credential shape in `key` on memory.list and byte-preserves a benign key", async () => {
    (memoryService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ id: "k-hf", key: HF }),
      makeItem({ id: "k-sk", key: SK }),
      makeItem({ id: "k-akia", key: AKIA }),
      makeItem({ id: "k-card", key: CARD }),
      makeItem({ id: "k-benign", key: "user:preferences:theme" }),
    ]);
    const res = (await findRoute("memory.list").handler(makeCtx())) as { items: FridayMemoryItem[] };

    const byId = (id: string) => res.items.find((i) => i.id === id)!;
    // Each admitted credential shape is rewritten (not equal to the raw stored key).
    expect(byId("k-hf").key).not.toBe(HF);
    expect(byId("k-hf").key).toContain(SECRET_MARKER);
    expect(byId("k-sk").key).not.toBe(SK);
    expect(byId("k-sk").key).toContain(SECRET_MARKER);
    expect(byId("k-akia").key).not.toBe(AKIA);
    expect(byId("k-akia").key).toContain(SECRET_MARKER);
    // round-4 Defect 2: a PURE-DECIMAL key (any script) is an ambiguous business identifier — it is
    // preserved BYTE-IDENTICAL by the identifier-aware `redactStructuredKey` (all-`\p{Nd}` exempt), NOT
    // folded to `[CREDIT_CARD]` (which would corrupt a benign, addressable id). The credential shapes
    // above still redact because they contain non-`Nd` characters.
    expect(byId("k-card").key).toBe(CARD);
    // A benign key is returned BYTE-IDENTICAL (addressability unaffected).
    expect(byId("k-benign").key).toBe("user:preferences:theme");

    // CARD is intentionally EXCLUDED: a pure-decimal key legitimately round-trips verbatim (see above).
    const json = JSON.stringify(res);
    for (const raw of [HF, HF_BODY, SK, SK_BODY, AKIA]) {
      expect(json).not.toContain(raw);
    }
  });

  it("redacts a credential that lives ONLY in `key` on the store idempotency-replay path", async () => {
    replayItem = makeItem({ id: "m-replay", key: HF, metadata: {} });
    const res = (await findRoute("memory.store").handler(
      makeCtx({
        body: { namespace: "default", content: "benign note" },
        headers: { "idempotency-key": "idem-1" },
      }),
    )) as { item: FridayMemoryItem };
    // The replay early-return item is filtered, so a secret persisted in `key` is not re-leaked on retry.
    expect(res.item.key).toContain(SECRET_MARKER);
    const json = JSON.stringify(res);
    expect(json).not.toContain(HF);
    expect(json).not.toContain(HF_BODY);
  });

  // ── namespace ────────────────────────────────────────────────────────────────────────────
  it("redacts a credential ONLY in `namespace` on memory.list and byte-preserves a benign namespace", async () => {
    (memoryService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ id: "ns-secret", namespace: `legacy-${HF}` }),
      makeItem({ id: "ns-benign", namespace: "user-facts" }),
    ]);
    const res = (await findRoute("memory.list").handler(makeCtx())) as { items: FridayMemoryItem[] };

    const secret = res.items.find((i) => i.id === "ns-secret")!;
    expect(secret.namespace).toContain(SECRET_MARKER);
    const clean = res.items.find((i) => i.id === "ns-benign")!;
    // A benign namespace is BYTE-IDENTICAL (addressability unaffected).
    expect(clean.namespace).toBe("user-facts");

    const json = JSON.stringify(res);
    expect(json).not.toContain(HF);
    expect(json).not.toContain(HF_BODY);
  });

  // ── expiresAt ────────────────────────────────────────────────────────────────────────────
  it("redacts a credential ONLY in `expiresAt` on memory.get", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({ id: "exp-secret", expiresAt: `expires ${HF}` }),
    );
    const res = (await findRoute("memory.get").handler(
      makeCtx({ params: { id: "exp-secret" } }),
    )) as { item: FridayMemoryItem };
    expect(res.item.expiresAt).toContain(SECRET_MARKER);
    const json = JSON.stringify(res);
    expect(json).not.toContain(HF);
    expect(json).not.toContain(HF_BODY);
  });

  it("round-trips a valid ISO `expiresAt` timestamp BYTE-IDENTICAL (no over-redaction)", async () => {
    const iso = "2027-01-15T08:30:00.000Z";
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({ id: "exp-iso", expiresAt: iso }),
    );
    const res = (await findRoute("memory.get").handler(
      makeCtx({ params: { id: "exp-iso" } }),
    )) as { item: FridayMemoryItem };
    // A real timestamp carries no sensitive subspan → the redactor is a no-op.
    expect(res.item.expiresAt).toBe(iso);
  });

  it("passes an absent `expiresAt` through unchanged (never coerced to a string)", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({ id: "exp-absent" }),
    );
    const res = (await findRoute("memory.get").handler(
      makeCtx({ params: { id: "exp-absent" } }),
    )) as { item: FridayMemoryItem };
    expect(res.item.expiresAt).toBeUndefined();
  });
});
