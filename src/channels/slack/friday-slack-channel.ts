/**
 * Slack Channel Plugin — connects via Socket Mode or HTTP events.
 *
 * Normalizes Slack message events (DM, channel, thread) into FridayChannelMessage.
 * Sends via Slack Web API (chat.postMessage).
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
  type FridaySlackChannelConfig,
  FridaySlackChannelConfigSchema,
} from "./slack-config.schema.js";
import type {
  SlackHttpEventService,
  SlackMessageEvent,
  SlackSocketService,
  SlackWebApiService,
} from "./slack-service.js";
import {
  createSlackHttpEventServiceStub,
  createSlackSocketServiceStub,
  createSlackWebApiServiceStub,
} from "./slack-service.js";

// ─── Normalizer ───

export function normalizeSlackMessage(event: SlackMessageEvent): FridayChannelMessage | null {
  // Skip bot messages and subtypes (edits, deletes, etc.)
  if (event.bot_id) return null;
  if (event.subtype) return null;

  const isDm = event.channel_type === "im" || event.channel_type === "mpim";
  const images: string[] = [];
  if (event.files) {
    for (const f of event.files) {
      if (f.mimetype.startsWith("image/")) {
        images.push(f.url_private);
      }
    }
  }

  return {
    id: event.ts,
    channelKind: "slack",
    senderId: event.user,
    chatId: event.channel,
    chatType: isDm ? "direct" : "group",
    text: event.text,
    images: images.length > 0 ? images : undefined,
    replyTo: event.thread_ts !== event.ts ? event.thread_ts : undefined,
    timestamp: parseFloat(event.ts) * 1000,
    raw: event,
  };
}

// ─── Factory ───

export interface SlackChannelDeps {
  socket?: SlackSocketService;
  httpEvents?: SlackHttpEventService;
  webApi?: SlackWebApiService;
}

export function createFridaySlackChannel(deps: SlackChannelDeps = {}): FridayChannelPlugin {
  const socket = deps.socket ?? createSlackSocketServiceStub();
  const httpEvents = deps.httpEvents ?? createSlackHttpEventServiceStub();
  const webApi = deps.webApi ?? createSlackWebApiServiceStub();

  let config: FridaySlackChannelConfig | null = null;
  let connectionStatus: FridayChannelStatus = "disconnected";

  // ─── Config Adapter ───

  const configAdapter: FridayChannelConfigAdapter<FridaySlackChannelConfig> = {
    validate(raw) {
      return FridaySlackChannelConfigSchema.parse(raw);
    },
    defaults() {
      return { enabled: true, mode: "socket" };
    },
  };

  // ─── Inbound Adapter ───

  const inboundAdapter: FridayChannelInboundAdapter = {
    normalize(rawEvent: unknown): FridayChannelMessage | null {
      return normalizeSlackMessage(rawEvent as SlackMessageEvent);
    },
  };

  // ─── Outbound Adapter ───

  const outboundAdapter: FridayChannelOutboundAdapter = {
    async send(options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      if (!config) throw new Error("Slack channel not initialized");

      const result = await webApi.sendMessage(config.botToken, {
        channel: options.chatId,
        text: options.text,
        thread_ts: options.replyTo,
      });

      return { messageId: result.ts };
    },
  };

  // ─── Status Adapter ───

  const statusAdapter: FridayChannelStatusAdapter = {
    status(): FridayChannelStatus {
      return connectionStatus;
    },
    diagnostics() {
      return {
        mode: config?.mode ?? "socket",
        connected: socket.isConnected(),
        httpListening: httpEvents.isListening(),
      };
    },
  };

  // ─── Lifecycle Adapter ───

  const lifecycleAdapter: FridayChannelLifecycleAdapter = {
    async connect(eventHandler: (rawEvent: unknown) => void) {
      if (!config) throw new Error("Slack channel not initialized");
      connectionStatus = "connecting";

      if (config.mode === "http") {
        if (!config.signingSecret) {
          throw new Error("Slack HTTP mode requires signingSecret in config");
        }
        await httpEvents.start(config.signingSecret, (event) => {
          eventHandler(event);
        });
      } else {
        await socket.connect(config.appToken ?? "", config.botToken, (event) => {
          eventHandler(event);
        });
      }

      connectionStatus = "connected";
    },
    async disconnect() {
      connectionStatus = "disconnected";
      if (config?.mode === "http") {
        await httpEvents.stop();
      } else {
        await socket.disconnect();
      }
    },
  };

  // ─── Plugin ───

  const adapters: FridayChannelAdapters<FridaySlackChannelConfig> = {
    config: configAdapter,
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
    lifecycle: lifecycleAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "slack",
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
        threadResolution: true,
        providerRetries: false,
      },
      supports: {
        directMessages: true,
        groupMessages: true,
        threads: true,
        typing: false,
      },
      curatedSkillIds: ["slack-channel-status"],
    },

    async init(rawConfig) {
      config = configAdapter.validate(rawConfig);
    },

    async start(handler) {
      if (!config) throw new Error("Slack channel not initialized");
      connectionStatus = "connecting";

      const eventHandler = (event: SlackMessageEvent) => {
        const msg = inboundAdapter.normalize(event);
        if (msg) handler(msg);
      };

      if (config.mode === "http") {
        if (!config.signingSecret) {
          throw new Error("Slack HTTP mode requires signingSecret in config");
        }
        await httpEvents.start(config.signingSecret, eventHandler);
      } else {
        await socket.connect(config.appToken ?? "", config.botToken, eventHandler);
      }

      connectionStatus = "connected";
    },

    async stop() {
      connectionStatus = "disconnected";
      if (config?.mode === "http") {
        await httpEvents.stop();
      } else {
        await socket.disconnect();
      }
    },

    async send(options: FridayChannelSendOptions) {
      return outboundAdapter.send(options);
    },
  };

  return plugin;
}
