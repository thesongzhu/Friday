#!/usr/bin/env node
/**
 * Phase24G Lark/Feishu channel-driven workflow-candidate approve/reject proof.
 *
 * Proves real Lark/Feishu websocket inbound -> real hub Reflex command handler
 * -> real candidate approve/reject state changes -> real workflow CRUD save on
 * approve and no save on reject -> real Lark/Feishu ack. The LLM bridge is
 * intentionally stubbed and recorded as such.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFridayHttpServer } from "#api";
import { createFridayLarkChannel } from "#channels";
import { createFridayHub } from "#hub";

import {
  buildWorkflowNonce,
  envInteger,
  findFreePort,
  installWorkflowApprovalStub,
  listWorkflowsByTag,
  seedWorkflowCandidates,
  tail,
  withTimeout,
  waitForCandidateAck,
  waitForCandidateStatus,
} from "./lib/workflow-candidate-proof-harness.mjs";
import {
  containsTokenMaterial as containsTokenMaterialShared,
  scrub as scrubShared,
} from "./lib/token-redaction.mjs";

const PHASE_KEY = "phase24g";
const PHASE_LABEL = "Phase24G";
const WORKFLOW_TAG = "phase24g-channel-approval";
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const FEISHU_BASE_URL = "https://open.feishu.cn";
const LARK_BASE_URL = "https://open.larksuite.com";
const LARK_REDACTION_LABELS = Object.freeze({
  tokenLabel: "[REDACTED_LARK_APP_SECRET]",
  prefixLabel: "[REDACTED_LARK_APP_SECRET_PREFIX]",
});

function envBoolean(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function buildRejectOperatorMessage(candidateId, config) {
  return `reject reflex ${candidateId} ${config.rejectNonce}`;
}

function buildApproveOperatorMessage(candidateId) {
  return `approve reflex ${candidateId}`;
}

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
  if (tokens.length === 0) return scrubShared(value, "", LARK_REDACTION_LABELS);
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
  return scrub(raw, token);
}

function shouldForceProcessExitAfterCleanup(env = process.env) {
  return env.PHASE24G_DISABLE_FORCE_EXIT !== "true";
}

function readEnvConfig() {
  const useFeishu = envBoolean("FRIDAY_LARK_USE_FEISHU", false);
  const platformBrand = useFeishu ? "feishu" : "lark";
  const platformDisplayName = useFeishu ? "Feishu" : "Lark";
  const platformBaseUrl = useFeishu ? FEISHU_BASE_URL : LARK_BASE_URL;
  const receiveMode = process.env.FRIDAY_LARK_RECEIVE_MODE?.trim() || "websocket";
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
    timeoutMs: envInteger("PHASE24G_LARK_FEISHU_LISTENER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    acceptAfterMs: Date.now() - 5_000,
    githubRunId: process.env.GITHUB_RUN_ID?.trim() || null,
    githubSha: process.env.GITHUB_SHA?.trim() || null,
    rejectCandidateId: process.env.PHASE24G_LARK_FEISHU_REJECT_CANDIDATE_ID?.trim() || null,
    approveCandidateId: process.env.PHASE24G_LARK_FEISHU_APPROVE_CANDIDATE_ID?.trim() || null,
    rejectNonce: buildWorkflowNonce(PHASE_KEY, "reject", "PHASE24G_LARK_FEISHU_REJECT_NONCE"),
    approveNonce: buildWorkflowNonce(PHASE_KEY, "approve", "PHASE24G_LARK_FEISHU_APPROVE_NONCE"),
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

function inspectLarkFeishuEvent(rawEvent, normalized, config, receivedAtMs = Date.now()) {
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
  const authorBot = senderType !== null && senderType !== "user";
  const authorBotFalse = senderType === "user";
  const normalizedText = typeof normalized?.text === "string" ? normalized.text : "";
  const containsRejectCommand = normalizedText.startsWith("reject reflex");
  const containsApproveCommand = normalizedText.startsWith("approve reflex");
  const containsRejectNonce = normalizedText.includes(config.rejectNonce);
  const senderMatched = senderId.length > 0 && senderId === config.allowedUserId;
  const chatMatched = chatId.length > 0 && chatId === config.chatId;
  const createTime = typeof message?.create_time === "string" ? Number.parseInt(message.create_time, 10) : null;
  const messageDateMs = Number.isFinite(createTime) ? createTime : null;
  const freshForRun = typeof messageDateMs === "number" && messageDateMs >= config.acceptAfterMs;
  const rawTargetMatched = authorBotFalse
    && senderMatched
    && chatMatched
    && freshForRun
    && (containsRejectCommand || containsApproveCommand);

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
    containsRejectCommand,
    containsApproveCommand,
    containsRejectNonce,
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
    containsRejectCommand: inspection.containsRejectCommand,
    containsApproveCommand: inspection.containsApproveCommand,
    containsRejectNonce: inspection.containsRejectNonce,
    rawTargetMatched: inspection.rawTargetMatched,
    normalizerAccepted: inspection.normalizerAccepted,
  };
}

function recordLarkFeishuEvent(report, observedEventsByMessageId, rawEvent, normalized, config) {
  const inspection = inspectLarkFeishuEvent(rawEvent, normalized, config, Date.now());
  const redacted = redactedLarkFeishuInspection(inspection);
  const diagnostics = report.diagnostics.larkFeishuHubAdapter;
  diagnostics.eventCount += 1;
  if (inspection.messageId) diagnostics.messageEventCount += 1;
  if (inspection.messageId && !inspection.freshForRun) diagnostics.staleMessageEventCount += 1;
  if (inspection.rawTargetMatched) diagnostics.targetRawEventCount += 1;
  diagnostics.lastEvent = redacted;
  if (inspection.messageId && inspection.chatMatched && inspection.freshForRun) {
    observedEventsByMessageId.set(inspection.messageId, {
      rawEvent,
      normalized: inspection.normalized,
      receivedAtMs: inspection.receivedAtMs,
      inspection: redacted,
    });
  }
  if (!inspection.rawTargetMatched) return inspection;

  report.observedLarkFeishuEvent = {
    type: "LARK_FEISHU_MESSAGE_RECEIVE_V1",
    ...redacted,
  };
  diagnostics.matchedEvent = redacted;
  return inspection;
}

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

function resolveReportPath() {
  const reportRoot = process.env.PHASE24G_REPORT_ROOT?.trim()
    || (process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, "phase24g-lark-feishu-workflow-candidate")
      : path.join(os.tmpdir(), "phase24g-lark-feishu-workflow-candidate"));
  return path.join(reportRoot, "phase24g-lark-feishu-workflow-candidate-proof.json");
}

function initialReport(config, reportPath) {
  return {
    schemaVersion: "friday.phase24g.lark_feishu_workflow_candidate_approval_rejection_proof.v1",
    phase: PHASE_LABEL,
    scope: "Lark/Feishu channel-driven workflow-candidate approve/reject live proof (LLM bridge stubbed)",
    status: "running",
    blocker: null,
    startedAt: new Date().toISOString(),
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
      configuredRejectCandidateIdTail: tail(config.rejectCandidateId),
      configuredApproveCandidateIdTail: tail(config.approveCandidateId),
      rejectNonce: config.rejectNonce,
      approveNonce: config.approveNonce,
      workflowGeneratorApproveAndSaveStubbed: true,
      llmBridgeBoundary: "stubbed_to_bypass_live_llm_workflow_save_via_real_crud_only",
    },
    criteria: {
      wsClientConnected: false,
      fridayHubChannelConnected: false,
      channelAllowListEnforced: false,
      rejectCandidateSeeded: false,
      approveCandidateSeeded: false,
      rejectInboundObserved: false,
      rejectAckDelivered: false,
      rejectCandidateStatusRejected: false,
      rejectDidNotSaveWorkflow: false,
      approveInboundObserved: false,
      approveAckDelivered: false,
      approveCandidateStatusApproved: false,
      approveSavedWorkflow: false,
      workflowVisibleInCrud: false,
      artifactHasNoToken: false,
    },
    diagnostics: {
      proofSource: "instrumented_hub_lark_feishu_wsclient_plus_seeded_reflex_candidates",
      platformBrand: config.platformBrand,
      platformDisplayName: config.platformDisplayName,
      larkFeishuHubAdapter: {
        platformBrand: config.platformBrand,
        wsClientConnected: false,
        eventCount: 0,
        messageEventCount: 0,
        staleMessageEventCount: 0,
        targetRawEventCount: 0,
        lastEvent: null,
        matchedEvent: null,
      },
      cleanupFailures: [],
      llmBridgeBoundary: "stubbed_to_bypass_live_llm_workflow_save_via_real_crud_only",
    },
    observedLarkFeishuEvent: null,
    rejectFlow: {
      candidateIdTail: null,
      candidateStatusReached: null,
      ackDelivered: false,
      workflowSavedAfter: false,
    },
    approveFlow: {
      candidateIdTail: null,
      candidateStatusReached: null,
      ackDelivered: false,
      workflowSaved: false,
      workflowIdTail: null,
      workflowVersionIdTail: null,
    },
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

async function main() {
  const config = readEnvConfig();
  const reportPath = resolveReportPath();
  const report = initialReport(config, reportPath);
  let hub;
  let server;
  let stateDir = "";
  const observedEventsByMessageId = new Map();
  const approvedSlot = { workflowId: null, workflowVersionId: null };

  try {
    const missingEnv = missingRequiredEnv(config);
    if (missingEnv.length > 0) {
      report.status = "blocked";
      report.blocker = "PHASE24G_LARK_FEISHU_ENV_EXPOSURE_BLOCKED";
      report.failures.push(`Missing required env: ${missingEnv.join(", ")}`);
      await writeReport(report, config.appSecret);
      process.exitCode = 2;
      return;
    }
    if (config.receiveMode !== "websocket") {
      report.status = "blocked";
      report.blocker = "PHASE24G_LARK_FEISHU_WEBSOCKET_MODE_REQUIRED";
      report.failures.push(`Phase24G live proof requires FRIDAY_LARK_RECEIVE_MODE=websocket, got ${config.receiveMode}`);
      await writeReport(report, config.appSecret);
      process.exitCode = 2;
      return;
    }

    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-phase24g-lark-feishu-"));
    process.env.FRIDAY_CHANNEL_DEBOUNCE_MS = process.env.FRIDAY_CHANNEL_DEBOUNCE_MS ?? "0";
    process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS = process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS ?? "0";

    hub = await createFridayHub({
      stateDir,
      skillDirs: [],
      port: 0,
      logRequests: false,
      // Phase24G verifies candidate acks via the current-runner session mirror.
      // Production/default hubs keep TS session execution fail-closed; this
      // disposable proof harness opts in to the same test-oracle path used by
      // live channel E2E coverage.
      allowTestOnlySessionExecution: true,
      channels: { enabled: false, instances: [] },
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
    const allowlistSummary = larkView?.allowlist;
    report.criteria.channelAllowListEnforced =
      allowlistSummary?.hasAllowedUsers === true
      && (allowlistSummary?.allowedUsersCount ?? 0) > 0
      && allowlistSummary?.hasAllowedChats === true
      && (allowlistSummary?.allowedChatsCount ?? 0) > 0;

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

    const harnessConfig = {
      phaseKey: PHASE_KEY,
      phaseLabel: PHASE_LABEL,
      channelKind: config.platformBrand,
      channelDisplayName: config.platformDisplayName,
      channelUserId: config.allowedUserId,
      workflowTag: WORKFLOW_TAG,
      rejectNonce: config.rejectNonce,
      approveNonce: config.approveNonce,
      rejectCandidateId: config.rejectCandidateId,
      approveCandidateId: config.approveCandidateId,
    };
    const { rejectCandidateId, approveCandidateId, generatorSessionId } = await seedWorkflowCandidates(stateDir, harnessConfig);
    report.criteria.rejectCandidateSeeded = true;
    report.criteria.approveCandidateSeeded = true;
    report.rejectFlow.candidateIdTail = tail(rejectCandidateId);
    report.approveFlow.candidateIdTail = tail(approveCandidateId);
    installWorkflowApprovalStub(hub, harnessConfig, generatorSessionId, approvedSlot);

    await writeReport(report, config.appSecret);

    const rejectText = buildRejectOperatorMessage(rejectCandidateId, config);
    const approveText = buildApproveOperatorMessage(approveCandidateId);
    console.log("PHASE24G_LARK_FEISHU_LISTENER_READY");
    console.log(`Step 1 — from the configured trusted ${config.platformDisplayName} user, send this exact text in the configured chat:`);
    console.log(rejectText);
    console.log("After the reject ack arrives, send Step 2:");
    console.log(approveText);

    const perFlowTimeout = Math.max(60_000, Math.floor(config.timeoutMs / 2));
    const rejectAck = await waitForCandidateAck(baseUrl, config.platformBrand, config.chatId, rejectCandidateId, "rejected", perFlowTimeout);
    if (!rejectAck) {
      report.status = "blocked";
      report.blocker = "PHASE24G_WAITING_FOR_REJECT_ACK";
      report.failures.push(`Reject ack for candidate ${tail(rejectCandidateId)} not observed within ${perFlowTimeout}ms`);
      await writeReport(report, config.appSecret);
      process.exitCode = 2;
      return;
    }
    report.criteria.rejectAckDelivered = true;
    report.rejectFlow.ackDelivered = true;

    const rejectCandidate = await waitForCandidateStatus(stateDir, rejectCandidateId, "rejected", 30_000);
    report.rejectFlow.candidateStatusReached = rejectCandidate?.status ?? null;
    report.criteria.rejectCandidateStatusRejected = rejectCandidate?.status === "rejected";
    const workflowsAfterReject = listWorkflowsByTag(hub, WORKFLOW_TAG);
    report.criteria.rejectDidNotSaveWorkflow = workflowsAfterReject.length === 0;
    report.rejectFlow.workflowSavedAfter = workflowsAfterReject.length > 0;
    report.criteria.rejectInboundObserved = Boolean(
      [...observedEventsByMessageId.values()].find((entry) => entry?.inspection?.containsRejectCommand),
    );

    if (!report.criteria.rejectCandidateStatusRejected || !report.criteria.rejectDidNotSaveWorkflow) {
      report.status = "failed";
      report.blocker = "PHASE24G_REJECT_PATH_INVARIANTS_BROKEN";
      report.failures.push("Reject path did not satisfy invariants (status=rejected AND no workflow saved)");
      await writeReport(report, config.appSecret);
      process.exitCode = 1;
      return;
    }

    const approveAck = await waitForCandidateAck(baseUrl, config.platformBrand, config.chatId, approveCandidateId, "approved", perFlowTimeout);
    if (!approveAck) {
      report.status = "blocked";
      report.blocker = "PHASE24G_WAITING_FOR_APPROVE_ACK";
      report.failures.push(`Approve ack for candidate ${tail(approveCandidateId)} not observed within ${perFlowTimeout}ms`);
      await writeReport(report, config.appSecret);
      process.exitCode = 2;
      return;
    }
    report.criteria.approveAckDelivered = true;
    report.approveFlow.ackDelivered = true;

    const approveCandidate = await waitForCandidateStatus(stateDir, approveCandidateId, "approved", 30_000);
    report.approveFlow.candidateStatusReached = approveCandidate?.status ?? null;
    report.criteria.approveCandidateStatusApproved = approveCandidate?.status === "approved";
    const workflowsAfterApprove = listWorkflowsByTag(hub, WORKFLOW_TAG);
    report.criteria.workflowVisibleInCrud = workflowsAfterApprove.length === 1;
    report.criteria.approveSavedWorkflow = Boolean(approvedSlot.workflowId);
    report.approveFlow.workflowSaved = Boolean(approvedSlot.workflowId);
    report.approveFlow.workflowIdTail = tail(approvedSlot.workflowId);
    report.approveFlow.workflowVersionIdTail = tail(approvedSlot.workflowVersionId);
    report.criteria.approveInboundObserved = Boolean(
      [...observedEventsByMessageId.values()].find((entry) => entry?.inspection?.containsApproveCommand),
    );

    const requiredCriteria = [
      "wsClientConnected",
      "fridayHubChannelConnected",
      "channelAllowListEnforced",
      "rejectCandidateSeeded",
      "approveCandidateSeeded",
      "rejectInboundObserved",
      "rejectAckDelivered",
      "rejectCandidateStatusRejected",
      "rejectDidNotSaveWorkflow",
      "approveInboundObserved",
      "approveAckDelivered",
      "approveCandidateStatusApproved",
      "approveSavedWorkflow",
      "workflowVisibleInCrud",
      "artifactHasNoToken",
    ];
    report.failures = requiredCriteria.filter((key) => report.criteria[key] !== true);
    report.status = report.failures.length === 0 ? "passed" : "failed";
    if (report.status !== "passed") {
      report.blocker = "PHASE24G_LARK_FEISHU_WORKFLOW_CANDIDATE_REQUIRED_CRITERIA_NOT_MET";
    }

    await writeReport(report, config.appSecret);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    report.status = "failed";
    report.blocker = "PHASE24G_LARK_FEISHU_LISTENER_HARNESS_ERROR";
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
    if (shouldForceProcessExitAfterCleanup()) {
      process.exit(process.exitCode ?? 0);
    }
  }
}

export {
  buildApproveOperatorMessage,
  buildRejectOperatorMessage,
  containsTokenMaterial,
  initialReport,
  inspectLarkFeishuEvent,
  missingRequiredEnv,
  readEnvConfig,
  resolveReportPath,
  scrub,
  shouldForceProcessExitAfterCleanup,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
