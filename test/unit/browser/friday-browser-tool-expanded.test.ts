import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFridayBrowserManager, type FridayBrowserManager } from "#browser";
import { createFridayAgentBrowserTool } from "../../../src/agent/tools/friday-agent-browser-tool.js";

// ─── Mock Playwright objects ───

function createMockPage() {
  const page = {
    url: vi.fn().mockReturnValue("https://example.com"),
    title: vi.fn().mockResolvedValue("Example"),
    goto: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    dragAndDrop: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(null),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    pdf: vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    locator: vi.fn().mockImplementation(() => {
      const loc = {
        ariaSnapshot: vi.fn().mockResolvedValue("- heading: Example"),
        first: vi.fn().mockImplementation(() => loc),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        hover: vi.fn().mockResolvedValue(undefined),
        focus: vi.fn().mockResolvedValue(undefined),
        selectOption: vi.fn().mockResolvedValue(undefined),
      };
      return loc;
    }),
  };
  return page;
}

function createMockContext() {
  const pages: ReturnType<typeof createMockPage>[] = [];
  return {
    newPage: vi.fn().mockImplementation(() => {
      const page = createMockPage();
      pages.push(page);
      return Promise.resolve(page);
    }),
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    _pages: pages,
  };
}

function createMockBrowser() {
  const context = createMockContext();
  return {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    _context: context,
  };
}

function createMockLaunch() {
  return vi.fn().mockImplementation(() => Promise.resolve(createMockBrowser()));
}

// ─── Tests ───

