import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createPlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import {
  createPromoterJobRunner,
  validatePromotionKpis,
  DEFAULT_PROMOTION_KPI_THRESHOLDS,
} from "../../../../src/playbook/engine/index.js";

import type { PlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import type { VersionManager } from "../../../../src/playbook/engine/version-manager.js";
import type {
  FridayPlaybookCandidate,
  FridayPlaybookPromotionEngine,
  FridayPromotionDecision,
  FridayPromotionDecisionOutcome,
} from "../../../../src/playbook/model/friday-playbook.types.js";

const NOW = "2026-02-24T10:00:00.000Z";

function makeCandidate(overrides: Partial<FridayPlaybookCandidate> = {}): FridayPlaybookCandidate {
  return {
    id: "cand-1",
    fingerprint: "fp-1",
    workflowType: "workflow-a",
    tags: ["tag-a"],
    pattern: {
      nodeSequence: [{ nodeType: "extract" }],
      toolsUsed: ["tool-a"],
      parameterKeys: ["source"],
    },
    status: "pending",
    evidenceCount: 5,
    successCount: 5,
    failureCount: 0,
    totalDurationMs: 20_000,
    totalCost: { tokenCost: 300, apiCallCost: 10, latencyMs: 5_000 },
    sourceRunIds: ["run-1", "run-2", "run-3", "run-4", "run-5"],
    firstObservedAt: "2026-02-20T10:00:00.000Z",
    lastObservedAt: NOW,
    createdAt: "2026-02-20T10:00:00.000Z",
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDecision(
  candidateId: string,
  decision: FridayPromotionDecisionOutcome,
): FridayPromotionDecision {
  return {
    id: `decision-${candidateId}`,
    candidateId,
    decision,
    reason: `${decision}-reason`,
    ruleResults: [],
    scoreSnapshot: {
      id: `score-${candidateId}`,
      playbookId: null,
      versionNumber: null,
      compositeScore: 0.9,
      successRate: 1,
      speedScore: 0.9,
      costEfficiencyScore: 0.8,
      satisfactionScore: 0.8,
      sampleSize: 5,
      calculatedAt: NOW,
    },
    decidedAt: NOW,
  };
}

function makeVersionManagerMock(): VersionManager {
  return {
    createFromCandidate: vi.fn((candidate: FridayPlaybookCandidate) => ({
      playbook: {
        id: `pb-${candidate.id}`,
        name: `${candidate.workflowType}/playbook`,
        workflowType: candidate.workflowType,
        tags: candidate.tags,
        status: "active",
        activeVersionNumber: 1,
        sourceCandidateId: candidate.id,
        compositeScore: 0,
        totalUses: 0,
        totalSuccesses: 0,
        etag: "etag-1",
        createdAt: NOW,
        updatedAt: NOW,
      },
      version: {
        id: `ver-${candidate.id}`,
        playbookId: `pb-${candidate.id}`,
        versionNumber: 1,
        fingerprint: candidate.fingerprint,
        pattern: candidate.pattern,
        candidateId: candidate.id,
        createdAt: NOW,
      },
    })),
    evolve: vi.fn(() => null),
    rollback: vi.fn(() => null),
    deactivate: vi.fn(() => null),
    diff: vi.fn(() => null),
    getHistory: vi.fn(() => []),
  };
}

describe("Promoter Job Runner", () => {
  describe("validatePromotionKpis", () => {
    it("passes when KPIs satisfy reuse >35%, success lift >20%, rollback <1%", () => {
      const result = validatePromotionKpis({
        reuseHitRate: 0.36,
        successLift: 0.21,
        badPromotionRollbackRate: 0.009,
      });

      expect(result.isValid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("fails on threshold boundaries", () => {
      const result = validatePromotionKpis({
        reuseHitRate: DEFAULT_PROMOTION_KPI_THRESHOLDS.minReuseHitRate,
        successLift: DEFAULT_PROMOTION_KPI_THRESHOLDS.minSuccessLift,
        badPromotionRollbackRate: DEFAULT_PROMOTION_KPI_THRESHOLDS.maxBadPromotionRollbackRate,
      });

      expect(result.isValid).toBe(false);
      expect(result.violations).toHaveLength(3);
    });
  });

  describe("tick", () => {
    let store: PlaybookStore;
    let promotionEngine: FridayPlaybookPromotionEngine;
    let versionManager: VersionManager;

    beforeEach(() => {
      store = createPlaybookStore();
      promotionEngine = {
        evaluate: vi.fn(async (candidateId: string) => makeDecision(candidateId, "promote")),
        evaluateAll: vi.fn(async () => []),
      };
      versionManager = makeVersionManagerMock();
    });

    it("blocks tick when KPI thresholds are not met", async () => {
      store.saveCandidate(makeCandidate({ id: "cand-1" }));

      const runner = createPromoterJobRunner({
        store,
        promotionEngine,
        versionManager,
        getKpis: () => ({ reuseHitRate: 0.35, successLift: 0.25, badPromotionRollbackRate: 0.005 }),
        nowIso: () => NOW,
      });

      const result = await runner.tick({ idempotencyKey: "tick-1" });

      expect(result.status).toBe("blocked");
      expect(promotionEngine.evaluate).not.toHaveBeenCalled();
      expect(result.reason).toBe("kpi_threshold_not_met");
    });

    it("evaluates pending candidates and creates playbooks for promoted decisions", async () => {
      store.saveCandidate(makeCandidate({ id: "cand-1", status: "pending" }));

      const runner = createPromoterJobRunner({
        store,
        promotionEngine,
        versionManager,
        getKpis: () => ({ reuseHitRate: 0.5, successLift: 0.3, badPromotionRollbackRate: 0.002 }),
        nowIso: () => NOW,
      });

      const result = await runner.tick({ idempotencyKey: "tick-2" });

      expect(result.status).toBe("completed");
      expect(result.promotedDecisions).toBe(1);
      expect(result.createdPlaybooks).toBe(1);
      expect(versionManager.createFromCandidate).toHaveBeenCalledTimes(1);
    });

    it("replays cached result for the same idempotency key", async () => {
      store.saveCandidate(makeCandidate({ id: "cand-1", status: "pending" }));

      const runner = createPromoterJobRunner({
        store,
        promotionEngine,
        versionManager,
        getKpis: () => ({ reuseHitRate: 0.6, successLift: 0.4, badPromotionRollbackRate: 0.001 }),
        nowIso: () => NOW,
      });

      const first = await runner.tick({ idempotencyKey: "same-key" });
      const second = await runner.tick({ idempotencyKey: "same-key" });

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(promotionEngine.evaluate).toHaveBeenCalledTimes(1);
      expect(versionManager.createFromCandidate).toHaveBeenCalledTimes(1);
    });

    it("captures per-candidate evaluation errors and continues", async () => {
      store.saveCandidate(makeCandidate({ id: "cand-1", status: "pending" }));
      store.saveCandidate(makeCandidate({ id: "cand-2", fingerprint: "fp-2", status: "pending" }));

      vi.mocked(promotionEngine.evaluate).mockImplementation(async (candidateId: string) => {
        if (candidateId === "cand-1") {
          throw new Error("boom");
        }
        return makeDecision(candidateId, "defer");
      });

      const runner = createPromoterJobRunner({
        store,
        promotionEngine,
        versionManager,
        getKpis: () => ({ reuseHitRate: 0.7, successLift: 0.25, badPromotionRollbackRate: 0.001 }),
        nowIso: () => NOW,
      });

      const result = await runner.tick({ idempotencyKey: "tick-3" });

      expect(result.status).toBe("completed");
      expect(result.deferredDecisions).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("evaluate(cand-1) failed");
    });
  });

  describe("start", () => {
    let store: PlaybookStore;
    let promotionEngine: FridayPlaybookPromotionEngine;
    let versionManager: VersionManager;

    beforeEach(() => {
      vi.useFakeTimers();
      store = createPlaybookStore();
      promotionEngine = {
        evaluate: vi.fn(async (candidateId: string) => makeDecision(candidateId, "promote")),
        evaluateAll: vi.fn(async () => []),
      };
      versionManager = makeVersionManagerMock();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("starts and stops interval ticks", async () => {
      const getKpis = vi.fn(() => ({
        reuseHitRate: 0.5,
        successLift: 0.3,
        badPromotionRollbackRate: 0.001,
      }));

      const runner = createPromoterJobRunner({
        store,
        promotionEngine,
        versionManager,
        getKpis,
        nowIso: () => NOW,
      });

      const control = runner.start(1_000);
      expect(control.isRunning()).toBe(true);

      await vi.advanceTimersByTimeAsync(2_500);
      expect(getKpis).toHaveBeenCalledTimes(2);

      control.stop();
      expect(control.isRunning()).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(getKpis).toHaveBeenCalledTimes(2);
    });
  });
});
