import { describe, it, expect, beforeEach } from "vitest";

import { createFailureClassifier } from "../../../../src/retry/engine/failure-classifier.js";
import { createRetryStrategyEngine } from "../../../../src/retry/engine/retry-strategy-engine.js";
import { createRetryContextTracker } from "../../../../src/retry/engine/retry-context.js";
import { createRetryBudget } from "../../../../src/retry/engine/retry-budget.js";
import {
  RetryOrchestrationError,
  createRetryOrchestrator,
} from "../../../../src/retry/engine/retry-orchestrator.js";

import type {
  FailureClassifierConfig,
} from "../../../../src/retry/engine/failure-classifier.js";
import type {
  RetryStrategyEngineConfig,
} from "../../../../src/retry/engine/retry-strategy-engine.js";
import type {
  RetryContextTrackerConfig,
} from "../../../../src/retry/engine/retry-context.js";
import type {
  FridayRetryCostBudget,
  FridayRetryStrategy,
} from "../../../../src/retry/model/friday-retry-engine.types.js";

let idCounter = 0;
let timeCounter = 0;

const classifierConfig: FailureClassifierConfig = {
  generateId: () => `cls-${++idCounter}` as string,
  nowIso: () => `2026-02-24T12:00:${String(timeCounter++).padStart(2, "0")}.000Z` as string,
};

const strategyConfig: RetryStrategyEngineConfig = {
  generateId: () => `dec-${++idCounter}` as string,
  nowIso: () => `2026-02-24T12:01:${String(timeCounter++).padStart(2, "0")}.000Z` as string,
};

const contextConfig: RetryContextTrackerConfig = {
  nowIso: () => `2026-02-24T12:02:${String(timeCounter++).padStart(2, "0")}.000Z` as string,
};

const defaultCostBudget: FridayRetryCostBudget = {
  maxTotalTokens: 1000,
  maxTotalApiCalls: 100,
  maxTotalComputeMs: 60_000,
};

function makeTransientStrategy(
  overrides?: Partial<FridayRetryStrategy>,
): FridayRetryStrategy {
  return {
    strategy: "fixed",
    failureCategory: "transient",
    maxAttempts: 3,
    respectRetryAfter: false,
    timeoutMultiplier: 1,
    escalate: false,
    escalateOnExhaustion: true,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterPercent: 0,
    ...overrides,
  } as FridayRetryStrategy;
}

function makeNoneStrategy(): FridayRetryStrategy {
  return {
    strategy: "none",
    failureCategory: "auth",
    maxAttempts: 0,
    respectRetryAfter: false,
    timeoutMultiplier: 1,
    escalate: true,
    escalateOnExhaustion: true,
    escalationChannel: "operator",
  } as FridayRetryStrategy;
}

