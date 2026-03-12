import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  LegacySkillPermissionV1,
  PermissionGrant,
  PermissionPolicyV2,
} from "../model/friday-skill-permission-policy.types.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import { loadFridaySkillFrontmatter } from "./friday-skill-frontmatter-parser.js";
import type { ParsedSkillFrontmatter } from "./friday-skill-frontmatter-parser.js";

export interface FridayLegacySkillMetadata {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  os?: string[];
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
}

export interface FridayLegacySkillInvocationPolicy {
  userInvocable: boolean;
  disableModelInvocation: boolean;
}

export interface AdaptFridayLegacySkillOptions {
  skillDir: string;
  workspaceDir: string;
  skillMdPath?: string;
}

export interface AdaptedFridayLegacySkill {
  skillMdPath: string;
  frontmatter: ParsedSkillFrontmatter;
  metadata?: FridayLegacySkillMetadata;
  invocation: FridayLegacySkillInvocationPolicy;
  manifest: SkillManifestV2;
  warnings: string[];
}

/** Converts legacy coarse permission shape to canonical PermissionPolicyV2 IR. */
export function mapLegacyPermissionV1ToV2(
  legacy: LegacySkillPermissionV1,
  workspaceDir: string,
): PermissionPolicyV2 {
  const grants: PermissionGrant[] = [];
  const promptOn: PermissionPolicyV2["promptOn"] = [];

  // Map tools — per §6.1.1 legacy compat table
  if (legacy.tools.length === 1 && legacy.tools[0] === "*") {
    grants.push({
      id: "legacy-tools",
      resource: "tool",
      action: "execute",
      required: false,
      reason: "Legacy skill — all tools",
    });
  } else if (legacy.tools.length > 0) {
    grants.push({
      id: "legacy-tools",
      resource: "tool",
      action: "execute",
      required: false,
      reason: "Legacy skill — selected tools",
      selectors: { toolAllowlist: [...legacy.tools] },
    });
  }

  // Map memory scope — per §6.1.1 legacy compat table
  if (legacy.memoryScope === "read") {
    grants.push({
      id: "memory.read",
      resource: "memory",
      action: "read",
      required: false,
      reason: "Legacy memory read access",
    });
  } else if (legacy.memoryScope === "readwrite") {
    grants.push({
      id: "memory.read",
      resource: "memory",
      action: "read",
      required: false,
      reason: "Legacy memory read access",
    });
    grants.push({
      id: "memory.write",
      resource: "memory",
      action: "write",
      required: false,
      reason: "Legacy memory write access",
    });
  }

  // Map network — per §6.1.1 legacy compat table
  if (legacy.network) {
    grants.push({
      id: "network.connect",
      resource: "network",
      action: "connect",
      required: false,
      reason: "Legacy network access",
      selectors: { hostAllowlist: ["*"] },
    });
    promptOn.push("network.connect");
  }

  // Map filesystem — per §6.1.1 legacy compat table
  if (legacy.filesystem === "workspace") {
    grants.push({
      id: "filesystem.read.workspace",
      resource: "filesystem",
      action: "read",
      required: false,
      reason: "Legacy workspace filesystem read access",
      selectors: { pathPrefixes: [workspaceDir] },
    });
    grants.push({
      id: "filesystem.write.workspace",
      resource: "filesystem",
      action: "write",
      required: false,
      reason: "Legacy workspace filesystem write access",
      selectors: { pathPrefixes: [workspaceDir] },
    });
    promptOn.push("filesystem.write");
  } else if (legacy.filesystem === "scoped" && legacy.filesystemScopes) {
    grants.push({
      id: "filesystem.read.scoped",
      resource: "filesystem",
      action: "read",
      required: false,
      reason: "Legacy scoped filesystem read access",
      selectors: { pathPrefixes: legacy.filesystemScopes },
    });
    grants.push({
      id: "filesystem.write.scoped",
      resource: "filesystem",
      action: "write",
      required: false,
      reason: "Legacy scoped filesystem write access",
      selectors: { pathPrefixes: legacy.filesystemScopes },
    });
    promptOn.push("filesystem.write");
  }

  return { grants, promptOn };
}

/**
 * Resolves legacy OpenClaw metadata from frontmatter.
 * Mirrors `resolveOpenClawMetadata(frontmatter)` from Clawdbot.
 */
