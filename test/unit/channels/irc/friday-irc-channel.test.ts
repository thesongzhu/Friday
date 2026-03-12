import { describe, it, expect, beforeEach } from "vitest";
import {
  createFridayIrcChannel,
  normalizeIrcPrivmsg,
} from "#channels";
import type {
  FridayChannelPlugin,
  FridayChannelMessage,
} from "#channels";
import type {
  IrcConnectionService,
  IrcPrivmsgEvent,
  IrcConnectionOptions,
} from "../../../../src/channels/irc/irc-service.js";
import { FridayIrcChannelConfigSchema } from "../../../../src/channels/irc/irc-config.schema.js";

// ─── Mock Services ───

function createMockConnection(): IrcConnectionService & {
  _onMessage: ((event: IrcPrivmsgEvent) => void) | null;
  _sentMessages: Array<{ target: string; message: string }>;
  _connOptions: IrcConnectionOptions | null;
} {
  let connected = false;
  let channels: string[] = [];
  let onMessageFn: ((event: IrcPrivmsgEvent) => void) | null = null;
  const sentMessages: Array<{ target: string; message: string }> = [];
  let connOptions: IrcConnectionOptions | null = null;

  return {
    get _onMessage() { return onMessageFn; },
    _sentMessages: sentMessages,
    get _connOptions() { return connOptions; },
    async connect(options, onMessage) {
      connected = true;
      channels = [...options.channels];
      onMessageFn = onMessage;
      connOptions = options;
    },
    async disconnect() {
      connected = false;
      channels = [];
      onMessageFn = null;
    },
    async sendMessage(target, message) {
      sentMessages.push({ target, message });
    },
    isConnected() { return connected; },
    joinedChannels() { return [...channels]; },
  };
}

function makePrivmsg(overrides: Partial<IrcPrivmsgEvent> = {}): IrcPrivmsgEvent {
  return {
    prefix: "alice!alice@host",
    nick: "alice",
    user: "alice",
    host: "host",
    command: "PRIVMSG",
    target: "#general",
    message: "Hello IRC!",
    timestamp: 1740150000000,
    ...overrides,
  };
}

