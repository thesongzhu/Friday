import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createFridayApiDocCrawler,
  extractSameOriginLinks,
  extractOrigin,
} from "../../../../src/skills/converter/undocumented-api/friday-api-doc-crawler.js";
import { FridayDomainError } from "#errors";

const NOW_ISO = "2026-02-23T12:00:00.000Z";

// Public IP for test URLs (example.com's IP — passes SSRF guard)
const TEST_IP = "93.184.216.34";
const BASE = `http://${TEST_IP}`;

// ─── SSRF Protection Tests ───

describe("FridayApiDocCrawler — SSRF protection", () => {
  it("blocks http://127.0.0.1 without calling fetchFn", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const crawler = createFridayApiDocCrawler({ fetchFn, nowIso: () => NOW_ISO });

    await expect(crawler.crawl({ uri: "http://127.0.0.1/secret" })).rejects.toThrow(FridayDomainError);
    try {
      await crawler.crawl({ uri: "http://127.0.0.1/secret" });
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("VALIDATION_ERROR");
      expect((err as FridayDomainError).httpStatus).toBe(400);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("blocks http://metadata.google.internal without calling fetchFn", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const crawler = createFridayApiDocCrawler({ fetchFn, nowIso: () => NOW_ISO });

    await expect(crawler.crawl({ uri: "http://metadata.google.internal/computeMetadata/v1/" })).rejects.toThrow(FridayDomainError);
    try {
      await crawler.crawl({ uri: "http://metadata.google.internal/computeMetadata/v1/" });
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("VALIDATION_ERROR");
      expect((err as FridayDomainError).httpStatus).toBe(400);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("blocks redirect from public URL to metadata IP", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/secret" },
        }),
      );

    const crawler = createFridayApiDocCrawler({ fetchFn, nowIso: () => NOW_ISO });

    await expect(crawler.crawl({ uri: `${BASE}/docs` })).rejects.toThrow(FridayDomainError);
    try {
      await crawler.crawl({ uri: `${BASE}/docs` });
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("VALIDATION_ERROR");
      expect((err as FridayDomainError).httpStatus).toBe(400);
    }
    // fetchFn called for the first (public) hop only per crawl invocation
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("returns content for public URL success path", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("# API Docs\nGET /v1/users", { status: 200 }),
    );

    const crawler = createFridayApiDocCrawler({ fetchFn, nowIso: () => NOW_ISO });

    const result = await crawler.crawl({ uri: `${BASE}/docs` });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].content).toContain("GET /v1/users");
    expect(result.sourceRef).toBe(`${BASE}/docs`);
  });

  it("streams fetched content only up to maxBytes before truncating", async () => {
    const response = new Response("a".repeat(3000), { status: 200 });
    const textSpy = vi.spyOn(response, "text");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    const crawler = createFridayApiDocCrawler({ fetchFn, nowIso: () => NOW_ISO, maxBytes: 1024 });

    const result = await crawler.crawl({ uri: `${BASE}/large-docs` });

    expect(result.pages[0].content).toHaveLength(1024);
    expect(textSpy).not.toHaveBeenCalled();
  });
});

// ─── Single-Page Crawl Tests ───

