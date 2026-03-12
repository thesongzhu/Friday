/**
 * Skill converter service interface — orchestrates detection, conversion,
 * validation, installation, and packaging.
 */

import type { FridaySkillValidationIssue } from "../../validation/friday-skill-validation.types.js";
import type {
  FridaySkillConversionSource,
  FridaySkillConverterDetection,
  FridaySkillConverterResult,
  FridaySkillSourceFormat,
} from "../model/friday-skill-converter.types.js";

// ─── Service interface ───

export interface FridaySkillConverterService {
  listConverters(): Array<{
    id: string;
    displayName: string;
    sourceFormats: FridaySkillSourceFormat[];
  }>;

  detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null>;

  convert(input: FridaySkillConvertInput): Promise<FridaySkillConvertOutput>;

  import(input: FridaySkillImportInput): Promise<FridaySkillImportOutput>;

  pack(input: FridaySkillPackInput): Promise<FridaySkillPackOutput>;
}

// ─── Input/Output types ───

export interface FridaySkillConvertInput {
  source: FridaySkillConversionSource;
  formatHint?: FridaySkillSourceFormat | "auto";
  dryRun?: boolean;
  options?: {
    splitOperations?: boolean;
    skillIdPrefix?: string;
  };
}

export interface FridaySkillConvertOutput extends FridaySkillConverterResult {
  validation: Array<{
    skillId: string;
    ok: boolean;
    issues: FridaySkillValidationIssue[];
  }>;
  quality?: FridaySkillConversionQualitySummary;
}

export interface FridaySkillConversionQualitySummary {
  score: number;
  status: "high" | "medium" | "low";
  draftPassRate: number;
  issueCounts: {
    error: number;
    warning: number;
    info: number;
  };
}

export interface FridaySkillImportInput {
  source: FridaySkillConversionSource;
  formatHint?: FridaySkillSourceFormat | "auto";
  target?: "managed" | "workspace" | { path: string };
  replace?: boolean;
  refreshRegistry?: boolean;
  dryRun?: boolean;
  options?: {
    splitOperations?: boolean;
    skillIdPrefix?: string;
  };
}

export interface FridaySkillImportOutput {
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

export interface FridaySkillPackInput {
  skillDir: string;
  outputFile: string;
}

export interface FridaySkillPackOutput {
  packageFile: string;
  checksumSha256: string;
}
