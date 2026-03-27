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

export type ToolNodeExecutor = (
  context: FridayNodeExecutionContext,
  config: JsonObject,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<JsonValue>;

export interface ToolNodeAdapterOptions {
  toolExecutor?: ToolNodeExecutor;
}

/**
 * Built-in adapter for workflow `action` nodes with `actionType: "tool"`.
 * This adapter provides a deterministic baseline implementation that can be
 * overridden by registering a more specific adapter key.
 */
export class ToolNodeAdapter implements FridayNodeAdapter {
  readonly nodeType = "action:tool";
  private readonly toolExecutor?: ToolNodeExecutor;

  constructor(options: ToolNodeAdapterOptions = {}) {
    this.toolExecutor = options.toolExecutor;
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
    if (this.toolExecutor) {
      return this.toolExecutor(context, config, input, signal);
    }
    return { ...input } as JsonValue;
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
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new FridayDomainError("INTERNAL_ERROR", "Tool node operation aborted", { httpStatus: 500 });
}
