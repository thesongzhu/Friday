import { describe, it, expect } from "vitest";
import { sanitizeChannelInput, FRIDAY_MAX_CHANNEL_INPUT_LENGTH } from "#channels";

describe("sanitizeChannelInput", () => {
  it("trims whitespace", () => {
    expect(sanitizeChannelInput("  hello  ")).toBe("hello");
  });

  it("replaces control characters with spaces", () => {
    expect(sanitizeChannelInput("hello\x00world")).toBe("hello world");
    expect(sanitizeChannelInput("a\x01b\x02c")).toBe("a b c");
  });

  it("removes zero-width characters", () => {
    expect(sanitizeChannelInput("hello\u200Bworld")).toBe("helloworld");
    expect(sanitizeChannelInput("a\u200Cb\u200Dc\uFEFFd")).toBe("abcd");
  });

  it("normalizes multiple whitespace to single space", () => {
    expect(sanitizeChannelInput("hello   world  foo")).toBe("hello world foo");
  });

  it("handles combination of all issues", () => {
    expect(sanitizeChannelInput("  \x00\u200Bhello\x01  \u200D world\uFEFF  ")).toBe("hello world");
  });

  it("returns empty string for all-control input", () => {
    expect(sanitizeChannelInput("\x00\x01\x02")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeChannelInput("")).toBe("");
  });

  it("preserves normal text unchanged", () => {
    expect(sanitizeChannelInput("Hello, how are you?")).toBe("Hello, how are you?");
  });

  it("preserves Unicode text", () => {
    expect(sanitizeChannelInput("你好世界")).toBe("你好世界");
  });

  it("truncates input exceeding max length", () => {
    const oversized = "a".repeat(FRIDAY_MAX_CHANNEL_INPUT_LENGTH + 1000);
    const result = sanitizeChannelInput(oversized);
    expect(result.length).toBeLessThanOrEqual(FRIDAY_MAX_CHANNEL_INPUT_LENGTH);
  });

  it("preserves input within max length", () => {
    const withinLimit = "hello world";
    expect(sanitizeChannelInput(withinLimit)).toBe("hello world");
  });

  it("applies NFC normalization", () => {
    // é composed (e + combining acute) vs precomposed
    const decomposed = "caf\u0065\u0301"; // e + combining accent
    const result = sanitizeChannelInput(decomposed);
    expect(result).toBe("café");
  });

  it("exports FRIDAY_MAX_CHANNEL_INPUT_LENGTH constant", () => {
    expect(typeof FRIDAY_MAX_CHANNEL_INPUT_LENGTH).toBe("number");
    expect(FRIDAY_MAX_CHANNEL_INPUT_LENGTH).toBeGreaterThan(0);
  });
});
