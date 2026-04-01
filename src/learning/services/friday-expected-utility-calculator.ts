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
  /** Historical success rate for similar actions (0..1). */
  historicalSuccessRate?: number;
  /** Historical failure rate for the route or remediation family (0..1). */
  routeFailureRate?: number;
  /** Number of matched lessons backing this remediation. */
  lessonMatchCount?: number;
  /** Strength of a matching learned pattern (0..1). */
  patternStrength?: number;
  /** Historical rollback frequency for similar fixes (0..1). */
  rollbackFrequency?: number;
  /** Historical operator rejection rate for similar fixes (0..1). */
  humanRejectionRate?: number;
  /** Learned budget/circuit-breaker state. */
  policyBudgetState?: "open" | "capped" | "cooldown";
}

export interface FridayUtilityResult {
  /** Expected utility score (roughly -1..1). */
  expectedUtility: number;
  /** Action recommendation based on utility. */
  recommendation: "auto_apply" | "suggest" | "defer";
  /** Human-readable reasoning string for observability. */
  reasoning: string;
  /** Structured learning signals that influenced the result. */
  learningSignals?: string[];
  /** Learned budget/circuit-breaker state applied to the decision. */
  policyBudgetState?: "open" | "capped" | "cooldown";
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

/**
 * Adaptive strategy that keeps the same contract but folds in historical
 * outcome data, lesson/pattern evidence, and operator feedback.
 *
 * It is intentionally constrained:
 * - it can downgrade or cap automation confidence
 * - it cannot bypass approval/risk gates
 * - budget states can only reduce autonomy (`auto_apply` -> `suggest`/`defer`)
 */
export class FridayAdaptiveUtilityStrategy implements FridayUtilityStrategy {
  compute(input: FridayUtilityInput): FridayUtilityResult {
    const clamp01 = (v: number | undefined, fallback = 0): number =>
      Math.max(0, Math.min(1, typeof v === "number" && Number.isFinite(v) ? v : fallback));

    const benefit = clamp01(input.estimatedBenefitScore);
    const cost = clamp01(input.estimatedCostScore);
    const predictedSuccess = clamp01(input.predictedSuccessProb);
    const historicalSuccess = clamp01(input.historicalSuccessRate, predictedSuccess);
    const routeFailure = clamp01(input.routeFailureRate, 1 - predictedSuccess);
    const rollbackFrequency = clamp01(input.rollbackFrequency);
    const humanRejectionRate = clamp01(input.humanRejectionRate);
    const lessonMatchCount = Math.max(0, Math.min(3, Math.floor(input.lessonMatchCount ?? 0)));
    const patternStrength = clamp01(input.patternStrength);
    const policyBudgetState = input.policyBudgetState ?? "open";

    const learningSignals: string[] = [];
    if (lessonMatchCount > 0) learningSignals.push(`lesson_match:${String(lessonMatchCount)}`);
    if (patternStrength > 0) learningSignals.push(`pattern_strength:${patternStrength.toFixed(2)}`);
    if (historicalSuccess !== predictedSuccess) {
      learningSignals.push(`historical_success:${historicalSuccess.toFixed(2)}`);
    }
    if (routeFailure > 0) learningSignals.push(`route_failure:${routeFailure.toFixed(2)}`);
    if (rollbackFrequency > 0) learningSignals.push(`rollback_frequency:${rollbackFrequency.toFixed(2)}`);
    if (humanRejectionRate > 0) learningSignals.push(`human_rejection:${humanRejectionRate.toFixed(2)}`);
    if (policyBudgetState !== "open") learningSignals.push(`budget:${policyBudgetState}`);

    const lessonBoost = lessonMatchCount * 0.08;
    const patternBoost = patternStrength * 0.12;
    const effectiveSuccess = clamp01(
      predictedSuccess * 0.45
      + historicalSuccess * 0.35
      + lessonBoost
      + patternBoost
      - routeFailure * 0.15
      - rollbackFrequency * 0.1
      - humanRejectionRate * 0.08,
      predictedSuccess,
    );
    const effectiveFailure = clamp01(
      routeFailure * 0.45
      + rollbackFrequency * 0.35
      + humanRejectionRate * 0.2,
      1 - effectiveSuccess,
    );

    const adjustedBenefit = clamp01(benefit + lessonBoost + patternBoost, benefit);
    const adjustedCost = clamp01(cost + rollbackFrequency * 0.25 + humanRejectionRate * 0.3, cost);
    const riskPenalty = input.riskTier * 0.15;
    const baseEu =
      adjustedBenefit * effectiveSuccess
      - adjustedCost * Math.max(effectiveFailure, 1 - effectiveSuccess)
      - riskPenalty;

    let recommendation: FridayUtilityResult["recommendation"];
    if (baseEu > 0.3) {
      recommendation = "auto_apply";
    } else if (baseEu > 0) {
      recommendation = "suggest";
    } else {
      recommendation = "defer";
    }

    if (policyBudgetState === "capped" && recommendation === "auto_apply") {
      recommendation = "suggest";
    } else if (policyBudgetState === "cooldown") {
      recommendation = "defer";
    }

    return {
      expectedUtility: baseEu,
      recommendation,
      reasoning:
        `EU=${baseEu.toFixed(3)}`
        + ` (benefit=${adjustedBenefit.toFixed(2)}`
        + `, P(success)=${effectiveSuccess.toFixed(2)}`
        + `, routeFailure=${routeFailure.toFixed(2)}`
        + `, rollback=${rollbackFrequency.toFixed(2)}`
        + `, humanReject=${humanRejectionRate.toFixed(2)}`
        + `, riskPenalty=${riskPenalty.toFixed(2)})`,
      ...(learningSignals.length > 0 ? { learningSignals } : {}),
      ...(policyBudgetState !== "open" ? { policyBudgetState } : {}),
    };
  }
}
