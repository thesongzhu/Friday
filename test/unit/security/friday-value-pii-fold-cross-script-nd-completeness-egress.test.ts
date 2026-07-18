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
import {
  redactUnicodeResistantPii,
  type UnicodeResistantPiiMatch,
} from "../../../src/security/friday-value-pii-fold.js";
import { attachFridayAgentToolExecutionContext } from "../../../src/agent/runtime/friday-agent-tool-execution-context.js";

// ─── SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 round-10 — CROSS-SCRIPT \p{Nd} COMPLETENESS (Advisor P0) ──
// The SHARED value-PII preserving fold (`src/security/friday-value-pii-fold.ts`) folds cross-script
// Unicode decimal digits (`\p{Nd}` that NFKD does NOT fold to ASCII) so a card / SSN / phone written in
// Arabic-Indic / Devanagari / … still de-obfuscates and redacts. A prior revision did that fold via a
// HAND-MAINTAINED list of block bases that DRIFTED behind the supported runtime's Unicode version (16.0),
// OMITTING whole Nd blocks: Garay (U+16130), Kawi (U+11F50), Nag Mundari (U+1E4F0), Kirat Rai (the
// merged 20-code-point run U+116D0–116E3), Sunuwar (U+11BF0), Ol Onal (U+1E5F1), and the blocks at
// U+10D40 / U+16AC0 / U+16D70. Digits in those blocks stayed NON-ASCII → EVADED the ASCII card/ssn/phone
// matchers → a Visa-shaped card in Garay digits was emitted VERBATIM by the real output filter, the agent
// `memory_search` serialization, the HTTP get/list/search routes, AND the realtime redactor — a
// cross-script PII LEAK contradicting the PR's uniform cross-script redaction.
//
// The ROOT fix makes the digit fold RUNTIME-DERIVED (memoized) so it is AUTOMATICALLY COMPLETE for the
// runtime's Unicode version and CANNOT drift: every `\p{Nd}` code point the runtime recognizes maps to
// its ASCII value 0–9. Value derivation is per contiguous decimal RUN (value = (cp − runStart) mod 10),
// REQUIRED because some runs concatenate two blocks with no gap — e.g. U+116D0–116E3 is ONE 20-run (two
// Kirat-Rai-family 0–9 blocks); the naive "predecessor-gap base" heuristic mis-assigns the SECOND block
// values 10..19 and would still LEAK it.
//
// This suite proves, RED pre-fix (leaks verbatim): every runtime `\p{Nd}` folds to its correct ASCII
// digit (exhaustive invariant, incl. the previously-omitted blocks and the merged-run second block); a
// card / SSN / phone in representative previously-omitted scripts REDACTS to [CREDIT_CARD]/[SSN_US]/
// [PHONE_US] across the real output filter, agent `memory_search` (direct + list), the HTTP get/list/
// search/replay routes, AND the realtime redactor; and the round-7/8/9 no-fabrication guarantees + the
// full-width / Arabic-Indic RETAIN coverage + benign multilingual preservation still hold.
// Every sensitive token is assembled from PARTS (no contiguous ASCII PII literal in this file).
// ───────────────────────────────────────────────────────────────────────────────────────────────────

const NOW = "2026-07-18T10:00:00.000Z";
const U3000 = "　"; // ideographic space (guard preserves — non-bridge)

// Map ASCII digits of `ascii` into a decimal-digit block whose DIGIT ZERO is `base`; non-digits pass
// through unchanged. Used to write a benign ASCII PII SHAPE in a cross-script Nd block, from PARTS.
function toScript(base: number, ascii: string): string {
  return [...ascii]
    .map((c) => {
      const code = c.codePointAt(0)!;
      return code >= 0x30 && code <= 0x39 ? String.fromCodePoint(base + (code - 0x30)) : c;
    })
    .join("");
}

// ── Representative PREVIOUSLY-OMITTED Nd blocks (each DIGIT ZERO). Includes the merged-run SECOND block
//    U+116DA (would keep leaking under a predecessor-gap base heuristic). None of these NFKD-folds.
const BLK_GARAY = 0x16130;
const BLK_KAWI = 0x11f50;
const BLK_NAG_MUNDARI = 0x1e4f0;
const BLK_KIRAT_RAI_2ND = 0x116da; // second 0–9 block of the U+116D0–116E3 merged run
const BLK_SUNUWAR = 0x11bf0;
const BLK_OL_ONAL = 0x1e5f1; // note: odd DIGIT-ZERO offset — derivation must not assume even bases
const BLK_10D40 = 0x10d40;
const BLK_16AC0 = 0x16ac0;
const BLK_16D70 = 0x16d70;

