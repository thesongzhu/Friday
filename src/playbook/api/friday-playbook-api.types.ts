/**
 * Playbook Learning System — API and SDK Contract.
 *
 * Request/response DTOs for the playbook learning REST API.
 * All types follow Friday API conventions: `FridayPage<T>` for pagination,
 * `FridayApiSuccessResponse<T>` / `FridayApiErrorResponse` for responses.
 *
 * @module playbook/api
 */

import type { FridayPage, FridayPaginationQuery } from "../../api/model/friday-api-common.types.js";

import type {
  FridayPlaybookCandidateStatus,
  FridayPlaybookCostDimensions,
  FridayPlaybookMatchReason,
  FridayPlaybookScoreDimension,
  FridayPlaybookSelector,
  FridayPlaybookStatus,
  FridayPromotionDecisionOutcome,
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/friday-playbook.types.js";

// ═══════════════════════════════════════════════════════════════════════
// ERROR CODES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Standardised error codes for the playbook learning domain.
 *
 * @example
 * ```ts
 * if (error.code === FRIDAY_PLAYBOOK_ERROR_CODES.PLAYBOOK_NOT_FOUND) { ... }
 * ```
 */
export const FRIDAY_PLAYBOOK_ERROR_CODES = {
  /** The requested playbook does not exist or has been deleted. */
  PLAYBOOK_NOT_FOUND: "PLAYBOOK_NOT_FOUND",
  /** The requested playbook version does not exist. */
  VERSION_NOT_FOUND: "PLAYBOOK_VERSION_NOT_FOUND",
  /** The requested playbook candidate does not exist. */
  CANDIDATE_NOT_FOUND: "PLAYBOOK_CANDIDATE_NOT_FOUND",
  /** The candidate is not in a promotable state. */
  CANDIDATE_NOT_PROMOTABLE: "PLAYBOOK_CANDIDATE_NOT_PROMOTABLE",
  /** The playbook is not in a rollback-eligible state. */
  PLAYBOOK_NOT_ROLLBACKABLE: "PLAYBOOK_NOT_ROLLBACKABLE",
  /** The target rollback version does not exist. */
  ROLLBACK_VERSION_NOT_FOUND: "PLAYBOOK_ROLLBACK_VERSION_NOT_FOUND",
  /** The target rollback version is the same as the current active version. */
  ROLLBACK_VERSION_SAME: "PLAYBOOK_ROLLBACK_VERSION_SAME",
  /** Optimistic concurrency conflict — the etag does not match. */
  ETAG_MISMATCH: "PLAYBOOK_ETAG_MISMATCH",
  /** Promotion was denied by the Rules Engine. */
  PROMOTION_RULES_DENIED: "PLAYBOOK_PROMOTION_RULES_DENIED",
  /** Selection was denied by the Rules Engine. */
  SELECTION_RULES_DENIED: "PLAYBOOK_SELECTION_RULES_DENIED",
  /** Validation failed on the request payload. */
  VALIDATION_FAILED: "PLAYBOOK_VALIDATION_FAILED",
  /** Idempotency key reused with a different payload inside retention window. */
  IDEMPOTENCY_KEY_CONFLICT: "PLAYBOOK_IDEMPOTENCY_KEY_CONFLICT",
  /** Score history not found for the specified playbook. */
  SCORE_HISTORY_EMPTY: "PLAYBOOK_SCORE_HISTORY_EMPTY",
} as const;

/** Union type of all playbook error codes. */
export type FridayPlaybookErrorCode =
  (typeof FRIDAY_PLAYBOOK_ERROR_CODES)[keyof typeof FRIDAY_PLAYBOOK_ERROR_CODES];

// ═══════════════════════════════════════════════════════════════════════
// PAGINATION (reuses shared types from api/model)
// ═══════════════════════════════════════════════════════════════════════

/** Pagination query for playbook endpoints. */
export type FridayPlaybookPaginationQuery = FridayPaginationQuery;

/** Paginated result for playbook endpoints. */
export type FridayPlaybookPage<TItem> = FridayPage<TItem>;

// ═══════════════════════════════════════════════════════════════════════
// IDEMPOTENCY CONTRACT
// ═══════════════════════════════════════════════════════════════════════

/** Idempotency TTL in hours for playbook API write operations. */
export const FRIDAY_PLAYBOOK_IDEMPOTENCY_TTL_HOURS = 24 as const;

/** Idempotency contract specification for playbook API write operations. */
export interface FridayPlaybookIdempotencyContract {
  /** Scope is (principalId, operationId, key). */
  scope: "principal+operation";
  /** Keys expire after 24 hours. */
  ttlHours: 24;
  /** Same payload hash returns the original response. */
  replayBehavior: "same_payload_returns_original_response";
  /** Different payload hash returns 409. */
  conflict: { httpStatus: 409; code: "PLAYBOOK_IDEMPOTENCY_KEY_CONFLICT" };
}

// ═══════════════════════════════════════════════════════════════════════
// DTO TYPES (API layer — no domain entity leakage)
// ═══════════════════════════════════════════════════════════════════════

/** API DTO for a playbook. */
export interface FridayPlaybookDto {
  id: UUID;
  name: string;
  description?: string;
  workflowType: string;
  tags: string[];
  status: FridayPlaybookStatus;
  activeVersionNumber: number;
  sourceCandidateId: UUID;
  compositeScore: number;
  totalUses: number;
  totalSuccesses: number;
  lastUsedAt?: ISODateTime;
  lastSuccessfulAt?: ISODateTime;
  etag: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  archivedAt?: ISODateTime;
}

/** API DTO for a playbook version. */
export interface FridayPlaybookVersionDto {
  id: UUID;
  playbookId: UUID;
  versionNumber: number;
  fingerprint: string;
  pattern: JsonObject;
  candidateId: UUID;
  changeNote?: string;
  createdAt: ISODateTime;
}

/** API DTO for a playbook candidate. */
export interface FridayPlaybookCandidateDto {
  id: UUID;
  fingerprint: string;
  workflowType: string;
  tags: string[];
  pattern: JsonObject;
  status: FridayPlaybookCandidateStatus;
  evidenceCount: number;
  successCount: number;
  failureCount: number;
  totalDurationMs: number;
  totalCost: FridayPlaybookCostDimensions;
  sourceRunIds: UUID[];
  promotedPlaybookId?: UUID;
  firstObservedAt: ISODateTime;
  lastObservedAt: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** API DTO for a playbook score snapshot. */
export interface FridayPlaybookScoreDto {
  id: UUID;
  playbookId: UUID | null;
  versionNumber: number | null;
  compositeScore: number;
  successRate: number;
  speedScore: number;
  costEfficiencyScore: number;
  satisfactionScore: number;
  sampleSize: number;
  calculatedAt: ISODateTime;
}

/** API DTO for a playbook selection match. */
export interface FridayPlaybookMatchDto {
  id: UUID;
  runId: UUID;
  workflowId: UUID;
  playbookId: UUID | null;
  versionNumber: number | null;
  matchScore: number | null;
  similarity: number | null;
  reason: FridayPlaybookMatchReason;
  context: FridayPlaybookSelector;
  selectedAt: ISODateTime;
}

/** API DTO for a promotion rule result. */
export interface FridayPromotionRuleResultDto {
  ruleId: string;
  passed: boolean;
  actualValue: number;
  threshold: number;
}

/** API DTO for a promotion decision. */
export interface FridayPromotionDecisionDto {
  id: UUID;
  candidateId: UUID;
  decision: FridayPromotionDecisionOutcome;
  reason: string;
  ruleResults: FridayPromotionRuleResultDto[];
  rulesResult?: JsonObject;
  scoreSnapshot: FridayPlaybookScoreDto;
  decidedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// LIST PLAYBOOKS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/playbooks`.
 *
 * @openapi operationId: listPlaybooks
 */
export interface FridayListPlaybooksQuery extends FridayPlaybookPaginationQuery {
  /** Filter by playbook status. */
  status?: FridayPlaybookStatus;
  /** Filter by workflow type (exact match). */
  workflowType?: string;
  /** Filter by tag (matches any playbook containing this tag). */
  tag?: string;
  /** Minimum composite score filter. */
  minScore?: number;
  /** Sort field. */
  sortBy?: "compositeScore" | "totalUses" | "createdAt" | "updatedAt";
  /** Sort direction. */
  sortDir?: "asc" | "desc";
}

/**
 * Summary of a playbook for list views.
 * Omits version history and full pattern for efficiency.
 */
export interface FridayPlaybookSummary {
  /** Playbook ID. */
  id: UUID;
  /** Human-readable name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Workflow type. */
  workflowType: string;
  /** Tags. */
  tags: string[];
  /** Current status. */
  status: FridayPlaybookStatus;
  /** Active version number. */
  activeVersionNumber: number;
  /** Latest composite score. */
  compositeScore: number;
  /** Total uses. */
  totalUses: number;
  /** Total successes. */
  totalSuccesses: number;
  /** Most recent use timestamp. */
  lastUsedAt?: ISODateTime;
  /** Most recent successful use timestamp. */
  lastSuccessfulAt?: ISODateTime;
  /** When created. */
  createdAt: ISODateTime;
  /** When last updated. */
  updatedAt: ISODateTime;
}

/**
 * Response body for `GET /api/playbooks`.
 *
 * @openapi operationId: listPlaybooks
 */
export interface FridayListPlaybooksResponse extends FridayPlaybookPage<FridayPlaybookSummary> {}

// ═══════════════════════════════════════════════════════════════════════
// GET PLAYBOOK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Response body for `GET /api/playbooks/:playbookId`.
 *
 * Full playbook detail including active version.
 *
 * @openapi operationId: getPlaybook
 */
export interface FridayGetPlaybookResponse {
  /** The full playbook DTO. */
  playbook: FridayPlaybookDto;
  /** The currently active version DTO. */
  activeVersion: FridayPlaybookVersionDto;
  /** Total number of versions. */
  versionCount: number;
}

// ═══════════════════════════════════════════════════════════════════════
// LIST PLAYBOOK VERSIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/playbooks/:playbookId/versions`.
 *
 * @openapi operationId: listPlaybookVersions
 */
export interface FridayListPlaybookVersionsQuery extends FridayPlaybookPaginationQuery {}

/**
 * Response body for `GET /api/playbooks/:playbookId/versions`.
 *
 * @openapi operationId: listPlaybookVersions
 */
export interface FridayListPlaybookVersionsResponse extends FridayPlaybookPage<FridayPlaybookVersionDto> {}

// ═══════════════════════════════════════════════════════════════════════
// PROMOTE CANDIDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/playbooks/candidates/:candidateId/promote`.
 *
 * Triggers on-demand promotion evaluation for a specific candidate.
 *
 * @openapi operationId: promoteCandidate
 */
export interface FridayPromoteCandidateRequest {
  /**
   * If true, skip promotion rules and force promotion.
   * Requires elevated permissions.
   * @default false
   */
  force?: boolean;
  /**
   * Idempotency key to prevent duplicate promotion.
   * See {@link FridayPlaybookIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/playbooks/candidates/:candidateId/promote`.
 *
 * Discriminated union keyed by `decision.decision`:
 * - `promoted` — includes the created playbook.
 * - `rejected` — includes only the decision; no playbook.
 * - `deferred` — includes only the decision; no playbook.
 *
 * @openapi operationId: promoteCandidate
 */
export type FridayPromoteCandidateResponse =
  | FridayPromoteCandidatePromoted
  | FridayPromoteCandidateRejected
  | FridayPromoteCandidateDeferred;

/** Promotion succeeded — a new playbook was created. */
export interface FridayPromoteCandidatePromoted {
  /** The promotion decision (decision === "promote"). */
  decision: FridayPromotionDecisionDto & { decision: "promote" };
  /** The newly created playbook. */
  playbook: FridayPlaybookDto;
}

/** Promotion rejected — candidate failed non-recoverable criteria. */
export interface FridayPromoteCandidateRejected {
  /** The promotion decision (decision === "reject"). */
  decision: FridayPromotionDecisionDto & { decision: "reject" };
}

/** Promotion deferred — candidate needs more evidence. */
export interface FridayPromoteCandidateDeferred {
  /** The promotion decision (decision === "defer"). */
  decision: FridayPromotionDecisionDto & { decision: "defer" };
}

// ═══════════════════════════════════════════════════════════════════════
// LIST CANDIDATES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/playbooks/candidates`.
 *
 * @openapi operationId: listCandidates
 */
export interface FridayListCandidatesQuery extends FridayPlaybookPaginationQuery {
  /** Filter by candidate status. */
  status?: FridayPlaybookCandidateStatus;
  /** Filter by workflow type. */
  workflowType?: string;
  /** Filter by minimum evidence count. */
  minEvidence?: number;
  /** Sort field. */
  sortBy?: "evidenceCount" | "successRate" | "firstObservedAt" | "lastObservedAt";
  /** Sort direction. */
  sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/playbooks/candidates`.
 *
 * @openapi operationId: listCandidates
 */
export interface FridayListCandidatesResponse extends FridayPlaybookPage<FridayPlaybookCandidateDto> {}

// ═══════════════════════════════════════════════════════════════════════
// GET CANDIDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Response body for `GET /api/playbooks/candidates/:candidateId`.
 *
 * @openapi operationId: getCandidate
 */
export interface FridayGetCandidateResponse {
  /** The full candidate DTO. */
  candidate: FridayPlaybookCandidateDto;
  /** Promotion decisions for this candidate (most recent first). */
  promotionHistory: FridayPromotionDecisionDto[];
}

// ═══════════════════════════════════════════════════════════════════════
// SELECT PLAYBOOK FOR CONTEXT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/playbooks/select`.
 *
 * Finds the best playbook for the given execution context.
 *
 * @openapi operationId: selectPlaybook
 */
export interface FridaySelectPlaybookRequest {
  /** Selector context describing the incoming task. */
  selector: FridayPlaybookSelector;
  /**
   * If true, evaluate the selection but do not persist the selection record.
   * Useful for dry-run scenarios and preview UIs.
   * @default false
   */
  dryRun?: boolean;
  /**
   * Idempotency key for replay and conflict detection.
   *
   * - **Same key, same payload:** returns the cached selection result.
   * - **Same key, different payload:** returns 409 with
   *   `PLAYBOOK_IDEMPOTENCY_KEY_CONFLICT`.
   * - **Different key:** creates a new selection record.
   *
   * See {@link FridayPlaybookIdempotencyContract} for scope, TTL, and semantics.
   */
  idempotencyKey: string;
}

/**
 * Response body for `POST /api/playbooks/select`.
 *
 * Discriminated union keyed by `match.reason`:
 * - `matched` (score) — includes playbook and version.
 * - `below_threshold` / `rules_denied` (fallback) — includes match only.
 * - `no_match` (none) — includes match only.
 *
 * @openapi operationId: selectPlaybook
 */
export type FridaySelectPlaybookResponse =
  | FridaySelectPlaybookMatched
  | FridaySelectPlaybookFallback
  | FridaySelectPlaybookNone;

/** A playbook was matched by score. */
export interface FridaySelectPlaybookMatched {
  /** The match result (reason === "matched"). */
  match: FridayPlaybookMatchDto & { reason: "matched" };
  /** The matched playbook. */
  playbook: FridayPlaybookDto;
  /** The matched playbook version. */
  version: FridayPlaybookVersionDto;
}

/** Candidates exist but none qualified (below threshold or rules denied). */
export interface FridaySelectPlaybookFallback {
  /** The match result (reason === "below_threshold" | "rules_denied"). */
  match: FridayPlaybookMatchDto & { reason: "below_threshold" | "rules_denied" };
}

/** No candidates exist for this workflow type. */
export interface FridaySelectPlaybookNone {
  /** The match result (reason === "no_match"). */
  match: FridayPlaybookMatchDto & { reason: "no_match" };
}

// ═══════════════════════════════════════════════════════════════════════
// GET PLAYBOOK SCORE HISTORY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/playbooks/:playbookId/scores`.
 *
 * @openapi operationId: getPlaybookScoreHistory
 */
export interface FridayGetPlaybookScoreHistoryQuery extends FridayPlaybookPaginationQuery {
  /** Filter scores calculated after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter scores calculated before this timestamp (exclusive). */
  before?: ISODateTime;
  /** Filter by scoring dimension (returns only that dimension's values). */
  dimension?: FridayPlaybookScoreDimension;
}

/**
 * Response body for `GET /api/playbooks/:playbookId/scores`.
 *
 * @openapi operationId: getPlaybookScoreHistory
 */
export interface FridayGetPlaybookScoreHistoryResponse extends FridayPlaybookPage<FridayPlaybookScoreDto> {
  /** Current (latest) score. */
  currentScore: FridayPlaybookScoreDto;
  /** Score trend summary. */
  trend: FridayPlaybookScoreTrend;
}

/**
 * Score trend summary for dashboard display.
 */
export interface FridayPlaybookScoreTrend {
  /** Change in composite score over the query window. */
  compositeScoreDelta: number;
  /** Direction of the trend. */
  direction: "improving" | "stable" | "declining";
  /** Number of score samples in the query window. */
  sampleCount: number;
  /** Earliest score timestamp in the window. */
  windowStart: ISODateTime;
  /** Latest score timestamp in the window. */
  windowEnd: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// ROLLBACK PLAYBOOK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/playbooks/:playbookId/rollback`.
 *
 * Rolls back a playbook to a previous version, or deactivates it entirely.
 *
 * @openapi operationId: rollbackPlaybook
 */
export interface FridayRollbackPlaybookRequest {
  /** Required optimistic concurrency token. */
  etag: string;
  /**
   * Target version number to roll back to.
   * If omitted, the playbook is deactivated (status set to "rolled_back").
   */
  targetVersionNumber?: number;
  /** Human-readable reason for the rollback. */
  reason: string;
  /**
   * Idempotency key to prevent duplicate rollbacks.
   * See {@link FridayPlaybookIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/playbooks/:playbookId/rollback`.
 *
 * @openapi operationId: rollbackPlaybook
 */
export interface FridayRollbackPlaybookResponse {
  /** The updated playbook after rollback. */
  playbook: FridayPlaybookDto;
  /** The version that is now active (null if playbook was deactivated). */
  activeVersion: FridayPlaybookVersionDto | null;
  /** Previous version number before rollback. */
  previousVersionNumber: number;
}

// ═══════════════════════════════════════════════════════════════════════
// LIST SELECTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/playbooks/selections`.
 *
 * @openapi operationId: listSelections
 */
export interface FridayListSelectionsQuery extends FridayPlaybookPaginationQuery {
  /** Filter by playbook ID. */
  playbookId?: UUID;
  /** Filter by workflow ID. */
  workflowId?: UUID;
  /** Filter by run ID. */
  runId?: UUID;
  /** Filter by match reason. */
  reason?: FridayPlaybookMatchReason;
  /** Filter selections after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter selections before this timestamp (exclusive). */
  before?: ISODateTime;
}

/**
 * Response body for `GET /api/playbooks/selections`.
 *
 * @openapi operationId: listSelections
 */
export interface FridayListSelectionsResponse extends FridayPlaybookPage<FridayPlaybookMatchDto> {}

// ═══════════════════════════════════════════════════════════════════════
// LIST PROMOTION DECISIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/playbooks/promotions`.
 *
 * @openapi operationId: listPromotionDecisions
 */
export interface FridayListPromotionDecisionsQuery extends FridayPlaybookPaginationQuery {
  /** Filter by candidate ID. */
  candidateId?: UUID;
  /** Filter by decision outcome. */
  decision?: FridayPromotionDecisionOutcome;
  /** Filter decisions after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter decisions before this timestamp (exclusive). */
  before?: ISODateTime;
}

/**
 * Response body for `GET /api/playbooks/promotions`.
 *
 * @openapi operationId: listPromotionDecisions
 */
export interface FridayListPromotionDecisionsResponse extends FridayPlaybookPage<FridayPromotionDecisionDto> {}

// ═══════════════════════════════════════════════════════════════════════
// ANALYTICS SUMMARY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/playbooks/analytics`.
 *
 * @openapi operationId: getPlaybookAnalytics
 */
export interface FridayGetPlaybookAnalyticsQuery {
  /** Filter by workflow type. */
  workflowType?: string;
  /** Analytics window start (inclusive). */
  after?: ISODateTime;
  /** Analytics window end (exclusive). */
  before?: ISODateTime;
}

/**
 * Response body for `GET /api/playbooks/analytics`.
 *
 * Aggregated analytics for the playbook learning system.
 *
 * @openapi operationId: getPlaybookAnalytics
 */
export interface FridayGetPlaybookAnalyticsResponse {
  /** Total number of active playbooks. */
  totalPlaybooks: number;
  /** Total number of pending candidates. */
  totalCandidates: number;
  /** Reuse hit rate (selections with match / total selections). */
  reuseHitRate: number;
  /** Success lift (success rate with playbook - success rate without). */
  successLift: number;
  /** Rollback rate (rollbacks / total promotions). */
  rollbackRate: number;
  /** Average composite score across active playbooks. */
  averageScore: number;
  /** Breakdown by workflow type. */
  byWorkflowType: FridayPlaybookAnalyticsBreakdown[];
}

/**
 * Analytics breakdown for a single workflow type.
 */
export interface FridayPlaybookAnalyticsBreakdown {
  /** Workflow type. */
  workflowType: string;
  /** Number of active playbooks. */
  playbookCount: number;
  /** Number of pending candidates. */
  candidateCount: number;
  /** Reuse hit rate for this workflow type. */
  reuseHitRate: number;
  /** Success lift for this workflow type. */
  successLift: number;
  /** Average composite score. */
  averageScore: number;
}
