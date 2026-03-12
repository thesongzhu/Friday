/**
 * NodeRunner Execution Framework — API and SDK Contract.
 *
 * Request/response DTOs for the NodeRunner REST API.
 * Follows Friday API conventions: `FridayPage<T>` for pagination,
 * `FridayApiSuccessResponse<T>` / `FridayApiErrorResponse` for responses.
 *
 * @module node-runner/api
 */

import type { FridayPage, FridayPaginationQuery } from "../../api/model/friday-api-common.types.js";

import type {
  FridayNodeArtifact,
  FridayNodeExecutionStatus,
  FridayNodeRunnerErrorCode,
  FridayNodeRunnerStepResult,
} from "../model/friday-node-runner.types.js";

// Re-export so consumers can import from either location
export type { FridayNodeRunnerErrorCode } from "../model/friday-node-runner.types.js";

import type {
  ISODateTime,
  JsonObject,
  JsonValue,
  UUID,
} from "../../rules/model/friday-rules-engine.types.js";

// ─── Error Codes ───

/**
 * Standardized error codes for the NodeRunner domain.
 *
 * @example
 * ```ts
 * if (error.code === FRIDAY_NODE_RUNNER_ERROR_CODES.NODE_NOT_FOUND) { ... }
 * ```
 */
export const FRIDAY_NODE_RUNNER_ERROR_CODES = {
  /** The requested node does not exist in the workflow graph. */
  NODE_NOT_FOUND: "NODE_NOT_FOUND",
  /** No adapter is registered for the node's type. */
  NODE_ADAPTER_NOT_FOUND: "NODE_ADAPTER_NOT_FOUND",
  /** The node failed to load its configuration or dependencies. */
  NODE_LOAD_FAILED: "NODE_LOAD_FAILED",
  /** Node execution failed due to an adapter error. */
  NODE_EXECUTION_FAILED: "NODE_EXECUTION_FAILED",
  /** Node execution exceeded its timeout. */
  NODE_TIMEOUT: "NODE_TIMEOUT",
  /** Node execution was cancelled via abort signal. */
  NODE_CANCELLED: "NODE_CANCELLED",
  /** Pre-rules evaluation denied execution. */
  PRE_RULES_DENIED: "PRE_RULES_DENIED",
  /** Post-rules evaluation denied the output. */
  POST_RULES_DENIED: "POST_RULES_DENIED",
  /** Rules engine evaluation failed (internal error, not a deny decision). */
  RULE_EVALUATION_FAILED: "RULE_EVALUATION_FAILED",
  /** Input or output validation failed. */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /** The requested execution record does not exist. */
  EXECUTION_NOT_FOUND: "EXECUTION_NOT_FOUND",
  /** Post-validate acceptance testing failed. */
  ACCEPTANCE_FAILED: "ACCEPTANCE_FAILED",
  /** The execution is not in a cancellable state. */
  EXECUTION_NOT_CANCELLABLE: "EXECUTION_NOT_CANCELLABLE",
} as const satisfies Record<string, FridayNodeRunnerErrorCode>;

// ─── Pagination (reuses shared types from api/model) ───

/** Pagination query for NodeRunner endpoints. */
export type FridayNodeRunnerPaginationQuery = FridayPaginationQuery;

/** Paginated result for NodeRunner endpoints. */
export type FridayNodeRunnerPage<TItem> = FridayPage<TItem>;

// ─── Retry Hints ───

/**
 * Backoff strategy for retry hints.
 */
export type FridayRetryBackoffStrategy = "none" | "fixed" | "exponential";

/**
 * Retry hint returned when an execution fails with a retryable error.
 * The workflow engine (or SDK consumer) may use this to decide whether
 * and when to retry.
 */
export interface FridayRetryHint {
  /** Whether the error is retryable. */
  retryable: boolean;
  /** Suggested delay before retry in milliseconds. */
  retryAfterMs?: number;
  /** Maximum number of retry attempts. */
  maxRetries?: number;
  /** Backoff strategy. */
  backoff?: FridayRetryBackoffStrategy;
  /** Reason the error is or is not retryable. */
  reason?: string;
}

// ─── Execute Node ───

/**
 * Request body for `POST /api/node-runner/execute`.
 *
 * Triggers a single node execution through the 6-step pipeline.
 *
 * @openapi operationId: executeNode
 */
export interface FridayExecuteNodeRequest {
  /** Workflow run ID (parent context). */
  runId: UUID;
  /** Workflow definition ID. */
  workflowId: UUID;
  /** Node ID within the workflow graph. */
  nodeId: string;
  /** Attempt number (1-based). */
  attemptNumber?: number;
  /** Input data from upstream nodes. */
  inputData: Record<string, unknown>;
  /** Execution timeout override in milliseconds. */
  timeoutMs?: number;
  /** Arbitrary execution metadata. */
  metadata?: JsonObject;
}

/**
 * Response body for `POST /api/node-runner/execute`.
 *
 * @openapi operationId: executeNode
 */
