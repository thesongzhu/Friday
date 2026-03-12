import { describe, it, expect } from "vitest";
import { createFridayWorkflowRetryManager } from "#workflows";
import type { FridayWorkflowRunNodeEntity } from "#workflows";
import type { FridayNodeRetryPolicy } from "#workflows";

describe("FridayWorkflowRetryManager", () => {
  let idCounter = 0;
  const manager = createFridayWorkflowRetryManager({
    idGenerator: () => `attempt-${String(++idCounter).padStart(4, "0")}`,
    randomFn: () => 0.5, // Fixed random for deterministic tests
  });

  function makeAttempt(
    attempt: number,
  ): FridayWorkflowRunNodeEntity {
    return {
      id: "node-attempt-1",
      runId: "run-1",
      nodeId: "node-1",
      attempt,
      attemptId: "attempt-1",
      status: "failed",
      idempotencyKey: `wfrun:run-1:node:node-1:attempt:${attempt}`,
      createdAt: "2025-01-15T10:00:00.000Z",
      updatedAt: "2025-01-15T10:00:00.000Z",
    };
  }

  const defaultPolicy: FridayNodeRetryPolicy = {
    maxAttempts: 3,
    backoff: "exponential",
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    retryOn: ["NODE_EXECUTION_FAILED", "NODE_TIMEOUT"],
  };

  it("returns shouldRetry=false when no retry policy", () => {
    const decision = manager.evaluateRetry(makeAttempt(1), undefined, "ERROR");
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toBe("no retry policy");
  });

  it("returns shouldRetry=true when under max attempts", () => {
    const decision = manager.evaluateRetry(
      makeAttempt(1),
      defaultPolicy,
      "NODE_EXECUTION_FAILED",
    );
    expect(decision.shouldRetry).toBe(true);
    expect(decision.nextAttemptNumber).toBe(2);
    expect(decision.reason).toBe("retry eligible");
  });

  it("returns shouldRetry=false when at max attempts", () => {
    const decision = manager.evaluateRetry(
      makeAttempt(3),
      defaultPolicy,
      "NODE_EXECUTION_FAILED",
    );
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toBe("max attempts exceeded");
  });

  it("returns shouldRetry=false when error code not in retryOn", () => {
    const decision = manager.evaluateRetry(
      makeAttempt(1),
      defaultPolicy,
      "SOME_OTHER_ERROR",
    );
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toBe("error code not in retryOn list");
  });

  it("computes fixed backoff correctly", () => {
    const fixedPolicy: FridayNodeRetryPolicy = {
      maxAttempts: 3,
      backoff: "fixed",
      baseDelayMs: 500,
      maxDelayMs: 5000,
      retryOn: [],
    };
    expect(manager.computeBackoffMs(1, fixedPolicy)).toBe(500);
    expect(manager.computeBackoffMs(2, fixedPolicy)).toBe(500);
  });

  it("computes exponential backoff with doubling", () => {
    // With fixed random of 0.5, jitter = delay * 0.25 * (0.5*2-1) = 0
    // So delay is exact exponential
    const delay1 = manager.computeBackoffMs(1, defaultPolicy); // 1000 * 2^0 = 1000
    const delay2 = manager.computeBackoffMs(2, defaultPolicy); // 1000 * 2^1 = 2000
    const delay3 = manager.computeBackoffMs(3, defaultPolicy); // 1000 * 2^2 = 4000

    expect(delay1).toBe(1000);
    expect(delay2).toBe(2000);
    expect(delay3).toBe(4000);
  });

  it("caps exponential backoff at maxDelayMs", () => {
    const delay = manager.computeBackoffMs(10, defaultPolicy);
    expect(delay).toBeLessThanOrEqual(defaultPolicy.maxDelayMs);
  });

  it("computes no backoff correctly", () => {
    const nonePolicy: FridayNodeRetryPolicy = {
      maxAttempts: 3,
      backoff: "none",
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      retryOn: [],
    };
    expect(manager.computeBackoffMs(1, nonePolicy)).toBe(0);
  });

  it("generates correct idempotency key format", () => {
    const key = manager.generateIdempotencyKey("run-1", "node-1", 2);
    expect(key).toBe("wfrun:run-1:node:node-1:attempt:2");
  });

  it("generates unique attempt ids", () => {
    const id1 = manager.generateAttemptId();
    const id2 = manager.generateAttemptId();
    expect(id1).not.toBe(id2);
  });

  it("empty retryOn list means all errors retryable", () => {
    expect(
      manager.isRetryableError("ANY_ERROR", []),
    ).toBe(true);
  });

  it("non-empty retryOn list matches specific codes", () => {
    expect(
      manager.isRetryableError("NODE_TIMEOUT", ["NODE_TIMEOUT"]),
    ).toBe(true);
    expect(
      manager.isRetryableError("OTHER", ["NODE_TIMEOUT"]),
    ).toBe(false);
  });
});
