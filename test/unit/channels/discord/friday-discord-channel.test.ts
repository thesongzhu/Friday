import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createFridayDiscordChannel,
  normalizeDiscordMessageCreate,
} from "#channels";
import type {
  FridayChannelPlugin,
  FridayChannelMessage,
} from "#channels";
import type {
  DiscordGatewayService,
  DiscordRestService,
  DiscordGatewayEvent,
  DiscordMessageCreatePayload,
  DiscordGatewayStatusChange,
  DiscordSendMessagePayload,
} from "../../../../src/channels/discord/discord-service.js";
import { FridayDiscordChannelConfigSchema } from "../../../../src/channels/discord/discord-config.schema.js";

// ─── Mock Services ───

function createMockGateway(): DiscordGatewayService & {
  _onEvent: ((event: DiscordGatewayEvent) => void) | null;
  _onStatusChange: ((status: DiscordGatewayStatusChange) => void) | null;
} {
  let connected = false;
  let onEventFn: ((event: DiscordGatewayEvent) => void) | null = null;
  let onStatusChangeFn: ((status: DiscordGatewayStatusChange) => void) | null = null;

  return {
    get _onEvent() {
      return onEventFn;
    },
    get _onStatusChange() {
      return onStatusChangeFn;
    },
    async connect(_token, _intents, onEvent, onStatusChange) {
      connected = true;
      onEventFn = onEvent;
      onStatusChangeFn = onStatusChange ?? null;
    },
    async disconnect() {
      connected = false;
      onEventFn = null;
      onStatusChangeFn = null;
    },
    isConnected() {
      return connected;
    },
  };
}

function createMockRest(): DiscordRestService & {
  calls: Array<{ channelId: string; payload: unknown }>;
  typingCalls: string[];
} {
  const calls: Array<{ channelId: string; payload: unknown }> = [];
  const typingCalls: string[] = [];
  return {
    calls,
    typingCalls,
    async sendMessage(_token, channelId, payload) {
      calls.push({ channelId, payload });
      return { id: `sent-${Date.now()}` };
    },
    async sendTyping(_token, channelId) {
      typingCalls.push(channelId);
    },
  };
}

