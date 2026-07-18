import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFridayAgentMemoryTools } from "#agent";
import { createFridayMemoryRoutes } from "#api";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
import type {
  FridayMemoryItem,
  FridayMemorySearchResult,
  FridayMemoryService,
  FridayMemoryGuardServiceFactory,
} from "#memory";
import { attachFridayAgentToolExecutionContext } from "../../../../../src/agent/runtime/friday-agent-tool-execution-context.js";

// ─── SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 round-4 — FULL FIELD-POLICY MATRIX ─────────────────
// The Advisor's round-4 required_action #4: prove the repaired SHARED field-policy layer end-to-end
// through BOTH the agent `memory_search` trust boundary AND the HTTP get/list/search/replay routes.
// Every case below is RED on the pre-round-4 tree where annotated (the three flagged defects) and
// GREEN after, with the no-degrade cases (benign preservation, non-bridge, credential/formatted-PII
// keys still redacting) held green. Every sensitive token is assembled from PARTS so no contiguous
// secret/PII literal sits in this file (GitHub push protection / detect-secrets).
//
//   Defect 1 [HIGH]  — free-form VALUE redaction must detect Unicode-obfuscated PII (not just secrets).
//   Defect 2 [HIGH]  — `key` uses the IDENTIFIER-aware policy: a pure-decimal key is preserved
//                      byte-identical (any script) while credential/formatted-PII keys still redact.
//   Defect 3 [MED]   — `source` (unbounded free-form) must NOT be silently truncated on read-back.
// ───────────────────────────────────────────────────────────────────────────────────────────────

const NOW = "2026-07-17T10:00:00.000Z";
const SECRET_MARKER = "[REDACTED_SECRET]";
const ZWSP = "​"; // U+200B zero-width space
const AT = "@";

// ── Unicode-obfuscated PII (Defect 1). Each is RED pre-fix: the pre-round-4 value transform ran the
//    Unicode detection pass for SECRET shapes ONLY, so a Unicode-spliced PII value egressed verbatim.
// Zero-width email — the ZWSP splits the DOMAIN so NEITHER half is a valid email raw; the preserving
// fold removes the ZWSP and the guard's own detector matches `leak@evil.com`.
const EMAIL_ZW = "leak" + AT + "ev" + ZWSP + "il.com";
const EMAIL_ZW_LEAK_PROBE = "leak" + AT + "ev"; // contiguous run that leaks pre-fix
// Fullwidth-letter email — the guard folds fullwidth DIGITS but not fullwidth LETTERS, so the raw
// matcher misses it; the fold's NFKD letter-fold reveals it.
const EMAIL_FW = "ｌｅａｋ" + AT + "evil.com"; // fullwidth "leak"@evil.com
// Combining-mark-spliced card — a combining acute (U+0301) between digit groups; the raw matcher's
// width fold does not strip it, so the card stays hidden until the preserving fold strips \p{M}.
const CARD_COMB = "4111" + "́" + "111111111111"; // pragma: allowlist secret — combining-spliced test card
// Zero-width SSN — the ZWSP breaks the `\d{3}-\d{2}-\d{4}` shape for the raw matcher.
const SSN_ZW = "123" + ZWSP + "-45-6789";

// ── Raw PII / secret (Defect 1 (a) — superset baseline).
const EMAIL = "leak" + AT + "evil.com";
const HF_BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz01234567"; // pragma: allowlist secret — 34 base62
const HF = ["hf", HF_BODY].join("_"); // pragma: allowlist secret — HuggingFace token shape

// ── Keys (Defect 2). Pure-decimal keys (ASCII + Arabic-Indic) are ambiguous business ids → preserved
//    byte-identical. ASCII is RED pre-fix (was folded to `[CREDIT_CARD]`). Credential + formatted-PII
//    keys still redact.
const CARD = ["4111", "1111", "1111", "1111"].join(""); // pragma: allowlist secret — pure-decimal card key
const CARD_AR = "٤١١١١١١١١١١١١١١١"; // 16 Arabic-Indic digits — pure-decimal key, other script
const SSN_KEY = ["123", "45", "6789"].join("-"); // formatted-PII key (SSN-shaped)

