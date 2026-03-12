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
