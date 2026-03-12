/**
 * Discord Channel Plugin — connects to the Discord Gateway via WebSocket.
 *
 * Uses the adapter architecture:
 * - Config adapter validates Discord-specific config
 * - Inbound adapter normalizes MESSAGE_CREATE into FridayChannelMessage
 * - Outbound adapter sends via REST API (stubbed)
 * - Status adapter tracks gateway connection state
 * - Lifecycle adapter manages gateway connect/disconnect
 *
 * External API calls are stubbed behind DiscordGatewayService / DiscordRestService.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

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
  type FridayDiscordChannelConfig,
  FridayDiscordChannelConfigSchema,
} from "./discord-config.schema.js";
import type {
  DiscordGatewayEvent,
  DiscordGatewayService,
  DiscordMessageCreatePayload,
  DiscordRestService,
} from "./discord-service.js";
import {
  createDiscordGatewayServiceStub,
  createDiscordRestServiceStub,
} from "./discord-service.js";

const DISCORD_MAX_EMBEDS = 10;
const DISCORD_MAX_FILES = 10;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function guessImageMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      return undefined;
  }
}

// ─── Normalizer ───

export function normalizeDiscordMessageCreate(
  payload: DiscordMessageCreatePayload,
  requireMention?: boolean,
  botUserId?: string,
): FridayChannelMessage | null {
  // Skip bot messages
  if (payload.author.bot) return null;

  // If requireMention is on, check if bot is mentioned
  if (requireMention && botUserId) {
    const mentioned = payload.mentions?.some((m) => m.id === botUserId);
    if (!mentioned) return null;
  }

  const isDm = !payload.guild_id;
  const images: string[] = [];
  if (payload.attachments) {
    for (const att of payload.attachments) {
      if (att.content_type?.startsWith("image/")) {
        images.push(att.url);
      }
    }
  }

  // OC-006: Populate threadId from Discord thread metadata or cross-channel reply
  const threadId = payload.thread?.id
    ?? (payload.message_reference?.channel_id !== payload.channel_id
      ? payload.message_reference?.channel_id
      : undefined);

  return {
    id: payload.id,
    channelKind: "discord",
    senderId: payload.author.id,
    senderName: payload.author.username,
    chatId: payload.channel_id,
    chatType: isDm ? "direct" : "group",
    text: payload.content,
    images: images.length > 0 ? images : undefined,
    replyTo: payload.message_reference?.message_id,
    threadId,
    timestamp: new Date(payload.timestamp).getTime(),
    raw: payload,
  };
}

// ─── Factory ───

export interface DiscordChannelDeps {
  gateway?: DiscordGatewayService;
  rest?: DiscordRestService;
}

export function createFridayDiscordChannel(deps: DiscordChannelDeps = {}): FridayChannelPlugin {
  const gateway = deps.gateway ?? createDiscordGatewayServiceStub();
  const rest = deps.rest ?? createDiscordRestServiceStub();

  let config: FridayDiscordChannelConfig | null = null;
  let connectionStatus: FridayChannelStatus = "disconnected";
  let onEvent: ((rawEvent: unknown) => void) | null = null;

  // Message-ID dedup — prevents duplicate MESSAGE_CREATE processing
  // (e.g. on gateway reconnect, health monitor restart, or buffered re-delivery)
  const seenMessageIds = new Map<string, ReturnType<typeof setTimeout>>();
  const SEEN_MESSAGE_TTL_MS = 60_000;

  function isDuplicateMessage(event: unknown): boolean {
    const e = event as DiscordGatewayEvent;
    if (e.t !== "MESSAGE_CREATE") return false;
    const payload = e.d as { id?: string } | undefined;
    const msgId = payload?.id;
    if (!msgId) return false;
    if (seenMessageIds.has(msgId)) return true;
    const timer = setTimeout(() => seenMessageIds.delete(msgId), SEEN_MESSAGE_TTL_MS);
    seenMessageIds.set(msgId, timer);
    return false;
  }

  // ─── Config Adapter ───

  const configAdapter: FridayChannelConfigAdapter<FridayDiscordChannelConfig> = {
    validate(raw) {
      return FridayDiscordChannelConfigSchema.parse(raw);
    },
    defaults() {
      return {
        enabled: true,
        intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15),
        requireMention: false,
      };
    },
  };

  // ─── Inbound Adapter ───

  const inboundAdapter: FridayChannelInboundAdapter = {
    normalize(rawEvent: unknown): FridayChannelMessage | null {
      const event = rawEvent as DiscordGatewayEvent;
      if (event.t !== "MESSAGE_CREATE") return null;

      const payload = event.d as DiscordMessageCreatePayload;
      if (!payload?.id || !payload?.author) return null;

      return normalizeDiscordMessageCreate(
        payload,
        config?.requireMention,
        config?.botUserId,
      );
    },
  };

  // ─── Outbound Adapter ───

  const outboundAdapter: FridayChannelOutboundAdapter = {
    async send(options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      if (!config) throw new Error("Discord channel not initialized");

      const embeds: Array<{ image?: { url: string } }> = [];
      const files: Array<{ filename: string; data: Uint8Array; contentType?: string }> = [];
      const skipped: string[] = [];

      for (const rawImage of options.images ?? []) {
        const image = rawImage.trim();
        if (!image) continue;

        if (isHttpUrl(image)) {
          if (embeds.length < DISCORD_MAX_EMBEDS) {
            embeds.push({ image: { url: image } });
          }
          continue;
        }

        try {
          const data = await fs.readFile(image);
          if (files.length < DISCORD_MAX_FILES) {
            files.push({
              filename: path.basename(image) || `image-${String(files.length + 1)}.png`,
              data: new Uint8Array(data),
              contentType: guessImageMimeType(image),
            });
          }
        } catch {
          skipped.push(image);
        }
      }

      const text =
        skipped.length > 0
          ? `${options.text}\n\n[warning] ${String(skipped.length)} image file(s) could not be attached.`
          : options.text;

      const payload = {
        content: text,
        message_reference: options.replyTo
          ? { message_id: options.replyTo }
          : undefined,
        // Keep reply threading without pinging/highlighting the replied user.
        allowed_mentions: options.replyTo
          ? { replied_user: false }
          : undefined,
        ...(embeds.length > 0 ? { embeds } : {}),
        ...(files.length > 0 ? { files } : {}),
      };

      const result = await rest.sendMessage(config.token, options.chatId, payload);

      return { messageId: result.id };
    },
    async typing(chatId: string): Promise<void> {
      if (!config) throw new Error("Discord channel not initialized");
      await rest.sendTyping(config.token, chatId);
    },
  };

  // ─── Status Adapter ───

  const statusAdapter: FridayChannelStatusAdapter = {
    status(): FridayChannelStatus {
      return connectionStatus;
    },
    diagnostics() {
      return {
        connected: gateway.isConnected(),
        requireMention: config?.requireMention ?? false,
        intents: config?.intents ?? 0,
      };
    },
  };

  // ─── Lifecycle Adapter ───

  const lifecycleAdapter: FridayChannelLifecycleAdapter = {
    async connect(eventHandler: (rawEvent: unknown) => void) {
      if (!config) throw new Error("Discord channel not initialized");

      // Re-entry guard: if already connected, skip — the gateway handles its own reconnect internally.
      if (connectionStatus === "connected" && gateway.isConnected()) return;

      // If a connection is in progress, disconnect first to avoid duplicate handlers.
      if (connectionStatus === "connecting") {
        await gateway.disconnect();
      }

      onEvent = eventHandler;
      connectionStatus = "connecting";

      await gateway.connect(config.token, config.intents, (event) => {
        if (isDuplicateMessage(event)) return;
        if (onEvent) onEvent(event);
      }, (status) => {
        connectionStatus = status;
      });

      connectionStatus = "connected";
    },
    async disconnect() {
      connectionStatus = "disconnected";
      onEvent = null;
      for (const timer of seenMessageIds.values()) clearTimeout(timer);
      seenMessageIds.clear();
      await gateway.disconnect();
    },
  };

  // ─── Plugin ───

  const adapters: FridayChannelAdapters<FridayDiscordChannelConfig> = {
    config: configAdapter,
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
    lifecycle: lifecycleAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "discord",
    adapters,

    async init(rawConfig) {
      config = configAdapter.validate(rawConfig);
    },

    async start(handler) {
      if (!config) throw new Error("Discord channel not initialized");

      // Delegate to lifecycle adapter to avoid dual gateway.connect() paths.
      await lifecycleAdapter.connect((event) => {
        const msg = inboundAdapter.normalize(event as DiscordGatewayEvent);
        if (msg) handler(msg);
      });
    },

    async stop() {
      connectionStatus = "disconnected";
      onEvent = null;
      for (const timer of seenMessageIds.values()) clearTimeout(timer);
      seenMessageIds.clear();
      await gateway.disconnect();
    },

    async send(options: FridayChannelSendOptions) {
      return outboundAdapter.send(options);
    },
  };

  return plugin;
}
