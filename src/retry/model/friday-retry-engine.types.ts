/**
 * Retry Engine — Domain Model and Data Contract.
 *
 * Canonical types for the Friday Retry Engine: failure taxonomy,
 * retry policies, cost accounting, retry execution traces,
 * decision trees, and persistence schema types.
 *
 * @module retry/model
 */

import type {
  FridayEvaluationContext,
  FridayEvaluationResult,
  ISODateTime,
  JsonObject,
  JsonValue,
  UUID,
} from "../../rules/model/friday-rules-engine.types.js";

import type {
  FridayNodeExecutionContext,
  FridayNodeExecutionResult,
  FridayNodeRunnerErrorCode,
} from "../../node-runner/model/friday-node-runner.types.js";

import type { FridayRetryHint } from "../../node-runner/api/friday-node-runner-api.types.js";

import type { FridayNodeRetryPolicy } from "../../workflows/model/friday-workflow-graph.types.js";

// ─── Failure Taxonomy ───

/**
 * The seven failure categories in the retry taxonomy.
 * Each maps to a default retry strategy.
 */
export type FridayFailureCategory =
  | "transient"
  | "rate_limit"
  | "auth"
  | "logic"
  | "resource"
  | "timeout"
  | "unknown";

/**
 * Priority order for failure categories when classification is ambiguous.
 * Lower index = higher priority. Used when an error matches multiple categories.
 */
export const FRIDAY_FAILURE_CATEGORY_PRIORITY: readonly FridayFailureCategory[] = [
  "rate_limit",
  "timeout",
  "transient",
  "resource",
  "auth",
  "logic",
  "unknown",
] as const;

/**
 * Severity of a classified failure.
 * Informs urgency of escalation and retry aggressiveness.
 */
export type FridayFailureSeverity =
  | "critical"
  | "major"
  | "minor"
  | "info";

/**
 * Source signal used to classify the failure.
 * Records how the classifier arrived at its decision for audit.
 */
export type FridayFailureClassificationSource =
  | "http_status"
  | "error_code"
  | "error_message"
  | "retry_hint"
  | "custom_rule"
  | "default";

/**
 * A classified failure: the result of running the failure classifier
 * on a raw error from a node execution.
 */
export interface FridayClassifiedFailure {
  /** Unique classification ID for audit correlation. */
  classificationId: UUID;
  /** The assigned failure category. */
  category: FridayFailureCategory;
  /** Severity of the failure. */
  severity: FridayFailureSeverity;
  /** How the classifier arrived at this category. */
  classificationSource: FridayFailureClassificationSource;
  /** Confidence score (0–100) of the classification. */
  confidence: number;
  /** Original error code from the NodeRunner (if available). */
  originalErrorCode?: FridayNodeRunnerErrorCode | string;
  /** Original error message (may be truncated for persistence). */
  originalErrorMessage?: string;
  /** HTTP status code (if the failure originated from an HTTP response). */
  httpStatusCode?: number;
  /** Retry-After header value in milliseconds (if present in the response). */
  retryAfterMs?: number;
  /** NodeRunner retry hint (if the adapter provided one). */
  retryHint?: FridayRetryHint;
  /** Whether this failure category is retryable by default. */
  retryable: boolean;
  /** Timestamp of the classification. */
  classifiedAt: ISODateTime;
  /** Arbitrary metadata from the classification process. */
  metadata?: JsonObject;
}

/**
 * Failure class definition: maps a category to its default retry behavior.
 * Used to build the classification lookup table.
 */
export interface FridayFailureClass {
  /** The failure category. */
  category: FridayFailureCategory;
  /** Human-readable description. */
  description: string;
  /** Whether this category is retryable by default. */
  retryableByDefault: boolean;
  /** Default severity. */
  defaultSeverity: FridayFailureSeverity;
  /** Default max retry attempts (0 = no retry). */
  defaultMaxAttempts: number;
  /** HTTP status codes that map to this category. */
  httpStatusCodes: number[];
  /** NodeRunner error codes that map to this category. */
  errorCodes: string[];
  /** Error message patterns (regex) that map to this category. */
  errorMessagePatterns: string[];
}

// ─── Retry Strategy ───

/**
 * Backoff strategy types for retry execution.
 */
export type FridayRetryStrategyType =
  | "exponential"
  | "linear"
  | "fixed"
  | "immediate"
  | "custom"
  | "none";

