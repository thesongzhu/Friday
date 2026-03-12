import { describe, it, expect, beforeEach } from "vitest";
import {
  createFridayWebchatChannel,
  normalizeWebchatMessage,
} from "#channels";
import type {
  FridayChannelPlugin,
  FridayChannelMessage,
} from "#channels";
import type {
  WebchatWsService,
  WebchatInboundMessage,
  WebchatOutboundMessage,
} from "../../../../src/channels/webchat/webchat-service.js";
import { FridayWebchatChannelConfigSchema } from "../../../../src/channels/webchat/webchat-config.schema.js";

// ─── Mock Services ───

function createMockWs(): WebchatWsService & {
  _onMessage: ((msg: WebchatInboundMessage) => void) | null;
  _sentMessages: Array<{ clientId: string; message: WebchatOutboundMessage }>;
} {
  let running = false;
  let onMessageFn: ((msg: WebchatInboundMessage) => void) | null = null;
  const sentMessages: Array<{ clientId: string; message: WebchatOutboundMessage }> = [];

  return {
    get _onMessage() { return onMessageFn; },
    _sentMessages: sentMessages,
    async start(_path, _origins, onMessage) {
      running = true;
      onMessageFn = onMessage;
    },
    async stop() {
      running = false;
      onMessageFn = null;
    },
    async sendToClient(clientId, message) {
      sentMessages.push({ clientId, message });
    },
    async broadcast(_message) {
      // stub
    },
    clientCount() { return 3; },
    isRunning() { return running; },
    matchesPath(pathname) { return pathname === "/ws/chat"; },
    handleUpgrade() { return false; },
  };
}

function makeInboundMessage(overrides: Partial<WebchatInboundMessage> = {}): WebchatInboundMessage {
  return {
    type: "message",
    id: "msg-1",
    clientId: "client-abc",
    clientName: "Web User",
    text: "Hello from browser!",
    timestamp: 1740150000000,
    ...overrides,
  };
}

describe("FridayWebchatChannel", () => {
  let ws: ReturnType<typeof createMockWs>;
  let plugin: FridayChannelPlugin;

  beforeEach(() => {
    ws = createMockWs();
    plugin = createFridayWebchatChannel({ ws });
  });

  // ─── Config Validation ───

  describe("config validation", () => {
    it("validates valid config with defaults", () => {
      const result = FridayWebchatChannelConfigSchema.parse({ kind: "webchat" });
      expect(result.wsPath).toBe("/ws/chat");
      expect(result.allowedOrigins).toEqual([]);
      expect(result.authMode).toBe("none");
      expect(result.maxClients).toBe(100);
    });

    it("accepts custom wsPath", () => {
      const result = FridayWebchatChannelConfigSchema.parse({
        kind: "webchat",
        wsPath: "/custom/ws",
      });
      expect(result.wsPath).toBe("/custom/ws");
    });

    it("accepts token authMode", () => {
      const result = FridayWebchatChannelConfigSchema.parse({
        kind: "webchat",
        authMode: "token",
      });
      expect(result.authMode).toBe("token");
    });

    it("rejects invalid authMode", () => {
      expect(() =>
        FridayWebchatChannelConfigSchema.parse({ kind: "webchat", authMode: "invalid" }),
      ).toThrow();
    });
  });

  // ─── Init ───

  describe("init", () => {
    it("initializes with valid config", async () => {
      await plugin.init({ kind: "webchat" });
      expect(plugin.kind).toBe("webchat");
    });
  });

  // ─── Inbound Normalization ───

  describe("inbound normalization", () => {
    it("normalizes webchat message", () => {
      const msg = makeInboundMessage();
      const result = normalizeWebchatMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.channelKind).toBe("webchat");
      expect(result!.senderId).toBe("client-abc");
      expect(result!.senderName).toBe("Web User");
      expect(result!.chatType).toBe("direct");
      expect(result!.text).toBe("Hello from browser!");
    });

    it("uses clientId as chatId", () => {
      const msg = makeInboundMessage({ clientId: "client-xyz" });
      const result = normalizeWebchatMessage(msg);
      expect(result!.chatId).toBe("client-xyz");
    });

    it("returns null for non-message types", () => {
      const msg = { ...makeInboundMessage(), type: "typing" as const };
      const result = normalizeWebchatMessage(msg as unknown as WebchatInboundMessage);
      expect(result).toBeNull();
    });

    it("handles messages with images", () => {
      const msg = makeInboundMessage({
        images: ["data:image/png;base64,abc"],
      });
      const result = normalizeWebchatMessage(msg);
      expect(result!.images).toEqual(["data:image/png;base64,abc"]);
    });

    it("handles messages with replyTo", () => {
      const msg = makeInboundMessage({ replyTo: "prev-msg-1" });
      const result = normalizeWebchatMessage(msg);
      expect(result!.replyTo).toBe("prev-msg-1");
    });
  });

  // ─── Outbound ───

  describe("outbound", () => {
    it("sends message to specific client", async () => {
      await plugin.init({ kind: "webchat" });
      const result = await plugin.send({
        chatId: "client-abc",
        text: "Server response",
      });

      expect(result.messageId).toBeDefined();
      expect(ws._sentMessages).toHaveLength(1);
      expect(ws._sentMessages[0].clientId).toBe("client-abc");
      expect(ws._sentMessages[0].message.text).toBe("Server response");
    });
  });

  // ─── Status ───

  describe("status", () => {
    it("reports disconnected before start", async () => {
      await plugin.init({ kind: "webchat" });
      expect(plugin.adapters!.status!.status()).toBe("disconnected");
    });

    it("reports connected after start", async () => {
      await plugin.init({ kind: "webchat" });
      await plugin.start(() => {});
      expect(plugin.adapters!.status!.status()).toBe("connected");
    });

    it("provides diagnostics with client count", async () => {
      await plugin.init({ kind: "webchat" });
      await plugin.start(() => {});
      const diag = plugin.adapters!.status!.diagnostics!();
      expect(diag).toHaveProperty("clientCount", 3);
      expect(diag).toHaveProperty("wsPath", "/ws/chat");
      expect(diag).toHaveProperty("running", true);
    });
  });

  // ─── Start Integration ───

  describe("start integration", () => {
    it("delivers messages through handler", async () => {
      await plugin.init({ kind: "webchat" });
      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      ws._onMessage!(makeInboundMessage({ text: "Live webchat" }));
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Live webchat");
    });
  });
});
