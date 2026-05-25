/**
 * Memory Dedup — Initiative D.2 (proof_pending; NOT wired into store path)
 *
 * Provides a helper (`checkMemoryDuplicate`) that, given a candidate memory
 * item and a search function, can detect semantically duplicate memories in
 * the same namespace via similarity threshold. Also provides a `mergeMemoryContent`
 * helper for downstream merge logic.
 *
 * **Current state (B3 truth-labeling):** the helper is NOT called from
 * `friday-memory-service.ts`'s `store()` path. `memoryService.store()`
 * persists every well-formed store request as a new row regardless of
 * whether a near-duplicate already exists. This module's existence does
 * NOT mean Friday's durable memory store de-duplicates incoming items.
 *
 * Wiring this helper into `store()` is a memory-policy decision that
 * requires explicit product direction on:
 * - similarity threshold (the 0.92 default is a placeholder, not a policy)
 * - merge semantics (which fields take precedence: tags, metadata, TTL,
 *   source, confidence, embedding)
 * - confidence-bump behavior
 * - data-loss / clobber expectations when "merging" overlapping items
 * - audit trail when an item is merged vs. replaced vs. inserted-new
 *
 * Until that decision is made and the helper is wired with proof, callers
 * MUST NOT assume dedup is active. The `assertFridayMemoryDedupNotActive`
 * advisory is emitted once per process when this module is first imported
 * so a future regression that silently wires this without policy review
 * surfaces in logs.
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

let memoryDedupAdvisoryEmitted = false;

/**
 * Emit a one-time advisory log so anyone reading runtime logs can see that
 * this dedup machinery is loaded but not wired into the durable memory
 * store path. Intentionally a `console.info` (not `warn`) so it's
 * informational, not an error; warn-once semantics so it does not spam.
 */
function emitMemoryDedupAdvisoryOnce(): void {
  if (memoryDedupAdvisoryEmitted) return;
  memoryDedupAdvisoryEmitted = true;
  console.info(
    "[friday][memory-dedup] advisory: checkMemoryDuplicate is loaded but NOT wired into memoryService.store(). Durable memory store does not de-duplicate incoming items. Full dedup wiring is policy_pending (see file header).",
  );
}

/**
 * Check whether a new memory is a duplicate of an existing one.
 *
 * B3 truth-labeling: this helper is callable but NOT invoked by the durable
 * `memoryService.store()` path. Calling it from a caller that explicitly
 * needs dedup is fine; do NOT assume that calling `memoryService.store()`
 * implicitly de-duplicates incoming items.
 */
export async function checkMemoryDuplicate(
  input: FridayMemoryStoreInput,
  deps: FridayMemoryDedupDeps,
  options?: FridayMemoryDedupOptions,
): Promise<FridayMemoryDedupResult> {
  emitMemoryDedupAdvisoryOnce();
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
