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
 *   friday runs        backfill-pack-context [--dry-run|--apply] [--json]
 *   friday status                                           — show hub status
 *   friday import      <source> [--from <format>]                — preview conversion only
 *   friday convert     <source> --out <dir> [--from <format>]
 *   friday converters                                       — list converters
 *   friday pack        <skill-dir> --out <file.tgz>
 *   friday skills init <skill-id> [--template node|shell] [--out <dir>]
 *   friday daemon      start|stop|restart|status            — manage background daemon
 *   friday tui         [--host <addr>] [--port <n>]         — open the terminal dashboard
 *   friday --help                                           — usage info
 */

// ─── Global error handlers (must be first) ───
process.on("unhandledRejection", (reason) => {
  console.error("[friday][FATAL] Unhandled promise rejection:", reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  console.error("[friday][FATAL] Uncaught exception:", error.stack ?? error.message);
  process.exit(1);
});

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildFridayChannelSecretRef,
  buildFridayChannelSecretRefKey,
  type FridaySupportedChannelKind,
  getFridayChannelSecretFieldDescriptors,
  isFridayEnvSecretRef,
  parseFridayChannelsConfig,
  parseFridayChannelSecretRef,
} from "#channels";
import { FridayDomainError } from "#errors";
import { createFridayHub, resolveFridayHubConfig } from "#hub";
import type { FridayHubConfig } from "#hub";
import {
  createFridaySecretRepository,
  encryptSecret,
  fridaySecretAadContext,
  getProvisionedMasterKey,
} from "#providers";
import {
  redactFridaySkillCandidateSourceUri,
  redactFridaySkillSourceText,
  redactFridaySkillSourceValue,
} from "#skills/converter";
import { parseFridayHttpTrustProxyMode } from "#api";
import { resolveFridayDbPath } from "#state";
import { resolveSafePath, safeJsonParse } from "#utilities";
import Database from "better-sqlite3";
import {
  createFridayLocalDaemonService,
  formatFridayDaemonStatus,
} from "../daemon/friday-daemon-runtime.js";
import {
  createFridayOpenClawPhaseController,
  formatFridayOpenClawDoctorReport,
  formatFridayOpenClawPhaseStates,
} from "../automation/openclaw-adoption/index.js";
import { runFridayCliLoop } from "./friday-cli-run-loop.js";
import { FRIDAY_VERSION } from "../lib/version.js";
import { resolveStateDir } from "../state/paths/friday-state-dir-resolver.js";
import {
  runFridayCliAuthAttachCli,
  runFridayCliAuthConnectAnthropicToken,
  runFridayCliAuthLoginAnthropic,
  runFridayCliAuthStatus,
} from "./friday-cli-auth.js";
import { cmdRuns } from "./friday-cli-runs.js";

const execFileAsync = promisify(execFile);

// ─── Arg parser ───

export interface ParsedArgs {
  command: "start" | "list" | "run" | "runs" | "status" | "help" | "import" | "convert" | "converters" | "pack" | "auth" | "skills" | "daemon" | "phases" | "setup" | "tui";
  showHelp: boolean;
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
  token: string | undefined;
  binaryPath: string | undefined;
  noBrowser: boolean;
  skillsSubcommand: string | undefined;
  template: "node" | "shell" | undefined;
  initSkillId: string | undefined;
  // Daemon-related fields
  daemonSubcommand: "start" | "stop" | "restart" | "status" | undefined;
  phasesSubcommand: "doctor" | "list" | "status" | "start-next" | "run-next" | "promote" | "resume" | "stabilize" | "closeout" | undefined;
  phaseIdArg: string | undefined;
  manifestPath: string | undefined;
  prepareNext: boolean;
  json: boolean;
  apply: boolean;
  runsSubcommand: "backfill-pack-context" | undefined;
}

