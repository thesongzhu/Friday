import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFridayAgentMemoryTools } from "#agent";
import { createFridayMemoryRoutes } from "#api";
import { redactEventPayload } from "#api";
import { createFridayMemoryOutputFilter } from "#memory";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
import type {
  FridayMemoryItem,
  FridayMemorySearchResult,
  FridayMemoryService,
  FridayMemoryGuardServiceFactory,
} from "#memory";
import { createFridayMemoryPiiGuard } from "../../../src/memory/guard/services/friday-memory-pii-guard.js";
import { attachFridayAgentToolExecutionContext } from "../../../src/agent/runtime/friday-agent-tool-execution-context.js";

// ─── SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 round-7 — FABRICATED-SEPARATOR FALSE-POSITIVE CLASS ────
// The Advisor / production probes found a NO-DEGRADE data-corruption bug in the SHARED value-PII
// preserving fold (`src/security/friday-value-pii-fold.ts`). Its detection copy is built via
// NFKD → strip \p{M} → strip Cf/Default_Ignorable → fold \p{Nd}, preserving Unicode-whitespace + No/Nl
// as non-bridge. But a NON-whitespace SPACING ACCENT whose NFKD DECOMPOSITION BEGINS WITH ASCII SPACE
// (U+00A8 ¨ → <space>+◌̈, U+00B4 ´, U+00AF ¯, U+00B8 ¸, U+02D8–U+02DD, …) had its combining mark
// stripped, leaving a BARE ASCII SPACE the card/SSN/phone matcher accepts as a `[ -]` / `[- ]` /
// `[-.\s]` group separator. So a BENIGN digit run split by such an accent was FABRICATED into
// `[CREDIT_CARD]` / `[SSN_US]` / `[PHONE_US]` — corrupting content/source/nested-metadata and DROPPING
// a benign tag. The exact-BASE output filter preserves the bytes, so this PR INTRODUCED the false
// positive into memory readback; the shared fold is ALSO used by realtime, so it hit that too.
//
// The class is BROADER than those 10 chars: ANY compatibility code point whose NFKD yields a
// leading/standalone matcher-significant ASCII separator — dot-leader U+2024 → '.', small hyphen-minus
// U+FE63 → '-', fullwidth macron U+FFE3 → space, Greek iota-subscript U+037A → space, Arabic
// presentation FATHATAN U+FE70 → space, … — can fabricate a bridging separator. The ROOT fix
// neutralizes the WHOLE class: no source code point that is NOT itself a matcher separator (nor a
// genuine Unicode whitespace / the guard's deliberate full-width `foldWidthForMatching` set) can
// CONTRIBUTE a matcher-significant ASCII separator to the detection copy — the original source code
// point is PRESERVED instead, so in the copy it stays a single non-separator, non-digit character that
// neither BRIDGES nor JOINS adjacent groups.
//
// Every benign input is PRESERVED BYTE-IDENTICAL (NOT a marker) across the real output filter, agent
// `memory_search` (direct + list), the HTTP get/list/search/idempotency-replay routes, the realtime
// `redactEventPayload`, AND equals the shared `guard.redactDeep` output (strict Unicode-resistant
// SUPERSET / audit differential). RED pre-fix (corrupted to a marker). RETAINED: genuine card/SSN/
// phone/email (raw + zero-width/combining/full-width obfuscated) still redact full-span; U+3000/No·Nl
// non-bridge + multilingual preserved; secret ≻ PII precedence; local-part-obfuscated email (round-6)
// still full-span. Every sensitive token is assembled from PARTS (no contiguous literal in this file).
// ───────────────────────────────────────────────────────────────────────────────────────────────

const NOW = "2026-07-18T10:00:00.000Z";
const ZWSP = "​"; // zero-width space
const COMB = "́"; // combining acute
const U3000 = "　"; // ideographic space (guard preserves — non-bridge)
const AT = "@";

