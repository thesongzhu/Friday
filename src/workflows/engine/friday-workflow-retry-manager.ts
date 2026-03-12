import type {
  FridayWorkflowRunNodeEntity,
  UUID,
} from "../model/friday-workflow.types.js";
import type { FridayNodeRetryPolicy } from "../model/friday-workflow-graph.types.js";

// ─── Decision type ───

export interface FridayRetryDecision {
  shouldRetry: boolean;
  nextAttemptNumber: number;
  delayMs: number;
  reason: string;
}

// ─── Interface ───

export interface FridayWorkflowRetryManager {
  evaluateRetry(
    nodeAttempt: FridayWorkflowRunNodeEntity,
    retryPolicy: FridayNodeRetryPolicy | undefined,
    errorCode: string,
  ): FridayRetryDecision;

  computeBackoffMs(
    attemptNumber: number,
    policy: FridayNodeRetryPolicy,
  ): number;

  generateIdempotencyKey(
    runId: UUID,
    nodeId: string,
    attemptNumber: number,
  ): string;

  generateAttemptId(): UUID;

  isRetryableError(errorCode: string, retryOn: string[]): boolean;
}

// ─── Factory ───

export interface CreateRetryManagerDeps {
  idGenerator: () => string;
  /** Optional: inject a random function for deterministic testing */
  randomFn?: () => number;
}

export function createFridayWorkflowRetryManager(
  deps: CreateRetryManagerDeps,
): FridayWorkflowRetryManager {
  const random = deps.randomFn ?? Math.random;

  return {
    evaluateRetry(nodeAttempt, retryPolicy, errorCode) {
      if (!retryPolicy) {
        return {
          shouldRetry: false,
          nextAttemptNumber: nodeAttempt.attempt + 1,
          delayMs: 0,
          reason: "no retry policy",
        };
      }

      if (nodeAttempt.attempt >= retryPolicy.maxAttempts) {
        return {
          shouldRetry: false,
          nextAttemptNumber: nodeAttempt.attempt + 1,
          delayMs: 0,
          reason: "max attempts exceeded",
        };
      }

      if (
        retryPolicy.retryOn.length > 0 &&
        !this.isRetryableError(errorCode, retryPolicy.retryOn)
      ) {
        return {
          shouldRetry: false,
          nextAttemptNumber: nodeAttempt.attempt + 1,
          delayMs: 0,
          reason: "error code not in retryOn list",
        };
      }

      const delayMs = this.computeBackoffMs(nodeAttempt.attempt, retryPolicy);

      return {
        shouldRetry: true,
        nextAttemptNumber: nodeAttempt.attempt + 1,
        delayMs,
        reason: "retry eligible",
      };
    },

    computeBackoffMs(attemptNumber, policy) {
      switch (policy.backoff) {
        case "none":
          return 0;
        case "fixed":
          return Math.min(policy.baseDelayMs, policy.maxDelayMs);
        case "exponential": {
          const delay = policy.baseDelayMs * Math.pow(2, attemptNumber - 1);
          // Add jitter: ±25%
          const jitter = delay * 0.25 * (random() * 2 - 1);
          return Math.min(Math.round(delay + jitter), policy.maxDelayMs);
        }
      }
    },

    generateIdempotencyKey(runId, nodeId, attemptNumber) {
      return `wfrun:${runId}:node:${nodeId}:attempt:${attemptNumber}`;
    },

    generateAttemptId() {
      return deps.idGenerator();
    },

    isRetryableError(errorCode, retryOn) {
      // Empty retryOn list means all errors are retryable (wildcard)
      if (retryOn.length === 0) return true;
      return retryOn.includes(errorCode);
    },
  };
}
