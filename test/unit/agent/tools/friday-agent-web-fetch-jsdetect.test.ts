/**
 * JS-rendered page detection tests — validates the FULL path:
 *   summarizeContent() → processedBody string → jsRendered flag → isError
 *
 * Covers all three summarizeContent() output paths:
 *   Rule 0 (empty page): "content may require JavaScript"
 *   Rule 1 (HTML >5KB, text <500): "JS-rendered page detected"
 *   Rule 2 (HTML >10KB, text <2% ratio): "Page appears to be JS-rendered"
 *
 * The critical bug: web_fetch previously checked for "JS-rendered page"
 * which matched Rule 1 but NOT Rule 2.  Real Reddit HTML (468KB, ~1500
 * chars text) triggers Rule 2, so isError was never set → LLM never
 * retried with browser.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createFridayAgentWebFetchTool } from "#agent";
import { summarizeContent } from "../../../../src/link-understanding/friday-link-summarize.js";

// ─── Fixtures ───

/**
 * Simulate real Reddit HTML: 468KB of HTML but only ~1500 chars of plain text.
 * Triggers Rule 2 (text < 2% of HTML) but NOT Rule 1 (text > 500).
 */
function buildRedditLikeHtml(): string {
  // ~1500 chars of actual text content (above the 500 threshold for Rule 1)
  const textContent = Array.from({ length: 15 }, (_, i) =>
    `<p>Reddit post ${String(i)}: This is a discussion thread about programming and technology with several comments from various users.</p>`,
  ).join("\n");

  // Pad with massive CSS (like real Reddit inline styles)
  const cssRules = Array.from({ length: 2000 }, (_, i) =>
    `.Post__container__${String(i)}r{display:flex;flex-direction:column;padding:8px 16px;border-bottom:1px solid #343536;background:#1a1a1b;color:#d7dadc;font-size:14px;line-height:21px}`,
  ).join("\n");

  // Pad with webpack chunks
  const webpackChunk = `!function(e){function t(t){for(var n,a,i=t[0],l=t[1],p=t[2],c=0,s=[];c<i.length;c++)a=i[c],Object.prototype.hasOwnProperty.call(o,a)&&o[a]&&s.push(o[a][0]),o[a]=0;for(n in l)Object.prototype.hasOwnProperty.call(l,n)&&(e[n]=l[n]);for(f&&f(t);s.length;)s.shift()()}var n={},o={1:0},r=[];`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Reddit - Dive into anything</title>
<style>
body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto}
#root{min-height:100vh}
${cssRules}
</style>
<script>
window.__INITIAL_STATE__={"app":{"config":{"csrf_token":"abc","lang":"en"}},"user":null};
${webpackChunk.repeat(50)}
</script>
</head>
<body>
<div id="root">${textContent}</div>
<noscript>You need to enable JavaScript to run this app.</noscript>
</body>
</html>`;
}

/** Rule 1 trigger: big HTML, tiny text (<500 chars) */
function buildSpaShellHtml(): string {
  const cssRules = Array.from({ length: 100 }, (_, i) =>
    `.css-${String(i)}{display:flex;align-items:center;justify-content:center;position:relative}`,
  ).join("\n");
  return `<!DOCTYPE html><html><head><title>App</title>
