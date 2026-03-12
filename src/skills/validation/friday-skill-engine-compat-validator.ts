import semver from "semver";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillValidationIssue } from "./friday-skill-validation.types.js";

export interface FridaySkillEngineCompatibilityContext {
  hubVersion: string;
  supportedApiVersions: string[];
}

/** Validates skill runtime compatibility against current hub/api versions. */
export function validateFridaySkillEngineCompatibility(
  manifest: SkillManifestV2,
  context: FridaySkillEngineCompatibilityContext,
): FridaySkillValidationIssue[] {
  const issues: FridaySkillValidationIssue[] = [];

  // Check API version compatibility
  if (!context.supportedApiVersions.includes(manifest.runtime.apiVersion)) {
    issues.push({
      stage: "engine-compat",
      severity: "error",
      code: "UNSUPPORTED_API_VERSION",
      message: `Skill requires API version "${manifest.runtime.apiVersion}" but hub supports [${context.supportedApiVersions.join(", ")}]`,
    });
  }

  // Check minHubVersion compatibility
  const minHub = semver.valid(semver.coerce(manifest.runtime.minHubVersion));
  const currentHub = semver.valid(semver.coerce(context.hubVersion));

  if (minHub && currentHub) {
    if (semver.gt(minHub, currentHub)) {
      issues.push({
        stage: "engine-compat",
        severity: "error",
        code: "HUB_VERSION_TOO_LOW",
        message: `Skill requires hub version >=${manifest.runtime.minHubVersion} but current hub is ${context.hubVersion}`,
      });
    }
  } else {
    // If versions can't be parsed, warn
    if (!minHub) {
      issues.push({
        stage: "engine-compat",
        severity: "warning",
        code: "INVALID_MIN_HUB_VERSION",
        message: `Cannot parse minHubVersion: "${manifest.runtime.minHubVersion}"`,
      });
    }
    if (!currentHub) {
      issues.push({
        stage: "engine-compat",
        severity: "warning",
        code: "INVALID_HUB_VERSION",
        message: `Cannot parse hub version: "${context.hubVersion}"`,
      });
    }
  }

  return issues;
}