describe("FridayIrcChannel", () => {
  let connection: ReturnType<typeof createMockConnection>;
  let plugin: FridayChannelPlugin;

  beforeEach(() => {
    connection = createMockConnection();
    plugin = createFridayIrcChannel({ connection });
  });

  // ─── Config Validation ───

  describe("config validation", () => {
    it("validates valid config", () => {
      const result = FridayIrcChannelConfigSchema.parse({
        kind: "irc",
        host: "irc.libera.chat",
        nick: "friday-bot",
      });
      expect(result.host).toBe("irc.libera.chat");
      expect(result.port).toBe(6667);
      expect(result.tls).toBe(false);
      expect(result.channels).toEqual([]);
    });

    it("rejects missing host", () => {
      expect(() =>
        FridayIrcChannelConfigSchema.parse({ kind: "irc", nick: "bot" }),
      ).toThrow();
    });

    it("rejects missing nick", () => {
      expect(() =>
        FridayIrcChannelConfigSchema.parse({ kind: "irc", host: "irc.example.com" }),
      ).toThrow();
    });

    it("accepts TLS and channels", () => {
      const result = FridayIrcChannelConfigSchema.parse({
        kind: "irc",
        host: "irc.example.com",
        port: 6697,
        tls: true,
        nick: "bot",
        channels: ["#general", "#dev"],
      });
      expect(result.tls).toBe(true);
      expect(result.port).toBe(6697);
      expect(result.channels).toEqual(["#general", "#dev"]);
    });
  });

  // ─── Init ───

  describe("init", () => {
    it("initializes with valid config", async () => {
      await plugin.init({
        kind: "irc",
        host: "irc.libera.chat",
        nick: "friday-bot",
      });
      expect(plugin.kind).toBe("irc");
    });
  });

  // ─── Inbound Normalization ───

  describe("inbound normalization", () => {
    it("normalizes a channel PRIVMSG", () => {
      const event = makePrivmsg();
      const result = normalizeIrcPrivmsg(event, "friday-bot");
      expect(result).not.toBeNull();
      expect(result!.channelKind).toBe("irc");
      expect(result!.senderId).toBe("alice");
      expect(result!.chatId).toBe("#general");
      expect(result!.chatType).toBe("group");
      expect(result!.text).toBe("Hello IRC!");
    });

    it("normalizes a DM (target is bot nick)", () => {
      const event = makePrivmsg({ target: "friday-bot" });
      const result = normalizeIrcPrivmsg(event, "friday-bot");
      expect(result!.chatType).toBe("direct");
      expect(result!.chatId).toBe("alice");
    });

    it("skips messages from self", () => {
      const event = makePrivmsg({ nick: "friday-bot" });
      const result = normalizeIrcPrivmsg(event, "friday-bot");
      expect(result).toBeNull();
    });

    it("handles & prefixed channels as group", () => {
      const event = makePrivmsg({ target: "&local" });
      const result = normalizeIrcPrivmsg(event, "bot");
      expect(result!.chatType).toBe("group");
    });

    it("returns null for non-PRIVMSG commands", () => {
      const event = {
        ...makePrivmsg(),
        command: "NOTICE" as "PRIVMSG",
      };
      const result = normalizeIrcPrivmsg(event, "bot");
      expect(result).toBeNull();
    });

    it("generates composite message ID", () => {
      const event = makePrivmsg({ nick: "bob", timestamp: 12345 });
      const result = normalizeIrcPrivmsg(event, "bot");
      expect(result!.id).toBe("bob-12345");
    });
  });

  // ─── Outbound ───

  describe("outbound", () => {
    it("sends PRIVMSG to target", async () => {
      await plugin.init({
        kind: "irc",
        host: "irc.example.com",
        nick: "bot",
      });

      const result = await plugin.send({
        chatId: "#general",
        text: "Hello from bot!",
      });

      expect(result.messageId).toBeDefined();
      expect(connection._sentMessages).toHaveLength(1);
      expect(connection._sentMessages[0].target).toBe("#general");
      expect(connection._sentMessages[0].message).toBe("Hello from bot!");
    });
  });

  // ─── Status ───

  describe("status", () => {
    it("reports disconnected before start", async () => {
      await plugin.init({ kind: "irc", host: "h", nick: "n" });
      expect(plugin.adapters!.status!.status()).toBe("disconnected");
    });

    it("reports connected after start", async () => {
      await plugin.init({
        kind: "irc",
        host: "h",
        nick: "n",
        channels: ["#test"],
      });
      await plugin.start(() => {});
      expect(plugin.adapters!.status!.status()).toBe("connected");
    });

    it("provides diagnostics with joined channels", async () => {
      await plugin.init({
        kind: "irc",
        host: "irc.example.com",
        nick: "bot",
        channels: ["#a", "#b"],
      });
      await plugin.start(() => {});
      const diag = plugin.adapters!.status!.diagnostics!();
      expect(diag).toHaveProperty("host", "irc.example.com");
      expect(diag).toHaveProperty("nick", "bot");
      expect(diag).toHaveProperty("joinedChannels");
      expect((diag as Record<string, unknown>).joinedChannels).toEqual(["#a", "#b"]);
    });
  });

  // ─── Start Integration ───

  describe("start integration", () => {
    it("delivers messages through handler", async () => {
      await plugin.init({
        kind: "irc",
        host: "h",
        nick: "bot",
        channels: ["#test"],
      });
      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      connection._onMessage!(makePrivmsg({ message: "Live IRC msg" }));
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Live IRC msg");
    });

    it("passes connection options correctly", async () => {
      await plugin.init({
        kind: "irc",
        host: "irc.libera.chat",
        port: 6697,
        tls: true,
        nick: "friday",
        username: "friday-user",
        channels: ["#dev"],
      });
      await plugin.start(() => {});

      expect(connection._connOptions!.host).toBe("irc.libera.chat");
      expect(connection._connOptions!.port).toBe(6697);
      expect(connection._connOptions!.tls).toBe(true);
      expect(connection._connOptions!.nick).toBe("friday");
    });
  });
});
