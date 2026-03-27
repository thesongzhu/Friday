/**
 * Workflow Data Node Adapter for the NodeRunner pipeline.
 *
 * Data nodes apply a mapping or transform from config to produce output.
 * This adapter wraps the existing data node logic from the workflow node
 * executor into the deterministic 6-step NodeRunner pipeline.
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

export type DataExpressionEvaluator = {
  exec: (expr: string, context: Record<string, unknown>) => unknown;
};

export interface WorkflowDataAdapterOptions {
  expressionEvaluator: DataExpressionEvaluator;
}

/**
 * Adapter for workflow `data` nodes.
 *
 * Applies mapping or transform expressions from the node config to
 * produce derived output data.
 */
export class WorkflowDataAdapter implements FridayNodeAdapter {
  readonly nodeType = "data";
  private readonly expressionEvaluator: DataExpressionEvaluator;

  constructor(options: WorkflowDataAdapterOptions) {
    this.expressionEvaluator = options.expressionEvaluator;
  }

  async load(context: FridayNodeExecutionContext, signal?: AbortSignal): Promise<JsonObject> {
    throwIfAborted(signal);
    return { ...(context.node.config as JsonObject) };
  }

  validateInput(
    _context: FridayNodeExecutionContext,
    _config: JsonObject,
    signal?: AbortSignal,
  ): FridayValidationResult {
    throwIfAborted(signal);
    return { valid: true, errors: [] };
  }

  async execute(
    context: FridayNodeExecutionContext,
    config: JsonObject,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    throwIfAborted(signal);

    const transform = config.transform as string | undefined;
    const mapping = config.mapping as Record<string, unknown> | undefined;

    if (transform) {
      const result = this.expressionEvaluator.exec(transform, input);
      return (result ?? null) as JsonValue;
    }

    if (mapping) {
      const resolved = resolveArgs(mapping, input, this.expressionEvaluator);
      return resolved as unknown as JsonValue;
    }

    return null;
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

// ─── Helpers ───

function resolveArgs(
  args: Record<string, unknown>,
  expressionContext: Record<string, unknown>,
  evaluator: DataExpressionEvaluator,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.startsWith("$")) {
      resolved[key] = evaluator.exec(value, expressionContext);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new FridayDomainError("INTERNAL_ERROR", "Data node operation aborted", { httpStatus: 500 });
}
