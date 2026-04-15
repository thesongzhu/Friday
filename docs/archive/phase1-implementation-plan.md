> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 1 Plan: Skill Runtime/Registry + Manifest V2 Loader + Legacy Adapter

## Scope Guardrails
- Add only new files under `src/` (no edits to Phase 0 files in `src/config/` or `src/state/`).
- `skill.manifest.json` is primary; `SKILL.md` frontmatter is fallback.
- Loader flow is deterministic: read -> defaults -> Zod validate -> pipeline validate -> trust enforce -> registry snapshot.
- Registry precedence is preserved exactly: `extra < bundled < managed < agents-skills-personal < agents-skills-project < workspace`.

## New `src/` File Tree (new files only)
```text
src/
  skills/
    model/
      friday-skill-permission-policy.types.ts
      friday-skill-manifest-v2.types.ts
      friday-skill-source.types.ts
      friday-skill-trust.types.ts
      friday-skill-lifecycle.types.ts
      friday-skill-runtime.types.ts
    manifest/
      friday-skill-manifest-defaults.ts
      friday-skill-manifest.schema.ts
      friday-skill-manifest-loader.ts
      friday-skill-frontmatter-parser.ts
      friday-skill-legacy-adapter.ts
      friday-skill-package-loader.ts
    validation/
      friday-skill-validation.types.ts
      friday-skill-filesystem-scope-validator.ts
      friday-skill-step-graph-validator.ts
      friday-skill-schema-compiler.ts
      friday-skill-engine-compat-validator.ts
      friday-skill-validation-pipeline.ts
    trust/
      friday-skill-trust-enforcer.ts
    lifecycle/
      friday-skill-lifecycle-machine.ts
    registry/
      friday-skill-registry.types.ts
      friday-skill-discovery.ts
      friday-skill-watcher.ts
      friday-skill-registry.ts
    index.ts
  hub/
    services/
      friday-hub-gateway-ingress.types.ts
      friday-hub-config-manager.types.ts
      friday-hub-memory-state.types.ts
      index.ts
```

## File-by-File Contracts

### `src/skills/model/friday-skill-permission-policy.types.ts`
Purpose: Canonical permission IR from arch doc §6.1.1 + legacy V1 mapping input shape.
```ts
export type PermissionResource =
  | "filesystem"
  | "network"
  | "channel"
  | "tool"
  | "memory"
  | "device"
  | "shell";

export type PermissionAction =
  | "read"
  | "write"
  | "connect"
  | "send"
  | "receive"
  | "execute"
  | "capture";

export interface PermissionSelectors {
  pathPrefixes?: string[];
  hostAllowlist?: string[];
  channelIds?: string[];
  toolAllowlist?: string[];
  commandAllowlist?: string[];
  memoryNamespaces?: string[];
}

export interface PermissionGrant {
  id: string;
  resource: PermissionResource;
  action: PermissionAction;
  required: boolean;
  reason: string;
  selectors?: PermissionSelectors;
}

export type PermissionPromptToken =
  | "filesystem.write"
  | "network.connect"
  | "shell.execute"
  | "channel.send"
  | "device.capture";

export interface PermissionPolicyV2 {
  grants: PermissionGrant[];
  promptOn: PermissionPromptToken[];
}

export interface LegacySkillPermissionV1 {
  tools: string[];
  memoryScope: "none" | "read" | "readwrite";
  network: boolean;
  filesystem: "none" | "workspace" | "scoped";
  filesystemScopes?: string[];
}
```

### `src/skills/model/friday-skill-manifest-v2.types.ts`
Purpose: Authoritative `SkillManifestV2` contract from arch doc §6.1.
```ts
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
```

### `src/skills/model/friday-skill-source.types.ts`
Purpose: Source/origin taxonomy + precedence from arch doc §6.6.
```ts
export type SkillSource = "bundled" | "marketplace" | "git" | "local";

export type SkillOrigin =
  | "extra"
  | "bundled"
  | "managed"
  | "agents-skills-personal"
  | "agents-skills-project"
  | "workspace";

export const SKILL_ORIGIN_PRECEDENCE: SkillOrigin[];

/** Returns precedence index where larger value means higher collision priority. */
export function getSkillOriginPrecedence(origin: SkillOrigin): number;

/** Returns >0 when left should win collision over right. */
export function compareSkillOrigins(left: SkillOrigin, right: SkillOrigin): number;
```

