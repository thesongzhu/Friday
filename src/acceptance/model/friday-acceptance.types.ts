/**
 * Acceptance Testing Layer — Domain Model and Data Contract.
 *
 * Canonical types for the Friday Acceptance Testing Layer: acceptance tests,
 * test registry, checks, verdicts, evidence, artifact types, and persistence
 * schema types.
 *
 * @module acceptance/model
 */

import type {
  FridayEvaluationResult,
  ISODateTime,
  JsonObject,
  JsonValue,
  UUID,
} from "../../rules/model/friday-rules-engine.types.js";

import type { FridayNodeArtifact } from "../../node-runner/model/friday-node-runner.types.js";

// ─── Artifact Types ───

/**
 * Artifact types that can be tested by the acceptance layer.
 * Mirrors `FridayNodeArtifact.artifactType` from the NodeRunner.
 */
export type FridayAcceptanceArtifactType =
  | "json"
  | "text"
  | "file"
  | "image"
  | "audio"
  | "video";

// ─── Check Types ───

/** Discriminator for the four built-in check types. */
export type FridayAcceptanceCheckType =
  | "schema"
  | "quantitative"
  | "quality"
  | "custom";

// ─── Check Configuration (per check type) ───

/**
 * Configuration for a schema check.
 * Validates artifact content against a JSON Schema (draft 2020-12).
 */
export interface FridayAcceptanceSchemaCheckConfig {
  /** The check type discriminator. */
  checkType: "schema";
  /** JSON Schema to validate against. */
  schema: JsonObject;
  /**
   * If true, treat validation warnings as failures.
   * @default false
   */
  strict?: boolean;
}

/**
 * Comparison operators for quantitative checks.
 */
export type FridayAcceptanceQuantOperator =
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "eq"
  | "between";

/** Operators that compare against a single threshold. */
export type FridayAcceptanceQuantSingleBoundOperator = Exclude<FridayAcceptanceQuantOperator, "between">;

/** Base fields shared by all quantitative check configs. */
interface FridayAcceptanceQuantCheckConfigBase {
  /** Check type discriminator. */
  checkType: "quantitative";
  /** JSON path to the metric value in the artifact. */
  metricPath: string;
  /** Optional warning threshold. */
  warnThreshold?: number;
}

/** Quantitative check with a single threshold (gt, gte, lt, lte, eq). */
export interface FridayAcceptanceQuantSingleBoundCheckConfig extends FridayAcceptanceQuantCheckConfigBase {
  /** Comparison operator. */
  operator: FridayAcceptanceQuantSingleBoundOperator;
  /** Threshold to compare against. */
  threshold: number;
  lowerBound?: never;
  upperBound?: never;
}

/** Quantitative check with a range (between). */
export interface FridayAcceptanceQuantBetweenCheckConfig extends FridayAcceptanceQuantCheckConfigBase {
  /** Range operator. */
  operator: "between";
  /** Lower bound of acceptable range. */
  lowerBound: number;
  /** Upper bound of acceptable range. */
  upperBound: number;
  threshold?: never;
}

/** Quantitative check configuration (discriminated by operator). */
export type FridayAcceptanceQuantCheckConfig =
  | FridayAcceptanceQuantSingleBoundCheckConfig
  | FridayAcceptanceQuantBetweenCheckConfig;

/**
 * Quality dimensions supported by v1 quality checks.
 */
export type FridayAcceptanceQualityDimension =
  | "completeness"
  | "consistency"
  | "validity"
  | "readability";

/**
 * Configuration for a quality check.
 * Runs deterministic quality heuristics against the artifact.
 */
export interface FridayAcceptanceQualityCheckConfig {
  /** The check type discriminator. */
  checkType: "quality";
  /** Quality dimension to evaluate. */
  dimension: FridayAcceptanceQualityDimension;
  /**
   * Minimum acceptable score (0–100).
   * Artifacts scoring below this fail.
   */
  minScore: number;
  /**
   * Optional warn threshold (0–100).
   * Artifacts scoring between warnScore and minScore receive a `warn` verdict.
   */
  warnScore?: number;
}

/**
 * Configuration for a custom check.
 * References a user-defined or plugin-provided handler.
 */
export interface FridayAcceptanceCustomCheckConfig {
  /** The check type discriminator. */
  checkType: "custom";
  /** Unique handler identifier (e.g., plugin name or function reference key). */
  handlerRef: string;
  /** Arbitrary handler configuration. */
  handlerConfig?: JsonObject;
}

/**
 * Union of all check configurations, discriminated by `checkType`.
 */
