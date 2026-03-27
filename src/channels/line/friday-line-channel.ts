/**
 * LINE Channel Plugin — receives via webhook, sends via push/reply API.
 *
 * Webhook events include signature validation (stubbed).
 * Supports both push messages and reply messages.
 */

import { FridayDomainError } from "#errors";
import type {
  FridayChannelMessage,
  FridayChannelPlugin,
  FridayChannelSendOptions,
} from "../friday-channel.types.js";
import type {
  FridayChannelAdapters,
  FridayChannelConfigAdapter,
  FridayChannelInboundAdapter,
  FridayChannelLifecycleAdapter,
  FridayChannelOutboundAdapter,
  FridayChannelStatus,
  FridayChannelStatusAdapter,
} from "../friday-channel-adapters.types.js";
import {
  type FridayLineChannelConfig,
  FridayLineChannelConfigSchema,
} from "./line-config.schema.js";
import type {
  LineApiService,
  LineWebhookEvent,
  LineWebhookListenerService,
  LineWebhookPayload,
} from "./line-service.js";
import {
  createLineApiServiceStub,
  createLineWebhookListenerServiceStub,
} from "./line-service.js";

// ─── Normalizer ───

export function normalizeLineWebhookEvent(event: LineWebhookEvent): FridayChannelMessage | null {
  if (event.type !== "message") return null;
  if (!event.message) return null;
  if (event.message.type !== "text" && event.message.type !== "image") return null;

  const senderId = event.source.userId ?? "";
  const isGroup = event.source.type === "group" || event.source.type === "room";
  const chatId = event.source.groupId ?? event.source.roomId ?? senderId;

  const images: string[] = [];
  if (event.message.type === "image") {
    images.push(event.message.id);
  }

  return {
    id: event.message.id,
    channelKind: "line",
    senderId,
    chatId,
    chatType: isGroup ? "group" : "direct",
    text: event.message.text ?? "",
    images: images.length > 0 ? images : undefined,
    timestamp: event.timestamp,
    raw: { ...event, replyToken: event.replyToken },
  };
}

export function normalizeLineWebhookPayload(
  payload: LineWebhookPayload,
): FridayChannelMessage[] {
  const messages: FridayChannelMessage[] = [];
  for (const event of payload.events) {
    const msg = normalizeLineWebhookEvent(event);
    if (msg) messages.push(msg);
  }
  return messages;
}

// ─── Factory ───

export interface LineChannelDeps {
  webhookListener?: LineWebhookListenerService;
  api?: LineApiService;
}

export function createFridayLineChannel(deps: LineChannelDeps = {}): FridayChannelPlugin {
  const webhookListener = deps.webhookListener ?? createLineWebhookListenerServiceStub();
  const api = deps.api ?? createLineApiServiceStub();

  let config: FridayLineChannelConfig | null = null;
  let connectionStatus: FridayChannelStatus = "disconnected";

  // ─── Config Adapter ───

  const configAdapter: FridayChannelConfigAdapter<FridayLineChannelConfig> = {
    validate(raw) {
      return FridayLineChannelConfigSchema.parse(raw);
    },
    defaults() {
      return { enabled: true, webhookPath: "/webhook/line" };
    },
  };

  // ─── Inbound Adapter ───

  const inboundAdapter: FridayChannelInboundAdapter = {
    normalize(rawEvent: unknown): FridayChannelMessage | null {
      const payload = rawEvent as LineWebhookPayload;
      const messages = normalizeLineWebhookPayload(payload);
      return messages[0] ?? null;
    },
    normalizeAll(rawEvent: unknown): FridayChannelMessage[] {
      return normalizeLineWebhookPayload(rawEvent as LineWebhookPayload);
    },
  };

  // ─── Outbound Adapter ───

  const outboundAdapter: FridayChannelOutboundAdapter = {
    async send(options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "LINE channel not initialized", { httpStatus: 503 });

      await api.pushMessage(config.channelAccessToken, {
        to: options.chatId,
        messages: [{ type: "text", text: options.text }],
      });

      // LINE push API doesn't return a message ID
      return { messageId: `line-push-${Date.now()}` };
    },
  };

  // ─── Status Adapter ───

  const statusAdapter: FridayChannelStatusAdapter = {
    status(): FridayChannelStatus {
      return connectionStatus;
    },
    diagnostics() {
      return {
        webhookPath: config?.webhookPath ?? "/webhook/line",
        listening: webhookListener.isListening(),
      };
    },
  };

  // ─── Lifecycle Adapter ───

  const lifecycleAdapter: FridayChannelLifecycleAdapter = {
    async connect(eventHandler: (rawEvent: unknown) => void) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "LINE channel not initialized", { httpStatus: 503 });
      connectionStatus = "connecting";

      await webhookListener.start(config.webhookPath, config.channelSecret, (payload) => {
        eventHandler(payload);
      });

      connectionStatus = "connected";
    },
    async disconnect() {
      connectionStatus = "disconnected";
      await webhookListener.stop();
    },
  };

  // ─── Plugin ───

  const adapters: FridayChannelAdapters<FridayLineChannelConfig> = {
    config: configAdapter,
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
    lifecycle: lifecycleAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "line",
    adapters,
    contract: {
      coreAuthority: { messageRouting: true, sessionMirroring: true, audit: true, evidence: true },
      pluginResponsibilities: { config: true, auth: true, pairing: false, outboundDelivery: true, threadResolution: false, providerRetries: false },
      supports: { directMessages: true, groupMessages: true, threads: false, typing: false },
    },

    async init(rawConfig) {
      config = configAdapter.validate(rawConfig);
    },

    async start(handler) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "LINE channel not initialized", { httpStatus: 503 });
      connectionStatus = "connecting";

      await webhookListener.start(config.webhookPath, config.channelSecret, (payload) => {
        const messages = normalizeLineWebhookPayload(payload);
        for (const msg of messages) {
          handler(msg);
        }
      });

      connectionStatus = "connected";
    },

    async stop() {
      connectionStatus = "disconnected";
      await webhookListener.stop();
    },

    async send(options: FridayChannelSendOptions) {
      return outboundAdapter.send(options);
    },
  };

  return plugin;
}