### `src/skills/model/friday-skill-trust.types.ts`
Purpose: Trust tier/sandbox types from arch doc §6.4.
```ts
export type SkillTrustTier = "bundled" | "managed" | "workspace" | "extra";
export type SkillExecutionMode = "trusted" | "restricted" | "isolated";

export interface SkillSandboxPolicy {
  trustTier: SkillTrustTier;
  defaultExecutionMode: SkillExecutionMode;
  allowedExecutionModes: SkillExecutionMode[];
}
```

### `src/skills/model/friday-skill-lifecycle.types.ts`
Purpose: Unified status model from arch doc §6.2 + lifecycle operations.
```ts
export type SkillLifecycleStatus =
  | "not_installed"
  | "installed"
  | "disabled"
  | "error"
  | "upgrade_available";

export type SkillLifecycleOperation =
  | "discover"
  | "install"
  | "verify"
  | "activate"
  | "disable"
  | "enable"
  | "update"
  | "uninstall"
  | "mark_error"
  | "detect_upgrade"
  | "clear_upgrade";

export interface FridaySkillLifecycleTransition {
  from: SkillLifecycleStatus;
  operation: SkillLifecycleOperation;
  to: SkillLifecycleStatus;
}
```

### `src/skills/model/friday-skill-runtime.types.ts`
Purpose: Runtime lifecycle interfaces from skill-system doc §2.6.
```ts
import type { SkillManifestV2 } from "./friday-skill-manifest-v2.types.js";

export type SkillRunStatus =
  | "running"
  | "waiting_for_user"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type SkillRunState<TState> = {
  runId: string;
  skillId: string;
  version: string;
  status: SkillRunStatus;
  currentStepId: string;
  attemptsByStep: Record<string, number>;
  state: TState;
  startedAt: string;
  updatedAt: string;
};

export type SkillInitContext<TInput> = {
  input: TInput;
  sessionId: string;
  userId: string;
  channel: string;
  nowIso: string;
};

export type ToolRequestItem = {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
};

export type ToolResultItem = {
  requestId: string;
  tool: string;
  ok: boolean;
  payload: unknown;
};

export type SkillExecuteContext<TInput, TState> = {
  input: TInput;
  run: SkillRunState<TState>;
  userMessage?: string;
  toolResults?: ToolResultItem[];
};

export type SkillExecutionResult<TState, TOutput> = {
  run: SkillRunState<TState>;
  messages: Array<{ role: "assistant" | "system"; text: string }>;
  requestedTools?: ToolRequestItem[];
  output?: TOutput;
};

export type SkillTeardownContext<TState> = {
  run: SkillRunState<TState>;
  reason: "completed" | "failed" | "cancelled";
};

export interface FridaySkill<TInput, TState, TOutput> {
  manifest: SkillManifestV2;
  init(ctx: SkillInitContext<TInput>): Promise<SkillRunState<TState>>;
  execute(ctx: SkillExecuteContext<TInput, TState>): Promise<SkillExecutionResult<TState, TOutput>>;
  teardown(ctx: SkillTeardownContext<TState>): Promise<void>;
}
```

### `src/skills/manifest/friday-skill-manifest-defaults.ts`
Purpose: Minimal authoring defaults/normalization from skill-system doc §2.4.
```ts
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";

/** Immutable defaults used before schema validation. */
export const FRIDAY_SKILL_MANIFEST_DEFAULTS: Readonly<Omit<
  SkillManifestV2,
  "id" | "name" | "description" | "version"
>>;

/** Applies documented defaults and returns a fully-populated manifest candidate. */
export function applyFridaySkillManifestDefaults(raw: Record<string, unknown>): SkillManifestV2;
```

### `src/skills/manifest/friday-skill-manifest.schema.ts`
Purpose: Zod schema validation for full `SkillManifestV2`.
```ts
import { z } from "zod";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";

export const SkillManifestV2Schema: z.ZodType<SkillManifestV2>;

/** Parses and validates a fully normalized manifest. Throws on invalid input. */
export function parseFridaySkillManifestV2(input: unknown): SkillManifestV2;

/** Safe parse variant used by registry pipeline for issue aggregation. */
export function safeParseFridaySkillManifestV2(
  input: unknown,
): z.SafeParseReturnType<SkillManifestV2, SkillManifestV2>;
```

