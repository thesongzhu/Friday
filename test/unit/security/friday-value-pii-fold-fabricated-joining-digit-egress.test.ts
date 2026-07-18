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

// ─── SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 round-9 — FABRICATED-JOINING-DIGIT FALSE-POSITIVE CLASS ──
// The symmetric partner of the round-7 fabricated-SEPARATOR bug. The SHARED value-PII preserving fold
// (`src/security/friday-value-pii-fold.ts`) builds its detection copy via NFKD → strip \p{M} →
// strip Cf/Default_Ignorable → fold \p{Nd}. Round-7 stopped a source that is NOT itself a matcher
// separator from FABRICATING a digit-group-BRIDGE separator. The MIRROR IMAGE it missed: a source that
// is NOT itself a `\p{Nd}` decimal digit but whose NFKD DECOMPOSITION CONTRIBUTES an ASCII DIGIT.
// ~80 CJK compatibility symbols decompose to digit-bearing strings whose ASCII digits JOIN / EXTEND an
// adjacent BENIGN digit run to complete a card / SSN / phone shape (SSN & phone have NO Luhn gate, so a
// single joined digit is enough):
//   • enclosed months ㋀–㋋ (U+32C0–32CB → "1月".."12月")   — fold begins with a digit → joins a PRECEDING run
//   • telegraph hours ㍘–㍰ (U+3358–3370 → "0点".."24点")   — digit-leading → joins a PRECEDING run
//   • date days ㏠–㏾ (U+33E0–33FE → "1日".."31日")         — digit-leading → joins a PRECEDING run
//   • squared unit symbols ㎟/㎠/㎡/… (→ "mm2"/"m2"/…)      — digit inside the fold (whole class at fold level)
// e.g. "1234567㏮" → detection copy "1234567" + "15日" → false `[SSN_US]`; a 15-digit non-card run + "1日"
// → a 16-digit Luhn-valid card → false `[CREDIT_CARD]`; "415.555.013㏠" → "415.555.0131" → `[PHONE_US]`. So
// BENIGN CJK date/time/measurement content in memory is corrupted to a false marker on read-back.
//
// The ROOT fix neutralizes the WHOLE class by a GENERAL rule (symmetric to the bridge rule): the fold
// may put an ASCII DIGIT in the detection copy ONLY when the SOURCE code point IS a Unicode decimal
// digit (`\p{Nd}`). Any non-`\p{Nd}` source whose fold would emit an ASCII digit is PRESERVED unchanged,
// so in the copy it stays a single non-digit character that can neither JOIN nor EXTEND an adjacent run.
//
// Every benign input is PRESERVED BYTE-IDENTICAL (NOT a marker) across the real output filter, agent
// `memory_search` (direct + list), the HTTP get/list/search/idempotency-replay routes, the realtime
// `redactEventPayload`, AND equals the shared `guard.redactDeep` output (audit differential). RED
// pre-fix (corrupted to a marker). RETAINED: genuine full-width (FF10–FF19) AND cross-script Arabic-
// Indic digit card/SSN/phone STILL redact full-span; No/Nl + U+3000 non-bridge + multilingual preserved.
// Every sensitive token is assembled from PARTS (no contiguous PII literal in this file).
// ───────────────────────────────────────────────────────────────────────────────────────────────────

const NOW = "2026-07-18T10:00:00.000Z";
const U3000 = "　"; // ideographic space (guard preserves — non-bridge)

// ── CJK compatibility digit-fabricators (each NFKD contributes an ASCII digit; none is \p{Nd}).
const SYM_DAY_1 = "㏠"; // U+33E0 → "1日"  (digit-leading → joins a PRECEDING run)
const SYM_HOUR_0 = "㍘"; // U+3358 → "0点"
const SYM_MON_1 = "㋀"; // U+32C0 → "1月"
const SYM_D15 = "㏮"; // U+33EE → "15日"  (finding example)
const SYM_H10 = "㍢"; // U+3362 → "10点"  (finding example)

