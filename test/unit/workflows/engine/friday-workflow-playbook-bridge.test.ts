/**
 * A-006 Workflow Playbook Bridge Tests
 *
 * Validates playbook selection on intake, feedback recording on completion,
 * score recalculation, promotion evaluation, and trace emission.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWorkflowPlaybookBridge,
  type PlaybookBridgeTrace,
  type WorkflowPlaybookBridgeDeps,
} from "../../../../src/workflows/engine/friday-workflow-playbook-bridge.js";
import type {
  FridayPlaybookMatch,
  FridayPlaybookCandidate,
  FridayPlaybookRunCompletionEvent,
  FridayPlaybookScore,
  FridayPromotionDecision,
} from "../../../../src/playbook/model/friday-playbook.types.js";

// ─── Helpers ───

function makeMatch(overrides: Partial<FridayPlaybookMatch> = {}): FridayPlaybookMatch {
  return {
    id: "match-1",
    runId: "run-1",
    workflowId: "wf-1",
    playbookId: "pb-1",
    versionNumber: 1,
    matchScore: 0.85,
    similarity: 0.90,
    reason: "matched",
    context: {
      workflowType: "data-pipeline",
      workflowId: "wf-1",
      runId: "run-1",
      nodeSequence: [{ nodeType: "action" }],
      tags: ["etl"],
    },
    selectedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<FridayPlaybookCandidate> = {}): FridayPlaybookCandidate {
  return {
    id: "cand-1",
    fingerprint: "sha256-abc",
    workflowType: "data-pipeline",
    tags: ["etl"],
    pattern: { nodes: [{ nodeType: "action" }] },
    status: "pending",
    evidenceCount: 3,
    successCount: 3,
    failureCount: 0,
    totalDurationMs: 5000,
    totalCost: { tokenCost: 100, apiCallCost: 5, latencyMs: 5000 },
    sourceRunIds: ["run-1", "run-2", "run-3"],
    firstObservedAt: "2026-01-01T00:00:00Z",
    lastObservedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCompletionEvent(overrides: Partial<FridayPlaybookRunCompletionEvent> = {}): FridayPlaybookRunCompletionEvent {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    workflowType: "data-pipeline",
    tags: ["etl"],
    nodeSequence: [{ nodeType: "action" }],
    toolsUsed: ["file-reader"],
    parameterKeys: ["inputPath"],
    durationMs: 2000,
    cost: { tokenCost: 50, apiCallCost: 2, latencyMs: 2000 },
    success: true,
    completedAt: "2026-01-01T00:01:00Z",
    ...overrides,
  };
}

function makeScore(overrides: Partial<FridayPlaybookScore> = {}): FridayPlaybookScore {
  return {
    id: "score-1",
    playbookId: "pb-1",
    versionNumber: 1,
    compositeScore: 0.82,
    successRate: 0.95,
    speedScore: 0.70,
    costEfficiencyScore: 0.80,
    satisfactionScore: 0.76,
    sampleSize: 10,
    calculatedAt: "2026-01-01T00:01:00Z",
    ...overrides,
  };
}

function makePromotionDecision(overrides: Partial<FridayPromotionDecision> = {}): FridayPromotionDecision {
  return {
    id: "dec-1",
    candidateId: "cand-1",
    decision: "promote",
    reason: "All promotion rules passed",
    ruleResults: [
      { ruleId: "min-evidence", passed: true, actualValue: 5, threshold: 5 },
      { ruleId: "min-success-rate", passed: true, actualValue: 0.95, threshold: 0.90 },
    ],
    scoreSnapshot: makeScore(),
    decidedAt: "2026-01-01T00:01:00Z",
    ...overrides,
  };
}

function makeBridge(overrides: Partial<WorkflowPlaybookBridgeDeps> = {}) {
  const selector = { select: vi.fn().mockResolvedValue(makeMatch()) };
  const learner = { processCompletedRun: vi.fn().mockResolvedValue(makeCandidate()) };
  const scoreCalculator = { recalculate: vi.fn().mockResolvedValue(makeScore()), recalculateAll: vi.fn() };
  const promotionEngine = { evaluate: vi.fn().mockResolvedValue(makePromotionDecision()), evaluateAll: vi.fn() };
  const onTrace = vi.fn();

  const bridge = createWorkflowPlaybookBridge({
    selector,
    learner,
    scoreCalculator,
    promotionEngine,
    onTrace,
    nowIso: () => "2026-01-01T00:00:00Z",
    ...overrides,
  });

  return { bridge, selector, learner, scoreCalculator, promotionEngine, onTrace };
}

// ─── Tests ───

describe("A-006 FridayWorkflowPlaybookBridge", () => {
  describe("intake selection", () => {
    it("selects matching playbook on intake", async () => {
      const { bridge, selector } = makeBridge();

      const result = await bridge.selectOnIntake({
        runId: "run-1", workflowId: "wf-1",
        workflowType: "data-pipeline",
        tags: ["etl"],
        nodeSequence: [{ nodeType: "action" }],
      });

      expect(selector.select).toHaveBeenCalledOnce();
      expect(result.decision).toBe("matched");
      expect(result.playbookId).toBe("pb-1");
      expect(result.versionNumber).toBe(1);
      expect(result.matchScore).toBe(0.85);
    });

    it("passes correct selector context", async () => {
      const { bridge, selector } = makeBridge();

      await bridge.selectOnIntake({
        runId: "run-42", workflowId: "wf-7",
        workflowType: "report-gen",
        tags: ["weekly", "analytics"],
        nodeSequence: [{ nodeType: "ai", adapterType: "claude" }],
        metadata: { env: "staging" },
      });

      const ctx = selector.select.mock.calls[0][0];
      expect(ctx.workflowType).toBe("report-gen");
      expect(ctx.runId).toBe("run-42");
      expect(ctx.workflowId).toBe("wf-7");
      expect(ctx.tags).toEqual(["weekly", "analytics"]);
      expect(ctx.nodeSequence).toEqual([{ nodeType: "ai", adapterType: "claude" }]);
    });

    it("returns no_match when no playbooks match", async () => {
      const { bridge } = makeBridge({
        selector: {
          select: vi.fn().mockResolvedValue(makeMatch({
            reason: "no_match",
            playbookId: null,
            versionNumber: null,
            matchScore: null,
            similarity: null,
          })),
        },
      });

      const result = await bridge.selectOnIntake({
        runId: "run-1", workflowId: "wf-1",
        workflowType: "unknown-type",
        tags: [],
        nodeSequence: [],
      });

      expect(result.decision).toBe("no_match");
      expect(result.playbookId).toBeNull();
    });

    it("returns below_threshold when score too low", async () => {
      const { bridge } = makeBridge({
        selector: {
          select: vi.fn().mockResolvedValue(makeMatch({
            reason: "below_threshold",
            playbookId: null,
            versionNumber: null,
            matchScore: 0.45,
          })),
        },
      });

      const result = await bridge.selectOnIntake({
        runId: "run-1", workflowId: "wf-1",
        workflowType: "data-pipeline",
        tags: ["etl"],
        nodeSequence: [{ nodeType: "action" }],
      });

      expect(result.decision).toBe("below_threshold");
    });

    it("skips selection when disabled", async () => {
      const { bridge, selector } = makeBridge({ enabled: false });

      const result = await bridge.selectOnIntake({
        runId: "run-1", workflowId: "wf-1",
        workflowType: "data-pipeline",
        tags: [],
        nodeSequence: [],
      });

      expect(selector.select).not.toHaveBeenCalled();
      expect(result.decision).toBe("skipped");
    });
  });

  describe("feedback recording", () => {
    it("records run completion via learning engine", async () => {
      const { bridge, learner } = makeBridge();
      const event = makeCompletionEvent();

      const result = await bridge.recordFeedback(event);

      expect(learner.processCompletedRun).toHaveBeenCalledOnce();
      expect(learner.processCompletedRun).toHaveBeenCalledWith(event);
      expect(result.candidate).toBeDefined();
      expect(result.candidate!.id).toBe("cand-1");
    });

    it("recalculates score for promoted candidate's playbook", async () => {
      const { bridge, scoreCalculator } = makeBridge({
        learner: {
          processCompletedRun: vi.fn().mockResolvedValue(
            makeCandidate({ status: "promoted", promotedPlaybookId: "pb-1" }),
          ),
        },
      });

      const result = await bridge.recordFeedback(makeCompletionEvent());

      expect(scoreCalculator.recalculate).toHaveBeenCalledWith("pb-1");
      expect(result.scoreRecalculated).toBe(true);
      expect(result.updatedScore).toBeDefined();
    });

    it("evaluates promotion for pending candidates", async () => {
      const { bridge, promotionEngine } = makeBridge({
        learner: {
          processCompletedRun: vi.fn().mockResolvedValue(
            makeCandidate({ status: "pending" }),
          ),
        },
      });

      const result = await bridge.recordFeedback(makeCompletionEvent());

      expect(promotionEngine.evaluate).toHaveBeenCalledWith("cand-1");
      expect(result.promotionDecision).toBeDefined();
      expect(result.promotionDecision!.decision).toBe("promote");
    });

    it("skips promotion when candidate is not pending", async () => {
      const { bridge, promotionEngine } = makeBridge({
        learner: {
          processCompletedRun: vi.fn().mockResolvedValue(
            makeCandidate({ status: "promoted", promotedPlaybookId: "pb-1" }),
          ),
        },
      });

      await bridge.recordFeedback(makeCompletionEvent());

      expect(promotionEngine.evaluate).not.toHaveBeenCalled();
    });

    it("handles null candidate (no pattern match)", async () => {
      const { bridge, scoreCalculator, promotionEngine } = makeBridge({
        learner: { processCompletedRun: vi.fn().mockResolvedValue(null) },
      });

      const result = await bridge.recordFeedback(makeCompletionEvent());

      expect(result.candidate).toBeNull();
      expect(result.scoreRecalculated).toBe(false);
      expect(result.promotionDecision).toBeNull();
      expect(scoreCalculator.recalculate).not.toHaveBeenCalled();
      expect(promotionEngine.evaluate).not.toHaveBeenCalled();
    });

    it("works without optional score calculator", async () => {
      const { bridge } = makeBridge({
        scoreCalculator: undefined,
        learner: {
          processCompletedRun: vi.fn().mockResolvedValue(
            makeCandidate({ status: "promoted", promotedPlaybookId: "pb-1" }),
          ),
        },
      });

      const result = await bridge.recordFeedback(makeCompletionEvent());

      expect(result.scoreRecalculated).toBe(false);
      expect(result.updatedScore).toBeNull();
    });

    it("works without optional promotion engine", async () => {
      const { bridge } = makeBridge({
        promotionEngine: undefined,
        learner: {
          processCompletedRun: vi.fn().mockResolvedValue(
            makeCandidate({ status: "pending" }),
          ),
        },
      });

      const result = await bridge.recordFeedback(makeCompletionEvent());

      expect(result.promotionDecision).toBeNull();
    });
  });

  describe("trace events", () => {
    it("emits trace on intake", async () => {
      const { bridge, onTrace } = makeBridge();

      await bridge.selectOnIntake({
        runId: "run-1", workflowId: "wf-1",
        workflowType: "data-pipeline",
        tags: [], nodeSequence: [],
      });

      expect(onTrace).toHaveBeenCalledOnce();
      const trace: PlaybookBridgeTrace = onTrace.mock.calls[0][0];
      expect(trace.phase).toBe("intake");
      expect(trace.runId).toBe("run-1");
      expect(trace.timestamp).toBe("2026-01-01T00:00:00Z");
      expect(trace.intakeResult).toBeDefined();
    });

    it("emits trace on feedback", async () => {
      const { bridge, onTrace } = makeBridge();

      await bridge.recordFeedback(makeCompletionEvent());

      expect(onTrace).toHaveBeenCalledOnce();
      const trace: PlaybookBridgeTrace = onTrace.mock.calls[0][0];
      expect(trace.phase).toBe("feedback");
      expect(trace.feedbackResult).toBeDefined();
    });

    it("stores traces queryable by runId", async () => {
      const { bridge } = makeBridge();

      await bridge.selectOnIntake({
        runId: "run-1", workflowId: "wf-1",
        workflowType: "t", tags: [], nodeSequence: [],
      });
      await bridge.recordFeedback(makeCompletionEvent({ runId: "run-1", workflowId: "wf-1" }));
      await bridge.selectOnIntake({
        runId: "run-2", workflowId: "wf-2",
        workflowType: "t", tags: [], nodeSequence: [],
      });

      expect(bridge.getTraces("run-1")).toHaveLength(2);
      expect(bridge.getTraces("run-2")).toHaveLength(1);
    });
  });

  describe("isEnabled", () => {
    it("returns true when enabled", () => {
      const { bridge } = makeBridge({ enabled: true });
      expect(bridge.isEnabled()).toBe(true);
    });

    it("returns false when disabled", () => {
      const { bridge } = makeBridge({ enabled: false });
      expect(bridge.isEnabled()).toBe(false);
    });

    it("defaults to enabled", () => {
      const { bridge } = makeBridge();
      expect(bridge.isEnabled()).toBe(true);
    });
  });

  describe("reset", () => {
    it("clears all traces", async () => {
      const { bridge } = makeBridge();

      await bridge.selectOnIntake({
        runId: "run-1", workflowId: "wf-1",
        workflowType: "t", tags: [], nodeSequence: [],
      });
      expect(bridge.getTraces("run-1")).toHaveLength(1);

      bridge.reset();

      expect(bridge.getTraces("run-1")).toHaveLength(0);
    });
  });

  describe("deterministic score formula", () => {
    it("returns deterministic match score from selector", async () => {
      const fixedMatch = makeMatch({ matchScore: 0.7777 });
      const { bridge } = makeBridge({
        selector: { select: vi.fn().mockResolvedValue(fixedMatch) },
      });

      const r1 = await bridge.selectOnIntake({
        runId: "run-1", workflowId: "wf-1",
        workflowType: "t", tags: [], nodeSequence: [],
      });
      const r2 = await bridge.selectOnIntake({
        runId: "run-2", workflowId: "wf-1",
        workflowType: "t", tags: [], nodeSequence: [],
      });

      expect(r1.matchScore).toBe(0.7777);
      expect(r2.matchScore).toBe(0.7777);
      expect(r1.matchScore).toBe(r2.matchScore);
    });
  });

  describe("promotion/demotion feedback loop", () => {
    it("triggers promote on sufficient evidence", async () => {
      const { bridge, promotionEngine } = makeBridge({
        learner: {
          processCompletedRun: vi.fn().mockResolvedValue(
            makeCandidate({ status: "pending", evidenceCount: 5, successCount: 5 }),
          ),
        },
        promotionEngine: {
          evaluate: vi.fn().mockResolvedValue(makePromotionDecision({ decision: "promote" })),
          evaluateAll: vi.fn(),
        },
      });

      const result = await bridge.recordFeedback(makeCompletionEvent());

      expect(result.promotionDecision!.decision).toBe("promote");
    });

    it("defers promotion with insufficient evidence", async () => {
      const { bridge } = makeBridge({
        learner: {
          processCompletedRun: vi.fn().mockResolvedValue(
            makeCandidate({ status: "pending", evidenceCount: 2 }),
          ),
        },
        promotionEngine: {
          evaluate: vi.fn().mockResolvedValue(makePromotionDecision({ decision: "defer", reason: "Insufficient evidence" })),
          evaluateAll: vi.fn(),
        },
      });

      const result = await bridge.recordFeedback(makeCompletionEvent());

      expect(result.promotionDecision!.decision).toBe("defer");
    });

    it("rejects candidate with high failure rate", async () => {
      const { bridge } = makeBridge({
        learner: {
          processCompletedRun: vi.fn().mockResolvedValue(
            makeCandidate({ status: "pending", evidenceCount: 10, successCount: 3, failureCount: 7 }),
          ),
        },
        promotionEngine: {
          evaluate: vi.fn().mockResolvedValue(makePromotionDecision({ decision: "reject", reason: "High failure rate" })),
          evaluateAll: vi.fn(),
        },
      });

      const result = await bridge.recordFeedback(makeCompletionEvent({ success: false }));

      expect(result.promotionDecision!.decision).toBe("reject");
    });
  });
});
