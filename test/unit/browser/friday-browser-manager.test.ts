import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFridayBrowserManager, validateUrl, matchesOrigin, sanitizeArtifactPathSegment, FRIDAY_BROWSER_ALLOW_ANY_ORIGIN } from "#browser";

// ─── Mock Playwright objects ───

function createMockPage(opts?: { closed?: boolean }) {
  return {
    url: vi.fn().mockReturnValue("about:blank"),
    title: vi.fn().mockResolvedValue(""),
    goto: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(opts?.closed ?? false),
  };
}

function createMockContext() {
  const pages = [createMockPage()];
  return {
    newPage: vi.fn().mockImplementation(() => {
      const page = createMockPage();
      pages.push(page);
      return Promise.resolve(page);
    }),
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockBrowser(opts?: { connected?: boolean }) {
  const context = createMockContext();
  return {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(opts?.connected ?? true),
    _context: context,
  };
}

function createMockLaunch() {
  return vi.fn().mockImplementation(() => Promise.resolve(createMockBrowser()));
}

// ─── Tests ───

describe("FridayBrowserManager", () => {
  let launchImpl: ReturnType<typeof createMockLaunch>;

  beforeEach(() => {
    launchImpl = createMockLaunch();
  });

  // ─── Launch ───

  describe("launch", () => {
    it("creates a new session", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      const result = await manager.launch("s1");
      expect(result.sessionId).toBe("s1");
      expect(result.tabId).toBe("tab-1");
      expect(result.reused).toBe(false);
      expect(launchImpl).toHaveBeenCalledOnce();
    });

    it("reuses existing session", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1");
      const result = await manager.launch("s1");
      expect(result.reused).toBe(true);
      expect(launchImpl).toHaveBeenCalledOnce(); // Not called again
    });

    it("enforces max sessions limit", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        maxSessions: 2,
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1");
      await manager.launch("s2");
      await expect(manager.launch("s3")).rejects.toThrow("Maximum sessions (2) reached");
    });

    it("respects abort signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await expect(manager.launch("s1", controller.signal)).rejects.toThrow();
    });

    it("cleans up context and page on newPage failure", async () => {
      const mockContext = createMockContext();
      mockContext.newPage.mockRejectedValueOnce(new Error("newPage failed"));
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const failLaunch = vi.fn().mockResolvedValue(mockBrowser);

      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: failLaunch as never,
      });

      await expect(manager.launch("s1")).rejects.toThrow("newPage failed");
      expect(mockContext.close).toHaveBeenCalled();
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it("cleans up browser on newContext failure", async () => {
      const mockBrowser = {
        newContext: vi.fn().mockRejectedValue(new Error("newContext failed")),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const failLaunch = vi.fn().mockResolvedValue(mockBrowser);

      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: failLaunch as never,
      });

      await expect(manager.launch("s1")).rejects.toThrow("newContext failed");
      expect(mockBrowser.close).toHaveBeenCalled();
    });

  });

  // ─── getPage ───

  describe("getPage", () => {
    it("returns active tab page", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1");
      const { tabId, page } = await manager.getPage("s1");
      expect(tabId).toBe("tab-1");
      expect(page).toBeDefined();
    });

    it("throws for missing session", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await expect(manager.getPage("missing")).rejects.toThrow(
        'Session "missing" not found',
      );
    });

    it("throws for missing tab", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1");
      await expect(
        manager.getPage("s1", { tabId: "tab-999" }),
      ).rejects.toThrow('Tab "tab-999" not found');
    });

    it("creates new tab when createIfMissing is true", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1");
      const { tabId } = await manager.getPage("s1", {
        tabId: "new-tab",
        createIfMissing: true,
      });
      expect(tabId).toBe("tab-2");
    });

    it("enforces max tabs per session", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        maxTabsPerSession: 2,
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1");
      await manager.getPage("s1", { tabId: "new-1", createIfMissing: true });
      await expect(
        manager.getPage("s1", { tabId: "new-2", createIfMissing: true }),
      ).rejects.toThrow("Maximum tabs per session (2) reached");
    });
  });

  // ─── Global page limit ───

  describe("maxTotalPages", () => {
    it("enforces global page limit across sessions", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        maxSessions: 10,
        maxTabsPerSession: 10,
        maxTotalPages: 3,
        launchImpl: launchImpl as never,
      });

      // Session 1: 1 page (from launch)
      await manager.launch("s1");
      // Session 2: 1 page (from launch)
      await manager.launch("s2");
      // Session 1: +1 tab = 3 total pages
      await manager.getPage("s1", { tabId: "new-1", createIfMissing: true });

      // This should fail - 4th page exceeds limit of 3
      await expect(
        manager.getPage("s2", { tabId: "new-2", createIfMissing: true }),
      ).rejects.toThrow("Maximum total pages (3) reached");
    });

    it("rejects launch when global page limit is reached", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        maxSessions: 10,
        maxTabsPerSession: 10,
        maxTotalPages: 2,
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1");
      await manager.launch("s2");
      // 2 pages open, launching s3 would add a 3rd
      await expect(manager.launch("s3")).rejects.toThrow("Maximum total pages (2) reached");
    });
  });

  // ─── Close ───

  describe("close", () => {
    it("closes a specific session", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1");
      await manager.launch("s2");
      await manager.close("s1");
      expect(manager.sessions.size).toBe(1);
      expect(manager.sessions.has("s1")).toBe(false);
      expect(manager.sessions.has("s2")).toBe(true);
    });

    it("closes all sessions when no id given", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1");
      await manager.launch("s2");
      await manager.close();
      expect(manager.sessions.size).toBe(0);
    });

    it("does not throw for unknown session id", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await expect(manager.close("nonexistent")).resolves.toBeUndefined();
    });
  });

  // ─── Session resilience ───

  describe("session resilience", () => {
    it("re-launches when browser has disconnected on launch()", async () => {
      let callCount = 0;
      const deadBrowser = createMockBrowser({ connected: false });
      const liveBrowser = createMockBrowser({ connected: true });

      const customLaunch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? deadBrowser : liveBrowser);
      });

      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: customLaunch as never,
      });

      // First launch creates a session with a dead browser
      await manager.launch("s1");
      // Second launch detects dead browser, evicts, and re-launches
      const result = await manager.launch("s1");
      expect(result.reused).toBe(false);
      expect(customLaunch).toHaveBeenCalledTimes(2);
    });

    it("throws on getPage when browser has disconnected", async () => {
      const mockBrowser = createMockBrowser({ connected: true });
      const customLaunch = vi.fn().mockResolvedValue(mockBrowser);

      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: customLaunch as never,
      });

      await manager.launch("s1");
      // Simulate browser dying
      mockBrowser.isConnected.mockReturnValue(false);

      await expect(manager.getPage("s1")).rejects.toThrow("browser has disconnected");
      // Session should be evicted
      expect(manager.sessions.size).toBe(0);
    });

    it("skips closed pages and falls through to createIfMissing", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1");
      // Get the session and mark its page as closed
      const session = manager.getSession("s1")!;
      const page = session.tabs.get("tab-1")!;
      (page as unknown as { isClosed: ReturnType<typeof vi.fn> }).isClosed.mockReturnValue(true);

      // Without createIfMissing, should throw (tab removed, no new tab created)
      await expect(
        manager.getPage("s1", { tabId: "tab-1" }),
      ).rejects.toThrow('Tab "tab-1" not found');
    });
  });

  // ─── Options ───

  describe("options", () => {
    it("exposes resolved options", () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      expect(manager.options.workspaceRoot).toBe("/tmp/test");
      expect(manager.options.headless).toBe(true);
      expect(manager.options.maxSessions).toBe(3);
      expect(manager.options.maxTabsPerSession).toBe(8);
      expect(manager.options.navigationTimeoutMs).toBe(20_000);
      expect(manager.options.actionTimeoutMs).toBe(15_000);
      expect(manager.options.allowedOrigins).toEqual([]);
    });

    it("summarizes canonical browser profiles for diagnostics", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1", undefined, "operator");
      await manager.launch("s2", undefined, "automation");

      const summary = manager.getDiagnosticsSummary();

      expect(summary.sessionCount).toBe(2);
      expect(summary.profiles).toEqual([
        expect.objectContaining({
          name: "automation",
          kind: "automation",
          sessionCount: 1,
        }),
        expect.objectContaining({
          name: "operator",
          kind: "operator",
          sessionCount: 1,
        }),
      ]);
    });
  });
});

