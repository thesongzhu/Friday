/**
 * WhatsApp Channel Plugin — receives via webhook, sends via Cloud API or bridge.
 *
 * Supports two providers:
 * - cloud-api: Official Meta Cloud API
 * - bridge: Third-party bridge (e.g. whatsapp-web.js bridge)
 */

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
  type FridayWhatsappChannelConfig,
  FridayWhatsappChannelConfigSchema,
} from "./whatsapp-config.schema.js";
import type {
  WhatsappApiService,
  WhatsappWebhookMessage,
  WhatsappWebhookService,
} from "./whatsapp-service.js";
import {
  createWhatsappApiServiceStub,
  createWhatsappWebhookServiceStub,
} from "./whatsapp-service.js";

// ─── Normalizer ───

export function normalizeWhatsappWebhook(
  event: WhatsappWebhookMessage,
): FridayChannelMessage[] {
  const messages: FridayChannelMessage[] = [];

  for (const entry of event.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const value = change.value;
      if (!value.messages) continue;

      const contactMap = new Map<string, string>();
      if (value.contacts) {
        for (const c of value.contacts) {
          contactMap.set(c.wa_id, c.profile.name);
        }
      }

      for (const msg of value.messages) {
        if (msg.type !== "text" && msg.type !== "image") continue;

        const text = msg.text?.body ?? msg.image?.caption ?? "";
        const images: string[] = [];
        if (msg.image) {
          images.push(msg.image.id);
        }

        messages.push({
          id: msg.id,
          channelKind: "whatsapp",
          senderId: msg.from,
          senderName: contactMap.get(msg.from),
          chatId: msg.from, // WhatsApp 1:1 chats use sender as chatId
          chatType: "direct",
          text,
          images: images.length > 0 ? images : undefined,
          timestamp: parseInt(msg.timestamp, 10) * 1000,
          raw: msg,
        });
      }
    }
  }

  return messages;
}

// ─── Factory ───

export interface WhatsappChannelDeps {
  webhook?: WhatsappWebhookService;
  api?: WhatsappApiService;
}

export function createFridayWhatsappChannel(deps: WhatsappChannelDeps = {}): FridayChannelPlugin {
  const webhook = deps.webhook ?? createWhatsappWebhookServiceStub();
  const api = deps.api ?? createWhatsappApiServiceStub();

  let config: FridayWhatsappChannelConfig | null = null;
  let connectionStatus: FridayChannelStatus = "disconnected";

  // ─── Config Adapter ───

  const configAdapter: FridayChannelConfigAdapter<FridayWhatsappChannelConfig> = {
    validate(raw) {
      return FridayWhatsappChannelConfigSchema.parse(raw);
    },
    defaults() {
      return { enabled: true, provider: "cloud-api" };
    },
  };

  // ─── Inbound Adapter ───

  const inboundAdapter: FridayChannelInboundAdapter = {
    normalize(rawEvent: unknown): FridayChannelMessage | null {
      const event = rawEvent as WhatsappWebhookMessage;
      const messages = normalizeWhatsappWebhook(event);
      return messages[0] ?? null;
    },
    normalizeAll(rawEvent: unknown): FridayChannelMessage[] {
      return normalizeWhatsappWebhook(rawEvent as WhatsappWebhookMessage);
    },
  };

  // ─── Outbound Adapter ───

  const outboundAdapter: FridayChannelOutboundAdapter = {
    async send(options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      if (!config) throw new Error("WhatsApp channel not initialized");

      if (config.provider === "cloud-api") {
        if (!config.accessToken || !config.phoneNumberId) {
          throw new Error("WhatsApp Cloud API requires accessToken and phoneNumberId");
        }

        const result = await api.sendMessage(config.accessToken, config.phoneNumberId, {
          messaging_product: "whatsapp",
          to: options.chatId,
          type: "text",
          text: { body: options.text },
          context: options.replyTo ? { message_id: options.replyTo } : undefined,
        });

        return { messageId: result.messages[0]?.id ?? "" };
      }

      // Bridge mode: stub
      return { messageId: `bridge-stub-${Date.now()}` };
    },
  };

  // ─── Status Adapter ───

  const statusAdapter: FridayChannelStatusAdapter = {
    status(): FridayChannelStatus {
      return connectionStatus;
    },
    diagnostics() {
      return {
        provider: config?.provider ?? "cloud-api",
        listening: webhook.isListening(),
      };
    },
  };

  // ─── Lifecycle Adapter ───

  const lifecycleAdapter: FridayChannelLifecycleAdapter = {
    async connect(eventHandler: (rawEvent: unknown) => void) {
      if (!config) throw new Error("WhatsApp channel not initialized");
      connectionStatus = "connecting";

      webhook.setAppSecret?.(config.appSecret);
      await webhook.startWebhook(config.webhookVerifyToken ?? "", (event) => {
        eventHandler(event);
      });

      connectionStatus = "connected";
    },
    async disconnect() {
      connectionStatus = "disconnected";
      await webhook.stopWebhook();
    },
  };

  // ─── Plugin ───

  const adapters: FridayChannelAdapters<FridayWhatsappChannelConfig> = {
    config: configAdapter,
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
    lifecycle: lifecycleAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "whatsapp",
    adapters,
    contract: {
      coreAuthority: {
        messageRouting: true,
        sessionMirroring: true,
        audit: true,
        evidence: true,
      },
      pluginResponsibilities: {
        config: true,
        auth: true,
        pairing: true,
        outboundDelivery: true,
        threadResolution: false,
        providerRetries: false,
      },
      supports: {
        directMessages: true,
        groupMessages: false,
        threads: false,
        typing: false,
      },
      curatedSkillIds: ["whatsapp-channel-status"],
    },

    async init(rawConfig) {
      config = configAdapter.validate(rawConfig);
    },

    async start(handler) {
      if (!config) throw new Error("WhatsApp channel not initialized");
      connectionStatus = "connecting";

      webhook.setAppSecret?.(config.appSecret);
      await webhook.startWebhook(config.webhookVerifyToken ?? "", (event) => {
        const messages = normalizeWhatsappWebhook(event);
        for (const msg of messages) {
          handler(msg);
        }
      });

      connectionStatus = "connected";
    },

    async stop() {
      connectionStatus = "disconnected";
      await webhook.stopWebhook();
    },

    async send(options: FridayChannelSendOptions) {
      return outboundAdapter.send(options);
    },
  };

  return plugin;
}
