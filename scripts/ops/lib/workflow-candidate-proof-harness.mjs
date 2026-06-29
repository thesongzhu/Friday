import net from "node:net";
import path from "node:path";

import Database from "better-sqlite3";

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

function buildWorkflowCandidateId(phaseKey, kind, explicitValue) {
  const explicit = typeof explicitValue === "string" ? explicitValue.trim() : "";
  if (explicit) return sanitizeNoncePart(explicit, `${phaseKey}-${kind}-explicit`);
  return `${phaseKey}-${kind}-${Date.now()}`;
}

function buildWorkflowNonce(phaseKey, kind, explicitEnvVar) {
  const explicit = process.env[explicitEnvVar]?.trim();
  if (explicit) return sanitizeNoncePart(explicit, `${phaseKey}-${kind}-explicit`);
  const runId = sanitizeNoncePart(process.env.GITHUB_RUN_ID, "local");
  const sha = sanitizeNoncePart((process.env.GITHUB_SHA ?? "local").slice(0, 8), "local");
  return `${phaseKey}-${kind}-run-${runId}-${sha}`;
}

function tail(value) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  if (text.length === 0) return null;
  return text.length <= 8 ? text : text.slice(-8);
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

function authlessJsonHeaders() {
  return { "Content-Type": "application/json" };
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

async function createCandidateRepository() {
  const reflex = await import("#reflex");
  return reflex.createFridayReflexCandidateRepository();
}

async function seedWorkflowCandidates(stateDir, config) {
  const candidateRepo = await createCandidateRepository();
  const rejectCandidateId = buildWorkflowCandidateId(config.phaseKey, "reject", config.rejectCandidateId);
  const approveCandidateId = buildWorkflowCandidateId(config.phaseKey, "approve", config.approveCandidateId);
  const generatorSessionId = `${config.phaseKey}-approve-session-${Date.now()}`;
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
      sourceRunId: `${config.phaseKey}-run-reject-${Date.now()}`,
      sessionKey: `${config.phaseKey}-session-reject`,
      channelKind: config.channelKind,
      channelUserId: config.channelUserId,
      title: `${config.phaseLabel} reject candidate (LLM-bridge-stubbed)`,
      summary: `${config.phaseLabel} reject scenario nonce ${config.rejectNonce}`,
      payload: {
        goal: `Trusted ${config.channelDisplayName} reject reflex command must transition this candidate to rejected and save NO workflow.`,
        scenario: "reject",
        phase: config.phaseLabel,
        nonce: config.rejectNonce,
      },
      evidence: {
        generatorSessionId: `${config.phaseKey}-reject-session-${Date.now()}`,
        priorRecipeCandidate: true,
        mode: `${config.phaseKey}_live_channel_fixture`,
        validationOk: true,
        qaVerdict: { status: "passed", source: `${config.phaseKey}_fixture` },
        harness: { status: "passed", source: `${config.phaseKey}_fixture` },
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
      sourceRunId: `${config.phaseKey}-run-approve-${Date.now()}`,
      sessionKey: `${config.phaseKey}-session-approve`,
      channelKind: config.channelKind,
      channelUserId: config.channelUserId,
      title: `${config.phaseLabel} approve candidate (LLM-bridge-stubbed)`,
      summary: `${config.phaseLabel} approve scenario nonce ${config.approveNonce}`,
      payload: {
        goal: `Trusted ${config.channelDisplayName} approve reflex command must transition this candidate to approved and save a workflow via real CRUD (LLM bridge stubbed).`,
        scenario: "approve",
        phase: config.phaseLabel,
        nonce: config.approveNonce,
      },
      evidence: {
        generatorSessionId,
        priorRecipeCandidate: true,
        mode: `${config.phaseKey}_live_channel_fixture`,
        validationOk: true,
        qaVerdict: { status: "passed", source: `${config.phaseKey}_fixture` },
        harness: { status: "passed", source: `${config.phaseKey}_fixture` },
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
      { id: "start", type: "start", next: ["end"], config: {} },
      { id: "end", type: "end", next: [], config: {} },
    ],
    edges: [],
  };
}

function installWorkflowApprovalStub(hub, config, generatorSessionId, approvedSlot) {
  const original = hub.workflowGenerator.approveAndSave.bind(hub.workflowGenerator);
  hub.workflowGenerator.approveAndSave = async (sessionId) => {
    if (sessionId !== generatorSessionId) return original(sessionId);
    const { workflow, version } = hub.workflowRuntime.crud.createWorkflowWithVersion(
      {
        slug: `${config.phaseKey}-channel-approved-workflow`,
        name: `${config.phaseLabel} channel-approved workflow`,
        description: `Deterministic workflow saved after trusted ${config.channelDisplayName} approve reflex command (${config.phaseLabel} live proof).`,
        tags: [config.workflowTag],
        ownerUserId: LEARNING_DEFAULT_USER_ID,
      },
      makeApprovedWorkflowGraph(),
      LEARNING_DEFAULT_USER_ID,
      `Approved through trusted ${config.channelDisplayName} channel Reflex command — ${config.phaseLabel} live proof.`,
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
        proofBoundary: `crud_publish_only_${config.phaseKey}_llm_bridge_stubbed`,
        summary: `${config.phaseLabel} live-channel proof: real channel command -> real reflex approval gate -> stubbed LLM bridge -> real CRUD save.`,
      },
    };
  };
}

