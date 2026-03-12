import type { FridaySqliteLayer } from "#state";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";

// ─── Interface ───

export interface FridayMarketplaceCacheService {
  /** Returns source IDs that have stale cache entries (older than freshTtlHours). */
  getStaleSourceIds(): string[];
  /** Prune cache entries older than pruneDays. */
  pruneStaleEntries(): number;
  /** Delete all cache entries for a specific source. */
  clearSourceCache(sourceId: string): number;
}

// ─── Config ───

export interface FridayMarketplaceCacheTtlConfig {
  freshTtlHours: number;
  staleServeTtlHours: number;
  pruneDays: number;
}

export const FRIDAY_DEFAULT_CACHE_TTL: FridayMarketplaceCacheTtlConfig = {
  freshTtlHours: 6,
  staleServeTtlHours: 24,
  pruneDays: 30,
};

// ─── Dependencies ───

export interface CreateMarketplaceCacheServiceDeps {
  db: FridaySqliteLayer;
  cacheRepo: FridayMarketplaceCacheRepository;
  nowIso: () => string;
  ttlConfig?: FridayMarketplaceCacheTtlConfig;
}

// ─── Factory ───

export function createFridayMarketplaceCacheService(
  deps: CreateMarketplaceCacheServiceDeps,
): FridayMarketplaceCacheService {
  const config = deps.ttlConfig ?? FRIDAY_DEFAULT_CACHE_TTL;

  function subtractHours(isoDate: string, hours: number): string {
    const ms = new Date(isoDate).getTime() - hours * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  }

  function subtractDays(isoDate: string, days: number): string {
    const ms = new Date(isoDate).getTime() - days * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  }

  return {
    getStaleSourceIds() {
      const cutoff = subtractHours(deps.nowIso(), config.freshTtlHours);
      return deps.db.withReadConnection((conn) =>
        deps.cacheRepo.listStaleSourceIds(conn, cutoff),
      );
    },

    pruneStaleEntries() {
      const cutoff = subtractDays(deps.nowIso(), config.pruneDays);
      return deps.db.withWriteTransaction((conn) =>
        deps.cacheRepo.pruneOlderThan(conn, cutoff),
      );
    },

    clearSourceCache(sourceId) {
      return deps.db.withWriteTransaction((conn) =>
        deps.cacheRepo.deleteBySourceId(conn, sourceId),
      );
    },
  };
}