function isHelpFlag(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

export function parseArgs(argv: string[]): ParsedArgs {
  // Strip node + script path
  const args = argv.slice(2);

  const result: ParsedArgs = {
    command: "help",
    showHelp: false,
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
    token: undefined,
    binaryPath: undefined,
    noBrowser: false,
    skillsSubcommand: undefined,
    template: undefined,
    initSkillId: undefined,
    daemonSubcommand: undefined,
    phasesSubcommand: undefined,
    phaseIdArg: undefined,
    manifestPath: undefined,
    prepareNext: true,
    json: false,
    apply: false,
    runsSubcommand: undefined,
  };

  if (args.length === 0) {
    return result;
  }

  const cmd = args[0]!;
  if (isHelpFlag(cmd)) {
    result.command = "help";
    result.showHelp = true;
    return result;
  }

  const validCommands = ["start", "list", "run", "runs", "status", "import", "convert", "converters", "pack", "auth", "skills", "daemon", "phases", "setup", "tui"] as const;
  type ValidCommand = (typeof validCommands)[number];

  if ((validCommands as readonly string[]).includes(cmd)) {
    result.command = cmd as ValidCommand;
  } else {
    result.command = "help";
    return result;
  }

  result.showHelp = args.slice(1).some((arg) => isHelpFlag(arg));

  let i = 1;

  // For "converters" command, no additional args needed
  if (cmd === "converters") {
    return result;
  }

  // For "daemon" command, parse the subcommand
  if (cmd === "daemon") {
    const sub = args[1];
    const validSubs = ["start", "stop", "restart", "status"] as const;
    if (sub && (validSubs as readonly string[]).includes(sub)) {
      result.daemonSubcommand = sub as (typeof validSubs)[number];
    }
    return result;
  }

  if (cmd === "phases") {
    const sub = args[1];
    const validSubs = ["doctor", "list", "status", "start-next", "run-next", "promote", "resume", "stabilize", "closeout"] as const;
    if (sub && (validSubs as readonly string[]).includes(sub)) {
      result.phasesSubcommand = sub as (typeof validSubs)[number];
    }
    if ((sub === "promote" || sub === "stabilize" || sub === "resume") && args[2] && !args[2]!.startsWith("--")) {
      result.phaseIdArg = args[2]!;
      i = 3;
    } else {
      i = 2;
    }
  }

  if (cmd === "runs") {
    const sub = args[1];
    const validSubs = ["backfill-pack-context"] as const;
    if (sub && (validSubs as readonly string[]).includes(sub)) {
      result.runsSubcommand = sub as (typeof validSubs)[number];
    }
    i = 2;
  }

  while (i < args.length) {
    const arg = args[i]!;

    if (arg === "--skills-dir" && i + 1 < args.length) {
      result.skillDirs.push(args[i + 1]!);
      i += 2;
      continue;
    }

    if (arg === "--port" && i + 1 < args.length) {
      const parsed = parsePort(args[i + 1]!);
      if (parsed !== undefined) {
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

    if (arg === "--apply") {
      result.apply = true;
      i += 1;
      continue;
    }

    if (arg === "--manifest" && i + 1 < args.length) {
      result.manifestPath = args[i + 1]!;
      i += 2;
      continue;
    }

    if (arg === "--json") {
      result.json = true;
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

    if (arg === "--token" && i + 1 < args.length) {
      result.token = args[i + 1]!;
      i += 2;
      continue;
    }

    if (arg === "--binary-path" && i + 1 < args.length) {
      result.binaryPath = args[i + 1]!;
      i += 2;
      continue;
    }

    if (arg === "--no-browser") {
      result.noBrowser = true;
      i += 1;
      continue;
    }

    if (arg === "--prepare-next") {
      result.prepareNext = true;
      i += 1;
      continue;
    }

    if (arg === "--no-prepare-next") {
      result.prepareNext = false;
      i += 1;
      continue;
    }

    if (arg === "--template" && i + 1 < args.length) {
      const template = args[i + 1]!;
      result.template = template === "shell" ? "shell" : template === "node" ? "node" : undefined;
      i += 2;
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

    if (result.command === "skills" && !arg.startsWith("--")) {
      if (result.skillsSubcommand === undefined) {
        result.skillsSubcommand = arg;
        i += 1;
        continue;
      }
      if (result.initSkillId === undefined) {
        result.initSkillId = arg;
        i += 1;
        continue;
      }
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

function printUsage(parsed?: ParsedArgs): void {
  const command = parsed?.command;

  if (command === "start") {
    console.log(`
friday start [--skills-dir <path>] [--port <n>] [--host <addr>]

Boot the hub, load skills, and keep the process running.
Default host: 127.0.0.1 (loopback only). Use --host 0.0.0.0 for network access.
    `.trim());
    return;
  }

  if (command === "list") {
    console.log(`
friday list [--skills-dir <path>]

Load skills and print them in a table, then exit.
    `.trim());
    return;
  }

  if (command === "run") {
    console.log(`
friday run <skill-id> [--input key=value ...] [--skills-dir <path>]

Boot the hub, run a single skill, print result, then exit.
    `.trim());
    return;
  }

  if (command === "runs") {
    console.log(`
friday runs backfill-pack-context [--dry-run|--apply] [--json]

Backfill historical packContext metadata onto agent runs using strict session evidence.
    `.trim());
    return;
  }

  if (command === "setup") {
    console.log(`
friday setup

Interactive setup wizard — walks you through configuring:
  1. LLM provider (Anthropic / DeepSeek / OpenAI / Ollama)
  2. API key (or skip for Ollama)
  3. Message channels (optional)

Writes config to ~/.friday/friday.json5 and optionally starts the hub.
    `.trim());
    return;
  }

  if (command === "status") {
    console.log(`
friday status

Show daemon/runtime status summary for the current state directory.
    `.trim());
    return;
  }

  if (command === "import") {
    console.log(`
friday import <source> [--from <format>] [--target <path>] [--replace] [--dry-run] [--no-refresh]

Preview conversion only. Candidate staging now requires canonical approval through the lifecycle surface.
    `.trim());
    return;
  }

  if (command === "convert") {
    console.log(`
friday convert <source> --out <dir> [--from <format>] [--split-operations] [--skill-id-prefix <prefix>]

Convert a skill source to Friday package(s) without installing.
    `.trim());
    return;
  }

  if (command === "converters") {
    console.log(`
friday converters

List installed converters and supported source formats.
    `.trim());
    return;
  }

  if (command === "pack") {
    console.log(`
friday pack <skill-dir> --out <file.tgz>

Package a native Friday skill directory into a .friday.tgz archive.
    `.trim());
    return;
  }

  if (command === "skills") {
    console.log(`
friday skills init <skill-id> [--template node|shell] [--out <dir>]

Create a minimal local skill template with manifest, entrypoint, and SKILL.md.
    `.trim());
    return;
  }

  if (command === "auth") {
    console.log(`
friday auth login anthropic [legacy disabled; use setup-token or API-key provider]
friday auth setup-token anthropic [--provider-id <id>] [--token <token>]
friday auth paste-token anthropic [--provider-id <id>] [--token <token>]
friday auth attach-cli codex --provider-id <id> [--binary-path <path>]
friday auth status [--provider-id <id>]

Authenticate providers through supported OAuth, setup-token, or CLI-managed external sessions.
    `.trim());
    return;
  }

  if (command === "daemon") {
    console.log(`
friday daemon start|stop|restart|status

Manage the Friday background daemon process.
    `.trim());
    return;
  }

  if (command === "phases") {
    console.log(`
friday phases doctor|list|status|start-next|run-next|promote|resume|stabilize <phase-id>|closeout [--manifest <path>] [--dry-run] [--json]

Inspect and drive the OpenClaw adoption phase controller.
    `.trim());
    return;
  }

  if (command === "tui") {
    console.log(`
friday tui [--host <addr>] [--port <n>]

Open the terminal dashboard against the current Friday API binding.
    `.trim());
    return;
  }

  console.log(`
friday — Friday AI automation CLI

This is a developer/build/tooling CLI, not a consumer install. \`npm install\`
gives you this dev/tooling runtime, not the full Friday product (no signed
native app, managed native Hub lifecycle, native mobile, formal updates, or
Endbar release guarantees). The native Friday.app is the consumer release
vehicle, and it is not yet publicly released.

Usage:
  friday start  [--skills-dir <path>] [--port <n>] [--host <addr>]
      Boot the hub, load skills, and keep the process running.
      Default host: 127.0.0.1 (loopback only). Use --host 0.0.0.0 for network access.

  friday list   [--skills-dir <path>]
      Load skills and print them in a table, then exit.

  friday run <skill-id> [--input key=value ...] [--skills-dir <path>]
      Boot the hub, run a single skill, print result, then exit.

  friday runs backfill-pack-context [--dry-run|--apply] [--json]
      Backfill historical packContext metadata onto agent runs using strict session evidence.

  friday status
      Show hub status (running / stopped).

  friday import <source> [--from <format>] [--target <path>] [--replace] [--dry-run] [--no-refresh]
      Preview conversion only. Candidate staging now requires canonical approval through the lifecycle surface.

  friday convert <source> --out <dir> [--from <format>] [--split-operations] [--skill-id-prefix <prefix>]
      Convert a skill source to Friday package(s) without installing.

  friday converters
      List installed converters and supported source formats.

  friday pack <skill-dir> --out <file.tgz>
      Package a native Friday skill directory into a .friday.tgz archive.

  friday skills init <skill-id> [--template node|shell] [--out <dir>]
      Create a minimal local skill template with manifest, entrypoint, and SKILL.md.

  friday daemon start|stop|restart|status
      Manage the Friday background daemon process.

  friday tui [--host <addr>] [--port <n>]
      Open the terminal dashboard against the current Friday API binding.

  friday phases doctor|list|status|start-next|run-next|promote|resume|stabilize <phase-id>|closeout
      Inspect and drive the OpenClaw adoption phase controller.

  friday setup
      Interactive setup wizard — configure LLM provider, API keys, and channels.

  friday --help
      Show this help message.

Options:
  --skills-dir <path>   Directory to discover skills from (repeatable).
  --port <n>            Port for the API + UI server.
  --host <addr>         Bind address (default: 127.0.0.1). Use 0.0.0.0 for network access.
  --input key=value     Input parameter for skill execution (repeatable).
  --from <format>       Source format hint (auto, clawdbot-skill-md, n8n-node, openai-gpt-action, code-repo, undocumented-api, friday-package).
  --target <path>       Retired for \`friday import\`; direct install targets require lifecycle promotion.
  --out <path>          Output directory or file path.
  --template <kind>     Template runtime for \`friday skills init\` (node or shell).
  --manifest <path>     Custom phase manifest path for \`friday phases\`.
  --json                Emit machine-readable JSON for supported phase/status commands.
  --replace             Retired for \`friday import\`; replacement happens through shadow/canary promotion.
  --dry-run             Preview conversion; \`friday import\` is always draft-only.
  --apply               Apply a one-time maintenance command instead of previewing it.
  --prepare-next        After a successful promotion, mark the next phase as implementing.
  --no-prepare-next     Do not auto-unlock the next phase after promotion.
  --split-operations    Create one skill per OpenAPI operation (default).
  --no-split-operations Combine all OpenAPI operations into one skill.
  --skill-id-prefix <s> Prefix for generated skill IDs.
  --no-refresh          Retired for \`friday import\`; registry refresh only follows lifecycle promotion.
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
      // P2-05: Basic format validation — accept secret refs ($ENV, secret://) and validate raw tokens.
      if (!token.startsWith("secret://") && !token.startsWith("$") && (token.length < 50 || !/^[A-Za-z0-9._\-]+$/.test(token))) {
        warnLegacyChannelSkip(kind, "token format appears invalid (expected 50+ chars or secret:// / $ENV reference)");
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
      if (asNonEmptyString(raw.verificationToken)) instance.verificationToken = asNonEmptyString(raw.verificationToken);
      if (asNonEmptyString(raw.encryptKey)) instance.encryptKey = asNonEmptyString(raw.encryptKey);
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
  const parsed = safeJsonParse(row.channels_json) as unknown;
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
    const masterKey = getProvisionedMasterKey();
    for (const write of secretWrites) {
      const secretId = `channel-secret:${write.refKey}`; // pragma: allowlist secret
      const envelope = encryptSecret(
        write.plaintext,
        masterKey,
        fridaySecretAadContext({ scope: "channel", id: secretId }),
      );
      channelSecretRepository.upsert(db, {
        id: secretId,
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
  const hasExplicitEnvFile = configured !== undefined && configured.trim().length > 0;
  const primaryEnvPath = configured && configured.trim().length > 0
    ? configured.trim()
    : resolveSafePath(cwd, ".env");

  const envPaths = [primaryEnvPath];
  if (!hasExplicitEnvFile && (env === process.env || env.FRIDAY_STATE_DIR)) {
    const setupEnvPath = join(resolveStateDir({ env }), ".env");
    if (!envPaths.includes(setupEnvPath)) {
      envPaths.push(setupEnvPath);
    }
  }

  for (const envPath of envPaths) {
    loadProcessEnvFromSingleDotEnvFile(envPath, env);
  }
}

function loadProcessEnvFromSingleDotEnvFile(envPath: string, env: NodeJS.ProcessEnv): void {
  if (!existsSync(envPath)) {
    return;
  }

  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
  } catch (err) {
    console.warn("[friday][cli] .env file read failed:", err instanceof Error ? err.message : String(err));
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
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
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
  } catch (err) {
    console.warn("[friday][cli] daemon address lookup failed:", err instanceof Error ? err.message : String(err));
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

function buildHttpBaseUrl(binding: FridayStartupNetworkBinding): string {
  const hostname = binding.host.includes(":") && !binding.host.startsWith("[")
    ? `[${binding.host}]`
    : binding.host;
  return `http://${hostname}:${binding.port}`;
}

function resolveFridayTuiBaseUrl(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FRIDAY_TUI_BASE_URL?.trim();
  if (configured) {
    return configured;
  }
  return buildHttpBaseUrl(resolveStartupNetworkBinding(parsed, { env }));
}

function buildConfig(parsed: ParsedArgs): FridayHubConfig {
  return {
    skillDirs: parsed.skillDirs,
    port: parsed.port,
  };
}

interface FridayCliSkillRunResult {
  runId: string;
  status: string;
  durationMs: number;
  output: Record<string, unknown>;
  stdout?: string;
  stderr?: string;
}

type FridayCliExecFile = (
  file: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
  },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export interface FridayCliRunCommandDeps {
  createHub?: typeof createFridayHub;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<typeof console, "log" | "error">;
  setExitCode?: (code: number) => void;
  execFileFn?: FridayCliExecFile;
}

function printCliSkillRunResult(
  logger: Pick<typeof console, "log" | "error">,
  result: FridayCliSkillRunResult,
): void {
  logger.log(`Run ${result.runId} — ${result.status} (${result.durationMs}ms)`);
  if (result.stdout) {
    logger.log("\n--- stdout ---");
    logger.log(result.stdout);
  }
  if (result.stderr) {
    logger.log("\n--- stderr ---");
    logger.log(result.stderr);
  }
  if (Object.keys(result.output).length > 0) {
    logger.log("\n--- output ---");
    logger.log(JSON.stringify(result.output, null, 2));
  }
}

function isCliSkillRunSuccessful(result: FridayCliSkillRunResult): boolean {
  return result.status === "completed" || result.status === "skill_executed_not_completed";
}

function markCliSkillRunFailure(
  logger: Pick<typeof console, "log" | "error">,
  result: FridayCliSkillRunResult,
  setExitCode: (code: number) => void,
): void {
  if (isCliSkillRunSuccessful(result)) {
    return;
  }

  logger.error(`Error: skill run ${result.runId} ended with status "${result.status}".`);
  setExitCode(1);
}

async function runCliSkillRemotely(params: {
  parsed: ParsedArgs;
  baseUrl: string;
  accessToken: string;
  fetchFn: typeof fetch;
}): Promise<FridayCliSkillRunResult> {
  const response = await params.fetchFn(
    `${params.baseUrl.replace(/\/+$/, "")}/v1/skills/${encodeURIComponent(params.parsed.skillId ?? "")}/run`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: params.parsed.input,
        sessionId: "cli",
        channel: "cli",
      }),
    },
  );

  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    data?: Partial<FridayCliSkillRunResult> | null;
    error?: { code?: string; message?: string } | null;
  } | null;

  if (
    !response.ok
    || body?.ok !== true
    || !body.data
    || typeof body.data.runId !== "string"
    || typeof body.data.status !== "string"
  ) {
    const message = typeof body?.error?.message === "string"
      ? body.error.message
      : `HTTP ${response.status}: ${response.statusText}`;
    throw new Error(message);
  }

  return {
    runId: body.data.runId,
    status: body.data.status,
    durationMs: typeof body.data.durationMs === "number" ? body.data.durationMs : 0,
    output: body.data.output && typeof body.data.output === "object"
      ? body.data.output as Record<string, unknown>
      : {},
    stdout: typeof body.data.stdout === "string" ? body.data.stdout : undefined,
    stderr: typeof body.data.stderr === "string" ? body.data.stderr : undefined,
  };
}

function isCliRustSkillRunRouteEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.FRIDAY_ROUTE_SKILL_RUNS_VIA_RUST?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function throwRustSkillRunRouteUnavailable(message: string): never {
  throw new FridayDomainError(
    "TS_RUNTIME_SKILL_RUNS_RUST_ROUTE_UNAVAILABLE",
    message,
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_skill_run_entrypoint_required",
      },
    },
  );
}

function requireCliRustSkillRunEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throwRustSkillRunRouteUnavailable(
      `Rust skill-run route is enabled but ${name} is not configured.`,
    );
  }
  return value;
}

function splitCliRustSkillRunList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveCliRustManagedSkillsRoot(parsed: ParsedArgs, env: NodeJS.ProcessEnv): string {
  const configured = env.FRIDAY_D21_MANAGED_SKILLS_ROOT?.trim();
  if (configured) {
    return configured;
  }
  const firstSkillDir = parsed.skillDirs[0]?.trim();
  if (firstSkillDir) {
    return firstSkillDir;
  }
  throwRustSkillRunRouteUnavailable(
    "Rust skill-run route is enabled but no managed skills root is configured.",
  );
}

function parseCliRustSkillRunJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throwRustSkillRunRouteUnavailable("Rust skill-run route returned empty stdout.");
  }
  const parsed = safeJsonParse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throwRustSkillRunRouteUnavailable("Rust skill-run route returned invalid JSON.");
  }
  return parsed as Record<string, unknown>;
}