### `src/skills/manifest/friday-skill-manifest-loader.ts`
Purpose: Read `skill.manifest.json`, normalize, validate.
```ts
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";

export interface LoadFridaySkillManifestOptions {
  skillDir: string;
  manifestFileName?: "skill.manifest.json";
}

export interface LoadedFridaySkillManifest {
  manifestPath: string;
  raw: Record<string, unknown>;
  manifest: SkillManifestV2;
}

export interface FridaySkillManifestLoadError {
  code:
    | "MANIFEST_NOT_FOUND"
    | "MANIFEST_READ_FAILED"
    | "MANIFEST_PARSE_FAILED"
    | "MANIFEST_VALIDATION_FAILED";
  message: string;
  path?: string;
  cause?: unknown;
}

export type LoadFridaySkillManifestResult =
  | { ok: true; value: LoadedFridaySkillManifest }
  | { ok: false; error: FridaySkillManifestLoadError };

/** Loads and validates `skill.manifest.json` from a skill directory. */
export function loadFridaySkillManifest(
  options: LoadFridaySkillManifestOptions,
): LoadFridaySkillManifestResult;
```

### `src/skills/manifest/friday-skill-frontmatter-parser.ts`
Purpose: YAML frontmatter parser for `SKILL.md` legacy mode.
```ts
export type ParsedSkillFrontmatter = Record<string, string>;

export interface ParsedFridaySkillMarkdown {
  frontmatter: ParsedSkillFrontmatter;
  body: string;
}

export interface FridaySkillFrontmatterParseError {
  code: "SKILL_MD_READ_FAILED" | "SKILL_MD_FRONTMATTER_INVALID";
  message: string;
  path?: string;
  cause?: unknown;
}

export type ParseFridaySkillFrontmatterResult =
  | { ok: true; value: ParsedFridaySkillMarkdown }
  | { ok: false; error: FridaySkillFrontmatterParseError };

/** Extracts YAML frontmatter from markdown (`---` block) using `yaml` package. */
export function parseFridaySkillFrontmatter(markdown: string): ParsedFridaySkillMarkdown;

/** Reads a `SKILL.md` file and parses frontmatter + body content. */
export function loadFridaySkillFrontmatter(skillMdPath: string): ParseFridaySkillFrontmatterResult;
```

### `src/skills/manifest/friday-skill-legacy-adapter.ts`
Purpose: Convert legacy `SKILL.md` metadata into `SkillManifestV2` per §2.2.1.
```ts
import type {
  LegacySkillPermissionV1,
  PermissionPolicyV2,
} from "../model/friday-skill-permission-policy.types.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
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
): PermissionPolicyV2;

/** Adapts `SKILL.md` frontmatter/body into a normalized `SkillManifestV2`. */
export function adaptFridayLegacySkill(
  options: AdaptFridayLegacySkillOptions,
): { ok: true; value: AdaptedFridayLegacySkill } | { ok: false; error: Error };
```

### `src/skills/manifest/friday-skill-package-loader.ts`
Purpose: Manifest-first, legacy fallback dual-load.
```ts
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { AdaptedFridayLegacySkill } from "./friday-skill-legacy-adapter.js";

export type FridaySkillLoadMode = "manifest-v2" | "legacy-skill-md";

export interface LoadFridaySkillPackageOptions {
  skillDir: string;
  workspaceDir: string;
}

export interface FridayLoadedSkillPackage {
  skillDir: string;
  loadMode: FridaySkillLoadMode;
  manifest: SkillManifestV2;
  manifestPath?: string;
  skillMdPath?: string;
  declaredFiles: string[];
  legacy?: AdaptedFridayLegacySkill;
}

export type LoadFridaySkillPackageResult =
  | { ok: true; value: FridayLoadedSkillPackage }
  | { ok: false; error: Error };

/** Loads one skill package using manifest-first, then legacy SKILL.md fallback. */
export function loadFridaySkillPackage(
  options: LoadFridaySkillPackageOptions,
): LoadFridaySkillPackageResult;

/** Resolves all files that must be watched for hot-reload for one skill package. */
export function resolveFridaySkillDeclaredFiles(input: {
  skillDir: string;
  manifest: SkillManifestV2;
  loadMode: FridaySkillLoadMode;
  skillMdPath?: string;
}): string[];
```

### `src/skills/validation/friday-skill-validation.types.ts`
Purpose: Shared validation result model for §2.7.2 pipeline.
```ts
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
```