// The 10 previously-omitted 0–9 blocks (the merged 20-run counts as two: U+116D0 and U+116DA).
const OMITTED_BASES = [
  BLK_10D40,
  0x116d0,
  BLK_KIRAT_RAI_2ND,
  BLK_SUNUWAR,
  BLK_KAWI,
  BLK_GARAY,
  BLK_16AC0,
  BLK_16D70,
  BLK_NAG_MUNDARI,
  BLK_OL_ONAL,
] as const;

// ── PII SHAPES built from PARTS (proven redactable by the round-9 suite in genuine \p{Nd} form).
const CARD_DIGITS = "4111" + "1111" + "1111" + "1111"; // Luhn-valid Visa test number
const SSN_DIGITS = "123" + "45" + "6789";
const PHONE_TEMPLATE = ["415", "555", "0132"].join("."); // dotted US phone

function scriptCard(base: number): string {
  return toScript(base, CARD_DIGITS);
}
function scriptSsn(base: number): string {
  return toScript(base, SSN_DIGITS);
}
function scriptPhone(base: number): string {
  return toScript(base, PHONE_TEMPLATE);
}

// Representative cross-script fixtures used across the seam surfaces.
const GARAY_CARD = scriptCard(BLK_GARAY);
const KAWI_SSN = scriptSsn(BLK_KAWI);
const NAG_PHONE = scriptPhone(BLK_NAG_MUNDARI);
const KIRAT2_SSN = scriptSsn(BLK_KIRAT_RAI_2ND); // merged-run second block

// ── RETAIN coverage — full-width AND Arabic-Indic real \p{Nd} digit PII (rounds 1–9) still redact.
function toFullwidth(ascii: string): string {
  return toScript(0xff10, ascii);
}
function toArabicIndic(ascii: string): string {
  return toScript(0x0660, ascii);
}
const FW_CARD = toFullwidth(CARD_DIGITS);
const FW_SSN = toFullwidth(SSN_DIGITS);
const AI_CARD = toArabicIndic(CARD_DIGITS);
const AI_SSN = toArabicIndic(SSN_DIGITS);
const PHONE = PHONE_TEMPLATE; // genuine ASCII US phone → [PHONE_US]
const MULTI = "café résumé 日本語 naïve"; // benign multilingual — byte-identical

// ── No-FP anchors (round-7/8/9): a CJK compat symbol must NOT fabricate a joining digit; U+3000 stays.
const SYM_DAY_15 = "㏮"; // U+33EE → "15日" — non-\p{Nd}; must never emit a joining ASCII digit
const DL8 = "1234" + "5678"; // 8 benign digits — not SSN/card/phone alone

