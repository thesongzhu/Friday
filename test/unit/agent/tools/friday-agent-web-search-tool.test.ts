import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridayAgentWebSearchTool } from "#agent";

describe("FridayAgentWebSearchTool", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function signal(): AbortSignal {
    return new AbortController().signal;
  }

  it("returns dated Serper results with applied freshness metadata", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        organic: [
          {
            title: "Iran headline",
            link: "https://example.com/iran",
            snippet: "Latest Iran story",
            date: "2026-03-14",
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const tool = createFridayAgentWebSearchTool({
      provider: "serper",
      apiKey: "serper-key",
    });

    const result = await tool.execute(
      { query: "Iran latest news", freshness: "day", numResults: 1 },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Date: 2026-03-14");
    expect(result.metadata).toMatchObject({
      provider: "serper",
      freshnessRequested: "day",
      freshnessApplied: true,
      hasDates: true,
      warning: null,
    });
  });

  it("returns dated Tavily results with applied freshness metadata", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            title: "Iran update",
            url: "https://example.com/update",
            content: "Recent update",
            published_date: "2026-03-14T08:00:00Z",
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const tool = createFridayAgentWebSearchTool({
      provider: "tavily",
      apiKey: "tavily-key",
    });

    const result = await tool.execute(
      { query: "Iran latest news", freshness: "week", numResults: 1 },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Date: 2026-03-14T08:00:00Z");
    expect(result.metadata).toMatchObject({
      provider: "tavily",
      freshnessRequested: "week",
      freshnessApplied: true,
      hasDates: true,
      warning: null,
    });
  });

  it("marks DuckDuckGo results as unverified for latest-ness", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `
        <html><body>
          <div class="result">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1">Headline</a>
            <a class="result__snippet" href="#">Snippet</a>
          </div>
        </body></html>
      `,
    }) as unknown as typeof fetch;

    const tool = createFridayAgentWebSearchTool();

    const result = await tool.execute(
      { query: "Iran latest news", freshness: "day", numResults: 1 },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Warning:");
    expect(result.metadata).toMatchObject({
      provider: "duckduckgo",
      freshnessRequested: "day",
      freshnessApplied: false,
      hasDates: false,
    });
    expect(result.metadata?.warning).toContain("latest-ness is unverified");
  });

  it("does not silently fall back when Serper is configured without an API key", async () => {
    globalThis.fetch = vi.fn();
    const tool = createFridayAgentWebSearchTool({ provider: "serper" });

    const result = await tool.execute(
      { query: "Iran latest news", freshness: "day" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("FRIDAY_SERPER_API_KEY");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      provider: "serper",
      freshnessRequested: "day",
      freshnessApplied: false,
      hasDates: false,
    });
  });
});
