/**
 * Link Understanding Service — Orchestrates URL detection, fetch, and summarization.
 *
 * @module link-understanding/friday-link-understanding-service
 */

import type {
  FridayLinkCacheRepository,
  FridayLinkCandidate,
  FridayLinkSummary,
  FridayLinkUnderstandingConfig,
} from "./friday-link-understanding.types.js";
import { DEFAULT_LINK_UNDERSTANDING_CONFIG } from "./friday-link-understanding.types.js";
import { detectLinks } from "./friday-link-detect.js";
import { fetchLink } from "./friday-link-fetch.js";
import type { FridayLinkFetchFn } from "./friday-link-fetch.js";
import { summarizeContent } from "./friday-link-summarize.js";

// ─── Deps ───

export interface FridayLinkUnderstandingServiceDeps {
  readonly fetchFn: FridayLinkFetchFn;
  readonly cache: FridayLinkCacheRepository;
  readonly nowIso: () => string;
  readonly config?: FridayLinkUnderstandingConfig;
}

// ─── Interface ───

export interface FridayLinkUnderstandingService {
  /** Detect links in text, fetch, summarize, and return enriched summaries. */
  processText(text: string): Promise<FridayLinkSummary[]>;
  /** Detect links without fetching (useful for dry-run). */
  detectOnly(text: string): FridayLinkCandidate[];
}

// ─── Factory ───

export function createFridayLinkUnderstandingService(
  deps: FridayLinkUnderstandingServiceDeps,
): FridayLinkUnderstandingService {
  const config = deps.config ?? DEFAULT_LINK_UNDERSTANDING_CONFIG;

  return {
    async processText(text) {
      if (!config.enabled) return [];

      const candidates = detectLinks(text).slice(0, config.maxLinksPerMessage);
      if (candidates.length === 0) return [];

      const summaries: FridayLinkSummary[] = [];

      for (const candidate of candidates) {
        const startTime = Date.now();

        // Check cache
        const cached = deps.cache.get(candidate.normalizedUrl);
        if (cached) {
          summaries.push({
            url: candidate.url,
            title: cached.title,
            summary: cached.summary,
            contentType: cached.contentType,
            cached: true,
            processingMs: Date.now() - startTime,
          });
          continue;
        }

        // Fetch and summarize
        try {
          const fetchResult = await fetchLink(candidate.url, deps.fetchFn, config);

          if (fetchResult.statusCode < 200 || fetchResult.statusCode >= 400) {
            continue;
          }

          const summary = await summarizeContent(
            fetchResult.body,
            fetchResult.contentType,
            config.summaryMaxChars,
            candidate.url,
          );

          const now = deps.nowIso();
          const expiresAt = new Date(
            new Date(now).getTime() + config.cacheTtlMs,
          ).toISOString();

          // Cache the result
          deps.cache.set({
            url: candidate.normalizedUrl,
            title: fetchResult.title,
            summary,
            contentType: fetchResult.contentType,
            fetchedAt: now,
            expiresAt,
          });

          summaries.push({
            url: candidate.url,
            title: fetchResult.title,
            summary,
            contentType: fetchResult.contentType,
            cached: false,
            processingMs: Date.now() - startTime,
          });
        } catch (err) {
          // Skip failed fetches silently
          console.warn("[friday][link-understanding-service] fetch failed:", err instanceof Error ? err.message : String(err));
          continue;
        }
      }

      return summaries;
    },

    detectOnly(text) {
      return detectLinks(text);
    },
  };
}
