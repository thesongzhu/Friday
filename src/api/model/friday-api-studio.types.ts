export type FridayStudioLocale = "zh" | "en";

export type FridayStudioProductId =
  | "seo_audit"
  | "research_report"
  | "html_slide_deck"
  | "wechat_miniprogram"
  | "guided_browser_automation"
  | "integration_builder";

export type FridayStudioArtifactKind =
  | "html"
  | "json"
  | "markdown"
  | "source"
  | "readme"
  | "zip";

export type FridayStudioRunStatus = "completed" | "failed";

export interface FridayStudioLocalizedText {
  zh: string;
  en: string;
}

export interface FridayStudioInputField {
  key: string;
  label: FridayStudioLocalizedText;
  help?: FridayStudioLocalizedText;
  type: "text" | "textarea" | "url" | "select" | "multiline";
  required?: boolean;
  defaultValue?: string;
  options?: Array<{
    value: string;
    label: FridayStudioLocalizedText;
  }>;
}

export interface FridayStudioProductSummary {
  id: FridayStudioProductId;
  title: FridayStudioLocalizedText;
  description: FridayStudioLocalizedText;
  category: "audit" | "research" | "presentation" | "app" | "automation" | "integration";
  delivery: FridayStudioLocalizedText;
  inputs: FridayStudioInputField[];
  outputKinds: FridayStudioArtifactKind[];
  firstParty: true;
  localOnly: true;
  mutatesUserComputer: false;
}

export interface FridayStudioArtifact {
  id: string;
  kind: FridayStudioArtifactKind;
  label: FridayStudioLocalizedText;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  previewable: boolean;
}

export interface FridayStudioRun {
  id: string;
  productId: FridayStudioProductId;
  status: FridayStudioRunStatus;
  title: string;
  createdAt: string;
  completedAt: string;
  artifactRoot: string;
  summary: FridayStudioLocalizedText;
  inputs: Record<string, unknown>;
  artifacts: FridayStudioArtifact[];
  checks: Array<{
    id: string;
    label: FridayStudioLocalizedText;
    status: "passed" | "warning" | "failed";
    detail: FridayStudioLocalizedText;
  }>;
  nextActions: FridayStudioLocalizedText[];
  error?: string;
}

export interface FridayStudioRunRequest {
  productId: FridayStudioProductId;
  inputs?: Record<string, unknown>;
  locale?: FridayStudioLocale;
  deliveryTarget?: {
    kind: "artifact_store" | "workspace" | "user_directory";
    path?: string;
  };
}

export interface FridayStudioProductsResponse {
  products: FridayStudioProductSummary[];
}

export interface FridayStudioRunResponse {
  run: FridayStudioRun;
}

export interface FridayStudioArtifactResponse {
  artifact: FridayStudioArtifact;
  content: string;
  encoding: "utf-8" | "base64";
}

export interface FridayStudioExportResponse {
  fileName: string;
  mimeType: "application/zip";
  base64: string;
  sizeBytes: number;
}

export interface FridayStudioImportFileInput {
  relativePath: string;
  content: string;
  encoding?: "utf-8" | "base64";
}

export interface FridayStudioImportRequest {
  kind: "directory" | "zip";
  name?: string;
  files?: FridayStudioImportFileInput[];
  zipBase64?: string;
  fileName?: string;
}

export interface FridayStudioImportedPack {
  id: string;
  name: string;
  description: string;
  sourceKind: "directory" | "zip";
  importedAt: string;
  fileCount: number;
  rootPath: string;
  packJsonPath?: string;
  entryPrompts: string[];
  productIds: FridayStudioProductId[];
}

export interface FridayStudioImportResponse {
  pack: FridayStudioImportedPack;
  checks: FridayStudioRun["checks"];
}

export interface FridayStudioArtifactCandidateValidation {
  valid: boolean;
  candidateLabel: string;
  candidateDescription: string;
  inferredCapabilities: string[];
  permissions: string[];
  operationCount: number;
  risks: string[];
  trustTier: "generated";
  sourceType: "studio_artifact";
  checks: FridayStudioRun["checks"];
}

export interface FridayStudioArtifactCandidateResponse {
  validation: FridayStudioArtifactCandidateValidation;
  run: FridayStudioRun;
  candidates: FridayStudioCapabilityCandidate[];
}

export interface FridayStudioCapabilityCandidate {
  id: string;
  capability: string;
  sourceType: "studio_artifact";
  trustTier: "generated";
  label: string;
  description: string;
  risks: string[];
  requiresApproval: true;
  requiresHuman: boolean;
  rank: number;
}
