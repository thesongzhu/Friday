import type { SkillCategory, SkillInvocationMode, SkillKind, SkillManifestV2, SkillRuntimeKind } from "../model/friday-skill-manifest-v2.types.js";

type ManifestDefaults = Readonly<Omit<SkillManifestV2, "id" | "name" | "description" | "version">>;

/** Immutable defaults used before schema validation. */
export const FRIDAY_SKILL_MANIFEST_DEFAULTS: ManifestDefaults = Object.freeze({
  schemaVersion: "2.0" as const,
  kind: "conversation" as SkillKind,
  category: "utility" as SkillCategory,
  author: { name: "unknown" },
  tags: [] as string[],
  runtime: {
    kind: "builtin" as SkillRuntimeKind,
    entrypoint: "",
    minHubVersion: "1.0.0",
    apiVersion: "1" as const,
    timeoutMsDefault: 30_000,
  },
  triggers: {
    intents: [] as string[],
    phrases: [] as string[],
    channels: ["*"] as string[],
  },
  invocation: {
    userInvocable: true,
    modelInvocable: true,
    priority: 50,
    modes: ["intent"] as SkillInvocationMode[],
  },
  requirements: {
    bins: [] as string[],
    env: [] as string[],
    config: [] as string[],
    os: ["darwin", "linux", "win32"] as Array<"darwin" | "linux" | "win32">,
    mcpServers: [] as NonNullable<SkillManifestV2["requirements"]["mcpServers"]>,
  },
  inputs: [] as SkillManifestV2["inputs"],
  outputs: [] as SkillManifestV2["outputs"],
  permissions: {
    grants: [] as SkillManifestV2["permissions"]["grants"],
    promptOn: [] as SkillManifestV2["permissions"]["promptOn"],
  },
  schemas: null,
  flow: null,
  executionTargets: {
    allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"] as Array<"phone" | "desktop" | "rpi" | "cloud-vm">,
    requiredCapabilities: [] as string[],
  },
  telemetry: {
    events: [] as string[],
  },
});

/** Applies documented defaults and returns a fully-populated manifest candidate. */
export function applyFridaySkillManifestDefaults(
  raw: Record<string, unknown>,
): SkillManifestV2 {
  const defaults = FRIDAY_SKILL_MANIFEST_DEFAULTS;

  const rawRuntime = (raw.runtime ?? {}) as Record<string, unknown>;
  const rawTriggers = (raw.triggers ?? {}) as Record<string, unknown>;
  const rawInvocation = (raw.invocation ?? {}) as Record<string, unknown>;
  const rawRequirements = (raw.requirements ?? {}) as Record<string, unknown>;
  const rawPermissions = (raw.permissions ?? {}) as Record<string, unknown>;
  const rawExecutionTargets = (raw.executionTargets ?? {}) as Record<string, unknown>;

  return {
    schemaVersion: (raw.schemaVersion as SkillManifestV2["schemaVersion"]) ?? defaults.schemaVersion,
    id: raw.id as string,
    name: raw.name as string,
    description: raw.description as string,
    version: raw.version as string,
    kind: (raw.kind as SkillManifestV2["kind"]) ?? defaults.kind,
    category: (raw.category as SkillManifestV2["category"]) ?? defaults.category,
    author: (raw.author as SkillManifestV2["author"]) ?? { ...defaults.author },
    homepage: raw.homepage as string | undefined,
    license: raw.license as string | undefined,
    tags: (raw.tags as string[]) ?? [...defaults.tags],

    runtime: {
      kind: (rawRuntime.kind as SkillManifestV2["runtime"]["kind"]) ?? defaults.runtime.kind,
      entrypoint: (rawRuntime.entrypoint as string) ?? defaults.runtime.entrypoint,
      minHubVersion: (rawRuntime.minHubVersion as string) ?? defaults.runtime.minHubVersion,
      minSatelliteVersion: rawRuntime.minSatelliteVersion as string | undefined,
      apiVersion: (rawRuntime.apiVersion as "1") ?? defaults.runtime.apiVersion,
      timeoutMsDefault: (rawRuntime.timeoutMsDefault as number) ?? defaults.runtime.timeoutMsDefault,
    },

    triggers: {
      intents: (rawTriggers.intents as string[]) ?? [...defaults.triggers.intents],
      phrases: (rawTriggers.phrases as string[]) ?? [...defaults.triggers.phrases],
      channels: (rawTriggers.channels as string[]) ?? [...defaults.triggers.channels],
      events: rawTriggers.events as SkillManifestV2["triggers"]["events"],
    },

    invocation: {
      userInvocable: (rawInvocation.userInvocable as boolean) ?? defaults.invocation.userInvocable,
      modelInvocable: (rawInvocation.modelInvocable as boolean) ?? defaults.invocation.modelInvocable,
      priority: (rawInvocation.priority as number) ?? defaults.invocation.priority,
      modes: (rawInvocation.modes as SkillManifestV2["invocation"]["modes"]) ?? [...defaults.invocation.modes],
    },

    requirements: {
      bins: (rawRequirements.bins as string[]) ?? [...defaults.requirements.bins],
      env: (rawRequirements.env as string[]) ?? [...defaults.requirements.env],
      config: (rawRequirements.config as string[]) ?? [...defaults.requirements.config],
      os: (rawRequirements.os as SkillManifestV2["requirements"]["os"]) ?? [...defaults.requirements.os],
      mcpServers:
        (rawRequirements.mcpServers as SkillManifestV2["requirements"]["mcpServers"]) ??
        [...(defaults.requirements.mcpServers ?? [])],
    },

    inputs: (raw.inputs as SkillManifestV2["inputs"]) ?? [...defaults.inputs],
    outputs: (raw.outputs as SkillManifestV2["outputs"]) ?? [...defaults.outputs],

    permissions: {
      grants: (rawPermissions.grants as SkillManifestV2["permissions"]["grants"]) ?? [...defaults.permissions.grants],
      promptOn: (rawPermissions.promptOn as SkillManifestV2["permissions"]["promptOn"]) ?? [...defaults.permissions.promptOn],
    },

    schemas: (raw.schemas as SkillManifestV2["schemas"]) ?? defaults.schemas,
    flow: (raw.flow as SkillManifestV2["flow"]) ?? defaults.flow,

    executionTargets: {
      allowedSatelliteTypes:
        (rawExecutionTargets.allowedSatelliteTypes as SkillManifestV2["executionTargets"]["allowedSatelliteTypes"]) ??
        [...defaults.executionTargets.allowedSatelliteTypes],
      requiredCapabilities:
        (rawExecutionTargets.requiredCapabilities as string[]) ??
        [...defaults.executionTargets.requiredCapabilities],
    },

    ui: raw.ui as SkillManifestV2["ui"],
    telemetry: (raw.telemetry as SkillManifestV2["telemetry"]) ?? { ...defaults.telemetry, events: [...defaults.telemetry!.events] },
    distribution: raw.distribution as SkillManifestV2["distribution"],
  };
}
