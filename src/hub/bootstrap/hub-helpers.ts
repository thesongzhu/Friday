/**
 * Pure helper functions and type definitions used by the hub bootstrap.
 *
 * These are extracted from the top-level scope of `friday-hub-bootstrap.ts`
 * and have no dependency on any runtime state.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { safeJsonParse } from "#utilities";
import type { FridayAgentMessage } from "#agent";
import type {
  FridayChannelInstanceConfig,
  FridayChannelMessage,
} from "#channels";
import {
  FRIDAY_CHANNEL_CAPABILITY_MATRIX,
  FRIDAY_SUPPORTED_CHANNEL_KINDS,
  getFridayChannelSecretFieldDescriptors,
  parseFridayChannelSecretRef,
  parseFridayEnvSecretRef,
} from "#channels";
import type {
  FridayEvaluationContext,
  FridayEvaluationResult,
  FridayPolicyBundle,
  FridayPolicyBundleRow,
  FridayRule,
  FridayRuleRow,
} from "#rules";
import type { FridaySqliteLayer } from "#state";
import type { FridaySessionMessageRecord } from "#sessions";
import type {
  FridayAutoFixStepKind,
  StepExecutor,
  StepVerifier,
} from "#learning";
import type { FridayHubConfigManagerService, FridaySkillRegistrySettings } from "../services/friday-hub-config-manager.types.js";
import type { FridayDiscoveredSkillRecord, FridayHubMemoryStateService } from "../services/friday-hub-memory-state.types.js";
import { appendFridayAuditLog } from "../services/friday-hub-audit-log-writer.js";
import type { FridayStateRuntime } from "#state";
import type { FridaySkillExecutor, FridaySkillRegistry, SkillLifecycleStatus } from "#skills";
import type { FridaySkillSecurityProfile } from "#skills";
import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridaySkillConverterService } from "#skills/converter";
import type { FridayProviderService } from "#providers";
import type { FridayWorkflowGeneratorService, FridayWorkflowRuntime } from "#workflows";
import type { FridayApiRuntime } from "#api";
import type { FridayChannelRegistry, WebchatWsService } from "#channels";
import type { FridaySatelliteRuntime } from "#satellites";
import type { FridayBrowserPresentationMode } from "#browser";

// ─── Constants ───

/** Directory for persisted secrets. */
const FRIDAY_SECRET_DIR = path.join(os.homedir(), ".friday");
/** File for persisted token secret. */
const FRIDAY_TOKEN_SECRET_FILE = path.join(FRIDAY_SECRET_DIR, "token.secret");

// ─── Marketplace helpers ───

