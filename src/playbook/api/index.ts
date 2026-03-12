// ─── Playbook Learning System API Contract ───

export {
  FRIDAY_PLAYBOOK_ERROR_CODES,
  FRIDAY_PLAYBOOK_IDEMPOTENCY_TTL_HOURS,
} from "./friday-playbook-api.types.js";

export type {
  // Error codes
  FridayPlaybookErrorCode,

  // Pagination
  FridayPlaybookPaginationQuery,
  FridayPlaybookPage,

  // Idempotency
  FridayPlaybookIdempotencyContract,

  // List playbooks
  FridayListPlaybooksQuery,
  FridayPlaybookSummary,
  FridayListPlaybooksResponse,

  // Get playbook
  FridayGetPlaybookResponse,

  // List playbook versions
  FridayListPlaybookVersionsQuery,
  FridayListPlaybookVersionsResponse,

  // DTO types
  FridayPlaybookDto,
  FridayPlaybookVersionDto,
  FridayPlaybookCandidateDto,
  FridayPlaybookScoreDto,
  FridayPlaybookMatchDto,
  FridayPromotionRuleResultDto,
  FridayPromotionDecisionDto,

  // Promote candidate
  FridayPromoteCandidateRequest,
  FridayPromoteCandidateResponse,
  FridayPromoteCandidatePromoted,
  FridayPromoteCandidateRejected,
  FridayPromoteCandidateDeferred,

  // List candidates
  FridayListCandidatesQuery,
  FridayListCandidatesResponse,

  // Get candidate
  FridayGetCandidateResponse,

  // Select playbook
  FridaySelectPlaybookRequest,
  FridaySelectPlaybookResponse,
  FridaySelectPlaybookMatched,
  FridaySelectPlaybookFallback,
  FridaySelectPlaybookNone,

  // Score history
  FridayGetPlaybookScoreHistoryQuery,
  FridayGetPlaybookScoreHistoryResponse,
  FridayPlaybookScoreTrend,

  // Rollback
  FridayRollbackPlaybookRequest,
  FridayRollbackPlaybookResponse,

  // Selections
  FridayListSelectionsQuery,
  FridayListSelectionsResponse,

  // Promotion decisions
  FridayListPromotionDecisionsQuery,
  FridayListPromotionDecisionsResponse,

  // Analytics
  FridayGetPlaybookAnalyticsQuery,
  FridayGetPlaybookAnalyticsResponse,
  FridayPlaybookAnalyticsBreakdown,
} from "./friday-playbook-api.types.js";
