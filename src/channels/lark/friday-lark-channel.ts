/**
 * Lark/Feishu Channel Plugin — connects via WebSocket or webhook.
 *
 * Auth flow:
 *   1. POST appId + appSecret → tenant_access_token
 *   2. Connect WebSocket for event subscription (default)
 *   3. Send messages via REST API
 *
 * Region support:
 *   - International Lark: https://open.larksuite.com
 *   - China Feishu: https://open.feishu.cn
 *
 * References:
 *   - https://open.feishu.cn/document/server-docs/overview
 *   - https://open.larksuite.com/document/server-docs/overview
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
  FridayChannelOutboundAdapter,
  FridayChannelStatus,
  FridayChannelStatusAdapter,
} from "../friday-channel-adapters.types.js";
import type { LarkWebhookRelayService } from "./lark-webhook-relay.js";

// ─── Constants ───

const FEISHU_API_BASE = "https://open.feishu.cn";
const LARK_API_BASE = "https://open.larksuite.com";

const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const SEND_MESSAGE_PATH = "/open-apis/im/v1/messages";
const WS_ENDPOINT_PATH = "/open-apis/callback/ws/endpoint";

const TOKEN_REFRESH_BUFFER_MS = 60_000;
const WS_RECONNECT_DELAY_MS = 5_000;
const WS_PING_INTERVAL_MS = 30_000;

// ─── Internal Types ───

interface LarkAccessToken {
  tenantAccessToken: string;
  expiresAt: number;
}

interface LarkConfig {
  appId: string;
  appSecret: string;
  useFeishu: boolean;
  allowedUsers?: string[];
  allowedChats?: string[];
  receiveMode: "websocket" | "webhook";
}

export interface LarkChannelDeps {
  webhookRelay?: LarkWebhookRelayService;
}

// ─── Factory ───

export function createFridayLarkChannel(deps: LarkChannelDeps = {}): FridayChannelPlugin {
  let config: LarkConfig | null = null;
  let token: LarkAccessToken | null = null;
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let onMessage: ((msg: FridayChannelMessage) => void) | null = null;
  let stopped = false;
  const webhookRelay = deps.webhookRelay;

  function apiBase(): string {
    return config!.useFeishu ? FEISHU_API_BASE : LARK_API_BASE;
  }

  async function refreshToken(): Promise<void> {
    const response = await fetch(`${apiBase()}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: config!.appId,
        app_secret: config!.appSecret,
      }),
    });

    if (!response.ok) {
      throw new FridayDomainError("INTERNAL_ERROR", `Lark token refresh failed: ${response.status} ${response.statusText}`, { httpStatus: 500 });
    }

    const data = (await response.json()) as {
      code: number;
      msg: string;
      tenant_access_token: string;
      expire: number;
    };

    if (data.code !== 0) {
      throw new FridayDomainError("INTERNAL_ERROR", `Lark token refresh error: ${data.code} ${data.msg}`, { httpStatus: 500 });
    }

    token = {
      tenantAccessToken: data.tenant_access_token,
      expiresAt: Date.now() + data.expire * 1000 - TOKEN_REFRESH_BUFFER_MS,
    };
  }

  async function ensureToken(): Promise<string> {
    if (!token || Date.now() >= token.expiresAt) {
      await refreshToken();
    }
    return token!.tenantAccessToken;
  }

  function parseMessageEvent(event: Record<string, unknown>): FridayChannelMessage | null {
    const eventData = event.event as Record<string, unknown> | undefined;
    if (!eventData) return null;

    const message = eventData.message as Record<string, unknown> | undefined;
    const sender = eventData.sender as Record<string, unknown> | undefined;

    if (!message || !sender) return null;

    const messageId = message.message_id as string | undefined;
    const chatId = message.chat_id as string | undefined;
    const chatType = message.chat_type as string | undefined;
    const content = message.content as string | undefined;
    const createTime = message.create_time as string | undefined;

    const senderId =
      (sender.sender_id as Record<string, unknown>)?.open_id as string | undefined;
    const senderName =
      (sender.sender_id as Record<string, unknown>)?.name as string | undefined;

    if (!messageId || !chatId || !senderId) return null;

    // Lark content is JSON-encoded; extract text
    let text = "";
    if (content) {
      try {
        const parsed = JSON.parse(content) as { text?: string };
        text = parsed.text ?? content;
      } catch (err) {
      console.warn("[friday][lark-channel] operation failed:", err instanceof Error ? err.message : String(err));
        text = content;
      }
    }

    // Extract image keys if present
    const images: string[] = [];
    const imageKey = message.image_key as string | undefined;
    if (imageKey) {
      images.push(imageKey);
    }

    return {
      id: messageId,
      channelKind: config!.useFeishu ? "feishu" : "lark",
      senderId,
      senderName: senderName ?? undefined,
      chatId,
      chatType: chatType === "p2p" ? "direct" : "group",
      text,
      images: images.length > 0 ? images : undefined,
      replyTo: (message.parent_id as string) ?? undefined,
      timestamp: createTime ? parseInt(createTime, 10) : Date.now(),
      raw: event,
    };
  }

  async function fetchWsEndpoint(): Promise<string> {
    const accessToken = await ensureToken();
    const response = await fetch(`${apiBase()}${WS_ENDPOINT_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new FridayDomainError("INTERNAL_ERROR", `Lark WS endpoint fetch failed: ${response.status}`, { httpStatus: 500 });
    }

    const data = (await response.json()) as {
      code: number;
      data?: { URL?: string; url?: string };
    };

    const wsUrl = data.data?.URL ?? data.data?.url;
    if (!wsUrl) {
      throw new FridayDomainError("INTERNAL_ERROR", "Lark WS endpoint returned no URL", { httpStatus: 500 });
    }

    return wsUrl;
  }

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(delayMs = WS_RECONNECT_DELAY_MS): void {
    if (stopped || reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;

      fetchWsEndpoint()
        .then((url) => {
          if (stopped) return;
          connectWebSocket(url);
        })
        .catch(() => {
          if (!stopped) {
            scheduleReconnect(WS_RECONNECT_DELAY_MS * 2);
          }
        });
    }, delayMs);
  }

  function connectWebSocket(wsUrl: string): void {
    if (stopped) return;

    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.addEventListener("message", (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch (err) {
      console.warn("[friday][lark-channel] operation failed:", err instanceof Error ? err.message : String(err));
        return;
      }

      const type = data.type as string | undefined;

      if (type === "pong") {
        // Ping-pong keepalive response
        return;
      }

      // Event envelope
      const header = data.header as Record<string, unknown> | undefined;
      const eventType = header?.event_type as string | undefined;

      if (eventType === "im.message.receive_v1") {
        const msg = parseMessageEvent(data);
        if (msg && onMessage) {
          onMessage(msg);
        }
      }
    });

    socket.addEventListener("open", () => {
      // Start ping timer
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, WS_PING_INTERVAL_MS);
    });

    socket.addEventListener("close", () => {
      // Ignore stale socket close events
      if (ws !== socket) return;
      ws = null;

      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }

      if (!stopped) {
        scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      // Will trigger close event, which handles reconnection
    });
  }

  // ─── Adapter wrappers ───

  const inboundAdapter: FridayChannelInboundAdapter = {
    normalize(rawEvent: unknown): FridayChannelMessage | null {
      const data = rawEvent as Record<string, unknown>;
      return parseMessageEvent(data);
    },
  };

  const outboundAdapter: FridayChannelOutboundAdapter = {
    async send(options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      return plugin.send(options);
    },
  };

  const statusAdapter: FridayChannelStatusAdapter = {
    status(): FridayChannelStatus {
      if (config?.receiveMode === "webhook") {
        if (stopped) return "disconnected";
        return webhookRelay?.isListening() ? "connected" : "disconnected";
      }
      if (stopped) return "disconnected";
      if (ws && ws.readyState === WebSocket.OPEN) return "connected";
      if (ws) return "connecting";
      return "disconnected";
    },
    diagnostics() {
      return {
        hasToken: token !== null,
        useFeishu: config?.useFeishu ?? false,
        receiveMode: config?.receiveMode ?? "websocket",
        webhookListening: webhookRelay?.isListening() ?? false,
      };
    },
  };

  const adapters: FridayChannelAdapters = {
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "lark",
    adapters,
    contract: {
      coreAuthority: { messageRouting: true, sessionMirroring: true, audit: true, evidence: true },
      pluginResponsibilities: { config: true, auth: true, pairing: false, outboundDelivery: true, threadResolution: false, providerRetries: false },
      supports: { directMessages: true, groupMessages: true, threads: false, typing: false },
    },

    async init(rawConfig) {
      // P1-CH-001: Use Zod schema for runtime config validation
      const { FridayLarkChannelConfigSchema } = await import("./lark-config.schema.js");
      const parsed = FridayLarkChannelConfigSchema.parse({ kind: rawConfig.useFeishu ? "feishu" : "lark", ...rawConfig });
      config = {
        appId: parsed.appId,
        appSecret: parsed.appSecret,
        useFeishu: parsed.useFeishu,
        allowedUsers: parsed.allowedUsers,
        allowedChats: parsed.allowedChats,
        receiveMode: parsed.receiveMode,
      };

      // Override kind for Feishu
      if (config.useFeishu) {
        (this as { kind: string }).kind = "feishu";
      }
    },

    async start(handler) {
      onMessage = handler;
      stopped = false;

      try {
        await refreshToken();

        if (config!.receiveMode === "websocket") {
          const wsUrl = await fetchWsEndpoint();
          connectWebSocket(wsUrl);
        } else {
          if (!webhookRelay) {
            throw new FridayDomainError("VALIDATION_ERROR", "Lark webhook mode requires webhookRelay dependency", { httpStatus: 400 });
          }
          if (config!.appSecret) {
            webhookRelay.setAppSecret(config!.appSecret);
          }
          await webhookRelay.start((event) => {
            const msg = parseMessageEvent(event);
            if (msg && onMessage) {
              onMessage(msg);
            }
          });
        }
      } catch (error) {
        stopped = true;
        onMessage = null;
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (ws) {
          try {
            ws.close();
          } catch (err) {
      console.warn("[friday][lark-channel] operation failed:", err instanceof Error ? err.message : String(err));
            // ignore
          }
          ws = null;
        }
        if (webhookRelay?.isListening()) {
          await webhookRelay.stop().catch(() => {
            // ignore cleanup error
          });
        }
        throw error;
      }
    },

    async stop() {
      stopped = true;
      onMessage = null;

      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      if (ws) {
        ws.close();
        ws = null;
      }
      if (webhookRelay?.isListening()) {
        await webhookRelay.stop();
      }
    },

    async send(options: FridayChannelSendOptions) {
      const accessToken = await ensureToken();
      const { chatId, text, replyTo } = options;

      const body: Record<string, unknown> = {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      };

      if (replyTo) {
        body.reply_in_thread = false;
      }

      const url = `${apiBase()}${SEND_MESSAGE_PATH}?receive_id_type=chat_id`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new FridayDomainError("INTERNAL_ERROR", `Lark send failed: ${response.status} ${errorText}`, { httpStatus: 500 });
      }

      const result = (await response.json()) as {
        code: number;
        data?: { message_id?: string };
      };

      if (result.code !== 0) {
        throw new FridayDomainError("INTERNAL_ERROR", `Lark send error: code ${result.code}`, { httpStatus: 500 });
      }

      return { messageId: result.data?.message_id ?? "" };
    },
  };

  return plugin;
}
