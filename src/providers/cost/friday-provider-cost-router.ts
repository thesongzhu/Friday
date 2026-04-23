import type { FridayResolvedProviderRoute } from "../model/friday-provider.types.js";
import type {
  FridayCostRoutingDecision,
  FridayLlmBudgetStatus,
  FridayTaskComplexity,
} from "../model/friday-provider-cost.types.js";
import type { FridayProviderPricingCatalog } from "./friday-provider-pricing-catalog.js";

const QUALITY_TIER_SCORE: Record<string, number> = {
  best: 1.0,
  balanced: 0.5,
  cheap: 0.1,
};

// ─── Interface ───

export interface FridayProviderCostRouter {
  planRoutes(params: {
    candidates: FridayResolvedProviderRoute[];
    estimatedInputTokens: number;
    complexity: FridayTaskComplexity;
    budget: FridayLlmBudgetStatus;
  }): FridayCostRoutingDecision;
}

// ─── Factory ───

export function createFridayProviderCostRouter(deps: {
  pricingCatalog: FridayProviderPricingCatalog;
}): FridayProviderCostRouter {
  const { pricingCatalog } = deps;

  return {
    planRoutes(params) {
      const { candidates, estimatedInputTokens, complexity, budget } = params;
      const budgetState = budget.state;

      // Over-limit: only allow free/local providers (ollama)
      if (budgetState === "over_limit") {
        const localOnly = candidates.filter(
          (c) => c.provider.kind === "ollama",
        );

        return {
          strategy: "budget_local_only",
          complexity,
          budgetState,
          estimatedInputTokens,
          orderedCandidates: localOnly,
          reason: localOnly.length > 0
            ? "Budget exceeded — restricted to local (free) providers only"
            : "Budget exceeded — no local providers available",
        };
      }

      // Near-limit: prefer cheaper candidates
      if (budgetState === "near_limit") {
        const scored = candidates
          .map((candidate) => {
            const pricing = pricingCatalog.getPricing(
              candidate.provider.kind,
              candidate.model,
            );
            // When near limit, force cost-priority scoring
            const costScore = 1 - Math.min(pricing.inputPer1MUsd / 20, 1);
            const qualityScore = QUALITY_TIER_SCORE[pricing.qualityTier] ?? 0.5;
            const total = costScore * 0.80 + qualityScore * 0.20;
            return { candidate, score: total };
          })
          .sort((a, b) => b.score - a.score);

        return {
          strategy: "budget_downgrade",
          complexity,
          budgetState,
          estimatedInputTokens,
          orderedCandidates: scored.map((s) => s.candidate),
          reason: "Near budget limit — candidates re-ordered to prefer cheaper models",
        };
      }

      // Normal: preserve the operator-configured order. Cost routing may only
      // reorder when a budget policy explicitly requires a downgrade.
      return {
        strategy: "configured",
        complexity,
        budgetState,
        estimatedInputTokens,
        orderedCandidates: candidates,
        reason: "Budget OK — routing followed the configured provider order",
      };
    },
  };
}
