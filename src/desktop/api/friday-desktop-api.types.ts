/**
 * Desktop Control Runtime — API and SDK Contract.
 *
 * Request/response DTOs for the desktop control REST API.
 * All types follow Friday API conventions: `FridayPage<T>` for pagination,
 * `FridayApiSuccessResponse<T>` / `FridayApiErrorResponse` for responses.
 *
 * @module desktop/api
 */

import type { FridayPage, FridayPaginationQuery } from "../../api/model/friday-api-common.types.js";

import type {
  FridayDesktopActionStatus,
  FridayDesktopActionType,
  FridayDesktopBounds,
  FridayDesktopCapability,
  FridayDesktopErrorCode,
  FridayDesktopOsPermissionStatus,
  FridayDesktopOsPermissionType,
  FridayDesktopPermissionDecisionValue,
  FridayDesktopPermissionHumanDecision,
  FridayDesktopPlatform,
  FridayDesktopPolicyDecision,
  FridayDesktopRecordingParameterMap,
  FridayDesktopRecordingState,
  FridayDesktopRiskLevel,
  FridayDesktopSelectorStrategy,
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/friday-desktop.types.js";

// ═══════════════════════════════════════════════════════════════════════
// ERROR CODES (re-exported from domain model)
// ═══════════════════════════════════════════════════════════════════════

export { FRIDAY_DESKTOP_ERROR_CODES } from "../model/friday-desktop.types.js";
export type { FridayDesktopErrorCode } from "../model/friday-desktop.types.js";

// ═══════════════════════════════════════════════════════════════════════
// PAGINATION
// ═══════════════════════════════════════════════════════════════════════

/** Pagination query for desktop endpoints. */
export type FridayDesktopPaginationQuery = FridayPaginationQuery;

/** Paginated result for desktop endpoints. */
export type FridayDesktopPage<TItem> = FridayPage<TItem>;

// ═══════════════════════════════════════════════════════════════════════
// IDEMPOTENCY CONTRACT
// ═══════════════════════════════════════════════════════════════════════

/** Idempotency TTL in hours for desktop API write operations. */
export const FRIDAY_DESKTOP_IDEMPOTENCY_TTL_HOURS = 24 as const;

/** Idempotency contract specification for desktop API write operations. */
export interface FridayDesktopIdempotencyContract {
  /** Scope is (principalId, operationId, key). */
  readonly scope: "principal+operation";
  /** Keys expire after 24 hours. */
  readonly ttlHours: 24;
  /** Same payload hash returns the original response. */
  readonly replayBehavior: "same_payload_returns_original_response";
  /** Different payload hash returns 409. */
  readonly conflict: {
    readonly httpStatus: 409;
    readonly code: "DESKTOP_IDEMPOTENCY_KEY_CONFLICT";
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DTO TYPES (API layer — no domain entity leakage)
// ═══════════════════════════════════════════════════════════════════════

/** API DTO for an element selector. */
export interface FridayDesktopElementSelectorDto {
  readonly strategy: FridayDesktopSelectorStrategy;
  readonly value: string;
  readonly appBundleId?: string;
  readonly windowTitle?: string;
  readonly displayIndex?: number;
  readonly fallbacks?: readonly FridayDesktopElementSelectorDto[];
}

/**
 * API DTO for a desktop action.
 *
 * Opaque at the API layer — the `type` discriminant is preserved but
 * the payload is serialised as a flat object so the API boundary does
 * not leak domain-internal discriminated union variants.
 */
export interface FridayDesktopActionDto {
  readonly type: FridayDesktopActionType;
  readonly [key: string]: unknown;
}

/** API DTO for a file entry returned by list operations. */
export interface FridayDesktopFileEntryDto {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
  readonly modifiedAt: ISODateTime;
}

/** API DTO for a platform adapter. */
export interface FridayDesktopAdapterDto {
  readonly id: string;
  readonly platform: FridayDesktopPlatform;
  readonly displayName: string;
  readonly version: string;
  readonly capabilities: readonly FridayDesktopCapability[];
  readonly supportedOsVersions: string;
  readonly detectedOsVersion: string;
  readonly healthy: boolean;
  readonly statusMessage: string;
  readonly initializedAt: ISODateTime;
}

/** API DTO for a desktop element. */
export interface FridayDesktopElementDto {
  readonly elementId: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly bounds: FridayDesktopBounds;
  readonly appBundleId: string;
  readonly windowTitle?: string;
  readonly displayIndex: number;
  readonly childCount: number;
  /** Platform-specific attributes (present when `includePlatformAttributes` is true). */
  readonly platformAttributes?: JsonObject;
}

/** API DTO for an action result. */
export interface FridayDesktopActionResultDto {
  readonly id: UUID;
  readonly action: FridayDesktopActionDto;
  readonly status: FridayDesktopActionStatus;
  readonly platform: FridayDesktopPlatform;
  readonly errorMessage?: string;
  readonly errorCode?: FridayDesktopErrorCode;
  readonly targetElement?: FridayDesktopElementDto;
  readonly screenshotBase64?: string;
  readonly elementData?: FridayDesktopElementDto;
  readonly clipboardContent?: string;
  readonly fileData?: string;
  readonly fileListing?: readonly FridayDesktopFileEntryDto[];
  readonly matchedPolicyRuleId?: UUID;
  readonly permissionDecisionId?: UUID;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly durationMs: number;
  readonly startedAt: ISODateTime;
  readonly completedAt: ISODateTime;
}

/** API DTO for a recording. */
export interface FridayDesktopRecordingDto {
  readonly id: UUID;
  readonly name: string;
  readonly description?: string;
  readonly state: FridayDesktopRecordingState;
  readonly platform: FridayDesktopPlatform;
  /** Parameters as RFC-aligned map: name → { type, defaultValue, ... }. */
  readonly parameters: FridayDesktopRecordingParameterMap;
  readonly tags: readonly string[];
  readonly stepCount: number;
  readonly createdBy: string;
  readonly tenantId?: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly stoppedAt?: ISODateTime;
}

/** API DTO for a recording step. */
export interface FridayDesktopRecordingStepDto {
  readonly id: UUID;
  readonly recordingId: UUID;
  readonly stepIndex: number;
  readonly action: FridayDesktopActionDto;
  readonly result?: FridayDesktopActionResultDto;
  readonly element?: FridayDesktopElementDto;
  readonly parameterBindings: Readonly<Record<string, string>>;
  readonly timestamp: ISODateTime;
  readonly durationMs?: number;
}

/** API DTO for a desktop policy. */
export interface FridayDesktopPolicyDto {
  readonly id: UUID;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly ruleCount: number;
  readonly tenantId?: string;
  readonly createdBy: string;
  readonly etag: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for a policy rule. */
export interface FridayDesktopPolicyRuleDto {
  readonly id: UUID;
  readonly policyId: UUID;
  readonly actionType: FridayDesktopActionType;
  readonly appFilter: string;
  readonly elementFilter?: string;
  readonly riskLevel: FridayDesktopRiskLevel;
  readonly decision: FridayDesktopPolicyDecision;
  readonly engineDelegate: boolean;
  readonly description?: string;
  readonly priority: number;
  readonly createdAt: ISODateTime;
}

/** API DTO for an OS permission check. */
export interface FridayDesktopPermissionDto {
  readonly permissionType: FridayDesktopOsPermissionType;
  readonly status: FridayDesktopOsPermissionStatus;
  readonly platform: FridayDesktopPlatform;
  readonly grantInstructions?: string;
  readonly checkedAt: ISODateTime;
}

/** API DTO for a permission prompt. */
export interface FridayDesktopPermissionPromptDto {
  readonly id: UUID;
  readonly actionType: FridayDesktopActionType;
  readonly action: FridayDesktopActionDto;
  readonly riskLevel: FridayDesktopRiskLevel;
  readonly appBundleId?: string;
  readonly elementDescription?: string;
  readonly policyRuleId?: UUID;
  readonly reason: string;
  readonly timeoutMs: number;
  readonly createdAt: ISODateTime;
  readonly expiresAt: ISODateTime;
}

/** API DTO for a permission decision. */
export interface FridayDesktopPermissionDecisionDto {
  readonly id: UUID;
  readonly promptId: UUID;
  readonly actionType: FridayDesktopActionType;
  readonly appBundleId?: string;
  readonly elementDescription?: string;
  readonly riskLevel: FridayDesktopRiskLevel;
  readonly decision: FridayDesktopPermissionDecisionValue;
  readonly decidedBy: string;
  readonly rationale?: string;
  readonly tenantId?: string;
  readonly createdAt: ISODateTime;
  readonly expiresAt?: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// EXECUTE ACTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/desktop/actions/execute`.
 *
 * Executes a single desktop action through the policy/permission pipeline.
 *
 * @openapi operationId: executeDesktopAction
 */
export interface FridayExecuteDesktopActionRequest {
  /** The action to execute. */
  readonly action: FridayDesktopActionDto;
  /** Timeout override in milliseconds (null = default). */
  readonly timeoutMs?: number;
  /**
   * Idempotency key to prevent duplicate executions.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/desktop/actions/execute`.
 *
 * @openapi operationId: executeDesktopAction
 */
export interface FridayExecuteDesktopActionResponse {
  /** The action result. */
  readonly result: FridayDesktopActionResultDto;
  /** Permission prompt (if human confirmation was needed). */
  readonly permissionPrompt?: FridayDesktopPermissionPromptDto;
  /** Permission decision (if human confirmation was provided). */
  readonly permissionDecision?: FridayDesktopPermissionDecisionDto;
}

// ═══════════════════════════════════════════════════════════════════════
// BATCH ACTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * A single action within a batch request.
 */
export interface FridayDesktopBatchActionItem {
  /** Client-assigned ID for correlating results. */
  readonly clientId: string;
  /** The action to execute. */
  readonly action: FridayDesktopActionDto;
  /** Timeout override in milliseconds (null = default). */
  readonly timeoutMs?: number;
}

/**
 * Request body for `POST /api/desktop/actions/batch`.
 *
 * Executes multiple desktop actions sequentially.
 *
 * @openapi operationId: batchDesktopActions
 */
export interface FridayBatchDesktopActionsRequest {
  /** Actions to execute in order. */
  readonly actions: readonly FridayDesktopBatchActionItem[];
  /** Whether to stop on first failure. @default true */
  readonly stopOnFailure?: boolean;
  /**
   * Idempotency key to prevent duplicate batch executions.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Result of a single action within a batch.
 */
export interface FridayDesktopBatchActionResultItem {
  /** Correlation ID from the request. */
  readonly clientId: string;
  /** The action result. */
  readonly result: FridayDesktopActionResultDto;
}

/**
 * Response body for `POST /api/desktop/actions/batch`.
 *
 * @openapi operationId: batchDesktopActions
 */
export interface FridayBatchDesktopActionsResponse {
  /** Results for each action, in order. */
  readonly results: readonly FridayDesktopBatchActionResultItem[];
  /** Overall success (true if all actions succeeded). */
  readonly allSucceeded: boolean;
  /** Number of actions that succeeded. */
  readonly successCount: number;
  /** Number of actions that failed. */
  readonly failureCount: number;
  /** Number of actions skipped (due to stopOnFailure). */
  readonly skippedCount: number;
}

// ═══════════════════════════════════════════════════════════════════════
// CANCEL ACTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/desktop/actions/:actionId/cancel`.
 *
 * Cancels a running desktop action.
 *
 * @openapi operationId: cancelDesktopAction
 */
export interface FridayCancelDesktopActionRequest {
  /** Reason for cancellation. */
  readonly reason?: string;
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/desktop/actions/:actionId/cancel`.
 *
 * @openapi operationId: cancelDesktopAction
 */
export interface FridayCancelDesktopActionResponse {
  /** The cancelled action result. */
  readonly result: FridayDesktopActionResultDto;
}

// ═══════════════════════════════════════════════════════════════════════
// RECORDINGS: START
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/desktop/recordings`.
 *
 * Starts a new desktop recording.
 *
 * @openapi operationId: startDesktopRecording
 */
export interface FridayStartDesktopRecordingRequest {
  /** Name for the recording. */
  readonly name: string;
  /** Optional description. */
  readonly description?: string;
  /** Optional tags for discovery. */
  readonly tags?: readonly string[];
  /** Tenant context. */
  readonly tenantId?: string;
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/desktop/recordings`.
 *
 * @openapi operationId: startDesktopRecording
 */
export interface FridayStartDesktopRecordingResponse {
  /** The created recording. */
  readonly recording: FridayDesktopRecordingDto;
}

// ═══════════════════════════════════════════════════════════════════════
// RECORDINGS: STOP
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/desktop/recordings/:recordingId/stop`.
 *
 * Stops an active recording.
 *
 * @openapi operationId: stopDesktopRecording
 */
export interface FridayStopDesktopRecordingRequest {
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/desktop/recordings/:recordingId/stop`.
 *
 * @openapi operationId: stopDesktopRecording
 */
export interface FridayStopDesktopRecordingResponse {
  /** The stopped recording. */
  readonly recording: FridayDesktopRecordingDto;
}

// ═══════════════════════════════════════════════════════════════════════
// RECORDINGS: PAUSE / RESUME
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/desktop/recordings/:recordingId/pause`.
 *
 * @openapi operationId: pauseDesktopRecording
 */
export interface FridayPauseDesktopRecordingRequest {
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/desktop/recordings/:recordingId/pause`.
 *
 * @openapi operationId: pauseDesktopRecording
 */
export interface FridayPauseDesktopRecordingResponse {
  /** The paused recording. */
  readonly recording: FridayDesktopRecordingDto;
}

/**
 * Request body for `POST /api/desktop/recordings/:recordingId/resume`.
 *
 * @openapi operationId: resumeDesktopRecording
 */
export interface FridayResumeDesktopRecordingRequest {
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/desktop/recordings/:recordingId/resume`.
 *
 * @openapi operationId: resumeDesktopRecording
 */
export interface FridayResumeDesktopRecordingResponse {
  /** The resumed recording. */
  readonly recording: FridayDesktopRecordingDto;
}

// ═══════════════════════════════════════════════════════════════════════
// RECORDINGS: LIST
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/desktop/recordings`.
 *
 * @openapi operationId: listDesktopRecordings
 */
export interface FridayListDesktopRecordingsQuery extends FridayDesktopPaginationQuery {
  /** Filter by recording state. */
  readonly state?: FridayDesktopRecordingState;
  /** Filter by tag. */
  readonly tag?: string;
  /** Filter by platform. */
  readonly platform?: FridayDesktopPlatform;
  /** Filter by tenant ID. */
  readonly tenantId?: string;
  /** Sort field. */
  readonly sortBy?: "name" | "createdAt" | "updatedAt" | "stepCount";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/desktop/recordings`.
 *
 * @openapi operationId: listDesktopRecordings
 */
export interface FridayListDesktopRecordingsResponse extends FridayDesktopPage<FridayDesktopRecordingDto> {}

// ═══════════════════════════════════════════════════════════════════════
// RECORDINGS: GET
// ═══════════════════════════════════════════════════════════════════════

/**
 * Response body for `GET /api/desktop/recordings/:recordingId`.
 *
 * Returns the recording metadata only. Steps are fetched via the
 * separate paginated `GET /api/desktop/recordings/:recordingId/steps` endpoint.
 *
 * @openapi operationId: getDesktopRecording
 */
export interface FridayGetDesktopRecordingResponse {
  /** The recording detail. */
  readonly recording: FridayDesktopRecordingDto;
}

// ═══════════════════════════════════════════════════════════════════════
// RECORDINGS: LIST STEPS (paginated)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/desktop/recordings/:recordingId/steps`.
 *
 * Paginated listing of recording steps.
 *
 * @openapi operationId: listDesktopRecordingSteps
 */
export interface FridayListDesktopRecordingStepsQuery extends FridayDesktopPaginationQuery {
  /** Sort direction. @default "asc" */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/desktop/recordings/:recordingId/steps`.
 *
 * @openapi operationId: listDesktopRecordingSteps
 */
export interface FridayListDesktopRecordingStepsResponse extends FridayDesktopPage<FridayDesktopRecordingStepDto> {}

// ═══════════════════════════════════════════════════════════════════════
// RECORDINGS: REPLAY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/desktop/recordings/:recordingId/replay`.
 *
 * Replays a stopped recording with optional parameter overrides.
 *
 * @openapi operationId: replayDesktopRecording
 */
export interface FridayReplayDesktopRecordingRequest {
  /** Parameter values for replay (name → value). */
  readonly parameters?: Readonly<Record<string, string>>;
  /** Whether to stop on first step failure. @default true */
  readonly stopOnFailure?: boolean;
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Result of a single replayed step.
 */
export interface FridayDesktopReplayStepResult {
  /** Step index. */
  readonly stepIndex: number;
  /** Original step ID. */
  readonly stepId: UUID;
  /** The action result. */
  readonly result: FridayDesktopActionResultDto;
}

/**
 * Response body for `POST /api/desktop/recordings/:recordingId/replay`.
 *
 * @openapi operationId: replayDesktopRecording
 */
export interface FridayReplayDesktopRecordingResponse {
  /** Recording that was replayed. */
  readonly recordingId: UUID;
  /** Results for each step. */
  readonly stepResults: readonly FridayDesktopReplayStepResult[];
  /** Overall success. */
  readonly allSucceeded: boolean;
  /** Number of steps that succeeded. */
  readonly successCount: number;
  /** Number of steps that failed. */
  readonly failureCount: number;
  /** Number of steps skipped (due to stopOnFailure). */
  readonly skippedCount: number;
  /** Total replay duration in milliseconds. */
  readonly totalDurationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════
// RECORDINGS: DELETE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `DELETE /api/desktop/recordings/:recordingId`.
 *
 * @openapi operationId: deleteDesktopRecording
 */
export interface FridayDeleteDesktopRecordingRequest {
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `DELETE /api/desktop/recordings/:recordingId`.
 *
 * @openapi operationId: deleteDesktopRecording
 */
export interface FridayDeleteDesktopRecordingResponse {
  /** Whether the recording was deleted. */
  readonly deleted: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// POLICIES: CREATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Rule specification for policy creation.
 */
export interface FridayDesktopPolicyRuleInput {
  /** Action type this rule applies to. */
  readonly actionType: FridayDesktopActionType;
  /** App filter glob. */
  readonly appFilter: string;
  /** Element filter glob. */
  readonly elementFilter?: string;
  /** Risk level classification. */
  readonly riskLevel: FridayDesktopRiskLevel;
  /** Policy decision. */
  readonly decision: FridayDesktopPolicyDecision;
  /** Whether to delegate to Rules Engine. @default false */
  readonly engineDelegate?: boolean;
  /** Human-readable description. */
  readonly description?: string;
  /** Rule priority. @default 0 */
  readonly priority?: number;
}

/**
 * Request body for `POST /api/desktop/policies`.
 *
 * @openapi operationId: createDesktopPolicy
 */
export interface FridayCreateDesktopPolicyRequest {
  /** Policy name. */
  readonly name: string;
  /** Policy description. */
  readonly description?: string;
  /** Whether the policy is enabled. @default true */
  readonly enabled?: boolean;
  /** Policy priority. @default 0 */
  readonly priority?: number;
  /** Initial rules. */
  readonly rules: readonly FridayDesktopPolicyRuleInput[];
  /** Tenant context. */
  readonly tenantId?: string;
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/desktop/policies`.
 *
 * @openapi operationId: createDesktopPolicy
 */
export interface FridayCreateDesktopPolicyResponse {
  /** The created policy. */
  readonly policy: FridayDesktopPolicyDto;
  /** The rules within the policy. */
  readonly rules: readonly FridayDesktopPolicyRuleDto[];
}

// ═══════════════════════════════════════════════════════════════════════
// POLICIES: GET
// ═══════════════════════════════════════════════════════════════════════

/**
 * Response body for `GET /api/desktop/policies/:policyId`.
 *
 * @openapi operationId: getDesktopPolicy
 */
export interface FridayGetDesktopPolicyResponse {
  /** The policy detail. */
  readonly policy: FridayDesktopPolicyDto;
  /** Rules within the policy. */
  readonly rules: readonly FridayDesktopPolicyRuleDto[];
}

// ═══════════════════════════════════════════════════════════════════════
// POLICIES: LIST
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/desktop/policies`.
 *
 * @openapi operationId: listDesktopPolicies
 */
export interface FridayListDesktopPoliciesQuery extends FridayDesktopPaginationQuery {
  /** Filter by enabled state. */
  readonly enabled?: boolean;
  /** Filter by tenant ID. */
  readonly tenantId?: string;
  /** Sort field. */
  readonly sortBy?: "name" | "priority" | "createdAt" | "updatedAt";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/desktop/policies`.
 *
 * @openapi operationId: listDesktopPolicies
 */
export interface FridayListDesktopPoliciesResponse extends FridayDesktopPage<FridayDesktopPolicyDto> {}

// ═══════════════════════════════════════════════════════════════════════
// POLICIES: UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `PATCH /api/desktop/policies/:policyId`.
 *
 * @openapi operationId: updateDesktopPolicy
 */
export interface FridayUpdateDesktopPolicyRequest {
  /** Updated name. */
  readonly name?: string;
  /** Updated description. */
  readonly description?: string;
  /** Updated enabled state. */
  readonly enabled?: boolean;
  /** Updated priority. */
  readonly priority?: number;
  /** Optimistic concurrency token. */
  readonly etag: string;
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `PATCH /api/desktop/policies/:policyId`.
 *
 * @openapi operationId: updateDesktopPolicy
 */
export interface FridayUpdateDesktopPolicyResponse {
  /** The updated policy. */
  readonly policy: FridayDesktopPolicyDto;
}

// ═══════════════════════════════════════════════════════════════════════
// POLICIES: DELETE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `DELETE /api/desktop/policies/:policyId`.
 *
 * @openapi operationId: deleteDesktopPolicy
 */
export interface FridayDeleteDesktopPolicyRequest {
  /** Optimistic concurrency token. */
  readonly etag: string;
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `DELETE /api/desktop/policies/:policyId`.
 *
 * @openapi operationId: deleteDesktopPolicy
 */
export interface FridayDeleteDesktopPolicyResponse {
  /** Whether the policy was deleted. */
  readonly deleted: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// POLICIES: ADD RULE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/desktop/policies/:policyId/rules`.
 *
 * @openapi operationId: addDesktopPolicyRule
 */
export interface FridayAddDesktopPolicyRuleRequest {
  /** Rule specification. */
  readonly rule: FridayDesktopPolicyRuleInput;
  /** Optimistic concurrency token for the parent policy. */
  readonly etag: string;
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/desktop/policies/:policyId/rules`.
 *
 * @openapi operationId: addDesktopPolicyRule
 */
export interface FridayAddDesktopPolicyRuleResponse {
  /** The created rule. */
  readonly rule: FridayDesktopPolicyRuleDto;
  /** Updated policy etag. */
  readonly etag: string;
}

// ═══════════════════════════════════════════════════════════════════════
// POLICIES: REMOVE RULE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `DELETE /api/desktop/policies/:policyId/rules/:ruleId`.
 *
 * @openapi operationId: removeDesktopPolicyRule
 */
export interface FridayRemoveDesktopPolicyRuleRequest {
  /** Optimistic concurrency token for the parent policy. */
  readonly etag: string;
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `DELETE /api/desktop/policies/:policyId/rules/:ruleId`.
 *
 * @openapi operationId: removeDesktopPolicyRule
 */
export interface FridayRemoveDesktopPolicyRuleResponse {
  /** Whether the rule was removed. */
  readonly deleted: boolean;
  /** Updated policy etag. */
  readonly etag: string;
}

// ═══════════════════════════════════════════════════════════════════════
// PERMISSIONS: LIST OS PERMISSIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Response body for `GET /api/desktop/permissions`.
 *
 * Lists OS-level permissions and their current status.
 *
 * **Pagination exception:** This endpoint is not paginated because the
 * set of OS permission types is small and fixed
 * (see {@link FridayDesktopOsPermissionType}).
 *
 * @openapi operationId: listDesktopPermissions
 */
export interface FridayListDesktopPermissionsResponse {
  /** OS permission check results (fixed-size; one entry per permission type). */
  readonly permissions: readonly FridayDesktopPermissionDto[];
  /** Platform checked. */
  readonly platform: FridayDesktopPlatform;
}

// ═══════════════════════════════════════════════════════════════════════
// PERMISSIONS: RESPOND TO PROMPT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/desktop/permissions/prompts/:promptId/respond`.
 *
 * Submits a human decision for a permission prompt.
 *
 * @openapi operationId: respondToDesktopPermissionPrompt
 */
export interface FridayRespondToPermissionPromptRequest {
  /** The decision (human-submittable values only; "timeout" is system-generated). */
  readonly decision: FridayDesktopPermissionHumanDecision;
  /** Human-readable rationale. */
  readonly rationale?: string;
  /**
   * Idempotency key.
   * See {@link FridayDesktopIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/desktop/permissions/prompts/:promptId/respond`.
 *
 * @openapi operationId: respondToDesktopPermissionPrompt
 */
export interface FridayRespondToPermissionPromptResponse {
  /** The recorded decision. */
  readonly decision: FridayDesktopPermissionDecisionDto;
}

// ═══════════════════════════════════════════════════════════════════════
// PERMISSIONS: LIST DECISIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/desktop/permissions/decisions`.
 *
 * @openapi operationId: listDesktopPermissionDecisions
 */
export interface FridayListDesktopPermissionDecisionsQuery extends FridayDesktopPaginationQuery {
  /** Filter by action type. */
  readonly actionType?: FridayDesktopActionType;
  /** Filter by decision. */
  readonly decision?: FridayDesktopPermissionDecisionValue;
  /** Filter by tenant ID. */
  readonly tenantId?: string;
  /** Decisions after this timestamp. */
  readonly after?: ISODateTime;
  /** Decisions before this timestamp. */
  readonly before?: ISODateTime;
}

/**
 * Response body for `GET /api/desktop/permissions/decisions`.
 *
 * @openapi operationId: listDesktopPermissionDecisions
 */
export interface FridayListDesktopPermissionDecisionsResponse
  extends FridayDesktopPage<FridayDesktopPermissionDecisionDto> {}

// ═══════════════════════════════════════════════════════════════════════
// PLATFORM CAPABILITY DISCOVERY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Response body for `GET /api/desktop/platform`.
 *
 * Returns the current platform adapter info and capabilities.
 *
 * @openapi operationId: getDesktopPlatform
 */
export interface FridayGetDesktopPlatformResponse {
  /** The active platform adapter. */
  readonly adapter: FridayDesktopAdapterDto;
  /** All supported action types for this platform. */
  readonly supportedActions: readonly FridayDesktopActionType[];
  /** All OS permissions and their status. */
  readonly permissions: readonly FridayDesktopPermissionDto[];
}

// ═══════════════════════════════════════════════════════════════════════
// ELEMENT INSPECTION / SEARCH
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/desktop/elements/inspect`.
 *
 * Inspects a specific element by selector.
 *
 * @openapi operationId: inspectDesktopElement
 */
export interface FridayInspectDesktopElementRequest {
  /** Element selector. */
  readonly selector: FridayDesktopElementSelectorDto;
  /** Include children up to this depth. @default 0 */
  readonly childDepth?: number;
  /** Include platform-specific attributes. @default false */
  readonly includePlatformAttributes?: boolean;
}

/**
 * Response body for `POST /api/desktop/elements/inspect`.
 *
 * @openapi operationId: inspectDesktopElement
 */
export interface FridayInspectDesktopElementResponse {
  /** The inspected element (null if not found). */
  readonly element: FridayDesktopElementDto | null;
  /** Child elements (if childDepth > 0). */
  readonly children?: readonly FridayDesktopElementDto[];
}

/**
 * Query parameters for `GET /api/desktop/elements/search`.
 *
 * Searches for elements matching a query.
 *
 * @openapi operationId: searchDesktopElements
 */
export interface FridaySearchDesktopElementsQuery extends FridayDesktopPaginationQuery {
  /** Text query to match against element name, role, value, or description. */
  readonly query: string;
  /** Filter by app bundle ID. */
  readonly appBundleId?: string;
  /** Filter by element role. */
  readonly role?: string;
}

/**
 * Response body for `GET /api/desktop/elements/search`.
 *
 * @openapi operationId: searchDesktopElements
 */
export interface FridaySearchDesktopElementsResponse extends FridayDesktopPage<FridayDesktopElementDto> {}

// ═══════════════════════════════════════════════════════════════════════
// ACTION LOG
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/desktop/actions/log`.
 *
 * @openapi operationId: listDesktopActionLog
 */
export interface FridayListDesktopActionLogQuery extends FridayDesktopPaginationQuery {
  /** Filter by action type. */
  readonly actionType?: FridayDesktopActionType;
  /** Filter by status. */
  readonly status?: FridayDesktopActionStatus;
  /** Filter by app bundle ID. */
  readonly appBundleId?: string;
  /** Filter by tenant ID. */
  readonly tenantId?: string;
  /** Actions after this timestamp. */
  readonly after?: ISODateTime;
  /** Actions before this timestamp. */
  readonly before?: ISODateTime;
  /** Sort field. */
  readonly sortBy?: "createdAt" | "durationMs" | "actionType";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/desktop/actions/log`.
 *
 * @openapi operationId: listDesktopActionLog
 */
export interface FridayListDesktopActionLogResponse extends FridayDesktopPage<FridayDesktopActionResultDto> {}
