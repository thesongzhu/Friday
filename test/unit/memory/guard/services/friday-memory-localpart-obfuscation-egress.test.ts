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

// ─── SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 round-6 — LOCAL-PART-OBFUSCATED EMAIL FULL-SPAN ──────
// An independent lens found a MEDIUM partial-PII leak: the DEEP string leaf (`redactStringLeaf`) and
// the free-form VALUE path (`redactFreeFormValue`) composed the RAW PII leg FIRST, THEN the preserving
// Unicode fold. For an email whose LOCAL PART carries a zero-width / combining mark but whose remainder
// is a valid `x@domain.tld`, the raw email regex independently matched the domain-side fragment
// `ret@example.com` → `[EMAIL]`, CONSUMING the `@domain` anchor; the fold then ran over
// `agentsec<ZW>[EMAIL]`, found no email, and the local-part PREFIX (`agentsec` / real-name `john.d`)
// survived VERBATIM. NON-UNIFORM: the SAME input is redacted FULL-SPAN by the realtime redactor, the
// direct preserving fold, and the memory TAG path — only the deep + free-form VALUE paths leaked.
//
// FIX: fold-complete ordering — SECRET → Unicode-resistant PII FOLD → raw ASCII/full-width PII
// residual, so the obfuscated-email span is redacted FULL-SPAN before the ASCII email regex can
// fragment it. Every case whose local part is obfuscated must egress the FULL `[EMAIL]` (no surviving
// prefix) across content / source / namespace / expiresAt / nested metadata, on BOTH the agent
// `memory_search` trust boundary AND the HTTP get / list / search / replay routes.
//
// Regression held: domain-split ZW email + fullwidth email + ZW/combining SSN·card·phone STILL redact
// full-span; benign U+3000 non-bridge + multilingual preserved byte-identical; SECRET precedence
// intact. Every sensitive token is assembled from PARTS (GitHub push protection / detect-secrets).
// ───────────────────────────────────────────────────────────────────────────────────────────────

const NOW = "2026-07-17T10:00:00.000Z";
const ZWSP = "​"; // U+200B zero-width space
const COMB = "́"; // U+0301 combining acute
const AT = "@";

// ── LOCAL-PART-obfuscated emails (round-6 root). Domain remainder is a valid `x@domain.tld`, so the
//    raw email regex matches the DOMAIN-side fragment first and fragments the span pre-fix.
const EMAIL_LOCAL_ZW = "agentsec" + ZWSP + "ret" + AT + "example.com";
const EMAIL_LOCAL_ZW_LEAK = "agentsec"; // local-part prefix that survives pre-fix
const EMAIL_NAME_ZW = "john.d" + ZWSP + "oe" + AT + "corp.com";
const EMAIL_NAME_ZW_LEAK = "john.d"; // real-name fragment that survives pre-fix
const EMAIL_LOCAL_COMB = "agentse" + COMB + "cret" + AT + "example.com";
const EMAIL_LOCAL_COMB_LEAK = "agentse"; // fragment (rendered `agentsé…`) that survives pre-fix

// ── Regression: domain-split ZW email + fullwidth-letter email (rounds 4/5) still full-span.
const EMAIL_DOMAIN_ZW = "leak" + AT + "ev" + ZWSP + "il.com";
const EMAIL_DOMAIN_ZW_LEAK = "leak" + AT + "ev";
const EMAIL_FW = "ｌｅａｋ" + AT + "evil.com"; // fullwidth "leak"@evil.com

// ── Regression: obfuscated SSN / card / phone still redact full-span (a broken digit-run does NOT
//    independently match, so these never leaked — but must stay full-span).
const SSN_ZW = "123" + ZWSP + "-45-6789";
const CARD_COMB = "4111" + COMB + "111111111111"; // pragma: allowlist secret — combining-spliced test card
const PHONE_ZW = "415" + ZWSP + "-555-0123";

// ── Secret precedence (must be unchanged by the reorder).
const TOKEN_SSN = "token=" + ["123", "45", "6789"].join("-");
const SECRET_MARKER = "[REDACTED_SECRET]";

