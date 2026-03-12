/**
 * Realistic HTML summarization tests — validates summarizeContent()
 * against actual website HTML patterns, not toy examples.
 *
 * With Readability integration, summarizeContent now uses Mozilla Readability
 * as the primary extractor.  JS-rendered detection only triggers when
 * Readability also fails to extract meaningful content.
 */

import { describe, it, expect } from "vitest";
import {
  summarizeContent,
  stripHtmlToText,
  extractReadableContent,
} from "../../../src/link-understanding/friday-link-summarize.js";

// ─── Realistic HTML Fixtures ───

/** React SPA shell — minimal text, large HTML (like Reddit). Padded to >5KB to match real pages. */
const REACT_SPA_HTML = (() => {
  // Real Reddit pages have massive inline CSS and webpack chunks
  const cssRules = Array.from({ length: 80 }, (_, i) =>
    `.Post__${String(i)}{display:flex;flex-direction:column;padding:8px 16px;border-bottom:1px solid #343536;background:#1a1a1b;color:#d7dadc}`
  ).join("\n");
  const webpackChunk = `!function(e){function t(t){for(var n,a,i=t[0],l=t[1],p=t[2],c=0,s=[];c<i.length;c++)a=i[c],Object.prototype.hasOwnProperty.call(o,a)&&o[a]&&s.push(o[a][0]),o[a]=0;for(n in l)Object.prototype.hasOwnProperty.call(l,n)&&(e[n]=l[n]);for(f&&f(t);s.length;)s.shift()()}var n={},o={1:0},r=[];`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Reddit - Dive into anything</title>
<link rel="stylesheet" href="/static/css/main.abc123.css"/>
<script defer src="/static/js/runtime.def456.js"></script>
<script defer src="/static/js/vendor.ghi789.js"></script>
<script defer src="/static/js/main.jkl012.js"></script>
<style>
body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto}
#root{min-height:100vh}
.header{display:flex;align-items:center;height:48px;background:#1a1a1b}
.nav{display:flex;gap:8px}.nav a{color:#d7dadc;text-decoration:none}
@media(max-width:768px){.sidebar{display:none}}
${cssRules}
</style>
<script>
window.__INITIAL_STATE__={"app":{"config":{"csrf_token":"abc","lang":"en"}},"user":null};
(function(){var d=document;var s=d.createElement('script');s.src='/static/js/analytics.js';d.head.appendChild(s)})();
${webpackChunk.repeat(3)}
</script>
</head>
<body>
<div id="root"></div>
<noscript>You need to enable JavaScript to run this app.</noscript>
</body>
</html>`;
})();

/** Server-rendered article page — good text content (like a news site) */
const NEWS_ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>AI Agents Transform Software Development - Tech News</title>
<meta name="description" content="New research shows AI agents can autonomously handle complex coding tasks"/>
<style>body{font-family:Georgia,serif;margin:0;padding:0}.article{max-width:680px;margin:0 auto;padding:20px}</style>
</head>
<body>
<header>
<nav><a href="/">Home</a> <a href="/tech">Tech</a> <a href="/science">Science</a></nav>
</header>
<article class="article">
<h1>AI Agents Transform Software Development</h1>
<p class="byline">By Jane Smith | March 3, 2026</p>
<p>A new wave of AI-powered coding agents is reshaping how software teams approach development.
These autonomous systems can read codebases, write tests, fix bugs, and deploy changes
with minimal human intervention.</p>
<p>According to a recent study by researchers at MIT, teams using AI agents reported
a 40% reduction in time spent on routine coding tasks. The agents excel at pattern
recognition, code review, and test generation.</p>
<p>"We're seeing a fundamental shift in the developer workflow," said Dr. Chen Wei,
lead researcher on the project. "AI agents don't replace developers — they amplify them.
The most effective teams are those that learn to collaborate with their AI counterparts."</p>
<p>The technology builds on large language models fine-tuned for code understanding.
Unlike simple code completion tools, these agents maintain context across entire
codebases and can plan multi-step operations.</p>
<p>Key capabilities include automated debugging, where the agent reads error logs,
traces the issue to its source, and proposes fixes. Some agents can even run test
suites and iterate on their solutions until tests pass.</p>
</article>
<footer><p>Copyright 2026 Tech News</p></footer>
</body>
</html>`;

/** Twitter/X-like SPA — almost no server-rendered text, padded to realistic size (>5KB) */
const TWITTER_SPA_HTML = (() => {
  // Real Twitter pages have massive inline CSS (~30KB+) — we pad with realistic CSS rules
  const cssRules = Array.from({ length: 100 }, (_, i) =>
    `.css-${String(i)}r{display:flex;align-items:center;justify-content:center;position:relative;z-index:${String(i)};box-sizing:border-box}`
  ).join("\n");
  const scriptChunk = `!function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}n.m=e,n.c=t}([]);`;
  return `<!DOCTYPE html>
<html dir="ltr" lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=0"/>
<meta property="og:site_name" content="X (formerly Twitter)"/>
<title>X</title>
<link rel="stylesheet" href="/responsive-web/client-web/main.abc123.css"/>
<style>
body,html{-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%;background-color:#000;
color-scheme:dark;font-family:"TwitterChirp",-apple-system,BlinkMacSystemFont,"Segoe UI",
Roboto,Helvetica,Arial,sans-serif;-webkit-tap-highlight-color:rgba(0,0,0,0);
margin:0;padding:0}
#react-root{min-height:100vh}
div,span,p,a{margin:0;padding:0;border:0;font-size:100%;font:inherit;vertical-align:baseline}
${cssRules}
</style>
<link rel="preload" as="script" crossorigin="anonymous" href="/responsive-web/client-web/vendor.abc.js"/>
<link rel="preload" as="script" crossorigin="anonymous" href="/responsive-web/client-web/main.def.js"/>
<script>
document.domain=document.domain;
window.__INITIAL_STATE__=void 0;
window.__META_DATA__={"isLoggedIn":false,"hasMultiAccountCookie":false};
${scriptChunk.repeat(5)}
</script>
</head>
<body>
<noscript>
<center>If you're not redirected soon, please <a href="/">use this link</a>.</center>
</noscript>
<div id="react-root">
<div class="css-175oi2r" style="min-height:100vh">
<div class="css-175oi2r r-13awgt0 r-12vffkv"></div>
</div>
</div>
<script type="text/javascript" charset="utf-8" nonce="abc123" src="/responsive-web/client-web/polyfills.abc.js"></script>
<script type="text/javascript" charset="utf-8" nonce="abc123" src="/responsive-web/client-web/vendor.def.js"></script>
<script type="text/javascript" charset="utf-8" nonce="abc123" src="/responsive-web/client-web/main.ghi.js"></script>
</body>
</html>`;
})();

/** Small, valid HTML page — should NOT trigger JS detection */
const SMALL_VALID_HTML = `<html><body><h1>Hello World</h1><p>This is a test page with some content.</p></body></html>`;

/** Empty body HTML — realistic SPA shell with enough size to trigger JS detection (>5KB) */
const EMPTY_BODY_HTML = (() => {
  // Real SPA shells have webpack runtime, polyfills, and config inline
  const webpackRuntime = `!function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}n.m=e}([]);`;
  return `<!DOCTYPE html><html><head><title>Loading</title>
<style>body{margin:0;padding:0;font-family:sans-serif}#app{min-height:100vh}</style>
<script>${webpackRuntime.repeat(35)}</script>
</head><body><div id="app"></div>
<script src="/app.js"></script>
<script src="/vendor.js"></script>
</body></html>`;
})();

// ─── Tests ───

describe("summarizeContent — realistic HTML", () => {
  describe("SPA detection (Readability + fallback)", () => {
    it("detects React SPA shell as needing browser (Readability finds nothing)", async () => {
      const result = await summarizeContent(REACT_SPA_HTML, "text/html", 10_000);
      // Readability should fail on empty SPA shell, triggering JS-rendered fallback
      expect(result).toContain("browser tool");
    });

    it("detects Twitter/X SPA shell as needing browser", async () => {
      const result = await summarizeContent(TWITTER_SPA_HTML, "text/html", 10_000);
      expect(result).toContain("browser tool");
    });

    it("detects near-empty body with scripts as needing browser", async () => {
      const result = await summarizeContent(EMPTY_BODY_HTML, "text/html", 10_000);
      expect(result).toContain("browser tool");
    });

    it("extracts article text from a normal news page via Readability", async () => {
      const result = await summarizeContent(NEWS_ARTICLE_HTML, "text/html", 10_000);
      expect(result).not.toContain("JS-rendered");
      expect(result).not.toContain("browser tool");
      // Readability should extract the article content
      expect(result).toContain("AI Agents Transform Software Development");
      expect(result).toContain("40% reduction");
      expect(result).toContain("Dr. Chen Wei");
    });

    it("extracts text from small valid HTML via Readability", async () => {
      const result = await summarizeContent(SMALL_VALID_HTML, "text/html", 10_000);
      expect(result).not.toContain("JS-rendered");
      expect(result).toContain("Hello World");
    });
  });

  describe("Readability extraction (direct)", () => {
    it("extracts article content from news HTML", async () => {
      const result = await extractReadableContent(NEWS_ARTICLE_HTML);
      expect(result).not.toBeNull();
      expect(result!.text).toContain("AI-powered coding agents");
      expect(result!.text).toContain("40% reduction");
    });

    it("returns null for empty SPA shell", async () => {
      const result = await extractReadableContent(REACT_SPA_HTML);
      // SPA shell has no readable content
      expect(result === null || (result?.text ?? "").length < 100).toBe(true);
    });

    it("extracts content with charThreshold: 0 (matches OpenClaw)", async () => {
      // Small content that would be ignored with default charThreshold
      const smallHtml = `<html><body><article><p>Short but important content.</p></article></body></html>`;
      const result = await extractReadableContent(smallHtml);
      expect(result).not.toBeNull();
      expect(result!.text).toContain("Short but important content");
    });
  });

  describe("text-to-HTML ratio detection (regex fallback)", () => {
    it("provides useful text for well-structured articles", async () => {
      const result = await summarizeContent(NEWS_ARTICLE_HTML, "text/html", 10_000);
      // Readability should extract meaningful paragraphs
      expect(result).toContain("autonomous systems");
      expect(result).toContain("routine coding tasks");
    });
  });

  describe("empty and edge cases", () => {
    it("returns browser fallback message for completely empty HTML", async () => {
      const result = await summarizeContent("", "text/html", 10_000);
      expect(result).toContain("Empty page");
      expect(result).toContain("browser tool");
    });

    it("returns browser fallback for HTML with only scripts", async () => {
      const html = "<html><head><script>var x=1;</script></head><body><script>render()</script></body></html>";
      const result = await summarizeContent(html, "text/html", 10_000);
      expect(result).toContain("browser tool");
    });

    it("handles non-HTML content type correctly", async () => {
      const result = await summarizeContent('{"key": "value"}', "application/json", 10_000);
      expect(result).toBe('{"key": "value"}');
    });

    it("handles plain text content type", async () => {
      const result = await summarizeContent("Hello plain text world", "text/plain", 10_000);
      expect(result).toBe("Hello plain text world");
    });
  });

  describe("stripHtmlToText sanity", () => {
    it("removes script blocks entirely", () => {
      const text = stripHtmlToText("<p>Before</p><script>alert('xss')</script><p>After</p>");
      expect(text).toContain("Before");
      expect(text).toContain("After");
      expect(text).not.toContain("alert");
      expect(text).not.toContain("xss");
    });

    it("removes style blocks entirely", () => {
      const text = stripHtmlToText("<style>body{color:red}</style><p>Content</p>");
      expect(text).toContain("Content");
      expect(text).not.toContain("color:red");
    });

    it("decodes HTML entities", () => {
      const text = stripHtmlToText("<p>A &amp; B &lt; C &gt; D &quot;E&quot; F&#39;s</p>");
      expect(text).toContain("A & B < C > D");
    });
  });
});
