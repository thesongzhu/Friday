import { describe, it, expect, beforeEach } from "vitest";
import {
  createFridaySignalChannel,
  normalizeSignalMessage,
} from "#channels";
import type {
  FridayChannelPlugin,
  FridayChannelMessage,
} from "#channels";
import type {
  SignalSseService,
  SignalRpcService,
  SignalInboundMessage,
  SignalSendPayload,
} from "../../../../src/channels/signal/signal-service.js";
import { FridaySignalChannelConfigSchema } from "../../../../src/channels/signal/signal-config.schema.js";

// ─── Mock Services ───

function createMockSse(): SignalSseService & {
  _onMessage: ((msg: SignalInboundMessage) => void) | null;
} {
  let connected = false;
  let onMessageFn: ((msg: SignalInboundMessage) => void) | null = null;

  return {
    get _onMessage() { return onMessageFn; },
    async connect(_url, _account, onMessage) {
      connected = true;
      onMessageFn = onMessage;
    },
    async disconnect() {
      connected = false;
      onMessageFn = null;
    },
    isConnected() { return connected; },
  };
}

function createMockRpc(): SignalRpcService & { calls: Array<{ payload: SignalSendPayload }> } {
  const calls: Array<{ payload: SignalSendPayload }> = [];
  return {
    calls,
    async sendMessage(_url, _account, payload) {
      calls.push({ payload });
      return { timestamp: 1740150001000 };
    },
  };
}

function makeSignalMessage(overrides: Partial<{
  source: string;
  sourceNumber: string;
  sourceName: string;
  message: string;
  groupId: string;
  timestamp: number;
}> = {}): SignalInboundMessage {
  return {
    envelope: {
      source: overrides.source ?? "uuid-1",
      sourceNumber: overrides.sourceNumber ?? "+1234567890",
      sourceName: overrides.sourceName ?? "Alice",
      timestamp: overrides.timestamp ?? 1740150000000,
      dataMessage: {
        message: overrides.message ?? "Hello from Signal!",
        timestamp: overrides.timestamp ?? 1740150000000,
        groupInfo: overrides.groupId
          ? { groupId: overrides.groupId, groupName: "Test Group" }
          : undefined,
      },
    },
    account: "+0000000000",
  };
}

describe("FridaySignalChannel", () => {
  let sse: ReturnType<typeof createMockSse>;
  let rpc: ReturnType<typeof createMockRpc>;
  let plugin: FridayChannelPlugin;

  beforeEach(() => {
    sse = createMockSse();
    rpc = createMockRpc();
    plugin = createFridaySignalChannel({ sse, rpc });
  });

  // ─── Config Validation ───

  describe("config validation", () => {
    it("validates valid config", () => {
      const result = FridaySignalChannelConfigSchema.parse({
        kind: "signal",
        account: "+1234567890",
      });
      expect(result.account).toBe("+1234567890");
      expect(result.baseUrl).toBe("http://localhost:8080");
    });

    it("rejects missing account", () => {
      expect(() =>
        FridaySignalChannelConfigSchema.parse({ kind: "signal" }),
      ).toThrow();
    });

    it("accepts custom baseUrl", () => {
      const result = FridaySignalChannelConfigSchema.parse({
        kind: "signal",
        account: "+1",
        baseUrl: "http://remote:9090",
      });
      expect(result.baseUrl).toBe("http://remote:9090");
    });
  });

  // ─── Init ───

  describe("init", () => {
    it("initializes with valid config", async () => {
      await plugin.init({ kind: "signal", account: "+1234567890" });
      expect(plugin.kind).toBe("signal");
    });

    it("rejects config without account", async () => {
      await expect(plugin.init({ kind: "signal" })).rejects.toThrow();
    });
  });

  // ─── Inbound Normalization ───

  describe("inbound normalization", () => {
    it("normalizes a direct message", () => {
      const msg = makeSignalMessage();
      const result = normalizeSignalMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.channelKind).toBe("signal");
      expect(result!.senderId).toBe("+1234567890");
      expect(result!.senderName).toBe("Alice");
      expect(result!.chatType).toBe("direct");
      expect(result!.text).toBe("Hello from Signal!");
    });

    it("normalizes a group message", () => {
      const msg = makeSignalMessage({ groupId: "group-abc" });
      const result = normalizeSignalMessage(msg);
      expect(result!.chatType).toBe("group");
      expect(result!.chatId).toBe("group-abc");
    });

    it("returns null for envelope without dataMessage", () => {
      const msg: SignalInboundMessage = {
        envelope: {
          source: "uuid-1",
          sourceNumber: "+1",
          timestamp: 1,
        },
        account: "+0",
      };
      expect(normalizeSignalMessage(msg)).toBeNull();
    });

    it("extracts image attachments", () => {
      const msg = makeSignalMessage();
      msg.envelope.dataMessage!.attachments = [
        { contentType: "image/jpeg", id: "att-1", size: 1024 },
        { contentType: "application/pdf", id: "att-2", size: 2048 },
      ];
      const result = normalizeSignalMessage(msg);
      expect(result!.images).toEqual(["att-1"]);
    });

    it("extracts quote as replyTo", () => {
      const msg = makeSignalMessage();
      msg.envelope.dataMessage!.quote = { id: 999, author: "+1", text: "Quoted" };
      const result = normalizeSignalMessage(msg);
      expect(result!.replyTo).toBe("999");
    });

    it("generates composite message ID", () => {
      const msg = makeSignalMessage({ sourceNumber: "+1", timestamp: 12345 });
      const result = normalizeSignalMessage(msg);
      expect(result!.id).toBe("+1-12345");
    });
  });

  // ─── Outbound ───

  describe("outbound", () => {
    it("sends via JSON-RPC", async () => {
      await plugin.init({ kind: "signal", account: "+0000000000" });
      const result = await plugin.send({
        chatId: "+1234567890",
        text: "Bot reply",
      });

      expect(result.messageId).toBe("1740150001000");
      expect(rpc.calls).toHaveLength(1);
      expect(rpc.calls[0].payload.recipients).toEqual(["+1234567890"]);
    });
  });

  // ─── Status ───

  describe("status", () => {
    it("reports disconnected before start", async () => {
      await plugin.init({ kind: "signal", account: "+1" });
      expect(plugin.adapters!.status!.status()).toBe("disconnected");
    });

    it("reports connected after start", async () => {
      await plugin.init({ kind: "signal", account: "+1" });
      await plugin.start(() => {});
      expect(plugin.adapters!.status!.status()).toBe("connected");
    });

    it("provides diagnostics", async () => {
      await plugin.init({ kind: "signal", account: "+1" });
      const diag = plugin.adapters!.status!.diagnostics!();
      expect(diag).toHaveProperty("baseUrl");
      expect(diag).toHaveProperty("account");
    });
  });

  // ─── Start Integration ───

  describe("start integration", () => {
    it("delivers messages through handler", async () => {
      await plugin.init({ kind: "signal", account: "+0" });
      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      sse._onMessage!(makeSignalMessage({ message: "Live signal msg" }));
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Live signal msg");
    });
  });
});
