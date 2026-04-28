import { describe, it, expect, beforeEach } from "vitest";
import {
  createFridayTelegramChannel,
  normalizeTelegramUpdate,
} from "#channels";
import type {
  FridayChannelPlugin,
  FridayChannelMessage,
} from "#channels";
import type {
  TelegramPollingService,
  TelegramWebhookService,
  TelegramApiService,
  TelegramUpdate,
  TelegramSendMessagePayload,
} from "../../../../src/channels/telegram/telegram-service.js";
import { FridayTelegramChannelConfigSchema } from "../../../../src/channels/telegram/telegram-config.schema.js";

// ─── Mock Services ───

function createMockPolling(): TelegramPollingService & {
  _onUpdate: ((update: TelegramUpdate) => void) | null;
} {
  let polling = false;
  let onUpdateFn: ((update: TelegramUpdate) => void) | null = null;

  return {
    get _onUpdate() { return onUpdateFn; },
    async startPolling(_token, onUpdate) {
      polling = true;
      onUpdateFn = onUpdate;
    },
    async stopPolling() {
      polling = false;
      onUpdateFn = null;
    },
    isPolling() { return polling; },
  };
}

function createMockWebhook(): TelegramWebhookService & {
  _onUpdate: ((update: TelegramUpdate) => void) | null;
  _webhookUrl: string | null;
} {
  let listening = false;
  let onUpdateFn: ((update: TelegramUpdate) => void) | null = null;
  let webhookUrl: string | null = null;

  return {
    get _onUpdate() { return onUpdateFn; },
    get _webhookUrl() { return webhookUrl; },
    async startWebhook(_token, url, onUpdate) {
      listening = true;
      onUpdateFn = onUpdate;
      webhookUrl = url;
    },
    async stopWebhook() {
      listening = false;
      onUpdateFn = null;
      webhookUrl = null;
    },
    isListening() { return listening; },
  };
}

function createMockApi(): TelegramApiService & { calls: Array<{ payload: TelegramSendMessagePayload }> } {
  const calls: Array<{ payload: TelegramSendMessagePayload }> = [];
  return {
    calls,
    async sendMessage(_token, payload) {
      calls.push({ payload });
      return { ok: true, result: { message_id: 12345 } };
    },
  };
}

function makeUpdate(overrides: Partial<TelegramUpdate["message"]> = {}): TelegramUpdate {
  return {
    update_id: 1001,
    message: {
      message_id: 42,
      from: { id: 100, is_bot: false, first_name: "Alice", last_name: "Smith", username: "alice" },
      chat: { id: 100, type: "private" },
      date: 1740150000,
      text: "Hello!",
      ...overrides,
    },
  };
}

