// ─── Retry Engine Domain Model ───

export {
  FRIDAY_FAILURE_CATEGORY_PRIORITY,
} from "./friday-retry-engine.types.js";

export type {
  // Failure taxonomy
  FridayFailureCategory,
  FridayFailureSeverity,
  FridayFailureClassificationSource,
  FridayClassifiedFailure,
  FridayFailureClass,

  // Retry strategy
  FridayRetryStrategyType,
  FridayRetryStrategy,

  // Retry policy
  FridayRetryPolicyApiVersion,
  FridayRetryPolicyKind,
  FridayRetryPolicy,
  FridayRetryPolicyYamlMetadata,
  FridayRetryPolicyYaml,

  // Cost accounting
  FridayRetryCostDimensions,
  FridayRetryCostBudget,
  FridayRetryCostRecord,
  FridayRetryCostSummary,

  // Retry execution
  FridayRetryAttempt,
  FridayRetryAttemptOutcome,
  FridayRetryDecision,
  FridayRetryTraceStatus,
  FridayRetryTrace,

  // Escalation
  FridayRetryEscalationTarget,
  FridayRetryEscalation,

  // Engine interfaces
  FridayFailureClassifier,
  FridayCustomClassificationRule,
  FridayRetryDecisionEngine,
  FridayRetryDecisionContext,
  FridayRetryEngineConfig,

  // Persistence row types
  FridayRetryPolicyRow,
  FridayRetryTraceRow,
  FridayRetryAttemptRow,
  FridayRetryCostRecordRow,
  FridayRetryEscalationRow,
  FridayRetryRowMapper,
} from "./friday-retry-engine.types.js";