export function deriveMarketplaceSkillIdCandidates(packageName: string): string[] {
  const candidates = new Set<string>();
  const trimmed = packageName.trim();
  if (trimmed.length > 0) {
    candidates.add(trimmed);
    const slashIndex = trimmed.lastIndexOf("/");
    if (slashIndex >= 0 && slashIndex < trimmed.length - 1) {
      candidates.add(trimmed.slice(slashIndex + 1));
    }
    candidates.add(trimmed.replace(/^@/, "").replace(/\//g, "-"));
  }
  return [...candidates];
}

// ─── Cross-channel identity ───

function normalizeCrossChannelIdentity(raw: string): string | null {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : null;
}

/**
 * Parse cross-channel identity mappings from JSON.
 *
 * Supported formats:
 * 1) Flat: { "discord:123": "jarvis", "telegram:456": "jarvis" }
 * 2) Nested: { "discord": { "123": "jarvis" }, "telegram": { "456": "jarvis" } }
 */
export function parseFridayChannelIdentityMap(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn("[friday][hub-helpers] parse-identity-map:", err instanceof Error ? err.message : String(err));
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const resolved: Record<string, string> = {};
  const root = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(root)) {
    if (typeof value === "string") {
      const normalized = normalizeCrossChannelIdentity(value);
      if (normalized) {
        resolved[key] = normalized;
      }
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const nested = value as Record<string, unknown>;
    for (const [senderId, canonical] of Object.entries(nested)) {
      if (typeof canonical !== "string") continue;
      const normalized = normalizeCrossChannelIdentity(canonical);
      if (!normalized) continue;
      resolved[`${key}:${senderId}`] = normalized;
    }
  }
  return resolved;
}

export function resolveFridayChannelSessionKey(
  msg: FridayChannelMessage,
  options: {
    crossChannelIdentityEnabled: boolean;
    identityMap: Readonly<Record<string, string>>;
  },
): string {
  const threadId = typeof msg.threadId === "string" ? msg.threadId.trim() : "";

  const withThread = (base: string): string => {
    if (threadId.length === 0) {
      return base;
    }
    return `${base}:thread:${threadId}`;
  };

  if (options.crossChannelIdentityEnabled && msg.chatType === "direct") {
    const mapped = options.identityMap[`${msg.channelKind}:${msg.senderId}`];
    if (mapped) {
      return withThread(`omni:default:${mapped}`);
    }
  }
  return withThread(`channel:${msg.channelKind}:${msg.chatId}`);
}

export function resolveFridayChannelDisabledToolNames(_channelKind: string): string[] {
  return [];
}

export interface FridayChannelTerminalTextInput {
  status: "completed" | "failed" | "cancelled";
  response: string;
  imageCount: number;
}

export function resolveFridayChannelTerminalText(input: FridayChannelTerminalTextInput): string {
  const hasResponse = input.response.trim().length > 0;
  const hasImages = input.imageCount > 0;

  if (input.status === "completed" && !hasResponse) {
    return hasImages
      ? "Task completed. Attached output artifacts."
      : "Task completed.";
  }
  if (input.status === "failed" && !hasResponse) {
    return "Request failed. Please retry.";
  }
  if (input.status === "cancelled" && !hasResponse) {
    return "Request was cancelled before completion.";
  }
  if (input.status === "failed" && hasResponse) {
    return `Request failed: ${input.response}`;
  }
  if (input.status === "cancelled" && hasResponse) {
    return `Request cancelled: ${input.response}`;
  }
  return input.response;
}

export function buildFridayChannelDeliveryFailureText(runId: string): string {
  return (
    "I completed your request, but delivery failed (E-CH-OUTBOUND-001). " +
    `Correlation: ${runId}. You can query /v1/agent/runs/${runId}.`
  );
}

// ─── Browser config ───

export function resolveBrowserHostConfigFromEnv(
  env: NodeJS.ProcessEnv,
): {
  wsEndpoint?: string;
  launchArgs?: string[];
  useHostChrome?: boolean;
  cdpPort?: number;
  chromePath?: string;
} | undefined {
  const wsEndpoint = env.FRIDAY_BROWSER_WS_ENDPOINT?.trim();
  const rawLaunchArgs = env.FRIDAY_BROWSER_LAUNCH_ARGS?.trim();
  const resolvedPresentationMode = resolveBrowserPresentationModeFromEnv(env);
  const useHostChrome = env.FRIDAY_BROWSER_USE_HOST_CHROME === "true"
    || resolvedPresentationMode === "host_chrome_visible";
  const cdpPort = env.FRIDAY_BROWSER_CDP_PORT
    ? parseInt(env.FRIDAY_BROWSER_CDP_PORT, 10) || undefined
    : undefined;
  const chromePath = env.FRIDAY_BROWSER_CHROME_PATH?.trim() || undefined;

  let launchArgs: string[] | undefined;

  if (rawLaunchArgs) {
    try {
      const parsed = JSON.parse(rawLaunchArgs);
      if (Array.isArray(parsed)) {
        launchArgs = parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
      }
    } catch (err) {
      console.warn("[friday][hub-helpers] parse-browser-launch-args:", err instanceof Error ? err.message : String(err));
      launchArgs = rawLaunchArgs
        .split(/\s+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
  }

  if (
    !wsEndpoint &&
    (!launchArgs || launchArgs.length === 0) &&
    !useHostChrome
  ) {
    return undefined;
  }

  return {
    wsEndpoint: wsEndpoint && wsEndpoint.length > 0 ? wsEndpoint : undefined,
    launchArgs: launchArgs && launchArgs.length > 0 ? launchArgs : undefined,
    useHostChrome: useHostChrome || undefined,
    cdpPort,
    chromePath,
  };
}

export function resolveBrowserPresentationModeFromEnv(
  env: NodeJS.ProcessEnv,
): FridayBrowserPresentationMode {
  const explicitMode = env.FRIDAY_BROWSER_PRESENTATION_MODE?.trim();
  if (
    explicitMode === "auto"
    || explicitMode === "headless"
    || explicitMode === "host_chrome_visible"
  ) {
    return explicitMode;
  }
  if (env.FRIDAY_BROWSER_USE_HOST_CHROME === "true") {
    return "host_chrome_visible";
  }
  if (env.FRIDAY_BROWSER_HEADLESS === "false") {
    return "host_chrome_visible";
  }
  if (env.FRIDAY_BROWSER_HEADLESS === "true") {
    return "headless";
  }
  return "auto";
}

// ─── Desktop config ───

export function parseDesktopSandboxAllowedRoots(raw: string | undefined, workspaceRoot: string): string[] {
  if (!raw || raw.trim().length === 0) {
    return [workspaceRoot];
  }
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    return [workspaceRoot];
  }
  return values.map((value) => path.resolve(value));
}

// ─── Session / Agent message mapping ───

export function mapSessionMessageToAgentMessage(
  message: FridaySessionMessageRecord,
): FridayAgentMessage | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }

  if (typeof message.content === "string") {
    const content = message.content.trim();
    if (content.length > 0) {
      return { role: message.role, content };
    }
  }

  const fallbackText = message.contentText.trim();
  if (fallbackText.length > 0) {
    return { role: message.role, content: fallbackText };
  }

  return null;
}

// ─── Rules helpers ───

export const RULES_EVALUATE_SCOPE = "rules:evaluate";

export function normalizeScopeList(scopes: readonly string[] | undefined): string[] {
  const set = new Set<string>();
  for (const scope of scopes ?? []) {
    if (typeof scope === "string" && scope.trim().length > 0) {
      set.add(scope.trim());
    }
  }
  set.add(RULES_EVALUATE_SCOPE);
  return [...set];
}

export function mapPolicyBundleRow(row: FridayPolicyBundleRow): FridayPolicyBundle {
  const tags = (() => {
    const parsed = safeJsonParse(row.tags_json);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  })();

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    version: row.version,
    priority: row.priority,
    enabled: row.enabled === 1,
    tags,
    source: row.source === "import" || row.source === "system" ? row.source : "user",
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapRuleRow(row: FridayRuleRow): FridayRule {
  const conditions = (() => {
    const parsed = safeJsonParse(row.conditions_json);
    return typeof parsed === "object" && parsed !== null
      ? parsed as FridayRule["conditions"]
      : {};
  })();

  return {
    id: row.id,
    policyBundleId: row.policy_bundle_id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled === 1,
    resource: row.resource as FridayRule["resource"],
    action: row.action as FridayRule["action"],
    conditions,
    decision: row.decision as FridayRule["decision"],
    message: row.message ?? undefined,
    priority: row.priority,
    version: row.version,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Channel config loading from setup state ───

interface SetupChannelEntryRow {
  channels_json: string | null;
}

interface SetupChannelPersistedEntry {
  kind?: unknown;
  enabled?: unknown;
  config?: unknown;
}

export function loadChannelsConfigFromSetupState(
  sqlite: FridaySqliteLayer,
): Record<string, unknown> | undefined {
  const supportedKinds = new Set<string>(FRIDAY_SUPPORTED_CHANNEL_KINDS);
  const row = sqlite.withReadConnection((db) => {
    return db
      .prepare("SELECT channels_json FROM friday_setup_state WHERE id = 'singleton'")
      .get() as SetupChannelEntryRow | undefined;
  });

  if (!row?.channels_json) {
    return undefined;
  }

  const parsed: unknown = safeJsonParse(row.channels_json);
  if (!Array.isArray(parsed)) {
    return undefined;
  }

  const instances: Record<string, unknown>[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const entry = item as SetupChannelPersistedEntry;
    const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
    if (!kind || !supportedKinds.has(kind)) continue;

    const baseConfig = entry.config;
    const config =
      baseConfig && typeof baseConfig === "object" && !Array.isArray(baseConfig)
        ? baseConfig as Record<string, unknown>
        : {};

    instances.push({
      kind,
      enabled: entry.enabled !== false,
      ...config,
    });
  }

  if (instances.length === 0) {
    return undefined;
  }

  return {
    enabled: instances.some((instance) => instance.enabled !== false),
    instances,
  };
}

// ─── Channel config resolution with secret policy ───

export interface ChannelConfigResolutionResult {
  config: Record<string, unknown>;
  warnings: string[];
  errors: string[];
}

export function resolveChannelInitConfigWithSecretPolicy(params: {
  instance: FridayChannelInstanceConfig;
  env: NodeJS.ProcessEnv;
  secretPolicy: "strict" | "compat"; // pragma: allowlist secret
  resolveSecretRef: (refKey: string) => string | null;
}): ChannelConfigResolutionResult {
  const { instance, env, secretPolicy, resolveSecretRef } = params;
  const config = { ...instance } as Record<string, unknown>;
  const warnings: string[] = [];
  const errors: string[] = [];

  const capability = FRIDAY_CHANNEL_CAPABILITY_MATRIX[instance.kind];
  if (!capability) {
    errors.push(`No capability profile found for channel kind "${instance.kind}"`);
    return { config, warnings, errors };
  }
  if (!capability.supportsInbound || !capability.supportsOutbound) {
    errors.push(
      `Capability policy disabled kind "${instance.kind}" because inbound/outbound support is incomplete`,
    );
    return { config, warnings, errors };
  }

  const secretFields = getFridayChannelSecretFieldDescriptors(instance.kind, config);
  for (const field of secretFields) {
    const rawValue = config[field.field];
    const value = typeof rawValue === "string" ? rawValue.trim() : "";

    if (value.length === 0) {
      if (field.required) {
        const reasonSuffix = field.reason ? ` (${field.reason})` : "";
        errors.push(
          `Missing required secret field "${field.field}" for kind "${instance.kind}"${reasonSuffix}`,
        );
      }
      continue;
    }

    const envVar = parseFridayEnvSecretRef(value);
    if (envVar) {
      const envValue = env[envVar];
      if (!envValue || envValue.trim().length === 0) {
        errors.push(
          `Environment variable "${envVar}" is not set for channel ${instance.kind}.${field.field}`,
        );
      } else {
        config[field.field] = envValue;
      }
      continue;
    }

    const refKey = parseFridayChannelSecretRef(value);
    if (refKey) {
      const resolved = resolveSecretRef(refKey);
      if (!resolved) {
        errors.push(
          `Stored secret ref "${refKey}" was not found for channel ${instance.kind}.${field.field}`,
        );
      } else {
        config[field.field] = resolved;
      }
      continue;
    }

    if (secretPolicy === "strict") { // pragma: allowlist secret
      errors.push(
        `Plaintext secret is blocked by policy for channel ${instance.kind}.${field.field}; use $ENV_VAR or secret://channel/...`,
      );
      continue;
    }

    warnings.push(
      `Plaintext secret accepted in compat mode for channel ${instance.kind}.${field.field}`,
    );
  }

  return { config, warnings, errors };
}

// ─── Token secret resolution ───

export interface FridayTokenSecretResult {
  secret: string;
  source: "config" | "env" | "file" | "generated";
}

/**
 * Resolves the token secret with precedence:
 *   1. Explicit config value
 *   2. `FRIDAY_TOKEN_SECRET` env var
 *   3. `~/.friday/token.secret` file
 *   4. Generate random, persist to `~/.friday/token.secret`
 *
 * Follows the same pattern as `getMasterKey()` in `friday-secret-crypto.ts`.
 */
export function resolveTokenSecret(
  configSecret: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FridayTokenSecretResult {
  // 1. Explicit config
  if (configSecret) {
    return { secret: configSecret, source: "config" };
  }

  // 2. Environment variable
  const envSecret = env.FRIDAY_TOKEN_SECRET;
  if (envSecret) {
    return { secret: envSecret, source: "env" };
  }

  // 3. Persisted file
  try {
    const content = fs.readFileSync(FRIDAY_TOKEN_SECRET_FILE, "utf8").trim();
    if (content.length > 0) {
      return { secret: content, source: "file" };
    }
  } catch (err) {
    // File missing/unreadable — fall through to generate
    console.warn("[friday][hub-helpers] read-token-secret:", err instanceof Error ? err.message : String(err));
  }

  // 4. Generate random and persist
  const generated = crypto.randomBytes(32).toString("hex");

  try {
    fs.mkdirSync(FRIDAY_SECRET_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(FRIDAY_TOKEN_SECRET_FILE, generated + "\n", {
      mode: 0o600,
    });
  } catch (err) {
    console.warn(
      "[friday] WARNING: Could not persist token secret to " + FRIDAY_TOKEN_SECRET_FILE,
      err instanceof Error ? err.message : String(err),
    );
  }

  console.warn(
    "[friday] WARNING: No FRIDAY_TOKEN_SECRET configured. " +
      "Generated a random token secret and saved to " +
      FRIDAY_TOKEN_SECRET_FILE +
      ". Set FRIDAY_TOKEN_SECRET for production use.",
  );

  return { secret: generated, source: "generated" };
}

// ─── Stub services for standalone hub ───

export function createStubConfigManager(
  config: { stateDir?: string; skillDirs: string[] },
  stateRuntime: FridayStateRuntime,
): FridayHubConfigManagerService {
  const skillSettings: FridaySkillRegistrySettings = {
    workspaceDir: config.stateDir ?? ".",
    bundledSkillsDir: config.skillDirs[0] ?? "skills",
    managedSkillsDir: config.skillDirs[1] ?? "managed-skills",
    extraSkillDirs: config.skillDirs.slice(2),
    watchEnabled: false,
    watchDebounceMs: 300,
  };

  const securityProfile: FridaySkillSecurityProfile = {};

  return {
    getCurrentConfig: async () => stateRuntime.config,
    getConfig: async () => ({ revision: 1, settings: {} }),
    validatePatch: async () => ({ valid: true, errors: [] }),
    applyPatch: async () => ({ revision: 1, changedKeys: [] }),
    listRevisions: async () => ({ items: [] }),
    revertToRevision: async () => ({
      revision: 1,
      changedKeys: [],
      revertedFrom: 1,
    }),
    getSkillRegistrySettings: async () => skillSettings,
    getSkillSecurityProfile: async () => securityProfile,
  };
}

export interface FridayHubAutoFixExecutionSupport {
  stepExecutors: Partial<Record<FridayAutoFixStepKind, StepExecutor>>;
  stepVerifiers: Partial<Record<FridayAutoFixStepKind, StepVerifier>>;
}

function isRevertPayload(payload: unknown): boolean {
  return typeof payload === "object" &&
    payload !== null &&
    "revert" in payload &&
    (payload as { revert?: unknown }).revert === true;
}

export function createFridayHubAutoFixExecutionSupport(deps: {
  registry: FridaySkillRegistry;
  memoryState: FridayHubMemoryStateService;
  nowIso: () => string;
}): FridayHubAutoFixExecutionSupport {
  const unsupportedKinds: FridayAutoFixStepKind[] = [
    "retry_node",
    "switch_model_fallback",
    "trim_payload",
    "apply_config_patch",
    "grant_permission",
    "pause_workflow",
  ];

  const stepExecutors: Partial<Record<FridayAutoFixStepKind, StepExecutor>> = {};
  const stepVerifiers: Partial<Record<FridayAutoFixStepKind, StepVerifier>> = {};

  for (const kind of unsupportedKinds) {
    stepExecutors[kind] = async () => false;
    stepVerifiers[kind] = async () => false;
  }

  stepExecutors.disable_skill = async (step) => {
    if (!step.target) {
      return false;
    }

    const revert = isRevertPayload(step.payload);
    if (!revert && !deps.registry.get(step.target)) {
      return false;
    }

    await deps.memoryState.updateSkillStatus(
      step.target,
      revert ? "installed" : "disabled",
      revert
        ? `auto-fix rollback @ ${deps.nowIso()}`
        : `auto-fix disable_skill @ ${deps.nowIso()}`,
    );
    return true;
  };

  stepVerifiers.disable_skill = async (step) => {
    if (!step.target) {
      return false;
    }
    const revert = isRevertPayload(step.payload);
    const statuses = await deps.memoryState.listSkillStatuses();
    return statuses[step.target] === (revert ? "installed" : "disabled");
  };

  return {
    stepExecutors,
    stepVerifiers,
  };
}

export function createStubMemoryState(auditLogPath?: string): FridayHubMemoryStateService {
  const statuses: Record<string, SkillLifecycleStatus> = {};
  return {
    listSkillStatuses: async () => statuses,
    upsertDiscoveredSkills: async (records: FridayDiscoveredSkillRecord[]) => {
      for (const r of records) {
        statuses[r.id] = r.status;
      }
    },
    updateSkillStatus: async (skillId: string, status: SkillLifecycleStatus) => {
      statuses[skillId] = status;
    },
    appendAuditLog: async (entry) => {
      if (auditLogPath) {
        await appendFridayAuditLog(auditLogPath, entry);
      }
    },
    getSession: async () => null,
    appendSessionMessage: async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      sequence: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    getMemoryItems: async () => [],
    putMemoryItem: async () => {},
  };
}

// ─── Public types ───

export interface FridayHub {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): FridayHubStatus;
  skills: FridaySkillRegistry;
  executor: FridaySkillExecutor;
  providerService: FridayProviderService;
  skillGenerator: FridaySkillGeneratorService;
  converterService: FridaySkillConverterService;
  workflowGenerator: FridayWorkflowGeneratorService;
  workflowRuntime: FridayWorkflowRuntime;
  apiRuntime: FridayApiRuntime;
  channelRegistry: FridayChannelRegistry;
  satelliteRuntime: FridaySatelliteRuntime;
  webchatWsService?: WebchatWsService;
}

export interface FridayHubStatus {
  state: "starting" | "running" | "stopping" | "stopped";
  skillCount: number;
  upSince: string | null;
}

export interface FridayHubConfig {
  stateDir?: string;
  skillDirs: string[];
  host?: string;
  port?: number;
  tokenSecret?: string;
  pluginRuntimeMode?: "stub" | "full";
  serverVersion?: string;
  corsOrigins?: string[];
  logRequests?: boolean;
  /** Raw channels configuration block (parsed via FridayChannelsConfigSchema). */
  channels?: Record<string, unknown>;
}

// ─── Resolved Hub Config ───

export interface FridayResolvedHubConfig {
  stateDir?: string;
  skillDirs: string[];
  port: number;
  tokenSecret: string;
  tokenSecretSource: FridayTokenSecretResult["source"];
  serverVersion: string;
  corsOrigins: string[];
  logRequests: boolean;
  pluginRuntimeMode: "stub" | "full";
  /** Whether passwordless local login is allowed (dev mode only). */
  allowPasswordlessLocalLogin: boolean;
  /** Whether loopback UI/app surfaces may bootstrap a local session via `login({ local: true })`. */
  allowLocalBypassLogin: boolean;
  /** Whether deterministic pipeline execution is globally enabled. */
  pipelineEnabled: boolean;
  /** Deterministic pipeline enforcement mode. */
  pipelineMode: "shadow" | "warn" | "enforce";
}