### `src/skills/validation/friday-skill-filesystem-scope-validator.ts`
Purpose: Static validation of `pathPrefixes` scopes (§2.3.1).
```ts
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillValidationIssue } from "./friday-skill-validation.types.js";

export interface ValidateFridayFilesystemScopeOptions {
  scope: string;
  skillDir: string;
  workspaceDir: string;
  absoluteAllowPrefixes?: string[];
}

export interface FridayFilesystemScopeValidationResult {
  ok: boolean;
  resolvedPath?: string;
  reason?: string;
}

/** Validates one filesystem scope with canonicalization + containment checks. */
export function validateFridayFilesystemScope(
  options: ValidateFridayFilesystemScopeOptions,
): FridayFilesystemScopeValidationResult;

/** Validates all filesystem selector scopes in manifest permissions. */
export function validateFridayManifestFilesystemScopes(
  manifest: SkillManifestV2,
  skillDir: string,
  workspaceDir: string,
): FridaySkillValidationIssue[];
```

### `src/skills/validation/friday-skill-step-graph-validator.ts`
Purpose: Validate flow graph rules (§2.7.2 step graph validation).
```ts
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillValidationIssue } from "./friday-skill-validation.types.js";

/** Validates flow graph integrity when `manifest.flow` is present. */
export function validateFridaySkillStepGraph(
  flow: SkillManifestV2["flow"],
): FridaySkillValidationIssue[];
```

### `src/skills/validation/friday-skill-schema-compiler.ts`
Purpose: Compile referenced JSON schemas with AJV (§2.7.2).
```ts
import type Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillValidationIssue } from "./friday-skill-validation.types.js";

export interface FridayCompiledSkillSchemas {
  input?: ValidateFunction<unknown>;
  state?: ValidateFunction<unknown>;
  output?: ValidateFunction<unknown>;
}

export interface CompileFridaySkillSchemasOptions {
  manifest: SkillManifestV2;
  skillDir: string;
  ajv?: Ajv;
}

/** Compiles input/state/output schemas declared by manifest into AJV validators. */
export function compileFridaySkillSchemas(
  options: CompileFridaySkillSchemasOptions,
): { compiled: FridayCompiledSkillSchemas; issues: FridaySkillValidationIssue[] };
```

### `src/skills/validation/friday-skill-engine-compat-validator.ts`
Purpose: Validate `minHubVersion` and `apiVersion` compatibility (§2.3.2, §2.7.2).
```ts
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
): FridaySkillValidationIssue[];
```

### `src/skills/validation/friday-skill-validation-pipeline.ts`
Purpose: Orchestrate full validation pipeline (§2.7.2).
```ts
import type { FridayLoadedSkillPackage } from "../manifest/friday-skill-package-loader.js";
import type { FridayCompiledSkillSchemas } from "./friday-skill-schema-compiler.js";
import type { FridaySkillValidationResult } from "./friday-skill-validation.types.js";

export interface ValidateFridaySkillPackageOptions {
  loaded: FridayLoadedSkillPackage;
  workspaceDir: string;
  hubVersion: string;
  supportedApiVersions: string[];
}

/** Runs manifest/files/flow/schema/compat/filesystem validations in deterministic order. */
export function validateFridaySkillPackage(
  options: ValidateFridaySkillPackageOptions,
): FridaySkillValidationResult & { compiledSchemas: FridayCompiledSkillSchemas };
```

### `src/skills/trust/friday-skill-trust-enforcer.ts`
Purpose: Trust tier mapping + sandbox policy enforcement (§6.4, §2.5).
```ts
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
export function mapFridaySkillOriginToTrustTier(origin: SkillOrigin): SkillTrustTier;

/** Returns default sandbox policy for a trust tier. */
export function getFridayDefaultSandboxPolicy(trustTier: SkillTrustTier): SkillSandboxPolicy;

/** Enforces trust + execution mode policy and returns issues if blocked. */
export function enforceFridaySkillTrust(input: {
  manifest: SkillManifestV2;
  origin: SkillOrigin;
  requestedExecutionMode?: SkillExecutionMode;
  securityProfile?: FridaySkillSecurityProfile;
}): { decision?: FridaySkillTrustDecision; issues: FridaySkillValidationIssue[] };
```

### `src/skills/lifecycle/friday-skill-lifecycle-machine.ts`
Purpose: Deterministic status transitions (§6.2).
```ts
import type {
  SkillLifecycleOperation,
  SkillLifecycleStatus,
} from "../model/friday-skill-lifecycle.types.js";

export interface FridaySkillLifecycleTransitionResult {
  previous: SkillLifecycleStatus;
  operation: SkillLifecycleOperation;
  next: SkillLifecycleStatus;
  changed: boolean;
}

/** Returns true when lifecycle operation is valid from current status. */
export function canApplyFridaySkillLifecycleOperation(
  current: SkillLifecycleStatus,
  operation: SkillLifecycleOperation,
): boolean;

/** Applies lifecycle operation and returns deterministic next status. */
export function applyFridaySkillLifecycleOperation(
  current: SkillLifecycleStatus,
  operation: SkillLifecycleOperation,
): FridaySkillLifecycleTransitionResult;
```

