/**
 * Link Detection — Extract and deduplicate URLs from text.
 *
 * @module link-understanding/friday-link-detect
 */

import type { FridayLinkCandidate } from "./friday-link-understanding.types.js";

/**
 * Regex for matching HTTP(S) URLs in text.
 *
 * Matches:
 * - http:// and https:// schemes
 * - Domain names with optional port
 * - Paths, query strings, and fragments
 * - Stops at whitespace, quotes, or common trailing punctuation
 */
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

/**
 * Characters that are commonly appended to URLs in prose but aren't part of the URL.
 */
const TRAILING_PUNCT = /[.,;:!?)]+$/;

/**
 * Extracts URLs from text and returns deduplicated link candidates.
 */
export function detectLinks(text: string): FridayLinkCandidate[] {
  const matches: FridayLinkCandidate[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  // Reset lastIndex for global regex
  URL_REGEX.lastIndex = 0;

  while ((match = URL_REGEX.exec(text)) !== null) {
    let raw = match[0];
    const startIndex = match.index;

    // Strip trailing punctuation
    raw = raw.replace(TRAILING_PUNCT, "");

    // Normalize
    const normalized = normalizeUrl(raw);

    // Deduplicate
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    matches.push({
      url: raw,
      normalizedUrl: normalized,
      startIndex,
      endIndex: startIndex + raw.length,
    });
  }

  return matches;
}

/**
 * Normalizes a URL for deduplication:
 * - Lowercases scheme and host
 * - Removes default ports (80 for http, 443 for https)
 * - Removes trailing slash on root paths
 * - Removes fragment
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove fragment
    parsed.hash = "";
    // Remove default ports
    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }
    let normalized = parsed.toString();
    // Remove trailing slash on root path
    if (parsed.pathname === "/" && !parsed.search) {
      normalized = normalized.replace(/\/$/, "");
    }
    return normalized;
  } catch {
    return url.toLowerCase();
  }
}
