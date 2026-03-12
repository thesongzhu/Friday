/**
 * Retry Orchestrator — End-to-end retry execution pipeline.
 *
 * Composes failure classification, strategy decisioning, retry trace context,
 * and optional runtime retry budget gating behind a single API:
 * `retryWithPolicy(fn, config)`.
 *
 * @module retry/engine
 */

import type { FridayClassifyFailureError } from "../api/friday-retry-api.types.js";

import type {
  FridayClassifiedFailure,
  FridayRetryAttemptOutcome,
  FridayRetryCostBudget,
  FridayRetryCostDimensions,
  FridayRetryDecision,
  FridayRetryStrategy,
} from "../model/friday-retry-engine.types.js";

import type { FridayRetryHint } from "../../node-runner/api/friday-node-runner-api.types.js";
import type { FridayNodeExecutionResult } from "../../node-runner/model/friday-node-runner.types.js";
import type { ISODateTime, UUID } from "../../rules/model/friday-rules-engine.types.js";

import { isWithinBudget } from "./retry-strategy-engine.js";
import type { RetryStrategyEngineInstance } from "./retry-strategy-engine.js";
import type {
  RetryContextKey,
  RetryContextState,
  RetryContextTrackerInstance,
} from "./retry-context.js";
import type { RetryBudgetInstance } from "./retry-budget.js";

/** Classifier dependency accepted by the orchestrator. */
export interface RetryOrchestratorClassifier {
  classify(
    input: FridayClassifyFailureError | FridayNodeExecutionResult,
    retryHint?: FridayRetryHint,
  ): FridayClassifiedFailure;
  classifyError?: (
    error: FridayClassifyFailureError,
    retryHint?: FridayRetryHint,
  ) => FridayClassifiedFailure;
}

/** Configuration for creating a retry orchestrator instance. */
export interface RetryOrchestratorConfig {
  classifier: RetryOrchestratorClassifier;
  strategyEngine: RetryStrategyEngineInstance;
  contextTracker: RetryContextTrackerInstance;
  retryBudget?: RetryBudgetInstance;
  nowIso: () => ISODateTime;
}

/** Cost estimator hook arguments. */
export interface RetryAttemptCostEstimatorArgs {
  attemptNumber: number;
  error?: unknown;
  classifiedFailure?: FridayClassifiedFailure;
  decision?: FridayRetryDecision;
}

/** Runtime configuration for a single retry operation. */
export interface RetryWithPolicyConfig {
  runId: UUID;
  workflowId: UUID;
  nodeId: string;
  strategies: FridayRetryStrategy[];
  costBudget: FridayRetryCostBudget;
  retryHint?: FridayRetryHint;
  sleep?: (delayMs: number) => Promise<void>;
  maxExecutionAttempts?: number;
  estimateAttemptCost?: (
    args: RetryAttemptCostEstimatorArgs,
  ) => FridayRetryCostDimensions;
  classifyInputFromError?: (error: unknown) => FridayClassifyFailureError;
  mapAttemptOutcome?: (
    error: unknown,
    classifiedFailure: FridayClassifiedFailure,
  ) => FridayRetryAttemptOutcome;
}

const ZERO_COST: Readonly<FridayRetryCostDimensions> = {
  tokens: 0,
  apiCalls: 0,
  computeMs: 0,
};

function addCosts(
  a: FridayRetryCostDimensions,
  b: FridayRetryCostDimensions,
): FridayRetryCostDimensions {
  return {
    tokens: a.tokens + b.tokens,
    apiCalls: a.apiCalls + b.apiCalls,
    computeMs: a.computeMs + b.computeMs,
  };
}

/**
 * Error thrown when retries cannot continue (exhausted, escalated, budget-denied).
 */
export class RetryOrchestrationError extends Error {
  readonly lastError: unknown;
  readonly lastDecision?: FridayRetryDecision;
  readonly contextSnapshot?: RetryContextState;

  constructor(
    message: string,
    lastError: unknown,
    lastDecision?: FridayRetryDecision,
    contextSnapshot?: RetryContextState,
  ) {
    super(message);
    this.name = "RetryOrchestrationError";
    this.lastError = lastError;
    this.lastDecision = lastDecision;
    this.contextSnapshot = contextSnapshot;
  }
}

/**
 * Convert unknown runtime error to classifier input contract.
 */