### `src/skills/registry/friday-skill-registry.types.ts`
Purpose: Registry API contracts + runtime snapshot model.
```ts
import type { SkillLifecycleStatus } from "../model/friday-skill-lifecycle.types.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { SkillInvocationMode } from "../model/friday-skill-manifest-v2.types.js";
import type { SkillOrigin, SkillSource } from "../model/friday-skill-source.types.js";
import type { FridayLoadedSkillPackage } from "../manifest/friday-skill-package-loader.js";
import type { FridaySkillTrustDecision } from "../trust/friday-skill-trust-enforcer.js";
import type { FridaySkillValidationResult } from "../validation/friday-skill-validation.types.js";
import type { FridayHubConfigManagerService } from "../../hub/services/friday-hub-config-manager.types.js";
import type { FridayHubGatewayIngressService } from "../../hub/services/friday-hub-gateway-ingress.types.js";
import type { FridayHubMemoryStateService } from "../../hub/services/friday-hub-memory-state.types.js";

export interface FridaySkillDiscoveryRoot {
  origin: SkillOrigin;
  source: SkillSource;
  dir: string;
}

export interface FridayDiscoveredSkillCandidate {
  root: FridaySkillDiscoveryRoot;
  skillDir: string;
}

export interface FridayRegisteredSkill {
  manifest: SkillManifestV2;
  skillDir: string;
  source: SkillSource;
  origin: SkillOrigin;
  status: SkillLifecycleStatus;
  loaded: FridayLoadedSkillPackage;
  validation: FridaySkillValidationResult;
  trust: FridaySkillTrustDecision;
}

export interface FridaySkillResolutionContext {
  channel?: string;
  mode?: SkillInvocationMode;
}

export interface FridayCompatResult {
  compatible: boolean;
  reasons: string[];
}

export interface CreateFridaySkillRegistryOptions {
  workspaceDir: string;
  hubVersion: string;
  supportedApiVersions: string[];
  configManager: FridayHubConfigManagerService;
  memoryStateService: FridayHubMemoryStateService;
  gatewayIngress?: FridayHubGatewayIngressService;
}

export interface FridaySkillRegistry {
  list(): FridayRegisteredSkill[];
  get(skillId: string): FridayRegisteredSkill | null;
  resolveByIntent(skillIntent: string, context: FridaySkillResolutionContext): FridayRegisteredSkill | null;
  validateAll(): FridaySkillValidationResult[];
  reload(skillId: string): Promise<void>;
  refresh(): Promise<void>;
  isCompatible(manifest: SkillManifestV2): FridayCompatResult;
  startWatching(): Promise<void>;
  stopWatching(): Promise<void>;
  close(): Promise<void>;
}
```

### `src/skills/registry/friday-skill-discovery.ts`
Purpose: Resolve roots and discover skill directories with precedence.
```ts
import type {
  FridayDiscoveredSkillCandidate,
  FridaySkillDiscoveryRoot,
} from "./friday-skill-registry.types.js";
import type { FridaySkillRegistrySettings } from "../../hub/services/friday-hub-config-manager.types.js";

/** Builds precedence-ordered roots from config settings. */
export function resolveFridaySkillDiscoveryRoots(
  settings: FridaySkillRegistrySettings,
): FridaySkillDiscoveryRoot[];

/** Discovers skill directories (manifest or SKILL.md) under all roots deterministically. */
export function discoverFridaySkillCandidates(
  roots: FridaySkillDiscoveryRoot[],
): FridayDiscoveredSkillCandidate[];
```

### `src/skills/registry/friday-skill-watcher.ts`
Purpose: Chokidar-based hot-reload watcher for declared files.
```ts
export interface FridaySkillFileChangeEvent {
  skillId: string;
  skillDir: string;
  changedPath: string;
  changeType: "add" | "change" | "unlink";
}

export interface FridaySkillWatcher {
  /** Starts watcher with initial targets. */
  start(targetsBySkillId: Map<string, string[]>): Promise<void>;
  /** Replaces watcher targets after registry refresh. */
  updateTargets(targetsBySkillId: Map<string, string[]>): Promise<void>;
  /** Stops all watchers and releases file descriptors. */
  close(): Promise<void>;
}

/** Creates a debounced chokidar watcher for skill declared files. */
export function createFridaySkillWatcher(options: {
  debounceMs: number;
  onChange: (event: FridaySkillFileChangeEvent) => Promise<void> | void;
}): FridaySkillWatcher;
```

