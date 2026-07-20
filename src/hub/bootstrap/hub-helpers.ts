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
import { type FridayConfig, type LoadedFridayConfig, parseFridayConfig, writeFridayConfig } from "#config";
import { FridayDomainError } from "#errors";
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
import type { FridaySkillExecutor, FridaySkillRegistry, FridaySkillRepository, SkillLifecycleStatus } from "#skills";
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
import type { FridayMcpAdapter } from "../../agent/mcp/friday-mcp-adapter.types.js";
import { parseFridaySecretInput } from "../../security/friday-secret-ref.js";
import type { RustRouteProbeOutcome } from "../../diagnostics/friday-rust-route-self-probe.js";

// ─── Constants ───

/** Directory for persisted secrets. */
const FRIDAY_SECRET_DIR = path.join(os.homedir(), ".friday");
/** File for persisted token secret. */
const FRIDAY_TOKEN_SECRET_FILE = path.join(FRIDAY_SECRET_DIR, "token.secret");

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

function normalizeFridayChannelApprovalPrincipalSegment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

export function resolveFridayChannelApprovalPrincipalId(input: {
  channelKind: string;
  chatId: string;
  senderId: string;
}): string {
  return [
    "channel",
    normalizeFridayChannelApprovalPrincipalSegment(input.channelKind),
    normalizeFridayChannelApprovalPrincipalSegment(input.chatId),
    "sender",
    normalizeFridayChannelApprovalPrincipalSegment(input.senderId),
  ].join(":");
}

export function canResolveFridayChannelApprovalFromMessage(input: {
  route: {
    channelKind: string;
    chatId: string;
    senderId: string;
  };
  message: Pick<FridayChannelMessage, "channelKind" | "chatId" | "senderId">;
}): boolean {
  return input.route.channelKind === input.message.channelKind
    && input.route.chatId === input.message.chatId
    && input.route.senderId === input.message.senderId;
}

export function createFridayChannelToolApprovalShortId(runId: string, toolCallId: string): string {
  const source = `${runId}:${toolCallId}`.replace(/[^a-z0-9]/gi, "");
  return (source.slice(-6) || "ACTION").toUpperCase();
}

export type FridayChannelApprovalExpiryDecision =
  | { expired: false }
  | {
    expired: true;
    reason: "approval_expired" | "approval_expiration_invalid";
  };

export function evaluateFridayChannelApprovalExpiry(input: {
  expiresAt: string;
  nowIso: string;
}): FridayChannelApprovalExpiryDecision {
  const expiresAtMs = Date.parse(input.expiresAt);
  const nowMs = Date.parse(input.nowIso);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
    return {
      expired: true,
      reason: "approval_expiration_invalid",
    };
  }
  if (expiresAtMs <= nowMs) {
    return {
      expired: true,
      reason: "approval_expired",
    };
  }
  return { expired: false };
}

export interface FridayChannelTerminalTextInput {
  status: "completed" | "failed" | "cancelled";
  response: string;
  imageCount: number;
  sourceText?: string;
}

export function stripFridayUiActionHints(text: string): string {
  return text.replace(/<!--action:.*?-->/gs, "").trim();
}

const FRIDAY_CHANNEL_INTERNAL_LEAK_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:DSML|tool[_ -]?call|tool_calls|tool_use|planner|debug trace|raw json|internal protocol)\b/iu,
  /\b(?:memory_search|workflow_list|workflow_run|skills_list|agents_list|spawn_subagent)\b/iu,
  /\b(?:read[- ]?only sub[- ]?agent|sub[- ]?agent handoff|workflow_run is blocked)\b/iu,
  /<\s*(?:tool_use|tool_result|dsml)\b/iu,
  /^\s*[{[]\s*"(?:tool_calls|name|arguments|input|handoff)"/iu,
];

export function sanitizeFridayChannelVisibleReply(text: string): string {
  const stripped = stripFridayUiActionHints(text);
  if (stripped.length === 0) {
    return "";
  }
  const filtered = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !FRIDAY_CHANNEL_INTERNAL_LEAK_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return filtered.length > 0
    ? filtered
    : "I handled the request safely. I will ask before starting anything risky.";
}

export function resolveFridayChannelTerminalText(input: FridayChannelTerminalTextInput): string {
  const response = sanitizeFridayChannelVisibleReply(input.response);
  const hasResponse = response.length > 0;
  const hasImages = input.imageCount > 0;
  const isChinese = /[\u4e00-\u9fff]/u.test(input.sourceText ?? "");

  if (isChinese) {
    if (input.status === "completed" && !hasResponse) {
      return hasImages
        ? "已完成，已附上输出。"
        : "已完成。";
    }
    if (input.status === "failed" && !hasResponse) {
      return "请求失败，请重试。";
    }
    if (input.status === "cancelled" && !hasResponse) {
      return "请求已取消，未完成。";
    }
    if (input.status === "failed" && hasResponse) {
      return `请求失败：${response}`;
    }
    if (input.status === "cancelled" && hasResponse) {
      return `请求已取消：${response}`;
    }
    return response;
  }

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
    return `Request failed: ${response}`;
  }
  if (input.status === "cancelled" && hasResponse) {
    return `Request cancelled: ${response}`;
  }
  return response;
}

export function buildFridayChannelDeliveryFailureText(runId: string, sourceText?: string): string {
  if (/[\u4e00-\u9fff]/u.test(sourceText ?? "")) {
    return `请求已完成，但消息发送失败（E-CH-OUTBOUND-001）。关联 ID：${runId}。`;
  }
  return (
    "I completed your request, but delivery failed (E-CH-OUTBOUND-001). " +
    `Correlation: ${runId}. You can query /v1/agent/runs/${runId}.`
  );
}