function toClassifyFailureError(error: unknown): FridayClassifyFailureError {
  if (typeof error === "object" && error !== null) {
    const objectError = error as {
      errorCode?: unknown;
      code?: unknown;
      errorMessage?: unknown;
      message?: unknown;
      httpStatusCode?: unknown;
      statusCode?: unknown;
      status?: unknown;
    };

    const errorCode =
      typeof objectError.errorCode === "string"
        ? objectError.errorCode
        : typeof objectError.code === "string"
          ? objectError.code
          : undefined;

    const errorMessage =
      typeof objectError.errorMessage === "string"
        ? objectError.errorMessage
        : typeof objectError.message === "string"
          ? objectError.message
          : undefined;

    const httpStatusCode =
      typeof objectError.httpStatusCode === "number"
        ? objectError.httpStatusCode
        : typeof objectError.statusCode === "number"
          ? objectError.statusCode
          : typeof objectError.status === "number"
            ? objectError.status
            : undefined;

    if (errorCode !== undefined) {
      return { errorCode, errorMessage, httpStatusCode };
    }
    if (errorMessage !== undefined) {
      return { errorMessage, httpStatusCode };
    }
    if (httpStatusCode !== undefined) {
      return { httpStatusCode };
    }
  }

  if (typeof error === "string") {
    return { errorMessage: error };
  }

  return { errorMessage: "Unknown retry failure" };
}

/**
 * Infer an attempt outcome from runtime error shape.
 */
function defaultAttemptOutcome(
  error: unknown,
  classifiedFailure: FridayClassifiedFailure,
): FridayRetryAttemptOutcome {
  if (classifiedFailure.category === "timeout") {
    return "timeout";
  }

  if (typeof error === "object" && error !== null) {
    const objectError = error as { errorCode?: unknown; code?: unknown };
    const code =
      typeof objectError.errorCode === "string"
        ? objectError.errorCode
        : typeof objectError.code === "string"
          ? objectError.code
          : undefined;
    if (code && code.toUpperCase().includes("TIMEOUT")) {
      return "timeout";
    }
  }

  return "failure";
}

async function defaultSleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * End-to-end retry orchestrator.
 */
export class RetryOrchestrator {
  private readonly classifier: RetryOrchestratorClassifier;
  private readonly strategyEngine: RetryStrategyEngineInstance;
  private readonly contextTracker: RetryContextTrackerInstance;
  private readonly retryBudget?: RetryBudgetInstance;
  private readonly nowIso: () => ISODateTime;

  constructor(config: RetryOrchestratorConfig) {
    this.classifier = config.classifier;
    this.strategyEngine = config.strategyEngine;
    this.contextTracker = config.contextTracker;
    this.retryBudget = config.retryBudget;
    this.nowIso = config.nowIso;
  }

