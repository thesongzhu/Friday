import { describe, it, expect, vi } from "vitest";
import { createFridayAgentCanvasTool } from "#agent";
import type { FridayBrowserManager } from "../../../../src/browser/friday-browser-manager.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function mockPage(overrides?: Record<string, unknown>) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    setContent: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue("https://example.com"),
    title: vi.fn().mockResolvedValue("Example"),
    evaluate: vi.fn().mockResolvedValue("eval-result"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("png-data")),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    ...overrides,
  };
}

function mockBrowserManager(page?: ReturnType<typeof mockPage>): FridayBrowserManager {
  const p = page ?? mockPage();
  return {
    launch: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn().mockResolvedValue({ page: p, context: {} }),
    close: vi.fn().mockResolvedValue(undefined),
    snapshotAria: vi.fn().mockResolvedValue("[document] Example page"),
  } as unknown as FridayBrowserManager;
}

describe("FridayAgentCanvasTool", () => {
  // ─── Definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentCanvasTool({ browserManager: mockBrowserManager() });
    expect(tool.name).toBe("canvas");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.required).toContain("action");
  });

  // ─── Present action ───

  it("presents a URL canvas", async () => {
    const bm = mockBrowserManager();
    const tool = createFridayAgentCanvasTool({ browserManager: bm });

    const result = await tool.execute(
      { action: "present", url: "https://example.com", canvasId: "test-1" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      canvasId: "test-1",
      url: "https://example.com",
      title: "Example",
    });
    expect(bm.launch).toHaveBeenCalled();
  });

  it("presents inline HTML", async () => {
    const bm = mockBrowserManager();
    const tool = createFridayAgentCanvasTool({ browserManager: bm });

    const result = await tool.execute(
      { action: "present", html: "<h1>Hello</h1>", canvasId: "html-1" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const p = (await bm.getPage("canvas:html-1", {}, signal())).page;
    expect(p.setContent).toHaveBeenCalled();
  });

  it("returns error when neither url nor html provided for present", async () => {
    const tool = createFridayAgentCanvasTool({ browserManager: mockBrowserManager() });

    const result = await tool.execute(
      { action: "present", canvasId: "empty" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("url");
  });

  // ─── Navigate action ───

  it("navigates an existing canvas", async () => {
    const bm = mockBrowserManager();
    const tool = createFridayAgentCanvasTool({ browserManager: bm });

    const result = await tool.execute(
      { action: "navigate", canvasId: "nav-1", url: "https://example.com/page" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.canvasId).toBe("nav-1");
  });

  // ─── Eval action ───

  it("evaluates JavaScript on a canvas", async () => {
    const bm = mockBrowserManager();
    const tool = createFridayAgentCanvasTool({ browserManager: bm });

    const result = await tool.execute(
      { action: "eval", canvasId: "eval-1", script: "document.title" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.result).toBe("eval-result");
  });

  // ─── Snapshot action ───

  it("takes a snapshot of a canvas", async () => {
    const bm = mockBrowserManager();
    const tool = createFridayAgentCanvasTool({ browserManager: bm });

    const result = await tool.execute(
      { action: "snapshot", canvasId: "snap-1" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.axTree).toBeDefined();
    expect(parsed.screenshot).toBeDefined();
  });

  // ─── URL validation (Issue 6 fix) ───

  it("rejects file:// URLs in present", async () => {
    const tool = createFridayAgentCanvasTool({ browserManager: mockBrowserManager() });

    const result = await tool.execute(
      { action: "present", url: "file:///etc/passwd", canvasId: "bad-1" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Disallowed URL scheme");
  });

  it("rejects javascript: URLs in present", async () => {
    const tool = createFridayAgentCanvasTool({ browserManager: mockBrowserManager() });

    const result = await tool.execute(
      { action: "present", url: "javascript:alert(1)", canvasId: "bad-2" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Disallowed URL scheme");
  });

  it("rejects file:// URLs in navigate", async () => {
    const tool = createFridayAgentCanvasTool({ browserManager: mockBrowserManager() });

    const result = await tool.execute(
      { action: "navigate", canvasId: "nav-sec", url: "file:///etc/shadow" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Disallowed URL scheme");
  });

  it("rejects loopback IPs in navigate", async () => {
    const tool = createFridayAgentCanvasTool({ browserManager: mockBrowserManager() });

    const result = await tool.execute(
      { action: "navigate", canvasId: "nav-loop", url: "http://127.0.0.1:8080/admin" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Loopback");
  });

  it("rejects private IP addresses in present", async () => {
    const tool = createFridayAgentCanvasTool({ browserManager: mockBrowserManager() });

    const result = await tool.execute(
      { action: "present", canvasId: "priv-1", url: "http://192.168.1.1/admin" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Private IP");
  });

  it("allows valid HTTPS URLs in navigate", async () => {
    const bm = mockBrowserManager();
    const tool = createFridayAgentCanvasTool({ browserManager: bm });

    const result = await tool.execute(
      { action: "navigate", canvasId: "nav-ok", url: "https://example.com/page" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
  });

  it("allows inline HTML without URL validation", async () => {
    const bm = mockBrowserManager();
    const tool = createFridayAgentCanvasTool({ browserManager: bm });

    const result = await tool.execute(
      { action: "present", html: "<h1>Safe HTML</h1>", canvasId: "html-safe" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
  });

  // ─── Parameter validation ───

  it("returns error for invalid action", async () => {
    const tool = createFridayAgentCanvasTool({ browserManager: mockBrowserManager() });

    const result = await tool.execute({ action: "delete" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid action");
  });

  // ─── Error handling ───

  it("returns error when browser manager throws", async () => {
    const bm: FridayBrowserManager = {
      launch: vi.fn().mockResolvedValue(undefined),
      getPage: vi.fn().mockRejectedValue(new Error("Browser crashed")),
      close: vi.fn().mockResolvedValue(undefined),
      snapshotAria: vi.fn(),
    } as unknown as FridayBrowserManager;
    const tool = createFridayAgentCanvasTool({ browserManager: bm });

    const result = await tool.execute(
      { action: "navigate", canvasId: "crash", url: "https://example.com" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Browser crashed");
  });
});
