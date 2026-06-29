#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createFridayHttpServer } from "#api";
import {
  createTelegramApiService,
  createTelegramPollingService,
  createTelegramWebhookService,
  createFridayTelegramChannel,
  normalizeTelegramUpdate,
} from "#channels";
import { createFridayHub } from "#hub";

import {
  containsTokenMaterial as containsTokenMaterialShared,
  scrub as scrubShared,
} from "./lib/token-redaction.mjs";
import { acquireLocalBearerToken } from "./lib/phase24-local-auth.mjs";

const PROBE_BODY_TEXT = "help me clean up old files in my workspace; ask me before doing anything";
const TELEGRAM_REDACTION_LABELS = Object.freeze({
  tokenLabel: "[REDACTED_TELEGRAM_BOT_TOKEN]",
  prefixLabel: "[REDACTED_TELEGRAM_BOT_TOKEN_PREFIX]",
});
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const AWAITING_STATES = new Set(["awaiting_clarification", "awaiting_plan_approval"]);
const UNIFIED_TASK_STATE_SCHEMA_VERSION = "friday.agent.unified_task_state.v1";

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
  const explicit = process.env.PHASE24C_TELEGRAM_PROBE_NONCE?.trim();
  if (explicit) return sanitizeNoncePart(explicit, "phase24c-run-explicit");
  const runId = sanitizeNoncePart(process.env.GITHUB_RUN_ID, "local");
  const sha = sanitizeNoncePart((process.env.GITHUB_SHA ?? "local").slice(0, 8), "local");
  return `phase24c-run-${runId}-${sha}`;
}

function messageIncludesProbe(value, config) {
  const text = String(value ?? "");
  return text.includes(config.probeBodyText) && text.includes(config.probeNonce);
}

function tail(value) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  if (text.length === 0) return null;
  return text.length <= 8 ? text : text.slice(-8);
}

function scrub(value, token) {
  return scrubShared(value, token, TELEGRAM_REDACTION_LABELS);
}

function containsTokenMaterial(serialized, token) {
  return containsTokenMaterialShared(serialized, token);
}

