/**
 * MCP Request Dedup — Initiative C.1
 *
 * Caches identical MCP tool call results within a configurable
 * time window. Prevents duplicate calls to the same MCP server
 * with the same tool name and arguments.
 *
 * Only read-only tool calls are cached. Mutating calls always
 * pass through.
 */

import { createHash } from "node:crypto";

// ─── Types ───

export interface FridayMcpDedupEntry<T = unknown> {
  key: string;
  result: T;
  cachedAt: number;
  expiresAt: number;
}

export interface FridayMcpRequestDedupOptions {
  /** Cache TTL in milliseconds. Default: 5000 (5s). */
  ttlMs?: number;
  /** Maximum number of cached entries. Default: 256. */
  maxEntries?: number;
}

export interface FridayMcpRequestDedup {
  /**
   * Get a cached result for the given call, or undefined if not cached.
   */
  get<T>(serverId: string, toolName: string, args: Record<string, unknown>): T | undefined;

  /**
   * Store a result in the cache.
   */
  set<T>(serverId: string, toolName: string, args: Record<string, unknown>, result: T): void;

  /**
   * Invalidate all cached results for a given server (e.g. after a mutation).
   */
  invalidateServer(serverId: string): void;

  /**
   * Clear the entire cache.
   */
  clear(): void;

  /** Number of entries currently cached. */
  readonly size: number;
}

// ─── Key generation ───

function buildCacheKey(serverId: string, toolName: string, args: Record<string, unknown>): string {
  const argsHash = createHash("sha256")
    .update(JSON.stringify(args, Object.keys(args).sort()))
    .digest("hex")
    .slice(0, 16);
  return `${serverId}:${toolName}:${argsHash}`;
}

// ─── Factory ───

export function createFridayMcpRequestDedup(
  options?: FridayMcpRequestDedupOptions,
): FridayMcpRequestDedup {
  const ttlMs = options?.ttlMs ?? 5_000;
  const maxEntries = options?.maxEntries ?? 256;
  const cache = new Map<string, FridayMcpDedupEntry>();

  function evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) {
        cache.delete(key);
      }
    }
  }

  function evictOldest(): void {
    if (cache.size <= maxEntries) return;
    // Delete oldest entries until we're under the limit
    const entries = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    const toDelete = entries.slice(0, cache.size - maxEntries);
    for (const [key] of toDelete) {
      cache.delete(key);
    }
  }

  function get<T>(serverId: string, toolName: string, args: Record<string, unknown>): T | undefined {
    const key = buildCacheKey(serverId, toolName, args);
    const entry = cache.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }

    return entry.result as T;
  }

  function set<T>(serverId: string, toolName: string, args: Record<string, unknown>, result: T): void {
    const key = buildCacheKey(serverId, toolName, args);
    const now = Date.now();
    cache.set(key, {
      key,
      result,
      cachedAt: now,
      expiresAt: now + ttlMs,
    });

    // Periodic cleanup
    if (cache.size > maxEntries * 1.5) {
      evictExpired();
      evictOldest();
    }
  }

  function invalidateServer(serverId: string): void {
    const prefix = `${serverId}:`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
  }

  function clear(): void {
    cache.clear();
  }

  return {
    get,
    set,
    invalidateServer,
    clear,
    get size() {
      return cache.size;
    },
  };
}
