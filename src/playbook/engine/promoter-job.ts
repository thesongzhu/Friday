/**
 * Promoter Job Runner — orchestrates periodic candidate promotion.
 *
 * Runs promotion evaluations on pending candidates, gates promotion on KPI
 * thresholds, and applies version-manager actions for promoted candidates.
 *
 * @module playbook/engine
 */

import { FridayDomainError } from "#errors";
import type {
  FridayPlaybookCandidate,
  FridayPlaybookPromotionEngine,
  FridayPromotionDecision,
} from "../model/friday-playbook.types.js";

import type { PlaybookStore } from "./playbook-store.js";
import type { VersionManager } from "./version-manager.js";

/** KPI snapshot used to gate promotion runs. */
export interface PromotionKpiSnapshot {
  reuseHitRate: number;
  successLift: number;
  badPromotionRollbackRate: number;
}

/** KPI thresholds that must be satisfied before promotions run. */
export interface PromotionKpiThresholds {
  minReuseHitRate: number;
  minSuccessLift: number;
  maxBadPromotionRollbackRate: number;
}

/** Default production KPI thresholds for safe promotion. */
export const DEFAULT_PROMOTION_KPI_THRESHOLDS: Readonly<PromotionKpiThresholds> = {
  minReuseHitRate: 0.35,
  minSuccessLift: 0.20,
  maxBadPromotionRollbackRate: 0.01,
} as const;

/** Result of validating KPI thresholds. */
export interface PromotionKpiValidation {
  isValid: boolean;
  violations: string[];
}

/** Validate promotion KPIs against configured thresholds. */
export function validatePromotionKpis(
  kpis: PromotionKpiSnapshot,
  thresholds: PromotionKpiThresholds = DEFAULT_PROMOTION_KPI_THRESHOLDS,
): PromotionKpiValidation {
  const violations: string[] = [];

  if (!(kpis.reuseHitRate > thresholds.minReuseHitRate)) {
    violations.push(
      `reuseHitRate ${kpis.reuseHitRate.toFixed(4)} must be > ${thresholds.minReuseHitRate.toFixed(4)}`,
    );
  }

  if (!(kpis.successLift > thresholds.minSuccessLift)) {
    violations.push(
      `successLift ${kpis.successLift.toFixed(4)} must be > ${thresholds.minSuccessLift.toFixed(4)}`,
    );
  }

  if (!(kpis.badPromotionRollbackRate < thresholds.maxBadPromotionRollbackRate)) {
    violations.push(
      `badPromotionRollbackRate ${kpis.badPromotionRollbackRate.toFixed(4)} must be < ${thresholds.maxBadPromotionRollbackRate.toFixed(4)}`,
    );
  }

  return {
    isValid: violations.length === 0,
    violations,
  };
}

/** Dependencies required for promoter job orchestration. */
export interface PromoterJobRunnerDeps {
  store: PlaybookStore;
  promotionEngine: FridayPlaybookPromotionEngine;
  versionManager: VersionManager;
  getKpis: () => PromotionKpiSnapshot | Promise<PromotionKpiSnapshot>;
  nowIso: () => string;
  kpiThresholds?: PromotionKpiThresholds;
  onError?: (error: unknown) => void | Promise<void>;
}

/** Tick options for idempotent promoter runs. */
export interface PromoterJobTickOptions {
  idempotencyKey?: string;
}

/** Output from a single promoter job tick. */
export interface PromoterJobTickResult {
  status: "completed" | "blocked" | "skipped";
  reason?: string;
  replayed: boolean;
  idempotencyKey?: string;
  kpis: PromotionKpiSnapshot;
  kpiValidation: PromotionKpiValidation;
  processedCandidates: number;
  promotedDecisions: number;
  rejectedDecisions: number;
  deferredDecisions: number;
  createdPlaybooks: number;
  evolvedPlaybooks: number;
  errors: string[];
}

/** Interval-based promoter runner with explicit tick control. */
export interface PromoterJobRunner {
  tick(options?: PromoterJobTickOptions): Promise<PromoterJobTickResult>;
  start(intervalMs: number): { stop: () => void; isRunning: () => boolean };
}

