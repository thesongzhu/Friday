import type { ISODateTime, UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecTestAssertionOperator } from "../../model/friday-workflow-spec.types.js";

// ─── Test Case Status ───

export type FridayWorkflowTestCaseStatus = "passed" | "failed" | "skipped";

// ─── Assertion Result ───

export interface FridayWorkflowTestAssertionResult {
  path: string;
  operator: FridayWorkflowSpecTestAssertionOperator;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  message?: string;
}

// ─── Test Case Result ───

export interface FridayWorkflowTestCaseResult {
  name: string;
  status: FridayWorkflowTestCaseStatus;
  durationMs: number;
  assertionResults: FridayWorkflowTestAssertionResult[];
  error?: { code: string; message: string };
}

// ─── Test Run Result ───

export interface FridayWorkflowTestRunResult {
  runId: UUID;
  workflowId: UUID;
  draftId?: UUID;
  startedAt: ISODateTime;
  finishedAt: ISODateTime;
  passed: boolean;
  caseResults: FridayWorkflowTestCaseResult[];
}
