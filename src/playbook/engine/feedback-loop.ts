import { FridayDomainError } from "#errors";

/**
 * Feedback Loop — Track playbook success/failure rates and adjust
 * confidence scores using multi-dimensional scoring with exponential decay.
 *
 * Implements the {@link FridayPlaybookScoreCalculator} interface.
 * Also provides promotion evaluation via the {@link FridayPlaybookPromotionEngine} interface.
 *
 * @module playbook/engine
 */

import type {
  FridayPlaybook,
  FridayPlaybookCandidate,
  FridayPlaybookCostDimensions,
  FridayPlaybookEngineConfig,
  FridayPlaybookPromotionEngine,
  FridayPlaybookScore,
  FridayPlaybookScoreCalculator,
  FridayPlaybookScoreConfig,
  FridayPlaybookScoreDimension,
  FridayPromotionConfig,
  FridayPromotionDecision,
  FridayPromotionDecisionOutcome,
  FridayPromotionRule,
  FridayPromotionRuleResult,
  UUID,
} from "../model/friday-playbook.types.js";

import {
  FRIDAY_PLAYBOOK_COST_NORMALIZATION_WEIGHTS,
} from "../model/friday-playbook.types.js";

import type { PlaybookStore } from "./playbook-store.js";

// ─── Score Calculator ───

/** Dependencies for creating a score calculator. */
export interface ScoreCalculatorDeps {
  store: PlaybookStore;
  config: FridayPlaybookEngineConfig;
}

/** Create a score calculator instance. */
export function createScoreCalculator(deps: ScoreCalculatorDeps): FridayPlaybookScoreCalculator {
  const { store, config } = deps;
  const scoreConfig = config.scoring;

  return {
    async recalculate(playbookId: UUID): Promise<FridayPlaybookScore> {
      const playbook = store.getPlaybook(playbookId);
      if (!playbook) {
        throw new FridayDomainError("NOT_FOUND", `Playbook not found: ${playbookId}`, { httpStatus: 404 });
      }
      return calculateAndPersistScore(playbook);
    },

    async recalculateAll(): Promise<FridayPlaybookScore[]> {
      const playbooks = store.getAllPlaybooks("active");
      const scores: FridayPlaybookScore[] = [];
      for (const pb of playbooks) {
        scores.push(calculateAndPersistScore(pb));
      }
      return scores;
    },
  };

  function calculateAndPersistScore(playbook: FridayPlaybook): FridayPlaybookScore {
    const matches = store.getMatchesByPlaybookId(playbook.id);
    const sampleSize = matches.length || 1;

    // Success rate
    const successRate = playbook.totalUses > 0 ? playbook.totalSuccesses / playbook.totalUses : 0;

    // Speed score: normalized inverse of average duration
    const speedScore = computeSpeedScore(playbook);

    // Cost efficiency score
    const costEfficiencyScore = computeCostEfficiencyScore(playbook);

    // Satisfaction score (derived from success rate as proxy when no explicit feedback)
    const satisfactionScore = successRate * 0.8;

    // Apply exponential decay based on time since actual last use.
    const recencyAnchor = playbook.lastUsedAt ?? playbook.createdAt;
    const daysSinceLastUse = computeDaysSince(recencyAnchor, config.nowIso());
    const decayFactor = Math.exp(-scoreConfig.decayRate * daysSinceLastUse);

    // Compute weighted composite score
    const weights = scoreConfig.weights;
    const rawComposite =
      weights.success_rate * successRate +
      weights.speed * speedScore +
      weights.cost_efficiency * costEfficiencyScore +
      weights.satisfaction * satisfactionScore;

    const compositeScore = clamp(rawComposite * decayFactor, 0, 1);

    const score: FridayPlaybookScore = {
      id: config.generateId(),
      playbookId: playbook.id,
      versionNumber: playbook.activeVersionNumber,
      compositeScore,
      successRate,
      speedScore,
      costEfficiencyScore,
      satisfactionScore,
      sampleSize,
      calculatedAt: config.nowIso(),
    };

    store.saveScore(score);

    // Update playbook composite score cache
    const updatedPlaybook: FridayPlaybook = {
      ...playbook,
      compositeScore,
      updatedAt: config.nowIso(),
    };
    store.savePlaybook(updatedPlaybook);

    return score;
  }

  function computeSpeedScore(playbook: FridayPlaybook): number {
    // Look up candidate for duration data
    const candidate = store.getCandidate(playbook.sourceCandidateId);
    if (!candidate || candidate.evidenceCount === 0) return 0.5;

    const avgDurationMs = candidate.totalDurationMs / candidate.evidenceCount;
    // Normalize: faster = higher score. Use 60s as baseline for "slow"
    const maxDurationMs = 60_000;
    return clamp(1 - avgDurationMs / maxDurationMs, 0, 1);
  }

  function computeCostEfficiencyScore(playbook: FridayPlaybook): number {
    const candidate = store.getCandidate(playbook.sourceCandidateId);
    if (!candidate || candidate.evidenceCount === 0) return 0.5;

    const avgCost = normalizeCost({
      tokenCost: candidate.totalCost.tokenCost / candidate.evidenceCount,
      apiCallCost: candidate.totalCost.apiCallCost / candidate.evidenceCount,
      latencyMs: candidate.totalCost.latencyMs / candidate.evidenceCount,
    });

    // Normalize: lower cost = higher score. Use 1000 as baseline for "expensive"
    const maxCost = 1000;
    return clamp(1 - avgCost / maxCost, 0, 1);
  }
}

