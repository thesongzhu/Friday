export type SkillTrustTier = "bundled" | "managed" | "workspace" | "extra";
export type SkillExecutionMode = "trusted" | "restricted" | "isolated";

export interface SkillSandboxPolicy {
  trustTier: SkillTrustTier;
  defaultExecutionMode: SkillExecutionMode;
  allowedExecutionModes: SkillExecutionMode[];
}
