import { describe, it, expect, beforeEach } from "vitest";

import {
  createRetryContextTracker,
  ZERO_COST,
} from "../../../../src/retry/engine/retry-context.js";

import type {
  RetryContextTrackerConfig,
  InitContextParams,
  RecordAttemptParams,
  RetryContextKey,
} from "../../../../src/retry/engine/retry-context.js";

import type {
  FridayClassifiedFailure,
  FridayRetryDecision,
} from "../../../../src/retry/model/friday-retry-engine.types.js";

// ─── Helpers ───

let timeCounter = 0;
const testConfig: RetryContextTrackerConfig = {
  nowIso: () => `2026-02-24T10:00:${String(timeCounter++).padStart(2, "0")}.000Z` as string,
};

function makeInitParams(overrides?: Partial<InitContextParams>): InitContextParams {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    nodeId: "node-1",
    originalFailureCategory: "transient",
    ...overrides,
  } as InitContextParams;
}

function makeAttemptParams(overrides?: Partial<RecordAttemptParams>): RecordAttemptParams {
  return {
    classifiedFailure: {
      classificationId: "cf-1",
      category: "transient",
      severity: "minor",
      classificationSource: "http_status",
      confidence: 90,
      retryable: true,
      classifiedAt: "2026-02-24T10:00:00.000Z",
    } as FridayClassifiedFailure,
    decision: {
      shouldRetry: true,
      nextAttemptNumber: 2,
      delayMs: 1000,
      reason: "Retrying transient failure",
      failureCategory: "transient",
      strategyType: "exponential",
      rulesOverride: false,
      budgetConstrained: false,
      escalate: false,
      idempotencyKey: "retry:run-1:node-1:2",
      decidedAt: "2026-02-24T10:00:00.000Z",
    } as FridayRetryDecision,
    delayMs: 1000,
    outcome: "failure",
    cost: { tokens: 1000, apiCalls: 1, computeMs: 5000 },
    startedAt: "2026-02-24T10:00:01.000Z",
    completedAt: "2026-02-24T10:00:02.000Z",
    ...overrides,
  } as RecordAttemptParams;
}

const testKey: RetryContextKey = { runId: "run-1" as string, nodeId: "node-1" };

// ─── Tests ───

