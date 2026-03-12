import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../unit/satellites/_helpers/create-test-db.helper.js";
import {
  createFridayAgentRuntime,
  createFridayAgentEventEmitter,
  createFridayAgentToolRegistry,
} from "#agent";
import type {
  FridayAgentLlmClient,
  FridayAgentLlmStreamEvent,
  FridayAgentEventEmitter,
  FridayAgentToolDefinition,
} from "#agent";
import { createFridayBrowserManager, type FridayBrowserManager } from "#browser";

// ─── Mock Playwright objects ───

function makeMockPage(opts?: { url?: string; title?: string }) {
  const state = { url: opts?.url ?? "about:blank", title: opts?.title ?? "" };
  const page = {
    url: vi.fn().mockImplementation(() => state.url),
    title: vi.fn().mockImplementation(() => Promise.resolve(state.title)),
    goto: vi.fn().mockImplementation(async (url: string) => {
      state.url = url;
      state.title = `Page: ${new URL(url).hostname}`;
    }),
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
    evaluate: vi.fn().mockResolvedValue([]),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    pdf: vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    locator: vi.fn().mockReturnValue({
      ariaSnapshot: vi.fn().mockResolvedValue("- heading: Example"),
    }),
  };
  return page;
}

function makeMockContext() {
  return {
    newPage: vi.fn().mockImplementation(() => Promise.resolve(makeMockPage())),
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockBrowser(opts?: { connected?: boolean }) {
  const context = makeMockContext();
  return {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(opts?.connected ?? true),
    _context: context,
  };
}

// ─── Mock LLM ───

function createMockLlmClient(
  eventBatches: FridayAgentLlmStreamEvent[][],
): FridayAgentLlmClient {
  let callIndex = 0;
  return {
    async *stream() {
      const batch = eventBatches[callIndex] ?? [];
      callIndex++;
      for (const event of batch) {
        yield event;
      }
    },
  };
}

// ─── Integration Tests ───

describe("Browser Resilience Integration", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;
  let eventEmitter: FridayAgentEventEmitter;
  const NOW = "2026-03-02T12:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
    eventEmitter = createFridayAgentEventEmitter();
  });

  afterEach(() => {
    db.close();
  });

  function buildRuntime(opts: {
    llmEvents: FridayAgentLlmStreamEvent[][];
    browserManager: FridayBrowserManager;
    extraTools?: FridayAgentToolDefinition[];
  }) {
    const tools = createFridayAgentToolRegistry({
      workdir: "/tmp/test",
      browserManager: opts.browserManager,
    });
    if (opts.extraTools && opts.extraTools.length > 0) {
      tools.push(...opts.extraTools);
    }

    const runtime = createFridayAgentRuntime({
      db,
      llmClient: createMockLlmClient(opts.llmEvents),
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are Friday with full computer control.",
      tools,
      eventEmitter,
      idGenerator,
      nowIso: () => NOW,
    });

    return runtime;
  }

  function createFailingWebFetchTool(spy?: ReturnType<typeof vi.fn>): FridayAgentToolDefinition {
    return {
      name: "web_fetch",
      description: "Failing web_fetch for fallback test",
      parameters: {
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
      async execute(args) {
        spy?.(args);
        return {
          content: "Fetch error: upstream DNS timeout",
          isError: true,
        };
      },
    };
  }

  it("agent opens a URL via browser tool end-to-end", async () => {
    const launchImpl = vi.fn().mockImplementation(() => Promise.resolve(makeMockBrowser()));

    const browserManager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    // LLM calls browser.open, then responds with text
    const runtime = buildRuntime({
      browserManager,
      llmEvents: [
        // Turn 1: LLM calls browser tool
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "browser",
            input: { action: "open", url: "https://www.google.com" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 100, outputTokens: 50 },
        ],
        // Turn 2: LLM sees tool result, responds with text
        [
          { type: "text_delta", text: "I've opened Google for you." },
          { type: "message_end", stopReason: "end_turn", inputTokens: 150, outputTokens: 20 },
        ],
      ],
    });

    const result = await runtime.executeRun({ task: "open google", sessionKey: "test-session" });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("opened Google");
    expect(result.toolCallCount).toBe(1);
    expect(launchImpl).toHaveBeenCalledOnce();
  });

  it("agent recovers from browser disconnect and re-opens", async () => {
    let callCount = 0;
    const deadBrowser = makeMockBrowser({ connected: true });
    const liveBrowser = makeMockBrowser({ connected: true });

    const launchImpl = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount === 1 ? deadBrowser : liveBrowser);
    });

    const browserManager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    // Pre-launch a session, then kill the browser
    await browserManager.launch("default");
    deadBrowser.isConnected.mockReturnValue(false);

    // LLM calls browser.open (will find dead session, auto-recover)
    const runtime = buildRuntime({
      browserManager,
      llmEvents: [
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "browser",
            input: { action: "open", url: "https://www.facebook.com" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 100, outputTokens: 50 },
        ],
        [
          { type: "text_delta", text: "Facebook is now open." },
          { type: "message_end", stopReason: "end_turn", inputTokens: 150, outputTokens: 20 },
        ],
      ],
    });

    const result = await runtime.executeRun({ task: "open facebook", sessionKey: "test-session" });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("Facebook");
    // Should have launched twice: once pre-test, once for recovery
    expect(launchImpl).toHaveBeenCalledTimes(2);
  });

  it("agent opens multiple sites sequentially", async () => {
    const launchImpl = vi.fn().mockImplementation(() => Promise.resolve(makeMockBrowser()));

    const browserManager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    // LLM opens google, then navigates to facebook
    const runtime = buildRuntime({
      browserManager,
      llmEvents: [
        // Turn 1: open google
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "browser",
            input: { action: "open", url: "https://www.google.com" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 100, outputTokens: 50 },
        ],
        // Turn 2: navigate to facebook
        [
          {
            type: "tool_use",
            id: "call-2",
            name: "browser",
            input: { action: "navigate", sessionId: "default", url: "https://www.facebook.com" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 200, outputTokens: 50 },
        ],
        // Turn 3: text reply
        [
          { type: "text_delta", text: "Done. Opened Google then navigated to Facebook." },
          { type: "message_end", stopReason: "end_turn", inputTokens: 300, outputTokens: 30 },
        ],
      ],
    });

    const result = await runtime.executeRun({ task: "open google then facebook", sessionKey: "test-session" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(2);
    // Browser only launched once (session reused for navigate)
    expect(launchImpl).toHaveBeenCalledOnce();
  });

  it("images extracted from browser screenshot tool calls", async () => {
    const launchImpl = vi.fn().mockImplementation(() => Promise.resolve(makeMockBrowser()));

    const browserManager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    // LLM opens url then takes a screenshot
    const runtime = buildRuntime({
      browserManager,
      llmEvents: [
        // Turn 1: open
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "browser",
            input: { action: "open", url: "https://www.example.com" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 100, outputTokens: 50 },
        ],
        // Turn 2: screenshot
        [
          {
            type: "tool_use",
            id: "call-2",
            name: "browser",
            input: { action: "screenshot", sessionId: "default" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 200, outputTokens: 50 },
        ],
        // Turn 3: text reply
        [
          { type: "text_delta", text: "Screenshot taken." },
          { type: "message_end", stopReason: "end_turn", inputTokens: 300, outputTokens: 20 },
        ],
      ],
    });

    const result = await runtime.executeRun({ task: "open example.com and screenshot", sessionKey: "test-session" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(2);
    // Image extraction picks up the screenshot path
    expect(result.images).toBeDefined();
    expect(result.images!.length).toBeGreaterThan(0);
    expect(result.images![0]).toMatch(/\.png$/);
  });

  it("channel-agnostic: no tools are disabled for any channel", async () => {
    // This test verifies the contract that resolveFridayChannelDisabledToolNames
    // returns [] for all channel kinds — tested inline here for integration coverage
    const { resolveFridayChannelDisabledToolNames } = await import("#hub");

    for (const channel of ["discord", "telegram", "slack", "webchat", "unknown"]) {
      expect(resolveFridayChannelDisabledToolNames(channel)).toEqual([]);
    }
  });

  it("auto-fallbacks web_fetch failure to browser open/snapshot", async () => {
    const launchImpl = vi.fn().mockImplementation(() => Promise.resolve(makeMockBrowser()));
    const webFetchSpy = vi.fn();

    const browserManager = createFridayBrowserManager({
      workspaceRoot: "/tmp/test",
      launchImpl: launchImpl as never,
    });

    const runtime = buildRuntime({
      browserManager,
      extraTools: [createFailingWebFetchTool(webFetchSpy)],
      llmEvents: [
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "web_fetch",
            input: { url: "https://www.youtube.com/watch?v=test" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 90, outputTokens: 45 },
        ],
        [
          { type: "text_delta", text: "Fallback succeeded and I extracted the page snapshot." },
          { type: "message_end", stopReason: "end_turn", inputTokens: 120, outputTokens: 24 },
        ],
      ],
    });

    const result = await runtime.executeRun({
      task: "Summarize this URL https://www.youtube.com/watch?v=test",
      sessionKey: "test-session",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(result.response).toContain("Fallback succeeded");
    expect(result.response).not.toContain("no successful tool call evidence");
    expect(webFetchSpy).toHaveBeenCalledTimes(1);
    // Browser launch indicates runtime-level fallback executed.
    expect(launchImpl).toHaveBeenCalledTimes(1);
  });
});
