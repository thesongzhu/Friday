/**
 * Non-Builder Product UX (UIX) — Domain Model and Data Contract.
 *
 * Canonical types for the Friday UIX layer: action templates, guided
 * workflows, smart defaults, user preferences, NL conversation context,
 * and persistence schema types.
 *
 * @module uix/model
 */

// ─── Foundational Value Types (local; mirrors rules/workflow pattern) ───

/** UUID string identifier. */
export type UUID = string;

/** ISO 8601 date-time string. */
export type ISODateTime = string;

/** JSON-safe primitive value. */
export type JsonPrimitive = string | number | boolean | null;

/** Recursive JSON-safe value. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** JSON-safe object. */
export interface JsonObject {
  [key: string]: JsonValue;
}

// ─── Action Template Categories ───

/**
 * Top-level categories for organizing action templates.
 * Each category groups related templates in the template registry.
 */
export type FridayActionCategory =
  | "monitoring"
  | "reporting"
  | "integration"
  | "communication"
  | "data"
  | "management";

// ─── Action Template Execution Target ───

/** How an action template is executed when triggered. */
export type FridayActionTemplateExecutionType =
  | "skill"
  | "workflow"
  | "agent"
  | "channel";

/** Execution target: invoke a skill. */
export interface FridaySkillTarget {
  type: "skill";
  skillId: string;
}

/** Execution target: create or run a workflow. */
export interface FridayWorkflowTarget {
  type: "workflow";
  workflowId: string;
}

/** Execution target: start an agent task with a prompt template. */
export interface FridayAgentTarget {
  type: "agent";
  agentPrompt: string;
}

/** Execution target: send a message to a channel. */
export interface FridayChannelTarget {
  type: "channel";
  channelId: string;
  message: string;
}

/**
 * Discriminated union of all execution target variants.
 * Describes what the template does when the user confirms.
 */
export type FridayActionTemplateExecutionTarget =
  | FridaySkillTarget
  | FridayWorkflowTarget
  | FridayAgentTarget
  | FridayChannelTarget;

// ─── Action Template Parameter ───

/** Unified disclosure level for progressive disclosure of template parameters and user preferences. */
export type FridayDisclosureLevel = "basic" | "standard" | "advanced" | "expert";

/** Numeric rank for disclosure level comparison: `basic(0) < standard(1) < advanced(2) < expert(3)`. */
export const FRIDAY_DISCLOSURE_LEVEL_RANK: Readonly<Record<FridayDisclosureLevel, number>> = {
  basic: 0,
  standard: 1,
  advanced: 2,
  expert: 3,
};

/** Data type for a template parameter value. */
export type FridayParameterType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "multi-select"
  | "datetime"
  | "url"
  | "email";

/**
 * A single parameter definition for an action template.
 * Describes what user input is needed and how it should be presented.
 */
export interface FridayActionTemplateParameter {
  /** Parameter key (used in execution target interpolation). */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Help text shown below the input. */
  description?: string;
  /** Data type of this parameter. */
  type: FridayParameterType;
  /** Whether a value is required for execution. */
  required: boolean;
  /** Default value (used when user does not provide one). */
  defaultValue?: JsonValue;
  /** Minimum disclosure level at which this parameter is shown. */
  minDisclosureLevel: FridayDisclosureLevel;
  /** Allowed values (for "select" and "multi-select" types). */
  options?: FridayParameterOption[];
  /** Validation pattern (regex string for "string" and "url" types). */
  validationPattern?: string;
  /** Validation error message when pattern does not match. */
  validationMessage?: string;
  /** Placeholder text for the input field. */
  placeholder?: string;
  /** Sort order within the parameter list. Lower = shown first. */
  sortOrder: number;
}

/** A selectable option for "select" and "multi-select" parameter types. */
export interface FridayParameterOption {
  /** Option value (stored). */
  value: string;
  /** Human-readable label (displayed). */
  label: string;
  /** Optional description shown as a hint. */
  description?: string;
}

// ─── NL Trigger Phrase ───

/**
 * A trigger phrase for fast-path pattern matching.
 * Allows bypassing LLM classification for known phrases.
 */
export interface FridayTemplateTriggerPhrase {
  /** The pattern to match (plain text or glob-style). */
  pattern: string;
  /** Whether the match is case-sensitive. */
  caseSensitive: boolean;
  /** Parameters to extract from the matched input (regex capture groups). */
  extractionPattern?: string;
}

// ─── Action Template Entity ───

/**
 * A pre-built action template that wraps a complete automation
 * behind a one-click interface. Templates are the primary way
 * non-builder users interact with Friday.
 */