// ─── Strategy Discriminated Union ───

/**
 * Common fields shared by all retry strategy variants.
 */
export interface FridayRetryStrategyBase {
  /** Which failure category this strategy applies to. */
  failureCategory: FridayFailureCategory;
  /** Maximum number of retry attempts. */
  maxAttempts: number;
  /**
   * Whether to respect the Retry-After header as minimum delay.
   * Primarily for `rate_limit` failures.
   * @default false
   */
  respectRetryAfter: boolean;
  /**
   * Multiplier applied to node timeout on retry (e.g., 1.5 = 50% more time).
   * Primarily for `timeout` failures.
   * @default 1.0
   */
  timeoutMultiplier: number;
  /** Whether to escalate immediately (strategy = "none"). */
  escalate: boolean;
  /** Whether to escalate when all retry attempts are exhausted. */
  escalateOnExhaustion: boolean;
  /** Escalation channel identifier (e.g., "operator", "developer"). */
  escalationChannel?: string;
}

/**
 * Common fields for strategies that use backoff delays (exponential, linear, fixed).
 */
export interface FridayRetryBackoffStrategyBase extends FridayRetryStrategyBase {
  /** Base delay in milliseconds. */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (cap for backoff). */
  maxDelayMs: number;
  /**
   * Jitter percentage applied to computed delay (0–100).
   * @default 25
   */
  jitterPercent: number;
  /** Not applicable — no custom handler. */
  customHandlerRef?: never;
}

/** Exponential backoff strategy (delay doubles per attempt). */
export interface FridayExponentialRetryStrategy extends FridayRetryBackoffStrategyBase {
  strategy: "exponential";
}

/** Linear backoff strategy (delay increases by baseDelayMs per attempt). */
export interface FridayLinearRetryStrategy extends FridayRetryBackoffStrategyBase {
  strategy: "linear";
}

/** Fixed delay strategy (constant delay between attempts). */
export interface FridayFixedRetryStrategy extends FridayRetryBackoffStrategyBase {
  strategy: "fixed";
}

/** Immediate retry strategy (no delay between attempts). */
export interface FridayImmediateRetryStrategy extends FridayRetryStrategyBase {
  strategy: "immediate";
  /** Not applicable — immediate retries have no delay. */
  baseDelayMs?: never;
  /** Not applicable — immediate retries have no delay. */
  maxDelayMs?: never;
  /** Not applicable — immediate retries have no delay. */
  jitterPercent?: never;
  /** Not applicable — no custom handler. */
  customHandlerRef?: never;
}

/** Custom retry strategy (delegates to a registered handler). */
export interface FridayCustomRetryStrategy extends FridayRetryStrategyBase {
  strategy: "custom";
  /** Base delay in milliseconds (optional; handler may compute its own). */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (optional; handler may compute its own). */
  maxDelayMs?: number;
  /** Jitter percentage (optional; handler may compute its own). */
  jitterPercent?: number;
  /**
   * Custom handler reference — required for custom strategy.
   * Resolves to a registered retry handler function.
   */
  customHandlerRef: string;
}

/** No-retry strategy (escalate immediately). */
export interface FridayNoneRetryStrategy extends FridayRetryStrategyBase {
  strategy: "none";
  /** Not applicable — no retry, no delay. */
  baseDelayMs?: never;
  /** Not applicable — no retry, no delay. */
  maxDelayMs?: never;
  /** Not applicable — no retry, no delay. */
  jitterPercent?: never;
  /** Not applicable — no custom handler. */
  customHandlerRef?: never;
}

/**
 * A retry strategy for a specific failure category within a policy.
 * Discriminated union on the `strategy` field.
 */
export type FridayRetryStrategy =
  | FridayExponentialRetryStrategy
  | FridayLinearRetryStrategy
  | FridayFixedRetryStrategy
  | FridayImmediateRetryStrategy
  | FridayCustomRetryStrategy
  | FridayNoneRetryStrategy;

// ─── Retry Policy ───

/**
 * API version for the YAML retry policy format.
 */
export type FridayRetryPolicyApiVersion = "friday/retry/v1";

/**
 * Top-level kind for a YAML retry policy document.
 */
export type FridayRetryPolicyKind = "RetryPolicy";

/**
 * A retry policy: groups retry strategies by failure category
 * with a shared cost budget.
 */
