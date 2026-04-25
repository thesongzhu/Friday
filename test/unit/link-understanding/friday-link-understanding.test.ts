import { describe, it, expect, vi } from "vitest";
import {
  detectLinks,
  normalizeUrl,
  stripHtmlToText,
  truncateToLength,
  summarizeContent,
  createFridayLinkCacheRepository,
  createFridayLinkUnderstandingService,
  DEFAULT_LINK_UNDERSTANDING_CONFIG,
} from "../../../src/link-understanding/index.js";

// ─── detectLinks ───

describe("detectLinks", () => {
  it("extracts HTTP and HTTPS URLs from text", () => {
    const links = detectLinks("Visit https://example.com and http://test.org for info");
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe("https://example.com");
    expect(links[1].url).toBe("http://test.org");
  });

  it("deduplicates URLs", () => {
    const links = detectLinks("See https://example.com and https://example.com again");
    expect(links).toHaveLength(1);
  });

  it("strips trailing punctuation", () => {
    const links = detectLinks("Check https://example.com/page.");
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/page");
  });

  it("handles URLs with query params and paths", () => {
    const links = detectLinks("API at https://api.example.com/v2/users?page=1&limit=10");
    expect(links).toHaveLength(1);
    expect(links[0].url).toContain("?page=1&limit=10");
  });

  it("returns empty for text without URLs", () => {
    const links = detectLinks("No links here, just plain text.");
    expect(links).toHaveLength(0);
  });

  it("records start and end indices", () => {
    const text = "Go to https://example.com now";
    const links = detectLinks(text);
    expect(links[0].startIndex).toBe(6);
    expect(links[0].endIndex).toBe(25);
  });
});

// ─── normalizeUrl ───

describe("normalizeUrl", () => {
  it("removes default port 443 for https", () => {
    expect(normalizeUrl("https://example.com:443/path")).toBe("https://example.com/path");
  });

  it("removes default port 80 for http", () => {
    expect(normalizeUrl("http://example.com:80/path")).toBe("http://example.com/path");
  });

  it("removes fragment", () => {
    expect(normalizeUrl("https://example.com/page#section")).toBe("https://example.com/page");
  });

  it("removes trailing slash on root", () => {
    const result = normalizeUrl("https://example.com/");
    expect(result).toBe("https://example.com");
  });

  it("keeps trailing slash on paths", () => {
    const result = normalizeUrl("https://example.com/path/");
    expect(result).toContain("/path/");
  });
});

// ─── stripHtmlToText ───

