#!/usr/bin/env node
/**
 * Phase24E Telegram channel-driven workflow-candidate approve/reject live proof.
 *
 * What this listener proves
 * -------------------------
 * - Real Telegram channel inbound -> real hub command handler -> real
 *   `reflexService.rejectCandidate` / `reflexService.approveCandidate` ->
 *   real workflow CRUD save (for approve) or no-save (for reject) -> real
 *   channel ack reflecting the exact outcome.
 *
 * What this listener does NOT prove
 * ---------------------------------
 * - Live LLM generation. To avoid live provider spend without explicit
 *   authorization, the listener installs the same stub on
 *   `hub.workflowGenerator.approveAndSave` that the existing local proof in
 *   `test/unit/hub/friday-hub-bootstrap.test.ts` uses. The downstream
 *   `workflowRuntime.crud` insert is real; the LLM bridge call is bypassed.
 *   The artifact records `workflowGeneratorApproveAndSaveStubbed: true` so no
 *   reader can mistake this for a live-LLM proof.
 * - Discord or Lark+Feishu channel-driven approval/rejection. This listener
 *   covers Telegram only; the other two channels remain proof_pending under
 *   the existing C2 boundary in the Friday Map.
 * - Channel-driven natural-trigger execution (memory recall + workflow_list +
 *   workflow_run via channel). That requires real agent runtime which needs
 *   either live LLM authorization or a separate deterministic-agent design
 *   decision and is held back as C2.2.
 *
 * Operator-driven flow
 * --------------------
 * The run prompts the operator (in the configured Telegram chat) to send
 * two messages from the trusted setup user:
 *
 *   Step 1: `reject reflex <rejectCandidateId> <rejectNonce>`
 *   Step 2: `approve reflex <approveCandidateId>`
 *
 * Both candidates are seeded via direct DB insert against the hub's SQLite
 * store before the listener prints instructions. The trusted user id, chat
 * id and bot token come from the GitHub Actions `phase-24-live-channels`
 * environment.
 *
 * The artifact JSON written at the end matches the validator schema
 * `friday.phase24e.telegram_workflow_candidate_approval_rejection_proof.v1`
 * and is validated by `scripts/ops/validate-channel-proof-artifacts.mjs`
 * via the `--telegram-workflow-candidate <path>` flag.
 */

import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { createFridayHttpServer } from "#api";
import {
  createTelegramApiService,
  createTelegramPollingService,
  createTelegramWebhookService,
  createFridayTelegramChannel,
  normalizeTelegramUpdate,
} from "#channels";
import { createFridayHub } from "#hub";
import { createFridayReflexCandidateRepository } from "#reflex";

import {
  containsTokenMaterial as containsTokenMaterialShared,
  scrub as scrubShared,
} from "./lib/token-redaction.mjs";

const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const TELEGRAM_REDACTION_LABELS = Object.freeze({
  tokenLabel: "[REDACTED_TELEGRAM_BOT_TOKEN]",
  prefixLabel: "[REDACTED_TELEGRAM_BOT_TOKEN_PREFIX]",
});
const WORKFLOW_TAG = "phase24e-channel-approval";
const LEARNING_DEFAULT_USER_ID = "admin-001";

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

