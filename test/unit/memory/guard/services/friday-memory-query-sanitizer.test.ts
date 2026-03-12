import { describe, it, expect } from "vitest";
import { sanitizeFridayMemoryQuery } from "#memory";

describe("sanitizeFridayMemoryQuery", () => {
  // ─── Basic sanitization ───

  it("returns simple tokens as-is", () => {
    expect(sanitizeFridayMemoryQuery("hello world")).toBe("hello world");
  });

  it("returns null for empty string", () => {
    expect(sanitizeFridayMemoryQuery("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(sanitizeFridayMemoryQuery("   ")).toBeNull();
  });

  it("returns null when all tokens are stripped", () => {
    expect(sanitizeFridayMemoryQuery("+ - * \"\"")).toBeNull();
  });

  // ─── FTS5 operator stripping ───

  it("strips AND operator", () => {
    expect(sanitizeFridayMemoryQuery("foo AND bar")).toBe("foo bar");
  });

  it("strips OR operator", () => {
    expect(sanitizeFridayMemoryQuery("foo OR bar")).toBe("foo bar");
  });

  it("strips NOT operator", () => {
    expect(sanitizeFridayMemoryQuery("NOT foo")).toBe("foo");
  });

  it("strips NEAR operator", () => {
    expect(sanitizeFridayMemoryQuery("foo NEAR bar")).toBe("foo bar");
  });

  it("is case-insensitive for operator stripping", () => {
    expect(sanitizeFridayMemoryQuery("foo and bar or baz")).toBe("foo bar baz");
  });

  // ─── Special character stripping ───

  it("strips double quotes", () => {
    expect(sanitizeFridayMemoryQuery('"exact phrase"')).toBe("exact phrase");
  });

  it("strips asterisks", () => {
    expect(sanitizeFridayMemoryQuery("foo*")).toBe("foo");
  });

  it("strips plus and minus", () => {
    expect(sanitizeFridayMemoryQuery("+foo -bar")).toBe("foo bar");
  });

  it("strips parentheses", () => {
    expect(sanitizeFridayMemoryQuery("(foo OR bar)")).toBe("foo bar");
  });

  it("strips curly braces", () => {
    expect(sanitizeFridayMemoryQuery("{foo}")).toBe("foo");
  });

  it("strips carets", () => {
    expect(sanitizeFridayMemoryQuery("foo^2")).toBe("foo 2");
  });

  it("strips colons", () => {
    expect(sanitizeFridayMemoryQuery("title:foo")).toBe("title foo");
  });

  // ─── Token limits ───

  it("limits to 24 tokens", () => {
    const tokens = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const result = sanitizeFridayMemoryQuery(tokens);
    expect(result).not.toBeNull();
    expect(result!.split(" ")).toHaveLength(24);
  });

  it("truncates individual tokens to 64 chars", () => {
    const longToken = "a".repeat(100);
    const result = sanitizeFridayMemoryQuery(longToken);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(64);
  });

  // ─── Query length limit ───

  it("truncates query to 512 chars before processing", () => {
    const longQuery = "x ".repeat(300); // 600 chars
    const result = sanitizeFridayMemoryQuery(longQuery);
    expect(result).not.toBeNull();
  });

  // ─── Unicode support ───

  it("allows Unicode word characters", () => {
    expect(sanitizeFridayMemoryQuery("café naïve")).toBe("café naïve");
  });

  it("allows CJK characters", () => {
    expect(sanitizeFridayMemoryQuery("日本語 テスト")).toBe("日本語 テスト");
  });

  // ─── Edge cases ───

  it("handles mixed safe and unsafe tokens", () => {
    expect(sanitizeFridayMemoryQuery("hello + world - test")).toBe("hello world test");
  });

  it("collapses multiple spaces", () => {
    const result = sanitizeFridayMemoryQuery("hello    world");
    expect(result).toBe("hello world");
  });
});
