#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createFridayHttpServer } from "#api";
import {
  createDiscordGatewayService,
  createDiscordRestService,
  createFridayDiscordChannel,
  normalizeDiscordMessageCreate,
} from "#channels";
import { createFridayHub } from "#hub";

import {
  containsTokenMaterial as containsTokenMaterialShared,
  scrub as scrubShared,
} from "./lib/token-redaction.mjs";
import { acquireLocalBearerToken } from "./lib/phase24-local-auth.mjs";

const PROBE_BODY_TEXT = "help me clean up old files in my workspace; ask me before doing anything";
const DISCORD_REDACTION_LABELS = Object.freeze({
  tokenLabel: "[REDACTED_DISCORD_BOT_TOKEN]",
  prefixLabel: "[REDACTED_DISCORD_BOT_TOKEN_PREFIX]",
});
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

function sanitizeNoncePart(value, fallback) {
  const raw = typeof value === "string" ? value.trim() : "";
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}

function buildProbeNonce() {
  const explicit = process.env.PHASE24B_DISCORD_PROBE_NONCE?.trim();
  if (explicit) return sanitizeNoncePart(explicit, "phase24b-run-explicit");
  const runId = sanitizeNoncePart(process.env.GITHUB_RUN_ID, "local");
  const sha = sanitizeNoncePart((process.env.GITHUB_SHA ?? "local").slice(0, 8), "local");
  return `phase24b-run-${runId}-${sha}`;
}

function messageIncludesProbe(value, config) {
  const text = String(value ?? "");
  return text.includes(config.probeBodyText) && text.includes(config.probeNonce);
}

function tail(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length <= 8 ? value : value.slice(-8);
}

function scrub(value, token) {
  return scrubShared(value, token, DISCORD_REDACTION_LABELS);
}