const ALL_MARKERS = ["[CREDIT_CARD]", "[SSN_US]", "[PHONE_US]", "[EMAIL]", "[PHONE]"];
function assertNoMarker(s: string): void {
  for (const m of ALL_MARKERS) expect(s).not.toContain(m);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 0 — the shared fold itself: exhaustive runtime-wide \p{Nd} completeness invariant
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Drive the REAL exported fold and capture the detection copy: for a single code point the copy IS its
// fold, so `foldOf(ch)` observes exactly what ASCII (if any) the fold emits — no internal export needed.
function foldOf(s: string): string {
  let captured = "";
  redactUnicodeResistantPii(s, (normalized) => {
    captured = normalized;
    return [];
  });
  return captured;
}

describe("round-10 cross-script \\p{Nd} completeness — shared fold invariant [RED pre-fix]", () => {
  const ND = /\p{Nd}/u;

  it("(invariant) EVERY runtime \\p{Nd} code point folds to its correct ASCII digit 0–9", () => {
    let runStart = -1;
    let prevNd = false;
    let checked = 0;
    const runLengths: number[] = [];
    let curRunLen = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      const isNd = ND.test(String.fromCodePoint(cp));
      if (isNd && !prevNd) {
        runStart = cp;
        curRunLen = 0;
      }
      if (isNd) {
        const expected = String((cp - runStart) % 10);
        expect(foldOf(String.fromCodePoint(cp)), `U+${cp.toString(16)} must fold to ${expected}`).toBe(
          expected,
        );
        checked += 1;
        curRunLen += 1;
      } else if (prevNd) {
        runLengths.push(curRunLen);
      }
      prevNd = isNd;
    }
    // A meaningful chunk of the Unicode digit space was actually swept (76 blocks × 10 in Unicode 16.0).
    expect(checked).toBeGreaterThanOrEqual(640);
    // Each contiguous decimal run is a whole number of ten-digit blocks — the invariant the per-run
    // (cp − runStart) mod 10 value derivation relies on (and that the merged 20-/50-runs satisfy).
    for (const len of runLengths) expect(len % 10, `run length ${len} must be a multiple of 10`).toBe(0);
  });

  it("(previously-omitted blocks) each omitted block's digits 0–9 fold to ASCII 0–9 [RED pre-fix]", () => {
    for (const base of OMITTED_BASES) {
      for (let d = 0; d <= 9; d += 1) {
        expect(foldOf(String.fromCodePoint(base + d)), `U+${(base + d).toString(16)}`).toBe(String(d));
      }
    }
  });

  it("(merged-run second block) U+116DA..U+116E3 folds to 0–9 (not 10–19) [RED pre-fix]", () => {
    for (let d = 0; d <= 9; d += 1) {
      expect(foldOf(String.fromCodePoint(BLK_KIRAT_RAI_2ND + d))).toBe(String(d));
    }
    // ...and a 9-run in that block reads as an SSN shape in the copy.
    expect(redactUnicodeResistantPii(scriptSsn(BLK_KIRAT_RAI_2ND), flagSsnRun)).toBe("[SSN]");
  });

  it("(RETAIN) genuine full-width / Arabic-Indic / Devanagari / math \\p{Nd} still fold to ASCII", () => {
    const genuine = [toFullwidth("7"), toArabicIndic("7"), "१" /* Devanagari 1 */, "\u{1D7CF}" /* math-bold 1 */];
    for (const ch of genuine) expect(redactUnicodeResistantPii(ch, flagAnyDigit)).toBe("[DIGIT]");
  });

  it("(no-FP) a non-\\p{Nd} CJK compat symbol still fabricates NO ASCII digit (round-9 holds)", () => {
    // The round-9 neutralization PRESERVES the source symbol (it is NOT \p{Nd}), so its decomposition's
    // ASCII digits never enter the detection copy — the copy keeps the symbol itself, no digit.
    expect(foldOf(SYM_DAY_15)).toBe(SYM_DAY_15);
    expect(foldOf(SYM_DAY_15)).not.toMatch(/[0-9]/);
    // an 8-digit run + the symbol yields no 9-digit SSN run in the copy
    expect(redactUnicodeResistantPii(DL8 + SYM_DAY_15, flagSsnRun)).toBe(DL8 + SYM_DAY_15);
  });
});

