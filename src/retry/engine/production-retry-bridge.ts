/**
 * Production Retry Bridge — integrates the unified RetryOrchestrator
 * into the workflow execution path.
 *
 * Provides a factory that creates a pre-configured RetryOrchestrator
 * with the full failure taxonomy, strategy engine, context tracking,
 * and budget management. Can be injected into the workflow runtime
 * alongside or in place of the legacy retry manager.
 *
 * @module retry/engine
 */

import type { ISODateTime, UUID } from "../../rules/model/friday-rules-engine.types.js";
import type { FridayFailureCategory, FridayRetryCostBudget, FridayRetryStrategy } from "../model/friday-retry-engine.types.js";

import { createFailureClassifier } from "./failure-classifier.js";
import { createRetryStrategyEngine } from "./retry-strategy-engine.js";
import { createRetryContextTracker } from "./retry-context.js";
import { createRetryBudget, DEFAULT_RETRY_BUDGET_CONFIG } from "./retry-budget.js";
import { createRetryOrchestrator } from "./retry-orchestrator.js";
import type { RetryAttemptCostEstimatorArgs, RetryOrchestrator, RetryOrchestratorConfig , RetryWithPolicyConfig} from "./retry-orchestrator.js";
import type { RetryBudgetInstance } from "./retry-budget.js";

// ─── Default Retry Strategies ───

/**
 * Default retry strategies by failure category.
 * These follow the unified failure taxonomy.
 */
export const DEFAULT_PRODUCTION_STRATEGIES: readonly FridayRetryStrategy[] = [
  {
    type: "exponential",
    failureCategory: "rate_limit",
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 60_000,
    jitterPercent: 25,
    respectRetryAfter: true,
    timeoutMultiplier: 1.0,
    escalate: false,
    escalateOnExhaustion: true,
    escalationChannel: "operator",
  },
  {
    type: "exponential",
    failureCategory: "timeout",
    maxAttempts: 2,
    baseDelayMs: 2000,
    maxDelayMs: 30_000,
    jitterPercent: 20,
    respectRetryAfter: false,
    timeoutMultiplier: 1.5,
    escalate: false,
    escalateOnExhaustion: true,
    escalationChannel: "operator",
  },
  {
    type: "exponential",
    failureCategory: "transient",
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 15_000,
    jitterPercent: 30,
    respectRetryAfter: false,
    timeoutMultiplier: 1.0,
    escalate: false,
    escalateOnExhaustion: true,
    escalationChannel: "developer",
  },
  {
    type: "linear",
    failureCategory: "resource",
    maxAttempts: 2,
    baseDelayMs: 5000,
    maxDelayMs: 30_000,
    jitterPercent: 10,
    respectRetryAfter: false,
    timeoutMultiplier: 1.0,
    escalate: false,
    escalateOnExhaustion: true,
    escalationChannel: "operator",
  },
  {
    type: "none",
    failureCategory: "auth",
    maxAttempts: 0,
    respectRetryAfter: false,
    timeoutMultiplier: 1.0,
    escalate: true,
    escalateOnExhaustion: false,
  },
  {
    type: "none",
    failureCategory: "logic",
    maxAttempts: 0,
    respectRetryAfter: false,
    timeoutMultiplier: 1.0,
    escalate: false,
    escalateOnExhaustion: false,
  },
  {
    type: "fixed",
    failureCategory: "unknown",
    maxAttempts: 1,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
    jitterPercent: 50,
    respectRetryAfter: false,
    timeoutMultiplier: 1.0,
    escalate: false,
    escalateOnExhaustion: true,
    escalationChannel: "developer",
  },
] as unknown as FridayRetryStrategy[];

/**
 * Default cost budget for production retry.
 */
export const DEFAULT_PRODUCTION_COST_BUDGET: FridayRetryCostBudget = {
  maxTotalTokens: 100_000,
  maxTotalApiCalls: 50,
  maxTotalComputeMs: 300_000, // 5 minutes total compute
};

// ─── Bridge Configuration ───

export interface ProductionRetryBridgeConfig {
  /** Generate a new UUID. */
  generateId: () => UUID;
  /** Get current ISO timestamp. */
  nowIso: () => ISODateTime;
  /** Override default strategies. */
  strategies?: FridayRetryStrategy[];
  /** Override default cost budget. */
  costBudget?: FridayRetryCostBudget;
  /** Enable runtime retry budget (token bucket). */
  enableRetryBudget?: boolean;
}

// ─── Bridge Result ───

export interface ProductionRetryBridge {
  /** The configured RetryOrchestrator for production use. */
  readonly orchestrator: RetryOrchestrator;
  /** Default strategies for the production path. */
  readonly strategies: readonly FridayRetryStrategy[];
  /** Default cost budget for the production path. */
  readonly costBudget: FridayRetryCostBudget;

  /**
   * Execute a function with production retry policy.
   *
   * @param fn - The function to execute with retries.
   * @param runId - Workflow run ID.
   * @param workflowId - Workflow definition ID.
   * @param nodeId - Node ID within the workflow graph.
   * @param overrides - Optional per-call configuration overrides.
   * @returns The result of the function execution.
   */
  executeWithRetry<T>(
    fn: (attemptNumber: number) => Promise<T>,
    runId: UUID,
    workflowId: UUID,
    nodeId: string,
    overrides?: Partial<Pick<RetryWithPolicyConfig, "strategies" | "costBudget" | "retryHint" | "sleep" | "maxExecutionAttempts">>,
  ): Promise<T>;
}

// ─── Factory ───

/**
 * Create a production-configured retry bridge with the full unified
 * failure taxonomy and retry orchestration pipeline.
 */
export function createProductionRetryBridge(
  config: ProductionRetryBridgeConfig,
): ProductionRetryBridge {
  const { generateId, nowIso } = config;
  const strategies = config.strategies ?? (DEFAULT_PRODUCTION_STRATEGIES as unknown as FridayRetryStrategy[]);
  const costBudget = config.costBudget ?? DEFAULT_PRODUCTION_COST_BUDGET;

  // Create the failure classifier with full taxonomy
  const classifier = createFailureClassifier({ generateId, nowIso });

  // Create the retry strategy engine
  const strategyEngine = createRetryStrategyEngine({ generateId, nowIso });

  // Create the context tracker for runtime state
  const contextTracker = createRetryContextTracker({ nowIso });

  // Optional: create runtime retry budget
  const retryBudget: RetryBudgetInstance | undefined = config.enableRetryBudget
    ? createRetryBudget(DEFAULT_RETRY_BUDGET_CONFIG)
    : undefined;

  // Create the orchestrator
  const orchestrator = createRetryOrchestrator({
    classifier,
    strategyEngine,
    contextTracker,
    retryBudget,
    nowIso,
  });

  return {
    orchestrator,
    strategies,
    costBudget,

    async executeWithRetry<T>(
      fn: (attemptNumber: number) => Promise<T>,
      runId: UUID,
      workflowId: UUID,
      nodeId: string,
      overrides?: Partial<Pick<RetryWithPolicyConfig, "strategies" | "costBudget" | "retryHint" | "sleep" | "maxExecutionAttempts">>,
    ): Promise<T> {
      return orchestrator.retryWithPolicy(fn, {
        runId,
        workflowId,
        nodeId,
        strategies: overrides?.strategies ?? strategies,
        costBudget: overrides?.costBudget ?? costBudget,
        retryHint: overrides?.retryHint,
        sleep: overrides?.sleep,
        maxExecutionAttempts: overrides?.maxExecutionAttempts,
      });
    },
  };
}
