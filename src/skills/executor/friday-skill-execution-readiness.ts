import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import {
  getFridayPythonRuntimeUnavailableMessage,
  probeFridayExecutable,
  resolveFridayPythonCommand,
} from "./friday-runtime-probe.js";

type FridaySatelliteType = SkillManifestV2["executionTargets"]["allowedSatelliteTypes"][number];

export interface FridaySkillExecutionReadinessRequirements {
  bins: string[];
  env: string[];
  config: string[];
  os: Array<"darwin" | "linux" | "win32">;
  executionTargets?: {
    allowedSatelliteTypes: FridaySatelliteType[];
    requiredCapabilities: string[];
  };
}

export interface FridaySkillExecutionReadiness {
  ready: boolean;
  blockers: string[];
  requirements?: FridaySkillExecutionReadinessRequirements;
}

export interface EvaluateFridaySkillExecutionReadinessInput {
  manifest: Pick<SkillManifestV2, "runtime" | "requirements" | "executionTargets">;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  currentSatelliteType?: FridaySatelliteType;
  availableCapabilities?: readonly string[];
}

export function evaluateFridaySkillExecutionReadiness(
  input: EvaluateFridaySkillExecutionReadinessInput,
): FridaySkillExecutionReadiness {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const blockers: string[] = [];
  const requirements: FridaySkillExecutionReadinessRequirements = {
    bins: [...input.manifest.requirements.bins],
    env: [...input.manifest.requirements.env],
    config: [...input.manifest.requirements.config],
    os: [...input.manifest.requirements.os],
    executionTargets: {
      allowedSatelliteTypes: [...input.manifest.executionTargets.allowedSatelliteTypes],
      requiredCapabilities: [...input.manifest.executionTargets.requiredCapabilities],
    },
  };

  if (
    requirements.os.length > 0
    && !requirements.os.includes(platform as "darwin" | "linux" | "win32")
  ) {
    blockers.push(`Current OS "${platform}" is not supported by this skill.`);
  }

  const missingBins = requirements.bins.filter((bin) => !probeFridayExecutable(bin, env));
  if (missingBins.length > 0) {
    blockers.push(`Missing required binaries: ${missingBins.join(", ")}`);
  }

  const missingEnv = requirements.env.filter((key) => {
    const value = env[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (missingEnv.length > 0) {
    blockers.push(`Missing required environment variables: ${missingEnv.join(", ")}`);
  }

  if (requirements.config.length > 0) {
    blockers.push(`Requires unresolved config values: ${requirements.config.join(", ")}`);
  }

  if (input.manifest.runtime.kind === "python" && !resolveFridayPythonCommand(env)) {
    blockers.push(getFridayPythonRuntimeUnavailableMessage());
  }

  if (
    input.currentSatelliteType
    && requirements.executionTargets
    && requirements.executionTargets.allowedSatelliteTypes.length > 0
    && !requirements.executionTargets.allowedSatelliteTypes.includes(input.currentSatelliteType)
  ) {
    blockers.push(
      `Current execution target "${input.currentSatelliteType}" is not allowed for this skill.`,
    );
  }

  const requiredCapabilities = requirements.executionTargets?.requiredCapabilities ?? [];
  if (requiredCapabilities.length > 0) {
    if (!input.availableCapabilities) {
      blockers.push(`Required capabilities cannot be verified in this runtime: ${requiredCapabilities.join(", ")}`);
    } else {
      const available = new Set(input.availableCapabilities);
      const missingCapabilities = requiredCapabilities.filter((capability) => !available.has(capability));
      if (missingCapabilities.length > 0) {
        blockers.push(`Missing required capabilities: ${missingCapabilities.join(", ")}`);
      }
    }
  }

  const hasRequirements =
    requirements.bins.length > 0
    || requirements.env.length > 0
    || requirements.config.length > 0
    || requirements.os.length > 0
    || (requirements.executionTargets?.allowedSatelliteTypes.length ?? 0) > 0
    || (requirements.executionTargets?.requiredCapabilities.length ?? 0) > 0;

  return {
    ready: blockers.length === 0,
    blockers,
    ...(hasRequirements ? { requirements } : {}),
  };
}
