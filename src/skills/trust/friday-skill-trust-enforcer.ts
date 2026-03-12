import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { SkillOrigin } from "../model/friday-skill-source.types.js";
import type {
  SkillExecutionMode,
  SkillSandboxPolicy,
  SkillTrustTier,
} from "../model/friday-skill-trust.types.js";
import type { FridaySkillValidationIssue } from "../validation/friday-skill-validation.types.js";

export interface FridaySkillSecurityProfile {
  policyOverridesByTier?: Partial<Record<SkillTrustTier, Partial<SkillSandboxPolicy>>>;
  forcedExecutionModeBySkillId?: Record<string, SkillExecutionMode>;
}

export interface FridaySkillTrustDecision {
  trustTier: SkillTrustTier;
  sandboxPolicy: SkillSandboxPolicy;
  executionMode: SkillExecutionMode;
  requiredPermissionIds: string[];
  optionalPermissionIds: string[];
}

/** Maps skill origin to trust tier (workspace/.agents => workspace trust tier). */
export function mapFridaySkillOriginToTrustTier(origin: SkillOrigin): SkillTrustTier {
  switch (origin) {
    case "bundled":
      return "bundled";
    case "managed":
      return "managed";
    case "workspace":
    case "agents-skills-personal":
    case "agents-skills-project":
      return "workspace";
    case "extra":
      return "extra";
  }
}

/** Returns default sandbox policy for a trust tier. */
export function getFridayDefaultSandboxPolicy(trustTier: SkillTrustTier): SkillSandboxPolicy {
  switch (trustTier) {
    case "bundled":
      return {
        trustTier: "bundled",
        defaultExecutionMode: "trusted",
        allowedExecutionModes: ["trusted", "restricted", "isolated"],
      };
    case "managed":
      return {
        trustTier: "managed",
        defaultExecutionMode: "restricted",
        allowedExecutionModes: ["restricted", "isolated"],
      };
    case "workspace":
      return {
        trustTier: "workspace",
        defaultExecutionMode: "isolated",
        allowedExecutionModes: ["restricted", "isolated"],
      };
    case "extra":
      return {
        trustTier: "extra",
        defaultExecutionMode: "isolated",
        allowedExecutionModes: ["isolated"],
      };
  }
}

/** Enforces trust + execution mode policy and returns issues if blocked. */
export function enforceFridaySkillTrust(input: {
  manifest: SkillManifestV2;
  origin: SkillOrigin;
  requestedExecutionMode?: SkillExecutionMode;
  securityProfile?: FridaySkillSecurityProfile;
}): { decision?: FridaySkillTrustDecision; issues: FridaySkillValidationIssue[] } {
  const { manifest, origin, requestedExecutionMode, securityProfile } = input;
  const issues: FridaySkillValidationIssue[] = [];

  const trustTier = mapFridaySkillOriginToTrustTier(origin);
  let sandboxPolicy = getFridayDefaultSandboxPolicy(trustTier);

  // Apply tier-level overrides from security profile
  if (securityProfile?.policyOverridesByTier?.[trustTier]) {
    const overrides = securityProfile.policyOverridesByTier[trustTier];
    sandboxPolicy = { ...sandboxPolicy, ...overrides };
  }

  // Determine execution mode
  let executionMode = sandboxPolicy.defaultExecutionMode;

  // Check forced execution mode by skill ID
  if (securityProfile?.forcedExecutionModeBySkillId?.[manifest.id]) {
    executionMode = securityProfile.forcedExecutionModeBySkillId[manifest.id]!;
  } else if (requestedExecutionMode) {
    executionMode = requestedExecutionMode;
  }

  // Validate requested mode is allowed
  if (!sandboxPolicy.allowedExecutionModes.includes(executionMode)) {
    issues.push({
      stage: "trust-policy",
      severity: "error",
      code: "EXECUTION_MODE_DISALLOWED",
      message: `Execution mode "${executionMode}" is not allowed for trust tier "${trustTier}" (allowed: [${sandboxPolicy.allowedExecutionModes.join(", ")}])`,
    });
    return { issues };
  }

  // Partition permissions into required and optional
  const requiredPermissionIds = manifest.permissions.grants
    .filter((g) => g.required)
    .map((g) => g.id);

  const optionalPermissionIds = manifest.permissions.grants
    .filter((g) => !g.required)
    .map((g) => g.id);

  return {
    decision: {
      trustTier,
      sandboxPolicy,
      executionMode,
      requiredPermissionIds,
      optionalPermissionIds,
    },
    issues,
  };
}