function containsTokenMaterial(serialized, token) {
  return containsTokenMaterialShared(serialized, token);
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

// Bearer token for the disposable listener hub, set after bootstrap-local-passphrase +
// login. Session/run read endpoints require a bound principal
// (OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED); this token is the legitimate principal.
// SECURITY: never logged, never written to the proof artifact.
let listenerBearerToken = null;

function authlessJsonHeaders() {
  return { "Content-Type": "application/json" };
}

function authedJsonHeaders() {
  return listenerBearerToken
    ? { "Content-Type": "application/json", Authorization: `Bearer ${listenerBearerToken}` }
    : { "Content-Type": "application/json" };
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
    headers: authedJsonHeaders(),
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

function inspectDiscordPayload(payload, config, receivedAtMs) {
  const content = String(payload?.content ?? "");
  const mentionMatched = !config.requireMention || hasMention(payload, config.botUserId);
  const authorBotFalse = payload?.author?.bot !== true;
  const senderMatched = payload?.author?.id === config.setupUserId;
  const channelMatched = payload?.channel_id === config.channelId;
  const probeBodyMatched = content.includes(config.probeBodyText);
  const nonceMatched = content.includes(config.probeNonce);
  let normalized = null;
  if (payload?.id && payload?.author) {
    normalized = normalizeDiscordMessageCreate(payload, config.requireMention, config.botUserId);
  }
  const rawTargetMatched = authorBotFalse
    && senderMatched
    && channelMatched
    && mentionMatched
    && probeBodyMatched
    && nonceMatched;
  return {
    receivedAt: new Date(receivedAtMs).toISOString(),
    receivedAtMs,
    messageId: typeof payload?.id === "string" ? payload.id : null,
    messageIdTail: tail(payload?.id),
    channelIdTail: tail(payload?.channel_id),
    guildIdTail: tail(payload?.guild_id),
    senderIdTail: tail(payload?.author?.id),
    authorBot: payload?.author?.bot === true,
    authorBotFalse,
    senderMatched,
    channelMatched,
    mentionMatched,
    probeBodyMatched,
    nonceMatched,
    fullProbeMatched: probeBodyMatched && nonceMatched,
    rawTargetMatched,
    normalizerAccepted: normalized !== null,
    normalized,
  };
}

function redactedDiscordInspection(inspection) {
  return {
    receivedAt: inspection.receivedAt,
    messageIdTail: inspection.messageIdTail,
    channelIdTail: inspection.channelIdTail,
    guildIdTail: inspection.guildIdTail,
    senderIdTail: inspection.senderIdTail,
    authorBot: inspection.authorBot,
    authorBotFalse: inspection.authorBotFalse,
    senderMatched: inspection.senderMatched,
    channelMatched: inspection.channelMatched,
    mentionMatched: inspection.mentionMatched,
    probeBodyMatched: inspection.probeBodyMatched,
    nonceMatched: inspection.nonceMatched,
    fullProbeMatched: inspection.fullProbeMatched,
    rawTargetMatched: inspection.rawTargetMatched,
    normalizerAccepted: inspection.normalizerAccepted,
  };
}

function recordDiscordMessageCreate(report, observedEventsByMessageId, payload, config) {
  const receivedAtMs = Date.now();
  const inspection = inspectDiscordPayload(payload, config, receivedAtMs);
  const redacted = redactedDiscordInspection(inspection);
  const diagnostics = report.diagnostics.discordHubAdapter;
  diagnostics.messageCreateCount += 1;
  diagnostics.lastMessageCreate = redacted;
  if (inspection.fullProbeMatched) diagnostics.nonceMessageCreateCount += 1;
  if (inspection.rawTargetMatched) diagnostics.targetRawMessageCreateCount += 1;
  if (inspection.messageId) {
    observedEventsByMessageId.set(inspection.messageId, {
      payload,
      normalized: inspection.normalized,
      receivedAtMs,
      inspection: redacted,
    });
  }
  if (!inspection.rawTargetMatched) return;

  report.criteria.listenerReceivedMessageCreate = true;
  report.criteria.authorBotFalse = inspection.authorBotFalse;
  report.criteria.authorMatchesTrustedSetupUser = inspection.senderMatched;
  report.criteria.channelMatchesConfiguredChannel = inspection.channelMatched;
  report.criteria.requireMentionSatisfied = inspection.mentionMatched;
  report.criteria.nonceMatched = inspection.nonceMatched;
  report.criteria.normalizerDidNotDrop = inspection.normalizerAccepted;
  report.observedDiscordEvent = {
    type: "MESSAGE_CREATE",
    ...redacted,
  };
  diagnostics.matchedMessageCreate = redacted;
}

function createInstrumentedDiscordGatewayService(config, report, observedEventsByMessageId) {
  const gateway = createDiscordGatewayService();
  return {
    async connect(token, intents, onEvent, onStatusChange) {
      await gateway.connect(token, intents, (event) => {
        if (event?.t === "MESSAGE_CREATE") {
          recordDiscordMessageCreate(report, observedEventsByMessageId, event.d, config);
        }
        onEvent(event);
      }, (status) => {
        const connected = status === "connected" || gateway.isConnected();
        report.criteria.gatewayConnected = connected;
        report.diagnostics.discordHubAdapter.gatewayConnected = connected;
        if (onStatusChange) onStatusChange(status);
      });
      report.criteria.gatewayConnected = gateway.isConnected();
      report.diagnostics.discordHubAdapter.gatewayConnected = gateway.isConnected();
    },
    async disconnect() {
      await gateway.disconnect();
      report.diagnostics.discordHubAdapter.gatewayConnected = false;
    },
    isConnected() {
      return gateway.isConnected();
    },
  };
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
      commit_sha: process.env.GITHUB_SHA ?? null,
      githubSha: process.env.GITHUB_SHA ?? null,
      githubRunId: process.env.GITHUB_RUN_ID ?? null,
      githubRefName: process.env.GITHUB_REF_NAME ?? null,
      timeoutMs: config.timeoutMs,
      requireMention: config.requireMention,
      configuredGuildIdTail: tail(config.guildId),
      configuredChannelIdTail: tail(config.channelId),
      configuredSetupUserIdTail: tail(config.setupUserId),
      configuredBotUserIdTail: tail(config.botUserId),
      discordTokenPresent: Boolean(config.botToken),
      probeBodyText: config.probeBodyText,
      probeNonce: config.probeNonce,
      expectedOperatorMessage: config.expectedOperatorMessage,
    },
    criteria: {
      gatewayConnected: false,
      listenerReceivedMessageCreate: false,
      authorBotFalse: false,
      authorMatchesTrustedSetupUser: false,
      channelMatchesConfiguredChannel: false,
      requireMentionSatisfied: !config.requireMention,
      nonceMatched: false,
      normalizerDidNotDrop: false,
      normalizedChannelKindDiscord: false,
      normalizedSenderMatchesTrustedSetupUser: false,
      normalizedChatMatchesConfiguredChannel: false,
      normalizedChatTypeGroup: false,
      fridayHubChannelConnected: false,
      realHubAdapterAcceptedMessage: false,
      userSessionMirrorMatched: false,
      sessionMirrorMatchesNonce: false,
      sharedStateMachineRunFound: false,
      fridayRunTaskMatchedProbe: false,
      runMatchesNonce: false,
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
      assistantSessionReplyObserved: false,
      evidenceMatchesNonce: false,
      fullEvidenceSurfaceExported: false,
      artifactHasNoToken: false,
    },
    diagnostics: {
      proofSource: "instrumented_hub_gateway_and_current_runner_session",
      discordHubAdapter: {
        gatewayConnected: false,
        realHubAdapterAcceptedMessage: false,
        messageCreateCount: 0,
        nonceMessageCreateCount: 0,
        targetRawMessageCreateCount: 0,
        lastMessageCreate: null,
        matchedMessageCreate: null,
      },
      currentRunnerNonceCorrespondence: {
        sourceMessageIdTail: null,
        sessionMirrorMatchesNonce: false,
        sessionMirrorSourceMessageIdMatchesGateway: false,
        runMatchesNonce: false,
        evidenceMatchesNonce: false,
      },
      localNonCurrentRunnerAmbiguityPossible: true,
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

async function waitForRun(baseUrl, receivedAtMs, normalizedMessage, config, timeoutMs) {
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
        return run?.task === expectedTask || messageIncludesProbe(run?.task, config);
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

async function getSessionMessages(baseUrl, chatOrMessage) {
  const chatId = typeof chatOrMessage === "string" ? chatOrMessage : chatOrMessage.chatId;
  const sessionKey = `channel:discord:${chatId}`;
  const encoded = encodeURIComponent(sessionKey);
  const response = await apiFetch(baseUrl, "GET", `/v1/sessions/${encoded}/messages?limit=30`).catch(() => null);
  return Array.isArray(response?.items)
    ? response.items
    : Array.isArray(response?.messages)
      ? response.messages
      : [];
}

async function waitForUserSessionMirror(baseUrl, config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await getSessionMessages(baseUrl, config.channelId);
    const mirror = messages.find((message) =>
      message?.role === "user"
      && message?.metadata?.channelKind === "discord"
      && typeof message?.metadata?.sourceMessageId === "string"
      && messageIncludesProbe(message?.contentText, config)
    );
    if (mirror) return mirror;
    await delay(1000);
  }
  return null;
}

async function waitForAssistantSessionReply(baseUrl, normalizedMessage, config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await getSessionMessages(baseUrl, normalizedMessage);
    const receipt = messages.find((message) =>
      message?.role === "assistant"
      && (
        message?.metadata?.replyToMessageId === normalizedMessage.id
        || String(message?.contentText ?? "").includes("Proposed plan")
        || String(message?.contentText ?? "").includes(config.probeNonce)
      )
    );
    if (receipt) return receipt;
    await delay(1000);
  }
  return null;
}

function readEnvConfig() {
  const probeNonce = buildProbeNonce();
  const probeText = `${PROBE_BODY_TEXT} ${probeNonce}`;
  const botUserId = process.env.FRIDAY_DISCORD_BOT_USER_ID?.trim() ?? "";
  return {
    botToken: process.env.FRIDAY_DISCORD_BOT_TOKEN?.trim() ?? "",
    setupUserId: process.env.FRIDAY_DISCORD_SETUP_USER_ID?.trim() ?? "",
    guildId: process.env.FRIDAY_DISCORD_GUILD_ID?.trim() ?? "",
    channelId: process.env.FRIDAY_DISCORD_CHANNEL_ID?.trim() ?? "",
    botUserId,
    requireMention: envBoolean("FRIDAY_DISCORD_REQUIRE_MENTION", true),
    timeoutMs: envInteger("PHASE24B_DISCORD_LISTENER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    githubRunId: process.env.GITHUB_RUN_ID?.trim() || null,
    githubSha: process.env.GITHUB_SHA?.trim() || null,
    probeBodyText: PROBE_BODY_TEXT,
    probeNonce,
    probeText,
    expectedOperatorMessage: `<@${botUserId}> ${probeText}`,
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
  let stateDir = "";
  const observedEventsByMessageId = new Map();

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
      // Phase24B proves the live channel adapter by reading the current-runner
      // session mirror. Production/default hubs keep TS session execution
      // fail-closed; this disposable proof harness opts in to the same
      // test-oracle path used by live channel E2E coverage.
      allowTestOnlySessionExecution: true,
      channels: {
        enabled: false,
        instances: [],
      },
    });

    const instrumentedGateway = createInstrumentedDiscordGatewayService(config, report, observedEventsByMessageId);
    const discordPlugin = createFridayDiscordChannel({
      gateway: instrumentedGateway,
      rest: createDiscordRestService(),
    });
    await discordPlugin.init({
      kind: "discord",
      enabled: true,
      token: config.botToken,
      intents: REQUIRED_INTENTS,
      botUserId: config.botUserId,
      allowedUsers: [config.setupUserId],
      allowedChannels: [config.channelId],
      requireMention: config.requireMention,
    });
    hub.channelRegistry.register(discordPlugin, {
      allowedUsers: [config.setupUserId],
      allowedChats: [config.channelId],
    });
    await hub.start();
    const discordView = hub.channelRegistry.describe("discord");
    report.criteria.fridayHubChannelConnected = discordView?.status === "connected" && discordView?.running === true;
    report.criteria.gatewayConnected = instrumentedGateway.isConnected();
    report.diagnostics.discordHubAdapter.gatewayConnected = instrumentedGateway.isConnected();

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

    // Session/run read endpoints require a bound principal
    // (OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED). Authenticate as a legitimate local
    // principal via the standard bootstrap-local-passphrase + login flow. The token is
    // kept local and is never logged or written to the proof artifact.
    listenerBearerToken = await acquireLocalBearerToken(baseUrl);

    await writeReport(report, config.botToken);

    console.log("PHASE24B_DISCORD_LISTENER_READY");
    console.log("Send this in the configured Discord channel now:");
    console.log(config.expectedOperatorMessage);

    const mirror = await waitForUserSessionMirror(baseUrl, config, config.timeoutMs);
    report.criteria.userSessionMirrorMatched = Boolean(mirror);
    report.criteria.sessionMirrorMatchesNonce = Boolean(mirror && messageIncludesProbe(mirror.contentText, config));
    report.diagnostics.currentRunnerNonceCorrespondence.sessionMirrorMatchesNonce = report.criteria.sessionMirrorMatchesNonce;
    report.userSessionMirror = mirror
      ? {
        messageIdTail: tail(mirror.id),
        sourceMessageIdTail: tail(mirror.metadata?.sourceMessageId),
        channelKind: mirror.metadata?.channelKind ?? null,
        contentMatchedProbe: messageIncludesProbe(mirror.contentText, config),
        nonceMatched: String(mirror.contentText ?? "").includes(config.probeNonce),
      }
      : null;

    if (!mirror) {
      report.status = "blocked";
      report.blocker = report.criteria.listenerReceivedMessageCreate
        ? "PHASE24B_DISCORD_HUB_ADAPTER_DID_NOT_CREATE_NONCE_SESSION_MIRROR"
        : "PHASE24B_WAITING_FOR_TRUSTED_USER_MESSAGE";
      report.diagnostics.localNonCurrentRunnerAmbiguityPossible = true;
      report.failures.push(`No current-runner user session mirror for nonce ${config.probeNonce} appeared within ${config.timeoutMs}ms`);
      await writeReport(report, config.botToken);
      process.exitCode = 2;
      return;
    }

    const sourceMessageId = mirror.metadata?.sourceMessageId;
    report.diagnostics.currentRunnerNonceCorrespondence.sourceMessageIdTail = tail(sourceMessageId);
    const observed = typeof sourceMessageId === "string" ? observedEventsByMessageId.get(sourceMessageId) : null;
    report.diagnostics.currentRunnerNonceCorrespondence.sessionMirrorSourceMessageIdMatchesGateway = Boolean(observed);

    if (!observed) {
      report.status = "blocked";
      report.blocker = "PHASE24B_DISCORD_CURRENT_LISTENER_SOURCE_EVENT_NOT_FOUND";
      report.diagnostics.localNonCurrentRunnerAmbiguityPossible = true;
      report.failures.push("Current runner session mirror matched the nonce, but the instrumented hub gateway did not record the same sourceMessageId");
      await writeReport(report, config.botToken);
      process.exitCode = 2;
      return;
    }

    const { normalized, receivedAtMs, inspection } = observed;
    if (!inspection?.rawTargetMatched) {
      report.status = "failed";
      report.blocker = "PHASE24B_DISCORD_SESSION_MIRROR_SOURCE_NOT_TRUSTED_TARGET";
      report.diagnostics.localNonCurrentRunnerAmbiguityPossible = true;
      report.failures.push("Session mirror sourceMessageId matched a gateway event, but that event did not satisfy trusted sender/channel/mention/nonce checks");
      await writeReport(report, config.botToken);
      process.exitCode = 1;
      return;
    }

    if (!normalized) {
      report.status = "failed";
      report.blocker = "PHASE24B_DISCORD_NORMALIZER_DROPPED_TRUSTED_USER_MESSAGE";
      report.failures.push("Discord MESSAGE_CREATE matched trusted sender/channel but Friday normalizer returned null");
      await writeReport(report, config.botToken);
      process.exitCode = 1;
      return;
    }

    report.criteria.realHubAdapterAcceptedMessage = true;
    report.diagnostics.discordHubAdapter.realHubAdapterAcceptedMessage = true;
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
      textMatchedProbe: messageIncludesProbe(normalized.text, config),
      nonceMatched: normalized.text.includes(config.probeNonce),
      replyToTail: tail(normalized.replyTo),
      timestampPresent: typeof normalized.timestamp === "number",
    };
    await writeReport(report, config.botToken);

    const run = await waitForRun(baseUrl, receivedAtMs, normalized, config, Math.min(config.timeoutMs, 180_000));
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
    const assistantReply = await waitForAssistantSessionReply(baseUrl, normalized, config, Math.min(config.timeoutMs, 60_000));
    const finalSessionMessages = await getSessionMessages(baseUrl, normalized);
    const exportedEvidenceFiles = [
      await writeEvidenceArtifact(report, config.botToken, "friday-agent-run-response.json", runDetails),
      await writeEvidenceArtifact(report, config.botToken, "friday-agent-run-audit-response.json", audit),
      await writeEvidenceArtifact(report, config.botToken, "friday-session-messages-response.json", { items: finalSessionMessages }),
    ];

    report.criteria.sharedStateMachineRunFound = true;
    report.criteria.fridayRunTaskMatchedProbe = messageIncludesProbe(runRecord.task, config);
    report.criteria.runMatchesNonce = String(runRecord.task ?? "").includes(config.probeNonce);
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
    report.criteria.discordShortReceiptObserved = Boolean(assistantReply?.metadata?.sourceMessageId);
    report.criteria.assistantSessionReplyObserved = Boolean(assistantReply);
    report.criteria.evidenceMatchesNonce = messageIncludesProbe(runRecord.task, config)
      && finalSessionMessages.some((message) => message?.role === "user" && messageIncludesProbe(message?.contentText, config));
    report.criteria.fullEvidenceSurfaceExported = exportedEvidenceFiles.length === 3;
    report.diagnostics.currentRunnerNonceCorrespondence.runMatchesNonce = report.criteria.runMatchesNonce;
    report.diagnostics.currentRunnerNonceCorrespondence.evidenceMatchesNonce = report.criteria.evidenceMatchesNonce;
    report.diagnostics.localNonCurrentRunnerAmbiguityPossible = !(report.criteria.realHubAdapterAcceptedMessage
      && report.criteria.sessionMirrorMatchesNonce
      && report.criteria.runMatchesNonce
      && report.criteria.evidenceMatchesNonce);
    report.fridayRun = {
      runId: runRecord.id,
      status: runRecord.status,
      unifiedTaskState: state,
      sourceSurface: auditUnifiedTaskState?.run?.sourceSurface ?? null,
      liveChannelProofBoundary: auditUnifiedTaskState?.channelBoundary?.liveChannelProof ?? null,
      sessionKey: runRecord.sessionKey,
      taskMatchedProbe: messageIncludesProbe(runRecord.task, config),
      nonceMatched: String(runRecord.task ?? "").includes(config.probeNonce),
      responsePresent: Boolean(runRecord.responseText || runRecord.summary),
      completedAt: runRecord.completedAt ?? null,
    };
    report.evidenceSurface = {
      runEndpoint: `/v1/agent/runs/${encodeURIComponent(runRecord.id)}`,
      auditEndpoint: `/v1/agent/runs/${encodeURIComponent(runRecord.id)}/audit`,
      replayReceiptStatus: audit?.replayReceipt?.receiptStatus ?? null,
      auditEventCount: Array.isArray(audit?.events) ? audit.events.length : null,
      assistantReceiptMessageIdTail: tail(assistantReply?.metadata?.sourceMessageId),
      assistantReceiptRole: assistantReply?.role ?? null,
      assistantSessionReplyObserved: Boolean(assistantReply),
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
      "nonceMatched",
      "normalizerDidNotDrop",
      "normalizedChannelKindDiscord",
      "normalizedSenderMatchesTrustedSetupUser",
      "normalizedChatMatchesConfiguredChannel",
      "normalizedChatTypeGroup",
      "fridayHubChannelConnected",
      "realHubAdapterAcceptedMessage",
      "userSessionMirrorMatched",
      "sessionMirrorMatchesNonce",
      "sharedStateMachineRunFound",
      "fridayRunTaskMatchedProbe",
      "runMatchesNonce",
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
      "evidenceMatchesNonce",
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
    if (server) await server.close().catch(() => {});
    if (hub) await hub.stop().catch(() => {});
    if (stateDir) await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main();
