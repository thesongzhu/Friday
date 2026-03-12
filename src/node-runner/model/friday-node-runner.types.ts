/**
 * NodeRunner Execution Framework — Domain Model and Data Contract.
 *
 * Canonical types for the Friday NodeRunner: the 6-step execution pipeline,
 * execution context, node adapters, state machine, validation results,
 * and persistence schema types.
 *
 * @module node-runner/model
 */

import type {
  FridayEvaluationContext,
  FridayEvaluationResult,
  ISODateTime,
  JsonObject,
  JsonValue,
  UUID,
} from "../../rules/model/friday-rules-engine.types.js";

import type { FridayWorkflowNode } from "../../workflows/model/friday-workflow-graph.types.js";

// ─── Error Codes ───

/** Canonical error codes for node runner failures. */
export type FridayNodeRunnerErrorCode =
  | "NODE_NOT_FOUND"
  | "NODE_ADAPTER_NOT_FOUND"
  | "NODE_LOAD_FAILED"
  | "NODE_EXECUTION_FAILED"
  | "NODE_EXECUTION_TIMEOUT"
  | "NODE_TIMEOUT"
  | "NODE_VALIDATION_FAILED"
  | "NODE_PRE_RULES_DENIED"
  | "NODE_POST_RULES_DENIED"
  | "NODE_CANCELLED"
  | "NODE_DEPENDENCY_FAILED"
  | "NODE_INPUT_SCHEMA_INVALID"
  | "NODE_OUTPUT_SCHEMA_INVALID"
  | "NODE_INTERNAL_ERROR"
  | "PRE_RULES_DENIED"
  | "POST_RULES_DENIED"
  | "RULE_EVALUATION_FAILED"
  | "VALIDATION_FAILED"
  | "EXECUTION_NOT_FOUND"
  | "ACCEPTANCE_FAILED"
  | "EXECUTION_NOT_CANCELLABLE";

// ─── Pipeline Step Identifiers ───

/**
 * The six ordered steps in the NodeRunner pipeline.
 * Every execution traverses these in sequence; no step is skipped or reordered.
 */
export type FridayNodeRunnerStepName =
  | "load"
  | "pre-validate"
  | "pre-rules"
  | "execute"
  | "post-validate"
  | "post-rules";

/**
 * Ordered array of pipeline steps for iteration and state-machine enforcement.
 */
export const FRIDAY_NODE_RUNNER_STEP_ORDER: readonly FridayNodeRunnerStepName[] = [
  "load",
  "pre-validate",
  "pre-rules",
  "execute",
  "post-validate",
  "post-rules",
] as const;

// ─── Execution Status (State Machine) ───

/**
 * Status values for a node execution.
 * Each maps to a position in the 6-step pipeline or a terminal state.
 */
export type FridayNodeExecutionStatus =
  | "loading"
  | "validating"
  | "checking-rules"
  | "executing"
  | "post-validating"
  | "post-rules"
  | "completed"
  | "failed"
  | "timed-out"
  | "cancelled";

/**
 * A single valid state transition in the execution state machine.
 */
export interface FridayNodeRunnerStateTransition {
  /** Source state. */
  readonly from: FridayNodeExecutionStatus;
  /** Target state. */
  readonly to: FridayNodeExecutionStatus;
  /** Human-readable trigger description. */
  readonly trigger: string;
}

/**
 * Complete set of valid state transitions.
 * The runner enforces that only these transitions occur.
 */
export const FRIDAY_NODE_RUNNER_TRANSITIONS: readonly FridayNodeRunnerStateTransition[] = [
  { from: "loading", to: "validating", trigger: "load_success" },
  { from: "loading", to: "failed", trigger: "load_error" },
  { from: "loading", to: "timed-out", trigger: "load_timeout" },
  { from: "loading", to: "cancelled", trigger: "load_cancelled" },
  { from: "validating", to: "checking-rules", trigger: "validation_passed" },
  { from: "validating", to: "failed", trigger: "validation_failed" },
  { from: "validating", to: "timed-out", trigger: "validation_timeout" },
  { from: "validating", to: "cancelled", trigger: "validation_cancelled" },
  { from: "checking-rules", to: "executing", trigger: "rules_allowed" },
  { from: "checking-rules", to: "failed", trigger: "rules_denied" },
  { from: "checking-rules", to: "timed-out", trigger: "pre_rules_timeout" },
  { from: "checking-rules", to: "cancelled", trigger: "pre_rules_cancelled" },
  { from: "executing", to: "post-validating", trigger: "execute_success" },
  { from: "executing", to: "failed", trigger: "execute_error" },
  { from: "executing", to: "timed-out", trigger: "execute_timeout" },
  { from: "executing", to: "cancelled", trigger: "execute_cancelled" },
  { from: "post-validating", to: "post-rules", trigger: "output_valid" },
  { from: "post-validating", to: "failed", trigger: "output_invalid" },
  { from: "post-validating", to: "timed-out", trigger: "post_validation_timeout" },
  { from: "post-validating", to: "cancelled", trigger: "post_validation_cancelled" },
  { from: "post-rules", to: "completed", trigger: "post_rules_allowed" },
  { from: "post-rules", to: "failed", trigger: "post_rules_denied" },
  { from: "post-rules", to: "timed-out", trigger: "post_rules_timeout" },
  { from: "post-rules", to: "cancelled", trigger: "post_rules_cancelled" },
] as const;

