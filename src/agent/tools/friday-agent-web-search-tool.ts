import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  readNumberParam,
  readStringParam,
  truncateOutput,
} from "./friday-agent-tool-helpers.js";

// ─── Constants ───

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;
const SEARCH_TIMEOUT_MS = 15_000;

// ─── Options ───

export interface CreateFridayAgentWebSearchToolOptions {
  /** Search provider: "serper" | "tavily" | "duckduckgo". Defaults to "duckduckgo". */
  provider?: string;
  /** API key for the configured provider (not needed for duckduckgo). */
  apiKey?: string;
}

// ─── Result type ───

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

// ─── Factory ───

export function createFridayAgentWebSearchTool(
  options?: CreateFridayAgentWebSearchToolOptions,
): FridayAgentToolDefinition {
  const provider = (options?.provider ?? "duckduckgo").toLowerCase();
  const apiKey = options?.apiKey;

  return {
    name: "web_search",
    description:
      "Search the web for information. Returns a list of results with titles, URLs, and snippets. " +
      "Use this for news, facts, documentation, and any information lookup. " +
      "Prefer this over browser for simple searches.",
    parameters: {
      properties: {
        query: { type: "string", description: "Search query" },
        numResults: {
          type: "number",
          description: `Number of results to return (1-${MAX_NUM_RESULTS}). Defaults to ${DEFAULT_NUM_RESULTS}.`,
        },
        freshness: {
          type: "string",
          description: 'Filter by recency: "day", "week", or "month". Optional.',
        },
      },
      required: ["query"],
    },
    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const query = readStringParam(args, "query", { required: true });
      const numResults = Math.min(
        Math.max(1, readNumberParam(args, "numResults", { integer: true }) ?? DEFAULT_NUM_RESULTS),
        MAX_NUM_RESULTS,
      );
      const freshness = readStringParam(args, "freshness");

      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), SEARCH_TIMEOUT_MS);
      const onParentAbort = () => timeoutController.abort();
      if (signal.aborted) {
        timeoutController.abort();
      } else {
        signal.addEventListener("abort", onParentAbort, { once: true });
      }

      try {
        let results: WebSearchResult[];

        if (provider === "serper" && apiKey) {
          results = await searchSerper(query, numResults, freshness, apiKey, timeoutController.signal);
        } else if (provider === "tavily" && apiKey) {
          results = await searchTavily(query, numResults, freshness, apiKey, timeoutController.signal);
        } else {
          results = await searchDuckDuckGo(query, numResults, timeoutController.signal);
        }

        if (results.length === 0) {
          return { content: "No results found.", isError: undefined };
        }

        const formatted = results.map((r, i) => {
          const parts = [
            `${String(i + 1)}. ${r.title}`,
            `   URL: ${r.url}`,
          ];
          if (r.date) parts.push(`   Date: ${r.date}`);
          parts.push(`   ${r.snippet}`);
          return parts.join("\n");
        });

        return { content: formatted.join("\n\n"), isError: undefined };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("abort")) {
          return errorResult(`Search timed out after ${String(SEARCH_TIMEOUT_MS)}ms`);
        }
        return errorResult(`Search error: ${message}`);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onParentAbort);
      }
    },
  };
}

// ─── Serper.dev provider (Google results) ───

async function searchSerper(
  query: string,
  numResults: number,
  freshness: string | undefined,
  apiKey: string,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const body: Record<string, unknown> = { q: query, num: numResults };
  if (freshness === "day") body.tbs = "qdr:d";
  else if (freshness === "week") body.tbs = "qdr:w";
  else if (freshness === "month") body.tbs = "qdr:m";

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Serper API error: HTTP ${String(response.status)}`);
  }

  const data = await response.json() as {
    organic?: Array<{
      title?: string;
      link?: string;
      snippet?: string;
      date?: string;
    }>;
  };

  return (data.organic ?? []).slice(0, numResults).map((item) => ({
    title: item.title ?? "",
    url: item.link ?? "",
    snippet: item.snippet ?? "",
    date: item.date,
  }));
}

// ─── Tavily provider ───

async function searchTavily(
  query: string,
  numResults: number,
  freshness: string | undefined,
  apiKey: string,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: numResults,
    search_depth: "basic",
  };
  if (freshness === "day") body.days = 1;
  else if (freshness === "week") body.days = 7;
  else if (freshness === "month") body.days = 30;

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Tavily API error: HTTP ${String(response.status)}`);
  }

  const data = await response.json() as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      published_date?: string;
    }>;
  };

  return (data.results ?? []).slice(0, numResults).map((item) => ({
    title: item.title ?? "",
    url: item.url ?? "",
    snippet: item.content ?? "",
    date: item.published_date,
  }));
}

// ─── DuckDuckGo HTML lite (no API key needed) ───

async function searchDuckDuckGo(
  query: string,
  numResults: number,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; FridayAgent/1.0)",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo error: HTTP ${String(response.status)}`);
  }

  const html = await response.text();
  return parseDuckDuckGoHtml(html, numResults);
}

function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  // Match result links: <a rel="nofollow" class="result__a" href="...">...</a>
  const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Match snippets: <a class="result__snippet" ...>...</a>
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links = [...html.matchAll(linkRegex)];
  const snippets = [...html.matchAll(snippetRegex)];

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const linkMatch = links[i]!;
    let href = linkMatch[1] ?? "";
    const titleHtml = linkMatch[2] ?? "";
    const snippetHtml = snippets[i]?.[1] ?? "";

    // DuckDuckGo wraps URLs in a redirect: //duckduckgo.com/l/?uddg=<encoded>&rut=...
    if (href.includes("uddg=")) {
      const uddgMatch = /uddg=([^&]+)/.exec(href);
      if (uddgMatch?.[1]) {
        href = decodeURIComponent(uddgMatch[1]);
      }
    }

    const title = stripHtmlTags(titleHtml).trim();
    const snippet = stripHtmlTags(snippetHtml).trim();

    if (title && href) {
      results.push({ title, url: href, snippet });
    }
  }

  return results;
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