describe("Browser Tool — Expanded Actions", () => {
  let manager: FridayBrowserManager;
  let launchImpl: ReturnType<typeof createMockLaunch>;
  let tool: ReturnType<typeof createFridayAgentBrowserTool>;
  const signal = new AbortController().signal;

  beforeEach(() => {
    launchImpl = createMockLaunch();
    manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });
    tool = createFridayAgentBrowserTool({ browserManager: manager });
  });

  // ─── Profile & TargetId Support ───

  describe("profile and targetId", () => {
    it("opens browser with profile metadata", async () => {
      const result = await tool.execute(
        { action: "open", sessionId: "s1", profile: "chrome" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.sessionId).toBe("s1");
      expect(data.profile).toBe("chrome");
    });

    it("resolves session via targetId", async () => {
      // Launch a session first
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      // Navigate using targetId
      const result = await tool.execute(
        { action: "navigate", targetId: "s1:tab-1", url: "https://example.com" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.sessionId).toBe("s1");
      expect(data.tabId).toBe("tab-1");
    });
  });

  // ─── Status Action ───

  describe("status action", () => {
    it("returns empty session list when no browsers open", async () => {
      const result = await tool.execute({ action: "status" }, signal);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.totalSessions).toBe(0);
      expect(data.sessions).toEqual([]);
    });

    it("returns session list with active sessions", async () => {
      await tool.execute({ action: "open", sessionId: "s1", profile: "chrome" }, signal);
      await tool.execute({ action: "open", sessionId: "s2" }, signal);

      const result = await tool.execute({ action: "status" }, signal);
      const data = JSON.parse(result.content as string);
      expect(data.totalSessions).toBe(2);
      expect(data.sessions).toHaveLength(2);
    });

    it("filters by profile", async () => {
      await tool.execute({ action: "open", sessionId: "s1", profile: "chrome" }, signal);
      await tool.execute({ action: "open", sessionId: "s2", profile: "openclaw" }, signal);

      const result = await tool.execute(
        { action: "status", profile: "chrome" },
        signal,
      );
      const data = JSON.parse(result.content as string);
      expect(data.totalSessions).toBe(1);
      expect(data.sessions[0].profile).toBe("chrome");
    });
  });

  // ─── Profiles Action ───

  describe("profiles action", () => {
    it("lists active profiles", async () => {
      await tool.execute({ action: "open", sessionId: "s1", profile: "chrome" }, signal);
      await tool.execute({ action: "open", sessionId: "s2", profile: "chrome" }, signal);
      await tool.execute({ action: "open", sessionId: "s3", profile: "openclaw" }, signal);

      const result = await tool.execute({ action: "profiles" }, signal);
      const data = JSON.parse(result.content as string);
      expect(data.profiles).toContainEqual({ name: "chrome", sessionCount: 2 });
      expect(data.profiles).toContainEqual({ name: "openclaw", sessionCount: 1 });
    });

    it("shows (default) for sessions without profile", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute({ action: "profiles" }, signal);
      const data = JSON.parse(result.content as string);
      expect(data.profiles).toContainEqual({ name: "(default)", sessionCount: 1 });
    });
  });

  // ─── Start / Stop Actions ───

  describe("start/stop actions", () => {
    it("start is an alias for open", async () => {
      const result = await tool.execute(
        { action: "start", sessionId: "s1", profile: "chrome" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.sessionId).toBe("s1");
    });

    it("stop closes all sessions", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);
      await tool.execute({ action: "open", sessionId: "s2" }, signal);

      const result = await tool.execute({ action: "stop" }, signal);
      const data = JSON.parse(result.content as string);
      expect(data.closedAll).toBe(true);
      expect(manager.sessions.size).toBe(0);
    });

    it("stop closes sessions by profile", async () => {
      await tool.execute({ action: "open", sessionId: "s1", profile: "chrome" }, signal);
      await tool.execute({ action: "open", sessionId: "s2", profile: "openclaw" }, signal);

      const result = await tool.execute({ action: "stop", profile: "chrome" }, signal);
      const data = JSON.parse(result.content as string);
      expect(data.profile).toBe("chrome");
      expect(data.closedSessions).toBe(1);
      expect(manager.sessions.size).toBe(1);
      expect(manager.sessions.has("s2")).toBe(true);
    });
  });

  // ─── Focus Action ───

  describe("focus action", () => {
    it("sets active tab and brings to front", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "focus", sessionId: "s1", tabId: "tab-1" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.sessionId).toBe("s1");
      expect(data.tabId).toBe("tab-1");
    });
  });

  // ─── Console Action ───

  describe("console action", () => {
    it("evaluates expression when text provided", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "console", sessionId: "s1", text: "document.title" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.sessionId).toBe("s1");
    });

    it("returns guidance when no text provided", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "console", sessionId: "s1" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.message).toContain("evaluate an expression");
    });
  });

  // ─── Expanded Act Kinds ───

  describe("expanded act kinds", () => {
    it("act:hover hovers over element", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "hover", selector: "#btn" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.act).toBe("hover");
    });

    it("act:drag drags from source to target", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        {
          action: "act",
          sessionId: "s1",
          act: "drag",
          selector: "#source",
          endSelector: "#target",
        },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.act).toBe("drag");
    });

    it("act:drag requires endSelector", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "drag", selector: "#source" },
        signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("endSelector is required");
    });

    it("act:select selects options", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        {
          action: "act",
          sessionId: "s1",
          act: "select",
          selector: "#dropdown",
          values: ["opt1", "opt2"],
        },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.act).toBe("select");
    });

    it("act:select requires values", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "select", selector: "#dropdown" },
        signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Values array is required");
    });

    it("act:fill fills a field", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        {
          action: "act",
          sessionId: "s1",
          act: "fill",
          selector: "#email",
          text: "test@example.com",
        },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.act).toBe("fill");
    });

    it("act:resize resizes viewport", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "resize", width: 800, height: 600 },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.act).toBe("resize");
    });

    it("act:resize requires at least width or height", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "resize" },
        signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Width and/or height are required");
    });

    it("act:wait waits for timeout", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "wait", timeMs: 100 },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.act).toBe("wait");
    });

    it("act:wait with selector waits for element", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "wait", selector: "#loading", timeMs: 5000 },
        signal,
      );
      expect(result.isError).toBeUndefined();
    });

    it("act:evaluate evaluates JavaScript", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "evaluate", text: "1 + 1" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.act).toBe("evaluate");
    });

    it("act:close closes the current tab", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "close" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.act).toBe("close");
      expect(data.closedTabId).toBe("tab-1");
    });
  });

  // ─── Upload Action ───

  describe("upload action", () => {
    it("requires filePaths", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "upload", sessionId: "s1", selector: "#file-input" },
        signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("filePaths array is required");
    });
  });

  // ─── Dialog Action ───

  describe("dialog action", () => {
    it("times out when no dialog appears", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "dialog", sessionId: "s1", accept: true, timeMs: 50 },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.dialog).toBeNull();
      expect(data.message).toContain("No dialog appeared");
    });
  });

  // ─── Invalid Actions ───

  describe("validation", () => {
    it("rejects invalid action", async () => {
      const result = await tool.execute(
        { action: "invalid_action", sessionId: "s1" },
        signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid action");
    });

    it("rejects invalid act kind", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "invalid_kind", selector: "#x" },
        signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid act kind");
    });
  });

  // ─── Backward Compatibility ───

  describe("backward compatibility", () => {
    it("original open action still works with just sessionId", async () => {
      const result = await tool.execute(
        { action: "open", sessionId: "s1", url: "https://example.com" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.sessionId).toBe("s1");
    });

    it("original act:click still works", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "click", selector: "#btn" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.act).toBe("click");
    });

    it("original act:type still works", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "type", selector: "#input", text: "hello" },
        signal,
      );
      expect(result.isError).toBeUndefined();
    });

    it("original act:press still works", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "act", sessionId: "s1", act: "press", key: "Enter" },
        signal,
      );
      expect(result.isError).toBeUndefined();
    });

    it("original tabs action still works", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "tabs", sessionId: "s1", tabsAction: "list" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.tabs).toBeDefined();
    });

    it("original close action still works", async () => {
      await tool.execute({ action: "open", sessionId: "s1" }, signal);

      const result = await tool.execute(
        { action: "close", sessionId: "s1" },
        signal,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content as string);
      expect(data.closed).toBe(true);
    });
  });
});