// ── Benign fixtures. Each LEADING run is NOT PII on its own (8 digits < SSN's 9, 15 digits fails card
//    Luhn, a 3-digit phone tail < 4); pre-fix the symbol's digit JOINS it into a false marker.
const DL8 = "1234" + "5678"; // 8 benign digits (not SSN/card/phone alone) — from parts
const DL7 = "123" + "4567"; // 7 benign digits
function benignSsn(sym: string): string {
  return DL8 + sym; // 8-digit run + digit-leading symbol → 9-digit SSN shape in the copy (pre-fix)
}
const BENIGN_SSN_DAY = benignSsn(SYM_DAY_1); // "12345678㏠"
const BENIGN_SSN_HOUR = benignSsn(SYM_HOUR_0); // "12345678㍘"
const BENIGN_SSN_MONTH = benignSsn(SYM_MON_1); // "12345678㋀"
const BENIGN_SSN_D15 = DL7 + SYM_D15; // "1234567㏮"  (finding → "123456715日" → SSN)
const BENIGN_SSN_H10 = "111111" + "2" + SYM_H10; // "1111112㍢" (finding → "111111210点" → SSN)
// 15-digit run that FAILS card Luhn alone; "1日" appends the 16th digit → Luhn-valid card (pre-fix).
const CARD15 = "4" + "1".repeat(14); // 15 digits, NOT a card on its own
const BENIGN_CARD_DAY = CARD15 + SYM_DAY_1; // 15-digit run + "1日" → 16-digit card in the copy
// "415.555.013" is a 3-digit phone tail (< 4); "1日" appends the 4th digit → phone (pre-fix).
const BENIGN_PHONE_DAY = ["415", "555", "013"].join(".") + SYM_DAY_1;

const ALL_JOIN_BENIGN: Array<[string, string]> = [
  ["ssn/day ㏠", BENIGN_SSN_DAY],
  ["ssn/hour ㍘", BENIGN_SSN_HOUR],
  ["ssn/month ㋀", BENIGN_SSN_MONTH],
  ["ssn/finding ㏮", BENIGN_SSN_D15],
  ["ssn/finding ㍢", BENIGN_SSN_H10],
  ["card/day ㏠", BENIGN_CARD_DAY],
  ["phone/day ㏠", BENIGN_PHONE_DAY],
];

// ── RETAINED coverage — genuine full-width AND cross-script real \p{Nd} digit PII (must STILL redact).
function toFullwidth(ascii: string): string {
  return [...ascii]
    .map((c) => {
      const code = c.codePointAt(0)!;
      return code >= 0x21 && code <= 0x7e ? String.fromCodePoint(code + 0xfee0) : c;
    })
    .join("");
}
function toArabicIndic(ascii: string): string {
  return [...ascii]
    .map((c) => {
      const code = c.codePointAt(0)!;
      return code >= 0x30 && code <= 0x39 ? String.fromCodePoint(0x0660 + (code - 0x30)) : c;
    })
    .join("");
}
const FW_SSN = toFullwidth("123") + toFullwidth("45") + toFullwidth("6789"); // full-width SSN → [SSN_US]
const FW_CARD = toFullwidth("4111" + "1111" + "1111" + "1111"); // full-width card → [CREDIT_CARD]
const AI_SSN = toArabicIndic("123") + toArabicIndic("45") + toArabicIndic("6789"); // Arabic-Indic → [SSN_US]
const AI_CARD = toArabicIndic("4111" + "1111" + "1111" + "1111"); // Arabic-Indic card → [CREDIT_CARD]
const PHONE = ["415", "555", "0132"].join("."); // genuine US phone → [PHONE_US]
const MULTI = "café résumé 日本語 naïve"; // benign multilingual — byte-identical

