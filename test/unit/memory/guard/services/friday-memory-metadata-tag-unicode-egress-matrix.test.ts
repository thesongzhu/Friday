import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFridayAgentMemoryTools } from "#agent";
import { createFridayMemoryRoutes } from "#api";
import { createFridayMemoryOutputFilter } from "#memory";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
import type {
  FridayMemoryItem,
  FridayMemorySearchResult,
  FridayMemoryService,
  FridayMemoryGuardServiceFactory,
} from "#memory";
import { attachFridayAgentToolExecutionContext } from "../../../../../src/agent/runtime/friday-agent-tool-execution-context.js";

// ─── SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 round-5 — NESTED METADATA + TAGS Unicode-PII matrix ──
// The Advisor's round-5 HIGH: round-4's `redactFreeFormValue` (raw ∪ Unicode-obfuscated PII, U+3000/
// No·Nl non-bridge) was applied ONLY to SCALAR item fields. Unicode-obfuscated PII still ESCAPED via
//   (1) nested `metadata` string values — `redactMetadata` → `redactDeep`, whose string-VALUE leg
//       lacked Unicode-obfuscated PII coverage (the E1 exception carried into the deep path); and
//   (2) `tags` — `dropSensitiveTags` checked raw PII + raw/Unicode SECRETS but NOT Unicode PII.
// The canonical-root fix makes Unicode-resistant PII UNIFORM across every string egress:
//   • `redactDeep`'s string leg now composes the shared `redactUnicodeResistantPii` preserving fold —
//     so nested metadata + learned-fact values inherit it (E1 closed for the deep path); and
//   • `dropSensitiveTags` uses the COMPLETE raw ∪ Unicode PII∪secret sensitivity predicate.
//
// Each canary is placed ONLY in a nested `metadata.<key>` string value, and SEPARATELY only in a
// `tag`, RAW and Unicode-obfuscated (zero-width U+200B / fullwidth / combining), and proven across
// the agent `memory_search` trust boundary (direct-search + list legs), the HTTP get/list/search/
// idempotency-replay routes, and the learned-fact output-filter consumer. Every case is RED on the
// pre-round-5 tree (Unicode-PII in metadata/tag leaks) and GREEN after; the benign no-degrade cases
// (multilingual + U+3000/No·Nl non-bridge preserved byte-identical, raw controls) are held green.
// Every sensitive token is assembled from PARTS so no contiguous secret/PII literal sits in this file.
// ───────────────────────────────────────────────────────────────────────────────────────────────

const NOW = "2026-07-17T10:00:00.000Z";
const ZWSP = "​"; // U+200B zero-width space
const U3000 = "　"; // ideographic space
const AT = "@";

// ── Unicode-obfuscated PII (RED pre-fix in the DEEP / tag paths). Same shapes proven by the round-4
//    scalar matrix, now placed in nested metadata + tags.
const EMAIL_ZW = "leak" + AT + "ev" + ZWSP + "il.com"; // zero-width splits the domain
const EMAIL_ZW_LEAK_PROBE = "leak" + AT + "ev"; // contiguous run that leaks pre-fix
const EMAIL_FW = "ｌｅａｋ" + AT + "evil.com"; // fullwidth "leak"@evil.com
const CARD_COMB = "4111" + "́" + "111111111111"; // pragma: allowlist secret — combining-spliced card
const SSN_ZW = "123" + ZWSP + "-45-6789"; // zero-width breaks the \d{3}-\d{2}-\d{4} shape

// ── Raw PII (superset baseline — must stay redacted / dropped exactly as before).
const EMAIL = "leak" + AT + "evil.com";
const SSN = "123" + "-" + "45" + "-" + "6789";