export interface FridayRetryPolicy {
  /** Unique policy identifier. */
  id: UUID;
  /** Human-readable name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Policy version (incremented on update). */
  version: number;
  /**
   * Policy priority. Lower number = higher priority.
   * When multiple policies match, the highest-priority one wins.
   * @default 100
   */
  priority: number;
  /** Whether this policy is active. */
  enabled: boolean;
  /** Tags for filtering and organization. */
  tags: string[];
  /** Cost budget for retries under this policy. */
  costBudget: FridayRetryCostBudget;
  /** Per-category retry strategies. */
  strategies: FridayRetryStrategy[];
  /** Optimistic concurrency token. */
  etag: string;
  /** When this policy was created. */
  createdAt: ISODateTime;
  /** When this policy was last updated. */
  updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  deletedAt?: ISODateTime;
}

// ─── Retry Policy YAML Schema ───

/** Metadata section of a YAML retry policy. */
export interface FridayRetryPolicyYamlMetadata {
  /** Policy identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Policy version number. */
  version: number;
  /**
   * Policy priority. Lower number = higher priority.
   * @default 100
   */
  priority?: number;
  /** Whether the policy is enabled. */
  enabled?: boolean;
  /** Tags for filtering. */
  tags?: string[];
}

/** Parsed YAML retry policy document. */
export interface FridayRetryPolicyYaml {
  /** API version string. */
  apiVersion: FridayRetryPolicyApiVersion;
  /** Document kind. */
  kind: FridayRetryPolicyKind;
  /** Policy metadata. */
  metadata: FridayRetryPolicyYamlMetadata;
  /** Cost budget configuration. */
  costBudget: FridayRetryCostBudget;
  /** Per-category strategy definitions. */
  strategies: FridayRetryStrategy[];
}

// ─── Cost Accounting ───

/**
 * Cost dimensions tracked per retry attempt.
 */
export interface FridayRetryCostDimensions {
  /** Number of LLM tokens consumed. */
  tokens: number;
  /** Number of external API calls made. */
  apiCalls: number;
  /** Compute time in milliseconds. */
  computeMs: number;
}

/**
 * Cost budget that limits retry spending.
 * Applied at per-node or per-workflow-run level.
 */
export interface FridayRetryCostBudget {
  /** Maximum total tokens across all retry attempts. */
  maxTotalTokens: number;
  /** Maximum total API calls across all retry attempts. */
  maxTotalApiCalls: number;
  /** Maximum total compute time in milliseconds across all retry attempts. */
  maxTotalComputeMs: number;
  /** Per-attempt cost limits (optional; prevents a single retry from being too expensive). */
  maxCostPerAttempt?: FridayRetryCostDimensions;
}

/**
 * A single cost record for one retry attempt.
 */
export interface FridayRetryCostRecord {
  /** Unique cost record identifier. */
  id: UUID;
  /** Parent retry trace ID. */
  traceId: UUID;
  /** Attempt number this cost belongs to. */
  attemptNumber: number;
  /** Parent workflow run ID. */
  runId: UUID;
  /** Node ID within the workflow graph. */
  nodeId: string;
  /** Cost dimensions for this attempt. */
  cost: FridayRetryCostDimensions;
  /** Running total after this attempt (accumulated across the trace). */
  cumulativeCost: FridayRetryCostDimensions;
  /** Whether this attempt exceeded the per-attempt budget. */
  perAttemptBudgetExceeded: boolean;
  /** Whether the cumulative cost exceeds the total budget after this attempt. */
  totalBudgetExceeded: boolean;
  /** When this cost was recorded. */
  recordedAt: ISODateTime;
}

/**
 * Aggregated cost summary for a retry trace or workflow run.
 */
export interface FridayRetryCostSummary {
  /** Total cost across all retry attempts. */
  totalCost: FridayRetryCostDimensions;
  /** Cost of the original (non-retry) operation, used as the baseline for overhead calculation. */
  originalOperationCost: FridayRetryCostDimensions;
  /** Retry overhead as a percentage of original operation cost per dimension. */
  overheadPercent: {
    tokensPercent: number;
    apiCallsPercent: number;
    computeMsPercent: number;
  };
  /** Cost budget that was applied. */
  budget: FridayRetryCostBudget;
  /** Whether the total budget was exceeded. */
  budgetExceeded: boolean;
  /** Cost as a percentage of budget (0–100+ per dimension). */
  budgetUtilization: {
    tokensPercent: number;
    apiCallsPercent: number;
    computeMsPercent: number;
  };
  /** Total number of cost records. */
  recordCount: number;
}

