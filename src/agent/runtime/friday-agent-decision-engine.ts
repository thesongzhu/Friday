/**
 * Default Decision Engine — transparent pass-through.
 *
 * canDecideLocally() always returns false, so the LLM handles all decisions.
 * rankTools() returns tools unchanged.
 *
 * This is the baseline that preserves current behavior while establishing
 * the pluggable interface for future world-model integration.
 */

import type { FridayDecisionEngine } from "./friday-agent-decision-engine.types.js";

export function createDefaultFridayDecisionEngine(): FridayDecisionEngine {
  return {
    canDecideLocally: () => false,

    decideLocally: async () => ({
      action: "defer_to_llm" as const,
      confidence: 0,
      reason: "default engine defers all decisions to LLM",
    }),

    rankTools: (_ctx, tools) => tools,
  };
}
