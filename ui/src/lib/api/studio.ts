import { apiClient } from "./client";

export type StudioLocale = "zh" | "en";
export type StudioProductId =
  | "seo_audit"
  | "research_report"
  | "html_slide_deck"
  | "wechat_miniprogram"
  | "guided_browser_automation"
  | "integration_builder";

export interface StudioLocalizedText {
  zh: string;
  en: string;
}

export interface StudioInputField {
  key: string;
  label: StudioLocalizedText;
  help?: StudioLocalizedText;
  type: "text" | "textarea" | "url" | "select" | "multiline";
  required?: boolean;
  defaultValue?: string;
  options?: Array<{ value: string; label: StudioLocalizedText }>;
}

export interface StudioProductSummary {
  id: StudioProductId;
  title: StudioLocalizedText;
  description: StudioLocalizedText;
  category: "audit" | "research" | "presentation" | "app" | "automation" | "integration";
  delivery: StudioLocalizedText;
  inputs: StudioInputField[];
  outputKinds: Array<"html" | "json" | "markdown" | "source" | "readme" | "zip">;
  firstParty: true;
  localOnly: true;
  mutatesUserComputer: false;
}

export interface StudioArtifact {
  id: string;
  kind: "html" | "json" | "markdown" | "source" | "readme" | "zip";
  label: StudioLocalizedText;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  previewable: boolean;
}

export interface StudioRun {
  id: string;
  productId: StudioProductId;
  status: "completed" | "failed";
  title: string;
  createdAt: string;
  completedAt: string;
  artifactRoot: string;
  summary: StudioLocalizedText;
  inputs: Record<string, unknown>;
  artifacts: StudioArtifact[];
  checks: Array<{
    id: string;
    label: StudioLocalizedText;
    status: "passed" | "warning" | "failed";
    detail: StudioLocalizedText;
  }>;
  nextActions: StudioLocalizedText[];
  error?: string;
}

export interface StudioRunRequest {
  productId: StudioProductId;
  inputs?: Record<string, unknown>;
  locale?: StudioLocale;
}

export interface StudioArtifactResponse {
  artifact: StudioArtifact;
  content: string;
  encoding: "utf-8" | "base64";
}

export interface StudioExportResponse {
  fileName: string;
  mimeType: "application/zip";
  base64: string;
  sizeBytes: number;
}

export interface StudioImportRequest {
  kind: "directory" | "zip";
  name?: string;
  fileName?: string;
  files?: Array<{ relativePath: string; content: string; encoding?: "utf-8" | "base64" }>;
  zipBase64?: string;
}

export interface StudioImportResponse {
  pack: {
    id: string;
    name: string;
    description: string;
    sourceKind: "directory" | "zip";
    importedAt: string;
    fileCount: number;
    rootPath: string;
    packJsonPath?: string;
    entryPrompts: string[];
    productIds: StudioProductId[];
  };
  checks: StudioRun["checks"];
}

export const studioApi = {
  listProducts(): Promise<{ products: StudioProductSummary[] }> {
    return apiClient.get("/v1/studio/products");
  },
  createRun(request: StudioRunRequest): Promise<{ run: StudioRun }> {
    return apiClient.post<StudioRunRequest, { run: StudioRun }>("/v1/studio/runs", request);
  },
  getArtifact(runId: string, artifactId: string): Promise<StudioArtifactResponse> {
    return apiClient.get(`/v1/studio/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`);
  },
  exportRun(runId: string): Promise<StudioExportResponse> {
    return apiClient.get(`/v1/studio/runs/${encodeURIComponent(runId)}/export`);
  },
  importPack(request: StudioImportRequest): Promise<StudioImportResponse> {
    return apiClient.post<StudioImportRequest, StudioImportResponse>("/v1/studio/imports", request);
  },
};
