// ─── Non-Builder Product UX (UIX) Domain Model ───

export {
  FRIDAY_SMART_DEFAULT_PRIORITY,
  FRIDAY_DISCLOSURE_LEVEL_RANK,
} from "./friday-uix.types.js";

export type {
  // Foundational value types
  UUID,
  ISODateTime,
  JsonPrimitive,
  JsonValue,
  JsonObject,

  // Action template categories
  FridayActionCategory,

  // Action template execution
  FridayActionTemplateExecutionType,
  FridaySkillTarget,
  FridayWorkflowTarget,
  FridayAgentTarget,
  FridayChannelTarget,
  FridayActionTemplateExecutionTarget,

  // Action template parameters
  FridayParameterType,
  FridayActionTemplateParameter,
  FridayParameterOption,

  // NL trigger phrases
  FridayTemplateTriggerPhrase,

  // Action template entity
  FridayActionTemplate,

  // Guided workflow step types
  FridayGuidedStepType,
  FridayGuidedStepValidation,
  FridayGuidedStepOption,
  FridayGuidedStep,

  // Guided workflow entity
  FridayGuidedWorkflow,

  // Guided context (runtime state)
  FridayGuidedContextStatus,
  FridayGuidedCompletedStep,
  FridayGuidedContext,

  // Smart defaults
  FridaySmartDefaultSource,
  FridaySmartDefault,

  // User preferences
  FridayUserPreferenceCategory,
  FridayDisclosureLevel,
  FridayUserPreference,

  // Conversation context (NL → action mapping)
  FridayIntentClassificationTarget,
  FridayIntentClassification,
  FridayConversationTurn,
  FridayUixRouteTarget,
  FridayConversationContext,

  // Template execution result
  FridayTemplateExecutionOutcome,
  FridayTemplateExecutionResult,

  // Persistence row types
  FridayActionTemplateRow,
  FridayGuidedWorkflowRow,
  FridayGuidedContextRow,
  FridayUserPreferenceRow,
  FridayTemplateExecutionRow,
  FridayConversationContextRow,
  FridayUixRowMapper,
} from "./friday-uix.types.js";