// ── Benign / no-over-redaction (Defect 1 (f)). U+3000 (ideographic space) between two fullwidth
//    digit groups must NOT be folded to an ASCII space that bridges them into a fabricated card.
const FW8 = "０１２３４５６７"; // 8 fullwidth digits
const BENIGN_U3000 = FW8 + "　" + FW8; // two groups separated by U+3000
const MULTI = "café résumé 日本語 naïve"; // benign multilingual — preserved byte-identical
// Long benign source (Defect 3): > 8192 chars, no sensitive subspan → must return in FULL.
const LONG_SOURCE = "session:" + "a".repeat(10_406);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 1 — agent `memory_search` (content / namespace / source egress across the trust boundary)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
interface MappedResult {
  content: string;
  score: number;
  metadata: { id: string; namespace: string; tags: string[]; source: string; createdAt: string };
}
function signalWithPrincipal(principalId: string, sessionKey = "agent:run:run-1"): AbortSignal {
  return attachFridayAgentToolExecutionContext(new AbortController().signal, {
    runId: "run-1",
    sessionKey,
    readOnly: false,
    principalId,
  });
}
function agentItem(overrides: Partial<FridayMemoryItem>): FridayMemoryItem {
  return {
    id: "item-1", namespace: "agent", key: "key-1", content: "benign", source: "agent",
    tags: [], metadata: {}, createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}
function agentResult(item: FridayMemoryItem, score: number): FridayMemorySearchResult {
  return { item, score, ftsScore: score, semanticScore: score, matchedBy: ["fts"], snippet: item.content.slice(0, 200) };
}
function agentMock(input: { search?: FridayMemorySearchResult[]; list?: FridayMemoryItem[] }): FridayMemoryService {
  return {
    search: vi.fn().mockResolvedValue(input.search ?? []),
    store: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue(input.list ?? []),
    delete: vi.fn().mockResolvedValue(false),
    prune: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [], dryRun: false }),
  } as unknown as FridayMemoryService;
}
function parseAgent(content: string): MappedResult[] {
  return JSON.parse(content) as MappedResult[];
}

