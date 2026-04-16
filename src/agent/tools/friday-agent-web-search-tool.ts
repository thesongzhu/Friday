import { FridayDomainError } from "#errors";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Constants ───

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;
const SEARCH_TIMEOUT_MS = 15_000;
const GOOGLE_NEWS_RSS_SEARCH_URL = "https://news.google.com/rss/search";
const DUCKDUCKGO_TIMELINESS_WARNING =
  "DuckDuckGo HTML search does not provide verified recency filtering or stable publication dates; latest-ness is unverified.";
const SERPER_KEY_MISSING_WARNING =
  'web_search provider "serper" requires FRIDAY_SERPER_API_KEY; refusing to silently fall back to DuckDuckGo for time-sensitive lookups.';
const TAVILY_KEY_MISSING_WARNING =
  'web_search provider "tavily" requires FRIDAY_TAVILY_API_KEY; refusing to silently fall back to DuckDuckGo for time-sensitive lookups.';

// ─── Options ───

export interface CreateFridayAgentWebSearchToolOptions {
  /** Search provider: "auto" | "serper" | "tavily" | "duckduckgo" | "google_news_rss". Defaults to "auto". */
  provider?: string;
  /** API key for the configured provider (not needed for duckduckgo/google_news_rss). */
  apiKey?: string;
}

// ─── Result type ───

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

type ConfiguredWebSearchProvider = "auto" | "serper" | "tavily" | "duckduckgo" | "google_news_rss";

type WebSearchProvider = "serper" | "tavily" | "duckduckgo" | "google_news_rss";

type WebSearchMetadata = Record<string, unknown> & {
  provider: WebSearchProvider;
  freshnessRequested: string | null;
  freshnessApplied: boolean;
  hasDates: boolean;
  warning: string | null;
};

// ─── Factory ───

export function createFridayAgentWebSearchTool(
  options?: CreateFridayAgentWebSearchToolOptions,
): FridayAgentToolDefinition {
  const configuredProvider = normalizeProvider(options?.provider);
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
        let warning: string | null = null;
        let freshnessApplied = false;
        let provider: WebSearchProvider;

        if (configuredProvider === "serper") {
          if (!apiKey) {
            return {
              ...errorResult(SERPER_KEY_MISSING_WARNING),
              metadata: buildSearchMetadata({
                provider: "serper",
                freshnessRequested: freshness,
                freshnessApplied: false,
                hasDates: false,
                warning: SERPER_KEY_MISSING_WARNING,
              }),
            };
          }
          results = await searchSerper(query, numResults, freshness, apiKey, timeoutController.signal);
          freshnessApplied = Boolean(freshness);
          provider = "serper";
        } else if (configuredProvider === "tavily") {
          if (!apiKey) {
            return {
              ...errorResult(TAVILY_KEY_MISSING_WARNING),
              metadata: buildSearchMetadata({
                provider: "tavily",
                freshnessRequested: freshness,
                freshnessApplied: false,
                hasDates: false,
                warning: TAVILY_KEY_MISSING_WARNING,
              }),
            };
          }
          results = await searchTavily(query, numResults, freshness, apiKey, timeoutController.signal);
          freshnessApplied = Boolean(freshness);
          provider = "tavily";
        } else if (
          configuredProvider === "google_news_rss"
          || (configuredProvider === "auto" && isTimeSensitiveNewsQuery(query, freshness))
        ) {
          results = await searchGoogleNewsRss(query, numResults, freshness, timeoutController.signal);
          freshnessApplied = Boolean(freshness);
          provider = "google_news_rss";
        } else {
          results = await searchDuckDuckGo(query, numResults, timeoutController.signal);
          freshnessApplied = false;
          warning = freshness ? DUCKDUCKGO_TIMELINESS_WARNING : null;
          provider = "duckduckgo";
        }

        const hasDates = results.some((result) => typeof result.date === "string" && result.date.trim().length > 0);
        if (!warning && (provider === "serper" || provider === "tavily" || provider === "google_news_rss") && freshnessApplied && !hasDates) {
          warning = "Search results did not include verifiable publication dates; latest-ness remains unverified.";
        }
        const metadata = buildSearchMetadata({
          provider,
          freshnessRequested: freshness,
          freshnessApplied,
          hasDates,
          warning,
        });

        if (results.length === 0) {
          const content = warning
            ? `Warning: ${warning}\n\nNo results found.`
            : "No results found.";
          return { content, isError: undefined, metadata };
        }

        const formatted = results.map((result, index) => {
          const parts = [
            `${String(index + 1)}. ${result.title}`,
            `   URL: ${result.url}`,
          ];
          if (result.date) parts.push(`   Date: ${result.date}`);
          parts.push(`   ${result.snippet}`);
          return parts.join("\n");
        });

        const sections = warning
          ? [`Warning: ${warning}`, formatted.join("\n\n")]
          : [formatted.join("\n\n")];
        return { content: sections.join("\n\n"), isError: undefined, metadata };
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

function normalizeProvider(provider: string | undefined): ConfiguredWebSearchProvider {
  const normalized = provider?.trim().toLowerCase();
  if (
    normalized === "auto"
    || normalized === "serper"
    || normalized === "tavily"
    || normalized === "duckduckgo"
    || normalized === "google_news_rss"
  ) {
    return normalized;
  }
  return "auto";
}

function buildSearchMetadata(input: {
  provider: WebSearchProvider;
  freshnessRequested: string | undefined;
  freshnessApplied: boolean;
  hasDates: boolean;
  warning: string | null;
}): WebSearchMetadata {
  return {
    provider: input.provider,
    freshnessRequested: input.freshnessRequested ?? null,
    freshnessApplied: input.freshnessApplied,
    hasDates: input.hasDates,
    warning: input.warning,
  };
}

function isTimeSensitiveNewsQuery(query: string, freshness: string | undefined): boolean {
  if (typeof freshness === "string" && freshness.trim().length > 0) {
    return true;
  }
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return (
    /\b(latest|recent|today|current|breaking|headline|news)\b/.test(normalized)
    || /(最新|最近|今天|当前|新闻|头条|快讯|报道)/.test(query)
  );
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
    throw new FridayDomainError("INTERNAL_ERROR", `Serper API error: HTTP ${String(response.status)}`, { httpStatus: 500 });
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
    throw new FridayDomainError("INTERNAL_ERROR", `Tavily API error: HTTP ${String(response.status)}`, { httpStatus: 500 });
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

// ─── Google News RSS (public dated feed for time-sensitive news) ───

async function searchGoogleNewsRss(
  query: string,
  numResults: number,
  freshness: string | undefined,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const url = new URL(GOOGLE_NEWS_RSS_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; FridayAgent/1.0)",
    },
    signal,
  });

  if (!response.ok) {
    throw new FridayDomainError("INTERNAL_ERROR", `Google News RSS error: HTTP ${String(response.status)}`, { httpStatus: 500 });
  }

  const xml = await response.text();
  const parsed = parseGoogleNewsRss(xml);
  const filtered = applyFreshnessFilter(parsed, freshness);
  return filtered.slice(0, numResults);
}