export interface FridayActionTemplate {
  /** Unique template identifier. */
  id: UUID;
  /** Human-readable name. */
  name: string;
  /** Short description shown in template listings. */
  description: string;
  /** Detailed description shown when the template is selected. */
  longDescription?: string;
  /** Icon identifier (emoji or icon name). */
  icon: string;
  /** Category for organization. */
  category: FridayActionCategory;
  /** Tags for search and filtering. */
  tags: string[];
  /** Whether this template is available for use. */
  enabled: boolean;
  /** Template version (incremented on update). */
  version: number;
  /** Parameter definitions. */
  parameters: FridayActionTemplateParameter[];
  /** Execution target. */
  executionTarget: FridayActionTemplateExecutionTarget;
  /** NL trigger phrases for fast-path pattern matching. */
  triggerPhrases: FridayTemplateTriggerPhrase[];
  /** NL intent key for LLM-based classification mapping. */
  intentKey: string;
  /**
   * Preview template string. Supports parameter interpolation.
   * Shown to the user before execution.
   * @example "Monitor {url} every {schedule} and send {format} to {channel}"
   */
  previewTemplate: string;
  /**
   * Sort priority within category. Lower number = shown first.
   * @default 100
   */
  sortPriority: number;
  /** Optimistic concurrency token. */
  etag: string;
  /** When this template was created. */
  createdAt: ISODateTime;
  /** When this template was last updated. */
  updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  deletedAt?: ISODateTime;
}

// ─── Guided Workflow Step Types ───

/** The type of user interaction for a guided workflow step. */
export type FridayGuidedStepType =
  | "input"
  | "select"
  | "multi-select"
  | "confirm"
  | "preview"
  | "info";

// ─── Guided Step Validation ───

/** Validation rule for a guided workflow step. */
export interface FridayGuidedStepValidation {
  /** Validation type. */
  type: "required" | "pattern" | "min" | "max" | "minLength" | "maxLength" | "custom";
  /** Validation value (pattern string, min/max number, or custom validator key). */
  value?: JsonValue;
  /** Error message when validation fails. */
  message: string;
}

// ─── Guided Step Option ───

/** A selectable option within a select or multi-select step. */
export interface FridayGuidedStepOption {
  /** Option value (stored). */
  value: string;
  /** Human-readable label (displayed). */
  label: string;
  /** Optional description or hint. */
  description?: string;
  /** Optional icon. */
  icon?: string;
}

// ─── Guided Workflow Step ───

/**
 * A single step in a guided workflow wizard.
 * Each step collects one piece of information from the user.
 */
export interface FridayGuidedStep {
  /** Unique step identifier within the workflow. */
  id: string;
  /** Step type (determines the UI component). */
  type: FridayGuidedStepType;
  /** Human-readable title shown at the top of the step. */
  title: string;
  /** Description or instruction text. */
  description?: string;
  /** Help text shown on demand (e.g., "?" icon). */
  helpText?: string;
  /** Placeholder text for input steps. */
  placeholder?: string;
  /** Selectable options (for "select" and "multi-select" steps). */
  options?: FridayGuidedStepOption[];
  /** Validation rules for user input. */
  validations: FridayGuidedStepValidation[];
  /** Default value for this step. */
  defaultValue?: JsonValue;
  /**
   * The data key where this step's value is stored in the context.
   * Not used for "preview" and "info" step types.
   */
  dataKey?: string;
  /**
   * Whether this step can be skipped (optional step).
   * @default false
   */
  skippable: boolean;
  /**
   * Condition for showing this step. If present, the step is only
   * shown when the condition evaluates to true against the current context.
   * Uses dot-path references to context data (e.g., "service === 'notion'").
   */
  showCondition?: string;
  /** Step position in the wizard (0-indexed). */
  sortOrder: number;
}

// ─── Guided Workflow Entity ───

/**
 * A guided workflow wizard that walks users through
 * a multi-step process to configure and execute an automation.
 */
export interface FridayGuidedWorkflow {
  /** Unique workflow wizard identifier. */
  id: UUID;
  /** Human-readable name. */
  name: string;
  /** Short description shown in wizard listings. */
  description: string;
  /** Detailed description shown when the wizard is started. */
  longDescription?: string;
  /** Icon identifier (emoji or icon name). */
  icon: string;
  /** Category for organization. */
  category: FridayActionCategory;
  /** Tags for search and filtering. */
  tags: string[];
  /** Whether this wizard is available for use. */
  enabled: boolean;
  /** Wizard version (incremented on update). */
  version: number;
  /** Ordered list of steps in this wizard. */
  steps: FridayGuidedStep[];
  /** NL intent key for LLM-based classification mapping. */
  intentKey: string;
  /** Execution target (what happens when the wizard completes). */
  executionTarget: FridayActionTemplateExecutionTarget;
  /**
   * Preview template string for the final confirmation step.
   * Supports parameter interpolation from context data.
   */
  previewTemplate: string;
  /**
   * Maximum allowed duration (in hours) for an in-progress wizard
   * before state is expired.
   * @default 24
   */
  stateTtlHours: number;
  /** Optimistic concurrency token. */
  etag: string;
  /** When this wizard was created. */
  createdAt: ISODateTime;
  /** When this wizard was last updated. */
  updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  deletedAt?: ISODateTime;
}

