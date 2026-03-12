import { describe, it, expect, beforeEach } from "vitest";
import {
  createFridaySlackChannel,
  normalizeSlackMessage,
} from "#channels";
import type {
  FridayChannelPlugin,
  FridayChannelMessage,
} from "#channels";
import type {
  SlackSocketService,
  SlackHttpEventService,
  SlackWebApiService,
  SlackMessageEvent,
  SlackSendPayload,
} from "../../../../src/channels/slack/slack-service.js";
import { FridaySlackChannelConfigSchema } from "../../../../src/channels/slack/slack-config.schema.js";

// ─── Mock Services ───

function createMockSocket(): SlackSocketService & {
  _onEvent: ((event: SlackMessageEvent) => void) | null;
} {
  let connected = false;
  let onEventFn: ((event: SlackMessageEvent) => void) | null = null;

  return {
    get _onEvent() { return onEventFn; },
    async connect(_appToken, _botToken, onEvent) {
      connected = true;
      onEventFn = onEvent;
    },
    async disconnect() {
      connected = false;
      onEventFn = null;
    },
    isConnected() { return connected; },
  };
}

function createMockHttpEvents(): SlackHttpEventService & {
  _onEvent: ((event: SlackMessageEvent) => void) | null;
} {
  let listening = false;
  let onEventFn: ((event: SlackMessageEvent) => void) | null = null;

  return {
    get _onEvent() { return onEventFn; },
    async start(_signingSecret, onEvent) {
      listening = true;
      onEventFn = onEvent;
    },
    async stop() {
      listening = false;
      onEventFn = null;
    },
    isListening() { return listening; },
  };
}

function createMockWebApi(): SlackWebApiService & { calls: Array<{ payload: SlackSendPayload }> } {
  const calls: Array<{ payload: SlackSendPayload }> = [];
  return {
    calls,
    async sendMessage(_token, payload) {
      calls.push({ payload });
      return { ok: true, ts: "1740150001.000100", channel: payload.channel };
    },
    async getUserInfo(_token, userId) {
      return { id: userId, name: "mock-user" };
    },
  };
}

function makeSlackMessage(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: "message",
    channel: "C01234",
    user: "U01234",
    text: "Hello Slack!",
    ts: "1740150000.000100",
    channel_type: "channel",
    ...overrides,
  };
}

