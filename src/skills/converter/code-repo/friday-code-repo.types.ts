import type { FridayConvertedSkillDraft } from "../model/friday-skill-converter.types.js";

export type FridayCodeRepoCapabilityKind =
  | "http-endpoint"
  | "cli-command"
  | "script-task"
  | "library-function";

export interface FridayCodeRepoFile {
  relativePath: string;
  content: string;
}

export interface FridayCodeRepoMaterializedSource {
  rootPath: string;
  files: FridayCodeRepoFile[];
}

export interface FridayCodeRepoLanguageProfile {
  language: string;
  fileCount: number;
}

export interface FridayCodeRepoCapability {
  kind: FridayCodeRepoCapabilityKind;
  id: string;
  name: string;
  description: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface FridayCodeRepoAnalysisResult {
  sourceRoot: string;
  languages: FridayCodeRepoLanguageProfile[];
  capabilities: FridayCodeRepoCapability[];
  warnings: string[];
}

export interface FridayCodeRepoDraftPlan {
  drafts: FridayConvertedSkillDraft[];
  warnings: string[];
}