function cliRustSkillRunString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cliRustSkillRunNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function runCliSkillViaRust(params: {
  parsed: ParsedArgs;
  env: NodeJS.ProcessEnv;
  execFileFn: FridayCliExecFile;
}): Promise<FridayCliSkillRunResult> {
  const skillId = params.parsed.skillId;
  if (!skillId) {
    throwRustSkillRunRouteUnavailable("Rust skill-run route is enabled but skillId is missing.");
  }

  const env = params.env;
  const bin = requireCliRustSkillRunEnv(env, "FRIDAY_D21_SKILL_RUN_LOCAL_BIN");
  const dbPath = requireCliRustSkillRunEnv(env, "FRIDAY_D21_SKILL_RUN_LOCAL_DB_PATH");
  const operatorVkPath = requireCliRustSkillRunEnv(env, "FRIDAY_D21_OPERATOR_VK_PATH");
  const approvalJson = requireCliRustSkillRunEnv(env, "FRIDAY_D21_SKILL_RUN_APPROVAL_JSON");
  const missionId = requireCliRustSkillRunEnv(env, "FRIDAY_D21_SKILL_RUN_MISSION_ID");
  const workItemId = requireCliRustSkillRunEnv(env, "FRIDAY_D21_SKILL_RUN_WORK_ITEM_ID");
  const operatorPrincipalId = requireCliRustSkillRunEnv(
    env,
    "FRIDAY_D21_SKILL_RUN_OPERATOR_PRINCIPAL_ID",
  );
  const managedSkillsRoot = resolveCliRustManagedSkillsRoot(params.parsed, env);
  const timeoutMsRaw = env.FRIDAY_D21_SKILL_RUN_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutMsRaw ? Number.parseInt(timeoutMsRaw, 10) : 30_000;
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;

  const args = [
    "run-local",
    "--db",
    dbPath,
    "--operator-vk-path",
    operatorVkPath,
    "--approval-json",
    approvalJson,
    "--managed-skills-root",
    managedSkillsRoot,
    "--skill-id",
    skillId,
    "--mission-id",
    missionId,
    "--work-item-id",
    workItemId,
    "--operator-principal-id",
    operatorPrincipalId,
    "--timeout-ms",
    String(effectiveTimeoutMs),
  ];

  const nowMs = env.FRIDAY_D21_SKILL_RUN_NOW_MS?.trim();
  if (nowMs) {
    args.push("--now-ms", nowMs);
  }

  const adoptedSkillIds = splitCliRustSkillRunList(env.FRIDAY_D21_ADOPTED_SKILL_IDS);
  for (const adoptedSkillId of adoptedSkillIds) {
    args.push("--adopted-skill-id", adoptedSkillId);
  }

  const approvedFirstRunSkillIds = splitCliRustSkillRunList(
    env.FRIDAY_D21_APPROVED_FIRST_RUN_SKILL_IDS,
  );
  const firstRunIds = approvedFirstRunSkillIds.length > 0 ? approvedFirstRunSkillIds : [skillId];
  for (const approvedFirstRunSkillId of firstRunIds) {
    args.push("--approved-first-run-skill-id", approvedFirstRunSkillId);
  }

  if (env.FRIDAY_D21_REQUIRE_DARWIN_SANDBOX?.trim() === "1") {
    args.push("--require-darwin-sandbox");
  }

  let stdout = "";
  let stderr = "";
  try {
    const result = await params.execFileFn(bin, args, {
      env: {
        ...env,
        FRIDAY_D21_SKILL_RUN_LOCAL: "1",
      },
      timeout: effectiveTimeoutMs + 5_000,
      maxBuffer: 1024 * 1024,
    });
    stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
    stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
  } catch (error) {
    const maybeStdout = (error as { stdout?: string | Buffer }).stdout;
    if (typeof maybeStdout === "string" || Buffer.isBuffer(maybeStdout)) {
      stdout = Buffer.isBuffer(maybeStdout) ? maybeStdout.toString("utf8") : maybeStdout;
    }
    const maybeStderr = (error as { stderr?: string | Buffer }).stderr;
    if (typeof maybeStderr === "string" || Buffer.isBuffer(maybeStderr)) {
      stderr = Buffer.isBuffer(maybeStderr) ? maybeStderr.toString("utf8") : maybeStderr;
    }
    if (!stdout.trim()) {
      throwRustSkillRunRouteUnavailable("Rust skill-run route failed before emitting a receipt.");
    }
  }

  const receipt = parseCliRustSkillRunJson(stdout);
  const ok = receipt.ok === true;
  const runId = cliRustSkillRunString(receipt.run_ref)
    ?? cliRustSkillRunString(receipt.proof_ref)
    ?? `rust-skill-run:${skillId}`;
  const status = cliRustSkillRunString(receipt.status)
    ?? (ok ? "skill_executed_not_completed" : cliRustSkillRunString(receipt.error_kind) ?? "failed");

  return {
    runId,
    status,
    durationMs: 0,
    output: {
      truthLabel: cliRustSkillRunString(receipt.truth_label),
      runsSkill: receipt.runs_skill === true,
      executesSkill: receipt.executes_skill === true,
      completesWorkItem: receipt.completes_work_item === true,
      proofRef: cliRustSkillRunString(receipt.proof_ref),
      skillId: cliRustSkillRunString(receipt.skill_id),
      exitCode: cliRustSkillRunNumber(receipt.exit_code),
      outputSha256: cliRustSkillRunString(receipt.output_sha256),
      outputLen: cliRustSkillRunNumber(receipt.output_len),
    },
    stderr: stderr.trim().length > 0 ? stderr : undefined,
  };
}