// ── The 10 spacing accents named in the finding (each NFKD begins with ASCII space).
const NAMED_SPACE_ACCENTS: Array<[string, string]> = [
  ["U+00A8 diaeresis", "¨"],
  ["U+00B4 acute", "´"],
  ["U+00AF macron", "¯"],
  ["U+00B8 cedilla", "¸"],
  ["U+02D8 breve", "˘"],
  ["U+02D9 dot-above", "˙"],
  ["U+02DA ring-above", "˚"],
  ["U+02DB ogonek", "˛"],
  ["U+02DC small-tilde", "˜"],
  ["U+02DD double-acute", "˝"],
];

// ── Broader class (proves the fix is a GENERAL rule, not an enumerated list of 10):
//    other space-fabricators + a dot-fabricator + a hyphen-fabricator.
const OTHER_SPACE_FABRICATORS: Array<[string, string]> = [
  ["U+037A greek-iota-subscript", "ͺ"],
  ["U+0384 greek-tonos", "΄"],
  ["U+1FBD greek-koronis", "᾽"],
  ["U+FFE3 fullwidth-macron", "￣"],
  ["U+FE70 arabic-fathatan-isolated", "ﹰ"],
  ["U+203E overline", "‾"],
];
const DOT_FABRICATOR = "․"; // ONE DOT LEADER → '.'
const HYPHEN_FABRICATOR = "﹣"; // SMALL HYPHEN-MINUS → '-'

// ── Benign fixtures. 4111111111111111 is Luhn-valid, so a fabricated SPACE/HYPHEN between the two
//    8-digit halves bridges them into a false [CREDIT_CARD] pre-fix. Split so no 16-digit literal.
function benignCardSplit(sep: string): string {
  return "41111111" + sep + "11111111";
}
// 123 45 6789 matches the SSN shape; a fabricated space/hyphen bridges the benign groups pre-fix.
function benignSsnSplit(sep: string): string {
  return "123" + sep + "45" + sep + "6789";
}
// 415.555.0132 matches the US phone shape; a fabricated dot bridges the benign groups pre-fix.
function benignPhoneSplit(sep: string): string {
  return "415" + sep + "555" + sep + "0132";
}

// The canonical finding example.
const BENIGN_CARD_DIAERESIS = benignCardSplit("¨"); // 41111111¨11111111

// ── RETAINED coverage (must STILL redact / preserve exactly as before the fix).
const CARD = "4111" + "1111" + "1111" + "1111"; // raw Luhn-valid test card
const CARD_COMB = "4111" + COMB + "111111111111"; // combining-spliced card
const SSN = ["123", "45", "6789"].join("-");
const SSN_ZW = "123" + ZWSP + "-45-6789";
const PHONE = "415" + "-" + "555" + "-" + "0132";
const PHONE_ZW = "415" + ZWSP + "-555-0132";
const EMAIL = "leak" + AT + "evil.com";
const EMAIL_ZW = "leak" + AT + "ev" + ZWSP + "il.com"; // zero-width splits the domain
const EMAIL_FW = "ｌｅａｋ" + AT + "evil.com"; // fullwidth "leak"@evil.com
const EMAIL_LOCAL_ZW = "agentsec" + ZWSP + "ret" + AT + "example.com"; // round-6 local-part obfuscation
const EMAIL_LOCAL_ZW_LEAK = "agentsec"; // prefix that survived pre-round-6
const TOKEN_SSN = "token=" + ["123", "45", "6789"].join("-"); // secret ≻ PII
const SECRET_MARKER = "[REDACTED_SECRET]";
const BENIGN_U3000 = "01234567" + U3000 + "01234567"; // two ASCII-digit groups, U+3000 non-bridge
const MULTI = "café résumé 日本語 naïve"; // benign multilingual — byte-identical

