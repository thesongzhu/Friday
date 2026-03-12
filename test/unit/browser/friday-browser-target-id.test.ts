import { describe, it, expect, vi } from "vitest";
import {
  parseBrowserTargetId,
  formatBrowserTargetId,
  resolveBrowserTarget,
  createFridayBrowserManager,
} from "#browser";

// ─── Mock Playwright objects ───

function createMockPage() {
  return {
    url: vi.fn().mockReturnValue("about:blank"),
    title: vi.fn().mockResolvedValue(""),
    goto: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext() {
  return {
    newPage: vi.fn().mockImplementation(() => Promise.resolve(createMockPage())),
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockBrowser() {
  const context = createMockContext();
  return {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockLaunch() {
  return vi.fn().mockImplementation(() => Promise.resolve(createMockBrowser()));
}

// ─── parseBrowserTargetId ───

describe("parseBrowserTargetId", () => {
  it("parses session-only target id", () => {
    const result = parseBrowserTargetId("session-1");
    expect(result).toEqual({ sessionId: "session-1" });
  });

  it("parses session:tab target id", () => {
    const result = parseBrowserTargetId("session-1:tab-2");
    expect(result).toEqual({ sessionId: "session-1", tabId: "tab-2" });
  });

  it("handles empty tab id after colon", () => {
    const result = parseBrowserTargetId("session-1:");
    expect(result).toEqual({ sessionId: "session-1", tabId: "" });
  });

  it("handles multiple colons (only first split)", () => {
    const result = parseBrowserTargetId("session-1:tab-2:extra");
    expect(result).toEqual({ sessionId: "session-1", tabId: "tab-2:extra" });
  });
});

// ─── formatBrowserTargetId ───

describe("formatBrowserTargetId", () => {
  it("formats session only", () => {
    expect(formatBrowserTargetId("s1")).toBe("s1");
  });

  it("formats session:tab", () => {
    expect(formatBrowserTargetId("s1", "tab-1")).toBe("s1:tab-1");
  });

  it("formats session with undefined tab as session only", () => {
    expect(formatBrowserTargetId("s1", undefined)).toBe("s1");
  });
});

// ─── resolveBrowserTarget ───

describe("resolveBrowserTarget", () => {
  it("resolves from explicit sessionId", async () => {
    const launchImpl = createMockLaunch();
    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    await manager.launch("s1");

    const result = resolveBrowserTarget(manager, { sessionId: "s1" });
    expect(result.sessionId).toBe("s1");
    expect(result.tabId).toBe("tab-1");
    expect(result.session).toBeDefined();
  });

  it("resolves from targetId", async () => {
    const launchImpl = createMockLaunch();
    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    await manager.launch("s1");

    const result = resolveBrowserTarget(manager, { targetId: "s1:tab-1" });
    expect(result.sessionId).toBe("s1");
    expect(result.tabId).toBe("tab-1");
  });

  it("resolves from targetId without tab (uses active tab)", async () => {
    const launchImpl = createMockLaunch();
    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    await manager.launch("s1");

    const result = resolveBrowserTarget(manager, { targetId: "s1" });
    expect(result.sessionId).toBe("s1");
    expect(result.tabId).toBe("tab-1"); // active tab
  });

  it("resolves from profile via stored metadata", async () => {
    const launchImpl = createMockLaunch();
    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    await manager.launch("chrome", undefined, "chrome");

    const result = resolveBrowserTarget(manager, { profile: "chrome" });
    expect(result.sessionId).toBe("chrome");
    expect(result.tabId).toBe("tab-1");
  });

  it("resolves profile via metadata not naming convention", async () => {
    const launchImpl = createMockLaunch();
    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    // Session "random-id" with profile "myprofile" should be found via metadata
    await manager.launch("random-id", undefined, "myprofile");

    const result = resolveBrowserTarget(manager, { profile: "myprofile" });
    expect(result.sessionId).toBe("random-id");
  });

  it("does NOT match by session ID prefix (no naming convention)", async () => {
    const launchImpl = createMockLaunch();
    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    // Session "myprofile-001" without profile metadata should NOT match "myprofile"
    await manager.launch("myprofile-001");

    expect(() =>
      resolveBrowserTarget(manager, { profile: "myprofile" }),
    ).toThrow('No session found for profile "myprofile"');
  });

  it("explicit tabId takes precedence over targetId tab", async () => {
    const launchImpl = createMockLaunch();
    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    await manager.launch("s1");

    const result = resolveBrowserTarget(manager, {
      targetId: "s1:tab-999",
      tabId: "tab-1",
    });
    expect(result.tabId).toBe("tab-1");
  });

  it("throws for missing session", () => {
    const launchImpl = createMockLaunch();
    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    expect(() =>
      resolveBrowserTarget(manager, { sessionId: "missing" }),
    ).toThrow('Session "missing" not found');
  });

  it("throws for missing tab", async () => {
    const launchImpl = createMockLaunch();
    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    await manager.launch("s1");

    expect(() =>
      resolveBrowserTarget(manager, { sessionId: "s1", tabId: "tab-99" }),
    ).toThrow('Tab "tab-99" not found');
  });

  it("throws for missing profile session", () => {
    const launchImpl = createMockLaunch();
    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    expect(() =>
      resolveBrowserTarget(manager, { profile: "nonexistent" }),
    ).toThrow('No session found for profile "nonexistent"');
  });

  it("throws when no identifiers provided", () => {
    const launchImpl = createMockLaunch();
    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    expect(() => resolveBrowserTarget(manager, {})).toThrow(
      "No session specified",
    );
  });
});
