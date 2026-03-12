/**
 * Retry Engine — API and SDK Contract.
 *
 * Request/response DTOs for the retry engine REST API.
 * All types follow Friday API conventions: `FridayPage<T>` for pagination,
 * `FridayApiSuccessResponse<T>` / `FridayApiErrorResponse` for responses.
 *
 * @module retry/api
 */

import type { FridayPage, FridayPaginationQuery } from "../../api/model/friday-api-common.types.js";

import type {
  FridayClassifiedFailure,
  FridayFailureCategory,
  FridayRetryAttempt,
  FridayRetryCostBudget,
  FridayRetryCostDimensions,
  FridayRetryCostSummary,
  FridayRetryDecision,
  FridayRetryEscalation,
  FridayRetryPolicy,
  FridayRetryStrategy,
  FridayRetryStrategyType,
  FridayRetryTrace,
  FridayRetryTraceStatus,
} from "../model/friday-retry-engine.types.js";

import type {
  ISODateTime,
  JsonObject,
  UUID,
} from "../../rules/model/friday-rules-engine.types.js";

import type {
  FridayRetryHint,
} from "../../node-runner/api/friday-node-runner-api.types.js";

// ─── Error Codes ───

/**
 * Standardized error codes for the retry engine domain.
 *
 * @example
 * ```ts
 * if (error.code === FRIDAY_RETRY_ERROR_CODES.POLICY_NOT_FOUND) { ... }
 * ```
 */
export const FRIDAY_RETRY_ERROR_CODES = {
  /** The requested retry policy does not exist or has been deleted. */
  POLICY_NOT_FOUND: "RETRY_POLICY_NOT_FOUND",
  /** The requested retry trace does not exist. */
  TRACE_NOT_FOUND: "RETRY_TRACE_NOT_FOUND",
  /** The retry policy definition failed validation. */
  POLICY_VALIDATION_FAILED: "RETRY_POLICY_VALIDATION_FAILED",
  /** The retry policy YAML failed parsing or schema validation. */
  POLICY_PARSE_FAILED: "RETRY_POLICY_PARSE_FAILED",
  /** Optimistic concurrency conflict — the etag does not match. */
  POLICY_ETAG_MISMATCH: "RETRY_POLICY_ETAG_MISMATCH",
  /** A retry policy with the same ID already exists. */
  POLICY_DUPLICATE_ID: "RETRY_POLICY_DUPLICATE_ID",
  /** Failure classification failed due to an internal error. */
  CLASSIFICATION_FAILED: "RETRY_CLASSIFICATION_FAILED",
  /** Retry decision failed due to an internal error. */
  DECISION_FAILED: "RETRY_DECISION_FAILED",
  /** Retry cost budget has been exceeded. */
  BUDGET_EXCEEDED: "RETRY_BUDGET_EXCEEDED",
  /** Rules Engine denied the retry. */
  RULES_DENIED: "RETRY_RULES_DENIED",
  /** The escalation was not found. */
  ESCALATION_NOT_FOUND: "RETRY_ESCALATION_NOT_FOUND",
  /** Idempotency key reused with a different payload inside retention window. */
  IDEMPOTENCY_KEY_CONFLICT: "RETRY_IDEMPOTENCY_KEY_CONFLICT",
} as const;

/** Union type of all retry engine error codes. */
export type FridayRetryErrorCode =
  (typeof FRIDAY_RETRY_ERROR_CODES)[keyof typeof FRIDAY_RETRY_ERROR_CODES];

// ─── Pagination (reuses shared types from api/model) ───

/** Pagination query for retry engine endpoints. */
export type FridayRetryPaginationQuery = FridayPaginationQuery;

/** Paginated result for retry engine endpoints. */
export type FridayRetryPage<TItem> = FridayPage<TItem>;

// ─── Idempotency Contract ───

/** Idempotency TTL in hours for retry API write operations. */
export const FRIDAY_RETRY_IDEMPOTENCY_TTL_HOURS = 24 as const;

/** Idempotency contract specification for retry API write operations. */
export interface FridayRetryIdempotencyContract {
  /** Scope is (principalId, operationId, key). */
  scope: "principal+operation";
  /** Keys expire after 24 hours. */
  ttlHours: 24;
  /** Same payload hash returns the original response. */
  replayBehavior: "same_payload_returns_original_response";
  /** Different payload hash returns 409. */
  conflict: { httpStatus: 409; code: "RETRY_IDEMPOTENCY_KEY_CONFLICT" };
}

// ─── Classify Failure Error ───

/**
 * Error descriptor for failure classification requests.
 * At least one of `errorCode`, `errorMessage`, or `httpStatusCode` must be provided
 * so the classifier has a signal to work with.
 */
