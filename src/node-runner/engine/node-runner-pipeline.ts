/**
 * NodeRunner Pipeline — 6-step deterministic execution engine.
 *
 * Runs every node through: load → pre-validate → pre-rules → execute →
 * post-validate → post-rules. Each step produces a `FridayNodeRunnerStepResult`.
 * On failure, the pipeline short-circuits and remaining steps are marked skipped.
 *
 * Design guarantees:
 * - Deterministic: same input always produces same output ordering.
 * - Never throws: errors are captured in `FridayNodeExecutionResult`.
 * - Fail-closed: missing rules evaluator or adapter → immediate failure.
 * - Timeout-safe: overall and per-execute-step AbortSignal enforcement.
 *
 * @module node-runner/engine
 */

import { FridayDomainError } from "#errors";

import type {
  FridayEvaluationContext,
  FridayEvaluationResult,
  JsonObject,
  JsonValue,
} from "../../rules/model/friday-rules-engine.types.js";

import type {
  FridayNodeAdapter,
  FridayNodeExecutionContext,
  FridayNodeExecutionResult,
  FridayNodeExecutionStatus,
  FridayNodeRunnerErrorCode,
  FridayNodeRunnerPipeline,
  FridayNodeRunnerPipelineConfig,
  FridayNodeRunnerStepName,
  FridayNodeRunnerStepResult,
  FridayValidationResult,
} from "../model/friday-node-runner.types.js";

import { FRIDAY_NODE_RUNNER_STEP_ORDER } from "../model/friday-node-runner.types.js";

import { isValidTransition, transition } from "./state-machine.js";
import { buildPostRulesContext, buildPreRulesContext } from "./rules-context-builder.js";

// ─── Constants ───

const DEFAULT_TIMEOUT_MS = 30_000;
const TIMEOUT_REASON_TAG = Symbol("NODE_RUNNER_TIMEOUT");
const TIMEOUT_ERROR_NAME = "TimeoutError";
const EXPLICIT_TIMEOUT_REASON_KEY = "timeout";

class NodeRunnerTimeoutReason extends Error {
  readonly [TIMEOUT_REASON_TAG] = true;

  constructor(timeoutMs: number) {
    super(`Node execution timed out after ${timeoutMs}ms`);
    this.name = "NodeRunnerTimeoutReason";
  }
}

// ─── Pipeline Implementation ───

export class NodeRunnerPipeline implements FridayNodeRunnerPipeline {
  private readonly config: FridayNodeRunnerPipelineConfig;

  constructor(config: FridayNodeRunnerPipelineConfig) {
    if (!config.adapterRegistry) {
      throw new FridayDomainError("VALIDATION_ERROR", "NodeRunnerPipeline requires an adapterRegistry", { httpStatus: 400 });
    }
    if (!config.evaluateRules) {
      throw new FridayDomainError("VALIDATION_ERROR", "NodeRunnerPipeline requires an evaluateRules function (fail-closed)", { httpStatus: 400 });
    }
    this.config = config;
  }