// ─── URL validation ───

describe("validateUrl", () => {
  it("allows valid http URLs when allow-any sentinel is passed (B4 explicit opt-in)", () => {
    expect(validateUrl("http://localhost:3000", [FRIDAY_BROWSER_ALLOW_ANY_ORIGIN])).toBeUndefined();
    expect(validateUrl("https://example.com", [FRIDAY_BROWSER_ALLOW_ANY_ORIGIN])).toBeUndefined();
  });

  it("B4 default-deny: rejects valid http URLs when allowedOrigins is empty", () => {
    const error = validateUrl("https://example.com", []);
    expect(error).toBeDefined();
    expect(error).toContain("not in the allowed origins");
  });

  it("rejects file: protocol", () => {
    const error = validateUrl("file:///etc/passwd", []);
    expect(error).toContain("not allowed");
  });

  it("rejects data: protocol", () => {
    const error = validateUrl("data:text/html,test", []);
    expect(error).toContain("not allowed");
  });

  it("rejects invalid URLs", () => {
    const error = validateUrl("not-a-url", []);
    expect(error).toContain("Invalid URL");
  });

  it("enforces allowed origins", () => {
    const error = validateUrl("https://blocked.com", ["https://allowed.com"]);
    expect(error).toContain("not in the allowed origins");
  });

  it("allows matching origins", () => {
    const error = validateUrl("https://allowed.com/path", ["https://allowed.com"]);
    expect(error).toBeUndefined();
  });
});

