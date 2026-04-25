/**
 * A-005 Unified Retry Bridge Tests
 *
 * Validates failure taxonomy mapping, retry decisions, budget enforcement,
 * circuit breaker, DLQ escalation, and trace event emission.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWorkflowUnifiedRetryBridge,
  classifyWorkflowError,
  type WorkflowRetryTrace,
} from "../../../../src/workflows/engine/friday-workflow-unified-retry-bridge.js";

describe("A-005 classifyWorkflowError", () => {
  it("classifies schema/validation errors as logic", () => {
    expect(classifyWorkflowError("SCHEMA_VALIDATION_FAILED")).toBe("logic");
    expect(classifyWorkflowError("INVALID_JSON")).toBe("logic");
    expect(classifyWorkflowError("PARSE_ERROR")).toBe("logic");
  });

  it("classifies quality errors as logic", () => {
    expect(classifyWorkflowError("QUALITY_CHECK_FAILED")).toBe("logic");
    expect(classifyWorkflowError("ACCEPTANCE_FAILED")).toBe("logic");
  });

  it("classifies policy errors as auth", () => {
    expect(classifyWorkflowError("POLICY_DENIED")).toBe("auth");
    expect(classifyWorkflowError("RULES_DENIED")).toBe("auth");
    expect(classifyWorkflowError("FORBIDDEN")).toBe("auth");
  });

  it("classifies budget errors as rate_limit", () => {
    expect(classifyWorkflowError("BUDGET_EXCEEDED")).toBe("rate_limit");
    expect(classifyWorkflowError("RATE_LIMIT_HIT")).toBe("rate_limit");
    expect(classifyWorkflowError("COST_LIMIT")).toBe("rate_limit");
  });

  it("keeps 429/rate-limit provider wrappers retryable instead of auth", () => {
    expect(classifyWorkflowError(
      "PROVIDER_AUTH_INVALID",
      "429 rate limit exceeded while refreshing auth profile",
    )).toBe("rate_limit");
    expect(classifyWorkflowError(
      "POLICY_DENIED",
      "Too many requests from upstream",
    )).toBe("rate_limit");
  });

  it("classifies timeout errors as timeout", () => {
    expect(classifyWorkflowError("TIMEOUT")).toBe("timeout");
    expect(classifyWorkflowError("REQUEST_TIMEOUT")).toBe("timeout");
  });

  it("classifies tool/network errors as transient", () => {
    expect(classifyWorkflowError("TOOL_EXECUTION_FAILED")).toBe("transient");
    expect(classifyWorkflowError("CONNECTION_REFUSED")).toBe("transient");
  });

  it("classifies missing-skill node execution failures as logic instead of unknown", () => {
    expect(
      classifyWorkflowError(
        "NODE_EXECUTION_FAILED",
        "NODE_EXECUTION_FAILED: skill 'missing-skill' not found",
      ),
    ).toBe("logic");
  });

  it("defaults to unknown for unrecognized errors", () => {
    expect(classifyWorkflowError("UNKNOWN_ERROR")).toBe("unknown");
    expect(classifyWorkflowError("INTERNAL")).toBe("unknown");
  });
});

describe("A-005 WorkflowUnifiedRetryBridge", () => {
  let onRetryTrace: ReturnType<typeof vi.fn>;
  let onDlqEscalation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onRetryTrace = vi.fn();
    onDlqEscalation = vi.fn();
  });

  function makeBridge(overrides: Record<string, unknown> = {}) {
    return createWorkflowUnifiedRetryBridge({
      maxAttempts: 3,
      baseDelayMs: 100,
      retryBudgetMax: 5,
      circuitBreakerThreshold: 3,
      onRetryTrace,
      onDlqEscalation,
      nowIso: () => "2026-01-01T00:00:00Z",
      ...overrides,
    });
  }

  describe("retry decisions", () => {
    it("allows retry for timeout errors under budget", () => {
      const bridge = makeBridge();
      const decision = bridge.evaluateRetry({
        runId: "r-1", nodeId: "n-1", attempt: 1,
        errorCode: "TIMEOUT", errorMessage: "connection timed out",
      });

      expect(decision.shouldRetry).toBe(true);
      expect(decision.category).toBe("timeout");
      expect(decision.delayMs).toBe(100); // 100 * 2^0
    });

    it("allows retry for transient errors under budget", () => {
      const bridge = makeBridge();
      const decision = bridge.evaluateRetry({
        runId: "r-1", nodeId: "n-1", attempt: 1,
        errorCode: "TOOL_EXECUTION_FAILED",
      });

      expect(decision.shouldRetry).toBe(true);
      expect(decision.category).toBe("transient");
    });

    it("applies exponential backoff", () => {
      const bridge = makeBridge();

      const d1 = bridge.evaluateRetry({ runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "TIMEOUT" });
      expect(d1.delayMs).toBe(100);

      const d2 = bridge.evaluateRetry({ runId: "r-1", nodeId: "n-1", attempt: 2, errorCode: "TIMEOUT" });
      expect(d2.delayMs).toBe(200);
    });

    it("denies retry for logic errors (non-retryable)", () => {
      const bridge = makeBridge();
      const decision = bridge.evaluateRetry({
        runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "SCHEMA_ERROR",
      });

      expect(decision.shouldRetry).toBe(false);
      expect(decision.category).toBe("logic");
      expect(decision.escalateToDlq).toBe(true);
    });

    it("denies retry for auth errors (non-retryable)", () => {
      const bridge = makeBridge();
      const decision = bridge.evaluateRetry({
        runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "POLICY_DENIED",
      });

      expect(decision.shouldRetry).toBe(false);
      expect(decision.category).toBe("auth");
    });

    it("denies retry for unknown errors (non-retryable)", () => {
      const bridge = makeBridge();
      const decision = bridge.evaluateRetry({
        runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "INTERNAL",
      });

      expect(decision.shouldRetry).toBe(false);
      expect(decision.category).toBe("unknown");
    });

    it("denies retry when max attempts reached", () => {
      const bridge = makeBridge();
      const decision = bridge.evaluateRetry({
        runId: "r-1", nodeId: "n-1", attempt: 3, errorCode: "TIMEOUT",
      });

      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toBe("max attempts reached");
      expect(decision.escalateToDlq).toBe(true);
    });
  });

  describe("retry budget", () => {
    it("enforces retry budget limit", () => {
      const bridge = makeBridge({ retryBudgetMax: 2 });

      bridge.evaluateRetry({ runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "TIMEOUT" });
      bridge.evaluateRetry({ runId: "r-1", nodeId: "n-2", attempt: 1, errorCode: "TIMEOUT" });

      const decision = bridge.evaluateRetry({ runId: "r-1", nodeId: "n-3", attempt: 1, errorCode: "TIMEOUT" });
      expect(decision.shouldRetry).toBe(false);
      expect(decision.budgetExhausted).toBe(true);
    });

    it("reports remaining budget", () => {
      const bridge = makeBridge({ retryBudgetMax: 5 });
      expect(bridge.getRetryBudgetMax()).toBe(5);
      expect(bridge.getRetryBudgetUsed("r-1")).toBe(0);
      expect(bridge.getRetryBudgetRemaining("r-1")).toBe(5);

      bridge.evaluateRetry({ runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "TIMEOUT" });
      expect(bridge.getRetryBudgetUsed("r-1")).toBe(1);
      expect(bridge.getRetryBudgetRemaining("r-1")).toBe(4);
    });

    it("isolates budget per run", () => {
      const bridge = makeBridge({ retryBudgetMax: 2 });
      bridge.evaluateRetry({ runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "TIMEOUT" });
      bridge.evaluateRetry({ runId: "r-1", nodeId: "n-2", attempt: 1, errorCode: "TIMEOUT" });

      // Different run should have its own budget
      const decision = bridge.evaluateRetry({ runId: "r-2", nodeId: "n-1", attempt: 1, errorCode: "TIMEOUT" });
      expect(decision.shouldRetry).toBe(true);
    });
  });

  describe("circuit breaker", () => {
    it("opens circuit after threshold consecutive failures", () => {
      const bridge = makeBridge({ circuitBreakerThreshold: 3 });

      bridge.recordAttempt({ runId: "r-1", nodeId: "n-1", attempt: 1, category: "transient", success: false });
      bridge.recordAttempt({ runId: "r-1", nodeId: "n-1", attempt: 2, category: "transient", success: false });
      bridge.recordAttempt({ runId: "r-1", nodeId: "n-1", attempt: 3, category: "transient", success: false });

      expect(bridge.getCircuitBreakerThreshold()).toBe(3);
      expect(bridge.getConsecutiveFailures("n-1")).toBe(3);
      expect(bridge.isCircuitOpen("n-1")).toBe(true);

      const decision = bridge.evaluateRetry({ runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "TIMEOUT" });
      expect(decision.shouldRetry).toBe(false);
      expect(decision.circuitOpen).toBe(true);
    });

    it("resets consecutive failures on success", () => {
      const bridge = makeBridge({ circuitBreakerThreshold: 3 });

      bridge.recordAttempt({ runId: "r-1", nodeId: "n-1", attempt: 1, category: "transient", success: false });
      bridge.recordAttempt({ runId: "r-1", nodeId: "n-1", attempt: 2, category: "transient", success: false });
      bridge.recordAttempt({ runId: "r-1", nodeId: "n-1", attempt: 3, category: "transient", success: true });

      expect(bridge.getConsecutiveFailures("n-1")).toBe(0);
      expect(bridge.isCircuitOpen("n-1")).toBe(false);
    });
  });

  describe("DLQ escalation", () => {
    it("calls onDlqEscalation when retry is exhausted", () => {
      const bridge = makeBridge();
      bridge.evaluateRetry({ runId: "r-1", nodeId: "n-1", attempt: 3, errorCode: "TIMEOUT" });

      expect(onDlqEscalation).toHaveBeenCalledOnce();
      expect(onDlqEscalation.mock.calls[0][0].decision.escalateToDlq).toBe(true);
    });

    it("calls onDlqEscalation for non-retryable errors", () => {
      const bridge = makeBridge();
      bridge.evaluateRetry({ runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "SCHEMA_ERROR" });

      expect(onDlqEscalation).toHaveBeenCalledOnce();
    });
  });

  describe("retry trace events", () => {
    it("emits trace for every retry evaluation", () => {
      const bridge = makeBridge();
      bridge.evaluateRetry({
        runId: "r-1",
        nodeId: "n-1",
        attempt: 1,
        errorCode: "TIMEOUT",
        errorMessage: "connection timed out",
      });

      expect(onRetryTrace).toHaveBeenCalledOnce();
      const trace: WorkflowRetryTrace = onRetryTrace.mock.calls[0][0];
      expect(trace.runId).toBe("r-1");
      expect(trace.category).toBe("timeout");
      expect(trace.errorMessage).toBe("connection timed out");
      expect(trace.timestamp).toBe("2026-01-01T00:00:00Z");
    });

    it("records traces queryable by runId", () => {
      const bridge = makeBridge();
      bridge.evaluateRetry({ runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "TIMEOUT" });
      bridge.evaluateRetry({ runId: "r-2", nodeId: "n-1", attempt: 1, errorCode: "TOOL_FAIL" });

      expect(bridge.getTraces("r-1")).toHaveLength(1);
      expect(bridge.getTraces("r-2")).toHaveLength(1);
    });
  });

  describe("storm / adversarial", () => {
    it("bounded retries under rapid failure storm", () => {
      const bridge = makeBridge({ retryBudgetMax: 3, maxAttempts: 5 });
      let retriesAllowed = 0;

      for (let i = 0; i < 20; i++) {
        const d = bridge.evaluateRetry({
          runId: "r-storm", nodeId: `n-${i % 3}`, attempt: 1, errorCode: "TIMEOUT",
        });
        if (d.shouldRetry) retriesAllowed++;
      }

      expect(retriesAllowed).toBeLessThanOrEqual(3);
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      const bridge = makeBridge();
      bridge.evaluateRetry({ runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "TIMEOUT" });
      bridge.recordAttempt({ runId: "r-1", nodeId: "n-1", attempt: 1, category: "transient", success: false });

      bridge.reset();

      expect(bridge.getRetryBudgetRemaining("r-1")).toBe(5);
      expect(bridge.isCircuitOpen("n-1")).toBe(false);
      expect(bridge.getTraces("r-1")).toHaveLength(0);
    });
  });
});