// ─── Retry Execution ───

/**
 * A single retry attempt within a trace.
 */
export interface FridayRetryAttempt {
  /** Unique attempt identifier. */
  id: UUID;
  /** Parent retry trace ID. */
  traceId: UUID;
  /** Attempt number (1-based; attempt 1 is the first retry, not the original execution). */
  attemptNumber: number;
  /** Classified failure that triggered this attempt. */
  classifiedFailure: FridayClassifiedFailure;
  /** Retry decision that authorized this attempt. */
  decision: FridayRetryDecision;
  /** Delay waited before this attempt in milliseconds. */
  delayMs: number;
  /** NodeRunner execution ID for this attempt (if executed). */
  executionId?: UUID;
  /** Outcome of this attempt. */
  outcome: FridayRetryAttemptOutcome;
  /** Cost record for this attempt. */
  costRecord?: FridayRetryCostRecord;
  /** Rules Engine evaluation result (if Rules Engine was consulted). */
  rulesResult?: FridayEvaluationResult;
  /** Error code from this attempt (if it failed). */
  errorCode?: string;
  /** Error message from this attempt (if it failed). */
  errorMessage?: string;
  /** When this attempt started. */
  startedAt: ISODateTime;
  /** When this attempt completed. */
  completedAt: ISODateTime;
  /** Arbitrary attempt metadata. */
  metadata?: JsonObject;
}

/**
 * Outcome of a retry attempt.
 */
export type FridayRetryAttemptOutcome =
  | "success"
  | "failure"
  | "timeout"
  | "cancelled"
  | "budget_exceeded"
  | "rules_denied";

/**
 * The retry decision produced by the decision tree.
 */
export interface FridayRetryDecision {
  /** Whether to retry. */
  shouldRetry: boolean;
  /** Next attempt number (if retrying). */
  nextAttemptNumber: number;
  /** Computed delay before the next attempt in milliseconds. */
  delayMs: number;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Failure category that was classified. */
  failureCategory: FridayFailureCategory;
  /** Strategy that was selected. */
  strategyType: FridayRetryStrategyType;
  /** Whether the decision was overridden by the Rules Engine. */
  rulesOverride: boolean;
  /** Whether the decision was limited by cost budget. */
  budgetConstrained: boolean;
  /** Whether escalation is recommended. */
  escalate: boolean;
  /** Escalation channel (if escalation is recommended). */
  escalationChannel?: string;
  /** Timeout override for the next attempt in milliseconds (if applicable). */
  nextTimeoutMs?: number;
  /** Idempotency key for the next attempt. */
  idempotencyKey: string;
  /** When the decision was made. */
  decidedAt: ISODateTime;
}

/**
 * Resolution status of a retry trace.
 */
export type FridayRetryTraceStatus =
  | "in_progress"
  | "resolved"
  | "exhausted"
  | "escalated"
  | "cancelled"
  | "budget_exceeded";

/**
 * A retry trace: the complete history of retry attempts for a single
 * (runId, nodeId) pair. Groups all attempts from first failure to resolution.
 */
export interface FridayRetryTrace {
  /** Unique trace identifier. */
  id: UUID;
  /** Parent workflow run ID. */
  runId: UUID;
  /** Parent workflow definition ID. */
  workflowId: UUID;
  /** Node ID within the workflow graph. */
  nodeId: string;
  /** Current trace status. */
  status: FridayRetryTraceStatus;
  /** Retry policy ID that governed this trace. */
  policyId: UUID;
  /** Failure category of the original failure. */
  originalFailureCategory: FridayFailureCategory;
  /** Original error code that triggered the retry sequence. */
  originalErrorCode?: string;
  /** Original error message. */
  originalErrorMessage?: string;
  /** Ordered list of retry attempts. */
  attempts: FridayRetryAttempt[];
  /** Total number of attempts (including the original execution). */
  totalAttempts: number;
  /** Aggregated cost summary. */
  costSummary: FridayRetryCostSummary;
  /** Total trace duration in milliseconds (from first failure to resolution). */
  durationMs: number;
  /** When the first failure occurred. */
  firstFailureAt: ISODateTime;
  /** When the trace was resolved (or escalated/cancelled). */
  resolvedAt?: ISODateTime;
  /** When the trace record was created. */
  createdAt: ISODateTime;
  /** When the trace record was last updated. */
  updatedAt: ISODateTime;
}

