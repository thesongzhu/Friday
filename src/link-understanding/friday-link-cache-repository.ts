/**
 * Link Cache Repository — In-memory cache for link summaries.
 *
 * @module link-understanding/friday-link-cache-repository
 */

import type {
  FridayLinkCacheEntry,
  FridayLinkCacheRepository,
} from "./friday-link-understanding.types.js";

/**
 * Creates an in-memory link cache repository.
 *
 * Production deployments can replace this with a SQLite-backed implementation.
 */
export function createFridayLinkCacheRepository(
  nowIso?: () => string,
): FridayLinkCacheRepository {
  const cache = new Map<string, FridayLinkCacheEntry>();
  const now = nowIso ?? (() => new Date().toISOString());

  return {
    get(url) {
      const entry = cache.get(url);
      if (!entry) return null;
      // Check expiry
      if (entry.expiresAt < now()) {
        cache.delete(url);
        return null;
      }
      return entry;
    },

    set(entry) {
      cache.set(entry.url, entry);
    },

    pruneExpired(now) {
      let count = 0;
      for (const [url, entry] of cache) {
        if (entry.expiresAt < now) {
          cache.delete(url);
          count++;
        }
      }
      return count;
    },
  };
}