export type FridayAcceptanceCheckConfig =
  | FridayAcceptanceSchemaCheckConfig
  | FridayAcceptanceQuantCheckConfig
  | FridayAcceptanceQualityCheckConfig
  | FridayAcceptanceCustomCheckConfig;

// ─── Verdict ───

/** The three possible outcomes of an acceptance check. */
export type FridayAcceptanceVerdictOutcome = "pass" | "fail" | "warn";

/**
 * Priority order for verdicts when aggregating.
 * Lower index = higher priority. Fail always wins.
 */
export const FRIDAY_ACCEPTANCE_VERDICT_PRIORITY: readonly FridayAcceptanceVerdictOutcome[] = [
  "fail",
  "warn",
  "pass",
] as const;

/** Severity levels for acceptance verdicts. */
export type FridayAcceptanceSeverity =
  | "critical"
  | "major"
  | "minor"
  | "info";

/**
 * Priority order for severity when aggregating.
 * Lower index = higher priority. Critical always wins.
 */
export const FRIDAY_ACCEPTANCE_SEVERITY_PRIORITY: readonly FridayAcceptanceSeverity[] = [
  "critical",
  "major",
  "minor",
  "info",
] as const;

// ─── Evidence ───

/**
 * A single piece of evidence produced by an acceptance check.
 * Provides structured detail about why a check passed, failed, or warned.
 */
export interface FridayAcceptanceEvidence {
  /** Which check produced this evidence. */
  checkId: UUID;
  /** Check type that produced this evidence. */
  checkType: FridayAcceptanceCheckType;
  /** Human-readable explanation. */
  message: string;
  /** What the check expected (threshold, schema summary, score target). */
  expected?: JsonValue;
  /** What the artifact actually produced (value, errors, score). */
  actual?: JsonValue;
  /** Rules Engine evaluation result (present for rule-linked checks). */
  ruleEvaluationResult?: FridayEvaluationResult;
  /** Arbitrary structured metadata for debugging. */
  metadata?: JsonObject;
}

/**
 * Verdict produced by a single acceptance check execution.
 */
export interface FridayAcceptanceVerdict {
  /** Outcome of the check. */
  verdict: FridayAcceptanceVerdictOutcome;
  /** Severity of the finding. */
  severity: FridayAcceptanceSeverity;
  /** Evidence chain supporting the verdict. */
  evidence: FridayAcceptanceEvidence[];
}

// ─── Acceptance Check ───

/** Check execution status. */
export type FridayAcceptanceCheckStatus = "executed" | "skipped";

// ─── Run State Machine ───

/** Lifecycle states for an acceptance run. */
export enum AcceptanceRunState {
  Pending = "pending",
  Running = "running",
  Passed = "passed",
  Failed = "failed",
  RolledBack = "rolled_back",
}

/** Allowed transitions for the acceptance run state machine. */
export const ACCEPTANCE_RUN_STATE_TRANSITIONS: Readonly<Record<AcceptanceRunState, readonly AcceptanceRunState[]>> = {
  [AcceptanceRunState.Pending]: [AcceptanceRunState.Running],
  [AcceptanceRunState.Running]: [AcceptanceRunState.Passed, AcceptanceRunState.Failed],
  [AcceptanceRunState.Passed]: [],
  [AcceptanceRunState.Failed]: [AcceptanceRunState.RolledBack],
  [AcceptanceRunState.RolledBack]: [],
} as const;

/** Reason labels emitted with acceptance run transitions. */
export type AcceptanceRunTransitionReason =
  | "started"
  | "checks_passed"
  | "checks_failed"
  | "mandatory_gate_missing"
  | "content_resolution_failed"
  | "rollback_emitted";

/** A single validated state transition in an acceptance run. */
export interface FridayAcceptanceRunStateTransition {
  from: AcceptanceRunState;
  to: AcceptanceRunState;
  at: ISODateTime;
  reason?: AcceptanceRunTransitionReason;
}

/** Rollback event emitted for failed acceptance runs. */
export interface FridayAcceptanceRollbackEvent {
  eventId: UUID;
  runId: UUID;
  executionId: UUID;
  artifactUri: string;
  artifactType: FridayAcceptanceArtifactType;
  reason: string;
  failedCheckIds: UUID[];
  emittedAt: ISODateTime;
}

/** Return true when a state transition is valid. */
export function canTransitionAcceptanceRunState(
  from: AcceptanceRunState,
  to: AcceptanceRunState,
): boolean {
  return ACCEPTANCE_RUN_STATE_TRANSITIONS[from].includes(to);
}

/**
 * Validate a run-state transition and throw on invalid state changes.
 */
