import { beforeEach, describe, it, expect, vi, afterEach } from "vitest";
import { createFridayAgentWebFetchTool, createFridayAgentSsrfGuard, rewriteUrl } from "#agent";
import type { FridayAgentSsrfGuard } from "#agent";

describe("FridayAgentWebFetchTool", () => {
  const originalFetch = globalThis.fetch;
  const originalSuppression = process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = "1";
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSuppression === undefined) {
      delete process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;
    } else {
      process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = originalSuppression;
    }
    warnSpy?.mockRestore();
    warnSpy = null;
  });

  function signal(): AbortSignal {
    return new AbortController().signal;
  }

  function mockFetch(status: number, body: string, headers?: Record<string, string>): void {
    const responseHeaders = new Headers(headers ?? { "content-type": "text/plain" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: responseHeaders,
      text: () => Promise.resolve(body),
    }) as unknown as typeof fetch;
  }

  // ─── GET request ───

  it("performs GET request and returns response", async () => {
    mockFetch(200, "Hello World");
    const tool = createFridayAgentWebFetchTool();

    const result = await tool.execute(
      { url: "https://example.com" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("HTTP 200");
    expect(result.content).toContain("Hello World");
  });

  // ─── POST request ───

  it("performs POST request with body", async () => {
    mockFetch(201, '{"id":1}', { "content-type": "application/json" });
    const tool = createFridayAgentWebFetchTool();

    const result = await tool.execute(
      {
        url: "https://api.example.com/items",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"name":"test"}',
      },
      signal(),
    );

    expect(result.content).toContain("201");
    expect(result.content).toContain('{"id":1}');
  });

  // ─── Error response ───

  it("marks error responses with isError", async () => {
    mockFetch(404, "Not Found");
    const tool = createFridayAgentWebFetchTool();

    const result = await tool.execute(
      { url: "https://example.com/missing" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("404");
  });

  // ─── Invalid method ───

  it("rejects invalid HTTP methods", async () => {
    const tool = createFridayAgentWebFetchTool();

    const result = await tool.execute(
      { url: "https://example.com", method: "PATCH" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid HTTP method");
  });

  // ─── Network error ───

  it("handles network errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error("Network error"),
    ) as unknown as typeof fetch;
    const tool = createFridayAgentWebFetchTool();

    const result = await tool.execute(
      { url: "https://unreachable.example.com" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Fetch error");
  });

  // ─── Missing URL ───

  it("throws on missing url", async () => {
    const tool = createFridayAgentWebFetchTool();

    await expect(
      tool.execute({}, signal()),
    ).rejects.toThrow("url is required");
  });

  // ─── Tool definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentWebFetchTool();

    expect(tool.name).toBe("web_fetch");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
  });

  it("suppresses the missing SSRF guard warning in explicit test-warning suppression mode", () => {
    process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = "1";
    createFridayAgentWebFetchTool();
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("web_fetch tool created without SSRF guard"),
    );
  });

  // ─── SSRF guard: blocks localhost/private ───

  /**
   * Create a mock SSRF guard that performs synchronous URL checks (same as real guard)
   * but stubs out DNS resolution to avoid real network calls in tests.
   */
  function createTestSsrfGuard(): FridayAgentSsrfGuard {
    const realGuard = createFridayAgentSsrfGuard();
    return {
      validate: (url: string) => realGuard.validate(url),
      validateWithDns: async (url: string) => {
        // Run synchronous checks (protocol, hostname, literal IP)
        realGuard.validate(url);
        // Skip actual DNS resolution in unit tests
      },
    };
  }

  it("blocks localhost when SSRF guard is enabled", async () => {
    const tool = createFridayAgentWebFetchTool({ ssrfGuard: createTestSsrfGuard() });

    const result = await tool.execute(
      { url: "http://localhost/secret" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("SSRF guard");
    expect(result.content).toContain("blocked");
  });

  it("blocks private IP when SSRF guard is enabled", async () => {
    const tool = createFridayAgentWebFetchTool({ ssrfGuard: createTestSsrfGuard() });

    const result = await tool.execute(
      { url: "http://192.168.1.1/admin" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("SSRF guard");
  });

  it("allows public URL when SSRF guard is enabled (guarded fetch path)", async () => {
    mockFetch(200, "Public content");
    const tool = createFridayAgentWebFetchTool({ ssrfGuard: createTestSsrfGuard() });

    const result = await tool.execute(
      { url: "https://api.example.com/data" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Public content");
  });

  it("uses redirect: manual when SSRF guard is present", async () => {
    mockFetch(200, "ok");
    const tool = createFridayAgentWebFetchTool({ ssrfGuard: createTestSsrfGuard() });

    await tool.execute({ url: "https://safe.example.com" }, signal());

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://safe.example.com",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  // ─── Default browser-like headers ───

  describe("default browser headers", () => {
    it("sends User-Agent, Accept, Accept-Language by default", async () => {
      mockFetch(200, "ok");
      const tool = createFridayAgentWebFetchTool();

      await tool.execute({ url: "https://example.com" }, signal());

      const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers["User-Agent"]).toContain("Mozilla/5.0");
      expect(headers["Accept"]).toContain("text/html");
      expect(headers["Accept-Language"]).toContain("en-US");
    });

    it("user-supplied headers override defaults", async () => {
      mockFetch(200, "ok");
      const tool = createFridayAgentWebFetchTool();

      await tool.execute(
        { url: "https://example.com", headers: { "User-Agent": "MyBot/1.0", "X-Custom": "test" } },
        signal(),
      );

      const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe("MyBot/1.0");
      expect(headers["X-Custom"]).toBe("test");
      // Defaults that were NOT overridden should still be present
      expect(headers["Accept"]).toContain("text/html");
      expect(headers["Accept-Language"]).toContain("en-US");
    });
  });

  // ─── Reddit URL rewriting ───

  describe("Reddit URL rewriting", () => {
    it("rewrites www.reddit.com to old.reddit.com", async () => {
      mockFetch(200, "old reddit content");
      const tool = createFridayAgentWebFetchTool();

      await tool.execute(
        { url: "https://www.reddit.com/r/programming/comments/abc123/test" },
        signal(),
      );

      const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(calledUrl).toBe("https://old.reddit.com/r/programming/comments/abc123/test");
    });

    it("rewrites bare reddit.com to old.reddit.com", async () => {
      mockFetch(200, "old reddit content");
      const tool = createFridayAgentWebFetchTool();

      await tool.execute(
        { url: "https://reddit.com/r/technology" },
        signal(),
      );

      const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(calledUrl).toBe("https://old.reddit.com/r/technology");
    });

    it("does NOT rewrite old.reddit.com (already correct)", async () => {
      mockFetch(200, "already old reddit");
      const tool = createFridayAgentWebFetchTool();

      await tool.execute(
        { url: "https://old.reddit.com/r/test" },
        signal(),
      );

      const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(calledUrl).toBe("https://old.reddit.com/r/test");
    });

    it("does NOT rewrite non-Reddit URLs", async () => {
      mockFetch(200, "not reddit");
      const tool = createFridayAgentWebFetchTool();

      await tool.execute(
        { url: "https://news.ycombinator.com" },
        signal(),
      );

      const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(calledUrl).toBe("https://news.ycombinator.com");
    });
  });
});

// ─── rewriteUrl unit tests (pure function) ───

describe("rewriteUrl", () => {
  it("rewrites www.reddit.com → old.reddit.com", () => {
    expect(rewriteUrl("https://www.reddit.com/r/test")).toBe("https://old.reddit.com/r/test");
  });

  it("rewrites bare reddit.com → old.reddit.com", () => {
    expect(rewriteUrl("https://reddit.com/r/test")).toBe("https://old.reddit.com/r/test");
  });

  it("preserves old.reddit.com unchanged", () => {
    expect(rewriteUrl("https://old.reddit.com/r/test")).toBe("https://old.reddit.com/r/test");
  });

  it("preserves path, query, and fragment", () => {
    expect(rewriteUrl("https://www.reddit.com/r/test/comments/abc?sort=new#top")).toBe(
      "https://old.reddit.com/r/test/comments/abc?sort=new#top",
    );
  });

  it("does not rewrite non-Reddit URLs", () => {
    expect(rewriteUrl("https://example.com/foo")).toBe("https://example.com/foo");
    expect(rewriteUrl("https://news.ycombinator.com")).toBe("https://news.ycombinator.com");
  });

  it("returns malformed URLs unchanged", () => {
    expect(rewriteUrl("not-a-url")).toBe("not-a-url");
  });
});
