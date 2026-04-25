/**
 * A-005 Unified Retry Bridge — integrates the unified RetryOrchestrator
 * and FailureClassifier from src/retry into the workflow run path.
 *
 * Maps runtime errors to the canonical failure taxonomy
 * (SCHEMA/QUALITY/POLICY/TOOL/BUDGET/LOGIC), applies retry strategies
 * with budget/circuit-breaker enforcement, and escalates exhausted
 * retries to the dead-letter queue.
 *
 * @module workflows/engine
 */

import type {
  FridayClassifiedFailure,
  FridayFailureCategory,
} from "#retry";
import type { UUID } from "../model/friday-workflow.types.js";

// ─── Failure Taxonomy Mapping ───

/** Map common error codes/patterns to the unified failure taxonomy. */
export function classifyWorkflowError(
  errorCode: string,
  errorMessage?: string,
): FridayFailureCategory {
  const code = errorCode.toUpperCase();
  const msg = (errorMessage ?? "").toUpperCase();

  // Hard provider throttling signals must stay retryable even when the text
  // also includes broad auth/policy wording from an upstream wrapper.
  if (
    code.includes("RATE_LIMIT")
    || code.includes("THROTTLED")
    || code.includes("TOO_MANY_REQUESTS")
    || msg.includes("429")
    || msg.includes("RATE LIMIT")
    || msg.includes("RATE_LIMIT")
    || msg.includes("TOO MANY REQUESTS")
    || msg.includes("THROTTL")
  ) {
    return "rate_limit";
  }

  // Schema / validation / parse errors → logic (non-retryable)
  if (code.includes("SCHEMA") || code.includes("VALIDATION") || code.includes("PARSE") || code.includes("INVALID_JSON")) {
    return "logic";
  }

  // Quality / acceptance errors → logic (non-retryable)
  if (code.includes("QUALITY") || code.includes("ACCEPTANCE") || msg.includes("LOW SCORE") || msg.includes("QUALITY")) {
    return "logic";
  }

  // Policy / authorization errors → auth (non-retryable)
  if (code.includes("POLICY") || code.includes("DENIED") || code.includes("FORBIDDEN") || code.includes("RULES")) {
    return "auth";
  }

  // Budget / quota errors → rate_limit (retryable with backoff)
  if (code.includes("BUDGET") || code.includes("QUOTA") || code.includes("COST")) {
    return "rate_limit";
  }

  // Timeout errors → timeout (retryable)
  if (code.includes("TIMEOUT")) {
    return "timeout";
  }

  // Tool / network errors → transient (retryable)
  if (code.includes("TOOL") || code.includes("NETWORK") || code.includes("CONNECTION") || code.includes("ECONNREFUSED")) {
    return "transient";
  }

  if (code.includes("NODE_EXECUTION_FAILED")) {
    if (
      msg.includes("NOT FOUND")
      || msg.includes("MISSING")
      || msg.includes("UNKNOWN NODE TYPE")
      || msg.includes("UNSUPPORTED")
      || msg.includes("INVALID")
    ) {
      return "logic";
    }
    return "transient";
  }

  // Unknown catch-all (non-retryable by default)
  return "unknown";
}

// ─── Retry Bridge Types ───

export interface WorkflowRetryDecision {
  shouldRetry: boolean;
  category: FridayFailureCategory;
  delayMs: number;
  attempt: number;
  maxAttempts: number;
  reason: string;
  budgetExhausted: boolean;
  circuitOpen: boolean;
  escalateToDlq: boolean;
}

export interface WorkflowRetryTrace {
  runId: UUID;
  nodeId: string;
  attempt: number;
  category: FridayFailureCategory;
  decision: WorkflowRetryDecision;
  errorCode: string;
  errorMessage?: string;
  timestamp: string;
}

// ─── Dependencies ───

export interface WorkflowRetryBridgeDeps {
  /** Max retry attempts per node. Default: 3. */
  maxAttempts?: number;
  /** Base delay in ms for backoff. Default: 1000. */
  baseDelayMs?: number;
  /** Retry budget: max total retries across all nodes in a run. Default: 10. */
  retryBudgetMax?: number;
  /** Circuit breaker: open after N consecutive failures on same node. Default: 5. */
  circuitBreakerThreshold?: number;
  /** Callback to emit retry trace events. */
  onRetryTrace?: (trace: WorkflowRetryTrace) => void;
  /** Callback when retry is escalated to DLQ. */
  onDlqEscalation?: (trace: WorkflowRetryTrace) => void;
  /** Clock function. */
  nowIso?: () => string;
}

// ─── Interface ───

export interface FridayWorkflowUnifiedRetryBridge {
  evaluateRetry(params: {
    runId: UUID;
    nodeId: string;
    attempt: number;
    errorCode: string;
    errorMessage?: string;
  }): WorkflowRetryDecision;

  recordAttempt(params: {
    runId: UUID;
    nodeId: string;
    attempt: number;
    category: FridayFailureCategory;
    success: boolean;
  }): void;

  getRetryBudgetMax(): number;
  getRetryBudgetUsed(runId: UUID): number;
  getRetryBudgetRemaining(runId: UUID): number;
  getCircuitBreakerThreshold(): number;
  getConsecutiveFailures(nodeId: string): number;
  isCircuitOpen(nodeId: string): boolean;
  getTraces(runId: UUID): WorkflowRetryTrace[];
  reset(): void;
}