describe("FridayApiDocCrawler — single-page mode", () => {
  it("returns base64 content as a single page", async () => {
    const content = "GET /api/hello\nPOST /api/world";
    const encoded = Buffer.from(content).toString("base64");
    const crawler = createFridayApiDocCrawler({ nowIso: () => NOW_ISO });

    const result = await crawler.crawl({ contentBase64: encoded });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].content).toBe(content);
    expect(result.pages[0].fetchedAt).toBe(NOW_ISO);
    expect(result.sourceRef).toBe("inline-content");
  });

  it("respects maxBytes for base64 content", async () => {
    const content = "x".repeat(5000);
    const encoded = Buffer.from(content).toString("base64");
    const crawler = createFridayApiDocCrawler({ nowIso: () => NOW_ISO, maxBytes: 2048 });

    const result = await crawler.crawl({ contentBase64: encoded });
    expect(result.pages[0].content.length).toBeLessThanOrEqual(2048);
  });

  it("prefers contentBase64 over URI when both provided", async () => {
    const content = "GET /v1/inline";
    const encoded = Buffer.from(content).toString("base64");
    const crawler = createFridayApiDocCrawler({ nowIso: () => NOW_ISO });

    const result = await crawler.crawl({
      contentBase64: encoded,
      uri: `${BASE}/docs`,
    });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].content).toBe(content);
    expect(result.sourceRef).toBe(`${BASE}/docs`);
  });

  it("throws when neither uri nor contentBase64 is provided", async () => {
    const crawler = createFridayApiDocCrawler({ nowIso: () => NOW_ISO });

    await expect(crawler.crawl({})).rejects.toThrow(FridayDomainError);
    try {
      await crawler.crawl({});
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("strips HTML tags from fetched content", async () => {
    const html = `<html><head><title>API</title></head><body><h1>Endpoints</h1><p>GET /v1/users</p></body></html>`;
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(html, { status: 200 }),
    );

    const crawler = createFridayApiDocCrawler({ fetchFn, nowIso: () => NOW_ISO });
    const result = await crawler.crawl({ uri: `${BASE}/docs` });

    expect(result.pages[0].content).toContain("Endpoints");
    expect(result.pages[0].content).toContain("GET /v1/users");
    expect(result.pages[0].content).not.toContain("<h1>");
    expect(result.pages[0].content).not.toContain("</p>");
  });

  it("strips script and style tags from HTML", async () => {
    const html = `<html><style>.foo { color: red; }</style><script>alert('xss')</script><p>Content</p></html>`;
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(html, { status: 200 }),
    );

    const crawler = createFridayApiDocCrawler({ fetchFn, nowIso: () => NOW_ISO });
    const result = await crawler.crawl({ uri: `${BASE}/page` });

    expect(result.pages[0].content).toContain("Content");
    expect(result.pages[0].content).not.toContain("alert");
    expect(result.pages[0].content).not.toContain("color: red");
  });

  it("returns plain text content as-is", async () => {
    const plain = "GET /v1/users\nPOST /v1/users\nDELETE /v1/users/:id";
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(plain, { status: 200 }),
    );

    const crawler = createFridayApiDocCrawler({ fetchFn, nowIso: () => NOW_ISO });
    const result = await crawler.crawl({ uri: `${BASE}/api.txt` });

    expect(result.pages[0].content).toBe(plain);
  });

  it("throws for non-ok HTTP response", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    );

    const crawler = createFridayApiDocCrawler({ fetchFn, nowIso: () => NOW_ISO });
    await expect(crawler.crawl({ uri: `${BASE}/missing` })).rejects.toThrow(FridayDomainError);
  });
});

// ─── Local File Crawl Tests ───

describe("FridayApiDocCrawler — local file", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "friday-test-crawler-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("reads local file content", async () => {
    const filePath = join(tempDir, "api-docs.txt");
    writeFileSync(filePath, "GET /v1/health\nPOST /v1/login");

    const crawler = createFridayApiDocCrawler({ nowIso: () => NOW_ISO });
    const result = await crawler.crawl({ uri: filePath });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].content).toContain("GET /v1/health");
    expect(result.pages[0].source).toBe(filePath);
  });

  it("throws for non-existent local file", async () => {
    const crawler = createFridayApiDocCrawler({ nowIso: () => NOW_ISO });
    await expect(crawler.crawl({ uri: "/tmp/nonexistent-file.txt" })).rejects.toThrow(FridayDomainError);
    try {
      await crawler.crawl({ uri: "/tmp/nonexistent-file.txt" });
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("SOURCE_NOT_FOUND");
    }
  });

  it("respects maxBytes for local files", async () => {
    const filePath = join(tempDir, "large-docs.txt");
    writeFileSync(filePath, "x".repeat(10_000));

    const crawler = createFridayApiDocCrawler({ nowIso: () => NOW_ISO, maxBytes: 2048 });
    const result = await crawler.crawl({ uri: filePath });

    expect(result.pages[0].content.length).toBeLessThanOrEqual(2048);
  });
});

// ─── Multi-Page Crawl Tests ───

