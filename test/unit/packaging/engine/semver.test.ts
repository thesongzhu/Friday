import { describe, it, expect } from "vitest";
import {
  parseSemver,
  isValidSemver,
  compareSemver,
  compareSemverStr,
  satisfiesRange,
  maxSatisfying,
  rangesIntersect,
} from "../../../../src/packaging/engine/semver.js";
import type { SemverParsed } from "../../../../src/packaging/engine/semver.js";

// ─── parseSemver ───

describe("parseSemver", () => {
  it("parses a basic version", () => {
    const result = parseSemver("1.2.3");
    expect(result).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
      build: [],
    });
  });

  it("parses a version with prerelease", () => {
    const result = parseSemver("1.0.0-beta.1");
    expect(result).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ["beta", "1"],
      build: [],
    });
  });

  it("parses a version with build metadata", () => {
    const result = parseSemver("1.0.0+build.123");
    expect(result).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: [],
      build: ["build", "123"],
    });
  });

  it("parses a version with prerelease and build", () => {
    const result = parseSemver("2.1.0-alpha.3+build.456");
    expect(result).toEqual({
      major: 2,
      minor: 1,
      patch: 0,
      prerelease: ["alpha", "3"],
      build: ["build", "456"],
    });
  });

  it("parses 0.0.0", () => {
    expect(parseSemver("0.0.0")).toEqual({
      major: 0,
      minor: 0,
      patch: 0,
      prerelease: [],
      build: [],
    });
  });

  it("returns null for invalid versions", () => {
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("1")).toBeNull();
    expect(parseSemver("abc")).toBeNull();
    expect(parseSemver("1.2.3.4")).toBeNull();
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("v1.2.3")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseSemver("  1.2.3  ")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
      build: [],
    });
  });
});

// ─── isValidSemver ───

describe("isValidSemver", () => {
  it("returns true for valid versions", () => {
    expect(isValidSemver("0.0.1")).toBe(true);
    expect(isValidSemver("1.0.0-alpha")).toBe(true);
    expect(isValidSemver("99.99.99")).toBe(true);
  });

  it("returns false for invalid versions", () => {
    expect(isValidSemver("not-a-version")).toBe(false);
    expect(isValidSemver("1.2")).toBe(false);
  });
});

// ─── compareSemver ───