/** Create a promoter job runner. */
export function createPromoterJobRunner(deps: PromoterJobRunnerDeps): PromoterJobRunner {
  const {
    store,
    promotionEngine,
    versionManager,
    getKpis,
    nowIso,
    onError,
    kpiThresholds = DEFAULT_PROMOTION_KPI_THRESHOLDS,
  } = deps;

  const idempotencyCache = new Map<string, PromoterJobTickResult>();
  let inFlight = false;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let intervalTickCounter = 0;

  return {
    async tick(options: PromoterJobTickOptions = {}): Promise<PromoterJobTickResult> {
      const { idempotencyKey } = options;

      if (idempotencyKey) {
        const cached = idempotencyCache.get(idempotencyKey);
        if (cached) {
          return {
            ...cached,
            replayed: true,
          };
        }
      }

      if (inFlight) {
        const skipped = createEmptyResult({
          status: "skipped",
          reason: "tick_in_progress",
          idempotencyKey,
          replayed: false,
          kpis: { reuseHitRate: 0, successLift: 0, badPromotionRollbackRate: 1 },
          kpiValidation: {
            isValid: false,
            violations: ["tick already in progress"],
          },
        });

        if (idempotencyKey) {
          idempotencyCache.set(idempotencyKey, skipped);
        }

        return skipped;
      }

      inFlight = true;
      try {
        const kpis = await getKpis();
        const kpiValidation = validatePromotionKpis(kpis, kpiThresholds);

        if (!kpiValidation.isValid) {
          const blocked = createEmptyResult({
            status: "blocked",
            reason: "kpi_threshold_not_met",
            idempotencyKey,
            replayed: false,
            kpis,
            kpiValidation,
          });

          if (idempotencyKey) {
            idempotencyCache.set(idempotencyKey, blocked);
          }

          return blocked;
        }

        const pendingCandidates = store.getCandidatesByStatus("pending");
        let processedCandidates = 0;
        let promotedDecisions = 0;
        let rejectedDecisions = 0;
        let deferredDecisions = 0;
        let createdPlaybooks = 0;
        let evolvedPlaybooks = 0;
        const errors: string[] = [];

        for (const pendingCandidate of pendingCandidates) {
          let decision: FridayPromotionDecision;

          try {
            decision = await promotionEngine.evaluate(pendingCandidate.id);
          } catch (error) {
            errors.push(`evaluate(${pendingCandidate.id}) failed: ${toErrorMessage(error)}`);
            continue;
          }

          processedCandidates += 1;

          if (decision.decision === "promote") {
            promotedDecisions += 1;
            const candidate = store.getCandidate(decision.candidateId);
            if (!candidate) {
              errors.push(`candidate ${decision.candidateId} disappeared before promotion action`);
              continue;
            }

            try {
              const action = applyPromotion(candidate);
              if (action === "created") {
                createdPlaybooks += 1;
              } else {
                evolvedPlaybooks += 1;
              }
            } catch (error) {
              errors.push(`promotion action for ${candidate.id} failed: ${toErrorMessage(error)}`);
            }
            continue;
          }

          if (decision.decision === "reject") {
            rejectedDecisions += 1;
            continue;
          }

          deferredDecisions += 1;
        }

        const completed: PromoterJobTickResult = {
          status: "completed",
          replayed: false,
          idempotencyKey,
          kpis,
          kpiValidation,
          processedCandidates,
          promotedDecisions,
          rejectedDecisions,
          deferredDecisions,
          createdPlaybooks,
          evolvedPlaybooks,
          errors,
        };

        if (idempotencyKey) {
          idempotencyCache.set(idempotencyKey, completed);
        }

        return completed;
      } catch (error) {
        const failed = createEmptyResult({
          status: "skipped",
          reason: "tick_error",
          idempotencyKey,
          replayed: false,
          kpis: { reuseHitRate: 0, successLift: 0, badPromotionRollbackRate: 1 },
          kpiValidation: {
            isValid: false,
            violations: [toErrorMessage(error)],
          },
          errors: [toErrorMessage(error)],
        });

        if (idempotencyKey) {
          idempotencyCache.set(idempotencyKey, failed);
        }

        await onError?.(error);
        return failed;
      } finally {
        inFlight = false;
      }
    },

    start(intervalMs: number) {
      if (intervalMs <= 0) {
        throw new FridayDomainError("VALIDATION_ERROR", "intervalMs must be > 0", { httpStatus: 400 });
      }

      if (intervalHandle !== null) {
        return {
          stop,
          isRunning,
        };
      }

      intervalHandle = setInterval(() => {
        const idempotencyKey = `interval:${nowIso()}:${++intervalTickCounter}`;
        void this.tick({ idempotencyKey }).catch(async (error) => {
          await onError?.(error);
        });
      }, intervalMs);
      if (typeof intervalHandle.unref === "function") {
        intervalHandle.unref();
      }

      return {
        stop,
        isRunning,
      };
    },
  };

  function stop(): void {
    if (intervalHandle === null) {
      return;
    }
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  function isRunning(): boolean {
    return intervalHandle !== null;
  }

  function applyPromotion(candidate: FridayPlaybookCandidate): "created" | "evolved" {
    if (candidate.promotedPlaybookId) {
      const version = versionManager.evolve(
        candidate.promotedPlaybookId,
        candidate,
        `Promoter job evolve at ${nowIso()}`,
      );
      if (version) {
        return "evolved";
      }
    }

    versionManager.createFromCandidate(candidate);
    return "created";
  }
}

function createEmptyResult(overrides: {
  status: "blocked" | "skipped";
  reason: string;
  idempotencyKey?: string;
  replayed: boolean;
  kpis: PromotionKpiSnapshot;
  kpiValidation: PromotionKpiValidation;
  errors?: string[];
}): PromoterJobTickResult {
  return {
    status: overrides.status,
    reason: overrides.reason,
    replayed: overrides.replayed,
    idempotencyKey: overrides.idempotencyKey,
    kpis: overrides.kpis,
    kpiValidation: overrides.kpiValidation,
    processedCandidates: 0,
    promotedDecisions: 0,
    rejectedDecisions: 0,
    deferredDecisions: 0,
    createdPlaybooks: 0,
    evolvedPlaybooks: 0,
    errors: overrides.errors ?? [],
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown_error";
}
