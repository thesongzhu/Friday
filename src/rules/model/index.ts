// ─── Rules Engine Domain Model ───

export type {
  // Foundational value types
  UUID,
  ISODateTime,
  JsonPrimitive,
  JsonValue,
  JsonObject,

  // Decision
  FridayRuleDecision,

  // Resource and action
  FridayRuleResource,
  FridayRuleAction,
  FridayRuleActionMeta,

  // Conditions
  FridayRuleConditionOperator,
  FridayRuleCondition,
  FridayRuleConditionGroup,

  // Rule entity
  FridayRule,

  // Rule set
  FridayRuleSet,

  // Policy bundle
  FridayPolicyBundleSource,
  FridayPolicyBundleSignatureAlgorithm,
  FridayPolicyBundleSignature,
  FridayPolicyBundle,

  // Evaluation
  FridayEvaluationSource,
  FridayEvaluationContext,
  ContextRedactionRules,
  FridayMatchedRule,
  FridayEvaluationTransitionState,
  FridayEvaluationTransitionReason,
  FridayEvaluationTransition,
  FridayEvaluationErrorCode,
  FridayEvaluationError,
  FridayEvaluationResult,

  // Versioning
  FridayRuleVersion,

  // Persistence row types
  FridayPolicyBundleRow,
  FridayRuleRow,
  FridayRuleEvaluationLogRow,
  FridayRuleVersionRow,
  FridayRowMapper,

  // YAML DSL types
  FridayPolicyBundleApiVersion,
  FridayPolicyBundleKind,
  FridayPolicyBundleYamlMetadata,
  FridayPolicyBundleYamlRule,
  FridayPolicyBundleYaml,

  // Hook types
  FridayRuleHookPhase,
  FridayRuleHookRegistration,
  FridayRuleHookHandler,
} from "./friday-rules-engine.types.js";

export {
  FRIDAY_RULE_DECISION_PRIORITY,
} from "./friday-rules-engine.types.js";
