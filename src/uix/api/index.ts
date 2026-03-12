// ─── Non-Builder Product UX (UIX) API Contract ───

export {
  FRIDAY_UIX_ERROR_CODES,
  FRIDAY_UIX_IDEMPOTENCY_TTL_HOURS,
} from "./friday-uix-api.types.js";

export type {
  // Error codes
  FridayUixErrorCode,

  // Pagination
  FridayUixPaginationQuery,
  FridayUixPage,

  // Idempotency
  FridayUixIdempotencyContract,

  // List action templates
  FridayListActionTemplatesQuery,
  FridayListActionTemplatesResponse,

  // Get action template
  FridayGetActionTemplateResponse,

  // Execute action template
  FridayExecuteActionTemplateRequest,
  FridayExecuteActionTemplateResponse,

  // Classify intent
  FridayClassifyIntentRequest,
  FridayClassifyIntentResponse,
  FridayActionTemplateSummary,
  FridayGuidedWorkflowSummary,

  // List guided workflows
  FridayListGuidedWorkflowsQuery,
  FridayListGuidedWorkflowsResponse,

  // Get guided workflow
  FridayGetGuidedWorkflowResponse,

  // Start guided workflow
  FridayStartGuidedWorkflowRequest,
  FridayStartGuidedWorkflowResponse,
  FridayGuidedStepPresentation,

  // Advance guided step
  FridayAdvanceGuidedStepRequest,
  FridayAdvanceGuidedStepResponse,

  // Go back guided step
  FridayGoBackGuidedStepRequest,
  FridayGoBackGuidedStepResponse,

  // Abandon guided workflow
  FridayAbandonGuidedWorkflowRequest,
  FridayAbandonGuidedWorkflowResponse,

  // Get guided context
  FridayGetGuidedContextResponse,

  // User preferences
  FridayListUserPreferencesQuery,
  FridayListUserPreferencesResponse,
  FridayGetUserPreferenceResponse,
  FridayUpdateUserPreferencesRequest,
  FridayUserPreferenceUpsert,
  FridayUpdateUserPreferencesResponse,
  FridayDeleteUserPreferenceResponse,
  FridayGetCommunicationPersonaResponse,

  // Template executions
  FridayListTemplateExecutionsQuery,
  FridayListTemplateExecutionsResponse,
  FridayGetTemplateExecutionResponse,
} from "./friday-uix-api.types.js";