  /**
   * Run a function with retry policy orchestration.
   *
   * @param fn - Execution function. Receives 1-based attempt number.
   * @param config - Retry policy runtime configuration.
   * @returns Function result when successful.
   * @throws RetryOrchestrationError when retries are exhausted/escalated/blocked.
   */
  async retryWithPolicy<T>(
    fn: (attemptNumber: number) => Promise<T>,
    config: RetryWithPolicyConfig,
  ): Promise<T> {
    const key: RetryContextKey = { runId: config.runId, nodeId: config.nodeId };
    const classifyInputFromError =
      config.classifyInputFromError ?? toClassifyFailureError;
    const estimateAttemptCost =
      config.estimateAttemptCost ?? (() => ({ ...ZERO_COST }));
    const mapAttemptOutcome =
      config.mapAttemptOutcome ?? defaultAttemptOutcome;
    const sleep = config.sleep ?? defaultSleep;
    const maxExecutionAttempts = config.maxExecutionAttempts ?? 100;

    if (maxExecutionAttempts < 1) {
      throw new Error("maxExecutionAttempts must be >= 1");
    }

    let currentAttemptNumber = 0;
    let delayBeforeAttemptMs = 0;
    let lastFailure: FridayClassifiedFailure | undefined;
    let lastDecision: FridayRetryDecision | undefined;

    while (currentAttemptNumber < maxExecutionAttempts) {
      currentAttemptNumber++;
      let acquiredBudgetPermit = false;

      if (currentAttemptNumber > 1 && this.retryBudget) {
        acquiredBudgetPermit = this.retryBudget.acquire();
        if (!acquiredBudgetPermit) {
          if (this.contextTracker.getContext(key)) {
            this.contextTracker.markExhausted(key);
          }
          throw new RetryOrchestrationError(
            "Retry budget denied permit",
            undefined,
            lastDecision,
            this.contextTracker.getContext(key),
          );
        }
      }

      try {
        const result = await fn(currentAttemptNumber);

        if (lastFailure && lastDecision) {
          this.contextTracker.recordAttempt(key, {
            classifiedFailure: lastFailure,
            decision: lastDecision,
            delayMs: delayBeforeAttemptMs,
            outcome: "success",
            cost: estimateAttemptCost({
              attemptNumber: currentAttemptNumber,
              decision: lastDecision,
            }),
            startedAt: this.nowIso(),
            completedAt: this.nowIso(),
          });
        }

        return result;
      } catch (error) {
        const classifyInput = classifyInputFromError(error);
        const classifiedFailure = this.classify(classifyInput, config.retryHint);

        if (!this.contextTracker.getContext(key)) {
          this.contextTracker.initContext({
            runId: config.runId,
            workflowId: config.workflowId,
            nodeId: config.nodeId,
            originalFailureCategory: classifiedFailure.category,
          });
        }

        const attemptCost = estimateAttemptCost({
          attemptNumber: currentAttemptNumber,
          error,
          classifiedFailure,
          decision: lastDecision,
        });

        const decision = this.strategyEngine.buildDecision(
          classifiedFailure,
          {
            runId: config.runId,
            workflowId: config.workflowId,
            nodeId: config.nodeId,
            currentAttemptNumber,
            accumulatedCost: this.contextTracker.getAccumulatedCost(key),
            currentAttemptCost: attemptCost,
            costBudget: config.costBudget,
          },
          config.strategies,
        );

        this.contextTracker.recordAttempt(key, {
          classifiedFailure,
          decision,
          delayMs: delayBeforeAttemptMs,
          outcome: mapAttemptOutcome(error, classifiedFailure),
          cost: attemptCost,
          startedAt: this.nowIso(),
          completedAt: this.nowIso(),
          errorCode: classifyInput.errorCode,
          errorMessage: classifyInput.errorMessage,
        });

        lastFailure = classifiedFailure;
        lastDecision = decision;

        if (decision.shouldRetry) {
          const projectedNextAttemptCost = estimateAttemptCost({
            attemptNumber: currentAttemptNumber + 1,
            error,
            classifiedFailure,
            decision,
          });
          const projectedCostAfterNextAttempt = addCosts(
            this.contextTracker.getAccumulatedCost(key),
            projectedNextAttemptCost,
          );

          if (!isWithinBudget(projectedCostAfterNextAttempt, config.costBudget)) {
            const budgetDecision: FridayRetryDecision = {
              ...decision,
              shouldRetry: false,
              nextAttemptNumber: currentAttemptNumber,
              delayMs: 0,
              reason: "Retry cost budget exceeded",
              budgetConstrained: true,
              escalate: true,
            };

            lastDecision = budgetDecision;
            this.contextTracker.markExhausted(key);

            throw new RetryOrchestrationError(
              budgetDecision.reason,
              error,
              budgetDecision,
              this.contextTracker.getContext(key),
            );
          }
        }

        if (!decision.shouldRetry) {
          if (decision.budgetConstrained) {
            this.contextTracker.markExhausted(key);
          } else if (decision.escalate) {
            this.contextTracker.markEscalated(key);
          } else {
            this.contextTracker.markExhausted(key);
          }

          throw new RetryOrchestrationError(
            decision.reason,
            error,
            decision,
            this.contextTracker.getContext(key),
          );
        }

        delayBeforeAttemptMs = decision.delayMs;
        await sleep(decision.delayMs);
      } finally {
        if (acquiredBudgetPermit && this.retryBudget) {
          this.retryBudget.release();
        }
      }
    }

    const existingContext = this.contextTracker.getContext(key);
    if (existingContext?.status === "in_progress") {
      if (lastDecision?.escalate) {
        this.contextTracker.markEscalated(key);
      } else {
        this.contextTracker.markExhausted(key);
      }
    }

    throw new RetryOrchestrationError(
      `Retry loop exceeded safety limit (${maxExecutionAttempts} attempts)`,
      undefined,
      lastDecision,
      this.contextTracker.getContext(key),
    );
  }

  private classify(
    error: FridayClassifyFailureError,
    retryHint?: FridayRetryHint,
  ): FridayClassifiedFailure {
    if (typeof this.classifier.classifyError === "function") {
      return this.classifier.classifyError(error, retryHint);
    }
    return this.classifier.classify(error, retryHint);
  }
}

/**
 * Factory helper for creating retry orchestrator instances.
 */
export function createRetryOrchestrator(
  config: RetryOrchestratorConfig,
): RetryOrchestrator {
  return new RetryOrchestrator(config);
}
