/**
 * Rules Engine Core — Domain Model and Data Contract.
 *
 * Canonical types for the Friday Rules Engine: rules, rule sets,
 * policy bundles, conditions, decisions, evaluation contexts/results,
 * and persistence schema types.
 *
 * @module rules/model
 */

// ─── Foundational Value Types (local; mirrors workflow pattern) ───

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

// ─── Rule Decision ───

/** The four possible outcomes of a rule evaluation. */
export type FridayRuleDecision = "allow" | "deny" | "warn" | "audit";

/**
 * Priority order for decisions when multiple rules match.
 * Lower index = higher priority. Deny always wins.
 */
export const FRIDAY_RULE_DECISION_PRIORITY: readonly FridayRuleDecision[] = [
  "deny",
  "warn",
  "audit",
  "allow",
];

// ─── Rule Resource and Action ───

/**
 * Resource categories that rules can target.
 * Superset of `PermissionResource` from the skill permission model (not an exact match).
 */
export type FridayRuleResource =
  | "filesystem"
  | "network"
  | "channel"
  | "tool"
  | "memory"
  | "device"
  | "shell"
  | "skill"
  | "workflow"
  | "agent"
  | "artifact"
  | "retry"
  | "playbook"
  | "desktop";

/**
 * Action types that rules can gate.
 * Superset of `PermissionAction` from the skill permission model (not an exact match).
 */
export type FridayRuleAction =
  | "read"
  | "write"
  | "connect"
  | "send"
  | "receive"
  | "execute"
  | "capture"
  | "create"
  | "delete"
  | "update"
  | "accept"
  | "promote"
  | "select"
  | "click"
  | "type"
  | "keypress"
  | "scroll"
  | "drag"
  | "screenshot"
  | "read_element"
  | "launch_app"
  | "close_app"
  | "clipboard"
  | "file_operation";

// ─── Rule Condition ───

/** Operators available for condition evaluation. */
export type FridayRuleConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "matches"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "not_exists";

/** Operators that test for field presence only (no value needed). */
export type FridayRulePresenceOperator = "exists" | "not_exists";

/** Operators that compare a field against a value. */
export type FridayRuleValueOperator = Exclude<FridayRuleConditionOperator, FridayRulePresenceOperator>;

/** A condition that compares a field against a value. */
export interface FridayRuleValueCondition {
  field: string;
  operator: FridayRuleValueOperator;
  value: JsonValue;
}

/** A condition that checks field presence only. */
export interface FridayRulePresenceCondition {
  field: string;
  operator: FridayRulePresenceOperator;
  value?: never;
}

/** A single condition in a rule. Discriminated by operator type. */
export type FridayRuleCondition = FridayRuleValueCondition | FridayRulePresenceCondition;

/** Logical grouping of conditions. */
export interface FridayRuleConditionGroup {
  /** All conditions must match (AND). */
  all?: FridayRuleCondition[];
  /** At least one condition must match (OR). */
  any?: FridayRuleCondition[];
  /** No condition may match (NOT ANY). */
  none?: FridayRuleCondition[];
}

// ─── Rule Action Metadata (response metadata) ───

/** Action metadata attached to an evaluation result. */
export interface FridayRuleActionMeta {
  /** Human-readable message explaining the decision. */
  message?: string;
  /** Optional structured metadata for the decision. */
  metadata?: JsonObject;
}

// ─── Rule Entity (domain shape) ───

/** A single rule within a policy bundle. */
export interface FridayRule {
  /** Unique rule identifier. */
  id: UUID;
  /** Parent policy bundle ID. */
  policyBundleId: UUID;
  /** Human-readable rule name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Whether this rule is actively evaluated. */
  enabled: boolean;
  /** Resource category this rule applies to. */
  resource: FridayRuleResource;
  /** Action this rule gates. */
  action: FridayRuleAction;
  /** Conditions that must be met for this rule to match. */
  conditions: FridayRuleConditionGroup;
  /** Decision to return when the rule matches. */
  decision: FridayRuleDecision;
  /** Message returned with the decision. */
  message?: string;
  /**
   * Rule priority within its bundle. Lower number = higher priority.
   * @default 100
   */
  priority: number;
  /** Rule version (incremented on update). */
  version: number;
  /** Optimistic concurrency token. */
  etag: string;
  /** When this rule was created. */
  createdAt: ISODateTime;
  /** When this rule was last updated. */
  updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  deletedAt?: ISODateTime;
}

