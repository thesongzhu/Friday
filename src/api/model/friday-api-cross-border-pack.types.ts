import type {
  FridayCrossBorderImportBatch,
  FridayCrossBorderImportKind,
  FridayCrossBorderImportSource,
  FridayCrossBorderOperatingProfile,
  FridayCrossBorderRunEvidence,
  FridayCrossBorderSnapshot,
  FridayCrossBorderWorkflowId,
} from "../../packs/cross-border/friday-cross-border-pack.types.js";

export interface FridayCrossBorderProfileResponse {
  profile: FridayCrossBorderOperatingProfile | null;
}

export interface FridayCrossBorderProfileUpdateRequest {
  regionFocus: FridayCrossBorderOperatingProfile["regionFocus"];
  storeStage: FridayCrossBorderOperatingProfile["storeStage"];
  categoryL1: string;
  categoryL2: string;
  fulfillmentMode: FridayCrossBorderOperatingProfile["fulfillmentMode"];
  priceBand: string;
  adUsage: FridayCrossBorderOperatingProfile["adUsage"];
  customerServiceMode: FridayCrossBorderOperatingProfile["customerServiceMode"];
  monitoringDepth: FridayCrossBorderOperatingProfile["monitoringDepth"];
  watchTargets: FridayCrossBorderOperatingProfile["watchTargets"];
  competitorTargets: FridayCrossBorderOperatingProfile["competitorTargets"];
}

export interface FridayCrossBorderSnapshotResponse {
  snapshot: FridayCrossBorderSnapshot;
}

export interface FridayCrossBorderImportRequest {
  kind: FridayCrossBorderImportKind;
  source: FridayCrossBorderImportSource;
  title: string;
  rawText?: string;
  publicLinks?: string[];
  fileNames?: string[];
}

export interface FridayCrossBorderImportResponse {
  importBatch: FridayCrossBorderImportBatch;
  snapshot: FridayCrossBorderSnapshot;
}

export interface FridayCrossBorderWorkflowPresetApplyRequest {
  workflowIds?: FridayCrossBorderWorkflowId[];
  timezone: string;
}

export interface FridayCrossBorderWorkflowPresetToggleRequest {
  enabled: boolean;
  timezone?: string;
}

export interface FridayCrossBorderWorkflowPresetResponse {
  snapshot: FridayCrossBorderSnapshot;
}

export interface FridayCrossBorderRunEvidenceCaptureRequest {
  workflowId: FridayCrossBorderWorkflowId;
  managedWorkflowId: string;
  status: FridayCrossBorderRunEvidence["status"];
  summary: string;
}

export interface FridayCrossBorderRunEvidenceCaptureResponse {
  evidence: FridayCrossBorderRunEvidence;
  snapshot: FridayCrossBorderSnapshot;
}

export interface FridayCrossBorderImportStaleRequest {
  importBatchId: string;
}

export interface FridayCrossBorderImportStaleResponse {
  snapshot: FridayCrossBorderSnapshot;
}

export interface FridayCrossBorderDisableAllResponse {
  snapshot: FridayCrossBorderSnapshot;
}