// ─── Guided Context (Runtime State) ───

/** Status of a guided workflow execution. */
export type FridayGuidedContextStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "expired"
  | "abandoned";

/** A completed step record within a guided context. */
export interface FridayGuidedCompletedStep {
  /** Step ID. */
  stepId: string;
  /** Data collected from this step. */
  data: JsonObject;
  /** When this step was completed. */
  completedAt: ISODateTime;
}

/**
 * Runtime state for an active guided workflow session.
 * Tracks the user's progress through the wizard steps.
 */
export interface FridayGuidedContext {
  /** Unique context identifier. */
  id: UUID;
  /** Reference to the guided workflow definition. */
  workflowId: UUID;
  /** User principal ID. */
  principalId: string;
  /** Channel ID where the wizard is active. */
  channelId: string;
  /** Current status. */
  status: FridayGuidedContextStatus;
  /** Index of the current step (0-based). */
  currentStepIndex: number;
  /** Completed steps with their collected data. */
  completedSteps: FridayGuidedCompletedStep[];
  /** Merged data from all completed steps (accumulated context). */
  sessionData: JsonObject;
  /** When this context was created (wizard started). */
  startedAt: ISODateTime;
  /** When this context was last updated. */
  updatedAt: ISODateTime;
  /** When this context expires (startedAt + stateTtlHours). */
  expiresAt: ISODateTime;
  /** When the wizard completed or was abandoned. */
  finishedAt?: ISODateTime;
}

// ─── Smart Defaults ───

/** Source that produced a smart default value. */
export type FridaySmartDefaultSource =
  | "user_input"
  | "user_preference"
  | "recent_context"
  | "template_default"
  | "system_default";

/**
 * Priority order for smart default sources.
 * Lower index = higher priority. User input always wins.
 */
export const FRIDAY_SMART_DEFAULT_PRIORITY: readonly FridaySmartDefaultSource[] = [
  "user_input",
  "user_preference",
  "recent_context",
  "template_default",
  "system_default",
] as const;

/**
 * A resolved smart default for a single parameter.
 * Includes the value and metadata about how it was determined.
 */
export interface FridaySmartDefault {
  /** Parameter key this default applies to. */
  parameterKey: string;
  /** The resolved default value. */
  value: JsonValue;
  /** The source that provided this value. */
  source: FridaySmartDefaultSource;
  /** Confidence score (0.0–1.0). Higher = more confident this is correct. */
  confidence: number;
  /** Human-readable explanation of why this default was chosen. */
  reason?: string;
}

// ─── User Preferences ───

/** Category for organizing user preferences. */
export type FridayUserPreferenceCategory =
  | "notification"
  | "scheduling"
  | "formatting"
  | "disclosure"
  | "provider"
  | "communication";

/**
 * A single user preference entry.
 * Preferences persist across sessions and influence smart defaults.
 */
export interface FridayUserPreference {
  /** Unique preference identifier. */
  id: UUID;
  /** User principal ID. */
  principalId: string;
  /** Preference category. */
  category: FridayUserPreferenceCategory;
  /** Preference key (unique within principal + category). */
  key: string;
  /** Preference value. */
  value: JsonValue;
  /**
   * Whether this preference was set explicitly by the user
   * or learned implicitly from usage patterns.
   */
  source: "explicit" | "implicit";
  /** Confidence for implicit preferences (1.0 for explicit). */
  confidence: number;
  /** When this preference was created. */
  createdAt: ISODateTime;
  /** When this preference was last updated. */
  updatedAt: ISODateTime;
}

// ─── Conversation Context (NL → Action Mapping) ───

/** Discriminated union for what the intent classifier resolved to. */
export type FridayIntentClassificationTarget =
  | { type: "template"; templateId: string }
  | { type: "workflow"; workflowId: string }
  | { type: "ambiguous"; templateIds: string[]; workflowIds: string[] };

/**
 * Classification result from the NL intent mapper.
 * Represents the system's understanding of what the user wants.
 */
export interface FridayIntentClassification {
  /** The classified intent key (e.g., "schedule.monitoring"). */
  intentKey: string;
  /** Confidence score (0.0–1.0). */
  confidence: number;
  /** Extracted parameters from the NL input. */
  extractedParameters: JsonObject;
  /** Resolved classification target. */
  target: FridayIntentClassificationTarget;
  /** Classification source. */
  source: "pattern_match" | "llm" | "direct";
}

/**
 * A single turn in the conversation history.
 */
