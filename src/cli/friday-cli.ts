#!/usr/bin/env node

/**
 * Phase C — Friday CLI entry point.
 *
 * Lightweight arg parsing via process.argv; no external CLI framework.
 *
 * Commands:
 *   friday start      [--skills-dir <path>] [--port <n>]   — boot hub, keep running
 *   friday list        [--skills-dir <path>]                — list loaded skills
 *   friday run         <skill-id> [--input k=v ...] [--skills-dir <path>] — run a skill
 *   friday status                                           — show hub status
 *   friday import      <source> [--from <format>] [--target <path>] [--replace] [--dry-run]
 *   friday convert     <source> --out <dir> [--from <format>]
 *   friday converters                                       — list converters
 *   friday pack        <skill-dir> --out <file.tgz>
 *   friday --help                                           — usage info
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFridayChannelSecretRef,
  buildFridayChannelSecretRefKey,
  type FridaySupportedChannelKind,
  getFridayChannelSecretFieldDescriptors,
  isFridayEnvSecretRef,
  parseFridayChannelsConfig,
  parseFridayChannelSecretRef,
} from "#channels";
import { createFridayHub, resolveFridayHubConfig } from "#hub";
import type { FridayHubConfig } from "#hub";
import {
  createFridaySecretRepository,
  encryptSecret,
  getMasterKey,
} from "#providers";
import { resolveFridayDbPath } from "#state";
import { resolveSafePath } from "#utilities";
import Database from "better-sqlite3";
import { runFridayCliLoop } from "./friday-cli-run-loop.js";
import { FRIDAY_VERSION } from "../lib/version.js";
import { runFridayCliAuthLoginAnthropic } from "./friday-cli-auth.js";

// ─── Arg parser ───

export interface ParsedArgs {
  command: "start" | "list" | "run" | "status" | "help" | "import" | "convert" | "converters" | "pack" | "auth";
  skillDirs: string[];
  port: number | undefined;
  skillId: string | undefined;
  input: Record<string, string>;
  // Converter-related fields
  source: string | undefined;
  from: string | undefined;
  target: string | undefined;
  out: string | undefined;
  replace: boolean;
  dryRun: boolean;
  skillDir: string | undefined;
  // New converter option flags
  splitOperations: boolean | undefined;
  skillIdPrefix: string | undefined;
  noRefresh: boolean;
  host: string | undefined;
  // Auth-related fields
  authSubcommand: string | undefined;
  authTarget: string | undefined;
  providerId: string | undefined;
  code: string | undefined;
  noBrowser: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  // Strip node + script path
  const args = argv.slice(2);

  const result: ParsedArgs = {
    command: "help",
    skillDirs: [],
    port: undefined,
    skillId: undefined,
    input: {},
    source: undefined,
    from: undefined,
    target: undefined,
    out: undefined,
    replace: false,
    dryRun: false,
    skillDir: undefined,
    splitOperations: undefined,
    skillIdPrefix: undefined,
    noRefresh: false,
    host: undefined,
    authSubcommand: undefined,
    authTarget: undefined,
    providerId: undefined,
    code: undefined,
    noBrowser: false,
  };

  if (args.length === 0) {
    return result;
  }

  const cmd = args[0]!;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    result.command = "help";
    return result;
  }

  const validCommands = ["start", "list", "run", "status", "import", "convert", "converters", "pack", "auth"] as const;
  type ValidCommand = (typeof validCommands)[number];

  if ((validCommands as readonly string[]).includes(cmd)) {
    result.command = cmd as ValidCommand;
  } else {
    result.command = "help";
    return result;
  }

  // For "converters" command, no additional args needed
  if (cmd === "converters") {
    return result;
  }

  let i = 1;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === "--skills-dir" && i + 1 < args.length) {
      result.skillDirs.push(args[i + 1]!);
      i += 2;
      continue;
    }

    if (arg === "--port" && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1]!, 10);
      if (!Number.isNaN(parsed)) {
        result.port = parsed;
      }
      i += 2;
      continue;
    }

    if (arg === "--host" && i + 1 < args.length) {
      result.host = args[i + 1]!;
      i += 2;
      continue;
    }

    if (arg === "--input" && i + 1 < args.length) {
      const kv = args[i + 1]!;
      const eqIdx = kv.indexOf("=");
      if (eqIdx > 0) {
        result.input[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
      }
      i += 2;
      continue;
    }

    if (arg === "--from" && i + 1 < args.length) {
      result.from = args[i + 1]!;
      i += 2;
      continue;
    }

    if (arg === "--target" && i + 1 < args.length) {
      result.target = args[i + 1]!;
      i += 2;
      continue;
    }

    if (arg === "--out" && i + 1 < args.length) {
      result.out = args[i + 1]!;
      i += 2;
      continue;
    }

    if (arg === "--replace") {
      result.replace = true;
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      result.dryRun = true;
      i += 1;
      continue;
    }

    if (arg === "--split-operations") {
      result.splitOperations = true;
      i += 1;
      continue;
    }

    if (arg === "--no-split-operations") {
      result.splitOperations = false;
      i += 1;
      continue;
    }

    if (arg === "--skill-id-prefix" && i + 1 < args.length) {
      result.skillIdPrefix = args[i + 1]!;
      i += 2;
      continue;
    }

    if (arg === "--no-refresh") {
      result.noRefresh = true;
      i += 1;
      continue;
    }

    if (arg === "--provider-id" && i + 1 < args.length) {
      result.providerId = args[i + 1]!;
      i += 2;
      continue;
    }

    if (arg === "--code" && i + 1 < args.length) {
      result.code = args[i + 1]!;
      i += 2;
      continue;
    }

    if (arg === "--no-browser") {
      result.noBrowser = true;
      i += 1;
      continue;
    }

    // For `run`, the first positional after the command is the skill ID
    if (result.command === "run" && result.skillId === undefined && !arg.startsWith("--")) {
      result.skillId = arg;
      i += 1;
      continue;
    }

    // For `import` or `convert`, the first positional is the source
    if ((result.command === "import" || result.command === "convert") && result.source === undefined && !arg.startsWith("--")) {
      result.source = arg;
      i += 1;
      continue;
    }

    // For `pack`, the first positional is the skill dir
    if (result.command === "pack" && result.skillDir === undefined && !arg.startsWith("--")) {
      result.skillDir = arg;
      i += 1;
      continue;
    }

    // For `auth`, parse subcommand and target: auth login anthropic
    if (result.command === "auth" && !arg.startsWith("--")) {
      if (result.authSubcommand === undefined) {
        result.authSubcommand = arg;
        i += 1;
        continue;
      }
      if (result.authTarget === undefined) {
        result.authTarget = arg;
        i += 1;
        continue;
      }
    }

    // Unknown arg — skip
    i += 1;
  }

  return result;
}

// ─── Usage ───

function printUsage(): void {
  console.log(`
friday — Friday AI automation CLI

Usage:
  friday start  [--skills-dir <path>] [--port <n>] [--host <addr>]
      Boot the hub, load skills, and keep the process running.
      Default host: 127.0.0.1 (loopback only). Use --host 0.0.0.0 for network access.

  friday list   [--skills-dir <path>]
      Load skills and print them in a table, then exit.

  friday run <skill-id> [--input key=value ...] [--skills-dir <path>]
      Boot the hub, run a single skill, print result, then exit.

  friday status
      Show hub status (running / stopped).

  friday import <source> [--from <format>] [--target <path>] [--replace] [--dry-run] [--no-refresh]
      Detect, convert, validate, install, and refresh registry for a skill source.

  friday convert <source> --out <dir> [--from <format>] [--split-operations] [--skill-id-prefix <prefix>]
      Convert a skill source to Friday package(s) without installing.

  friday converters
      List installed converters and supported source formats.

  friday pack <skill-dir> --out <file.tgz>
      Package a native Friday skill directory into a .friday.tgz archive.

  friday --help
      Show this help message.

Options:
  --skills-dir <path>   Directory to discover skills from (repeatable).
  --port <n>            Port for the API + UI server.
  --host <addr>         Bind address (default: 127.0.0.1). Use 0.0.0.0 for network access.
  --input key=value     Input parameter for skill execution (repeatable).
  --from <format>       Source format hint (auto, clawdbot-skill-md, n8n-node, openai-gpt-action, code-repo, undocumented-api, friday-package).
  --target <path>       Install target (managed, workspace, or a custom path).
  --out <path>          Output directory or file path.
  --replace             Overwrite existing skill on collision.
  --dry-run             Preview conversion without installing.
  --split-operations    Create one skill per OpenAPI operation (default).
  --no-split-operations Combine all OpenAPI operations into one skill.
  --skill-id-prefix <s> Prefix for generated skill IDs.
  --no-refresh          Skip registry refresh after import.
`.trim());
}

// ─── Commands ───

type JsonObject = Record<string, unknown>;
const channelSecretRepository = createFridaySecretRepository();

interface FridayStartupChannelsResolution {
  channels?: JsonObject;
  source:
    | "env_override"
    | "setup_state"
    | "migrated_legacy_to_setup_state"
    | "legacy_runtime_fallback"
    | "none";
  migrated: boolean;
  scrubbedLegacy: boolean;
  compatMode: boolean;
}

interface LegacyFridayJsonDocument {
  path: string;
  content: JsonObject;
}

interface FridayPersistedSetupChannel {
  kind: FridaySupportedChannelKind;
  enabled: boolean;
  config: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function warnLegacyChannelSkip(kind: string, reason: string): void {
  console.warn(`[friday] Skip legacy channel "${kind}": ${reason}`);
}

function normalizeLegacyChannelEntry(
  kind: string,
  raw: JsonObject,
): JsonObject | null {
  if (raw.enabled === false) return null;

  switch (kind) {
    case "discord": {
      const token = asNonEmptyString(raw.token) ?? asNonEmptyString(raw.botToken);
      if (!token) {
        warnLegacyChannelSkip(kind, "missing token");
        return null;
      }
      const instance: JsonObject = { kind: "discord", enabled: true, token };
      const allowedUsers = asStringArray(raw.allowedUsers) ?? asStringArray(raw.allowFrom);
      const allowedChannels = asStringArray(raw.allowedChannels) ?? asStringArray(raw.allowedChats);
      const intents = asPositiveInt(raw.intents);
      if (allowedUsers) instance.allowedUsers = allowedUsers;
      if (allowedChannels) instance.allowedChannels = allowedChannels;
      if (typeof raw.requireMention === "boolean") instance.requireMention = raw.requireMention;
      if (asNonEmptyString(raw.botUserId)) instance.botUserId = asNonEmptyString(raw.botUserId);
      if (intents) instance.intents = intents;
      return instance;
    }
    case "telegram": {
      const botToken = asNonEmptyString(raw.botToken) ?? asNonEmptyString(raw.token);
      if (!botToken) {
        warnLegacyChannelSkip(kind, "missing botToken/token");
        return null;
      }
      const instance: JsonObject = { kind: "telegram", enabled: true, botToken };
      const mode = asNonEmptyString(raw.mode) ?? asNonEmptyString(raw.receiveMode);
      const allowedUsers = asStringArray(raw.allowedUsers) ?? asStringArray(raw.allowFrom);
      const allowedChats = asStringArray(raw.allowedChats) ?? asStringArray(raw.allowedChannels);
      if (mode === "webhook" || mode === "polling") instance.mode = mode;
      if (asNonEmptyString(raw.webhookUrl)) instance.webhookUrl = asNonEmptyString(raw.webhookUrl);
      if (allowedUsers) instance.allowedUsers = allowedUsers;
      if (allowedChats) instance.allowedChats = allowedChats;
      return instance;
    }
    case "slack": {
      const botToken = asNonEmptyString(raw.botToken) ?? asNonEmptyString(raw.token);
      if (!botToken) {
        warnLegacyChannelSkip(kind, "missing botToken/token");
        return null;
      }
      const instance: JsonObject = { kind: "slack", enabled: true, botToken };
      const mode = asNonEmptyString(raw.mode);
      const allowedUsers = asStringArray(raw.allowedUsers) ?? asStringArray(raw.allowFrom);
      const allowedChannels = asStringArray(raw.allowedChannels) ?? asStringArray(raw.allowedChats);
      if (mode === "socket" || mode === "http") instance.mode = mode;
      if (asNonEmptyString(raw.appToken)) instance.appToken = asNonEmptyString(raw.appToken);
      if (asNonEmptyString(raw.signingSecret)) instance.signingSecret = asNonEmptyString(raw.signingSecret);
      if (allowedUsers) instance.allowedUsers = allowedUsers;
      if (allowedChannels) instance.allowedChannels = allowedChannels;
      return instance;
    }
    case "whatsapp": {
      const provider = asNonEmptyString(raw.provider) === "bridge" ? "bridge" : "cloud-api";
      const instance: JsonObject = { kind: "whatsapp", enabled: true, provider };
      if (provider === "bridge") {
        const bridgeUrl = asNonEmptyString(raw.bridgeUrl) ?? asNonEmptyString(raw.baseUrl);
        if (!bridgeUrl) {
          warnLegacyChannelSkip(kind, "missing bridgeUrl/baseUrl for bridge provider");
          return null;
        }
        instance.bridgeUrl = bridgeUrl;
      } else {
        const accessToken = asNonEmptyString(raw.accessToken) ?? asNonEmptyString(raw.token);
        const phoneNumberId = asNonEmptyString(raw.phoneNumberId);
        if (!accessToken || !phoneNumberId) {
          warnLegacyChannelSkip(kind, "missing accessToken/token or phoneNumberId for cloud-api provider");
          return null;
        }
        instance.accessToken = accessToken;
        instance.phoneNumberId = phoneNumberId;
      }
      const allowedUsers = asStringArray(raw.allowedUsers) ?? asStringArray(raw.allowFrom);
      const allowedChats = asStringArray(raw.allowedChats) ?? asStringArray(raw.allowedChannels);
      if (asNonEmptyString(raw.webhookVerifyToken)) {
        instance.webhookVerifyToken = asNonEmptyString(raw.webhookVerifyToken);
      }
      if (asNonEmptyString(raw.appSecret)) instance.appSecret = asNonEmptyString(raw.appSecret);
      if (allowedUsers) instance.allowedUsers = allowedUsers;
      if (allowedChats) instance.allowedChats = allowedChats;
      return instance;
    }
    case "signal": {
      const account =
        asNonEmptyString(raw.account) ??
        asNonEmptyString(raw.phoneNumber) ??
        asNonEmptyString(raw.phone);
      if (!account) {
        warnLegacyChannelSkip(kind, "missing account/phoneNumber/phone");
        return null;
      }
      const instance: JsonObject = { kind: "signal", enabled: true, account };
      if (asNonEmptyString(raw.baseUrl)) instance.baseUrl = asNonEmptyString(raw.baseUrl);
      if (asNonEmptyString(raw.cliPath)) instance.cliPath = asNonEmptyString(raw.cliPath);
      const allowedUsers = asStringArray(raw.allowedUsers) ?? asStringArray(raw.allowFrom);
      if (allowedUsers) instance.allowedUsers = allowedUsers;
      return instance;
    }
    case "line": {
      const channelAccessToken =
        asNonEmptyString(raw.channelAccessToken) ??
        asNonEmptyString(raw.accessToken) ??
        asNonEmptyString(raw.token);
      const channelSecret = asNonEmptyString(raw.channelSecret) ?? asNonEmptyString(raw.secret);
      if (!channelAccessToken || !channelSecret) {
        warnLegacyChannelSkip(kind, "missing channelAccessToken/token or channelSecret");
        return null;
      }
      const instance: JsonObject = {
        kind: "line",
        enabled: true,
        channelAccessToken,
        channelSecret,
      };
      if (asNonEmptyString(raw.webhookPath)) instance.webhookPath = asNonEmptyString(raw.webhookPath);
      const allowedUsers = asStringArray(raw.allowedUsers) ?? asStringArray(raw.allowFrom);
      const allowedGroups = asStringArray(raw.allowedGroups) ?? asStringArray(raw.allowedChats);
      if (allowedUsers) instance.allowedUsers = allowedUsers;
      if (allowedGroups) instance.allowedGroups = allowedGroups;
      return instance;
    }
    case "qq": {
      const appId = asNonEmptyString(raw.appId);
      const appSecret = asNonEmptyString(raw.appSecret);
      if (!appId || !appSecret) {
        warnLegacyChannelSkip(kind, "missing appId/appSecret");
        return null;
      }
      const instance: JsonObject = { kind: "qq", enabled: true, appId, appSecret };
      if (typeof raw.sandbox === "boolean") instance.sandbox = raw.sandbox;
      const allowedUsers = asStringArray(raw.allowedUsers) ?? asStringArray(raw.allowFrom);
      const allowedGroups = asStringArray(raw.allowedGroups) ?? asStringArray(raw.allowedChats);
      if (allowedUsers) instance.allowedUsers = allowedUsers;
      if (allowedGroups) instance.allowedGroups = allowedGroups;
      return instance;
    }
    case "lark":
    case "feishu": {
      const appId = asNonEmptyString(raw.appId);
      const appSecret = asNonEmptyString(raw.appSecret);
      if (!appId || !appSecret) {
        warnLegacyChannelSkip(kind, "missing appId/appSecret");
        return null;
      }
      const instance: JsonObject = { kind, enabled: true, appId, appSecret };
      const receiveMode = asNonEmptyString(raw.receiveMode) ?? asNonEmptyString(raw.mode);
      const allowedUsers = asStringArray(raw.allowedUsers) ?? asStringArray(raw.allowFrom);
      const allowedChats = asStringArray(raw.allowedChats) ?? asStringArray(raw.allowedChannels);
      if (kind === "feishu") instance.useFeishu = true;
      if (receiveMode === "websocket" || receiveMode === "webhook") {
        instance.receiveMode = receiveMode;
      }
      if (allowedUsers) instance.allowedUsers = allowedUsers;
      if (allowedChats) instance.allowedChats = allowedChats;
      return instance;
    }
    case "webchat": {
      const instance: JsonObject = { kind: "webchat", enabled: true };
      if (asNonEmptyString(raw.wsPath)) instance.wsPath = asNonEmptyString(raw.wsPath);
      const allowedOrigins = asStringArray(raw.allowedOrigins);
      if (allowedOrigins) instance.allowedOrigins = allowedOrigins;
      const authMode = asNonEmptyString(raw.authMode);
      if (authMode === "none" || authMode === "token" || authMode === "session") {
        instance.authMode = authMode;
      }
      const maxClients = asPositiveInt(raw.maxClients);
      if (maxClients) instance.maxClients = maxClients;
      return instance;
    }
    case "irc": {
      const host = asNonEmptyString(raw.host);
      const nick = asNonEmptyString(raw.nick);
      if (!host || !nick) {
        warnLegacyChannelSkip(kind, "missing host/nick");
        return null;
      }
      const instance: JsonObject = { kind: "irc", enabled: true, host, nick };
      const port = asPositiveInt(raw.port);
      if (port) instance.port = port;
      if (typeof raw.tls === "boolean") instance.tls = raw.tls;
      if (asNonEmptyString(raw.username)) instance.username = asNonEmptyString(raw.username);
      if (asNonEmptyString(raw.password)) instance.password = asNonEmptyString(raw.password);
      const channels = asStringArray(raw.channels) ?? asStringArray(raw.joinChannels);
      const allowedUsers = asStringArray(raw.allowedUsers) ?? asStringArray(raw.allowFrom);
      if (channels) instance.channels = channels;
      if (allowedUsers) instance.allowedUsers = allowedUsers;
      return instance;
    }
    default:
      return null;
  }
}

function buildChannelsFromLegacyMap(rawMap: JsonObject): JsonObject | undefined {
  const instances: JsonObject[] = [];
  for (const [kind, value] of Object.entries(rawMap)) {
    if (!isObject(value)) continue;
    const normalized = normalizeLegacyChannelEntry(kind, value);
    if (normalized) instances.push(normalized);
  }
  if (instances.length === 0) return undefined;
  return { enabled: true, instances };
}

function loadChannelsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JsonObject | undefined {
  const raw = env.FRIDAY_CHANNELS_JSON;
  if (!raw || raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) return undefined;
    if (Array.isArray(parsed.instances) || typeof parsed.enabled === "boolean") {
      return parsed;
    }
    return buildChannelsFromLegacyMap(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[friday] Failed to parse FRIDAY_CHANNELS_JSON: ${message}`);
    return undefined;
  }
}

function readLegacyFridayJsonDocument(
  env: NodeJS.ProcessEnv = process.env,
): LegacyFridayJsonDocument | undefined {
  const home = env.HOME;
  if (!home || home.trim() === "") return undefined;
  const legacyPath = join(home, ".friday", "friday.json");
  if (!existsSync(legacyPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, "utf8")) as unknown;
    if (!isObject(parsed)) return undefined;
    return {
      path: legacyPath,
      content: parsed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[friday] Failed to parse ${legacyPath}: ${message}`);
    return undefined;
  }
}

function loadChannelsFromLegacyFridayJson(
  env: NodeJS.ProcessEnv = process.env,
): JsonObject | undefined {
  const legacy = readLegacyFridayJsonDocument(env);
  if (!legacy || !isObject(legacy.content.channels)) {
    return undefined;
  }
  return buildChannelsFromLegacyMap(legacy.content.channels);
}

function scrubLegacyChannelsBlock(legacy: LegacyFridayJsonDocument): boolean {
  if (!Object.prototype.hasOwnProperty.call(legacy.content, "channels")) {
    return false;
  }
  delete legacy.content.channels;
  writeFileSync(legacy.path, `${JSON.stringify(legacy.content, null, 2)}\n`, "utf8");
  return true;
}

function hasSqliteTable(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = ?`,
    )
    .get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function readSetupStateChannels(db: Database.Database): FridayPersistedSetupChannel[] {
  const row = db
    .prepare("SELECT channels_json FROM friday_setup_state WHERE id = 'singleton'")
    .get() as { channels_json?: string | null } | undefined;
  if (!row?.channels_json) {
    return [];
  }
  try {
    const parsed = JSON.parse(row.channels_json) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is { kind?: unknown; enabled?: unknown; config?: unknown } =>
        isObject(item),
      )
      .map((item) => ({
        kind: String(item.kind ?? "").trim() as FridaySupportedChannelKind,
        enabled: item.enabled !== false,
        config: isObject(item.config) ? item.config : {},
      }))
      .filter((item) => item.kind.length > 0);
  } catch {
    return [];
  }
}

function buildPersistedChannelsFromLegacyMap(rawMap: JsonObject): FridayPersistedSetupChannel[] {
  const persisted: FridayPersistedSetupChannel[] = [];
  for (const [kind, value] of Object.entries(rawMap)) {
    if (!isObject(value)) continue;
    const normalized = normalizeLegacyChannelEntry(kind, value);
    if (!normalized) continue;

    const { kind: normalizedKind, enabled, ...config } = normalized;
    if (typeof normalizedKind !== "string") {
      continue;
    }

    persisted.push({
      kind: normalizedKind as FridaySupportedChannelKind,
      enabled: enabled !== false,
      config,
    });
  }
  return persisted;
}

function persistMigratedChannels(
  db: Database.Database,
  persistedChannels: FridayPersistedSetupChannel[],
  nowIso: string,
): { changed: boolean } {
  const secretWrites: Array<{ refKey: string; plaintext: string }> = [];
  const normalizedChannels = persistedChannels.map((channel, slot) => {
    const config: JsonObject = { ...channel.config };
    for (const field of getFridayChannelSecretFieldDescriptors(channel.kind, config)) {
      const rawValue = config[field.field];
      if (typeof rawValue !== "string") {
        continue;
      }
      const trimmed = rawValue.trim();
      if (
        trimmed.length === 0
        || isFridayEnvSecretRef(trimmed)
        || parseFridayChannelSecretRef(trimmed)
      ) {
        continue;
      }
      const refKey = buildFridayChannelSecretRefKey(channel.kind, slot, field.field);
      secretWrites.push({ refKey, plaintext: trimmed });
      config[field.field] = buildFridayChannelSecretRef(refKey);
    }
    return {
      kind: channel.kind,
      enabled: channel.enabled,
      config,
    };
  });
  const changed = JSON.stringify(normalizedChannels) !== JSON.stringify(persistedChannels);

  const enabledInstances = normalizedChannels
    .filter((channel) => channel.enabled)
    .map((channel) => ({
      kind: channel.kind,
      enabled: true,
      ...channel.config,
    }));
  if (enabledInstances.length > 0) {
    parseFridayChannelsConfig({
      enabled: true,
      instances: enabledInstances,
    });
  }

  if (!changed && secretWrites.length === 0) {
    return { changed: false };
  }

  if (secretWrites.length > 0) {
    const masterKey = getMasterKey();
    for (const write of secretWrites) {
      const envelope = encryptSecret(write.plaintext, masterKey);
      channelSecretRepository.upsert(db, {
        id: `channel-secret:${write.refKey}`,
        scope: "channel",
        refKey: write.refKey,
        encryptedValue: JSON.stringify(envelope),
        keyId: "master-v1",
        nowIso,
      });
    }
  }

  db.prepare(
    `INSERT OR IGNORE INTO friday_setup_state (id, created_at, updated_at)
     VALUES ('singleton', ?, ?)`,
  ).run(nowIso, nowIso);
  db.prepare(
    `UPDATE friday_setup_state
     SET channels_json = ?, updated_at = ?
     WHERE id = 'singleton'`,
  ).run(JSON.stringify(normalizedChannels), nowIso);
  return { changed };
}

export function prepareStartupChannelsConfig(options?: {
  env?: NodeJS.ProcessEnv;
  dbPath?: string;
  nowIso?: () => string;
}): FridayStartupChannelsResolution {
  const env = options?.env ?? process.env;
  const fromEnv = loadChannelsFromEnv(env);
  if (fromEnv) {
    return {
      channels: fromEnv,
      source: "env_override",
      migrated: false,
      scrubbedLegacy: false,
      compatMode: false,
    };
  }

  const legacy = readLegacyFridayJsonDocument(env);
  const legacyChannels = legacy && isObject(legacy.content.channels)
    ? legacy.content.channels
    : undefined;
  const dbPath = options?.dbPath ?? resolveFridayDbPath({ env });

  if (!existsSync(dbPath)) {
    const runtimeFallback = legacyChannels ? buildChannelsFromLegacyMap(legacyChannels) : undefined;
    return {
      channels: runtimeFallback,
      source: runtimeFallback ? "legacy_runtime_fallback" : "none",
      migrated: false,
      scrubbedLegacy: false,
      compatMode: Boolean(runtimeFallback),
    };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    const hasSetupTable = hasSqliteTable(db, "friday_setup_state");
    const hasSecretsTable = hasSqliteTable(db, "secrets");
    if (!hasSetupTable || !hasSecretsTable) {
      const runtimeFallback = legacyChannels ? buildChannelsFromLegacyMap(legacyChannels) : undefined;
      return {
        channels: runtimeFallback,
        source: runtimeFallback ? "legacy_runtime_fallback" : "none",
        migrated: false,
        scrubbedLegacy: false,
        compatMode: Boolean(runtimeFallback),
      };
    }

    const existingSetupChannels = readSetupStateChannels(db);
    if (existingSetupChannels.length > 0) {
      const nowIso = options?.nowIso?.() ?? new Date().toISOString();
      let changed = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        changed = persistMigratedChannels(db, existingSetupChannels, nowIso).changed;
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const scrubbedLegacy = legacy ? scrubLegacyChannelsBlock(legacy) : false;
      return {
        source: "setup_state",
        migrated: changed,
        scrubbedLegacy,
        compatMode: false,
      };
    }

    if (!legacyChannels) {
      return {
        source: "none",
        migrated: false,
        scrubbedLegacy: false,
        compatMode: false,
      };
    }

    const persistedChannels = buildPersistedChannelsFromLegacyMap(legacyChannels);
    if (persistedChannels.length === 0) {
      const scrubbedLegacy = legacy ? scrubLegacyChannelsBlock(legacy) : false;
      return {
        source: "none",
        migrated: false,
        scrubbedLegacy,
        compatMode: false,
      };
    }

    const nowIso = options?.nowIso?.() ?? new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      persistMigratedChannels(db, persistedChannels, nowIso);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const scrubbedLegacy = legacy ? scrubLegacyChannelsBlock(legacy) : false;
    return {
      source: "migrated_legacy_to_setup_state",
      migrated: true,
      scrubbedLegacy,
      compatMode: false,
    };
  } catch (error) {
    const runtimeFallback = legacyChannels ? buildChannelsFromLegacyMap(legacyChannels) : undefined;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[friday] Failed to migrate legacy channel config into setup_state: ${message}`);
    return {
      channels: runtimeFallback,
      source: runtimeFallback ? "legacy_runtime_fallback" : "none",
      migrated: false,
      scrubbedLegacy: false,
      compatMode: Boolean(runtimeFallback),
    };
  } finally {
    db?.close();
  }
}

interface SetupNetworkStateRow {
  network_host: string | null;
  network_port: number | null;
}

export interface FridayStartupNetworkBinding {
  host: string;
  port: number;
}

function decodeQuotedEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  const hasMatchingQuote = quote === "\"" || quote === "'";
  if (!hasMatchingQuote || trimmed[trimmed.length - 1] !== quote) {
    return trimmed;
  }
  const inner = trimmed.slice(1, -1);
  if (quote === "'") {
    return inner;
  }
  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

export function loadProcessEnvFromDotEnvFile(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  filePath?: string;
}): void {
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  const configured = options?.filePath ?? env.FRIDAY_ENV_FILE;
  const envPath = configured && configured.trim().length > 0
    ? configured.trim()
    : resolveSafePath(cwd, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eqIndex = withoutExport.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = withoutExport.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }
    if (env[key] !== undefined) {
      continue;
    }
    const rawValue = withoutExport.slice(eqIndex + 1);
    env[key] = decodeQuotedEnvValue(rawValue);
  }
}

function normalizePort(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    return undefined;
  }
  return value;
}

function parsePort(raw: string | undefined): number | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const parsed = parseInt(raw, 10);
  return normalizePort(parsed);
}

function parseHost(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const host = raw.trim();
  return host.length > 0 ? host : undefined;
}

export function readSetupNetworkBinding(dbPath: string): FridayStartupNetworkBinding | undefined {
  if (!existsSync(dbPath)) return undefined;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const hasTable = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'friday_setup_state'`,
      )
      .get() as { name?: string } | undefined;
    if (!hasTable?.name) return undefined;

    const row = db
      .prepare(
        `SELECT network_host, network_port
         FROM friday_setup_state
         WHERE id = 'singleton'`,
      )
      .get() as SetupNetworkStateRow | undefined;
    if (!row) return undefined;

    const host = parseHost(row.network_host ?? undefined);
    const port = normalizePort(row.network_port ?? undefined);
    if (!host || !port) return undefined;

    return { host, port };
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export function resolveStartupNetworkBinding(
  parsed: ParsedArgs,
  options?: {
    env?: NodeJS.ProcessEnv;
    dbPath?: string;
    readSetupBinding?: (dbPath: string) => FridayStartupNetworkBinding | undefined;
  },
): FridayStartupNetworkBinding {
  const env = options?.env ?? process.env;
  const cliHost = parseHost(parsed.host);
  const cliPort = normalizePort(parsed.port);
  const envHost = parseHost(env.FRIDAY_HOST);
  const envPort = parsePort(env.FRIDAY_PORT);

  const explicitHost = cliHost ?? envHost;
  const explicitPort = cliPort ?? envPort;

  const readSetupBinding = options?.readSetupBinding ?? readSetupNetworkBinding;
  const setupDbPath = options?.dbPath ?? resolveFridayDbPath({ env });
  const setupBinding = readSetupBinding(setupDbPath);

  return {
    host: explicitHost ?? setupBinding?.host ?? "127.0.0.1",
    port: explicitPort ?? setupBinding?.port ?? 3141,
  };
}

function buildConfig(parsed: ParsedArgs): FridayHubConfig {
  return {
    skillDirs: parsed.skillDirs,
    port: parsed.port,
  };
}

async function cmdStart(parsed: ParsedArgs): Promise<void> {
  const startupBinding = resolveStartupNetworkBinding(parsed);
  const startupChannels = prepareStartupChannelsConfig();
  if (startupChannels.compatMode && !process.env.FRIDAY_CHANNEL_SECRET_POLICY) {
    process.env.FRIDAY_CHANNEL_SECRET_POLICY = "compat"; // pragma: allowlist secret
  }
  const config: FridayHubConfig = {
    ...buildConfig(parsed),
    host: startupBinding.host,
    port: startupBinding.port,
    channels: startupChannels.channels,
  };
  const resolved = resolveFridayHubConfig(config);
  const hub = await createFridayHub(config);

  await hub.start();

  const status = hub.status();
  console.log(
    `🚀 Friday hub running — ${status.skillCount} skill(s) loaded`,
  );

  // Hand off to the run loop — it starts the HTTP server and handles shutdown signals
  const uiStaticDir = process.env.FRIDAY_UI_DIST_DIR ?? undefined;
  await runFridayCliLoop({
    hub,
    port: resolved.port,
    host: startupBinding.host,
    corsOrigins: resolved.corsOrigins,
    logRequests: resolved.logRequests,
    uiStaticDir,
  });
}

async function cmdList(parsed: ParsedArgs): Promise<void> {
  const config = buildConfig(parsed);
  const hub = await createFridayHub(config);

  await hub.start();

  const skills = hub.skills.list();
  if (skills.length === 0) {
    console.log("No skills found.");
  } else {
    console.log(`Found ${skills.length} skill(s):\n`);
    console.log(
      padEnd("ID", 30) +
        padEnd("NAME", 30) +
        padEnd("KIND", 16) +
        "RUNTIME",
    );
    console.log("-".repeat(86));
    for (const skill of skills) {
      console.log(
        padEnd(skill.manifest.id, 30) +
          padEnd(skill.manifest.name, 30) +
          padEnd(skill.manifest.kind, 16) +
          skill.manifest.runtime.kind,
      );
    }
  }

  await hub.stop();
}

async function cmdRun(parsed: ParsedArgs): Promise<void> {
  if (!parsed.skillId) {
    console.error("Error: missing <skill-id> argument for `friday run`.");
    process.exitCode = 1;
    return;
  }

  const config = buildConfig(parsed);
  const hub = await createFridayHub(config);

  await hub.start();

  const handle = hub.executor.execute({
    skillId: parsed.skillId,
    input: parsed.input,
    sessionId: "cli",
    userId: "cli-user",
    channel: "cli",
  });

  const result = await handle.result;

  console.log(`Run ${result.runId} — ${result.status} (${result.durationMs}ms)`);
  if (result.stdout) {
    console.log("\n--- stdout ---");
    console.log(result.stdout);
  }
  if (result.stderr) {
    console.log("\n--- stderr ---");
    console.log(result.stderr);
  }
  if (Object.keys(result.output).length > 0) {
    console.log("\n--- output ---");
    console.log(JSON.stringify(result.output, null, 2));
  }

  await hub.stop();
}

async function cmdImport(parsed: ParsedArgs): Promise<void> {
  if (!parsed.source) {
    console.error("Error: missing <source> argument for `friday import`.");
    process.exitCode = 1;
    return;
  }

  console.log(`📦 Importing skill from: ${parsed.source}`);
  console.log(`   Format hint: ${parsed.from ?? "auto"}`);
  console.log(`   Target: ${parsed.target ?? "managed"}`);
  if (parsed.replace) console.log("   Replace: yes");
  if (parsed.dryRun) console.log("   Dry run: yes");
  if (parsed.noRefresh) console.log("   Refresh: no");

  const config = buildConfig(parsed);
  const hub = await createFridayHub(config);
  await hub.start();

  try {
    // Resolve target
    let target: "managed" | "workspace" | { path: string } = "managed";
    if (parsed.target === "managed" || parsed.target === "workspace") {
      target = parsed.target;
    } else if (parsed.target) {
      target = { path: parsed.target };
    }

    const result = await hub.converterService.import({
      source: { uri: parsed.source },
      formatHint: (parsed.from as "auto" | undefined) ?? "auto",
      target,
      replace: parsed.replace,
      refreshRegistry: !parsed.noRefresh,
      dryRun: parsed.dryRun,
      options: {
        ...(parsed.splitOperations !== undefined ? { splitOperations: parsed.splitOperations } : {}),
        ...(parsed.skillIdPrefix ? { skillIdPrefix: parsed.skillIdPrefix } : {}),
      },
    });

    console.log(`\n✅ Import complete — converter: ${result.converterId}, format: ${result.detectedFormat}`);
    for (const imp of result.imports) {
      const status = imp.installed ? "✅ installed" : "❌ not installed";
      console.log(`   ${imp.skillId}: ${status} → ${imp.skillDir || "(none)"}`);
      for (const issue of imp.issues) {
        console.log(`      ${issue.severity}: ${issue.message}`);
      }
    }
    if (result.registryRefreshed) {
      console.log("   Registry refreshed.");
    }
  } finally {
    await hub.stop();
  }
}

async function cmdConvert(parsed: ParsedArgs): Promise<void> {
  if (!parsed.source) {
    console.error("Error: missing <source> argument for `friday convert`.");
    process.exitCode = 1;
    return;
  }

  if (!parsed.out) {
    console.error("Error: --out <dir> is required for `friday convert`.");
    process.exitCode = 1;
    return;
  }

  console.log(`🔄 Converting skill from: ${parsed.source}`);
  console.log(`   Output: ${parsed.out}`);
  console.log(`   Format hint: ${parsed.from ?? "auto"}`);

  const config = buildConfig(parsed);
  const hub = await createFridayHub(config);
  await hub.start();

  try {
    const result = await hub.converterService.convert({
      source: { uri: parsed.source },
      formatHint: (parsed.from as "auto" | undefined) ?? "auto",
      dryRun: parsed.dryRun,
      options: {
        ...(parsed.splitOperations !== undefined ? { splitOperations: parsed.splitOperations } : {}),
        ...(parsed.skillIdPrefix ? { skillIdPrefix: parsed.skillIdPrefix } : {}),
      },
    });

    console.log(`\n✅ Conversion complete — converter: ${result.converterId}, format: ${result.detectedFormat}`);
    console.log(`   ${result.drafts.length} draft(s) generated.`);

    // Write drafts to output directory
    const outDir = parsed.out;
    for (const draft of result.drafts) {
      const draftDir = resolveSafePath(outDir, draft.manifest.id);
      mkdirSync(draftDir, { recursive: true });
      for (const file of draft.files) {
        const filePath = resolveSafePath(draftDir, file.path);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.content, "utf-8");
      }
      console.log(`   📁 ${draft.manifest.id} → ${draftDir}`);
    }

    // Print validation results
    for (const v of result.validation) {
      const status = v.ok ? "✅" : "⚠️";
      console.log(`   ${status} ${v.skillId}: ${v.issues.length} issue(s)`);
      for (const issue of v.issues) {
        console.log(`      ${issue.severity}: ${issue.message}`);
      }
    }
  } finally {
    await hub.stop();
  }
}

async function cmdConverters(parsed: ParsedArgs): Promise<void> {
  const config = buildConfig(parsed);
  const hub = await createFridayHub(config);
  await hub.start();

  try {
    const converters = hub.converterService.listConverters();
    console.log("📋 Skill Converters:");
    console.log("");
    console.log(padEnd("ID", 30) + padEnd("NAME", 35) + "FORMATS");
    console.log("-".repeat(85));

    for (const c of converters) {
      console.log(
        padEnd(c.id, 30) + padEnd(c.displayName, 35) + c.sourceFormats.join(", "),
      );
    }
  } finally {
    await hub.stop();
  }
}

async function cmdPack(parsed: ParsedArgs): Promise<void> {
  if (!parsed.skillDir) {
    console.error("Error: missing <skill-dir> argument for `friday pack`.");
    process.exitCode = 1;
    return;
  }

  if (!parsed.out) {
    console.error("Error: --out <file.tgz> is required for `friday pack`.");
    process.exitCode = 1;
    return;
  }

  console.log(`📦 Packing skill from: ${parsed.skillDir}`);
  console.log(`   Output: ${parsed.out}`);

  const config = buildConfig(parsed);
  const hub = await createFridayHub(config);
  await hub.start();

  try {
    const result = await hub.converterService.pack({
      skillDir: parsed.skillDir,
      outputFile: parsed.out,
    });

    console.log(`\n✅ Pack complete`);
    console.log(`   Package: ${result.packageFile}`);
    console.log(`   SHA-256: ${result.checksumSha256}`);
  } finally {
    await hub.stop();
  }
}

async function cmdAuth(parsed: ParsedArgs): Promise<void> {
  if (parsed.authSubcommand !== "login" || parsed.authTarget !== "anthropic") {
    console.error("Usage: friday auth login anthropic [--provider-id <id>] [--code <code#state>] [--no-browser]");
    process.exitCode = 1;
    return;
  }

  const config = buildConfig(parsed);
  const hub = await createFridayHub(config);
  await hub.start();

  try {
    await runFridayCliAuthLoginAnthropic(
      {
        providerId: parsed.providerId,
        code: parsed.code,
        noBrowser: parsed.noBrowser,
      },
      {
        providerService: hub.providerService,
        stdout: (msg: string) => console.log(msg),
        stderr: (msg: string) => console.error(msg),
      },
    );
  } finally {
    await hub.stop();
  }
}

function cmdStatus(): void {
  // v1: No persistent hub process or IPC socket yet.
  // Report CLI version and basic system info.
  const version = FRIDAY_VERSION;
  console.log(`Friday CLI v${version}`);
  console.log(`Node.js ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log("");
  console.log("Hub status: not detectable (no IPC socket in v1)");
  console.log("Start the hub with: friday start");
}

function padEnd(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

export async function finalizeCliCommand(
  command: ParsedArgs["command"],
  exit: (code?: number) => unknown = process.exit,
): Promise<void> {
  if (command === "start") {
    return;
  }

  await new Promise((resolve) => setImmediate(resolve));
  const exitCode =
    typeof process.exitCode === "number"
      ? process.exitCode
      : Number.parseInt(String(process.exitCode ?? 0), 10);
  exit(Number.isFinite(exitCode) ? exitCode : 1);
}

// ─── Main ───

async function main(): Promise<void> {
  loadProcessEnvFromDotEnvFile();
  const parsed = parseArgs(process.argv);

  switch (parsed.command) {
    case "start":
      await cmdStart(parsed);
      break;
    case "list":
      await cmdList(parsed);
      break;
    case "run":
      await cmdRun(parsed);
      break;
    case "status":
      cmdStatus();
      break;
    case "import":
      await cmdImport(parsed);
      break;
    case "convert":
      await cmdConvert(parsed);
      break;
    case "converters":
      await cmdConverters(parsed);
      break;
    case "pack":
      await cmdPack(parsed);
      break;
    case "auth":
      await cmdAuth(parsed);
      break;
    case "help":
    default:
      printUsage();
      break;
  }

  await finalizeCliCommand(parsed.command);
}

export function isCliEntrypointPath(argvPath: string | undefined, moduleUrl: string): boolean {
  if (typeof argvPath !== "string" || argvPath.trim().length === 0) {
    return false;
  }

  const modulePath = fileURLToPath(moduleUrl);

  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return argvPath === modulePath;
  }
}

const isCliEntrypoint = isCliEntrypointPath(process.argv[1], import.meta.url);

if (isCliEntrypoint) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  });
}