function resolveOpenClawMetadata(
  frontmatter: ParsedSkillFrontmatter,
): FridayLegacySkillMetadata | undefined {
  const metadata: FridayLegacySkillMetadata = {};
  let hasAny = false;

  if (frontmatter.always !== undefined) {
    metadata.always = frontmatter.always === "true";
    hasAny = true;
  }
  if (frontmatter.skillKey) {
    metadata.skillKey = frontmatter.skillKey;
    hasAny = true;
  }
  if (frontmatter.primaryEnv) {
    metadata.primaryEnv = frontmatter.primaryEnv;
    hasAny = true;
  }
  if (frontmatter.emoji) {
    metadata.emoji = frontmatter.emoji;
    hasAny = true;
  }
  if (frontmatter.homepage) {
    metadata.homepage = frontmatter.homepage;
    hasAny = true;
  }
  if (frontmatter.os) {
    metadata.os = frontmatter.os.split(",").map((o) => o.trim());
    hasAny = true;
  }

  // Parse requires block from individual frontmatter keys
  const bins = frontmatter["requires.bins"];
  const env = frontmatter["requires.env"];
  const config = frontmatter["requires.config"];
  if (bins || env || config) {
    metadata.requires = {};
    if (bins) metadata.requires.bins = bins.split(",").map((b) => b.trim());
    if (env) metadata.requires.env = env.split(",").map((e) => e.trim());
    if (config) metadata.requires.config = config.split(",").map((c) => c.trim());
    hasAny = true;
  }

  return hasAny ? metadata : undefined;
}

/**
 * Resolves invocation policy from frontmatter.
 * Mirrors `resolveSkillInvocationPolicy(frontmatter)` from Clawdbot.
 */
function resolveSkillInvocationPolicy(
  frontmatter: ParsedSkillFrontmatter,
): FridayLegacySkillInvocationPolicy {
  return {
    userInvocable: frontmatter.userInvocable !== "false",
    disableModelInvocation: frontmatter.disableModelInvocation === "true",
  };
}

/**
 * Resolves skill key from directory name or frontmatter.
 * Mirrors `resolveSkillKey(skill, entry)` from Clawdbot.
 */
function resolveSkillKey(
  skillDir: string,
  frontmatter: ParsedSkillFrontmatter,
): string {
  return frontmatter.skillKey ?? basename(skillDir);
}

/**
 * Adapts `SKILL.md` frontmatter/body into a normalized `SkillManifestV2`.
 * Implements the §2.2.1 `skillEntryToManifest` conversion model exactly.
 */
export function adaptFridayLegacySkill(
  options: AdaptFridayLegacySkillOptions,
): { ok: true; value: AdaptedFridayLegacySkill } | { ok: false; error: Error } {
  const skillMdPath = options.skillMdPath ?? join(options.skillDir, "SKILL.md");

  if (!existsSync(skillMdPath)) {
    return {
      ok: false,
      error: new Error(`SKILL.md not found: ${skillMdPath}`),
    };
  }

  const loadResult = loadFridaySkillFrontmatter(skillMdPath);
  if (!loadResult.ok) {
    return {
      ok: false,
      error: new Error(loadResult.error.message),
    };
  }

  const { frontmatter, body } = loadResult.value;
  const warnings: string[] = [];

  // Resolve metadata and invocation policy per §2.2.1
  const metadata = resolveOpenClawMetadata(frontmatter);
  const invocation = resolveSkillInvocationPolicy(frontmatter);
  const skillKey = resolveSkillKey(options.skillDir, frontmatter);

  // Derive name and description from frontmatter/body
  const skillName = frontmatter.name ?? skillKey;
  const description = body.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";

  // Build manifest exactly per §2.2.1 skillEntryToManifest
  const manifest: SkillManifestV2 = {
    schemaVersion: "2.0",
    id: skillKey,
    name: skillName,
    version: "0.0.0",
    description,
    kind: "conversation",
    category: "utility",
    author: { name: "unknown" },
    tags: [],
    runtime: {
      kind: "builtin",
      entrypoint: "",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: {
      intents: [],
      phrases: [],
      channels: ["*"],
    },
    invocation: {
      userInvocable: invocation.userInvocable,
      modelInvocable: !invocation.disableModelInvocation,
      priority: 50,
      modes: ["intent"],
    },
    requirements: {
      bins: metadata?.requires?.bins ?? [],
      env: metadata?.primaryEnv ? [metadata.primaryEnv] : [],
      config: metadata?.requires?.config ?? [],
      os: (metadata?.os as Array<"darwin" | "linux" | "win32">) ?? ["darwin", "linux", "win32"],
    },
    inputs: [],
    outputs: [],
    permissions: {
      grants: [
        { id: "legacy-tools", resource: "tool", action: "execute", required: false, reason: "Legacy skill — all tools" },
        { id: "legacy-memory", resource: "memory", action: "read", required: false, reason: "Legacy skill — memory read" },
      ],
      promptOn: [],
    },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
  };

  return {
    ok: true,
    value: {
      skillMdPath,
      frontmatter,
      metadata,
      invocation,
      manifest,
      warnings,
    },
  };
}
