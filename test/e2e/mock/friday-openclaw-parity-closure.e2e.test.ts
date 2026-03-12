import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFridayDiscordChannel } from "#channels";

import {
  createMockHubEnv,
  type MockHubEnv,
} from "./_helpers/mock-env.js";
import { resetMockCounters } from "../../_mocks/mock-llm-providers.js";
import type { MockFetch } from "../../_mocks/mock-llm-providers.js";

interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  error?: {
    code?: string;
    message?: string;
  };
}

interface AgentRunResult {
  runId: string;
  status: string;
  response: string;
  responseText?: string;
  toolCallCount: number;
  durationMs: number;
  images?: string[];
}

interface SkillListResult {
  items: Array<{
    id: string;
    name: string;
    version: string;
    status: string;
    tags: string[];
  }>;
}

interface DetectProviderResult {
  kind: string;
  validated: boolean;
  warnings: string[];
}

interface AutomationRecord {
  id: string;
  enabled: boolean;
  runCount: number;
  lastRunId?: string;
}

interface WebchatInboundFrame {
  type: "message";
  id: string;
  text: string;
  images?: string[];
  replyTo?: string;
  timestamp?: number;
}

interface WebchatOutboundFrame {
  type: string;
  id?: string;
  text?: string;
  images?: string[];
  replyTo?: string;
  clientId?: string;
}

interface SchedulerJobRow {
  last_status: "ok" | "error" | "timeout" | null;
  last_error: string | null;
  last_run_at: string | null;
  enabled: number;
}

interface AgentRunEventRow {
  event_name: string;
  payload_json: string;
}

interface FridayAuditLogEntry {
  errorCode?: string;
  traceId?: string;
  caller?: string;
  details?: Record<string, unknown>;
}

const WEBCHAT_CHANNEL_CONFIG = {
  enabled: true,
  instances: [
    {
      kind: "webchat",
      enabled: true,
      wsPath: "/ws/chat",
      allowedOrigins: ["*"],
      authMode: "none",
      maxClients: 100,
    },
  ],
};

async function apiFetch<T>(
  baseUrl: string,
  token: string,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: ApiEnvelope<T> }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as ApiEnvelope<T>;
  return { status: res.status, json };
}