### `src/skills/registry/friday-skill-registry.ts`
Purpose: Concrete registry implementation (load, validate, trust, precedence, watch).
```ts
import type {
  CreateFridaySkillRegistryOptions,
  FridayCompatResult,
  FridayRegisteredSkill,
  FridaySkillRegistry,
  FridaySkillResolutionContext,
} from "./friday-skill-registry.types.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";

export class FridaySkillRegistryImpl implements FridaySkillRegistry {
  constructor(options: CreateFridaySkillRegistryOptions);

  /** Initial full load; calls `refresh()` then optionally starts watching. */
  initialize(): Promise<void>;

  list(): FridayRegisteredSkill[];
  get(skillId: string): FridayRegisteredSkill | null;
  resolveByIntent(skillIntent: string, context: FridaySkillResolutionContext): FridayRegisteredSkill | null;
  validateAll(): import("../validation/friday-skill-validation.types.js").FridaySkillValidationResult[];
  reload(skillId: string): Promise<void>;
  refresh(): Promise<void>;
  isCompatible(manifest: SkillManifestV2): FridayCompatResult;
  startWatching(): Promise<void>;
  stopWatching(): Promise<void>;
  close(): Promise<void>;
}
```

### `src/skills/index.ts`
Purpose: Public exports for Phase 1 skill subsystem.
```ts
export * from "./model/friday-skill-permission-policy.types.js";
export * from "./model/friday-skill-manifest-v2.types.js";
export * from "./model/friday-skill-source.types.js";
export * from "./model/friday-skill-trust.types.js";
export * from "./model/friday-skill-lifecycle.types.js";
export * from "./model/friday-skill-runtime.types.js";
export * from "./manifest/friday-skill-manifest-defaults.js";
export * from "./manifest/friday-skill-manifest.schema.js";
export * from "./manifest/friday-skill-manifest-loader.js";
export * from "./manifest/friday-skill-frontmatter-parser.js";
export * from "./manifest/friday-skill-legacy-adapter.js";
export * from "./manifest/friday-skill-package-loader.js";
export * from "./validation/friday-skill-validation.types.js";
export * from "./validation/friday-skill-validation-pipeline.js";
export * from "./trust/friday-skill-trust-enforcer.js";
export * from "./lifecycle/friday-skill-lifecycle-machine.js";
export * from "./registry/friday-skill-registry.types.js";
export * from "./registry/friday-skill-registry.js";
```

### `src/hub/services/friday-hub-gateway-ingress.types.ts`
Purpose: Gateway ingress service interface for modularization.
```ts
export type FridayWsFrame =
  | FridayWsReqFrame
  | FridayWsResFrame
  | FridayWsEventFrame
  | FridayWsAckFrame
  | FridayWsResumeFrame;

export interface FridayWsReqFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
  idempotencyKey?: string;
  traceId?: string;
}

export interface FridayWsResFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
}

export interface FridayWsEventFrame {
  type: "event";
  event: string;
  seq: number;
  payload?: unknown;
  emittedAt: string;
}

export interface FridayWsAckFrame {
  type: "ack";
  seq: number;
  streamId: string;
  epoch: number;
  emittedAt: string;
}

export interface FridayWsResumeFrame {
  type: "resume";
  lastAckedSeq: number;
  streamId: string;
  epoch: number;
  cursor: string;
  subscriptions: string[];
  emittedAt: string;
}

export interface FridayGatewayRequestContext {
  principalType: "user" | "satellite" | "service" | "workflow-runner";
  principalId?: string;
  scopes: string[];
  connectionId?: string;
  traceId?: string;
}

export type FridayGatewayMethodHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
  context: FridayGatewayRequestContext,
) => Promise<TResult>;

export interface FridayHubGatewayIngressService {
  registerMethod<TParams = unknown, TResult = unknown>(
    method: string,
    handler: FridayGatewayMethodHandler<TParams, TResult>,
  ): void;
  dispatchFrame(
    frame: FridayWsFrame,
    context: FridayGatewayRequestContext,
  ): Promise<FridayWsResFrame | null>;
  publishEvent(frame: FridayWsEventFrame): Promise<void>;
}
```