function serializeScrubbedJson(value, token) {
  const serialized = `${JSON.stringify(scrub(value, token), null, 2)}\n`;
  if (containsTokenMaterial(serialized, token)) {
    throw new Error("Refusing to write artifact because it contains the Telegram bot token");
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

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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

function inspectTelegramUpdate(update, config, receivedAtMs) {
  const message = update?.message ?? null;
  const content = String(message?.text ?? "");
  const authorBot = message?.from?.is_bot === true;
  const authorBotFalse = Boolean(message?.from) && !authorBot;
  const senderId = message?.from?.id === undefined ? "" : String(message.from.id);
  const chatId = message?.chat?.id === undefined ? "" : String(message.chat.id);
  const senderMatched = senderId === config.allowedUserId;
  const chatMatched = chatId === config.chatId;
  const probeBodyMatched = content.includes(config.probeBodyText);
  const nonceMatched = content.includes(config.probeNonce);
  const normalized = normalizeTelegramUpdate(update);
  const messageId = message?.message_id === undefined ? null : String(message.message_id);
  const messageDateMs = Number.isFinite(message?.date) ? message.date * 1000 : null;
  const freshForRun = typeof messageDateMs === "number" && messageDateMs >= config.acceptAfterMs;
  const rawTargetMatched = authorBotFalse
    && senderMatched
    && chatMatched
    && freshForRun
    && probeBodyMatched
    && nonceMatched;
  return {
    receivedAt: new Date(receivedAtMs).toISOString(),
    receivedAtMs,
    updateId: typeof update?.update_id === "number" ? update.update_id : null,
    updateIdTail: tail(update?.update_id),
    messageId,
    messageIdTail: tail(messageId),
    chatIdTail: tail(chatId),
    senderIdTail: tail(senderId),
    chatType: message?.chat?.type ?? null,
    messageDate: typeof messageDateMs === "number" ? new Date(messageDateMs).toISOString() : null,
    freshForRun,
    authorBot,
    authorBotFalse,
    senderMatched,
    chatMatched,
    probeBodyMatched,
    nonceMatched,
    fullProbeMatched: probeBodyMatched && nonceMatched,
    rawTargetMatched,
    normalizerAccepted: normalized !== null,
    normalized,
  };
}

function redactedTelegramInspection(inspection) {
  return {
    receivedAt: inspection.receivedAt,
    updateIdTail: inspection.updateIdTail,
    messageIdTail: inspection.messageIdTail,
    chatIdTail: inspection.chatIdTail,
    senderIdTail: inspection.senderIdTail,
    chatType: inspection.chatType,
    messageDate: inspection.messageDate,
    freshForRun: inspection.freshForRun,
    authorBot: inspection.authorBot,
    authorBotFalse: inspection.authorBotFalse,
    senderMatched: inspection.senderMatched,
    chatMatched: inspection.chatMatched,
    probeBodyMatched: inspection.probeBodyMatched,
    nonceMatched: inspection.nonceMatched,
    fullProbeMatched: inspection.fullProbeMatched,
    rawTargetMatched: inspection.rawTargetMatched,
    normalizerAccepted: inspection.normalizerAccepted,
  };
}

function recordTelegramUpdate(report, observedEventsByMessageId, update, config) {
  const receivedAtMs = Date.now();
  const inspection = inspectTelegramUpdate(update, config, receivedAtMs);
  const redacted = redactedTelegramInspection(inspection);
  const diagnostics = report.diagnostics.telegramHubAdapter;
  diagnostics.updateCount += 1;
  if (inspection.messageId) diagnostics.messageUpdateCount += 1;
  if (inspection.messageId && !inspection.freshForRun) diagnostics.staleMessageUpdateCount += 1;
  diagnostics.lastUpdate = redacted;
  if (inspection.fullProbeMatched) diagnostics.nonceUpdateCount += 1;
  if (inspection.rawTargetMatched) diagnostics.targetRawUpdateCount += 1;
  if (inspection.messageId && inspection.chatMatched && inspection.freshForRun) {
    observedEventsByMessageId.set(inspection.messageId, {
      update,
      normalized: inspection.normalized,
      receivedAtMs,
      inspection: redacted,
    });
  }
  if (!inspection.rawTargetMatched) return;

  report.criteria.listenerReceivedTelegramMessage = true;
  report.criteria.authorBotFalse = inspection.authorBotFalse;
  report.criteria.senderMatchesTrustedAllowedUser = inspection.senderMatched;
  report.criteria.chatMatchesConfiguredChat = inspection.chatMatched;
  report.criteria.nonceMatched = inspection.nonceMatched;
  report.criteria.normalizerDidNotDrop = inspection.normalizerAccepted;
  report.observedTelegramEvent = {
    type: "TELEGRAM_UPDATE_MESSAGE",
    ...redacted,
  };
  diagnostics.matchedUpdate = redacted;
  return inspection;
}

function createInstrumentedTelegramPollingService(config, report, observedEventsByMessageId) {
  const polling = createTelegramPollingService(config.pollingTimeoutSec);
  return {
    async startPolling(token, onUpdate) {
      await polling.startPolling(token, (update) => {
        const inspection = recordTelegramUpdate(report, observedEventsByMessageId, update, config);
        if (!inspection?.freshForRun) return;
        onUpdate(update);
      });
      report.criteria.pollingConnected = polling.isPolling();
      report.diagnostics.telegramHubAdapter.pollingConnected = polling.isPolling();
    },
    async stopPolling() {
      await polling.stopPolling();
      report.diagnostics.telegramHubAdapter.pollingConnected = false;
    },
    isPolling() {
      return polling.isPolling();
    },
  };
}

function initialReport(config, reportPath) {
  const startedAt = new Date().toISOString();
  return {
    schemaVersion: "friday.phase24c.telegram_trusted_inbound_proof.v1",
    phase: "Phase24C",
    scope: "Telegram live trusted user inbound proof",
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
      pollingTimeoutSec: config.pollingTimeoutSec,
      telegramMode: config.mode,
      acceptAfter: new Date(config.acceptAfterMs).toISOString(),
      configuredChatIdTail: tail(config.chatId),
      configuredAllowedUserIdTail: tail(config.allowedUserId),
      telegramTokenPresent: Boolean(config.botToken),
      probeBodyText: config.probeBodyText,
      probeNonce: config.probeNonce,
      expectedOperatorMessage: config.expectedOperatorMessage,
    },
    criteria: {
      pollingConnected: false,
      listenerReceivedTelegramMessage: false,
      authorBotFalse: false,
      senderMatchesTrustedAllowedUser: false,
      chatMatchesConfiguredChat: false,
      nonceMatched: false,
      normalizerDidNotDrop: false,
      normalizedChannelKindTelegram: false,
      normalizedSenderMatchesTrustedAllowedUser: false,
      normalizedChatMatchesConfiguredChat: false,
      normalizedChatTypeSupported: false,
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
      telegramShortReceiptObserved: false,
      assistantSessionReplyObserved: false,
      evidenceMatchesNonce: false,
      fullEvidenceSurfaceExported: false,
      artifactHasNoToken: false,
    },
    diagnostics: {
      proofSource: "instrumented_hub_polling_adapter_and_current_runner_session",
      telegramHubAdapter: {
        pollingConnected: false,
        realHubAdapterAcceptedMessage: false,
        updateCount: 0,
        messageUpdateCount: 0,
        staleMessageUpdateCount: 0,
        nonceUpdateCount: 0,
        targetRawUpdateCount: 0,
        lastUpdate: null,
        matchedUpdate: null,
      },
      currentRunnerNonceCorrespondence: {
        sourceMessageIdTail: null,
        sessionMirrorMatchesNonce: false,
        sessionMirrorSourceMessageIdMatchesPolling: false,
        runMatchesNonce: false,
        evidenceMatchesNonce: false,
      },
      localNonCurrentRunnerAmbiguityPossible: true,
      cleanupFailures: [],
    },
    observedTelegramEvent: null,
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
  const reportRoot = process.env.PHASE24C_REPORT_ROOT?.trim()
    || (process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, "phase24c-telegram-trusted-inbound") : path.join(os.tmpdir(), "phase24c-telegram-trusted-inbound"));
  return path.join(reportRoot, "phase24c-telegram-trusted-inbound-proof.json");
}

async function waitForRun(baseUrl, receivedAtMs, normalizedMessage, config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const sessionKey = `channel:telegram:${normalizedMessage.chatId}`;
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
  const sessionKey = `channel:telegram:${chatId}`;
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
    const messages = await getSessionMessages(baseUrl, config.chatId);
    const mirror = messages.find((message) =>
      message?.role === "user"
      && message?.metadata?.channelKind === "telegram"
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
  const mode = process.env.FRIDAY_TELEGRAM_MODE?.trim() || "polling";
  const acceptAfterMs = Date.now() - 5_000;
  return {
    botToken: process.env.FRIDAY_TELEGRAM_BOT_TOKEN?.trim() ?? "",
    allowedUserId: process.env.FRIDAY_TELEGRAM_ALLOWED_USER_ID?.trim() ?? "",
    chatId: process.env.FRIDAY_TELEGRAM_CHAT_ID?.trim() ?? "",
    mode,
    timeoutMs: envInteger("PHASE24C_TELEGRAM_LISTENER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    pollingTimeoutSec: envInteger("PHASE24C_TELEGRAM_POLLING_TIMEOUT_SEC", 5),
    acceptAfterMs,
    githubRunId: process.env.GITHUB_RUN_ID?.trim() || null,
    githubSha: process.env.GITHUB_SHA?.trim() || null,
    probeBodyText: PROBE_BODY_TEXT,
    probeNonce,
    probeText,
    expectedOperatorMessage: probeText,
  };
}

function missingRequiredEnv(config) {
  return [
    ["FRIDAY_TELEGRAM_BOT_TOKEN", config.botToken],
    ["FRIDAY_TELEGRAM_ALLOWED_USER_ID", config.allowedUserId],
    ["FRIDAY_TELEGRAM_CHAT_ID", config.chatId],
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
      report.blocker = "PHASE24C_TELEGRAM_ENV_EXPOSURE_BLOCKED";
      report.failures.push(`Missing required env: ${missingEnv.join(", ")}`);
      await writeReport(report, config.botToken);
      process.exitCode = 2;
      return;
    }
    if (config.mode !== "polling") {
      report.status = "blocked";
      report.blocker = "PHASE24C_TELEGRAM_POLLING_MODE_REQUIRED";
      report.failures.push(`Phase24C live proof requires FRIDAY_TELEGRAM_MODE=polling, got ${config.mode}`);
      await writeReport(report, config.botToken);
      process.exitCode = 2;
      return;
    }

    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-phase24c-telegram-"));
    process.env.FRIDAY_CHANNEL_DEBOUNCE_MS = process.env.FRIDAY_CHANNEL_DEBOUNCE_MS ?? "0";
    process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS = process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS ?? "0";

    hub = await createFridayHub({
      stateDir,
      skillDirs: [],
      port: 0,
      logRequests: false,
      // Phase24C proves the live channel adapter by reading the current-runner
      // session mirror. Production/default hubs keep TS session execution
      // fail-closed; this disposable proof harness opts in to the same
      // test-oracle path used by live channel E2E coverage.
      allowTestOnlySessionExecution: true,
      channels: {
        enabled: false,
        instances: [],
      },
    });

    const instrumentedPolling = createInstrumentedTelegramPollingService(config, report, observedEventsByMessageId);
    const telegramPlugin = createFridayTelegramChannel({
      polling: instrumentedPolling,
      webhook: createTelegramWebhookService(),
      api: createTelegramApiService(),
    });
    await telegramPlugin.init({
      kind: "telegram",
      enabled: true,
      botToken: config.botToken,
      mode: "polling",
      allowedUsers: [config.allowedUserId],
      allowedChats: [config.chatId],
    });
    hub.channelRegistry.register(telegramPlugin, {
      allowedUsers: [config.allowedUserId],
      allowedChats: [config.chatId],
    });
    await hub.start();
    const telegramView = hub.channelRegistry.describe("telegram");
    report.criteria.fridayHubChannelConnected = telegramView?.status === "connected" && telegramView?.running === true;
    report.criteria.pollingConnected = instrumentedPolling.isPolling();
    report.diagnostics.telegramHubAdapter.pollingConnected = instrumentedPolling.isPolling();

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

    console.log("PHASE24C_TELEGRAM_LISTENER_READY");
    console.log("Send this in the configured Telegram channel now:");
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
      report.blocker = report.criteria.listenerReceivedTelegramMessage
        ? "PHASE24C_TELEGRAM_HUB_ADAPTER_DID_NOT_CREATE_NONCE_SESSION_MIRROR"
        : "PHASE24C_WAITING_FOR_TRUSTED_USER_MESSAGE";
      report.diagnostics.localNonCurrentRunnerAmbiguityPossible = true;
      report.failures.push(`No current-runner user session mirror for nonce ${config.probeNonce} appeared within ${config.timeoutMs}ms`);
      await writeReport(report, config.botToken);
      process.exitCode = 2;
      return;
    }

    const sourceMessageId = mirror.metadata?.sourceMessageId;
    report.diagnostics.currentRunnerNonceCorrespondence.sourceMessageIdTail = tail(sourceMessageId);
    const observed = typeof sourceMessageId === "string" ? observedEventsByMessageId.get(sourceMessageId) : null;
    report.diagnostics.currentRunnerNonceCorrespondence.sessionMirrorSourceMessageIdMatchesPolling = Boolean(observed);

    if (!observed) {
      report.status = "blocked";
      report.blocker = "PHASE24C_TELEGRAM_CURRENT_LISTENER_SOURCE_EVENT_NOT_FOUND";
      report.diagnostics.localNonCurrentRunnerAmbiguityPossible = true;
      report.failures.push("Current runner session mirror matched the nonce, but the instrumented Telegram polling adapter did not record the same sourceMessageId");
      await writeReport(report, config.botToken);
      process.exitCode = 2;
      return;
    }

    const { normalized, receivedAtMs, inspection } = observed;
    if (!inspection?.rawTargetMatched) {
      report.status = "failed";
      report.blocker = "PHASE24C_TELEGRAM_SESSION_MIRROR_SOURCE_NOT_TRUSTED_TARGET";
      report.diagnostics.localNonCurrentRunnerAmbiguityPossible = true;
      report.failures.push("Session mirror sourceMessageId matched a polling update, but that update did not satisfy trusted sender/chat/nonce checks");
      await writeReport(report, config.botToken);
      process.exitCode = 1;
      return;
    }

    if (!normalized) {
      report.status = "failed";
      report.blocker = "PHASE24C_TELEGRAM_NORMALIZER_DROPPED_TRUSTED_USER_MESSAGE";
      report.failures.push("Telegram update matched trusted sender/chat but Friday normalizer returned null");
      await writeReport(report, config.botToken);
      process.exitCode = 1;
      return;
    }

    report.criteria.realHubAdapterAcceptedMessage = true;
    report.diagnostics.telegramHubAdapter.realHubAdapterAcceptedMessage = true;
    report.criteria.normalizedChannelKindTelegram = normalized.channelKind === "telegram";
    report.criteria.normalizedSenderMatchesTrustedAllowedUser = normalized.senderId === config.allowedUserId;
    report.criteria.normalizedChatMatchesConfiguredChat = normalized.chatId === config.chatId;
    report.criteria.normalizedChatTypeSupported = normalized.chatType === "direct" || normalized.chatType === "group";
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
      report.blocker = "PHASE24C_TELEGRAM_SHARED_STATE_MACHINE_RUN_NOT_FOUND";
      report.failures.push("Trusted Telegram message was normalized but no matching Friday channel-origin run appeared");
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
    report.criteria.telegramShortReceiptObserved = Boolean(assistantReply?.metadata?.sourceMessageId);
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
      "pollingConnected",
      "listenerReceivedTelegramMessage",
      "authorBotFalse",
      "senderMatchesTrustedAllowedUser",
      "chatMatchesConfiguredChat",
      "nonceMatched",
      "normalizerDidNotDrop",
      "normalizedChannelKindTelegram",
      "normalizedSenderMatchesTrustedAllowedUser",
      "normalizedChatMatchesConfiguredChat",
      "normalizedChatTypeSupported",
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
        ? "PHASE24C_TELEGRAM_TRUSTED_INBOUND_ACCEPTANCE_FAILED"
        : "PHASE24C_TELEGRAM_SHARED_STATE_MACHINE_NOT_AWAITING_HUMAN";
    }

    await writeReport(report, config.botToken);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    report.status = "failed";
    report.blocker = "PHASE24C_TELEGRAM_LISTENER_HARNESS_ERROR";
    report.failures.push(safeError(error, config?.botToken ?? ""));
    await writeReport(report, config?.botToken ?? "").catch(() => {});
    process.exitCode = 1;
  } finally {
    const cleanupFailures = [];
    if (server) {
      await withTimeout(server.close(), 5_000, "http_server_close").catch((error) => {
        cleanupFailures.push(safeError(error, config?.botToken ?? ""));
      });
    }
    if (hub) {
      await withTimeout(hub.stop(), 5_000, "hub_stop").catch((error) => {
        cleanupFailures.push(safeError(error, config?.botToken ?? ""));
      });
    }
    if (stateDir) {
      await withTimeout(fs.rm(stateDir, { recursive: true, force: true }), 5_000, "state_dir_cleanup").catch((error) => {
        cleanupFailures.push(safeError(error, config?.botToken ?? ""));
      });
    }
    if (cleanupFailures.length > 0) {
      report.diagnostics.cleanupFailures = cleanupFailures;
      await writeReport(report, config?.botToken ?? "").catch(() => {});
      if (process.exitCode === 0 || process.exitCode === undefined) process.exitCode = 1;
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      process.exit(process.exitCode ?? 0);
    }
  }
}

main();
