import { describe, it, expect, beforeEach } from "vitest";
import {
  createFridayWhatsappChannel,
  normalizeWhatsappWebhook,
} from "#channels";
import type {
  FridayChannelPlugin,
  FridayChannelMessage,
} from "#channels";
import type {
  WhatsappWebhookService,
  WhatsappApiService,
  WhatsappWebhookMessage,
  WhatsappSendPayload,
} from "../../../../src/channels/whatsapp/whatsapp-service.js";
import { FridayWhatsappChannelConfigSchema } from "../../../../src/channels/whatsapp/whatsapp-config.schema.js";

// ─── Mock Services ───

function createMockWebhook(): WhatsappWebhookService & {
  _onEvent: ((event: WhatsappWebhookMessage) => void) | null;
} {
  let listening = false;
  let onEventFn: ((event: WhatsappWebhookMessage) => void) | null = null;

  return {
    get _onEvent() { return onEventFn; },
    async startWebhook(_token, onEvent) {
      listening = true;
      onEventFn = onEvent;
    },
    async stopWebhook() {
      listening = false;
      onEventFn = null;
    },
    isListening() { return listening; },
  };
}

function createMockApi(): WhatsappApiService & { calls: Array<{ payload: WhatsappSendPayload }> } {
  const calls: Array<{ payload: WhatsappSendPayload }> = [];
  return {
    calls,
    async sendMessage(_token, _phoneId, payload) {
      calls.push({ payload });
      return { messages: [{ id: "wamid.test-123" }] };
    },
  };
}

function makeWebhookEvent(overrides: {
  from?: string;
  msgId?: string;
  text?: string;
  contactName?: string;
} = {}): WhatsappWebhookMessage {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry-1",
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "+1234567890", phone_number_id: "pn-1" },
          contacts: [{ profile: { name: overrides.contactName ?? "Alice" }, wa_id: overrides.from ?? "+1987654321" }],
          messages: [{
            from: overrides.from ?? "+1987654321",
            id: overrides.msgId ?? "wamid.incoming-1",
            timestamp: "1740150000",
            text: { body: overrides.text ?? "Hello!" },
            type: "text",
          }],
        },
        field: "messages",
      }],
    }],
  };
}

