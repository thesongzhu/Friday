/**
 * Pattern Extractor — stub for extracting learned patterns
 * from episode trajectories.
 *
 * Initial implementation returns empty results. Future versions
 * will analyze tool sequence frequencies, failure mode clusters,
 * and temporal usage patterns to inform decision-making.
 */

import type { FridaySqliteLayer } from "#state";
import type { FridayLearnedPattern } from "../../agent/model/friday-agent-world-state.types.js";

// ─── Deps ───────────────────────────────────────────────────────

export interface CreateFridayPatternExtractorDeps {
  db: FridaySqliteLayer;
}

// ─── Public interface ───────────────────────────────────────────

export interface FridayPatternExtractor {
  /** Extract patterns from recent episodes for a user. */
  extractPatterns(userId: string, limit?: number): Promise<FridayLearnedPattern[]>;
}

// ─── Factory ────────────────────────────────────────────────────

export function createFridayPatternExtractor(
  _deps: CreateFridayPatternExtractorDeps,
): FridayPatternExtractor {
  return {
    async extractPatterns(_userId, _limit) {
      // Stub: future implementation will analyze episodes for:
      // - Tool sequence frequency (most common 3-tool combinations)
      // - Failure mode clustering (similar task + same error → pattern)
      // - Temporal patterns (user active hours + task type correlation)
      return [];
    },
  };
}
