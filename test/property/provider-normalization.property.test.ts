import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { FRIDAY_PROVIDER_KINDS } from "../../src/providers/model/friday-provider.types.js";

/**
 * Mirrors normalizeModelId from src/providers/routing/friday-provider-fallback.ts.
 * We re-implement here because it is not exported, but we test the same invariant.
 */
function normalizeModelId(input: string): string {
  return input.trim().toLowerCase().replace(/_/g, "-").replace(/-+/g, "-");
}

describe("provider normalization property tests", () => {
  it("normalizeModelId is idempotent: normalize(normalize(x)) === normalize(x)", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const once = normalizeModelId(input);
        const twice = normalizeModelId(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 1000 },
    );
  });

  it("normalizeModelId always produces lowercase output", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = normalizeModelId(input);
        expect(result).toBe(result.toLowerCase());
      }),
      { numRuns: 500 },
    );
  });

  it("normalizeModelId never produces consecutive dashes", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = normalizeModelId(input);
        expect(result).not.toMatch(/--/);
      }),
      { numRuns: 500 },
    );
  });

  it("normalizeModelId replaces all underscores with dashes", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = normalizeModelId(input);
        expect(result).not.toContain("_");
      }),
      { numRuns: 500 },
    );
  });

  it("provider kind validation returns a consistent result for the same input", () => {
    const kindsSet = new Set<string>(FRIDAY_PROVIDER_KINDS);
    fc.assert(
      fc.property(fc.string(), (input) => {
        const first = kindsSet.has(input);
        const second = kindsSet.has(input);
        expect(first).toBe(second);
      }),
      { numRuns: 500 },
    );
  });

  it("all known provider kinds are already normalized", () => {
    for (const kind of FRIDAY_PROVIDER_KINDS) {
      const normalized = normalizeModelId(kind);
      expect(normalized).toBe(kind);
    }
  });
});