describe("FridayApiDocCrawler — multi-page bounded crawl", () => {
  function makeFetchFn(pages: Record<string, string>) {
    return vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      // Normalize URL for lookup
      let lookup = url;
      try {
        const parsed = new URL(url);
        parsed.hash = "";
        lookup = parsed.href;
      } catch {}

      const body = pages[lookup] ?? pages[url];
      if (body !== undefined) {
        return new Response(body, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });
  }

  it("crawls multiple pages following same-origin links", async () => {
    const fetchFn = makeFetchFn({
      [`${BASE}/docs`]: `<html><body>
        <h1>API Docs</h1>
        <a href="/docs/endpoints">Endpoints</a>
        <a href="/docs/auth">Auth</a>
      </body></html>`,
      [`${BASE}/docs/endpoints`]: `<html><body>
        <h1>Endpoints</h1>
        <p>GET /v1/users</p>
      </body></html>`,
      [`${BASE}/docs/auth`]: `<html><body>
        <h1>Authentication</h1>
        <p>Bearer token</p>
      </body></html>`,
    });

    const crawler = createFridayApiDocCrawler({
      fetchFn,
      nowIso: () => NOW_ISO,
      maxPages: 5,
      maxDepth: 2,
    });

    const result = await crawler.crawl({ uri: `${BASE}/docs` });

    expect(result.pages.length).toBeGreaterThanOrEqual(2);
    expect(result.pages.length).toBeLessThanOrEqual(3);
    expect(result.pages[0].source).toBe(`${BASE}/docs`);
    expect(result.sourceRef).toBe(`${BASE}/docs`);
  });

  it("respects maxPages limit", async () => {
    const fetchFn = makeFetchFn({
      [`${BASE}/docs`]: `<html><body>
        <a href="/page1">P1</a><a href="/page2">P2</a><a href="/page3">P3</a>
      </body></html>`,
      [`${BASE}/page1`]: `<html><body>Page 1</body></html>`,
      [`${BASE}/page2`]: `<html><body>Page 2</body></html>`,
      [`${BASE}/page3`]: `<html><body>Page 3</body></html>`,
    });

    const crawler = createFridayApiDocCrawler({
      fetchFn,
      nowIso: () => NOW_ISO,
      maxPages: 2,
      maxDepth: 2,
    });

    const result = await crawler.crawl({ uri: `${BASE}/docs` });
    expect(result.pages.length).toBe(2);
  });

  it("respects maxDepth limit", async () => {
    const fetchFn = makeFetchFn({
      [`${BASE}/docs`]: `<html><body>
        <a href="/docs/level1">Level 1</a>
      </body></html>`,
      [`${BASE}/docs/level1`]: `<html><body>
        <a href="/docs/level1/level2">Level 2</a>
        Level 1 Content
      </body></html>`,
      [`${BASE}/docs/level1/level2`]: `<html><body>
        <a href="/docs/level1/level2/level3">Level 3</a>
        Level 2 Content
      </body></html>`,
      [`${BASE}/docs/level1/level2/level3`]: `<html><body>
        Level 3 Content (should not be reached)
      </body></html>`,
    });

    const crawler = createFridayApiDocCrawler({
      fetchFn,
      nowIso: () => NOW_ISO,
      maxPages: 10,
      maxDepth: 1,
    });

    const result = await crawler.crawl({ uri: `${BASE}/docs` });
    // Depth 0 = entry page, depth 1 = level1. Level2 at depth 2 not followed.
    expect(result.pages.length).toBe(2);
    const sources = result.pages.map((p) => p.source);
    expect(sources).toContain(`${BASE}/docs`);
    expect(sources).toContain(`${BASE}/docs/level1`);
    expect(sources).not.toContain(`${BASE}/docs/level1/level2`);
  });

  it("does not visit the same URL twice", async () => {
    const fetchFn = makeFetchFn({
      [`${BASE}/a`]: `<html><body><a href="/b">B</a></body></html>`,
      [`${BASE}/b`]: `<html><body><a href="/a">A again</a></body></html>`,
    });

    const crawler = createFridayApiDocCrawler({
      fetchFn,
      nowIso: () => NOW_ISO,
      maxPages: 10,
      maxDepth: 5,
    });

    const result = await crawler.crawl({ uri: `${BASE}/a` });
    expect(result.pages.length).toBe(2);
  });

  it("skips pages that fail to fetch without aborting", async () => {
    const fetchFn = makeFetchFn({
      [`${BASE}/docs`]: `<html><body>
        <a href="/broken">Broken</a>
        <a href="/ok">OK</a>
        Entry page
      </body></html>`,
      // /broken is NOT in pages map → returns 404
      [`${BASE}/ok`]: `<html><body>OK Page</body></html>`,
    });

    const crawler = createFridayApiDocCrawler({
      fetchFn,
      nowIso: () => NOW_ISO,
      maxPages: 5,
      maxDepth: 2,
    });

    const result = await crawler.crawl({ uri: `${BASE}/docs` });
    expect(result.pages.length).toBe(2);
    expect(result.pages.some((p) => p.content.includes("OK Page"))).toBe(true);
  });

  it("throws when all pages fail to fetch", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("Server Error", { status: 500 }),
    );

    const crawler = createFridayApiDocCrawler({
      fetchFn,
      nowIso: () => NOW_ISO,
      maxPages: 5,
      maxDepth: 2,
    });

    await expect(
      crawler.crawl({ uri: `${BASE}/docs` }),
    ).rejects.toThrow(FridayDomainError);
  });

  it("only follows same-origin links", async () => {
    const fetchFn = makeFetchFn({
      [`${BASE}/docs`]: `<html><body>
        <a href="http://104.16.132.229/steal">Evil</a>
        <a href="/docs/internal">Internal</a>
      </body></html>`,
      [`${BASE}/docs/internal`]: `<html><body>Internal Page</body></html>`,
    });

    const crawler = createFridayApiDocCrawler({
      fetchFn,
      nowIso: () => NOW_ISO,
      maxPages: 10,
      maxDepth: 2,
    });

    const result = await crawler.crawl({ uri: `${BASE}/docs` });
    const sources = result.pages.map((p) => p.source);
    expect(sources).not.toContain("http://104.16.132.229/steal");
    expect(sources).toContain(`${BASE}/docs/internal`);
  });

  it("respects allowedPathPrefixes", async () => {
    const fetchFn = makeFetchFn({
      [`${BASE}/docs`]: `<html><body>
        <a href="/docs/api">API</a>
        <a href="/blog/post1">Blog</a>
      </body></html>`,
      [`${BASE}/docs/api`]: `<html><body>API Page</body></html>`,
      [`${BASE}/blog/post1`]: `<html><body>Blog Post</body></html>`,
    });

    const crawler = createFridayApiDocCrawler({
      fetchFn,
      nowIso: () => NOW_ISO,
      maxPages: 10,
      maxDepth: 2,
      allowedPathPrefixes: ["/docs"],
    });

    const result = await crawler.crawl({ uri: `${BASE}/docs` });
    const sources = result.pages.map((p) => p.source);
    expect(sources).toContain(`${BASE}/docs/api`);
    expect(sources).not.toContain(`${BASE}/blog/post1`);
  });

  it("skips non-doc URLs (images, CSS, JS, etc.)", async () => {
    const fetchFn = makeFetchFn({
      [`${BASE}/docs`]: `<html><body>
        <a href="/docs/page2">Page 2</a>
        <a href="/assets/logo.png">Logo</a>
        <a href="/styles/main.css">CSS</a>
        <a href="/scripts/app.js">JS</a>
        <a href="/downloads/archive.zip">Download</a>
      </body></html>`,
      [`${BASE}/docs/page2`]: `<html><body>Page 2</body></html>`,
    });

    const crawler = createFridayApiDocCrawler({
      fetchFn,
      nowIso: () => NOW_ISO,
      maxPages: 10,
      maxDepth: 2,
    });

    const result = await crawler.crawl({ uri: `${BASE}/docs` });
    const sources = result.pages.map((p) => p.source);
    expect(sources).toContain(`${BASE}/docs/page2`);
    expect(sources.length).toBe(2);
  });

  it("backward compatible: maxPages=1 (default) returns single page", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        `<html><body><a href="/docs/more">More</a>Main Page</body></html>`,
        { status: 200 },
      ),
    );

    // Default maxPages=1
    const crawler = createFridayApiDocCrawler({
      fetchFn,
      nowIso: () => NOW_ISO,
    });

    const result = await crawler.crawl({ uri: `${BASE}/docs` });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].content).toContain("Main Page");
  });
});

