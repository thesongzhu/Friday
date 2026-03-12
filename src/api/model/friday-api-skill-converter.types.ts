/**
 * API request/response types for skill converter endpoints.
 */

import type {
  FridayConvertedSkillDraft,
  FridaySkillConversionQualitySummary,
  FridaySkillConversionSource,
  FridaySkillSourceFormat,
} from "#skills/converter";

import type { FridaySkillValidationIssue } from "#skills";

// ─── Request types ───

export interface FridayApiConvertRequest {
  source: FridaySkillConversionSource;
  formatHint?: FridaySkillSourceFormat | "auto";
  dryRun?: boolean;
  options?: {
    splitOperations?: boolean;
    skillIdPrefix?: string;
  };
}

export interface FridayApiImportRequest {
  source: FridaySkillConversionSource;
  formatHint?: FridaySkillSourceFormat | "auto";
  target?: "managed" | "workspace" | { path: string };
  replace?: boolean;
  refreshRegistry?: boolean;
}

export interface FridayApiPackRequest {
  skillDir: string;
  outputFile: string;
}

// ─── Response types ───

export interface FridayApiListConvertersResponse {
  converters: Array<{
    id: string;
    displayName: string;
    sourceFormats: FridaySkillSourceFormat[];
  }>;
}

export interface FridayApiConvertResponse {
  converterId: string;
  detectedFormat: FridaySkillSourceFormat;
  drafts: FridayConvertedSkillDraft[];
  validation: Array<{
    skillId: string;
    ok: boolean;
    issues: FridaySkillValidationIssue[];
  }>;
  quality: FridaySkillConversionQualitySummary;
}

export interface FridayApiImportResponse {
  converterId: string;
  detectedFormat: FridaySkillSourceFormat;
  imports: Array<{
    skillId: string;
    skillDir: string;
    installed: boolean;
    issues: FridaySkillValidationIssue[];
  }>;
  registryRefreshed: boolean;
}

export interface FridayApiPackResponse {
  packageFile: string;
  checksumSha256: string;
}
