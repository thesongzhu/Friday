#!/usr/bin/env node
/**
 * Phase24F Discord channel-driven workflow-candidate approve/reject live proof.
 *
 * Proves real Discord inbound -> real hub Reflex command handler -> real
 * candidate approve/reject state changes -> real workflow CRUD save on approve
 * and no save on reject -> real Discord ack. The workflow-generator LLM bridge
 * is intentionally stubbed; the artifact records that boundary explicitly.
 */

import fs from "node:fs/promises";
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

const PHASE_KEY = "phase24f";
const PHASE_LABEL = "Phase24F";
const WORKFLOW_TAG = "phase24f-channel-approval";
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const DISCORD_GUILDS = 1 << 0;
const DISCORD_GUILD_MESSAGES = 1 << 9;
const DISCORD_DIRECT_MESSAGES = 1 << 12;
const DISCORD_MESSAGE_CONTENT = 1 << 15;
const REQUIRED_INTENTS = DISCORD_GUILDS | DISCORD_GUILD_MESSAGES | DISCORD_DIRECT_MESSAGES | DISCORD_MESSAGE_CONTENT;
const DISCORD_REDACTION_LABELS = Object.freeze({
  tokenLabel: "[REDACTED_DISCORD_BOT_TOKEN]",
  prefixLabel: "[REDACTED_DISCORD_BOT_TOKEN_PREFIX]",
});

