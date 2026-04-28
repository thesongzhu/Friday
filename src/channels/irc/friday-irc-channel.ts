/**
 * IRC Channel Plugin — connects via TCP socket to an IRC server.
 *
 * Normalizes PRIVMSG events into FridayChannelMessage.
 * Sends via PRIVMSG commands.
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
import { formatFridayChannelOutboundText } from "../friday-channel-outbound-formatting.js";
import {
  type FridayIrcChannelConfig,
  FridayIrcChannelConfigSchema,
} from "./irc-config.schema.js";
import type { IrcConnectionService, IrcPrivmsgEvent } from "./irc-service.js";
import { createIrcConnectionServiceStub } from "./irc-service.js";

// ─── Normalizer ───

export function normalizeIrcPrivmsg(
  event: IrcPrivmsgEvent,
  botNick: string,
): FridayChannelMessage | null {
  if (event.command !== "PRIVMSG") return null;
  // Skip messages from self
  if (event.nick === botNick) return null;

  const isChannel = event.target.startsWith("#") || event.target.startsWith("&");
  const isDm = !isChannel;

  return {
    id: `${event.nick}-${event.timestamp}`,
    channelKind: "irc",
    senderId: event.nick,
    senderName: event.nick,
    chatId: isDm ? event.nick : event.target,
    chatType: isDm ? "direct" : "group",
    text: event.message,
    timestamp: event.timestamp,
    raw: event,
  };
}

// ─── Factory ───

export interface IrcChannelDeps {
  connection?: IrcConnectionService;
}

export function createFridayIrcChannel(deps: IrcChannelDeps = {}): FridayChannelPlugin {
  const connection = deps.connection ?? createIrcConnectionServiceStub();

  let config: FridayIrcChannelConfig | null = null;
  let connectionStatus: FridayChannelStatus = "disconnected";

  // ─── Config Adapter ───

  const configAdapter: FridayChannelConfigAdapter<FridayIrcChannelConfig> = {
    validate(raw) {
      return FridayIrcChannelConfigSchema.parse(raw);
    },
    defaults() {
      return { enabled: true, port: 6667, tls: false, channels: [] };
    },
  };

  // ─── Inbound Adapter ───

  const inboundAdapter: FridayChannelInboundAdapter = {
    normalize(rawEvent: unknown): FridayChannelMessage | null {
      if (!config) return null;
      return normalizeIrcPrivmsg(rawEvent as IrcPrivmsgEvent, config.nick);
    },
  };

  // ─── Outbound Adapter ───

  const outboundAdapter: FridayChannelOutboundAdapter = {
    async send(options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "IRC channel not initialized", { httpStatus: 503 });

      await connection.sendMessage(options.chatId, formatFridayChannelOutboundText("irc", options.text));

      // IRC doesn't have message IDs; generate a synthetic one
      return { messageId: `irc-${Date.now()}` };
    },
  };

  // ─── Status Adapter ───

  const statusAdapter: FridayChannelStatusAdapter = {
    status(): FridayChannelStatus {
      return connectionStatus;
    },
    diagnostics() {
      return {
        host: config?.host ?? "",
        port: config?.port ?? 6667,
        tls: config?.tls ?? false,
        nick: config?.nick ?? "",
        connected: connection.isConnected(),
        joinedChannels: connection.joinedChannels(),
      };
    },
  };

  // ─── Lifecycle Adapter ───

  const lifecycleAdapter: FridayChannelLifecycleAdapter = {
    async connect(eventHandler: (rawEvent: unknown) => void) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "IRC channel not initialized", { httpStatus: 503 });
      connectionStatus = "connecting";

      await connection.connect(
        {
          host: config.host,
          port: config.port,
          tls: config.tls,
          nick: config.nick,
          username: config.username,
          password: config.password,
          channels: config.channels,
        },
        (event) => {
          eventHandler(event);
        },
      );

      connectionStatus = "connected";
    },
    async disconnect() {
      connectionStatus = "disconnected";
      await connection.disconnect();
    },
  };

  // ─── Plugin ───

  const adapters: FridayChannelAdapters<FridayIrcChannelConfig> = {
    config: configAdapter,
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
    lifecycle: lifecycleAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "irc",
    adapters,
    contract: {
      coreAuthority: { messageRouting: true, sessionMirroring: true, audit: true, evidence: true },
      pluginResponsibilities: { config: true, auth: true, pairing: false, outboundDelivery: true, threadResolution: false, providerRetries: false },
      supports: { directMessages: false, groupMessages: true, threads: false, typing: false },
    },

    async init(rawConfig) {
      config = configAdapter.validate(rawConfig);
    },

    async start(handler) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "IRC channel not initialized", { httpStatus: 503 });
      connectionStatus = "connecting";

      await connection.connect(
        {
          host: config.host,
          port: config.port,
          tls: config.tls,
          nick: config.nick,
          username: config.username,
          password: config.password,
          channels: config.channels,
        },
        (event) => {
          const msg = inboundAdapter.normalize(event);
          if (msg) handler(msg);
        },
      );

      connectionStatus = "connected";
    },

    async stop() {
      connectionStatus = "disconnected";
      await connection.disconnect();
    },

    async send(options: FridayChannelSendOptions) {
      return outboundAdapter.send(options);
    },
  };

  return plugin;
}