export type FridayClassifyFailureError =
  | { errorCode: string; errorMessage?: string; httpStatusCode?: number }
  | { errorCode?: string; errorMessage: string; httpStatusCode?: number }
  | { errorCode?: string; errorMessage?: string; httpStatusCode: number };

// ─── Classify Failure ───

/**
 * Request body for `POST /api/retry/classify`.
 *
 * Submits a raw failure for classification into the failure taxonomy.
 *
 * @openapi operationId: classifyFailure
 */
export interface FridayClassifyFailureRequest {
  /**
   * Error descriptor — required. Must contain at least one of
   * `errorCode`, `errorMessage`, or `httpStatusCode`.
   */
  error: FridayClassifyFailureError;
  /** Retry hint from the NodeRunner adapter (if available). */
  retryHint?: FridayRetryHint;
  /** NodeRunner execution ID for correlation. */
  executionId?: UUID;
  /** Parent workflow run ID for correlation. */
  runId?: UUID;
  /** Node ID for correlation. */
  nodeId?: string;
  /** Additional metadata for classification. */
  metadata?: JsonObject;
}

/**
 * Response body for `POST /api/retry/classify`.
 *
 * @openapi operationId: classifyFailure
 */
export interface FridayClassifyFailureResponse {
  /** The classified failure. */
  classifiedFailure: FridayClassifiedFailure;
}

// ─── Get Retry Decision ───

/**
 * Request body for `POST /api/retry/decide`.
 *
 * Given a classified failure and context, produces a retry decision.
 *
 * @openapi operationId: getRetryDecision
 */
export interface FridayGetRetryDecisionRequest {
  /** The classified failure — required. Obtain via `POST /api/retry/classify` first. */
  classifiedFailure: FridayClassifiedFailure;
  /** Parent workflow run ID. */
  runId: UUID;
  /** Parent workflow definition ID. */
  workflowId: UUID;
  /** Node ID within the workflow graph. */
  nodeId: string;
  /** Current attempt number (before the potential retry). */
  currentAttemptNumber: number;
  /** Retry policy ID to use (overrides node-level policy). */
  retryPolicyId?: UUID;
  /** Accumulated cost so far for this (runId, nodeId) pair. */
  accumulatedCost?: FridayRetryCostDimensions;
  /** Execution metadata for Rules Engine context. */
  metadata?: JsonObject;
  /**
   * If true, evaluate the decision but do not persist a trace entry.
   * Useful for dry-run scenarios.
   */
  dryRun?: boolean;
}

/**
 * Response body for `POST /api/retry/decide`.
 *
 * @openapi operationId: getRetryDecision
 */
export interface FridayGetRetryDecisionResponse {
  /** The classified failure used for decisioning. */
  classifiedFailure: FridayClassifiedFailure;
  /** The retry decision. */
  decision: FridayRetryDecision;
}

// ─── List Retry Traces ───

/**
 * Query parameters for `GET /api/retry/traces`.
 *
 * @openapi operationId: listRetryTraces
 */
export interface FridayListRetryTracesQuery extends FridayRetryPaginationQuery {
  /** Filter by workflow run ID. */
  runId?: UUID;
  /** Filter by workflow definition ID. */
  workflowId?: UUID;
  /** Filter by node ID. */
  nodeId?: string;
  /** Filter by trace status. */
  status?: FridayRetryTraceStatus;
  /** Filter by original failure category. */
  failureCategory?: FridayFailureCategory;
  /** Filter by retry policy ID. */
  policyId?: UUID;
  /** Filter traces created after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter traces created before this timestamp (exclusive). */
  before?: ISODateTime;
}

/**
 * Summary of a retry trace for list views.
 * Omits large fields (attempts, costSummary details) for efficiency.
 */
export interface FridayRetryTraceSummary {
  /** Trace ID. */
  id: UUID;
  /** Parent workflow run ID. */
  runId: UUID;
  /** Parent workflow definition ID. */
  workflowId: UUID;
  /** Node ID within the graph. */
  nodeId: string;
  /** Trace status. */
  status: FridayRetryTraceStatus;
  /** Retry policy ID. */
  policyId: UUID;
  /** Original failure category. */
  originalFailureCategory: FridayFailureCategory;
  /** Original error code. */
  originalErrorCode?: string;
  /** Total number of attempts. */
  totalAttempts: number;
  /** Total cost (aggregated). */
  totalCost: FridayRetryCostDimensions;
  /** Whether the cost budget was exceeded. */
  budgetExceeded: boolean;
  /** Total trace duration in milliseconds. */
  durationMs: number;
  /** When the first failure occurred. */
  firstFailureAt: ISODateTime;
  /** When the trace was resolved. */
  resolvedAt?: ISODateTime;
  /** When the trace was created. */
  createdAt: ISODateTime;
}

