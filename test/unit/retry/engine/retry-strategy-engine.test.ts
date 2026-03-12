import { describe, it, expect } from "vitest";

import {
  computeRawDelay,
  computeDelay,
  applyJitter,
  findStrategyForCategory,
  isWithinBudget,
  buildRetryDecision,
  createRetryStrategyEngine,
} from "../../../../src/retry/engine/retry-strategy-engine.js";

import type {
  FridayRetryStrategy,
  FridayClassifiedFailure,
  FridayRetryDecisionContext,
  FridayRetryCostBudget,
  FridayRetryCostDimensions,
} from "../../../../src/retry/model/friday-retry-engine.types.js";

import type { RetryStrategyEngineConfig } from "../../../../src/retry/engine/retry-strategy-engine.js";

// ─── Helpers ───

let idCounter = 0;
const testConfig: RetryStrategyEngineConfig = {
  generateId: () => `test-id-${++idCounter}` as string,
  nowIso: () => "2026-02-24T10:00:00.000Z" as string,
};

function makeExponentialStrategy(overrides?: Partial<FridayRetryStrategy>): FridayRetryStrategy {
  return {
    strategy: "exponential",
    failureCategory: "transient",
    maxAttempts: 3,
    respectRetryAfter: false,
    timeoutMultiplier: 1.0,
    escalate: false,
    escalateOnExhaustion: true,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitterPercent: 25,
    ...overrides,
  } as FridayRetryStrategy;
}

function makeLinearStrategy(): FridayRetryStrategy {
  return {
    strategy: "linear",
    failureCategory: "resource",
    maxAttempts: 2,
    respectRetryAfter: false,
    timeoutMultiplier: 1.0,
    escalate: false,
    escalateOnExhaustion: true,
    baseDelayMs: 10000,
    maxDelayMs: 120000,
    jitterPercent: 10,
  } as FridayRetryStrategy;
}

function makeFixedStrategy(): FridayRetryStrategy {
  return {
    strategy: "fixed",
    failureCategory: "rate_limit",
    maxAttempts: 5,
    respectRetryAfter: true,
    timeoutMultiplier: 1.0,
    escalate: false,
    escalateOnExhaustion: true,
    baseDelayMs: 5000,
    maxDelayMs: 60000,
    jitterPercent: 0,
  } as FridayRetryStrategy;
}

function makeImmediateStrategy(): FridayRetryStrategy {
  return {
    strategy: "immediate",
    failureCategory: "unknown",
    maxAttempts: 1,
    respectRetryAfter: false,
    timeoutMultiplier: 1.0,
    escalate: false,
    escalateOnExhaustion: true,
  } as FridayRetryStrategy;
}

function makeNoneStrategy(): FridayRetryStrategy {
  return {
    strategy: "none",
    failureCategory: "auth",
    maxAttempts: 0,
    respectRetryAfter: false,
    timeoutMultiplier: 1.0,
    escalate: true,
    escalateOnExhaustion: true,
    escalationChannel: "operator",
  } as FridayRetryStrategy;
}

function makeClassifiedFailure(
  category: string = "transient",
): FridayClassifiedFailure {
  return {
    classificationId: "cf-1",
    category: category as FridayClassifiedFailure["category"],
    severity: "minor",
    classificationSource: "http_status",
    confidence: 90,
    retryable: true,
    classifiedAt: "2026-02-24T10:00:00.000Z",
  } as FridayClassifiedFailure;
}

const testBudget: FridayRetryCostBudget = {
  maxTotalTokens: 50000,
  maxTotalApiCalls: 20,
  maxTotalComputeMs: 300000,
};

function makeContext(overrides?: Partial<FridayRetryDecisionContext>): FridayRetryDecisionContext {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    nodeId: "node-1",
    currentAttemptNumber: 1,
    accumulatedCost: { tokens: 0, apiCalls: 0, computeMs: 0 },
    costBudget: testBudget,
    ...overrides,
  } as FridayRetryDecisionContext;
}

