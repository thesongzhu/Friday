/**
 * QQ Channel Plugin — connects to the QQ Bot Gateway via WebSocket.
 *
 * Auth flow:
 *   1. POST appId + appSecret → access_token via QQ Bot API
 *   2. GET gateway URL
 *   3. Connect WebSocket, identify, heartbeat, receive events
 *
 * Outbound: REST API calls to send messages.
 *
 * References:
 *   - https://bot.q.qq.com/wiki/develop/api-v2/
 */

import { FridayDomainError } from "#errors";
import type {
  FridayChannelMessage,
  FridayChannelPlugin,
  FridayChannelSendOptions,
} from "../friday-channel.types.js";
import type {
  FridayChannelAdapters,
  FridayChannelInboundAdapter,
  FridayChannelLifecycleAdapter,
  FridayChannelOutboundAdapter,
  FridayChannelStatus,
  FridayChannelStatusAdapter,
} from "../friday-channel-adapters.types.js";
import { formatFridayChannelOutboundText } from "../friday-channel-outbound-formatting.js";

// ─── Constants ───

const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQ_API_BASE = "https://api.sgroup.qq.com";
const QQ_SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";

const QQ_GATEWAY_INTENTS_DEFAULT =
  (1 << 25) | // GROUP_AT_MESSAGE_CREATE
  (1 << 30);  // C2C_MESSAGE_CREATE

const QQ_HEARTBEAT_INTERVAL_MS = 30_000;
const QQ_TOKEN_REFRESH_BUFFER_MS = 60_000;

// ─── Internal Types ───

interface QqAccessToken {
  accessToken: string;
  expiresAt: number;
}

interface QqConfig {
  appId: string;
  appSecret: string;
  sandbox: boolean;
  allowedUsers?: string[];
  allowedGroups?: string[];
}

// ─── Factory ───

