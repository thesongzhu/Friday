import { describe, expect, it } from "vitest";

import {
  assertSafeAppleScriptIdentifier,
  toAppleScriptIdentifierLiteral,
  toAppleScriptStringLiteral,
} from "../../../src/system/friday-applescript.js";

describe("toAppleScriptStringLiteral", () => {
  it("encodes multiline text with linefeed concatenation", () => {
    expect(toAppleScriptStringLiteral("hello\nworld")).toBe("\"hello\" & linefeed & \"world\"");
  });

  it("normalizes carriage returns to linefeed", () => {
    expect(toAppleScriptStringLiteral("hello\r\nworld")).toBe("\"hello\" & linefeed & \"world\"");
  });

  it("rejects unsafe control characters", () => {
    expect(() => toAppleScriptStringLiteral("bad\u0001value")).toThrow("Unsafe AppleScript input");
  });

  it("rejects bidi control characters", () => {
    expect(() => toAppleScriptStringLiteral("bad\u202Evalue")).toThrow("Unsafe AppleScript input");
  });
});

describe("toAppleScriptIdentifierLiteral", () => {
  it("rejects multiline identifiers", () => {
    expect(() => toAppleScriptIdentifierLiteral("Finder\nbeep", "app identifier")).toThrow(
      "Unsafe AppleScript app identifier",
    );
  });

  it("passes through safe identifiers", () => {
    expect(assertSafeAppleScriptIdentifier("Finder", "app identifier")).toBe("Finder");
    expect(toAppleScriptIdentifierLiteral("Finder", "app identifier")).toBe("\"Finder\"");
  });
});
