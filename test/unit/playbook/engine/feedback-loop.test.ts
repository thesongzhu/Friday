import { describe, it, expect, beforeEach } from "vitest";
import { createPlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import {
  createScoreCalculator,
  createPromotionEngine,
  normalizeCost,
  computeDaysSince,
  clamp,
} from "../../../../src/playbook/engine/feedback-loop.js";
import type { PlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import type {
  FridayPlaybook,
  FridayPlaybookCandidate,
  FridayPlaybookScoreCalculator,
  FridayPlaybookPromotionEngine,
  FridayPlaybookEngineConfig,
} from "../../../../src/playbook/model/friday-playbook.types.js";
import {
  FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS,
  FRIDAY_DEFAULT_PROMOTION_RULES,
  FRIDAY_PLAYBOOK_TIE_BREAK_ORDER,
} from "../../../../src/playbook/model/friday-playbook.types.js";

// ─── Helpers ───

const NOW = "2026-02-24T10:00:00.000Z";
let idCounter = 0;

function makeConfig(overrides: Partial<FridayPlaybookEngineConfig> = {}): FridayPlaybookEngineConfig {
  idCounter = 0;
  return {
    scoring: {
      weights: { ...FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS },
      decayRate: 0.02,
      autoArchiveDays: 90,
      minSampleSize: 5,
    },
    selection: {
      matchThreshold: 0.6,
      similarityWeight: 0.6,
      scoreWeight: 0.4,
      minTagOverlap: 0.5,
      maxCandidates: 50,
      tieBreakOrder: [...FRIDAY_PLAYBOOK_TIE_BREAK_ORDER],
    },
    promotion: {
      rules: [...FRIDAY_DEFAULT_PROMOTION_RULES],
      evaluationIntervalHours: 6,
      rollbackConsecutiveWindows: 3,
      rollbackSuccessRateThreshold: 0.5,
    },
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
    ...overrides,
  };
}

function makePlaybook(overrides: Partial<FridayPlaybook> = {}): FridayPlaybook {
  return {
    id: "pb-1",
    name: "test-playbook",
    workflowType: "data-pipeline",
    tags: ["etl"],
    status: "active",
    activeVersionNumber: 1,
    sourceCandidateId: "cand-1",
    compositeScore: 0,
    totalUses: 10,
    totalSuccesses: 9,
    lastUsedAt: NOW,
    lastSuccessfulAt: NOW,
    etag: "etag-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<FridayPlaybookCandidate> = {}): FridayPlaybookCandidate {
  return {
    id: "cand-1",
    fingerprint: "abc123",
    workflowType: "data-pipeline",
    tags: ["etl"],
    pattern: { nodeSequence: [] },
    status: "pending",
    evidenceCount: 10,
    successCount: 9,
    failureCount: 1,
    totalDurationMs: 50_000,
    totalCost: { tokenCost: 1000, apiCallCost: 50, latencyMs: 30_000 },
    sourceRunIds: Array.from({ length: 10 }, (_, i) => `run-${i + 1}`),
    firstObservedAt: "2026-02-20T10:00:00.000Z",
    lastObservedAt: NOW,
    createdAt: "2026-02-20T10:00:00.000Z",
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── Tests ───

describe("Feedback Loop", () => {
  describe("normalizeCost", () => {
    it("weights cost dimensions correctly", () => {
      const cost = { tokenCost: 100, apiCallCost: 10, latencyMs: 500 };
      // 100 * 0.50 + 10 * 0.30 + 500 * 0.20 = 50 + 3 + 100 = 153
      expect(normalizeCost(cost)).toBeCloseTo(153, 5);
    });

    it("returns 0 for zero costs", () => {
      expect(normalizeCost({ tokenCost: 0, apiCallCost: 0, latencyMs: 0 })).toBe(0);
    });
  });

  describe("computeDaysSince", () => {
    it("computes correct day difference", () => {
      const from = "2026-02-20T10:00:00.000Z";
      const to = "2026-02-24T10:00:00.000Z";
      expect(computeDaysSince(from, to)).toBeCloseTo(4.0, 5);
    });

    it("returns 0 for future-to-past", () => {
      expect(computeDaysSince(NOW, "2026-02-20T10:00:00.000Z")).toBe(0);
    });
  });

  describe("clamp", () => {
    it("clamps below min", () => expect(clamp(-0.5, 0, 1)).toBe(0));
    it("clamps above max", () => expect(clamp(1.5, 0, 1)).toBe(1));
    it("passes through in range", () => expect(clamp(0.5, 0, 1)).toBe(0.5));
  });

  describe("Score Calculator", () => {
    let store: PlaybookStore;
    let calculator: FridayPlaybookScoreCalculator;

    beforeEach(() => {
      store = createPlaybookStore();
      const config = makeConfig();
      calculator = createScoreCalculator({ store, config });
    });

    it("calculates and persists a score for a playbook", async () => {
      store.savePlaybook(makePlaybook());
      store.saveCandidate(makeCandidate());

      const score = await calculator.recalculate("pb-1");

      expect(score.playbookId).toBe("pb-1");
      expect(score.compositeScore).toBeGreaterThan(0);
      expect(score.compositeScore).toBeLessThanOrEqual(1);
      expect(score.successRate).toBeCloseTo(0.9, 5);
      expect(score.sampleSize).toBeGreaterThanOrEqual(1);

      // Verify persisted
      const stored = store.getLatestScore("pb-1");
      expect(stored).toEqual(score);
    });

    it("updates playbook compositeScore cache", async () => {
      store.savePlaybook(makePlaybook({ compositeScore: 0 }));
      store.saveCandidate(makeCandidate());

      await calculator.recalculate("pb-1");

      const updated = store.getPlaybook("pb-1");
      expect(updated!.compositeScore).toBeGreaterThan(0);
    });

    it("throws for non-existent playbook", async () => {
      await expect(calculator.recalculate("nonexistent")).rejects.toThrow("Playbook not found");
    });

    it("recalculates all active playbooks", async () => {
      store.savePlaybook(makePlaybook({ id: "pb-1", sourceCandidateId: "c1" }));
      store.savePlaybook(makePlaybook({ id: "pb-2", sourceCandidateId: "c2" }));
      store.savePlaybook(makePlaybook({ id: "pb-3", status: "archived", sourceCandidateId: "c3" }));
      store.saveCandidate(makeCandidate({ id: "c1", fingerprint: "f1" }));
      store.saveCandidate(makeCandidate({ id: "c2", fingerprint: "f2" }));

      const scores = await calculator.recalculateAll();
      expect(scores).toHaveLength(2); // only active playbooks
    });

    it("applies decay for stale playbooks", async () => {
      // Playbook last used 30 days ago.
      const oldDate = "2026-01-25T10:00:00.000Z";
      store.savePlaybook(makePlaybook({ lastUsedAt: oldDate, updatedAt: NOW }));
      store.saveCandidate(makeCandidate());

      const score = await calculator.recalculate("pb-1");

      // Decayed score should be lower than raw score
      // Raw score with 90% success rate should be > 0.5
      // After ~30 days of decay (λ=0.02), factor ≈ e^(-0.6) ≈ 0.55
      expect(score.compositeScore).toBeLessThan(0.6);
    });

    it("does not treat updatedAt as last-use recency", async () => {
      store.savePlaybook(
        makePlaybook({
          lastUsedAt: NOW,
          updatedAt: "2026-01-25T10:00:00.000Z",
        }),
      );
      store.saveCandidate(makeCandidate());

      const score = await calculator.recalculate("pb-1");
      expect(score.compositeScore).toBeGreaterThan(0.7);
    });
  });

  describe("Promotion Engine", () => {
    let store: PlaybookStore;
    let engine: FridayPlaybookPromotionEngine;

    beforeEach(() => {
      store = createPlaybookStore();
      const config = makeConfig();
      engine = createPromotionEngine({ store, config });
    });

    it("promotes a candidate that meets all criteria", async () => {
      store.saveCandidate(
        makeCandidate({
          evidenceCount: 10,
          successCount: 10,
          failureCount: 0,
          totalCost: { tokenCost: 50, apiCallCost: 2, latencyMs: 1000 },
        }),
      );

      const decision = await engine.evaluate("cand-1");

      expect(decision.decision).toBe("promote");
      expect(decision.reason).toContain("All promotion rules passed");
      expect(decision.ruleResults.every((r) => r.passed)).toBe(true);
    });

    it("defers a candidate with insufficient evidence", async () => {
      store.saveCandidate(
        makeCandidate({
          evidenceCount: 2,
          successCount: 2,
          failureCount: 0,
        }),
      );

      const decision = await engine.evaluate("cand-1");

      expect(decision.decision).toBe("defer");
      expect(decision.ruleResults.some((r) => r.ruleId === "min-evidence" && !r.passed)).toBe(true);
    });

    it("rejects a candidate with low success rate and enough evidence", async () => {
      store.saveCandidate(
        makeCandidate({
          evidenceCount: 10,
          successCount: 5,
          failureCount: 5,
        }),
      );

      const decision = await engine.evaluate("cand-1");

      expect(decision.decision).toBe("reject");
    });

    it("updates candidate status on promotion", async () => {
      store.saveCandidate(
        makeCandidate({
          evidenceCount: 10,
          successCount: 10,
          totalCost: { tokenCost: 50, apiCallCost: 2, latencyMs: 1000 },
        }),
      );

      await engine.evaluate("cand-1");

      const updated = store.getCandidate("cand-1");
      expect(updated!.status).toBe("promoted");
    });

    it("updates candidate status on rejection", async () => {
      store.saveCandidate(
        makeCandidate({
          evidenceCount: 10,
          successCount: 5,
        }),
      );

      await engine.evaluate("cand-1");

      const updated = store.getCandidate("cand-1");
      expect(updated!.status).toBe("rejected");
    });

    it("persists promotion decisions", async () => {
      store.saveCandidate(makeCandidate());

      const decision = await engine.evaluate("cand-1");
      const stored = store.getDecision(decision.id);
      expect(stored).toEqual(decision);
    });

    it("throws for non-existent candidate", async () => {
      await expect(engine.evaluate("nonexistent")).rejects.toThrow("Candidate not found");
    });

    it("evaluates all pending candidates", async () => {
      store.saveCandidate(makeCandidate({ id: "c1", fingerprint: "f1", status: "pending" }));
      store.saveCandidate(makeCandidate({ id: "c2", fingerprint: "f2", status: "pending" }));
      store.saveCandidate(makeCandidate({ id: "c3", fingerprint: "f3", status: "observed" }));

      const decisions = await engine.evaluateAll();
      expect(decisions).toHaveLength(2);
    });

    it("includes score snapshot in decision", async () => {
      store.saveCandidate(makeCandidate());

      const decision = await engine.evaluate("cand-1");

      expect(decision.scoreSnapshot).toBeDefined();
      expect(decision.scoreSnapshot.successRate).toBeCloseTo(0.9, 1);
      expect(decision.scoreSnapshot.compositeScore).toBeGreaterThan(0);
    });

    it("uses nullable score snapshot identity fields for unpromoted candidates", async () => {
      store.saveCandidate(makeCandidate({ promotedPlaybookId: undefined }));
      const decision = await engine.evaluate("cand-1");

      expect(decision.scoreSnapshot.playbookId).toBeNull();
      expect(decision.scoreSnapshot.versionNumber).toBeNull();
    });
  });
});
