import { z, type ZodSafeParseResult } from "zod";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";

const PermissionResourceSchema = z.enum([
  "filesystem", "network", "channel", "tool", "memory", "device", "shell",
]);

const PermissionActionSchema = z.enum([
  "read", "write", "connect", "send", "receive", "execute", "capture",
]);

const PermissionSelectorsSchema = z.object({
  pathPrefixes: z.array(z.string()).optional(),
  hostAllowlist: z.array(z.string()).optional(),
  channelIds: z.array(z.string()).optional(),
  toolAllowlist: z.array(z.string()).optional(),
  commandAllowlist: z.array(z.string()).optional(),
  memoryNamespaces: z.array(z.string()).optional(),
}).strict();

const PermissionGrantSchema = z.object({
  id: z.string().min(1),
  resource: PermissionResourceSchema,
  action: PermissionActionSchema,
  required: z.boolean(),
  reason: z.string(),
  selectors: PermissionSelectorsSchema.optional(),
}).strict();

const PermissionPromptTokenSchema = z.enum([
  "filesystem.write",
  "network.connect",
  "shell.execute",
  "channel.send",
  "device.capture",
]);

const PermissionPolicyV2Schema = z.object({
  grants: z.array(PermissionGrantSchema),
  promptOn: z.array(PermissionPromptTokenSchema),
}).strict();

const SkillKindSchema = z.enum(["conversation", "workflow", "system"]);

const SkillCategorySchema = z.enum([
  "automation", "communication", "filesystem", "browser",
  "media", "ai", "integration", "utility",
]);

const SkillRuntimeKindSchema = z.enum(["builtin", "node", "python", "shell", "remote-http"]);
const SkillInvocationModeSchema = z.enum(["intent", "workflow"]);
const SkillStepTypeSchema = z.enum(["ask", "infer", "plan", "act", "confirm", "finalize"]);

const SkillStepDefinitionSchema = z.object({
  id: z.string().min(1),
  type: SkillStepTypeSchema,
  prompt: z.string().optional(),
  collect: z.array(z.string()).optional(),
  completion: z.object({
    requiredFields: z.array(z.string()).optional(),
    customRuleId: z.string().optional(),
    minConfidence: z.number().optional(),
  }).strict(),
  transitions: z.object({
    onSuccess: z.string().nullable().optional(),
    onFailure: z.string().nullable().optional(),
  }).strict(),
  retry: z.object({
    maxAttempts: z.number(),
    backoffMs: z.number(),
  }).strict().optional(),
}).strict();

const InputDefinitionSchema = z.object({
  key: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array", "file", "secret"]),
  required: z.boolean(),
  label: z.string(),
  help: z.string().optional(),
  defaultValue: z.unknown().optional(),
  validation: z.object({
    regex: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    enum: z.array(z.string()).optional(),
  }).strict().optional(),
}).strict();

const OutputDefinitionSchema = z.object({
  key: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array", "file"]),
  description: z.string().optional(),
}).strict();

const OsSchema = z.enum(["darwin", "linux", "win32"]);
const SatelliteTypeSchema = z.enum(["phone", "desktop", "rpi", "cloud-vm"]);

export const FRIDAY_SKILL_MANIFEST_V2_SCHEMA: z.ZodType<SkillManifestV2> = z.object({
  schemaVersion: z.literal("2.0"),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  kind: SkillKindSchema,
  category: SkillCategorySchema,
  author: z.object({
    name: z.string().min(1),
    url: z.string().optional(),
    contact: z.string().optional(),
  }).strict(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  repository: z.string().optional(),
  tags: z.array(z.string()),

  runtime: z.object({
    kind: SkillRuntimeKindSchema,
    entrypoint: z.string(),
    minHubVersion: z.string().min(1),
    minSatelliteVersion: z.string().optional(),
    apiVersion: z.literal("1"),
    timeoutMsDefault: z.number().int().positive(),
  }).strict(),

  triggers: z.object({
    intents: z.array(z.string()),
    phrases: z.array(z.string()),
    channels: z.array(z.string()),
    events: z.array(z.object({
      source: z.string(),
      event: z.string(),
    }).strict()).optional(),
  }).strict(),

  invocation: z.object({
    userInvocable: z.boolean(),
    modelInvocable: z.boolean(),
    priority: z.number().int(),
    modes: z.array(SkillInvocationModeSchema),
  }).strict(),

  requirements: z.object({
    bins: z.array(z.string()),
    env: z.array(z.string()),
    config: z.array(z.string()),
    os: z.array(OsSchema),
    mcpServers: z.array(z.object({
      name: z.string().min(1),
      auth: z.enum(["connected", "authenticated"]),
    }).strict()).optional(),
  }).strict(),

  inputs: z.array(InputDefinitionSchema),
  outputs: z.array(OutputDefinitionSchema),
  permissions: PermissionPolicyV2Schema,

  schemas: z.object({
    input: z.string().nullable(),
    state: z.string().nullable(),
    output: z.string().nullable(),
  }).strict().nullable().optional(),

  flow: z.object({
    startStep: z.string().min(1),
    steps: z.array(SkillStepDefinitionSchema),
  }).strict().nullable().optional(),

  executionTargets: z.object({
    allowedSatelliteTypes: z.array(SatelliteTypeSchema),
    requiredCapabilities: z.array(z.string()),
  }).strict(),

  ui: z.object({
    icon: z.string().optional(),
    color: z.string().optional(),
    node: z.object({
      width: z.number(),
      height: z.number(),
      inputsLayout: z.enum(["left", "top"]),
      outputsLayout: z.enum(["right", "bottom"]),
    }).strict().optional(),
    forms: z.array(z.object({
      section: z.string(),
      fields: z.array(z.string()),
    }).strict()).optional(),
  }).strict().optional(),

  telemetry: z.object({
    events: z.array(z.string()),
  }).strict().optional(),

  distribution: z.object({
    integrity: z.object({
      algorithm: z.literal("sha256"),
      digest: z.string(),
    }).strict(),
    signature: z.object({
      algorithm: z.literal("ed25519"),
      keyId: z.string(),
      value: z.string(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

/** Parses and validates a fully normalized manifest. Throws on invalid input. */
export function parseFridaySkillManifestV2(input: unknown): SkillManifestV2 {
  return FRIDAY_SKILL_MANIFEST_V2_SCHEMA.parse(input);
}

/** Safe parse variant used by registry pipeline for issue aggregation. */
export function safeParseFridaySkillManifestV2(
  input: unknown,
): ZodSafeParseResult<SkillManifestV2> {
  return FRIDAY_SKILL_MANIFEST_V2_SCHEMA.safeParse(input);
}
