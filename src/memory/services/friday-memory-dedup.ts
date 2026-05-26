/**
 * Memory Dedup — Initiative D.2 (advisory-wired; destructive merge/block remains policy_pending)
 *
 * Provides a helper (`checkMemoryDuplicate`) that, given a candidate memory
 * item and a search function, can detect semantically duplicate memories in
 * the same namespace via similarity threshold. Also provides
 * `mergeMemoryContent` + `mergeMemoryConfidence` helpers reserved for future
 * merge logic.
 *
 * **Current state (B4 advisory wire-in, 2026-05-26):** `checkMemoryDuplicate`
 * is now called from `friday-memory-service.ts`'s `store()` path AFTER a
 * successful persist. When a duplicate is detected above
 * `deps.dedupThreshold` (default 0.92 placeholder), the service emits a
 * `FridayMemoryDedupAdvisoryEvent` via `console.info` and the optional
 * `deps.dedupAdvisorySink`. The advisory is purely additive — the
 * candidate is already in the durable store by the time it fires.
 *
 * Per POST_RELEASE_DEFAULT_DECISIONS.md B4 + the 2026-05-26 operator
 * directive: Friday MUST NEVER delete, overwrite, merge, or block any user
 * memory based on this signal. `mergeMemoryContent` /
 * `mergeMemoryConfidence` remain available for future callers but are NOT
 * invoked from `store()` — destructive merge/block semantics need explicit
 * product direction on:
 * - similarity threshold (the 0.92 default is a placeholder, not a policy)
 * - merge semantics (which fields take precedence: tags, metadata, TTL,
 *   source, confidence, embedding)
 * - confidence-bump behavior
 * - data-loss / clobber expectations when "merging" overlapping items
 * - audit trail when an item is merged vs. replaced vs. inserted-new
 *
 * Until that decision is made, callers MUST NOT assume `memoryService.store()`
 * de-duplicates incoming items. It does not. It only emits an advisory.
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
 * Emit a one-time advisory log on first `checkMemoryDuplicate()` call so
 * anyone reading runtime logs can see that this dedup machinery is wired
 * advisory-only — destructive merge/block semantics remain policy_pending.
 * Intentionally a `console.info` (not `warn`) so it's informational, not an
 * error; warn-once semantics so it does not spam.
 */
function emitMemoryDedupAdvisoryOnce(): void {
  if (memoryDedupAdvisoryEmitted) return;
  memoryDedupAdvisoryEmitted = true;
  console.info(
    "[friday][memory-dedup] advisory: checkMemoryDuplicate is wired into memoryService.store() in advisory-only mode (non-destructive). Duplicate detection emits an audit event; no memory is deleted, overwritten, merged, or blocked. Destructive merge/block semantics remain policy_pending (see file header).",
  );
}

/**
 * Check whether a new memory is a duplicate of an existing one.
 *
 * B4 advisory wire-in (2026-05-26): this helper IS now invoked by
 * `memoryService.store()` AFTER persist, in advisory-only mode. A positive
 * result triggers an audit event (`FridayMemoryDedupAdvisoryEvent`) but
 * never causes deletion, overwrite, merge, or blocking of any user memory.
 * Callers that need destructive dedup must implement their own policy on
 * top of this signal — `memoryService.store()` will not.
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