describe("FridayWhatsappChannel", () => {
  let webhook: ReturnType<typeof createMockWebhook>;
  let api: ReturnType<typeof createMockApi>;
  let plugin: FridayChannelPlugin;

  beforeEach(() => {
    webhook = createMockWebhook();
    api = createMockApi();
    plugin = createFridayWhatsappChannel({ webhook, api });
  });

  // ─── Config Validation ───

  describe("config validation", () => {
    it("validates cloud-api config", () => {
      const result = FridayWhatsappChannelConfigSchema.parse({
        kind: "whatsapp",
        accessToken: "tok",
        phoneNumberId: "pn-1",
      });
      expect(result.provider).toBe("cloud-api");
    });

    it("accepts bridge provider", () => {
      const result = FridayWhatsappChannelConfigSchema.parse({
        kind: "whatsapp",
        provider: "bridge",
        bridgeUrl: "http://localhost:3000",
      });
      expect(result.provider).toBe("bridge");
    });

    it("validates kind is whatsapp", () => {
      expect(() =>
        FridayWhatsappChannelConfigSchema.parse({ kind: "wrong" }),
      ).toThrow();
    });
  });

  // ─── Init ───

  describe("init", () => {
    it("initializes with cloud-api config", async () => {
      await plugin.init({
        kind: "whatsapp",
        accessToken: "tok",
        phoneNumberId: "pn-1",
      });
      expect(plugin.kind).toBe("whatsapp");
    });
  });

  // ─── Inbound Normalization ───

  describe("inbound normalization", () => {
    it("normalizes text messages", () => {
      const event = makeWebhookEvent({ text: "Hi from WhatsApp" });
      const results = normalizeWhatsappWebhook(event);
      expect(results).toHaveLength(1);
      expect(results[0].channelKind).toBe("whatsapp");
      expect(results[0].text).toBe("Hi from WhatsApp");
      expect(results[0].chatType).toBe("direct");
    });

    it("extracts sender name from contacts", () => {
      const event = makeWebhookEvent({ contactName: "Bob" });
      const results = normalizeWhatsappWebhook(event);
      expect(results[0].senderName).toBe("Bob");
    });

    it("extracts message ID", () => {
      const event = makeWebhookEvent({ msgId: "wamid.specific-id" });
      const results = normalizeWhatsappWebhook(event);
      expect(results[0].id).toBe("wamid.specific-id");
    });

    it("converts timestamp to milliseconds", () => {
      const event = makeWebhookEvent();
      const results = normalizeWhatsappWebhook(event);
      expect(results[0].timestamp).toBe(1740150000000);
    });

    it("returns empty array for status-only events", () => {
      const event: WhatsappWebhookMessage = {
        object: "whatsapp_business_account",
        entry: [{
          id: "e-1",
          changes: [{
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+1", phone_number_id: "pn" },
              statuses: [{ id: "wamid.1", status: "delivered", timestamp: "1", recipient_id: "+2" }],
            },
            field: "messages",
          }],
        }],
      };
      const results = normalizeWhatsappWebhook(event);
      expect(results).toHaveLength(0);
    });

    it("ignores non-messages field changes", () => {
      const event: WhatsappWebhookMessage = {
        object: "whatsapp_business_account",
        entry: [{
          id: "e-1",
          changes: [{
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+1", phone_number_id: "pn" },
            },
            field: "something_else",
          }],
        }],
      };
      const results = normalizeWhatsappWebhook(event);
      expect(results).toHaveLength(0);
    });
  });

  // ─── Outbound ───

  describe("outbound", () => {
    it("sends via cloud API", async () => {
      await plugin.init({
        kind: "whatsapp",
        accessToken: "tok",
        phoneNumberId: "pn-1",
      });

      const result = await plugin.send({ chatId: "+1987654321", text: "Response" });
      expect(result.messageId).toBe("wamid.test-123");
      expect(api.calls).toHaveLength(1);
      expect(api.calls[0].payload.to).toBe("+1987654321");
    });

    it("throws if cloud-api config missing credentials", async () => {
      await plugin.init({ kind: "whatsapp" });
      await expect(
        plugin.send({ chatId: "+1", text: "test" }),
      ).rejects.toThrow("accessToken and phoneNumberId");
    });
  });

  // ─── Status ───

  describe("status", () => {
    it("reports disconnected before start", async () => {
      await plugin.init({ kind: "whatsapp", accessToken: "t", phoneNumberId: "p" });
      expect(plugin.adapters!.status!.status()).toBe("disconnected");
    });

    it("reports connected after start", async () => {
      await plugin.init({ kind: "whatsapp", accessToken: "t", phoneNumberId: "p" });
      await plugin.start(() => {});
      expect(plugin.adapters!.status!.status()).toBe("connected");
    });

    it("provides diagnostics with provider", async () => {
      await plugin.init({ kind: "whatsapp", accessToken: "t", phoneNumberId: "p" });
      const diag = plugin.adapters!.status!.diagnostics!();
      expect(diag).toHaveProperty("provider", "cloud-api");
    });
  });

  // ─── Batch Normalization ───

  describe("batch normalization", () => {
    it("normalizeAll returns all messages from batch webhook", () => {
      const batchEvent: WhatsappWebhookMessage = {
        object: "whatsapp_business_account",
        entry: [{
          id: "entry-1",
          changes: [{
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+1", phone_number_id: "pn" },
              contacts: [
                { profile: { name: "Alice" }, wa_id: "+111" },
                { profile: { name: "Bob" }, wa_id: "+222" },
              ],
              messages: [
                { from: "+111", id: "wamid.1", timestamp: "1740150000", text: { body: "First" }, type: "text" },
                { from: "+222", id: "wamid.2", timestamp: "1740150001", text: { body: "Second" }, type: "text" },
              ],
            },
            field: "messages",
          }],
        }],
      };
      const results = normalizeWhatsappWebhook(batchEvent);
      expect(results).toHaveLength(2);
      expect(results[0].text).toBe("First");
      expect(results[1].text).toBe("Second");
    });

    it("inbound adapter normalizeAll returns all messages", async () => {
      await plugin.init({ kind: "whatsapp", accessToken: "t", phoneNumberId: "p" });
      const adapter = plugin.adapters!.inbound!;

      const batchEvent: WhatsappWebhookMessage = {
        object: "whatsapp_business_account",
        entry: [{
          id: "entry-1",
          changes: [{
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+1", phone_number_id: "pn" },
              messages: [
                { from: "+111", id: "wamid.1", timestamp: "1740150000", text: { body: "A" }, type: "text" },
                { from: "+222", id: "wamid.2", timestamp: "1740150001", text: { body: "B" }, type: "text" },
              ],
            },
            field: "messages",
          }],
        }],
      };

      expect(adapter.normalizeAll).toBeDefined();
      const results = adapter.normalizeAll!(batchEvent);
      expect(results).toHaveLength(2);
      expect(results[0].text).toBe("A");
      expect(results[1].text).toBe("B");
    });
  });

  // ─── Start Integration ───

  describe("start integration", () => {
    it("delivers messages through handler", async () => {
      await plugin.init({ kind: "whatsapp", accessToken: "t", phoneNumberId: "p" });
      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      webhook._onEvent!(makeWebhookEvent({ text: "Live msg" }));
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Live msg");
    });

    it("delivers ALL messages from batch webhook through handler", async () => {
      await plugin.init({ kind: "whatsapp", accessToken: "t", phoneNumberId: "p" });
      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      const batchEvent: WhatsappWebhookMessage = {
        object: "whatsapp_business_account",
        entry: [{
          id: "entry-1",
          changes: [{
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+1", phone_number_id: "pn" },
              messages: [
                { from: "+111", id: "wamid.1", timestamp: "1740150000", text: { body: "Msg 1" }, type: "text" },
                { from: "+222", id: "wamid.2", timestamp: "1740150001", text: { body: "Msg 2" }, type: "text" },
                { from: "+333", id: "wamid.3", timestamp: "1740150002", text: { body: "Msg 3" }, type: "text" },
              ],
            },
            field: "messages",
          }],
        }],
      };
      webhook._onEvent!(batchEvent);
      expect(messages).toHaveLength(3);
      expect(messages[0].text).toBe("Msg 1");
      expect(messages[1].text).toBe("Msg 2");
      expect(messages[2].text).toBe("Msg 3");
    });
  });
});
