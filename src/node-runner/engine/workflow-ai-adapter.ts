/**
 * Workflow AI Node Adapter for the NodeRunner pipeline.
 *
 * AI nodes interpolate a prompt template with expression values and
 * invoke an AI inference skill. This adapter wraps the existing AI node
 * logic from the workflow node executor into the deterministic 6-step
 * NodeRunner pipeline.
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

// ─── Dependencies ───

export type AiExpressionEvaluator = {
  exec: (expr: string, context: Record<string, unknown>) => unknown;
};

export type AiSkillInvoker = (
  skillId: string,
  runId: string,
  nodeId: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface WorkflowAiAdapterOptions {
  expressionEvaluator: AiExpressionEvaluator;
  invokeSkill: AiSkillInvoker;
}

/**
 * Adapter for workflow `ai` nodes.
 *
 * Interpolates the prompt template using the expression evaluator,
 * then invokes the `ai-inference` skill with the resolved prompt.
 */
export class WorkflowAiAdapter implements FridayNodeAdapter {
  readonly nodeType = "ai";
  private readonly expressionEvaluator: AiExpressionEvaluator;
  private readonly invokeSkill: AiSkillInvoker;

  constructor(options: WorkflowAiAdapterOptions) {
    this.expressionEvaluator = options.expressionEvaluator;
    this.invokeSkill = options.invokeSkill;
  }

  async load(context: FridayNodeExecutionContext, signal?: AbortSignal): Promise<JsonObject> {
    throwIfAborted(signal);
    const config = context.node.config as JsonObject;
    const prompt = config.prompt as string | undefined;

    if (!prompt) {
      throw new Error("ai node missing 'prompt' in config");
    }

    return { ...config };
  }

  validateInput(
    _context: FridayNodeExecutionContext,
    config: JsonObject,
    signal?: AbortSignal,
  ): FridayValidationResult {
    throwIfAborted(signal);
    const prompt = config.prompt as string | undefined;
    if (!prompt) {
      return {
        valid: false,
        errors: [{ field: "prompt", constraint: "required", message: "prompt is required for ai nodes" }],
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

    const prompt = config.prompt as string;
    const model = config.model as string | undefined;

    // Interpolate prompt using expression context
    let interpolatedPrompt = prompt;
    const refPattern = /\$[a-zA-Z_][a-zA-Z0-9_.]*\b/g;
    for (const match of prompt.matchAll(refPattern)) {
      const refExpr = match[0];
      try {
        const val = this.expressionEvaluator.exec(refExpr, input);
        interpolatedPrompt = interpolatedPrompt.replace(
          refExpr,
          String(val ?? ""),
        );
      } catch {
        // Leave unresolved refs as-is
      }
    }

    const result = await this.invokeSkill(
      "ai-inference",
      context.runId,
      context.nodeId,
      { prompt: interpolatedPrompt, model },
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("AI node operation aborted");
}
