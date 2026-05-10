import type { ISODateTime, UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "./friday-workflow-builder-canvas.types.js";

// ─── Draft Status ───

export type FridayWorkflowDraftStatus = "active" | "archived" | "published" | "conflicted";

// ─── Autosave State ───

export interface FridayWorkflowDraftAutosaveState {
  enabled: boolean;
  intervalMs: number;
  lastSavedAt?: ISODateTime;
}

export interface FridayWorkflowDraftSourceReview {
  source: "deeplink.workflow_template" | "bundle_import";
  sourceUrl?: string;
  importedAt: ISODateTime;
  requiresReviewBeforePublish: boolean;
}

// ─── Draft Entity ───

export interface FridayWorkflowDraftEntity {
  draftId: UUID;
  workflowId: UUID;
  ownerUserId?: UUID;
  title: string;
  status: FridayWorkflowDraftStatus;
  revision: number;
  baseWorkflowVersionId?: UUID;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  publishedVersionId?: UUID;
  autosave: FridayWorkflowDraftAutosaveState;
  sourceReview?: FridayWorkflowDraftSourceReview;
}

// ─── Draft Save Input ───

export interface FridayWorkflowDraftSaveInput {
  draftId: UUID;
  expectedRevision: number;
  lockToken: string;
  spec?: FridayWorkflowSpecV1;
  visual?: FridayWorkflowVisualGraphV1;
  title?: string;
  autosave?: Partial<FridayWorkflowDraftAutosaveState>;
}