// ── Benign / no-over-redaction.
const FW8 = "０１２３４５６７"; // 8 fullwidth digits
const BENIGN_U3000 = FW8 + "　" + FW8; // two groups separated by U+3000 (must NOT bridge)
const MULTI = "café résumé 日本語 naïve"; // benign multilingual — preserved byte-identical

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 1 — agent `memory_search` (content / namespace / source across the trust boundary)
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
function agentMock(input: { search?: FridayMemorySearchResult[] }): FridayMemoryService {
  return {
    search: vi.fn().mockResolvedValue(input.search ?? []),
    store: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(false),
    prune: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [], dryRun: false }),
  } as unknown as FridayMemoryService;
}
function parseAgent(content: string): MappedResult[] {
  return JSON.parse(content) as MappedResult[];
}

describe("round-6 local-part obfuscation — agent memory_search", () => {
  it("redacts a local-part-ZW email FULL-SPAN in content/namespace/source (no surviving prefix) [RED pre-fix]", async () => {
    const legacy = agentItem({
      id: "lp",
      content: "mail " + EMAIL_LOCAL_ZW,
      namespace: EMAIL_NAME_ZW,
      source: "from " + EMAIL_LOCAL_COMB,
      tags: ["ok"],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(legacy, 0.9)] }),
    });
    const res = await searchTool!.execute({ query: "mail" }, signalWithPrincipal("user-1"));
    expect(res.isError).toBeUndefined();
    const row = parseAgent(res.content).find((r) => r.metadata.id === "lp")!;

    expect(row.content).toBe("mail [EMAIL]");
    expect(row.metadata.namespace).toBe("[EMAIL]");
    expect(row.metadata.source).toBe("from [EMAIL]");
    // No local-part prefix survives anywhere in the serialized tool output.
    expect(res.content).not.toContain(EMAIL_LOCAL_ZW_LEAK);
    expect(res.content).not.toContain(EMAIL_NAME_ZW_LEAK);
    expect(res.content).not.toContain(EMAIL_LOCAL_COMB_LEAK);
    expect(res.content).not.toContain("example.com");
    expect(res.content).not.toContain("corp.com");
  });

  it("no-degrade: domain-split ZW + fullwidth email still full-span; benign preserved", async () => {
    const legacy = agentItem({
      id: "reg",
      content: "a " + EMAIL_DOMAIN_ZW + " b " + EMAIL_FW,
      source: BENIGN_U3000 + " " + MULTI,
      tags: ["ok"],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(legacy, 0.9)] }),
    });
    const res = await searchTool!.execute({ query: "a" }, signalWithPrincipal("user-1"));
    const row = parseAgent(res.content).find((r) => r.metadata.id === "reg")!;
    expect(row.content).toBe("a [EMAIL] b [EMAIL]");
    expect(res.content).not.toContain(EMAIL_DOMAIN_ZW_LEAK);
    expect(res.content).not.toContain("evil.com");
    // Benign U+3000 non-bridge + multilingual preserved byte-identical.
    expect(row.metadata.source).toBe(BENIGN_U3000 + " " + MULTI);
    expect(res.content).not.toContain("[CREDIT_CARD]");
  });

  it("no-degrade: obfuscated SSN / card / phone still redact full-span", async () => {
    const legacy = agentItem({
      id: "num",
      content: "ssn " + SSN_ZW + " card " + CARD_COMB + " tel " + PHONE_ZW,
    });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(legacy, 0.9)] }),
    });
    const res = await searchTool!.execute({ query: "ssn" }, signalWithPrincipal("user-1"));
    const row = parseAgent(res.content).find((r) => r.metadata.id === "num")!;
    expect(row.content).toContain("[SSN_US]");
    expect(row.content).toContain("[CREDIT_CARD]");
    expect(row.content).toContain("[PHONE_US]");
    expect(res.content).not.toContain("123-45-6789");
    expect(res.content).not.toContain("555-0123");
  });

  it("no-degrade: secret precedence token=<ssn> stays [REDACTED_SECRET]", async () => {
    const legacy = agentItem({ id: "sec", source: TOKEN_SSN });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(legacy, 0.9)] }),
    });
    const res = await searchTool!.execute({ query: "x" }, signalWithPrincipal("user-1"));
    const row = parseAgent(res.content).find((r) => r.metadata.id === "sec")!;
    expect(row.metadata.source).toBe("token=" + SECRET_MARKER);
    expect(res.content).not.toContain("[SSN_US]");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 2 — HTTP memory routes (get / list / search / replay): values + NESTED metadata + expiresAt
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-6 local-part obfuscation — HTTP memory routes", () => {
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

  it("redacts a local-part-obfuscated email FULL-SPAN in source/expiresAt/NESTED metadata on memory.get [RED pre-fix]", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({
        id: "u",
        source: "from " + EMAIL_LOCAL_ZW,
        expiresAt: EMAIL_NAME_ZW,
        metadata: { outer: { inner: EMAIL_LOCAL_COMB }, plain: EMAIL_LOCAL_ZW },
      }),
    );
    const res = (await findRoute("memory.get").handler(makeCtx({ params: { id: "u" } }))) as { item: FridayMemoryItem };
    expect(res.item.source).toBe("from [EMAIL]");
    expect(res.item.expiresAt).toBe("[EMAIL]");
    const md = res.item.metadata as { outer: { inner: string }; plain: string };
    expect(md.outer.inner).toBe("[EMAIL]"); // NESTED metadata full-span
    expect(md.plain).toBe("[EMAIL]");
    const json = JSON.stringify(res);
    expect(json).not.toContain(EMAIL_LOCAL_ZW_LEAK);
    expect(json).not.toContain(EMAIL_NAME_ZW_LEAK);
    expect(json).not.toContain(EMAIL_LOCAL_COMB_LEAK);
    expect(json).not.toContain("example.com");
    expect(json).not.toContain("corp.com");
  });

  it("redacts a local-part-obfuscated email FULL-SPAN in content on memory.search [RED pre-fix]", async () => {
    (memoryService.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      httpResult(makeItem({ id: "s-lp", content: "mail " + EMAIL_LOCAL_ZW })),
    ]);
    const res = (await findRoute("memory.search").handler(
      makeCtx({ body: { query: "mail" } }),
    )) as { items: FridayMemorySearchResult[] };
    const row = res.items.find((r) => r.item.id === "s-lp")!;
    expect(row.item.content).toBe("mail [EMAIL]");
    expect(row.snippet).toBe("mail [EMAIL]");
    expect(JSON.stringify(res)).not.toContain(EMAIL_LOCAL_ZW_LEAK);
  });

  it("redacts a local-part-obfuscated email in NESTED metadata on memory.list [RED pre-fix]", async () => {
    (memoryService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ id: "l-lp", metadata: { a: { b: { c: EMAIL_LOCAL_ZW } } } }),
    ]);
    const res = (await findRoute("memory.list").handler(makeCtx())) as { items: FridayMemoryItem[] };
    const item = res.items.find((i) => i.id === "l-lp")!;
    const md = item.metadata as { a: { b: { c: string } } };
    expect(md.a.b.c).toBe("[EMAIL]");
    expect(JSON.stringify(res)).not.toContain(EMAIL_LOCAL_ZW_LEAK);
  });

  it("redacts a local-part-obfuscated email in `source` on the store idempotency-replay path [RED pre-fix]", async () => {
    replayItem = makeItem({ id: "m-replay", source: "from " + EMAIL_NAME_ZW });
    const res = (await findRoute("memory.store").handler(
      makeCtx({ body: { namespace: "default", content: "benign note" }, headers: { "idempotency-key": "idem-1" } }),
    )) as { item: FridayMemoryItem };
    expect(res.item.source).toBe("from [EMAIL]");
    expect(JSON.stringify(res)).not.toContain(EMAIL_NAME_ZW_LEAK);
  });

  it("no-degrade: obfuscated SSN/card + benign U+3000 non-bridge on memory.get", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({
        id: "n",
        content: "ssn " + SSN_ZW + " card " + CARD_COMB,
        source: BENIGN_U3000,
        metadata: { m: BENIGN_U3000, t: MULTI },
      }),
    );
    const res = (await findRoute("memory.get").handler(makeCtx({ params: { id: "n" } }))) as { item: FridayMemoryItem };
    expect(res.item.content).toContain("[SSN_US]");
    expect(res.item.content).toContain("[CREDIT_CARD]");
    expect(res.item.source).toBe(BENIGN_U3000);
    const md = res.item.metadata as { m: string; t: string };
    expect(md.m).toBe(BENIGN_U3000);
    expect(md.t).toBe(MULTI);
    expect(JSON.stringify(res)).not.toContain("123-45-6789");
  });
});
