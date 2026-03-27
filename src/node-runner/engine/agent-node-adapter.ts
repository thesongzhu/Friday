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

export type AgentNodeExecutor = (
  context: FridayNodeExecutionContext,
  config: JsonObject,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<JsonValue>;

export interface AgentNodeAdapterOptions {
  agentExecutor?: AgentNodeExecutor;
}

/**
 * Built-in adapter for workflow `ai` nodes.
 * The default behavior is intentionally minimal and deterministic so projects
 * can override it with provider-specific adapters when needed.
 */
export class AgentNodeAdapter implements FridayNodeAdapter {
  readonly nodeType = "ai";
  private readonly agentExecutor?: AgentNodeExecutor;

  constructor(options: AgentNodeAdapterOptions = {}) {
    this.agentExecutor = options.agentExecutor;
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
    if (this.agentExecutor) {
      return this.agentExecutor(context, config, input, signal);
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
  throw new FridayDomainError("INTERNAL_ERROR", "Agent node operation aborted", { httpStatus: 500 });
}