// ─── Step Result ───

/**
 * Outcome of a single pipeline step.
 * - `success` — Step completed successfully.
 * - `failure` — Step encountered an error.
 * - `skipped` — Step was not reached due to an earlier terminal outcome (failure, timeout, or cancellation).
 */
export type FridayNodeRunnerStepOutcome = "success" | "failure" | "skipped";

/**
 * Result produced by a single pipeline step.
 * Every step (whether it succeeds or fails) emits exactly one of these.
 */
export interface FridayNodeRunnerStepResult {
  /** Which pipeline step produced this result. */
  step: FridayNodeRunnerStepName;
  /** Whether the step succeeded, failed, or was skipped. */
  outcome: FridayNodeRunnerStepOutcome;
  /** Duration of this step in milliseconds. */
  durationMs: number;
  /** Typed error code if the step failed. */
  errorCode?: FridayNodeRunnerErrorCode;
  /** Human-readable error message if the step failed. */
  errorMessage?: string;
  /** Rules Engine evaluation result (for pre-rules and post-rules steps). */
  rulesResult?: FridayEvaluationResult;
  /** Validation detail (for pre-validate and post-validate steps). */
  validationErrors?: FridayValidationError[];
  /** Arbitrary step metadata for debugging. */
  metadata?: JsonObject;
}

// ─── Validation ───

/**
 * A single input/output validation error.
 */
export interface FridayValidationError {
  /** Dot-path to the invalid field (e.g. "args.url"). */
  field: string;
  /** Machine-readable constraint that was violated. */
  constraint: string;
  /** Human-readable error message. */
  message: string;
}

/**
 * Aggregated validation result returned by adapter validate methods.
 */
export interface FridayValidationResult {
  /** Whether validation passed. */
  valid: boolean;
  /** Individual validation errors (empty when valid). */
  errors: FridayValidationError[];
}

// ─── Execution Context ───

/**
 * The data contract that flows through all 6 pipeline steps.
 * Created by the workflow engine, enriched by each step.
 */
export interface FridayNodeExecutionContext {
  // ── Identity (set by caller) ──

  /** Unique execution ID for this pipeline run. */
  executionId: UUID;
  /** Parent workflow run ID. */
  runId: UUID;
  /** Parent workflow definition ID. */
  workflowId: UUID;
  /** Node ID within the workflow graph. */
  nodeId: string;
  /** Attempt number (1-based; incremented on retry by the workflow engine). */
  attemptNumber: number;

  // ── Node definition (set by caller) ──

  /** Full node definition from the compiled graph. */
  node: FridayWorkflowNode;
  /** Raw input data from upstream nodes / expression evaluation. */
  inputData: Record<string, unknown>;

  // ── Enriched by Load step ──

  /** Adapter-resolved configuration (skill refs, provider config, etc.). */
  resolvedConfig?: JsonObject;
  /** Adapter-resolved dependencies. */
  resolvedDeps?: JsonObject;

  // ── Enriched by Pre-Validate step ──

  /** Schema-validated input (same shape as inputData after validation). */
  validatedInput?: Record<string, unknown>;

  // ── Enriched by Pre-Rules step ──

  /** Rules Engine evaluation result from the pre-rules step. */
  preRulesResult?: FridayEvaluationResult;

  // ── Enriched by Execute step ──

  /** Raw execution output from the adapter. */
  output?: JsonValue;
  /** Artifacts produced during execution. */
  artifacts?: FridayNodeArtifact[];

  // ── Enriched by Post-Validate step ──

  /** Schema-validated output. */
  validatedOutput?: JsonValue;

  // ── Enriched by Post-Rules step ──

  /** Rules Engine evaluation result from the post-rules step. */
  postRulesResult?: FridayEvaluationResult;