  async execute(context: FridayNodeExecutionContext): Promise<FridayNodeExecutionResult> {
    const stepResults: FridayNodeRunnerStepResult[] = [];
    let status: FridayNodeExecutionStatus = "loading";
    let adapter: FridayNodeAdapter | undefined;
    let adapterConfig: JsonObject | undefined;

    // Set up overall timeout via AbortController
    const timeoutMs = context.timeoutMs ?? this.config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutController = new AbortController();
    const compositeSignal = composeAbortSignals(context.signal, timeoutController.signal);
    const timeoutHandle = setTimeout(
      () => timeoutController.abort(new NodeRunnerTimeoutReason(timeoutMs)),
      timeoutMs,
    );

    try {
      // ── Step 1: Load ──
      const loadResult = await this.runStep("load", compositeSignal, async () => {
        adapter = this.resolveAdapter(context);
        const config = await adapter.load(context, compositeSignal);
        adapterConfig = config;
        context.resolvedConfig = config;
        return undefined;
      });
      stepResults.push(loadResult);
      if (loadResult.outcome === "failure") {
        status = transitionToFailure(status, loadResult, compositeSignal);
        return this.buildResult(context, status, stepResults, loadResult);
      }
      status = transition(status, "validating");

      // ── Step 2: Pre-Validate ──
      const preValidateResult = await this.runStep("pre-validate", compositeSignal, async () => {
        const validation = await adapter!.validateInput(context, adapterConfig!, compositeSignal);
        if (!validation.valid) {
          return {
            errorCode: "VALIDATION_FAILED" as FridayNodeRunnerErrorCode,
            errorMessage: formatValidationErrors(validation),
            validationErrors: validation.errors,
          };
        }
        context.validatedInput = { ...context.inputData };
        return undefined;
      });
      stepResults.push(preValidateResult);
      if (preValidateResult.outcome === "failure") {
        status = transitionToFailure(status, preValidateResult, compositeSignal);
        return this.buildResult(context, status, stepResults, preValidateResult);
      }
      status = transition(status, "checking-rules");

      // ── Step 3: Pre-Rules ──
      const preRulesResult = await this.runStep("pre-rules", compositeSignal, async () => {
        const evalContext = buildPreRulesContext(context, adapter!.nodeType);
        const result = await this.evaluateRulesSafe(evalContext, compositeSignal);
        context.preRulesResult = result;
        if (!result.allowed) {
          return {
            errorCode: "PRE_RULES_DENIED" as FridayNodeRunnerErrorCode,
            errorMessage: result.message ?? "Pre-rules evaluation denied execution",
            rulesResult: result,
          };
        }
        return { rulesResult: result };
      });
      stepResults.push(preRulesResult);
      if (preRulesResult.outcome === "failure") {
        status = transitionToFailure(status, preRulesResult, compositeSignal);
        return this.buildResult(context, status, stepResults, preRulesResult);
      }
      status = transition(status, "executing");

      // ── Step 4: Execute ──
      const executeResult = await this.runStep("execute", compositeSignal, async () => {
        const output = await adapter!.execute(
          context,
          adapterConfig!,
          context.validatedInput ?? context.inputData,
          compositeSignal,
        );
        context.output = output as JsonValue;
        return undefined;
      });
      stepResults.push(executeResult);
      if (executeResult.outcome === "failure") {
        status = transitionToFailure(status, executeResult, compositeSignal);
        return this.buildResult(context, status, stepResults, executeResult);
      }
      status = transition(status, "post-validating");

      // ── Step 5: Post-Validate ──
      const postValidateResult = await this.runStep("post-validate", compositeSignal, async () => {
        const validation = await adapter!.validateOutput(
          context,
          context.output as JsonValue,
          compositeSignal,
        );
        if (!validation.valid) {
          return {
            errorCode: "VALIDATION_FAILED" as FridayNodeRunnerErrorCode,
            errorMessage: formatValidationErrors(validation),
            validationErrors: validation.errors,
          };
        }
        context.validatedOutput = context.output;
        return undefined;
      });
      stepResults.push(postValidateResult);
      if (postValidateResult.outcome === "failure") {
        status = transitionToFailure(status, postValidateResult, compositeSignal);
        return this.buildResult(context, status, stepResults, postValidateResult);
      }
      status = transition(status, "post-rules");

      // ── Step 6: Post-Rules ──
      const executeDurationMs = executeResult.durationMs;
      const postRulesResult = await this.runStep("post-rules", compositeSignal, async () => {
        const evalContext = buildPostRulesContext(context, adapter!.nodeType, executeDurationMs);
        const result = await this.evaluateRulesSafe(evalContext, compositeSignal);
        context.postRulesResult = result;
        if (!result.allowed) {
          return {
            errorCode: "POST_RULES_DENIED" as FridayNodeRunnerErrorCode,
            errorMessage: result.message ?? "Post-rules evaluation denied output",
            rulesResult: result,
          };
        }
        return { rulesResult: result };
      });
      stepResults.push(postRulesResult);
      if (postRulesResult.outcome === "failure") {
        status = transitionToFailure(status, postRulesResult, compositeSignal);
        return this.buildResult(context, status, stepResults, postRulesResult);
      }

      // ── All steps succeeded ──
      status = transition(status, "completed");
      return this.buildResult(context, status, stepResults);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  // ─── Step Runner ───

  /**
   * Execute a single pipeline step with timing, error capture, and abort checking.
   *
   * The `fn` returns `undefined` on success, or a partial step result with
   * errorCode/errorMessage on logical failure (e.g. validation fail, rules deny).
   */
  private async runStep(
    step: FridayNodeRunnerStepName,
    signal: AbortSignal,
    fn: () =>
      | StepFailureInfo
      | undefined
      | Promise<StepFailureInfo | undefined>,
  ): Promise<FridayNodeRunnerStepResult> {
    const startMs = performance.now();

    // Check for abort before starting the step
    if (signal.aborted) {
      return buildStepResult(step, round2(performance.now() - startMs), {
        outcome: "failure",
        errorCode: classifyAbortError(signal),
        errorMessage: `Step "${step}" aborted before execution`,
      });
    }

    try {
      const failureInfo = await fn();

      const durationMs = round2(performance.now() - startMs);

      if (signal.aborted) {
        return buildStepResult(step, durationMs, {
          outcome: "failure",
          errorCode: classifyAbortError(signal),
          errorMessage: `Step "${step}" aborted after execution`,
        });
      }

      if (failureInfo?.errorCode) {
        return buildStepResult(step, durationMs, {
          outcome: "failure",
          errorCode: failureInfo.errorCode,
          errorMessage: failureInfo.errorMessage,
          rulesResult: failureInfo.rulesResult,
          validationErrors: failureInfo.validationErrors,
        });
      }

      return buildStepResult(step, durationMs, {
        outcome: "success",
        rulesResult: failureInfo?.rulesResult,
      });
    } catch (error) {
      const durationMs = round2(performance.now() - startMs);

      if (signal.aborted) {
        return buildStepResult(step, durationMs, {
          outcome: "failure",
          errorCode: classifyAbortError(signal),
          errorMessage: `Step "${step}" aborted: ${errorMessage(error)}`,
        });
      }

      return buildStepResult(step, durationMs, {
        outcome: "failure",
        errorCode: classifyStepError(step, error),
        errorMessage: `Step "${step}" failed: ${errorMessage(error)}`,
      });
    }
  }

  // ─── Adapter Resolution ───

  private resolveAdapter(context: FridayNodeExecutionContext): FridayNodeAdapter {
    const adapter = this.config.adapterRegistry.resolve({
      type: context.node.type,
      config: context.node.config as Record<string, unknown>,
    });
    if (!adapter) {
      throw new AdapterNotFoundError(context.node.type, context.nodeId);
    }
    return adapter;
  }

  // ─── Rules Evaluation ───

  private async evaluateRulesSafe(
    evalContext: FridayEvaluationContext,
    signal: AbortSignal,
  ): Promise<FridayEvaluationResult> {
    try {
      return await this.config.evaluateRules(evalContext, signal);
    } catch (error) {
      throw new RuleEvaluationError(errorMessage(error));
    }
  }

  // ─── Result Builder ───

  private buildResult(
    context: FridayNodeExecutionContext,
    status: FridayNodeExecutionStatus,
    stepResults: FridayNodeRunnerStepResult[],
    failedStep?: FridayNodeRunnerStepResult,
  ): FridayNodeExecutionResult {
    // Fill in skipped steps for any pipeline steps not reached
    const completedSteps = new Set(stepResults.map((r) => r.step));
    for (const stepName of FRIDAY_NODE_RUNNER_STEP_ORDER) {
      if (!completedSteps.has(stepName)) {
        stepResults.push(buildStepResult(stepName, 0, { outcome: "skipped" }));
      }
    }

    const completedAt = this.config.nowIso();
    const totalDurationMs = round2(
      stepResults.reduce((sum, r) => sum + r.durationMs, 0),
    );

    return {
      executionId: context.executionId,
      status,
      output: status === "completed" ? (context.validatedOutput ?? context.output) : undefined,
      artifacts: status === "completed" ? context.artifacts : undefined,
      stepResults,
      durationMs: totalDurationMs,
      errorCode: failedStep?.errorCode,
      errorMessage: failedStep?.errorMessage,
      startedAt: context.startedAt,
      completedAt,
    };
  }
}

// ─── Step Result Helper Types ───

interface StepFailureInfo {
  errorCode?: FridayNodeRunnerErrorCode;
  errorMessage?: string;
  rulesResult?: FridayEvaluationResult;
  validationErrors?: FridayNodeRunnerStepResult["validationErrors"];
}

interface StepResultOptions {
  outcome: "success" | "failure" | "skipped";
  errorCode?: FridayNodeRunnerErrorCode;
  errorMessage?: string;
  rulesResult?: FridayEvaluationResult;
  validationErrors?: FridayNodeRunnerStepResult["validationErrors"];
}

function buildStepResult(
  step: FridayNodeRunnerStepName,
  durationMs: number,
  options: StepResultOptions,
): FridayNodeRunnerStepResult {
  const result: FridayNodeRunnerStepResult = {
    step,
    outcome: options.outcome,
    durationMs,
  };
  if (options.errorCode) result.errorCode = options.errorCode;
  if (options.errorMessage) result.errorMessage = options.errorMessage;
  if (options.rulesResult) result.rulesResult = options.rulesResult;
  if (options.validationErrors) result.validationErrors = options.validationErrors;
  return result;
}

// ─── Error Classification ───

class AdapterNotFoundError extends Error {
  constructor(nodeType: string, nodeId: string) {
    super(`No adapter found for node type "${nodeType}" (node: ${nodeId})`);
    this.name = "AdapterNotFoundError";
  }
}

class RuleEvaluationError extends Error {
  constructor(message: string) {
    super(`Rules evaluation failed: ${message}`);
    this.name = "RuleEvaluationError";
  }
}

function classifyStepError(
  step: FridayNodeRunnerStepName,
  error?: unknown,
): FridayNodeRunnerErrorCode {
  const passthroughCode = extractPrefixedErrorCode(error);
  if (passthroughCode) {
    return passthroughCode;
  }
  switch (step) {
    case "load":
      return "NODE_LOAD_FAILED";
    case "pre-validate":
    case "post-validate":
      return "VALIDATION_FAILED";
    case "pre-rules":
      return "RULE_EVALUATION_FAILED";
    case "execute":
      return "NODE_EXECUTION_FAILED";
    case "post-rules":
      return "RULE_EVALUATION_FAILED";
  }
}

function extractPrefixedErrorCode(error: unknown): FridayNodeRunnerErrorCode | null {
  const message = errorMessage(error);
  const matched = message.match(/^([A-Z][A-Z0-9_]+):/);
  if (!matched) {
    return null;
  }
  const candidate = matched[1];
  if (
    candidate.startsWith("NODE_")
    || candidate === "VALIDATION_FAILED"
    || candidate === "RULE_EVALUATION_FAILED"
    || candidate === "PRE_RULES_DENIED"
    || candidate === "POST_RULES_DENIED"
    || candidate === "ACCEPTANCE_FAILED"
    || candidate === "EXECUTION_NOT_CANCELLABLE"
  ) {
    return candidate as FridayNodeRunnerErrorCode;
  }
  return null;
}

function classifyAbortError(signal: AbortSignal): FridayNodeRunnerErrorCode {
  return isTimeoutAbortReason(signal.reason) ? "NODE_TIMEOUT" : "NODE_CANCELLED";
}

function isTimeoutAbortReason(reason: unknown): boolean {
  if (isInternalTimeoutReason(reason)) {
    return true;
  }
  if (isDomTimeoutError(reason)) {
    return true;
  }
  if (hasTimeoutErrorName(reason)) {
    return true;
  }
  if (hasExplicitTimeoutMarker(reason)) {
    return true;
  }
  return false;
}

function isInternalTimeoutReason(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    TIMEOUT_REASON_TAG in reason
  );
}

function isDomTimeoutError(reason: unknown): boolean {
  return (
    typeof DOMException === "function" &&
    reason instanceof DOMException &&
    reason.name === TIMEOUT_ERROR_NAME
  );
}

function hasTimeoutErrorName(reason: unknown): boolean {
  return (
    (typeof reason === "object" || typeof reason === "function") &&
    reason !== null &&
    "name" in reason &&
    (reason as { name?: unknown }).name === TIMEOUT_ERROR_NAME
  );
}

function hasExplicitTimeoutMarker(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    EXPLICIT_TIMEOUT_REASON_KEY in reason &&
    (reason as Record<string, unknown>)[EXPLICIT_TIMEOUT_REASON_KEY] === true
  );
}

