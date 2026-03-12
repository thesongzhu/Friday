/**
 * NodeRunner Execution Framework — barrel export.
 *
 * @module node-runner/engine
 */

// ─── Pipeline (main entry point) ───

export { NodeRunnerPipeline, createNodeRunnerPipeline } from "./node-runner-pipeline.js";

// ─── Adapter Registry ───

export { NodeAdapterRegistry } from "./adapter-registry.js";
export type { NodeAdapterRegistryOptions } from "./adapter-registry.js";
export { ToolNodeAdapter } from "./tool-node-adapter.js";
export type { ToolNodeAdapterOptions, ToolNodeExecutor } from "./tool-node-adapter.js";
export { AgentNodeAdapter } from "./agent-node-adapter.js";
export type { AgentNodeAdapterOptions, AgentNodeExecutor } from "./agent-node-adapter.js";

// ─── State Machine ───

export {
  isValidTransition,
  isTerminalState,
  transition,
  getValidTargets,
  stepToActiveStatus,
} from "./state-machine.js";

// ─── Workflow Node Adapters ───

export { WorkflowTriggerAdapter } from "./workflow-trigger-adapter.js";
export { WorkflowActionAdapter } from "./workflow-action-adapter.js";
export type {
  WorkflowActionAdapterOptions,
  ActionSkillResolver,
  ActionSkillInvoker,
  ActionExpressionEvaluator,
} from "./workflow-action-adapter.js";
export { WorkflowConditionAdapter } from "./workflow-condition-adapter.js";
export type {
  WorkflowConditionAdapterOptions,
  ConditionExpressionEvaluator,
} from "./workflow-condition-adapter.js";
export { WorkflowDataAdapter } from "./workflow-data-adapter.js";
export type {
  WorkflowDataAdapterOptions,
  DataExpressionEvaluator,
} from "./workflow-data-adapter.js";
export { WorkflowAiAdapter } from "./workflow-ai-adapter.js";
export type {
  WorkflowAiAdapterOptions,
  AiExpressionEvaluator,
  AiSkillInvoker,
} from "./workflow-ai-adapter.js";
export { WorkflowApprovalAdapter } from "./workflow-approval-adapter.js";

// Re-export acceptance gate from acceptance module for convenience
export { createAcceptanceGate } from "../../acceptance/engine/acceptance-gate.js";
export type {
  AcceptanceGate,
  AcceptanceGateConfig,
  AcceptanceGateResult,
} from "../../acceptance/engine/acceptance-gate.js";

// ─── Rules Context Builders ───

export {
  mapNodeTypeToResource,
  buildPreRulesContext,
  buildPostRulesContext,
} from "./rules-context-builder.js";
