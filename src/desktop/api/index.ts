// ─── Desktop Control Runtime API Contract ───

export {
  FRIDAY_DESKTOP_ERROR_CODES,
  FRIDAY_DESKTOP_IDEMPOTENCY_TTL_HOURS,
} from "./friday-desktop-api.types.js";

export type {
  // Error codes (re-exported from domain model via API types)
  FridayDesktopErrorCode,

  // Pagination
  FridayDesktopPaginationQuery,
  FridayDesktopPage,

  // Idempotency
  FridayDesktopIdempotencyContract,

  // DTO types
  FridayDesktopElementSelectorDto,
  FridayDesktopActionDto,
  FridayDesktopFileEntryDto,
  FridayDesktopAdapterDto,
  FridayDesktopElementDto,
  FridayDesktopActionResultDto,
  FridayDesktopRecordingDto,
  FridayDesktopRecordingStepDto,
  FridayDesktopPolicyDto,
  FridayDesktopPolicyRuleDto,
  FridayDesktopPermissionDto,
  FridayDesktopPermissionPromptDto,
  FridayDesktopPermissionDecisionDto,

  // Execute action
  FridayExecuteDesktopActionRequest,
  FridayExecuteDesktopActionResponse,

  // Batch actions
  FridayDesktopBatchActionItem,
  FridayBatchDesktopActionsRequest,
  FridayDesktopBatchActionResultItem,
  FridayBatchDesktopActionsResponse,

  // Cancel action
  FridayCancelDesktopActionRequest,
  FridayCancelDesktopActionResponse,

  // Recordings: start
  FridayStartDesktopRecordingRequest,
  FridayStartDesktopRecordingResponse,

  // Recordings: stop
  FridayStopDesktopRecordingRequest,
  FridayStopDesktopRecordingResponse,

  // Recordings: pause/resume
  FridayPauseDesktopRecordingRequest,
  FridayPauseDesktopRecordingResponse,
  FridayResumeDesktopRecordingRequest,
  FridayResumeDesktopRecordingResponse,

  // Recordings: list
  FridayListDesktopRecordingsQuery,
  FridayListDesktopRecordingsResponse,

  // Recordings: get
  FridayGetDesktopRecordingResponse,

  // Recordings: list steps (paginated)
  FridayListDesktopRecordingStepsQuery,
  FridayListDesktopRecordingStepsResponse,

  // Recordings: replay
  FridayReplayDesktopRecordingRequest,
  FridayDesktopReplayStepResult,
  FridayReplayDesktopRecordingResponse,

  // Recordings: delete
  FridayDeleteDesktopRecordingRequest,
  FridayDeleteDesktopRecordingResponse,

  // Policies: create
  FridayDesktopPolicyRuleInput,
  FridayCreateDesktopPolicyRequest,
  FridayCreateDesktopPolicyResponse,

  // Policies: get
  FridayGetDesktopPolicyResponse,

  // Policies: list
  FridayListDesktopPoliciesQuery,
  FridayListDesktopPoliciesResponse,

  // Policies: update
  FridayUpdateDesktopPolicyRequest,
  FridayUpdateDesktopPolicyResponse,

  // Policies: delete
  FridayDeleteDesktopPolicyRequest,
  FridayDeleteDesktopPolicyResponse,

  // Policies: add/remove rule
  FridayAddDesktopPolicyRuleRequest,
  FridayAddDesktopPolicyRuleResponse,
  FridayRemoveDesktopPolicyRuleRequest,
  FridayRemoveDesktopPolicyRuleResponse,

  // Permissions: list
  FridayListDesktopPermissionsResponse,

  // Permissions: respond to prompt
  FridayRespondToPermissionPromptRequest,
  FridayRespondToPermissionPromptResponse,

  // Permissions: list decisions
  FridayListDesktopPermissionDecisionsQuery,
  FridayListDesktopPermissionDecisionsResponse,

  // Platform capability discovery
  FridayGetDesktopPlatformResponse,

  // Element inspection/search
  FridayInspectDesktopElementRequest,
  FridayInspectDesktopElementResponse,
  FridaySearchDesktopElementsQuery,
  FridaySearchDesktopElementsResponse,

  // Action log
  FridayListDesktopActionLogQuery,
  FridayListDesktopActionLogResponse,
} from "./friday-desktop-api.types.js";