/**
 * Determine the correct failure status based on the current state and error type.
 */
function transitionToFailure(
  currentStatus: FridayNodeExecutionStatus,
  failedStep: FridayNodeRunnerStepResult,
  signal: AbortSignal,
): FridayNodeExecutionStatus {
  let target: FridayNodeExecutionStatus = "failed";

  if (signal.aborted && failedStep.errorCode === "NODE_CANCELLED") {
    target = "cancelled";
  } else if (signal.aborted && failedStep.errorCode === "NODE_TIMEOUT") {
    target = "timed-out";
  }

  if (isValidTransition(currentStatus, target)) {
    return transition(currentStatus, target);
  }
  if (target !== "failed" && isValidTransition(currentStatus, "failed")) {
    return transition(currentStatus, "failed");
  }
  return currentStatus;
}

// ─── Validation Formatting ───

function formatValidationErrors(result: FridayValidationResult): string {
  if (result.errors.length === 0) return "Validation failed";
  return result.errors
    .map((e) => `${e.field}: ${e.message} (${e.constraint})`)
    .join("; ");
}

// ─── AbortSignal Composition ───

/**
 * Compose two optional AbortSignals into a single signal that aborts
 * when either source aborts.
 */
function composeAbortSignals(
  external: AbortSignal | undefined,
  timeout: AbortSignal,
): AbortSignal {
  if (!external) return timeout;

  // Use AbortSignal.any if available (Node 20+)
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([external, timeout]);
  }

  // Fallback: manual composition
  const controller = new AbortController();
  const onAbort = () => controller.abort(external.reason ?? timeout.reason);

  if (external.aborted || timeout.aborted) {
    controller.abort(external.aborted ? external.reason : timeout.reason);
    return controller.signal;
  }

  external.addEventListener("abort", onAbort, { once: true });
  timeout.addEventListener("abort", onAbort, { once: true });

  return controller.signal;
}

// ─── Utilities ───

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

// ─── Factory ───

/**
 * Create a new `NodeRunnerPipeline` instance.
 *
 * @param config - Pipeline configuration with adapter registry, rules evaluator, and utilities.
 * @returns A configured `FridayNodeRunnerPipeline` implementation.
 */
export function createNodeRunnerPipeline(
  config: FridayNodeRunnerPipelineConfig,
): FridayNodeRunnerPipeline {
  return new NodeRunnerPipeline(config);
}
