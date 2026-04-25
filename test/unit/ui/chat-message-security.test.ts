import { describe, expect, it } from "vitest";

import { isSafeMarkdownLinkHref } from "../../../ui/src/components/chat/chat-message";

describe("chat markdown link safety", () => {
  it("allows only absolute http and https links", () => {
    expect(isSafeMarkdownLinkHref("https://example.com/path")).toBe(true);
    expect(isSafeMarkdownLinkHref("http://example.com/path")).toBe(true);
    expect(isSafeMarkdownLinkHref("javascript:alert(1)")).toBe(false);
    expect(isSafeMarkdownLinkHref("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeMarkdownLinkHref("/relative/path")).toBe(false);
  });
});