const ALL_MARKERS = ["[CREDIT_CARD]", "[SSN_US]", "[PHONE_US]", "[EMAIL]", "[PHONE]"];
function assertNoMarker(s: string): void {
  for (const m of ALL_MARKERS) expect(s).not.toContain(m);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 0 — the shared fold itself (whole-class proof over the exported redactUnicodeResistantPii)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A detector that flags EVERY ASCII-digit run in the detection copy. Driven through the real exported
// `redactUnicodeResistantPii`, it turns "did the fold put an ASCII digit in the copy?" into observable
// output: a fabricated digit → `[DIGIT]`; a preserved non-digit source → byte-identical.
function flagAnyDigit(normalized: string): UnicodeResistantPiiMatch[] {
  const out: UnicodeResistantPiiMatch[] = [];
  const re = /[0-9]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) out.push({ type: "digit", start: m.index, end: m.index + m[0].length });
  return out;
}
// A detector that flags only a 9+-digit CONTIGUOUS run (SSN-shaped) — proves the JOIN closure directly.
function flagSsnRun(normalized: string): UnicodeResistantPiiMatch[] {
  const m = /\d{9,}/u.exec(normalized);
  return m ? [{ type: "ssn", start: m.index, end: m.index + m[0].length }] : [];
}

describe("round-9 fabricated-joining-digit — shared fold whole-class [RED pre-fix]", () => {
  const ND = /\p{Nd}/u;

  it("(class) EVERY non-\\p{Nd} source in U+3200–33FF fabricates NO ASCII digit — preserved byte-identical", () => {
    let checked = 0;
    for (let cp = 0x3200; cp <= 0x33ff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      if (ND.test(ch)) continue; // a genuine decimal digit legitimately folds — not this class
      checked += 1;
      expect(redactUnicodeResistantPii(ch, flagAnyDigit), `U+${cp.toString(16)} must fabricate no digit`).toBe(ch);
    }
    expect(checked).toBeGreaterThan(200); // the whole CJK enclosed/compat block was actually swept
  });

  it("(class named) the finding's month/hour/day/unit symbols emit no ASCII digit into the copy", () => {
    for (const ch of [SYM_MON_1, SYM_HOUR_0, SYM_DAY_1, SYM_D15, SYM_H10, "㎟", "㎠", "㎡", "㋋", "㍰", "㏾"]) {
      expect(redactUnicodeResistantPii(ch, flagAnyDigit)).toBe(ch);
    }
  });

  it("(no JOIN) a benign 8-digit run + digit-leading symbol yields NO 9-digit run in the copy", () => {
    for (const sym of [SYM_DAY_1, SYM_HOUR_0, SYM_MON_1]) {
      expect(redactUnicodeResistantPii(DL8 + sym, flagSsnRun)).toBe(DL8 + sym);
    }
  });

  it("(RETAIN) genuine \\p{Nd} digits STILL fold to ASCII in the copy (real-digit PII coverage)", () => {
    // A single genuine decimal digit (full-width / Arabic-Indic / Devanagari / math-bold) → the copy has
    // an ASCII digit → flagged → redacted. Proves the fix did NOT suppress legitimate digit folding.
    const genuine = [toFullwidth("7"), toArabicIndic("7"), "१" /* Devanagari 1 */, "\u{1D7CF}" /* math-bold 1 */];
    for (const ch of genuine) expect(redactUnicodeResistantPii(ch, flagAnyDigit)).toBe("[DIGIT]");
    // and a genuine 9-run of full-width / Arabic-Indic digits is still a 9-run in the copy
    expect(redactUnicodeResistantPii(FW_SSN, flagSsnRun)).toBe("[SSN]");
    expect(redactUnicodeResistantPii(AI_SSN, flagSsnRun)).toBe("[SSN]");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 1 — shared output filter (content / source / nested metadata / tags) + audit differential
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-9 fabricated-joining-digit — shared output filter (no false positive) [RED pre-fix]", () => {
  const filter = createFridayMemoryOutputFilter();
  function item(overrides: Partial<FridayMemoryItem>): FridayMemoryItem {
    return {
      id: "i-1", namespace: "agent", key: "k-1", content: "benign", source: "agent",
      tags: [], metadata: {}, createdAt: NOW, updatedAt: NOW, ...overrides,
    };
  }

  for (const [name, benign] of ALL_JOIN_BENIGN) {
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

  it("(tag) KEEPS a benign joining-digit tag (never dropped as PII) [RED pre-fix]", () => {
    const tags = [BENIGN_SSN_D15, BENIGN_CARD_DAY, "ok", MULTI, U3000 + "ok"];
    const out = filter.filterItem(item({ tags }));
    expect(out.tags).toEqual(tags);
  });

  it("(audit differential) filter output == guard.redactDeep == benign input byte-identical", () => {
    const guard = createFridayMemoryPiiGuard("redact");
    for (const [, benign] of ALL_JOIN_BENIGN) {
      expect(guard.redactDeep(benign).value as string).toBe(benign);
      expect(filter.filterItem(item({ content: benign })).content).toBe(benign);
    }
  });

  it("(RETAIN) genuine full-width + cross-script Arabic-Indic card/SSN/phone STILL redact full-span", () => {
    const out = filter.filterItem(item({
      content: `card ${FW_CARD}`,
      source: `ssn ${FW_SSN}`,
      metadata: { aiCard: AI_CARD, aiSsn: AI_SSN, phone: PHONE, bio: MULTI },
    }));
    expect(out.content).toBe("card [CREDIT_CARD]");
    expect(out.source).toBe("ssn [SSN_US]");
    const md = out.metadata as Record<string, string>;
    expect(md.aiCard).toBe("[CREDIT_CARD]");
    expect(md.aiSsn).toBe("[SSN_US]");
    expect(md.phone).toBe("[PHONE_US]");
    expect(md.bio).toBe(MULTI); // multilingual preserved
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 2 — HTTP memory routes (get / list / search / idempotency-replay)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-9 fabricated-joining-digit — HTTP memory routes (no false positive) [RED pre-fix]", () => {
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

  it("(get) preserves benign joining-digit content/metadata/tag", async () => {
    (memoryService.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeItem({ id: "u", content: BENIGN_SSN_D15, metadata: { deep: { n: BENIGN_CARD_DAY } }, tags: [BENIGN_SSN_D15, "ok"] }),
    );
    const res = (await findRoute("memory.get").handler(makeCtx({ params: { id: "u" } }))) as { item: FridayMemoryItem };
    expect(res.item.content).toBe(BENIGN_SSN_D15);
    expect((res.item.metadata as { deep: { n: string } }).deep.n).toBe(BENIGN_CARD_DAY);
    expect(res.item.tags).toEqual([BENIGN_SSN_D15, "ok"]);
    assertNoMarker(JSON.stringify(res));
  });

  it("(list) preserves benign across rows; still redacts a genuine full-width card row", async () => {
    (memoryService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ id: "r-benign", content: BENIGN_SSN_HOUR, metadata: { a: BENIGN_PHONE_DAY } }),
      makeItem({ id: "r-pii", content: `card ${FW_CARD}`, metadata: { c: AI_SSN } }),
    ]);
    const res = (await findRoute("memory.list").handler(makeCtx())) as { items: FridayMemoryItem[] };
    const byId = (id: string) => res.items.find((i) => i.id === id)!;
    expect(byId("r-benign").content).toBe(BENIGN_SSN_HOUR);
    expect((byId("r-benign").metadata as { a: string }).a).toBe(BENIGN_PHONE_DAY);
    expect(byId("r-pii").content).toBe("card [CREDIT_CARD]");
    expect((byId("r-pii").metadata as { c: string }).c).toBe("[SSN_US]");
  });

  it("(search) preserves benign joining-digit content", async () => {
    (memoryService.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      httpResult(makeItem({ id: "s", content: BENIGN_PHONE_DAY })),
    ]);
    const res = (await findRoute("memory.search").handler(
      makeCtx({ body: { query: "x" } }),
    )) as { items: FridayMemorySearchResult[] };
    expect(res.items.find((r) => r.item.id === "s")!.item.content).toBe(BENIGN_PHONE_DAY);
    assertNoMarker(JSON.stringify(res));
  });

  it("(store idempotency-replay) preserves benign joining-digit content", async () => {
    replayItem = makeItem({ id: "m-replay", content: BENIGN_CARD_DAY });
    const res = (await findRoute("memory.store").handler(
      makeCtx({ body: { namespace: "default", content: "benign note" }, headers: { "idempotency-key": "idem-1" } }),
    )) as { item: FridayMemoryItem };
    expect(res.item.content).toBe(BENIGN_CARD_DAY);
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

describe("round-9 fabricated-joining-digit — agent memory_search (no false positive) [RED pre-fix]", () => {
  it("(direct) preserves benign content + KEEPS benign tag; still redacts a genuine card row", async () => {
    const benignRow = agentItem({
      id: "benign", content: `status ${BENIGN_SSN_D15} note`, tags: [BENIGN_SSN_D15, "keep"],
    });
    const piiRow = agentItem({ id: "pii", content: `status card ${FW_CARD}`, tags: [] });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [agentResult(benignRow, 0.9), agentResult(piiRow, 0.5)] }),
    });
    const res = await searchTool!.execute({ query: "status" }, signalWithPrincipal("user-1"));
    expect(res.isError).toBeUndefined();
    const rows = parseAgent(res.content);
    const benign = rows.find((r) => r.metadata.id === "benign")!;
    const pii = rows.find((r) => r.metadata.id === "pii")!;
    expect(benign.content).toBe(`status ${BENIGN_SSN_D15} note`);
    expect(benign.metadata.tags).toEqual([BENIGN_SSN_D15, "keep"]);
    expect(pii.content).toBe("status card [CREDIT_CARD]");
  });

  it("(list leg) preserves benign joining-digit content on the session lexical fallback", async () => {
    const benignRow = agentItem({ id: "l", content: `profile ${BENIGN_SSN_HOUR} entry` });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: agentMock({ search: [], list: [benignRow] }),
      resolveSessionMemoryNamespace: async () => "sess-abc",
    });
    const res = await searchTool!.execute({ query: "profile" }, signalWithPrincipal("user-1", "sess-123"));
    expect(res.isError).toBeUndefined();
    const row = parseAgent(res.content).find((r) => r.metadata.id === "l");
    expect(row, "list-leg row should be present").toBeDefined();
    expect(row!.content).toBe(`profile ${BENIGN_SSN_HOUR} entry`);
    assertNoMarker(res.content);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SURFACE 4 — realtime `redactEventPayload` (the shared fold's OTHER consumer)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("round-9 fabricated-joining-digit — realtime redactEventPayload (no false positive) [RED pre-fix]", () => {
  for (const [name, benign] of ALL_JOIN_BENIGN) {
    it(`(${name}) preserves benign digit run byte-identical in a content field`, () => {
      const out = redactEventPayload({ note: `value ${benign} ok`, nested: { deep: benign } }) as {
        note: string; nested: { deep: string };
      };
      expect(out.note).toBe(`value ${benign} ok`);
      expect(out.nested.deep).toBe(benign);
      assertNoMarker(JSON.stringify(out));
    });
  }

  it("(RETAIN) realtime still redacts genuine full-width + Arabic-Indic card/SSN/phone", () => {
    const out = redactEventPayload({
      a: `card ${FW_CARD}`, b: FW_SSN, c: AI_CARD, d: AI_SSN, e: PHONE,
    }) as Record<string, string>;
    expect(out.a).toBe("card [CREDIT_CARD]");
    expect(out.b).toBe("[SSN_US]");
    expect(out.c).toBe("[CREDIT_CARD]");
    expect(out.d).toBe("[SSN_US]");
    expect(out.e).toBe("[PHONE_US]");
  });

  it("(RETAIN) realtime preserves U+3000/multilingual byte-identical", () => {
    const out = redactEventPayload({ spaced: DL8 + U3000 + DL8, bio: MULTI }) as { spaced: string; bio: string };
    expect(out.spaced).toBe(DL8 + U3000 + DL8);
    expect(out.bio).toBe(MULTI);
  });
});
