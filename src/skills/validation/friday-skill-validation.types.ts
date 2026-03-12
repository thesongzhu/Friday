export type FridaySkillValidationStage =
  | "manifest"
  | "required-files"
  | "filesystem-scope"
  | "step-graph"
  | "schema-compile"
  | "engine-compat"
  | "trust-policy";

export type FridaySkillValidationSeverity = "error" | "warning";

export interface FridaySkillValidationIssue {
  stage: FridaySkillValidationStage;
  severity: FridaySkillValidationSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface FridaySkillValidationResult {
  ok: boolean;
  issues: FridaySkillValidationIssue[];
}