describe("field-policy matrix — agent memory_search (Defect 1 + 3, no-degrade)", () => {
  it("(b) redacts Unicode-obfuscated PII in content/namespace/source [RED pre-fix]", async () => {
    const legacy = agentItem({
      id: "u-pii",
      content: "purchase " + CARD_COMB,              // combining-spliced card
      namespace: "ns-" + EMAIL_FW,                   // fullwidth-letter email
      source: "from " + EMAIL_ZW,                    // zero-width-spliced email
      tags: ["ok"],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(legacy, 0.9)] }),
    });
    const res = await searchTool!.execute({ query: "purchase" }, signalWithPrincipal("user-1"));
    expect(res.isError).toBeUndefined();
    const row = parseAgent(res.content).find((r) => r.metadata.id === "u-pii")!;

    expect(row.content).toContain("[CREDIT_CARD]");
    expect(row.metadata.namespace).toContain("[EMAIL]");
    expect(row.metadata.source).toContain("[EMAIL]");
    // No de-obfuscated PII fragment leaks anywhere in the serialized tool output.
    expect(res.content).not.toContain(EMAIL);
    expect(res.content).not.toContain(EMAIL_ZW_LEAK_PROBE);
    expect(res.content).not.toContain("evil.com"); // fullwidth email domain is ASCII → must be gone
  });

  it("(a) redacts raw PII + a raw credential in free-form values (superset baseline)", async () => {
    const legacy = agentItem({
      id: "raw", content: "email " + EMAIL, source: "token " + HF, tags: ["ok"],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(legacy, 0.9)] }),
    });
    const res = await searchTool!.execute({ query: "email" }, signalWithPrincipal("user-1"));
    const row = parseAgent(res.content).find((r) => r.metadata.id === "raw")!;
    expect(row.content).toContain("[EMAIL]");
    expect(row.metadata.source).toContain(SECRET_MARKER);
    expect(res.content).not.toContain(EMAIL);
    expect(res.content).not.toContain(HF_BODY);
  });

  it("(c) returns a long benign `source` (>8192) in FULL, byte-identical [RED pre-fix: truncated]", async () => {
    const legacy = agentItem({ id: "long", content: "benign status", source: LONG_SOURCE });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(legacy, 0.9)] }),
    });
    const res = await searchTool!.execute({ query: "status" }, signalWithPrincipal("user-1"));
    const row = parseAgent(res.content).find((r) => r.metadata.id === "long")!;
    // Pre-fix `source` was routed through the 8192 content SIZE cap → truncated; now full.
    expect(row.metadata.source).toBe(LONG_SOURCE);
    expect(row.metadata.source.length).toBe(LONG_SOURCE.length);
  });

  it("(f) does NOT over-redact benign U+3000-separated fullwidth digits / multilingual text", async () => {
    const benign = agentItem({ id: "benign", content: BENIGN_U3000 + " " + MULTI, source: "channel:telegram" });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(benign, 0.9)] }),
    });
    const res = await searchTool!.execute({ query: "note" }, signalWithPrincipal("user-1"));
    const row = parseAgent(res.content).find((r) => r.metadata.id === "benign")!;
    // No fabricated [CREDIT_CARD] from the ideographic-space bridge; multilingual preserved.
    expect(row.content).toBe(BENIGN_U3000 + " " + MULTI);
    expect(row.content).not.toContain("[CREDIT_CARD]");
    expect(row.metadata.source).toBe("channel:telegram");
  });

  it("no-degrade: ranking order + result limit preserved with a redacted row", async () => {
    const top = agentItem({ id: "t", content: "alpha status green" });
    const mid = agentItem({ id: "m", content: "card " + CARD_COMB });
    const low = agentItem({ id: "l", content: "gamma status blue" });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(top, 0.9), agentResult(mid, 0.5), agentResult(low, 0.1)] }),
    });
    const res = await searchTool!.execute({ query: "status", limit: 2 }, new AbortController().signal);
    const parsed = parseAgent(res.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.metadata.id).toBe("t");
    expect(parsed[1]!.metadata.id).toBe("m");
    expect(parsed[0]!.content).toBe("alpha status green");
    expect(parsed[1]!.content).toContain("[CREDIT_CARD]");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 2 — HTTP memory routes (get / list / search / replay): key + expiresAt + values
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("field-policy matrix — HTTP memory routes (Defect 1 + 2 + 3, no-degrade)", () => {
  let memoryService: FridayMemoryService;
  let memoryGuardFactory: FridayMemoryGuardServiceFactory;
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
  let replayItem: FridayMemoryItem | null;

  function makeCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
    return {
      requestId: "req-1", receivedAt: NOW, params: {}, query: {}, body: {}, headers: {},
      principal: {
        principalType: "user" as const, principalId: "user-1", userId: "user-1",
        role: "admin" as const, scopes: ["hub.admin" as const], tokenId: "tok-1",
        tokenKind: "access" as const, issuedAt: NOW,
      },
      ...overrides,
    };
  }
  const findRoute = (operationId: string) => routes.find((r) => r.operationId === operationId)!;
  function makeItem(overrides: Partial<FridayMemoryItem> = {}): FridayMemoryItem {
    return {
      id: "m-1", namespace: "default", key: "k-benign", content: "benign note", source: "agent",
      tags: ["ok"], metadata: { note: "keep" }, createdAt: NOW, updatedAt: NOW, ...overrides,
    };
  }
  function httpResult(item: FridayMemoryItem, score = 0.9): FridayMemorySearchResult {
    return { item, score, ftsScore: score, semanticScore: score, matchedBy: ["fts"], snippet: item.content.slice(0, 200) };
  }

  beforeEach(() => {
    memoryService = {
      store: vi.fn(), search: vi.fn(), get: vi.fn(), list: vi.fn(), delete: vi.fn(), prune: vi.fn(),
    } as unknown as FridayMemoryService;
    memoryGuardFactory = {
      forPrincipal: vi.fn().mockReturnValue(memoryService),
      forContext: vi.fn().mockReturnValue(memoryService),
    } as unknown as FridayMemoryGuardServiceFactory;
    replayItem = null;
    routes = createFridayMemoryRoutes({ memoryGuardFactory, findStoreReplay: () => replayItem });
  });

  // ── Defect 2: key identifier policy ──────────────────────────────────────────────────────────
  it("(d) preserves a pure-decimal `key` BYTE-IDENTICAL — ASCII [RED pre-fix] + Arabic-Indic — on memory.list", async () => {
    (memoryService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ id: "k-ascii", key: CARD }),
      makeItem({ id: "k-arabic", key: CARD_AR }),
    ]);
    const res = (await findRoute("memory.list").handler(makeCtx())) as { items: FridayMemoryItem[] };
    const byId = (id: string) => res.items.find((i) => i.id === id)!;
    // Pre-round-4 the value transform folded the 16 digits to a Luhn card → `[CREDIT_CARD]`.
    expect(byId("k-ascii").key).toBe(CARD);
    expect(byId("k-arabic").key).toBe(CARD_AR);
    expect(JSON.stringify(res)).not.toContain("[CREDIT_CARD]");
  });

  it("(d) preserves a pure-decimal `key` byte-identical on memory.get", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(makeItem({ id: "k-get", key: CARD }));
    const res = (await findRoute("memory.get").handler(makeCtx({ params: { id: "k-get" } }))) as { item: FridayMemoryItem };
    expect(res.item.key).toBe(CARD);
  });

  it("(e) redacts a credential-shaped `key` and a formatted-PII (SSN-shaped) `key` on memory.list", async () => {
    (memoryService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ id: "k-cred", key: HF }),
      makeItem({ id: "k-ssn", key: SSN_KEY }),
      makeItem({ id: "k-ok", key: "user:preferences:theme" }),
    ]);
    const res = (await findRoute("memory.list").handler(makeCtx())) as { items: FridayMemoryItem[] };
    const byId = (id: string) => res.items.find((i) => i.id === id)!;
    expect(byId("k-cred").key).toContain(SECRET_MARKER);
    expect(byId("k-cred").key).not.toBe(HF);
    expect(byId("k-ssn").key).toBe("[SSN_US]");
    // Benign key unaffected.
    expect(byId("k-ok").key).toBe("user:preferences:theme");
    expect(JSON.stringify(res)).not.toContain(HF_BODY);
  });

  // ── Defect 1: Unicode-obfuscated PII in free-form values ─────────────────────────────────────
  it("(b) redacts Unicode-obfuscated PII in `source` + `expiresAt` on memory.get [RED pre-fix]", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({ id: "u", source: "from " + EMAIL_ZW, expiresAt: "ssn " + SSN_ZW }),
    );
    const res = (await findRoute("memory.get").handler(makeCtx({ params: { id: "u" } }))) as { item: FridayMemoryItem };
    expect(res.item.source).toContain("[EMAIL]");
    expect(res.item.expiresAt).toContain("[SSN_US]");
    const json = JSON.stringify(res);
    expect(json).not.toContain(EMAIL_ZW_LEAK_PROBE);
    expect(json).not.toContain("123-45-6789");
  });

  it("(a)/(b) redacts raw + Unicode-obfuscated PII in content on the memory.search route", async () => {
    (memoryService.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      httpResult(makeItem({ id: "s-raw", content: "email " + EMAIL })),
      httpResult(makeItem({ id: "s-uni", content: "card " + CARD_COMB })),
    ]);
    const res = (await findRoute("memory.search").handler(
      makeCtx({ body: { query: "email" } }),
    )) as { items: FridayMemorySearchResult[] };
    const byId = (id: string) => res.items.find((r) => r.item.id === id)!;
    expect(byId("s-raw").item.content).toContain("[EMAIL]");
    expect(byId("s-uni").item.content).toContain("[CREDIT_CARD]");
    expect(JSON.stringify(res)).not.toContain(EMAIL);
  });

  it("(a) redacts a credential that lives ONLY in `key` on the store idempotency-replay path", async () => {
    replayItem = makeItem({ id: "m-replay", key: HF, metadata: {} });
    const res = (await findRoute("memory.store").handler(
      makeCtx({ body: { namespace: "default", content: "benign note" }, headers: { "idempotency-key": "idem-1" } }),
    )) as { item: FridayMemoryItem };
    expect(res.item.key).toContain(SECRET_MARKER);
    expect(JSON.stringify(res)).not.toContain(HF_BODY);
  });

  // ── Defect 3: source non-truncating ──────────────────────────────────────────────────────────
  it("(c) returns a long benign `source` (>8192) in FULL, byte-identical on memory.get [RED pre-fix]", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(makeItem({ id: "long", source: LONG_SOURCE }));
    const res = (await findRoute("memory.get").handler(makeCtx({ params: { id: "long" } }))) as { item: FridayMemoryItem };
    expect(res.item.source).toBe(LONG_SOURCE);
    expect(res.item.source.length).toBe(LONG_SOURCE.length);
  });

  // ── Defect 1: no over-redaction ──────────────────────────────────────────────────────────────
  it("(f) does NOT fabricate a card from benign U+3000-separated fullwidth digits on memory.get", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({ id: "b", content: BENIGN_U3000, source: BENIGN_U3000, namespace: FW8 }),
    );
    const res = (await findRoute("memory.get").handler(makeCtx({ params: { id: "b" } }))) as { item: FridayMemoryItem };
    expect(res.item.content).toBe(BENIGN_U3000);
    expect(res.item.source).toBe(BENIGN_U3000);
    expect(JSON.stringify(res)).not.toContain("[CREDIT_CARD]");
  });
});
