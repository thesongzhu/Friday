/**
 * Acceptance Testing Layer — API and SDK Contract.
 *
 * Request/response DTOs for the acceptance testing REST API.
 * All types follow Friday API conventions: `FridayPage<T>` for pagination,
 * `FridayApiSuccessResponse<T>` / `FridayApiErrorResponse` for responses.
 *
 * @module acceptance/api
 */

import type { FridayPage, FridayPaginationQuery } from "../../api/model/friday-api-common.types.js";

import type {
  FridayAcceptanceArtifactType,
  FridayAcceptanceCheck,
  FridayAcceptanceCheckConfig,
  FridayAcceptanceCheckType,
  FridayAcceptanceRunResult,
  FridayAcceptanceSeverity,
  FridayAcceptanceTest,
  FridayAcceptanceVerdictOutcome,
} from "../model/friday-acceptance.types.js";

import type {
  ISODateTime,
  JsonObject,
  UUID,
} from "../../rules/model/friday-rules-engine.types.js";

import type { FridayNodeArtifact } from "../../node-runner/model/friday-node-runner.types.js";

// ─── Error Codes ───

/**
 * Standardized error codes for the acceptance testing domain.
 *
 * @example
 * ```ts
 * if (error.code === FRIDAY_ACCEPTANCE_ERROR_CODES.TEST_NOT_FOUND) { ... }
 * ```
 */
export const FRIDAY_ACCEPTANCE_ERROR_CODES = {
  /** The requested acceptance test does not exist or has been deleted. */
  TEST_NOT_FOUND: "ACCEPTANCE_TEST_NOT_FOUND",
  /** The requested acceptance run does not exist. */
  RUN_NOT_FOUND: "ACCEPTANCE_RUN_NOT_FOUND",
  /** An acceptance test with the same ID already exists for the artifact type. */
  TEST_DUPLICATE_ID: "ACCEPTANCE_TEST_DUPLICATE_ID",
  /** The acceptance test definition failed validation. */
  TEST_VALIDATION_FAILED: "ACCEPTANCE_TEST_VALIDATION_FAILED",
  /** Optimistic concurrency conflict — the etag does not match. */
  TEST_ETAG_MISMATCH: "ACCEPTANCE_TEST_ETAG_MISMATCH",
  /** Acceptance check execution failed due to an internal error. */
  CHECK_EXECUTION_FAILED: "ACCEPTANCE_CHECK_EXECUTION_FAILED",
  /** The referenced Rules Engine policy bundle was not found. */
  RULE_POLICY_BUNDLE_NOT_FOUND: "ACCEPTANCE_RULE_POLICY_BUNDLE_NOT_FOUND",
  /** The artifact URI could not be retrieved. */
  ARTIFACT_NOT_ACCESSIBLE: "ACCEPTANCE_ARTIFACT_NOT_ACCESSIBLE",
  /** The artifact exceeds the maximum allowed size. */
  ARTIFACT_TOO_LARGE: "ACCEPTANCE_ARTIFACT_TOO_LARGE",
  /** The custom check handler reference could not be resolved. */
  CUSTOM_HANDLER_NOT_FOUND: "ACCEPTANCE_CUSTOM_HANDLER_NOT_FOUND",
  /** Idempotency key reused with a different payload inside retention window. */
  IDEMPOTENCY_KEY_CONFLICT: "ACCEPTANCE_IDEMPOTENCY_KEY_CONFLICT",
} as const;

/** Union type of all acceptance testing error codes. */
export type FridayAcceptanceErrorCode =
  (typeof FRIDAY_ACCEPTANCE_ERROR_CODES)[keyof typeof FRIDAY_ACCEPTANCE_ERROR_CODES];

// ─── Pagination (reuses shared types from api/model) ───

/** Pagination query for acceptance testing endpoints. */
export type FridayAcceptancePaginationQuery = FridayPaginationQuery;

/** Paginated result for acceptance testing endpoints. */
export type FridayAcceptancePage<TItem> = FridayPage<TItem>;

// ─── Idempotency Contract ───

