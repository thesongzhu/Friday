import { existsSync, readFileSync } from "node:fs";

import { createFridayAgentSsrfGuard, fetchWithFridayAgentSsrfGuard, FridaySsrfBlockedError } from "#agent";
import { FridayDomainError } from "#errors";

import type { FridayApiDocsCorpus, FridayApiDocsPage } from "./friday-undocumented-api.types.js";

// ─── Interfaces ───

export interface CreateFridayApiDocCrawlerDeps {
  fetchFn?: typeof fetch;
  nowIso?: () => string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Maximum pages to crawl (default: 1 for single-page, set higher for multi-page). */
  maxPages?: number;
  /** Maximum link-follow depth from the entry URL (default: 2). */
  maxDepth?: number;
  /** Optional allowlist of URL path prefixes to follow (same-origin enforced regardless). */
  allowedPathPrefixes?: string[];
}

export interface FridayApiDocCrawler {
  crawl(source: { uri?: string; contentBase64?: string }): Promise<FridayApiDocsCorpus>;
}

// ─── Constants ───

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_PAGES = 1;
const DEFAULT_MAX_DEPTH = 2;

// ─── Factory ───

export function createFridayApiDocCrawler(
  deps: CreateFridayApiDocCrawlerDeps = {},
): FridayApiDocCrawler {
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const timeoutMs = Math.max(1, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBytes = Math.max(1024, deps.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxPages = Math.max(1, deps.maxPages ?? DEFAULT_MAX_PAGES);
  const maxDepth = Math.max(0, deps.maxDepth ?? DEFAULT_MAX_DEPTH);
  const allowedPathPrefixes = deps.allowedPathPrefixes ?? [];
  const ssrfGuard = createFridayAgentSsrfGuard();

  return {
    async crawl(source): Promise<FridayApiDocsCorpus> {
      const sourceRef = source.uri ?? "inline-content";

      // Base64 content — no crawling, single page
      if (source.contentBase64) {
        let decoded: string;
        try {
          decoded = Buffer.from(source.contentBase64, "base64").toString("utf-8");
        } catch {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Invalid contentBase64 for undocumented API source",
            { httpStatus: 400 },
          );
        }
        return {
          sourceRef,
          pages: [
            {
              source: sourceRef,
              content: decoded.slice(0, maxBytes),
              fetchedAt: nowIso(),
            },
          ],
        };
      }

      if (!source.uri) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "Undocumented API converter requires source.uri or source.contentBase64",
          { httpStatus: 400 },
        );
      }

      // HTTP URL — multi-page crawl if maxPages > 1
      if (isHttpUrl(source.uri)) {
        if (maxPages <= 1) {
          // Single-page mode (backward compatible)
          const body = await fetchTextWithLimit(fetchFn, ssrfGuard, source.uri, timeoutMs, maxBytes);
          return {
            sourceRef,
            pages: [
              {
                source: source.uri,
                content: stripHtmlToText(body),
                fetchedAt: nowIso(),
              },
            ],
          };
        }

        // Multi-page bounded crawl
        return crawlMultiPage(
          source.uri,
          sourceRef,
          fetchFn,
          ssrfGuard,
          nowIso,
          timeoutMs,
          maxBytes,
          maxPages,
          maxDepth,
          allowedPathPrefixes,
        );
      }

      // Local file — single page
      if (!existsSync(source.uri)) {
        throw new FridayDomainError(
          "SOURCE_NOT_FOUND",
          `Undocumented API source not found: ${source.uri}`,
          { httpStatus: 404 },
        );
      }

      const raw = readFileSync(source.uri, "utf-8");
      return {
        sourceRef,
        pages: [
          {
            source: source.uri,
            content: raw.slice(0, maxBytes),
            fetchedAt: nowIso(),
          },
        ],
      };
    },
  };
}

// ─── Multi-Page Crawl ───

