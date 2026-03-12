/**
 * Link Fetch — SSRF-safe URL fetching with redirect limits and size caps.
 *
 * @module link-understanding/friday-link-fetch
 */

import type { FridayLinkUnderstandingConfig } from "./friday-link-understanding.types.js";

// ─── Fetch Result ───

export interface FridayLinkFetchResult {
  readonly url: string;
  readonly statusCode: number;
  readonly contentType: string | null;
  readonly body: string;
  readonly title: string | null;
  readonly truncated: boolean;
}

// ─── Fetch Function Abstraction ───

export type FridayLinkFetchFn = (
  url: string,
  options: { timeoutMs: number; maxRedirects: number },
) => Promise<{ statusCode: number; contentType: string | null; body: string }>;

/**
 * Fetches a URL with size limits and extracts title.
 */
export async function fetchLink(
  url: string,
  fetchFn: FridayLinkFetchFn,
  config: FridayLinkUnderstandingConfig,
): Promise<FridayLinkFetchResult> {
  const response = await fetchFn(url, {
    timeoutMs: config.fetchTimeoutMs,
    maxRedirects: config.maxRedirects,
  });

  let body = response.body;
  let truncated = false;

  if (body.length > config.maxResponseSizeBytes) {
    body = body.slice(0, config.maxResponseSizeBytes);
    truncated = true;
  }

  const title = extractTitle(body, response.contentType);

  return {
    url,
    statusCode: response.statusCode,
    contentType: response.contentType,
    body,
    title,
    truncated,
  };
}

/**
 * Extracts the page title from HTML content.
 */
function extractTitle(body: string, contentType: string | null): string | null {
  if (!contentType || !contentType.includes("html")) return null;

  // Try <title> tag
  const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) return titleMatch[1].trim();

  // Try og:title
  const ogMatch = body.match(
    /<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i,
  );
  if (ogMatch) return ogMatch[1].trim();

  return null;
}