function buildNonce(kind, explicitEnvVar) {
  const explicit = process.env[explicitEnvVar]?.trim();
  if (explicit) return sanitizeNoncePart(explicit, `phase24e-${kind}-explicit`);
  const runId = sanitizeNoncePart(process.env.GITHUB_RUN_ID, "local");
  const sha = sanitizeNoncePart((process.env.GITHUB_SHA ?? "local").slice(0, 8), "local");
  return `phase24e-${kind}-run-${runId}-${sha}`;
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

function readEnvConfig() {
  const rejectNonce = buildNonce("reject", "PHASE24E_TELEGRAM_REJECT_NONCE");
  const approveNonce = buildNonce("approve", "PHASE24E_TELEGRAM_APPROVE_NONCE");
  const mode = process.env.FRIDAY_TELEGRAM_MODE?.trim() || "polling";
  const acceptAfterMs = Date.now() - 5_000;
  return {
    botToken: process.env.FRIDAY_TELEGRAM_BOT_TOKEN?.trim() ?? "",
    allowedUserId: process.env.FRIDAY_TELEGRAM_ALLOWED_USER_ID?.trim() ?? "",
    chatId: process.env.FRIDAY_TELEGRAM_CHAT_ID?.trim() ?? "",
    mode,
    timeoutMs: envInteger("PHASE24E_TELEGRAM_LISTENER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    pollingTimeoutSec: envInteger("PHASE24E_TELEGRAM_POLLING_TIMEOUT_SEC", 5),
    acceptAfterMs,
    githubRunId: process.env.GITHUB_RUN_ID?.trim() || null,
    githubSha: process.env.GITHUB_SHA?.trim() || null,
    rejectNonce,
    approveNonce,
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

function inspectTelegramUpdate(update, config, receivedAtMs) {
  const message = update?.message ?? null;
  const content = String(message?.text ?? "");
  const authorBot = message?.from?.is_bot === true;
  const authorBotFalse = Boolean(message?.from) && !authorBot;
  const senderId = message?.from?.id === undefined ? "" : String(message.from.id);
  const chatId = message?.chat?.id === undefined ? "" : String(message.chat.id);
  const senderMatched = senderId === config.allowedUserId;
  const chatMatched = chatId === config.chatId;
  const containsRejectNonce = content.includes(config.rejectNonce);
  const containsApproveCommand = content.startsWith("approve reflex");
  const containsRejectCommand = content.startsWith("reject reflex");
  const normalized = normalizeTelegramUpdate(update);
  const messageId = message?.message_id === undefined ? null : String(message.message_id);
  const messageDateMs = Number.isFinite(message?.date) ? message.date * 1000 : null;
  const freshForRun = typeof messageDateMs === "number" && messageDateMs >= config.acceptAfterMs;
  return {
    receivedAt: new Date(receivedAtMs).toISOString(),
    receivedAtMs,
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
    containsRejectCommand,
    containsApproveCommand,
    containsRejectNonce,
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
    containsRejectCommand: inspection.containsRejectCommand,
    containsApproveCommand: inspection.containsApproveCommand,
    containsRejectNonce: inspection.containsRejectNonce,
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
  diagnostics.lastUpdate = redacted;
  if (inspection.messageId
      && inspection.chatMatched
      && inspection.senderMatched
      && inspection.freshForRun
      && (inspection.containsRejectCommand || inspection.containsApproveCommand)) {
    observedEventsByMessageId.set(inspection.messageId, {
      update,
      normalized: inspection.normalized,
      receivedAtMs,
      inspection: redacted,
    });
    report.observedTelegramEvent = {
      type: "TELEGRAM_UPDATE_MESSAGE",
      ...redacted,
    };
  }
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

function resolveReportPath() {
  const reportRoot = process.env.PHASE24E_REPORT_ROOT?.trim()
    || (process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, "phase24e-telegram-workflow-candidate")
      : path.join(os.tmpdir(), "phase24e-telegram-workflow-candidate"));
  return path.join(reportRoot, "phase24e-telegram-workflow-candidate-proof.json");
}

function initialReport(config, reportPath) {
  const startedAt = new Date().toISOString();
  return {
    schemaVersion: "friday.phase24e.telegram_workflow_candidate_approval_rejection_proof.v1",
    phase: "Phase24E",
    scope: "Telegram channel-driven workflow-candidate approve/reject live proof (LLM bridge stubbed)",
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
      telegramMode: config.mode,
      acceptAfter: new Date(config.acceptAfterMs).toISOString(),
      configuredChatIdTail: tail(config.chatId),
      configuredAllowedUserIdTail: tail(config.allowedUserId),
      telegramTokenPresent: Boolean(config.botToken),
      rejectNonce: config.rejectNonce,
      approveNonce: config.approveNonce,
      workflowGeneratorApproveAndSaveStubbed: true,
      llmBridgeBoundary: "stubbed_to_bypass_live_llm_workflow_save_via_real_crud_only",
    },
    criteria: {
      pollingConnected: false,
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
      proofSource: "instrumented_hub_polling_adapter_plus_seeded_reflex_candidates",
      telegramHubAdapter: {
        pollingConnected: false,
        updateCount: 0,
        messageUpdateCount: 0,
        lastUpdate: null,
      },
      cleanupFailures: [],
      llmBridgeBoundary: "stubbed_to_bypass_live_llm_workflow_save_via_real_crud_only",
    },
    observedTelegramEvent: null,
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

function seedWorkflowCandidates(stateDir, config) {
  const candidateRepo = createFridayReflexCandidateRepository();
  const rejectCandidateId = `phase24e-reject-${Date.now()}`;
  const approveCandidateId = `phase24e-approve-${Date.now()}`;
  const generatorSessionId = `phase24e-approve-session-${Date.now()}`;
  const db = new Database(path.join(stateDir, "friday.db"));
  try {
    const nowIso = new Date().toISOString();
    candidateRepo.insert(db, {
      id: rejectCandidateId,
      nowIso,
      userId: LEARNING_DEFAULT_USER_ID,
      kind: "workflow",
      origin: "post_run",
      status: "ready_for_review",
      sourceRunId: `phase24e-run-reject-${Date.now()}`,
      sessionKey: `phase24e-session-reject`,
      channelKind: "telegram",
      channelUserId: config.allowedUserId,
      title: "Phase24E reject candidate (LLM-bridge-stubbed)",
      summary: `Phase24E reject scenario nonce ${config.rejectNonce}`,
      payload: {
        goal: "Trusted Telegram reject reflex command must transition this candidate to rejected and save NO workflow.",
        phase24eScenario: "reject",
        nonce: config.rejectNonce,
      },
      evidence: {
        generatorSessionId: `phase24e-reject-session-${Date.now()}`,
        priorRecipeCandidate: true,
        mode: "phase24e_live_channel_fixture",
        validationOk: true,
        qaVerdict: { status: "passed", source: "phase24e_fixture" },
        harness: { status: "passed", source: "phase24e_fixture" },
      },
      confidence: 0.91,
      riskTier: 3,
    });
    candidateRepo.insert(db, {
      id: approveCandidateId,
      nowIso,
      userId: LEARNING_DEFAULT_USER_ID,
      kind: "workflow",
      origin: "post_run",
      status: "ready_for_review",
      sourceRunId: `phase24e-run-approve-${Date.now()}`,
      sessionKey: `phase24e-session-approve`,
      channelKind: "telegram",
      channelUserId: config.allowedUserId,
      title: "Phase24E approve candidate (LLM-bridge-stubbed)",
      summary: `Phase24E approve scenario nonce ${config.approveNonce}`,
      payload: {
        goal: "Trusted Telegram approve reflex command must transition this candidate to approved and save a workflow via real CRUD (LLM bridge stubbed).",
        phase24eScenario: "approve",
        nonce: config.approveNonce,
      },
      evidence: {
        generatorSessionId,
        priorRecipeCandidate: true,
        mode: "phase24e_live_channel_fixture",
        validationOk: true,
        qaVerdict: { status: "passed", source: "phase24e_fixture" },
        harness: { status: "passed", source: "phase24e_fixture" },
      },
      confidence: 0.91,
      riskTier: 3,
    });
    return { rejectCandidateId, approveCandidateId, generatorSessionId };
  } finally {
    db.close();
  }
}

function makeApprovedWorkflowGraph() {
  return {
    schemaVersion: "friday.workflow.graph.v1",
    nodes: [
      {
        id: "start",
        type: "start",
        next: ["end"],
        config: {},
      },
      {
        id: "end",
        type: "end",
        next: [],
        config: {},
      },
    ],
    edges: [],
  };
}

function installWorkflowApprovalStub(hub, generatorSessionId, approvedSlot) {
  // Mirror the established test pattern from
  // test/unit/hub/friday-hub-bootstrap.test.ts: bypass the LLM-backed
  // generator session and finalize the approve path through real
  // workflowRuntime.crud. The LLM bridge is the only stubbed seam; the
  // approval gate, candidate state machine, channel command parsing, and
  // CRUD persistence remain production code.
  const original = hub.workflowGenerator.approveAndSave.bind(hub.workflowGenerator);
  hub.workflowGenerator.approveAndSave = async (sessionId) => {
    if (sessionId !== generatorSessionId) {
      // Fall back to the real path for anything we didn't pre-stage; this
      // ensures we don't silently mask other approval errors.
      return original(sessionId);
    }
    const { workflow, version } = hub.workflowRuntime.crud.createWorkflowWithVersion(
      {
        slug: "phase24e-channel-approved-workflow",
        name: "Phase24E channel-approved workflow",
        description: "Deterministic workflow saved after trusted Telegram approve reflex command (Phase24E live proof).",
        tags: [WORKFLOW_TAG],
        ownerUserId: LEARNING_DEFAULT_USER_ID,
      },
      makeApprovedWorkflowGraph(),
      LEARNING_DEFAULT_USER_ID,
      "Approved through trusted Telegram channel Reflex command — Phase24E live proof.",
    );
    const published = hub.workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);
    approvedSlot.workflowId = workflow.id;
    approvedSlot.workflowVersionId = published.id;
    return {
      sessionId,
      workflowId: workflow.id,
      workflowVersionId: published.id,
      versionNumber: published.versionNumber,
      slug: workflow.slug,
      published: true,
      publicationBoundary: {
        stage: "published_version",
        lifecyclePromotion: "not_lifecycle_promoted",
        proofBoundary: "crud_publish_only_phase24e_llm_bridge_stubbed",
        summary:
          "Phase24E live-channel proof: real channel command -> real reflex approval gate -> stubbed LLM bridge -> real CRUD save.",
      },
    };
  };
}

function readCandidateFromDb(stateDir, candidateId) {
  // Reviewer A finding: the public HTTP route `/v1/reflex/candidates/:id`
  // hydrates the default-public principal whose userId differs from the
  // `admin-001` userId we seeded under, so `service.getCandidate` filters
  // it out and throws REFLEX_CANDIDATE_NOT_FOUND. Reading the candidate
  // directly from the SQLite store via the same repository the listener
  // already uses sidesteps the principal scoping without changing any
  // production behavior.
  const candidateRepo = createFridayReflexCandidateRepository();
  const db = new Database(path.join(stateDir, "friday.db"));
  try {
    return candidateRepo.getById(db, { userId: LEARNING_DEFAULT_USER_ID, id: candidateId });
  } finally {
    db.close();
  }
}

async function getSessionMessages(baseUrl, chatId) {
  const sessionKey = `channel:telegram:${chatId}`;
  const encoded = encodeURIComponent(sessionKey);
  const response = await apiFetch(baseUrl, "GET", `/v1/sessions/${encoded}/messages?limit=60`).catch(() => null);
  return Array.isArray(response?.items)
    ? response.items
    : Array.isArray(response?.messages)
      ? response.messages
      : [];
}

async function waitForCandidateAck(baseUrl, chatId, candidateId, expectedStatusWord, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const needle = `Reflex candidate ${candidateId} 已更新为 ${expectedStatusWord}`;
  while (Date.now() < deadline) {
    const messages = await getSessionMessages(baseUrl, chatId);
    const found = messages.find((message) =>
      message?.role === "assistant"
      && typeof message?.contentText === "string"
      && message.contentText.includes(needle)
    );
    if (found) return found;
    await delay(1500);
  }
  return null;
}

async function waitForCandidateStatus(stateDir, candidateId, expectedStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    let candidate;
    try {
      candidate = readCandidateFromDb(stateDir, candidateId);
    } catch {
      candidate = null;
    }
    lastSeen = candidate?.status ?? lastSeen;
    if (candidate?.status === expectedStatus) return candidate;
    await delay(1500);
  }
  return { status: lastSeen };
}

function listWorkflowsByTag(hub) {
  return hub.workflowRuntime.crud.listWorkflows({ tag: WORKFLOW_TAG, archived: false });
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
      report.blocker = "PHASE24E_TELEGRAM_ENV_EXPOSURE_BLOCKED";
      report.failures.push(`Missing required env: ${missingEnv.join(", ")}`);
      await writeReport(report, config.botToken);
      process.exitCode = 2;
      return;
    }
    if (config.mode !== "polling") {
      report.status = "blocked";
      report.blocker = "PHASE24E_TELEGRAM_POLLING_MODE_REQUIRED";
      report.failures.push(`Phase24E live proof requires FRIDAY_TELEGRAM_MODE=polling, got ${config.mode}`);
      await writeReport(report, config.botToken);
      process.exitCode = 2;
      return;
    }

    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-phase24e-telegram-"));
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
    // Reviewer A finding: FridayChannelRegistryView only exposes the
    // allowlist as boolean+count summary, not the raw arrays. Use that
    // shape (defense-in-depth: also confirm we just passed a non-empty
    // allowlist into register() above, which the registry summary
    // reflects).
    const allowlistSummary = telegramView?.allowlist;
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

    const { rejectCandidateId, approveCandidateId, generatorSessionId } = seedWorkflowCandidates(stateDir, config);
    report.criteria.rejectCandidateSeeded = true;
    report.criteria.approveCandidateSeeded = true;
    report.rejectFlow.candidateIdTail = tail(rejectCandidateId);
    report.approveFlow.candidateIdTail = tail(approveCandidateId);

    installWorkflowApprovalStub(hub, generatorSessionId, approvedSlot);

    await writeReport(report, config.botToken);

    console.log("PHASE24E_TELEGRAM_LISTENER_READY");
    console.log("Step 1 — from the configured trusted Telegram account, send this exact text in the configured chat:");
    console.log(`reject reflex ${rejectCandidateId} ${config.rejectNonce}`);
    console.log("After the reject ack arrives, send Step 2:");
    console.log(`approve reflex ${approveCandidateId}`);

    // ─── Reject flow ───
    const perFlowTimeout = Math.max(60_000, Math.floor(config.timeoutMs / 2));
    const rejectAck = await waitForCandidateAck(baseUrl, config.chatId, rejectCandidateId, "rejected", perFlowTimeout);
    if (!rejectAck) {
      report.status = "blocked";
      report.blocker = "PHASE24E_WAITING_FOR_REJECT_ACK";
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
    const workflowsAfterReject = listWorkflowsByTag(hub);
    report.criteria.rejectDidNotSaveWorkflow = workflowsAfterReject.length === 0;
    report.rejectFlow.workflowSavedAfter = workflowsAfterReject.length > 0;
    report.criteria.rejectInboundObserved = Boolean(
      [...observedEventsByMessageId.values()].find((entry) =>
        entry?.inspection?.containsRejectCommand
      ),
    );

    if (!report.criteria.rejectCandidateStatusRejected || !report.criteria.rejectDidNotSaveWorkflow) {
      report.status = "failed";
      report.blocker = "PHASE24E_REJECT_PATH_INVARIANTS_BROKEN";
      report.failures.push("Reject path did not satisfy invariants (status=rejected AND no workflow saved)");
      await writeReport(report, config.botToken);
      process.exitCode = 1;
      return;
    }

    // ─── Approve flow ───
    const approveAck = await waitForCandidateAck(baseUrl, config.chatId, approveCandidateId, "approved", perFlowTimeout);
    if (!approveAck) {
      report.status = "blocked";
      report.blocker = "PHASE24E_WAITING_FOR_APPROVE_ACK";
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

    const workflowsAfterApprove = listWorkflowsByTag(hub);
    report.criteria.workflowVisibleInCrud = workflowsAfterApprove.length === 1;
    report.criteria.approveSavedWorkflow = Boolean(approvedSlot.workflowId);
    report.approveFlow.workflowSaved = Boolean(approvedSlot.workflowId);
    report.approveFlow.workflowIdTail = tail(approvedSlot.workflowId);
    report.approveFlow.workflowVersionIdTail = tail(approvedSlot.workflowVersionId);

    report.criteria.approveInboundObserved = Boolean(
      [...observedEventsByMessageId.values()].find((entry) =>
        entry?.inspection?.containsApproveCommand
      ),
    );

    const requiredCriteria = [
      "pollingConnected",
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
      report.blocker = report.blocker ?? "PHASE24E_TELEGRAM_WORKFLOW_CANDIDATE_REQUIRED_CRITERIA_NOT_MET";
    }

    await writeReport(report, config.botToken);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    report.status = "failed";
    report.blocker = "PHASE24E_TELEGRAM_LISTENER_HARNESS_ERROR";
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
