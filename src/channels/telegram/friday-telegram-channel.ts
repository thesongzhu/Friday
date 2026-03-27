/**
 * Telegram Channel Plugin — connects via Bot API polling or webhook.
 *
 * Uses the adapter architecture for modular message normalization,
 * outbound sending, and lifecycle management.
 *
 * External API calls are stubbed behind TelegramPollingService / TelegramApiService.
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
  type FridayTelegramChannelConfig,
  FridayTelegramChannelConfigSchema,
} from "./telegram-config.schema.js";
import type {
  TelegramApiService,
  TelegramMessage,
  TelegramPollingService,
  TelegramUpdate,
  TelegramWebhookService,
} from "./telegram-service.js";
import {
  createTelegramApiServiceStub,
  createTelegramPollingServiceStub,
  createTelegramWebhookServiceStub,
} from "./telegram-service.js";

// ─── Normalizer ───

export function normalizeTelegramUpdate(update: TelegramUpdate): FridayChannelMessage | null {
  const msg = update.message;
  if (!msg) return null;
  if (!msg.from) return null;
  if (msg.from.is_bot) return null;

  const isPrivate = msg.chat.type === "private";
  const images: string[] = [];
  if (msg.photo && msg.photo.length > 0) {
    // Use largest photo (last in array)
    images.push(msg.photo[msg.photo.length - 1].file_id);
  }

  return {
    id: String(msg.message_id),
    channelKind: "telegram",
    senderId: String(msg.from.id),
    senderName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
    chatId: String(msg.chat.id),
    chatType: isPrivate ? "direct" : "group",
    text: msg.text ?? "",
    images: images.length > 0 ? images : undefined,
    replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
    timestamp: msg.date * 1000,
    raw: update,
  };
}

// ─── Factory ───

export interface TelegramChannelDeps {
  polling?: TelegramPollingService;
  webhook?: TelegramWebhookService;
  api?: TelegramApiService;
}

export function createFridayTelegramChannel(deps: TelegramChannelDeps = {}): FridayChannelPlugin {
  const polling = deps.polling ?? createTelegramPollingServiceStub();
  const webhookService = deps.webhook ?? createTelegramWebhookServiceStub();
  const api = deps.api ?? createTelegramApiServiceStub();

  let config: FridayTelegramChannelConfig | null = null;
  let connectionStatus: FridayChannelStatus = "disconnected";

  // ─── Config Adapter ───

  const configAdapter: FridayChannelConfigAdapter<FridayTelegramChannelConfig> = {
    validate(raw) {
      return FridayTelegramChannelConfigSchema.parse(raw);
    },
    defaults() {
      return { enabled: true, mode: "polling" };
    },
  };

  // ─── Inbound Adapter ───

  const inboundAdapter: FridayChannelInboundAdapter = {
    normalize(rawEvent: unknown): FridayChannelMessage | null {
      return normalizeTelegramUpdate(rawEvent as TelegramUpdate);
    },
  };

  // ─── Outbound Adapter ───

  const outboundAdapter: FridayChannelOutboundAdapter = {
    async send(options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Telegram channel not initialized", { httpStatus: 503 });

      const result = await api.sendMessage(config.botToken, {
        chat_id: options.chatId,
        text: options.text,
        reply_to_message_id: options.replyTo ? parseInt(options.replyTo, 10) : undefined,
      });

      return { messageId: String(result.result.message_id) };
    },
  };

  // ─── Status Adapter ───

  const statusAdapter: FridayChannelStatusAdapter = {
    status(): FridayChannelStatus {
      return connectionStatus;
    },
    diagnostics() {
      return {
        mode: config?.mode ?? "polling",
        polling: polling.isPolling(),
        webhook: webhookService.isListening(),
      };
    },
  };

  // ─── Lifecycle Adapter ───

  const lifecycleAdapter: FridayChannelLifecycleAdapter = {
    async connect(eventHandler: (rawEvent: unknown) => void) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Telegram channel not initialized", { httpStatus: 503 });
      connectionStatus = "connecting";

      if (config.mode === "webhook") {
        if (!config.webhookUrl) {
          throw new FridayDomainError("VALIDATION_ERROR", "Telegram webhook mode requires webhookUrl in config", { httpStatus: 400 });
        }
        await webhookService.startWebhook(config.botToken, config.webhookUrl, (update) => {
          eventHandler(update);
        });
      } else {
        await polling.startPolling(config.botToken, (update) => {
          eventHandler(update);
        });
      }

      connectionStatus = "connected";
    },
    async disconnect() {
      connectionStatus = "disconnected";
      if (config?.mode === "webhook") {
        await webhookService.stopWebhook();
      } else {
        await polling.stopPolling();
      }
    },
  };

  // ─── Plugin ───

  const adapters: FridayChannelAdapters<FridayTelegramChannelConfig> = {
    config: configAdapter,
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
    lifecycle: lifecycleAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "telegram",
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
        pairing: false,
        outboundDelivery: true,
        threadResolution: false,
        providerRetries: true,
      },
      supports: {
        directMessages: true,
        groupMessages: true,
        threads: false,
        typing: false,
      },
      curatedSkillIds: ["telegram-channel-status"],
    },

    async init(rawConfig) {
      config = configAdapter.validate(rawConfig);
    },

    async start(handler) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Telegram channel not initialized", { httpStatus: 503 });
      connectionStatus = "connecting";

      const updateHandler = (update: TelegramUpdate) => {
        const msg = inboundAdapter.normalize(update);
        if (msg) handler(msg);
      };

      if (config.mode === "webhook") {
        if (!config.webhookUrl) {
          throw new FridayDomainError("VALIDATION_ERROR", "Telegram webhook mode requires webhookUrl in config", { httpStatus: 400 });
        }
        await webhookService.startWebhook(config.botToken, config.webhookUrl, updateHandler);
      } else {
        await polling.startPolling(config.botToken, updateHandler);
      }

      connectionStatus = "connected";
    },

    async stop() {
      connectionStatus = "disconnected";
      if (config?.mode === "webhook") {
        await webhookService.stopWebhook();
      } else {
        await polling.stopPolling();
      }
    },

    async send(options: FridayChannelSendOptions) {
      return outboundAdapter.send(options);
    },
  };

  return plugin;
}
