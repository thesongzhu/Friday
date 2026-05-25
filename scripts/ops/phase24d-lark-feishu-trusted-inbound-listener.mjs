#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createFridayHttpServer } from "#api";
import {
  createFridayLarkChannel,
} from "#channels";
import { createFridayHub } from "#hub";

import {
  containsTokenMaterial as containsTokenMaterialShared,
  scrub as scrubShared,
} from "./lib/token-redaction.mjs";

const PROBE_BODY_TEXT = "help me clean up old files in my workspace; ask me before doing anything";
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const AWAITING_STATES = new Set(["awaiting_clarification", "awaiting_plan_approval"]);
const UNIFIED_TASK_STATE_SCHEMA_VERSION = "friday.agent.unified_task_state.v1";

const LARK_REDACTION_LABELS = Object.freeze({
  tokenLabel: "[REDACTED_LARK_APP_SECRET]",
  prefixLabel: "[REDACTED_LARK_APP_SECRET_PREFIX]",
});

const FEISHU_BASE_URL = "https://open.feishu.cn";
const LARK_BASE_URL = "https://open.larksuite.com";

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
  const explicit = process.env.PHASE24D_LARK_FEISHU_PROBE_NONCE?.trim();
  if (explicit) return sanitizeNoncePart(explicit, "phase24d-run-explicit");
  const runId = sanitizeNoncePart(process.env.GITHUB_RUN_ID, "local");
  const sha = sanitizeNoncePart((process.env.GITHUB_SHA ?? "local").slice(0, 8), "local");
  return `phase24d-run-${runId}-${sha}`;
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

// Lark/Feishu secrets covered by every redaction step. `appSecret` is required;
// `verificationToken` and `encryptKey` are optional per lark-config.schema.ts
// but if present in env they must also be redacted from any serialized output.
function collectLarkSecrets(primaryToken) {
  const seen = new Set();
  const tokens = [];
  const push = (candidate) => {
    if (typeof candidate === "string" && candidate.length > 0 && !seen.has(candidate)) {
      seen.add(candidate);
      tokens.push(candidate);
    }
  };
  push(primaryToken);
  push(process.env.FRIDAY_LARK_APP_SECRET?.trim());
  push(process.env.FRIDAY_LARK_VERIFICATION_TOKEN?.trim());
  push(process.env.FRIDAY_LARK_ENCRYPT_KEY?.trim());
  return tokens;
}

function scrub(value, token) {
  const tokens = collectLarkSecrets(token);
  if (tokens.length === 0) {
    return scrubShared(value, "", LARK_REDACTION_LABELS);
  }
  let current = value;
  for (const candidate of tokens) {
    current = scrubShared(current, candidate, LARK_REDACTION_LABELS);
  }
  return current;
}

function containsTokenMaterial(serialized, token) {
  const tokens = collectLarkSecrets(token);
  for (const candidate of tokens) {
    if (containsTokenMaterialShared(serialized, candidate)) return true;
  }
  return false;
}

function serializeScrubbedJson(value, token) {
  const serialized = `${JSON.stringify(scrub(value, token), null, 2)}\n`;
  if (containsTokenMaterial(serialized, token)) {
    throw new Error("Refusing to write artifact because it contains the Lark app secret");
  }
  return serialized;
}

function safeError(error, token) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // scrub() folds in process.env-derived secrets, so callers in early-failure
  // branches (where `config` is undefined) still get full redaction coverage.
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

