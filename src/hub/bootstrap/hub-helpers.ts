/**
 * Pure helper functions and type definitions used by the hub bootstrap.
 *
 * These are extracted from the top-level scope of `friday-hub-bootstrap.ts`
 * and have no dependency on any runtime state.
 */

import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { safeJsonParse } from "#utilities";
import type { FridayAgentMessage, FridaySsrfPolicy } from "#agent";
import type {
  FridayChannelInstanceConfig,
  FridayChannelMessage,
} from "#channels";
import {
  FRIDAY_CHANNEL_CAPABILITY_MATRIX,
  FRIDAY_SUPPORTED_CHANNEL_KINDS,
  getFridayChannelSecretFieldDescriptors,
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
import { canonicalizeFridaySessionKey } from "#sessions";
import type { FridaySessionMessageRecord } from "#sessions";
import type {
  FridayAutoFixStepKind,
  StepExecutor,
  StepVerifier,
} from "#learning";
import type { FridaySelfHealingApiService } from "#learning";
import type { FridayHubConfigManagerService, FridaySkillRegistrySettings } from "../services/friday-hub-config-manager.types.js";
import type { FridayDiscoveredSkillRecord, FridayHubMemoryStateService } from "../services/friday-hub-memory-state.types.js";
import { appendFridayAuditLog } from "../services/friday-hub-audit-log-writer.js";
import type { FridayStateRuntime } from "#state";
import type { FridaySkillExecutor, FridaySkillRegistry, SkillLifecycleStatus } from "#skills";
import type { FridaySkillSecurityProfile } from "#skills";
import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridaySkillConverterService } from "#skills/converter";
import type { FridayProviderService } from "#providers";
import {
  normalizeFridayModelRoutingConfig,
  normalizeFridayProviderSupportedModels,
} from "#providers";
import type { FridayWorkflowGeneratorService, FridayWorkflowRuntime } from "#workflows";
import type { FridayApiRuntime } from "#api";
import type { FridayChannelRegistry, WebchatWsService } from "#channels";
import type { FridaySatelliteRuntime } from "#satellites";
import type { FridayBrowserPresentationMode } from "#browser";
import type { FridayAutonomousEngine } from "../../agent/autonomous/friday-autonomous.types.js";
import { parseFridaySecretInput } from "../../security/friday-secret-ref.js";

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

  const withThread = (baseSlot: string): string => {
    if (threadId.length === 0) {
      return baseSlot;
    }
    return `${baseSlot}--thread--${threadId}`;
  };

  if (options.crossChannelIdentityEnabled && msg.chatType === "direct") {
    const mapped = options.identityMap[`${msg.channelKind}:${msg.senderId}`];
    if (mapped) {
      return canonicalizeFridaySessionKey(`omni:default:${withThread(mapped)}`);
    }
  }
  return canonicalizeFridaySessionKey(`channel:${msg.channelKind}:${withThread(msg.chatId)}`);
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

    const parsed = parseFridaySecretInput(value, {
      secretRefPrefixes: ["secret://channel/", "secret://"],
    });
    if (parsed.kind !== "inline") {
      if (parsed.kind === "env-ref") {
        const envValue = env[parsed.envVar];
        if (!envValue || envValue.trim().length === 0) {
          errors.push(
            `Environment variable "${parsed.envVar}" is not set for channel ${instance.kind}.${field.field}`,
          );
        } else {
          config[field.field] = envValue.trim();
        }
        continue;
      }

      if (parsed.kind === "secret-ref") {
        const resolved = resolveSecretRef(parsed.refKey);
        if (!resolved) {
          errors.push(
            `Stored secret ref "${parsed.refKey}" was not found for channel ${instance.kind}.${field.field}`,
          );
        } else {
          config[field.field] = resolved;
        }
        continue;
      }

      if (parsed.kind === "file-ref") {
        if (!parsed.path.startsWith("/")) {
          errors.push(
            `File secret ref must use an absolute path for channel ${instance.kind}.${field.field}`,
          );
          continue;
        }
        try {
          const fileValue = fs.readFileSync(parsed.path, "utf8").trim();
          if (fileValue.length === 0) {
            errors.push(
              `Secret file "${parsed.path}" is empty for channel ${instance.kind}.${field.field}`,
            );
          } else {
            config[field.field] = fileValue;
          }
        } catch (err) {
          errors.push(
            `Failed to read secret file "${parsed.path}" for channel ${instance.kind}.${field.field}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }

      if (parsed.kind === "command-ref") {
        try {
          const output = execFileSync("/bin/sh", ["-c", parsed.command], {
            timeout: 5_000,
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
          }).trim();
          if (output.length === 0) {
            errors.push(
              `Secret command returned empty output for channel ${instance.kind}.${field.field}`,
            );
          } else {
            config[field.field] = output;
          }
        } catch (err) {
          errors.push(
            `Failed to execute secret command for channel ${instance.kind}.${field.field}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }
    }

    if (secretPolicy === "strict") { // pragma: allowlist secret
      errors.push(
        `Plaintext secret is blocked by policy for channel ${instance.kind}.${field.field}; use env:, $ENV_VAR, file:, command:, or secret://...`,
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
  providerService?: FridayProviderService;
  workflowRuntime?: FridayWorkflowRuntime;
  nowIso: () => string;
}): FridayHubAutoFixExecutionSupport {
  // P2-07: Only override step kinds that need hub-level service access.
  // All other kinds use DEFAULT_EXECUTORS from the execution service which
  // correctly set directive markers and return true.
  const stepExecutors: Partial<Record<FridayAutoFixStepKind, StepExecutor>> = {};
  const stepVerifiers: Partial<Record<FridayAutoFixStepKind, StepVerifier>> = {};

  const readPayloadRecord = (payload: unknown): Record<string, unknown> | null =>
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;

  const readString = (
    payload: Record<string, unknown> | null,
    ...keys: string[]
  ): string | undefined => {
    for (const key of keys) {
      const value = payload?.[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return undefined;
  };

  const readNumber = (
    payload: Record<string, unknown> | null,
    key: string,
  ): number | undefined => {
    const value = payload?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  const readBoolean = (
    payload: Record<string, unknown> | null,
    key: string,
  ): boolean | undefined => {
    const value = payload?.[key];
    return typeof value === "boolean" ? value : undefined;
  };

  const readStringArray = (
    payload: Record<string, unknown> | null,
    ...keys: string[]
  ): string[] | undefined => {
    for (const key of keys) {
      const value = payload?.[key];
      if (!Array.isArray(value)) {
        continue;
      }
      const normalized = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      return normalized;
    }
    return undefined;
  };

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

  const workflowRuntime = deps.workflowRuntime;
  if (workflowRuntime) {
    stepExecutors.retry_node = async (step) => {
      const payload = readPayloadRecord(step.payload);
      const runId = readString(payload, "runId", "workflowRunId");
      const nodeId = readString(payload, "nodeId");
      if (!runId) {
        return false;
      }

      const beforeCount = nodeId
        ? workflowRuntime.execution.getRunNodes(runId).filter((node) => node.nodeId === nodeId).length
        : workflowRuntime.execution.getRunNodes(runId).length;
      await workflowRuntime.execution.retryRun(runId, nodeId ? [nodeId] : undefined);
      const afterCount = nodeId
        ? workflowRuntime.execution.getRunNodes(runId).filter((node) => node.nodeId === nodeId).length
        : workflowRuntime.execution.getRunNodes(runId).length;

      if (payload) {
        payload._retryRequested = true;
        payload._retryRunId = runId;
        if (nodeId) {
          payload._retryNodeId = nodeId;
        }
        payload._retryCountBefore = beforeCount;
        payload._retryCountAfter = afterCount;
        payload._retryAt = deps.nowIso();
      }
      return afterCount > beforeCount;
    };

    stepVerifiers.retry_node = async (step) => {
      const payload = readPayloadRecord(step.payload);
      const runId = readString(payload, "_retryRunId", "runId", "workflowRunId");
      if (!runId) {
        return false;
      }
      const nodeId = readString(payload, "_retryNodeId", "nodeId");
      const beforeCount = readNumber(payload, "_retryCountBefore") ?? 0;
      const currentCount = nodeId
        ? workflowRuntime.execution.getRunNodes(runId).filter((node) => node.nodeId === nodeId).length
        : workflowRuntime.execution.getRunNodes(runId).length;
      return payload?._retryRequested === true && currentCount > beforeCount;
    };

    stepExecutors.pause_workflow = async (step) => {
      const payload = readPayloadRecord(step.payload);
      const runId = readString(payload, "runId", "workflowRunId") ?? step.target;
      if (!runId) {
        return false;
      }
      const run = await workflowRuntime.execution.pauseRun(
        runId,
        readString(payload, "reason") ?? `auto-fix pause_workflow @ ${deps.nowIso()}`,
      );
      if (payload) {
        payload._workflowPaused = run.status === "paused";
        payload._pausedRunId = runId;
        payload._pausedAt = deps.nowIso();
      }
      return run.status === "paused";
    };

    stepVerifiers.pause_workflow = async (step) => {
      const payload = readPayloadRecord(step.payload);
      const runId = readString(payload, "_pausedRunId", "runId", "workflowRunId") ?? step.target;
      if (!runId) {
        return false;
      }
      return workflowRuntime.execution.getRun(runId)?.status === "paused";
    };
  }

  const providerService = deps.providerService;
  if (providerService) {
    stepExecutors.switch_model_fallback = async (step) => {
      const payload = readPayloadRecord(step.payload);
      const routing = await providerService.getRoutingConfig();
      const normalizedRouting = normalizeFridayModelRoutingConfig(routing);
      const revert = isRevertPayload(step.payload);
      if (revert) {
        const restoreProviderId = readString(
          payload,
          "restoreProviderId",
          "_routeSwitchedFrom",
          "actualProviderId",
          "providerId",
        );
        const restoreModel = readString(
          payload,
          "restoreModel",
          "actualModel",
          "model",
        ) ?? normalizedRouting.defaultModel;
        if (!restoreProviderId) {
          return false;
        }
        const restoreFallbackProviderIds = readStringArray(
          payload,
          "restoreFallbackProviderIds",
          "fallbackProviderIds",
        ) ?? normalizedRouting.fallbackProviderIds;
        const restoreEnforceRequestedModel = readBoolean(
          payload,
          "restoreEnforceRequestedModel",
        );
        await providerService.setRoutingConfig({
          defaultProviderId: restoreProviderId,
          defaultModel: restoreModel,
          fallbackProviderIds: restoreFallbackProviderIds,
          ...(restoreEnforceRequestedModel !== undefined
            ? { enforceRequestedModel: restoreEnforceRequestedModel }
            : normalizedRouting.enforceRequestedModel !== undefined
              ? { enforceRequestedModel: normalizedRouting.enforceRequestedModel }
              : {}),
        });
        if (payload) {
          payload._modelFallbackRequested = true;
          payload._routeRolledBackTo = restoreProviderId;
          payload._fallbackRollbackAt = deps.nowIso();
        }
        return true;
      }

      const providers = await providerService.listProviders();
      const requestedModel = readString(payload, "model", "requestedModel");
      const preferredProviderId = readString(
        payload,
        "nextProviderId",
        "fallbackProviderId",
        "providerId",
      );
      const eligibleProviders = providers.filter((provider) =>
        provider.enabled &&
        provider.id !== normalizedRouting.defaultProviderId &&
        (requestedModel == null || normalizeFridayProviderSupportedModels(provider.config.supportedModels).includes(requestedModel)));
      const nextProviderId = preferredProviderId && eligibleProviders.some((provider) => provider.id === preferredProviderId)
        ? preferredProviderId
        : eligibleProviders[0]?.id;
      if (!nextProviderId) {
        return false;
      }
      const nextModel = requestedModel
        ?? providers.find((provider) => provider.id === nextProviderId)?.defaultModel
        ?? normalizedRouting.defaultModel;
      const fallbackProviderIds = [
        normalizedRouting.defaultProviderId,
        ...normalizedRouting.fallbackProviderIds,
      ].filter((providerId, index, all) =>
        providerId &&
        providerId !== nextProviderId &&
        all.indexOf(providerId) === index);
      await providerService.setRoutingConfig({
        defaultProviderId: nextProviderId,
        defaultModel: nextModel,
        fallbackProviderIds,
        ...(normalizedRouting.enforceRequestedModel !== undefined
          ? { enforceRequestedModel: normalizedRouting.enforceRequestedModel }
          : {}),
      });
      if (payload) {
        payload._modelFallbackRequested = true;
        payload._routeSwitchedFrom = normalizedRouting.defaultProviderId;
        payload._routeSwitchedTo = nextProviderId;
        payload._fallbackAt = deps.nowIso();
      }
      return true;
    };

    stepVerifiers.switch_model_fallback = async (step) => {
      const payload = readPayloadRecord(step.payload);
      const route = await providerService.getRoutingConfig();
      if (isRevertPayload(step.payload)) {
        const rolledBackTo = readString(payload, "_routeRolledBackTo", "restoreProviderId");
        const restoreModel = readString(payload, "restoreModel", "actualModel", "model");
        return payload?._modelFallbackRequested === true &&
          typeof rolledBackTo === "string" &&
          route.defaultProviderId === rolledBackTo &&
          (restoreModel == null || route.defaultModel === restoreModel);
      }
      const switchedTo = readString(payload, "_routeSwitchedTo");
      return payload?._modelFallbackRequested === true &&
        typeof switchedTo === "string" &&
        route.defaultProviderId === switchedTo;
    };
  }

  stepExecutors.trim_payload = async (step) => {
    const payload = readPayloadRecord(step.payload);
    if (!payload) {
      return false;
    }
    const maxChars = readNumber(payload, "maxChars") ?? 4000;
    const candidateFields = ["prompt", "content", "text", "body", "message", "input"];
    const trimmedFields: string[] = [];
    for (const field of candidateFields) {
      const value = payload[field];
      if (typeof value === "string" && value.length > maxChars) {
        payload[field] = `${value.slice(0, Math.max(0, maxChars - 1))}…`;
        trimmedFields.push(field);
      }
    }
    if (trimmedFields.length === 0) {
      return false;
    }
    payload._trimRequested = true;
    payload._trimmedFields = trimmedFields;
    payload._trimTargetLength = maxChars;
    return true;
  };

  stepVerifiers.trim_payload = async (step) => {
    const payload = readPayloadRecord(step.payload);
    if (!payload || payload._trimRequested !== true) {
      return false;
    }
    const maxChars = readNumber(payload, "_trimTargetLength") ?? 4000;
    const trimmedFields = Array.isArray(payload._trimmedFields)
      ? payload._trimmedFields.filter((value): value is string => typeof value === "string")
      : [];
    return trimmedFields.length > 0 &&
      trimmedFields.every((field) => typeof payload[field] === "string" && (payload[field] as string).length <= maxChars);
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
  autonomousEngine: FridayAutonomousEngine;
  selfHealing: FridaySelfHealingApiService;
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
  /** Optional SSRF guard policy (e.g. `{ allowPrivateNetwork: true }` for test environments). */
  ssrfPolicy?: FridaySsrfPolicy;
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
  /** Resolved SSRF policy for provider/agent network access. */
  ssrfPolicy?: FridaySsrfPolicy;
}
