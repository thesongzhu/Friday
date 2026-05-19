import type { FridayResolvedProviderRoute } from "../model/friday-provider.types.js";
import type { FridayProviderRoutingCostMode } from "../model/friday-provider.types.js";
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

function scoreByCost(
  candidate: FridayResolvedProviderRoute,
  pricingCatalog: FridayProviderPricingCatalog,
): number {
  const pricing = pricingCatalog.getPricing(
    candidate.provider.kind,
    candidate.model,
  );
  const costScore = 1 - Math.min(pricing.inputPer1MUsd / 20, 1);
  const qualityScore = QUALITY_TIER_SCORE[pricing.qualityTier] ?? 0.5;
  return costScore * 0.95 + qualityScore * 0.05;
}

function scoreByBudgetDowngrade(
  candidate: FridayResolvedProviderRoute,
  pricingCatalog: FridayProviderPricingCatalog,
): number {
  const pricing = pricingCatalog.getPricing(
    candidate.provider.kind,
    candidate.model,
  );
  const costScore = 1 - Math.min(pricing.inputPer1MUsd / 20, 1);
  const qualityScore = QUALITY_TIER_SCORE[pricing.qualityTier] ?? 0.5;
  return costScore * 0.80 + qualityScore * 0.20;
}

function scoreByQuality(
  candidate: FridayResolvedProviderRoute,
  pricingCatalog: FridayProviderPricingCatalog,
): number {
  const pricing = pricingCatalog.getPricing(
    candidate.provider.kind,
    candidate.model,
  );
  const qualityScore = QUALITY_TIER_SCORE[pricing.qualityTier] ?? 0.5;
  const costScore = 1 - Math.min(pricing.inputPer1MUsd / 20, 1);
  return qualityScore * 0.85 + costScore * 0.15;
}

// ─── Interface ───

export interface FridayProviderCostRouter {
  planRoutes(params: {
    candidates: FridayResolvedProviderRoute[];
    estimatedInputTokens: number;
    complexity: FridayTaskComplexity;
    budget: FridayLlmBudgetStatus;
    costMode?: FridayProviderRoutingCostMode;
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
      const costMode = params.costMode ?? "standard";
      const budgetState = budget.state;

      // Over-limit: only allow free/local providers (ollama)
      if (budgetState === "over_limit") {
        const localOnly = candidates.filter(
          (c) => c.provider.kind === "ollama",
        );

        return {
          strategy: "budget_local_only",
          costMode,
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
            return {
              candidate,
              score: scoreByBudgetDowngrade(candidate, pricingCatalog),
            };
          })
          .sort((a, b) => b.score - a.score);

        return {
          strategy: "budget_downgrade",
          costMode,
          complexity,
          budgetState,
          estimatedInputTokens,
          orderedCandidates: scored.map((s) => s.candidate),
          reason: "Near budget limit — candidates re-ordered to prefer cheaper models",
        };
      }

      if (costMode === "frugal") {
        const scored = candidates
          .map((candidate) => ({
            candidate,
            score: scoreByCost(candidate, pricingCatalog),
          }))
          .sort((a, b) => b.score - a.score);

        return {
          strategy: "cost_auto",
          costMode,
          complexity,
          budgetState,
          estimatedInputTokens,
          orderedCandidates: scored.map((s) => s.candidate),
          reason: "Frugal mode: eligible candidates re-ordered to prefer lower-cost models",
        };
      }

      if (costMode === "strict") {
        const scored = candidates
          .map((candidate) => ({
            candidate,
            score: scoreByQuality(candidate, pricingCatalog),
          }))
          .sort((a, b) => b.score - a.score);

        return {
          strategy: "configured",
          costMode,
          complexity,
          budgetState,
          estimatedInputTokens,
          orderedCandidates: scored.map((s) => s.candidate),
          reason: "Strict mode: eligible candidates re-ordered to prefer higher-quality models",
        };
      }

      // Normal: preserve the operator-configured order. Cost routing may only
      // reorder when a budget policy explicitly requires a downgrade.
      return {
        strategy: "configured",
        costMode,
        complexity,
        budgetState,
        estimatedInputTokens,
        orderedCandidates: candidates,
        reason: "Budget OK — routing followed the configured provider order",
      };
    },
  };
}