### `src/hub/services/friday-hub-config-manager.types.ts`
Purpose: Config manager interface + skill registry/trust settings source.
```ts
import type { LoadedFridayConfig } from "../../config/friday-config.types.js";
import type { FridaySkillSecurityProfile } from "../../skills/trust/friday-skill-trust-enforcer.js";

export interface FridayConfigValidationError {
  field: string;
  rule: string;
  message: string;
}

export interface FridayConfigRevisionRecord {
  id: string;
  revision: number;
  patch: Record<string, unknown>;
  fullSnapshot: Record<string, unknown>;
  changedKeys: string[];
  changedByUserId?: string;
  reason?: string;
  createdAt: string;
}

export interface FridaySkillRegistrySettings {
  workspaceDir: string;
  bundledSkillsDir: string;
  managedSkillsDir: string;
  extraSkillDirs: string[];
  watchEnabled: boolean;
  watchDebounceMs: number;
}

export interface FridayHubConfigManagerService {
  /** Returns typed Phase 0 config snapshot from config IO subsystem. */
  getCurrentConfig(): Promise<LoadedFridayConfig>;
  getConfig(keys?: string[]): Promise<{ revision: number; settings: Record<string, unknown> }>;
  validatePatch(patch: Record<string, unknown>): Promise<{
    valid: boolean;
    errors: FridayConfigValidationError[];
  }>;
  applyPatch(params: {
    expectedRevision: number;
    patch: Record<string, unknown>;
    reason?: string;
  }): Promise<{ revision: number; changedKeys: string[] }>;
  listRevisions(cursor?: string, limit?: number): Promise<{
    items: FridayConfigRevisionRecord[];
    nextCursor?: string;
  }>;
  revertToRevision(toRevision: number): Promise<{
    revision: number;
    changedKeys: string[];
    revertedFrom: number;
  }>;
  /** Provides resolved roots and watch options for skill registry discovery. */
  getSkillRegistrySettings(workspaceDir: string): Promise<FridaySkillRegistrySettings>;
  /** Provides admin trust/sandbox overrides for trust enforcement. */
  getSkillSecurityProfile(): Promise<FridaySkillSecurityProfile>;
}
```

### `src/hub/services/friday-hub-memory-state.types.ts`
Purpose: Memory/state service interface used by registry/runtime/audit.
```ts
import type { SkillLifecycleStatus } from "../../skills/model/friday-skill-lifecycle.types.js";
import type { SkillManifestV2 } from "../../skills/model/friday-skill-manifest-v2.types.js";
import type { SkillOrigin, SkillSource } from "../../skills/model/friday-skill-source.types.js";

export interface FridayDiscoveredSkillRecord {
  id: string;
  name: string;
  source: SkillSource;
  origin: SkillOrigin;
  status: SkillLifecycleStatus;
  manifest: SkillManifestV2;
  latestVersion?: string;
  installedVersion?: string;
}

export interface FridayAuditLogWrite {
  id: string;
  ts: string;
  actorType: "user" | "satellite" | "service" | "workflow-runner";
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  requestId?: string;
  traceId?: string;
  details?: Record<string, unknown>;
}

export interface FridayConversationSessionRecord {
  id: string;
  sessionKey: string;
  agentId: string;
  channel: string;
  chatKind: "dm" | "group" | "channel" | "thread";
  ownerLeaseEpoch: number;
  status: "active" | "idle" | "archived";
  summary?: string;
}

export interface FridaySessionMessageWrite {
  sessionId: string;
  leaseEpoch: number;
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  sourceSatelliteId?: string;
  idempotencyKey?: string;
}

export interface FridaySessionMessageRecord extends FridaySessionMessageWrite {
  id: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface FridayMemoryItemRecord {
  id: string;
  namespace: string;
  key: string;
  value: unknown;
  tags: string[];
  updatedAt: string;
}

export interface FridayHubMemoryStateService {
  listSkillStatuses(): Promise<Record<string, SkillLifecycleStatus>>;
  upsertDiscoveredSkills(records: FridayDiscoveredSkillRecord[]): Promise<void>;
  updateSkillStatus(skillId: string, status: SkillLifecycleStatus, reason?: string): Promise<void>;
  appendAuditLog(entry: FridayAuditLogWrite): Promise<void>;
  getSession(sessionId: string): Promise<FridayConversationSessionRecord | null>;
  appendSessionMessage(input: FridaySessionMessageWrite): Promise<FridaySessionMessageRecord>;
  getMemoryItems(namespace: string, keys?: string[]): Promise<FridayMemoryItemRecord[]>;
  putMemoryItem(item: {
    namespace: string;
    key: string;
    value: unknown;
    tags?: string[];
  }): Promise<void>;
}
```

