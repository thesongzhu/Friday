/**
 * Web Routing E2E Tests — validates the complete execution path
 * when the agent fetches web pages:
 *
 * 1. web_fetch with normal HTML → agent gets clean text
 * 2. web_fetch with JS-rendered page → tool returns error → agent retries with browser
 * 3. web_fetch with empty page → signals browser fallback
 * 4. Tool selection strategy matches OpenClaw behavior
 *
 * Uses realistic HTML fixtures (not toy HTML) to catch the same
 * failures that occur with real websites like Reddit, Twitter, SPAs.
 *
 * NOTE: Mock routes use DNS-resolvable domains (example.com, www.reddit.com)
 * because the SSRF guard validates DNS before the fetch interceptor runs.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  createMockHubEnv,
  type MockHubEnv,
} from "./_helpers/mock-env.js";
import { resetMockCounters } from "../../_mocks/mock-llm-providers.js";
import type { MockFetchRouter } from "./_helpers/mock-fetch-router.js";
import type { FridayProviderApi } from "../../../src/providers/model/friday-provider.types.js";

// ─── Helpers ───

async function apiFetch<T>(
  baseUrl: string,
  token: string,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as T;
  return { status: res.status, json };
}

// ─── Realistic HTML Fixtures ───

/**
 * React SPA shell — realistic size (>5KB) with minimal readable text.
 * Triggers JS-rendered page detection (HTML > 5KB, text < 500 chars).
 */
