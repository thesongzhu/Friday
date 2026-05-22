#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createFridayHttpServer } from "#api";
import { createDiscordGatewayService, normalizeDiscordMessageCreate } from "#channels";
import { createFridayHub } from "#hub";

const PROBE_TEXT = "help me clean up old files in my workspace; ask me before doing anything";
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const DISCORD_GUILDS = 1 << 0;
const DISCORD_GUILD_MESSAGES = 1 << 9;
const DISCORD_DIRECT_MESSAGES = 1 << 12;
const DISCORD_MESSAGE_CONTENT = 1 << 15;
const REQUIRED_INTENTS = DISCORD_GUILDS | DISCORD_GUILD_MESSAGES | DISCORD_DIRECT_MESSAGES | DISCORD_MESSAGE_CONTENT;
const AWAITING_STATES = new Set(["awaiting_clarification", "awaiting_plan_approval"]);
const UNIFIED_TASK_STATE_SCHEMA_VERSION = "friday.agent.unified_task_state.v1";

function envBoolean(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function envInteger(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function tail(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length <= 8 ? value : value.slice(-8);
}

function scrub(value, token) {
  const replacer = (_key, current) => {
    if (typeof current !== "string") return current;
    let next = current;
    if (token) {
      next = next.split(token).join("[REDACTED_DISCORD_BOT_TOKEN]");
      if (token.length > 12) {
        next = next.split(token.slice(0, 12)).join("[REDACTED_DISCORD_BOT_TOKEN_PREFIX]");
      }
    }
    return next;
  };
  return JSON.parse(JSON.stringify(value, replacer));
}

function containsTokenMaterial(serialized, token) {
  return Boolean(
    token
    && (
      serialized.includes(token)
      || (token.length > 12 && serialized.includes(token.slice(0, 12)))
    ),
  );
}

function serializeScrubbedJson(value, token) {
  const serialized = `${JSON.stringify(scrub(value, token), null, 2)}\n`;
  if (containsTokenMaterial(serialized, token)) {
    throw new Error("Refusing to write artifact because it contains the Discord bot token");
  }
  return serialized;
}

function safeError(error, token) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return scrub(raw, token);
}

function authlessJsonHeaders() {
  return { "Content-Type": "application/json" };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiFetch(baseUrl, method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: authlessJsonHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { rawText: text };
  }
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed with HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  if (json && typeof json === "object" && json.ok === true && Object.hasOwn(json, "data")) {
    return json.data;
  }
  return json;
}

function hasMention(payload, botUserId) {
  return Array.isArray(payload?.mentions) && payload.mentions.some((mention) => mention?.id === botUserId);
}

function isTargetMessage(payload, config) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.channel_id !== config.channelId) return false;
  if (payload.author?.id !== config.setupUserId) return false;
  if (payload.author?.bot === true) return false;
  if (config.requireMention && !hasMention(payload, config.botUserId)) return false;
  if (!String(payload.content ?? "").includes(PROBE_TEXT)) return false;
  return true;
}

function initialReport(config, reportPath) {
  const startedAt = new Date().toISOString();
  return {
    schemaVersion: "friday.phase24b.discord_trusted_inbound_proof.v1",
    phase: "Phase24B",
    scope: "Discord live trusted user inbound proof",
    status: "running",
    blocker: null,
    startedAt,
    completedAt: null,
    reportPath,
    environment: {
      githubSha: process.env.GITHUB_SHA ?? null,
      githubRefName: process.env.GITHUB_REF_NAME ?? null,
      timeoutMs: config.timeoutMs,
      requireMention: config.requireMention,
      configuredGuildIdTail: tail(config.guildId),
      configuredChannelIdTail: tail(config.channelId),
      configuredSetupUserIdTail: tail(config.setupUserId),
      configuredBotUserIdTail: tail(config.botUserId),
      discordTokenPresent: Boolean(config.botToken),
    },
    criteria: {
      gatewayConnected: false,
      listenerReceivedMessageCreate: false,
      authorBotFalse: false,
      authorMatchesTrustedSetupUser: false,
      channelMatchesConfiguredChannel: false,
      requireMentionSatisfied: !config.requireMention,
      normalizerDidNotDrop: false,
      normalizedChannelKindDiscord: false,
      normalizedSenderMatchesTrustedSetupUser: false,
      normalizedChatMatchesConfiguredChannel: false,
      normalizedChatTypeGroup: false,
      fridayHubChannelConnected: false,
      userSessionMirrorMatched: false,
      sharedStateMachineRunFound: false,
      fridayRunTaskMatchedProbe: false,
      getRunUnifiedTaskStateAvailable: false,
      auditUnifiedTaskStateAvailable: false,
      runAuditUnifiedTaskStateMatch: false,
      unifiedTaskStateSchemaValid: false,
      unifiedTaskStateAwaitingHuman: false,
      unifiedTaskStateSourceSurfaceChannel: false,
      channelBoundaryConsumable: false,
      channelBoundaryNoLiveClaim: false,
      notCompleted: false,
      evidenceReceiptAvailable: false,
      discordShortReceiptObserved: false,
      fullEvidenceSurfaceExported: false,
      artifactHasNoToken: false,
    },
    observedDiscordEvent: null,
    normalizedMessage: null,
    userSessionMirror: null,
    fridayRun: null,
    evidenceSurface: null,
    failures: [],
  };
}