// ─── Rule Set ───

/**
 * A logical grouping of rules that share evaluation context.
 * Used for organizing rules by domain (e.g., "agent-safety", "workflow-limits").
 */
export interface FridayRuleSet {
  /** Unique identifier. */
  id: UUID;
  /** Human-readable name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Rule IDs belonging to this set. */
  ruleIds: UUID[];
  /** Tags for filtering. */
  tags: string[];
  /** When this rule set was created. */
  createdAt: ISODateTime;
  /** When this rule set was last updated. */
  updatedAt: ISODateTime;
}

// ─── Policy Bundle Entity (domain shape) ───

/** The source of a policy bundle (how it was created). */
export type FridayPolicyBundleSource = "user" | "system" | "import";

/** Supported policy bundle signature algorithms. */
export type FridayPolicyBundleSignatureAlgorithm = "hmac-sha256";

/** Signature metadata used to verify policy bundle integrity/authenticity. */
export interface FridayPolicyBundleSignature {
  /** Algorithm used to compute the signature. */
  algorithm: FridayPolicyBundleSignatureAlgorithm;
  /** Secret/key identifier used for verification lookup. */
  keyId: string;
  /** Signature value (hex-encoded HMAC digest). */
  value: string;
}

/** A policy bundle groups related rules under a single versioned unit. */
export interface FridayPolicyBundle {
  /** Unique bundle identifier. */
  id: UUID;
  /** Human-readable name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Bundle version (incremented on update). */
  version: number;
  /**
   * Bundle priority. Lower number = higher priority.
   * Rules in higher-priority bundles are evaluated first.
   * @default 100
   */
  priority: number;
  /** Whether this bundle is active. */
  enabled: boolean;
  /** Tags for filtering and organization. */
  tags: string[];
  /** How this bundle was created. */
  source: FridayPolicyBundleSource;
  /** Optional signature metadata for integrity/authenticity checks. */
  signature?: FridayPolicyBundleSignature;
  /** Optimistic concurrency token. */
  etag: string;
  /** When this bundle was created. */
  createdAt: ISODateTime;
  /** When this bundle was last updated. */
  updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  deletedAt?: ISODateTime;
}

// ─── Evaluation Context ───

/** Source system that triggered the evaluation. */
export type FridayEvaluationSource = "agent" | "workflow" | "api" | "system";

/**
 * Context provided to the rules engine for evaluation.
 * Built by the calling runtime (agent, workflow, etc.) before each gated action.
 */
export interface FridayEvaluationContext {
  /** Resource category being accessed. */
  resource: FridayRuleResource;
  /** Action being performed. */
  action: FridayRuleAction;
  /** Arguments/parameters of the action (tool args, skill input, etc.). */
  args: JsonObject;
  /** Source system that triggered the evaluation. */
  source: FridayEvaluationSource;
  /** Principal performing the action (user, agent, satellite). */
  principalId?: string;
  /** Current agent run ID (if source is "agent"). */
  runId?: UUID;
  /** Current workflow ID (if source is "workflow"). */
  workflowId?: UUID;
  /** Current workflow run ID (if source is "workflow"). */
  workflowRunId?: UUID;
  /** Current workflow node ID (if source is "workflow"). */
  nodeId?: string;
  /** Session ID for the current execution context. */
  sessionId?: string;
  /** Authorization scopes granted to the caller. */
  scopes?: string[];
  /** Additional metadata for custom condition evaluation. */
  metadata?: JsonObject;
  /** Evaluate only rules from these policy bundles when provided. */
  policyBundleIds?: string[];
}

