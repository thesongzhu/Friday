import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowBuilderValidationReport } from "./friday-workflow-builder-validation.types.js";

// ─── Publish Input ───

export interface FridayWorkflowBuilderPublishInput {
  draftId: UUID;
  workflowId: UUID;
  lockToken: string;
  createdByUserId?: UUID;
  changeNote?: string;
  publishNow: boolean;
}

// ─── Publish Result ───

export interface FridayWorkflowBuilderPublishResult {
  workflowId: UUID;
  workflowVersionId: UUID;
  versionNumber: number;
  published: boolean;
  checksum: string;
  validation: FridayWorkflowBuilderValidationReport;
}