const REACT_SPA_HTML = (() => {
  const cssRules = Array.from({ length: 80 }, (_, i) =>
    `.Post__${String(i)}{display:flex;flex-direction:column;padding:8px 16px;border-bottom:1px solid #343536;background:#1a1a1b;color:#d7dadc}`
  ).join("\n");
  const webpackChunk = `!function(e){function t(t){for(var n,a,i=t[0],l=t[1],p=t[2],c=0,s=[];c<i.length;c++)a=i[c],Object.prototype.hasOwnProperty.call(o,a)&&o[a]&&s.push(o[a][0]),o[a]=0;for(n in l)Object.prototype.hasOwnProperty.call(l,n)&&(e[n]=l[n])}var n={},o={1:0};`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Reddit - Dive into anything</title>
<script defer src="/static/js/main.js"></script>
<style>body{margin:0;padding:0;font-family:sans-serif}#root{min-height:100vh}
${cssRules}
</style>
<script>
window.__INITIAL_STATE__={"app":{"config":{}}};
${webpackChunk.repeat(5)}
</script>
</head>
<body>
<div id="root"></div>
<noscript>You need to enable JavaScript to run this app.</noscript>
</body>
</html>`;
})();

/** Well-structured article — should parse fine */
const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>AI Agents in 2026</title></head>
<body>
<article>
<h1>AI Agents Transform Software Development</h1>
<p>A new wave of AI-powered coding agents is reshaping how software teams approach development.
These autonomous systems can read codebases, write tests, fix bugs, and deploy changes
with minimal human intervention.</p>
<p>According to a recent study, teams using AI agents reported a 40% reduction in time spent
on routine coding tasks. The agents excel at pattern recognition, code review, and test generation.</p>
<p>The technology builds on large language models fine-tuned for code understanding.
Unlike simple code completion tools, these agents maintain context across entire
codebases and can plan multi-step operations.</p>
</article>
</body>
</html>`;

/**
 * Reddit-like page — triggers Rule 2: text > 500 chars but < 2% of HTML size.
 * Real Reddit returns ~468KB HTML with ~1500 chars of visible text.
 */
const REDDIT_RULE2_HTML = (() => {
  // ~1500 chars of text content (above Rule 1's 500 threshold)
  const textContent = Array.from({ length: 15 }, (_, i) =>
    `<p>Reddit post ${String(i)}: This is a discussion thread about programming and technology with several comments from various users.</p>`,
  ).join("\n");
  const cssRules = Array.from({ length: 2000 }, (_, i) =>
    `.Post__${String(i)}{display:flex;flex-direction:column;padding:8px 16px;border-bottom:1px solid #343536;background:#1a1a1b;color:#d7dadc;font-size:14px;line-height:21px}`,
  ).join("\n");
  const webpackChunk = `!function(e){function t(t){for(var n,a,i=t[0],l=t[1],p=t[2],c=0,s=[];c<i.length;c++)a=i[c]}var n={},o={1:0};`;
  return `<!DOCTYPE html><html><head><title>Reddit</title>
<style>${cssRules}</style>
<script>${webpackChunk.repeat(50)}</script>
</head><body><div id="root">${textContent}</div></body></html>`;
})();

/**
 * Empty SPA shell — realistic size (>5KB) with nearly zero text.
 * Should trigger JS-rendered or empty page detection.
 */
const EMPTY_SPA_HTML = (() => {
  const webpackRuntime = `!function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}n.m=e}([]);`;
  return `<!DOCTYPE html><html><head><title>App</title>
<style>body{margin:0;padding:0;font-family:sans-serif}#app{min-height:100vh}</style>
<script>${webpackRuntime.repeat(35)}</script>
</head><body><div id="app"></div>
<script src="/bundle.js"></script>
</body></html>`;
})();

// ─── Test Types ───

interface AgentRunResult {
  ok: boolean;
  data: {
    runId: string;
    status: string;
    response: string;
    toolCallCount: number;
    durationMs: number;
  };
}

// ─── Tests ───

describe("Friday Web Routing E2E", () => {
  let env: MockHubEnv;
  let providerId: string;
  let model: string;

  beforeAll(async () => {
    env = await createMockHubEnv({ providerKinds: ["anthropic"] });
    const provider = env.providers["anthropic"]!;
    providerId = provider.providerId;
    model = provider.model;
  }, 30_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  }, 15_000);

  beforeEach(() => {
    for (const mock of Object.values(env.mocks)) {
      mock.reset();
    }
    resetMockCounters();
  });

  describe("web_fetch with well-structured HTML", () => {
    it("returns parsed article text (not raw HTML)", async () => {
      const mock = env.mockFor("anthropic");
      const router = globalThis.fetch as unknown as MockFetchRouter;

      // Use example.com — DNS-resolvable public domain
      const articleRoute = {
        urlPrefix: "https://example.com",
        api: "anthropic-messages" as FridayProviderApi,
        mockFetch: async () =>
          new Response(ARTICLE_HTML, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      };
      router.routes.unshift(articleRoute);

      try {
        // LLM calls web_fetch with the article URL
        mock.enqueue({
          type: "tool_use",
          toolName: "web_fetch",
          toolInput: { url: "https://example.com/article/123" },
        });
        // LLM receives parsed text and responds
        mock.enqueue({
          type: "text",
          text: "The article discusses AI agents transforming software development.",
        });

        const res = await apiFetch<AgentRunResult>(
          env.baseUrl,
          env.accessToken,
          "POST",
          "/v1/agent/runs",
          { task: "Read this article: https://example.com/article/123", providerId, model, timeoutMs: 15_000 },
        );

        expect(res.json.data.status).toBe("completed");
        expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);

        // Verify the tool result sent to LLM contains parsed text, not raw HTML
        const toolResultCall = mock.calls[1]; // Second call has the tool result
        expect(toolResultCall).toBeDefined();
        const body = toolResultCall!.bodyJson as { messages?: Array<{ role: string; content: unknown }> };
        // Serialize all messages to find tool result content
        const toolResultStr = JSON.stringify(body.messages);

        // Should contain the article text
        expect(toolResultStr).toContain("AI Agents Transform");
        // Should NOT contain raw HTML tags
        expect(toolResultStr).not.toContain("<article>");
        expect(toolResultStr).not.toContain("<p>");
        // Should indicate HTML was parsed
        expect(toolResultStr).toContain("HTML parsed to plain text");
      } finally {
        const idx = router.routes.indexOf(articleRoute);
        if (idx >= 0) router.routes.splice(idx, 1);
      }
    });
  });

  describe("web_fetch with JS-rendered pages (Reddit, Twitter, SPAs)", () => {
    it("returns JS-rendered error for React SPA shell", async () => {
      const mock = env.mockFor("anthropic");
      const router = globalThis.fetch as unknown as MockFetchRouter;

      // URL rewriting sends www.reddit.com → old.reddit.com, so route must match the rewritten host
      const spaRoute = {
        urlPrefix: "https://old.reddit.com",
        api: "anthropic-messages" as FridayProviderApi,
        mockFetch: async () =>
          new Response(REACT_SPA_HTML, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      };
      router.routes.unshift(spaRoute);

      try {
        // LLM tries web_fetch on Reddit
        mock.enqueue({
          type: "tool_use",
          toolName: "web_fetch",
          toolInput: { url: "https://www.reddit.com/r/AI_Agents/comments/abc/test_post/" },
        });
        // LLM sees the JS-rendered error and responds (ideally would retry with browser)
        mock.enqueue({
          type: "text",
          text: "The page requires JavaScript. Let me use the browser tool instead.",
        });

        const res = await apiFetch<AgentRunResult>(
          env.baseUrl,
          env.accessToken,
          "POST",
          "/v1/agent/runs",
          { task: "Read this Reddit post", providerId, model, timeoutMs: 15_000 },
        );

        expect(res.json.data.status).toBe("completed");

        // Verify the tool result sent to LLM signals JS-rendered page
        const toolResultCall = mock.calls[1];
        expect(toolResultCall).toBeDefined();
        const body = toolResultCall!.bodyJson as { messages?: Array<{ role: string; content: unknown }> };
        const toolResultStr = JSON.stringify(body.messages);

        // Must contain the JS-rendered signal
        expect(toolResultStr).toContain("JS-rendered");
        expect(toolResultStr).toContain("browser tool");
        // Must be marked as error so LLM knows to retry
        expect(toolResultStr).toContain("is_error");
      } finally {
        const idx = router.routes.indexOf(spaRoute);
        if (idx >= 0) router.routes.splice(idx, 1);
      }
    });

    it("extracts content via Readability for Reddit-like page (Rule 2 no longer triggers)", async () => {
      const mock = env.mockFor("anthropic");
      const router = globalThis.fetch as unknown as MockFetchRouter;

      // URL rewriting sends www.reddit.com → old.reddit.com, so route must match the rewritten host
      const redditRoute = {
        urlPrefix: "https://old.reddit.com/r/rule2",
        api: "anthropic-messages" as FridayProviderApi,
        mockFetch: async () =>
          new Response(REDDIT_RULE2_HTML, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      };
      router.routes.unshift(redditRoute);

      try {
        mock.enqueue({
          type: "tool_use",
          toolName: "web_fetch",
          toolInput: { url: "https://www.reddit.com/r/rule2/comments/abc/test/" },
        });
        mock.enqueue({
          type: "text",
          text: "Here is the Reddit post content.",
        });

        const res = await apiFetch<AgentRunResult>(
          env.baseUrl,
          env.accessToken,
          "POST",
          "/v1/agent/runs",
          { task: "Read this Reddit post", providerId, model, timeoutMs: 15_000 },
        );

        expect(res.json.data.status).toBe("completed");

        // With Readability, the <p> text is extracted successfully — no isError
        const toolResultCall = mock.calls[1];
        expect(toolResultCall).toBeDefined();
        const body = toolResultCall!.bodyJson as { messages?: Array<{ role: string; content: unknown }> };
        const toolResultStr = JSON.stringify(body.messages);

        // Readability extracts the Reddit post text
        expect(toolResultStr).toContain("Reddit post");
        expect(toolResultStr).toContain("programming and technology");
        // No JS-rendered error — Readability handled it
        expect(toolResultStr).not.toContain("JS-rendered");
        expect(toolResultStr).not.toContain("is_error");
      } finally {
        const idx = router.routes.indexOf(redditRoute);
        if (idx >= 0) router.routes.splice(idx, 1);
      }
    });

    it("returns error for empty SPA shell", async () => {
      const mock = env.mockFor("anthropic");
      const router = globalThis.fetch as unknown as MockFetchRouter;

      // Use example.org — DNS-resolvable public domain
      const emptyRoute = {
        urlPrefix: "https://example.org",
        api: "anthropic-messages" as FridayProviderApi,
        mockFetch: async () =>
          new Response(EMPTY_SPA_HTML, {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      };
      router.routes.unshift(emptyRoute);

      try {
        mock.enqueue({
          type: "tool_use",
          toolName: "web_fetch",
          toolInput: { url: "https://example.org/dashboard" },
        });
        mock.enqueue({
          type: "text",
          text: "Page requires JS rendering.",
        });

        const res = await apiFetch<AgentRunResult>(
          env.baseUrl,
          env.accessToken,
          "POST",
          "/v1/agent/runs",
          { task: "Read this page", providerId, model, timeoutMs: 15_000 },
        );

        expect(res.json.data.status).toBe("completed");

        const toolResultCall = mock.calls[1];
        const body = toolResultCall!.bodyJson as { messages?: Array<{ role: string; content: unknown }> };
        const toolResultStr = JSON.stringify(body.messages);
        expect(toolResultStr).toContain("browser tool");
      } finally {
        const idx = router.routes.indexOf(emptyRoute);
        if (idx >= 0) router.routes.splice(idx, 1);
      }
    });
  });

  describe("web_fetch → browser fallback chain", () => {
    it("agent retries with browser after web_fetch JS-rendered error", async () => {
      const mock = env.mockFor("anthropic");
      const router = globalThis.fetch as unknown as MockFetchRouter;

      // URL rewriting sends www.reddit.com → old.reddit.com, so route must match the rewritten host
      const spaRoute = {
        urlPrefix: "https://old.reddit.com",
        api: "anthropic-messages" as FridayProviderApi,
        mockFetch: async () =>
          new Response(REACT_SPA_HTML, {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      };
      router.routes.unshift(spaRoute);

      try {
        // Step 1: LLM tries web_fetch
        mock.enqueue({
          type: "tool_use",
          toolName: "web_fetch",
          toolInput: { url: "https://www.reddit.com/r/test/page" },
        });
        // Step 2: LLM sees JS-rendered error, tries browser
        mock.enqueue({
          type: "tool_use",
          toolName: "browser",
          toolInput: { action: "navigate", url: "https://www.reddit.com/r/test/page" },
        });
        // Step 3: LLM responds with browser result
        mock.enqueue({
          type: "text",
          text: "I read the page content using the browser.",
        });

        const res = await apiFetch<AgentRunResult>(
          env.baseUrl,
          env.accessToken,
          "POST",
          "/v1/agent/runs",
          { task: "Read https://www.reddit.com/r/test/page", providerId, model, timeoutMs: 15_000 },
        );

        expect(res.json.data.status).toBe("completed");
        // Should have at least 2 tool calls (web_fetch + browser)
        expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(2);
        // Should have called LLM 3 times (web_fetch result, browser result, final)
        expect(mock.calls.length).toBe(3);
      } finally {
        const idx = router.routes.indexOf(spaRoute);
        if (idx >= 0) router.routes.splice(idx, 1);
      }
    });
  });

  describe("system prompt tool strategy", () => {
    it("system prompt contains web routing strategy for JS-heavy sites", async () => {
      const mock = env.mockFor("anthropic");
      mock.enqueue({ type: "text", text: "ok" });

      await apiFetch<AgentRunResult>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        { task: "hello", providerId, model, timeoutMs: 10_000 },
      );

      const firstCall = mock.calls[0]!;
      const body = firstCall.bodyJson as { system?: string | Array<{ text: string }> };
      const systemPrompt = typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system) ? body.system.map((b) => b.text).join("") : "";

      // Must mention JS-heavy sites
      expect(systemPrompt).toContain("JS-heavy");
      // Must mention browser as the tool for JS sites
      expect(systemPrompt).toContain("browser");
      // Must mention fallback strategy
      expect(systemPrompt).toContain("web_fetch");
      expect(systemPrompt).toContain("snapshot");
      // Must mention retry on failure
      expect(systemPrompt).toContain("retry");
    });

    it("system prompt lists all required tools", async () => {
      const mock = env.mockFor("anthropic");
      mock.enqueue({ type: "text", text: "ok" });

      await apiFetch<AgentRunResult>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        { task: "hello", providerId, model, timeoutMs: 10_000 },
      );

      const firstCall = mock.calls[0]!;
      const body = firstCall.bodyJson as { system?: string | Array<{ text: string }> };
      const systemPrompt = typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system) ? body.system.map((b) => b.text).join("") : "";

      // Must mention key tools
      expect(systemPrompt).toContain("web_search");
      expect(systemPrompt).toContain("web_fetch");
      expect(systemPrompt).toContain("browser");
      expect(systemPrompt).toContain("exec");
      expect(systemPrompt).toContain("read");
      expect(systemPrompt).toContain("write");
      expect(systemPrompt).toContain("memory_store");
      expect(systemPrompt).toContain("memory_search");
    });
  });

  describe("web_fetch parseHtml parameter", () => {
    it("returns raw JSON when parseHtml=false", async () => {
      const mock = env.mockFor("anthropic");
      const router = globalThis.fetch as unknown as MockFetchRouter;

      // Use example.com — DNS-resolvable public domain
      const jsonRoute = {
        urlPrefix: "https://example.com/api",
        api: "anthropic-messages" as FridayProviderApi,
        mockFetch: async () =>
          new Response(
            JSON.stringify({ data: [1, 2, 3], total: 3 }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      };
      router.routes.unshift(jsonRoute);

      try {
        mock.enqueue({
          type: "tool_use",
          toolName: "web_fetch",
          toolInput: { url: "https://example.com/api/data", parseHtml: false },
        });
        mock.enqueue({ type: "text", text: "Got JSON data." });

        const res = await apiFetch<AgentRunResult>(
          env.baseUrl,
          env.accessToken,
          "POST",
          "/v1/agent/runs",
          { task: "Fetch API data", providerId, model, timeoutMs: 15_000 },
        );

        expect(res.json.data.status).toBe("completed");

        const toolResultCall = mock.calls[1];
        const body = toolResultCall!.bodyJson as { messages?: Array<{ role: string; content: unknown }> };
        const toolResultStr = JSON.stringify(body.messages);
        // Should contain raw JSON (quotes are escaped in JSON.stringify output)
        expect(toolResultStr).toContain("data");
        expect(toolResultStr).toContain("[1,2,3]");
      } finally {
        const idx = router.routes.indexOf(jsonRoute);
        if (idx >= 0) router.routes.splice(idx, 1);
      }
    });
  });
});
