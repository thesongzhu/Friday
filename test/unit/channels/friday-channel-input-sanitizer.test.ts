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

/** Build a string from a codepoint so the source stays free of invisible chars. */
const cp = (code: number): string => String.fromCodePoint(code);

describe("sanitizeChannelInput bidi / directional-format concealment", () => {
  // Trojan-source / prompt-injection concealment vectors. Each of these passes
  // through the sanitizer unchanged BEFORE this hardening (real RED anchors).
  const BIDI_CONTROLS: ReadonlyArray<readonly [string, number]> = [
    ["U+202A LRE", 0x202a],
    ["U+202B RLE", 0x202b],
    ["U+202C PDF", 0x202c],
    ["U+202D LRO", 0x202d],
    ["U+202E RLO", 0x202e],
    ["U+2066 LRI", 0x2066],
    ["U+2067 RLI", 0x2067],
    ["U+2068 FSI", 0x2068],
    ["U+2069 PDI", 0x2069],
    ["U+061C ALM", 0x061c],
  ];

  it.each(BIDI_CONTROLS)(
    "removes %s so it cannot reorder or conceal instructions",
    (_name, code) => {
      const ch = cp(code);
      const out = sanitizeChannelInput(`a${ch}b`);
      expect(out).not.toContain(ch);
      expect(out).toBe("ab");
    },
  );

  it("neutralizes a right-to-left-override concealment attempt", () => {
    const rlo = cp(0x202e);
    const out = sanitizeChannelInput(`delete${rlo}account`);
    expect(out).not.toContain(rlo);
    expect(out).toBe("deleteaccount");
  });
});

describe("sanitizeChannelInput line / paragraph separator normalization", () => {
  // NEL U+0085 is NOT matched by JS `\s` and NOT in the C0/DEL control strip,
  // so it passes through unchanged BEFORE this hardening (real RED anchor).
  it("maps NEL U+0085 to a space", () => {
    const nel = cp(0x0085);
    const out = sanitizeChannelInput(`alpha${nel}beta`);
    expect(out).not.toContain(nel);
    expect(out).toBe("alpha beta");
  });

  // U+2028 / U+2029 are already folded by the trailing whitespace collapse
  // today; the explicit mapping makes the intent robust and order-independent.
  it("maps LINE SEPARATOR U+2028 to a space", () => {
    const ls = cp(0x2028);
    const out = sanitizeChannelInput(`alpha${ls}beta`);
    expect(out).not.toContain(ls);
    expect(out).toBe("alpha beta");
  });

  it("maps PARAGRAPH SEPARATOR U+2029 to a space", () => {
    const ps = cp(0x2029);
    const out = sanitizeChannelInput(`alpha${ps}beta`);
    expect(out).not.toContain(ps);
    expect(out).toBe("alpha beta");
  });
});

describe("sanitizeChannelInput no-degrade with new strips", () => {
  it("preserves emoji unchanged", () => {
    expect(sanitizeChannelInput("hello 👍 world 🎉")).toBe("hello 👍 world 🎉");
  });

  it("preserves CJK and Arabic letters unchanged", () => {
    expect(sanitizeChannelInput("你好世界 مرحبا")).toBe("你好世界 مرحبا");
  });

  it("removes zero-width and folds control chars alongside the new bidi strip", () => {
    // Mixed payload: control (NUL) + zero-width (ZWSP) + RLO override between words.
    const mixed = `hello${cp(0x00)}${cp(0x200b)}${cp(0x202e)}world`;
    expect(sanitizeChannelInput(mixed)).toBe("hello world");
  });
});