export interface FridayExecuteNodeResponse {
  /** Unique execution ID. */
  executionId: UUID;
  /** Final execution status. */
  status: FridayNodeExecutionStatus;
  /** Output data (present only when status is "completed"). */
  output?: JsonValue;
  /** Artifacts produced (present only when status is "completed"). */
  artifacts?: FridayNodeArtifact[];
  /** Per-step results for debugging. */
  stepResults: FridayNodeRunnerStepResult[];
  /** Total pipeline duration in milliseconds. */
  durationMs: number;
  /** Error code if the execution failed. */
  errorCode?: FridayNodeRunnerErrorCode;
  /** Human-readable error message if the execution failed. */
  errorMessage?: string;
  /** Retry hint (present when the error may be transient). */
  retryHint?: FridayRetryHint;
  /** Pipeline start timestamp. */
  startedAt: ISODateTime;
  /** Pipeline end timestamp. */
  completedAt: ISODateTime;
}

// ─── Get Execution Status ───

/**
 * Response body for `GET /api/node-runner/executions/:executionId/status`.
 *
 * Lightweight status check (no step details or output).
 *
 * @openapi operationId: getNodeExecutionStatus
 */
export interface FridayGetNodeExecutionStatusResponse {
  /** Execution ID. */
  executionId: UUID;
  /** Current execution status. */
  status: FridayNodeExecutionStatus;
  /** Duration so far (or total if terminal). */
  durationMs: number;
  /** Error code if the execution failed. */
  errorCode?: FridayNodeRunnerErrorCode;
  /** Pipeline start timestamp. */
  startedAt: ISODateTime;
  /** Pipeline end timestamp (null if still running). */
  completedAt?: ISODateTime;
}

// ─── Get Execution Detail ───

/**
 * Response body for `GET /api/node-runner/executions/:executionId`.
 *
 * Full execution record with step results, output, and metadata.
 *
 * @openapi operationId: getNodeExecutionDetail
 */
export interface FridayGetNodeExecutionDetailResponse {
  /** Execution ID. */
  executionId: UUID;
  /** Parent workflow run ID. */
  runId: UUID;
  /** Parent workflow definition ID. */
  workflowId: UUID;
  /** Node ID within the graph. */
  nodeId: string;
  /** Attempt number. */
  attemptNumber: number;
  /** Resolved adapter key (e.g. `action:skill`, `action:tool`, `ai`). */
  adapterType: string;
  /** Final execution status. */
  status: FridayNodeExecutionStatus;
  /** Output data (present only when completed). */
  output?: JsonValue;
  /** Artifacts produced. */
  artifacts?: FridayNodeArtifact[];
  /** Per-step results. */
  stepResults: FridayNodeRunnerStepResult[];
  /** Total pipeline duration in milliseconds. */
  durationMs: number;
  /** Error code if failed. */
  errorCode?: FridayNodeRunnerErrorCode;
  /** Error message if failed. */
  errorMessage?: string;
  /** Input data (may be redacted). */
  inputData: Record<string, unknown>;
  /** Resolved config (may be redacted). */
  resolvedConfig?: JsonObject;
  /** Execution metadata. */
  metadata: JsonObject;
  /** Pipeline start timestamp. */
  startedAt: ISODateTime;
  /** Pipeline end timestamp. */
  completedAt: ISODateTime;
}

// ─── List Executions ───

/**
 * Query parameters for `GET /api/node-runner/executions`.
 *
 * @openapi operationId: listNodeExecutions
 */
export interface FridayListNodeExecutionsQuery extends FridayNodeRunnerPaginationQuery {
  /** Filter by workflow run ID. */
  runId?: UUID;
  /** Filter by workflow definition ID. */
  workflowId?: UUID;
  /** Filter by node ID. */
  nodeId?: string;
  /** Filter by execution status. */
  status?: FridayNodeExecutionStatus;
  /** Filter executions started after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter executions started before this timestamp (exclusive). */
  before?: ISODateTime;
}

/**
 * Response body for `GET /api/node-runner/executions`.
 *
 * @openapi operationId: listNodeExecutions
 */
export interface FridayListNodeExecutionsResponse extends FridayNodeRunnerPage<FridayNodeExecutionSummary> {}

/**
 * Summary of a node execution for list views.
 * Omits large fields (output, stepResults) for efficiency.
 */
export interface FridayNodeExecutionSummary {
  /** Execution ID. */
  executionId: UUID;
  /** Parent workflow run ID. */
  runId: UUID;
  /** Parent workflow definition ID. */
  workflowId: UUID;
  /** Node ID within the graph. */
  nodeId: string;
  /** Attempt number. */
  attemptNumber: number;
  /** Resolved adapter key (e.g. `action:skill`, `action:tool`, `ai`). */
  adapterType: string;
  /** Final execution status. */
  status: FridayNodeExecutionStatus;
  /** Error code if failed. */
  errorCode?: FridayNodeRunnerErrorCode;
  /** Total pipeline duration in milliseconds. */
  durationMs: number;
  /** Pipeline start timestamp. */
  startedAt: ISODateTime;
  /** Pipeline end timestamp. */
  completedAt: ISODateTime;
}

// ─── Cancel Execution ───

/**
 * Request body for `POST /api/node-runner/executions/:executionId/cancel`.
 *
 * @openapi operationId: cancelNodeExecution
 */
export interface FridayCancelNodeExecutionRequest {
  /** Reason for cancellation. */
  reason?: string;
}

/**
 * Response body for `POST /api/node-runner/executions/:executionId/cancel`.
 *
 * @openapi operationId: cancelNodeExecution
 */
export interface FridayCancelNodeExecutionResponse {
  /** Execution ID. */
  executionId: UUID;
  /** Updated execution status. */
  status: "cancelled";
  /** When the cancellation was processed. */
  cancelledAt: ISODateTime;
}
