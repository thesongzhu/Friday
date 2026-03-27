/**
 * Workflow Action Node Adapter for the NodeRunner pipeline.
 *
 * Action nodes resolve a skill by ID and invoke it with expression-resolved
 * arguments. This adapter wraps the existing action node logic from the
 * workflow node executor into the deterministic 6-step NodeRunner pipeline.
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

export type ActionSkillResolver = (skillId: string) => unknown | null;

export type ActionSkillInvoker = (
  skillId: string,
  runId: string,
  nodeId: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export type ActionExpressionEvaluator = {
  exec: (expr: string, context: Record<string, unknown>) => unknown;
};

export interface WorkflowActionAdapterOptions {
  resolveSkill: ActionSkillResolver;
  invokeSkill: ActionSkillInvoker;
  expressionEvaluator: ActionExpressionEvaluator;
}

/**
 * Adapter for workflow `action` nodes.
 *
 * Resolves a skill by ID from the config, evaluates expression arguments,
 * and invokes the skill through the injected invokeSkill callback.
 */
export class WorkflowActionAdapter implements FridayNodeAdapter {
  readonly nodeType = "action";
  private readonly resolveSkill: ActionSkillResolver;
  private readonly invokeSkill: ActionSkillInvoker;
  private readonly expressionEvaluator: ActionExpressionEvaluator;

  constructor(options: WorkflowActionAdapterOptions) {
    this.resolveSkill = options.resolveSkill;
    this.invokeSkill = options.invokeSkill;
    this.expressionEvaluator = options.expressionEvaluator;
  }

  async load(context: FridayNodeExecutionContext, signal?: AbortSignal): Promise<JsonObject> {
    throwIfAborted(signal);
    const config = context.node.config as JsonObject;
    const skillId = (config.skillId ?? config.ref) as string | undefined;

    if (!skillId) {
      throw new FridayDomainError("VALIDATION_ERROR", "action node missing skillId or ref in config", { httpStatus: 400 });
    }

    const skill = this.resolveSkill(skillId);
    if (!skill) {
      throw new FridayDomainError("NOT_FOUND", `skill '${skillId}' not found`, { httpStatus: 404 });
    }

    return { ...config, _resolvedSkillId: skillId };
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

    const skillId = config._resolvedSkillId as string;
    const rawArgs = (config.args ?? {}) as Record<string, unknown>;

    // Resolve expression arguments
    const resolvedArgs = resolveArgs(rawArgs, input, this.expressionEvaluator);

    const result = await this.invokeSkill(
      skillId,
      context.runId,
      context.nodeId,
      resolvedArgs,
      signal,
    );

    return (result ?? null) as JsonValue;
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
  evaluator: ActionExpressionEvaluator,
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
  throw new FridayDomainError("INTERNAL_ERROR", "Action node operation aborted", { httpStatus: 500 });
}