describe("RetryOrchestrator", () => {
  beforeEach(() => {
    idCounter = 0;
    timeCounter = 0;
  });

  it("runs full pipeline and recovers after a retry", async () => {
    const classifier = createFailureClassifier(classifierConfig);
    const strategyEngine = createRetryStrategyEngine(strategyConfig);
    const contextTracker = createRetryContextTracker(contextConfig);
    const orchestrator = createRetryOrchestrator({
      classifier,
      strategyEngine,
      contextTracker,
      nowIso: contextConfig.nowIso,
    });

    let calls = 0;
    const value = await orchestrator.retryWithPolicy(async () => {
      calls++;
      if (calls === 1) {
        throw { errorCode: "ECONNRESET", errorMessage: "connection reset" };
      }
      return "ok";
    }, {
      runId: "run-1" as string,
      workflowId: "wf-1" as string,
      nodeId: "node-1",
      strategies: [makeTransientStrategy()],
      costBudget: defaultCostBudget,
      sleep: async () => {},
      estimateAttemptCost: () => ({ tokens: 10, apiCalls: 1, computeMs: 100 }),
    });

    expect(value).toBe("ok");
    expect(calls).toBe(2);

    const context = contextTracker.getContext({ runId: "run-1" as string, nodeId: "node-1" });
    expect(context).toBeDefined();
    expect(context!.status).toBe("resolved");
    expect(context!.attempts).toHaveLength(2);
    expect(context!.accumulatedCost.tokens).toBe(20);
  });

  it("escalates immediately for no-retry strategy", async () => {
    const classifier = createFailureClassifier(classifierConfig);
    const strategyEngine = createRetryStrategyEngine(strategyConfig);
    const contextTracker = createRetryContextTracker(contextConfig);
    const orchestrator = createRetryOrchestrator({
      classifier,
      strategyEngine,
      contextTracker,
      nowIso: contextConfig.nowIso,
    });

    let calls = 0;
    await expect(orchestrator.retryWithPolicy(async () => {
      calls++;
      throw { errorCode: "NODE_PRE_RULES_DENIED", errorMessage: "forbidden" };
    }, {
      runId: "run-2" as string,
      workflowId: "wf-1" as string,
      nodeId: "node-auth",
      strategies: [makeNoneStrategy()],
      costBudget: defaultCostBudget,
      sleep: async () => {},
    })).rejects.toBeInstanceOf(RetryOrchestrationError);

    expect(calls).toBe(1);
    const context = contextTracker.getContext({ runId: "run-2" as string, nodeId: "node-auth" });
    expect(context!.status).toBe("escalated");
    expect(context!.attempts).toHaveLength(1);
  });

  it("enforces per-attempt cost budget via strategy decision", async () => {
    const classifier = createFailureClassifier(classifierConfig);
    const strategyEngine = createRetryStrategyEngine(strategyConfig);
    const contextTracker = createRetryContextTracker(contextConfig);
    const orchestrator = createRetryOrchestrator({
      classifier,
      strategyEngine,
      contextTracker,
      nowIso: contextConfig.nowIso,
    });

    let calls = 0;
    await expect(orchestrator.retryWithPolicy(async () => {
      calls++;
      throw { errorCode: "ECONNRESET", errorMessage: "retry me" };
    }, {
      runId: "run-3" as string,
      workflowId: "wf-1" as string,
      nodeId: "node-budget",
      strategies: [makeTransientStrategy({ maxAttempts: 5 })],
      costBudget: {
        ...defaultCostBudget,
        maxCostPerAttempt: { tokens: 5, apiCalls: 1, computeMs: 50 },
      },
      estimateAttemptCost: () => ({ tokens: 6, apiCalls: 1, computeMs: 50 }),
      sleep: async () => {},
    })).rejects.toBeInstanceOf(RetryOrchestrationError);

    expect(calls).toBe(1);
    const context = contextTracker.getContext({ runId: "run-3" as string, nodeId: "node-budget" });
    expect(context!.status).toBe("exhausted");
    expect(context!.attempts).toHaveLength(1);
  });

  it("marks exhausted when runtime retry budget denies next retry", async () => {
    const classifier = createFailureClassifier(classifierConfig);
    const strategyEngine = createRetryStrategyEngine(strategyConfig);
    const contextTracker = createRetryContextTracker(contextConfig);
    const retryBudget = createRetryBudget(
      { maxTokens: 0, refillRatePerSecond: 0, maxConcurrent: 1 },
      () => 1000,
    );
    const orchestrator = createRetryOrchestrator({
      classifier,
      strategyEngine,
      contextTracker,
      retryBudget,
      nowIso: contextConfig.nowIso,
    });

    let calls = 0;
    await expect(orchestrator.retryWithPolicy(async () => {
      calls++;
      throw { errorCode: "ECONNRESET", errorMessage: "fail once" };
    }, {
      runId: "run-4" as string,
      workflowId: "wf-1" as string,
      nodeId: "node-runtime-budget",
      strategies: [makeTransientStrategy({ maxAttempts: 5 })],
      costBudget: defaultCostBudget,
      sleep: async () => {},
    })).rejects.toThrow("Retry budget denied permit");

    expect(calls).toBe(1);
    const context = contextTracker.getContext({
      runId: "run-4" as string,
      nodeId: "node-runtime-budget",
    });
    expect(context!.status).toBe("exhausted");
  });

  it("does not schedule another retry when projected next attempt exceeds total budget", async () => {
    const classifier = createFailureClassifier(classifierConfig);
    const strategyEngine = createRetryStrategyEngine(strategyConfig);
    const contextTracker = createRetryContextTracker(contextConfig);
    const orchestrator = createRetryOrchestrator({
      classifier,
      strategyEngine,
      contextTracker,
      nowIso: contextConfig.nowIso,
    });

    let calls = 0;
    await expect(orchestrator.retryWithPolicy(async () => {
      calls++;
      throw { errorCode: "ECONNRESET", errorMessage: "retry me" };
    }, {
      runId: "run-5" as string,
      workflowId: "wf-1" as string,
      nodeId: "node-projected-budget",
      strategies: [makeTransientStrategy({ maxAttempts: 5 })],
      costBudget: {
        maxTotalTokens: 15,
        maxTotalApiCalls: 10,
        maxTotalComputeMs: 1_000,
      },
      estimateAttemptCost: () => ({ tokens: 10, apiCalls: 1, computeMs: 50 }),
      sleep: async () => {},
    })).rejects.toThrow("Retry cost budget exceeded");

    expect(calls).toBe(1);
    const context = contextTracker.getContext({
      runId: "run-5" as string,
      nodeId: "node-projected-budget",
    });
    expect(context).toBeDefined();
    expect(context!.status).toBe("exhausted");
    expect(context!.attempts).toHaveLength(1);
    expect(context!.accumulatedCost.tokens).toBe(10);
  });

  it("marks context exhausted before safety-limit throw", async () => {
    const classifier = createFailureClassifier(classifierConfig);
    const strategyEngine = createRetryStrategyEngine(strategyConfig);
    const contextTracker = createRetryContextTracker(contextConfig);
    const orchestrator = createRetryOrchestrator({
      classifier,
      strategyEngine,
      contextTracker,
      nowIso: contextConfig.nowIso,
    });

    let calls = 0;
    await expect(orchestrator.retryWithPolicy(async () => {
      calls++;
      throw { errorCode: "ECONNRESET", errorMessage: "retry me" };
    }, {
      runId: "run-6" as string,
      workflowId: "wf-1" as string,
      nodeId: "node-safety-limit",
      strategies: [makeTransientStrategy({ maxAttempts: 5 })],
      costBudget: defaultCostBudget,
      maxExecutionAttempts: 1,
      sleep: async () => {},
    })).rejects.toThrow("Retry loop exceeded safety limit (1 attempts)");

    expect(calls).toBe(1);
    const context = contextTracker.getContext({
      runId: "run-6" as string,
      nodeId: "node-safety-limit",
    });
    expect(context).toBeDefined();
    expect(context!.status).toBe("exhausted");
    expect(context!.attempts).toHaveLength(1);
  });
});
