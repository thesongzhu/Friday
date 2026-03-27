/**
 * Rules Engine context builders for NodeRunner pre/post evaluation.
 *
 * Constructs `FridayEvaluationContext` objects for the Rules Engine
 * at the pre-rules (Step 3) and post-rules (Step 6) pipeline stages.
 *
 * @module node-runner/engine
 */

import { FridayDomainError } from "#errors";

import type {
  FridayEvaluationContext,
  FridayRuleResource,
  JsonObject,
} from "../../rules/model/friday-rules-engine.types.js";

import type { FridayNodeExecutionContext } from "../model/friday-node-runner.types.js";

import type { WorkflowNodeType } from "../../workflows/model/friday-workflow.types.js";

// ─── Node Type → Rule Resource Mapping ───

const NODE_TYPE_RESOURCE_MAP: Readonly<Record<WorkflowNodeType, FridayRuleResource>> = {
  action: "tool",
  ai: "agent",
  condition: "workflow",
  data: "workflow",
  trigger: "workflow",
  approval: "workflow",
};

/**
 * Map a workflow node type to a Rules Engine resource.
 * Fails closed for unknown node types.
 */
export function mapNodeTypeToResource(nodeType: string): FridayRuleResource {
  if (Object.prototype.hasOwnProperty.call(NODE_TYPE_RESOURCE_MAP, nodeType)) {
    return NODE_TYPE_RESOURCE_MAP[nodeType as WorkflowNodeType];
  }
  throw new FridayDomainError("VALIDATION_ERROR", `No rules resource mapping defined for node type "${nodeType}"`, { httpStatus: 400 });
}

// ─── Pre-Rules Context ───

/**
 * Build a `FridayEvaluationContext` for pre-rules evaluation (Step 3).
 *
 * Uses the validated input as args, with node metadata for policy matching.
 */
export function buildPreRulesContext(
  ctx: FridayNodeExecutionContext,
  adapterNodeType: string,
): FridayEvaluationContext {
  return {
    resource: mapNodeTypeToResource(ctx.node.type),
    action: "execute",
    args: (ctx.validatedInput ?? ctx.inputData) as JsonObject,
    source: "workflow",
    workflowId: ctx.workflowId,
    workflowRunId: ctx.runId,
    nodeId: ctx.nodeId,
    metadata: {
      nodeType: ctx.node.type,
      adapterId: adapterNodeType,
    },
  };
}

// ─── Post-Rules Context ───

/**
 * Build a `FridayEvaluationContext` for post-rules evaluation (Step 6).
 *
 * Includes the execution output in args under `_output` for post-execution
 * policy checks (e.g., output content filtering).
 */
export function buildPostRulesContext(
  ctx: FridayNodeExecutionContext,
  adapterNodeType: string,
  executeDurationMs: number,
): FridayEvaluationContext {
  const inputArgs = (ctx.validatedInput ?? ctx.inputData) as JsonObject;
  const outputValue = ctx.validatedOutput ?? ctx.output;

  return {
    resource: mapNodeTypeToResource(ctx.node.type),
    action: "execute",
    args: {
      ...inputArgs,
      _output: (outputValue ?? null) as JsonObject,
    },
    source: "workflow",
    workflowId: ctx.workflowId,
    workflowRunId: ctx.runId,
    nodeId: ctx.nodeId,
    metadata: {
      nodeType: ctx.node.type,
      adapterId: adapterNodeType,
      phase: "post",
      durationMs: executeDurationMs,
    },
  };
}
