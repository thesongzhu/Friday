/**
 * Retry Engine Runtime — barrel export.
 *
 * Core components for failure classification, retry strategy computation,
 * circuit breaking, dead letter queuing, rate-limited retry budgets,
 * and retry context tracking.
 *
 * @module retry/engine
 */

// ─── Failure Classifier ───

export {
  createFailureClassifier,
  FAILURE_CLASS_DEFINITIONS,
} from "./failure-classifier.js";
export type {
  FailureClassifierConfig,
  FailureClassifierInstance,
} from "./failure-classifier.js";

// ─── Retry Strategy Engine ───

export {
  createRetryStrategyEngine,
  computeRawDelay,
  computeDelay,
  applyJitter,
  findStrategyForCategory,
  isWithinBudget,
  buildRetryDecision,
} from "./retry-strategy-engine.js";
export type {
  RetryStrategyEngineConfig,
  RetryStrategyEngineInstance,
} from "./retry-strategy-engine.js";

// ─── Circuit Breaker ───

export {
  createCircuitBreakerManager,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "./circuit-breaker.js";
export type {
  CircuitBreakerState,
  CircuitBreakerConfig,
  CircuitBreakerSnapshot,
  CircuitBreakerManagerInstance,
} from "./circuit-breaker.js";

// ─── Dead Letter Queue ───

export {
  createDeadLetterQueue,
  DEFAULT_DLQ_MAX_SIZE,
} from "./dead-letter-queue.js";
export type {
  DeadLetterEntry,
  DeadLetterQueueConfig,
  EnqueueParams,
  DeadLetterQueryFilter,
  DeadLetterQueueInstance,
} from "./dead-letter-queue.js";

// ─── Retry Budget ───

export {
  createRetryBudget,
  DEFAULT_RETRY_BUDGET_CONFIG,
} from "./retry-budget.js";
export type {
  RetryBudgetConfig,
  RetryBudgetSnapshot,
  RetryBudgetInstance,
} from "./retry-budget.js";

// ─── Retry Context Tracker ───

export {
  createRetryContextTracker,
  ZERO_COST,
} from "./retry-context.js";
export type {
  RetryContextKey,
  RetryAttemptRecord,
  RetryContextState,
  RetryContextTrackerConfig,
  InitContextParams,
  RecordAttemptParams,
  RetryContextTrackerInstance,
} from "./retry-context.js";

// ─── Retry Orchestrator ───

export {
  RetryOrchestrationError,
  RetryOrchestrator,
  createRetryOrchestrator,
} from "./retry-orchestrator.js";
export type {
  RetryOrchestratorClassifier,
  RetryOrchestratorConfig,
  RetryAttemptCostEstimatorArgs,
  RetryWithPolicyConfig,
} from "./retry-orchestrator.js";

// ─── Production Retry Bridge ───

export {
  createProductionRetryBridge,
  DEFAULT_PRODUCTION_STRATEGIES,
  DEFAULT_PRODUCTION_COST_BUDGET,
} from "./production-retry-bridge.js";
export type {
  ProductionRetryBridge,
  ProductionRetryBridgeConfig,
} from "./production-retry-bridge.js";