function envBoolean(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function hasMention(payload, botUserId) {
  return Array.isArray(payload?.mentions) && payload.mentions.some((mention) => mention?.id === botUserId);
}

function buildRejectOperatorMessage(candidateId, config) {
  const mentionSuffix = config.requireMention ? ` <@${config.botUserId}>` : "";
  return `reject reflex ${candidateId} ${config.rejectNonce}${mentionSuffix}`;
}

function buildApproveOperatorMessage(candidateId, config) {
  const mentionSuffix = config.requireMention ? ` <@${config.botUserId}>` : "";
  return `approve reflex ${candidateId}${mentionSuffix}`;
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

function readEnvConfig() {
  const botUserId = process.env.FRIDAY_DISCORD_BOT_USER_ID?.trim() ?? "";
  return {
    botToken: process.env.FRIDAY_DISCORD_BOT_TOKEN?.trim() ?? "",
    setupUserId: process.env.FRIDAY_DISCORD_SETUP_USER_ID?.trim() ?? "",
    guildId: process.env.FRIDAY_DISCORD_GUILD_ID?.trim() ?? "",
    channelId: process.env.FRIDAY_DISCORD_CHANNEL_ID?.trim() ?? "",
    botUserId,
    requireMention: envBoolean("FRIDAY_DISCORD_REQUIRE_MENTION", true),
    timeoutMs: envInteger("PHASE24F_DISCORD_LISTENER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    acceptAfterMs: Date.now() - 5_000,
    githubRunId: process.env.GITHUB_RUN_ID?.trim() || null,
    githubSha: process.env.GITHUB_SHA?.trim() || null,
    rejectCandidateId: process.env.PHASE24F_DISCORD_REJECT_CANDIDATE_ID?.trim() || null,
    approveCandidateId: process.env.PHASE24F_DISCORD_APPROVE_CANDIDATE_ID?.trim() || null,
    rejectNonce: buildWorkflowNonce(PHASE_KEY, "reject", "PHASE24F_DISCORD_REJECT_NONCE"),
    approveNonce: buildWorkflowNonce(PHASE_KEY, "approve", "PHASE24F_DISCORD_APPROVE_NONCE"),
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

function inspectDiscordPayload(payload, config, receivedAtMs = Date.now()) {
  const content = String(payload?.content ?? "");
  const messageTimeMs = Number.isFinite(Date.parse(payload?.timestamp ?? "")) ? Date.parse(payload.timestamp) : null;
  const freshForRun = typeof messageTimeMs === "number" && messageTimeMs >= config.acceptAfterMs;
  const mentionMatched = !config.requireMention || hasMention(payload, config.botUserId);
  const authorBotFalse = payload?.author?.bot !== true;
  const senderMatched = payload?.author?.id === config.setupUserId;
  const channelMatched = payload?.channel_id === config.channelId;
  const containsRejectCommand = content.startsWith("reject reflex");
  const containsApproveCommand = content.startsWith("approve reflex");
  const containsRejectNonce = content.includes(config.rejectNonce);
  let normalized = null;
  if (payload?.id && payload?.author) {
    normalized = normalizeDiscordMessageCreate(payload, config.requireMention, config.botUserId);
  }
  const rawTargetMatched = authorBotFalse
    && senderMatched
    && channelMatched
    && freshForRun
    && mentionMatched
    && (containsRejectCommand || containsApproveCommand);
  return {
    receivedAt: new Date(receivedAtMs).toISOString(),
    receivedAtMs,
    messageId: typeof payload?.id === "string" ? payload.id : null,
    messageIdTail: tail(payload?.id),
    channelIdTail: tail(payload?.channel_id),
    guildIdTail: tail(payload?.guild_id),
    senderIdTail: tail(payload?.author?.id),
    messageDate: typeof messageTimeMs === "number" ? new Date(messageTimeMs).toISOString() : null,
    freshForRun,
    authorBot: payload?.author?.bot === true,
    authorBotFalse,
    senderMatched,
    channelMatched,
    mentionMatched,
    containsRejectCommand,
    containsApproveCommand,
    containsRejectNonce,
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
    messageDate: inspection.messageDate,
    freshForRun: inspection.freshForRun,
    authorBot: inspection.authorBot,
    authorBotFalse: inspection.authorBotFalse,
    senderMatched: inspection.senderMatched,
    channelMatched: inspection.channelMatched,
    mentionMatched: inspection.mentionMatched,
    containsRejectCommand: inspection.containsRejectCommand,
    containsApproveCommand: inspection.containsApproveCommand,
    containsRejectNonce: inspection.containsRejectNonce,
    rawTargetMatched: inspection.rawTargetMatched,
    normalizerAccepted: inspection.normalizerAccepted,
  };
}

function recordDiscordMessageCreate(report, observedEventsByMessageId, payload, config) {
  const inspection = inspectDiscordPayload(payload, config, Date.now());
  const redacted = redactedDiscordInspection(inspection);
  const diagnostics = report.diagnostics.discordHubAdapter;
  diagnostics.messageCreateCount += 1;
  if (inspection.messageId) diagnostics.messageEventCount += 1;
  if (inspection.messageId && !inspection.freshForRun) diagnostics.staleMessageEventCount += 1;
  if (inspection.rawTargetMatched) diagnostics.targetRawMessageCreateCount += 1;
  diagnostics.lastMessageCreate = redacted;
  if (inspection.messageId && inspection.channelMatched && inspection.freshForRun) {
    observedEventsByMessageId.set(inspection.messageId, {
      payload,
      normalized: inspection.normalized,
      receivedAtMs: inspection.receivedAtMs,
      inspection: redacted,
    });
  }
  if (!inspection.rawTargetMatched) return inspection;

  report.observedDiscordEvent = {
    type: "DISCORD_MESSAGE_CREATE",
    ...redacted,
  };
  diagnostics.matchedMessageCreate = redacted;
  return inspection;
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

function resolveReportPath() {
  const reportRoot = process.env.PHASE24F_REPORT_ROOT?.trim()
    || (process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, "phase24f-discord-workflow-candidate")
      : path.join(os.tmpdir(), "phase24f-discord-workflow-candidate"));
  return path.join(reportRoot, "phase24f-discord-workflow-candidate-proof.json");
}

function initialReport(config, reportPath) {
  return {
    schemaVersion: "friday.phase24f.discord_workflow_candidate_approval_rejection_proof.v1",
    phase: PHASE_LABEL,
    scope: "Discord channel-driven workflow-candidate approve/reject live proof (LLM bridge stubbed)",
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
      requireMention: config.requireMention,
      acceptAfter: new Date(config.acceptAfterMs).toISOString(),
      configuredGuildIdTail: tail(config.guildId),
      configuredChannelIdTail: tail(config.channelId),
      configuredSetupUserIdTail: tail(config.setupUserId),
      configuredBotUserIdTail: tail(config.botUserId),
      discordTokenPresent: Boolean(config.botToken),
      configuredRejectCandidateIdTail: tail(config.rejectCandidateId),
      configuredApproveCandidateIdTail: tail(config.approveCandidateId),
      rejectNonce: config.rejectNonce,
      approveNonce: config.approveNonce,
      workflowGeneratorApproveAndSaveStubbed: true,
      llmBridgeBoundary: "stubbed_to_bypass_live_llm_workflow_save_via_real_crud_only",
    },
    criteria: {
      gatewayConnected: false,
      fridayHubChannelConnected: false,
      channelAllowListEnforced: false,
      requireMentionSatisfied: !config.requireMention,
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
      proofSource: "instrumented_hub_discord_gateway_plus_seeded_reflex_candidates",
      discordHubAdapter: {
        gatewayConnected: false,
        messageCreateCount: 0,
        messageEventCount: 0,
        staleMessageEventCount: 0,
        targetRawMessageCreateCount: 0,
        lastMessageCreate: null,
        matchedMessageCreate: null,
      },
      cleanupFailures: [],
      llmBridgeBoundary: "stubbed_to_bypass_live_llm_workflow_save_via_real_crud_only",
    },
    observedDiscordEvent: null,
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
      report.blocker = "PHASE24F_DISCORD_ENV_EXPOSURE_BLOCKED";
      report.failures.push(`Missing required env: ${missingEnv.join(", ")}`);
      await writeReport(report, config.botToken);
      process.exitCode = 2;
      return;
    }

    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-phase24f-discord-"));
    process.env.FRIDAY_CHANNEL_DEBOUNCE_MS = process.env.FRIDAY_CHANNEL_DEBOUNCE_MS ?? "0";
    process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS = process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS ?? "0";

    hub = await createFridayHub({
      stateDir,
      skillDirs: [],
      port: 0,
      logRequests: false,
      channels: { enabled: false, instances: [] },
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
    const allowlistSummary = discordView?.allowlist;
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
      channelKind: "discord",
      channelDisplayName: "Discord",
      channelUserId: config.setupUserId,
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

    await writeReport(report, config.botToken);

    const rejectText = buildRejectOperatorMessage(rejectCandidateId, config);
    const approveText = buildApproveOperatorMessage(approveCandidateId, config);
    console.log("PHASE24F_DISCORD_LISTENER_READY");
    console.log("Step 1 — from the configured trusted Discord user, send this exact text in the configured channel:");
    console.log(rejectText);
    console.log("After the reject ack arrives, send Step 2:");
    console.log(approveText);

    const perFlowTimeout = Math.max(60_000, Math.floor(config.timeoutMs / 2));
    const rejectAck = await waitForCandidateAck(baseUrl, "discord", config.channelId, rejectCandidateId, "rejected", perFlowTimeout);
    if (!rejectAck) {
      report.status = "blocked";
      report.blocker = "PHASE24F_WAITING_FOR_REJECT_ACK";
      report.failures.push(`Reject ack for candidate ${tail(rejectCandidateId)} not observed within ${perFlowTimeout}ms`);
      await writeReport(report, config.botToken);
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
    report.criteria.requireMentionSatisfied = !config.requireMention || Boolean(
      [...observedEventsByMessageId.values()].find((entry) => entry?.inspection?.mentionMatched),
    );

    if (!report.criteria.rejectCandidateStatusRejected || !report.criteria.rejectDidNotSaveWorkflow) {
      report.status = "failed";
      report.blocker = "PHASE24F_REJECT_PATH_INVARIANTS_BROKEN";
      report.failures.push("Reject path did not satisfy invariants (status=rejected AND no workflow saved)");
      await writeReport(report, config.botToken);
      process.exitCode = 1;
      return;
    }

    const approveAck = await waitForCandidateAck(baseUrl, "discord", config.channelId, approveCandidateId, "approved", perFlowTimeout);
    if (!approveAck) {
      report.status = "blocked";
      report.blocker = "PHASE24F_WAITING_FOR_APPROVE_ACK";
      report.failures.push(`Approve ack for candidate ${tail(approveCandidateId)} not observed within ${perFlowTimeout}ms`);
      await writeReport(report, config.botToken);
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
      "gatewayConnected",
      "fridayHubChannelConnected",
      "channelAllowListEnforced",
      "requireMentionSatisfied",
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
      report.blocker = "PHASE24F_DISCORD_WORKFLOW_CANDIDATE_REQUIRED_CRITERIA_NOT_MET";
    }

    await writeReport(report, config.botToken);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    report.status = "failed";
    report.blocker = "PHASE24F_DISCORD_LISTENER_HARNESS_ERROR";
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
  }
}

export {
  buildApproveOperatorMessage,
  buildRejectOperatorMessage,
  containsTokenMaterial,
  initialReport,
  inspectDiscordPayload,
  missingRequiredEnv,
  readEnvConfig,
  resolveReportPath,
  scrub,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