async function readCandidateFromDb(stateDir, candidateId) {
  const candidateRepo = await createCandidateRepository();
  const db = new Database(path.join(stateDir, "friday.db"));
  try {
    return candidateRepo.getById(db, { userId: LEARNING_DEFAULT_USER_ID, id: candidateId });
  } finally {
    db.close();
  }
}

async function getSessionMessages(baseUrl, channelKind, chatId, limit = 60) {
  const sessionKey = `channel:${channelKind}:${chatId}`;
  const encoded = encodeURIComponent(sessionKey);
  const response = await apiFetch(baseUrl, "GET", `/v1/sessions/${encoded}/messages?limit=${limit}`).catch(() => null);
  return Array.isArray(response?.items)
    ? response.items
    : Array.isArray(response?.messages)
      ? response.messages
      : [];
}

async function waitForCandidateAck(baseUrl, channelKind, chatId, candidateId, expectedStatusWord, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const needle = `Reflex candidate ${candidateId} 已更新为 ${expectedStatusWord}`;
  while (Date.now() < deadline) {
    const messages = await getSessionMessages(baseUrl, channelKind, chatId);
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

function observeChannelOutboundAcks(hub, report, persistReport) {
  const originalSend = hub.channelRegistry.send.bind(hub.channelRegistry);
  const deliveries = [];

  hub.channelRegistry.send = async (kind, options) => {
    const text = typeof options?.text === "string" ? options.text : "";
    const startedAt = new Date().toISOString();
    try {
      const delivery = await originalSend(kind, options);
      const entry = {
        kind,
        chatIdTail: tail(options?.chatId),
        replyToMessageIdTail: tail(options?.replyTo),
        messageIdTail: tail(delivery?.messageId),
        deliveredAt: new Date().toISOString(),
        startedAt,
        reflexCandidateAck: text.includes("Reflex candidate ") && text.includes(" 已更新为 "),
        text,
      };
      deliveries.push(entry);
      report.diagnostics.channelOutboundDeliveries = deliveries;
      await persistReport?.("channel_outbound_delivery").catch(() => {});
      return delivery;
    } catch (error) {
      const entry = {
        kind,
        chatIdTail: tail(options?.chatId),
        replyToMessageIdTail: tail(options?.replyTo),
        deliveredAt: null,
        startedAt,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        reflexCandidateAck: text.includes("Reflex candidate ") && text.includes(" 已更新为 "),
        text,
      };
      deliveries.push(entry);
      report.diagnostics.channelOutboundDeliveries = deliveries;
      await persistReport?.("channel_outbound_delivery_failed").catch(() => {});
      throw error;
    }
  };

  return {
    deliveries,
    restore() {
      hub.channelRegistry.send = originalSend;
    },
  };
}

async function waitForObservedChannelAck(observer, candidateId, expectedStatusWord, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const needle = `Reflex candidate ${candidateId} 已更新为 ${expectedStatusWord}`;
  while (Date.now() < deadline) {
    const found = observer.deliveries.find((entry) =>
      entry?.reflexCandidateAck === true
      && typeof entry?.text === "string"
      && entry.text.includes(needle)
      && typeof entry?.messageIdTail === "string"
      && entry.messageIdTail.length > 0
    );
    if (found) return found;
    await delay(1000);
  }
  return null;
}

async function waitForCandidateStatus(stateDir, candidateId, expectedStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    let candidate;
    try {
      candidate = await readCandidateFromDb(stateDir, candidateId);
    } catch {
      candidate = null;
    }
    lastSeen = candidate?.status ?? lastSeen;
    if (candidate?.status === expectedStatus) return candidate;
    await delay(1500);
  }
  return { status: lastSeen };
}

function listWorkflowsByTag(hub, workflowTag) {
  return hub.workflowRuntime.crud.listWorkflows({ tag: workflowTag, archived: false });
}

export {
  LEARNING_DEFAULT_USER_ID,
  apiFetch,
  buildWorkflowCandidateId,
  buildWorkflowNonce,
  delay,
  envInteger,
  findFreePort,
  getSessionMessages,
  installWorkflowApprovalStub,
  listWorkflowsByTag,
  observeChannelOutboundAcks,
  seedWorkflowCandidates,
  tail,
  withTimeout,
  waitForCandidateAck,
  waitForObservedChannelAck,
  waitForCandidateStatus,
};