const ALL_BRIDGE_FIXTURES: Array<[string, string]> = [
  ...NAMED_SPACE_ACCENTS.map(([n, c]) => [`card/${n}`, benignCardSplit(c)] as [string, string]),
  ...OTHER_SPACE_FABRICATORS.map(([n, c]) => [`card/${n}`, benignCardSplit(c)] as [string, string]),
  ["card/U+FE63 small-hyphen", benignCardSplit(HYPHEN_FABRICATOR)],
  ...NAMED_SPACE_ACCENTS.slice(0, 3).map(
    ([n, c]) => [`ssn/${n}`, benignSsnSplit(c)] as [string, string],
  ),
  ["ssn/U+FE63 small-hyphen", benignSsnSplit(HYPHEN_FABRICATOR)],
  ["phone/U+2024 dot-leader", benignPhoneSplit(DOT_FABRICATOR)],
];

const ALL_MARKERS = ["[CREDIT_CARD]", "[SSN_US]", "[PHONE_US]", "[EMAIL]", "[PHONE]"];
function assertNoMarker(s: string): void {
  for (const m of ALL_MARKERS) expect(s).not.toContain(m);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 1 — shared output filter (content / source / nested metadata / tags) + audit differential
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-7 fabricated-separator — shared output filter (no false positive) [RED pre-fix]", () => {
  const filter = createFridayMemoryOutputFilter();
  function item(overrides: Partial<FridayMemoryItem>): FridayMemoryItem {
    return {
      id: "i-1", namespace: "agent", key: "k-1", content: "benign", source: "agent",
      tags: [], metadata: {}, createdAt: NOW, updatedAt: NOW, ...overrides,
    };
  }

  for (const [name, benign] of ALL_BRIDGE_FIXTURES) {
    it(`(${name}) preserves benign digit run byte-identical on content/source/nested-metadata`, () => {
      const out = filter.filterItem(item({
        content: benign,
        source: benign,
        metadata: { top: benign, deep: { deeper: benign } },
      }));
      expect(out.content).toBe(benign);
      expect(out.source).toBe(benign);
      const md = out.metadata as { top: string; deep: { deeper: string } };
      expect(md.top).toBe(benign);
      expect(md.deep.deeper).toBe(benign);
      assertNoMarker(JSON.stringify(out));
    });
  }

  it("(tag) KEEPS a benign fabricated-separator tag (never dropped as PII) [RED pre-fix]", () => {
    const out = filter.filterItem(item({
      tags: [BENIGN_CARD_DIAERESIS, benignSsnSplit("´"), "ok", MULTI, BENIGN_U3000],
    }));
    expect(out.tags).toEqual([BENIGN_CARD_DIAERESIS, benignSsnSplit("´"), "ok", MULTI, BENIGN_U3000]);
  });

  it("(audit differential) filter output == guard.redactDeep == benign input byte-identical", () => {
    const guard = createFridayMemoryPiiGuard("redact");
    for (const [, benign] of ALL_BRIDGE_FIXTURES) {
      const deep = guard.redactDeep(benign).value as string;
      expect(deep).toBe(benign); // audit path preserves benign (no fabricated marker)
      expect((filter.filterItem(item({ content: benign })).content)).toBe(benign);
    }
  });

  it("(RETAIN) genuine PII (raw + zero-width/combining/full-width) STILL redacts full-span", () => {
    const out = filter.filterItem(item({
      content: `card ${CARD}`,
      source: EMAIL,
      metadata: {
        cardComb: CARD_COMB, ssnZw: SSN_ZW, phoneZw: PHONE_ZW,
        emailZw: EMAIL_ZW, emailFw: EMAIL_FW, emailLocal: EMAIL_LOCAL_ZW,
      },
    }));
    expect(out.content).toBe("card [CREDIT_CARD]");
    expect(out.source).toBe("[EMAIL]");
    const md = out.metadata as Record<string, string>;
    expect(md.cardComb).toBe("[CREDIT_CARD]");
    expect(md.ssnZw).toContain("[SSN_US]");
    expect(md.phoneZw).toContain("[PHONE_US]");
    expect(md.emailZw).toBe("[EMAIL]");
    expect(md.emailFw).toBe("[EMAIL]");
    expect(md.emailLocal).toBe("[EMAIL]"); // round-6 local-part obfuscation full-span
    const json = JSON.stringify(out);
    expect(json).not.toContain(EMAIL_LOCAL_ZW_LEAK);
    expect(json).not.toContain("evil.com");
  });

  it("(RETAIN) secret ≻ PII precedence + U+3000/No·Nl non-bridge + multilingual preserved", () => {
    const out = filter.filterItem(item({
      content: TOKEN_SSN,
      metadata: { spaced: BENIGN_U3000, bio: MULTI },
    }));
    expect(out.content).toContain(SECRET_MARKER);
    expect(out.content).not.toContain("[SSN_US]");
    const md = out.metadata as { spaced: string; bio: string };
    expect(md.spaced).toBe(BENIGN_U3000); // U+3000 non-bridge preserved
    expect(md.bio).toBe(MULTI);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 2 — HTTP memory routes (get / list / search / idempotency-replay)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-7 fabricated-separator — HTTP memory routes (no false positive) [RED pre-fix]", () => {
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

  it("(get) preserves benign fabricated-separator content/metadata/tag", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({ id: "u", content: BENIGN_CARD_DIAERESIS, metadata: { deep: { n: BENIGN_CARD_DIAERESIS } }, tags: [BENIGN_CARD_DIAERESIS, "ok"] }),
    );
    const res = (await findRoute("memory.get").handler(makeCtx({ params: { id: "u" } }))) as { item: FridayMemoryItem };
    expect(res.item.content).toBe(BENIGN_CARD_DIAERESIS);
    expect((res.item.metadata as { deep: { n: string } }).deep.n).toBe(BENIGN_CARD_DIAERESIS);
    expect(res.item.tags).toEqual([BENIGN_CARD_DIAERESIS, "ok"]);
    assertNoMarker(JSON.stringify(res));
  });

  it("(list) preserves benign across rows; still redacts a genuine card row", async () => {
    (memoryService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ id: "r-benign", content: benignCardSplit(HYPHEN_FABRICATOR), metadata: { a: benignSsnSplit("˘") } }),
      makeItem({ id: "r-pii", content: `card ${CARD}`, metadata: { c: CARD_COMB } }),
    ]);
    const res = (await findRoute("memory.list").handler(makeCtx())) as { items: FridayMemoryItem[] };
    const byId = (id: string) => res.items.find((i) => i.id === id)!;
    expect(byId("r-benign").content).toBe(benignCardSplit(HYPHEN_FABRICATOR));
    expect((byId("r-benign").metadata as { a: string }).a).toBe(benignSsnSplit("˘"));
    expect(byId("r-pii").content).toBe("card [CREDIT_CARD]");
    expect((byId("r-pii").metadata as { c: string }).c).toBe("[CREDIT_CARD]");
  });

  it("(search) preserves benign fabricated-separator content", async () => {
    (memoryService.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      httpResult(makeItem({ id: "s", content: benignPhoneSplit(DOT_FABRICATOR) })),
    ]);
    const res = (await findRoute("memory.search").handler(
      makeCtx({ body: { query: "x" } }),
    )) as { items: FridayMemorySearchResult[] };
    expect(res.items.find((r) => r.item.id === "s")!.item.content).toBe(benignPhoneSplit(DOT_FABRICATOR));
    assertNoMarker(JSON.stringify(res));
  });

  it("(store idempotency-replay) preserves benign fabricated-separator content", async () => {
    replayItem = makeItem({ id: "m-replay", content: BENIGN_CARD_DIAERESIS });
    const res = (await findRoute("memory.store").handler(
      makeCtx({ body: { namespace: "default", content: "benign note" }, headers: { "idempotency-key": "idem-1" } }),
    )) as { item: FridayMemoryItem };
    expect(res.item.content).toBe(BENIGN_CARD_DIAERESIS);
    assertNoMarker(JSON.stringify(res));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 3 — agent `memory_search` (direct search + session-lexical LIST legs)
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

describe("round-7 fabricated-separator — agent memory_search (no false positive) [RED pre-fix]", () => {
  it("(direct) preserves benign content + KEEPS benign tag; still redacts a genuine card row", async () => {
    const benignRow = agentItem({
      id: "benign", content: `status ${BENIGN_CARD_DIAERESIS} note`,
      tags: [BENIGN_CARD_DIAERESIS, "keep"],
    });
    const piiRow = agentItem({ id: "pii", content: `status card ${CARD}`, tags: [] });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(benignRow, 0.9), agentResult(piiRow, 0.5)] }),
    });
    const res = await searchTool!.execute({ query: "status" }, signalWithPrincipal("user-1"));
    expect(res.isError).toBeUndefined();
    const rows = parseAgent(res.content);
    const benign = rows.find((r) => r.metadata.id === "benign")!;
    const pii = rows.find((r) => r.metadata.id === "pii")!;
    expect(benign.content).toBe(`status ${BENIGN_CARD_DIAERESIS} note`);
    expect(benign.metadata.tags).toEqual([BENIGN_CARD_DIAERESIS, "keep"]); // benign tag kept
    expect(pii.content).toBe("status card [CREDIT_CARD]"); // genuine card still redacted
  });

  it("(list leg) preserves benign fabricated-separator content on the session lexical fallback", async () => {
    const benignRow = agentItem({ id: "l", content: `profile ${benignSsnSplit(HYPHEN_FABRICATOR)} entry` });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [], list: [benignRow] }),
      resolveSessionMemoryNamespace: async () => "sess-abc",
    });
    const res = await searchTool!.execute({ query: "profile" }, signalWithPrincipal("user-1", "sess-123"));
    expect(res.isError).toBeUndefined();
    const row = parseAgent(res.content).find((r) => r.metadata.id === "l");
    expect(row, "list-leg row should be present").toBeDefined();
    expect(row!.content).toBe(`profile ${benignSsnSplit(HYPHEN_FABRICATOR)} entry`);
    assertNoMarker(res.content);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 4 — realtime `redactEventPayload` (the shared fold's OTHER consumer)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-7 fabricated-separator — realtime redactEventPayload (no false positive) [RED pre-fix]", () => {
  for (const [name, benign] of ALL_BRIDGE_FIXTURES) {
    it(`(${name}) preserves benign digit run byte-identical in a content field`, () => {
      const out = redactEventPayload({ note: `value ${benign} ok`, nested: { deep: benign } }) as {
        note: string; nested: { deep: string };
      };
      expect(out.note).toBe(`value ${benign} ok`);
      expect(out.nested.deep).toBe(benign);
      assertNoMarker(JSON.stringify(out));
    });
  }

  it("(RETAIN) realtime still redacts genuine PII (raw + zero-width/combining/full-width)", () => {
    const out = redactEventPayload({
      a: `card ${CARD}`, b: EMAIL_ZW, c: CARD_COMB, d: EMAIL_FW, e: `ssn ${SSN}`, f: PHONE,
    }) as Record<string, string>;
    expect(out.a).toBe("card [CREDIT_CARD]");
    expect(out.b).toBe("[EMAIL]");
    expect(out.c).toBe("[CREDIT_CARD]");
    expect(out.d).toBe("[EMAIL]");
    expect(out.e).toBe("ssn [SSN_US]");
    expect(out.f).toBe("[PHONE_US]");
  });

  it("(RETAIN) realtime preserves U+3000/No·Nl non-bridge + multilingual byte-identical", () => {
    const out = redactEventPayload({ spaced: BENIGN_U3000, bio: MULTI }) as { spaced: string; bio: string };
    expect(out.spaced).toBe(BENIGN_U3000);
    expect(out.bio).toBe(MULTI);
  });
});
