/**
 * Link Understanding — Type definitions for URL detection, fetch, and summarization.
 *
 * @module link-understanding/friday-link-understanding.types
 */

// ─── Link Candidate ───

export interface FridayLinkCandidate {
  /** Original URL as extracted from text. */
  readonly url: string;
  /** Normalized URL (lowercase scheme, no fragment). */
  readonly normalizedUrl: string;
  /** Start index in source text. */
  readonly startIndex: number;
  /** End index in source text. */
  readonly endIndex: number;
}

// ─── Link Summary ───

export interface FridayLinkSummary {
  /** The URL that was fetched. */
  readonly url: string;
  /** Page title (from <title> or og:title). */
  readonly title: string | null;
  /** Short summary of the page content. */
  readonly summary: string;
  /** Content type of the fetched resource. */
  readonly contentType: string | null;
  /** Whether this came from cache. */
  readonly cached: boolean;
  /** Processing time in ms. */
  readonly processingMs: number;
}

// ─── Configuration ───

export interface FridayLinkUnderstandingConfig {
  /** Whether link understanding is enabled. */
  readonly enabled: boolean;
  /** Maximum number of links to process per message. */
  readonly maxLinksPerMessage: number;
  /** Maximum response body size in bytes before truncation. */
  readonly maxResponseSizeBytes: number;
  /** Fetch timeout in ms. */
  readonly fetchTimeoutMs: number;
  /** Maximum redirect count. */
  readonly maxRedirects: number;
  /** Cache TTL in ms. */
  readonly cacheTtlMs: number;
  /** Summary max length in characters. */
  readonly summaryMaxChars: number;
}

export const DEFAULT_LINK_UNDERSTANDING_CONFIG: FridayLinkUnderstandingConfig = {
  enabled: true,
  maxLinksPerMessage: 3,
  maxResponseSizeBytes: 512 * 1024, // 512 KB
  fetchTimeoutMs: 10_000,
  maxRedirects: 5,
  cacheTtlMs: 60 * 60 * 1000, // 1 hour
  summaryMaxChars: 500,
};

// ─── Cache Entry ───

export interface FridayLinkCacheEntry {
  readonly url: string;
  readonly title: string | null;
  readonly summary: string;
  readonly contentType: string | null;
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

// ─── Cache Repository ───

export interface FridayLinkCacheRepository {
  /** Get a cached summary by URL. Returns null if not cached or expired. */
  get(url: string): FridayLinkCacheEntry | null;
  /** Store a summary in cache. */
  set(entry: FridayLinkCacheEntry): void;
  /** Remove expired entries. Returns count of removed entries. */
  pruneExpired(now: string): number;
}
