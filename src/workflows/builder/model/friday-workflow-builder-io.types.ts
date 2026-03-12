import type { ISODateTime, UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "./friday-workflow-builder-canvas.types.js";
import type { FridayWorkflowDraftEntity } from "./friday-workflow-builder-draft.types.js";
import type { FridayWorkflowBuilderValidationReport } from "./friday-workflow-builder-validation.types.js";

// ─── Export Bundle ───

export interface FridayWorkflowSpecBundleV1 {
  bundleSchemaVersion: "1.0";
  exportedAt: ISODateTime;
  source: { type: "draft" | "workflow_version"; id: UUID; workflowId: UUID };
  workflow: { slug?: string; name: string; description?: string; tags?: string[] };
  draft?: { draftId: UUID; revision: number; title: string };
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  checksum: string;
}

// ─── Import Result ───

export interface FridayWorkflowImportResult {
  draft: FridayWorkflowDraftEntity;
  validation: FridayWorkflowBuilderValidationReport;
  warnings: string[];
}
