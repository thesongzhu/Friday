/**
 * Workflow Condition Node Adapter for the NodeRunner pipeline.
 *
 * Condition nodes evaluate an expression and return a boolean result.
 * This adapter wraps the existing condition node logic from the workflow
 * node executor into the deterministic 6-step NodeRunner pipeline.
 *
 * @module node-runner/engine
 */

import { FridayDomainError } from "#errors";

import type {
  FridayNodeAdapter,
  FridayNodeExecutionContext,
  FridayValidationResult,
} from "../model/friday-node-runner.types.js";

import type {
  JsonObject,
  JsonValue,
} from "../../rules/model/friday-rules-engine.types.js";

// ─── Dependencies ───

export type ConditionExpressionEvaluator = {
  exec: (expr: string, context: Record<string, unknown>) => unknown;
};

export interface WorkflowConditionAdapterOptions {
  expressionEvaluator: ConditionExpressionEvaluator;
}

/**
 * Adapter for workflow `condition` nodes.
 *
 * Evaluates a condition expression from the node config and returns
 * `{ result: boolean }` as its output.
 */
export class WorkflowConditionAdapter implements FridayNodeAdapter {
  readonly nodeType = "condition";
  private readonly expressionEvaluator: ConditionExpressionEvaluator;

  constructor(options: WorkflowConditionAdapterOptions) {
    this.expressionEvaluator = options.expressionEvaluator;
  }

  async load(context: FridayNodeExecutionContext, signal?: AbortSignal): Promise<JsonObject> {
    throwIfAborted(signal);
    const config = context.node.config as JsonObject;
    const conditionExpr = config.condition as string | undefined;

    if (!conditionExpr) {
      throw new FridayDomainError("VALIDATION_ERROR", "condition node missing 'condition' in config", { httpStatus: 400 });
    }

    return { ...config };
  }

  validateInput(
    _context: FridayNodeExecutionContext,
    config: JsonObject,
    signal?: AbortSignal,
  ): FridayValidationResult {
    throwIfAborted(signal);
    const conditionExpr = config.condition as string | undefined;
    if (!conditionExpr) {
      return {
        valid: false,
        errors: [{ field: "condition", constraint: "required", message: "condition expression is required" }],
      };
    }
    return { valid: true, errors: [] };
  }

  async execute(
    context: FridayNodeExecutionContext,
    config: JsonObject,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    throwIfAborted(signal);

    const conditionExpr = config.condition as string;
    const result = this.expressionEvaluator.exec(conditionExpr, input);

    return { result: Boolean(result) } as JsonValue;
  }

  validateOutput(
    _context: FridayNodeExecutionContext,
    _output: JsonValue,
    signal?: AbortSignal,
  ): FridayValidationResult {
    throwIfAborted(signal);
    return { valid: true, errors: [] };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new FridayDomainError("INTERNAL_ERROR", "Condition node operation aborted", { httpStatus: 500 });
}
