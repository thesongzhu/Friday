import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridaySqliteLayer } from "#state";
import {
  createFridaySecretRepository,
  decryptSecretWithMigration,
  detectFridayProviderKindFromApiKey,
  encryptSecret,
  FRIDAY_PROVIDER_KIND_SET,
  type FridayProviderApi,
  type FridayProviderAuthMode,
  type FridayProviderKind,
  type FridayProviderService,
  fridaySecretAadContext,
  getFridayProviderAuthModesForBackend,
  getFridayProviderCapability,
  getFridayProviderPreset,
  getStrictMasterKey,
  isFridayProviderAuthModeSupportedForKind,
} from "#providers";
import type { FridayEncryptedEnvelope } from "#providers";
import type { FridaySkillRegistry } from "#skills";
import {
  buildFridayChannelSecretRef,
  buildFridayChannelSecretRefKey,
  FRIDAY_CHANNEL_SECRET_SCOPE,
  FRIDAY_SUPPORTED_CHANNEL_KINDS,
  FRIDAY_UNSUPPORTED_CHANNEL_KINDS,
  FRIDAY_UNSUPPORTED_CHANNEL_MODES,
  getFridayChannelSecretFieldDescriptors,
  isControlCapableChannelKind,
  isFridayChannelKindSupported,
  isFridayChannelModeSupported,
  parseFridayChannelsConfig,
  parseFridayChannelSecretRef,
} from "#channels";
import type { FridaySupportedChannelKind } from "#channels";
import { FridayDomainError } from "#errors";
import { validateGatewayUrl } from "../../../agent/tools/friday-agent-gateway-validation.js";
import { parseFridaySecretInput } from "../../../security/friday-secret-ref.js";
import { isFridayLoopbackAddress } from "../friday-http-client-ip.js";
import { isUnauthenticatedPublicPrincipal } from "../../../security/friday-owner-session-channel-capability.js";
import type { FridayAuthPrincipal } from "../../model/friday-api-auth.types.js";
import type {
  FridayRustHubProvidersDetectService,
  FridayRustProvidersDetectReceipt,
} from "../../mission-spine/friday-rust-hub-providers-detect-bridge-service.js";

// ─── Types ───

type SetupStepId = "welcome" | "security" | "communication" | "provider" | "network" | "channels" | "skills" | "done";
type NetworkMode = "local" | "network" | "custom";

interface DetectProviderRequest {
  apiKey?: string;
  kind?: FridayProviderKind;
  baseUrl?: string;
  authMode?: FridayProviderAuthMode;
}

interface DetectProviderResponse {
  kind: FridayProviderKind;
  confidence: "high" | "medium" | "low";
  baseUrl: string;
  api: FridayProviderApi;
  authMode: FridayProviderAuthMode;
  availableModels: string[];
  defaultModel?: string;
  validated: boolean;
  latencyMs?: number;
  warnings: string[];
}

interface SetupStatusResponse {
  needsSetup: boolean;
  setupCompletedAt: string | null;
  providerCount: number;
  channelCount: number;
  skillsCount: number;
  network: {
    host: string;
    port: number;
    mode: NetworkMode;
    previewUrls: string[];
  };
}

interface SetupNetworkRequest {
  mode: NetworkMode;
  host?: string;
  port: number;
}

interface SetupNetworkResponse {
  host: string;
  port: number;
  mode: NetworkMode;
  previewUrls: string[];
  restartRequired: boolean;
}

interface SetupCompleteRequest {
  completedSteps: SetupStepId[];
  skippedSteps: SetupStepId[];
}

interface SetupCompleteResponse {
  setupCompletedAt: string;
}

interface SetupChannelsRequest {
  controlConfirmed?: boolean;
  channels: Array<{
    kind: FridaySupportedChannelKind;
    enabled: boolean;
    config: Record<string, unknown>;
  }>;
}

interface SetupChannelPersistedConfig {
  kind: FridaySupportedChannelKind;
  enabled: boolean;
  config: Record<string, unknown>;
  controlConfirmed?: boolean;
  controlConfirmedAt?: string;
}

interface SetupChannelsResponse {
  savedKinds: string[];
  activation?: SetupChannelsActivationResponse;
}

interface SetupChannelsActivationResponse {
  startedKinds: string[];
  failed: Array<{ kind: string; message: string }>;
  restartRequired: boolean;
  warnings: string[];
}

interface SetupChannelTestRequest {
  kind: FridaySupportedChannelKind;
  config: Record<string, unknown>;
}

interface SetupChannelTestResponse {
  kind: FridaySupportedChannelKind;
  validated: boolean;
  useFeishu?: boolean;
  receiveMode?: "websocket" | "webhook";
  tokenExpiresInSeconds?: number;
  warnings: string[];
}

interface SetupFeishuRegistrationBeginResponse {
  registrationId: string;
  kind: "feishu";
  domain: "feishu";
  qrUrl: string;
  userCode: string;
  intervalSeconds: number;
  expireInSeconds: number;
  expiresAt: string;
  warnings: string[];
}

interface SetupFeishuRegistrationPollRequest {
  registrationId: string;
}

interface SetupFeishuRegistrationPollResponse {
  registrationId: string;
  kind: "feishu";
  status: "pending" | "slow_down" | "success" | "dm_failed" | "access_denied" | "expired" | "error";
  appId?: string;
  ownerOpenId?: string;
  suggestedAllowedUsers?: string[];
  dmVerified?: boolean;
  welcomeMessageId?: string;
  intervalSeconds?: number;
  expiresAt?: string;
  message?: string;
  warnings: string[];
}

interface SetupTelegramVerificationBeginRequest {
  botToken?: string;
}

interface SetupTelegramVerificationBeginResponse {
  verificationId: string;
  kind: "telegram";
  status: "pending";
  botUserId: string;
  botUsername?: string;
  botName: string;
  startCode: string;
  startUrl?: string;
  expiresAt: string;
  warnings: string[];
}

interface SetupTelegramVerificationPollRequest {
  verificationId: string;
}

interface SetupTelegramVerificationPollResponse {
  verificationId: string;
  kind: "telegram";
  status: "pending" | "success" | "expired" | "error";
  botUserId?: string;
  botUsername?: string;
  chatId?: string;
  userId?: string;
  welcomeMessageId?: string;
  expiresAt?: string;
  message?: string;
  warnings: string[];
}

interface SetupDiscordVerificationBeginRequest {
  token?: string;
  guildId?: string;
}

interface SetupDiscordVerificationBeginResponse {
  verificationId: string;
  kind: "discord";
  status: "ready";
  applicationId: string;
  botUserId: string;
  botUsername: string;
  inviteUrl: string;
  guildId?: string;
  guildVerified?: boolean;
  expiresAt: string;
  warnings: string[];
}

interface SetupDiscordVerificationCompleteRequest {
  verificationId: string;
  userId?: string;
  guildId?: string;
}

interface SetupDiscordVerificationCompleteResponse {
  verificationId: string;
  kind: "discord";
  status: "success" | "dm_failed" | "expired" | "error";
  applicationId?: string;
  botUserId?: string;
  botUsername?: string;
  guildId?: string;
  guildVerified?: boolean;
  userId?: string;
  dmVerified?: boolean;
  welcomeMessageId?: string;
  message?: string;
  warnings: string[];
}

// ─── DB row type ───

interface SetupStateRow {
  id: string;
  setup_completed_at: string | null;
  completed_steps: string;
  skipped_steps: string;
  network_mode: string;
  network_host: string;
  network_port: number;
  channels_json: string;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ───

const VALID_KINDS = FRIDAY_PROVIDER_KIND_SET;
const VALID_AUTH_MODES = new Set<string>(["api-key", "bearer-token", "oauth", "token", "none"]);
const VALID_NETWORK_MODES = new Set<string>(["local", "network", "custom"]);
const VALID_CHANNEL_KINDS = new Set<string>(FRIDAY_SUPPORTED_CHANNEL_KINDS);
const VALID_STEP_IDS = new Set<string>(["welcome", "security", "communication", "provider", "network", "channels", "skills", "done"]);

const channelSecretRepository = createFridaySecretRepository();
const FEISHU_API_BASE = "https://open.feishu.cn";
const LARK_API_BASE = "https://open.larksuite.com";
const FEISHU_ACCOUNTS_BASE = "https://accounts.feishu.cn";
const FEISHU_APP_REGISTRATION_PATH = "/oauth/v1/app/registration";
const LARK_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const LARK_SEND_MESSAGE_PATH = "/open-apis/im/v1/messages";
const TELEGRAM_API_BASE = "https://api.telegram.org";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_BOT_INVITE_PERMISSIONS = "274878024768";
const CHANNEL_TEST_TIMEOUT_MS = 8_000;
const FEISHU_REGISTRATION_TIMEOUT_MS = 10_000;
const FEISHU_REGISTRATION_SESSION_TTL_MS = 15 * 60 * 1000;
const CHANNEL_SETUP_VERIFICATION_SESSION_TTL_MS = 15 * 60 * 1000;

interface FeishuAppRegistrationResult {
  appId: string;
  appSecret: string;
  ownerOpenId?: string;
  dmVerified: boolean;
  welcomeMessageId?: string;
  dmError?: string;
}

interface FeishuAppRegistrationSession {
  registrationId: string;
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  intervalSeconds: number;
  expireInSeconds: number;
  expiresAtMs: number;
  result?: FeishuAppRegistrationResult;
}

interface TelegramSetupVerificationResult {
  chatId: string;
  userId: string;
  welcomeMessageId: string;
}

interface TelegramSetupVerificationSession {
  verificationId: string;
  botToken: string;
  botUserId: string;
  botUsername?: string;
  botName: string;
  startCode: string;
  updateOffset?: number;
  expiresAtMs: number;
  result?: TelegramSetupVerificationResult;
}

interface DiscordSetupVerificationResult {
  userId: string;
  dmVerified: boolean;
  welcomeMessageId?: string;
  guildId?: string;
  guildVerified?: boolean;
  error?: string;
}

interface DiscordSetupVerificationSession {
  verificationId: string;
  token: string;
  applicationId: string;
  botUserId: string;
  botUsername: string;
  guildId?: string;
  guildVerified?: boolean;
  inviteUrl: string;
  expiresAtMs: number;
  result?: DiscordSetupVerificationResult;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function normalizeStringField(config: Record<string, unknown>, field: string): void {
  const value = config[field];
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    delete config[field];
    return;
  }
  config[field] = trimmed;
}

function normalizeSetupChannelConfig(
  kind: FridaySupportedChannelKind,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...config };

  for (const field of Object.keys(normalized)) {
    normalizeStringField(normalized, field);
  }

  for (const field of ["allowedUsers", "allowedChats", "allowedChannels", "allowedGroups", "channels"]) {
    const list = normalizeStringList(normalized[field]);
    if (list) {
      normalized[field] = list;
    } else if (typeof normalized[field] === "string" || Array.isArray(normalized[field])) {
      delete normalized[field];
    }
  }

  if (kind === "lark" || kind === "feishu") {
    normalized.useFeishu = kind === "feishu" ? true : normalizeBoolean(normalized.useFeishu) ?? false;
    if (typeof normalized.receiveMode === "string") {
      normalized.receiveMode = normalized.receiveMode.trim().toLowerCase();
    }
  }

  return normalized;
}

