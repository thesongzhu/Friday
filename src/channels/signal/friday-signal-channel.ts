/**
 * Signal Channel Plugin — connects to signal-cli daemon via SSE.
 *
 * Uses signal-cli REST API for both receiving (SSE) and sending (JSON-RPC).
 * External calls are stubbed behind SignalSseService / SignalRpcService.
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
  type FridaySignalChannelConfig,
  FridaySignalChannelConfigSchema,
} from "./signal-config.schema.js";
import type {
  SignalInboundMessage,
  SignalRpcService,
  SignalSseService,
} from "./signal-service.js";
import {
  createSignalRpcServiceStub,
  createSignalSseServiceStub,
} from "./signal-service.js";

// ─── Normalizer ───

export function normalizeSignalMessage(msg: SignalInboundMessage): FridayChannelMessage | null {
  const env = msg.envelope;
  if (!env.dataMessage) return null;

  const isGroup = !!env.dataMessage.groupInfo;
  const images: string[] = [];
  if (env.dataMessage.attachments) {
    for (const att of env.dataMessage.attachments) {
      if (att.contentType.startsWith("image/")) {
        images.push(att.id);
      }
    }
  }

  return {
    id: `${env.sourceNumber}-${env.dataMessage.timestamp}`,
    channelKind: "signal",
    senderId: env.sourceNumber,
    senderName: env.sourceName,
    chatId: isGroup ? env.dataMessage.groupInfo!.groupId : env.sourceNumber,
    chatType: isGroup ? "group" : "direct",
    text: env.dataMessage.message ?? "",
    images: images.length > 0 ? images : undefined,
    replyTo: env.dataMessage.quote ? String(env.dataMessage.quote.id) : undefined,
    timestamp: env.dataMessage.timestamp,
    raw: msg,
  };
}

// ─── Factory ───

export interface SignalChannelDeps {
  sse?: SignalSseService;
  rpc?: SignalRpcService;
}

export function createFridaySignalChannel(deps: SignalChannelDeps = {}): FridayChannelPlugin {
  const sse = deps.sse ?? createSignalSseServiceStub();
  const rpc = deps.rpc ?? createSignalRpcServiceStub();

  let config: FridaySignalChannelConfig | null = null;
  let connectionStatus: FridayChannelStatus = "disconnected";

  // ─── Config Adapter ───

  const configAdapter: FridayChannelConfigAdapter<FridaySignalChannelConfig> = {
    validate(raw) {
      return FridaySignalChannelConfigSchema.parse(raw);
    },
    defaults() {
      return { enabled: true, baseUrl: "http://localhost:8080" };
    },
  };

  // ─── Inbound Adapter ───

  const inboundAdapter: FridayChannelInboundAdapter = {
    normalize(rawEvent: unknown): FridayChannelMessage | null {
      return normalizeSignalMessage(rawEvent as SignalInboundMessage);
    },
  };

  // ─── Outbound Adapter ───

  const outboundAdapter: FridayChannelOutboundAdapter = {
    async send(options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Signal channel not initialized", { httpStatus: 503 });

      const result = await rpc.sendMessage(config.baseUrl, config.account, {
        recipients: [options.chatId],
        message: options.text,
        quote_timestamp: options.replyTo ? parseInt(options.replyTo, 10) : undefined,
      });

      return { messageId: String(result.timestamp) };
    },
  };

  // ─── Status Adapter ───

  const statusAdapter: FridayChannelStatusAdapter = {
    status(): FridayChannelStatus {
      return connectionStatus;
    },
    diagnostics() {
      return {
        baseUrl: config?.baseUrl ?? "",
        account: config?.account ?? "",
        connected: sse.isConnected(),
      };
    },
  };

  // ─── Lifecycle Adapter ───

  const lifecycleAdapter: FridayChannelLifecycleAdapter = {
    async connect(eventHandler: (rawEvent: unknown) => void) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Signal channel not initialized", { httpStatus: 503 });
      connectionStatus = "connecting";

      await sse.connect(config.baseUrl, config.account, (msg) => {
        eventHandler(msg);
      });

      connectionStatus = "connected";
    },
    async disconnect() {
      connectionStatus = "disconnected";
      await sse.disconnect();
    },
  };

  // ─── Plugin ───

  const adapters: FridayChannelAdapters<FridaySignalChannelConfig> = {
    config: configAdapter,
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
    lifecycle: lifecycleAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "signal",
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
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Signal channel not initialized", { httpStatus: 503 });
      connectionStatus = "connecting";

      await sse.connect(config.baseUrl, config.account, (msg) => {
        const normalized = inboundAdapter.normalize(msg);
        if (normalized) handler(normalized);
      });

      connectionStatus = "connected";
    },

    async stop() {
      connectionStatus = "disconnected";
      await sse.disconnect();
    },

    async send(options: FridayChannelSendOptions) {
      return outboundAdapter.send(options);
    },
  };

  return plugin;
}