export async function runCliSkillCommand(
  parsed: ParsedArgs,
  deps: FridayCliRunCommandDeps = {},
): Promise<void> {
  const logger = deps.logger ?? console;
  const env = deps.env ?? process.env;
  const setExitCode = deps.setExitCode ?? ((code: number) => {
    process.exitCode = code;
  });

  if (!parsed.skillId) {
    logger.error("Error: missing <skill-id> argument for `friday run`.");
    setExitCode(1);
    return;
  }

  const remoteHubUrl = env.FRIDAY_HUB_URL?.trim();
  const remoteAccessToken = env.FRIDAY_ACCESS_TOKEN?.trim();
  if (remoteHubUrl || remoteAccessToken) {
    if (!remoteHubUrl || !remoteAccessToken) {
      logger.error(
        "Error: `friday run` requires both FRIDAY_HUB_URL and FRIDAY_ACCESS_TOKEN to use a remote hub.",
      );
      setExitCode(1);
      return;
    }

    const result = await runCliSkillRemotely({
      parsed,
      baseUrl: remoteHubUrl,
      accessToken: remoteAccessToken,
      fetchFn: deps.fetchFn ?? fetch,
    });
    printCliSkillRunResult(logger, result);
    markCliSkillRunFailure(logger, result, setExitCode);
    return;
  }

  const config = buildConfig(parsed);

  if (
    parsed.skillId !== "ai-inference"
    && isCliRustSkillRunRouteEnabled(env)
  ) {
    const result = await runCliSkillViaRust({
      parsed,
      env,
      execFileFn: deps.execFileFn ?? execFileAsync,
    });
    printCliSkillRunResult(logger, result);
    markCliSkillRunFailure(logger, result, setExitCode);
    return;
  }

  // ─── TS Runtime Retirement — local-mode skill-run fail-closed guard ───
  // The REMOTE branch above already returned via the route-guarded HTTP surface.
  // This LOCAL-hub branch boots an in-process hub and reaches the shared
  // `hub.executor.execute` arbitrary-code sink (shell/python) DIRECTLY with a
  // caller-supplied skillId, bypassing the route guard. Mirror the SAME
  // per-caller guard the agent skill_run tool (friday-agent-skill-tool.ts) and
  // workflow invokeSkillForWorkflow (friday-hub-bootstrap.ts) use: fail closed
  // unless the test oracle (or a future Rust-owned entrypoint) opts in via the
  // SAME flag — sourced from config (CLI buildConfig leaves it undefined → OFF →
  // fail closed by default). EXEMPT `ai-inference`: that fixed (non-arbitrary)
  // skillId short-circuits to the provider service inside the executor and
  // returns BEFORE any code sink, so it is the live BYOK path that must stay live.
  if (
    parsed.skillId !== "ai-inference"
    && config.allowTestOnlySkillRunExecution !== true
  ) {
    throw new FridayDomainError(
      "TS_RUNTIME_SKILL_RUNS_RETIRED",
      "Skill run execution is fail-closed while runtime ownership is being moved out of TypeScript.",
      {
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_skill_run_entrypoint_required",
        },
      },
    );
  }

  const hub = await (deps.createHub ?? createFridayHub)(config);

  await hub.start();

  const handle = hub.executor.execute({
    skillId: parsed.skillId,
    input: parsed.input,
    sessionId: "cli",
    userId: "cli-user",
    channel: "cli",
  });

  const result = await handle.result;
  printCliSkillRunResult(logger, result);
  markCliSkillRunFailure(logger, result, setExitCode);

  await hub.stop();
}