/** Idempotency TTL in hours for `run` and `register` operations only. */
export const FRIDAY_ACCEPTANCE_IDEMPOTENCY_TTL_HOURS = 24 as const;

/**
 * Idempotency contract specification for `run` and `register` operations only.
 * Applies to `POST /api/acceptance/run` and `POST /api/acceptance/tests`.
 */
export interface FridayAcceptanceIdempotencyContract {
  /** Scope is (principalId, operationId, key). */
  scope: "principal+operation";
  /** Keys expire after 24 hours. */
  ttlHours: 24;
  /** Same payload hash returns the original response. */
  replayBehavior: "same_payload_returns_original_response";
  /** Different payload hash returns 409. */
  conflict: { httpStatus: 409; code: "ACCEPTANCE_IDEMPOTENCY_KEY_CONFLICT" };
}

// ─── Run Acceptance Tests ───

/**
 * Request body for `POST /api/acceptance/run`.
 *
 * Runs all registered acceptance tests against the provided artifact(s).
 *
 * @openapi operationId: runAcceptanceTests
 */
export interface FridayRunAcceptanceTestsRequest {
  /** NodeRunner execution ID (parent context). */
  executionId: UUID;
  /** Artifacts to test. */
  artifacts: FridayNodeArtifact[];
  /** Optional execution metadata. */
  metadata?: JsonObject;
  /**
   * Idempotency key to prevent duplicate runs.
   * See {@link FridayAcceptanceIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/acceptance/run`.
 *
 * @openapi operationId: runAcceptanceTests
 */
export interface FridayRunAcceptanceTestsResponse {
  /** Whether all artifacts passed acceptance. */
  passed: boolean;
  /** Per-artifact run results. */
  runs: FridayAcceptanceRunResult[];
  /** Total acceptance duration in milliseconds. */
  durationMs: number;
}

// ─── Get Acceptance Run ───

/**
 * Response body for `GET /api/acceptance/runs/:runId`.
 *
 * @openapi operationId: getAcceptanceRun
 */
export interface FridayGetAcceptanceRunResponse {
  /** The acceptance run result. */
  run: FridayAcceptanceRunResult;
}

// ─── List Acceptance Tests ───

/**
 * Query parameters for `GET /api/acceptance/tests`.
 *
 * @openapi operationId: listAcceptanceTests
 */
export interface FridayListAcceptanceTestsQuery extends FridayAcceptancePaginationQuery {
  /** Filter by artifact type. */
  artifactType?: FridayAcceptanceArtifactType;
  /** Filter by check type. */
  checkType?: FridayAcceptanceCheckType;
  /** Filter by enabled status. */
  enabled?: boolean;
  /** Filter by tag (matches any test containing this tag). */
  tag?: string;
  /** Include soft-deleted tests. */
  includeDeleted?: boolean;
}

/**
 * Response body for `GET /api/acceptance/tests`.
 *
 * @openapi operationId: listAcceptanceTests
 */
export interface FridayListAcceptanceTestsResponse extends FridayAcceptancePage<FridayAcceptanceTest> {}

// ─── Get Acceptance Test ───

/**
 * Response body for `GET /api/acceptance/tests/:testId`.
 *
 * @openapi operationId: getAcceptanceTest
 */
export interface FridayGetAcceptanceTestResponse {
  /** The requested acceptance test. */
  test: FridayAcceptanceTest;
}

// ─── Register Acceptance Test ───

/**
 * Request body for `POST /api/acceptance/tests`.
 *
 * @openapi operationId: registerAcceptanceTest
 */
export interface FridayRegisterAcceptanceTestRequest {
  /** Human-readable test name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Target artifact type. */
  artifactType: FridayAcceptanceArtifactType;
  /** Check type and configuration. */
  checkConfig: FridayAcceptanceCheckConfig;
  /**
   * Execution priority within its artifact type. Lower number = runs first.
   * @default 100
   */
  priority?: number;
  /** Whether this test is enabled on creation. */
  enabled?: boolean;
  /**
   * If true, stop testing this artifact after this check fails.
   * @default false
   */
  shortCircuit?: boolean;
  /** Optional Rules Engine policy bundle ID for rule-linked checks. */
  rulePolicyBundleId?: UUID;
  /** Tags for filtering and organization. */
  tags?: string[];
  /**
   * Idempotency key to prevent duplicate registration.
   * See {@link FridayAcceptanceIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/acceptance/tests`.
 *
 * @openapi operationId: registerAcceptanceTest
 */
export interface FridayRegisterAcceptanceTestResponse {
  /** The created acceptance test. */
  test: FridayAcceptanceTest;
}

// ─── Update Acceptance Test ───

/**
 * Request body for `PUT /api/acceptance/tests/:testId`.
 *
 * Uses optimistic concurrency — the `etag` must match the current test version.
 *
 * @openapi operationId: updateAcceptanceTest
 */
export interface FridayUpdateAcceptanceTestRequest {
  /** Required optimistic concurrency token. */
  etag: string;
  /** Updated test name. */
  name?: string;
  /** Updated description. */
  description?: string;
  /** Updated artifact type. */
  artifactType?: FridayAcceptanceArtifactType;
  /** Updated check configuration. */
  checkConfig?: FridayAcceptanceCheckConfig;
  /** Updated priority. */
  priority?: number;
  /** Updated enabled status. */
  enabled?: boolean;
  /** Updated short-circuit flag. */
  shortCircuit?: boolean;
  /** Updated Rules Engine policy bundle ID (set to null to remove). */
  rulePolicyBundleId?: UUID | null;
  /** Updated tags. */
  tags?: string[];
}

/**
 * Response body for `PUT /api/acceptance/tests/:testId`.
 *
 * @openapi operationId: updateAcceptanceTest
 */
export interface FridayUpdateAcceptanceTestResponse {
  /** The updated acceptance test. */
  test: FridayAcceptanceTest;
}

// ─── Delete Acceptance Test ───

/**
 * Request body for `DELETE /api/acceptance/tests/:testId`.
 *
 * @openapi operationId: deleteAcceptanceTest
 */
export interface FridayDeleteAcceptanceTestRequest {
  /** Required optimistic concurrency token. */
  etag: string;
}

/**
 * Response body for `DELETE /api/acceptance/tests/:testId`.
 *
 * @openapi operationId: deleteAcceptanceTest
 */
export interface FridayDeleteAcceptanceTestResponse {
  /** Confirmation of deletion. */
  deleted: true;
  /** ID of the deleted test. */
  testId: UUID;
}

// ─── Artifact Acceptance History ───

/**
 * Query parameters for `GET /api/acceptance/artifacts/:artifactUri/history`.
 *
 * @openapi operationId: getArtifactAcceptanceHistory
 */
export interface FridayGetArtifactAcceptanceHistoryQuery extends FridayAcceptancePaginationQuery {
  /** Filter by overall verdict. */
  verdict?: FridayAcceptanceVerdictOutcome;
  /** Filter by overall severity. */
  severity?: FridayAcceptanceSeverity;
  /** Filter runs after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter runs before this timestamp (exclusive). */
  before?: ISODateTime;
}

/** Summary of an acceptance run for history views. */
export interface FridayAcceptanceRunSummary {
  /** Acceptance run ID. */
  id: UUID;
  /** NodeRunner execution ID. */
  executionId: UUID;
  /** Artifact URI. */
  artifactUri: string;
  /** Artifact type. */
  artifactType: FridayAcceptanceArtifactType;
  /** Overall verdict. */
  overallVerdict: FridayAcceptanceVerdictOutcome;
  /** Overall severity. */
  overallSeverity: FridayAcceptanceSeverity;
  /** Total checks executed. */
  checksTotal: number;
  /** Checks that passed. */
  checksPassed: number;
  /** Checks that failed. */
  checksFailed: number;
  /** Total acceptance run duration in milliseconds. */
  durationMs: number;
  /** When this run was created. */
  createdAt: ISODateTime;
}

/**
 * Response body for `GET /api/acceptance/artifacts/:artifactUri/history`.
 *
 * @openapi operationId: getArtifactAcceptanceHistory
 */
export interface FridayGetArtifactAcceptanceHistoryResponse
  extends FridayAcceptancePage<FridayAcceptanceRunSummary> {}