async function crawlMultiPage(
  entryUrl: string,
  sourceRef: string,
  fetchFn: typeof fetch,
  ssrfGuard: ReturnType<typeof createFridayAgentSsrfGuard>,
  nowIso: () => string,
  timeoutMs: number,
  maxBytes: number,
  maxPages: number,
  maxDepth: number,
  allowedPathPrefixes: string[],
): Promise<FridayApiDocsCorpus> {
  const pages: FridayApiDocsPage[] = [];
  const visited = new Set<string>();

  // BFS queue: [url, depth]
  const queue: Array<[string, number]> = [[normalizeUrl(entryUrl), 0]];
  const entryOrigin = extractOrigin(entryUrl);

  while (queue.length > 0 && pages.length < maxPages) {
    const [url, depth] = queue.shift()!;
    const normalized = normalizeUrl(url);

    if (visited.has(normalized)) continue;
    visited.add(normalized);

    let rawHtml: string;
    try {
      rawHtml = await fetchTextWithLimit(fetchFn, ssrfGuard, url, timeoutMs, maxBytes);
    } catch {
      // Skip pages that fail to fetch — don't abort the entire crawl
      continue;
    }

    const textContent = stripHtmlToText(rawHtml);
    pages.push({
      source: url,
      content: textContent,
      fetchedAt: nowIso(),
    });

    // Extract and enqueue links if within depth limit
    if (depth < maxDepth && pages.length < maxPages) {
      const links = extractSameOriginLinks(rawHtml, url, entryOrigin, allowedPathPrefixes);
      for (const link of links) {
        const normLink = normalizeUrl(link);
        if (!visited.has(normLink)) {
          queue.push([link, depth + 1]);
        }
      }
    }
  }

  if (pages.length === 0) {
    throw new FridayDomainError(
      "SOURCE_FETCH_FAILED",
      `Failed to fetch any pages from: ${entryUrl}`,
      { httpStatus: 422 },
    );
  }

  return { sourceRef, pages };
}

// ─── Link Extraction ───

/**
 * Extracts same-origin links from HTML content.
 * Only follows links that match the entry origin and optional path prefixes.
 */
export function extractSameOriginLinks(
  html: string,
  pageUrl: string,
  entryOrigin: string,
  allowedPathPrefixes: string[],
): string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  // Match href attributes in anchor tags
  const hrefPattern = /href\s*=\s*["']([^"'#]+)/gi;
  let match;

  while ((match = hrefPattern.exec(html)) !== null) {
    const href = match[1].trim();
    if (!href) continue;

    // Skip non-navigable links
    if (href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }

    // Resolve relative URLs
    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(href, pageUrl).href;
    } catch {
      continue;
    }

    // Enforce same origin
    const linkOrigin = extractOrigin(resolvedUrl);
    if (linkOrigin !== entryOrigin) continue;

    // Enforce path prefix allowlist
    if (allowedPathPrefixes.length > 0) {
      const linkPath = extractPath(resolvedUrl);
      if (!allowedPathPrefixes.some((prefix) => linkPath.startsWith(prefix))) {
        continue;
      }
    }

    // Skip non-doc-like URLs (images, downloads, etc.)
    if (isNonDocUrl(resolvedUrl)) continue;

    const normalized = normalizeUrl(resolvedUrl);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      links.push(resolvedUrl);
    }
  }

  return links;
}

// ─── URL Helpers ───

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function extractOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

function extractPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove fragment and trailing slash for normalization
    parsed.hash = "";
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    parsed.pathname = path;
    return parsed.href;
  } catch {
    return url;
  }
}

function isNonDocUrl(url: string): boolean {
  const path = extractPath(url).toLowerCase();
  return /\.(png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2|ttf|eot|mp4|mp3|pdf|zip|tar|gz)$/.test(path);
}

// ─── Fetch Helpers ───

async function fetchTextWithLimit(
  fetchFn: typeof fetch,
  ssrfGuard: ReturnType<typeof createFridayAgentSsrfGuard>,
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchWithFridayAgentSsrfGuard({
      url,
      init: {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "Friday-UndocumentedApiConverter/1.0",
          "Accept": "text/html, text/plain, application/json",
        },
      },
      guard: ssrfGuard,
      fetchFn,
    });
    if (!response.ok) {
      throw new FridayDomainError(
        "SOURCE_FETCH_FAILED",
        `Failed to fetch undocumented API source (${String(response.status)})`,
        { httpStatus: 422 },
      );
    }
    const text = await response.text();
    return text.slice(0, maxBytes);
  } catch (error) {
    if (error instanceof FridayDomainError) {
      throw error;
    }
    if (error instanceof FridaySsrfBlockedError) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Blocked by SSRF guard: ${error.message}`,
        { httpStatus: 400 },
      );
    }
    throw new FridayDomainError(
      "SOURCE_FETCH_FAILED",
      `Failed to fetch undocumented API source: ${error instanceof Error ? error.message : String(error)}`,
      { httpStatus: 422, retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

// ─── HTML Helpers ───

function stripHtmlToText(input: string): string {
  if (!/<[a-z][\s\S]*>/i.test(input)) {
    return input;
  }
  // Basic HTML stripping is enough for converter heuristics.
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