// ─── Promotion Engine ───

/** Dependencies for creating a promotion engine. */
export interface PromotionEngineDeps {
  store: PlaybookStore;
  config: FridayPlaybookEngineConfig;
}

/** Create a promotion engine instance. */
export function createPromotionEngine(deps: PromotionEngineDeps): FridayPlaybookPromotionEngine {
  const { store, config } = deps;
  const promoConfig = config.promotion;

  return {
    async evaluate(candidateId: UUID): Promise<FridayPromotionDecision> {
      const candidate = store.getCandidate(candidateId);
      if (!candidate) {
        throw new FridayDomainError("NOT_FOUND", `Candidate not found: ${candidateId}`, { httpStatus: 404 });
      }
      return evaluateCandidate(candidate);
    },

    async evaluateAll(): Promise<FridayPromotionDecision[]> {
      const pending = store.getCandidatesByStatus("pending");
      const decisions: FridayPromotionDecision[] = [];
      for (const candidate of pending) {
        decisions.push(evaluateCandidate(candidate));
      }
      return decisions;
    },
  };

  function evaluateCandidate(candidate: FridayPlaybookCandidate): FridayPromotionDecision {
    const ruleResults = evaluateRules(candidate, promoConfig.rules);
    const allPassed = ruleResults.every((r) => r.passed);

    let outcome: FridayPromotionDecisionOutcome;
    let reason: string;

    if (allPassed) {
      outcome = "promote";
      reason = "All promotion rules passed.";
    } else {
      // Determine if failures are recoverable
      const failedRules = ruleResults.filter((r) => !r.passed);
      const hasNonRecoverable = failedRules.some(
        (r) => r.ruleId === "max-cost-ratio" || r.ruleId === "min-success-rate",
      );

      if (hasNonRecoverable && candidate.evidenceCount >= promoConfig.rules.find(
        (r) => r.metric === "evidence_count",
      )?.threshold!) {
        outcome = "reject";
        reason = `Non-recoverable promotion failure: ${failedRules.map((r) => r.ruleId).join(", ")}`;
      } else {
        outcome = "defer";
        reason = `Deferred: ${failedRules.map((r) => r.ruleId).join(", ")} not met.`;
      }
    }

    // Build score snapshot for the decision
    const scoreSnapshot = buildCandidateScoreSnapshot(candidate);

    const decision: FridayPromotionDecision = {
      id: config.generateId(),
      candidateId: candidate.id,
      decision: outcome,
      reason,
      ruleResults,
      scoreSnapshot,
      decidedAt: config.nowIso(),
    };

    store.saveDecision(decision);

    // Update candidate status based on outcome
    if (outcome === "promote") {
      const updated: FridayPlaybookCandidate = { ...candidate, status: "promoted", updatedAt: config.nowIso() };
      store.saveCandidate(updated);
    } else if (outcome === "reject") {
      const updated: FridayPlaybookCandidate = { ...candidate, status: "rejected", updatedAt: config.nowIso() };
      store.saveCandidate(updated);
    }

    return decision;
  }

  function evaluateRules(
    candidate: FridayPlaybookCandidate,
    rules: FridayPromotionRule[],
  ): FridayPromotionRuleResult[] {
    return rules
      .filter((rule) => rule.enabled)
      .map((rule) => {
        const actualValue = getMetricValue(candidate, rule.metric);
        const passed = compareMetric(actualValue, rule.operator, rule.threshold);
        return {
          ruleId: rule.id,
          passed,
          actualValue,
          threshold: rule.threshold,
        };
      });
  }

  function getMetricValue(
    candidate: FridayPlaybookCandidate,
    metric: string,
  ): number {
    switch (metric) {
      case "evidence_count":
        return candidate.evidenceCount;
      case "success_rate":
        return candidate.evidenceCount > 0 ? candidate.successCount / candidate.evidenceCount : 0;
      case "min_age_hours": {
        const ageMs =
          new Date(config.nowIso()).getTime() - new Date(candidate.firstObservedAt).getTime();
        return ageMs / (1000 * 60 * 60);
      }
      case "cost_efficiency_ratio": {
        if (candidate.evidenceCount === 0) return 0;
        const avgCost = normalizeCost({
          tokenCost: candidate.totalCost.tokenCost / candidate.evidenceCount,
          apiCallCost: candidate.totalCost.apiCallCost / candidate.evidenceCount,
          latencyMs: candidate.totalCost.latencyMs / candidate.evidenceCount,
        });
        // Ratio against a baseline of 100 (median proxy)
        return avgCost / 100;
      }
      case "failure_count":
        return candidate.failureCount;
      default:
        return 0;
    }
  }

  function compareMetric(actual: number, operator: string, threshold: number): boolean {
    switch (operator) {
      case "gte": return actual >= threshold;
      case "lte": return actual <= threshold;
      case "gt":  return actual > threshold;
      case "lt":  return actual < threshold;
      case "eq":  return actual === threshold;
      default:    return false;
    }
  }

  function buildCandidateScoreSnapshot(candidate: FridayPlaybookCandidate): FridayPlaybookScore {
    const successRate = candidate.evidenceCount > 0
      ? candidate.successCount / candidate.evidenceCount
      : 0;

    const avgDurationMs = candidate.evidenceCount > 0
      ? candidate.totalDurationMs / candidate.evidenceCount
      : 0;
    const speedScore = clamp(1 - avgDurationMs / 60_000, 0, 1);

    const avgCost = candidate.evidenceCount > 0
      ? normalizeCost({
          tokenCost: candidate.totalCost.tokenCost / candidate.evidenceCount,
          apiCallCost: candidate.totalCost.apiCallCost / candidate.evidenceCount,
          latencyMs: candidate.totalCost.latencyMs / candidate.evidenceCount,
        })
      : 0;
    const costEfficiencyScore = clamp(1 - avgCost / 1000, 0, 1);
    const satisfactionScore = successRate * 0.8;

    const weights = config.scoring.weights;
    const compositeScore = clamp(
      weights.success_rate * successRate +
      weights.speed * speedScore +
      weights.cost_efficiency * costEfficiencyScore +
      weights.satisfaction * satisfactionScore,
      0,
      1,
    );

    return {
      id: config.generateId(),
      playbookId: candidate.promotedPlaybookId ?? null,
      versionNumber: null,
      compositeScore,
      successRate,
      speedScore,
      costEfficiencyScore,
      satisfactionScore,
      sampleSize: candidate.evidenceCount,
      calculatedAt: config.nowIso(),
    };
  }
}

// ─── Shared Helpers ───

/** Normalize multi-dimensional cost into a scalar value. */
export function normalizeCost(cost: FridayPlaybookCostDimensions): number {
  return (
    cost.tokenCost * FRIDAY_PLAYBOOK_COST_NORMALIZATION_WEIGHTS.tokenCost +
    cost.apiCallCost * FRIDAY_PLAYBOOK_COST_NORMALIZATION_WEIGHTS.apiCallCost +
    cost.latencyMs * FRIDAY_PLAYBOOK_COST_NORMALIZATION_WEIGHTS.latencyMs
  );
}

/** Compute days between two ISO timestamps. */
export function computeDaysSince(from: string, to: string): number {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}

/** Clamp a number to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
