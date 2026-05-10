import Database from "better-sqlite3";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  FRIDAY_DEEP_PROOF_GATED,
  FRIDAY_DEEP_PROOF_MODEL,
  FRIDAY_DEEP_PROOF_PROVIDER_LABEL,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

interface RuntimeVersionEnvelope {
  ok: boolean;
  data: {
    version: string;
    apiVersion: string;
  };
}

interface UpgradeStatusEnvelope {
  ok: boolean;
  data: {
    items: Array<{
      kind: string;
      id: string;
      status: string;
      promotionChannel: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
      recordedCompatibilityStatus: string;
      derivedCompatibilityStatus: string;
      strategy: string;
      nextStage: string;
      details?: Record<string, unknown>;
      findings: Array<{ id: string; passed: boolean; severity: string }>;
    }>;
  };
}

interface ChannelGetEnvelope {
  ok: boolean;
  data: {
    channel: {
      kind: string;
      running: boolean;
      status: string;
      diagnostics?: Record<string, unknown>;
      health: {
        state: string;
        credentialStatus: string;
        restartCount: number;
      };
    };
  };
}

interface ChannelActionEnvelope {
  ok: boolean;
  data: {
    channel: {
      kind: string;
      status: string;
      running?: boolean;
      credentialStatus?: string;
      authMode?: string;
      promotionChannel?: string;
      compatibilityStatus?: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
    };
    status: UpgradeStatusEnvelope["data"]["items"][number] | null;
  };
}

interface UpgradeStateRowReadback {
  compatibilityStatus: string;
  promotionChannel: string;
  shadowVersionId: string | null;
  canaryStatsJson: string;
  lastVerifiedRuntimeVersion: string | null;
  lastVerifiedProviderModel: string | null;
}

interface WebchatInboundFrame {
  type: "message";
  id: string;
  text: string;
  timestamp: number;
  images?: string[];
  replyTo?: string;
}

interface WebchatOutboundFrame {
  type: string;
  id?: string;
  clientId?: string;
  text?: string;
  timestamp?: number;
}

function openStateDb(stateDir: string): Database.Database {
  return new Database(path.join(stateDir, "friday.db"), { readonly: true, fileMustExist: true });
}

function readUpgradeStateRow(stateDir: string, subjectId: string): UpgradeStateRowReadback | null {
  const db = openStateDb(stateDir);
  try {
    return (
      db.prepare(
        `SELECT compatibility_status AS compatibilityStatus,
                promotion_channel AS promotionChannel,
                shadow_version_id AS shadowVersionId,
                canary_stats_json AS canaryStatsJson,
                last_verified_runtime_version AS lastVerifiedRuntimeVersion,
                last_verified_provider_model AS lastVerifiedProviderModel
           FROM autonomy_subject_upgrade_state
          WHERE subject_kind = 'channel_adapter'
            AND subject_id = ?`,
      ).get(subjectId) as UpgradeStateRowReadback | undefined
    ) ?? null;
  } finally {
    db.close();
  }
}

function encodeMaskedTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  const mask = crypto.randomBytes(4);
  const len = data.length;
  const header: number[] = [0x81];

  if (len < 126) {
    header.push(0x80 | len);
  } else if (len < 65536) {
    header.push(0x80 | 126, (len >> 8) & 0xff, len & 0xff);
  } else {
    throw new Error("Payload too large for test helper");
  }

  const masked = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) {
    masked[index] = data[index]! ^ mask[index % 4]!;
  }

  return Buffer.concat([Buffer.from(header), mask, masked]);
}

