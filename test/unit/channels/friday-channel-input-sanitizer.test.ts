import { describe, it, expect } from "vitest";
import { sanitizeChannelInput } from "#channels";

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
});
