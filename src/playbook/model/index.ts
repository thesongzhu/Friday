// ─── Playbook Learning System Domain Model ───

export {
  FRIDAY_PLAYBOOK_COST_NORMALIZATION_WEIGHTS,
  FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS,
  FRIDAY_PLAYBOOK_SCORE_DECAY_RATE,
  FRIDAY_DEFAULT_PROMOTION_RULES,
  FRIDAY_PLAYBOOK_TIE_BREAK_ORDER,
} from "./friday-playbook.types.js";

export type {
  // Foundational value types
  UUID,
  ISODateTime,
  JsonPrimitive,
  JsonValue,
  JsonObject,

  // Core entities
  FridayPlaybookStatus,
  FridayPlaybook,
  FridayPlaybookCandidateStatus,
  FridayPlaybookCandidate,
  FridayPlaybookVersion,
  FridayPlaybookLifecycleEventType,
  FridayPlaybookLifecycleEvent,

  // Scoring
  FridayPlaybookScoreDimension,
  FridayPlaybookScore,
  FridayPlaybookScoreConfig,

  // Cost model
  FridayPlaybookCostDimensions,

  // Selection
  FridayPlaybookSelector,
  FridayPlaybookMatchReason,
  FridayPlaybookMatch,
  FridayPlaybookTieBreakCriterion,
  FridayPlaybookSelectionConfig,

  // Promotion
  FridayPromotionRule,
  FridayPromotionMetric,
  FridayPromotionOperator,
  FridayPromotionDecisionOutcome,
  FridayPromotionRuleResult,
  FridayPromotionDecision,
  FridayPromotionConfig,

  // Engine interfaces
  FridayPlaybookCandidateGenerator,
  FridayPlaybookRunCompletionEvent,
  FridayPlaybookPromotionEngine,
  FridayPlaybookScoreCalculator,
  FridayPlaybookSelectorEngine,
  FridayPlaybookEngineConfig,

  // Persistence row types
  FridayPlaybookRow,
  FridayPlaybookVersionRow,
  FridayPlaybookCandidateRow,
  FridayPlaybookScoreRow,
  FridayPlaybookSelectionRow,
  FridayPromotionDecisionRow,
  FridayPlaybookLifecycleEventRow,
  FridayPlaybookRowMapper,
} from "./friday-playbook.types.js";
