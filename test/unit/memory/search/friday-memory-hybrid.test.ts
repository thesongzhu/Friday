import { describe, it, expect } from "vitest";
import { mergeHybridResults } from "../../../../src/memory/search/friday-memory-hybrid.js";
import type { FridayMemoryItem } from "../../../../src/memory/model/friday-memory.types.js";

describe("mergeHybridResults", () => {
  /** Helper to build a minimal FridayMemoryItem for merge tests. */
  function makeItem(
    id: string,
    content = `content for ${id}`,
    confidence?: number,
    overrides?: Partial<FridayMemoryItem>,
  ): FridayMemoryItem {
    return {
      id,
      namespace: "test",
      key: id,
      content,
      source: "system",
      tags: [],
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      confidence,
      ...overrides,
    };
  }

  it("unions IDs and applies weighted scoring", () => {
    const items = new Map<string, FridayMemoryItem>([
      ["a", makeItem("a")],
      ["b", makeItem("b")],
      ["c", makeItem("c")],
    ]);

    const results = mergeHybridResults({
      ftsHits: [
        { itemId: "a", score: 1.0, snippet: "fts snippet a" },
        { itemId: "b", score: 0.5, snippet: "fts snippet b" },
      ],
      semanticHits: [
        { itemId: "b", score: 0.8 },   // overlap with FTS
        { itemId: "c", score: 0.6 },   // semantic only
      ],
      resolveItem: (id) => items.get(id) ?? null,
      weights: { fts: 0.45, semantic: 0.55 },
      limit: 10,
    });

    // All three items should appear
    const ids = results.map((r) => r.item.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");

    // Verify weighted scores
    const scoreOf = (id: string) => results.find((r) => r.item.id === id)!;

    // a: fts only → 1.0 * 0.45 + 0 * 0.55 = 0.45
    expect(scoreOf("a").score).toBeCloseTo(0.45);

    // b: both → 0.5 * 0.45 + 0.8 * 0.55 = 0.225 + 0.44 = 0.665
    expect(scoreOf("b").score).toBeCloseTo(0.665);

    // c: semantic only → 0 * 0.45 + 0.6 * 0.55 = 0.33
    expect(scoreOf("c").score).toBeCloseTo(0.33);

    // b should rank highest (0.665), then a (0.45), then c (0.33)
    expect(results[0].item.id).toBe("b");
    expect(results[1].item.id).toBe("a");
    expect(results[2].item.id).toBe("c");

    // matchedBy should reflect the sources
    expect(scoreOf("a").matchedBy).toEqual(["fts"]);
    expect(scoreOf("b").matchedBy).toEqual(expect.arrayContaining(["fts", "semantic"]));
    expect(scoreOf("c").matchedBy).toEqual(["semantic"]);
  });

  it("prefers FTS snippet on overlap and includes both match sources", () => {
    const items = new Map<string, FridayMemoryItem>([
      ["x", makeItem("x", "full content of x")],
    ]);

    const results = mergeHybridResults({
      ftsHits: [
        { itemId: "x", score: 0.7, snippet: "fts highlighted snippet" },
      ],
      semanticHits: [
        { itemId: "x", score: 0.9 },
      ],
      resolveItem: (id) => items.get(id) ?? null,
      weights: { fts: 0.45, semantic: 0.55 },
      limit: 10,
    });

    expect(results).toHaveLength(1);
    const hit = results[0];

    // FTS snippet should be preferred over content fallback
    expect(hit.snippet).toBe("fts highlighted snippet");

    // Both match sources should be recorded
    expect(hit.matchedBy).toContain("fts");
    expect(hit.matchedBy).toContain("semantic");

    // Combined weighted score: 0.7 * 0.45 + 0.9 * 0.55 = 0.315 + 0.495 = 0.81
    expect(hit.score).toBeCloseTo(0.81);
  });

  it("optionally boosts ordering with bounded confidence scores", () => {
    const items = new Map<string, FridayMemoryItem>([
      ["low", makeItem("low", "low confidence", 0.1)],
      ["high", makeItem("high", "high confidence", 0.9)],
    ]);

    const unboosted = mergeHybridResults({
      ftsHits: [
        { itemId: "low", score: 0.5, snippet: "low" },
        { itemId: "high", score: 0.48, snippet: "high" },
      ],
      semanticHits: [],
      resolveItem: (id) => items.get(id) ?? null,
      weights: { fts: 1, semantic: 0 },
      limit: 10,
    });

    const boosted = mergeHybridResults({
      ftsHits: [
        { itemId: "low", score: 0.5, snippet: "low" },
        { itemId: "high", score: 0.48, snippet: "high" },
      ],
      semanticHits: [],
      resolveItem: (id) => items.get(id) ?? null,
      weights: { fts: 1, semantic: 0 },
      limit: 10,
      boostByConfidence: true,
    });

    expect(unboosted[0].item.id).toBe("low");
    expect(boosted[0].item.id).toBe("high");
    expect(boosted.find((entry) => entry.item.id === "high")!.score).toBeCloseTo(0.525);
  });

  it("optionally boosts ordering with bounded access count", () => {
    const items = new Map<string, FridayMemoryItem>([
      ["fresh", makeItem("fresh", "fresh", 0.5, { accessCount: 0 })],
      ["used", makeItem("used", "used", 0.5, { accessCount: 20 })],
    ]);

    const boosted = mergeHybridResults({
      ftsHits: [
        { itemId: "fresh", score: 0.5, snippet: "fresh" },
        { itemId: "used", score: 0.48, snippet: "used" },
      ],
      semanticHits: [],
      resolveItem: (id) => items.get(id) ?? null,
      weights: { fts: 1, semantic: 0 },
      limit: 10,
      boostByAccess: true,
    });

    expect(boosted[0].item.id).toBe("used");
    expect(boosted.find((entry) => entry.item.id === "used")!.score).toBeCloseTo(0.51);
  });

  it("applies non-destructive confidence decay during ranking when requested", () => {
    const items = new Map<string, FridayMemoryItem>([
      ["old", makeItem("old", "old", 1.0, {
        updatedAt: "2025-01-01T00:00:00.000Z",
      })],
      ["recent", makeItem("recent", "recent", 0.6, {
        updatedAt: "2026-01-01T00:00:00.000Z",
      })],
    ]);

    const decayed = mergeHybridResults({
      ftsHits: [
        { itemId: "old", score: 0.5, snippet: "old" },
        { itemId: "recent", score: 0.49, snippet: "recent" },
      ],
      semanticHits: [],
      resolveItem: (id) => items.get(id) ?? null,
      weights: { fts: 1, semantic: 0 },
      limit: 10,
      boostByConfidence: true,
      applyRetentionDecay: true,
      retentionHalfLifeDays: 30,
      nowIso: "2026-01-02T00:00:00.000Z",
    });

    expect(decayed[0].item.id).toBe("recent");
    expect(items.get("old")!.confidence).toBe(1.0);
  });
});
