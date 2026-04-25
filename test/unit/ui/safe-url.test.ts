import { describe, expect, it } from "vitest";

import { isSafeHref, toSafeHref } from "../../../ui/src/lib/security/safe-url";

describe("UI safe href validation", () => {
  it("allows absolute http and https URLs by default", () => {
    expect(toSafeHref("https://example.com/path")).toBe("https://example.com/path");
    expect(toSafeHref("http://example.com/path")).toBe("http://example.com/path");
  });

  it("rejects scriptable and opaque schemes", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeHref("vbscript:msgbox(1)")).toBe(false);
  });

  it("only allows relative links when explicitly requested", () => {
    expect(toSafeHref("/settings")).toBeNull();
    expect(toSafeHref("/settings", { allowRelative: true })).toBe("/settings");
    expect(toSafeHref("//evil.example/path", { allowRelative: true })).toBeNull();
  });

  it("supports narrow protocol allowlists for local artifact links", () => {
    expect(toSafeHref("file:///tmp/friday/evidence.json", { allowedProtocols: ["file:"] })).toBe("file:///tmp/friday/evidence.json");
    expect(toSafeHref("https://example.com/evidence.json", { allowedProtocols: ["file:"] })).toBeNull();
  });
});