/**
 * Response body for `GET /api/retry/traces`.
 *
 * @openapi operationId: listRetryTraces
 */
export interface FridayListRetryTracesResponse extends FridayRetryPage<FridayRetryTraceSummary> {}

// ─── Get Retry Trace ───

/**
 * Response body for `GET /api/retry/traces/:traceId`.
 *
 * Full trace detail with all attempts and cost records.
 *
 * @openapi operationId: getRetryTrace
 */
export interface FridayGetRetryTraceResponse {
  /** The full retry trace. */
  trace: FridayRetryTrace;
}

// ─── Configure Retry Policies ───

/**
 * Query parameters for `GET /api/retry/policies`.
 *
 * @openapi operationId: listRetryPolicies
 */
export interface FridayListRetryPoliciesQuery extends FridayRetryPaginationQuery {
  /** Filter by enabled status. */
  enabled?: boolean;
  /** Filter by tag (matches any policy containing this tag). */
  tag?: string;
  /** Include soft-deleted policies. */
  includeDeleted?: boolean;
}

/**
 * Response body for `GET /api/retry/policies`.
 *
 * @openapi operationId: listRetryPolicies
 */
export interface FridayListRetryPoliciesResponse extends FridayRetryPage<FridayRetryPolicy> {}

/**
 * Response body for `GET /api/retry/policies/:policyId`.
 *
 * @openapi operationId: getRetryPolicy
 */
export interface FridayGetRetryPolicyResponse {
  /** The requested retry policy. */
  policy: FridayRetryPolicy;
}

/**
 * Request body for `POST /api/retry/policies`.
 *
 * @openapi operationId: createRetryPolicy
 */