export function assertAcceptanceRunStateTransition(
  from: AcceptanceRunState,
  to: AcceptanceRunState,
): void {
  if (!canTransitionAcceptanceRunState(from, to)) {
    throw new Error(`Invalid acceptance run state transition: ${from} -> ${to}`);
  }
}

/** A check that was executed and produced a verdict. */
export interface FridayExecutedAcceptanceCheck {
  /** Unique check result identifier. */
  id: string;
  /** Parent acceptance run identifier. */
  runId: string;
  /** The acceptance test that was run. */
  testId: string;
  /** Check type that was executed. */
  checkType: FridayAcceptanceCheckType;
  /** Execution status. */
  status: "executed";
  /** The verdict produced by this check. */
  verdict: FridayAcceptanceVerdictOutcome;
  /** Severity of the verdict. */
  severity: FridayAcceptanceSeverity;
  /** Evidence collected during this check. */
  evidence: FridayAcceptanceEvidence[];
  /** Rules Engine evaluation ID if rule-linked. */
  ruleEvaluationId?: string;
  /** Rules Engine evaluation IDs if multiple rule-linked evaluations were attached. */
  ruleEvaluationIds?: string[];
  /** Check execution duration in milliseconds. */
  durationMs: number;
  /** When this check was executed. */
  createdAt: string;
}

/** A check that was skipped due to short-circuit or precondition. */
export interface FridaySkippedAcceptanceCheck {
  /** Unique check result identifier. */
  id: string;
  /** Parent acceptance run identifier. */
  runId: string;
  /** The acceptance test that was skipped. */
  testId: string;
  /** Check type that was skipped. */
  checkType: FridayAcceptanceCheckType;
  /** Execution status. */
  status: "skipped";
  /** Reason the check was skipped. */
  skipReason?: string;
  /** When this check was recorded. */
  createdAt: string;
}

/** A single acceptance check result (discriminated by status). */
export type FridayAcceptanceCheck = FridayExecutedAcceptanceCheck | FridaySkippedAcceptanceCheck;

// ─── Acceptance Test ───

/**
 * A registered acceptance test definition.
 * Defines what check to run, against which artifact type, and how.
 */
export interface FridayAcceptanceTest {
  /** Unique test identifier. */
  id: UUID;
  /** Human-readable test name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Target artifact type. */
  artifactType: FridayAcceptanceArtifactType;
  /** Check type and configuration. */
  checkConfig: FridayAcceptanceCheckConfig;
  /**
   * Execution priority within its artifact type. Lower number = runs first.
   * @default 100
   */
  priority: number;
  /** Whether this test is actively evaluated. */
  enabled: boolean;
  /**
   * If true, stop testing this artifact after this check fails.
   * @default false
   */
  shortCircuit: boolean;
  /**
   * Optional Rules Engine policy bundle ID for rule-linked checks.
   * Forwarded to Rules evaluation scope via policyBundleId request field / context.policyBundleIds.
   */
  rulePolicyBundleId?: UUID;
  /** Tags for filtering and organization. */
  tags: string[];
  /** Test version (incremented on update). */
  version: number;
  /** Optimistic concurrency token. */
  etag: string;
  /** When this test was created. */
  createdAt: ISODateTime;
  /** When this test was last updated. */
  updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  deletedAt?: ISODateTime;
}

// ─── Acceptance Test Registry ───

/**
 * Registry that maps artifact types to their acceptance tests.
 * In-memory for fast lookups, backed by persistence.
 */
export interface FridayAcceptanceTestRegistry {
  /**
   * Register an acceptance test. Rejects duplicate test IDs
   * within the same artifact type.
   *
   * @param test - Acceptance test to register.
   */
  register(test: FridayAcceptanceTest): void;

  /**
   * Unregister an acceptance test by ID.
   *
   * @param testId - Test ID to remove.
   * @returns `true` if the test was found and removed.
   */
  unregister(testId: UUID): boolean;

  /**
   * Get all enabled tests for an artifact type, ordered by priority.
   *
   * @param artifactType - Artifact type to look up.
   * @returns Ordered array of enabled acceptance tests.
   */
  getTests(artifactType: FridayAcceptanceArtifactType): FridayAcceptanceTest[];

  /**
   * Get a single test by ID.
   *
   * @param testId - Test ID to look up.
   * @returns The test, or `undefined` if not found.
   */
  getById(testId: UUID): FridayAcceptanceTest | undefined;

  /**
   * List all registered artifact types that have at least one test.
   *
   * @returns Array of artifact types with registered tests.
   */
  listArtifactTypes(): FridayAcceptanceArtifactType[];
}