describe("FridayDiscordChannel", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let rest: ReturnType<typeof createMockRest>;
  let plugin: FridayChannelPlugin;

  beforeEach(() => {
    gateway = createMockGateway();
    rest = createMockRest();
    plugin = createFridayDiscordChannel({ gateway, rest });
  });

  // ─── Config Validation ───

  describe("config validation", () => {
    it("validates valid Discord config", () => {
      const result = FridayDiscordChannelConfigSchema.parse({
        kind: "discord",
        token: "test-token",
      });
      expect(result.kind).toBe("discord");
      expect(result.token).toBe("test-token");
      expect(result.enabled).toBe(true);
      expect(result.requireMention).toBe(false);
    });

    it("rejects config without token", () => {
      expect(() =>
        FridayDiscordChannelConfigSchema.parse({ kind: "discord" }),
      ).toThrow();
    });

    it("applies default intents", () => {
      const result = FridayDiscordChannelConfigSchema.parse({
        kind: "discord",
        token: "t",
      });
      expect(result.intents).toBeDefined();
      expect(typeof result.intents).toBe("number");
    });

    it("accepts custom intents", () => {
      const result = FridayDiscordChannelConfigSchema.parse({
        kind: "discord",
        token: "t",
        intents: 42,
      });
      expect(result.intents).toBe(42);
    });

    it("accepts botUserId", () => {
      const result = FridayDiscordChannelConfigSchema.parse({
        kind: "discord",
        token: "t",
        botUserId: "bot-123",
      });
      expect(result.botUserId).toBe("bot-123");
    });
  });

  // ─── Init ───

  describe("init", () => {
    it("initializes with valid config", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      expect(plugin.kind).toBe("discord");
    });

    it("rejects invalid config on init", async () => {
      await expect(plugin.init({ kind: "discord" })).rejects.toThrow();
    });
  });

  // ─── Inbound Normalization ───

  describe("inbound normalization", () => {
    it("normalizes MESSAGE_CREATE into FridayChannelMessage", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "msg-123",
        channel_id: "ch-456",
        guild_id: "guild-789",
        author: { id: "user-1", username: "TestUser", bot: false },
        content: "Hello Friday!",
        timestamp: "2026-02-21T12:00:00.000Z",
        mentions: [],
      };

      const result = normalizeDiscordMessageCreate(payload);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("msg-123");
      expect(result!.channelKind).toBe("discord");
      expect(result!.senderId).toBe("user-1");
      expect(result!.senderName).toBe("TestUser");
      expect(result!.chatId).toBe("ch-456");
      expect(result!.chatType).toBe("group");
      expect(result!.text).toBe("Hello Friday!");
    });

    it("normalizes DM (no guild_id) as direct", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "dm-1",
        channel_id: "dm-ch-1",
        author: { id: "user-2", username: "DmUser", bot: false },
        content: "Private message",
        timestamp: "2026-02-21T12:00:00.000Z",
      };

      const result = normalizeDiscordMessageCreate(payload);
      expect(result).not.toBeNull();
      expect(result!.chatType).toBe("direct");
    });

    it("skips bot messages", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "bot-msg",
        channel_id: "ch-1",
        guild_id: "g-1",
        author: { id: "bot-1", username: "Bot", bot: true },
        content: "Bot message",
        timestamp: "2026-02-21T12:00:00.000Z",
      };

      const result = normalizeDiscordMessageCreate(payload);
      expect(result).toBeNull();
    });

    it("filters by requireMention when botUserId is provided", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "msg-1",
        channel_id: "ch-1",
        guild_id: "g-1",
        author: { id: "user-1", username: "User", bot: false },
        content: "Not mentioning bot",
        timestamp: "2026-02-21T12:00:00.000Z",
        mentions: [],
      };

      const result = normalizeDiscordMessageCreate(payload, true, "bot-id-1");
      expect(result).toBeNull();
    });

    it("passes requireMention filter when bot is mentioned", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "msg-1",
        channel_id: "ch-1",
        guild_id: "g-1",
        author: { id: "user-1", username: "User", bot: false },
        content: "Hey <@bot-id-1>!",
        timestamp: "2026-02-21T12:00:00.000Z",
        mentions: [{ id: "bot-id-1" }],
      };

      const result = normalizeDiscordMessageCreate(payload, true, "bot-id-1");
      expect(result).not.toBeNull();
    });

    it("extracts image attachments", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "img-msg",
        channel_id: "ch-1",
        author: { id: "user-1", username: "User", bot: false },
        content: "Check this out",
        timestamp: "2026-02-21T12:00:00.000Z",
        attachments: [
          { id: "att-1", filename: "pic.png", content_type: "image/png", url: "https://cdn.example.com/pic.png", size: 1024 },
          { id: "att-2", filename: "doc.pdf", content_type: "application/pdf", url: "https://cdn.example.com/doc.pdf", size: 2048 },
        ],
      };

      const result = normalizeDiscordMessageCreate(payload);
      expect(result!.images).toEqual(["https://cdn.example.com/pic.png"]);
    });

    it("extracts reply reference", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "reply-msg",
        channel_id: "ch-1",
        author: { id: "user-1", username: "User", bot: false },
        content: "This is a reply",
        timestamp: "2026-02-21T12:00:00.000Z",
        message_reference: { message_id: "original-msg-1" },
      };

      const result = normalizeDiscordMessageCreate(payload);
      expect(result!.replyTo).toBe("original-msg-1");
    });

    // ─── OC-006: threadId extraction ───

    it("extracts threadId from Discord thread metadata", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "thread-msg-1",
        channel_id: "ch-1",
        guild_id: "g-1",
        author: { id: "user-1", username: "User", bot: false },
        content: "Message in thread",
        timestamp: "2026-02-21T12:00:00.000Z",
        thread: { id: "thread-123" },
      };

      const result = normalizeDiscordMessageCreate(payload);
      expect(result).not.toBeNull();
      expect(result!.threadId).toBe("thread-123");
    });

    it("uses cross-channel message_reference as threadId fallback", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "xref-msg-1",
        channel_id: "ch-1",
        guild_id: "g-1",
        author: { id: "user-1", username: "User", bot: false },
        content: "Cross-channel reply",
        timestamp: "2026-02-21T12:00:00.000Z",
        message_reference: { message_id: "msg-99", channel_id: "ch-2" },
      };

      const result = normalizeDiscordMessageCreate(payload);
      expect(result).not.toBeNull();
      expect(result!.threadId).toBe("ch-2");
    });

    it("does not set threadId for same-channel reply", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "same-ch-reply",
        channel_id: "ch-1",
        guild_id: "g-1",
        author: { id: "user-1", username: "User", bot: false },
        content: "Same channel reply",
        timestamp: "2026-02-21T12:00:00.000Z",
        message_reference: { message_id: "msg-50", channel_id: "ch-1" },
      };

      const result = normalizeDiscordMessageCreate(payload);
      expect(result).not.toBeNull();
      expect(result!.threadId).toBeUndefined();
    });

    it("prefers thread.id over cross-channel reference", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "both-msg",
        channel_id: "ch-1",
        guild_id: "g-1",
        author: { id: "user-1", username: "User", bot: false },
        content: "Thread takes precedence",
        timestamp: "2026-02-21T12:00:00.000Z",
        thread: { id: "thread-456" },
        message_reference: { message_id: "msg-77", channel_id: "ch-3" },
      };

      const result = normalizeDiscordMessageCreate(payload);
      expect(result).not.toBeNull();
      expect(result!.threadId).toBe("thread-456");
    });

    it("does not set threadId when neither thread nor cross-channel ref exist", () => {
      const payload: DiscordMessageCreatePayload = {
        id: "plain-msg",
        channel_id: "ch-1",
        guild_id: "g-1",
        author: { id: "user-1", username: "User", bot: false },
        content: "Plain message",
        timestamp: "2026-02-21T12:00:00.000Z",
      };

      const result = normalizeDiscordMessageCreate(payload);
      expect(result).not.toBeNull();
      expect(result!.threadId).toBeUndefined();
    });
  });

  // ─── Adapter Dispatch ───

  describe("adapter dispatch", () => {
    it("inbound adapter normalizes gateway events", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      const adapter = plugin.adapters!.inbound!;

      const event: DiscordGatewayEvent = {
        op: 0,
        t: "MESSAGE_CREATE",
        s: 1,
        d: {
          id: "msg-1",
          channel_id: "ch-1",
          guild_id: "g-1",
          author: { id: "u-1", username: "Test", bot: false },
          content: "test",
          timestamp: "2026-02-21T12:00:00.000Z",
        },
      };

      const result = adapter.normalize(event);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("msg-1");
    });

    it("inbound adapter ignores non-MESSAGE_CREATE events", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      const adapter = plugin.adapters!.inbound!;

      const event: DiscordGatewayEvent = {
        op: 0,
        t: "PRESENCE_UPDATE",
        s: 1,
        d: {},
      };

      expect(adapter.normalize(event)).toBeNull();
    });

    it("inbound adapter uses botUserId from config for requireMention", async () => {
      const mentionPlugin = createFridayDiscordChannel({ gateway, rest });
      await mentionPlugin.init({
        kind: "discord",
        token: "test-token",
        requireMention: true,
        botUserId: "bot-id-99",
      });
      const adapter = mentionPlugin.adapters!.inbound!;

      // Message without mention → null
      const noMention: DiscordGatewayEvent = {
        op: 0,
        t: "MESSAGE_CREATE",
        s: 1,
        d: {
          id: "msg-1",
          channel_id: "ch-1",
          guild_id: "g-1",
          author: { id: "u-1", username: "Test", bot: false },
          content: "hello",
          timestamp: "2026-02-21T12:00:00.000Z",
          mentions: [],
        },
      };
      expect(adapter.normalize(noMention)).toBeNull();

      // Message with mention → passes
      const withMention: DiscordGatewayEvent = {
        op: 0,
        t: "MESSAGE_CREATE",
        s: 1,
        d: {
          id: "msg-2",
          channel_id: "ch-1",
          guild_id: "g-1",
          author: { id: "u-1", username: "Test", bot: false },
          content: "hey <@bot-id-99>",
          timestamp: "2026-02-21T12:00:00.000Z",
          mentions: [{ id: "bot-id-99" }],
        },
      };
      const result = adapter.normalize(withMention);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("msg-2");
    });
  });

  // ─── Outbound Sending ───

  describe("outbound", () => {
    it("sends messages through REST service", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });

      const result = await plugin.send({
        chatId: "ch-123",
        text: "Hello from bot!",
        replyTo: "msg-original",
      });

      expect(result.messageId).toBeDefined();
      expect(rest.calls).toHaveLength(1);
      expect(rest.calls[0].channelId).toBe("ch-123");
      expect(rest.calls[0].payload).toEqual({
        content: "Hello from bot!",
        message_reference: { message_id: "msg-original" },
        allowed_mentions: { replied_user: false },
      });
    });

    it("sends image URLs as embeds", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });

      await plugin.send({
        chatId: "ch-123",
        text: "Image message",
        images: [
          "https://cdn.example.com/a.png",
          "https://cdn.example.com/b.jpg",
        ],
      });

      expect(rest.calls).toHaveLength(1);
      const payload = rest.calls[0].payload as DiscordSendMessagePayload;
      expect(payload.embeds).toEqual([
        { image: { url: "https://cdn.example.com/a.png" } },
        { image: { url: "https://cdn.example.com/b.jpg" } },
      ]);
      expect(payload.files).toBeUndefined();
    });

    it("sends local image paths as file attachments", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-discord-"));
      const imagePath = path.join(tmpDir, "snap.png");
      await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      try {
        await plugin.send({
          chatId: "ch-123",
          text: "Local attachment",
          images: [imagePath],
        });
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }

      expect(rest.calls).toHaveLength(1);
      const payload = rest.calls[0].payload as DiscordSendMessagePayload;
      expect(payload.files).toHaveLength(1);
      expect(payload.files?.[0]?.filename).toBe("snap.png");
      expect(payload.files?.[0]?.data).toBeInstanceOf(Uint8Array);
      expect(payload.files?.[0]?.contentType).toBe("image/png");
    });

    it("signals typing through REST service", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      await plugin.adapters!.outbound!.typing!("ch-typing-1");

      expect(rest.typingCalls).toEqual(["ch-typing-1"]);
    });
  });

  // ─── Lifecycle & Status ───

  describe("lifecycle and status", () => {
    it("reports disconnected before start", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      expect(plugin.adapters!.status!.status()).toBe("disconnected");
    });

    it("reports connected after start", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      await plugin.start(() => {});
      expect(plugin.adapters!.status!.status()).toBe("connected");
    });

    it("reports disconnected after stop", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      await plugin.start(() => {});
      await plugin.stop();
      expect(plugin.adapters!.status!.status()).toBe("disconnected");
    });

    it("provides diagnostics", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      const diag = plugin.adapters!.status!.diagnostics!();
      expect(diag).toHaveProperty("connected");
      expect(diag).toHaveProperty("requireMention");
      expect(diag).toHaveProperty("intents");
    });
  });

  // ─── Start/Stop Integration ───

  describe("start/stop integration", () => {
    it("delivers messages through start handler", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      // Simulate a message through the gateway
      gateway._onEvent!({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 1,
        d: {
          id: "msg-live",
          channel_id: "ch-1",
          guild_id: "g-1",
          author: { id: "u-1", username: "Live", bot: false },
          content: "Live message",
          timestamp: "2026-02-21T12:00:00.000Z",
        },
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Live message");
    });
  });

  // ─── Status Tracking via onStatusChange ───

  describe("connectionStatus updates via onStatusChange", () => {
    it("updates connectionStatus when gateway fires onStatusChange", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      await plugin.start(() => {});
      expect(plugin.adapters!.status!.status()).toBe("connected");

      // Gateway fires onStatusChange("disconnected") — simulating a drop
      gateway._onStatusChange!("disconnected");
      expect(plugin.adapters!.status!.status()).toBe("disconnected");

      // Gateway fires onStatusChange("connecting") — simulating reconnect
      gateway._onStatusChange!("connecting");
      expect(plugin.adapters!.status!.status()).toBe("connecting");

      // Gateway fires onStatusChange("connected") — reconnected
      gateway._onStatusChange!("connected");
      expect(plugin.adapters!.status!.status()).toBe("connected");
    });

    it("passes onStatusChange to gateway.connect via start()", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      await plugin.start(() => {});

      // The mock gateway should have captured onStatusChange
      expect(gateway._onStatusChange).not.toBeNull();
      expect(typeof gateway._onStatusChange).toBe("function");
    });

    it("passes onStatusChange to gateway.connect via lifecycle adapter", async () => {
      await plugin.init({ kind: "discord", token: "test-token" });
      const lifecycle = plugin.adapters!.lifecycle!;
      await lifecycle.connect(() => {});

      expect(gateway._onStatusChange).not.toBeNull();
      expect(typeof gateway._onStatusChange).toBe("function");
    });
  });
});
