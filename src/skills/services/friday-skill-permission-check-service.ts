import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";

// ─── Interface ───

export interface FridaySkillPermissionCheckService {
  /** Check that all required permissions are granted. Returns missing permissions. */
  checkPermissions(
    manifest: SkillManifestV2,
    grantedPermissions: string[],
  ): FridayPermissionCheckResult;
}

export interface FridayPermissionCheckResult {
  allowed: boolean;
  missingRequired: string[];
  warnings: string[];
}

// ─── Factory ───

export function createFridaySkillPermissionCheckService(): FridaySkillPermissionCheckService {
  return {
    checkPermissions(manifest, grantedPermissions) {
      const grants = manifest?.permissions?.grants;
      const promptOn = manifest?.permissions?.promptOn;

      const required = Array.isArray(grants)
        ? grants
            .filter((g) => g.required)
            .map((g) => `${g.resource}.${g.action}`)
        : [];

      const granted = new Set(grantedPermissions);
      const missingRequired = required.filter((p) => !granted.has(p));

      const warnings: string[] = [];
      if (Array.isArray(promptOn)) {
        for (const prompt of promptOn) {
          if (!granted.has(prompt)) {
            warnings.push(`Permission ${prompt} requires user prompt`);
          }
        }
      }

      return {
        allowed: missingRequired.length === 0,
        missingRequired,
        warnings,
      };
    },
  };
}