// ─── Acceptance Run ───

/**
 * Result of running all acceptance tests against a single artifact.
 * Aggregates per-check verdicts into an overall verdict.
 */
export interface FridayAcceptanceRunResult {
  /** Unique acceptance run ID. */
  id: UUID;
  /** NodeRunner execution ID (parent context). */
  executionId: UUID;
  /** URI of the artifact being tested. */
  artifactUri: string;
  /** Artifact type. */
  artifactType: FridayAcceptanceArtifactType;
  /** Aggregated overall verdict (worst-verdict-wins). */
  overallVerdict: FridayAcceptanceVerdictOutcome;
  /** Worst severity across all checks. */
  overallSeverity: FridayAcceptanceSeverity;
  /** Final lifecycle state after transition validation. */
  state: AcceptanceRunState;
  /** Transition history for this run. */
  stateTransitions: FridayAcceptanceRunStateTransition[];
  /** Rollback event emitted for failed runs. */
  rollbackEvent?: FridayAcceptanceRollbackEvent;
  /** Per-check results. */
  checks: FridayAcceptanceCheck[];
  /** Total checks that were executed. */
  checksTotal: number;
  /** Checks that passed. */
  checksPassed: number;
  /** Checks that failed. */
  checksFailed: number;
  /** Checks that warned. */
  checksWarned: number;
  /** Checks that were skipped (short-circuit). */
  checksSkipped: number;
  /** Total acceptance run duration in milliseconds. */
  durationMs: number;
  /** When this run was created. */
  createdAt: ISODateTime;
}

// ─── Acceptance Pipeline Context ───

/**
 * Input context for the acceptance testing sub-step.
 * Built by the NodeRunner post-validate step.
 */
export interface FridayAcceptancePipelineContext {
  /** NodeRunner execution ID. */
  executionId: UUID;
  /** Parent workflow run ID. */
  runId: UUID;
  /** Parent workflow definition ID. */
  workflowId: UUID;
  /** Node ID within the workflow graph. */
  nodeId: string;
  /** Validated output from the post-validate step. */
  validatedOutput: JsonValue;
  /** Artifacts produced during execution. */
  artifacts: FridayNodeArtifact[];
  /** Abort signal for cancellation / timeout. */
  signal?: AbortSignal;
  /** Extensible metadata bag. */
  metadata?: JsonObject;
}

/**
 * Output result of the acceptance testing sub-step.
 * Returned to the NodeRunner post-validate step.
 */
export interface FridayAcceptancePipelineResult {
  /** Whether all artifacts passed acceptance. */
  passed: boolean;
  /** Per-artifact run results. */
  runs: FridayAcceptanceRunResult[];
  /** Total acceptance duration in milliseconds. */
  durationMs: number;
}

// ─── Persistence Row Types (SQLite) ───

/** SQLite row shape for the `acceptance_tests` table. */
export interface FridayAcceptanceTestRow {
  id: string;
  name: string;
  description: string | null;
  artifact_type: string;
  check_type: string;
  config_json: string;
  priority: number;
  enabled: number;
  short_circuit: number;
  rule_policy_bundle_id: string | null;
  tags_json: string;
  version: number;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** SQLite row shape for the `acceptance_runs` table. */
export interface FridayAcceptanceRunRow {
  id: string;
  execution_id: string;
  artifact_uri: string;
  artifact_type: string;
  overall_verdict: string;
  overall_severity: string;
  state: string;
  checks_total: number;
  checks_passed: number;
  checks_failed: number;
  checks_warned: number;
  checks_skipped: number;
  duration_ms: number;
  result_json: string;
  artifact_json: string;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

/** Historical snapshot row for the `acceptance_test_versions` table. */
export interface FridayAcceptanceTestVersionRow {
  id: string;
  test_id: string;
  version: number;
  snapshot_json: string;
  changed_by: string | null;
  change_note: string | null;
  created_at: string;
}

/** Historical snapshot of an acceptance test definition. */
export interface FridayAcceptanceTestVersion {
  id: UUID;
  testId: UUID;
  version: number;
  snapshot: FridayAcceptanceTest;
  changedBy?: string;
  changeNote?: string;
  createdAt: ISODateTime;
}

/** SQLite row shape for the `acceptance_check_results` table. */
export interface FridayAcceptanceCheckResultRow {
  id: string;
  run_id: string;
  test_id: string;
  check_type: string;
  status: string;
  verdict: string | null;
  severity: string | null;
  evidence_json: string | null;
  duration_ms: number;
  rule_evaluation_id: string | null;
  created_at: string;
}