async function writeReport(report, token) {
  report.completedAt = report.status === "running" ? null : new Date().toISOString();
  if (report.criteria && typeof report.criteria === "object") {
    report.criteria.artifactHasNoToken = !containsTokenMaterial(JSON.stringify(scrub(report, token)), token);
  }
  const serialized = serializeScrubbedJson(report, token);
  await fs.mkdir(path.dirname(report.reportPath), { recursive: true });
  await fs.writeFile(report.reportPath, serialized, "utf8");
}

async function writeEvidenceArtifact(report, token, filename, value) {
  const artifactPath = path.join(path.dirname(report.reportPath), filename);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, serializeScrubbedJson(value, token), "utf8");
  return {
    filename,
    path: artifactPath,
  };
}

function resolveReportPath() {
  const reportRoot = process.env.PHASE24B_REPORT_ROOT?.trim()
    || (process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, "phase24b-discord-trusted-inbound") : path.join(os.tmpdir(), "phase24b-discord-trusted-inbound"));
  return path.join(reportRoot, "phase24b-discord-trusted-inbound-proof.json");
}

async function waitForRun(baseUrl, receivedAtMs, normalizedMessage, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const sessionKey = `channel:discord:${normalizedMessage.chatId}`;
  const expectedTask = normalizedMessage.text.trim();
  let lastCandidate = null;

  while (Date.now() < deadline) {
    const list = await apiFetch(baseUrl, "GET", "/v1/agent/runs?limit=20");
    const items = Array.isArray(list?.items) ? list.items : [];
    const candidates = items
      .filter((run) => {
        const createdAtMs = Date.parse(run?.createdAt ?? "");
        if (!Number.isFinite(createdAtMs) || createdAtMs < receivedAtMs - 10_000) return false;
        if (run?.sessionKey !== sessionKey) return false;
        if (run?.metadata?.surface !== "channel") return false;
        return run?.task === expectedTask || String(run?.task ?? "").includes(PROBE_TEXT);
      })
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));

    if (candidates.length > 0) {
      lastCandidate = candidates[0];
      const details = await apiFetch(baseUrl, "GET", `/v1/agent/runs/${encodeURIComponent(lastCandidate.id)}`);
      const run = details?.run ?? lastCandidate;
      const state = run?.unifiedTaskState?.state;
      if (AWAITING_STATES.has(state) || ["completed", "failed", "failed_tests", "cancelled"].includes(run?.status)) {
        return run;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  return lastCandidate;
}

async function getSessionMessages(baseUrl, normalizedMessage) {
  const sessionKey = `channel:discord:${normalizedMessage.chatId}`;
  const encoded = encodeURIComponent(sessionKey);
  const response = await apiFetch(baseUrl, "GET", `/v1/sessions/${encoded}/messages?limit=30`).catch(() => null);
  return Array.isArray(response?.items)
    ? response.items
    : Array.isArray(response?.messages)
      ? response.messages
      : [];
}

async function waitForUserSessionMirror(baseUrl, normalizedMessage, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await getSessionMessages(baseUrl, normalizedMessage);
    const mirror = messages.find((message) =>
      message?.role === "user"
      && message?.metadata?.sourceMessageId === normalizedMessage.id
      && message?.metadata?.channelKind === "discord"
      && String(message?.contentText ?? "").includes(PROBE_TEXT)
    );
    if (mirror) return mirror;
    await delay(1000);
  }
  return null;
}