function parseGoogleNewsRss(xml: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;

  for (const match of xml.matchAll(itemRegex)) {
    const block = match[1] ?? "";
    const title = normalizeWhitespace(decodeHtmlEntities(readXmlTag(block, "title")));
    const url = normalizeWhitespace(decodeHtmlEntities(readXmlTag(block, "link")));
    const description = normalizeWhitespace(stripHtmlTags(decodeHtmlEntities(readXmlTag(block, "description"))));
    const date = normalizeWhitespace(decodeHtmlEntities(readXmlTag(block, "pubDate")));

    if (!title || !url) {
      continue;
    }

    results.push({
      title,
      url,
      snippet: description || title,
      date: date || undefined,
    });
  }

  return results;
}

function readXmlTag(block: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = pattern.exec(block);
  if (!match?.[1]) {
    return "";
  }
  return match[1].replace(/^<!\\[CDATA\\[/, "").replace(/\\]\\]>$/, "");
}

function applyFreshnessFilter(
  results: WebSearchResult[],
  freshness: string | undefined,
): WebSearchResult[] {
  const cutoffDays = freshness === "day"
    ? 1
    : freshness === "week"
      ? 7
      : freshness === "month"
        ? 30
        : null;
  if (cutoffDays === null) {
    return results;
  }
  const cutoff = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;
  return results.filter((result) => {
    if (!result.date) {
      return false;
    }
    const publishedAt = Date.parse(result.date);
    return Number.isFinite(publishedAt) && publishedAt >= cutoff;
  });
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
    throw new FridayDomainError("INTERNAL_ERROR", `DuckDuckGo error: HTTP ${String(response.status)}`, { httpStatus: 500 });
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

  for (let index = 0; index < Math.min(links.length, maxResults); index++) {
    const linkMatch = links[index]!;
    let href = linkMatch[1] ?? "";
    const titleHtml = linkMatch[2] ?? "";
    const snippetHtml = snippets[index]?.[1] ?? "";

    if (href.includes("uddg=")) {
      const uddgMatch = /uddg=([^&]+)/.exec(href);
      if (uddgMatch?.[1]) {
        href = decodeURIComponent(uddgMatch[1]);
      }
    }

    const title = normalizeWhitespace(stripHtmlTags(titleHtml));
    const snippet = normalizeWhitespace(stripHtmlTags(snippetHtml));

    if (title && href) {
      results.push({ title, url: href, snippet });
    }
  }

  return results;
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
