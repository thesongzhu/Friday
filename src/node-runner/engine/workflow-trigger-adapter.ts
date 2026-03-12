/**
 * Workflow Trigger Node Adapter for the NodeRunner pipeline.
 *
 * Trigger nodes pass through their input payload as output.
 * This adapter wraps the existing trigger node logic from the workflow
 * node executor into the deterministic 6-step NodeRunner pipeline.
 *
 * @module node-runner/engine
 */

import type {
  FridayNodeAdapter,
  FridayNodeExecutionContext,
  FridayValidationResult,
} from "../model/friday-node-runner.types.js";

import type {
  JsonObject,
  JsonValue,
} from "../../rules/model/friday-rules-engine.types.js";

/**
 * Adapter for workflow `trigger` nodes.
 *
 * Trigger nodes are the entry point of a workflow — they pass through
 * the trigger payload (from inputData) as their output.
 */
export class WorkflowTriggerAdapter implements FridayNodeAdapter {
  readonly nodeType = "trigger";

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
    _config: JsonObject,
    _input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    throwIfAborted(signal);
    // Trigger nodes pass through their input data as output
    const payload = context.inputData ?? {};
    return payload as JsonValue;
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
  throw new Error("Trigger node operation aborted");
}