async function waitFor<T>(
  poll: () => Promise<T | null>,
  options: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<T> {
  const startedAt = Date.now();
  const intervalMs = options.intervalMs ?? 400;
  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await poll();
    if (result !== null) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${options.label}`);
}

async function withTemporaryEnv<T>(
  patch: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function extractLastToolResultContent(bodyJson: unknown): string {
  if (!bodyJson || typeof bodyJson !== "object") {
    return "";
  }
  const rawMessages = (bodyJson as { messages?: unknown }).messages;
  if (!Array.isArray(rawMessages)) {
    return "";
  }
  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const message = rawMessages[index];
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if ((block as { type?: unknown }).type !== "tool_result") continue;
      const text = (block as { content?: unknown }).content;
      if (typeof text === "string") {
        return text;
      }
    }
  }
  return "";
}

function writeEnablementEvidence(
  fileName: string,
  content: string | Uint8Array,
): string {
  const dir = path.join(process.cwd(), "reports", "enablement", "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function waitForAutomationRun(
  baseUrl: string,
  token: string,
  automationId: string,
  timeoutMs = 25_000,
): Promise<AutomationRecord> {
  return waitFor(
    async () => {
      const res = await apiFetch<{ automation: AutomationRecord }>(
        baseUrl,
        token,
        "GET",
        `/v1/agent/automations/${automationId}`,
      );
      if (res.status !== 200 || !res.json.ok) {
        return null;
      }
      if (res.json.data.automation.runCount > 0 && res.json.data.automation.lastRunId) {
        return res.json.data.automation;
      }
      return null;
    },
    { timeoutMs, label: `automation run ${automationId}` },
  );
}

async function waitForSchedulerStatus(
  stateDir: string,
  jobId: string,
  targetStatus: "ok" | "error" | "timeout",
  timeoutMs = 25_000,
): Promise<SchedulerJobRow> {
  const dbPath = path.join(stateDir, "friday.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    return await waitFor(
      async () => {
        const row = db
          .prepare(
            "SELECT last_status, last_error, last_run_at, enabled FROM friday_scheduler_jobs WHERE id = ?",
          )
          .get(jobId) as SchedulerJobRow | undefined;
        if (!row) {
          return null;
        }
        return row.last_status === targetStatus ? row : null;
      },
      {
        timeoutMs,
        label: `scheduler status ${targetStatus} for ${jobId}`,
      },
    );
  } finally {
    db.close();
  }
}

function listAgentRunEvents(stateDir: string, runId: string): Array<{
  eventName: string;
  payload: Record<string, unknown>;
}> {
  const dbPath = path.join(stateDir, "friday.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT event_name, payload_json FROM friday_agent_run_events WHERE run_id = ? ORDER BY seq ASC",
      )
      .all(runId) as AgentRunEventRow[];
    return rows.map((row) => ({
      eventName: row.event_name,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  } finally {
    db.close();
  }
}

function readAuditLogEntries(stateDir: string): FridayAuditLogEntry[] {
  const auditPath = path.join(stateDir, ".friday", "audit.jsonl");
  if (!fs.existsSync(auditPath)) {
    return [];
  }
  const content = fs.readFileSync(auditPath, "utf8");
  if (content.trim().length === 0) {
    return [];
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as FridayAuditLogEntry];
      } catch {
        return [];
      }
    });
}

function buildTestSkillManifest(skillId: string): Record<string, unknown> {
  return {
    schemaVersion: "2.0",
    id: skillId,
    name: "Parity Skill",
    description: "Skill discovery parity test",
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "e2e" },
    tags: ["parity", "e2e"],
    runtime: {
      kind: "shell",
      entrypoint: "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: {
      intents: ["parity.test"],
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
      bins: [],
      env: [],
      config: [],
      os: ["darwin", "linux", "win32"],
    },
    inputs: [],
    outputs: [],
    permissions: {
      grants: [],
      promptOn: [],
    },
    schemas: null,
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: {
      events: [],
    },
  };
}

function encodeMaskedTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  const maskKey = crypto.randomBytes(4);

  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    masked[i] = data[i]! ^ maskKey[i % 4]!;
  }

  return Buffer.concat([header, maskKey, masked]);
}

function decodeServerFrames(
  input: Buffer,
): { frames: string[]; rest: Buffer } {
  const frames: string[] = [];
  let buffer = input;

  while (buffer.length >= 2) {
    const firstByte = buffer[0]!;
    const secondByte = buffer[1]!;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buffer.length < 4) {
        break;
      }
      payloadLen = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buffer.length < 10) {
        break;
      }
      payloadLen = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    const maskSize = masked ? 4 : 0;
    const totalLen = offset + maskSize + payloadLen;
    if (buffer.length < totalLen) {
      break;
    }

    const payload = Buffer.from(buffer.subarray(offset + maskSize, totalLen));
    if (masked) {
      const maskKey = buffer.subarray(offset, offset + 4);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = payload[i]! ^ maskKey[i % 4]!;
      }
    }

    buffer = buffer.subarray(totalLen);

    if (opcode === 0x1) {
      frames.push(payload.toString("utf8"));
    } else if (opcode === 0x8) {
      break;
    }
  }

  return { frames, rest: buffer };
}

async function createWebchatClient(
  baseUrl: string,
  clientId: string,
): Promise<{
  send: (frame: WebchatInboundFrame) => void;
  waitForFrame: (
    predicate: (frame: WebchatOutboundFrame) => boolean,
    timeoutMs?: number,
  ) => Promise<WebchatOutboundFrame>;
  close: () => void;
}> {
  const target = new URL(baseUrl);
  const host = target.hostname;
  const port = Number(target.port);
  const requestPath = `/ws/chat?clientId=${encodeURIComponent(clientId)}`;
  const wsKey = crypto.randomBytes(16).toString("base64");

  const socket = net.createConnection({ host, port });
  const frameQueue: WebchatOutboundFrame[] = [];
  const listeners = new Set<(frame: WebchatOutboundFrame) => void>();
  let handshakeDone = false;
  let frameBuffer = Buffer.alloc(0);
  let handshakeBuffer = Buffer.alloc(0);

  const handshakeReady = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Webchat WS handshake timed out"));
    }, 15_000);

    socket.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket.on("data", (chunk: Buffer) => {
      if (!handshakeDone) {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const marker = handshakeBuffer.indexOf("\r\n\r\n");
        if (marker === -1) {
          return;
        }
        const headerText = handshakeBuffer.subarray(0, marker).toString("utf8");
        if (!headerText.startsWith("HTTP/1.1 101")) {
          clearTimeout(timeout);
          reject(new Error(`Webchat WS upgrade failed: ${headerText.split("\r\n")[0] ?? "unknown"}`));
          return;
        }
        handshakeDone = true;
        clearTimeout(timeout);
        resolve();

        const remainder = handshakeBuffer.subarray(marker + 4);
        handshakeBuffer = Buffer.alloc(0);
        if (remainder.length > 0) {
          frameBuffer = Buffer.concat([frameBuffer, remainder]);
        }
      } else {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
      }

      const decoded = decodeServerFrames(frameBuffer);
      frameBuffer = decoded.rest;
      for (const frameText of decoded.frames) {
        let parsed: WebchatOutboundFrame;
        try {
          parsed = JSON.parse(frameText) as WebchatOutboundFrame;
        } catch {
          continue;
        }
        frameQueue.push(parsed);
        for (const listener of listeners) {
          listener(parsed);
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  socket.write(
    `GET ${requestPath} HTTP/1.1\r\n` +
      `Host: ${host}:${String(port)}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${wsKey}\r\n` +
      "Sec-WebSocket-Version: 13\r\n" +
      `Origin: ${baseUrl}\r\n` +
      "\r\n",
  );

  await handshakeReady;

  const waitForFrame = (
    predicate: (frame: WebchatOutboundFrame) => boolean,
    timeoutMs = 30_000,
  ): Promise<WebchatOutboundFrame> =>
    new Promise((resolve, reject) => {
      const existing = frameQueue.find(predicate);
      if (existing) {
        resolve(existing);
        return;
      }

      const onFrame = (frame: WebchatOutboundFrame) => {
        if (!predicate(frame)) {
          return;
        }
        clearTimeout(timer);
        listeners.delete(onFrame);
        resolve(frame);
      };

      const timer = setTimeout(() => {
        listeners.delete(onFrame);
        reject(new Error("Timed out waiting for webchat frame"));
      }, timeoutMs);

      listeners.add(onFrame);
    });

  await waitForFrame((frame) => frame.type === "hello" && frame.clientId === clientId, 10_000);

  return {
    send(frame) {
      socket.write(encodeMaskedTextFrame(JSON.stringify(frame)));
    },
    waitForFrame,
    close() {
      socket.end();
      socket.destroy();
    },
  };
}

describe("Friday OpenClaw Parity Closure E2E", () => {
  let env: MockHubEnv;
  let providerId: string;
  let model: string;

  beforeAll(async () => {
    env = await createMockHubEnv({
      providerKinds: ["anthropic"],
      channels: WEBCHAT_CHANNEL_CONFIG,
    });
    providerId = env.providers.anthropic!.providerId;
    model = env.providers.anthropic!.model;
  }, 45_000);

  afterAll(async () => {
    if (env) {
      await env.cleanup();
    }
  }, 20_000);

  beforeEach(() => {
    for (const mock of Object.values(env.mocks) as MockFetch[]) {
      mock.reset();
    }
    resetMockCounters();
  });

  it("A/G route closure: skills discovery appears in user-facing /v1/skills output", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friday-parity-skill-"));
    const skillsRoot = path.join(tempRoot, "skills");
    const skillId = "parity-skill-e2e";
    const skillDir = path.join(skillsRoot, skillId);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "skill.manifest.json"),
      JSON.stringify(buildTestSkillManifest(skillId), null, 2),
      "utf8",
    );
    fs.writeFileSync(path.join(skillDir, "run.sh"), "#!/bin/sh\necho parity\n", "utf8");
    fs.chmodSync(path.join(skillDir, "run.sh"), 0o755);

    const skillEnv = await createMockHubEnv({
      providerKinds: ["anthropic"],
      skillDirs: [skillsRoot],
    });

    try {
      const res = await apiFetch<SkillListResult>(
        skillEnv.baseUrl,
        skillEnv.accessToken,
        "GET",
        "/v1/skills",
      );
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.data.items.some((item) => item.id === skillId)).toBe(true);
    } finally {
      await skillEnv.cleanup();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("C/G route closure: browser screenshot produces user-visible artifact path and on-disk file", async () => {
    const mock = env.mockFor("anthropic");
    mock.enqueue({
      type: "tool_use",
      toolName: "browser",
      toolInput: { action: "open", url: "https://example.com" },
    });
    mock.enqueue({
      type: "tool_use",
      toolName: "browser",
      toolInput: { action: "screenshot", sessionId: "default" },
    });
    mock.enqueue({
      type: "text",
      text: "Screenshot captured and attached.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      {
        task: "Open example.com and take a screenshot",
        providerId,
        model,
        timeoutMs: 30_000,
      },
    );

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(res.json.data.images)).toBe(true);
    expect((res.json.data.images ?? []).length).toBeGreaterThan(0);

    const screenshotPath = res.json.data.images![0]!;
    const stat = fs.statSync(screenshotPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);

    const evidencePath = writeEnablementEvidence(
      `browser-screenshot-${Date.now()}.png`,
      fs.readFileSync(screenshotPath),
    );
    expect(fs.statSync(evidencePath).size).toBeGreaterThan(0);
  }, 90_000);

  it("G route closure: webchat completed run returns user-visible message plus image artifacts", async () => {
    const mock = env.mockFor("anthropic");
    mock.enqueue({
      type: "tool_use",
      toolName: "browser",
      toolInput: { action: "open", url: "https://example.com" },
    });
    mock.enqueue({
      type: "tool_use",
      toolName: "browser",
      toolInput: { action: "screenshot", sessionId: "default" },
    });
    mock.enqueue({
      type: "text",
      text: "Screenshot complete.",
    });

    const client = await createWebchatClient(env.baseUrl, "parity-webchat-artifact");
    try {
      const inbound: WebchatInboundFrame = {
        type: "message",
        id: "msg-artifact-1",
        text: "Open example.com and send me a screenshot",
        timestamp: Date.now(),
      };
      client.send(inbound);

      const outbound = await client.waitForFrame(
        (frame) => frame.type === "message" && frame.replyTo === inbound.id,
        35_000,
      );
      expect(outbound.text).toContain("Screenshot");
      expect(Array.isArray(outbound.images)).toBe(true);
      expect((outbound.images ?? []).length).toBeGreaterThan(0);
      const screenshotPath = outbound.images![0]!;
      const stat = fs.statSync(screenshotPath);
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  }, 90_000);

  it("G route closure: webchat failed run returns explicit user-facing failure message", async () => {
    const mock = env.mockFor("anthropic");
    mock.enqueue({
      type: "network_error",
      message: "simulated upstream failure",
    });

    const client = await createWebchatClient(env.baseUrl, "parity-webchat-failed");
    try {
      const inbound: WebchatInboundFrame = {
        type: "message",
        id: "msg-failed-1",
        text: "Trigger a provider failure",
        timestamp: Date.now(),
      };
      client.send(inbound);

      const outbound = await client.waitForFrame(
        (frame) => frame.type === "message" && frame.replyTo === inbound.id,
        35_000,
      );
      expect(typeof outbound.text).toBe("string");
      expect(outbound.text!.length).toBeGreaterThan(0);
      expect(outbound.text).toContain("Request failed");
    } finally {
      client.close();
    }
  }, 60_000);

  it("E route closure: scheduler cron automation auto-triggers run and records ok state", async () => {
    const mock = env.mockFor("anthropic");
    mock.setDefault({
      type: "text",
      text: "Scheduled parity report generated.",
    });

    const createRes = await apiFetch<{ automation: AutomationRecord }>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/automations",
      {
        name: "Parity Scheduler Success",
        taskTemplate: "Generate scheduled parity report",
        schedule: {
          type: "cron",
          cron: "* * * * * *",
        },
        enabled: true,
      },
    );
    expect(createRes.status).toBe(200);
    expect(createRes.json.ok).toBe(true);
    const automationId = createRes.json.data.automation.id;

    const automation = await waitForAutomationRun(env.baseUrl, env.accessToken, automationId);
    expect(automation.runCount).toBeGreaterThan(0);
    expect(typeof automation.lastRunId).toBe("string");

    const runRes = await apiFetch<{ run: AgentRunResult }>(
      env.baseUrl,
      env.accessToken,
      "GET",
      `/v1/agent/runs/${automation.lastRunId!}`,
    );
    expect(runRes.status).toBe(200);
    expect(runRes.json.ok).toBe(true);
    expect(runRes.json.data.run.status).toBe("completed");
    expect(runRes.json.data.run.responseText ?? "").toContain("Scheduled parity report generated");

    const jobId = `agent-automation:${automationId}`;
    const schedulerRow = await waitForSchedulerStatus(env.stateDir, jobId, "ok");
    expect(schedulerRow.last_run_at).toBeTruthy();

    const disableRes = await apiFetch<{ automation: AutomationRecord }>(
      env.baseUrl,
      env.accessToken,
      "PATCH",
      `/v1/agent/automations/${automationId}`,
      { enabled: false },
    );
    expect(disableRes.status).toBe(200);
    expect(disableRes.json.ok).toBe(true);
    expect(disableRes.json.data.automation.enabled).toBe(false);
  }, 80_000);

  it("E route failure path: scheduler cron automation surfaces error state for failed runs", async () => {
    const mock = env.mockFor("anthropic");
    mock.setDefault({
      type: "network_error",
      message: "scheduled upstream failure",
    });

    const createRes = await apiFetch<{ automation: AutomationRecord }>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/automations",
      {
        name: "Parity Scheduler Failure",
        taskTemplate: "Trigger scheduled failure",
        schedule: {
          type: "cron",
          cron: "* * * * * *",
        },
        enabled: true,
      },
    );
    expect(createRes.status).toBe(200);
    expect(createRes.json.ok).toBe(true);
    const automationId = createRes.json.data.automation.id;
    const jobId = `agent-automation:${automationId}`;

    const schedulerRow = await waitForSchedulerStatus(env.stateDir, jobId, "error");
    expect(schedulerRow.last_error ?? "").toContain("E-SCHED-AUTOMATION-RUN-FAILED");
    expect(schedulerRow.last_error ?? "").toContain("scheduled upstream failure");

    const getRes = await apiFetch<{ automation: AutomationRecord }>(
      env.baseUrl,
      env.accessToken,
      "GET",
      `/v1/agent/automations/${automationId}`,
    );
    expect(getRes.status).toBe(200);
    expect(getRes.json.ok).toBe(true);
    expect(getRes.json.data.automation.runCount).toBeGreaterThan(0);
    expect(typeof getRes.json.data.automation.lastRunId).toBe("string");

    const disableRes = await apiFetch<{ automation: AutomationRecord }>(
      env.baseUrl,
      env.accessToken,
      "PATCH",
      `/v1/agent/automations/${automationId}`,
      { enabled: false },
    );
    expect(disableRes.status).toBe(200);
    expect(disableRes.json.ok).toBe(true);
    expect(disableRes.json.data.automation.enabled).toBe(false);
  }, 80_000);

  it("D/H failure path: setup provider detect returns code + readable error for missing api key", async () => {
    const res = await apiFetch<DetectProviderResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/providers/detect",
      {
        kind: "openai",
        authMode: "api-key",
      },
    );

    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    expect(res.json.error?.code).toBe("VALIDATION_ERROR");
    expect(res.json.error?.message).toContain("API key is required");
  });

  it("F route closure: observability API returns trace search results when enabled", async () => {
    const res = await apiFetch<Record<string, unknown>>(
      env.baseUrl,
      env.accessToken,
      "GET",
      "/v1/observability/traces",
    );

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(Array.isArray((res.json.data as { items?: unknown[] }).items)).toBe(true);
  });
});

describe("Friday OpenClaw Parity Closure E2E — Desktop Enablement", () => {
  it("desktop enabled route closure: desktop tool executes session_info and returns user-visible response", async () => {
    await withTemporaryEnv(
      {
        FRIDAY_DESKTOP_ENABLED: "true",
        FRIDAY_DESKTOP_PRINCIPAL_ID: "friday-desktop-e2e",
      },
      async () => {
        const env = await createMockHubEnv({ providerKinds: ["anthropic"] });
        try {
          const providerId = env.providers.anthropic!.providerId;
          const model = env.providers.anthropic!.model;
          const mock = env.mockFor("anthropic");
          mock.enqueue({
            type: "tool_use",
            toolName: "desktop",
            toolInput: { action: "session_info" },
          });
          mock.enqueue({
            type: "text",
            text: "Desktop session check completed.",
          });

          const res = await apiFetch<AgentRunResult>(
            env.baseUrl,
            env.accessToken,
            "POST",
            "/v1/agent/runs",
            {
              task: "Check desktop session info",
              providerId,
              model,
              timeoutMs: 30_000,
            },
          );

          expect(res.status).toBe(200);
          expect(res.json.ok).toBe(true);
          expect(res.json.data.status).toBe("completed");
          expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
          expect(res.json.data.responseText ?? res.json.data.response).toContain("Desktop session check completed");
          expect(mock.calls.length).toBe(2);

          const toolResultContent = extractLastToolResultContent(mock.calls[1]?.bodyJson);
          expect(toolResultContent).toContain("\"state\": \"connected\"");
          expect(toolResultContent).toContain("friday-desktop-e2e");
          const evidencePath = writeEnablementEvidence(
            `desktop-session-info-${Date.now()}.json`,
            toolResultContent,
          );
          expect(fs.statSync(evidencePath).size).toBeGreaterThan(0);

          const runEvents = listAgentRunEvents(env.stateDir, res.json.data.runId);
          const toolEnd = runEvents.find((event) =>
            event.eventName === "agent.run.tool_end" && event.payload.toolName === "desktop"
          );
          expect(toolEnd).toBeDefined();
          expect(toolEnd!.payload.isError).toBe(false);
          expect(toolEnd!.payload.routeId).toBe("agent.execute.tool");
          expect(toolEnd!.payload.correlationId).toBe(res.json.data.runId);
        } finally {
          await env.cleanup();
        }
      },
    );
  }, 90_000);

  it("desktop disabled failure path: model receives explicit enablement hint and tool_end logs error code", async () => {
    await withTemporaryEnv(
      {
        FRIDAY_DESKTOP_ENABLED: undefined,
        FRIDAY_DESKTOP_PRINCIPAL_ID: undefined,
      },
      async () => {
        const env = await createMockHubEnv({ providerKinds: ["anthropic"] });
        try {
          const providerId = env.providers.anthropic!.providerId;
          const model = env.providers.anthropic!.model;
          const mock = env.mockFor("anthropic");
          mock.enqueue({
            type: "tool_use",
            toolName: "desktop",
            toolInput: { action: "session_info" },
          });
          mock.enqueue({
            type: "text",
            text: "Desktop runtime is not enabled. Set FRIDAY_DESKTOP_ENABLED=true and restart Friday.",
          });

          const res = await apiFetch<AgentRunResult>(
            env.baseUrl,
            env.accessToken,
            "POST",
            "/v1/agent/runs",
            {
              task: "Check desktop session info",
              providerId,
              model,
              timeoutMs: 30_000,
            },
          );

          expect(res.status).toBe(200);
          expect(res.json.ok).toBe(true);
          expect(res.json.data.status).toBe("failed");
          expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
          expect(res.json.data.responseText ?? res.json.data.response).toContain("FRIDAY_DESKTOP_ENABLED=true");
          expect(res.json.data.responseText ?? res.json.data.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
          expect(mock.calls.length).toBe(2);

          const toolResultContent = extractLastToolResultContent(mock.calls[1]?.bodyJson);
          expect(toolResultContent).toContain('Tool "desktop" is unavailable because desktop runtime is not enabled');
          expect(toolResultContent).toContain("FRIDAY_DESKTOP_ENABLED=true");
          const evidencePath = writeEnablementEvidence(
            `desktop-disabled-tool-result-${Date.now()}.txt`,
            toolResultContent,
          );
          expect(fs.statSync(evidencePath).size).toBeGreaterThan(0);

          const runEvents = listAgentRunEvents(env.stateDir, res.json.data.runId);
          const toolEnd = runEvents.find((event) =>
            event.eventName === "agent.run.tool_end" && event.payload.toolName === "desktop"
          );
          expect(toolEnd).toBeDefined();
          expect(toolEnd!.payload.isError).toBe(true);
          expect(toolEnd!.payload.errorCode).toBe("AGENT_TOOL_ERROR");
          expect(toolEnd!.payload.routeId).toBe("agent.execute.tool");
          expect(toolEnd!.payload.correlationId).toBe(res.json.data.runId);
        } finally {
          await env.cleanup();
        }
      },
    );
  }, 90_000);
});

describe("Friday OpenClaw Parity Closure E2E — MCP Enablement", () => {
  it("mcp enabled route closure: mcp tool lists configured servers and returns user-visible response", async () => {
    const mcpConfig = JSON.stringify([
      {
        id: "local-mcp",
        command: "echo",
        args: ["ready"],
        cwd: process.cwd(),
        timeoutMs: 5_000,
      },
    ]);

    await withTemporaryEnv(
      {
        FRIDAY_MCP_SERVERS: mcpConfig,
      },
      async () => {
        const env = await createMockHubEnv({ providerKinds: ["anthropic"] });
        try {
          const providerId = env.providers.anthropic!.providerId;
          const model = env.providers.anthropic!.model;
          const mock = env.mockFor("anthropic");
          mock.enqueue({
            type: "tool_use",
            toolName: "mcp",
            toolInput: { action: "list_servers" },
          });
          mock.enqueue({
            type: "text",
            text: "MCP server list fetched.",
          });

          const res = await apiFetch<AgentRunResult>(
            env.baseUrl,
            env.accessToken,
            "POST",
            "/v1/agent/runs",
            {
              task: "List available MCP servers",
              providerId,
              model,
              timeoutMs: 30_000,
            },
          );

          expect(res.status).toBe(200);
          expect(res.json.ok).toBe(true);
          expect(res.json.data.status).toBe("completed");
          expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
          expect(res.json.data.responseText ?? res.json.data.response).toContain("MCP server list fetched");
          expect(mock.calls.length).toBe(2);

          const toolResultContent = extractLastToolResultContent(mock.calls[1]?.bodyJson);
          expect(toolResultContent).toContain("\"id\": \"local-mcp\"");
          expect(toolResultContent).toContain("\"command\": \"echo\"");
          const evidencePath = writeEnablementEvidence(
            `mcp-list-servers-${Date.now()}.json`,
            toolResultContent,
          );
          expect(fs.statSync(evidencePath).size).toBeGreaterThan(0);

          const runEvents = listAgentRunEvents(env.stateDir, res.json.data.runId);
          const toolEnd = runEvents.find((event) =>
            event.eventName === "agent.run.tool_end" && event.payload.toolName === "mcp"
          );
          expect(toolEnd).toBeDefined();
          expect(toolEnd!.payload.isError).toBe(false);
          expect(toolEnd!.payload.routeId).toBe("agent.execute.tool");
          expect(toolEnd!.payload.correlationId).toBe(res.json.data.runId);
        } finally {
          await env.cleanup();
        }
      },
    );
  }, 90_000);

  it("mcp input-recovery route closure: missing action auto-falls back to list_servers", async () => {
    const mcpConfig = JSON.stringify([
      {
        id: "local-mcp",
        command: "echo",
        args: ["ready"],
        cwd: process.cwd(),
        timeoutMs: 5_000,
      },
    ]);

    await withTemporaryEnv(
      {
        FRIDAY_MCP_SERVERS: mcpConfig,
      },
      async () => {
        const env = await createMockHubEnv({ providerKinds: ["anthropic"] });
        try {
          const providerId = env.providers.anthropic!.providerId;
          const model = env.providers.anthropic!.model;
          const mock = env.mockFor("anthropic");
          mock.enqueue({
            type: "tool_use",
            toolName: "mcp",
            toolInput: {},
          });
          mock.enqueue({
            type: "text",
            text: "MCP fallback completed.",
          });

          const res = await apiFetch<AgentRunResult>(
            env.baseUrl,
            env.accessToken,
            "POST",
            "/v1/agent/runs",
            {
              task: "Query MCP server info",
              providerId,
              model,
              timeoutMs: 30_000,
            },
          );

          expect(res.status).toBe(200);
          expect(res.json.ok).toBe(true);
          expect(res.json.data.status).toBe("completed");
          expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
          expect(res.json.data.responseText ?? res.json.data.response).toContain("MCP fallback completed");
          expect(mock.calls.length).toBe(2);

          const toolResultContent = extractLastToolResultContent(mock.calls[1]?.bodyJson);
          expect(toolResultContent).toContain("[auto-recovery:mcp->discovery]");
          expect(toolResultContent).toContain("\"id\": \"local-mcp\"");
          const evidencePath = writeEnablementEvidence(
            `mcp-input-recovery-${Date.now()}.json`,
            toolResultContent,
          );
          expect(fs.statSync(evidencePath).size).toBeGreaterThan(0);

          const runEvents = listAgentRunEvents(env.stateDir, res.json.data.runId);
          const primaryToolEnd = runEvents.find((event) =>
            event.eventName === "agent.run.tool_end"
            && event.payload.toolName === "mcp"
            && event.payload.routeId === "agent.execute.tool"
          );
          expect(primaryToolEnd).toBeDefined();
          expect(primaryToolEnd!.payload.isError).toBe(false);
          expect(primaryToolEnd!.payload.routeId).toBe("agent.execute.tool");
          expect(primaryToolEnd!.payload.correlationId).toBe(res.json.data.runId);

          const recoveryToolEnd = runEvents.find((event) =>
            event.eventName === "agent.run.tool_end"
            && event.payload.toolName === "mcp"
            && typeof event.payload.toolCallId === "string"
            && event.payload.toolCallId.endsWith(":input-recovery")
          );
          expect(recoveryToolEnd).toBeDefined();
          expect(recoveryToolEnd!.payload.isError).toBe(false);
          expect(recoveryToolEnd!.payload.routeId).toBe("agent.execute.tool.input_recovery");
          expect(recoveryToolEnd!.payload.correlationId).toBe(res.json.data.runId);
        } finally {
          await env.cleanup();
        }
      },
    );
  }, 90_000);
});

interface MockDiscordSendCall {
  token: string;
  channelId: string;
  payload: {
    content: string;
    message_reference?: { message_id: string };
    embeds?: Array<{ image?: { url: string } }>;
    files?: Array<{ filename: string; data: Uint8Array; contentType?: string }>;
  };
}

function createMockDiscordHarness(): {
  gateway: Record<string, unknown>;
  rest: Record<string, unknown>;
  sent: MockDiscordSendCall[];
  sendAttempts: MockDiscordSendCall[];
  typingCalls: Array<{ token: string; channelId: string }>;
  enqueueSendFailure: (message: string) => void;
  emitMessage: (payload: Record<string, unknown>) => void;
} {
  let connected = false;
  let onEvent: ((event: Record<string, unknown>) => void) | null = null;
  let onStatusChange: ((status: "connected" | "disconnected" | "connecting") => void) | null = null;

  const sent: MockDiscordSendCall[] = [];
  const sendAttempts: MockDiscordSendCall[] = [];
  const sendFailures: Error[] = [];
  const typingCalls: Array<{ token: string; channelId: string }> = [];

  return {
    gateway: {
      async connect(
        _token: string,
        _intents: number,
        eventHandler: (event: Record<string, unknown>) => void,
        statusHandler?: (status: "connected" | "disconnected" | "connecting") => void,
      ) {
        connected = true;
        onEvent = eventHandler;
        onStatusChange = statusHandler ?? null;
        onStatusChange?.("connected");
      },
      async disconnect() {
        connected = false;
        onStatusChange?.("disconnected");
      },
      isConnected() {
        return connected;
      },
    },
    rest: {
      async sendMessage(
        token: string,
        channelId: string,
        payload: MockDiscordSendCall["payload"],
      ) {
        const call: MockDiscordSendCall = {
          token,
          channelId,
          payload,
        };
        sendAttempts.push(call);
        const sendFailure = sendFailures.shift();
        if (sendFailure) {
          throw sendFailure;
        }
        sent.push(call);
        return { id: `discord-mock-${String(sent.length)}` };
      },
      async sendTyping(token: string, channelId: string) {
        typingCalls.push({ token, channelId });
      },
    },
    sent,
    sendAttempts,
    typingCalls,
    enqueueSendFailure(message: string) {
      sendFailures.push(new Error(message));
    },
    emitMessage(payload) {
      if (!onEvent) {
        throw new Error("Discord mock gateway is not connected");
      }
      onEvent({
        op: 0,
        t: "MESSAGE_CREATE",
        d: payload,
      });
    },
  };
}

describe("Friday OpenClaw Parity Closure E2E — Discord Mock Transport", () => {
  let env: MockHubEnv;
  const discordHarness = createMockDiscordHarness();

  beforeAll(async () => {
    env = await createMockHubEnv({
      providerKinds: ["anthropic"],
      channels: {
        enabled: true,
        instances: [],
      },
      beforeStart: async (hub) => {
        const discordPlugin = createFridayDiscordChannel({
          gateway: discordHarness.gateway as never,
          rest: discordHarness.rest as never,
        });
        await discordPlugin.init({
          kind: "discord",
          enabled: true,
          token: "mock-discord-token",
          requireMention: false,
        });
        hub.channelRegistry.register(discordPlugin);
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (env) {
      await env.cleanup();
    }
  }, 20_000);

  beforeEach(() => {
    for (const mock of Object.values(env.mocks) as MockFetch[]) {
      mock.reset();
    }
    resetMockCounters();
    discordHarness.sent.length = 0;
    discordHarness.sendAttempts.length = 0;
    discordHarness.typingCalls.length = 0;
  });

  it("G2 route closure: discord inbound message produces user-visible outbound message with attached artifact file", async () => {
    const mock = env.mockFor("anthropic");
    mock.enqueue({
      type: "tool_use",
      toolName: "browser",
      toolInput: { action: "open", url: "https://example.com" },
    });
    mock.enqueue({
      type: "tool_use",
      toolName: "browser",
      toolInput: { action: "screenshot", sessionId: "default" },
    });
    mock.enqueue({
      type: "text",
      text: "Screenshot complete.",
    });

    const inboundMessageId = "discord-msg-success-1";
    const inboundChannelId = "discord-channel-1";

    discordHarness.emitMessage({
      id: inboundMessageId,
      channel_id: inboundChannelId,
      author: { id: "discord-user-1", username: "parity-user", bot: false },
      content: "Open example.com and attach a screenshot",
      timestamp: new Date().toISOString(),
    });

    const outbound = await waitFor(
      async () => discordHarness.sent.find((call) =>
        call.channelId === inboundChannelId &&
        call.payload.message_reference?.message_id === inboundMessageId
      ) ?? null,
      { timeoutMs: 40_000, label: "discord outbound send (success)" },
    );

    expect(outbound.payload.content).toContain("Screenshot");
    expect(Array.isArray(outbound.payload.files)).toBe(true);
    expect((outbound.payload.files ?? []).length).toBeGreaterThan(0);
    const attachment = outbound.payload.files![0]!;
    expect(attachment.filename.length).toBeGreaterThan(0);
    expect(attachment.data.byteLength).toBeGreaterThan(0);
    const evidencePath = writeEnablementEvidence(
      `discord-attachment-${Date.now()}-${attachment.filename}`,
      attachment.data,
    );
    expect(fs.statSync(evidencePath).size).toBeGreaterThan(0);

    const runsRes = await apiFetch<{ items: AgentRunResult[] }>(
      env.baseUrl,
      env.accessToken,
      "GET",
      "/v1/agent/runs?limit=5",
    );
    expect(runsRes.status).toBe(200);
    expect(runsRes.json.ok).toBe(true);
    expect(runsRes.json.data.items.some((run) => run.status === "completed")).toBe(true);
    expect(discordHarness.typingCalls.length).toBeGreaterThan(0);
  }, 90_000);

  it("G2 route failure path: discord receives explicit user-facing failure text", async () => {
    const mock = env.mockFor("anthropic");
    mock.enqueue({
      type: "network_error",
      message: "discord upstream failure",
    });

    const inboundMessageId = "discord-msg-failure-1";
    const inboundChannelId = "discord-channel-2";

    discordHarness.emitMessage({
      id: inboundMessageId,
      channel_id: inboundChannelId,
      author: { id: "discord-user-2", username: "parity-user-2", bot: false },
      content: "Trigger a failure",
      timestamp: new Date().toISOString(),
    });

    const outbound = await waitFor(
      async () => discordHarness.sent.find((call) =>
        call.channelId === inboundChannelId &&
        call.payload.message_reference?.message_id === inboundMessageId
      ) ?? null,
      { timeoutMs: 35_000, label: "discord outbound send (failure)" },
    );

    expect(outbound.payload.content.length).toBeGreaterThan(0);
    expect(outbound.payload.content).toContain("Request failed");
    expect((outbound.payload.files ?? []).length).toBe(0);

    const runsRes = await apiFetch<{ items: AgentRunResult[] }>(
      env.baseUrl,
      env.accessToken,
      "GET",
      "/v1/agent/runs?limit=5",
    );
    expect(runsRes.status).toBe(200);
    expect(runsRes.json.ok).toBe(true);
    expect(runsRes.json.data.items.some((run) => run.status === "failed")).toBe(true);
  }, 70_000);

  it("G2 delivery failure closure: primary discord send failure retries with fallback text and traceable evidence", async () => {
    const mock = env.mockFor("anthropic");
    mock.enqueue({
      type: "tool_use",
      toolName: "browser",
      toolInput: { action: "open", url: "https://example.com" },
    });
    mock.enqueue({
      type: "tool_use",
      toolName: "browser",
      toolInput: { action: "screenshot", sessionId: "default" },
    });
    mock.enqueue({
      type: "text",
      text: "Delivery path executed.",
    });

    discordHarness.enqueueSendFailure("simulated primary discord transport failure");

    const inboundMessageId = "discord-msg-delivery-fallback-1";
    const inboundChannelId = "discord-channel-delivery-fallback";

    discordHarness.emitMessage({
      id: inboundMessageId,
      channel_id: inboundChannelId,
      author: { id: "discord-user-fallback", username: "parity-fallback", bot: false },
      content: "Open example.com, screenshot it, and reply",
      timestamp: new Date().toISOString(),
    });

    const outbound = await waitFor(
      async () => discordHarness.sent.find((call) =>
        call.channelId === inboundChannelId &&
        call.payload.message_reference?.message_id === inboundMessageId
      ) ?? null,
      { timeoutMs: 45_000, label: "discord outbound send (delivery fallback)" },
    );

    expect(discordHarness.sendAttempts.length).toBeGreaterThanOrEqual(2);
    expect(outbound.payload.content).toContain("delivery failed (E-CH-OUTBOUND-001)");
    expect(outbound.payload.content).toContain("/v1/agent/runs/");
    expect((outbound.payload.files ?? []).length).toBe(0);

    const runIdMatch = outbound.payload.content.match(/\/v1\/agent\/runs\/([A-Za-z0-9_-]+)/);
    expect(runIdMatch).not.toBeNull();
    const runId = runIdMatch?.[1];
    expect(typeof runId).toBe("string");
    expect(runId?.length ?? 0).toBeGreaterThan(0);

    const runEvents = listAgentRunEvents(env.stateDir, runId!);
    const toolEndEvents = runEvents.filter((event) => event.eventName === "agent.run.tool_end");
    expect(toolEndEvents.length).toBeGreaterThan(0);
    for (const event of toolEndEvents) {
      expect(event.payload.correlationId).toBe(runId);
      expect(typeof event.payload.routeId).toBe("string");
      expect((event.payload.routeId as string).length).toBeGreaterThan(0);
    }

    const auditEntry = await waitFor(
      async () => {
        const entries = readAuditLogEntries(env.stateDir);
        return entries.find((entry) =>
          entry.errorCode === "E-CH-OUTBOUND-001" &&
          entry.caller === "hub.channel.delivery.primary" &&
          (entry.details?.runId as string | undefined) === runId
        ) ?? null;
      },
      { timeoutMs: 20_000, label: "audit log entry for outbound delivery failure" },
    );

    expect(auditEntry.traceId).toBe(runId);
    expect(auditEntry.details?.routeId).toBe("hub.channel.delivery.primary");
    expect(auditEntry.details?.correlationId).toBe(runId);
    expect(auditEntry.details?.channelCorrelationId).toBe(
      `channel:discord:${inboundChannelId}:${inboundMessageId}`,
    );

    const sessionKey = `channel:discord:${inboundChannelId}`;
    const sessionRes = await apiFetch<{
      items: Array<{ role: string; contentText: string }>;
    }>(
      env.baseUrl,
      env.accessToken,
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
    );
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.json.ok).toBe(true);
    expect(sessionRes.json.data.items.some((item) =>
      item.role === "assistant" && item.contentText.includes(runId!)
    )).toBe(true);
  }, 95_000);
});