export function createFridayQqChannel(): FridayChannelPlugin {
  let config: QqConfig | null = null;
  let token: QqAccessToken | null = null;
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastSeq: number | null = null;
  let onMessage: ((msg: FridayChannelMessage) => void) | null = null;
  let stopped = false;

  function apiBase(): string {
    return config!.sandbox ? QQ_SANDBOX_API_BASE : QQ_API_BASE;
  }

  async function refreshToken(): Promise<void> {
    const response = await fetch(QQ_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: config!.appId,
        clientSecret: config!.appSecret,
      }),
    });

    if (!response.ok) {
      throw new FridayDomainError("INTERNAL_ERROR", `QQ token refresh failed: ${response.status} ${response.statusText}`, { httpStatus: 500 });
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000 - QQ_TOKEN_REFRESH_BUFFER_MS,
    };
  }

  async function ensureToken(): Promise<string> {
    if (!token || Date.now() >= token.expiresAt) {
      await refreshToken();
    }
    return token!.accessToken;
  }

  async function fetchGatewayUrl(): Promise<string> {
    const accessToken = await ensureToken();
    const response = await fetch(`${apiBase()}/gateway`, {
      headers: {
        Authorization: `QQBot ${accessToken}`,
        "X-Union-Appid": config!.appId,
      },
    });

    if (!response.ok) {
      throw new FridayDomainError("INTERNAL_ERROR", `QQ gateway fetch failed: ${response.status}`, { httpStatus: 500 });
    }

    const data = (await response.json()) as { url: string };
    return data.url;
  }

  function parseGroupMessage(payload: unknown): FridayChannelMessage | null {
    const d = payload as Record<string, unknown>;
    const msgId = d.id as string | undefined;
    const content = d.content as string | undefined;
    const groupOpenId = d.group_openid as string | undefined;
    const author = d.author as Record<string, unknown> | undefined;
    const senderId = author?.member_openid as string | undefined;
    const timestamp = d.timestamp as string | undefined;

    if (!msgId || !senderId || !groupOpenId) return null;

    return {
      id: msgId,
      channelKind: "qq",
      senderId,
      chatId: groupOpenId,
      chatType: "group",
      text: (content ?? "").trim(),
      timestamp: timestamp ? new Date(timestamp).getTime() : Date.now(),
      raw: payload,
    };
  }

  function parseDirectMessage(payload: unknown): FridayChannelMessage | null {
    const d = payload as Record<string, unknown>;
    const msgId = d.id as string | undefined;
    const content = d.content as string | undefined;
    const author = d.author as Record<string, unknown> | undefined;
    const senderId = author?.user_openid as string | undefined;
    const timestamp = d.timestamp as string | undefined;

    if (!msgId || !senderId) return null;

    return {
      id: msgId,
      channelKind: "qq",
      senderId,
      chatId: senderId,
      chatType: "direct",
      text: (content ?? "").trim(),
      timestamp: timestamp ? new Date(timestamp).getTime() : Date.now(),
      raw: payload,
    };
  }

  function handleDispatch(eventType: string, payload: unknown): void {
    if (!onMessage) return;

    let msg: FridayChannelMessage | null = null;

    switch (eventType) {
      case "GROUP_AT_MESSAGE_CREATE":
      case "GROUP_MESSAGE_CREATE":
        msg = parseGroupMessage(payload);
        break;
      case "C2C_MESSAGE_CREATE":
        msg = parseDirectMessage(payload);
        break;
      default:
        return;
    }

    if (msg) {
      onMessage(msg);
    }
  }

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectEpoch = 0;

  // P2-CH: Exponential backoff for reconnection
  const QQ_RECONNECT_INITIAL_MS = 1_000;
  const QQ_RECONNECT_MAX_MS = 60_000;
  let qqReconnectDelay = QQ_RECONNECT_INITIAL_MS;

  function scheduleReconnect(gatewayUrl: string, delayMs?: number): void {
    if (stopped || reconnectTimer) return;
    const epoch = reconnectEpoch;
    const effectiveDelay = delayMs ?? qqReconnectDelay;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped || epoch !== reconnectEpoch) return;
      qqReconnectDelay = Math.min(qqReconnectDelay * 2, QQ_RECONNECT_MAX_MS);
      reconnect(gatewayUrl);
    }, effectiveDelay);
  }

  function connectWebSocket(gatewayUrl: string): void {
    if (stopped) return;

    const socket = new WebSocket(gatewayUrl);
    ws = socket;

    socket.addEventListener("message", (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch (err) {
      console.warn("[friday][qq-channel] operation failed:", err instanceof Error ? err.message : String(err));
        return;
      }

      const op = data.op as number;
      const s = data.s as number | undefined;
      if (s !== undefined) lastSeq = s;

      switch (op) {
        case 10: {
          const heartbeatInterval =
            (data.d as Record<string, unknown>)?.heartbeat_interval as number | undefined;

          sendIdentify();
          qqReconnectDelay = QQ_RECONNECT_INITIAL_MS; // Reset backoff on successful connect

          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(
            () => sendHeartbeat(),
            heartbeatInterval ?? QQ_HEARTBEAT_INTERVAL_MS,
          );
          break;
        }
        case 11:
          break;
        case 0:
          handleDispatch(data.t as string, data.d);
          break;
        case 7:
        case 9:
          scheduleReconnect(gatewayUrl, 0);
          break;
      }
    });

    socket.addEventListener("close", () => {
      if (ws !== socket) return;
      scheduleReconnect(gatewayUrl, 5000);
    });

    socket.addEventListener("error", () => {
      // Will trigger close event, which handles reconnection
    });
  }

  function sendIdentify(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${token!.accessToken}`,
          intents: QQ_GATEWAY_INTENTS_DEFAULT,
          shard: [0, 1],
        },
      }),
    );
  }

  function sendHeartbeat(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ op: 1, d: lastSeq }));
  }

  function reconnect(gatewayUrl: string): void {
    reconnectEpoch += 1;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    const socket = ws;
    ws = null;
    if (socket) {
      try {
        socket.close();
      } catch (err) {
      console.warn("[friday][qq-channel] operation failed:", err instanceof Error ? err.message : String(err));
        // ignore
      }
    }
    if (!stopped) {
      connectWebSocket(gatewayUrl);
    }
  }

  // ─── Adapter wrappers ───

  const inboundAdapter: FridayChannelInboundAdapter = {
    normalize(rawEvent: unknown): FridayChannelMessage | null {
      const data = rawEvent as Record<string, unknown>;
      const eventType = data.t as string | undefined;
      if (!eventType) return null;

      switch (eventType) {
        case "GROUP_AT_MESSAGE_CREATE":
        case "GROUP_MESSAGE_CREATE":
          return parseGroupMessage(data.d);
        case "C2C_MESSAGE_CREATE":
          return parseDirectMessage(data.d);
        default:
          return null;
      }
    },
  };

  const outboundAdapter: FridayChannelOutboundAdapter = {
    async send(options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      return plugin.send(options);
    },
  };

  const statusAdapter: FridayChannelStatusAdapter = {
    status(): FridayChannelStatus {
      if (stopped) return "disconnected";
      if (ws && ws.readyState === WebSocket.OPEN) return "connected";
      if (ws) return "connecting";
      return "disconnected";
    },
    diagnostics() {
      return {
        lastSeq,
        hasToken: token !== null,
        sandbox: config?.sandbox ?? false,
      };
    },
  };

  // ─── Lifecycle Adapter ───

  const lifecycleAdapter: FridayChannelLifecycleAdapter = {
    async connect(eventHandler: (rawEvent: unknown) => void) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "QQ channel not initialized", { httpStatus: 503 });
      onMessage = null; // will be set by start() caller
      stopped = false;

      try {
        await refreshToken();
        const gatewayUrl = await fetchGatewayUrl();
        connectWebSocket(gatewayUrl);
      } catch (error) {
        stopped = true;
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
        throw error;
      }
    },
    async disconnect() {
      stopped = true;
      reconnectEpoch += 1;
      onMessage = null;

      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { ws.close(); ws = null; }
    },
  };

  const adapters: FridayChannelAdapters = {
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
    lifecycle: lifecycleAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "qq",
    adapters,
    contract: {
      coreAuthority: { messageRouting: true, sessionMirroring: true, audit: true, evidence: true },
      pluginResponsibilities: { config: true, auth: true, pairing: false, outboundDelivery: true, threadResolution: false, providerRetries: false },
      supports: { directMessages: true, groupMessages: true, threads: false, typing: false },
    },

    async init(rawConfig) {
      // P1-CH-001: Use Zod schema for runtime config validation
      const { FridayQqChannelConfigSchema } = await import("./qq-config.schema.js");
      const parsed = FridayQqChannelConfigSchema.parse({ kind: "qq", ...rawConfig });
      config = {
        appId: parsed.appId,
        appSecret: parsed.appSecret,
        sandbox: parsed.sandbox,
        allowedUsers: parsed.allowedUsers,
        allowedGroups: parsed.allowedGroups,
      };
    },

    async start(handler) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "QQ channel not initialized", { httpStatus: 503 });

      // Delegate to lifecycle adapter, then wire up the message handler
      await lifecycleAdapter.connect((event) => {
        const msg = inboundAdapter.normalize(event);
        if (msg) handler(msg);
      });
      onMessage = handler;
    },

    async stop() {
      await lifecycleAdapter.disconnect();
    },

    async send(options: FridayChannelSendOptions) {
      const accessToken = await ensureToken();
      const { chatId, replyTo, chatType } = options;
      const text = formatFridayChannelOutboundText("qq", options.text);

      // Determine if group or direct based on chatType from the inbound message
      const isDirect = chatType === "direct";

      const body: Record<string, unknown> = {
        content: text,
        msg_type: 0,
      };

      if (replyTo) {
        body.msg_id = replyTo;
      }

      // Use the correct endpoint based on chat type
      const url = isDirect
        ? `${apiBase()}/v2/users/${chatId}/messages`
        : `${apiBase()}/v2/groups/${chatId}/messages`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `QQBot ${accessToken}`,
          "Content-Type": "application/json",
          "X-Union-Appid": config!.appId,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new FridayDomainError("INTERNAL_ERROR", `QQ send failed: ${response.status} ${errorText}`, { httpStatus: 500 });
      }

      const result = (await response.json()) as { id?: string };
      return { messageId: result.id ?? "" };
    },
  };

  return plugin;
}