describe("RetryContextTracker", () => {
  let tracker: ReturnType<typeof createRetryContextTracker>;

  beforeEach(() => {
    timeCounter = 0;
    tracker = createRetryContextTracker(testConfig);
  });

  describe("ZERO_COST", () => {
    it("is all zeros", () => {
      expect(ZERO_COST.tokens).toBe(0);
      expect(ZERO_COST.apiCalls).toBe(0);
      expect(ZERO_COST.computeMs).toBe(0);
    });
  });

  describe("initContext", () => {
    it("creates a new context in in_progress state", () => {
      const ctx = tracker.initContext(makeInitParams());

      expect(ctx.status).toBe("in_progress");
      expect(ctx.key.runId).toBe("run-1");
      expect(ctx.key.nodeId).toBe("node-1");
      expect(ctx.originalFailureCategory).toBe("transient");
      expect(ctx.attempts).toHaveLength(0);
      expect(ctx.accumulatedCost).toEqual(ZERO_COST);
    });

    it("returns existing context if already in_progress", () => {
      const ctx1 = tracker.initContext(makeInitParams());
      const ctx2 = tracker.initContext(makeInitParams());
      expect(ctx2).toEqual(ctx1);
      expect(ctx2).not.toBe(ctx1);
    });

    it("creates a new context if previous one is resolved", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams({ outcome: "success" }));

      const ctx = tracker.initContext(makeInitParams());
      expect(ctx.status).toBe("in_progress");
      expect(ctx.attempts).toHaveLength(0);
    });
  });

  describe("recordAttempt", () => {
    it("records an attempt and updates the context", () => {
      tracker.initContext(makeInitParams());
      const ctx = tracker.recordAttempt(testKey, makeAttemptParams());

      expect(ctx).toBeDefined();
      expect(ctx!.attempts).toHaveLength(1);
      expect(ctx!.attempts[0].attemptNumber).toBe(1);
      expect(ctx!.attempts[0].outcome).toBe("failure");
    });

    it("accumulates costs across attempts", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams({
        cost: { tokens: 1000, apiCalls: 1, computeMs: 5000 },
      }));
      tracker.recordAttempt(testKey, makeAttemptParams({
        cost: { tokens: 2000, apiCalls: 2, computeMs: 3000 },
      }));

      const ctx = tracker.getContext(testKey);
      expect(ctx!.accumulatedCost).toEqual({
        tokens: 3000,
        apiCalls: 3,
        computeMs: 8000,
      });
    });

    it("assigns sequential attempt numbers", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams());
      tracker.recordAttempt(testKey, makeAttemptParams());
      tracker.recordAttempt(testKey, makeAttemptParams());

      const ctx = tracker.getContext(testKey);
      expect(ctx!.attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
    });

    it("transitions to resolved on success", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams({ outcome: "success" }));

      const ctx = tracker.getContext(testKey);
      expect(ctx!.status).toBe("resolved");
      expect(ctx!.resolvedAt).toBeDefined();
    });

    it("transitions to cancelled on cancellation", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams({ outcome: "cancelled" }));

      expect(tracker.getContext(testKey)!.status).toBe("escalated");
    });

    it("transitions to budget_exceeded on budget outcome", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams({ outcome: "budget_exceeded" }));

      expect(tracker.getContext(testKey)!.status).toBe("exhausted");
    });

    it("transitions to escalated on rules_denied", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams({ outcome: "rules_denied" }));

      expect(tracker.getContext(testKey)!.status).toBe("escalated");
    });

    it("stays in_progress on failure or timeout", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams({ outcome: "failure" }));
      expect(tracker.getContext(testKey)!.status).toBe("in_progress");

      tracker.recordAttempt(testKey, makeAttemptParams({ outcome: "timeout" }));
      expect(tracker.getContext(testKey)!.status).toBe("in_progress");
    });

    it("returns undefined for non-existent context", () => {
      const result = tracker.recordAttempt(
        { runId: "no-run" as string, nodeId: "no-node" },
        makeAttemptParams(),
      );
      expect(result).toBeUndefined();
    });

    it("rejects attempts once context is terminal", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams({ outcome: "success" }));

      expect(() => {
        tracker.recordAttempt(testKey, makeAttemptParams({ outcome: "failure" }));
      }).toThrow(/Cannot mutate terminal retry context/);
    });
  });

  describe("markExhausted / markEscalated", () => {
    it("markExhausted sets status to exhausted", () => {
      tracker.initContext(makeInitParams());
      tracker.markExhausted(testKey);
      expect(tracker.getContext(testKey)!.status).toBe("exhausted");
    });

    it("markEscalated sets status to escalated", () => {
      tracker.initContext(makeInitParams());
      tracker.markEscalated(testKey);
      expect(tracker.getContext(testKey)!.status).toBe("escalated");
    });

    it("returns undefined for non-existent context", () => {
      expect(tracker.markExhausted({ runId: "x" as string, nodeId: "y" })).toBeUndefined();
      expect(tracker.markEscalated({ runId: "x" as string, nodeId: "y" })).toBeUndefined();
    });

    it("rejects terminal-to-terminal transitions", () => {
      tracker.initContext(makeInitParams());
      tracker.markExhausted(testKey);

      expect(() => tracker.markEscalated(testKey)).toThrow(
        /Cannot mutate terminal retry context/,
      );
    });
  });

  describe("getAttemptCount / getAccumulatedCost", () => {
    it("returns 0 for non-existent context", () => {
      expect(tracker.getAttemptCount({ runId: "x" as string, nodeId: "y" })).toBe(0);
    });

    it("returns ZERO_COST for non-existent context", () => {
      const cost = tracker.getAccumulatedCost({ runId: "x" as string, nodeId: "y" });
      expect(cost).toEqual(ZERO_COST);
    });

    it("returns correct attempt count", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams());
      tracker.recordAttempt(testKey, makeAttemptParams());
      expect(tracker.getAttemptCount(testKey)).toBe(2);
    });
  });

  describe("getActiveContexts / getAllContexts", () => {
    it("returns only in_progress contexts from getActiveContexts", () => {
      tracker.initContext(makeInitParams({ nodeId: "node-a" }));
      tracker.initContext(makeInitParams({ nodeId: "node-b" }));
      tracker.recordAttempt(
        { runId: "run-1" as string, nodeId: "node-b" },
        makeAttemptParams({ outcome: "success" }),
      );

      const active = tracker.getActiveContexts();
      expect(active).toHaveLength(1);
      expect(active[0].key.nodeId).toBe("node-a");
    });

    it("returns all contexts from getAllContexts", () => {
      tracker.initContext(makeInitParams({ nodeId: "node-a" }));
      tracker.initContext(makeInitParams({ nodeId: "node-b" }));
      tracker.recordAttempt(
        { runId: "run-1" as string, nodeId: "node-b" },
        makeAttemptParams({ outcome: "success" }),
      );

      expect(tracker.getAllContexts()).toHaveLength(2);
    });
  });

  describe("immutable snapshots", () => {
    it("returns frozen snapshots from getContext", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams());

      const snapshot = tracker.getContext(testKey)!;
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.attempts)).toBe(true);
      expect(Object.isFrozen(snapshot.accumulatedCost)).toBe(true);
    });

    it("prevents external mutation from affecting internal state", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams());

      const snapshot = tracker.getContext(testKey)!;
      expect(() => {
        (snapshot.accumulatedCost as { tokens: number }).tokens = 999_999;
      }).toThrow();

      const latest = tracker.getContext(testKey)!;
      expect(latest.accumulatedCost.tokens).toBe(1000);
    });

    it("returns defensive copies from getAccumulatedCost", () => {
      tracker.initContext(makeInitParams());
      tracker.recordAttempt(testKey, makeAttemptParams());

      const first = tracker.getAccumulatedCost(testKey);
      const second = tracker.getAccumulatedCost(testKey);
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      expect(Object.isFrozen(first)).toBe(true);
    });
  });

  describe("removeContext / clear", () => {
    it("removes a specific context", () => {
      tracker.initContext(makeInitParams());
      expect(tracker.removeContext(testKey)).toBe(true);
      expect(tracker.getContext(testKey)).toBeUndefined();
    });

    it("returns false for non-existent context", () => {
      expect(tracker.removeContext({ runId: "x" as string, nodeId: "y" })).toBe(false);
    });

    it("clears all contexts", () => {
      tracker.initContext(makeInitParams({ nodeId: "node-a" }));
      tracker.initContext(makeInitParams({ nodeId: "node-b" }));
      tracker.clear();
      expect(tracker.getAllContexts()).toHaveLength(0);
    });
  });

  describe("getSummary", () => {
    it("returns count by status", () => {
      tracker.initContext(makeInitParams({ nodeId: "node-a" }));
      tracker.initContext(makeInitParams({ nodeId: "node-b" }));
      tracker.recordAttempt(
        { runId: "run-1" as string, nodeId: "node-b" },
        makeAttemptParams({ outcome: "success" }),
      );
      tracker.initContext(makeInitParams({ nodeId: "node-c" }));
      tracker.markExhausted({ runId: "run-1" as string, nodeId: "node-c" });

      const summary = tracker.getSummary();
      expect(summary.in_progress).toBe(1);
      expect(summary.resolved).toBe(1);
      expect(summary.exhausted).toBe(1);
      expect(summary.escalated).toBe(0);
      expect(summary.cancelled).toBe(0);
      expect(summary.budget_exceeded).toBe(0);
    });
  });
});