describe("compareSemver", () => {
  it("compares major versions", () => {
    expect(compareSemverStr("2.0.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareSemverStr("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  it("compares minor versions", () => {
    expect(compareSemverStr("1.2.0", "1.1.0")).toBeGreaterThan(0);
  });

  it("compares patch versions", () => {
    expect(compareSemverStr("1.0.2", "1.0.1")).toBeGreaterThan(0);
  });

  it("equal versions return 0", () => {
    expect(compareSemverStr("1.2.3", "1.2.3")).toBe(0);
  });

  it("prerelease has lower precedence than release", () => {
    expect(compareSemverStr("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
  });

  it("compares prerelease identifiers", () => {
    expect(compareSemverStr("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareSemverStr("1.0.0-alpha.1", "1.0.0-alpha.2")).toBeLessThan(0);
  });

  it("numeric prerelease identifiers sort numerically", () => {
    expect(compareSemverStr("1.0.0-1", "1.0.0-2")).toBeLessThan(0);
    expect(compareSemverStr("1.0.0-10", "1.0.0-2")).toBeGreaterThan(0);
  });

  it("shorter prerelease is less than longer with same prefix", () => {
    expect(compareSemverStr("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
  });

  it("ignores build metadata in comparisons", () => {
    expect(compareSemverStr("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });

  it("throws for invalid input", () => {
    expect(() => compareSemverStr("invalid", "1.0.0")).toThrow("Invalid semver");
  });
});

// ─── satisfiesRange ───

describe("satisfiesRange", () => {
  it("matches exact version", () => {
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
  });

  it("matches caret range (^)", () => {
    expect(satisfiesRange("1.2.3", "^1.0.0")).toBe(true);
    expect(satisfiesRange("1.9.9", "^1.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesRange("0.9.0", "^1.0.0")).toBe(false);
  });

  it("caret range with major 0", () => {
    expect(satisfiesRange("0.2.3", "^0.2.0")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.0")).toBe(false);
  });

  it("caret range with major 0, minor 0", () => {
    expect(satisfiesRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
  });

  it("matches tilde range (~)", () => {
    expect(satisfiesRange("1.2.3", "~1.2.0")).toBe(true);
    expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
  });

  it("matches >= operator", () => {
    expect(satisfiesRange("1.5.0", ">=1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", ">=1.0.0")).toBe(true);
    expect(satisfiesRange("0.9.0", ">=1.0.0")).toBe(false);
  });

  it("matches < operator", () => {
    expect(satisfiesRange("1.9.9", "<2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "<2.0.0")).toBe(false);
  });

  it("matches combined range (intersection)", () => {
    expect(satisfiesRange("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfiesRange("0.9.0", ">=1.0.0 <2.0.0")).toBe(false);
  });

  it("matches union range (||)", () => {
    expect(satisfiesRange("1.5.0", "^1.0.0 || ^3.0.0")).toBe(true);
    expect(satisfiesRange("3.5.0", "^1.0.0 || ^3.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.0.0 || ^3.0.0")).toBe(false);
  });

  it("matches hyphen range", () => {
    expect(satisfiesRange("1.5.0", "1.0.0 - 2.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", "1.0.0 - 2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "1.0.0 - 2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.1", "1.0.0 - 2.0.0")).toBe(false);
  });

  it("matches wildcard", () => {
    expect(satisfiesRange("0.0.1", "*")).toBe(true);
    expect(satisfiesRange("999.0.0", "*")).toBe(true);
  });

  it("returns false for invalid version", () => {
    expect(satisfiesRange("invalid", "^1.0.0")).toBe(false);
  });

  it("returns false for empty or invalid ranges", () => {
    expect(satisfiesRange("1.2.3", "")).toBe(false);
    expect(satisfiesRange("1.2.3", "   ")).toBe(false);
    expect(satisfiesRange("1.2.3", "||")).toBe(false);
    expect(satisfiesRange("1.2.3", "^")).toBe(false);
    expect(satisfiesRange("1.2.3", ">=1.0.0 || ")).toBe(false);
  });
});

// ─── maxSatisfying ───

describe("maxSatisfying", () => {
  const versions = ["1.0.0", "1.1.0", "1.2.0", "2.0.0", "2.1.0", "3.0.0-beta.1"];

  it("returns the highest satisfying version", () => {
    expect(maxSatisfying(versions, "^1.0.0")).toBe("1.2.0");
  });

  it("returns the highest for >= range", () => {
    // 3.0.0-beta.1 satisfies >=2.0.0 (prerelease of 3.0.0 > 2.x)
    // so maxSatisfying picks the highest: 3.0.0-beta.1 > 2.1.0
    expect(maxSatisfying(versions, ">=2.0.0")).toBe("3.0.0-beta.1");
    // Without the prerelease version, it should return 2.1.0
    expect(maxSatisfying(["1.0.0", "1.1.0", "1.2.0", "2.0.0", "2.1.0"], ">=2.0.0")).toBe("2.1.0");
  });

  it("returns null when nothing satisfies", () => {
    expect(maxSatisfying(versions, "^4.0.0")).toBeNull();
  });

  it("returns exact match", () => {
    expect(maxSatisfying(versions, "2.0.0")).toBe("2.0.0");
  });

  it("handles empty versions list", () => {
    expect(maxSatisfying([], "^1.0.0")).toBeNull();
  });
});

// ─── rangesIntersect ───

describe("rangesIntersect", () => {
  it("returns true for overlapping ranges", () => {
    expect(rangesIntersect("^1.0.0", ">=1.5.0 <2.0.0")).toBe(true);
  });

  it("returns false for non-overlapping ranges", () => {
    expect(rangesIntersect("^1.0.0", "^3.0.0")).toBe(false);
  });

  it("returns true for identical ranges", () => {
    expect(rangesIntersect("^2.0.0", "^2.0.0")).toBe(true);
  });

  it("returns false when either range is invalid", () => {
    expect(rangesIntersect("", "^1.0.0")).toBe(false);
    expect(rangesIntersect("^1.0.0", "||")).toBe(false);
  });
});