// ─── Escalation ───

/**
 * Escalation target types.
 */
export type FridayRetryEscalationTarget =
  | "operator"
  | "developer"
  | "channel"
  | "webhook";

/**
 * An escalation event emitted when retries cannot resolve a failure.
 */
export interface FridayRetryEscalation {
  /** Unique escalation identifier. */
  id: UUID;
  /** Parent retry trace ID. */
  traceId: UUID;
  /** Escalation target type. */
  target: FridayRetryEscalationTarget;
  /** Escalation channel identifier. */
  channel: string;
  /** Reason for escalation. */
  reason: string;
  /** Failure category that could not be resolved. */
  failureCategory: FridayFailureCategory;
  /** Total retry attempts before escalation. */
  attemptCount: number;
  /** Total cost consumed before escalation. */
  totalCost: FridayRetryCostDimensions;
  /** Whether the escalation has been acknowledged. */
  acknowledged: boolean;
  /** When the escalation was emitted. */
  escalatedAt: ISODateTime;
  /** When the escalation was acknowledged (if applicable). */
  acknowledgedAt?: ISODateTime;
}

// ─── Engine Interfaces ───

/**
 * Failure classifier: maps raw errors to taxonomy categories.
 */
export interface FridayFailureClassifier {
  /**
   * Classify a failure from a node execution result.
   *
   * @param executionResult - The failed node execution result.
   * @param retryHint - Optional retry hint from the NodeRunner adapter.
   * @returns Classified failure with category, severity, and metadata.
   */
  classify(
    executionResult: FridayNodeExecutionResult,
    retryHint?: FridayRetryHint,
  ): FridayClassifiedFailure;

  /**
   * Register a custom classification rule for provider-specific errors.
   *
   * @param rule - Custom classification rule.
   */
  registerCustomRule(rule: FridayCustomClassificationRule): void;
}

/**
 * A custom classification rule for provider-specific error mapping.
 */
export interface FridayCustomClassificationRule {
  /** Unique rule identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Error code pattern to match (exact or regex). */
  errorCodePattern?: string;
  /** Error message pattern to match (regex). */
  errorMessagePattern?: string;
  /** HTTP status code to match. */
  httpStatusCode?: number;
  /** Target failure category. */
  category: FridayFailureCategory;
  /** Target severity. */
  severity: FridayFailureSeverity;
  /** Rule priority (lower = higher priority). */
  priority: number;
}

/**
 * Retry decision engine: produces retry decisions from classified failures.
 */
export interface FridayRetryDecisionEngine {
  /**
   * Get a retry decision for a classified failure.
   *
   * @param classifiedFailure - The classified failure.
   * @param context - Retry decision context.
   * @returns Retry decision.
   */
  decide(
    classifiedFailure: FridayClassifiedFailure,
    context: FridayRetryDecisionContext,
  ): Promise<FridayRetryDecision>;
}

/**
 * Synchronous adapter for the Retry Engine, bridging the existing
 * synchronous `FridayWorkflowRetryManager` with the async Retry Engine.
 *
 * `decideSync()` returns a cached decision instantly (no I/O).
 * `refreshAsync()` should be called periodically to update the cache
 * from the full async pipeline (Rules Engine, cost checks, etc.).
 */
export interface FridayRetryEngineSyncAdapter {
  /**
   * Return a retry decision synchronously from the local cache.
   * Falls back to the legacy backoff logic if no cached decision is available.
   *
   * @param classifiedFailure - The classified failure.
   * @param context - Retry decision context.
   * @returns Cached retry decision (synchronous).
   */
  decideSync(
    classifiedFailure: FridayClassifiedFailure,
    context: FridayRetryDecisionContext,
  ): FridayRetryDecision;

  /**
   * Refresh the local decision cache by running the full async pipeline.
   * Should be called on a regular cadence or after policy/rule changes.
   *
   * @returns Promise that resolves when the cache is refreshed.
   */
  refreshAsync(): Promise<void>;
}

/**
 * Context provided to the retry decision engine.
 */
