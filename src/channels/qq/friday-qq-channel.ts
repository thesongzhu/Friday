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

import type {
  FridayChannelMessage,
  FridayChannelPlugin,
  FridayChannelSendOptions,
} from "../friday-channel.types.js";
import type {
  FridayChannelAdapters,
  FridayChannelInboundAdapter,
  FridayChannelOutboundAdapter,
  FridayChannelStatus,
  FridayChannelStatusAdapter,
} from "../friday-channel-adapters.types.js";

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
      throw new Error(`QQ token refresh failed: ${response.status} ${response.statusText}`);
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
      throw new Error(`QQ gateway fetch failed: ${response.status}`);
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

  function scheduleReconnect(gatewayUrl: string, delayMs = 5000): void {
    if (stopped || reconnectTimer) return;
    const epoch = reconnectEpoch;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped || epoch !== reconnectEpoch) return;
      reconnect(gatewayUrl);
    }, delayMs);
  }

  function connectWebSocket(gatewayUrl: string): void {
    if (stopped) return;

    const socket = new WebSocket(gatewayUrl);
    ws = socket;

    socket.addEventListener("message", (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
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
      } catch {
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

  const adapters: FridayChannelAdapters = {
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "qq",
    adapters,

    async init(rawConfig) {
      config = {
        appId: rawConfig.appId as string,
        appSecret: rawConfig.appSecret as string,
        sandbox: (rawConfig.sandbox as boolean) ?? false,
        allowedUsers: rawConfig.allowedUsers as string[] | undefined,
        allowedGroups: rawConfig.allowedGroups as string[] | undefined,
      };

      if (!config.appId || !config.appSecret) {
        throw new Error("QQ channel requires appId and appSecret");
      }
    },

    async start(handler) {
      onMessage = handler;
      stopped = false;

      try {
        await refreshToken();
        const gatewayUrl = await fetchGatewayUrl();
        connectWebSocket(gatewayUrl);
      } catch (error) {
        stopped = true;
        onMessage = null;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (ws) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          ws = null;
        }
        throw error;
      }
    },

    async stop() {
      stopped = true;
      reconnectEpoch += 1;
      onMessage = null;

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      if (ws) {
        ws.close();
        ws = null;
      }
    },

    async send(options: FridayChannelSendOptions) {
      const accessToken = await ensureToken();
      const { chatId, text, replyTo } = options;

      // Determine if group or direct based on chat context
      // QQ API requires msg_id for passive replies in groups
      const body: Record<string, unknown> = {
        content: text,
        msg_type: 0,
      };

      if (replyTo) {
        body.msg_id = replyTo;
      }

      // Try group message endpoint first
      const url = `${apiBase()}/v2/groups/${chatId}/messages`;

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
        throw new Error(`QQ send failed: ${response.status} ${errorText}`);
      }

      const result = (await response.json()) as { id?: string };
      return { messageId: result.id ?? "" };
    },
  };

  return plugin;
}
