/**
 * Workflow Approval Node Adapter for the NodeRunner pipeline.
 *
 * Approval nodes signal that the run should pause for human approval.
 * This adapter wraps the existing approval node logic from the workflow
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
 * Adapter for workflow `approval` nodes.
 *
 * Approval nodes always return `{ approved: false, pending: true }` to
 * signal that the workflow run should pause and await a human decision.
 */
export class WorkflowApprovalAdapter implements FridayNodeAdapter {
  readonly nodeType = "approval";

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
    _context: FridayNodeExecutionContext,
    _config: JsonObject,
    _input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    throwIfAborted(signal);
    return { approved: false, pending: true } as JsonValue;
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
  throw new Error("Approval node operation aborted");
}
