import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFridayAgentBrowserTool } from "#agent";
import { FRIDAY_BROWSER_ALLOW_ANY_ORIGIN, type FridayBrowserManager, type BrowserSession } from "#browser";

// ─── Mock helpers ───

function createMockPage(overrides?: Partial<Record<string, unknown>>) {
  return {
    url: vi.fn().mockReturnValue("https://example.com"),
    title: vi.fn().mockResolvedValue("Example"),
    goto: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("PNG_DATA")),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
    removeListener: vi.fn(),
    off: vi.fn(),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    evaluate: vi.fn().mockResolvedValue([
      { elementId: "e0", tag: "button", role: "button", name: "Submit", selector: "button.submit" },
      { elementId: "e1", tag: "input", role: "textbox", name: "Email", selector: "#email" },
    ]),
    locator: vi.fn().mockImplementation(() => {
      const loc: Record<string, unknown> = {
        ariaSnapshot: vi.fn().mockResolvedValue(
          "- heading \"Hello\" [level=1]\n- button \"Submit\"",
        ),
        first: vi.fn().mockImplementation(() => loc),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        hover: vi.fn().mockResolvedValue(undefined),
        focus: vi.fn().mockResolvedValue(undefined),
        selectOption: vi.fn().mockResolvedValue(undefined),
      };
      return loc;
    }),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

function createMockManager(overrides?: Partial<FridayBrowserManager>): FridayBrowserManager {
  const mockPage = createMockPage();
  const elementCache = new Map<string, string>();
  const tabs = new Map<string, unknown>([["tab-1", mockPage]]);
  const presentation = {
    configuredMode: "auto" as const,
    activeMode: "headless" as const,
    targetBrowser: "Playwright Chromium",
    sessionId: "test-session",
    tabId: "tab-1",
  };
  const session: BrowserSession = {
    browser: {} as never,
    context: {} as never,
    tabs: tabs as never,
    activeTabId: "tab-1",
    elementCache,
    tabCounter: 1,
    presentation,
  };
  const sessions = new Map<string, BrowserSession>([["test-session", session]]);

  return {
    launch: vi.fn().mockResolvedValue({ sessionId: "test-session", tabId: "tab-1", reused: false }),
    getPage: vi.fn().mockResolvedValue({ tabId: "tab-1", page: mockPage }),
    getSession: vi.fn().mockImplementation((id: string) => sessions.get(id)),
    snapshotAria: vi.fn().mockResolvedValue(
      "- heading \"Hello\" [level=1]\n- button \"Submit\"",
    ),
    close: vi.fn().mockResolvedValue(undefined),
    getDiagnostics: vi.fn().mockReturnValue(presentation),
    getDiagnosticsSummary: vi.fn().mockReturnValue({
      presentation,
      sessionCount: 1,
      profiles: [],
    }),
    listSessions: vi.fn().mockImplementation((profile?: string) => {
      const result: Array<{ sessionId: string; profile?: unknown; tabCount: number; activeTabId: string }> = [];
      for (const [sid, s] of sessions) {
        if (profile !== undefined && s.profile?.name !== profile) continue;
        result.push({ sessionId: sid, profile: s.profile, tabCount: s.tabs.size, activeTabId: s.activeTabId });
      }
      return result;
    }),
    getSessionsByProfile: vi.fn().mockImplementation((profile: string) => {
      const result: Array<{ sessionId: string; session: BrowserSession }> = [];
      for (const [sid, s] of sessions) {
        if (s.profile?.name === profile) result.push({ sessionId: sid, session: s });
      }
      return result;
    }),
    sessions: sessions as ReadonlyMap<string, BrowserSession>,
    options: {
      workspaceRoot: "/tmp/test-workspace",
      // Default-allow for tests that don't specifically test origin filtering.
      // Origin-filtering tests override this with explicit lists below.
      allowedOrigins: [FRIDAY_BROWSER_ALLOW_ANY_ORIGIN],
      headless: true,
      maxSessions: 3,
      maxTabsPerSession: 8,
      maxTotalPages: 16,
      navigationTimeoutMs: 20_000,
      actionTimeoutMs: 10_000,
    },
    ...overrides,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

// ─── Tests ───

describe("FridayAgentBrowserTool", () => {
  let manager: FridayBrowserManager;

  beforeEach(() => {
    manager = createMockManager();
  });

  // ─── Tool definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentBrowserTool({ browserManager: manager });
    expect(tool.name).toBe("browser");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
  });

  // ─── Validation ───

  it("rejects missing action", async () => {
    const tool = createFridayAgentBrowserTool({ browserManager: manager });
    await expect(
      tool.execute({ sessionId: "s1" }, signal()),
    ).rejects.toThrow("action is required");
  });

  it("rejects missing session identifiers", async () => {
    const tool = createFridayAgentBrowserTool({ browserManager: manager });
    // With no sessionId, targetId, or profile, the tool should error
    const result = await tool.execute({ action: "navigate", url: "https://example.com" }, signal());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No session specified");
  });

  it("rejects invalid action", async () => {
    const tool = createFridayAgentBrowserTool({ browserManager: manager });
    const result = await tool.execute(
      { action: "explode", sessionId: "s1" },
      signal(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid action");
  });

  // ─── Open action ───

  describe("open", () => {
    it("launches a session without URL", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "open", sessionId: "test-session" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.sessionId).toBe("test-session");
      expect(parsed.tabId).toBe("tab-1");
      expect(manager.launch).toHaveBeenCalledWith("test-session", expect.any(AbortSignal), undefined, undefined);
    });

    it("launches a session and navigates to URL", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "open", sessionId: "test-session", url: "https://example.com" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.url).toBe("https://example.com");
    });

    it("rejects blocked protocols on open", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "open", sessionId: "test-session", url: "file:///etc/passwd" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not allowed");
    });

    it("uses default session when open is called without sessionId/profile", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "open", url: "https://example.com" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.sessionId).toBe("default");
      expect(manager.launch).toHaveBeenCalledWith("default", expect.any(AbortSignal), undefined, undefined);
    });

    it("start alias also uses default session when session params are omitted", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "start" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.sessionId).toBe("default");
      expect(manager.launch).toHaveBeenCalledWith("default", expect.any(AbortSignal), undefined, undefined);
    });

    it("includes visible desktop presentation metadata when the session is backed by host Chrome", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const session = manager.getSession("test-session");
      if (!session) {
        throw new Error("test-session should exist");
      }
      session.presentation = {
        configuredMode: "auto",
        activeMode: "host_chrome_visible",
        targetBrowser: "Google Chrome",
        sessionId: "test-session",
        tabId: "tab-1",
      };

      const result = await tool.execute(
        { action: "open", sessionId: "test-session", url: "https://www.facebook.com" },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.presentationMode).toBe("host_chrome_visible");
      expect(parsed.targetBrowser).toBe("Google Chrome");
      expect(parsed.presentationSummary).toBe("example.com · visible desktop");
      expect(result.metadata?.browserPresentation).toMatchObject({
        presentationMode: "host_chrome_visible",
        targetBrowser: "Google Chrome",
        sessionId: "test-session",
        tabId: "tab-1",
      });
    });
  });

  // ─── Navigate action ───

  describe("navigate", () => {
    it("navigates to a URL", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "navigate", sessionId: "test-session", url: "https://example.com/page" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const mockPage = (await manager.getPage("test-session")).page;
      expect(mockPage.goto).toHaveBeenCalled();
    });

    it("rejects missing URL on navigate", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "navigate", sessionId: "test-session" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("url is required");
    });

    it("rejects non-http URL on navigate", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "navigate", sessionId: "test-session", url: "data:text/html,<h1>hi</h1>" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not allowed");
    });
  });

  // ─── Screenshot action ───

  describe("screenshot", () => {
    it("captures screenshot in path mode", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "screenshot", sessionId: "test-session" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.mode).toBe("path");
      expect(parsed.mimeType).toBe("image/png");
      expect(parsed.path).toContain("test-session");
    });

    it("captures screenshot in base64 mode", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "screenshot", sessionId: "test-session", screenshotMode: "base64" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.mode).toBe("base64");
      expect(parsed.base64).toBeTruthy();
    });

    it("respects fullPage option", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      await tool.execute(
        { action: "screenshot", sessionId: "test-session", fullPage: true },
        signal(),
      );
      const mockPage = (await manager.getPage("test-session")).page;
      expect(mockPage.screenshot).toHaveBeenCalledWith({ fullPage: true, type: "png" });
    });
  });

  // ─── Snapshot action ───

  describe("snapshot", () => {
    it("returns AX tree and interactive elements", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "snapshot", sessionId: "test-session" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.axTree).toBeDefined();
      expect(parsed.axText).toContain("heading");
      expect(parsed.interactive).toHaveLength(2);
      expect(parsed.interactive[0].elementId).toBe("e0");
    });

    it("uses snapshotAria from browser manager", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      await tool.execute(
        { action: "snapshot", sessionId: "test-session" },
        signal(),
      );
      expect(manager.snapshotAria).toHaveBeenCalledWith(
        "test-session",
        { tabId: "tab-1" },
        expect.any(AbortSignal),
      );
    });

    it("caches element IDs for later act calls", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      await tool.execute(
        { action: "snapshot", sessionId: "test-session" },
        signal(),
      );
      const session = manager.getSession("test-session")!;
      expect(session.elementCache.get("e0")).toBe("button.submit");
      expect(session.elementCache.get("e1")).toBe("#email");
    });
  });

  // ─── Act action ───

  describe("act", () => {
    it("clicks via selector", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "act", sessionId: "test-session", act: "click", selector: "button.submit" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const mockPage = (await manager.getPage("test-session")).page;
      expect(mockPage.locator).toHaveBeenCalledWith("button.submit:visible");
    });

    it("types text via selector", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "act", sessionId: "test-session", act: "type", selector: "#email", text: "test@example.com" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const mockPage = (await manager.getPage("test-session")).page;
      expect(mockPage.locator).toHaveBeenCalledWith("#email:visible");
    });

    it("presses a key", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "act", sessionId: "test-session", act: "press", selector: "#email", key: "Enter" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const mockPage = (await manager.getPage("test-session")).page;
      expect(mockPage.locator).toHaveBeenCalledWith("#email:visible");
      expect(mockPage.keyboard.press).toHaveBeenCalledWith("Enter");
    });

    it("clicks via cached elementId", async () => {
      // Populate element cache first
      const session = manager.getSession("test-session")!;
      session.elementCache.set("e0", "button.submit");

      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "act", sessionId: "test-session", act: "click", elementId: "e0" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const mockPage = (await manager.getPage("test-session")).page;
      expect(mockPage.locator).toHaveBeenCalledWith("button.submit:visible");
    });

    it("rejects missing act kind", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "act", sessionId: "test-session", selector: "button" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("act is required");
    });

    it("rejects invalid act kind", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "act", sessionId: "test-session", act: "destroy", selector: "button" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid act kind");
    });

    it("rejects missing selector and elementId", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "act", sessionId: "test-session", act: "click" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("selector or elementId is required");
    });

    it("rejects uncached elementId", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "act", sessionId: "test-session", act: "click", elementId: "e999" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found in cache");
    });

    it("rejects type without text", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "act", sessionId: "test-session", act: "type", selector: "#email" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("text is required");
    });

    it("rejects press without key", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "act", sessionId: "test-session", act: "press", selector: "#email" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("key is required");
    });
  });

  // ─── Tabs action ───

  describe("tabs", () => {
    it("lists tabs", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "tabs", sessionId: "test-session", tabsAction: "list" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.tabs).toHaveLength(1);
      expect(parsed.tabs[0].active).toBe(true);
    });

    it("defaults to list when tabsAction omitted", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "tabs", sessionId: "test-session" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.tabs).toBeDefined();
    });

    it("rejects invalid tabsAction", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "tabs", sessionId: "test-session", tabsAction: "explode" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid tabsAction");
    });
  });

  // ─── Close action ───

  describe("close", () => {
    it("closes a session", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        { action: "close", sessionId: "test-session" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.closed).toBe(true);
      expect(manager.close).toHaveBeenCalledWith("test-session");
    });
  });

  // ─── Error handling ───

  describe("error handling", () => {
    it("catches and returns browser manager errors", async () => {
      const errorManager = createMockManager({
        getPage: vi.fn().mockRejectedValue(new Error("Session not found")),
        getSession: vi.fn().mockReturnValue({
          browser: {} as never,
          context: {} as never,
          tabs: new Map([["tab-1", {}]]) as never,
          activeTabId: "tab-1",
          elementCache: new Map(),
          tabCounter: 1,
        }),
      });
      const tool = createFridayAgentBrowserTool({ browserManager: errorManager });
      const result = await tool.execute(
        { action: "navigate", sessionId: "missing", url: "https://example.com" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Session not found");
    });

    it("handles abort signal", async () => {
      const errorManager = createMockManager({
        getPage: vi.fn().mockRejectedValue(new Error("aborted")),
        getSession: vi.fn().mockReturnValue({
          browser: {} as never,
          context: {} as never,
          tabs: new Map([["tab-1", {}]]) as never,
          activeTabId: "tab-1",
          elementCache: new Map(),
          tabCounter: 1,
        }),
      });
      const tool = createFridayAgentBrowserTool({ browserManager: errorManager });
      const result = await tool.execute(
        { action: "navigate", sessionId: "test", url: "https://example.com" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("aborted");
    });
  });

  // ─── Upload path restriction ───

  describe("upload", () => {
    it("rejects paths outside workspace and temp dirs", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        {
          action: "upload",
          sessionId: "test-session",
          selector: "input[type=file]",
          filePaths: ["/etc/passwd"],
        },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside allowed directories");
    });

    it("rejects traversal paths", async () => {
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        {
          action: "upload",
          sessionId: "test-session",
          selector: "input[type=file]",
          filePaths: ["/tmp/test-workspace/../../etc/passwd"],
        },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside allowed directories");
    });

    it("accepts paths within workspace dir (containment check passes)", async () => {
      // We can't mock fs.existsSync in ESM, so we just test the path
      // containment logic by checking that workspace-internal paths
      // don't get the "outside allowed directories" error.
      // The file existence check will fail instead (expected).
      const tool = createFridayAgentBrowserTool({ browserManager: manager });
      const result = await tool.execute(
        {
          action: "upload",
          sessionId: "test-session",
          selector: "input[type=file]",
          filePaths: ["/tmp/test-workspace/myfile.txt"],
        },
        signal(),
      );
      // Should fail with "File not found" (not "outside allowed directories")
      expect(result.isError).toBe(true);
      expect(result.content).toContain("File not found");
      expect(result.content).not.toContain("outside allowed directories");
    });
  });

  // ─── Dialog cleanup ───

  describe("dialog", () => {
    it("removes listener on timeout to prevent stale handlers", async () => {
      const removeListenerSpy = vi.fn();
      const mockPage = createMockPage({
        once: vi.fn(), // never fires dialog
        removeListener: removeListenerSpy,
      });
      const tabs = new Map([["tab-1", mockPage]]);
      const session: BrowserSession = {
        browser: {} as never,
        context: {} as never,
        tabs: tabs as never,
        activeTabId: "tab-1",
        elementCache: new Map(),
        tabCounter: 1,
      };
      const dialogManager = createMockManager({
        getSession: vi.fn().mockReturnValue(session),
        getPage: vi.fn().mockResolvedValue({ tabId: "tab-1", page: mockPage }),
      });

      const tool = createFridayAgentBrowserTool({ browserManager: dialogManager });
      const result = await tool.execute(
        {
          action: "dialog",
          sessionId: "test-session",
          timeMs: 50, // short timeout
        },
        signal(),
      );

      // Should have timed out
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.dialog).toBeNull();
      expect(parsed.message).toContain("No dialog appeared");

      // Verify removeListener was called to clean up the stale handler
      expect(removeListenerSpy).toHaveBeenCalledWith("dialog", expect.any(Function));
    });
  });

  // ─── Origin restrictions ───

  describe("origin restrictions", () => {
    it("rejects URLs outside allowed origins", async () => {
      const restrictedManager = createMockManager();
      (restrictedManager as { options: FridayBrowserManager["options"] }).options = {
        ...restrictedManager.options,
        allowedOrigins: ["https://allowed.com"],
      };
      const tool = createFridayAgentBrowserTool({ browserManager: restrictedManager });
      const result = await tool.execute(
        { action: "navigate", sessionId: "test-session", url: "https://blocked.com" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not in the allowed origins");
    });

    it("allows URLs matching allowed origins", async () => {
      const restrictedManager = createMockManager();
      (restrictedManager as { options: FridayBrowserManager["options"] }).options = {
        ...restrictedManager.options,
        allowedOrigins: ["https://allowed.com"],
      };
      const tool = createFridayAgentBrowserTool({ browserManager: restrictedManager });
      const result = await tool.execute(
        { action: "navigate", sessionId: "test-session", url: "https://allowed.com/page" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
    });
  });
});