describe("FridaySlackChannel", () => {
  let socket: ReturnType<typeof createMockSocket>;
  let webApi: ReturnType<typeof createMockWebApi>;
  let plugin: FridayChannelPlugin;

  beforeEach(() => {
    socket = createMockSocket();
    webApi = createMockWebApi();
    plugin = createFridaySlackChannel({ socket, webApi });
  });

  // ─── Config Validation ───

  describe("config validation", () => {
    it("validates valid config", () => {
      const result = FridaySlackChannelConfigSchema.parse({
        kind: "slack",
        botToken: "xoxb-test",
      });
      expect(result.botToken).toBe("xoxb-test");
      expect(result.mode).toBe("socket");
    });

    it("rejects missing botToken", () => {
      expect(() => FridaySlackChannelConfigSchema.parse({ kind: "slack" })).toThrow();
    });

    it("accepts http mode", () => {
      const result = FridaySlackChannelConfigSchema.parse({
        kind: "slack",
        botToken: "xoxb-1",
        mode: "http",
      });
      expect(result.mode).toBe("http");
    });

    it("accepts appToken for socket mode", () => {
      const result = FridaySlackChannelConfigSchema.parse({
        kind: "slack",
        botToken: "xoxb-1",
        appToken: "xapp-1",
      });
      expect(result.appToken).toBe("xapp-1");
    });
  });

  // ─── Init ───

  describe("init", () => {
    it("initializes with valid config", async () => {
      await plugin.init({ kind: "slack", botToken: "xoxb-test" });
      expect(plugin.kind).toBe("slack");
    });
  });

  // ─── Inbound Normalization ───

  describe("inbound normalization", () => {
    it("normalizes a channel message", () => {
      const event = makeSlackMessage();
      const result = normalizeSlackMessage(event);
      expect(result).not.toBeNull();
      expect(result!.channelKind).toBe("slack");
      expect(result!.senderId).toBe("U01234");
      expect(result!.chatId).toBe("C01234");
      expect(result!.chatType).toBe("group");
      expect(result!.text).toBe("Hello Slack!");
    });

    it("normalizes a DM (im channel_type)", () => {
      const event = makeSlackMessage({ channel_type: "im" });
      const result = normalizeSlackMessage(event);
      expect(result!.chatType).toBe("direct");
    });

    it("normalizes mpim as direct", () => {
      const event = makeSlackMessage({ channel_type: "mpim" });
      const result = normalizeSlackMessage(event);
      expect(result!.chatType).toBe("direct");
    });

    it("skips bot messages", () => {
      const event = makeSlackMessage({ bot_id: "B01234" });
      expect(normalizeSlackMessage(event)).toBeNull();
    });

    it("skips messages with subtypes", () => {
      const event = makeSlackMessage({ subtype: "message_changed" });
      expect(normalizeSlackMessage(event)).toBeNull();
    });

    it("extracts thread_ts as replyTo", () => {
      const event = makeSlackMessage({
        ts: "1740150001.000100",
        thread_ts: "1740150000.000100",
      });
      const result = normalizeSlackMessage(event);
      expect(result!.replyTo).toBe("1740150000.000100");
    });

    it("does not set replyTo when thread_ts equals ts", () => {
      const event = makeSlackMessage({
        ts: "1740150000.000100",
        thread_ts: "1740150000.000100",
      });
      const result = normalizeSlackMessage(event);
      expect(result!.replyTo).toBeUndefined();
    });

    it("extracts image files", () => {
      const event = makeSlackMessage({
        files: [
          { id: "f1", name: "pic.png", mimetype: "image/png", url_private: "https://files.slack.com/pic.png", size: 1024 },
          { id: "f2", name: "doc.pdf", mimetype: "application/pdf", url_private: "https://files.slack.com/doc.pdf", size: 2048 },
        ],
      });
      const result = normalizeSlackMessage(event);
      expect(result!.images).toEqual(["https://files.slack.com/pic.png"]);
    });

    it("converts ts to milliseconds", () => {
      const event = makeSlackMessage({ ts: "1740150000.000100" });
      const result = normalizeSlackMessage(event);
      expect(result!.timestamp).toBeCloseTo(1740150000000, -2);
    });
  });

  // ─── Outbound ───

  describe("outbound", () => {
    it("sends via Web API", async () => {
      await plugin.init({ kind: "slack", botToken: "xoxb-test" });
      const result = await plugin.send({
        chatId: "C01234",
        text: "Bot reply",
        replyTo: "1740150000.000100",
      });

      expect(result.messageId).toBe("1740150001.000100");
      expect(webApi.calls).toHaveLength(1);
      expect(webApi.calls[0].payload.channel).toBe("C01234");
      expect(webApi.calls[0].payload.thread_ts).toBe("1740150000.000100");
    });
  });

  // ─── Status ───

  describe("status", () => {
    it("reports disconnected before start", async () => {
      await plugin.init({ kind: "slack", botToken: "xoxb-1" });
      expect(plugin.adapters!.status!.status()).toBe("disconnected");
    });

    it("reports connected after start", async () => {
      await plugin.init({ kind: "slack", botToken: "xoxb-1" });
      await plugin.start(() => {});
      expect(plugin.adapters!.status!.status()).toBe("connected");
    });

    it("provides diagnostics with mode", async () => {
      await plugin.init({ kind: "slack", botToken: "xoxb-1" });
      const diag = plugin.adapters!.status!.diagnostics!();
      expect(diag).toHaveProperty("mode", "socket");
    });
  });

  // ─── Start Integration ───

  describe("start integration", () => {
    it("delivers messages through handler", async () => {
      await plugin.init({ kind: "slack", botToken: "xoxb-test" });
      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      socket._onEvent!(makeSlackMessage({ text: "Live msg" }));
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Live msg");
    });
  });

  // ─── HTTP Mode ───

  describe("http mode", () => {
    let httpEvents: ReturnType<typeof createMockHttpEvents>;
    let httpPlugin: FridayChannelPlugin;

    beforeEach(() => {
      httpEvents = createMockHttpEvents();
      httpPlugin = createFridaySlackChannel({
        socket,
        httpEvents,
        webApi,
      });
    });

    it("starts HTTP event service when mode is http", async () => {
      await httpPlugin.init({
        kind: "slack",
        botToken: "xoxb-test",
        mode: "http",
        signingSecret: "slack-signing-secret",
      });
      const messages: FridayChannelMessage[] = [];
      await httpPlugin.start((msg) => messages.push(msg));

      expect(httpEvents.isListening()).toBe(true);
      expect(socket.isConnected()).toBe(false);

      // Deliver a message via HTTP event
      httpEvents._onEvent!(makeSlackMessage({ text: "Via HTTP" }));
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Via HTTP");
    });

    it("throws when http mode lacks signingSecret", async () => {
      await httpPlugin.init({
        kind: "slack",
        botToken: "xoxb-test",
        mode: "http",
      });
      await expect(httpPlugin.start(() => {})).rejects.toThrow("signingSecret");
    });

    it("stops HTTP event service on stop", async () => {
      await httpPlugin.init({
        kind: "slack",
        botToken: "xoxb-test",
        mode: "http",
        signingSecret: "secret",
      });
      await httpPlugin.start(() => {});
      expect(httpEvents.isListening()).toBe(true);

      await httpPlugin.stop();
      expect(httpEvents.isListening()).toBe(false);
    });

    it("still uses socket mode when mode is socket (default)", async () => {
      await httpPlugin.init({
        kind: "slack",
        botToken: "xoxb-test",
        mode: "socket",
        appToken: "xapp-test",
      });
      await httpPlugin.start(() => {});
      expect(socket.isConnected()).toBe(true);
      expect(httpEvents.isListening()).toBe(false);
    });

    it("provides diagnostics with httpListening field", async () => {
      await httpPlugin.init({
        kind: "slack",
        botToken: "xoxb-test",
        mode: "http",
        signingSecret: "secret",
      });
      const diag = httpPlugin.adapters!.status!.diagnostics!();
      expect(diag).toHaveProperty("httpListening");
    });
  });
});