export interface FridayCreateRetryPolicyRequest {
  /** Human-readable name. */
  name: string;
  /** Optional description. */
  description?: string;
  /**
   * Policy priority. Lower number = higher priority.
   * @default 100
   */
  priority?: number;
  /** Whether the policy is enabled on creation. */
  enabled?: boolean;
  /** Tags for filtering. */
  tags?: string[];
  /** Cost budget for retries under this policy. */
  costBudget: FridayRetryCostBudget;
  /** Per-category retry strategies. */
  strategies: FridayRetryStrategy[];
  /**
   * Idempotency key to prevent duplicate creation.
   * See {@link FridayRetryIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/retry/policies`.
 *
 * @openapi operationId: createRetryPolicy
 */
export interface FridayCreateRetryPolicyResponse {
  /** The created retry policy. */
  policy: FridayRetryPolicy;
}

/**
 * Request body for `PUT /api/retry/policies/:policyId`.
 *
 * Uses optimistic concurrency — the `etag` must match the current policy version.
 *
 * @openapi operationId: updateRetryPolicy
 */
export interface FridayUpdateRetryPolicyRequest {
  /** Required optimistic concurrency token. */
  etag: string;
  /** Updated name. */
  name?: string;
  /** Updated description. */
  description?: string;
  /** Updated priority. */
  priority?: number;
  /** Updated enabled status. */
  enabled?: boolean;
  /** Updated tags. */
  tags?: string[];
  /** Updated cost budget. */
  costBudget?: FridayRetryCostBudget;
  /** Updated strategies. */
  strategies?: FridayRetryStrategy[];
}

/**
 * Response body for `PUT /api/retry/policies/:policyId`.
 *
 * @openapi operationId: updateRetryPolicy
 */
export interface FridayUpdateRetryPolicyResponse {
  /** The updated retry policy. */
  policy: FridayRetryPolicy;
}

/**
 * Request body for `DELETE /api/retry/policies/:policyId`.
 *
 * @openapi operationId: deleteRetryPolicy
 */
export interface FridayDeleteRetryPolicyRequest {
  /** Required optimistic concurrency token. */
  etag: string;
}

/**
 * Response body for `DELETE /api/retry/policies/:policyId`.
 *
 * @openapi operationId: deleteRetryPolicy
 */
export interface FridayDeleteRetryPolicyResponse {
  /** Confirmation of deletion. */
  deleted: true;
  /** ID of the deleted policy. */
  policyId: UUID;
}

// ─── Import Retry Policy (from YAML) ───

/**
 * Request body for `POST /api/retry/policies/import`.
 *
 * Imports a YAML retry policy, creating or updating the policy.
 *
 * @openapi operationId: importRetryPolicy
 */
export interface FridayImportRetryPolicyRequest {
  /** Raw YAML content of the retry policy. */
  yaml: string;
  /** If true, overwrite existing policy with the same ID. */
  overwrite?: boolean;
  /**
   * Idempotency key to prevent duplicate imports.
   * See {@link FridayRetryIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/retry/policies/import`.
 *
 * @openapi operationId: importRetryPolicy
 */
export interface FridayImportRetryPolicyResponse {
  /** The imported retry policy. */
  policy: FridayRetryPolicy;
  /** Whether the policy was created (true) or updated (false). */
  created: boolean;
}

// ─── Cost Accounting Summary ───

/**
 * Query parameters for `GET /api/retry/costs`.
 *
 * @openapi operationId: getRetryCostSummary
 */
export interface FridayGetRetryCostSummaryQuery {
  /** Filter by workflow run ID. */
  runId?: UUID;
  /** Filter by workflow definition ID. */
  workflowId?: UUID;
  /** Filter by node ID. */
  nodeId?: string;
  /** Filter by retry policy ID. */
  policyId?: UUID;
  /** Filter costs recorded after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter costs recorded before this timestamp (exclusive). */
  before?: ISODateTime;
}

/**
 * Response body for `GET /api/retry/costs`.
 *
 * @openapi operationId: getRetryCostSummary
 */
export interface FridayGetRetryCostSummaryResponse {
  /** Aggregated cost summary. */
  summary: FridayRetryCostSummary;
  /** Breakdown by failure category. */
  byCategory: FridayRetryCostCategoryBreakdown[];
  /** Breakdown by node ID (if filtered by runId). */
  byNode?: FridayRetryCostNodeBreakdown[];
}

/** Cost breakdown for a single failure category. */
export interface FridayRetryCostCategoryBreakdown {
  /** Failure category. */
  category: FridayFailureCategory;
  /** Total cost for this category. */
  totalCost: FridayRetryCostDimensions;
  /** Total retry attempts in this category. */
  totalAttempts: number;
  /** Number of successful retries (resolved). */
  resolved: number;
  /** Number of escalated retries. */
  escalated: number;
}

/** Cost breakdown for a single node within a workflow run. */
export interface FridayRetryCostNodeBreakdown {
  /** Node ID. */
  nodeId: string;
  /** Total cost for this node. */
  totalCost: FridayRetryCostDimensions;
  /** Total retry attempts for this node. */
  totalAttempts: number;
  /** Trace status for this node's most recent trace. */
  latestTraceStatus: FridayRetryTraceStatus;
}

// ─── List Escalations ───

/**
 * Query parameters for `GET /api/retry/escalations`.
 *
 * @openapi operationId: listRetryEscalations
 */
export interface FridayListRetryEscalationsQuery extends FridayRetryPaginationQuery {
  /** Filter by trace ID. */
  traceId?: UUID;
  /** Filter by acknowledgement status. */
  acknowledged?: boolean;
  /** Filter by failure category. */
  failureCategory?: FridayFailureCategory;
  /** Filter escalations after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter escalations before this timestamp (exclusive). */
  before?: ISODateTime;
}

/**
 * Response body for `GET /api/retry/escalations`.
 *
 * @openapi operationId: listRetryEscalations
 */
export interface FridayListRetryEscalationsResponse extends FridayRetryPage<FridayRetryEscalation> {}

/**
 * Request body for `POST /api/retry/escalations/:escalationId/acknowledge`.
 *
 * @openapi operationId: acknowledgeRetryEscalation
 */
export interface FridayAcknowledgeRetryEscalationRequest {
  /** Optional acknowledgement note. */
  note?: string;
}

/**
 * Response body for `POST /api/retry/escalations/:escalationId/acknowledge`.
 *
 * @openapi operationId: acknowledgeRetryEscalation
 */
export interface FridayAcknowledgeRetryEscalationResponse {
  /** The updated escalation. */
  escalation: FridayRetryEscalation;
}

// ─── Retry Hint Compatibility ───

/**
 * Extended retry hint that includes Retry Engine classification.
 * Compatible with NodeRunner's `FridayRetryHint` and enriched with
 * taxonomy information.
 *
 * This type is returned by the Retry Engine when a NodeRunner
 * execution result includes a retry hint, bridging the two systems.
 */
export interface FridayEnrichedRetryHint extends FridayRetryHint {
  /** Failure category from the Retry Engine taxonomy. */
  failureCategory: FridayFailureCategory;
  /** Strategy type selected by the Retry Engine. */
  strategyType: FridayRetryStrategyType;
  /** Whether the retry was constrained by cost budget. */
  budgetConstrained: boolean;
  /** Whether the Rules Engine overrode the decision. */
  rulesOverride: boolean;
}