function inspectLarkFeishuEvent(rawEvent, normalized, config, receivedAtMs) {
  const data = rawEvent && typeof rawEvent === "object" ? rawEvent : {};
  const eventData = (data.event && typeof data.event === "object") ? data.event : data;
  const message = (eventData.message && typeof eventData.message === "object") ? eventData.message : null;
  const sender = (eventData.sender && typeof eventData.sender === "object") ? eventData.sender : null;
  const senderIdRecord = sender && typeof sender.sender_id === "object" ? sender.sender_id : null;
  const senderId = typeof senderIdRecord?.open_id === "string"
    ? senderIdRecord.open_id
    : (typeof senderIdRecord?.user_id === "string" ? senderIdRecord.user_id : "");
  const chatId = typeof message?.chat_id === "string" ? message.chat_id : "";
  const chatType = typeof message?.chat_type === "string" ? message.chat_type : null;
  const messageId = typeof message?.message_id === "string" ? message.message_id : null;
  const senderType = typeof sender?.sender_type === "string" ? sender.sender_type : null;
  // Lark sender_type values: "user", "app", "anonymous", "bot". Treat anything other than "user" as bot.
  const authorBot = senderType !== null && senderType !== "user";
  const authorBotFalse = senderType === "user";

  const normalizedText = typeof normalized?.text === "string" ? normalized.text : "";
  const probeBodyMatched = normalizedText.includes(config.probeBodyText);
  const nonceMatched = normalizedText.includes(config.probeNonce);
  const senderMatched = senderId.length > 0 && senderId === config.allowedUserId;
  const chatMatched = chatId.length > 0 && chatId === config.chatId;
  const createTime = typeof message?.create_time === "string" ? Number.parseInt(message.create_time, 10) : null;
  const messageDateMs = Number.isFinite(createTime) ? createTime : null;
  // Match phase24c semantics: a missing/unparseable timestamp must NOT count as fresh.
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
    messageId,
    messageIdTail: tail(messageId),
    chatIdTail: tail(chatId),
    senderIdTail: tail(senderId),
    chatType,
    senderType,
    messageDate: messageDateMs !== null ? new Date(messageDateMs).toISOString() : null,
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

function redactedLarkFeishuInspection(inspection) {
  return {
    receivedAt: inspection.receivedAt,
    messageIdTail: inspection.messageIdTail,
    chatIdTail: inspection.chatIdTail,
    senderIdTail: inspection.senderIdTail,
    chatType: inspection.chatType,
    senderType: inspection.senderType,
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

function recordLarkFeishuEvent(report, observedEventsByMessageId, rawEvent, normalized, config) {
  const receivedAtMs = Date.now();
  const inspection = inspectLarkFeishuEvent(rawEvent, normalized, config, receivedAtMs);
  const redacted = redactedLarkFeishuInspection(inspection);
  const diagnostics = report.diagnostics.larkFeishuHubAdapter;
  diagnostics.eventCount += 1;
  if (inspection.messageId) diagnostics.messageEventCount += 1;
  if (inspection.messageId && !inspection.freshForRun) diagnostics.staleMessageEventCount += 1;
  diagnostics.lastEvent = redacted;
  if (inspection.fullProbeMatched) diagnostics.nonceEventCount += 1;
  if (inspection.rawTargetMatched) diagnostics.targetRawEventCount += 1;
  if (inspection.messageId && inspection.chatMatched && inspection.freshForRun) {
    observedEventsByMessageId.set(inspection.messageId, {
      rawEvent,
      normalized: inspection.normalized,
      receivedAtMs,
      inspection: redacted,
    });
  }
  if (!inspection.rawTargetMatched) return inspection;

  report.criteria.listenerReceivedMessageReceive = true;
  report.criteria.authorBotFalse = inspection.authorBotFalse;
  report.criteria.senderMatchesTrustedAllowedUser = inspection.senderMatched;
  report.criteria.chatMatchesConfiguredChat = inspection.chatMatched;
  report.criteria.nonceMatched = inspection.nonceMatched;
  report.criteria.normalizerDidNotDrop = inspection.normalizerAccepted;
  report.observedLarkFeishuEvent = {
    type: "LARK_FEISHU_MESSAGE_RECEIVE_V1",
    ...redacted,
  };
  diagnostics.matchedEvent = redacted;
  return inspection;
}

/**
 * Instrument the real `createFridayLarkChannel` plugin without refactoring it.
 * We replace `adapters.lifecycle.connect(onEvent)` with a wrapped version that:
 *  - notes WSClient connect resolution → wsClientConnected
 *  - records every raw event for observation
 *  - delegates to the plugin's original inbound adapter to normalize, and
 *    forwards the event to the original onEvent handler so hub-side
 *    acceptance (session mirror / runs / evidence) is exercised exactly once.
 * The plugin's own internal WSClient is the only Lark connection; we do not
 * open a second one. This respects the "no refactor of friday-lark-channel.ts"
 * constraint by wrapping the public adapter surface from the outside.
 */
function instrumentLarkFeishuPlugin(plugin, config, report, observedEventsByMessageId) {
  const originalLifecycle = plugin.adapters.lifecycle;
  const originalInbound = plugin.adapters.inbound;
  if (!originalLifecycle || !originalInbound) {
    throw new Error("createFridayLarkChannel plugin is missing required lifecycle/inbound adapters");
  }
  const wrappedLifecycle = {
    async connect(onEvent) {
      const wrappedOnEvent = (rawEvent) => {
        let normalized = null;
        try {
          normalized = originalInbound.normalize(rawEvent);
        } catch {
          normalized = null;
        }
        recordLarkFeishuEvent(report, observedEventsByMessageId, rawEvent, normalized, config);
        onEvent(rawEvent);
      };
      await originalLifecycle.connect(wrappedOnEvent);
      report.criteria.wsClientConnected = true;
      report.diagnostics.larkFeishuHubAdapter.wsClientConnected = true;
    },
    async disconnect() {
      await originalLifecycle.disconnect();
      report.diagnostics.larkFeishuHubAdapter.wsClientConnected = false;
    },
    ...(typeof originalLifecycle.reconnect === "function"
      ? { reconnect: () => originalLifecycle.reconnect.call(originalLifecycle) }
      : {}),
  };
  return {
    ...plugin,
    adapters: {
      ...plugin.adapters,
      lifecycle: wrappedLifecycle,
    },
  };
}

function initialReport(config, reportPath) {
  const startedAt = new Date().toISOString();
  return {
    schemaVersion: "friday.phase24d.lark_feishu_trusted_inbound_proof.v1",
    phase: "Phase24D",
    scope: "Lark/Feishu live trusted user inbound proof",
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
      platformBrand: config.platformBrand,
      platformDisplayName: config.platformDisplayName,
      platformBaseUrl: config.platformBaseUrl,
      useFeishu: config.useFeishu,
      receiveMode: config.receiveMode,
      acceptAfter: new Date(config.acceptAfterMs).toISOString(),
      configuredChatIdTail: tail(config.chatId),
      configuredGroupChatIdTail: tail(config.groupChatId),
      configuredAllowedUserIdTail: tail(config.allowedUserId),
      larkAppIdTail: tail(config.appId),
      larkAppSecretPresent: Boolean(config.appSecret),
      probeBodyText: config.probeBodyText,
      probeNonce: config.probeNonce,
      expectedOperatorMessage: config.expectedOperatorMessage,
    },
    criteria: {
      wsClientConnected: false,
      listenerReceivedMessageReceive: false,
      authorBotFalse: false,
      senderMatchesTrustedAllowedUser: false,
      chatMatchesConfiguredChat: false,
      nonceMatched: false,
      normalizerDidNotDrop: false,
      normalizedChannelKindMatchesBrand: false,
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
      larkFeishuShortReceiptObserved: false,
      assistantSessionReplyObserved: false,
      evidenceMatchesNonce: false,
      fullEvidenceSurfaceExported: false,
      artifactHasNoToken: false,
    },
    diagnostics: {
      proofSource: "instrumented_hub_wsclient_adapter_and_current_runner_session",
      platformBrand: config.platformBrand,
      platformDisplayName: config.platformDisplayName,
      larkFeishuHubAdapter: {
        platformBrand: config.platformBrand,
        wsClientConnected: false,
        realHubAdapterAcceptedMessage: false,
        eventCount: 0,
        messageEventCount: 0,
        staleMessageEventCount: 0,
        nonceEventCount: 0,
        targetRawEventCount: 0,
        lastEvent: null,
        matchedEvent: null,
      },
      currentRunnerNonceCorrespondence: {
        sourceMessageIdTail: null,
        sessionMirrorMatchesNonce: false,
        sessionMirrorSourceMessageIdMatchesWsClient: false,
        runMatchesNonce: false,
        evidenceMatchesNonce: false,
      },
      localNonCurrentRunnerAmbiguityPossible: true,
      cleanupFailures: [],
    },
    observedLarkFeishuEvent: null,
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
  const reportRoot = process.env.PHASE24D_REPORT_ROOT?.trim()
    || (process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, "phase24d-lark-feishu-trusted-inbound") : path.join(os.tmpdir(), "phase24d-lark-feishu-trusted-inbound"));
  return path.join(reportRoot, "phase24d-lark-feishu-trusted-inbound-proof.json");
}

async function waitForRun(baseUrl, receivedAtMs, normalizedMessage, config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const sessionKey = `channel:${config.platformBrand}:${normalizedMessage.chatId}`;
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

    await delay(1500);
  }

  return lastCandidate;
}

async function getSessionMessages(baseUrl, chatOrMessage, config) {
  const chatId = typeof chatOrMessage === "string" ? chatOrMessage : chatOrMessage.chatId;
  const sessionKey = `channel:${config.platformBrand}:${chatId}`;
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
    const messages = await getSessionMessages(baseUrl, config.chatId, config);
    const mirror = messages.find((message) =>
      message?.role === "user"
      && message?.metadata?.channelKind === config.platformBrand
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
    const messages = await getSessionMessages(baseUrl, normalizedMessage, config);
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
  const useFeishu = envBoolean("FRIDAY_LARK_USE_FEISHU", false);
  const platformBrand = useFeishu ? "feishu" : "lark";
  const platformDisplayName = useFeishu ? "Feishu" : "Lark";
  const platformBaseUrl = useFeishu ? FEISHU_BASE_URL : LARK_BASE_URL;
  const receiveMode = process.env.FRIDAY_LARK_RECEIVE_MODE?.trim() || "websocket";
  const acceptAfterMs = Date.now() - 5_000;
  return {
    appId: process.env.FRIDAY_LARK_APP_ID?.trim() ?? "",
    appSecret: process.env.FRIDAY_LARK_APP_SECRET?.trim() ?? "",
    chatId: process.env.FRIDAY_LARK_CHAT_ID?.trim() ?? "",
    groupChatId: process.env.FRIDAY_LARK_GROUP_CHAT_ID?.trim() ?? "",
    allowedUserId: process.env.FRIDAY_LARK_ALLOWED_USER_ID?.trim() ?? "",
    useFeishu,
    platformBrand,
    platformDisplayName,
    platformBaseUrl,
    receiveMode,
    timeoutMs: envInteger("PHASE24D_LARK_FEISHU_LISTENER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
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
    ["FRIDAY_LARK_APP_ID", config.appId],
    ["FRIDAY_LARK_APP_SECRET", config.appSecret],
    ["FRIDAY_LARK_CHAT_ID", config.chatId],
    ["FRIDAY_LARK_ALLOWED_USER_ID", config.allowedUserId],
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
      report.blocker = "PHASE24D_LARK_FEISHU_ENV_EXPOSURE_BLOCKED";
      report.failures.push(`Missing required env: ${missingEnv.join(", ")}`);
      await writeReport(report, config.appSecret);
      process.exitCode = 2;
      return;
    }
    if (config.receiveMode !== "websocket") {
      report.status = "blocked";
      report.blocker = "PHASE24D_LARK_FEISHU_WEBSOCKET_MODE_REQUIRED";
      report.failures.push(`Phase24D live proof requires FRIDAY_LARK_RECEIVE_MODE=websocket, got ${config.receiveMode}`);
      await writeReport(report, config.appSecret);
      process.exitCode = 2;
      return;
    }

    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-phase24d-lark-feishu-"));
    process.env.FRIDAY_CHANNEL_DEBOUNCE_MS = process.env.FRIDAY_CHANNEL_DEBOUNCE_MS ?? "0";
    process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS = process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS ?? "0";

    hub = await createFridayHub({
      stateDir,
      skillDirs: [],
      port: 0,
      logRequests: false,
      channels: {
        enabled: false,
        instances: [],
      },
    });

    const realPlugin = createFridayLarkChannel();
    await realPlugin.init({
      kind: config.platformBrand,
      enabled: true,
      appId: config.appId,
      appSecret: config.appSecret,
      useFeishu: config.useFeishu,
      receiveMode: "websocket",
      allowedUsers: [config.allowedUserId],
      allowedChats: [config.chatId],
    });
    const instrumentedPlugin = instrumentLarkFeishuPlugin(realPlugin, config, report, observedEventsByMessageId);
    hub.channelRegistry.register(instrumentedPlugin, {
      allowedUsers: [config.allowedUserId],
      allowedChats: [config.chatId],
    });
    await hub.start();
    const larkView = hub.channelRegistry.describe(config.platformBrand);
    report.criteria.fridayHubChannelConnected = larkView?.status === "connected" && larkView?.running === true;

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

    await writeReport(report, config.appSecret);

    console.log("PHASE24D_LARK_FEISHU_LISTENER_READY");
    console.log(`Send this in the configured ${config.platformDisplayName} channel now:`);
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
      report.blocker = report.criteria.listenerReceivedMessageReceive
        ? "PHASE24D_LARK_FEISHU_HUB_ADAPTER_DID_NOT_CREATE_NONCE_SESSION_MIRROR"
        : "PHASE24D_WAITING_FOR_TRUSTED_USER_MESSAGE";
      report.diagnostics.localNonCurrentRunnerAmbiguityPossible = true;
      report.failures.push(`No current-runner user session mirror for nonce ${config.probeNonce} appeared within ${config.timeoutMs}ms`);
      await writeReport(report, config.appSecret);
      process.exitCode = 2;
      return;
    }

    const sourceMessageId = mirror.metadata?.sourceMessageId;
    report.diagnostics.currentRunnerNonceCorrespondence.sourceMessageIdTail = tail(sourceMessageId);
    const observed = typeof sourceMessageId === "string" ? observedEventsByMessageId.get(sourceMessageId) : null;
    report.diagnostics.currentRunnerNonceCorrespondence.sessionMirrorSourceMessageIdMatchesWsClient = Boolean(observed);

    if (!observed) {
      report.status = "blocked";
      report.blocker = "PHASE24D_LARK_FEISHU_CURRENT_LISTENER_SOURCE_EVENT_NOT_FOUND";
      report.diagnostics.localNonCurrentRunnerAmbiguityPossible = true;
      report.failures.push("Current runner session mirror matched the nonce, but the instrumented WSClient adapter did not record the same sourceMessageId");
      await writeReport(report, config.appSecret);
      process.exitCode = 2;
      return;
    }

    const { normalized, receivedAtMs, inspection } = observed;
    if (!inspection?.rawTargetMatched) {
      report.status = "failed";
      report.blocker = "PHASE24D_LARK_FEISHU_SESSION_MIRROR_SOURCE_NOT_TRUSTED_TARGET";
      report.diagnostics.localNonCurrentRunnerAmbiguityPossible = true;
      report.failures.push("Session mirror sourceMessageId matched a WSClient event, but that event did not satisfy trusted sender/chat/nonce checks");
      await writeReport(report, config.appSecret);
      process.exitCode = 1;
      return;
    }

    if (!normalized) {
      report.status = "failed";
      report.blocker = "PHASE24D_LARK_FEISHU_NORMALIZER_DROPPED_TRUSTED_USER_MESSAGE";
      report.failures.push(`${config.platformDisplayName} message_receive matched trusted sender/chat but Friday normalizer returned null`);
      await writeReport(report, config.appSecret);
      process.exitCode = 1;
      return;
    }

    report.criteria.realHubAdapterAcceptedMessage = true;
    report.diagnostics.larkFeishuHubAdapter.realHubAdapterAcceptedMessage = true;
    report.criteria.normalizedChannelKindMatchesBrand = normalized.channelKind === config.platformBrand;
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
    await writeReport(report, config.appSecret);

    const run = await waitForRun(baseUrl, receivedAtMs, normalized, config, Math.min(config.timeoutMs, 180_000));
    if (!run?.id) {
      report.status = "failed";
      report.blocker = "PHASE24D_LARK_FEISHU_SHARED_STATE_MACHINE_RUN_NOT_FOUND";
      report.failures.push(`Trusted ${config.platformDisplayName} message was normalized but no matching Friday channel-origin run appeared`);
      await writeReport(report, config.appSecret);
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
    const finalSessionMessages = await getSessionMessages(baseUrl, normalized, config);
    const exportedEvidenceFiles = [
      await writeEvidenceArtifact(report, config.appSecret, "friday-agent-run-response.json", runDetails),
      await writeEvidenceArtifact(report, config.appSecret, "friday-agent-run-audit-response.json", audit),
      await writeEvidenceArtifact(report, config.appSecret, "friday-session-messages-response.json", { items: finalSessionMessages }),
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
    report.criteria.larkFeishuShortReceiptObserved = Boolean(assistantReply?.metadata?.sourceMessageId);
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
    report.criteria.artifactHasNoToken = !containsTokenMaterial(JSON.stringify(scrub(report, config.appSecret)), config.appSecret);

    const requiredCriteria = [
      "wsClientConnected",
      "listenerReceivedMessageReceive",
      "authorBotFalse",
      "senderMatchesTrustedAllowedUser",
      "chatMatchesConfiguredChat",
      "nonceMatched",
      "normalizerDidNotDrop",
      "normalizedChannelKindMatchesBrand",
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
        ? "PHASE24D_LARK_FEISHU_TRUSTED_INBOUND_ACCEPTANCE_FAILED"
        : "PHASE24D_LARK_FEISHU_SHARED_STATE_MACHINE_NOT_AWAITING_HUMAN";
    }

    await writeReport(report, config.appSecret);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    report.status = "failed";
    report.blocker = "PHASE24D_LARK_FEISHU_LISTENER_HARNESS_ERROR";
    report.failures.push(safeError(error, config?.appSecret ?? ""));
    await writeReport(report, config?.appSecret ?? "").catch(() => {});
    process.exitCode = 1;
  } finally {
    const cleanupFailures = [];
    if (server) {
      await withTimeout(server.close(), 5_000, "http_server_close").catch((error) => {
        cleanupFailures.push(safeError(error, config?.appSecret ?? ""));
      });
    }
    if (hub) {
      await withTimeout(hub.stop(), 5_000, "hub_stop").catch((error) => {
        cleanupFailures.push(safeError(error, config?.appSecret ?? ""));
      });
    }
    if (stateDir) {
      await withTimeout(fs.rm(stateDir, { recursive: true, force: true }), 5_000, "state_dir_cleanup").catch((error) => {
        cleanupFailures.push(safeError(error, config?.appSecret ?? ""));
      });
    }
    if (cleanupFailures.length > 0) {
      report.diagnostics.cleanupFailures = cleanupFailures;
      await writeReport(report, config?.appSecret ?? "").catch(() => {});
      if (process.exitCode === 0 || process.exitCode === undefined) process.exitCode = 1;
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      process.exit(process.exitCode ?? 0);
    }
  }
}

// Export hooks for unit tests (no behavior change for direct CLI invocation).
export {
  buildProbeNonce,
  containsTokenMaterial,
  initialReport,
  missingRequiredEnv,
  readEnvConfig,
  resolveReportPath,
  scrub,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