async function cmdStart(parsed: ParsedArgs): Promise<void> {
  const startupBinding = resolveStartupNetworkBinding(parsed);

  // Early port availability check — fail fast before heavy hub initialization
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const tester = net.createServer();
    tester.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`\n❌ Port ${startupBinding.port} is already in use.`);
        console.error(`  Try: friday start --port ${startupBinding.port + 1}`);
        console.error(`  Or:  lsof -i :${startupBinding.port}  (to find the process using it)\n`);
        process.exit(1);
      }
      reject(err);
    });
    tester.listen(startupBinding.port, startupBinding.host, () => {
      tester.close(() => resolve());
    });
  });

  const startupChannels = prepareStartupChannelsConfig();
  const trustProxyMode = parseFridayHttpTrustProxyMode(process.env.FRIDAY_HTTP_TRUST_PROXY);
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
  // Apply resolved SSRF policy so self-hosted deployments can reach local providers
  if (resolved.ssrfPolicy && !config.ssrfPolicy) {
    config.ssrfPolicy = resolved.ssrfPolicy;
  }
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
    trustProxyMode,
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
  await runCliSkillCommand(parsed);
}

async function cmdImport(parsed: ParsedArgs): Promise<void> {
  if (!parsed.source) {
    console.error("Error: missing <source> argument for `friday import`.");
    process.exitCode = 1;
    return;
  }

  console.log(`📦 Previewing skill source before candidate staging: ${redactFridaySkillCandidateSourceUri(parsed.source)}`);
  console.log(`   Format hint: ${parsed.from ?? "auto"}`);
  console.log("   Candidate staging requires canonical approval; no files will be written.");

  const config = buildConfig(parsed);
  const hub = await createFridayHub(config);
  await hub.start();

  try {
    const result = await convertWithRedactedCliSourceErrors(hub, parsed, true);

    console.log(`\n🔒 Candidate staging blocked — converter: ${result.converterId}, format: ${result.detectedFormat}`);
    console.log("   This CLI entrypoint does not issue canonical approvals in Phase 3.1.");
    console.log("   No candidate was written, installed, promoted, or made available.");
    console.log("   Use the canonical-approved lifecycle route/UI flow to stage this source.");
    for (const draft of result.drafts) {
      const validation = result.validation.find((entry) => entry.skillId === draft.manifest.id);
      const status = validation?.ok ? "validated" : "needs review";
      console.log(`   ${draft.manifest.id}: preview draft ${draft.manifest.version} (${status})`);
    }
    for (const validation of result.validation) {
      for (const issue of validation.issues) {
        console.log(`      ${issue.severity}: ${issue.message}`);
      }
    }
    process.exitCode = 1;
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

  console.log(`🔄 Converting skill from: ${redactFridaySkillCandidateSourceUri(parsed.source)}`);
  console.log(`   Output: ${parsed.out}`);
  console.log(`   Format hint: ${parsed.from ?? "auto"}`);

  const config = buildConfig(parsed);
  const hub = await createFridayHub(config);
  await hub.start();

  try {
    const result = await convertWithRedactedCliSourceErrors(hub, parsed, parsed.dryRun);

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

async function convertWithRedactedCliSourceErrors(
  hub: Awaited<ReturnType<typeof createFridayHub>>,
  parsed: ParsedArgs,
  dryRun: boolean,
) {
  const source = parsed.source ?? "";
  try {
    const result = await hub.converterService.convert({
      source: { uri: source },
      formatHint: (parsed.from as "auto" | undefined) ?? "auto",
      dryRun,
      options: {
        ...(parsed.splitOperations !== undefined ? { splitOperations: parsed.splitOperations } : {}),
        ...(parsed.skillIdPrefix ? { skillIdPrefix: parsed.skillIdPrefix } : {}),
      },
    });
    return redactFridaySkillSourceValue(result, { uri: source }) as typeof result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redactFridaySkillSourceText(message, { uri: source }));
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

function normalizeSkillId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildSkillsInitTemplate(input: {
  skillId: string;
  template: "node" | "shell";
}): Array<{ path: string; content: string; mode?: number }> {
  const displayName = input.skillId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const manifest = {
    schemaVersion: "2.0",
    id: input.skillId,
    name: displayName,
    description: `${displayName} — starter skill template.`,
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: {
      name: "Friday Operator",
    },
    tags: [],
    runtime: {
      kind: input.template,
      entrypoint: input.template === "shell" ? "run.sh" : "index.mjs",
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
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent"],
    },
    requirements: {
      bins: input.template === "shell" ? ["node"] : [],
      env: [],
      config: [],
      os: ["darwin", "linux", "win32"],
    },
    inputs: [
      {
        key: "message",
        type: "string",
        required: false,
        label: "Message",
        help: "Optional input passed into the template skill.",
      },
    ],
    outputs: [
      {
        key: "summary",
        type: "string",
        description: "High-level result from the template skill.",
      },
      {
        key: "details",
        type: "object",
        description: "Structured output from the template skill.",
      },
    ],
    permissions: {
      grants: input.template === "shell"
        ? [
            {
              id: "shell-execute",
              resource: "shell",
              action: "execute",
              required: true,
              reason: "Shell template skills execute run.sh locally.",
            },
          ]
        : [],
      promptOn: input.template === "shell" ? ["shell.execute"] : [],
    },
    schemas: null,
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["desktop", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: {
      events: [],
    },
  };

  const nodeEntrypoint = `export async function execute(input) {\n  const message = typeof input?.message === "string" && input.message.trim().length > 0\n    ? input.message.trim()\n    : "Friday node skill template is ready.";\n\n  return {\n    summary: message,\n    details: {\n      ok: true,\n      runtime: "node",\n      receivedInput: input ?? {},\n    },\n  };\n}\n`;

  const shellEntrypoint = `#!/usr/bin/env sh\nset -eu\n\nINPUT_JSON=\"$(cat)\"\nMESSAGE=$(printf '%s' \"$INPUT_JSON\" | node -e \"const fs=require('fs'); const raw=fs.readFileSync(0,'utf8'); const input=raw ? JSON.parse(raw) : {}; process.stdout.write(typeof input.message === 'string' && input.message.trim() ? input.message.trim() : 'Friday shell skill template is ready.');\")\nprintf '{\"summary\":%s,\"details\":{\"ok\":true,\"runtime\":\"shell\"}}\\n' \"$(printf '%s' \"$MESSAGE\" | node -e \"const fs=require('fs'); process.stdout.write(JSON.stringify(fs.readFileSync(0,'utf8')))\")\"\n`;

  const skillDoc = `# ${displayName}\n\nPurpose: describe what this skill should do.\n\nInputs:\n- \`message\`: optional free-form input for the template.\n\nBehavior:\n- Keep this skill non-destructive by default.\n- Return structured JSON output on success.\n`;

  return [
    {
      path: "skill.manifest.json",
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    {
      path: input.template === "shell" ? "run.sh" : "index.mjs",
      content: input.template === "shell" ? shellEntrypoint : nodeEntrypoint,
      mode: input.template === "shell" ? 0o755 : undefined,
    },
    {
      path: "SKILL.md",
      content: skillDoc,
    },
  ];
}

async function cmdSkills(parsed: ParsedArgs): Promise<void> {
  if (parsed.skillsSubcommand !== "init") {
    console.error("Usage: friday skills init <skill-id> [--template node|shell] [--out <dir>]");
    process.exitCode = 1;
    return;
  }

  if (!parsed.initSkillId) {
    console.error("Error: missing <skill-id> argument for `friday skills init`.");
    process.exitCode = 1;
    return;
  }

  const skillId = normalizeSkillId(parsed.initSkillId);
  if (!skillId) {
    console.error("Error: <skill-id> must contain at least one alphanumeric character.");
    process.exitCode = 1;
    return;
  }

  const template = parsed.template ?? "node";
  const outputDir = parsed.out
    ? (isAbsolute(parsed.out) ? parsed.out : resolveSafePath(process.cwd(), parsed.out))
    : resolveSafePath(process.cwd(), join("managed-skills", skillId));

  if (existsSync(outputDir)) {
    console.error(`Error: output directory already exists: ${outputDir}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(outputDir, { recursive: true });
  for (const file of buildSkillsInitTemplate({ skillId, template })) {
    const absolutePath = join(outputDir, file.path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, file.content, file.mode ? { mode: file.mode } : undefined);
  }

  console.log(`✨ Created ${template} skill template`);
  console.log(`   Skill ID: ${skillId}`);
  console.log(`   Directory: ${outputDir}`);
}

async function cmdAuth(parsed: ParsedArgs): Promise<void> {
  const validAuthCommand =
    (parsed.authTarget === "anthropic"
      && (
        parsed.authSubcommand === "login"
        || parsed.authSubcommand === "setup-token"
        || parsed.authSubcommand === "paste-token"
      ))
    || (parsed.authSubcommand === "attach-cli"
      && (parsed.authTarget === "codex" || parsed.authTarget === "claude"))
    || (parsed.authSubcommand === "status" && parsed.authTarget === undefined);
  if (!validAuthCommand) {
    console.error("Usage: friday auth login anthropic [legacy disabled; use setup-token or API-key provider]");
    console.error("   or: friday auth setup-token anthropic [--provider-id <id>] [--token <token>]");
    console.error("   or: friday auth paste-token anthropic [--provider-id <id>] [--token <token>]");
    console.error("   or: friday auth attach-cli codex --provider-id <id> [--binary-path <path>]");
    console.error("   or: friday auth status [--provider-id <id>]");
    process.exitCode = 1;
    return;
  }

  const config = buildConfig(parsed);
  const hub = await createFridayHub(config);
  await hub.start();

  try {
    const deps = {
      providerService: hub.providerService,
      stdout: (msg: string) => console.log(msg),
      stderr: (msg: string) => console.error(msg),
    };
    if (parsed.authSubcommand === "login") {
      await runFridayCliAuthLoginAnthropic(
        {
          providerId: parsed.providerId,
          code: parsed.code,
          noBrowser: parsed.noBrowser,
        },
        deps,
      );
    } else if (parsed.authSubcommand === "attach-cli") {
      await runFridayCliAuthAttachCli(
        {
          providerId: parsed.providerId,
          binaryPath: parsed.binaryPath,
          authTarget: parsed.authTarget,
        },
        deps,
      );
    } else if (parsed.authSubcommand === "status") {
      await runFridayCliAuthStatus(
        {
          providerId: parsed.providerId,
        },
        deps,
      );
    } else {
      await runFridayCliAuthConnectAnthropicToken(
        {
          providerId: parsed.providerId,
          token: parsed.token,
        },
        deps,
        parsed.authSubcommand as "setup-token" | "paste-token",
      );
    }
  } finally {
    await hub.stop();
  }
}

function cmdPhases(parsed: ParsedArgs): void {
  const sub = parsed.phasesSubcommand;
  if (!sub) {
    console.error("Usage: friday phases doctor|list|status|start-next|run-next|promote|resume|stabilize <phase-id>|closeout [--manifest <path>] [--dry-run] [--json]");
    process.exitCode = 1;
    return;
  }

  const controller = createFridayOpenClawPhaseController({
    cwd: process.cwd(),
    manifestPath: parsed.manifestPath,
  });

  switch (sub) {
    case "doctor": {
      const report = controller.doctor();
      console.log(formatFridayOpenClawDoctorReport(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
      break;
    }
    case "list":
    case "status": {
      if (parsed.json) {
        console.log(JSON.stringify({
          paths: controller.getPaths(),
          state: controller.loadState(),
          phases: controller.listPhaseStates(),
        }, null, 2));
      } else {
        console.log(formatFridayOpenClawPhaseStates(controller.listPhaseStates()));
      }
      break;
    }
    case "start-next": {
      const result = controller.startNextPhase({ dryRun: parsed.dryRun });
      console.log(result.message);
      if (!result.ok) {
        process.exitCode = 1;
      }
      break;
    }
    case "run-next": {
      const result = controller.runNextPhase({
        dryRun: parsed.dryRun,
        prepareNext: parsed.prepareNext,
      });
      if ("run" in result) {
        console.log(`${result.phaseId}: ${result.status} (${result.branchName})`);
        if (!result.ok) {
          process.exitCode = 1;
        }
      } else {
        console.log(result.message);
        if (!result.ok) {
          process.exitCode = 1;
        }
      }
      break;
    }
    case "resume": {
      const result = controller.resumePhase({
        phaseId: parsed.phaseIdArg,
        dryRun: parsed.dryRun,
        prepareNext: parsed.prepareNext,
      });
      if ("run" in result) {
        console.log(`${result.phaseId}: ${result.status} (${result.branchName})`);
      } else {
        console.log(result.message);
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
      break;
    }
    case "promote": {
      if (!parsed.phaseIdArg) {
        console.error("Usage: friday phases promote <phase-id> [--manifest <path>] [--dry-run]");
        process.exitCode = 1;
        return;
      }
      const result = controller.promotePhase({
        phaseId: parsed.phaseIdArg,
        dryRun: parsed.dryRun,
        prepareNext: parsed.prepareNext,
      });
      console.log(`${result.phaseId}: ${result.status} (${result.branchName})`);
      if (!result.ok) {
        process.exitCode = 1;
      }
      break;
    }
    case "stabilize": {
      if (!parsed.phaseIdArg) {
        console.error("Usage: friday phases stabilize <phase-id> [--manifest <path>] [--dry-run]");
        process.exitCode = 1;
        return;
      }
      const result = controller.stabilizePhase({
        phaseId: parsed.phaseIdArg,
        dryRun: parsed.dryRun,
        prepareNext: parsed.prepareNext,
      });
      console.log(`${result.phaseId}: ${result.status} (${result.branchName})`);
      if (!result.ok) {
        process.exitCode = 1;
      }
      break;
    }
    case "closeout": {
      const result = controller.closeout({ dryRun: parsed.dryRun });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`${result.status}: ${result.reportPath}`);
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
      break;
    }
  }
}

function cmdStatus(): void {
  const version = FRIDAY_VERSION;
  const stateDir = resolveStateDir();
  const daemonService = createFridayLocalDaemonService({
    moduleUrl: import.meta.url,
    stateDir,
    version,
  });
  console.log(`Friday CLI v${version}`);
  console.log(`Node.js ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log("");
  console.log(formatFridayDaemonStatus(daemonService.status()));
  console.log(`State dir: ${stateDir}`);
}

// ─── Daemon ───

async function cmdDaemon(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.daemonSubcommand;
  if (!sub) {
    console.error("Usage: friday daemon start|stop|restart|status");
    process.exitCode = 1;
    return;
  }

  const stateDir = resolveStateDir();
  const service = createFridayLocalDaemonService({
    moduleUrl: import.meta.url,
    stateDir,
    version: FRIDAY_VERSION,
  });

  switch (sub) {
    case "start": {
      const result = await service.start();
      if (result.ok) {
        console.log(`Friday daemon started (PID ${String(result.value.pid)})`);
      } else {
        console.error(`Failed to start daemon: ${result.error.message}`);
        process.exitCode = 1;
      }
      break;
    }
    case "stop": {
      const result = await service.stop();
      if (result.ok) {
        console.log("Friday daemon stopped");
      } else {
        console.error(`Failed to stop daemon: ${result.error.message}`);
        process.exitCode = 1;
      }
      break;
    }
    case "restart": {
      const result = await service.restart();
      if (result.ok) {
        console.log(`Friday daemon restarted (PID ${String(result.value.pid)})`);
      } else {
        console.error(`Failed to restart daemon: ${result.error.message}`);
        process.exitCode = 1;
      }
      break;
    }
    case "status": {
      console.log(formatFridayDaemonStatus(service.status()));
      break;
    }
  }
}

function padEnd(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

// ─── Setup Wizard ───

const SETUP_ENV_FILE_MODE = 0o600;

export function tightenFridaySetupEnvFilePermissions(
  envPath: string,
  options?: { platform?: NodeJS.Platform },
): void {
  const platform = options?.platform ?? process.platform;
  if (platform === "win32" || !existsSync(envPath)) {
    return;
  }
  chmodSync(envPath, SETUP_ENV_FILE_MODE);
}

export function writeFridaySetupEnvFile(envPath: string, envLines: string[]): void {
  if (envLines.length === 0) {
    return;
  }
  tightenFridaySetupEnvFilePermissions(envPath);
  writeFileSync(envPath, envLines.join("\n") + "\n", { mode: SETUP_ENV_FILE_MODE });
  tightenFridaySetupEnvFilePermissions(envPath);
}

export async function cmdSetup(): Promise<void> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, (answer: string) => resolve(answer.trim())));

  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║         Friday Setup Wizard                      ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("");

  // Step 1: LLM Provider — present providers as explicit peer choices (no
  // steering by omission). DeepSeek is a first-class option.
  console.log("Step 1: Choose your LLM provider");
  console.log("  [1] Anthropic (Claude)");
  console.log("  [2] DeepSeek");
  console.log("  [3] OpenAI (GPT)");
  console.log("  [4] Ollama (local, free, no API key needed)");
  console.log("");
  const providerChoice = await ask("Enter choice [1/2/3/4]: ");

  let providerId: string;
  let apiKey = "";
  let baseUrl = "";

  switch (providerChoice) {
    case "2":
      providerId = "deepseek";
      console.log("");
      apiKey = await ask("Enter your DeepSeek API key: ");
      if (!apiKey) {
        console.error("API key is required for DeepSeek.");
        rl.close();
        process.exitCode = 1;
        return;
      }
      break;
    case "3":
      providerId = "openai";
      console.log("");
      apiKey = await ask("Enter your OpenAI API key: ");
      if (!apiKey) {
        console.error("API key is required for OpenAI.");
        rl.close();
        process.exitCode = 1;
        return;
      }
      break;
    case "4":
      providerId = "ollama";
      baseUrl = await ask("Ollama URL [http://localhost:11434]: ") || "http://localhost:11434";
      console.log("No API key needed for Ollama.");
      break;
    default:
      providerId = "anthropic";
      console.log("");
      apiKey = await ask("Enter your Anthropic API key: ");
      if (!apiKey) {
        console.error("API key is required for Anthropic.");
        rl.close();
        process.exitCode = 1;
        return;
      }
      break;
  }

  // Step 2: Write .env
  const stateDir = resolveStateDir({ env: process.env });
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  const envPath = join(stateDir, ".env");
  const envLines: string[] = [];

  if (apiKey) {
    const envVarName = providerId === "openai"
      ? "OPENAI_API_KEY"
      : providerId === "deepseek"
        ? "DEEPSEEK_API_KEY"
        : "FRIDAY_ANTHROPIC_API_KEY";
    envLines.push(`${envVarName}=${apiKey}`);
  }
  if (baseUrl) {
    envLines.push(`OLLAMA_BASE_URL=${baseUrl}`);
  }
  // Persist the user's explicit provider choice as routing intent so bootstrap
  // routes to it as the default even when other provider keys are present in
  // the environment (an explicit choice, never an auto-guess).
  envLines.push(`FRIDAY_SETUP_DEFAULT_PROVIDER=${providerId}`);

  if (envLines.length > 0) {
    writeFridaySetupEnvFile(envPath, envLines);
    loadProcessEnvFromDotEnvFile({ env: process.env });
    console.log(`\nConfiguration saved to ${envPath}`);
  }

  // Step 3: Offer to start
  console.log("");
  const startNow = await ask("Start Friday now? [Y/n]: ");
  rl.close();

  if (startNow.toLowerCase() !== "n") {
    console.log("\nStarting Friday...\n");
    const parsed = parseArgs(["node", "friday", "start"]);
    await cmdStart(parsed);
  } else {
    console.log("\nRun 'friday start' when ready.");
    console.log(`Then open: http://localhost:${process.env.FRIDAY_PORT ?? "3141"}`);
  }
}

export async function finalizeCliCommand(
  command: ParsedArgs["command"],
  exit: (code?: number) => unknown = process.exit,
): Promise<void> {
  if (command === "start" || command === "setup") {
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

  if (parsed.showHelp) {
    printUsage(parsed.command === "help" ? undefined : parsed);
    await finalizeCliCommand(parsed.command);
    return;
  }

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
    case "runs":
      await cmdRuns(parsed);
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
    case "skills":
      await cmdSkills(parsed);
      break;
    case "daemon":
      await cmdDaemon(parsed);
      break;
    case "phases":
      cmdPhases(parsed);
      break;
    case "setup":
      await cmdSetup();
      break;
    case "tui": {
      const { runFridayCliTui } = await import("./friday-cli-tui.js");
      await runFridayCliTui({
        apiBaseUrl: resolveFridayTuiBaseUrl(parsed),
      });
      break;
    }
    case "help":
    default:
      printUsage(parsed.command === "help" ? undefined : parsed);
      break;
  }

  await finalizeCliCommand(parsed.command);
}

function normalizeCliEntrypointPath(candidatePath: string): string {
  const normalized = normalize(candidatePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveCliEntrypointModulePath(moduleUrl: string): string | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(moduleUrl);
  } catch (err) {
    console.warn("[friday][cli] entrypoint module URL is invalid:", err instanceof Error ? err.message : String(err));
    return null;
  }

  if (parsedUrl.protocol !== "file:") {
    return null;
  }

  try {
    return fileURLToPath(parsedUrl);
  } catch (err) {
    const pathname = parsedUrl.pathname ? decodeURIComponent(parsedUrl.pathname) : "";
    if (!pathname) {
      console.warn("[friday][cli] entrypoint module URL path resolution failed:", err instanceof Error ? err.message : String(err));
      return null;
    }

    const fallbackPath = process.platform === "win32"
      ? pathname.replace(/^\/([A-Za-z]:)(\/|$)/, "$1$2").replace(/\//g, "\\")
      : pathname;
    console.warn("[friday][cli] entrypoint module URL path resolution fell back:", err instanceof Error ? err.message : String(err));
    return normalize(fallbackPath);
  }
}

export function isCliEntrypointPath(argvPath: string | undefined, moduleUrl: string): boolean {
  if (typeof argvPath !== "string" || argvPath.trim().length === 0) {
    return false;
  }

  const modulePath = resolveCliEntrypointModulePath(moduleUrl);
  if (!modulePath) {
    return false;
  }

  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch (err) {
    console.warn("[friday][cli] entrypoint path resolution failed:", err instanceof Error ? err.message : String(err));
    return normalizeCliEntrypointPath(argvPath) === normalizeCliEntrypointPath(modulePath);
  }
}

const isCliEntrypoint = isCliEntrypointPath(process.argv[1], import.meta.url);

if (isCliEntrypoint) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  });
}