// ─── Context Redaction Rules ───

/** Configurable redaction rules for audit/log context output. */
export interface ContextRedactionRules {
  /** Case-insensitive exact key names to redact. */
  sensitiveKeys?: string[];
  /** Case-insensitive regex patterns (as source strings) used to redact matching keys. */
  sensitiveKeyPatterns?: string[];
  /** Exact field paths to redact (e.g., "headers.authorization", "args.token"). */
  sensitivePaths?: string[];
  /** Replacement value used for redacted fields. */
  replacement?: string;
  /** Max length for non-redacted string values before truncation. */
  maxStringLength?: number;
}

// ─── Evaluation Result ───

/** A reference to a rule that was matched during evaluation. */
export interface FridayMatchedRule {
  /** Rule ID. */
  ruleId: UUID;
  /** Rule name. */
  ruleName: string;
  /** Policy bundle ID containing the rule. */
  policyBundleId: UUID;
  /** Decision from the matched rule. */
  decision: FridayRuleDecision;
  /** Message from the matched rule. */
  message?: string;
  /** Rule priority. */
  priority: number;
}

/** Internal evaluation state labels for transition tracing. */
export type FridayEvaluationTransitionState =
  | "init"
  | "match"
  | "decide"
  | "audit"
  | "rollback"
  | "done";

/** Reason metadata for non-happy-path transitions. */
export type FridayEvaluationTransitionReason =
  | "pre_hook_failure"
  | "post_hook_failure"
  | "audit_sink_failure";

/** A single state transition emitted by the rule engine. */
export interface FridayEvaluationTransition {
  /** Prior state. */
  from: FridayEvaluationTransitionState;
  /** Next state. */
  to: FridayEvaluationTransitionState;
  /** Transition timestamp. */
  at: ISODateTime;
  /** Optional reason for rollback/error transitions. */
  reason?: FridayEvaluationTransitionReason;
}

/** Structured deny/error codes returned by evaluation. */
export type FridayEvaluationErrorCode = "INSUFFICIENT_SCOPE" | "RULE_DENIED";

/** Structured deny/error metadata for evaluation responses. */
export interface FridayEvaluationError {
  /** Stable machine-readable error code. */
  code: FridayEvaluationErrorCode;
  /** Human-readable message describing the denial reason. */
  message: string;
  /** Audit reference ID that correlates with the emitted audit entry. */
  auditReferenceId: UUID;
}

/** Result of evaluating a context against all active rules. */
export interface FridayEvaluationResult {
  /** Unique evaluation ID for audit correlation. */
  evaluationId: UUID;
  /** Final decision (highest-priority decision from matched rules). */
  decision: FridayRuleDecision;
  /** All rules that matched the context (full-scan semantics). */
  matchedRules: FridayMatchedRule[];
  /** Message from the highest-priority matched rule (if any). */
  message?: string;
  /** Evaluation duration in milliseconds. */
  durationMs: number;
  /** Whether execution should proceed (true for allow/warn/audit, false for deny). */
  allowed: boolean;
  /** Timestamp of the evaluation. */
  evaluatedAt: ISODateTime;
  /** Optional structured deny/error details. */
  error?: FridayEvaluationError;
  /** Optional transition trace (present when enabled at evaluation time). */
  transitionTrace?: FridayEvaluationTransition[];
}

// ─── Rule Version ───

/** A historical version snapshot of a rule. */
export interface FridayRuleVersion {
  /** Unique version record ID. */
  id: UUID;
  /** Rule ID this version belongs to. */
  ruleId: UUID;
  /** Version number. */
  version: number;
  /** Snapshot of the rule at this version (serialized). */
  snapshot: JsonObject;
  /** Who made this change. */
  changedBy?: string;
  /** Change description. */
  changeNote?: string;
  /** When this version was created. */
  createdAt: ISODateTime;
}

// ─── Persistence Schema Types (SQLite Row Shapes) ───

