import type { FridaySqliteLayer } from "#state";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { FridayErrorIncidentEntity } from "../model/friday-learning.types.js";
import type {
  FridayAutoFixPlan,
  FridayAutoFixRiskTier,
  FridayAutoFixStepKind,
  FridayRiskAssessment,
} from "../model/friday-auto-fix.types.js";
import {
  FridayAdaptiveUtilityStrategy,
  type FridayUtilityInput,
  type FridayUtilityStrategy,
} from "./friday-expected-utility-calculator.js";

export interface FridayAutoFixRiskAssessmentService {
  assess(input: {
    incident: FridayErrorIncidentEntity;
    plan: FridayAutoFixPlan;
    nowIso: string;
    /** Diagnosis confidence (0..1). When provided, enables expected utility calculation. */
    confidence?: number;
  }): FridayRiskAssessment;
}

export interface CreateAutoFixRiskAssessmentServiceDeps {
  db: FridaySqliteLayer;
  actionRepo: FridayAutoFixActionRepository;
  /** Pluggable utility strategy. Defaults to FridayHeuristicUtilityStrategy. */
  utilityStrategy?: FridayUtilityStrategy;
}

/** Steps that are stateless / safe to auto-apply. */
const TIER_0_STEPS: Set<FridayAutoFixStepKind> = new Set([
  "retry_node",
  "switch_model_fallback",
  "trim_payload",
]);

/** Steps that require a rollback plan but can auto-apply. */
const TIER_1_STEPS: Set<FridayAutoFixStepKind> = new Set([
  "apply_config_patch",
  "grant_permission",
]);

/** Steps that always require approval. */
const TIER_2_STEPS: Set<FridayAutoFixStepKind> = new Set([
  "disable_skill",
  "pause_workflow",
]);

export function createFridayAutoFixRiskAssessmentService(
  deps: CreateAutoFixRiskAssessmentServiceDeps,
): FridayAutoFixRiskAssessmentService {
  const strategy = deps.utilityStrategy ?? new FridayAdaptiveUtilityStrategy();

  return {
    assess(input) {
      const { incident, plan, nowIso } = input;
      const reasons: string[] = [];

      // Determine base tier from step kinds
      let baseTier: FridayAutoFixRiskTier = 0;
      for (const step of plan.steps) {
        if (TIER_2_STEPS.has(step.kind)) {
          baseTier = 2;
          reasons.push(`Step '${step.kind}' requires approval`);
        } else if (TIER_1_STEPS.has(step.kind) && baseTier < 1) {
          baseTier = 1;
          reasons.push(`Step '${step.kind}' requires rollback plan`);
        }
      }

      let riskTier = baseTier;

      // Escalation: high severity bumps to Tier 2
      if (incident.severity === "high") {
        riskTier = 2;
        reasons.push("High severity incident escalates to Tier 2");
      }

      // Escalation: rolling 24h rollback rate > 30% (from executed actions only)
      if (riskTier < 2) {
        const counts24h = deps.db.withReadConnection((db) =>
          deps.actionRepo.countRolling24h(db, nowIso),
        );
        if (counts24h.executed > 0) {
          const rollbackRate = counts24h.rolledBack / counts24h.executed;
          if (rollbackRate > 0.3) {
            riskTier = 2;
            reasons.push(
              `24h rollback rate ${(rollbackRate * 100).toFixed(0)}% > 30% disables auto-apply`,
            );
          }
        }
      }

      // Escalation: 1h error spike > 3x baseline disables Tier 0/1 auto-apply
      if (riskTier < 2) {
        const counts1h = deps.db.withReadConnection((db) =>
          deps.actionRepo.countRolling1h(db, nowIso),
        );
        const counts24h = deps.db.withReadConnection((db) =>
          deps.actionRepo.countRolling24h(db, nowIso),
        );
        // Baseline = 24h rolled back / 24 (hourly average)
        const baseline24h = counts24h.executed > 0
          ? counts24h.rolledBack / 24
          : 0;
        if (baseline24h > 0 && counts1h.rolledBack > 3 * baseline24h) {
          riskTier = 2;
          reasons.push(
            `1h error spike (${counts1h.rolledBack} rollbacks) > 3x baseline (${baseline24h.toFixed(1)}/h) disables auto-apply`,
          );
        }
      }

      const recentActionSummary = deps.db.withReadConnection((db) =>
        deps.actionRepo.summarizeByFingerprint(db, {
          userId: incident.userId,
          fingerprint: incident.signature,
          limit: 200,
        }),
      );

      const sampleCount = recentActionSummary.sampleCount;
      const successCount = recentActionSummary.successCount;
      const rollbackCount = recentActionSummary.rollbackCount;
      const rejectedCount = recentActionSummary.rejectedCount;
      const historySuccessRate = sampleCount > 0 ? successCount / sampleCount : undefined;
      const routeFailureRate = sampleCount > 0 ? (rollbackCount + rejectedCount) / sampleCount : undefined;
      const rollbackFrequency =
        recentActionSummary.executedCount > 0
          ? rollbackCount / recentActionSummary.executedCount
          : undefined;
      const humanRejectionRate = sampleCount > 0 ? rejectedCount / sampleCount : undefined;

      let policyBudgetState: FridayUtilityInput["policyBudgetState"] = "open";
      if (rollbackCount >= 2 || (rollbackFrequency ?? 0) >= 0.5) {
        policyBudgetState = "capped";
        reasons.push("Recent rollback history caps auto-apply for this fingerprint");
      }
      if (rollbackCount >= 3 || rejectedCount >= 2) {
        policyBudgetState = "cooldown";
        reasons.push("Recent rollback/rejection history places this fingerprint into cooldown");
      }

      if (baseTier === 0 && riskTier === 0) {
        reasons.push("Stateless remediation — safe to auto-apply");
      }

      // Compute expected utility when confidence is available
      const confidence = input.confidence;
      let utilityResult: FridayRiskAssessment["utilityResult"];
      if (confidence !== undefined) {
        const recurrence = plan.evidence.recurrenceCount;
        const utilityInput: FridayUtilityInput = {
          riskTier,
          confidence,
          predictedSuccessProb: confidence,
          estimatedBenefitScore: Math.min(1, Math.log2(1 + recurrence) / 5),
          estimatedCostScore: riskTier / 2,
          historicalSuccessRate: historySuccessRate,
          routeFailureRate,
          lessonMatchCount: plan.evidence.matchedLessonIds.length,
          patternStrength:
            typeof incident.context.patternStrength === "number"
              ? Math.max(0, Math.min(1, incident.context.patternStrength))
              : undefined,
          rollbackFrequency,
          humanRejectionRate,
          policyBudgetState,
        };
        utilityResult = strategy.compute(utilityInput);
      }

      const requiresApproval = riskTier === 2;
      const autoApplyAllowed = riskTier < 2
        && policyBudgetState === "open"
        && (utilityResult?.recommendation ?? "auto_apply") === "auto_apply";

      return {
        riskTier,
        reasons,
        requiresApproval,
        autoApplyAllowed,
        utilityResult,
      };
    },
  };
}