describe("stripHtmlToText", () => {
  it("removes HTML tags", () => {
    expect(stripHtmlToText("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("removes script and style blocks", () => {
    const html = '<p>Content</p><script>alert("x")</script><style>.a{}</style><p>More</p>';
    expect(stripHtmlToText(html)).toBe("Content More");
  });

  it("decodes common HTML entities", () => {
    expect(stripHtmlToText("a &amp; b &lt; c")).toBe("a & b < c");
  });
});

// ─── truncateToLength ───

describe("truncateToLength", () => {
  it("returns text unchanged if within limit", () => {
    expect(truncateToLength("short", 100)).toBe("short");
  });

  it("truncates at word boundary", () => {
    const result = truncateToLength("The quick brown fox jumps over the lazy dog", 20);
    expect(result.length).toBeLessThanOrEqual(23); // 20 + "..."
    expect(result).toContain("...");
  });
});

// ─── summarizeContent ───

describe("summarizeContent", () => {
  it("strips HTML and truncates", async () => {
    const html = "<html><body><p>Hello world, this is a test page</p></body></html>";
    const result = await summarizeContent(html, "text/html", 30);
    expect(result).toContain("Hello world");
  });

  it("handles plain text", async () => {
    const result = await summarizeContent("Plain text content here", "text/plain", 100);
    expect(result).toBe("Plain text content here");
  });

  it("returns placeholder for empty content", async () => {
    expect(await summarizeContent("", "text/html", 100)).toContain("Empty page");
    expect(await summarizeContent("", "text/html", 100)).toContain("browser tool");
  });
});

// ─── Cache Repository ───

describe("FridayLinkCacheRepository", () => {
  it("stores and retrieves entries", () => {
    const cache = createFridayLinkCacheRepository();
    cache.set({
      url: "https://example.com",
      title: "Example",
      summary: "An example site",
      contentType: "text/html",
      fetchedAt: "2026-01-15T10:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
    });

    const entry = cache.get("https://example.com");
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("Example");
  });

  it("returns null for expired entries", () => {
    const cache = createFridayLinkCacheRepository();
    cache.set({
      url: "https://old.com",
      title: "Old",
      summary: "Expired",
      contentType: "text/html",
      fetchedAt: "2020-01-01T00:00:00Z",
      expiresAt: "2020-01-02T00:00:00Z",
    });

    expect(cache.get("https://old.com")).toBeNull();
  });

  it("returns null for unknown URLs", () => {
    const cache = createFridayLinkCacheRepository();
    expect(cache.get("https://unknown.com")).toBeNull();
  });

  it("prunes expired entries", () => {
    const cache = createFridayLinkCacheRepository();
    cache.set({
      url: "https://expired.com",
      title: "Expired",
      summary: "old",
      contentType: "text/html",
      fetchedAt: "2020-01-01T00:00:00Z",
      expiresAt: "2020-01-02T00:00:00Z",
    });
    cache.set({
      url: "https://fresh.com",
      title: "Fresh",
      summary: "new",
      contentType: "text/html",
      fetchedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
    });

    const pruned = cache.pruneExpired("2026-01-15T00:00:00Z");
    expect(pruned).toBe(1);
    expect(cache.get("https://fresh.com")).not.toBeNull();
  });
});

// ─── Service ───

describe("FridayLinkUnderstandingService", () => {
  function createMockFetchFn() {
    return vi.fn().mockResolvedValue({
      statusCode: 200,
      contentType: "text/html",
      body: "<html><head><title>Test Page</title></head><body><p>Page content here</p></body></html>",
    });
  }

  it("returns empty when disabled", async () => {
    const service = createFridayLinkUnderstandingService({
      fetchFn: createMockFetchFn(),
      cache: createFridayLinkCacheRepository(),
      nowIso: () => "2026-01-15T10:00:00Z",
      config: { ...DEFAULT_LINK_UNDERSTANDING_CONFIG, enabled: false },
    });

    const result = await service.processText("Visit https://example.com");
    expect(result).toHaveLength(0);
  });

  it("returns empty for text without links", async () => {
    const service = createFridayLinkUnderstandingService({
      fetchFn: createMockFetchFn(),
      cache: createFridayLinkCacheRepository(),
      nowIso: () => "2026-01-15T10:00:00Z",
    });

    const result = await service.processText("No links here");
    expect(result).toHaveLength(0);
  });

  it("fetches, summarizes, and caches a link", async () => {
    const fetchFn = createMockFetchFn();
    const nowIso = () => "2026-01-15T10:00:00Z";
    const cache = createFridayLinkCacheRepository(nowIso);
    const service = createFridayLinkUnderstandingService({
      fetchFn,
      cache,
      nowIso,
    });

    const result = await service.processText("Check https://example.com for details");

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Test Page");
    expect(result[0].summary).toContain("Page content");
    expect(result[0].cached).toBe(false);
    expect(fetchFn).toHaveBeenCalledWith("https://example.com", expect.objectContaining({
      timeoutMs: DEFAULT_LINK_UNDERSTANDING_CONFIG.fetchTimeoutMs,
      maxRedirects: DEFAULT_LINK_UNDERSTANDING_CONFIG.maxRedirects,
      maxResponseSizeBytes: DEFAULT_LINK_UNDERSTANDING_CONFIG.maxResponseSizeBytes,
    }));

    // Second call should use cache
    const result2 = await service.processText("Check https://example.com for details");
    expect(result2).toHaveLength(1);
    expect(result2[0].cached).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("respects maxLinksPerMessage limit", async () => {
    const fetchFn = createMockFetchFn();
    const service = createFridayLinkUnderstandingService({
      fetchFn,
      cache: createFridayLinkCacheRepository(),
      nowIso: () => "2026-01-15T10:00:00Z",
      config: { ...DEFAULT_LINK_UNDERSTANDING_CONFIG, maxLinksPerMessage: 1 },
    });

    const result = await service.processText("See https://a.com and https://b.com");
    expect(result).toHaveLength(1);
  });

  it("skips failed fetches", async () => {
    const service = createFridayLinkUnderstandingService({
      fetchFn: vi.fn().mockRejectedValue(new Error("SSRF blocked")),
      cache: createFridayLinkCacheRepository(),
      nowIso: () => "2026-01-15T10:00:00Z",
    });

    const result = await service.processText("Visit https://internal.corp");
    expect(result).toHaveLength(0);
  });

  it("skips non-2xx responses", async () => {
    const service = createFridayLinkUnderstandingService({
      fetchFn: vi.fn().mockResolvedValue({
        statusCode: 404,
        contentType: "text/html",
        body: "Not Found",
      }),
      cache: createFridayLinkCacheRepository(),
      nowIso: () => "2026-01-15T10:00:00Z",
    });

    const result = await service.processText("Visit https://example.com/404");
    expect(result).toHaveLength(0);
  });

  it("detectOnly returns candidates without fetching", () => {
    const fetchFn = createMockFetchFn();
    const service = createFridayLinkUnderstandingService({
      fetchFn,
      cache: createFridayLinkCacheRepository(),
      nowIso: () => "2026-01-15T10:00:00Z",
    });

    const candidates = service.detectOnly("See https://a.com and https://b.com");
    expect(candidates).toHaveLength(2);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
