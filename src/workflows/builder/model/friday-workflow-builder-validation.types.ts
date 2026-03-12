import type { ISODateTime } from "../../model/friday-workflow.types.js";
import type { FridayCompiledWorkflowGraphV2 } from "../../model/friday-workflow-graph.types.js";

// ─── Validation Severity and Stage ───

export type FridayWorkflowValidationSeverity = "error" | "warning" | "info";

export type FridayWorkflowValidationStage =
  | "spec_schema"
  | "graph_compile"
  | "compiled_graph"
  | "skill_refs"
  | "expressions"
  | "tests"
  | "canvas";

// ─── Validation Issue ───

export interface FridayWorkflowBuilderValidationIssue {
  code: string;
  stage: FridayWorkflowValidationStage;
  severity: FridayWorkflowValidationSeverity;
  message: string;
  jsonPath?: string;
  stepId?: string;
  edgeRef?: { from: string; to: string; when?: "success" | "failure" | "true" | "false" };
}

// ─── Validation Report ───

export interface FridayWorkflowBuilderValidationReport {
  valid: boolean;
  issues: FridayWorkflowBuilderValidationIssue[];
  compiledGraphPreview?: FridayCompiledWorkflowGraphV2;
  generatedAt: ISODateTime;
}