function decodeServerFrames(buffer: Buffer): { frames: string[]; rest: Buffer } {
  const frames: string[] = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const b1 = buffer[offset]!;
    const b2 = buffer[offset + 1]!;
    const opcode = b1 & 0x0f;
    const masked = (b2 & 0x80) !== 0;
    let payloadLen = b2 & 0x7f;
    offset += 2;

    if (payloadLen === 126) {
      if (offset + 2 > buffer.length) {
        return { frames, rest: buffer.subarray(offset - 2) };
      }
      payloadLen = buffer.readUInt16BE(offset);
      offset += 2;
    }

    const maskSize = masked ? 4 : 0;
    const totalLen = offset + maskSize + payloadLen;
    if (totalLen > buffer.length) {
      return { frames, rest: buffer.subarray(offset - (payloadLen >= 126 ? 4 : 2)) };
    }

    const payload = Buffer.from(buffer.subarray(offset + maskSize, totalLen));
    if (masked) {
      const maskKey = buffer.subarray(offset, offset + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ maskKey[index % 4]!;
      }
    }

    offset = totalLen;

    if (opcode === 0x1) {
      frames.push(payload.toString("utf8"));
    } else if (opcode === 0x8) {
      break;
    }
  }

  return { frames, rest: buffer.subarray(offset) };
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
  const requestPath = `/ws/chat?clientId=${encodeURIComponent(clientId)}`;
  const wsKey = crypto.randomBytes(16).toString("base64");
  const socket = net.createConnection({ host: target.hostname, port: Number(target.port) });
  const frameQueue: WebchatOutboundFrame[] = [];
  const listeners = new Set<(frame: WebchatOutboundFrame) => void>();
  let handshakeDone = false;
  let frameBuffer = Buffer.alloc(0);
  let handshakeBuffer = Buffer.alloc(0);

  const handshakeReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Webchat WS handshake timed out")), 15_000);

    socket.once("error", (err) => {
      clearTimeout(timer);
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
          clearTimeout(timer);
          reject(new Error(`Webchat WS upgrade failed: ${headerText.split("\r\n")[0] ?? "unknown"}`));
          return;
        }
        handshakeDone = true;
        clearTimeout(timer);
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
        try {
          const parsed = JSON.parse(frameText) as WebchatOutboundFrame;
          frameQueue.push(parsed);
          for (const listener of listeners) {
            listener(parsed);
          }
        } catch {
          // Ignore malformed frames in the test client.
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
      `Host: ${target.hostname}:${target.port}\r\n` +
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
    timeoutMs = 15_000,
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

  await waitForFrame((frame) => frame.type === "hello" && frame.clientId === clientId);

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

async function getRuntimeVersion(env: RealHubEnv): Promise<string> {
  const response = await fetch(`${env.baseUrl}/v1/version`, {
    headers: { Authorization: `Bearer ${env.accessToken}` },
  });
  const json = await response.json() as RuntimeVersionEnvelope;
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  return json.data.version;
}

async function getUpgradeStatus(env: RealHubEnv, channelKind: string): Promise<UpgradeStatusEnvelope["data"]["items"][number]> {
  const response = await fetch(
    `${env.baseUrl}/v1/autonomy/upgrade-status?kind=channel_adapter&id=${encodeURIComponent(channelKind)}`,
    {
      headers: { Authorization: `Bearer ${env.accessToken}` },
    },
  );
  const json = await response.json() as UpgradeStatusEnvelope;
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  expect(json.data.items).toHaveLength(1);
  return json.data.items[0]!;
}

async function getChannel(env: RealHubEnv, channelKind: string): Promise<ChannelGetEnvelope["data"]["channel"]> {
  const response = await fetch(`${env.baseUrl}/v1/channels/${encodeURIComponent(channelKind)}`, {
    headers: { Authorization: `Bearer ${env.accessToken}` },
  });
  const json = await response.json() as ChannelGetEnvelope;
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  return json.data.channel;
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)(`Friday Channel Adapter Self Upgrade Live (${FRIDAY_DEEP_PROOF_PROVIDER_LABEL})`, () => {
  let env: RealHubEnv;
  const inboundMessages: Array<{ text: string; senderId: string }> = [];

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv({
      hubConfig: {
        channels: {
          enabled: true,
          instances: [
            {
              kind: "webchat",
              enabled: true,
              wsPath: "/ws/chat",
              authMode: "none",
              allowedOrigins: [],
              maxClients: 100,
            },
          ],
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (env) {
      await cleanupFridayDeepProofHubEnv(env);
    }
  }, 30_000);

  it(
    "proves channel_adapter detect-adapt-replay-shadow-canary-promote-rollback with API and SQLite readback",
    { timeout: 240_000, retry: 1 },
    async () => {
      const runtimeVersion = await getRuntimeVersion(env);
      await env.hub!.channelRegistry.stopAll();

      const detectChannel = await getChannel(env, "webchat");
      expect(detectChannel.status).toBe("disconnected");
      expect(detectChannel.running).toBe(false);

      const detectStatus = await getUpgradeStatus(env, "webchat");
      expect(detectStatus.derivedCompatibilityStatus).toBe("adaptation_required");
      expect(detectStatus.strategy).toBe("patch");
      expect(detectStatus.findings.some((finding) => finding.id === "channel_runtime_state" && !finding.passed)).toBe(true);

      const startSummary = await env.hub!.channelRegistry.startAllBestEffort((msg) => {
        inboundMessages.push({ text: msg.text, senderId: msg.senderId });
      });
      expect(startSummary.failed).toEqual([]);
      expect(startSummary.startedKinds).toContain("webchat");

      const adaptedChannel = await getChannel(env, "webchat");
      expect(adaptedChannel.status).toBe("connected");
      expect(adaptedChannel.running).toBe(true);

      const postAdaptStatus = await getUpgradeStatus(env, "webchat");
      expect(postAdaptStatus.derivedCompatibilityStatus).toBe("compatible");
      expect(postAdaptStatus.strategy).toBe("noop");
      expect(postAdaptStatus.details?.authMode).toBe("none");

      const clientId = `phase4-webchat-${Date.now().toString(36)}`;
      const client = await createWebchatClient(env.baseUrl, clientId);
      try {
        client.send({
          type: "message",
          id: `client-msg-${Date.now().toString(36)}`,
          text: "channel replay proof",
          timestamp: Date.now(),
        });

        await expect.poll(() => inboundMessages.some((message) => message.text === "channel replay proof")).toBe(true);

        await env.hub!.channelRegistry.send("webchat", {
          chatId: clientId,
          text: "server replay ack",
        });

        const outboundFrame = await client.waitForFrame((frame) => frame.text === "server replay ack");
        expect(outboundFrame.text).toBe("server replay ack");
      } finally {
        client.close();
      }

      const firstShadowId = "webchat@shadow";
      const shadowRes = await fetch(`${env.baseUrl}/v1/autonomy/channels/webchat/shadow`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shadowVersionId: firstShadowId,
          runtimeVersion,
          providerModel: FRIDAY_DEEP_PROOF_MODEL,
        }),
      });
      const shadowJson = await shadowRes.json() as ChannelActionEnvelope;
      expect(shadowRes.status).toBe(200);
      expect(shadowJson.ok).toBe(true);
      expect(shadowJson.data.channel.promotionChannel).toBe("shadow");
      expect(shadowJson.data.status?.shadowVersionId).toBe(firstShadowId);

      const canaryRes = await fetch(`${env.baseUrl}/v1/autonomy/channels/webchat/canary`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ success: true }),
      });
      const canaryJson = await canaryRes.json() as ChannelActionEnvelope;
      expect(canaryRes.status).toBe(200);
      expect(canaryJson.ok).toBe(true);
      expect(canaryJson.data.channel.promotionChannel).toBe("canary");
      expect(canaryJson.data.channel.canaryStats?.sampleSize).toBe(1);
      expect(canaryJson.data.channel.canaryStats?.successCount).toBe(1);

      const promoteRes = await fetch(`${env.baseUrl}/v1/autonomy/channels/webchat/promote`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          runtimeVersion,
          providerModel: FRIDAY_DEEP_PROOF_MODEL,
        }),
      });
      const promoteJson = await promoteRes.json() as ChannelActionEnvelope;
      expect(promoteRes.status).toBe(200);
      expect(promoteJson.ok).toBe(true);
      expect(promoteJson.data.channel.promotionChannel).toBe("active");
      expect(promoteJson.data.status?.derivedCompatibilityStatus).toBe("compatible");

      const rowAfterPromote = readUpgradeStateRow(env.stateDir!, "webchat");
      expect(rowAfterPromote).not.toBeNull();
      expect(rowAfterPromote?.promotionChannel).toBe("active");
      expect(rowAfterPromote?.compatibilityStatus).toBe("compatible");
      expect(rowAfterPromote?.lastVerifiedRuntimeVersion).toBe(runtimeVersion);
      expect(rowAfterPromote?.lastVerifiedProviderModel).toBe(FRIDAY_DEEP_PROOF_MODEL);

      const secondShadowId = "webchat@shadow-rollback";
      await fetch(`${env.baseUrl}/v1/autonomy/channels/webchat/shadow`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shadowVersionId: secondShadowId,
          runtimeVersion,
          providerModel: FRIDAY_DEEP_PROOF_MODEL,
        }),
      });

      const failingCanaryRes = await fetch(`${env.baseUrl}/v1/autonomy/channels/webchat/canary`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ success: false }),
      });
      const failingCanaryJson = await failingCanaryRes.json() as ChannelActionEnvelope;
      expect(failingCanaryRes.status).toBe(200);
      expect(failingCanaryJson.data.channel.canaryStats?.failureCount).toBeGreaterThanOrEqual(1);

      const rollbackRes = await fetch(`${env.baseUrl}/v1/autonomy/channels/webchat/rollback`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          runtimeVersion,
          providerModel: FRIDAY_DEEP_PROOF_MODEL,
        }),
      });
      const rollbackJson = await rollbackRes.json() as ChannelActionEnvelope;
      expect(rollbackRes.status).toBe(200);
      expect(rollbackJson.ok).toBe(true);
      expect(rollbackJson.data.channel.promotionChannel).toBe("rolled_back");
      expect(rollbackJson.data.status?.promotionChannel).toBe("rolled_back");

      const rowAfterRollback = readUpgradeStateRow(env.stateDir!, "webchat");
      expect(rowAfterRollback?.promotionChannel).toBe("rolled_back");
      expect(rowAfterRollback?.compatibilityStatus).toBe("adaptation_required");
      expect(rowAfterRollback?.shadowVersionId).toBeNull();
      const rollbackStats = JSON.parse(rowAfterRollback?.canaryStatsJson ?? "{}") as { rollbackCount?: number };
      expect(rollbackStats.rollbackCount).toBeGreaterThanOrEqual(1);
    },
  );
});