// ─── Browser Manager Profile Tests ───

describe("FridayBrowserManager — Profile Support", () => {
  let launchImpl: ReturnType<typeof createMockLaunch>;

  beforeEach(() => {
    launchImpl = createMockLaunch();
  });

  describe("launch with profile", () => {
    it("stores profile metadata on session", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1", undefined, "chrome");
      const session = manager.getSession("s1");
      expect(session?.profile).toBeDefined();
      expect(session?.profile?.name).toBe("chrome");
      expect(session?.profile?.createdAt).toBeGreaterThan(0);
    });

    it("session without profile has undefined profile", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1");
      const session = manager.getSession("s1");
      expect(session?.profile).toBeUndefined();
    });
  });

  describe("listSessions", () => {
    it("lists all sessions", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1", undefined, "chrome");
      await manager.launch("s2", undefined, "openclaw");

      const sessions = manager.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it("filters by profile", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1", undefined, "chrome");
      await manager.launch("s2", undefined, "openclaw");
      await manager.launch("s3", undefined, "chrome");

      const chromeSessions = manager.listSessions("chrome");
      expect(chromeSessions).toHaveLength(2);
      expect(chromeSessions.every((s) => s.profile?.name === "chrome")).toBe(true);
    });

    it("returns empty array for unknown profile", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1", undefined, "chrome");
      expect(manager.listSessions("nonexistent")).toHaveLength(0);
    });
  });

  describe("getSessionsByProfile", () => {
    it("returns sessions matching profile", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      await manager.launch("s1", undefined, "chrome");
      await manager.launch("s2", undefined, "openclaw");

      const chrome = manager.getSessionsByProfile("chrome");
      expect(chrome).toHaveLength(1);
      expect(chrome[0].sessionId).toBe("s1");

      const openclaw = manager.getSessionsByProfile("openclaw");
      expect(openclaw).toHaveLength(1);
      expect(openclaw[0].sessionId).toBe("s2");
    });

    it("returns empty array for no matches", async () => {
      const manager = createFridayBrowserManager({
        workspaceRoot: "/tmp/test",
        launchImpl: launchImpl as never,
      });

      expect(manager.getSessionsByProfile("nonexistent")).toHaveLength(0);
    });
  });
});

// ─── Browser Tool — Disconnect Recovery ───

describe("Browser Tool — Disconnect Recovery", () => {
  const signal = new AbortController().signal;

  it("open retries on browser disconnect error", async () => {
    let callCount = 0;
    const deadBrowser = createMockBrowser();
    const liveBrowser = createMockBrowser();

    // First browser dies on page.goto
    const deadPage = deadBrowser._context._pages[0] ?? createMockPage();
    if (deadBrowser._context._pages.length === 0) {
      deadBrowser._context.newPage.mockResolvedValueOnce(deadPage);
    }

    const customLaunch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount <= 1 ? deadBrowser : liveBrowser);
    });

    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: customLaunch as never,
    });

    const tool = createFridayAgentBrowserTool({ browserManager: manager });

    // First launch succeeds, then mark browser as dead
    await manager.launch("default");
    deadBrowser.isConnected.mockReturnValue(false);

    // open should detect dead browser, evict, re-launch, and succeed
    const result = await tool.execute(
      { action: "open", sessionId: "default", url: "https://example.com" },
      signal,
    );
    expect(result.isError).toBeUndefined();
  });

  it("navigate retries on browser disconnect error", async () => {
    let callCount = 0;
    const deadBrowser = createMockBrowser();
    const liveBrowser = createMockBrowser();

    const customLaunch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount <= 1 ? deadBrowser : liveBrowser);
    });

    const manager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: customLaunch as never,
    });

    const tool = createFridayAgentBrowserTool({ browserManager: manager });

    // First launch succeeds, then mark browser as dead
    await manager.launch("default");
    deadBrowser.isConnected.mockReturnValue(false);

    // navigate should detect dead browser, close stale session, re-launch, and succeed
    const result = await tool.execute(
      { action: "navigate", sessionId: "default", url: "https://example.com" },
      signal,
    );
    expect(result.isError).toBeUndefined();
  });
});