### `src/hub/services/index.ts`
Purpose: Export hub service interfaces.
```ts
export * from "./friday-hub-gateway-ingress.types.js";
export * from "./friday-hub-config-manager.types.js";
export * from "./friday-hub-memory-state.types.js";
```

## Registry Behavior (deterministic algorithm)
1. Load discovery settings from `FridayHubConfigManagerService.getSkillRegistrySettings(workspaceDir)`.
2. Resolve roots in fixed precedence order (lowest to highest).
3. Discover candidate skill directories per root; lexical sort within each root.
4. For each candidate, run `loadFridaySkillPackage` (`manifest-v2` first, legacy fallback).
5. Run `validateFridaySkillPackage`.
6. Run `enforceFridaySkillTrust`.
7. Keep only candidates with no validation/trust errors.
8. Merge into map by `manifest.id`; later root with higher precedence overwrites previous.
9. Preserve lifecycle status by joining existing status map from `FridayHubMemoryStateService.listSkillStatuses()`, default `not_installed`.
10. Persist snapshot via `upsertDiscoveredSkills`.
11. If watching enabled, update chokidar target set to declared files for active snapshot.
12. On file change, reload affected skill atomically; if reload fails, keep prior snapshot and emit audit warning.

## Unit Test Plan (paths + key assertions)

| Test file | Key assertions |
|---|---|
| `test/unit/skills/manifest/friday-skill-manifest-defaults.test.ts` | Minimal manifest is fully defaulted exactly per §2.4 defaults table. |
| `test/unit/skills/manifest/friday-skill-manifest.schema.test.ts` | Zod accepts valid full manifest, rejects invalid `schemaVersion`, invalid `promptOn`, invalid enum fields. |
| `test/unit/skills/manifest/friday-skill-manifest-loader.test.ts` | Loader handles missing file, invalid JSON, invalid schema, and successful normalized load. |
| `test/unit/skills/manifest/friday-skill-frontmatter-parser.test.ts` | YAML frontmatter parsing, missing frontmatter returns empty, malformed YAML returns error result. |
| `test/unit/skills/manifest/friday-skill-legacy-adapter.test.ts` | Legacy adapter maps invocation flags, metadata requirements, OS/env/config defaults, and permissions fallback. |
| `test/unit/skills/manifest/friday-skill-package-loader.test.ts` | Manifest-first behavior, fallback to legacy when manifest absent, declared file list includes all referenced files. |
| `test/unit/skills/validation/friday-skill-filesystem-scope-validator.test.ts` | Rejects traversal and forbidden absolute paths; accepts skill/workspace-contained scopes. |
| `test/unit/skills/validation/friday-skill-step-graph-validator.test.ts` | Detects missing `startStep`, bad transition targets, unreachable steps, and no terminal path. |
| `test/unit/skills/validation/friday-skill-schema-compiler.test.ts` | Compiles valid JSON schemas, reports missing/invalid schema files as validation issues. |
| `test/unit/skills/validation/friday-skill-engine-compat-validator.test.ts` | Rejects unsupported API versions and too-high `minHubVersion`; accepts compatible versions. |
| `test/unit/skills/validation/friday-skill-validation-pipeline.test.ts` | Pipeline stage ordering and aggregated issues are deterministic. |
| `test/unit/skills/trust/friday-skill-trust-enforcer.test.ts` | Origin->trust mapping, default execution mode selection, blocked disallowed modes, override handling. |
| `test/unit/skills/lifecycle/friday-skill-lifecycle-machine.test.ts` | Valid transitions and rejected invalid operations for each status. |
| `test/unit/skills/registry/friday-skill-discovery.test.ts` | Root resolution and candidate ordering match precedence contract. |
| `test/unit/skills/registry/friday-skill-watcher.test.ts` | Chokidar change events debounce and map to correct skill IDs. |
| `test/unit/skills/registry/friday-skill-registry.test.ts` | End-to-end refresh/merge collision winner, resolveByIntent priority, atomic reload behavior. |
| `test/unit/hub/services/friday-hub-service-contracts.test.ts` | Registry interacts correctly with mocked config manager, memory/state, and gateway ingress interfaces. |

## New Dependencies
- `yaml` (required for `SKILL.md` frontmatter parsing).
- `chokidar` (required for skill hot-reload watchers).
- `ajv` (required for schema compilation stage in validation pipeline).
- `semver` (for robust `minHubVersion` compatibility checks).

This plan is Phase 1-complete, implementation-ready, and constrained to additive `src/` changes only.
