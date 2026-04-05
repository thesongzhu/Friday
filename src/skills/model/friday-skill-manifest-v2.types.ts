import type { PermissionPolicyV2 } from "./friday-skill-permission-policy.types.js";

export type SkillKind = "conversation" | "workflow" | "system";

export type SkillCategory =
  | "automation"
  | "communication"
  | "filesystem"
  | "browser"
  | "media"
  | "ai"
  | "integration"
  | "utility";

export type SkillRuntimeKind = "builtin" | "node" | "python" | "shell" | "remote-http";
export type SkillInvocationMode = "intent" | "workflow";
export type SkillStepType = "ask" | "infer" | "plan" | "act" | "confirm" | "finalize";
export type SkillMcpRequirementAuth = "connected" | "authenticated";

export interface SkillMcpServerRequirement {
  name: string;
  auth: SkillMcpRequirementAuth;
}

export interface SkillStepDefinition {
  id: string;
  type: SkillStepType;
  prompt?: string;
  collect?: string[];
  completion: {
    requiredFields?: string[];
    customRuleId?: string;
    minConfidence?: number;
  };
  transitions: {
    onSuccess?: string | null;
    onFailure?: string | null;
  };
  retry?: { maxAttempts: number; backoffMs: number };
}

export interface SkillManifestV2 {
  schemaVersion: "2.0";
  id: string;
  name: string;
  description: string;
  version: string;
  kind: SkillKind;
  category: SkillCategory;
  author: {
    name: string;
    url?: string;
    contact?: string;
  };
  homepage?: string;
  license?: string;
  repository?: string;
  tags: string[];

  runtime: {
    kind: SkillRuntimeKind;
    entrypoint: string;
    minHubVersion: string;
    minSatelliteVersion?: string;
    apiVersion: "1";
    timeoutMsDefault: number;
  };

  triggers: {
    intents: string[];
    phrases: string[];
    channels: string[];
    events?: Array<{ source: string; event: string }>;
  };

  invocation: {
    userInvocable: boolean;
    modelInvocable: boolean;
    priority: number;
    modes: SkillInvocationMode[];
  };

  requirements: {
    bins: string[];
    env: string[];
    config: string[];
    os: Array<"darwin" | "linux" | "win32">;
    mcpServers?: SkillMcpServerRequirement[];
  };

  inputs: Array<{
    key: string;
    type: "string" | "number" | "boolean" | "object" | "array" | "file" | "secret";
    required: boolean;
    label: string;
    help?: string;
    defaultValue?: unknown;
    validation?: { regex?: string; min?: number; max?: number; enum?: string[] };
  }>;

  outputs: Array<{
    key: string;
    type: "string" | "number" | "boolean" | "object" | "array" | "file";
    description?: string;
  }>;

  permissions: PermissionPolicyV2;

  schemas?: {
    input: string | null;
    state: string | null;
    output: string | null;
  } | null;

  flow?: {
    startStep: string;
    steps: SkillStepDefinition[];
  } | null;

  executionTargets: {
    allowedSatelliteTypes: Array<"phone" | "desktop" | "rpi" | "cloud-vm">;
    requiredCapabilities: string[];
  };

  ui?: {
    icon?: string;
    color?: string;
    node?: {
      width: number;
      height: number;
      inputsLayout: "left" | "top";
      outputsLayout: "right" | "bottom";
    };
    forms?: Array<{ section: string; fields: string[] }>;
  };

  telemetry?: {
    events: string[];
  };

  distribution?: {
    integrity: { algorithm: "sha256"; digest: string };
    signature?: { algorithm: "ed25519"; keyId: string; value: string };
  };
}
