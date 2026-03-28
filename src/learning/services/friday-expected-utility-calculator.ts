import type { FridayAutoFixRiskTier } from "../model/friday-auto-fix.types.js";

// ─── Input / Output types ───

export interface FridayUtilityInput {
  /** Risk tier from auto-fix assessment (0 = safe, 1 = needs rollback, 2 = needs approval). */
  riskTier: FridayAutoFixRiskTier;
  /** Diagnosis confidence (0..1). */
  confidence: number;
  /** Predicted probability of fix success (0..1). Initially equals confidence. */
  predictedSuccessProb: number;
  /** Estimated benefit of fixing this issue (0..1). Initially = normalize(recurrenceCount). */
  estimatedBenefitScore: number;
  /** Estimated cost of attempting the fix (0..1). Initially = riskTier / 2. */
  estimatedCostScore: number;
}

export interface FridayUtilityResult {
  /** Expected utility score (roughly -1..1). */
  expectedUtility: number;
  /** Action recommendation based on utility. */
  recommendation: "auto_apply" | "suggest" | "defer";
  /** Human-readable reasoning string for observability. */
  reasoning: string;
}

// ─── Strategy interface (pluggable for future ML models) ───

export interface FridayUtilityStrategy {
  compute(input: FridayUtilityInput): FridayUtilityResult;
}

// ─── Default heuristic strategy ───

/**
 * Computes expected utility using a simple benefit/cost model:
 *
 *   EU = benefit × P(success) - cost × P(failure) - riskPenalty
 *
 * This is intentionally simple — the interface is designed so a trained model
 * can replace this class without changing any callers.
 */
export class FridayHeuristicUtilityStrategy implements FridayUtilityStrategy {
  compute(input: FridayUtilityInput): FridayUtilityResult {
    // P3-03: Clamp probability/score inputs to valid [0, 1] range.
    const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
    const benefit = clamp01(input.estimatedBenefitScore);
    const cost = clamp01(input.estimatedCostScore);
    const pSuccess = clamp01(input.predictedSuccessProb);

    const eu = benefit * pSuccess - cost * (1 - pSuccess);
    const riskPenalty = input.riskTier * 0.15;
    const adjusted = eu - riskPenalty;

    let recommendation: FridayUtilityResult["recommendation"];
    if (adjusted > 0.3) {
      recommendation = "auto_apply";
    } else if (adjusted > 0) {
      recommendation = "suggest";
    } else {
      recommendation = "defer";
    }

    return {
      expectedUtility: adjusted,
      recommendation,
      reasoning:
        `EU=${adjusted.toFixed(3)}` +
        ` (benefit=${benefit.toFixed(2)}` +
        `, P(success)=${pSuccess.toFixed(2)}` +
        `, cost=${cost.toFixed(2)}` +
        `, riskPenalty=${riskPenalty.toFixed(2)})`,
    };
  }
}
