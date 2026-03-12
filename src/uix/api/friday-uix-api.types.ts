/**
 * Non-Builder Product UX (UIX) — API and SDK Contract.
 *
 * Request/response DTOs for the UIX REST API.
 * All types follow Friday API conventions: `FridayPage<T>` for pagination,
 * `FridayApiSuccessResponse<T>` / `FridayApiErrorResponse` for responses.
 *
 * @module uix/api
 */

import type {
  FridayActionCategory,
  FridayActionTemplate,
  FridayConversationContext,
  FridayDisclosureLevel,
  FridayGuidedContext,
  FridayGuidedContextStatus,
  FridayGuidedStepType,
  FridayGuidedWorkflow,
  FridayIntentClassification,
  FridaySmartDefault,
  FridayTemplateExecutionOutcome,
  FridayTemplateExecutionResult,
  FridayUixRouteTarget,
  FridayUserPreference,
  FridayUserPreferenceCategory,
  ISODateTime,
  JsonObject,
  JsonValue,
  UUID,
} from "../model/friday-uix.types.js";
import type { FridayCommunicationPersona } from "../services/friday-communication-persona.js";

import type { FridayPage, FridayPaginationQuery } from "../../api/model/friday-api-common.types.js";

// ─── Error Codes ───

/**
 * Standardized error codes for the UIX domain.
 *
 * @example
 * ```ts
 * if (error.code === FRIDAY_UIX_ERROR_CODES.TEMPLATE_NOT_FOUND) { ... }
 * ```
 */
export const FRIDAY_UIX_ERROR_CODES = {
  /** The requested action template does not exist or has been deleted. */
  TEMPLATE_NOT_FOUND: "UIX_TEMPLATE_NOT_FOUND",
  /** The action template is disabled and cannot be executed. */
  TEMPLATE_DISABLED: "UIX_TEMPLATE_DISABLED",
  /** Template parameter validation failed. */
  TEMPLATE_VALIDATION_FAILED: "UIX_TEMPLATE_VALIDATION_FAILED",
  /** Template execution failed. */
  TEMPLATE_EXECUTION_FAILED: "UIX_TEMPLATE_EXECUTION_FAILED",
  /** Optimistic concurrency conflict — the etag does not match. */
  TEMPLATE_ETAG_MISMATCH: "UIX_TEMPLATE_ETAG_MISMATCH",
  /** The requested guided workflow does not exist or has been deleted. */
  GUIDED_WORKFLOW_NOT_FOUND: "UIX_GUIDED_WORKFLOW_NOT_FOUND",
  /** The guided workflow is disabled and cannot be started. */
  GUIDED_WORKFLOW_DISABLED: "UIX_GUIDED_WORKFLOW_DISABLED",
  /** The requested guided context does not exist. */
  GUIDED_CONTEXT_NOT_FOUND: "UIX_GUIDED_CONTEXT_NOT_FOUND",
  /** The guided context has expired (exceeded TTL). */
  GUIDED_CONTEXT_EXPIRED: "UIX_GUIDED_CONTEXT_EXPIRED",
  /** The guided context is not in a state that allows advancing. */
  GUIDED_CONTEXT_NOT_ADVANCEABLE: "UIX_GUIDED_CONTEXT_NOT_ADVANCEABLE",
  /** Step validation failed during guided workflow advancement. */
  GUIDED_STEP_VALIDATION_FAILED: "UIX_GUIDED_STEP_VALIDATION_FAILED",
  /** Cannot go back from the first step. */
  GUIDED_STEP_NO_PREVIOUS: "UIX_GUIDED_STEP_NO_PREVIOUS",
  /** A guided context already exists for this user and channel. */
  GUIDED_CONTEXT_ALREADY_EXISTS: "UIX_GUIDED_CONTEXT_ALREADY_EXISTS",
  /** The requested user preference does not exist. */
  PREFERENCE_NOT_FOUND: "UIX_PREFERENCE_NOT_FOUND",
  /** User preference validation failed. */
  PREFERENCE_VALIDATION_FAILED: "UIX_PREFERENCE_VALIDATION_FAILED",
  /** NL intent classification failed. */
  INTENT_CLASSIFICATION_FAILED: "UIX_INTENT_CLASSIFICATION_FAILED",
  /** The execution was denied by the Rules Engine. */
  EXECUTION_DENIED: "UIX_EXECUTION_DENIED",
  /** The referenced skill does not exist. */
  SKILL_NOT_FOUND: "UIX_SKILL_NOT_FOUND",
  /** The referenced workflow does not exist. */
  WORKFLOW_NOT_FOUND: "UIX_WORKFLOW_NOT_FOUND",
  /** Idempotency key reused with a different payload inside retention window. */
  IDEMPOTENCY_KEY_CONFLICT: "UIX_IDEMPOTENCY_KEY_CONFLICT",
} as const;