  // ── Lifecycle ──

  /** Abort signal for cancellation / timeout. */
  signal?: AbortSignal;
  /** Execution timeout in milliseconds (from node config or default). */
  timeoutMs?: number;
  /** Pipeline start timestamp. */
  startedAt: ISODateTime;
  /** Extensible metadata bag (adapters and hooks may write here). */
  metadata: JsonObject;
}

/**
 * An artifact produced during node execution.
 */
export interface FridayNodeArtifact {
  /** Artifact type discriminator. */
  artifactType: "json" | "text" | "file" | "image" | "audio" | "video";
  /** URI to the artifact content. */
  uri: string;
  /** Content checksum for integrity verification. */
  checksum?: string;
  /** Arbitrary artifact metadata. */
  metadata?: Record<string, unknown>;
}

// ─── Execution Result ───

/**
 * Final result of a complete NodeRunner pipeline execution.
 * Returned to the workflow engine after all steps complete (or short-circuit).
 */
export interface FridayNodeExecutionResult {
  /** Execution ID (matches context.executionId). */
  executionId: UUID;
  /** Final execution status. */
  status: FridayNodeExecutionStatus;
  /** Output data (present only when status is "completed"). */
  output?: JsonValue;
  /** Artifacts produced (present only when status is "completed"). */
  artifacts?: FridayNodeArtifact[];
  /** Results from each pipeline step that was executed. */
  stepResults: FridayNodeRunnerStepResult[];
  /** Total pipeline duration in milliseconds. */
  durationMs: number;
  /** Error code if the execution failed. */
  errorCode?: FridayNodeRunnerErrorCode;
  /** Human-readable error message if the execution failed. */
  errorMessage?: string;
  /** Pipeline start timestamp. */
  startedAt: ISODateTime;
  /** Pipeline end timestamp. */
  completedAt: ISODateTime;
}

// ─── Node Adapter Interface ───

/**
 * Adapter interface for a specific node type.
 *
 * Each node type (tool, agent, skill, webhook, condition, data, etc.)
 * provides an adapter implementation. The NodeRunner delegates the
 * type-specific logic to the adapter at each relevant pipeline step.
 *
 * @typeParam TConfig - Adapter-resolved configuration shape.
 * @typeParam TInput  - Validated input shape.
 * @typeParam TOutput - Execution output shape.
 */
export interface FridayNodeAdapter<
  TConfig extends JsonObject = JsonObject,
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends JsonValue = JsonValue,
> {
  /**
   * Unique identifier for this adapter, typically matching the node type
   * or a more specific sub-type (e.g. "action:tool", "action:skill").
   */
  readonly nodeType: string;

  /**
   * Step 1 — Load: resolve node configuration and dependencies.
   *
   * @param context - Execution context with node definition and inputData.
   * @returns Resolved configuration for subsequent steps.
   */
  load(
    context: FridayNodeExecutionContext,
    signal?: AbortSignal,
  ): Promise<TConfig>;

  /**
   * Step 2 — Pre-Validate: validate the resolved input against expected schema.
   *
   * @param context - Execution context (post-load, with resolvedConfig).
   * @param config  - Configuration returned by `load()`.
   * @returns Validation result.
   */
  validateInput(
    context: FridayNodeExecutionContext,
    config: TConfig,
    signal?: AbortSignal,
  ): FridayValidationResult | Promise<FridayValidationResult>;

  /**
   * Step 4 — Execute: perform the node's actual work.
   *
   * @param context - Execution context (post-validation, post-pre-rules).
   * @param config  - Configuration returned by `load()`.
   * @param input   - Validated input data.
   * @param signal  - Abort signal for cancellation / timeout.
   * @returns Execution output.
   */
  execute(
    context: FridayNodeExecutionContext,
    config: TConfig,
    input: TInput,
    signal?: AbortSignal,
  ): Promise<TOutput>;

  /**
   * Step 5 — Post-Validate: validate the execution output.
   *
   * @param context - Execution context (post-execute).
   * @param output  - Raw output from `execute()`.
   * @returns Validation result.
   */
  validateOutput(
    context: FridayNodeExecutionContext,
    output: TOutput,
    signal?: AbortSignal,
  ): FridayValidationResult | Promise<FridayValidationResult>;
}

// ─── Adapter Registry ───

/**
 * Registry that maps node types to their adapter implementations.
 * The NodeRunner queries the registry during the Load step.
 */
export interface FridayNodeAdapterRegistry {
  /**
   * Register an adapter for a node type.
   *
   * @param adapter - Adapter instance to register.
   */
  register(adapter: FridayNodeAdapter): void;

