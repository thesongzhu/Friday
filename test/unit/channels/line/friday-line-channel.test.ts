import { describe, it, expect, beforeEach } from "vitest";
import {
  createFridayLineChannel,
  normalizeLineWebhookEvent,
  normalizeLineWebhookPayload,
} from "#channels";
import type {
  FridayChannelPlugin,
  FridayChannelMessage,
} from "#channels";
import type {
  LineWebhookListenerService,
  LineApiService,
  LineWebhookEvent,
  LineWebhookPayload,
  LineSendPayload,
} from "../../../../src/channels/line/line-service.js";
import { FridayLineChannelConfigSchema } from "../../../../src/channels/line/line-config.schema.js";

// ─── Mock Services ───

function createMockWebhookListener(): LineWebhookListenerService & {
  _onEvent: ((payload: LineWebhookPayload) => void) | null;
} {
  let listening = false;
  let onEventFn: ((payload: LineWebhookPayload) => void) | null = null;

  return {
    get _onEvent() { return onEventFn; },
    async start(_path, _secret, onEvent) {
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

function createMockApi(): LineApiService & {
  pushCalls: Array<{ payload: LineSendPayload }>;
  replyCalls: Array<{ replyToken: string }>;
} {
  const pushCalls: Array<{ payload: LineSendPayload }> = [];
  const replyCalls: Array<{ replyToken: string }> = [];

  return {
    pushCalls,
    replyCalls,
    async pushMessage(_token, payload) {
      pushCalls.push({ payload });
    },
    async replyMessage(_token, payload) {
      replyCalls.push({ replyToken: payload.replyToken });
    },
  };
}

function makeLineEvent(overrides: Partial<LineWebhookEvent> = {}): LineWebhookEvent {
  return {
    type: "message",
    replyToken: "reply-token-1",
    source: {
      type: "user",
      userId: "U001",
    },
    timestamp: 1740150000000,
    message: {
      id: "msg-line-1",
      type: "text",
      text: "Hello LINE!",
    },
    ...overrides,
  };
}

function makeLinePayload(events: LineWebhookEvent[] = [makeLineEvent()]): LineWebhookPayload {
  return {
    destination: "dest-1",
    events,
  };
}

describe("FridayLineChannel", () => {
  let webhookListener: ReturnType<typeof createMockWebhookListener>;
  let api: ReturnType<typeof createMockApi>;
  let plugin: FridayChannelPlugin;

  beforeEach(() => {
    webhookListener = createMockWebhookListener();
    api = createMockApi();
    plugin = createFridayLineChannel({ webhookListener, api });
  });

  // ─── Config Validation ───

  describe("config validation", () => {
    it("validates valid config", () => {
      const result = FridayLineChannelConfigSchema.parse({
        kind: "line",
        channelAccessToken: "tok",
        channelSecret: "secret",
      });
      expect(result.channelAccessToken).toBe("tok");
      expect(result.webhookPath).toBe("/webhook/line");
    });

    it("rejects missing channelAccessToken", () => {
      expect(() =>
        FridayLineChannelConfigSchema.parse({
          kind: "line",
          channelSecret: "s",
        }),
      ).toThrow();
    });

    it("rejects missing channelSecret", () => {
      expect(() =>
        FridayLineChannelConfigSchema.parse({
          kind: "line",
          channelAccessToken: "t",
        }),
      ).toThrow();
    });

    it("accepts custom webhookPath", () => {
      const result = FridayLineChannelConfigSchema.parse({
        kind: "line",
        channelAccessToken: "t",
        channelSecret: "s",
        webhookPath: "/custom/line",
      });
      expect(result.webhookPath).toBe("/custom/line");
    });
  });

  // ─── Init ───

  describe("init", () => {
    it("initializes with valid config", async () => {
      await plugin.init({
        kind: "line",
        channelAccessToken: "tok",
        channelSecret: "secret",
      });
      expect(plugin.kind).toBe("line");
    });
  });

  // ─── Inbound Normalization ───

  describe("inbound normalization", () => {
    it("normalizes a text message event", () => {
      const event = makeLineEvent();
      const result = normalizeLineWebhookEvent(event);
      expect(result).not.toBeNull();
      expect(result!.channelKind).toBe("line");
      expect(result!.senderId).toBe("U001");
      expect(result!.chatType).toBe("direct");
      expect(result!.text).toBe("Hello LINE!");
    });

    it("normalizes a group message", () => {
      const event = makeLineEvent({
        source: { type: "group", userId: "U001", groupId: "G001" },
      });
      const result = normalizeLineWebhookEvent(event);
      expect(result!.chatType).toBe("group");
      expect(result!.chatId).toBe("G001");
    });

    it("normalizes a room message", () => {
      const event = makeLineEvent({
        source: { type: "room", userId: "U001", roomId: "R001" },
      });
      const result = normalizeLineWebhookEvent(event);
      expect(result!.chatType).toBe("group");
      expect(result!.chatId).toBe("R001");
    });

    it("returns null for non-message events", () => {
      const event = makeLineEvent({ type: "follow" });
      expect(normalizeLineWebhookEvent(event)).toBeNull();
    });

    it("returns null for unsupported message types", () => {
      const event = makeLineEvent({
        message: { id: "m1", type: "sticker" },
      });
      expect(normalizeLineWebhookEvent(event)).toBeNull();
    });

    it("handles image messages", () => {
      const event = makeLineEvent({
        message: { id: "img-1", type: "image" },
      });
      const result = normalizeLineWebhookEvent(event);
      expect(result).not.toBeNull();
      expect(result!.images).toEqual(["img-1"]);
      expect(result!.text).toBe("");
    });

    it("normalizes multiple events in a payload", () => {
      const payload = makeLinePayload([
        makeLineEvent({ message: { id: "m1", type: "text", text: "First" } }),
        makeLineEvent({ message: { id: "m2", type: "text", text: "Second" } }),
      ]);
      const results = normalizeLineWebhookPayload(payload);
      expect(results).toHaveLength(2);
      expect(results[0].text).toBe("First");
      expect(results[1].text).toBe("Second");
    });

    it("preserves replyToken in raw", () => {
      const event = makeLineEvent({ replyToken: "rt-abc" });
      const result = normalizeLineWebhookEvent(event);
      expect((result!.raw as Record<string, unknown>).replyToken).toBe("rt-abc");
    });
  });

  // ─── Outbound ───

  describe("outbound", () => {
    it("sends push message via API", async () => {
      await plugin.init({
        kind: "line",
        channelAccessToken: "tok",
        channelSecret: "secret",
      });

      const result = await plugin.send({
        chatId: "U001",
        text: "Bot response",
      });

      expect(result.messageId).toBeDefined();
      expect(api.pushCalls).toHaveLength(1);
      expect(api.pushCalls[0].payload.to).toBe("U001");
      expect(api.pushCalls[0].payload.messages[0].text).toBe("Bot response");
    });
  });

  // ─── Status ───

  describe("status", () => {
    it("reports disconnected before start", async () => {
      await plugin.init({
        kind: "line",
        channelAccessToken: "t",
        channelSecret: "s",
      });
      expect(plugin.adapters!.status!.status()).toBe("disconnected");
    });

    it("reports connected after start", async () => {
      await plugin.init({
        kind: "line",
        channelAccessToken: "t",
        channelSecret: "s",
      });
      await plugin.start(() => {});
      expect(plugin.adapters!.status!.status()).toBe("connected");
    });

    it("provides diagnostics", async () => {
      await plugin.init({
        kind: "line",
        channelAccessToken: "t",
        channelSecret: "s",
      });
      const diag = plugin.adapters!.status!.diagnostics!();
      expect(diag).toHaveProperty("webhookPath");
      expect(diag).toHaveProperty("listening");
    });
  });

  // ─── Batch Normalization ───

  describe("batch normalization", () => {
    it("inbound adapter normalizeAll returns all messages from batch", async () => {
      await plugin.init({
        kind: "line",
        channelAccessToken: "t",
        channelSecret: "s",
      });
      const adapter = plugin.adapters!.inbound!;

      const payload = makeLinePayload([
        makeLineEvent({ message: { id: "m1", type: "text", text: "First" } }),
        makeLineEvent({ message: { id: "m2", type: "text", text: "Second" } }),
        makeLineEvent({ message: { id: "m3", type: "text", text: "Third" } }),
      ]);

      expect(adapter.normalizeAll).toBeDefined();
      const results = adapter.normalizeAll!(payload);
      expect(results).toHaveLength(3);
      expect(results[0].text).toBe("First");
      expect(results[1].text).toBe("Second");
      expect(results[2].text).toBe("Third");
    });

    it("inbound adapter normalize returns only first message", async () => {
      await plugin.init({
        kind: "line",
        channelAccessToken: "t",
        channelSecret: "s",
      });
      const adapter = plugin.adapters!.inbound!;

      const payload = makeLinePayload([
        makeLineEvent({ message: { id: "m1", type: "text", text: "First" } }),
        makeLineEvent({ message: { id: "m2", type: "text", text: "Second" } }),
      ]);

      const result = adapter.normalize(payload);
      expect(result).not.toBeNull();
      expect(result!.text).toBe("First");
    });
  });

  // ─── Start Integration ───

  describe("start integration", () => {
    it("delivers messages through handler", async () => {
      await plugin.init({
        kind: "line",
        channelAccessToken: "t",
        channelSecret: "s",
      });
      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      webhookListener._onEvent!(makeLinePayload([
        makeLineEvent({ message: { id: "m-live", type: "text", text: "Live LINE" } }),
      ]));
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Live LINE");
    });

    it("delivers ALL events from batch webhook through handler", async () => {
      await plugin.init({
        kind: "line",
        channelAccessToken: "t",
        channelSecret: "s",
      });
      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      webhookListener._onEvent!(makeLinePayload([
        makeLineEvent({ message: { id: "m1", type: "text", text: "Line 1" } }),
        makeLineEvent({ message: { id: "m2", type: "text", text: "Line 2" } }),
      ]));
      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe("Line 1");
      expect(messages[1].text).toBe("Line 2");
    });
  });
});