/** Union type of all UIX error codes. */
export type FridayUixErrorCode =
  (typeof FRIDAY_UIX_ERROR_CODES)[keyof typeof FRIDAY_UIX_ERROR_CODES];

// ─── Pagination (reuses shared types from api/model) ───

/** Pagination query for UIX endpoints. */
export type FridayUixPaginationQuery = FridayPaginationQuery;

/** Paginated result for UIX endpoints. */
export type FridayUixPage<TItem> = FridayPage<TItem>;

// ─── Idempotency Contract ───

/** Idempotency TTL in hours for all UIX API write operations. */
export const FRIDAY_UIX_IDEMPOTENCY_TTL_HOURS = 24 as const;

/**
 * Idempotency contract specification for UIX API write operations.
 *
 * Covered endpoints:
 * - `POST /api/uix/templates/:templateId/execute`
 * - `POST /api/uix/wizards/:workflowId/start`
 * - `POST /api/uix/wizards/contexts/:contextId/advance`
 * - `POST /api/uix/wizards/contexts/:contextId/back`
 * - `POST /api/uix/wizards/contexts/:contextId/abandon`
 */
export interface FridayUixIdempotencyContract {
  /** Scope is (principalId, operationId, key). */
  scope: "principal+operation";
  /** Keys expire after 24 hours. */
  ttlHours: 24;
  /** Same payload hash returns the original response. */
  replayBehavior: "same_payload_returns_original_response";
  /** Different payload hash returns 409. */
  conflict: { httpStatus: 409; code: "UIX_IDEMPOTENCY_KEY_CONFLICT" };
}

// ─── List Action Templates ───

/**
 * Query parameters for `GET /api/uix/templates`.
 *
 * @openapi operationId: listActionTemplates
 */
export interface FridayListActionTemplatesQuery extends FridayUixPaginationQuery {
  /** Filter by category. */
  category?: FridayActionCategory;
  /** Filter by tag (matches any template containing this tag). */
  tag?: string;
  /** Filter by enabled status. */
  enabled?: boolean;
  /** Search query (matches name, description, tags). */
  search?: string;
  /** Include soft-deleted templates. */
  includeDeleted?: boolean;
}

/**
 * Response body for `GET /api/uix/templates`.
 *
 * @openapi operationId: listActionTemplates
 */
export interface FridayListActionTemplatesResponse extends FridayUixPage<FridayActionTemplate> {}

// ─── Get Action Template ───

/**
 * Response body for `GET /api/uix/templates/:templateId`.
 *
 * @openapi operationId: getActionTemplate
 */
export interface FridayGetActionTemplateResponse {
  /** The requested action template. */
  template: FridayActionTemplate;
  /** Smart defaults computed for the current user. */
  defaults: FridaySmartDefault[];
}

// ─── Execute Action Template ───

/**
 * Request body for `POST /api/uix/templates/:templateId/execute`.
 *
 * Executes an action template with the provided parameters.
 * Missing parameters are filled from smart defaults.
 *
 * @openapi operationId: executeActionTemplate
 */
