import { apiClient } from "./client";
import type {
  FridayCrossBorderImportBatch,
  FridayCrossBorderImportKind,
  FridayCrossBorderImportSource,
  FridayCrossBorderOperatingProfile,
  FridayCrossBorderSnapshot,
  FridayCrossBorderWatchTarget,
  FridayCrossBorderCompetitorTarget,
  FridayCrossBorderWorkflowId,
} from "../../../../src/packs/cross-border/friday-cross-border-pack.types";

export interface CrossBorderProfileInput {
  regionFocus: FridayCrossBorderOperatingProfile["regionFocus"];
  storeStage: FridayCrossBorderOperatingProfile["storeStage"];
  categoryL1: string;
  categoryL2: string;
  fulfillmentMode: FridayCrossBorderOperatingProfile["fulfillmentMode"];
  priceBand: string;
  adUsage: FridayCrossBorderOperatingProfile["adUsage"];
  customerServiceMode: FridayCrossBorderOperatingProfile["customerServiceMode"];
  monitoringDepth: FridayCrossBorderOperatingProfile["monitoringDepth"];
  watchTargets: FridayCrossBorderWatchTarget[];
  competitorTargets: FridayCrossBorderCompetitorTarget[];
}

export interface CrossBorderImportInput {
  kind: FridayCrossBorderImportKind;
  source: FridayCrossBorderImportSource;
  title: string;
  rawText?: string;
  publicLinks?: string[];
  fileNames?: string[];
}

export interface CrossBorderWorkflowPresetApplyInput {
  workflowIds?: FridayCrossBorderWorkflowId[];
  timezone: string;
}

export interface CrossBorderWorkflowPresetToggleInput {
  enabled: boolean;
  timezone?: string;
}

interface CrossBorderProfileResponse {
  profile: FridayCrossBorderOperatingProfile | null;
}

interface CrossBorderSnapshotResponse {
  snapshot: FridayCrossBorderSnapshot;
}

interface CrossBorderImportResponse {
  importBatch: FridayCrossBorderImportBatch;
  snapshot: FridayCrossBorderSnapshot;
}

interface CrossBorderWorkflowPresetResponse {
  snapshot: FridayCrossBorderSnapshot;
}

export const crossBorderPackApi = {
  async getProfile(): Promise<FridayCrossBorderOperatingProfile | null> {
    const data = await apiClient.get<CrossBorderProfileResponse>("/v1/packs/cross-border/profile");
    return data.profile;
  },

  async saveProfile(profile: CrossBorderProfileInput): Promise<FridayCrossBorderOperatingProfile> {
    const data = await apiClient.put<CrossBorderProfileInput, CrossBorderProfileResponse>("/v1/packs/cross-border/profile", profile);
    if (!data.profile) {
      throw new Error("Cross-border profile was not returned.");
    }
    return data.profile;
  },

  async getSnapshot(): Promise<FridayCrossBorderSnapshot> {
    const data = await apiClient.get<CrossBorderSnapshotResponse>("/v1/packs/cross-border/snapshot");
    return data.snapshot;
  },

  async importData(payload: CrossBorderImportInput): Promise<CrossBorderImportResponse> {
    return apiClient.post<CrossBorderImportInput, CrossBorderImportResponse>("/v1/packs/cross-border/import", payload);
  },

  async applyWorkflowPreset(payload: CrossBorderWorkflowPresetApplyInput): Promise<FridayCrossBorderSnapshot> {
    const data = await apiClient.post<CrossBorderWorkflowPresetApplyInput, CrossBorderWorkflowPresetResponse>(
      "/v1/packs/cross-border/workflow-presets/apply",
      payload,
    );
    return data.snapshot;
  },

  async setWorkflowPresetEnabled(
    workflowId: FridayCrossBorderWorkflowId,
    payload: CrossBorderWorkflowPresetToggleInput,
  ): Promise<FridayCrossBorderSnapshot> {
    const data = await apiClient.patch<CrossBorderWorkflowPresetToggleInput, CrossBorderWorkflowPresetResponse>(
      `/v1/packs/cross-border/workflow-presets/${encodeURIComponent(workflowId)}`,
      payload,
    );
    return data.snapshot;
  },
};