/** SQLite row shape for `rule_policy_bundles` table. */
export interface FridayPolicyBundleRow {
  id: string;
  name: string;
  description: string | null;
  version: number;
  priority: number;
  enabled: number;
  tags_json: string;
  source: string;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** SQLite row shape for `rules` table. */
export interface FridayRuleRow {
  id: string;
  policy_bundle_id: string;
  name: string;
  description: string | null;
  enabled: number;
  resource: string;
  action: string;
  conditions_json: string;
  decision: string;
  message: string | null;
  priority: number;
  version: number;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** SQLite row shape for `rule_evaluation_log` table. */
export interface FridayRuleEvaluationLogRow {
  id: string;
  rule_id: string | null;
  policy_bundle_id: string | null;
  decision: string;
  resource: string;
  action: string;
  context_redacted_json: string;
  redaction_applied: number;
  redacted_fields_json: string;
  matched_rules_json: string;
  duration_ms: number;
  run_id: string | null;
  workflow_id: string | null;
  principal_id: string | null;
  created_at: string;
}

/** SQLite row shape for `rule_versions` table. */
export interface FridayRuleVersionRow {
  id: string;
  rule_id: string;
  version: number;
  snapshot_json: string;
  changed_by: string | null;
  change_note: string | null;
  created_at: string;
}

// ─── Row-to-Entity Mapper Signature ───

/** Generic row-to-entity mapper function type. */
export type FridayRowMapper<TRow, TEntity> = (row: TRow) => TEntity;

// ─── Policy Bundle YAML Schema (parsed from YAML DSL) ───

/** API version for the YAML policy bundle format. */
export type FridayPolicyBundleApiVersion = "friday/rules/v1";

/** Top-level kind for a YAML policy bundle document. */
export type FridayPolicyBundleKind = "PolicyBundle";

/** Metadata section of a YAML policy bundle. */
export interface FridayPolicyBundleYamlMetadata {
  /** Bundle identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Bundle version number. */
  version: number;
  /**
   * Bundle priority. Lower number = higher priority.
   * @default 100
   */
  priority?: number;
  /** Whether the bundle is enabled. */
  enabled?: boolean;
  /** Tags for filtering. */
  tags?: string[];
  /** Optional signature metadata for bundle verification. */
  signature?: FridayPolicyBundleSignature;
}

/** A rule definition within a YAML policy bundle. */
export interface FridayPolicyBundleYamlRule {
  /** Rule identifier (unique within the bundle). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Whether the rule is enabled. */
  enabled?: boolean;
  /** Resource category. */
  resource: FridayRuleResource;
  /** Action being gated. */
  action: FridayRuleAction;
  /** Condition groups. */
  conditions?: FridayRuleConditionGroup;
  /** Decision to return when matched. */
  decision: FridayRuleDecision;
  /** Message to include in the evaluation result. */
  message?: string;
  /** Rule priority within the bundle. */
  priority?: number;
}

/** Parsed YAML policy bundle document. */
export interface FridayPolicyBundleYaml {
  /** API version string. */
  apiVersion: FridayPolicyBundleApiVersion;
  /** Document kind. */
  kind: FridayPolicyBundleKind;
  /** Bundle metadata. */
  metadata: FridayPolicyBundleYamlMetadata;
  /** Rule definitions. */
  rules: FridayPolicyBundleYamlRule[];
}

// ─── Engine Hook Types ───

/** Phase of evaluation for hooks. */
export type FridayRuleHookPhase = "pre" | "post";

/** Hook registration entry. */
export interface FridayRuleHookRegistration {
  /** Source system this hook applies to. */
  source: FridayEvaluationSource;
  /** Evaluation phase. */
  phase: FridayRuleHookPhase;
  /** Hook callback. */
  handler: FridayRuleHookHandler;
}

/**
 * Hook handler function signature.
 * Called before or after rule evaluation. May enrich the context
 * or perform side effects (logging, metrics).
 */
export type FridayRuleHookHandler = (
  context: FridayEvaluationContext,
  result?: FridayEvaluationResult,
) => void | Promise<void>;