function requireTrimmedChannelString(
  config: Record<string, unknown>,
  field: string,
  kind: FridaySupportedChannelKind,
): string {
  const value = config[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${field} is required for channel ${kind}`,
      { httpStatus: 400 },
    );
  }
  return value.trim();
}

async function testLarkLikeChannelConnection(
  kind: FridaySupportedChannelKind,
  config: Record<string, unknown>,
): Promise<SetupChannelTestResponse> {
  const appId = requireTrimmedChannelString(config, "appId", kind);
  const appSecret = requireTrimmedChannelString(config, "appSecret", kind);
  const useFeishu = kind === "feishu" || normalizeBoolean(config.useFeishu) === true;
  const receiveMode = config.receiveMode === "webhook" ? "webhook" : "websocket";
  const apiBase = useFeishu ? FEISHU_API_BASE : LARK_API_BASE;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHANNEL_TEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${apiBase}${LARK_TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new FridayDomainError(
      "CHANNEL_CONNECTION_FAILED",
      aborted
        ? "Timed out while testing the Lark/Feishu app credentials."
        : `Could not reach the Lark/Feishu token endpoint: ${error instanceof Error ? error.message : String(error)}`,
      { httpStatus: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let data: {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  try {
    data = JSON.parse(responseText) as typeof data;
  } catch {
    throw new FridayDomainError(
      "CHANNEL_CONNECTION_FAILED",
      `Lark/Feishu token endpoint returned non-JSON response (${response.status}).`,
      { httpStatus: 502 },
    );
  }

  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new FridayDomainError(
      "CHANNEL_CREDENTIAL_INVALID",
      `Lark/Feishu credential test failed: ${data.code ?? response.status} ${data.msg ?? response.statusText}`,
      { httpStatus: 400 },
    );
  }

  return {
    kind,
    validated: true,
    useFeishu,
    receiveMode,
    tokenExpiresInSeconds: typeof data.expire === "number" ? data.expire : undefined,
    warnings: [
      "Credential validation only confirms App ID/App Secret. Message receiving still requires bot permissions and event subscription in the Feishu/Lark developer console.",
    ],
  };
}

const telegramVerificationSessions = new Map<string, TelegramSetupVerificationSession>();
const discordVerificationSessions = new Map<string, DiscordSetupVerificationSession>();

function pruneChannelSetupVerificationSessions(nowMs = Date.now()): void {
  for (const [verificationId, session] of telegramVerificationSessions.entries()) {
    if (session.expiresAtMs <= nowMs) {
      telegramVerificationSessions.delete(verificationId);
    }
  }
  for (const [verificationId, session] of discordVerificationSessions.entries()) {
    if (session.expiresAtMs <= nowMs) {
      discordVerificationSessions.delete(verificationId);
    }
  }
}

async function readJsonResponse<T>(response: Response, errorCode: string, label: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FridayDomainError(
      errorCode,
      `${label} returned non-JSON response (${response.status}).`,
      { httpStatus: 502 },
    );
  }
}

function telegramBotApiUrl(botToken: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
}

async function postTelegramBotApi<T extends { ok?: boolean; description?: string }>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithTimeout(telegramBotApiUrl(botToken, method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new FridayDomainError(
      "TELEGRAM_CONNECTION_FAILED",
      aborted
        ? `Timed out while calling Telegram ${method}.`
        : `Could not reach Telegram ${method}: ${error instanceof Error ? error.message : String(error)}`,
      { httpStatus: 502 },
    );
  }

  const data = await readJsonResponse<T>(response, "TELEGRAM_CONNECTION_FAILED", `Telegram ${method}`);
  if (!response.ok || data.ok === false) {
    const invalidCredential = response.status === 401 || /token/i.test(data.description ?? "");
    throw new FridayDomainError(
      invalidCredential ? "TELEGRAM_CREDENTIAL_INVALID" : "TELEGRAM_CONNECTION_FAILED",
      `Telegram ${method} failed: ${data.description ?? response.statusText}`,
      { httpStatus: invalidCredential ? 400 : 502 },
    );
  }
  return data;
}

async function beginTelegramVerification(
  input: SetupTelegramVerificationBeginRequest | null,
): Promise<SetupTelegramVerificationBeginResponse> {
  const botToken = typeof input?.botToken === "string" ? input.botToken.trim() : "";
  if (!botToken) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "botToken is required for Telegram verification.",
      { httpStatus: 400 },
    );
  }

  const me = await postTelegramBotApi<{
    ok: boolean;
    result?: {
      id?: number;
      is_bot?: boolean;
      first_name?: string;
      username?: string;
    };
    description?: string;
  }>(botToken, "getMe", {});
  const bot = me.result;
  if (!bot?.id || !bot.first_name) {
    throw new FridayDomainError(
      "TELEGRAM_CREDENTIAL_INVALID",
      "Telegram getMe did not return a bot identity.",
      { httpStatus: 400 },
    );
  }

  let updateOffset: number | undefined;
  try {
    const drained = await postTelegramBotApi<{
      ok: boolean;
      result?: Array<{ update_id?: number }>;
      description?: string;
    }>(botToken, "getUpdates", {
      timeout: 0,
      limit: 100,
      allowed_updates: ["message"],
    });
    const latestUpdateId = (drained.result ?? [])
      .map((update) => update.update_id)
      .filter((id): id is number => typeof id === "number" && Number.isFinite(id))
      .reduce<number | undefined>((latest, id) => latest === undefined ? id : Math.max(latest, id), undefined);
    updateOffset = latestUpdateId === undefined ? undefined : latestUpdateId + 1;
  } catch (error) {
    if (error instanceof FridayDomainError) {
      throw new FridayDomainError(
        "TELEGRAM_VERIFICATION_UNAVAILABLE",
        "Telegram verification needs getUpdates access. Delete any existing webhook for this bot, or use a fresh BotFather bot token.",
        { httpStatus: 400 },
      );
    }
    throw error;
  }

  pruneChannelSetupVerificationSessions();
  const verificationId = randomUUID();
  const startCode = `friday_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const expiresAtMs = Date.now() + CHANNEL_SETUP_VERIFICATION_SESSION_TTL_MS;
  const startUrl = bot.username ? `https://t.me/${bot.username}?start=${startCode}` : undefined;

  telegramVerificationSessions.set(verificationId, {
    verificationId,
    botToken,
    botUserId: String(bot.id),
    ...(bot.username ? { botUsername: bot.username } : {}),
    botName: bot.first_name,
    startCode,
    ...(updateOffset !== undefined ? { updateOffset } : {}),
    expiresAtMs,
  });

  return {
    verificationId,
    kind: "telegram",
    status: "pending",
    botUserId: String(bot.id),
    botUsername: bot.username,
    botName: bot.first_name,
    startCode,
    startUrl,
    expiresAt: new Date(expiresAtMs).toISOString(),
    warnings: [
      "Open the Telegram bot and send the setup code. Friday will only allow saving after it receives that private message and sends a verification reply.",
    ],
  };
}

async function pollTelegramVerification(
  verificationId: string,
): Promise<SetupTelegramVerificationPollResponse> {
  pruneChannelSetupVerificationSessions();
  const session = telegramVerificationSessions.get(verificationId);
  if (!session) {
    return {
      verificationId,
      kind: "telegram",
      status: "expired",
      message: "Telegram verification session was not found or has expired.",
      warnings: [],
    };
  }

  if (session.result) {
    return {
      verificationId,
      kind: "telegram",
      status: "success",
      botUserId: session.botUserId,
      botUsername: session.botUsername,
      chatId: session.result.chatId,
      userId: session.result.userId,
      welcomeMessageId: session.result.welcomeMessageId,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      warnings: [],
    };
  }

  const updates = await postTelegramBotApi<{
    ok: boolean;
    result?: Array<{
      update_id?: number;
      message?: {
        message_id?: number;
        text?: string;
        chat?: { id?: number | string; type?: string };
        from?: { id?: number | string; is_bot?: boolean };
      };
    }>;
    description?: string;
  }>(session.botToken, "getUpdates", {
    ...(session.updateOffset !== undefined ? { offset: session.updateOffset } : {}),
    timeout: 0,
    limit: 100,
    allowed_updates: ["message"],
  });

  for (const update of updates.result ?? []) {
    if (typeof update.update_id === "number") {
      session.updateOffset = Math.max(session.updateOffset ?? 0, update.update_id + 1);
    }
    const message = update.message;
    const text = message?.text?.trim() ?? "";
    const chatId = message?.chat?.id;
    const userId = message?.from?.id;
    if (
      text.includes(session.startCode)
      && message?.chat?.type === "private"
      && chatId !== undefined
      && userId !== undefined
      && message.from?.is_bot !== true
    ) {
      const welcome = await postTelegramBotApi<{
        ok: boolean;
        result?: { message_id?: number };
        description?: string;
      }>(session.botToken, "sendMessage", {
        chat_id: chatId,
        text: "Friday 已连接 Telegram。你现在可以在这个对话里给 Friday 发消息；敏感操作会在这里请求确认。",
      });
      const welcomeMessageId = String(welcome.result?.message_id ?? "");
      if (!welcomeMessageId) {
        return {
          verificationId,
          kind: "telegram",
          status: "error",
          message: "Telegram verification reply did not return a message id.",
          warnings: [],
        };
      }
      session.result = {
        chatId: String(chatId),
        userId: String(userId),
        welcomeMessageId,
      };
      return {
        verificationId,
        kind: "telegram",
        status: "success",
        botUserId: session.botUserId,
        botUsername: session.botUsername,
        chatId: session.result.chatId,
        userId: session.result.userId,
        welcomeMessageId: session.result.welcomeMessageId,
        expiresAt: new Date(session.expiresAtMs).toISOString(),
        warnings: [],
      };
    }
  }

  return {
    verificationId,
    kind: "telegram",
    status: "pending",
    botUserId: session.botUserId,
    botUsername: session.botUsername,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    warnings: [],
  };
}

async function discordApi<T>(
  token: string,
  path: string,
  init?: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${DISCORD_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new FridayDomainError(
      "DISCORD_CONNECTION_FAILED",
      aborted
        ? `Timed out while calling Discord ${path}.`
        : `Could not reach Discord ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { httpStatus: 502 },
    );
  }

  const data = await readJsonResponse<T & { message?: string; code?: number }>(
    response,
    "DISCORD_CONNECTION_FAILED",
    `Discord ${path}`,
  );
  if (!response.ok) {
    const invalidCredential = response.status === 401 || response.status === 403;
    throw new FridayDomainError(
      invalidCredential ? "DISCORD_CREDENTIAL_INVALID" : "DISCORD_CONNECTION_FAILED",
      `Discord ${path} failed: ${data.message ?? response.statusText}`,
      { httpStatus: invalidCredential ? 400 : 502 },
    );
  }
  return data;
}

async function tryVerifyDiscordGuild(token: string, guildId: string): Promise<boolean> {
  try {
    const guild = await discordApi<{ id?: string }>(token, `/guilds/${encodeURIComponent(guildId)}`);
    return guild.id === guildId;
  } catch {
    return false;
  }
}

function buildDiscordInviteUrl(applicationId: string): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    permissions: DISCORD_BOT_INVITE_PERMISSIONS,
    scope: "bot applications.commands",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function beginDiscordVerification(
  input: SetupDiscordVerificationBeginRequest | null,
): Promise<SetupDiscordVerificationBeginResponse> {
  const token = typeof input?.token === "string" ? input.token.trim().replace(/^Bot\s+/i, "") : "";
  if (!token) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "token is required for Discord verification.",
      { httpStatus: 400 },
    );
  }
  const guildId = typeof input?.guildId === "string" && input.guildId.trim()
    ? input.guildId.trim()
    : undefined;

  const user = await discordApi<{
    id?: string;
    username?: string;
    discriminator?: string;
    bot?: boolean;
  }>(token, "/users/@me");
  if (!user.id || !user.username) {
    throw new FridayDomainError(
      "DISCORD_CREDENTIAL_INVALID",
      "Discord token did not return a bot identity.",
      { httpStatus: 400 },
    );
  }

  const app = await discordApi<{
    id?: string;
    name?: string;
    bot?: { id?: string; username?: string };
  }>(token, "/oauth2/applications/@me");
  const applicationId = app.id ?? user.id;
  const botUserId = app.bot?.id ?? user.id;
  const botUsername = app.bot?.username ?? user.username;
  const inviteUrl = buildDiscordInviteUrl(applicationId);
  const guildVerified = guildId ? await tryVerifyDiscordGuild(token, guildId) : undefined;

  pruneChannelSetupVerificationSessions();
  const verificationId = randomUUID();
  const expiresAtMs = Date.now() + CHANNEL_SETUP_VERIFICATION_SESSION_TTL_MS;
  discordVerificationSessions.set(verificationId, {
    verificationId,
    token,
    applicationId,
    botUserId,
    botUsername,
    inviteUrl,
    ...(guildId ? { guildId } : {}),
    ...(guildVerified !== undefined ? { guildVerified } : {}),
    expiresAtMs,
  });

  return {
    verificationId,
    kind: "discord",
    status: "ready",
    applicationId,
    botUserId,
    botUsername,
    inviteUrl,
    ...(guildId ? { guildId } : {}),
    ...(guildVerified !== undefined ? { guildVerified } : {}),
    expiresAt: new Date(expiresAtMs).toISOString(),
    warnings: [
      guildId && guildVerified === false
        ? "The bot token is valid, but Friday cannot see that server yet. Open the invite URL, add the bot, then send the verification DM."
        : "Open the invite URL if the bot is not already in your server, then send a Discord verification DM.",
    ],
  };
}

async function completeDiscordVerification(
  input: SetupDiscordVerificationCompleteRequest | null,
): Promise<SetupDiscordVerificationCompleteResponse> {
  const verificationId = typeof input?.verificationId === "string" ? input.verificationId.trim() : "";
  const userId = typeof input?.userId === "string" ? input.userId.trim() : "";
  if (!verificationId) {
    throw new FridayDomainError("VALIDATION_ERROR", "verificationId is required.", { httpStatus: 400 });
  }
  if (!/^\d{5,30}$/.test(userId)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Discord userId is required and must be a numeric Discord user ID.",
      { httpStatus: 400 },
    );
  }

  pruneChannelSetupVerificationSessions();
  const session = discordVerificationSessions.get(verificationId);
  if (!session) {
    return {
      verificationId,
      kind: "discord",
      status: "expired",
      message: "Discord verification session was not found or has expired.",
      warnings: [],
    };
  }

  const guildId = typeof input?.guildId === "string" && input.guildId.trim()
    ? input.guildId.trim()
    : session.guildId;
  const guildVerified = guildId ? await tryVerifyDiscordGuild(session.token, guildId) : undefined;
  if (guildId && guildVerified !== true) {
    session.result = {
      userId,
      dmVerified: false,
      guildId,
      guildVerified: false,
      error: "Friday cannot verify that the Discord bot is in the selected server. Use the invite URL first, then try again.",
    };
    return {
      verificationId,
      kind: "discord",
      status: "dm_failed",
      applicationId: session.applicationId,
      botUserId: session.botUserId,
      botUsername: session.botUsername,
      guildId,
      guildVerified: false,
      userId,
      dmVerified: false,
      message: session.result.error,
      warnings: [],
    };
  }

  try {
    const dmChannel = await discordApi<{ id?: string }>(session.token, "/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!dmChannel.id) {
      throw new Error("Discord did not return a DM channel id.");
    }
    const message = await discordApi<{ id?: string }>(session.token, `/channels/${encodeURIComponent(dmChannel.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: "Friday 已连接 Discord。你现在可以在这个私信里给 Friday 发消息；敏感操作会在这里请求确认。",
      }),
    });
    if (!message.id) {
      throw new Error("Discord did not return a verification message id.");
    }
    session.result = {
      userId,
      dmVerified: true,
      welcomeMessageId: message.id,
      ...(guildId ? { guildId } : {}),
      ...(guildVerified !== undefined ? { guildVerified } : {}),
    };
    return {
      verificationId,
      kind: "discord",
      status: "success",
      applicationId: session.applicationId,
      botUserId: session.botUserId,
      botUsername: session.botUsername,
      ...(guildId ? { guildId } : {}),
      ...(guildVerified !== undefined ? { guildVerified } : {}),
      userId,
      dmVerified: true,
      welcomeMessageId: message.id,
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.result = {
      userId,
      dmVerified: false,
      ...(guildId ? { guildId } : {}),
      ...(guildVerified !== undefined ? { guildVerified } : {}),
      error: message,
    };
    return {
      verificationId,
      kind: "discord",
      status: "dm_failed",
      applicationId: session.applicationId,
      botUserId: session.botUserId,
      botUsername: session.botUsername,
      ...(guildId ? { guildId } : {}),
      ...(guildVerified !== undefined ? { guildVerified } : {}),
      userId,
      dmVerified: false,
      message,
      warnings: [
        "Discord DM verification failed. Make sure the bot is invited to a server you share and that your server privacy settings allow DMs from server members.",
      ],
    };
  }
}

function applyTelegramVerificationToConfig(config: Record<string, unknown>, enabled: boolean): void {
  const verificationId = typeof config.setupVerificationId === "string" ? config.setupVerificationId.trim() : "";
  if (!verificationId) {
    if (enabled) {
      throw new FridayDomainError(
        "TELEGRAM_VERIFICATION_REQUIRED",
        "Telegram setup requires a verified private message before saving.",
        { httpStatus: 400 },
      );
    }
    return;
  }

  pruneChannelSetupVerificationSessions();
  const session = telegramVerificationSessions.get(verificationId);
  if (!session?.result) {
    throw new FridayDomainError(
      "TELEGRAM_VERIFICATION_NOT_READY",
      "Telegram verification has not completed yet.",
      { httpStatus: 400 },
    );
  }
  const botToken = typeof config.botToken === "string" ? config.botToken.trim() : "";
  if (botToken !== session.botToken) {
    throw new FridayDomainError(
      "TELEGRAM_VERIFICATION_TOKEN_MISMATCH",
      "Telegram token changed after verification. Verify this bot again before saving.",
      { httpStatus: 400 },
    );
  }

  // Persist the verified principal as the allowlist so this control-capable
  // channel fails closed (the verified user, not "everyone"). Mirrors the
  // Feishu verification-apply path.
  if (!normalizeStringList(config.allowedUsers) && session.result.userId) {
    config.allowedUsers = [session.result.userId];
  }

  delete config.setupVerificationId;
}

function normalizeDiscordTokenForVerification(raw: string): string {
  return raw.trim().replace(/^Bot\s+/i, "");
}

function resolveDiscordTokenForVerification(raw: unknown): { comparisonToken: string; persistedToken: string } {
  const tokenInput = typeof raw === "string" ? raw.trim() : "";
  const parsed = parseFridaySecretInput(tokenInput, {
    secretRefPrefixes: ["secret://channel/", "secret://"],
  });
  if (parsed.kind === "env-ref") {
    return {
      comparisonToken: normalizeDiscordTokenForVerification(process.env[parsed.envVar] ?? ""),
      persistedToken: tokenInput,
    };
  }
  const token = normalizeDiscordTokenForVerification(tokenInput);
  return {
    comparisonToken: token,
    persistedToken: token,
  };
}

function applyDiscordVerificationToConfig(config: Record<string, unknown>, enabled: boolean): void {
  const verificationId = typeof config.setupVerificationId === "string" ? config.setupVerificationId.trim() : "";
  if (!verificationId) {
    if (enabled) {
      throw new FridayDomainError(
        "DISCORD_VERIFICATION_REQUIRED",
        "Discord setup requires a verified private message before saving.",
        { httpStatus: 400 },
      );
    }
    return;
  }

  pruneChannelSetupVerificationSessions();
  const session = discordVerificationSessions.get(verificationId);
  if (!session?.result?.dmVerified) {
    throw new FridayDomainError(
      "DISCORD_VERIFICATION_NOT_READY",
      "Discord verification has not completed yet.",
      { httpStatus: 400 },
    );
  }
  const { comparisonToken, persistedToken } = resolveDiscordTokenForVerification(config.token);
  if (comparisonToken !== session.token) {
    throw new FridayDomainError(
      "DISCORD_VERIFICATION_TOKEN_MISMATCH",
      "Discord token changed after verification. Verify this bot again before saving.",
      { httpStatus: 400 },
    );
  }

  config.token = persistedToken;
  config.botUserId = session.botUserId;
  // Persist the DM-verified user as the allowlist so this control-capable
  // channel fails closed (the verified user, not "everyone"). Mirrors the
  // Feishu verification-apply path.
  if (!normalizeStringList(config.allowedUsers) && session.result.userId) {
    config.allowedUsers = [session.result.userId];
  }
  delete config.setupVerificationId;
  delete config.setupUserId;
  delete config.guildId;
}

const feishuRegistrationSessions = new Map<string, FeishuAppRegistrationSession>();
const feishuSetupReadinessWelcomeSent = new Set<string>();

function pruneFeishuRegistrationSessions(nowMs = Date.now()): void {
  for (const [registrationId, session] of feishuRegistrationSessions.entries()) {
    if (session.expiresAtMs <= nowMs) {
      feishuRegistrationSessions.delete(registrationId);
    }
  }
}

async function postFeishuAppRegistration<T extends object>(
  body: Record<string, string>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEISHU_REGISTRATION_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${FEISHU_ACCOUNTS_BASE}${FEISHU_APP_REGISTRATION_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new FridayDomainError(
      "FEISHU_APP_REGISTRATION_FAILED",
      aborted
        ? "Timed out while contacting Feishu app registration."
        : `Could not reach Feishu app registration: ${error instanceof Error ? error.message : String(error)}`,
      { httpStatus: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new FridayDomainError(
      "FEISHU_APP_REGISTRATION_FAILED",
      `Feishu app registration returned non-JSON response (${response.status}).`,
      { httpStatus: 502 },
    );
  }
}

async function fetchFeishuTenantAccessToken(appId: string, appSecret: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHANNEL_TEST_TIMEOUT_MS);
  try {
    const tokenResponse = await fetch(`${FEISHU_API_BASE}${LARK_TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: controller.signal,
    });
    if (!tokenResponse.ok) return undefined;
    const tokenData = (await tokenResponse.json()) as {
      code?: number;
      tenant_access_token?: string;
    };
    if (tokenData.code !== 0) return undefined;
    return tokenData.tenant_access_token;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function beginFeishuAppRegistration(): Promise<SetupFeishuRegistrationBeginResponse> {
  const init = await postFeishuAppRegistration<{
    nonce?: string;
    supported_auth_methods?: string[];
    error?: string;
    error_description?: string;
  }>({ action: "init" });

  if (!init.supported_auth_methods?.includes("client_secret")) {
    throw new FridayDomainError(
      "FEISHU_APP_REGISTRATION_UNSUPPORTED",
      "Current Feishu registration environment does not support client_secret app creation.",
      { httpStatus: 502 },
    );
  }

  const started = await postFeishuAppRegistration<{
    device_code?: string;
    verification_uri_complete?: string;
    verification_uri?: string;
    user_code?: string;
    interval?: number;
    expire_in?: number;
    error?: string;
    error_description?: string;
  }>({
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });

  if (!started.device_code || !started.user_code || !(started.verification_uri_complete ?? started.verification_uri)) {
    throw new FridayDomainError(
      "FEISHU_APP_REGISTRATION_FAILED",
      `Feishu app registration begin failed: ${started.error ?? "missing_device_code"} ${started.error_description ?? ""}`.trim(),
      { httpStatus: 502 },
    );
  }

  const qrUrl = new URL(started.verification_uri_complete ?? started.verification_uri!);
  qrUrl.searchParams.set("from", "friday_onboard");
  qrUrl.searchParams.set("tp", "ob_cli_app");

  pruneFeishuRegistrationSessions();
  const registrationId = randomUUID();
  const intervalSeconds = typeof started.interval === "number" && started.interval > 0 ? started.interval : 5;
  const expireInSeconds = typeof started.expire_in === "number" && started.expire_in > 0 ? started.expire_in : 600;
  const expiresAtMs = Date.now() + Math.min(expireInSeconds * 1000, FEISHU_REGISTRATION_SESSION_TTL_MS);

  feishuRegistrationSessions.set(registrationId, {
    registrationId,
    deviceCode: started.device_code,
    qrUrl: qrUrl.toString(),
    userCode: started.user_code,
    intervalSeconds,
    expireInSeconds,
    expiresAtMs,
  });

  return {
    registrationId,
    kind: "feishu",
    domain: "feishu",
    qrUrl: qrUrl.toString(),
    userCode: started.user_code,
    intervalSeconds,
    expireInSeconds,
    expiresAt: new Date(expiresAtMs).toISOString(),
    warnings: [
      "Scan with the Feishu mobile app. If approval succeeds, Friday will store the generated app secret locally and encrypted when this channel is saved.",
    ],
  };
}

async function fetchFeishuAppOwnerOpenId(appId: string, appSecret: string): Promise<string | undefined> {
  try {
    const tenantAccessToken = await fetchFeishuTenantAccessToken(appId, appSecret);
    if (!tenantAccessToken) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHANNEL_TEST_TIMEOUT_MS);
    try {
      const appResponse = await fetch(`${FEISHU_API_BASE}/open-apis/application/v6/applications/${encodeURIComponent(appId)}?user_id_type=open_id`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      const appData = (await appResponse.json()) as {
        code?: number;
        data?: {
          app?: {
            owner?: { owner_id?: string; owner_type?: number; type?: number };
            creator_id?: string;
          };
        };
      };
      if (appData.code !== 0) return undefined;
      const app = appData.data?.app;
      const owner = app?.owner;
      const ownerType = owner?.owner_type ?? owner?.type;
      return ownerType === 2 && owner?.owner_id ? owner.owner_id : (app?.creator_id ?? owner?.owner_id);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return undefined;
  }
}

async function sendFeishuSetupWelcomeMessage(input: {
  appId: string;
  appSecret: string;
  ownerOpenId: string;
  text?: string;
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  const tenantAccessToken = await fetchFeishuTenantAccessToken(input.appId, input.appSecret);
  if (!tenantAccessToken) {
    return { ok: false, error: "Could not obtain a Feishu tenant access token for the generated app." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHANNEL_TEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${FEISHU_API_BASE}${LARK_SEND_MESSAGE_PATH}?receive_id_type=open_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: input.ownerOpenId,
        msg_type: "text",
        content: JSON.stringify({
          text: input.text ?? "Friday 飞书应用已创建。请回到 Friday setup 点击“保存并启动”；启动后你就可以在这个对话里给 Friday 发消息，敏感操作会在这里请求确认。",
        }),
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let data: {
      code?: number;
      msg?: string;
      data?: { message_id?: string };
    };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      return {
        ok: false,
        error: `Feishu welcome message returned non-JSON response (${response.status}).`,
      };
    }

    if (!response.ok || data.code !== 0) {
      return {
        ok: false,
        error: `Feishu welcome message failed: ${data.code ?? response.status} ${data.msg ?? response.statusText}`,
      };
    }

    return { ok: true, messageId: data.data?.message_id };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? "Timed out while sending the Feishu welcome message."
        : `Could not send the Feishu welcome message: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveSetupChannelSecretValue(deps: Pick<FridaySetupRoutesDeps, "db">, raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const refKey = parseFridayChannelSecretRef(value);
  if (!refKey) return value;
  try {
    const entity = deps.db.withReadConnection((db) =>
      channelSecretRepository.getByRef(db, FRIDAY_CHANNEL_SECRET_SCOPE, refKey),
    );
    if (!entity) return undefined;
    const envelope = JSON.parse(entity.encryptedValue) as FridayEncryptedEnvelope;
    const { plaintext, rewrapped } = decryptSecretWithMigration(
      envelope,
      getStrictMasterKey(),
      fridaySecretAadContext(entity),
    );
    if (rewrapped) {
      // Read-repair (SEC-SECRET-AAD-001): persist the v2 re-wrap; best-effort.
      try {
        deps.db.withWriteTransaction((db) => {
          channelSecretRepository.updateById(db, {
            secretId: entity.id,
            encryptedValue: JSON.stringify(rewrapped),
            keyId: "master-v1",
            nowIso: new Date().toISOString(),
          });
        });
      } catch {
        // Non-fatal: the read already succeeded.
      }
    }
    return plaintext;
  } catch (error) {
    console.warn("[friday][setup-routes] could not resolve channel secret for setup welcome:", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function normalizeSetupStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  }
  if (typeof raw === "string") {
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function loadFeishuSetupWelcomeTarget(
  deps: Pick<FridaySetupRoutesDeps, "db">,
): { appId: string; appSecret: string; ownerOpenId: string } | null {
  const state = deps.db.withReadConnection((db) => {
    return db.prepare("SELECT channels_json FROM friday_setup_state WHERE id = 'singleton'").get() as { channels_json: string } | undefined;
  });
  if (!state?.channels_json) return null;

  let channels: unknown;
  try {
    channels = JSON.parse(state.channels_json);
  } catch {
    return null;
  }
  if (!Array.isArray(channels)) return null;

  for (const entry of channels) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as SetupChannelPersistedConfig;
    if (record.kind !== "feishu" || record.enabled !== true) continue;
    const config = record.config ?? {};
    const appId = typeof config.appId === "string" ? config.appId.trim() : "";
    const appSecret = resolveSetupChannelSecretValue(deps, config.appSecret);
    const ownerOpenId = normalizeSetupStringList(config.allowedUsers)[0] ?? "";
    if (appId && appSecret && ownerOpenId) {
      return { appId, appSecret, ownerOpenId };
    }
  }
  return null;
}

function buildFeishuSetupCompleteWelcomeText(): string {
  return [
    "Friday 已启动，可以直接在这个飞书私聊里发消息。",
    "",
    "已打开：文本模型、飞书、文件读写、PDF、Skills。",
    "需要你连接账号/模型或开本机权限后会自动可用：看图、OCR、Embedding、TTS。",
    "需要你批准后才会执行：MCP、生成/安装自定义工具、第三方安装、写配置。",
    "",
    "如果飞书里出现多个 Friday，请以收到这条欢迎消息的私聊为准；旧私聊不会再连接当前这台本地 Friday。",
    "",
    "首页也会显示同一份状态。默认是简版，点“高级详情”可以看完整边界。",
  ].join("\n");
}

async function sendFeishuSetupCompleteWelcomeIfConfigured(deps: Pick<FridaySetupRoutesDeps, "db">): Promise<void> {
  const target = loadFeishuSetupWelcomeTarget(deps);
  if (!target) return;
  const dedupeKey = `${target.appId}:${target.ownerOpenId}`;
  if (feishuSetupReadinessWelcomeSent.has(dedupeKey)) return;
  const result = await sendFeishuSetupWelcomeMessage({
    ...target,
    text: buildFeishuSetupCompleteWelcomeText(),
  });
  if (result.ok) {
    feishuSetupReadinessWelcomeSent.add(dedupeKey);
  }
  if (!result.ok) {
    console.warn("[friday][setup-routes] setup completion Feishu welcome failed:", result.error);
  }
}

async function pollFeishuAppRegistration(
  registrationId: string,
): Promise<SetupFeishuRegistrationPollResponse> {
  pruneFeishuRegistrationSessions();
  const session = feishuRegistrationSessions.get(registrationId);
  if (!session) {
    throw new FridayDomainError(
      "FEISHU_APP_REGISTRATION_NOT_FOUND",
      "Feishu app registration session was not found or has expired.",
      { httpStatus: 404 },
    );
  }

  if (session.result) {
    const status = session.result.dmVerified ? "success" : "dm_failed";
    return {
      registrationId,
      kind: "feishu",
      status,
      appId: session.result.appId,
      ownerOpenId: session.result.ownerOpenId,
      suggestedAllowedUsers: session.result.ownerOpenId ? [session.result.ownerOpenId] : undefined,
      dmVerified: session.result.dmVerified,
      welcomeMessageId: session.result.welcomeMessageId,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      message: session.result.dmError,
      warnings: session.result.dmVerified
        ? []
        : ["Friday created the Feishu app, but the setup is not complete until a private welcome message can be delivered."],
    };
  }

  const polled = await postFeishuAppRegistration<{
    client_id?: string;
    client_secret?: string;
    user_info?: { open_id?: string; tenant_brand?: string };
    error?: string;
    error_description?: string;
  }>({
    action: "poll",
    device_code: session.deviceCode,
    tp: "ob_app",
  });

  if (polled.client_id && polled.client_secret) {
    const ownerOpenId = polled.user_info?.open_id
      ?? await fetchFeishuAppOwnerOpenId(polled.client_id, polled.client_secret);
    const welcome = ownerOpenId
      ? await sendFeishuSetupWelcomeMessage({
        appId: polled.client_id,
        appSecret: polled.client_secret,
        ownerOpenId,
      })
      : { ok: false as const, error: "Friday could not resolve the Feishu owner open_id from the QR authorization." };
    session.result = {
      appId: polled.client_id,
      appSecret: polled.client_secret,
      ...(ownerOpenId ? { ownerOpenId } : {}),
      dmVerified: welcome.ok,
      ...(welcome.ok && welcome.messageId ? { welcomeMessageId: welcome.messageId } : {}),
      ...(!welcome.ok ? { dmError: welcome.error } : {}),
    };
    const status = session.result.dmVerified ? "success" : "dm_failed";
    return {
      registrationId,
      kind: "feishu",
      status,
      appId: session.result.appId,
      ownerOpenId,
      suggestedAllowedUsers: ownerOpenId ? [ownerOpenId] : undefined,
      dmVerified: session.result.dmVerified,
      welcomeMessageId: session.result.welcomeMessageId,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      message: session.result.dmError,
      warnings: session.result.dmVerified
        ? ["Friday sent a welcome message to the approving Feishu user. The private chat is reachable."]
        : ["Friday created the Feishu app, but could not deliver the welcome private message. Check bot permissions, app availability, and whether the bot can message this user."],
    };
  }

  if (polled.error === "authorization_pending" || !polled.error) {
    return {
      registrationId,
      kind: "feishu",
      status: "pending",
      intervalSeconds: session.intervalSeconds,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      warnings: [],
    };
  }

  if (polled.error === "slow_down") {
    session.intervalSeconds += 5;
    return {
      registrationId,
      kind: "feishu",
      status: "slow_down",
      intervalSeconds: session.intervalSeconds,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      warnings: [],
    };
  }

  if (polled.error === "access_denied") {
    return { registrationId, kind: "feishu", status: "access_denied", warnings: [] };
  }

  if (polled.error === "expired_token") {
    feishuRegistrationSessions.delete(registrationId);
    return { registrationId, kind: "feishu", status: "expired", warnings: [] };
  }

  return {
    registrationId,
    kind: "feishu",
    status: "error",
    message: `${polled.error ?? "unknown"}: ${polled.error_description ?? "unknown"}`,
    warnings: [],
  };
}

function applyFeishuRegistrationToConfig(config: Record<string, unknown>, enabled: boolean): void {
  const registrationId = typeof config.registrationId === "string" ? config.registrationId.trim() : "";
  if (!registrationId) {
    if (enabled) {
      throw new FridayDomainError(
        "FEISHU_APP_REGISTRATION_REQUIRED",
        "Feishu setup requires QR app registration.",
        { httpStatus: 400 },
      );
    }
    return;
  }

  pruneFeishuRegistrationSessions();
  const session = feishuRegistrationSessions.get(registrationId);
  if (!session?.result) {
    throw new FridayDomainError(
      "FEISHU_APP_REGISTRATION_NOT_READY",
      "Feishu app registration has not completed yet.",
      { httpStatus: 400 },
    );
  }
  if (!session.result.dmVerified) {
    throw new FridayDomainError(
      "FEISHU_DM_VERIFICATION_REQUIRED",
      "Feishu setup requires a verified private welcome message before saving.",
      { httpStatus: 400 },
    );
  }

  config.appId = session.result.appId;
  config.appSecret = session.result.appSecret;
  config.useFeishu = true;
  config.receiveMode = "websocket";
  delete config.registrationId;

  if (!normalizeStringList(config.allowedUsers) && session.result.ownerOpenId) {
    config.allowedUsers = [session.result.ownerOpenId];
  }
}

function parseStepIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((step): step is string => typeof step === "string");
  } catch (err) {
    console.warn("[friday][setup-routes] operation failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function computePreviewUrls(host: string, port: number): string[] {
  const urls: string[] = [];

  if (host === "127.0.0.1" || host === "localhost") {
    urls.push(`http://localhost:${port}`);
    urls.push(`http://127.0.0.1:${port}`);
    return urls;
  }

  // Always include localhost
  urls.push(`http://localhost:${port}`);

  // If binding to 0.0.0.0, enumerate all non-internal IPv4 interfaces
  if (host === "0.0.0.0") {
    const interfaces = os.networkInterfaces();
    for (const ifaces of Object.values(interfaces)) {
      if (!ifaces) continue;
      for (const iface of ifaces) {
        if (iface.family === "IPv4" && !iface.internal) {
          urls.push(`http://${iface.address}:${port}`);
        }
      }
    }
  } else {
    urls.push(`http://${host}:${port}`);
  }

  return urls;
}

// ─── Model fetching ───

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function assertSetupBaseUrlSafe(baseUrl: string, opts?: { allowPrivateNetwork?: boolean }): void {
  const result = validateGatewayUrl(baseUrl, {
    allowLoopback: opts?.allowPrivateNetwork,
    allowPrivate: opts?.allowPrivateNetwork,
  });
  if (!result.valid) {
    throw new FridayDomainError("PROVIDER_UNREACHABLE", `Base URL blocked by security policy: ${result.error ?? "private/loopback address"}`, { httpStatus: 422, details: { hint: "Friday blocks localhost/private IPs by default. For local providers like Ollama, use the setup wizard which enables private network access." } });
  }
}

async function fetchOpenAiModels(baseUrl: string, apiKey: string, ssrf?: { allowPrivateNetwork?: boolean }): Promise<{ models: string[]; defaultModel?: string }> {
  assertSetupBaseUrlSafe(baseUrl, ssrf);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new FridayDomainError("PROVIDER_AUTH_INVALID", "Invalid API key", { httpStatus: 401, details: { hint: "OpenAI keys start with 'sk-'. Check your key at https://platform.openai.com/api-keys" } });
  }
  if (res.status === 429) {
    throw new FridayDomainError("PROVIDER_RATE_LIMITED", "Upstream rate limit", { httpStatus: 429, retryable: true });
  }
  if (!res.ok) {
    throw new FridayDomainError("PROVIDER_UNREACHABLE", `HTTP ${res.status}`, { httpStatus: 422 });
  }
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const allModels = (body.data ?? []).map((m) => m.id);

  // Filter to chat-capable models
  const chatPrefixes = ["gpt-", "o1", "o3", "o4"];
  const chatModels = allModels.filter((id) =>
    chatPrefixes.some((prefix) => id.startsWith(prefix)),
  );

  // Preferred order
  const preferred = ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "o4-mini", "o3-mini", "o1-mini"];
  const defaultModel = preferred.find((m) => chatModels.includes(m));

  chatModels.sort((a, b) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  return { models: chatModels.length > 0 ? chatModels : allModels, defaultModel };
}

async function fetchAnthropicModels(baseUrl: string, apiKey: string, ssrf?: { allowPrivateNetwork?: boolean }): Promise<{ models: string[]; defaultModel?: string; validated: boolean }> {
  assertSetupBaseUrlSafe(baseUrl, ssrf);
  const models = ["claude-opus-4", "claude-sonnet-4", "claude-haiku-3.5"];

  // Validate key with minimal API call
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new FridayDomainError("PROVIDER_AUTH_INVALID", "Invalid API key", { httpStatus: 401, details: { hint: "Anthropic keys start with 'sk-ant-'. Check your key at https://console.anthropic.com/settings/keys" } });
    }
    if (res.status === 402) {
      let msg = "Insufficient credit balance — add credits at https://console.anthropic.com/settings/billing";
      try {
        const errBody = (await res.json()) as { error?: { message?: string } };
        if (errBody?.error?.message) msg = errBody.error.message;
      } catch {
        // ignore parse errors
      }
      throw new FridayDomainError("PROVIDER_PAYMENT_REQUIRED", msg, { httpStatus: 402, details: { hint: "Your API key is valid but has no credits. Visit https://console.anthropic.com/settings/billing to add credits." } });
    }
    if (res.status === 429) {
      throw new FridayDomainError("PROVIDER_RATE_LIMITED", "Upstream rate limit", { httpStatus: 429, retryable: true });
    }
    // 400 with credit balance error is payment-required
    if (res.status === 400) {
      try {
        const errBody = (await res.json()) as { error?: { type?: string; message?: string } };
        if (errBody?.error?.message && /credit balance/i.test(errBody.error.message)) {
          throw new FridayDomainError("PROVIDER_PAYMENT_REQUIRED", errBody.error.message, { httpStatus: 402, details: { hint: "Your API key is valid but has no credits. Visit https://console.anthropic.com/settings/billing to add credits." } });
        }
      } catch (err) {
        if (err instanceof FridayDomainError) throw err;
        // ignore parse errors
      }
    }
    // 200, 529 all mean the key is valid
    const validated = res.ok || res.status === 529;
    return { models, defaultModel: "claude-sonnet-4", validated };
  } catch (err) {
    if (err instanceof FridayDomainError) {
      throw err;
    }
    throw new FridayDomainError("PROVIDER_UNREACHABLE", "Could not reach Anthropic API", { httpStatus: 422 });
  }
}

async function fetchGoogleModels(baseUrl: string, apiKey: string, ssrf?: { allowPrivateNetwork?: boolean }): Promise<{ models: string[]; defaultModel?: string }> {
  assertSetupBaseUrlSafe(baseUrl, ssrf);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1beta/models`;
  const res = await fetchWithTimeout(url, { method: "GET", headers: { "x-goog-api-key": apiKey } });
  if (res.status === 401 || res.status === 403) {
    throw new FridayDomainError("PROVIDER_AUTH_INVALID", "Invalid API key", { httpStatus: 401, details: { hint: "Google AI keys can be generated at https://aistudio.google.com/app/apikey" } });
  }
  if (res.status === 429) {
    throw new FridayDomainError("PROVIDER_RATE_LIMITED", "Upstream rate limit", { httpStatus: 429, retryable: true });
  }
  if (!res.ok) {
    throw new FridayDomainError("PROVIDER_UNREACHABLE", `HTTP ${res.status}`, { httpStatus: 422 });
  }
  const body = (await res.json()) as {
    models?: Array<{
      name: string;
      supportedGenerationMethods?: string[];
    }>;
  };

  const models = (body.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));

  // Default to newest stable Gemini model
  const defaultModel = models.find((m) => m.startsWith("gemini-2")) ??
    models.find((m) => m.startsWith("gemini-1.5")) ??
    models[0];

  return { models, defaultModel };
}

async function fetchOllamaModels(baseUrl: string, ssrf?: { allowPrivateNetwork?: boolean }): Promise<{ models: string[]; defaultModel?: string }> {
  assertSetupBaseUrlSafe(baseUrl, ssrf);
  const url = `${baseUrl.replace(/\/+$/, "")}/api/tags`;
  const res = await fetchWithTimeout(url, { method: "GET" });
  if (!res.ok) {
    throw new FridayDomainError("PROVIDER_UNREACHABLE", `Ollama not reachable (HTTP ${res.status})`, { httpStatus: 422 });
  }
  const body = (await res.json()) as { models?: Array<{ name: string }> };
  const models = (body.models ?? []).map((m) => m.name);
  return { models, defaultModel: models[0] };
}

async function fetchCompatibleModels(baseUrl: string, apiKey?: string, ssrf?: { allowPrivateNetwork?: boolean }): Promise<{ models: string[]; defaultModel?: string }> {
  assertSetupBaseUrlSafe(baseUrl, ssrf);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetchWithTimeout(url, { method: "GET", headers });
  if (res.status === 401 || res.status === 403) {
    throw new FridayDomainError("PROVIDER_AUTH_INVALID", "Invalid API key", { httpStatus: 401, details: { hint: "Verify the API key is correct and the provider supports the OpenAI-compatible /v1/models endpoint" } });
  }
  if (res.status === 429) {
    throw new FridayDomainError("PROVIDER_RATE_LIMITED", "Upstream rate limit", { httpStatus: 429, retryable: true });
  }
  if (!res.ok) {
    throw new FridayDomainError("PROVIDER_UNREACHABLE", `HTTP ${res.status}`, { httpStatus: 422 });
  }
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const models = (body.data ?? []).map((m) => m.id);
  return { models, defaultModel: models[0] };
}

// ─── Dependencies ───

export interface FridaySetupRoutesDeps {
  db: FridaySqliteLayer;
  providerService: FridayProviderService;
  skillRegistry: FridaySkillRegistry;
  nowIso: () => string;
  runningHost: string;
  runningPort: number;
  /** Allow loopback/private network addresses for self-hosted deployments using local providers. */
  allowPrivateNetwork?: boolean;
  getLiveChannelCount?: () => number;
  activateSavedChannels?: () =>
    | Promise<SetupChannelsActivationResponse>
    | SetupChannelsActivationResponse;
  onChannelsSaved?: (input: {
    userId: string;
    savedKinds: string[];
  }) => Promise<void> | void;
  onSetupCompleted?: (input: {
    userId: string;
  }) => Promise<void> | void;
  /**
   * Test-oracle only: allow the legacy TypeScript provider-detect probe
   * (POST /v1/providers/detect -> fetchOpenAiModels/Anthropic/Google/Ollama/
   * Compatible: a capability/key-validation probe that egresses to provider
   * /v1/models). Production/runtime callers must leave this unset so the route
   * fail-closes (503 TS_RUNTIME_PROVIDERS_DETECT_RETIRED) until Rust owns provider
   * detection. NOTE: retiring this 503s the onboarding/setup-wizard model
   * detection AND the release-GO closure harness — see the closeout / operator
   * reconciliation note.
   */
  allowTestOnlyProviderDetectExecution?: boolean;
  /**
   * DARK cut-over flag (DEFAULT-OFF). When `true`, the retired `providers.detect`
   * route — instead of fail-closing with 503 — bridges to the merged Rust
   * `hub_providers_detect` bin (#591/#639) via {@link rustProvidersDetect} and returns
   * its REFS-ONLY CLI-login-status payload. When falsy (the default) the route is
   * byte-identical to today: it fail-closes (503 TS_RUNTIME_PROVIDERS_DETECT_RETIRED)
   * unless the test-oracle flag re-enables the legacy BYOK probe.
   *
   * SURFACE-SHAPE: the Rust bin answers the codex/claude CLI-login question (input
   * `--probe`), NOT the legacy BYOK probe (apiKey/kind/baseUrl -> /v1/models). Flipping
   * this flag CHANGES the response contract for clients — see the PR / operator note.
   * The resolved boolean is supplied by the runtime (sourced from
   * `FRIDAY_ROUTE_PROVIDERS_VIA_RUST` / explicit config); this factory does NOT read
   * the env itself.
   */
  routeProvidersViaRust?: boolean;
  /**
   * The Rust providers-detect bridge service consulted ONLY when
   * {@link routeProvidersViaRust} is `true`. Injected by the runtime (and by tests).
   * When the flag is on but this is absent, the route fails closed.
   */
  rustProvidersDetect?: FridayRustHubProvidersDetectService;
}

// ─── Factory ───

/**
 * TS-runtime retirement guard for the provider-detect probe. Placed AFTER all
 * the request validation (bootstrap boundary, body, kind/authMode/key/baseUrl)
 * and IMMEDIATELY BEFORE the provider model-fetch egress, so malformed requests
 * still 400 and NO provider egress occurs when retired.
 */
function assertProviderDetectTestOracleAllowed(deps: FridaySetupRoutesDeps): void {
  if (deps.allowTestOnlyProviderDetectExecution === true) {
    return;
  }
  throw new FridayDomainError(
    "TS_RUNTIME_PROVIDERS_DETECT_RETIRED",
    "Provider detection is fail-closed in the default/live runtime; the Rust-owned provider-detect entrypoint is required.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_provider_detect_entrypoint_required",
      },
    },
  );
}

export function createFridaySetupRoutes(
  deps: FridaySetupRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {

  /**
   * B0 Slice A3 — setup bootstrap boundary.
   *
   * Scoped fallback verifier for **unauthenticated** first-boot setup. This is a
   * **bootstrap boundary, not an identity/authentication boundary**: loopback
   * alone is NOT treated as trusted identity for any other route family.
   *
   * Each mutating setup route invokes this assertion FIRST, before any side
   * effect. The logic:
   *   - if the request carries an authenticated bound principal (anything that
   *     is NOT the synthetic default-public principal), bypass — downstream
   *     authorization checks already apply. This preserves legitimate
   *     post-setup reconfiguration flows (e.g. authenticated admin re-running
   *     `setup.channels.discord.verification.begin` to swap bot tokens, the
   *     release-proof `l6-discord-channel-roundtrip` scenario).
   *   - otherwise (unauthenticated synthetic-public request), require:
   *       1. request originates from a loopback address (127.0.0.1 / ::1 / localhost)
   *       2. `friday_setup_state.setup_completed_at IS NULL` (still first-boot)
   *
   * After `setup.complete` succeeds, unauthenticated setup-wizard mutations are
   * permanently fail-closed regardless of source IP. Negative tests cover both
   * rejection paths per route plus the authenticated-bypass property.
   *
   * The effective trust source for `ctx.ip` is the server's trust-proxy policy
   * (see `resolveFridayClientIp` in `friday-http-client-ip.ts` and the
   * `FRIDAY_HTTP_TRUST_PROXY` env var, which defaults to "off"). Operators who
   * set `FRIDAY_HTTP_TRUST_PROXY=private_network` widen this bootstrap window
   * to private-network reachable first-boot — that is an operator-explicit
   * choice, not a default capability of this boundary.
   *
   * If a future setup flow needs to run from a non-localhost client (e.g.
   * remote-paired setup), STOP and design a separate setup-session-token
   * boundary — do not relax this assertion.
   */
  function assertSetupBootstrapBoundary(ctx: {
    ip?: string;
    principal?: FridayAuthPrincipal | null;
  }): void {
    if (!isUnauthenticatedPublicPrincipal(ctx.principal)) {
      // Authenticated bound principal: bypass the bootstrap boundary. The
      // bootstrap boundary is a fallback verifier for the synthetic-public
      // principal only; authenticated requests are already authorized.
      return;
    }
    if (!isFridayLoopbackAddress(ctx.ip)) {
      throw new FridayDomainError(
        "SETUP_BOOTSTRAP_NOT_ALLOWED_NON_LOCALHOST",
        "Unauthenticated setup is only allowed from localhost during first boot.",
        { httpStatus: 403 },
      );
    }
    const state = getSetupState();
    if (state.setup_completed_at !== null) {
      throw new FridayDomainError(
        "SETUP_ALREADY_COMPLETED",
        "Unauthenticated setup has already completed; this bootstrap route is no longer accessible without an authenticated principal.",
        { httpStatus: 409 },
      );
    }
  }

  function getSetupState(): SetupStateRow {
    return deps.db.withReadConnection((db) => {
      const row = db.prepare("SELECT * FROM friday_setup_state WHERE id = 'singleton'").get() as SetupStateRow | undefined;
      if (!row) {
        // Should never happen after migration, but handle gracefully
        return {
          id: "singleton",
          setup_completed_at: null,
          completed_steps: "[]",
          skipped_steps: "[]",
          network_mode: "local",
          network_host: "127.0.0.1",
          network_port: 3141,
          channels_json: "[]",
          created_at: deps.nowIso(),
          updated_at: deps.nowIso(),
        };
      }
      return { ...row, channels_json: row.channels_json ?? "[]" };
    });
  }

  return [
    // ─── GET /v1/setup/status ───
    {
      operationId: "setup.status",
      method: "GET",
      path: "/v1/setup/status",
      auth: { public: true },
      async handler(): Promise<SetupStatusResponse> {
        const state = getSetupState();
        const providers = await deps.providerService.listProviders();
        const skills = deps.skillRegistry.list();

        const persistedChannelCount = (() => {
          try {
            const parsed = JSON.parse(state.channels_json);
            if (!Array.isArray(parsed)) return 0;
            return parsed.filter((entry) => {
              if (typeof entry !== "object" || entry === null) return false;
              const persisted = entry as { enabled?: unknown; controlConfirmed?: unknown };
              return persisted.enabled === true && persisted.controlConfirmed !== false;
            }).length;
          } catch (err) {
            console.warn("[friday][setup-routes] operation failed:", err instanceof Error ? err.message : String(err));
            return 0;
          }
        })();
        const liveChannelCount = (() => {
          try {
            const count = deps.getLiveChannelCount?.();
            return Number.isFinite(count) ? Math.max(0, Number(count)) : 0;
          } catch (err) {
            console.warn("[friday][setup-routes] operation failed:", err instanceof Error ? err.message : String(err));
            return 0;
          }
        })();
        const channelCount = Math.max(persistedChannelCount, liveChannelCount);

        const host = deps.runningHost ?? state.network_host;
        const port = deps.runningPort ?? state.network_port;
        const mode = state.network_mode as NetworkMode;

        const completedSteps = parseStepIds(state.completed_steps);
        const completedByStepState = completedSteps.includes("done");
        let setupCompletedAt = state.setup_completed_at;

        // Backward-compat / self-heal: older runs may have "done" in steps but null timestamp.
        if (!setupCompletedAt && completedByStepState) {
          const repairedAt = state.updated_at || deps.nowIso();
          deps.db.withWriteTransaction((db) => {
            db.prepare(
              `UPDATE friday_setup_state
               SET setup_completed_at = ?, updated_at = ?
               WHERE id = 'singleton'`,
            ).run(repairedAt, deps.nowIso());
          });
          setupCompletedAt = repairedAt;
        }

        return {
          needsSetup: setupCompletedAt === null,
          setupCompletedAt,
          providerCount: providers.length,
          channelCount,
          skillsCount: skills.length,
          network: {
            host,
            port,
            mode,
            previewUrls: computePreviewUrls(host, port),
          },
        };
      },
    },

    // ─── POST /v1/providers/detect ───
    // B0 Slice A3 carve-out: bootstrap boundary (localhost + setup_completed_at IS NULL).
    // See assertSetupBootstrapBoundary above and negative tests in
    // test/unit/api/http/routes/friday-setup-routes.test.ts.
    {
      operationId: "providers.detect",
      method: "POST",
      path: "/v1/providers/detect",
      auth: { public: true, allowUnauthenticatedMutation: true },
      rateLimitPolicyId: "provider.validate",
      async handler(ctx): Promise<DetectProviderResponse | FridayRustProvidersDetectReceipt> {
        assertSetupBootstrapBoundary(ctx);

        // DARK cut-over (DEFAULT-OFF): when FRIDAY_ROUTE_PROVIDERS_VIA_RUST is on
        // (resolved into deps.routeProvidersViaRust), bridge to the Rust
        // hub_providers_detect bin and return its REFS-ONLY CLI-login-status payload
        // instead of fail-closing. The bootstrap boundary above still runs first
        // (byte-identical to today's gate ordering). The legacy BYOK input validation
        // below does NOT apply to the Rust surface — the bin validates its own argv —
        // so it is intentionally bypassed on this branch. SURFACE-SHAPE differs from
        // the legacy BYOK probe; see the deps doc + PR.
        if (deps.routeProvidersViaRust === true) {
          if (!deps.rustProvidersDetect) {
            throw new FridayDomainError(
              "TS_RUNTIME_PROVIDERS_DETECT_RETIRED",
              "Provider detection is fail-closed: the Rust route is enabled but the providers-detect bridge is not wired.",
              {
                httpStatus: 503,
                details: {
                  classification: "fail_closed",
                  replacement: "rust_owned_provider_detect_entrypoint_required",
                },
              },
            );
          }
          const detectBody = ctx.body as DetectProviderRequest | null;
          // Optional `probe` selector (`codex` | `claude` | `both`); default `both`.
          // The legacy BYOK kind/apiKey/baseUrl fields are NOT consumed here.
          const requestedProbe =
            detectBody && typeof (detectBody as Record<string, unknown>).probe === "string"
              ? ((detectBody as Record<string, unknown>).probe as string)
              : undefined;
          const probe =
            requestedProbe === "codex" || requestedProbe === "claude" || requestedProbe === "both"
              ? requestedProbe
              : "both";
          return deps.rustProvidersDetect.detect({ probe });
        }

        const body = ctx.body as DetectProviderRequest | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
        }

        const apiKey = typeof body.apiKey === "string" ? body.apiKey : undefined;
        const explicitKind = typeof body.kind === "string" && VALID_KINDS.has(body.kind) ? body.kind as FridayProviderKind : undefined;
        const explicitBaseUrl = typeof body.baseUrl === "string" ? body.baseUrl : undefined;
        const explicitAuthMode = typeof body.authMode === "string"
          ? (VALID_AUTH_MODES.has(body.authMode) ? body.authMode as FridayProviderAuthMode : undefined)
          : undefined;
        if (body.authMode !== undefined && !explicitAuthMode) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            `authMode must be one of: ${Array.from(VALID_AUTH_MODES).join(", ")}`,
            { httpStatus: 400 },
          );
        }

        // Detect provider kind
        let kind: FridayProviderKind;
        let confidence: "high" | "medium" | "low";

        if (explicitKind) {
          kind = explicitKind;
          confidence = "high";
        } else if (!apiKey && explicitBaseUrl && (explicitBaseUrl.includes("localhost:11434") || explicitBaseUrl.includes("127.0.0.1:11434"))) {
          kind = "ollama";
          confidence = "high";
        } else if (apiKey) {
          const detected = detectFridayProviderKindFromApiKey(apiKey);
          kind = detected.kind;
          confidence = detected.confidence;
        } else {
          throw new FridayDomainError("VALIDATION_ERROR", "Either apiKey, kind, or baseUrl (for Ollama) is required", { httpStatus: 400 });
        }

        // Get preset config
        const preset = getFridayProviderPreset(kind, explicitBaseUrl);
        const baseUrl = explicitBaseUrl ?? preset.baseUrl;
        const api = preset.api;
        const authMode = explicitAuthMode ?? preset.authMode;
        const capability = getFridayProviderCapability(kind);

        if (!isFridayProviderAuthModeSupportedForKind(kind, authMode)) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            `authMode '${authMode}' is not supported for '${kind}'. Supported: ${getFridayProviderAuthModesForBackend(kind, capability.supportedBackendKinds[0] ?? "http").join(", ")}`,
            { httpStatus: 400 },
          );
        }

        // Require credential unless this provider supports keyless or OAuth-first onboarding.
        if ((authMode === "api-key" || authMode === "bearer-token") && !apiKey) {
          throw new FridayDomainError("VALIDATION_ERROR", `API key is required for ${kind} provider`, { httpStatus: 400 });
        }

        if (!baseUrl) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            `baseUrl is required for ${kind} provider`,
            { httpStatus: 400 },
          );
        }

        // TS-runtime retirement: fail-close BEFORE the provider model-fetch
        // egress (fetchOpenAiModels/Anthropic/Google/Ollama/Compatible), after
        // all the request validation above, so no provider egress occurs when
        // retired and malformed requests still 400.
        assertProviderDetectTestOracleAllowed(deps);

        // Fetch models
        const warnings: string[] = [];
        let availableModels: string[] = [];
        let defaultModel: string | undefined;
        let validated = false;
        let latencyMs: number | undefined;

        const startMs = Date.now();

        const ssrf = { allowPrivateNetwork: deps.allowPrivateNetwork };

        try {
          switch (api) {
            case "openai-completions":
            case "openai-responses": {
              const result = kind === "openai"
                ? await fetchOpenAiModels(baseUrl, apiKey!, ssrf)
                : await fetchCompatibleModels(baseUrl, apiKey, ssrf);
              availableModels = result.models;
              defaultModel = result.defaultModel;
              validated = true;
              break;
            }
            case "openai-codex-responses": {
              availableModels = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
              defaultModel = "gpt-5.4-mini";
              validated = false;
              warnings.push("OpenAI Codex OAuth selected: complete device login before provider validation.");
              break;
            }
            case "anthropic-messages": {
              if ((authMode === "oauth" || authMode === "token") && !apiKey) {
                availableModels = ["claude-opus-4", "claude-sonnet-4", "claude-haiku-3.5"];
                defaultModel = "claude-sonnet-4";
                validated = false;
                warnings.push(
                  authMode === "oauth"
                    ? "OAuth selected: complete login before provider validation."
                    : "Token selected: paste setup-token before provider validation.",
                );
              } else {
                const result = await fetchAnthropicModels(baseUrl, apiKey!, ssrf);
                availableModels = result.models;
                defaultModel = result.defaultModel;
                validated = result.validated;
                if (!result.validated) {
                  warnings.push("Could not validate API key — models listed are defaults");
                }
              }
              break;
            }
            case "google-generative-ai": {
              const result = await fetchGoogleModels(baseUrl, apiKey!, ssrf);
              availableModels = result.models;
              defaultModel = result.defaultModel;
              validated = true;
              break;
            }
            case "ollama": {
              const result = await fetchOllamaModels(baseUrl, ssrf);
              availableModels = result.models;
              defaultModel = result.defaultModel;
              validated = true;
              if (availableModels.length === 0) {
                warnings.push("No models installed in Ollama — run 'ollama pull <model>' first");
              }
              break;
            }
            default: {
              const result = await fetchCompatibleModels(baseUrl, apiKey, ssrf);
              availableModels = result.models;
              defaultModel = result.defaultModel;
              validated = true;
              break;
            }
          }
        } catch (err) {
          if (err instanceof FridayDomainError) {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          throw new FridayDomainError("PROVIDER_UNREACHABLE", `Could not reach provider: ${msg}`, { httpStatus: 422 });
        }

        latencyMs = Date.now() - startMs;

        return {
          kind,
          confidence,
          baseUrl,
          api,
          authMode,
          availableModels,
          defaultModel,
          validated,
          latencyMs,
          warnings,
        };
      },
    },

    // ─── GET /v1/setup/network ───
    {
      operationId: "setup.network.get",
      method: "GET",
      path: "/v1/setup/network",
      auth: { public: true },
      async handler(): Promise<SetupNetworkResponse> {
        const state = getSetupState();
        const host = state.network_host;
        const port = state.network_port;
        const mode = state.network_mode as NetworkMode;

        return {
          host,
          port,
          mode,
          previewUrls: computePreviewUrls(host, port),
          restartRequired: false,
        };
      },
    },

    // ─── POST /v1/setup/network ───
    // B0 Slice A3 carve-out: bootstrap boundary.
    {
      operationId: "setup.network.save",
      method: "POST",
      path: "/v1/setup/network",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx): Promise<SetupNetworkResponse> {
        assertSetupBootstrapBoundary(ctx);
        const body = ctx.body as SetupNetworkRequest | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
        }

        const mode = body.mode;
        if (!mode || !VALID_NETWORK_MODES.has(mode)) {
          throw new FridayDomainError("VALIDATION_ERROR", `mode must be one of: ${[...VALID_NETWORK_MODES].join(", ")}`, { httpStatus: 400 });
        }

        const port = body.port;
        if (typeof port !== "number" || port < 1 || port > 65535) {
          throw new FridayDomainError("VALIDATION_ERROR", "port must be a number between 1 and 65535", { httpStatus: 400 });
        }

        let host: string;
        switch (mode) {
          case "local":
            host = "127.0.0.1";
            break;
          case "network":
            host = "0.0.0.0";
            break;
          case "custom":
            if (typeof body.host !== "string" || body.host.trim() === "") {
              throw new FridayDomainError("VALIDATION_ERROR", "host is required for custom mode", { httpStatus: 400 });
            }
            host = body.host.trim();
            break;
          default:
            host = "127.0.0.1";
        }

        const now = deps.nowIso();

        deps.db.withWriteTransaction((db) => {
          db.prepare(
            `INSERT OR IGNORE INTO friday_setup_state (id, created_at, updated_at)
             VALUES ('singleton', ?, ?)`,
          ).run(now, now);
          db.prepare(
            `UPDATE friday_setup_state SET network_mode = ?, network_host = ?, network_port = ?, updated_at = ? WHERE id = 'singleton'`,
          ).run(mode, host, port, now);
        });

        // Check if restart is required (compare both host and port)
        const restartRequired = port !== deps.runningPort || host !== deps.runningHost;

        return {
          host,
          port,
          mode: mode as NetworkMode,
          previewUrls: computePreviewUrls(host, port),
          restartRequired,
        };
      },
    },

    // ─── POST /v1/setup/channels/feishu/registration/begin ───
    // B0 Slice A3 carve-out: bootstrap boundary.
    {
      operationId: "setup.channels.feishu.registration.begin",
      method: "POST",
      path: "/v1/setup/channels/feishu/registration/begin",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx): Promise<SetupFeishuRegistrationBeginResponse> {
        assertSetupBootstrapBoundary(ctx);
        return beginFeishuAppRegistration();
      },
    },

    // ─── POST /v1/setup/channels/feishu/registration/poll ───
    // B0 Slice A3 carve-out: bootstrap boundary.
    {
      operationId: "setup.channels.feishu.registration.poll",
      method: "POST",
      path: "/v1/setup/channels/feishu/registration/poll",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx): Promise<SetupFeishuRegistrationPollResponse> {
        assertSetupBootstrapBoundary(ctx);
        const body = ctx.body as SetupFeishuRegistrationPollRequest | null;
        const registrationId = typeof body?.registrationId === "string" ? body.registrationId.trim() : "";
        if (!registrationId) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "registrationId is required.",
            { httpStatus: 400 },
          );
        }
        return pollFeishuAppRegistration(registrationId);
      },
    },

    // ─── POST /v1/setup/channels/telegram/verification/begin ───
    // B0 Slice A3 carve-out: bootstrap boundary.
    {
      operationId: "setup.channels.telegram.verification.begin",
      method: "POST",
      path: "/v1/setup/channels/telegram/verification/begin",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx): Promise<SetupTelegramVerificationBeginResponse> {
        assertSetupBootstrapBoundary(ctx);
        return beginTelegramVerification(ctx.body as SetupTelegramVerificationBeginRequest | null);
      },
    },

    // ─── POST /v1/setup/channels/telegram/verification/poll ───
    // B0 Slice A3 carve-out: bootstrap boundary.
    {
      operationId: "setup.channels.telegram.verification.poll",
      method: "POST",
      path: "/v1/setup/channels/telegram/verification/poll",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx): Promise<SetupTelegramVerificationPollResponse> {
        assertSetupBootstrapBoundary(ctx);
        const body = ctx.body as SetupTelegramVerificationPollRequest | null;
        const verificationId = typeof body?.verificationId === "string" ? body.verificationId.trim() : "";
        if (!verificationId) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "verificationId is required.",
            { httpStatus: 400 },
          );
        }
        return pollTelegramVerification(verificationId);
      },
    },

    // ─── POST /v1/setup/channels/discord/verification/begin ───
    // B0 Slice A3 carve-out: bootstrap boundary.
    {
      operationId: "setup.channels.discord.verification.begin",
      method: "POST",
      path: "/v1/setup/channels/discord/verification/begin",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx): Promise<SetupDiscordVerificationBeginResponse> {
        assertSetupBootstrapBoundary(ctx);
        return beginDiscordVerification(ctx.body as SetupDiscordVerificationBeginRequest | null);
      },
    },

    // ─── POST /v1/setup/channels/discord/verification/complete ───
    // B0 Slice A3 carve-out: bootstrap boundary.
    {
      operationId: "setup.channels.discord.verification.complete",
      method: "POST",
      path: "/v1/setup/channels/discord/verification/complete",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx): Promise<SetupDiscordVerificationCompleteResponse> {
        assertSetupBootstrapBoundary(ctx);
        return completeDiscordVerification(ctx.body as SetupDiscordVerificationCompleteRequest | null);
      },
    },

    // ─── POST /v1/setup/channels/test ───
    // B0 Slice A3 carve-out: bootstrap boundary.
    {
      operationId: "setup.channels.test",
      method: "POST",
      path: "/v1/setup/channels/test",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx): Promise<SetupChannelTestResponse> {
        assertSetupBootstrapBoundary(ctx);
        const body = ctx.body as SetupChannelTestRequest | null;
        if (!body || typeof body !== "object" || typeof body.kind !== "string") {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body must contain a channel kind", { httpStatus: 400 });
        }
        if (!VALID_CHANNEL_KINDS.has(body.kind)) {
          throw new FridayDomainError("VALIDATION_ERROR", `Invalid channel kind: ${String(body.kind)}`, { httpStatus: 400 });
        }
        // B1 unsupported-channel boundary: refuse channel kinds labeled
        // unsupported (currently QQ — see FRIDAY_UNSUPPORTED_CHANNEL_KINDS in
        // friday-channel-config.ts and GLOBAL_DECISIONS_LOCKED.md "QQ is
        // unsupported/proof_pending unless fixed and proven"). Test before
        // running any credential validation.
        if (!isFridayChannelKindSupported(body.kind)) {
          throw new FridayDomainError(
            "CHANNEL_KIND_UNSUPPORTED",
            `Channel kind "${body.kind}" is currently unsupported. See product release notes for status.`,
            { httpStatus: 409, details: { kind: body.kind, status: "unsupported" } },
          );
        }
        if (body.config !== null && body.config !== undefined && (typeof body.config !== "object" || Array.isArray(body.config))) {
          throw new FridayDomainError("VALIDATION_ERROR", `config must be an object for channel ${body.kind}`, { httpStatus: 400 });
        }

        const kind = body.kind as FridaySupportedChannelKind;
        const config = normalizeSetupChannelConfig(kind, { ...(body.config ?? {}) } as Record<string, unknown>);

        // B1 unsupported-channel-mode boundary: refuse kind+mode combinations
        // labeled unsupported (currently slack+http — the listener is an
        // unwired stub). See FRIDAY_UNSUPPORTED_CHANNEL_MODES in
        // friday-channel-config.ts. Check after normalize so the inspected
        // `mode` field reflects schema defaults rather than raw request input.
        const candidateMode = typeof config.mode === "string" ? config.mode : undefined;
        if (!isFridayChannelModeSupported(kind, candidateMode)) {
          throw new FridayDomainError(
            "CHANNEL_MODE_UNSUPPORTED",
            `Channel kind "${kind}" with mode "${candidateMode}" is currently unsupported. See product release notes for status.`,
            { httpStatus: 409, details: { kind, mode: candidateMode, status: "unsupported" } },
          );
        }

        if (kind === "lark" || kind === "feishu") {
          return testLarkLikeChannelConnection(kind, config);
        }

        return {
          kind,
          validated: true,
          warnings: ["This channel does not have a dedicated setup credential test yet."],
        };
      },
    },

    // ─── POST /v1/setup/channels ───
    // B0 Slice A3 carve-out: bootstrap boundary.
    {
      operationId: "setup.channels.save",
      method: "POST",
      path: "/v1/setup/channels",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx): Promise<SetupChannelsResponse> {
        assertSetupBootstrapBoundary(ctx);
        const body = ctx.body as SetupChannelsRequest | null;
        if (!body || typeof body !== "object" || !Array.isArray(body.channels)) {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body must contain a channels array", { httpStatus: 400 });
        }

        const channelSlotCounter = new Map<FridaySupportedChannelKind, number>();

        const nextChannelSlot = (kind: FridaySupportedChannelKind): number => {
          const current = channelSlotCounter.get(kind) ?? 0;
          channelSlotCounter.set(kind, current + 1);
          return current;
        };

        const secretWrites: Array<{ refKey: string; plaintext: string }> = [];
        const persistedChannels: SetupChannelPersistedConfig[] = [];
        const now = deps.nowIso();

        // Validate and normalize each channel entry
        const enabledInstances: Array<Record<string, unknown>> = [];
        for (const ch of body.channels) {
          if (!ch || typeof ch !== "object") {
            throw new FridayDomainError("VALIDATION_ERROR", "Each channel must be an object", { httpStatus: 400 });
          }
          if (typeof ch.kind !== "string" || !VALID_CHANNEL_KINDS.has(ch.kind)) {
            throw new FridayDomainError("VALIDATION_ERROR", `Invalid channel kind: ${String(ch.kind)}`, { httpStatus: 400 });
          }
          // B1 unsupported-channel boundary: refuse to save channels of
          // unsupported kind (currently QQ). The schema still accepts the
          // shape for backward-compat, but the runtime rejects activation.
          if (!isFridayChannelKindSupported(ch.kind)) {
            throw new FridayDomainError(
              "CHANNEL_KIND_UNSUPPORTED",
              `Channel kind "${ch.kind}" is currently unsupported. See product release notes for status.`,
              { httpStatus: 409, details: { kind: ch.kind, status: "unsupported" } },
            );
          }
          if (typeof ch.enabled !== "boolean") {
            throw new FridayDomainError("VALIDATION_ERROR", `enabled must be a boolean for channel ${ch.kind}`, { httpStatus: 400 });
          }
          if (ch.config !== null && ch.config !== undefined && (typeof ch.config !== "object" || Array.isArray(ch.config))) {
            throw new FridayDomainError("VALIDATION_ERROR", `config must be an object for channel ${ch.kind}`, { httpStatus: 400 });
          }

          const kind = ch.kind as FridaySupportedChannelKind;
          const slot = nextChannelSlot(kind);
          const config = normalizeSetupChannelConfig(kind, { ...(ch.config ?? {}) } as Record<string, unknown>);

          // B1 unsupported-channel-mode boundary: refuse to save channels with
          // an unsupported kind+mode combination (currently slack+http — the
          // listener is an unwired stub). See FRIDAY_UNSUPPORTED_CHANNEL_MODES.
          // Check after normalize so the inspected `mode` reflects schema
          // defaults rather than raw request input.
          const candidateMode = typeof config.mode === "string" ? config.mode : undefined;
          if (!isFridayChannelModeSupported(kind, candidateMode)) {
            throw new FridayDomainError(
              "CHANNEL_MODE_UNSUPPORTED",
              `Channel kind "${kind}" with mode "${candidateMode}" is currently unsupported. See product release notes for status.`,
              { httpStatus: 409, details: { kind, mode: candidateMode, status: "unsupported" } },
            );
          }

          if (kind === "telegram") {
            applyTelegramVerificationToConfig(config, ch.enabled);
          }
          if (kind === "discord") {
            applyDiscordVerificationToConfig(config, ch.enabled);
          }
          if (kind === "feishu") {
            applyFeishuRegistrationToConfig(config, ch.enabled);
          }

          // Fail closed: an enabled control-capable channel must persist a
          // verified user/chat allowlist. A missing allowlist must NOT be
          // treated as "allow everyone" (locked channel policy). The
          // verification-apply above populates this for telegram/discord/feishu;
          // any other control-capable channel must carry an explicit allowlist.
          if (ch.enabled && isControlCapableChannelKind(kind)) {
            const cfg = config as Record<string, unknown>;
            const hasAllowlist = Boolean(
              normalizeStringList(cfg.allowedUsers)
              || normalizeStringList(cfg.allowedChats)
              || normalizeStringList(cfg.allowedChannels)
              || normalizeStringList(cfg.allowedGroups),
            );
            if (!hasAllowlist) {
              throw new FridayDomainError(
                "CHANNEL_ALLOWLIST_REQUIRED",
                `Channel ${kind} requires a verified user/chat allowlist before it can be enabled (control-capable channels fail closed).`,
                { httpStatus: 400, details: { kind, status: "allowlist_required" } },
              );
            }
          }

          const secretFields = getFridayChannelSecretFieldDescriptors(kind, config);

          for (const field of secretFields) {
            const rawValue = config[field.field];
            const value = typeof rawValue === "string" ? rawValue.trim() : "";

            if (value.length === 0) {
              if (ch.enabled && field.required) {
                const reasonSuffix = field.reason ? ` (${field.reason})` : "";
                throw new FridayDomainError(
                  "VALIDATION_ERROR",
                  `Missing required secret field "${field.field}" for channel ${kind}${reasonSuffix}`,
                  { httpStatus: 400 },
                );
              }
              continue;
            }

            const parsedSecret = parseFridaySecretInput(value, {
              secretRefPrefixes: ["secret://channel/", "secret://"],
            });
            if (parsedSecret.kind !== "inline") {
              config[field.field] = value;
              continue;
            }

            const refKey = buildFridayChannelSecretRefKey(kind, slot, field.field);
            secretWrites.push({ refKey, plaintext: value });
            config[field.field] = buildFridayChannelSecretRef(refKey);
          }

          persistedChannels.push({
            kind,
            enabled: ch.enabled,
            config,
            ...(ch.enabled ? { controlConfirmed: true, controlConfirmedAt: now } : {}),
          });

          if (ch.enabled) {
            enabledInstances.push({
              kind,
              enabled: true,
              ...config,
            });
          }
        }

        if (enabledInstances.length > 0 && body.controlConfirmed !== true) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "controlConfirmed must be true before enabled channels can control Friday.",
            { httpStatus: 400 },
          );
        }

        if (enabledInstances.length > 0) {
          try {
            parseFridayChannelsConfig({
              enabled: true,
              instances: enabledInstances,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              `Invalid enabled channel config: ${message}`,
              { httpStatus: 400 },
            );
          }
        }

        if (secretWrites.length > 0) {
          const masterKey = getStrictMasterKey();
          deps.db.withWriteTransaction((db) => {
            for (const write of secretWrites) {
              const secretId = `channel-secret:${write.refKey}`; // pragma: allowlist secret
              const envelope = encryptSecret(
                write.plaintext,
                masterKey,
                fridaySecretAadContext({ scope: FRIDAY_CHANNEL_SECRET_SCOPE, id: secretId }),
              );
              channelSecretRepository.upsert(db, {
                id: secretId,
                scope: FRIDAY_CHANNEL_SECRET_SCOPE,
                refKey: write.refKey,
                encryptedValue: JSON.stringify(envelope),
                keyId: "master-v1",
                nowIso: now,
              });
            }
          });
        }

        const channelsJson = JSON.stringify(persistedChannels);

        deps.db.withWriteTransaction((db) => {
          db.prepare(
            `INSERT OR IGNORE INTO friday_setup_state (id, created_at, updated_at)
             VALUES ('singleton', ?, ?)`,
          ).run(now, now);
          db.prepare(
            `UPDATE friday_setup_state SET channels_json = ?, updated_at = ? WHERE id = 'singleton'`,
          ).run(channelsJson, now);
        });

        const savedKinds = persistedChannels
          .filter((ch) => ch.enabled)
          .map((ch) => ch.kind);

        let activation: SetupChannelsActivationResponse | undefined;
        if (deps.activateSavedChannels) {
          try {
            activation = await deps.activateSavedChannels();
          } catch (error) {
            activation = {
              startedKinds: [],
              failed: [],
              restartRequired: true,
              warnings: [
                `Channels were saved, but Friday could not start them without a restart: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ],
            };
          }
        }

        if (savedKinds.includes("feishu")) {
          await sendFeishuSetupCompleteWelcomeIfConfigured(deps);
        }

        if (ctx.principal?.userId && savedKinds.length > 0) {
          await deps.onChannelsSaved?.({
            userId: ctx.principal.userId,
            savedKinds,
          });
        }

        return { savedKinds, ...(activation ? { activation } : {}) };
      },
    },

    // ─── POST /v1/setup/complete ───
    // B0 Slice A3 carve-out: bootstrap boundary. After this route succeeds and
    // setup_completed_at is set, all 11 setup-wizard mutations (including this
    // one) become permanently fail-closed. A second call returns 409
    // SETUP_ALREADY_COMPLETED — clients should check setup.status to confirm
    // outcome rather than rely on idempotent retries here.
    {
      operationId: "setup.complete",
      method: "POST",
      path: "/v1/setup/complete",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx): Promise<SetupCompleteResponse> {
        assertSetupBootstrapBoundary(ctx);
        const body = ctx.body as SetupCompleteRequest | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
        }

        const completedSteps = Array.isArray(body.completedSteps) ? body.completedSteps : [];
        const skippedSteps = Array.isArray(body.skippedSteps) ? body.skippedSteps : [];

        // Validate that all step IDs are known
        for (const step of completedSteps) {
          if (typeof step !== "string" || !VALID_STEP_IDS.has(step)) {
            throw new FridayDomainError("VALIDATION_ERROR", `Unknown step ID in completedSteps: ${String(step)}`, { httpStatus: 400 });
          }
        }
        for (const step of skippedSteps) {
          if (typeof step !== "string" || !VALID_STEP_IDS.has(step)) {
            throw new FridayDomainError("VALIDATION_ERROR", `Unknown step ID in skippedSteps: ${String(step)}`, { httpStatus: 400 });
          }
        }

        // Idempotency: if setup is already complete, return existing timestamp
        const existingState = deps.db.withReadConnection((db) => {
          return db.prepare(
            `SELECT setup_completed_at FROM friday_setup_state WHERE id = 'singleton' AND setup_completed_at IS NOT NULL`,
          ).get() as { setup_completed_at: string } | undefined;
        });
        if (existingState?.setup_completed_at) {
          await sendFeishuSetupCompleteWelcomeIfConfigured(deps);
          return { setupCompletedAt: existingState.setup_completed_at };
        }

        // If provider step was not explicitly handled, auto-mark as skipped
        const providerHandled = completedSteps.includes("provider") || skippedSteps.includes("provider");
        if (!providerHandled) {
          skippedSteps.push("provider");
        }

        // "done" must always be persisted as the completion sentinel.
        const normalizedCompletedSteps = Array.from(
          new Set([...completedSteps, "done"]),
        );

        const now = deps.nowIso();

        deps.db.withWriteTransaction((db) => {
          db.prepare(
            `INSERT OR IGNORE INTO friday_setup_state (id, created_at, updated_at)
             VALUES ('singleton', ?, ?)`,
          ).run(now, now);
          db.prepare(
            `UPDATE friday_setup_state
             SET setup_completed_at = ?, completed_steps = ?, skipped_steps = ?, updated_at = ?
             WHERE id = 'singleton'`,
          ).run(now, JSON.stringify(normalizedCompletedSteps), JSON.stringify(skippedSteps), now);
        });

        await sendFeishuSetupCompleteWelcomeIfConfigured(deps);
        if (ctx.principal?.userId) {
          await deps.onSetupCompleted?.({ userId: ctx.principal.userId });
        }

        return { setupCompletedAt: now };
      },
    },
  ];
}
