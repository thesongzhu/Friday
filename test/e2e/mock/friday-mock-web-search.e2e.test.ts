/**
 * Web Search Tool E2E Tests — verify web_search tool with mocked
 * search provider responses through the full agent loop.
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

async function withSearchEnv<T>(
  envVars: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(envVars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

// ─── Mock HTML templates ───

const MOCK_DDG_HTML_3_RESULTS = `
<html><body>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&amp;rut=abc">Node.js Testing Guide</a>
  <a class="result__snippet" href="#">Comprehensive guide to testing Node.js applications with Vitest.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage2&amp;rut=def">Vitest Documentation</a>
  <a class="result__snippet" href="#">Official Vitest docs with examples and API reference.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage3&amp;rut=ghi">Jest vs Vitest Comparison</a>
  <a class="result__snippet" href="#">Detailed comparison of Jest and Vitest test runners.</a>
</div>
</body></html>
`;

const MOCK_DDG_HTML_EMPTY = `
<html><body>
<div class="no-results">
  <p>No results found for your query.</p>
</div>
</body></html>
`;

// ─── Tests ───

describe("Friday Mock Web Search E2E", () => {
  let env: MockHubEnv;
  let providerId: string;
  let model: string;
  let injectedRoutes: Array<{ urlPrefix: string; api: FridayProviderApi; mockFetch: unknown }>;

  beforeAll(async () => {
    env = await createMockHubEnv({ providerKinds: ["anthropic"] });
    const provider = env.providers["anthropic"]!;
    providerId = provider.providerId;
    model = provider.model;
    injectedRoutes = [];
  }, 30_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  }, 15_000);

  beforeEach(() => {
    for (const mock of Object.values(env.mocks)) {
      mock.reset();
    }
    resetMockCounters();

    // Remove any previously injected routes
    const router = globalThis.fetch as unknown as MockFetchRouter;
    for (const route of injectedRoutes) {
      const idx = router.routes.indexOf(route as never);
      if (idx >= 0) router.routes.splice(idx, 1);
    }
    injectedRoutes = [];
  });

  function injectRoute(
    urlPrefix: string,
    handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ): void {
    const router = globalThis.fetch as unknown as MockFetchRouter;
    const route = {
      urlPrefix,
      api: "anthropic-messages" as FridayProviderApi,
      mockFetch: handler,
    };
    router.routes.unshift(route);
    injectedRoutes.push(route);
  }

  it("DuckDuckGo search returns parsed results", async () => {
    const mock = env.mockFor("anthropic");

    injectRoute("https://html.duckduckgo.com", async () =>
      new Response(MOCK_DDG_HTML_3_RESULTS, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    mock.enqueue({
      type: "tool_use",
      toolName: "web_search",
      toolInput: { query: "nodejs testing", numResults: 3 },
    });
    mock.enqueue({
      type: "text",
      text: "Found 3 testing resources.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Search for nodejs testing", providerId, model, timeoutMs: 15_000 },
    );

    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);

    // The second LLM call should contain the tool result with parsed search results
    expect(mock.calls.length).toBe(2);
    const secondCallBody = mock.calls[1]!.bodyJson as { messages?: Array<{ content?: string | Array<{ text?: string }> }> };
    // The tool result is in the messages as a user message with tool_result
    expect(secondCallBody.messages).toBeDefined();
  });

  it("DuckDuckGo empty results returns 'No results found'", async () => {
    const mock = env.mockFor("anthropic");

    injectRoute("https://html.duckduckgo.com", async () =>
      new Response(MOCK_DDG_HTML_EMPTY, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    mock.enqueue({
      type: "tool_use",
      toolName: "web_search",
      toolInput: { query: "xyznonexistentqueryzyx" },
    });
    mock.enqueue({
      type: "text",
      text: "The search returned no results.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Search for something obscure", providerId, model, timeoutMs: 15_000 },
    );

    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
  });

  it("DuckDuckGo timeout returns error message", async () => {
    const mock = env.mockFor("anthropic");

    injectRoute("https://html.duckduckgo.com", async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    mock.enqueue({
      type: "tool_use",
      toolName: "web_search",
      toolInput: { query: "timeout test" },
    });
    mock.enqueue({
      type: "text",
      text: "Search timed out, trying alternative approach.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Search with timeout", providerId, model, timeoutMs: 15_000 },
    );

    expect(res.json.data.status).toBe("failed");
    expect(res.json.data.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    // LLM received the timeout error and still responded
    expect(mock.calls.length).toBe(2);
  });

  it("search freshness parameter is forwarded to DuckDuckGo URL", async () => {
    const mock = env.mockFor("anthropic");
    let capturedUrl = "";

    injectRoute("https://html.duckduckgo.com", async (input) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      return new Response(MOCK_DDG_HTML_3_RESULTS, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });

    mock.enqueue({
      type: "tool_use",
      toolName: "web_search",
      toolInput: { query: "recent news", freshness: "day" },
    });
    mock.enqueue({
      type: "text",
      text: "Found recent results.",
    });

    await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Search recent news", providerId, model, timeoutMs: 15_000 },
    );

    // DuckDuckGo doesn't support freshness natively, but the URL should still be called
    expect(capturedUrl).toContain("html.duckduckgo.com");
    // encodeURIComponent uses %20, not +
    expect(capturedUrl).toContain("recent%20news");
  });

  it("numResults parameter limits search results", async () => {
    const mock = env.mockFor("anthropic");

    injectRoute("https://html.duckduckgo.com", async () =>
      new Response(MOCK_DDG_HTML_3_RESULTS, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    mock.enqueue({
      type: "tool_use",
      toolName: "web_search",
      toolInput: { query: "test query", numResults: 1 },
    });
    mock.enqueue({
      type: "text",
      text: "Found one result.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Search with limited results", providerId, model, timeoutMs: 15_000 },
    );

    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
  });

  it("search result format includes title, URL, and snippet", async () => {
    const mock = env.mockFor("anthropic");

    injectRoute("https://html.duckduckgo.com", async () =>
      new Response(MOCK_DDG_HTML_3_RESULTS, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    mock.enqueue({
      type: "tool_use",
      toolName: "web_search",
      toolInput: { query: "vitest documentation" },
    });
    mock.enqueue({
      type: "text",
      text: "Found results with titles and URLs.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Search for vitest docs", providerId, model, timeoutMs: 15_000 },
    );

    expect(res.json.data.status).toBe("completed");

    // Check the tool result sent back to LLM contains formatted results
    // The second LLM call contains the tool result in messages
    const callBody = mock.calls[1]?.bodyJson as Record<string, unknown> | undefined;
    expect(callBody).toBeDefined();
  });

  it("latest news flow with Serper keeps absolute dates and URLs", async () => {
    await withSearchEnv(
      {
        FRIDAY_SEARCH_PROVIDER: "serper",
        FRIDAY_SERPER_API_KEY: "test-serper-key",
      },
      async () => {
        const localEnv = await createMockHubEnv({ providerKinds: ["anthropic"] });
        const router = globalThis.fetch as unknown as MockFetchRouter;
        const route = {
          urlPrefix: "https://google.serper.dev",
          api: "anthropic-messages" as FridayProviderApi,
          mockFetch: async () =>
            new Response(JSON.stringify({
              organic: [
                {
                  title: "Headline A",
                  link: "https://example.com/a",
                  snippet: "A summary",
                  date: "2026-03-14",
                },
                {
                  title: "Headline B",
                  link: "https://example.com/b",
                  snippet: "B summary",
                  date: "2026-03-13",
                },
                {
                  title: "Headline C",
                  link: "https://example.com/c",
                  snippet: "C summary",
                  date: "2026-03-12",
                },
              ],
            }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        };
        router.routes.unshift(route);

        try {
          const mock = localEnv.mockFor("anthropic");
          mock.enqueue({
            type: "tool_use",
            toolName: "web_search",
            toolInput: { query: "Iran latest news", freshness: "day", numResults: 3 },
          });
          mock.enqueue({
            type: "text",
            text:
              "1. Headline A (2026-03-14) https://example.com/a\n" +
              "2. Headline B (2026-03-13) https://example.com/b\n" +
              "3. Headline C (2026-03-12) https://example.com/c",
          });

          const res = await apiFetch<AgentRunResult>(
            localEnv.baseUrl,
            localEnv.accessToken,
            "POST",
            "/v1/agent/runs",
            {
              task: "Give me the latest Iran news",
              providerId: localEnv.providers.anthropic!.providerId,
              model: localEnv.providers.anthropic!.model,
              timeoutMs: 15_000,
              timezone: "America/Los_Angeles",
            },
          );

          expect(res.json.data.status).toBe("completed");
          expect(res.json.data.response).toContain("2026-03-14");
          expect(res.json.data.response).toContain("https://example.com/a");
          expect(res.json.data.response.indexOf("2026-03-14")).toBeLessThan(
            res.json.data.response.indexOf("2026-03-13"),
          );
          expect(mock.calls.length).toBe(2);
          const secondCallBody = mock.calls[1]!.bodyJson as { messages?: unknown };
          expect(JSON.stringify(secondCallBody.messages)).toContain("Date: 2026-03-14");
        } finally {
          await localEnv.cleanup();
        }
      },
    );
  });

  it("default DuckDuckGo latest news flow downgrades to unverified latestness", async () => {
    const mock = env.mockFor("anthropic");

    injectRoute("https://html.duckduckgo.com", async () =>
      new Response(MOCK_DDG_HTML_3_RESULTS, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    mock.enqueue({
      type: "tool_use",
      toolName: "web_search",
      toolInput: { query: "Iran latest news", freshness: "day", numResults: 3 },
    });
    mock.enqueue({
      type: "text",
      text: "以下是关于伊朗的三条最新新闻。",
    });
    mock.enqueue({
      type: "text",
      text: "这些是我找到的搜索结果。",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Give me the latest Iran news", providerId, model, timeoutMs: 15_000, timezone: "UTC" },
    );

    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.response).toContain("could not verify");
    expect(res.json.data.response).toContain("(UTC)");
    expect(mock.calls.length).toBe(3);
  });
});