export function buildFridayChannelMessageTooLongText(maxLength: number, sourceText?: string): string {
  if (/[\u4e00-\u9fff]/u.test(sourceText ?? "")) {
    return `消息太长（最多 ${String(maxLength)} 个字符）。`;
  }
  return `Message too long (max ${String(maxLength)} chars).`;
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
  controlConfirmed?: unknown;
  controlConfirmedAt?: unknown;
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
    if (entry.enabled === true && entry.controlConfirmed === false) continue;

    const baseConfig = entry.config;
    const config =
      baseConfig && typeof baseConfig === "object" && !Array.isArray(baseConfig)
        ? baseConfig as Record<string, unknown>
        : {};

    instances.push({
      kind,
      enabled: entry.enabled !== false,
      ...config,
      ...(typeof entry.controlConfirmedAt === "string" && entry.controlConfirmedAt.trim().length > 0
        ? { setupActivatedAt: entry.controlConfirmedAt.trim() }
        : {}),
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
          delete config[field.field];
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
          delete config[field.field];
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
          delete config[field.field];
          errors.push(
            `File secret ref must use an absolute path for channel ${instance.kind}.${field.field}`,
          );
          continue;
        }
        try {
          const fileValue = fs.readFileSync(parsed.path, "utf8").trim();
          if (fileValue.length === 0) {
            delete config[field.field];
            errors.push(
              `Secret file "${parsed.path}" is empty for channel ${instance.kind}.${field.field}`,
            );
          } else {
            config[field.field] = fileValue;
          }
        } catch (err) {
          delete config[field.field];
          errors.push(
            `Failed to read secret file "${parsed.path}" for channel ${instance.kind}.${field.field}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }

      if (parsed.kind === "command-ref") {
        delete config[field.field];
        errors.push(
          `Command secret refs are disabled for channel ${instance.kind}.${field.field}; use env:, file:, or secret:// refs instead`,
        );
        continue;
      }
    }

    if (secretPolicy === "strict") { // pragma: allowlist secret
      delete config[field.field];
      errors.push(
        `Plaintext secret is blocked by policy for channel ${instance.kind}.${field.field}; use env:, $ENV_VAR, file:, or secret://...`,
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

// ─── Config manager ───

const FRIDAY_HUB_CONFIG_SETTINGS_KEY = "runtime.config.current";

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function setPathValue(target: Record<string, unknown>, pathKey: string, value: unknown): void {
  const parts = pathKey.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return;
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index]!;
    const current = cursor[part];
    if (!isJsonRecord(current)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function getPathValue(source: Record<string, unknown>, pathKey: string): unknown {
  const parts = pathKey.split(".").map((part) => part.trim()).filter(Boolean);
  let cursor: unknown = source;
  for (const part of parts) {
    if (!isJsonRecord(cursor) || !(part in cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function mergeConfigPatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = cloneJsonRecord(base);
  for (const [key, value] of Object.entries(patch)) {
    if (key.includes(".")) {
      setPathValue(next, key, value);
      continue;
    }
    if (isJsonRecord(value) && isJsonRecord(next[key])) {
      next[key] = mergeConfigPatch(next[key] as Record<string, unknown>, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function collectPatchKeys(patch: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (key.includes(".")) {
      keys.push(pathKey);
      continue;
    }
    if (isJsonRecord(value) && Object.keys(value).length > 0) {
      keys.push(...collectPatchKeys(value, pathKey));
    } else {
      keys.push(pathKey);
    }
  }
  return [...new Set(keys)].sort();
}

function diffConfigKeys(
  before: unknown,
  after: unknown,
  prefix = "",
): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return [];
  }
  if (!isJsonRecord(before) || !isJsonRecord(after)) {
    return prefix ? [prefix] : [];
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    changed.push(...diffConfigKeys(before[key], after[key], childPrefix));
  }
  return [...new Set(changed)].sort();
}

function mapConfigValidationError(error: unknown): {
  field: string;
  rule: string;
  message: string;
}[] {
  if (isJsonRecord(error) && Array.isArray(error.issues)) {
    return error.issues.map((issue) => {
      const record = isJsonRecord(issue) ? issue : {};
      const pathValue = Array.isArray(record.path) ? record.path.join(".") : "";
      return {
        field: pathValue || "config",
        rule: typeof record.code === "string" ? record.code : "invalid",
        message: typeof record.message === "string" ? record.message : "Invalid config value",
      };
    });
  }
  return [{
    field: "config",
    rule: "invalid",
    message: error instanceof Error ? error.message : String(error),
  }];
}

/**
 * B9 / FRI-AUD-021 truth-label rename (2026-05-26): renamed from the prior
 * misleading "stub" name. This implementation actually persists config
 * snapshots + revisions in SQLite (via `stateRuntime.sqlite.withWrite-
 * Transaction` against the `hub_settings` table) and the `/v1/config/*`
 * HTTP routes are wired into the API runtime. Mutations are NOT no-ops.
 * The truthful "Persistent" name matches runtime behavior so future
 * inventories + grep readers do not confuse this with the still-partially-
 * stub `createStubMemoryState`.
 */
export function createPersistentConfigManager(
  config: { stateDir?: string; workspaceRoot?: string; skillDirs: string[] },
  stateRuntime: FridayStateRuntime,
): FridayHubConfigManagerService {
  const skillSettings: FridaySkillRegistrySettings = {
    workspaceDir: config.workspaceRoot ?? config.stateDir ?? ".",
    bundledSkillsDir: config.skillDirs[0] ?? "skills",
    managedSkillsDir: config.skillDirs[1] ?? "managed-skills",
    extraSkillDirs: config.skillDirs.slice(2),
    watchEnabled: false,
    watchDebounceMs: 300,
  };

  const securityProfile: FridaySkillSecurityProfile = {};
  const managedConfigPath = stateRuntime.config.exists
    ? stateRuntime.config.configPath
    : path.join(stateRuntime.stateDir, "friday.config.json5");

  function nowIso(): string {
    return new Date().toISOString();
  }

  function readSnapshot(): { revision: number; config: FridayConfig } {
    return stateRuntime.sqlite.withWriteTransaction((db) => {
      const row = db
        .prepare("SELECT value_json, revision FROM hub_settings WHERE key = ?")
        .get(FRIDAY_HUB_CONFIG_SETTINGS_KEY) as { value_json: string; revision: number } | undefined;
      if (row) {
        const parsed = safeJsonParse<unknown>(row.value_json);
        try {
          return {
            revision: row.revision,
            config: parseFridayConfig(parsed),
          };
        } catch {
          // Fall through to re-seeding from the last known loaded config.
        }
      }

      const current = parseFridayConfig(stateRuntime.config.config);
      const timestamp = nowIso();
      db.prepare(
        `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(FRIDAY_HUB_CONFIG_SETTINGS_KEY, JSON.stringify(current), timestamp, timestamp);
      db.prepare(
        `INSERT OR IGNORE INTO config_revisions
         (id, revision, patch_json, full_snapshot_json, changed_keys_json, reason, created_at)
         VALUES (?, 1, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        JSON.stringify({ initial: true }),
        JSON.stringify(current),
        JSON.stringify([]),
        "Initial runtime config snapshot",
        timestamp,
      );
      return { revision: 1, config: current };
    });
  }

  function persistSnapshot(input: {
    nextConfig: FridayConfig;
    nextRevision: number;
    patch: Record<string, unknown>;
    changedKeys: string[];
    reason?: string;
    revertedFrom?: number;
  }): void {
    const timestamp = nowIso();
    stateRuntime.sqlite.withWriteTransaction((db) => {
      db.prepare(
        `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      ).run(
        FRIDAY_HUB_CONFIG_SETTINGS_KEY,
        JSON.stringify(input.nextConfig),
        input.nextRevision,
        timestamp,
        timestamp,
      );
      db.prepare(
        `INSERT INTO config_revisions
         (id, revision, patch_json, full_snapshot_json, changed_keys_json, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        input.nextRevision,
        JSON.stringify(input.revertedFrom === undefined
          ? input.patch
          : { revertToRevision: input.patch.toRevision, revertedFrom: input.revertedFrom }),
        JSON.stringify(input.nextConfig),
        JSON.stringify(input.changedKeys),
        input.reason ?? null,
        timestamp,
      );
    });
    stateRuntime.config = {
      ...stateRuntime.config,
      config: input.nextConfig,
      configPath: managedConfigPath,
      exists: true,
      rawText: JSON.stringify(input.nextConfig, null, 2),
    };
  }

  return {
    getCurrentConfig: async (): Promise<LoadedFridayConfig> => {
      const snapshot = readSnapshot();
      return {
        ...stateRuntime.config,
        config: snapshot.config,
        configPath: managedConfigPath,
        exists: true,
        rawText: JSON.stringify(snapshot.config, null, 2),
        runtimeStateDir: stateRuntime.stateDir,
        workspaceRoot: config.workspaceRoot ?? config.stateDir ?? ".",
        launchCwd: process.cwd(),
      };
    },
    getConfig: async (keys) => {
      const snapshot = readSnapshot();
      if (!keys || keys.length === 0) {
        return {
          revision: snapshot.revision,
          settings: cloneJsonRecord(snapshot.config) as unknown as Record<string, unknown>,
        };
      }
      const full = snapshot.config as unknown as Record<string, unknown>;
      const settings: Record<string, unknown> = {};
      for (const key of keys) {
        const value = getPathValue(full, key);
        if (value !== undefined) {
          settings[key] = value;
        }
      }
      return { revision: snapshot.revision, settings };
    },
    validatePatch: async (patch) => {
      try {
        const snapshot = readSnapshot();
        parseFridayConfig(mergeConfigPatch(
          snapshot.config as unknown as Record<string, unknown>,
          patch,
        ));
        return { valid: true, errors: [] };
      } catch (error) {
        return { valid: false, errors: mapConfigValidationError(error) };
      }
    },
    applyPatch: async (params) => {
      const snapshot = readSnapshot();
      if (params.expectedRevision !== snapshot.revision) {
        throw new FridayDomainError(
          "CONFIG_REVISION_CONFLICT",
          `Config revision conflict: expected ${String(params.expectedRevision)}, current ${String(snapshot.revision)}`,
          { httpStatus: 409 },
        );
      }
      const candidateRaw = mergeConfigPatch(
        snapshot.config as unknown as Record<string, unknown>,
        params.patch,
      );
      const nextConfig = parseFridayConfig(candidateRaw);
      const changedKeys = diffConfigKeys(snapshot.config, nextConfig);
      const nextRevision = snapshot.revision + 1;
      await writeFridayConfig(nextConfig, {
        configPath: managedConfigPath,
        backupCount: nextConfig.backups.configBackupCount,
      });
      persistSnapshot({
        nextConfig,
        nextRevision,
        patch: params.patch,
        changedKeys: changedKeys.length > 0 ? changedKeys : collectPatchKeys(params.patch),
        reason: params.reason,
      });
      return { revision: nextRevision, changedKeys };
    },
    listRevisions: async (cursor, limit) => {
      const safeLimit = Math.min(Math.max(limit ?? 50, 1), 100);
      const beforeRevision = cursor && Number.isInteger(Number(cursor))
        ? Number(cursor)
        : undefined;
      const rows = stateRuntime.sqlite.withReadConnection((db) => (
        beforeRevision
          ? db.prepare(
            `SELECT * FROM config_revisions
             WHERE revision < ?
             ORDER BY revision DESC
             LIMIT ?`,
          ).all(beforeRevision, safeLimit + 1)
          : db.prepare(
            `SELECT * FROM config_revisions
             ORDER BY revision DESC
             LIMIT ?`,
          ).all(safeLimit + 1)
      )) as Array<{
        id: string;
        revision: number;
        patch_json: string;
        full_snapshot_json: string;
        changed_keys_json: string;
        changed_by_user_id: string | null;
        reason: string | null;
        created_at: string;
      }>;
      const page = rows.slice(0, safeLimit);
      return {
        items: page.map((row) => ({
          id: row.id,
          revision: row.revision,
          patch: safeJsonParse<Record<string, unknown>>(row.patch_json) ?? {},
          fullSnapshot: safeJsonParse<Record<string, unknown>>(row.full_snapshot_json) ?? {},
          changedKeys: safeJsonParse<string[]>(row.changed_keys_json) ?? [],
          changedByUserId: row.changed_by_user_id ?? undefined,
          reason: row.reason ?? undefined,
          createdAt: row.created_at,
        })),
        ...(rows.length > safeLimit ? { nextCursor: String(page.at(-1)!.revision) } : {}),
      };
    },
    revertToRevision: async (toRevision) => {
      const snapshot = readSnapshot();
      const row = stateRuntime.sqlite.withReadConnection((db) =>
        db.prepare("SELECT full_snapshot_json FROM config_revisions WHERE revision = ?")
          .get(toRevision),
      ) as { full_snapshot_json: string } | undefined;
      if (!row) {
        throw new FridayDomainError("CONFIG_REVISION_NOT_FOUND", "Config revision not found", { httpStatus: 404 });
      }
      const nextConfig = parseFridayConfig(safeJsonParse<unknown>(row.full_snapshot_json));
      const changedKeys = diffConfigKeys(snapshot.config, nextConfig);
      const nextRevision = snapshot.revision + 1;
      await writeFridayConfig(nextConfig, {
        configPath: managedConfigPath,
        backupCount: nextConfig.backups.configBackupCount,
      });
      persistSnapshot({
        nextConfig,
        nextRevision,
        patch: { toRevision },
        changedKeys,
        reason: `Reverted to revision ${String(toRevision)}`,
        revertedFrom: snapshot.revision,
      });
      return {
        revision: nextRevision,
        changedKeys,
        revertedFrom: snapshot.revision,
      };
    },
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
  configManager?: FridayHubConfigManagerService;
  providerService?: FridayProviderService;
  workflowRuntime?: FridayWorkflowRuntime;
  skillGenerator?: FridaySkillGeneratorService;
  nowIso: () => string;
}): FridayHubAutoFixExecutionSupport {
  // P2-07: External-state remediation must be backed by hub-level services.
  // The execution service fails closed for these kinds unless an executor is
  // injected here.
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

  const readRecordField = (
    payload: Record<string, unknown> | null,
    ...keys: string[]
  ): Record<string, unknown> | undefined => {
    for (const key of keys) {
      const value = payload?.[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
    return undefined;
  };

  stepExecutors.disable_skill = async (step) => {
    if (!step.target) {
      return false;
    }

    const payload = readPayloadRecord(step.payload);
    const revert = isRevertPayload(step.payload);
    if (!revert && !deps.registry.get(step.target)) {
      return false;
    }

    const nextStatus = revert ? "installed" : "disabled";
    const nowIso = deps.nowIso();
    await deps.memoryState.updateSkillStatus(
      step.target,
      nextStatus,
      revert
        ? `auto-fix rollback @ ${nowIso}`
        : `auto-fix disable_skill @ ${nowIso}`,
    );
    // Durable persistence is provided by createDurableMemoryState (audit E3, PR #406): the
    // updateSkillStatus wrapper above persists to the skills table for in-store skills. No
    // second persist path here.
    if (payload) {
      payload._skillDisabled = !revert;
      payload._skillStatusAfter = nextStatus;
      payload._skillStatusTarget = step.target;
      payload._skillStatusAt = nowIso;
    }
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

  stepExecutors.apply_config_patch = async (step) => {
    if (!step.target) {
      return false;
    }
    const payload = readPayloadRecord(step.payload);
    if (!payload) {
      return false;
    }

    const revert = isRevertPayload(step.payload);
    if (revert) {
      const toRevision = readNumber(payload, "toRevision") ?? readNumber(payload, "_configPatchPreviousRevision");
      if (deps.configManager && toRevision !== undefined) {
        const result = await deps.configManager.revertToRevision(toRevision);
        payload._configPatchRolledBack = true;
        payload._configPatchRolledBackToRevision = toRevision;
        payload._configPatchRollbackRevision = result.revision;
        payload._configPatchChangedKeys = result.changedKeys;
      } else {
        payload._configPatchRolledBack = true;
        payload._configPatchRollbackMode = "diagnostic_marker";
      }
      payload._configPatchTarget = step.target;
      payload._configPatchRollbackAt = deps.nowIso();
      return true;
    }

    const patch = readRecordField(payload, "patch", "configPatch");
    if (!patch) {
      // Phase 14.5B module_28b: fail-closed when no real patch payload is
      // present. The previous "diagnostic_marker" shortcut allowed an
      // apply_config_patch step to claim success without applying a real
      // config change, which the execution verifier then accepted as a
      // verified repair. Self-heal must distinguish diagnostic completion
      // from verified repair — no patch, no repair claim.
      payload._configPatchApplied = false;
      payload._configPatchMode = "diagnostic_only";
      payload._configPatchTarget = step.target;
      payload._configPatchAt = deps.nowIso();
      return false;
    }
    if (!deps.configManager) {
      return false;
    }
    const validation = await deps.configManager.validatePatch(patch);
    if (!validation.valid) {
      payload._configPatchValidationErrors = validation.errors;
      return false;
    }
    const current = await deps.configManager.getConfig();
    const expectedRevision = readNumber(payload, "expectedRevision") ?? current.revision;
    const result = await deps.configManager.applyPatch({
      expectedRevision,
      patch,
      reason: readString(payload, "reason", "fix") ?? `auto-fix apply_config_patch @ ${deps.nowIso()}`,
    });
    payload._configPatchPreviousRevision = current.revision;
    payload._configPatchRevision = result.revision;
    payload._configPatchChangedKeys = result.changedKeys;

    payload._configPatchApplied = true;
    payload._configPatchTarget = step.target;
    payload._configPatchAt = deps.nowIso();
    return true;
  };

  stepVerifiers.apply_config_patch = async (step) => {
    const payload = readPayloadRecord(step.payload);
    if (!payload) {
      return false;
    }
    if (isRevertPayload(step.payload)) {
      return payload._configPatchRolledBack === true;
    }
    // Phase 14.5B module_28b: verified repair requires both the executor's
    // applied flag AND a real config revision returned by configManager.
    // _configPatchApplied alone is no longer sufficient — diagnostic-only
    // payloads (no real `patch`) cannot pass verification.
    return payload._configPatchApplied === true &&
      typeof payload._configPatchRevision === "number" &&
      Number.isFinite(payload._configPatchRevision) &&
      (typeof payload._configPatchTarget !== "string" || payload._configPatchTarget === step.target);
  };

  const workflowRuntime = deps.workflowRuntime;
  if (workflowRuntime) {
    const sleep = async (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));

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
      const verifySpec = "verify" in step ? step.verify : undefined;
      const verifyMethod = verifySpec?.method;
      const timeoutMs = typeof verifySpec?.timeoutMs === "number"
        ? Math.max(0, verifySpec.timeoutMs)
        : 0;
      const deadline = Date.now() + timeoutMs;

      while (true) {
        const relevantNodes = nodeId
          ? workflowRuntime.execution.getRunNodes(runId).filter((node) => node.nodeId === nodeId)
          : workflowRuntime.execution.getRunNodes(runId);
        const currentCount = relevantNodes.length;
        if (payload?._retryRequested !== true || currentCount <= beforeCount) {
          if (Date.now() >= deadline) {
            return false;
          }
          await sleep(Math.min(50, Math.max(10, timeoutMs || 10)));
          continue;
        }

        if (verifyMethod !== "error_absent" && verifyMethod !== "node_retry_success") {
          return true;
        }

        const latestNode = relevantNodes.at(-1);
        if (latestNode?.status === "completed") {
          return true;
        }
        if (latestNode?.status === "failed") {
          return false;
        }
        if (!nodeId) {
          const run = workflowRuntime.execution.getRun(runId);
          if (run?.status === "completed") {
            return true;
          }
          if (run?.status === "failed" || run?.status === "cancelled") {
            return false;
          }
        }
        if (Date.now() >= deadline) {
          return false;
        }
        await sleep(Math.min(50, Math.max(10, timeoutMs || 10)));
      }
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
          costMode: normalizedRouting.costMode,
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
        costMode: normalizedRouting.costMode,
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

  const skillGenerator = deps.skillGenerator;
  if (skillGenerator) {
    stepExecutors.regenerate_skill = async (step) => {
      const payload = readPayloadRecord(step.payload);
      const skillId = readString(payload, "skillId") ?? step.target;
      if (!skillId) {
        return false;
      }

      const revert = isRevertPayload(step.payload);
      if (revert) {
        // Restore the prior status captured at plan-build time (never default-enable): a
        // 'not_installed' candidate is restored to 'not_installed', never promoted to 'installed';
        // absent capture falls back to the safe 'disabled' (not an enable). The write is persisted
        // durably by createDurableMemoryState's updateSkillStatus wrapper (audit E3, PR #406).
        const restore = (readString(payload, "restoreStatus") as SkillLifecycleStatus | undefined) ?? "disabled";
        await deps.memoryState.updateSkillStatus(
          skillId,
          restore,
          `auto-fix rollback regenerate_skill @ ${deps.nowIso()}`,
        );
        if (payload) {
          payload._skillRegenerated = true;
          payload._regenerateRolledBack = true;
          payload._regeneratedAt = deps.nowIso();
          payload._skillStatusAfter = restore;
        }
        return true;
      }

      const errorContext = readString(payload, "errorContext") ?? "Unknown failure";
      const recurrenceCount = readNumber(payload, "recurrenceCount") ?? 0;
      const goal = `Regenerate skill "${skillId}" that has failed ${String(recurrenceCount)} time(s). Original error: ${errorContext}. Generate an improved replacement that fixes the failure.`;

      const userId = readString(payload, "userId") ?? "system";

      const turnResponse = await skillGenerator.startSession({
        goal,
        userId,
        channel: "auto-fix",
      });

      const sessionId = turnResponse.session.sessionId;
      const draft = await skillGenerator.generateDraft(sessionId);
      const saved = await skillGenerator.approveAndSave(sessionId);

      await deps.memoryState.updateSkillStatus(
        skillId,
        "installed",
        `auto-fix regenerate_skill @ ${deps.nowIso()}`,
      );

      if (payload) {
        payload._skillRegenerated = true;
        payload._regeneratedAt = deps.nowIso();
        payload._regenerateSessionId = sessionId;
        payload._regenerateCandidateId = saved.candidateId;
        payload._regenerateDraftName = draft.manifest.name;
      }
      return true;
    };

    stepVerifiers.regenerate_skill = async (step) => {
      const payload = readPayloadRecord(step.payload);
      const skillId = readString(payload, "skillId") ?? step.target;
      if (!skillId) {
        return false;
      }
      if (isRevertPayload(step.payload)) {
        // Verify the captured prior status was restored (in-process; the write is persisted
        // durably by createDurableMemoryState).
        const restore = (readString(payload, "restoreStatus") as SkillLifecycleStatus | undefined) ?? "disabled";
        const statuses = await deps.memoryState.listSkillStatuses();
        return statuses[skillId] === restore;
      }
      const statuses = await deps.memoryState.listSkillStatuses();
      return payload?._skillRegenerated === true && statuses[skillId] === "installed";
    };
  }

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

/**
 * Audit E (E3): durable memory-state whose EXPLICIT skill-lifecycle transitions
 * (install / disable / enable / regenerate / error / not_installed via
 * `updateSkillStatus`) are persisted to the durable `skills` table, so a
 * self-heal disable (or any explicit transition) SURVIVES a hub restart. The
 * workflow-execution safety gate (`getPersistedSkillLifecycleStatus`) reads the
 * `skills` table, so persisting the explicit transition there is what makes the
 * gate keep blocking a disabled skill after restart.
 *
 * DELIBERATELY NARROW — only `updateSkillStatus` is made durable:
 *   - `upsertDiscoveredSkills` (registry discovery snapshot) and
 *     `listSkillStatuses` stay IN-MEMORY (delegated to the stub). Discovery
 *     must NOT write the table, or its auto-installed `installed` would CLOBBER
 *     the converter's `not_installed` for an unpromoted candidate and defeat
 *     the execution gate. Keeping discovery in-memory preserves the converter's
 *     persisted lifecycle status as the source of truth.
 *   - The durable write is best-effort: `updateLifecycleStatus` is an UPDATE,
 *     so it persists only for skills that already have a `skills` row (the
 *     converter-imported / promoted skills the gate actually governs). A
 *     bundled skill that has no `skills` row is not gated by the table and
 *     auto-reinstalls on discovery by design — its in-memory status is
 *     unchanged from before (no regression).
 */
export function createDurableMemoryState(deps: {
  db: FridaySqliteLayer;
  skillRepository: FridaySkillRepository;
  nowIso: () => string;
  auditLogPath?: string;
}): FridayHubMemoryStateService {
  const base = createStubMemoryState(deps.auditLogPath);
  return {
    ...base,
    updateSkillStatus: async (skillId: string, status: SkillLifecycleStatus, reason?: string) => {
      // Keep the in-memory view (read by in-flight self-heal verifiers) current.
      await base.updateSkillStatus(skillId, status, reason);
      // Persist the explicit transition to the durable `skills` table (what the
      // execution safety gate reads). Best-effort: a missing row (bundled skill
      // not catalog-written) UPDATEs zero rows and is left to in-memory only.
      deps.db.withWriteTransaction((conn) =>
        deps.skillRepository.updateLifecycleStatus(conn, skillId, status, deps.nowIso()),
      );
    },
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
  mcpAdapter?: FridayMcpAdapter;
  webchatWsService?: WebchatWsService;
  /**
   * F1.5 — Headless Rust-route self-probe diagnostic readback (DARK, DEFAULT-OFF). `lastProbeOutcome`
   * returns the most recent probe result, or `undefined` when the FRIDAY_RUST_ROUTE_DIAGNOSTIC_ENABLED
   * flag is unset (the diagnostic never ran). Read-only; never carries the self-minted bearer.
   */
  rustRouteDiagnostic: {
    lastProbeOutcome(): RustRouteProbeOutcome | undefined;
  };
}

export interface FridayHubStatus {
  state: "starting" | "running" | "stopping" | "stopped";
  skillCount: number;
  upSince: string | null;
}

export interface FridayHubConfig {
  stateDir?: string;
  workspaceRoot?: string;
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
  /** Test-oracle only; production hub creation must leave workflow run execution fail-closed. */
  allowTestOnlyWorkflowRunExecution?: boolean;
  /** Test-oracle only; production hub creation must leave skill run execution fail-closed. */
  allowTestOnlySkillRunExecution?: boolean;
  /** Test-oracle only; production hub creation must not bypass non-Darwin shell sandbox fail-closed behavior. */
  allowTestOnlyNonDarwinShellSandboxExecution?: boolean;
  /** Test-oracle only; production hub creation must leave skill verification fail-closed. */
  allowTestOnlySkillVerifyExecution?: boolean;
  /** Test-oracle only; production hub creation must leave skill generator sessions fail-closed. */
  allowTestOnlySkillGeneratorExecution?: boolean;
  /** Test-oracle only; production hub creation must leave workflow generator sessions fail-closed. */
  allowTestOnlyWorkflowGeneratorExecution?: boolean;
  /** Test-oracle only; production hub creation must leave workflow catalog mutations fail-closed. */
  allowTestOnlyWorkflowCatalogMutationExecution?: boolean;
  /** Test-oracle only; production hub creation must leave workflow deploy fail-closed. */
  allowTestOnlyWorkflowDeployExecution?: boolean;
  /** Test-oracle only; production hub creation must leave workflow builder draft/lock/template authoring fail-closed. */
  allowTestOnlyWorkflowBuilderDraftExecution?: boolean;
  /** Test-oracle only; production hub creation must leave auto-fix execution fail-closed. */
  allowTestOnlyAutoFixExecution?: boolean;
  /** Test-oracle only; production hub creation must leave desktop action execution fail-closed. */
  allowTestOnlyDesktopActionExecution?: boolean;
  /** Test-oracle only; production hub creation must leave desktop recording lifecycle + replay fail-closed. */
  allowTestOnlyDesktopRecordingExecution?: boolean;
  /** Test-oracle only; production hub creation must leave POST /v1/agent/runs fail-closed. */
  allowTestOnlyAgentRunStartExecution?: boolean;
  /** Test-oracle only; production hub creation must leave agent run controls fail-closed. */
  allowTestOnlyAgentRunControlExecution?: boolean;
  /** Test-oracle only; production hub creation must leave the agent run loop executeRun method fail-closed. */
  allowTestOnlyAgentRunExecution?: boolean;
  /** Test-oracle only; production hub creation must leave agent-loop run controls fail-closed. */
  allowTestOnlyAgentLoopRunControlExecution?: boolean;
  /** Test-oracle only; production hub creation must leave agent-loop policy mutations fail-closed. */
  allowTestOnlyAgentLoopPolicyMutation?: boolean;
  /** Test-oracle only; production hub creation must leave autonomy subject upgrade-lifecycle fail-closed. */
  allowTestOnlyAutonomyLifecycleExecution?: boolean;
  /** Test-oracle only; production hub creation must leave standing-goal/agenda mutations fail-closed. */
  allowTestOnlyStandingAgendaExecution?: boolean;
  /** Test-oracle only; production hub creation must leave autonomy-policy patch fail-closed. */
  allowTestOnlyAutonomyPolicyMutation?: boolean;
  /** Test-oracle only; production hub creation must leave capability-acquisition runs fail-closed. */
  allowTestOnlyCapabilityAcquisitionExecution?: boolean;
  /** Test-oracle only; production hub creation must leave session lifecycle/message mutations fail-closed. */
  allowTestOnlySessionExecution?: boolean;
  /** Test-oracle only; production hub creation must leave POST /v1/sessions/:sessionKey/run fail-closed. */
  allowTestOnlySessionRunExecution?: boolean;
  /** Test-oracle only; production hub creation must leave session memory extraction mutations fail-closed. */
  allowTestOnlySessionMemoryExtractionExecution?: boolean;
  /** Test-oracle only; production hub creation must leave legacy TS durable memory writes fail-closed. */
  allowTestOnlyTsMemoryWrites?: boolean;
  /** Test-oracle only; production hub creation must leave /v1/guide-lens/* fail-closed. */
  allowTestOnlyGuideLensExecution?: boolean;
  /** Test-oracle only; production hub creation must leave cross-border pack mutations fail-closed. */
  allowTestOnlyCrossBorderPackExecution?: boolean;
  /** Test-oracle only; production hub creation must leave self-healing diagnosis mutations fail-closed. */
  allowTestOnlyDiagnosisExecution?: boolean;
  /** Test-oracle only; production hub creation must leave the realtime checkpoint-ack mutation fail-closed. */
  allowTestOnlyRealtimeExecution?: boolean;
  /** Test-oracle only; production hub creation must leave inbound satellite runtime mutations (heartbeat/capabilities/sync) fail-closed. */
  allowTestOnlySatelliteRuntimeExecution?: boolean;
  /** Test-oracle only; production hub creation must leave satellite registration/pairing mutations fail-closed. */
  allowTestOnlySatellitePairingExecution?: boolean;
  /** Test-oracle only; production hub creation must leave skill-converter convert/import/pack mutations fail-closed. */
  allowTestOnlySkillConverterExecution?: boolean;
  /** Test-oracle only; production hub creation must leave scan-migrate local-scan + batch-convert product logic fail-closed. */
  allowTestOnlyScanMigrateExecution?: boolean;
  /** Test-oracle only; production hub creation must leave plugin install/enable/disable/uninstall fail-closed. */
  allowTestOnlyPluginExecution?: boolean;
  /** Test-oracle only; production hub creation must leave the provider-detect probe fail-closed. */
  allowTestOnlyProviderDetectExecution?: boolean;
  /** Test-oracle only; production hub creation must leave the provider probe surfaces (validate/doctor/capabilities.doctor) fail-closed. */
  allowTestOnlyProviderProbeExecution?: boolean;
  /** Test-oracle only; production hub creation must leave the provider routing-controls surfaces (routing.pin/routing.penalty.clear) fail-closed. */
  allowTestOnlyProviderRoutingControlsExecution?: boolean;
  /** Test-oracle only; production hub creation must leave the system-service `executeIntent` method fail-closed. */
  allowTestOnlySystemIntentExecution?: boolean;
  /**
   * TS Runtime Retirement — GAP G2: DEFAULT-OFF (INVERTED polarity) guard for the
   * UIX starter-skill execution lane (`executeStarterSkillTemplate`, route
   * POST /v1/uix/templates/:templateId/execute + assistant intent resolver) and
   * the UIX-driven skill-generator session mutators. UIX starter-skill execution
   * is an ACCEPTED-LIVE v1 feature (operator decision DEC-3a) and is NOT in the
   * retirement set, so unlike the `allowTestOnly*` flags this DEFAULTS FALSE —
   * the guard is INERT and starter skills keep working exactly as today (zero
   * degradation). Set `true` only when the operator decides to Rust-own skill
   * execution (R11): the lane then fails closed (503
   * TS_RUNTIME_SKILL_RUNS_RETIRED / TS_RUNTIME_SKILL_GENERATOR_RETIRED).
   * Production leaves this unset.
   */
  enforceUixSkillExecRetirement?: boolean;
  /**
   * execrun-replacement slice 4 (DARK): per-run "route a qualifying agent-run via the
   * future Rust read-only loop" flag. DEFAULT-FALSE — production hub creation must leave
   * this unset so the startRun route stays byte-identical to today (it computes nothing
   * and routes nothing). When true, the route-bound startRun wrapper evaluates the
   * fail-closed qualifying predicate and discards the boolean; NO actual routing is wired
   * in this slice (the later composition slice consumes it).
   */
  routeAgentRunViaRust?: boolean;
  /**
   * (CORE-RUNNABLE-001 / CORE-A CR-3) SESSION Rust-owned lifecycle/run bridge (DARK): "route the
   * session run (`POST /v1/sessions/:sessionKey/run`) to the Rust-owned loop instead of fail-closing
   * with 503" flag. DEFAULT-FALSE — production hub creation must leave this unset so the runtime
   * threads NO `rustSessionLifecycleBridge` and every session route stays byte-identical to today's
   * fail-closed 503. When true, bootstrap builds the REAL sealed-WS session dispatch adapter
   * (mirroring the agent-run sealed-WS config) and injects it. End-to-end closure ALSO needs the
   * provisioned sealed-WS host + answer-readback DB + a real turn (operator-gated). Resolution:
   * `resolveRouteSessionsViaRust` (explicit config wins; otherwise the `FRIDAY_ROUTE_SESSIONS_VIA_RUST`
   * env knob).
   */
  routeSessionsViaRust?: boolean;
  /**
   * GATE-AGENT-REPLACE A3 courier (DARK): master ON/OFF arming the pause/resume PRODUCT
   * TRANSPORT (the sealed WS courier's `AgentRunPaused` inbound + `resumeWithApproval` relay).
   * DEFAULT-FALSE — production hub creation must leave this unset so the courier's paused/resume
   * behavior is inert and the compose path is byte-identical to today. Resolved (config-explicit
   * wins, else `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST`) by `resolveAgentRunControlViaRust` and fed into
   * the api-runtime deps. Mirrors the Phase-2 Rust server's default-off flag of the SAME name; it
   * admits NO mutating run (the read-only qualifier stays hard — a SEPARATE later PR).
   */
  agentRunControlViaRust?: boolean;
  /** D20 W2 signed-batch worktree product entrypoint flag; default false / env fallback. */
  d20SignedBatchWorktreeViaRust?: boolean;
  /** B3 system-intent Rust product courier flag; default false / env fallback. */
  systemIntentViaRust?: boolean;
  /**
   * providers-bridge cut-over (DARK): master ON/OFF for routing the retired Tier-2
   * PROVIDER surfaces (`providers.detect` / `providers.doctor` / `providers.validate` /
   * `capabilities.doctor`) to the merged Rust `hub_providers_detect` /
   * `hub_capability_doctor` bins instead of fail-closing with 503. DEFAULT-FALSE —
   * production hub creation must leave this unset so the routes stay byte-identical to
   * today. Resolved (config-explicit wins, else `FRIDAY_ROUTE_PROVIDERS_VIA_RUST`) by
   * `resolveRouteProvidersViaRust` and fed into the api-runtime deps.
   */
  routeProvidersViaRust?: boolean;
  /**
   * Tier-2 WORKFLOW catalog-mutation route bridge (DARK): "route create/update/archive/
   * publish/deploy via the Rust `hub_workflow_catalog` bin (#657)" flag. DEFAULT-FALSE —
   * production hub creation must leave this unset so the catalog-mutation routes stay
   * byte-identical to today's fail-closed `TS_RUNTIME_WORKFLOW_CATALOG_MUTATION_RETIRED`
   * 503. When true, the catalog-mutation route handlers run auth then route to the
   * refs-only Rust bridge (a `rust_wired_dev` DEV-DB ceiling — see the bridge service).
   * Resolution: `resolveRouteWorkflowsViaRust` (explicit config wins; otherwise the
   * `FRIDAY_ROUTE_WORKFLOWS_VIA_RUST` env knob).
   */
  routeWorkflowsViaRust?: boolean;
  /** Workflow-run start/read Rust bridge flag; default false / env fallback. */
  routeWorkflowRunsViaRust?: boolean;
  /**
   * (Lane B-2) ORGANIC mission-spine POST routes bridge (DARK): "wire a real dispatch adapter into
   * `missionSpine.dispatch` so `/v1/mission-spine/intake|lifecycle|work-item-status` become CALLABLE"
   * flag. DEFAULT-FALSE — production hub creation must leave this unset so `missionSpine.dispatch`
   * stays unset (null) and each POST route returns today's fail-closed 503
   * (`MISSION_SPINE_DISPATCH_UNAVAILABLE`) → byte-identical. When true, bootstrap builds the sealed-WS
   * dispatch adapter (mirroring the agent-run sealed-WS config) and injects it. End-to-end Loop1
   * closure ALSO needs the SERVER flags (`FRIDAY_MISSION_INTAKE`, `FRIDAY_MISSION_SPINE_DISPATCH`) + a
   * deploy + a real mission (operator-gated). Resolution: `resolveRouteMissionSpineViaRust` (explicit
   * config wins; otherwise the `FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST` env knob).
   */
  routeMissionSpineViaRust?: boolean;
  /**
   * (Lane M) ORGANIC memory-confirmation POST route bridge (DARK): "wire a real dispatch adapter into
   * `memorySpine.dispatch` so `/v1/memory-spine/decide` becomes CALLABLE" flag. DEFAULT-FALSE —
   * production hub creation must leave this unset so `memorySpine.dispatch` stays unset (null) and the
   * POST route returns today's fail-closed 503 (`MEMORY_SPINE_DISPATCH_UNAVAILABLE`) → byte-identical.
   * When true, bootstrap builds the sealed-WS dispatch adapter (mirroring the mission-spine sealed-WS
   * config) and injects it. End-to-end memory-confirmation closure ALSO needs the SERVER flags
   * (`FRIDAY_MEMORY_CONFIRM`, `FRIDAY_RUN_LOOP_MEMORY_EXTRACTION`) + a deploy (operator-gated). This
   * client-side knob only makes the TS route CALLABLE. Resolution: `resolveRouteMemorySpineViaRust`
   * (explicit config wins; otherwise the `FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST` env knob).
   */
  routeMemorySpineViaRust?: boolean;
  /**
   * A1 run-outcome learning decision route bridge (DARK): wires a real dispatch adapter into
   * `runOutcomeLearning.dispatch` so `/v1/run-outcome-learning/decide` becomes callable. DEFAULT-FALSE.
   * End-to-end A1 live-done still requires Rust `FRIDAY_RUN_OUTCOME_LEARNING_CONFIRM`, an
   * operator-origin organic candidate, and a real confirm.
   */
  routeRunOutcomeLearningViaRust?: boolean;
  /**
   * (Organic mission→run binding PRODUCER — DARK): "after a fresh-Ready `/v1/mission-spine/intake`,
   * immediately fire a READ-ONLY bound agent-run carrying the server-produced mission handle" flag.
   * DEFAULT-FALSE — production hub creation must leave this unset so the auto-dispatch driver is
   * NEVER constructed, the dispatch adapter's `autoDispatchDriver` option is omitted, `intakeMission`
   * is byte-identical, and no organic run is ever produced. When true (AND `routeMissionSpineViaRust`
   * is also true), bootstrap constructs the driver and wires it into the dispatch adapter. End-to-end
   * joined proof ALSO needs `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` (the Rust read-only route), the SERVER
   * `FRIDAY_MISSION_INTAKE`/`FRIDAY_MISSION_SPINE_DISPATCH` flags, a deploy, and the SecureStore +
   * launchd provisioning (operator-gated). Resolution: `resolveMissionAutoDispatch` (explicit config
   * wins; otherwise the `FRIDAY_MISSION_AUTO_DISPATCH` env knob).
   */
  missionAutoDispatch?: boolean;
}

// ─── Resolved Hub Config ───

export interface FridayResolvedHubConfig {
  stateDir?: string;
  workspaceRoot?: string;
  skillDirs: string[];
  port: number;
  tokenSecret: string;
  tokenSecretSource: FridayTokenSecretResult["source"];
  serverVersion: string;
  corsOrigins: string[];
  logRequests: boolean;
  allowTestOnlyAutonomyLifecycleExecution?: boolean;
  allowTestOnlyPluginExecution?: boolean;
  pluginRuntimeMode: "stub" | "full";
  /** Whether deterministic pipeline execution is globally enabled. */
  pipelineEnabled: boolean;
  /** Deterministic pipeline enforcement mode. */
  pipelineMode: "shadow" | "warn" | "enforce";
  /** Whether hub-wired mutating system/agent paths enforce the canonical approval gate. */
  canonicalMutatingActionGate: boolean;
  /** Resolved SSRF policy for provider/agent network access. */
  ssrfPolicy?: FridaySsrfPolicy;
}