// ─── Factory ───

export function createWorkflowUnifiedRetryBridge(
  deps: WorkflowRetryBridgeDeps = {},
): FridayWorkflowUnifiedRetryBridge {
  const maxAttempts = deps.maxAttempts ?? 3;
  const baseDelayMs = deps.baseDelayMs ?? 1000;
  const retryBudgetMax = deps.retryBudgetMax ?? 10;
  const circuitBreakerThreshold = deps.circuitBreakerThreshold ?? 5;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  // State
  const budgetUsed = new Map<string, number>(); // runId -> count
  const consecutiveFailures = new Map<string, number>(); // nodeId -> count
  const traces: WorkflowRetryTrace[] = [];

  function getBudgetUsed(runId: string): number {
    return budgetUsed.get(runId) ?? 0;
  }

  function getConsecutiveFailures(nodeId: string): number {
    return consecutiveFailures.get(nodeId) ?? 0;
  }

  return {
    evaluateRetry(params) {
      const { runId, nodeId, attempt, errorCode, errorMessage } = params;
      const category = classifyWorkflowError(errorCode, errorMessage);

      // Check attempt limit
      if (attempt >= maxAttempts) {
        const decision: WorkflowRetryDecision = {
          shouldRetry: false, category, delayMs: 0,
          attempt, maxAttempts, reason: "max attempts reached",
          budgetExhausted: false, circuitOpen: false, escalateToDlq: true,
        };
        const trace: WorkflowRetryTrace = { runId, nodeId, attempt, category, decision, errorCode, errorMessage, timestamp: nowIso() };
        traces.push(trace);
        deps.onRetryTrace?.(trace);
        deps.onDlqEscalation?.(trace);
        return decision;
      }

      // Check circuit breaker
      if (getConsecutiveFailures(nodeId) >= circuitBreakerThreshold) {
        const decision: WorkflowRetryDecision = {
          shouldRetry: false, category, delayMs: 0,
          attempt, maxAttempts, reason: "circuit breaker open",
          budgetExhausted: false, circuitOpen: true, escalateToDlq: true,
        };
        const trace: WorkflowRetryTrace = { runId, nodeId, attempt, category, decision, errorCode, errorMessage, timestamp: nowIso() };
        traces.push(trace);
        deps.onRetryTrace?.(trace);
        deps.onDlqEscalation?.(trace);
        return decision;
      }

      // Check retry budget
      if (getBudgetUsed(runId) >= retryBudgetMax) {
        const decision: WorkflowRetryDecision = {
          shouldRetry: false, category, delayMs: 0,
          attempt, maxAttempts, reason: "retry budget exhausted",
          budgetExhausted: true, circuitOpen: false, escalateToDlq: true,
        };
        const trace: WorkflowRetryTrace = { runId, nodeId, attempt, category, decision, errorCode, errorMessage, timestamp: nowIso() };
        traces.push(trace);
        deps.onRetryTrace?.(trace);
        deps.onDlqEscalation?.(trace);
        return decision;
      }

      // Non-retryable categories
      if (category === "auth" || category === "logic" || category === "unknown") {
        const decision: WorkflowRetryDecision = {
          shouldRetry: false, category, delayMs: 0,
          attempt, maxAttempts, reason: `${category} errors are not retryable`,
          budgetExhausted: false, circuitOpen: false, escalateToDlq: true,
        };
        const trace: WorkflowRetryTrace = { runId, nodeId, attempt, category, decision, errorCode, errorMessage, timestamp: nowIso() };
        traces.push(trace);
        deps.onRetryTrace?.(trace);
        deps.onDlqEscalation?.(trace);
        return decision;
      }

      // Retryable — compute delay with exponential backoff
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      const decision: WorkflowRetryDecision = {
        shouldRetry: true, category, delayMs,
        attempt, maxAttempts, reason: "retryable failure",
        budgetExhausted: false, circuitOpen: false, escalateToDlq: false,
      };
      const trace: WorkflowRetryTrace = { runId, nodeId, attempt, category, decision, errorCode, errorMessage, timestamp: nowIso() };
      traces.push(trace);
      deps.onRetryTrace?.(trace);

      // Consume budget
      budgetUsed.set(runId, getBudgetUsed(runId) + 1);

      return decision;
    },

    recordAttempt(params) {
      const { nodeId, success } = params;
      if (success) {
        consecutiveFailures.set(nodeId, 0);
      } else {
        consecutiveFailures.set(nodeId, getConsecutiveFailures(nodeId) + 1);
      }
    },

    getRetryBudgetMax() {
      return retryBudgetMax;
    },

    getRetryBudgetUsed(runId) {
      return getBudgetUsed(runId);
    },

    getRetryBudgetRemaining(runId) {
      return retryBudgetMax - getBudgetUsed(runId);
    },

    getCircuitBreakerThreshold() {
      return circuitBreakerThreshold;
    },

    getConsecutiveFailures(nodeId) {
      return getConsecutiveFailures(nodeId);
    },

    isCircuitOpen(nodeId) {
      return getConsecutiveFailures(nodeId) >= circuitBreakerThreshold;
    },

    getTraces(runId) {
      return traces.filter((t) => t.runId === runId);
    },

    reset() {
      budgetUsed.clear();
      consecutiveFailures.clear();
      traces.length = 0;
    },
  };
}
