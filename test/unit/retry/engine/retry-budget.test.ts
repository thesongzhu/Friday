import { describe, it, expect, beforeEach } from "vitest";

import {
  createRetryBudget,
  DEFAULT_RETRY_BUDGET_CONFIG,
} from "../../../../src/retry/engine/retry-budget.js";

import type { RetryBudgetConfig } from "../../../../src/retry/engine/retry-budget.js";

// ─── Helpers ───

function createTestBudget(
  config?: Partial<RetryBudgetConfig>,
  startTime: number = 1000000,
) {
  let currentTime = startTime;
  const budget = createRetryBudget(
    { ...DEFAULT_RETRY_BUDGET_CONFIG, ...config },
    () => currentTime,
  );

  return {
    budget,
    advanceTime(ms: number) {
      currentTime += ms;
    },
    getTime() {
      return currentTime;
    },
  };
}

// ─── Tests ───

describe("RetryBudget", () => {
  describe("DEFAULT_RETRY_BUDGET_CONFIG", () => {
    it("has sensible defaults", () => {
      expect(DEFAULT_RETRY_BUDGET_CONFIG.maxTokens).toBe(20);
      expect(DEFAULT_RETRY_BUDGET_CONFIG.refillRatePerSecond).toBe(2);
      expect(DEFAULT_RETRY_BUDGET_CONFIG.maxConcurrent).toBe(10);
    });
  });

  describe("acquire / release", () => {
    it("allows acquire when tokens are available", () => {
      const { budget } = createTestBudget({ maxTokens: 5, maxConcurrent: 10 });
      expect(budget.acquire()).toBe(true);
    });

    it("decrements available tokens on acquire", () => {
      const { budget } = createTestBudget({ maxTokens: 3, maxConcurrent: 10, refillRatePerSecond: 0 });

      budget.acquire();
      budget.acquire();
      const snap = budget.getSnapshot();
      expect(snap.availableTokens).toBe(1);
    });

    it("denies acquire when all tokens are consumed", () => {
      const { budget } = createTestBudget({ maxTokens: 2, maxConcurrent: 10, refillRatePerSecond: 0 });

      expect(budget.acquire()).toBe(true);
      expect(budget.acquire()).toBe(true);
      expect(budget.acquire()).toBe(false);
    });

    it("denies acquire when concurrent limit is reached", () => {
      const { budget } = createTestBudget({ maxTokens: 20, maxConcurrent: 2, refillRatePerSecond: 0 });

      expect(budget.acquire()).toBe(true);
      expect(budget.acquire()).toBe(true);
      expect(budget.acquire()).toBe(false); // concurrent limit

      budget.release();
      expect(budget.acquire()).toBe(true); // concurrent slot freed
    });

    it("release decrements active retry count", () => {
      const { budget } = createTestBudget();
      budget.acquire();
      budget.acquire();
      expect(budget.getSnapshot().activeRetries).toBe(2);

      budget.release();
      expect(budget.getSnapshot().activeRetries).toBe(1);
    });

    it("release does not go below zero", () => {
      const { budget } = createTestBudget();
      budget.release();
      budget.release();
      expect(budget.getSnapshot().activeRetries).toBe(0);
    });
  });

  describe("token refill", () => {
    it("refills tokens over time", () => {
      const { budget, advanceTime } = createTestBudget({
        maxTokens: 10,
        refillRatePerSecond: 2,
        maxConcurrent: 10,
      });

      // Consume all tokens.
      for (let i = 0; i < 10; i++) {
        budget.acquire();
      }
      // Release all concurrent locks.
      for (let i = 0; i < 10; i++) {
        budget.release();
      }

      expect(budget.getSnapshot().availableTokens).toBe(0);

      // Advance 1 second → should refill 2 tokens.
      advanceTime(1000);
      expect(budget.getSnapshot().availableTokens).toBe(2);
    });

    it("does not exceed maxTokens on refill", () => {
      const { budget, advanceTime } = createTestBudget({
        maxTokens: 5,
        refillRatePerSecond: 10,
        maxConcurrent: 10,
      });

      // Already at max tokens.
      advanceTime(10000); // Would add 100 tokens if uncapped.
      expect(budget.getSnapshot().availableTokens).toBe(5);
    });

    it("refills fractional tokens over short intervals", () => {
      const { budget, advanceTime } = createTestBudget({
        maxTokens: 10,
        refillRatePerSecond: 2,
        maxConcurrent: 10,
      });

      // Consume all.
      for (let i = 0; i < 10; i++) budget.acquire();
      for (let i = 0; i < 10; i++) budget.release();

      // Advance 500ms → 1 token.
      advanceTime(500);
      expect(budget.getSnapshot().availableTokens).toBe(1);
    });
  });

  describe("canAcquire", () => {
    it("returns true when acquire would succeed", () => {
      const { budget } = createTestBudget({ maxTokens: 5, maxConcurrent: 10 });
      expect(budget.canAcquire()).toBe(true);
    });

    it("returns false when tokens are exhausted", () => {
      const { budget } = createTestBudget({ maxTokens: 1, maxConcurrent: 10, refillRatePerSecond: 0 });
      budget.acquire();
      expect(budget.canAcquire()).toBe(false);
    });

    it("does not consume a token", () => {
      const { budget } = createTestBudget({ maxTokens: 2, maxConcurrent: 10, refillRatePerSecond: 0 });
      budget.canAcquire();
      budget.canAcquire();
      budget.canAcquire();
      expect(budget.getSnapshot().availableTokens).toBe(2);
    });
  });

  describe("getSnapshot", () => {
    it("tracks totalGranted and totalDenied", () => {
      const { budget } = createTestBudget({ maxTokens: 2, maxConcurrent: 10, refillRatePerSecond: 0 });

      budget.acquire(); // granted
      budget.acquire(); // granted
      budget.acquire(); // denied

      const snap = budget.getSnapshot();
      expect(snap.totalGranted).toBe(2);
      expect(snap.totalDenied).toBe(1);
    });
  });

  describe("reset", () => {
    it("restores budget to initial state", () => {
      const { budget } = createTestBudget({ maxTokens: 5, maxConcurrent: 10, refillRatePerSecond: 0 });

      budget.acquire();
      budget.acquire();
      budget.acquire();

      budget.reset();
      const snap = budget.getSnapshot();
      expect(snap.availableTokens).toBe(5);
      expect(snap.activeRetries).toBe(0);
      expect(snap.totalGranted).toBe(0);
      expect(snap.totalDenied).toBe(0);
    });
  });
});
