import type { SkillManifestV2 } from "../../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillUiSchemaV1 } from "../../generator/model/friday-skill-ui-schema.types.js";

// ─── Source format ───

export const FRIDAY_SKILL_SOURCE_FORMATS = [
  "friday-package",
  "clawdbot-skill-md",
  "adk-skill",
  "n8n-node",
  "openai-gpt-action",
  "code-repo",
  "undocumented-api",
  "desktop-recording",
  "unknown",
] as const;

export type FridaySkillSourceFormat = (typeof FRIDAY_SKILL_SOURCE_FORMATS)[number];

export const FRIDAY_SKILL_SOURCE_FORMAT_HINTS = [
  ...FRIDAY_SKILL_SOURCE_FORMATS,
  "auto",
] as const;

// ─── Conversion source ───

export interface FridaySkillConversionSource {
  uri?: string;
  contentBase64?: string;
  formatHint?: FridaySkillSourceFormat | "auto";
}

// ─── Detection result ───

export interface FridaySkillConverterDetection {
  converterId: string;
  format: FridaySkillSourceFormat;
  confidence: number;
  reasons: string[];
}

// ─── Converted file ───

export interface FridayConvertedSkillFile {
  path: string;
  content: string;
  executable?: boolean;
}

// ─── Conversion report ───

export interface FridaySkillConversionReport {
  sourceFormat: FridaySkillSourceFormat;
  sourceRef?: string;
  convertedAt: string;
  converterId: string;
}

// ─── Converted draft ───

export interface FridayConvertedSkillDraft {
  manifest: SkillManifestV2;
  uiSchema: FridaySkillUiSchemaV1;
  files: FridayConvertedSkillFile[];
  warnings: string[];
  conversionReport: FridaySkillConversionReport;
}

// ─── Converter result ───

export interface FridaySkillConverterResult {
  converterId: string;
  detectedFormat: FridaySkillSourceFormat;
  drafts: FridayConvertedSkillDraft[];
}

// ─── Converter context ───

export interface FridaySkillConverterContext {
  workspaceDir: string;
  managedSkillsDir: string;
  nowIso: () => string;
}

// ─── Converter interface ───

export interface FridaySkillConverter {
  id: string;
  displayName: string;
  priority: number;
  detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null>;
  convert(
    source: FridaySkillConversionSource,
    ctx: FridaySkillConverterContext,
  ): Promise<FridaySkillConverterResult>;
}
