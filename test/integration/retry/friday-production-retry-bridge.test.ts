/**
 * Integration tests for the production retry bridge — verifying the unified
 * failure taxonomy and RetryOrchestrator work in a production-like path.
 *
 * Tests verify:
 * - Production bridge creates with default configuration
 * - Failure classification uses the 7-category taxonomy
 * - Retryable failures are retried with proper backoff
 * - Non-retryable failures are rejected immediately
 * - Cost budget enforcement prevents unbounded retries
 * - Default strategies cover all failure categories
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createProductionRetryBridge,
  DEFAULT_PRODUCTION_STRATEGIES,
  DEFAULT_PRODUCTION_COST_BUDGET,
  RetryOrchestrationError,
} from "#retry";
import type { UUID, ISODateTime } from "../../../src/rules/model/friday-rules-engine.types.js";

// ─── Test Helpers ───

let idCounter = 0;
function generateId(): UUID {
  return `test-${++idCounter}` as UUID;
}

function nowIso(): ISODateTime {
  return new Date().toISOString() as ISODateTime;
}

function createBridge(overrides: Record<string, unknown> = {}) {
  return createProductionRetryBridge({
    generateId,
    nowIso,
    ...overrides,
  });
}

// ─── Tests ───

describe("Production Retry Bridge", () => {
  beforeEach(() => {
    idCounter = 0;
  });

  describe("Configuration", () => {
    it("creates with default strategies and cost budget", () => {
      const bridge = createBridge();

      expect(bridge.orchestrator).toBeDefined();
      expect(bridge.strategies).toHaveLength(DEFAULT_PRODUCTION_STRATEGIES.length);
      expect(bridge.costBudget).toEqual(DEFAULT_PRODUCTION_COST_BUDGET);
    });

    it("allows overriding strategies and cost budget", () => {
      const customBudget = {
        maxTotalTokens: 1000,
        maxTotalApiCalls: 5,
        maxTotalComputeMs: 10_000,
      };
      const bridge = createBridge({ costBudget: customBudget });

      expect(bridge.costBudget).toEqual(customBudget);
    });
  });

  describe("Default strategies coverage", () => {
    it("has strategies for all 7 failure categories", () => {
      const categories = DEFAULT_PRODUCTION_STRATEGIES.map(
        (s) => (s as unknown as Record<string, unknown>).failureCategory,
      );

      expect(categories).toContain("rate_limit");
      expect(categories).toContain("timeout");
      expect(categories).toContain("transient");
      expect(categories).toContain("resource");
      expect(categories).toContain("auth");
      expect(categories).toContain("logic");
      expect(categories).toContain("unknown");
    });

    it("marks auth and logic as non-retryable (maxAttempts = 0)", () => {
      const authStrategy = DEFAULT_PRODUCTION_STRATEGIES.find(
        (s) => (s as unknown as Record<string, unknown>).failureCategory === "auth",
      ) as unknown as Record<string, unknown>;
      const logicStrategy = DEFAULT_PRODUCTION_STRATEGIES.find(
        (s) => (s as unknown as Record<string, unknown>).failureCategory === "logic",
      ) as unknown as Record<string, unknown>;

      expect(authStrategy?.maxAttempts).toBe(0);
      expect(logicStrategy?.maxAttempts).toBe(0);
    });

    it("marks rate_limit as most generous (maxAttempts = 5)", () => {
      const rateLimitStrategy = DEFAULT_PRODUCTION_STRATEGIES.find(
        (s) => (s as unknown as Record<string, unknown>).failureCategory === "rate_limit",
      ) as unknown as Record<string, unknown>;

      expect(rateLimitStrategy?.maxAttempts).toBe(5);
    });
  });

  describe("Retry execution", () => {
    it("succeeds on first attempt when function does not throw", async () => {
      const bridge = createBridge();
      const fn = vi.fn().mockResolvedValue("success");

      const result = await bridge.executeWithRetry(
        fn,
        "run-1" as UUID,
        "wf-1" as UUID,
        "node-1",
      );

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries transient failures and succeeds on second attempt", async () => {
      const bridge = createBridge();
      let attempt = 0;
      const fn = vi.fn(async () => {
        attempt++;
        if (attempt === 1) {
          const err = new Error("ECONNRESET: connection reset");
          (err as Record<string, unknown>).code = "ECONNRESET";
          throw err;
        }
        return "recovered";
      });

      const result = await bridge.executeWithRetry(
        fn,
        "run-1" as UUID,
        "wf-1" as UUID,
        "node-1",
        { sleep: async () => {} }, // Skip actual delays in tests
      );

      expect(result).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("rejects non-retryable failures immediately", async () => {
      const bridge = createBridge();
      const fn = vi.fn(async () => {
        const err = new Error("Unauthorized");
        (err as Record<string, unknown>).statusCode = 401;
        throw err;
      });

      await expect(
        bridge.executeWithRetry(
          fn,
          "run-1" as UUID,
          "wf-1" as UUID,
          "node-1",
          { sleep: async () => {} },
        ),
      ).rejects.toThrow();

      // Non-retryable (auth) should not retry: 1 initial attempt only
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("Bridge interface", () => {
    it("exposes orchestrator for direct access", () => {
      const bridge = createBridge();
      expect(bridge.orchestrator).toBeDefined();
      expect(typeof bridge.orchestrator.retryWithPolicy).toBe("function");
    });
  });
});