// ── Benign / no-over-redaction controls.
const FW8 = "０１２３４５６７"; // 8 fullwidth digits
const BENIGN_U3000 = FW8 + U3000 + FW8; // two groups separated by U+3000 (non-bridge)
const MULTI = "café résumé 日本語 naïve"; // benign multilingual — preserved byte-identical

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 1 — the shared output filter (the exact path the agent `memory_search` egress uses, plus
//             the HTTP routes and the learned-fact consumer). `filterItem` / `filterSearchResult` /
//             `redactLearnedFactValue` are the real functions every surface delegates to.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-5 matrix — shared output filter (metadata + tags, deep, no-degrade)", () => {
  const filter = createFridayMemoryOutputFilter();
  function item(overrides: Partial<FridayMemoryItem>): FridayMemoryItem {
    return {
      id: "i-1", namespace: "agent", key: "k-1", content: "benign", source: "agent",
      tags: [], metadata: {}, createdAt: NOW, updatedAt: NOW, ...overrides,
    };
  }

  it("(meta) redacts Unicode-obfuscated PII in NESTED metadata string values [RED pre-fix]", () => {
    const out = filter.filterItem(item({
      metadata: {
        contact: EMAIL_ZW,                 // zero-width email, top-level
        profile: { note: CARD_COMB },      // combining card, nested one level
        deep: { deeper: { id: SSN_ZW } },  // zero-width SSN, nested two levels
        fw: EMAIL_FW,                      // fullwidth-letter email
      },
    }));
    const md = out.metadata as {
      contact: string; profile: { note: string }; deep: { deeper: { id: string } }; fw: string;
    };
    expect(md.contact).toBe("[EMAIL]");
    expect(md.profile.note).toBe("[CREDIT_CARD]");
    expect(md.deep.deeper.id).toContain("[SSN_US]");
    expect(md.fw).toBe("[EMAIL]");
    const json = JSON.stringify(out);
    expect(json).not.toContain(EMAIL_ZW_LEAK_PROBE);
    expect(json).not.toContain("evil.com"); // fullwidth domain is ASCII → must be gone
    expect(json).not.toContain("123-45-6789");
  });

  it("(meta) redacts RAW PII in nested metadata (superset baseline)", () => {
    const out = filter.filterItem(item({ metadata: { a: { b: EMAIL }, c: SSN } }));
    const md = out.metadata as { a: { b: string }; c: string };
    expect(md.a.b).toBe("[EMAIL]");
    expect(md.c).toContain("[SSN_US]");
    expect(JSON.stringify(out)).not.toContain(EMAIL);
  });

  it("(meta) does NOT over-redact benign multilingual / U+3000 non-bridge metadata (byte-identical)", () => {
    const md = { bio: MULTI, spaced: BENIGN_U3000, count: 42, ok: true, nada: null };
    const out = filter.filterItem(item({ metadata: { ...md } }));
    expect(out.metadata).toEqual(md);
    expect(JSON.stringify(out)).not.toContain("[CREDIT_CARD]");
    expect(JSON.stringify(out)).not.toContain("[EMAIL]");
  });

  it("(tag) drops Unicode-obfuscated + raw PII tags; keeps benign / non-bridge tags [RED pre-fix]", () => {
    const out = filter.filterItem(item({
      tags: [EMAIL_ZW, EMAIL_FW, CARD_COMB, SSN_ZW, EMAIL, "ok", MULTI, BENIGN_U3000],
    }));
    // Every sensitive tag (raw ∪ Unicode-obfuscated) is DROPPED — never rewritten to a marker tag.
    expect(out.tags).toEqual(["ok", MULTI, BENIGN_U3000]);
    for (const t of out.tags) {
      expect(t).not.toContain("[EMAIL]");
      expect(t).not.toContain("[CREDIT_CARD]");
      expect(t).not.toContain("[SSN_US]");
    }
    expect(JSON.stringify(out)).not.toContain(EMAIL_ZW_LEAK_PROBE);
    expect(JSON.stringify(out)).not.toContain(EMAIL);
  });

  it("(search-result) applies the SAME metadata + tag policy through filterSearchResult", () => {
    const result: FridayMemorySearchResult = {
      item: item({ metadata: { contact: EMAIL_ZW }, tags: [CARD_COMB, "keep"] }),
      score: 0.9, ftsScore: 0.9, semanticScore: 0.9, matchedBy: ["fts"], snippet: "benign",
    };
    const out = filter.filterSearchResult(result);
    expect((out.item.metadata as { contact: string }).contact).toBe("[EMAIL]");
    expect(out.item.tags).toEqual(["keep"]);
  });

  it("(learned-fact) redacts Unicode-obfuscated PII in a nested learned-fact value [RED pre-fix]", () => {
    const out = filter.redactLearnedFactValue({
      label: "contact",
      channels: [{ kind: "email", raw: EMAIL_ZW }, { kind: "card", raw: CARD_COMB }],
      note: MULTI,
    }) as { label: string; channels: Array<{ kind: string; raw: string }>; note: string };
    expect(out.label).toBe("contact");
    expect(out.channels[0]!.raw).toBe("[EMAIL]");
    expect(out.channels[1]!.raw).toBe("[CREDIT_CARD]");
    expect(out.note).toBe(MULTI); // benign multilingual preserved
    expect(JSON.stringify(out)).not.toContain(EMAIL_ZW_LEAK_PROBE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 2 — HTTP memory routes (get / list / search / idempotency-replay): nested metadata + tags
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-5 matrix — HTTP memory routes (metadata + tags, no-degrade)", () => {
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

  it("(meta+tag) redacts nested metadata Unicode-PII + drops a Unicode-PII tag on memory.get [RED pre-fix]", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({ id: "u", metadata: { deep: { contact: EMAIL_ZW } }, tags: [CARD_COMB, "ok"] }),
    );
    const res = (await findRoute("memory.get").handler(makeCtx({ params: { id: "u" } }))) as { item: FridayMemoryItem };
    expect((res.item.metadata as { deep: { contact: string } }).deep.contact).toBe("[EMAIL]");
    expect(res.item.tags).toEqual(["ok"]);
    const json = JSON.stringify(res);
    expect(json).not.toContain(EMAIL_ZW_LEAK_PROBE);
  });

  it("(meta+tag) redacts on memory.list across rows [RED pre-fix]", async () => {
    (memoryService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ id: "r-fw", metadata: { a: EMAIL_FW }, tags: [SSN_ZW, "keep"] }),
      makeItem({ id: "r-benign", metadata: { bio: MULTI, spaced: BENIGN_U3000 }, tags: [MULTI, BENIGN_U3000] }),
    ]);
    const res = (await findRoute("memory.list").handler(makeCtx())) as { items: FridayMemoryItem[] };
    const byId = (id: string) => res.items.find((i) => i.id === id)!;
    expect((byId("r-fw").metadata as { a: string }).a).toBe("[EMAIL]");
    expect(byId("r-fw").tags).toEqual(["keep"]);
    // Benign row: metadata byte-identical, benign/non-bridge tags preserved.
    expect(byId("r-benign").metadata).toEqual({ bio: MULTI, spaced: BENIGN_U3000 });
    expect(byId("r-benign").tags).toEqual([MULTI, BENIGN_U3000]);
    expect(JSON.stringify(res)).not.toContain("evil.com");
    expect(JSON.stringify(res)).not.toContain("[CREDIT_CARD]");
  });

  it("(meta+tag) redacts on the memory.search route", async () => {
    (memoryService.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      httpResult(makeItem({ id: "s-uni", metadata: { p: { q: CARD_COMB } }, tags: [EMAIL_ZW, "t"] })),
    ]);
    const res = (await findRoute("memory.search").handler(
      makeCtx({ body: { query: "x" } }),
    )) as { items: FridayMemorySearchResult[] };
    const row = res.items.find((r) => r.item.id === "s-uni")!;
    expect((row.item.metadata as { p: { q: string } }).p.q).toBe("[CREDIT_CARD]");
    expect(row.item.tags).toEqual(["t"]);
    expect(JSON.stringify(res)).not.toContain(EMAIL_ZW_LEAK_PROBE);
  });

  it("(meta+tag) redacts a canary that lives ONLY in metadata/tag on the store idempotency-replay path", async () => {
    replayItem = makeItem({ id: "m-replay", metadata: { extra: { contact: EMAIL_ZW } }, tags: [CARD_COMB, "ok"] });
    const res = (await findRoute("memory.store").handler(
      makeCtx({ body: { namespace: "default", content: "benign note" }, headers: { "idempotency-key": "idem-1" } }),
    )) as { item: FridayMemoryItem };
    expect((res.item.metadata as { extra: { contact: string } }).extra.contact).toBe("[EMAIL]");
    expect(res.item.tags).toEqual(["ok"]);
    expect(JSON.stringify(res)).not.toContain(EMAIL_ZW_LEAK_PROBE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 3 — agent `memory_search` (direct search + session-lexical LIST legs). The tool serializes
//             `item.tags` (the filtered value) in `metadata.tags`, so a Unicode-PII TAG is proven
//             DROPPED end-to-end through BOTH legs. A metadata canary is asserted absent from the
//             whole serialized output (the tool never serializes arbitrary nested metadata, and the
//             shared filter — proven in SURFACE 1 — redacts it regardless).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
interface MappedResult {
  content: string;
  score: number;
  metadata: { id: string; namespace: string; tags: string[]; source: string; createdAt: string };
}
function signalWithPrincipal(principalId: string, sessionKey = "agent:run:run-1"): AbortSignal {
  return attachFridayAgentToolExecutionContext(new AbortController().signal, {
    runId: "run-1", sessionKey, readOnly: false, principalId,
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

describe("round-5 matrix — agent memory_search (direct + list legs: tag drop, no-degrade)", () => {
  it("(tag) drops a Unicode-obfuscated PII tag on the DIRECT search leg [RED pre-fix]", async () => {
    const legacy = agentItem({
      id: "u-tag",
      content: "status update note",
      metadata: { contact: EMAIL_ZW }, // never serialized by the tool, but filtered by the shared path
      tags: [EMAIL_ZW, CARD_COMB, "keep", MULTI, BENIGN_U3000],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(legacy, 0.9)] }),
    });
    const res = await searchTool!.execute({ query: "status" }, signalWithPrincipal("user-1"));
    expect(res.isError).toBeUndefined();
    const row = parseAgent(res.content).find((r) => r.metadata.id === "u-tag")!;
    // Unicode-obfuscated + raw sensitive tags dropped; benign + non-bridge tags kept byte-identical.
    expect(row.metadata.tags).toEqual(["keep", MULTI, BENIGN_U3000]);
    // No de-obfuscated PII fragment (from tag OR the never-serialized metadata) anywhere in the output.
    expect(res.content).not.toContain(EMAIL_ZW_LEAK_PROBE);
    expect(res.content).not.toContain(EMAIL);
  });

  it("(tag) drops a Unicode-obfuscated PII tag on the session lexical-fallback LIST leg [RED pre-fix]", async () => {
    const legacy = agentItem({
      id: "u-tag-list",
      content: "profile status entry",
      tags: [SSN_ZW, "profile", MULTI],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      // search returns nothing → the row can only reach the agent via the LIST-backed
      // session lexical fallback (buildSessionLexicalCandidates → memoryService.list).
      memoryService: agentMock({ search: [], list: [legacy] }),
      resolveSessionMemoryNamespace: async () => "sess-abc",
    });
    const res = await searchTool!.execute({ query: "profile" }, signalWithPrincipal("user-1", "sess-123"));
    expect(res.isError).toBeUndefined();
    const row = parseAgent(res.content).find((r) => r.metadata.id === "u-tag-list");
    expect(row, "list-leg row should be present in tool output").toBeDefined();
    expect(row!.metadata.tags).toEqual(["profile", MULTI]);
    expect(res.content).not.toContain("123-45-6789");
  });

  it("(no-degrade) benign tags preserved + ranking/limit intact with a dropped-tag row", async () => {
    const top = agentItem({ id: "t", content: "alpha status green", tags: ["green", MULTI] });
    const mid = agentItem({ id: "m", content: "beta status", tags: [EMAIL_ZW, "beta"] });
    const low = agentItem({ id: "l", content: "gamma status blue" });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(top, 0.9), agentResult(mid, 0.5), agentResult(low, 0.1)] }),
    });
    const res = await searchTool!.execute({ query: "status", limit: 2 }, new AbortController().signal);
    const parsed = parseAgent(res.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.metadata.id).toBe("t");
    expect(parsed[1]!.metadata.id).toBe("m");
    expect(parsed[0]!.metadata.tags).toEqual(["green", MULTI]); // benign preserved
    expect(parsed[1]!.metadata.tags).toEqual(["beta"]);         // Unicode-PII tag dropped
    expect(res.content).not.toContain(EMAIL_ZW_LEAK_PROBE);
  });
});
