import { FridayDomainError } from "#errors";
import type { FridayWorkflowNode } from "../model/friday-workflow-graph.types.js";
import type {
  FridayExpressionContext,
  FridayExpressionEvaluator,
} from "../model/friday-workflow-expression.types.js";
import type { JsonValue, UUID } from "../model/friday-workflow.types.js";

// ─── I/O types ───

export interface FridayNodeExecutionInput {
  runId: UUID;
  workflowId?: UUID;
  nodeId: string;
  attemptId: UUID;
  node: FridayWorkflowNode;
  inputData: Record<string, unknown>;
  expressionContext: FridayExpressionContext;
  signal?: AbortSignal;
}

export interface FridayNodeExecutionOutput {
  output: JsonValue;
  artifacts?: Array<{
    artifactType: "json" | "text" | "file" | "image" | "audio" | "video";
    uri: string;
    checksum?: string;
    metadata?: Record<string, unknown>;
  }>;
}

// ─── Interface ───

export interface FridayWorkflowNodeExecutor {
  executeNode(input: FridayNodeExecutionInput): Promise<FridayNodeExecutionOutput>;
}

// ─── Dependencies ───

export interface CreateNodeExecutorDeps {
  expressionEvaluator: FridayExpressionEvaluator;
  resolveSkill: (skillId: string) => unknown | null;
  invokeSkill: (
    skillId: string,
    runId: UUID,
    nodeId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  nowIso: () => string;
}

// ─── Expression arg resolution ───

function resolveArgs(
  args: Record<string, unknown>,
  expressionContext: FridayExpressionContext,
  evaluator: FridayExpressionEvaluator,
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

// ─── Factory ───

export function createFridayWorkflowNodeExecutor(
  deps: CreateNodeExecutorDeps,
): FridayWorkflowNodeExecutor {
  return {
    async executeNode(input) {
      const { node, expressionContext } = input;
      const config = node.config as Record<string, unknown>;

      switch (node.type) {
        case "trigger": {
          // Trigger nodes pass through their payload as output
          const payload =
            expressionContext.inputs ?? {};
          return { output: payload as JsonValue };
        }

        case "action": {
          const skillId = (config.skillId ?? config.ref) as string | undefined;
          if (!skillId) {
            throw new FridayDomainError("NODE_EXECUTION_FAILED", "NODE_EXECUTION_FAILED: action node missing skillId or ref", { httpStatus: 400 });
          }

          const skill = deps.resolveSkill(skillId);
          if (!skill) {
            throw new FridayDomainError(
              "NODE_EXECUTION_FAILED",
              `NODE_EXECUTION_FAILED: skill '${skillId}' not found`,
              { httpStatus: 404 },
            );
          }

          const rawArgs = (config.args ?? {}) as Record<string, unknown>;
          const resolvedArgs = resolveArgs(
            rawArgs,
            expressionContext,
            deps.expressionEvaluator,
          );

          // Apply per-node timeout (default 2 minutes) in addition to any external signal
          const nodeTimeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0
            ? config.timeoutMs
            : 120_000;
          const timeoutSignal = AbortSignal.timeout(nodeTimeoutMs);
          const effectiveSignal = input.signal
            ? AbortSignal.any([input.signal, timeoutSignal])
            : timeoutSignal;

          const result = await deps.invokeSkill(
            skillId,
            input.runId,
            input.nodeId,
            resolvedArgs,
            effectiveSignal,
          );
          return { output: (result ?? null) as JsonValue };
        }

        case "condition": {
          const conditionExpr = config.condition as string | undefined;
          if (!conditionExpr) {
            throw new FridayDomainError(
              "NODE_EXECUTION_FAILED",
              "NODE_EXECUTION_FAILED: condition node missing 'condition' in config",
              { httpStatus: 400 },
            );
          }
          const result = deps.expressionEvaluator.exec(
            conditionExpr,
            expressionContext,
          );
          return { output: { result: Boolean(result) } as JsonValue };
        }

        case "data": {
          // Apply mapping or transform from config
          const mapping = config.mapping as
            | Record<string, unknown>
            | undefined;
          const transform = config.transform as string | undefined;

          if (transform) {
            const result = deps.expressionEvaluator.exec(
              transform,
              expressionContext,
            );
            return { output: (result ?? null) as JsonValue };
          }

          if (mapping) {
            const resolved = resolveArgs(
              mapping,
              expressionContext,
              deps.expressionEvaluator,
            );
            // SAFETY: resolved args are Record<string, unknown>, runtime-compatible with JsonValue
            return { output: resolved as unknown as JsonValue };
          }

          return { output: null };
        }

        case "ai": {
          const prompt = config.prompt as string | undefined;
          const model = config.model as string | undefined;
          if (!prompt) {
            throw new FridayDomainError(
              "NODE_EXECUTION_FAILED",
              "NODE_EXECUTION_FAILED: ai node missing 'prompt' in config",
              { httpStatus: 400 },
            );
          }

          // Interpolate prompt using expression context
          let interpolatedPrompt = prompt;
          const refPattern = /\$[a-zA-Z_][a-zA-Z0-9_.]*\b/g;
          for (const match of prompt.matchAll(refPattern)) {
            const refExpr = match[0];
            try {
              const val = deps.expressionEvaluator.exec(
                refExpr,
                expressionContext,
              );
              // P2-WF-002: Use replaceAll to substitute all occurrences, not just the first
              interpolatedPrompt = interpolatedPrompt.replaceAll(
                refExpr,
                String(val ?? ""),
              );
            } catch (err) {
              // Leave unresolved refs as-is
              console.warn("[friday][workflow-node-executor] ref interpolation failed:", err instanceof Error ? err.message : String(err));
            }
          }

          const result = await deps.invokeSkill(
            "ai-inference",
            input.runId,
            input.nodeId,
            { prompt: interpolatedPrompt, model },
            input.signal,
          );
          return { output: (result ?? null) as JsonValue };
        }

        case "approval": {
          // Approval nodes signal that the run should pause
          return {
            output: { approved: false, pending: true } as JsonValue,
          };
        }

        default:
          throw new FridayDomainError(
            "NODE_EXECUTION_FAILED",
            `NODE_EXECUTION_FAILED: unknown node type '${node.type}'`,
            { httpStatus: 400 },
          );
      }
    },
  };
}
