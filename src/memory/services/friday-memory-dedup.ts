/**
 * Memory Dedup — Initiative D.2
 *
 * Prevents storing semantically duplicate memories within the
 * same namespace. Before storing, checks for existing items
 * with high similarity and merges if found.
 *
 * Merge strategy:
 * - If score > threshold: update existing item's content, bump confidence
 * - If score <= threshold: store as new item
 */

import type {
  FridayMemoryItem,
  FridayMemoryNamespace,
  FridayMemorySearchResult,
  FridayMemoryStoreInput,
} from "../model/friday-memory.types.js";

// ─── Types ───

export interface FridayMemoryDedupResult {
  /** Whether a duplicate was found and merged. */
  deduplicated: boolean;
  /** The existing item that was merged into (if deduplicated). */
  existingItem?: FridayMemoryItem;
  /** Similarity score of the best match (0.0–1.0). */
  bestScore?: number;
}

export interface FridayMemoryDedupOptions {
  /** Similarity threshold above which items are considered duplicates. Default: 0.92. */
  threshold?: number;
  /** Maximum number of candidates to evaluate. Default: 5. */
  maxCandidates?: number;
}

export interface FridayMemoryDedupDeps {
  /** Search for existing memories (uses the memory service's search). */
  search: (
    query: string,
    options?: { namespace?: FridayMemoryNamespace; limit?: number; minScore?: number },
  ) => Promise<FridayMemorySearchResult[]>;
}

// ─── Dedup logic ───

const DEFAULT_THRESHOLD = 0.92;
const DEFAULT_MAX_CANDIDATES = 5;

/**
 * Check whether a new memory is a duplicate of an existing one.
 */
export async function checkMemoryDuplicate(
  input: FridayMemoryStoreInput,
  deps: FridayMemoryDedupDeps,
  options?: FridayMemoryDedupOptions,
): Promise<FridayMemoryDedupResult> {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const maxCandidates = options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  // Search for similar items in the same namespace
  const candidates = await deps.search(input.content, {
    namespace: input.namespace,
    limit: maxCandidates,
    minScore: threshold * 0.8, // slightly lower threshold for candidates
  });

  if (candidates.length === 0) {
    return { deduplicated: false };
  }

  // Find the best match
  const best = candidates[0]!;
  if (best.score >= threshold) {
    return {
      deduplicated: true,
      existingItem: best.item,
      bestScore: best.score,
    };
  }

  return {
    deduplicated: false,
    bestScore: best.score,
  };
}

/**
 * Compute a merged content string when deduplicating.
 * Prefers the newer content if it's longer or more detailed.
 */
export function mergeMemoryContent(
  existing: string,
  incoming: string,
): string {
  // If incoming is substantially longer, use it (more detail)
  if (incoming.length > existing.length * 1.2) {
    return incoming;
  }
  // If existing is longer, keep it
  if (existing.length > incoming.length * 1.2) {
    return existing;
  }
  // Similar length — prefer incoming (newer)
  return incoming;
}

/**
 * Compute merged confidence. Dedup boosts confidence slightly
 * since multiple sources confirm the same information.
 */
export function mergeMemoryConfidence(
  existingConfidence: number | undefined,
  incomingConfidence: number | undefined,
): number {
  const existing = existingConfidence ?? 0.8;
  const incoming = incomingConfidence ?? 0.8;
  // Average with a small boost for confirmation
  const merged = (existing + incoming) / 2 + 0.05;
  return Math.min(merged, 1.0);
}
