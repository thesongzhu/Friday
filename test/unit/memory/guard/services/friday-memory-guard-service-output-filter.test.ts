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
});