async function waitForAssistantReceipt(baseUrl, normalizedMessage, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await getSessionMessages(baseUrl, normalizedMessage);
    const receipt = messages.find((message) =>
      message?.role === "assistant"
      && message?.metadata?.channelKind === "discord"
      && message?.metadata?.replyToMessageId === normalizedMessage.id
      && typeof message?.metadata?.sourceMessageId === "string"
      && message.metadata.sourceMessageId.trim().length > 0
      && message.metadata.sourceMessageId !== normalizedMessage.id
    );
    if (receipt) return receipt;
    await delay(1000);
  }
  return null;
}

function readEnvConfig() {
  return {
    botToken: process.env.FRIDAY_DISCORD_BOT_TOKEN?.trim() ?? "",
    setupUserId: process.env.FRIDAY_DISCORD_SETUP_USER_ID?.trim() ?? "",
    guildId: process.env.FRIDAY_DISCORD_GUILD_ID?.trim() ?? "",
    channelId: process.env.FRIDAY_DISCORD_CHANNEL_ID?.trim() ?? "",
    botUserId: process.env.FRIDAY_DISCORD_BOT_USER_ID?.trim() ?? "",
    requireMention: envBoolean("FRIDAY_DISCORD_REQUIRE_MENTION", true),
    timeoutMs: envInteger("PHASE24B_DISCORD_LISTENER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  };
}

function missingRequiredEnv(config) {
  return [
    ["FRIDAY_DISCORD_BOT_TOKEN", config.botToken],
    ["FRIDAY_DISCORD_SETUP_USER_ID", config.setupUserId],
    ["FRIDAY_DISCORD_CHANNEL_ID", config.channelId],
    ["FRIDAY_DISCORD_BOT_USER_ID", config.botUserId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

function unifiedTaskStateIsAvailable(state) {
  return state?.schemaVersion === UNIFIED_TASK_STATE_SCHEMA_VERSION;
}

function unifiedTaskStatesMatch(left, right) {
  return unifiedTaskStateIsAvailable(left)
    && unifiedTaskStateIsAvailable(right)
    && left.state === right.state
    && left.run?.runId === right.run?.runId
    && left.run?.sourceSurface === right.run?.sourceSurface
    && left.channelBoundary?.liveChannelProof === right.channelBoundary?.liveChannelProof;
}

async function main() {
  const config = readEnvConfig();
  const reportPath = resolveReportPath();
  const report = initialReport(config, reportPath);
  let hub;
  let server;
  let witnessGateway;
  let stateDir = "";

  try {
    const missingEnv = missingRequiredEnv(config);
    if (missingEnv.length > 0) {
      report.status = "blocked";
      report.blocker = "PHASE24B_DISCORD_ENV_EXPOSURE_BLOCKED";
      report.failures.push(`Missing required env: ${missingEnv.join(", ")}`);
      await writeReport(report, config.botToken);
      process.exitCode = 2;
      return;
    }

    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-phase24b-discord-"));
    process.env.FRIDAY_CHANNEL_DEBOUNCE_MS = process.env.FRIDAY_CHANNEL_DEBOUNCE_MS ?? "0";
    process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS = process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS ?? "0";

    hub = await createFridayHub({
      stateDir,
      skillDirs: [],
      port: 0,
      logRequests: false,
      channels: {
        enabled: true,
        instances: [
          {
            kind: "discord",
            enabled: true,
            token: "env:FRIDAY_DISCORD_BOT_TOKEN",
            intents: REQUIRED_INTENTS,
            botUserId: config.botUserId,
            allowedUsers: [config.setupUserId],
            allowedChannels: [config.channelId],
            requireMention: config.requireMention,
          },
        ],
      },
    });
    await hub.start();
    const discordView = hub.channelRegistry.describe("discord");
    report.criteria.fridayHubChannelConnected = discordView?.status === "connected" && discordView?.running === true;

    const port = await findFreePort();
    server = createFridayHttpServer({
      routes: hub.apiRuntime.routes,
      wsGateway: hub.apiRuntime.wsGateway,
      middleware: hub.apiRuntime.middleware,
      port,
      host: "127.0.0.1",
      logRequests: false,
    });
    await server.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    let resolveWitness;
    const witnessPromise = new Promise((resolve) => {
      resolveWitness = resolve;
    });

    witnessGateway = createDiscordGatewayService();
    await delay(envInteger("PHASE24B_DISCORD_GATEWAY_IDENTIFY_SPACING_MS", 6000));
    await witnessGateway.connect(
      config.botToken,
      REQUIRED_INTENTS,
      (event) => {
        if (event?.t !== "MESSAGE_CREATE") return;
        const payload = event.d;
        if (!isTargetMessage(payload, config)) return;
        const normalized = normalizeDiscordMessageCreate(payload, config.requireMention, config.botUserId);
        resolveWitness({ event, payload, normalized, receivedAtMs: Date.now() });
      },
      (status) => {
        if (status === "connected") {
          report.criteria.gatewayConnected = true;
        }
      },
    );
    report.criteria.gatewayConnected = witnessGateway.isConnected();
    await writeReport(report, config.botToken);

    console.log("PHASE24B_DISCORD_LISTENER_READY");
    console.log("Send this in the configured Discord channel now:");
    console.log(`<@${config.botUserId}> ${PROBE_TEXT}`);

    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve(null), config.timeoutMs);
    });
    const observed = await Promise.race([witnessPromise, timeout]);
    if (!observed) {
      report.status = "blocked";
      report.blocker = "PHASE24B_WAITING_FOR_TRUSTED_USER_MESSAGE";
      report.failures.push(`No matching trusted user MESSAGE_CREATE arrived within ${config.timeoutMs}ms`);
      await writeReport(report, config.botToken);
      process.exitCode = 2;
      return;
    }

    const { payload, normalized, receivedAtMs } = observed;
    report.criteria.listenerReceivedMessageCreate = true;
    report.criteria.authorBotFalse = payload.author?.bot !== true;
    report.criteria.authorMatchesTrustedSetupUser = payload.author?.id === config.setupUserId;
    report.criteria.channelMatchesConfiguredChannel = payload.channel_id === config.channelId;
    report.criteria.requireMentionSatisfied = !config.requireMention || hasMention(payload, config.botUserId);
    report.criteria.normalizerDidNotDrop = normalized !== null;
    report.observedDiscordEvent = {
      type: "MESSAGE_CREATE",
      messageIdTail: tail(payload.id),
      channelIdTail: tail(payload.channel_id),
      guildIdTail: tail(payload.guild_id),
      authorIdTail: tail(payload.author?.id),
      authorBot: payload.author?.bot === true,
      contentMatchedProbe: String(payload.content ?? "").includes(PROBE_TEXT),
      mentionsBot: hasMention(payload, config.botUserId),
    };

    if (!normalized) {
      report.status = "failed";
      report.blocker = "PHASE24B_DISCORD_NORMALIZER_DROPPED_TRUSTED_USER_MESSAGE";
      report.failures.push("Discord MESSAGE_CREATE matched trusted sender/channel but Friday normalizer returned null");
      await writeReport(report, config.botToken);
      process.exitCode = 1;
      return;
    }

    report.criteria.normalizedChannelKindDiscord = normalized.channelKind === "discord";
    report.criteria.normalizedSenderMatchesTrustedSetupUser = normalized.senderId === config.setupUserId;
    report.criteria.normalizedChatMatchesConfiguredChannel = normalized.chatId === config.channelId;
    report.criteria.normalizedChatTypeGroup = normalized.chatType === "group";
    report.normalizedMessage = {
      idTail: tail(normalized.id),
      channelKind: normalized.channelKind,
      senderIdTail: tail(normalized.senderId),
      senderNamePresent: Boolean(normalized.senderName),
      chatIdTail: tail(normalized.chatId),
      chatType: normalized.chatType,
      textMatchedProbe: normalized.text.includes(PROBE_TEXT),
      replyToTail: tail(normalized.replyTo),
      timestampPresent: typeof normalized.timestamp === "number",
    };
    await writeReport(report, config.botToken);

    const mirror = await waitForUserSessionMirror(baseUrl, normalized, Math.min(config.timeoutMs, 60_000));
    report.criteria.userSessionMirrorMatched = Boolean(mirror);
    report.userSessionMirror = mirror
      ? {
        messageIdTail: tail(mirror.id),
        sourceMessageIdTail: tail(mirror.metadata?.sourceMessageId),
        channelKind: mirror.metadata?.channelKind ?? null,
        contentMatchedProbe: String(mirror.contentText ?? "").includes(PROBE_TEXT),
      }
      : null;
    if (!mirror) {
      report.status = "failed";
      report.blocker = "PHASE24B_DISCORD_SESSION_MIRROR_NOT_FOUND";
      report.failures.push("Trusted Discord message was normalized but no exact sourceMessageId user session mirror appeared");
      await writeReport(report, config.botToken);
      process.exitCode = 1;
      return;
    }

    const run = await waitForRun(baseUrl, receivedAtMs, normalized, Math.min(config.timeoutMs, 180_000));
    if (!run?.id) {
      report.status = "failed";
      report.blocker = "PHASE24B_DISCORD_SHARED_STATE_MACHINE_RUN_NOT_FOUND";
      report.failures.push("Trusted Discord message was normalized but no matching Friday channel-origin run appeared");
      await writeReport(report, config.botToken);
      process.exitCode = 1;
      return;
    }

    const runDetails = await apiFetch(baseUrl, "GET", `/v1/agent/runs/${encodeURIComponent(run.id)}`);
    const runRecord = runDetails?.run ?? run;
    const audit = await apiFetch(baseUrl, "GET", `/v1/agent/runs/${encodeURIComponent(run.id)}/audit`);
    const runUnifiedTaskState = runRecord.unifiedTaskState ?? null;
    const auditUnifiedTaskState = audit?.unifiedTaskState ?? null;
    const state = auditUnifiedTaskState?.state ?? null;
    const receipt = await waitForAssistantReceipt(baseUrl, normalized, Math.min(config.timeoutMs, 60_000));
    const finalSessionMessages = await getSessionMessages(baseUrl, normalized);
    const exportedEvidenceFiles = [
      await writeEvidenceArtifact(report, config.botToken, "friday-agent-run-response.json", runDetails),
      await writeEvidenceArtifact(report, config.botToken, "friday-agent-run-audit-response.json", audit),
      await writeEvidenceArtifact(report, config.botToken, "friday-session-messages-response.json", { items: finalSessionMessages }),
    ];

    report.criteria.sharedStateMachineRunFound = true;
    report.criteria.fridayRunTaskMatchedProbe = String(runRecord.task ?? "").includes(PROBE_TEXT);
    report.criteria.getRunUnifiedTaskStateAvailable = unifiedTaskStateIsAvailable(runUnifiedTaskState);
    report.criteria.auditUnifiedTaskStateAvailable = unifiedTaskStateIsAvailable(auditUnifiedTaskState);
    report.criteria.runAuditUnifiedTaskStateMatch = unifiedTaskStatesMatch(runUnifiedTaskState, auditUnifiedTaskState);
    report.criteria.unifiedTaskStateSchemaValid = runUnifiedTaskState?.schemaVersion === UNIFIED_TASK_STATE_SCHEMA_VERSION
      && auditUnifiedTaskState?.schemaVersion === UNIFIED_TASK_STATE_SCHEMA_VERSION;
    report.criteria.unifiedTaskStateAwaitingHuman = AWAITING_STATES.has(state);
    report.criteria.unifiedTaskStateSourceSurfaceChannel = runUnifiedTaskState?.run?.sourceSurface === "channel"
      && auditUnifiedTaskState?.run?.sourceSurface === "channel";
    report.criteria.channelBoundaryConsumable = runUnifiedTaskState?.channelBoundary?.consumableByChannelAdapters === true
      && auditUnifiedTaskState?.channelBoundary?.consumableByChannelAdapters === true;
    report.criteria.channelBoundaryNoLiveClaim = runUnifiedTaskState?.channelBoundary?.liveChannelProof === "not_claimed"
      && auditUnifiedTaskState?.channelBoundary?.liveChannelProof === "not_claimed";
    report.criteria.notCompleted = runRecord.status !== "completed" && state !== "completed";
    report.criteria.evidenceReceiptAvailable = audit?.replayReceipt?.schemaVersion === "friday.agent.evidence_receipt.v1"
      && audit?.replayReceipt?.run?.runId === runRecord.id;
    report.criteria.discordShortReceiptObserved = Boolean(receipt?.metadata?.sourceMessageId);
    report.criteria.fullEvidenceSurfaceExported = exportedEvidenceFiles.length === 3;
    report.fridayRun = {
      runId: runRecord.id,
      status: runRecord.status,
      unifiedTaskState: state,
      sourceSurface: auditUnifiedTaskState?.run?.sourceSurface ?? null,
      liveChannelProofBoundary: auditUnifiedTaskState?.channelBoundary?.liveChannelProof ?? null,
      sessionKey: runRecord.sessionKey,
      taskMatchedProbe: String(runRecord.task ?? "").includes(PROBE_TEXT),
      responsePresent: Boolean(runRecord.responseText || runRecord.summary),
      completedAt: runRecord.completedAt ?? null,
    };
    report.evidenceSurface = {
      runEndpoint: `/v1/agent/runs/${encodeURIComponent(runRecord.id)}`,
      auditEndpoint: `/v1/agent/runs/${encodeURIComponent(runRecord.id)}/audit`,
      replayReceiptStatus: audit?.replayReceipt?.receiptStatus ?? null,
      auditEventCount: Array.isArray(audit?.events) ? audit.events.length : null,
      assistantReceiptMessageIdTail: tail(receipt?.metadata?.sourceMessageId),
      assistantReceiptRole: receipt?.role ?? null,
      exportedFiles: exportedEvidenceFiles,
    };
    report.criteria.artifactHasNoToken = !containsTokenMaterial(JSON.stringify(scrub(report, config.botToken)), config.botToken);

    const requiredCriteria = [
      "gatewayConnected",
      "listenerReceivedMessageCreate",
      "authorBotFalse",
      "authorMatchesTrustedSetupUser",
      "channelMatchesConfiguredChannel",
      "requireMentionSatisfied",
      "normalizerDidNotDrop",
      "normalizedChannelKindDiscord",
      "normalizedSenderMatchesTrustedSetupUser",
      "normalizedChatMatchesConfiguredChannel",
      "normalizedChatTypeGroup",
      "fridayHubChannelConnected",
      "userSessionMirrorMatched",
      "sharedStateMachineRunFound",
      "fridayRunTaskMatchedProbe",
      "getRunUnifiedTaskStateAvailable",
      "auditUnifiedTaskStateAvailable",
      "runAuditUnifiedTaskStateMatch",
      "unifiedTaskStateSchemaValid",
      "unifiedTaskStateAwaitingHuman",
      "unifiedTaskStateSourceSurfaceChannel",
      "channelBoundaryConsumable",
      "channelBoundaryNoLiveClaim",
      "notCompleted",
      "evidenceReceiptAvailable",
      "discordShortReceiptObserved",
      "fullEvidenceSurfaceExported",
      "artifactHasNoToken",
    ];
    report.failures = requiredCriteria.filter((key) => report.criteria[key] !== true);
    report.status = report.failures.length === 0 ? "passed" : "failed";
    if (report.status !== "passed") {
      report.blocker = report.criteria.unifiedTaskStateAwaitingHuman
        ? "PHASE24B_DISCORD_TRUSTED_INBOUND_ACCEPTANCE_FAILED"
        : "PHASE24B_DISCORD_SHARED_STATE_MACHINE_NOT_AWAITING_HUMAN";
    }

    await writeReport(report, config.botToken);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    report.status = "failed";
    report.blocker = "PHASE24B_DISCORD_LISTENER_HARNESS_ERROR";
    report.failures.push(safeError(error, config?.botToken ?? ""));
    await writeReport(report, config?.botToken ?? "").catch(() => {});
    process.exitCode = 1;
  } finally {
    if (witnessGateway) await witnessGateway.disconnect().catch(() => {});
    if (server) await server.close().catch(() => {});
    if (hub) await hub.stop().catch(() => {});
    if (stateDir) await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main();
