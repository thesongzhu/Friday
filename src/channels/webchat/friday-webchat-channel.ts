/**
 * Web Chat Channel Plugin — WebSocket-based chat for web UIs.
 *
 * Provides a real-time WebSocket endpoint for browser clients
 * to send and receive messages from Friday.
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
  type FridayWebchatChannelConfig,
  FridayWebchatChannelConfigSchema,
} from "./webchat-config.schema.js";
import type { WebchatInboundMessage, WebchatWsService } from "./webchat-service.js";
import { createWebchatWsServiceStub } from "./webchat-service.js";

// ─── Normalizer ───

export function normalizeWebchatMessage(msg: WebchatInboundMessage): FridayChannelMessage | null {
  if (msg.type !== "message") return null;

  return {
    id: msg.id,
    channelKind: "webchat",
    senderId: msg.clientId,
    senderName: msg.clientName,
    chatId: msg.clientId, // Each client is its own "chat"
    chatType: "direct",
    text: msg.text,
    images: msg.images,
    replyTo: msg.replyTo,
    timestamp: msg.timestamp,
    raw: msg,
  };
}

// ─── Factory ───

export interface WebchatChannelDeps {
  ws?: WebchatWsService;
}

export function createFridayWebchatChannel(deps: WebchatChannelDeps = {}): FridayChannelPlugin {
  const wsService = deps.ws ?? createWebchatWsServiceStub();

  let config: FridayWebchatChannelConfig | null = null;
  let connectionStatus: FridayChannelStatus = "disconnected";

  // ─── Config Adapter ───

  const configAdapter: FridayChannelConfigAdapter<FridayWebchatChannelConfig> = {
    validate(raw) {
      return FridayWebchatChannelConfigSchema.parse(raw);
    },
    defaults() {
      return { enabled: true, wsPath: "/ws/chat", allowedOrigins: [], authMode: "none", maxClients: 100 };
    },
  };

  // ─── Inbound Adapter ───

  const inboundAdapter: FridayChannelInboundAdapter = {
    normalize(rawEvent: unknown): FridayChannelMessage | null {
      return normalizeWebchatMessage(rawEvent as WebchatInboundMessage);
    },
  };

  // ─── Outbound Adapter ───

  const outboundAdapter: FridayChannelOutboundAdapter = {
    async send(options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      const messageId = `webchat-${Date.now()}`;

      await wsService.sendToClient(options.chatId, {
        type: "message",
        id: messageId,
        text: options.text,
        images: options.images,
        replyTo: options.replyTo,
        timestamp: Date.now(),
      });

      return { messageId };
    },
  };

  // ─── Status Adapter ───

  const statusAdapter: FridayChannelStatusAdapter = {
    status(): FridayChannelStatus {
      return connectionStatus;
    },
    diagnostics() {
      return {
        wsPath: config?.wsPath ?? "/ws/chat",
        clientCount: wsService.clientCount(),
        running: wsService.isRunning(),
        authMode: config?.authMode ?? "none",
      };
    },
  };

  // ─── Lifecycle Adapter ───

  const lifecycleAdapter: FridayChannelLifecycleAdapter = {
    async connect(eventHandler: (rawEvent: unknown) => void) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Webchat channel not initialized", { httpStatus: 503 });
      connectionStatus = "connecting";

      await wsService.start(config.wsPath, config.allowedOrigins, (msg) => {
        eventHandler(msg);
      });

      connectionStatus = "connected";
    },
    async disconnect() {
      connectionStatus = "disconnected";
      await wsService.stop();
    },
  };

  // ─── Plugin ───

  const adapters: FridayChannelAdapters<FridayWebchatChannelConfig> = {
    config: configAdapter,
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
    lifecycle: lifecycleAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "webchat",
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
        providerRetries: false,
      },
      supports: {
        directMessages: true,
        groupMessages: false,
        threads: false,
        typing: false,
      },
      curatedSkillIds: ["webchat-channel-status"],
    },

    async init(rawConfig) {
      config = configAdapter.validate(rawConfig);
    },

    async start(handler) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Webchat channel not initialized", { httpStatus: 503 });
      connectionStatus = "connecting";

      await wsService.start(config.wsPath, config.allowedOrigins, (msg) => {
        const normalized = inboundAdapter.normalize(msg);
        if (normalized) handler(normalized);
      });

      connectionStatus = "connected";
    },

    async stop() {
      connectionStatus = "disconnected";
      await wsService.stop();
    },

    async send(options: FridayChannelSendOptions) {
      return outboundAdapter.send(options);
    },
  };

  return plugin;
}