// Detectors used above and by the fold-level assertions.
function flagAnyDigit(normalized: string): UnicodeResistantPiiMatch[] {
  const out: UnicodeResistantPiiMatch[] = [];
  const re = /[0-9]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null)
    out.push({ type: "digit", start: m.index, end: m.index + m[0].length });
  return out;
}
function flagSsnRun(normalized: string): UnicodeResistantPiiMatch[] {
  const m = /\d{9,}/u.exec(normalized);
  return m ? [{ type: "ssn", start: m.index, end: m.index + m[0].length }] : [];
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 1 — shared output filter (content / source / nested metadata / tags) + audit differential
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-10 cross-script \\p{Nd} completeness — shared output filter [RED pre-fix]", () => {
  const filter = createFridayMemoryOutputFilter();
  function item(overrides: Partial<FridayMemoryItem>): FridayMemoryItem {
    return {
      id: "i-1", namespace: "agent", key: "k-1", content: "benign", source: "agent",
      tags: [], metadata: {}, createdAt: NOW, updatedAt: NOW, ...overrides,
    };
  }

  it("(card/ssn/phone across every omitted block) redacts to markers on content/source/nested [RED pre-fix]", () => {
    for (const base of OMITTED_BASES) {
      const out = filter.filterItem(item({
        content: `card ${scriptCard(base)}`,
        source: `ssn ${scriptSsn(base)}`,
        metadata: { top: `phone ${scriptPhone(base)}`, deep: { deeper: scriptCard(base) } },
      }));
      const hex = base.toString(16);
      expect(out.content, hex).toBe("card [CREDIT_CARD]");
      expect(out.source, hex).toBe("ssn [SSN_US]");
      const md = out.metadata as { top: string; deep: { deeper: string } };
      expect(md.top, hex).toBe("phone [PHONE_US]");
      expect(md.deep.deeper, hex).toBe("[CREDIT_CARD]");
    }
  });

  it("(tag) DROPS a cross-script card/ssn tag as PII (round-9 KEEP path is only for benign) [RED pre-fix]", () => {
    const out = filter.filterItem(item({ tags: [GARAY_CARD, "ok", KAWI_SSN, MULTI] }));
    expect(out.tags).toEqual(["ok", MULTI]); // PII-bearing tags removed, benign kept
  });

  it("(audit differential) filter output == guard.redactDeep for a cross-script card/ssn/phone", () => {
    const guard = createFridayMemoryPiiGuard("redact");
    for (const [seam, expected] of [
      [GARAY_CARD, "[CREDIT_CARD]"],
      [KAWI_SSN, "[SSN_US]"],
      [NAG_PHONE, "[PHONE_US]"],
      [KIRAT2_SSN, "[SSN_US]"],
    ] as const) {
      expect(guard.redactDeep(seam).value as string).toBe(expected);
      expect(filter.filterItem(item({ content: seam })).content).toBe(expected);
    }
  });

  it("(RETAIN + benign) full-width/Arabic-Indic still redact; multilingual preserved byte-identical", () => {
    const out = filter.filterItem(item({
      content: `card ${FW_CARD}`,
      source: `ssn ${FW_SSN}`,
      metadata: { aiCard: AI_CARD, aiSsn: AI_SSN, phone: PHONE, bio: MULTI, spaced: DL8 + U3000 + DL8 },
    }));
    expect(out.content).toBe("card [CREDIT_CARD]");
    expect(out.source).toBe("ssn [SSN_US]");
    const md = out.metadata as Record<string, string>;
    expect(md.aiCard).toBe("[CREDIT_CARD]");
    expect(md.aiSsn).toBe("[SSN_US]");
    expect(md.phone).toBe("[PHONE_US]");
    expect(md.bio).toBe(MULTI);
    expect(md.spaced).toBe(DL8 + U3000 + DL8); // U+3000 non-bridge preserved (no false marker)
    assertNoMarker(md.bio);
    assertNoMarker(md.spaced);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 2 — HTTP memory routes (get / list / search / idempotency-replay)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-10 cross-script \\p{Nd} completeness — HTTP memory routes [RED pre-fix]", () => {
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
  function httpResult(it: FridayMemoryItem, score = 0.9): FridayMemorySearchResult {
    return { item: it, score, ftsScore: score, semanticScore: score, matchedBy: ["fts"], snippet: it.content.slice(0, 200) };
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

  it("(get) redacts a Garay card in content/nested-metadata/tag [RED pre-fix]", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({ id: "u", content: `card ${GARAY_CARD}`, metadata: { deep: { n: KAWI_SSN } }, tags: [NAG_PHONE, "ok"] }),
    );
    const res = (await findRoute("memory.get").handler(makeCtx({ params: { id: "u" } }))) as { item: FridayMemoryItem };
    expect(res.item.content).toBe("card [CREDIT_CARD]");
    expect((res.item.metadata as { deep: { n: string } }).deep.n).toBe("[SSN_US]");
    expect(res.item.tags).toEqual(["ok"]); // PII tag dropped, benign kept
    assertNoMarker(GARAY_CARD); // (self-check: the raw script card carries no ASCII marker)
    expect(JSON.stringify(res)).not.toContain(GARAY_CARD); // no verbatim leak
  });

  it("(list) redacts cross-script rows; benign multilingual row preserved [RED pre-fix]", async () => {
    (memoryService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ id: "r-pii", content: `card ${GARAY_CARD}`, metadata: { c: KIRAT2_SSN } }),
      makeItem({ id: "r-benign", content: MULTI, metadata: { a: DL8 + U3000 + DL8 } }),
    ]);
    const res = (await findRoute("memory.list").handler(makeCtx())) as { items: FridayMemoryItem[] };
    const byId = (id: string) => res.items.find((i) => i.id === id)!;
    expect(byId("r-pii").content).toBe("card [CREDIT_CARD]");
    expect((byId("r-pii").metadata as { c: string }).c).toBe("[SSN_US]");
    expect(byId("r-benign").content).toBe(MULTI);
    expect((byId("r-benign").metadata as { a: string }).a).toBe(DL8 + U3000 + DL8);
  });

  it("(search) redacts a Nag-Mundari phone in content [RED pre-fix]", async () => {
    (memoryService.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      httpResult(makeItem({ id: "s", content: `call ${NAG_PHONE}` })),
    ]);
    const res = (await findRoute("memory.search").handler(makeCtx({ body: { query: "x" } }))) as {
      items: FridayMemorySearchResult[];
    };
    expect(res.items.find((r) => r.item.id === "s")!.item.content).toBe("call [PHONE_US]");
    expect(JSON.stringify(res)).not.toContain(NAG_PHONE);
  });

  it("(store idempotency-replay) redacts a Kawi SSN in content [RED pre-fix]", async () => {
    replayItem = makeItem({ id: "m-replay", content: `ssn ${KAWI_SSN}` });
    const res = (await findRoute("memory.store").handler(
      makeCtx({ body: { namespace: "default", content: "benign note" }, headers: { "idempotency-key": "idem-1" } }),
    )) as { item: FridayMemoryItem };
    expect(res.item.content).toBe("ssn [SSN_US]");
    expect(JSON.stringify(res)).not.toContain(KAWI_SSN);
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
function agentResult(it: FridayMemoryItem, score: number): FridayMemorySearchResult {
  return { item: it, score, ftsScore: score, semanticScore: score, matchedBy: ["fts"], snippet: it.content.slice(0, 200) };
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

describe("round-10 cross-script \\p{Nd} completeness — agent memory_search [RED pre-fix]", () => {
  it("(direct) redacts a Garay card in content + DROPS a Kawi-SSN tag; benign multilingual kept", async () => {
    const piiRow = agentItem({
      id: "pii", content: `status card ${GARAY_CARD} note`, tags: [KAWI_SSN, "keep"],
    });
    const benignRow = agentItem({ id: "benign", content: MULTI, tags: [MULTI] });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(piiRow, 0.9), agentResult(benignRow, 0.5)] }),
    });
    const res = await searchTool!.execute({ query: "status" }, signalWithPrincipal("user-1"));
    expect(res.isError).toBeUndefined();
    const rows = parseAgent(res.content);
    const pii = rows.find((r) => r.metadata.id === "pii")!;
    const benign = rows.find((r) => r.metadata.id === "benign")!;
    expect(pii.content).toBe("status card [CREDIT_CARD] note");
    expect(pii.metadata.tags).toEqual(["keep"]); // PII tag dropped
    expect(benign.content).toBe(MULTI);
    expect(benign.metadata.tags).toEqual([MULTI]);
    expect(res.content).not.toContain(GARAY_CARD);
    expect(res.content).not.toContain(KAWI_SSN);
  });

  it("(list leg) redacts a merged-run Kirat-Rai SSN on the session lexical fallback", async () => {
    const piiRow = agentItem({ id: "l", content: `profile ssn ${KIRAT2_SSN} entry` });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [], list: [piiRow] }),
      resolveSessionMemoryNamespace: async () => "sess-abc",
    });
    const res = await searchTool!.execute({ query: "profile" }, signalWithPrincipal("user-1", "sess-123"));
    expect(res.isError).toBeUndefined();
    const row = parseAgent(res.content).find((r) => r.metadata.id === "l");
    expect(row, "list-leg row should be present").toBeDefined();
    expect(row!.content).toBe("profile ssn [SSN_US] entry");
    expect(res.content).not.toContain(KIRAT2_SSN);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 4 — realtime `redactEventPayload` (the shared fold's OTHER consumer)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-10 cross-script \\p{Nd} completeness — realtime redactEventPayload [RED pre-fix]", () => {
  it("(card/ssn/phone across omitted blocks) redacts in content/nested fields [RED pre-fix]", () => {
    for (const base of OMITTED_BASES) {
      const out = redactEventPayload({
        note: `value ${scriptCard(base)} ok`,
        nested: { deep: scriptSsn(base), phone: scriptPhone(base) },
      }) as { note: string; nested: { deep: string; phone: string } };
      const hex = base.toString(16);
      expect(out.note, hex).toBe("value [CREDIT_CARD] ok");
      expect(out.nested.deep, hex).toBe("[SSN_US]");
      expect(out.nested.phone, hex).toBe("[PHONE_US]");
    }
  });

  it("(RETAIN) realtime still redacts genuine full-width + Arabic-Indic card/SSN; multilingual preserved", () => {
    const out = redactEventPayload({
      a: `card ${FW_CARD}`, b: FW_SSN, c: AI_CARD, d: AI_SSN, e: PHONE, bio: MULTI, spaced: DL8 + U3000 + DL8,
    }) as Record<string, string>;
    expect(out.a).toBe("card [CREDIT_CARD]");
    expect(out.b).toBe("[SSN_US]");
    expect(out.c).toBe("[CREDIT_CARD]");
    expect(out.d).toBe("[SSN_US]");
    expect(out.e).toBe("[PHONE_US]");
    expect(out.bio).toBe(MULTI);
    expect(out.spaced).toBe(DL8 + U3000 + DL8);
  });
});