export interface FridayConversationTurn {
  /** Turn identifier. */
  id: UUID;
  /** The user's raw input. */
  userInput: string;
  /** The intent classification for this turn. */
  classification?: FridayIntentClassification;
  /** The system's response summary. */
  responseAction: string;
  /** When this turn occurred. */
  timestamp: ISODateTime;
}

/** The routing decision for how to handle user input. */
export type FridayUixRouteTarget =
  | "template"
  | "wizard"
  | "agent_freeform"
  | "disambiguate";

/**
 * Per-session conversation context for the UIX layer.
 * Tracks recent intents, extracted parameters, and active wizard state.
 */
export interface FridayConversationContext {
  /** Unique context identifier (tied to the channel session). */
  id: UUID;
  /** User principal ID. */
  principalId: string;
  /** Channel ID. */
  channelId: string;
  /** Session ID from the session system. */
  sessionId: string;
  /** Recent conversation turns (last N turns, capped). */
  recentTurns: FridayConversationTurn[];
  /**
   * Maximum number of turns to retain in context.
   * @default 10
   */
  maxTurns: number;
  /** Active guided workflow context (if a wizard is in progress). */
  activeGuidedContextId?: UUID;
  /** Accumulated parameters from the current conversation flow. */
  accumulatedParameters: JsonObject;
  /** When this context was created. */
  createdAt: ISODateTime;
  /** When this context was last updated. */
  updatedAt: ISODateTime;
}

// ─── Template Execution Result ───

/** Outcome of executing an action template. */
export type FridayTemplateExecutionOutcome =
  | "success"
  | "failed"
  | "denied"
  | "cancelled";

/**
 * Result of executing an action template or completing a guided workflow.
 */
export interface FridayTemplateExecutionResult {
  /** Unique execution ID. */
  id: UUID;
  /** Template or wizard that was executed. */
  sourceId: UUID;
  /** Whether the source was a template or wizard. */
  sourceType: "template" | "wizard";
  /** User principal ID. */
  principalId: string;
  /** Execution outcome. */
  outcome: FridayTemplateExecutionOutcome;
  /** Parameters used for execution. */
  parameters: JsonObject;
  /** Result data (skill output, workflow ID, agent response). */
  resultData?: JsonObject;
  /** Error details if outcome is "failed" or "denied". */
  errorCode?: string;
  /** Human-readable error message. */
  errorMessage?: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** When execution started. */
  startedAt: ISODateTime;
  /** When execution completed. */
  completedAt: ISODateTime;
}

// ─── Persistence Schema Types (SQLite Row Shapes) ───

/** SQLite row shape for `uix_action_templates` table. */
export interface FridayActionTemplateRow {
  id: string;
  name: string;
  description: string;
  long_description: string | null;
  icon: string;
  category: string;
  tags_json: string;
  enabled: number;
  version: number;
  parameters_json: string;
  execution_target_json: string;
  trigger_phrases_json: string;
  intent_key: string;
  preview_template: string;
  sort_priority: number;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** SQLite row shape for `uix_guided_workflows` table. */
export interface FridayGuidedWorkflowRow {
  id: string;
  name: string;
  description: string;
  long_description: string | null;
  icon: string;
  category: string;
  tags_json: string;
  enabled: number;
  version: number;
  steps_json: string;
  intent_key: string;
  execution_target_json: string;
  preview_template: string;
  state_ttl_hours: number;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** SQLite row shape for `uix_guided_contexts` table. */
export interface FridayGuidedContextRow {
  id: string;
  workflow_id: string;
  principal_id: string;
  channel_id: string;
  status: string;
  current_step_index: number;
  completed_steps_json: string;
  session_data_json: string;
  started_at: string;
  updated_at: string;
  expires_at: string;
  finished_at: string | null;
}

/** SQLite row shape for `uix_user_preferences` table. */
export interface FridayUserPreferenceRow {
  id: string;
  principal_id: string;
  category: string;
  key: string;
  value_json: string;
  source: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

/** SQLite row shape for `uix_template_executions` table. */
export interface FridayTemplateExecutionRow {
  id: string;
  source_id: string;
  source_type: string;
  principal_id: string;
  outcome: string;
  parameters_json: string;
  result_data_json: string | null;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number;
  started_at: string;
  completed_at: string;
}

/** SQLite row shape for `uix_conversation_contexts` table. */
export interface FridayConversationContextRow {
  id: string;
  principal_id: string;
  channel_id: string;
  session_id: string;
  recent_turns_json: string;
  max_turns: number;
  active_guided_context_id: string | null;
  accumulated_parameters_json: string;
  created_at: string;
  updated_at: string;
}

// ─── Row-to-Entity Mapper Signature ───

/** Generic row-to-entity mapper function type. */
export type FridayUixRowMapper<TRow, TEntity> = (row: TRow) => TEntity;
