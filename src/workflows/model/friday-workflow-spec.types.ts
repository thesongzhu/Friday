import type { ISODateTime, UUID, WorkflowFailurePolicyV2 } from "./friday-workflow.types.js";

// ─── Spec Trigger ───

export type FridayWorkflowSpecTrigger =
  | { type: "manual" }
  | { type: "schedule"; cron: string; timezone: string }
  | { type: "event"; source: string; event: string };

// ─── Spec Input ───

export type FridayWorkflowSpecInputType = "string" | "number" | "boolean" | "object" | "array";

export interface FridayWorkflowSpecInput {
  key: string;
  type: FridayWorkflowSpecInputType;
  required: boolean;
  defaultValue?: unknown;
}

// ─── Spec Step ───

export type FridayWorkflowSpecStepType =
  | "skill_call"
  | "tool_call"
  | "condition"
  | "transform"
  | "human_approval";

export interface FridayWorkflowSpecStep {
  id: string;
  type: FridayWorkflowSpecStepType;
  ref?: string;
  args?: Record<string, unknown>;
  condition?: string;
  timeoutSec?: number;
  retry?: { maxAttempts: number; backoffMs: number };
}

// ─── Spec Edge ───

export type FridayWorkflowSpecEdgeWhen = "success" | "failure" | "true" | "false";

export interface FridayWorkflowSpecEdge {
  from: string;
  to: string;
  when?: FridayWorkflowSpecEdgeWhen;
}

// ─── Spec Output ───

export interface FridayWorkflowSpecOutput {
  key: string;
  fromStep: string;
  path: string;
}

// ─── Spec Test ───

export type FridayWorkflowSpecTestAssertionOperator = "==" | "!=" | ">" | "<" | "contains" | "matches";

export interface FridayWorkflowSpecMockStepResult {
  output: Record<string, unknown>;
  status?: "completed" | "failed";
}

export interface FridayWorkflowSpecTestAssertion {
  path: string;
  operator: FridayWorkflowSpecTestAssertionOperator;
  expected: unknown;
}

export interface FridayWorkflowSpecTestCase {
  name: string;
  description?: string;
  inputs: Record<string, unknown>;
  mocks?: Record<string, FridayWorkflowSpecMockStepResult>;
  assertions: FridayWorkflowSpecTestAssertion[];
}

// ─── WorkflowSpecV1 ───

export interface FridayWorkflowSpecV1 {
  schemaVersion: "1.0";
  workflowId: string;
  name: string;
  description: string;
  startStepId: string;
  trigger: FridayWorkflowSpecTrigger;
  inputs: FridayWorkflowSpecInput[];
  steps: FridayWorkflowSpecStep[];
  edges: FridayWorkflowSpecEdge[];
  outputs: FridayWorkflowSpecOutput[];
  errorPolicy: WorkflowFailurePolicyV2;
  tests: FridayWorkflowSpecTestCase[];
}