export interface FridayRetryDecisionContext {
  /** Parent workflow run ID. */
  runId: UUID;
  /** Parent workflow definition ID. */
  workflowId: UUID;
  /** Node ID within the workflow graph. */
  nodeId: string;
  /** Current attempt number (before the potential retry). */
  currentAttemptNumber: number;
  /** Node-level retry policy from the workflow graph (if defined). */
  nodeRetryPolicy?: FridayNodeRetryPolicy;
  /** Retry Engine policy ID to use (if overriding node policy). */
  retryPolicyId?: UUID;
  /** Accumulated cost so far for this (runId, nodeId) pair. */
  accumulatedCost: FridayRetryCostDimensions;
  /** Estimated cost for the next retry attempt (used for per-attempt budget enforcement). */
  currentAttemptCost?: FridayRetryCostDimensions;
  /** Cost budget to enforce. */
  costBudget: FridayRetryCostBudget;
  /** Execution metadata for Rules Engine context. */
  metadata?: JsonObject;
}

/**
 * Configuration for constructing a Retry Engine runtime.
 */
export interface FridayRetryEngineConfig {
  /** Rules Engine evaluate function (for retry override policies). */
  evaluateRules: (context: FridayEvaluationContext) => Promise<FridayEvaluationResult>;
  /** Generate a new UUID. */
  generateId: () => UUID;
  /** Get current ISO timestamp. */
  nowIso: () => ISODateTime;
  /** Default retry policy ID (used when no policy is specified on the node). */
  defaultPolicyId?: UUID;
  /** Default cost budget (used when no budget is specified on the policy). */
  defaultCostBudget: FridayRetryCostBudget;
}

// ─── Persistence Row Types (SQLite) ───

/** SQLite row shape for the `retry_policies` table. */
export interface FridayRetryPolicyRow {
  id: string;
  name: string;
  description: string | null;
  version: number;
  priority: number;
  enabled: number;
  tags_json: string;
  cost_budget_json: string;
  strategies_json: string;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** SQLite row shape for the `retry_traces` table. */
export interface FridayRetryTraceRow {
  id: string;
  run_id: string;
  workflow_id: string;
  node_id: string;
  status: string;
  policy_id: string;
  original_failure_category: string;
  original_error_code: string | null;
  original_error_message: string | null;
  attempts_json: string;
  total_attempts: number;
  cost_summary_json: string;
  duration_ms: number;
  first_failure_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** SQLite row shape for the `retry_attempts` table. */
export interface FridayRetryAttemptRow {
  id: string;
  trace_id: string;
  attempt_number: number;
  classified_failure_json: string;
  decision_json: string;
  delay_ms: number;
  execution_id: string | null;
  outcome: string;
  cost_record_json: string | null;
  rules_result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string;
  metadata_json: string | null;
}

/** SQLite row shape for the `retry_cost_records` table. */
export interface FridayRetryCostRecordRow {
  id: string;
  trace_id: string;
  attempt_number: number;
  run_id: string;
  node_id: string;
  cost_tokens: number;
  cost_api_calls: number;
  cost_compute_ms: number;
  cumulative_tokens: number;
  cumulative_api_calls: number;
  cumulative_compute_ms: number;
  per_attempt_budget_exceeded: number;
  total_budget_exceeded: number;
  recorded_at: string;
}

/** SQLite row shape for the `retry_escalations` table. */
export interface FridayRetryEscalationRow {
  id: string;
  trace_id: string;
  target: string;
  channel: string;
  reason: string;
  failure_category: string;
  attempt_count: number;
  total_cost_tokens: number;
  total_cost_api_calls: number;
  total_cost_compute_ms: number;
  acknowledged: number;
  escalated_at: string;
  acknowledged_at: string | null;
}

export type FridayRetryCircuitBreakerState = "closed" | "open" | "half_open";

/** Snapshot of a persisted retry circuit breaker target. */
export interface FridayRetryCircuitBreakerRecord {
  targetId: string;
  state: FridayRetryCircuitBreakerState;
  consecutiveFailures: number;
  failureThreshold: number;
  lastOpenedAt?: ISODateTime;
  tripCount: number;
  updatedAt: ISODateTime;
}

/** SQLite row shape for the `retry_circuit_breakers` table. */
export interface FridayRetryCircuitBreakerRow {
  target_id: string;
  state: string;
  consecutive_failures: number;
  failure_threshold: number;
  last_opened_at: string | null;
  trip_count: number;
  updated_at: string;
}

// ─── Row-to-Entity Mapper Signature (re-export pattern) ───

/** Generic row-to-entity mapper function type. */
export type FridayRetryRowMapper<TRow, TEntity> = (row: TRow) => TEntity;
