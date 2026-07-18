import { describe, it, expect } from "vitest";
import { createFridayMemoryOutputFilter } from "#memory";
import {
  FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS,
  FRIDAY_MEMORY_GUARD_MAX_RESULT_SNIPPET_CHARS,
  FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS,
} from "#memory";
import type { FridayMemoryItem, FridayMemorySearchResult } from "#memory";

const NOW = "2026-02-18T10:00:00.000Z";

function makeItem(overrides?: Partial<FridayMemoryItem>): FridayMemoryItem {
  return {
    id: "item-1",
    namespace: "test",
    key: "key-1",
    content: "Hello world",
    source: "system",
    tags: [],
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSearchResult(overrides?: Partial<FridayMemorySearchResult>): FridayMemorySearchResult {
  return {
    item: makeItem(),
    score: 0.9,
    ftsScore: 0.8,
    semanticScore: 1.0,
    matchedBy: ["fts"],
    snippet: "Hello world",
    ...overrides,
  };
}

describe("FridayMemoryOutputFilter", () => {
  const filter = createFridayMemoryOutputFilter();

  // ─── filterItem ───

  it("returns item as-is when content is within limit", () => {
    const item = makeItem({ content: "short" });
    const filtered = filter.filterItem(item);
    expect(filtered.content).toBe("short");
  });

  it("truncates item content to max chars", () => {
    const longContent = "x".repeat(FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS + 100);
    const item = makeItem({ content: longContent });
    const filtered = filter.filterItem(item);
    expect(filtered.content.length).toBe(FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS);
  });

  it("preserves other item fields", () => {
    const item = makeItem({ id: "special", tags: ["t1", "t2"] });
    const filtered = filter.filterItem(item);
    expect(filtered.id).toBe("special");
    expect(filtered.tags).toEqual(["t1", "t2"]);
  });

  it("redacts PII from item content before returning it", () => {
    const item = makeItem({ content: "Email user@example.com and SSN 123-45-6789" });
    const filtered = filter.filterItem(item);
    expect(filtered.content).toContain("[EMAIL]");
    expect(filtered.content).toContain("[SSN_US]");
    expect(filtered.content).not.toContain("user@example.com");
    expect(filtered.content).not.toContain("123-45-6789");
  });

  it("redacts PII in item metadata and drops PII-bearing tags on read-back", () => {
    const item = makeItem({
      metadata: { note: "reach me at owner@example.com", count: 3, nested: { ssn: "SSN 123-45-6789" } },
      tags: ["keep-me", "123-45-6789"], // 2nd tag is an SSN-pattern (charset-valid)
    });
    const filtered = filter.filterItem(item);
    const meta = filtered.metadata as { note: string; count: number; nested: { ssn: string } };
    expect(meta.note).toContain("[EMAIL]");
    expect(meta.note).not.toContain("owner@example.com");
    expect(meta.nested.ssn).toContain("[SSN_US]"); // nested redaction
    expect(meta.count).toBe(3); // non-string untouched
    expect(filtered.tags).toContain("keep-me"); // clean tag kept
    expect(filtered.tags).not.toContain("123-45-6789"); // PII-bearing tag dropped
  });

  // Advisor round 3 — output-filter read-back seam: a FULL-WIDTH pure-numeric metadata KEY is a
  // benign business id and must be preserved byte-identical, not folded + renamed to [CREDIT_CARD].
  it("preserves a FULL-WIDTH pure-numeric metadata KEY on read-back (not renamed to [CREDIT_CARD]) [red-first]", () => {
    const fullwidthKey = "４１１１１１１１１１１１１１１１"; // toFullwidth("4111111111111111") used as a KEY
    const item = makeItem({ metadata: { [fullwidthKey]: "canonical-marker" } });
    const filtered = filter.filterItem(item);
    const meta = filtered.metadata as Record<string, unknown>;
    expect(Object.keys(meta)).toContain(fullwidthKey); // preserved
    expect(Object.keys(meta)).not.toContain("[CREDIT_CARD]");
    expect(meta[fullwidthKey]).toBe("canonical-marker");
  });

  // ─── filterSearchResults ───

  it("returns results as-is when within limits", () => {
    const results = [makeSearchResult()];
    const filtered = filter.filterSearchResults(results);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].snippet).toBe("Hello world");
  });

  it("caps results to max search results", () => {
    const results = Array.from({ length: FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS + 10 }, (_, i) =>
      makeSearchResult({ item: makeItem({ id: `item-${i}` }) }),
    );
    const filtered = filter.filterSearchResults(results);
    expect(filtered).toHaveLength(FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS);
  });

  it("truncates snippet to max snippet chars", () => {
    const longSnippet = "y".repeat(FRIDAY_MEMORY_GUARD_MAX_RESULT_SNIPPET_CHARS + 50);
    const results = [makeSearchResult({ snippet: longSnippet })];
    const filtered = filter.filterSearchResults(results);
    expect(filtered[0].snippet.length).toBe(FRIDAY_MEMORY_GUARD_MAX_RESULT_SNIPPET_CHARS);
  });

  it("truncates result item content", () => {
    const longContent = "z".repeat(FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS + 50);
    const results = [makeSearchResult({ item: makeItem({ content: longContent }) })];
    const filtered = filter.filterSearchResults(results);
    expect(filtered[0].item.content.length).toBe(FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS);
  });

  it("redacts PII from search result content and snippets", () => {
    const results = [makeSearchResult({
      item: makeItem({ content: "Card 4111 1111 1111 1111 belongs elsewhere" }),
      snippet: "Call 415-555-1212 about user@example.com",
    })];
    const filtered = filter.filterSearchResults(results);
    expect(filtered[0].item.content).toContain("[CREDIT_CARD]");
    expect(filtered[0].item.content).not.toContain("4111 1111 1111 1111");
    expect(filtered[0].snippet).toContain("[PHONE_US]");
    expect(filtered[0].snippet).toContain("[EMAIL]");
    expect(filtered[0].snippet).not.toContain("user@example.com");
  });

  it("redacts a FULL-WIDTH credit card on the egress read path (filterItem)", () => {
    // Full-width digits (U+FF10–FF19) previously bypassed the ASCII-only regex and leaked
    // through the live GET /v1/memory/items(/:id) + POST /v1/memory/search read path.
    const fullwidthCard = "４１１１１１１１１１１１１１１１"; // toFullwidth("4111111111111111"), Luhn-valid
    const item = makeItem({ content: `カード番号は${fullwidthCard}です` });
    const filtered = filter.filterItem(item);
    expect(filtered.content).toContain("[CREDIT_CARD]");
    expect(filtered.content).not.toContain(fullwidthCard);
    expect(filtered.content).toBe("カード番号は[CREDIT_CARD]です");
  });

  it("redacts a FULL-WIDTH credit card in search result content and snippet (filterSearchResults)", () => {
    const fullwidthCard = "４１１１１１１１１１１１１１１１";
    const results = [makeSearchResult({
      item: makeItem({ content: `card ${fullwidthCard}` }),
      snippet: `snippet ${fullwidthCard}`,
    })];
    const filtered = filter.filterSearchResults(results);
    expect(filtered[0].item.content).toContain("[CREDIT_CARD]");
    expect(filtered[0].item.content).not.toContain(fullwidthCard);
    expect(filtered[0].snippet).toContain("[CREDIT_CARD]");
    expect(filtered[0].snippet).not.toContain(fullwidthCard);
  });

  it("preserves score and matchedBy", () => {
    const results = [makeSearchResult({ score: 0.95, matchedBy: ["fts", "semantic"] })];
    const filtered = filter.filterSearchResults(results);
    expect(filtered[0].score).toBe(0.95);
    expect(filtered[0].matchedBy).toEqual(["fts", "semantic"]);
  });

  it("handles empty results array", () => {
    const filtered = filter.filterSearchResults([]);
    expect(filtered).toHaveLength(0);
  });

  // ─── memory-egress blast radius (PRIV-UNICODE-REDACTION-001 round-10) ───
  //
  // The shared guard's key-name canonicalization also governs MEMORY egress (this filter calls
  // `redactDeep` on item.metadata and on learned-fact values). A numeric/bigint PII value under a
  // Unicode-OBFUSCATED PII-context metadata key leaked RAW on read-back before round-10; it is now
  // redacted. NO-DEGRADE: benign metadata (ASCII keys, benign numerics, structure) round-trips
  // unchanged, so the egress path is a strict superset with zero benign divergence.
  describe("Unicode-obfuscated metadata KEY (egress redactDeep)", () => {
    const ZW_PHONE_KEY = "ph​one"; // U+200B zero-width space
    const FW_SSN_KEY = "ｓｓｎ"; // full-width `ssn`

    it("redacts a numeric phone under a zero-width-spliced metadata key on filterItem (egress)", () => {
      const item = makeItem({ metadata: { [ZW_PHONE_KEY]: 14155552671 } });
      const filtered = filter.filterItem(item);
      expect(filtered.metadata[ZW_PHONE_KEY]).toBe("[PHONE_US]");
      expect(Object.keys(filtered.metadata)).toContain(ZW_PHONE_KEY); // key bytes preserved
    });

    it("redacts a bigint SSN under a full-width metadata key on a learned-fact value (egress)", () => {
      const redacted = filter.redactLearnedFactValue({ [FW_SSN_KEY]: 123456789n }) as Record<string, unknown>;
      expect(redacted[FW_SSN_KEY]).toBe("[SSN_US]");
    });

    it("NO-DEGRADE: benign metadata (ASCII keys + benign numerics + near-miss) round-trips unchanged", () => {
      const metadata = {
        phone_count: 14155552671, // benign: `count` is the final token
        "iph​one": 42, // ZW → `iphone` ≠ `phone`
        order_id: 5552345678, // benign business id under non-sensitive key
        note: "clean",
      };
      const filtered = filter.filterItem(makeItem({ metadata: { ...metadata } }));
      expect(filtered.metadata).toEqual(metadata);
    });
  });

  // ─── memory-egress key-CONTENT PII (PRIV-UNICODE-REDACTION-001 round-11) ───
  //
  // The guard's key-CONTENT redactor (`redactKey`) governs MEMORY egress too (this filter calls
  // `redactDeep` on item.metadata). A metadata KEY STRING that is itself PII, Unicode-obfuscated so
  // the raw ASCII (+ full-width-digit) matcher missed it (a zero-width-split email / Arabic-Indic SSN
  // used AS A KEY), persisted RAW on read-back before round-11; it is now redacted to its marker. The
  // VALUE is preserved. NO-DEGRADE: benign multilingual keys + ALL-Nd business-id keys round-trip
  // byte-identical (a strict superset, zero benign divergence).
  describe("Unicode-obfuscated key-CONTENT PII metadata KEY (egress redactDeep)", () => {
    it("redacts a zero-width-split EMAIL metadata KEY STRING on filterItem (egress); value preserved", () => {
      const emailKey = "victim@examp​le.com"; // U+200B in domain
      const item = makeItem({ metadata: { [emailKey]: "note-value" } });
      const filtered = filter.filterItem(item);
      const meta = filtered.metadata as Record<string, unknown>;
      expect(Object.keys(meta)).not.toContain(emailKey); // raw obfuscated key gone
      expect(Object.keys(meta)).toContain("[EMAIL]");
      expect(meta["[EMAIL]"]).toBe("note-value"); // value preserved
    });

    it("redacts an Arabic-Indic SSN metadata KEY STRING on a learned-fact value (egress)", () => {
      const ssnKey = "١٢٣-٤٥-٦٧٨٩"; // Arabic-Indic 123-45-6789
      const redacted = filter.redactLearnedFactValue({ [ssnKey]: 5 }) as Record<string, unknown>;
      expect(Object.keys(redacted)).not.toContain(ssnKey);
      expect(Object.keys(redacted)).toContain("[SSN_US]");
      expect(redacted["[SSN_US]"]).toBe(5);
    });

    it("NO-DEGRADE: benign multilingual + ALL-Nd pure-digit metadata KEYS round-trip byte-identical", () => {
      const metadata = {
        "café_naïve": "a", // precomposed accents, no PII shape
        "user​name": "b", // zero-width in a benign word
        "４１１１１１１１１１１１１１１１": "fw-id", // full-width all-digit business id (all-Nd exempt)
      };
      const filtered = filter.filterItem(makeItem({ metadata: { ...metadata } }));
      expect(filtered.metadata).toEqual(metadata); // no over-redaction, byte-identical
      expect(Object.keys(filtered.metadata)).not.toContain("[CREDIT_CARD]");
    });
  });

  // ─── memory-egress key-CONTENT SECRET (SEC-EVENT-REDACTION-001 round-12) ───
  //
  // The shared key-content sanitizer (`redactKey`) governs MEMORY egress too (this filter calls
  // `redactDeep` on item.metadata and on learned-fact values). A metadata KEY STRING that is itself a
  // SECRET (`sk-…`, `Authorization: Bearer …`, `api_key=…`) — ASCII or Unicode-obfuscated — persisted
  // RAW on read-back before round-12; it is now redacted to `[REDACTED_SECRET]` (whole-value shapes) or
  // keeps its forensic prefix (Bearer / generic assignment). VALUE preserved. NO-DEGRADE: sensitive
  // field-NAME keys and benign near-miss keys round-trip byte-identical.
  describe("key-CONTENT SECRET metadata KEY (egress redactDeep)", () => {
    it("redacts an ASCII sk- secret metadata KEY STRING on filterItem (egress); value preserved", () => {
      const secretKey = "sk-abcdefghijklmnopqrstuv0123456789"; // pragma: allowlist secret
      const item = makeItem({ metadata: { [secretKey]: "note-value" } });
      const filtered = filter.filterItem(item);
      const meta = filtered.metadata as Record<string, unknown>;
      expect(Object.keys(meta)).not.toContain(secretKey); // raw secret key gone
      expect(Object.keys(meta)).toContain("[REDACTED_SECRET]");
      expect(meta["[REDACTED_SECRET]"]).toBe("note-value"); // value preserved
    });

    it("redacts a zero-width-obfuscated sk- secret KEY + keeps the Bearer prefix on a learned-fact value (egress)", () => {
      const zwSecretKey = "sk-​abcdefghijklmnop0123456789"; // U+200B after sk- // pragma: allowlist secret
      const bearerKey = "Authorization: Bearer abcdefghijklmnopqrstuvwx"; // pragma: allowlist secret
      const redacted = filter.redactLearnedFactValue({ [zwSecretKey]: 1, [bearerKey]: 2 }) as Record<string, unknown>;
      expect(Object.keys(redacted)).not.toContain(zwSecretKey);
      expect(Object.keys(redacted)).not.toContain(bearerKey);
      expect(Object.keys(redacted)).toContain("[REDACTED_SECRET]");
      expect(Object.keys(redacted)).toContain("Authorization: Bearer [REDACTED_SECRET]"); // pragma: allowlist secret
      expect(JSON.stringify(redacted)).not.toContain("abcdefghijklmnop0123456789"); // pragma: allowlist secret
      expect(JSON.stringify(redacted)).not.toContain("abcdefghijklmnopqrstuvwx"); // pragma: allowlist secret
    });

    it("NO-DEGRADE: benign near-miss metadata KEYS round-trip byte-identical (no secret SHAPE → untouched)", () => {
      const metadata = {
        "session_token_count": "a", // near-miss (no `=value`)
        "sk_underscore_id": "b", // `sk_` not `sk-`
        "café_naïve": "c",
      };
      const filtered = filter.filterItem(makeItem({ metadata: { ...metadata } }));
      expect(filtered.metadata).toEqual(metadata); // byte-identical, no over-redaction
      expect(Object.keys(filtered.metadata)).not.toContain("[REDACTED_SECRET]");
    });
  });
});
