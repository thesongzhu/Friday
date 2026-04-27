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

import * as Lark from "@larksuiteoapi/node-sdk";
import type { WSClient as LarkWsClient } from "@larksuiteoapi/node-sdk";
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
import type { LarkWebhookRelayService } from "./lark-webhook-relay.js";

// ─── Constants ───

const FEISHU_API_BASE = "https://open.feishu.cn";
const LARK_API_BASE = "https://open.larksuite.com";

const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const SEND_MESSAGE_PATH = "/open-apis/im/v1/messages";

const TOKEN_REFRESH_BUFFER_MS = 60_000;
const WS_READY_TIMEOUT_MS = 15_000;

// ─── Internal Types ───

interface LarkAccessToken {
  tenantAccessToken: string;
  expiresAt: number;
}

interface LarkConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
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
  let wsClient: LarkWsClient | null = null;
  let connectionStatus: FridayChannelStatus = "disconnected";
  let lastConnectionError: string | undefined;
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
    const eventData = (event.event as Record<string, unknown> | undefined) ?? event;

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

  async function connectWebSocketWithSdk(eventHandler: (rawEvent: unknown) => void): Promise<void> {
    if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Lark channel not initialized", { httpStatus: 503 });
    const larkConfig = config;

    connectionStatus = "connecting";
    lastConnectionError = undefined;

    const readyTimeoutMs = Math.max(
      1_000,
      Number.parseInt(process.env.FRIDAY_LARK_WS_READY_TIMEOUT_MS ?? String(WS_READY_TIMEOUT_MS), 10) || WS_READY_TIMEOUT_MS,
    );

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const fail = (message: string): void => {
        connectionStatus = "error";
        lastConnectionError = message;
        wsClient?.close({ force: true });
        wsClient = null;
        settle(() => reject(new FridayDomainError("INTERNAL_ERROR", message, { httpStatus: 500 })));
      };
      const timer = setTimeout(() => {
        fail(
          "Lark SDK WebSocket did not become ready. Check that the Feishu app uses long-connection event subscription and has im.message.receive_v1 enabled.",
        );
      }, readyTimeoutMs);

      const client = new Lark.WSClient({
        appId: larkConfig.appId,
        appSecret: larkConfig.appSecret,
        domain: larkConfig.useFeishu ? Lark.Domain.Feishu : Lark.Domain.Lark,
        loggerLevel: Lark.LoggerLevel.warn,
        source: "friday",
        autoReconnect: true,
        onReady: () => {
          connectionStatus = "connected";
          lastConnectionError = undefined;
          settle(resolve);
        },
        onReconnecting: () => {
          connectionStatus = "connecting";
        },
        onReconnected: () => {
          connectionStatus = "connected";
          lastConnectionError = undefined;
        },
        onError: (error) => {
          fail(`Lark SDK WebSocket failed: ${error.message}`);
        },
      });

      wsClient = client;

      const eventDispatcher = new Lark.EventDispatcher({
        verificationToken: larkConfig.verificationToken,
        encryptKey: larkConfig.encryptKey,
        loggerLevel: Lark.LoggerLevel.warn,
      }).register({
        "im.message.receive_v1": async (data: unknown) => {
          eventHandler({ event: data });
        },
      });

      void client.start({ eventDispatcher }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        fail(`Lark SDK WebSocket failed: ${message}`);
      });
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
      return connectionStatus;
    },
    diagnostics() {
      return {
        hasToken: token !== null,
        useFeishu: config?.useFeishu ?? false,
        receiveMode: config?.receiveMode ?? "websocket",
        webhookListening: webhookRelay?.isListening() ?? false,
        sdkWebSocket: config?.receiveMode !== "webhook",
        lastConnectionError,
      };
    },
  };

  // ─── Lifecycle Adapter ───

  const lifecycleAdapter: FridayChannelLifecycleAdapter = {
    async connect(eventHandler: (rawEvent: unknown) => void) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Lark channel not initialized", { httpStatus: 503 });
      stopped = false;
      connectionStatus = "connecting";
      lastConnectionError = undefined;

      try {
        await refreshToken();

        if (config.receiveMode === "websocket") {
          await connectWebSocketWithSdk(eventHandler);
        } else {
          if (!webhookRelay) {
            throw new FridayDomainError("VALIDATION_ERROR", "Lark webhook mode requires webhookRelay dependency", { httpStatus: 400 });
          }
          webhookRelay.setVerificationToken(config.verificationToken);
          webhookRelay.setEncryptKey(config.encryptKey);
          await webhookRelay.start((event) => {
            eventHandler(event);
          });
          connectionStatus = "connected";
        }
      } catch (error) {
        stopped = true;
        connectionStatus = "error";
        lastConnectionError = error instanceof Error ? error.message : String(error);
        if (wsClient) { try { wsClient.close({ force: true }); } catch { /* ignore */ } wsClient = null; }
        if (webhookRelay?.isListening()) {
          await webhookRelay.stop().catch(() => { /* ignore cleanup error */ });
        }
        throw error;
      }
    },
    async disconnect() {
      stopped = true;
      connectionStatus = "disconnected";
      lastConnectionError = undefined;

      if (wsClient) { wsClient.close({ force: true }); wsClient = null; }
      if (webhookRelay?.isListening()) {
        await webhookRelay.stop();
      }
    },
  };

  const adapters: FridayChannelAdapters = {
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
    lifecycle: lifecycleAdapter,
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
        verificationToken: parsed.verificationToken,
        encryptKey: parsed.encryptKey,
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
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Lark channel not initialized", { httpStatus: 503 });

      // Delegate to lifecycle adapter, then wire up the message handler
      await lifecycleAdapter.connect((event) => {
        const msg = inboundAdapter.normalize(event);
        if (msg) handler(msg);
      });
    },

    async stop() {
      await lifecycleAdapter.disconnect();
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