// ─── Tests ───

describe("RetryStrategyEngine", () => {
  describe("computeRawDelay", () => {
    it("computes exponential backoff: delay doubles per attempt", () => {
      const strategy = makeExponentialStrategy();
      expect(computeRawDelay(strategy, 1)).toBe(1000);
      expect(computeRawDelay(strategy, 2)).toBe(2000);
      expect(computeRawDelay(strategy, 3)).toBe(4000);
      expect(computeRawDelay(strategy, 4)).toBe(8000);
    });

    it("caps exponential delay at maxDelayMs", () => {
      const strategy = makeExponentialStrategy({
        baseDelayMs: 10000,
        maxDelayMs: 30000,
      } as Partial<FridayRetryStrategy>);
      expect(computeRawDelay(strategy, 1)).toBe(10000);
      expect(computeRawDelay(strategy, 2)).toBe(20000);
      expect(computeRawDelay(strategy, 3)).toBe(30000); // capped
      expect(computeRawDelay(strategy, 4)).toBe(30000); // capped
    });

    it("computes linear backoff: delay increases by base per attempt", () => {
      const strategy = makeLinearStrategy();
      expect(computeRawDelay(strategy, 1)).toBe(10000);
      expect(computeRawDelay(strategy, 2)).toBe(20000);
      expect(computeRawDelay(strategy, 3)).toBe(30000);
    });

    it("caps linear delay at maxDelayMs", () => {
      const strategy = makeLinearStrategy();
      // attempt 13: 10000 * 13 = 130000 > 120000
      expect(computeRawDelay(strategy, 13)).toBe(120000);
    });

    it("computes fixed delay: constant per attempt", () => {
      const strategy = makeFixedStrategy();
      expect(computeRawDelay(strategy, 1)).toBe(5000);
      expect(computeRawDelay(strategy, 2)).toBe(5000);
      expect(computeRawDelay(strategy, 5)).toBe(5000);
    });

    it("returns 0 for immediate strategy", () => {
      const strategy = makeImmediateStrategy();
      expect(computeRawDelay(strategy, 1)).toBe(0);
      expect(computeRawDelay(strategy, 5)).toBe(0);
    });

    it("returns 0 for none strategy", () => {
      const strategy = makeNoneStrategy();
      expect(computeRawDelay(strategy, 1)).toBe(0);
    });
  });

  describe("applyJitter", () => {
    it("returns the original delay when jitter is 0", () => {
      expect(applyJitter(1000, 0, 0.5)).toBe(1000);
    });

    it("returns 0 when delay is 0", () => {
      expect(applyJitter(0, 25, 0.5)).toBe(0);
    });

    it("applies maximum positive jitter at random=1", () => {
      // random=1 → jitterMultiplier = (1*2 - 1) * 0.25 = 0.25
      // delay = 1000 * 1.25 = 1250
      expect(applyJitter(1000, 25, 1)).toBe(1250);
    });

    it("applies maximum negative jitter at random=0", () => {
      // random=0 → jitterMultiplier = (0*2 - 1) * 0.25 = -0.25
      // delay = 1000 * 0.75 = 750
      expect(applyJitter(1000, 25, 0)).toBe(750);
    });

    it("applies zero jitter at random=0.5", () => {
      // random=0.5 → jitterMultiplier = (0.5*2 - 1) * 0.25 = 0
      expect(applyJitter(1000, 25, 0.5)).toBe(1000);
    });

    it("never returns negative values", () => {
      // Even with 100% jitter and random=0 → delay * (1 - 1) = 0
      expect(applyJitter(1000, 100, 0)).toBe(0);
    });
  });

  describe("computeDelay (with jitter)", () => {
    it("applies jitter to exponential delay", () => {
      const strategy = makeExponentialStrategy();
      // attempt 1: raw = 1000, jitter 25%
      // random=0 → 750, random=1 → 1250
      expect(computeDelay(strategy, 1, 0)).toBe(750);
      expect(computeDelay(strategy, 1, 1)).toBe(1250);
    });

    it("returns 0 for immediate strategy regardless of random", () => {
      const strategy = makeImmediateStrategy();
      expect(computeDelay(strategy, 1, 0)).toBe(0);
      expect(computeDelay(strategy, 1, 1)).toBe(0);
    });
  });

  describe("findStrategyForCategory", () => {
    const strategies = [
      makeExponentialStrategy(),
      makeFixedStrategy(),
      makeNoneStrategy(),
    ];

    it("finds the strategy for a matching category", () => {
      const found = findStrategyForCategory(strategies, "transient");
      expect(found?.strategy).toBe("exponential");
    });

    it("returns undefined for unmatched category", () => {
      const found = findStrategyForCategory(strategies, "unknown");
      expect(found).toBeUndefined();
    });
  });

  describe("isWithinBudget", () => {
    it("returns true when all dimensions are under budget", () => {
      const cost: FridayRetryCostDimensions = { tokens: 100, apiCalls: 1, computeMs: 1000 };
      expect(isWithinBudget(cost, testBudget)).toBe(true);
    });

    it("returns true when dimensions are exactly at budget limits", () => {
      const cost: FridayRetryCostDimensions = { tokens: 50000, apiCalls: 1, computeMs: 1000 };
      expect(isWithinBudget(cost, testBudget)).toBe(true);
    });

    it("returns true when apiCalls are exactly at budget limit", () => {
      const cost: FridayRetryCostDimensions = { tokens: 100, apiCalls: 20, computeMs: 1000 };
      expect(isWithinBudget(cost, testBudget)).toBe(true);
    });

    it("returns true when computeMs is exactly at budget limit", () => {
      const cost: FridayRetryCostDimensions = { tokens: 100, apiCalls: 1, computeMs: 300000 };
      expect(isWithinBudget(cost, testBudget)).toBe(true);
    });

    it("returns false when tokens are above budget", () => {
      const cost: FridayRetryCostDimensions = { tokens: 50001, apiCalls: 1, computeMs: 1000 };
      expect(isWithinBudget(cost, testBudget)).toBe(false);
    });

    it("returns false when apiCalls are above budget", () => {
      const cost: FridayRetryCostDimensions = { tokens: 100, apiCalls: 21, computeMs: 1000 };
      expect(isWithinBudget(cost, testBudget)).toBe(false);
    });

    it("returns false when computeMs is above budget", () => {
      const cost: FridayRetryCostDimensions = { tokens: 100, apiCalls: 1, computeMs: 300001 };
      expect(isWithinBudget(cost, testBudget)).toBe(false);
    });
  });

  describe("buildRetryDecision", () => {
    it("returns shouldRetry=true for retryable failure within budget and attempts", () => {
      const failure = makeClassifiedFailure("transient");
      const strategies = [makeExponentialStrategy()];
      const context = makeContext();
      const decision = buildRetryDecision(failure, context, strategies, testConfig);

      expect(decision.shouldRetry).toBe(true);
      expect(decision.nextAttemptNumber).toBe(2);
      expect(decision.failureCategory).toBe("transient");
      expect(decision.strategyType).toBe("exponential");
      expect(decision.escalate).toBe(false);
      expect(decision.budgetConstrained).toBe(false);
    });

    it("returns shouldRetry=false when strategy is none", () => {
      const failure = makeClassifiedFailure("auth");
      const strategies = [makeNoneStrategy()];
      const context = makeContext();
      const decision = buildRetryDecision(failure, context, strategies, testConfig);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.escalate).toBe(true);
      expect(decision.escalationChannel).toBe("operator");
    });

    it("returns shouldRetry=false when attempts exhausted", () => {
      const failure = makeClassifiedFailure("transient");
      const strategies = [makeExponentialStrategy()];
      const context = makeContext({ currentAttemptNumber: 3 }); // maxAttempts=3
      const decision = buildRetryDecision(failure, context, strategies, testConfig);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain("exhausted");
    });

    it("returns shouldRetry=false when budget exceeded", () => {
      const failure = makeClassifiedFailure("transient");
      const strategies = [makeExponentialStrategy()];
      const context = makeContext({
        accumulatedCost: { tokens: 60000, apiCalls: 1, computeMs: 1000 },
      });
      const decision = buildRetryDecision(failure, context, strategies, testConfig);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.budgetConstrained).toBe(true);
      expect(decision.reason).toContain("budget");
    });

    it("returns shouldRetry=false when accumulated plus current attempt cost exceeds budget", () => {
      const failure = makeClassifiedFailure("transient");
      const strategies = [makeExponentialStrategy()];
      const context = makeContext({
        accumulatedCost: { tokens: 49_995, apiCalls: 10, computeMs: 1000 },
        currentAttemptCost: { tokens: 10, apiCalls: 1, computeMs: 100 },
      });
      const decision = buildRetryDecision(failure, context, strategies, testConfig);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.budgetConstrained).toBe(true);
      expect(decision.reason).toContain("budget");
    });

    it("returns shouldRetry=false when per-attempt budget is exceeded", () => {
      const failure = makeClassifiedFailure("transient");
      const strategies = [makeExponentialStrategy()];
      const context = makeContext({
        costBudget: {
          ...testBudget,
          maxCostPerAttempt: { tokens: 100, apiCalls: 2, computeMs: 5000 },
        },
        currentAttemptCost: { tokens: 101, apiCalls: 1, computeMs: 1000 },
      });
      const decision = buildRetryDecision(failure, context, strategies, testConfig);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.budgetConstrained).toBe(true);
      expect(decision.reason).toContain("Per-attempt");
    });

    it("returns shouldRetry=false when no strategy matches category", () => {
      const failure = makeClassifiedFailure("resource");
      const strategies = [makeExponentialStrategy()]; // only for transient
      const context = makeContext();
      const decision = buildRetryDecision(failure, context, strategies, testConfig);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain("No retry strategy");
    });

    it("respects Retry-After when configured", () => {
      const failure = makeClassifiedFailure("rate_limit");
      failure.retryAfterMs = 10000;
      const strategy = makeFixedStrategy(); // respectRetryAfter=true, baseDelay=5000
      const context = makeContext();
      const decision = buildRetryDecision(failure, context, [strategy], testConfig);

      expect(decision.shouldRetry).toBe(true);
      expect(decision.delayMs).toBeGreaterThanOrEqual(10000);
    });

    it("generates idempotency key with correct format", () => {
      const failure = makeClassifiedFailure("transient");
      const strategies = [makeExponentialStrategy()];
      const context = makeContext({ runId: "run-abc" as string, nodeId: "node-xyz" });
      const decision = buildRetryDecision(failure, context, strategies, testConfig);

      expect(decision.idempotencyKey).toBe("retry:run-abc:node-xyz:2");
    });
  });

  describe("createRetryStrategyEngine", () => {
    it("exposes all public methods", () => {
      const engine = createRetryStrategyEngine(testConfig);
      expect(typeof engine.computeDelay).toBe("function");
      expect(typeof engine.findStrategy).toBe("function");
      expect(typeof engine.isWithinBudget).toBe("function");
      expect(typeof engine.buildDecision).toBe("function");
    });

    it("buildDecision delegates to buildRetryDecision", () => {
      const engine = createRetryStrategyEngine(testConfig);
      const failure = makeClassifiedFailure("transient");
      const strategies = [makeExponentialStrategy()];
      const context = makeContext();
      const decision = engine.buildDecision(failure, context, strategies);

      expect(decision.shouldRetry).toBe(true);
    });
  });
});