export interface FridayExecuteActionTemplateRequest {
  /** Parameter values provided by the user. */
  parameters: JsonObject;
  /**
   * If true, compute defaults and preview the execution without running it.
   * Returns the merged parameters and preview text.
   */
  dryRun?: boolean;
  /**
   * Idempotency key to prevent duplicate executions.
   * See {@link FridayUixIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/uix/templates/:templateId/execute`.
 *
 * @openapi operationId: executeActionTemplate
 */
export interface FridayExecuteActionTemplateResponse {
  /** The execution result (null when dryRun is true). */
  result: FridayTemplateExecutionResult | null;
  /** The merged parameters (user input + smart defaults). */
  mergedParameters: JsonObject;
  /** Smart defaults that were applied. */
  appliedDefaults: FridaySmartDefault[];
  /** Human-readable preview of what was (or would be) executed. */
  preview: string;
}

// ─── Classify Intent (NL → Action) ───

/**
 * Request body for `POST /api/uix/classify`.
 *
 * Classifies a natural language input into an intent and resolves
 * it to an action template or guided workflow.
 *
 * @openapi operationId: classifyIntent
 */
export interface FridayClassifyIntentRequest {
  /** The user's natural language input. */
  input: string;
  /** Channel ID for context. */
  channelId?: string;
  /** Session ID for conversation context. */
  sessionId?: string;
}

/**
 * Response body for `POST /api/uix/classify`.
 *
 * @openapi operationId: classifyIntent
 */
export interface FridayClassifyIntentResponse {
  /** The intent classification result. */
  classification: FridayIntentClassification;
  /** The routing decision. */
  routeTarget: FridayUixRouteTarget;
  /** Suggested action templates (when routeTarget is "template" or "disambiguate"). */
  suggestedTemplates: FridayActionTemplateSummary[];
  /** Suggested guided workflows (when routeTarget is "wizard" or "disambiguate"). */
  suggestedWorkflows: FridayGuidedWorkflowSummary[];
}

/** Lightweight action template summary for classification responses. */
export interface FridayActionTemplateSummary {
  /** Template ID. */
  id: UUID;
  /** Template name. */
  name: string;
  /** Short description. */
  description: string;
  /** Icon. */
  icon: string;
  /** Category. */
  category: FridayActionCategory;
  /** Match confidence (0.0–1.0). */
  confidence: number;
}

/** Lightweight guided workflow summary for classification responses. */
export interface FridayGuidedWorkflowSummary {
  /** Workflow ID. */
  id: UUID;
  /** Workflow name. */
  name: string;
  /** Short description. */
  description: string;
  /** Icon. */
  icon: string;
  /** Category. */
  category: FridayActionCategory;
  /** Number of steps. */
  stepCount: number;
  /** Match confidence (0.0–1.0). */
  confidence: number;
}

// ─── List Guided Workflows ───

/**
 * Query parameters for `GET /api/uix/wizards`.
 *
 * @openapi operationId: listGuidedWorkflows
 */
export interface FridayListGuidedWorkflowsQuery extends FridayUixPaginationQuery {
  /** Filter by category. */
  category?: FridayActionCategory;
  /** Filter by tag. */
  tag?: string;
  /** Filter by enabled status. */
  enabled?: boolean;
  /** Search query. */
  search?: string;
  /** Include soft-deleted wizards. */
  includeDeleted?: boolean;
}

/**
 * Response body for `GET /api/uix/wizards`.
 *
 * @openapi operationId: listGuidedWorkflows
 */
export interface FridayListGuidedWorkflowsResponse extends FridayUixPage<FridayGuidedWorkflow> {}

// ─── Get Guided Workflow ───

/**
 * Response body for `GET /api/uix/wizards/:workflowId`.
 *
 * @openapi operationId: getGuidedWorkflow
 */
export interface FridayGetGuidedWorkflowResponse {
  /** The requested guided workflow. */
  workflow: FridayGuidedWorkflow;
  /** Number of steps in the workflow. */
  stepCount: number;
}

// ─── Start Guided Workflow ───

/**
 * Request body for `POST /api/uix/wizards/:workflowId/start`.
 *
 * Starts a new guided workflow session for the current user.
 *
 * @openapi operationId: startGuidedWorkflow
 */
export interface FridayStartGuidedWorkflowRequest {
  /** Channel ID where the wizard is active. */
  channelId: string;
  /** Initial parameter values (pre-fill from NL extraction). */
  initialData?: JsonObject;
  /**
   * Idempotency key to prevent duplicate starts.
   * See {@link FridayUixIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/uix/wizards/:workflowId/start`.
 *
 * @openapi operationId: startGuidedWorkflow
 */
export interface FridayStartGuidedWorkflowResponse {
  /** The created guided context. */
  context: FridayGuidedContext;
  /** The current step to present to the user. */
  currentStep: FridayGuidedStepPresentation;
  /** Smart defaults for the current step. */
  defaults: FridaySmartDefault[];
}

/**
 * Presentation model for a guided workflow step.
 * Includes the step definition plus computed defaults and progress info.
 */
export interface FridayGuidedStepPresentation {
  /** Step ID. */
  stepId: string;
  /** Step type. */
  type: FridayGuidedStepType;
  /** Step title. */
  title: string;
  /** Step description. */
  description?: string;
  /** Help text. */
  helpText?: string;
  /** Placeholder text. */
  placeholder?: string;
  /** Options (for select/multi-select). */
  options?: Array<{ value: string; label: string; description?: string; icon?: string }>;
  /** Pre-filled value (from defaults or initial data). */
  prefilledValue?: JsonValue;
  /** Whether this step can be skipped. */
  skippable: boolean;
  /** Current step number (1-indexed for display). */
  stepNumber: number;
  /** Total number of steps in the workflow. */
  totalSteps: number;
  /** Whether there is a previous step to go back to. */
  canGoBack: boolean;
}

// ─── Advance Guided Workflow Step ───

/**
 * Request body for `POST /api/uix/wizards/contexts/:contextId/advance`.
 *
 * Submits data for the current step and advances to the next step.
 *
 * @openapi operationId: advanceGuidedStep
 */
export interface FridayAdvanceGuidedStepRequest {
  /** Data for the current step. */
  stepData: JsonObject;
  /**
   * Idempotency key to prevent duplicate step advances.
   * Covered endpoint: `POST /api/uix/wizards/contexts/:contextId/advance`.
   * See {@link FridayUixIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/uix/wizards/contexts/:contextId/advance`.
 *
 * @openapi operationId: advanceGuidedStep
 */
export interface FridayAdvanceGuidedStepResponse {
  /** The updated guided context. */
  context: FridayGuidedContext;
  /** The next step to present (null if wizard is complete). */
  nextStep: FridayGuidedStepPresentation | null;
  /** Smart defaults for the next step (empty if wizard is complete). */
  defaults: FridaySmartDefault[];
  /** Whether the wizard is now complete and ready for execution. */
  isComplete: boolean;
  /** Execution result (populated only when isComplete and auto-execute is enabled). */
  executionResult?: FridayTemplateExecutionResult;
}

// ─── Go Back in Guided Workflow ───

/**
 * Request body for `POST /api/uix/wizards/contexts/:contextId/back`.
 *
 * Goes back to the previous step in the guided workflow.
 *
 * @openapi operationId: goBackGuidedStep
 */
export interface FridayGoBackGuidedStepRequest {
  /**
   * Idempotency key to prevent duplicate back navigations.
   * Covered endpoint: `POST /api/uix/wizards/contexts/:contextId/back`.
   * See {@link FridayUixIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/uix/wizards/contexts/:contextId/back`.
 *
 * @openapi operationId: goBackGuidedStep
 */
export interface FridayGoBackGuidedStepResponse {
  /** The updated guided context. */
  context: FridayGuidedContext;
  /** The previous step to present. */
  previousStep: FridayGuidedStepPresentation;
  /** Smart defaults for the previous step. */
  defaults: FridaySmartDefault[];
}

// ─── Abandon Guided Workflow ───

/**
 * Request body for `POST /api/uix/wizards/contexts/:contextId/abandon`.
 *
 * Abandons an in-progress guided workflow.
 *
 * @openapi operationId: abandonGuidedWorkflow
 */
export interface FridayAbandonGuidedWorkflowRequest {
  /**
   * Idempotency key to prevent duplicate abandon requests.
   * Covered endpoint: `POST /api/uix/wizards/contexts/:contextId/abandon`.
   * See {@link FridayUixIdempotencyContract} for scope, TTL, and conflict semantics.
   */
  idempotencyKey?: string;
}

/**
 * Response body for `POST /api/uix/wizards/contexts/:contextId/abandon`.
 *
 * @openapi operationId: abandonGuidedWorkflow
 */
export interface FridayAbandonGuidedWorkflowResponse {
  /** Confirmation of abandonment. */
  abandoned: true;
  /** ID of the abandoned context. */
  contextId: UUID;
}

// ─── Get Guided Context ───

/**
 * Response body for `GET /api/uix/wizards/contexts/:contextId`.
 *
 * @openapi operationId: getGuidedContext
 */
export interface FridayGetGuidedContextResponse {
  /** The guided context. */
  context: FridayGuidedContext;
  /** The current step presentation. */
  currentStep: FridayGuidedStepPresentation | null;
  /** Smart defaults for the current step. */
  defaults: FridaySmartDefault[];
  /** The parent guided workflow definition. */
  workflow: FridayGuidedWorkflow;
}

// ─── List User Preferences ───

/**
 * Query parameters for `GET /v1/uix/preferences`.
 *
 * @openapi operationId: listUserPreferences
 */
export interface FridayListUserPreferencesQuery extends FridayUixPaginationQuery {
  /** Filter by category. */
  category?: FridayUserPreferenceCategory;
}

/**
 * Response body for `GET /v1/uix/preferences`.
 *
 * @openapi operationId: listUserPreferences
 */
export interface FridayListUserPreferencesResponse extends FridayUixPage<FridayUserPreference> {}

// ─── Get User Preference ───

/**
 * Response body for `GET /v1/uix/preferences/:preferenceId`.
 *
 * @openapi operationId: getUserPreference
 */
export interface FridayGetUserPreferenceResponse {
  /** The requested preference. */
  preference: FridayUserPreference;
}

// ─── Update User Preferences ───

/**
 * Request body for `PUT /v1/uix/preferences`.
 *
 * Updates one or more user preferences. Creates preferences that don't exist.
 * Uses upsert semantics (principal + category + key).
 *
 * @openapi operationId: updateUserPreferences
 */
export interface FridayUpdateUserPreferencesRequest {
  /** Preferences to upsert. */
  preferences: FridayUserPreferenceUpsert[];
}

/** A single preference upsert entry. */
export interface FridayUserPreferenceUpsert {
  /** Preference category. */
  category: FridayUserPreferenceCategory;
  /** Preference key. */
  key: string;
  /** New value. */
  value: JsonValue;
}

/**
 * Response body for `PUT /v1/uix/preferences`.
 *
 * @openapi operationId: updateUserPreferences
 */
export interface FridayUpdateUserPreferencesResponse {
  /** Updated preferences. */
  preferences: FridayUserPreference[];
  /** Number of preferences created. */
  created: number;
  /** Number of preferences updated. */
  updated: number;
}

// ─── Delete User Preference ───

/**
 * Response body for `DELETE /v1/uix/preferences/:preferenceId`.
 *
 * @openapi operationId: deleteUserPreference
 */
export interface FridayDeleteUserPreferenceResponse {
  /** Confirmation of deletion. */
  deleted: true;
  /** ID of the deleted preference. */
  preferenceId: UUID;
}

// ─── Communication Persona ───

/**
 * Response body for `GET /v1/uix/persona`.
 *
 * @openapi operationId: getCommunicationPersona
 */
export interface FridayGetCommunicationPersonaResponse {
  /** Resolved communication persona for the current user. */
  persona: FridayCommunicationPersona;
}

// ─── List Template Executions ───

/**
 * Query parameters for `GET /api/uix/executions`.
 *
 * @openapi operationId: listTemplateExecutions
 */
export interface FridayListTemplateExecutionsQuery extends FridayUixPaginationQuery {
  /** Filter by source template or wizard ID. */
  sourceId?: UUID;
  /** Filter by source type. */
  sourceType?: "template" | "wizard";
  /** Filter by outcome. */
  outcome?: FridayTemplateExecutionOutcome;
  /** Filter executions after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter executions before this timestamp (exclusive). */
  before?: ISODateTime;
}

/**
 * Response body for `GET /api/uix/executions`.
 *
 * @openapi operationId: listTemplateExecutions
 */
export interface FridayListTemplateExecutionsResponse extends FridayUixPage<FridayTemplateExecutionResult> {}

// ─── Get Template Execution ───

/**
 * Response body for `GET /api/uix/executions/:executionId`.
 *
 * @openapi operationId: getTemplateExecution
 */
export interface FridayGetTemplateExecutionResponse {
  /** The execution result. */
  result: FridayTemplateExecutionResult;
  /** The source template or wizard (if still exists). */
  source: FridayActionTemplate | FridayGuidedWorkflow | null;
}