// ─── Origin matching ───

describe("matchesOrigin", () => {
  it("matches exact origin", () => {
    expect(matchesOrigin("https://example.com/path", ["https://example.com"])).toBe(true);
  });

  it("rejects non-matching origin", () => {
    expect(matchesOrigin("https://other.com", ["https://example.com"])).toBe(false);
  });

  it("supports wildcard subdomain", () => {
    expect(matchesOrigin("https://sub.example.com/path", ["https://*.example.com"])).toBe(true);
    expect(matchesOrigin("https://example.com/path", ["https://*.example.com"])).toBe(false);
  });

  // B4 default-deny safety boundary: empty `allowedOrigins` is now deny-all,
  // not allow-all. Production deployments that don't pass `allowedOrigins`
  // (e.g. `friday-hub-bootstrap` as of this PR) must opt-in to allow-any
  // navigation via the explicit `FRIDAY_BROWSER_ALLOW_ANY_ORIGIN` sentinel.
  it("B4 default-deny: rejects every URL when allowedOrigins list is empty", () => {
    expect(matchesOrigin("https://anything.com", [])).toBe(false);
    expect(matchesOrigin("https://example.com", [])).toBe(false);
    expect(matchesOrigin("http://localhost:8080", [])).toBe(false);
    expect(matchesOrigin("file:///etc/passwd", [])).toBe(false);
  });

  it("B4 allow-any opt-in: FRIDAY_BROWSER_ALLOW_ANY_ORIGIN sentinel permits any URL", () => {
    expect(matchesOrigin("https://anything.com", [FRIDAY_BROWSER_ALLOW_ANY_ORIGIN])).toBe(true);
    expect(matchesOrigin("https://evil.example.com", [FRIDAY_BROWSER_ALLOW_ANY_ORIGIN])).toBe(true);
    expect(matchesOrigin("http://internal.host", [FRIDAY_BROWSER_ALLOW_ANY_ORIGIN])).toBe(true);
  });

  it("B4 allow-any sentinel can be combined with explicit origins (still allow-any)", () => {
    expect(matchesOrigin("https://anything.com", ["https://example.com", FRIDAY_BROWSER_ALLOW_ANY_ORIGIN])).toBe(true);
  });

  it("rejects invalid URLs", () => {
    expect(matchesOrigin("not-a-url", ["https://example.com"])).toBe(false);
  });
});

// ─── Artifact path sanitization ───

describe("sanitizeArtifactPathSegment", () => {
  it("sanitizes a normal session id", () => {
    const result = sanitizeArtifactPathSegment("my-session_01");
    expect(result).toBe("my-session_01");
  });

  it("throws for '..' segments", () => {
    expect(() => sanitizeArtifactPathSegment("..")).toThrow("Invalid artifact path segment");
  });

  it("throws for '.' segments", () => {
    expect(() => sanitizeArtifactPathSegment(".")).toThrow("Invalid artifact path segment");
  });

  it("throws for 'a/../b' traversal", () => {
    expect(() => sanitizeArtifactPathSegment("a/../b")).toThrow("Invalid artifact path segment");
  });

  it("throws for 'a\\\\..\\\\b' backslash traversal", () => {
    expect(() => sanitizeArtifactPathSegment("a\\..\\b")).toThrow("Invalid artifact path segment");
  });

  it("throws for empty input", () => {
    expect(() => sanitizeArtifactPathSegment("")).toThrow("Invalid artifact path segment");
  });

  it("throws for whitespace-only input", () => {
    expect(() => sanitizeArtifactPathSegment("   ")).toThrow("Invalid artifact path segment");
  });

  it("joins multi-segment paths with underscores", () => {
    const result = sanitizeArtifactPathSegment("a/b/c");
    expect(result).toBe("a_b_c");
  });
});