// ─── extractSameOriginLinks Tests ───

describe("extractSameOriginLinks", () => {
  const origin = "http://api.example.com";
  const pageUrl = "http://api.example.com/docs";

  it("extracts same-origin links from HTML", () => {
    const html = `<a href="/docs/page1">P1</a><a href="/docs/page2">P2</a>`;
    const links = extractSameOriginLinks(html, pageUrl, origin, []);
    expect(links).toHaveLength(2);
    expect(links[0]).toBe("http://api.example.com/docs/page1");
    expect(links[1]).toBe("http://api.example.com/docs/page2");
  });

  it("resolves relative URLs against page URL", () => {
    const html = `<a href="./sub/page">Sub Page</a>`;
    const links = extractSameOriginLinks(html, "http://api.example.com/docs/", origin, []);
    expect(links).toHaveLength(1);
    expect(links[0]).toBe("http://api.example.com/docs/sub/page");
  });

  it("filters out cross-origin links", () => {
    const html = `<a href="http://evil.com/steal">Evil</a><a href="/safe">Safe</a>`;
    const links = extractSameOriginLinks(html, pageUrl, origin, []);
    expect(links).toHaveLength(1);
    expect(links[0]).toBe("http://api.example.com/safe");
  });

  it("skips javascript:, mailto:, tel: links", () => {
    const html = `
      <a href="javascript:void(0)">JS</a>
      <a href="mailto:test@example.com">Email</a>
      <a href="tel:+1234567890">Call</a>
      <a href="/real-page">Real</a>
    `;
    const links = extractSameOriginLinks(html, pageUrl, origin, []);
    expect(links).toHaveLength(1);
    expect(links[0]).toBe("http://api.example.com/real-page");
  });

  it("skips non-doc URLs (images, CSS, etc.)", () => {
    const html = `
      <a href="/logo.png">Logo</a>
      <a href="/style.css">Style</a>
      <a href="/font.woff2">Font</a>
      <a href="/real-page">Real</a>
    `;
    const links = extractSameOriginLinks(html, pageUrl, origin, []);
    expect(links).toHaveLength(1);
    expect(links[0]).toBe("http://api.example.com/real-page");
  });

  it("deduplicates links", () => {
    const html = `
      <a href="/page1">First</a>
      <a href="/page1">Duplicate</a>
      <a href="/page1/">Trailing Slash</a>
    `;
    const links = extractSameOriginLinks(html, pageUrl, origin, []);
    // /page1 and /page1/ normalize to the same URL
    expect(links).toHaveLength(1);
  });

  it("enforces path prefix allowlist", () => {
    const html = `
      <a href="/docs/api">API</a>
      <a href="/blog/post">Blog</a>
      <a href="/docs/guide">Guide</a>
    `;
    const links = extractSameOriginLinks(html, pageUrl, origin, ["/docs"]);
    expect(links).toHaveLength(2);
    expect(links.some((l) => l.includes("/docs/api"))).toBe(true);
    expect(links.some((l) => l.includes("/docs/guide"))).toBe(true);
    expect(links.some((l) => l.includes("/blog"))).toBe(false);
  });

  it("allows all paths when no prefix filter is set", () => {
    const html = `<a href="/a">A</a><a href="/b">B</a><a href="/c/d">CD</a>`;
    const links = extractSameOriginLinks(html, pageUrl, origin, []);
    expect(links).toHaveLength(3);
  });

  it("handles href with single quotes", () => {
    const html = `<a href='/docs/page'>Page</a>`;
    const links = extractSameOriginLinks(html, pageUrl, origin, []);
    expect(links).toHaveLength(1);
    expect(links[0]).toBe("http://api.example.com/docs/page");
  });

  it("skips hrefs with fragment-only values", () => {
    // The regex [^"'#]+ skips fragment-only hrefs
    const html = `<a href="#section1">Section 1</a><a href="/real">Real</a>`;
    const links = extractSameOriginLinks(html, pageUrl, origin, []);
    expect(links).toHaveLength(1);
    expect(links[0]).toBe("http://api.example.com/real");
  });

  it("returns empty array for HTML with no links", () => {
    const html = `<html><body><p>No links here</p></body></html>`;
    const links = extractSameOriginLinks(html, pageUrl, origin, []);
    expect(links).toHaveLength(0);
  });
});

// ─── extractOrigin Tests ───

describe("extractOrigin", () => {
  it("extracts origin from HTTP URL", () => {
    expect(extractOrigin("http://api.example.com/docs")).toBe("http://api.example.com");
  });

  it("extracts origin from HTTPS URL", () => {
    expect(extractOrigin("https://api.example.com/path")).toBe("https://api.example.com");
  });

  it("extracts origin with port", () => {
    expect(extractOrigin("http://localhost:3000/api")).toBe("http://localhost:3000");
  });

  it("returns empty string for invalid URL", () => {
    expect(extractOrigin("not-a-url")).toBe("");
  });
});

// ─── Converter Integration Tests ───

describe("FridayUndocumentedApiConverter — multi-page integration", () => {
  it("converter uses multi-page config", async () => {
    const { createFridayUndocumentedApiConverter } = await import(
      "../../../../src/skills/converter/converters/friday-undocumented-api-converter.js"
    );
    const converter = createFridayUndocumentedApiConverter();
    expect(converter.id).toBe("undocumented-api");
    expect(converter.displayName).toBe("Undocumented API Analyzer");
  });
});
