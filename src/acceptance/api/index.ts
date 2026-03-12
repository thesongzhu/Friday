// ─── Acceptance Testing API Contract ───

export {
  FRIDAY_ACCEPTANCE_ERROR_CODES,
  FRIDAY_ACCEPTANCE_IDEMPOTENCY_TTL_HOURS,
} from "./friday-acceptance-api.types.js";

export type {
  // Error codes
  FridayAcceptanceErrorCode,

  // Pagination
  FridayAcceptancePaginationQuery,
  FridayAcceptancePage,

  // Idempotency
  FridayAcceptanceIdempotencyContract,

  // Run acceptance tests
  FridayRunAcceptanceTestsRequest,
  FridayRunAcceptanceTestsResponse,

  // Get acceptance run
  FridayGetAcceptanceRunResponse,

  // List acceptance tests
  FridayListAcceptanceTestsQuery,
  FridayListAcceptanceTestsResponse,

  // Get acceptance test
  FridayGetAcceptanceTestResponse,

  // Register acceptance test
  FridayRegisterAcceptanceTestRequest,
  FridayRegisterAcceptanceTestResponse,

  // Update acceptance test
  FridayUpdateAcceptanceTestRequest,
  FridayUpdateAcceptanceTestResponse,

  // Delete acceptance test
  FridayDeleteAcceptanceTestRequest,
  FridayDeleteAcceptanceTestResponse,

  // Artifact acceptance history
  FridayGetArtifactAcceptanceHistoryQuery,
  FridayAcceptanceRunSummary,
  FridayGetArtifactAcceptanceHistoryResponse,
} from "./friday-acceptance-api.types.js";