describe("FridayTelegramChannel", () => {
  let polling: ReturnType<typeof createMockPolling>;
  let api: ReturnType<typeof createMockApi>;
  let plugin: FridayChannelPlugin;

  beforeEach(() => {
    polling = createMockPolling();
    api = createMockApi();
    plugin = createFridayTelegramChannel({ polling, api });
  });

  // ─── Config Validation ───

  describe("config validation", () => {
    it("validates valid config", () => {
      const result = FridayTelegramChannelConfigSchema.parse({
        kind: "telegram",
        botToken: "123:ABC",
      });
      expect(result.botToken).toBe("123:ABC");
      expect(result.mode).toBe("polling");
    });

    it("rejects missing botToken", () => {
      expect(() => FridayTelegramChannelConfigSchema.parse({ kind: "telegram" })).toThrow();
    });

    it("accepts webhook mode", () => {
      const result = FridayTelegramChannelConfigSchema.parse({
        kind: "telegram",
        botToken: "123:ABC",
        mode: "webhook",
        webhookUrl: "https://example.com/hook",
      });
      expect(result.mode).toBe("webhook");
    });
  });

  // ─── Init ───

  describe("init", () => {
    it("initializes with valid config", async () => {
      await plugin.init({ kind: "telegram", botToken: "test-token" });
      expect(plugin.kind).toBe("telegram");
    });

    it("rejects config without botToken", async () => {
      await expect(plugin.init({ kind: "telegram" })).rejects.toThrow();
    });
  });

  // ─── Inbound Normalization ───

  describe("inbound normalization", () => {
    it("normalizes a private text message", () => {
      const update = makeUpdate();
      const result = normalizeTelegramUpdate(update);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("42");
      expect(result!.channelKind).toBe("telegram");
      expect(result!.senderId).toBe("100");
      expect(result!.senderName).toBe("Alice Smith");
      expect(result!.chatType).toBe("direct");
      expect(result!.text).toBe("Hello!");
    });

    it("normalizes a group message", () => {
      const update = makeUpdate({
        chat: { id: -200, type: "supergroup", title: "Dev Chat" },
      });
      const result = normalizeTelegramUpdate(update);
      expect(result!.chatType).toBe("group");
      expect(result!.chatId).toBe("-200");
    });

    it("returns null for updates without message", () => {
      const update: TelegramUpdate = { update_id: 1 };
      expect(normalizeTelegramUpdate(update)).toBeNull();
    });

    it("skips bot messages", () => {
      const update = makeUpdate({
        from: { id: 999, is_bot: true, first_name: "Bot" },
      });
      expect(normalizeTelegramUpdate(update)).toBeNull();
    });

    it("skips setup verification start commands", () => {
      const update = makeUpdate({ text: "/start friday_abc123def4" });
      expect(normalizeTelegramUpdate(update)).toBeNull();
    });

    it("extracts photo file_id from largest photo", () => {
      const update = makeUpdate({
        text: undefined,
        photo: [
          { file_id: "small", file_unique_id: "s", width: 100, height: 100 },
          { file_id: "large", file_unique_id: "l", width: 800, height: 600 },
        ],
      });
      const result = normalizeTelegramUpdate(update);
      expect(result!.images).toEqual(["large"]);
    });

    it("extracts reply_to_message", () => {
      const update = makeUpdate({
        reply_to_message: { message_id: 99 },
      });
      const result = normalizeTelegramUpdate(update);
      expect(result!.replyTo).toBe("99");
    });

    it("converts timestamp from seconds to milliseconds", () => {
      const update = makeUpdate({ date: 1740150000 });
      const result = normalizeTelegramUpdate(update);
      expect(result!.timestamp).toBe(1740150000000);
    });

    it("falls back to current time when Telegram date is missing", () => {
      const before = Date.now();
      const update = makeUpdate({ date: undefined as unknown as number });
      const result = normalizeTelegramUpdate(update);
      const after = Date.now();
      expect(result!.timestamp).toBeGreaterThanOrEqual(before);
      expect(result!.timestamp).toBeLessThanOrEqual(after);
    });
  });

  // ─── Outbound ───

  describe("outbound", () => {
    it("sends messages via API service", async () => {
      await plugin.init({ kind: "telegram", botToken: "test-token" });
      const result = await plugin.send({
        chatId: "100",
        text: "Reply from bot",
        replyTo: "42",
      });

      expect(result.messageId).toBe("12345");
      expect(api.calls).toHaveLength(1);
      expect(api.calls[0].payload.chat_id).toBe("100");
      expect(api.calls[0].payload.text).toBe("Reply from bot");
      expect(api.calls[0].payload.reply_to_message_id).toBe(42);
    });
  });

  // ─── Status ───

  describe("status", () => {
    it("reports disconnected before start", async () => {
      await plugin.init({ kind: "telegram", botToken: "t" });
      expect(plugin.adapters!.status!.status()).toBe("disconnected");
    });

    it("reports connected after start", async () => {
      await plugin.init({ kind: "telegram", botToken: "t" });
      await plugin.start(() => {});
      expect(plugin.adapters!.status!.status()).toBe("connected");
    });

    it("reports disconnected after stop", async () => {
      await plugin.init({ kind: "telegram", botToken: "t" });
      await plugin.start(() => {});
      await plugin.stop();
      expect(plugin.adapters!.status!.status()).toBe("disconnected");
    });

    it("provides diagnostics with mode", async () => {
      await plugin.init({ kind: "telegram", botToken: "t" });
      const diag = plugin.adapters!.status!.diagnostics!();
      expect(diag).toHaveProperty("mode", "polling");
    });
  });

  // ─── Start Integration ───

  describe("start integration", () => {
    it("delivers normalized messages through handler", async () => {
      await plugin.init({ kind: "telegram", botToken: "test-token" });
      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      polling._onUpdate!(makeUpdate());
      expect(messages).toHaveLength(1);
      expect(messages[0].channelKind).toBe("telegram");
    });
  });

  // ─── Webhook Mode ───

  describe("webhook mode", () => {
    let webhookSvc: ReturnType<typeof createMockWebhook>;
    let webhookPlugin: FridayChannelPlugin;

    beforeEach(() => {
      webhookSvc = createMockWebhook();
      webhookPlugin = createFridayTelegramChannel({
        polling,
        webhook: webhookSvc,
        api,
      });
    });

    it("starts webhook service when mode is webhook", async () => {
      await webhookPlugin.init({
        kind: "telegram",
        botToken: "test-token",
        mode: "webhook",
        webhookUrl: "https://example.com/webhook",
      });
      const messages: FridayChannelMessage[] = [];
      await webhookPlugin.start((msg) => messages.push(msg));

      expect(webhookSvc.isListening()).toBe(true);
      expect(webhookSvc._webhookUrl).toBe("https://example.com/webhook");
      expect(polling.isPolling()).toBe(false);

      // Deliver a message via webhook
      webhookSvc._onUpdate!(makeUpdate({ text: "Via webhook" }));
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Via webhook");
    });

    it("throws when webhook mode lacks webhookUrl", async () => {
      await webhookPlugin.init({
        kind: "telegram",
        botToken: "test-token",
        mode: "webhook",
      });
      await expect(webhookPlugin.start(() => {})).rejects.toThrow("webhookUrl");
    });

    it("stops webhook service on stop", async () => {
      await webhookPlugin.init({
        kind: "telegram",
        botToken: "test-token",
        mode: "webhook",
        webhookUrl: "https://example.com/webhook",
      });
      await webhookPlugin.start(() => {});
      expect(webhookSvc.isListening()).toBe(true);

      await webhookPlugin.stop();
      expect(webhookSvc.isListening()).toBe(false);
    });

    it("still uses polling when mode is polling (default)", async () => {
      await webhookPlugin.init({
        kind: "telegram",
        botToken: "test-token",
        mode: "polling",
      });
      await webhookPlugin.start(() => {});
      expect(polling.isPolling()).toBe(true);
      expect(webhookSvc.isListening()).toBe(false);
    });

    it("provides diagnostics with webhook field", async () => {
      await webhookPlugin.init({
        kind: "telegram",
        botToken: "test-token",
        mode: "webhook",
        webhookUrl: "https://example.com/hook",
      });
      const diag = webhookPlugin.adapters!.status!.diagnostics!();
      expect(diag).toHaveProperty("webhook");
    });
  });
});