  /**
   * Exact-key lookup for a registered adapter.
   *
   * @param key - Exact adapter key (e.g. "action", "action:tool", "ai").
   * @returns The registered adapter, or `undefined` if none is registered.
   */
  get(key: string): FridayNodeAdapter | undefined;

  /**
   * Resolve adapter using precedence:
   * 1) node.config.adapterKey exact match,
   * 2) nodeType:actionType compound,
   * 3) nodeType fallback.
   *
   * @param node - Node context with type and optional config.
   * @returns The resolved adapter, or `undefined` if none matches.
   */
  resolve(node: { type: string; config?: Record<string, unknown> }): FridayNodeAdapter | undefined;

  /**
   * List all registered adapter node types.
   *
   * @returns Array of registered node type identifiers.
   */
  listTypes(): string[];
}

// ─── Pipeline Interface ───

/**
 * The NodeRunner pipeline: accepts an execution context and runs the
 * 6-step pipeline, returning a structured execution result.
 */
export interface FridayNodeRunnerPipeline {
  /**
   * Execute a node through the 6-step pipeline.
   *
   * @param context - Fully populated execution context.
   * @returns Structured execution result with step-by-step details.
   */
  execute(context: FridayNodeExecutionContext): Promise<FridayNodeExecutionResult>;
}

/**
 * Configuration for constructing a NodeRunner pipeline.
 */
export interface FridayNodeRunnerPipelineConfig {
  /** Adapter registry providing node-type implementations. */
  adapterRegistry: FridayNodeAdapterRegistry;
  /** Default execution timeout in milliseconds (used when node.timeoutMs is absent). */
  defaultTimeoutMs: number;
  /**
   * Rules Engine evaluate function (required; fail-closed).
   * NodeRunner construction must fail if this dependency is missing.
   */
  evaluateRules: (
    context: FridayEvaluationContext,
    signal?: AbortSignal,
  ) => Promise<FridayEvaluationResult>;
  /** Generate a new UUID. */
  generateId: () => UUID;
  /** Get current ISO timestamp. */
  nowIso: () => ISODateTime;
}

// ─── Persistence Row Types (SQLite) ───

/**
 * SQLite row shape for the `node_execution_log` table.
 * Records every pipeline execution for audit and debugging.
 */
export interface FridayNodeExecutionLogRow {
  /** Unique execution ID. */
  id: string;
  /** Parent workflow run ID. */
  run_id: string;
  /** Parent workflow ID. */
  workflow_id: string;
  /** Node ID within the graph. */
  node_id: string;
  /** Attempt number. */
  attempt_number: number;
  /** Adapter node type identifier. */
  adapter_type: string;
  /** Final execution status. */
  status: string;
  /** Error code (null if successful). */
  error_code: string | null;
  /** Error message (null if successful). */
  error_message: string | null;
  /** JSON-serialized step results array. */
  step_results_json: string;
  /** JSON-serialized output (null if execution did not complete). */
  output_json: string | null;
  /** JSON-serialized artifacts array (null if none). */
  artifacts_json: string | null;
  /** Total pipeline duration in milliseconds. */
  duration_ms: number;
  /** JSON-serialized input data (redacted for audit). */
  input_data_json: string;
  /** JSON-serialized resolved config (redacted for audit). */
  resolved_config_json: string | null;
  /** JSON-serialized execution metadata. */
  metadata_json: string;
  /** Pipeline start timestamp. */
  started_at: string;
  /** Pipeline end timestamp. */
  completed_at: string;
  /** Row creation timestamp. */
  created_at: string;
}

/**
 * SQLite row shape for the `node_execution_step_log` table.
 * Records individual step results for granular debugging.
 */
export interface FridayNodeExecutionStepLogRow {
  /** Unique step log ID. */
  id: string;
  /** Parent execution ID (FK to node_execution_log). */
  execution_id: string;
  /** Pipeline step name. */
  step: string;
  /** Step outcome (success/failure/skipped). */
  outcome: string;
  /** Step duration in milliseconds. */
  duration_ms: number;
  /** Error code (null if successful). */
  error_code: string | null;
  /** Error message (null if successful). */
  error_message: string | null;
  /** JSON-serialized rules evaluation result (null if N/A). */
  rules_result_json: string | null;
  /** JSON-serialized validation errors (null if N/A). */
  validation_errors_json: string | null;
  /** JSON-serialized step metadata. */
  metadata_json: string | null;
  /** Row creation timestamp. */
  created_at: string;
}
