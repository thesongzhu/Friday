/**
 * Rules Engine — API and SDK Contract.
 *
 * Request/response DTOs for the rules engine REST API.
 * All types follow Friday API conventions: `FridayPage<T>` for pagination,
 * `FridayApiSuccessResponse<T>` / `FridayApiErrorResponse` for responses.
 *
 * @module rules/api
 */

import type {
  FridayEvaluationContext,
  FridayEvaluationResult,
  FridayMatchedRule,
  FridayPolicyBundle,
  FridayPolicyBundleSource,
  FridayRule,
  FridayRuleAction,
  FridayRuleConditionGroup,
  FridayRuleDecision,
  FridayRuleResource,
  FridayRuleVersion,
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/friday-rules-engine.types.js";

import type { FridayPage, FridayPaginationQuery } from "../../api/model/friday-api-common.types.js";

// ─── Error Codes ───

/**
 * Standardized error codes for the rules engine domain.
 *
 * @example
 * ```ts
 * if (error.code === FRIDAY_RULES_ERROR_CODES.RULE_NOT_FOUND) { ... }
 * ```
 */
export const FRIDAY_RULES_ERROR_CODES = {
  /** The requested rule does not exist or has been deleted. */
  RULE_NOT_FOUND: "RULE_NOT_FOUND",
  /** The requested policy bundle does not exist or has been deleted. */
  POLICY_BUNDLE_NOT_FOUND: "POLICY_BUNDLE_NOT_FOUND",
  /** Rule evaluation failed due to an internal error. */
  RULE_EVALUATION_FAILED: "RULE_EVALUATION_FAILED",
  /** Two or more policy bundles have conflicting rules for the same resource/action. */
  POLICY_CONFLICT: "POLICY_CONFLICT",
  /** The rule definition failed validation. */
  RULE_VALIDATION_FAILED: "RULE_VALIDATION_FAILED",
  /** The policy bundle YAML failed parsing or schema validation. */
  POLICY_BUNDLE_PARSE_FAILED: "POLICY_BUNDLE_PARSE_FAILED",
  /** Optimistic concurrency conflict — the etag does not match. */
  RULE_ETAG_MISMATCH: "RULE_ETAG_MISMATCH",
  /** A rule with the same ID already exists in the bundle. */
  RULE_DUPLICATE_ID: "RULE_DUPLICATE_ID",
  /** The policy bundle version is stale — a newer version exists. */
  POLICY_BUNDLE_VERSION_CONFLICT: "POLICY_BUNDLE_VERSION_CONFLICT",
  /** Regex pattern in a rule condition is invalid or too complex. */
  RULE_INVALID_REGEX: "RULE_INVALID_REGEX",
  /** Regex pattern uses unsupported constructs or exceeds safety limits. */
  RULE_UNSAFE_REGEX: "RULE_UNSAFE_REGEX",
  /** Idempotency key reused with a different payload inside retention window. */
  IDEMPOTENCY_KEY_CONFLICT: "IDEMPOTENCY_KEY_CONFLICT",
} as const;

/** Union type of all rules engine error codes. */
export type FridayRulesErrorCode =
  (typeof FRIDAY_RULES_ERROR_CODES)[keyof typeof FRIDAY_RULES_ERROR_CODES];

// ─── Pagination (reuses shared types from api/model) ───

export type FridayRulesPaginationQuery = FridayPaginationQuery;
export type FridayRulesPage<TItem> = FridayPage<TItem>;

// ─── Idempotency Contract ───

/** Idempotency TTL in hours for all rules API write operations. */
export const FRIDAY_RULES_IDEMPOTENCY_TTL_HOURS = 24 as const;

/** Idempotency contract specification for rules API write operations. */
export interface FridayRulesIdempotencyContract {
  /** Scope is (principalId, operationId, key). */
  scope: "principal+operation";
  /** Keys expire after 24 hours. */
  ttlHours: 24;
  /** Same payload hash returns the original response. */
  replayBehavior: "same_payload_returns_original_response";
  /** Different payload hash returns 409. */
  conflict: { httpStatus: 409; code: "IDEMPOTENCY_KEY_CONFLICT" };
}

// ─── Evaluate ───

/**
 * Request body for `POST /api/rules/evaluate`.
 *
 * Submits an evaluation context for rule evaluation. Supports an optional
 * idempotency key to prevent duplicate audit log entries.
 *
 * @openapi operationId: evaluateRules
 */
export interface FridayEvaluateRulesRequest {
  /** The evaluation context describing the action being gated. */
  context: FridayEvaluationContext;
  /** Scope evaluation to a specific policy bundle. */
  policyBundleId?: string;
  /**
   * Idempotency key to prevent duplicate evaluations.
   * See {@link FridayRulesIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
  /**
   * If true, evaluate rules but do not write to the audit log.
   * Useful for testing and dry-run scenarios.
   */
  dryRun?: boolean;
}

/**
 * Response body for `POST /api/rules/evaluate`.
 *
 * @openapi operationId: evaluateRules
 */
export interface FridayEvaluateRulesResponse {
  /** The evaluation result. */
  result: FridayEvaluationResult;
}

// ─── List Rules ───

/**
 * Query parameters for `GET /api/rules`.
 *
 * @openapi operationId: listRules
 */
export interface FridayListRulesQuery extends FridayRulesPaginationQuery {
  /** Filter by policy bundle ID. */
  policyBundleId?: UUID;
  /** Filter by resource type. */
  resource?: FridayRuleResource;
  /** Filter by action type. */
  action?: FridayRuleAction;
  /** Filter by decision type. */
  decision?: FridayRuleDecision;
  /** Filter by enabled status. */
  enabled?: boolean;
  /** Include soft-deleted rules. */
  includeDeleted?: boolean;
}

/**
 * Response body for `GET /api/rules`.
 *
 * @openapi operationId: listRules
 */
export interface FridayListRulesResponse extends FridayRulesPage<FridayRule> {}

// ─── Get Rule ───

/**
 * Response body for `GET /api/rules/:ruleId`.
 *
 * @openapi operationId: getRule
 */
export interface FridayGetRuleResponse {
  /** The requested rule. */
  rule: FridayRule;
  /** The parent policy bundle. */
  policyBundle: FridayPolicyBundle;
}

// ─── Create Rule ───

/**
 * Request body for `POST /api/rules`.
 *
 * @openapi operationId: createRule
 */
export interface FridayCreateRuleRequest {
  /** Policy bundle this rule belongs to. */
  policyBundleId: UUID;
  /** Human-readable rule name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Resource category this rule applies to. */
  resource: FridayRuleResource;
  /** Action this rule gates. */
  action: FridayRuleAction;
  /** Conditions that must be met for this rule to match. */
  conditions?: FridayRuleConditionGroup;
  /** Decision to return when the rule matches. */
  decision: FridayRuleDecision;
  /** Message returned with the decision. */
  message?: string;
  /**
   * Rule priority within its bundle. Lower number = higher priority.
   * @default 100
   */
  priority?: number;
  /** Whether this rule is enabled on creation. */
  enabled?: boolean;
  /**
   * Idempotency key to prevent duplicate creation.
   * See {@link FridayRulesIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/rules`.
 *
 * @openapi operationId: createRule
 */
export interface FridayCreateRuleResponse {
  /** The created rule. */
  rule: FridayRule;
}

// ─── Update Rule ───

/**
 * Request body for `PUT /api/rules/:ruleId`.
 *
 * Uses optimistic concurrency — the `etag` must match the current rule version.
 *
 * @openapi operationId: updateRule
 */
export interface FridayUpdateRuleRequest {
  /** Required optimistic concurrency token. */
  etag: string;
  /** Updated rule name. */
  name?: string;
  /** Updated description. */
  description?: string;
  /** Updated resource. */
  resource?: FridayRuleResource;
  /** Updated action. */
  action?: FridayRuleAction;
  /** Updated conditions. */
  conditions?: FridayRuleConditionGroup;
  /** Updated decision. */
  decision?: FridayRuleDecision;
  /** Updated message. */
  message?: string;
  /** Updated priority. */
  priority?: number;
  /** Updated enabled status. */
  enabled?: boolean;
  /** Change note for version history. */
  changeNote?: string;
}

/**
 * Response body for `PUT /api/rules/:ruleId`.
 *
 * @openapi operationId: updateRule
 */
export interface FridayUpdateRuleResponse {
  /** The updated rule. */
  rule: FridayRule;
  /** The version record created for this update. */
  version: FridayRuleVersion;
}

// ─── Delete Rule ───

/**
 * Request body for `DELETE /api/rules/:ruleId`.
 *
 * @openapi operationId: deleteRule
 */
export interface FridayDeleteRuleRequest {
  /** Required optimistic concurrency token. */
  etag: string;
}

/**
 * Response body for `DELETE /api/rules/:ruleId`.
 *
 * @openapi operationId: deleteRule
 */
export interface FridayDeleteRuleResponse {
  /** Confirmation of deletion. */
  deleted: true;
  /** ID of the deleted rule. */
  ruleId: UUID;
}

// ─── List Policy Bundles ───

/**
 * Query parameters for `GET /api/rules/policy-bundles`.
 *
 * @openapi operationId: listPolicyBundles
 */
export interface FridayListPolicyBundlesQuery extends FridayRulesPaginationQuery {
  /** Filter by source type. */
  source?: FridayPolicyBundleSource;
  /** Filter by enabled status. */
  enabled?: boolean;
  /** Filter by tag (matches any bundle containing this tag). */
  tag?: string;
  /** Include soft-deleted bundles. */
  includeDeleted?: boolean;
}

/**
 * Response body for `GET /api/rules/policy-bundles`.
 *
 * @openapi operationId: listPolicyBundles
 */
export interface FridayListPolicyBundlesResponse extends FridayRulesPage<FridayPolicyBundle> {}

// ─── Get Policy Bundle ───

/**
 * Response body for `GET /api/rules/policy-bundles/:bundleId`.
 *
 * @openapi operationId: getPolicyBundle
 */
export interface FridayGetPolicyBundleResponse {
  /** The requested policy bundle. */
  bundle: FridayPolicyBundle;
  /** Rules belonging to this bundle. */
  rules: FridayRule[];
  /** Total count of rules in the bundle (may differ from rules[] if paginated). */
  ruleCount: number;
}

// ─── Create Policy Bundle ───

/**
 * Request body for `POST /api/rules/policy-bundles`.
 *
 * @openapi operationId: createPolicyBundle
 */
export interface FridayCreatePolicyBundleRequest {
  /** Human-readable name. */
  name: string;
  /** Optional description. */
  description?: string;
  /**
   * Bundle priority. Lower number = higher priority.
   * @default 100
   */
  priority?: number;
  /** Whether the bundle is enabled on creation. */
  enabled?: boolean;
  /** Tags for filtering. */
  tags?: string[];
  /** Source type. */
  source?: FridayPolicyBundleSource;
  /**
   * Idempotency key to prevent duplicate creation.
   * See {@link FridayRulesIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/rules/policy-bundles`.
 *
 * @openapi operationId: createPolicyBundle
 */
export interface FridayCreatePolicyBundleResponse {
  /** The created policy bundle. */
  bundle: FridayPolicyBundle;
}

// ─── Update Policy Bundle ───

/**
 * Request body for `PUT /api/rules/policy-bundles/:bundleId`.
 *
 * @openapi operationId: updatePolicyBundle
 */
export interface FridayUpdatePolicyBundleRequest {
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
}

/**
 * Response body for `PUT /api/rules/policy-bundles/:bundleId`.
 *
 * @openapi operationId: updatePolicyBundle
 */
export interface FridayUpdatePolicyBundleResponse {
  /** The updated policy bundle. */
  bundle: FridayPolicyBundle;
}

// ─── Delete Policy Bundle ───

/**
 * Request body for `DELETE /api/rules/policy-bundles/:bundleId`.
 *
 * @openapi operationId: deletePolicyBundle
 */
export interface FridayDeletePolicyBundleRequest {
  /** Required optimistic concurrency token. */
  etag: string;
}

/**
 * Response body for `DELETE /api/rules/policy-bundles/:bundleId`.
 *
 * @openapi operationId: deletePolicyBundle
 */
export interface FridayDeletePolicyBundleResponse {
  /** Confirmation of deletion. */
  deleted: true;
  /** ID of the deleted bundle. */
  bundleId: UUID;
  /** Number of rules that were cascade soft-deleted. */
  rulesDeleted: number;
}

// ─── Import Policy Bundle (from YAML) ───

/**
 * Request body for `POST /api/rules/policy-bundles/import`.
 *
 * Imports a YAML policy bundle, creating or updating the bundle and its rules.
 *
 * @openapi operationId: importPolicyBundle
 */
export interface FridayImportPolicyBundleRequest {
  /** Raw YAML content of the policy bundle. */
  yaml: string;
  /** If true, overwrite existing bundle with the same ID. */
  overwrite?: boolean;
  /**
   * Idempotency key to prevent duplicate imports.
   * See {@link FridayRulesIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/rules/policy-bundles/import`.
 *
 * @openapi operationId: importPolicyBundle
 */
export interface FridayImportPolicyBundleResponse {
  /** The imported policy bundle. */
  bundle: FridayPolicyBundle;
  /** Rules created or updated during import. */
  rules: FridayRule[];
  /** Number of rules created. */
  rulesCreated: number;
  /** Number of rules updated. */
  rulesUpdated: number;
}

// ─── Rule Version History ───

/**
 * Query parameters for `GET /api/rules/:ruleId/versions`.
 *
 * @openapi operationId: listRuleVersions
 */
export interface FridayListRuleVersionsQuery extends FridayRulesPaginationQuery {}

/**
 * Response body for `GET /api/rules/:ruleId/versions`.
 *
 * @openapi operationId: listRuleVersions
 */
export interface FridayListRuleVersionsResponse extends FridayRulesPage<FridayRuleVersion> {}

// ─── Evaluation Audit Log ───

/**
 * Query parameters for `GET /api/rules/audit-log`.
 *
 * @openapi operationId: listEvaluationAuditLog
 */
export interface FridayListEvaluationAuditLogQuery extends FridayRulesPaginationQuery {
  /** Filter by decision type. */
  decision?: FridayRuleDecision;
  /** Filter by resource type. */
  resource?: FridayRuleResource;
  /** Filter by action type. */
  action?: FridayRuleAction;
  /** Filter by run ID. */
  runId?: UUID;
  /** Filter by principal ID. */
  principalId?: string;
  /** Filter entries after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter entries before this timestamp (exclusive). */
  before?: ISODateTime;
}

/** A single audit log entry. */
export interface FridayEvaluationAuditLogEntry {
  /** Unique entry ID. */
  id: UUID;
  /** Rule that triggered this entry (if a specific rule matched). */
  ruleId?: UUID;
  /** Policy bundle ID (if a specific bundle was involved). */
  policyBundleId?: UUID;
  /** Final decision. */
  decision: FridayRuleDecision;
  /** Resource evaluated. */
  resource: FridayRuleResource;
  /** Action evaluated. */
  action: FridayRuleAction;
  /** Redacted context only (raw context is never returned). */
  context: JsonObject;
  /** Whether redaction was applied to the context. */
  redactionApplied: boolean;
  /** Fields that were redacted from the context. */
  redactedFields: string[];
  /** All matched rules. */
  matchedRules: FridayMatchedRule[];
  /** Evaluation duration in milliseconds. */
  durationMs: number;
  /** Associated run ID. */
  runId?: UUID;
  /** Associated workflow ID. */
  workflowId?: UUID;
  /** Principal ID. */
  principalId?: string;
  /** When the evaluation occurred. */
  createdAt: ISODateTime;
}

/**
 * Response body for `GET /api/rules/audit-log`.
 *
 * @openapi operationId: listEvaluationAuditLog
 */
export interface FridayListEvaluationAuditLogResponse extends FridayRulesPage<FridayEvaluationAuditLogEntry> {}