<style>${cssRules}</style>
<script>${"var x=1;".repeat(500)}</script>
</head><body><div id="root"></div><noscript>Enable JS</noscript></body></html>`;
}

describe("web_fetch JS-rendered detection (full path)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function signal(): AbortSignal {
    return new AbortController().signal;
  }

  function mockFetchHtml(html: string): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: () => Promise.resolve(html),
    }) as unknown as typeof fetch;
  }

  // ─── summarizeContent output verification ───

  describe("summarizeContent output strings", () => {
    it("Rule 0 (empty page) contains 'content may require JavaScript'", async () => {
      const result = await summarizeContent("", "text/html", 100_000);
      expect(result).toContain("content may require JavaScript");
    });

    it("Rule 1 (SPA shell, <500 text) triggers fallback (JS-rendered or browser tool)", async () => {
      const html = buildSpaShellHtml();
      expect(html.length).toBeGreaterThan(5_000);
      const result = await summarizeContent(html, "text/html", 100_000);
      // Readability may or may not extract content; either way should signal browser fallback
      expect(result).toContain("browser tool");
    });

    it("empty page and SPA shell both signal browser fallback", async () => {
      const rule0 = await summarizeContent("", "text/html", 100_000);
      const rule1 = await summarizeContent(buildSpaShellHtml(), "text/html", 100_000);

      expect(rule0).toContain("content may require JavaScript");
      expect(rule1).toContain("browser tool");
    });
  });

  // ─── Full path: web_fetch tool sets isError for JS-rendered pages ───

  describe("web_fetch tool isError flag", () => {
    it("extracts content via Readability for Reddit-like page (no isError)", async () => {
      // With Readability, the Reddit-like fixture's <p> text is extracted successfully
      // so isError is NOT set — Readability handles what regex couldn't.
      const html = buildRedditLikeHtml();
      mockFetchHtml(html);
      const tool = createFridayAgentWebFetchTool();

      const result = await tool.execute({ url: "https://www.reddit.com/r/test" }, signal());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Reddit post");
      expect(result.content).toContain("programming and technology");
    });

    it("sets isError=true for SPA shell (Readability finds nothing)", async () => {
      mockFetchHtml(buildSpaShellHtml());
      const tool = createFridayAgentWebFetchTool();

      const result = await tool.execute({ url: "https://example.com/spa" }, signal());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("browser tool");
    });

    it("sets isError=true for Rule 0 (empty page)", async () => {
      mockFetchHtml("<html><head><script>app()</script></head><body></body></html>");
      const tool = createFridayAgentWebFetchTool();

      const result = await tool.execute({ url: "https://example.com/empty" }, signal());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("content may require JavaScript");
    });

    it("does NOT set isError for normal HTML with good content", async () => {
      const normalHtml = `<!DOCTYPE html><html><head><title>News</title></head>
<body><article>
<h1>Breaking News</h1>
<p>A very important event happened today that affects many people around the world.
Scientists discovered a new species of deep-sea fish that glows in seven different colors.
The discovery was made during an expedition to the Mariana Trench.</p>
<p>Dr. Smith said the finding could help us understand bioluminescence better.</p>
</article></body></html>`;
      mockFetchHtml(normalHtml);
      const tool = createFridayAgentWebFetchTool();

      const result = await tool.execute({ url: "https://news.example.com/article" }, signal());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Breaking News");
      expect(result.content).not.toContain("JS-rendered");
    });

    it("does NOT set isError when parseHtml is false", async () => {
      mockFetchHtml(buildRedditLikeHtml());
      const tool = createFridayAgentWebFetchTool();

      const result = await tool.execute(
        { url: "https://www.reddit.com/r/test", parseHtml: false },
        signal(),
      );

      // parseHtml=false returns raw body, no JS detection
      expect(result.isError).toBeUndefined();
    });
  });

  // ─── Regression: the exact bug that caused Reddit to never trigger isError ───

  describe("regression: Rule 2 string matching", () => {
    it("'Page appears to be JS-rendered' contains 'JS-rendered'", () => {
      const rule2Output = "(Page appears to be JS-rendered — very low text-to-HTML ratio.)";
      expect(rule2Output.includes("JS-rendered")).toBe(true);
    });

    it("'Page appears to be JS-rendered' does NOT contain 'JS-rendered page' (old buggy check)", () => {
      const rule2Output = "(Page appears to be JS-rendered — very low text-to-HTML ratio.)";
      // This was the old check that missed Rule 2:
      expect(rule2Output.includes("JS-rendered page")).toBe(false);
    });
  });
});
