import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFridayLarkChannel } from "#channels";
import type { FridayChannelPlugin, FridayChannelMessage } from "#channels";
import type { LarkWebhookRelayService } from "#channels";

// ─── Mock WebSocket ───

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  listeners: Record<string, Array<(event: unknown) => void>> = {};
  sentMessages: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    // Auto-fire "open" event on next microtask
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(event: string, handler: (event: unknown) => void): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  removeEventListener(event: string, handler: (event: unknown) => void): void {
    const arr = this.listeners[event];
    if (arr) {
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(event: string, data: unknown): void {
    const handlers = this.listeners[event] ?? [];
    for (const h of handlers) h(data);
  }

  simulateMessage(data: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(data) });
  }
}

// ─── Mock fetch ───

function createMockFetch() {
  const responses: Array<{ url: string; body: unknown; status?: number }> = [];

  const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    const match = responses.find((r) => urlStr.includes(r.url));
    if (!match) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({}),
        text: async () => "Not Found",
      };
    }
    return {
      ok: (match.status ?? 200) < 400,
      status: match.status ?? 200,
      statusText: "OK",
      json: async () => match.body,
      text: async () => JSON.stringify(match.body),
    };
  });

  return { mockFetch, responses };
}

function createMockWebhookRelay(): LarkWebhookRelayService & {
  _handler: ((event: Record<string, unknown>) => void) | null;
  verificationToken?: string;
  encryptKey?: string;
} {
  let listening = false;
  let handler: ((event: Record<string, unknown>) => void) | null = null;
  let verificationToken: string | undefined;
  let encryptKey: string | undefined;
  return {
    get _handler() {
      return handler;
    },
    get verificationToken() {
      return verificationToken;
    },
    get encryptKey() {
      return encryptKey;
    },
    setVerificationToken(token) {
      verificationToken = token;
    },
    setEncryptKey(key) {
      encryptKey = key;
    },
    async start(onEvent) {
      listening = true;
      handler = onEvent;
    },
    async stop() {
      listening = false;
      handler = null;
    },
    isListening() {
      return listening;
    },
    handleHttpWebhook(rawBody) {
      if (!listening || !handler) {
        return { accepted: false, statusCode: 503, code: "LARK_LISTENER_INACTIVE" as const };
      }
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      handler(payload);
      return { accepted: true, statusCode: 200 };
    },
  };
}

describe("FridayLarkChannel", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebSocket: typeof globalThis.WebSocket;
  let plugin: FridayChannelPlugin;
  let fetchMock: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebSocket = globalThis.WebSocket;

    fetchMock = createMockFetch();
    globalThis.fetch = fetchMock.mockFetch as unknown as typeof globalThis.fetch;
    (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket as unknown;

    MockWebSocket.instances = [];

    plugin = createFridayLarkChannel();
  });

  afterEach(async () => {
    try {
      await plugin.stop();
    } catch {
      // ignore
    }
    globalThis.fetch = originalFetch;
    (globalThis as unknown as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  describe("init", () => {
    it("validates appId and appSecret are required", async () => {
      // P1-CH-001: Now uses Zod validation — throws ZodError for missing required fields
      await expect(plugin.init({})).rejects.toThrow();
    });

    it("initializes with valid config (international Lark)", async () => {
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        useFeishu: false,
      });
      expect(plugin.kind).toBe("lark");
    });

    it("sets kind to feishu when useFeishu is true", async () => {
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        useFeishu: true,
      });
      expect(plugin.kind).toBe("feishu");
    });
  });

  describe("token refresh", () => {
    it("fetches tenant_access_token from Feishu API", async () => {
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        useFeishu: true,
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-123",
            expire: 7200,
          },
        },
        {
          url: "/callback/ws/endpoint",
          body: {
            code: 0,
            data: { URL: "wss://lark.example.com/ws" },
          },
        },
      );

      await plugin.start(() => {});

      const tokenCall = fetchMock.mockFetch.mock.calls.find(
        (c) => String(c[0]).includes("tenant_access_token"),
      );
      expect(tokenCall).toBeDefined();
      expect(String(tokenCall![0])).toContain("open.feishu.cn");
    });

    it("uses international Lark API base when useFeishu is false", async () => {
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        useFeishu: false,
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-456",
            expire: 7200,
          },
        },
        {
          url: "/callback/ws/endpoint",
          body: {
            code: 0,
            data: { URL: "wss://lark.example.com/ws" },
          },
        },
      );

      await plugin.start(() => {});

      const tokenCall = fetchMock.mockFetch.mock.calls.find(
        (c) => String(c[0]).includes("tenant_access_token"),
      );
      expect(tokenCall).toBeDefined();
      expect(String(tokenCall![0])).toContain("open.larksuite.com");
    });
  });

  describe("message parsing", () => {
    it("parses im.message.receive_v1 events", async () => {
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-789",
            expire: 7200,
          },
        },
        {
          url: "/callback/ws/endpoint",
          body: {
            code: 0,
            data: { URL: "wss://lark.example.com/ws" },
          },
        },
      );

      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      const ws = MockWebSocket.instances[0];
      expect(ws).toBeDefined();

      // Wait for open event
      await new Promise((r) => setTimeout(r, 10));

      // Simulate a message receive event
      ws.simulateMessage({
        header: {
          event_type: "im.message.receive_v1",
          event_id: "evt-001",
        },
        event: {
          message: {
            message_id: "om_001",
            chat_id: "oc_abc",
            chat_type: "group",
            content: '{"text":"Hello from Lark!"}',
            create_time: "1708416000000",
          },
          sender: {
            sender_id: {
              open_id: "ou_user1",
              name: "Test User",
            },
          },
        },
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("om_001");
      expect(messages[0].channelKind).toBe("lark");
      expect(messages[0].senderId).toBe("ou_user1");
      expect(messages[0].chatId).toBe("oc_abc");
      expect(messages[0].chatType).toBe("group");
      expect(messages[0].text).toBe("Hello from Lark!");
    });

    it("parses p2p (direct) messages", async () => {
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-aaa",
            expire: 7200,
          },
        },
        {
          url: "/callback/ws/endpoint",
          body: {
            code: 0,
            data: { URL: "wss://lark.example.com/ws" },
          },
        },
      );

      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      const ws = MockWebSocket.instances[0];
      await new Promise((r) => setTimeout(r, 10));

      ws.simulateMessage({
        header: {
          event_type: "im.message.receive_v1",
        },
        event: {
          message: {
            message_id: "om_002",
            chat_id: "oc_dm",
            chat_type: "p2p",
            content: '{"text":"DM text"}',
            create_time: "1708416000000",
          },
          sender: {
            sender_id: { open_id: "ou_dm_user" },
          },
        },
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].chatType).toBe("direct");
    });

    it("handles non-JSON content gracefully", async () => {
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-bbb",
            expire: 7200,
          },
        },
        {
          url: "/callback/ws/endpoint",
          body: {
            code: 0,
            data: { URL: "wss://lark.example.com/ws" },
          },
        },
      );

      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      const ws = MockWebSocket.instances[0];
      await new Promise((r) => setTimeout(r, 10));

      ws.simulateMessage({
        header: { event_type: "im.message.receive_v1" },
        event: {
          message: {
            message_id: "om_003",
            chat_id: "oc_x",
            chat_type: "group",
            content: "plain text fallback",
            create_time: "1708416000000",
          },
          sender: {
            sender_id: { open_id: "ou_user2" },
          },
        },
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("plain text fallback");
    });

    it("ignores non-message events", async () => {
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-ccc",
            expire: 7200,
          },
        },
        {
          url: "/callback/ws/endpoint",
          body: {
            code: 0,
            data: { URL: "wss://lark.example.com/ws" },
          },
        },
      );

      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      const ws = MockWebSocket.instances[0];
      await new Promise((r) => setTimeout(r, 10));

      // Some other event type
      ws.simulateMessage({
        header: { event_type: "im.chat.member.bot.added_v1" },
        event: { chat_id: "oc_x" },
      });

      expect(messages).toHaveLength(0);
    });
  });

  describe("send", () => {
    it("sends text messages via REST API", async () => {
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-send",
            expire: 7200,
          },
        },
        {
          url: "/callback/ws/endpoint",
          body: {
            code: 0,
            data: { URL: "wss://lark.example.com/ws" },
          },
        },
        {
          url: "/im/v1/messages",
          body: {
            code: 0,
            data: { message_id: "om_sent_1" },
          },
        },
      );

      await plugin.start(() => {});

      const result = await plugin.send({
        chatId: "oc_target",
        text: "Response from bot",
      });

      expect(result.messageId).toBe("om_sent_1");

      // Verify the send call
      const sendCall = fetchMock.mockFetch.mock.calls.find(
        (c) => String(c[0]).includes("/im/v1/messages"),
      );
      expect(sendCall).toBeDefined();

      const body = JSON.parse((sendCall![1] as RequestInit).body as string);
      expect(body.receive_id).toBe("oc_target");
      expect(body.msg_type).toBe("text");
      expect(JSON.parse(body.content)).toEqual({ text: "Response from bot" });
    });
  });

  describe("reconnect after stop", () => {
    it("does not schedule reconnect after stop()", async () => {
      vi.useFakeTimers();

      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-stop",
            expire: 7200,
          },
        },
        {
          url: "/callback/ws/endpoint",
          body: {
            code: 0,
            data: { URL: "wss://lark.example.com/ws" },
          },
        },
      );

      await plugin.start(() => {});

      const ws = MockWebSocket.instances[0];
      ws.emit("open", {});

      const instanceCountBefore = MockWebSocket.instances.length;

      // Stop the plugin, then trigger close on the socket
      await plugin.stop();

      // Advance past reconnect delay
      vi.advanceTimersByTime(15_000);

      // No new WebSocket should have been created
      expect(MockWebSocket.instances.length).toBe(instanceCountBefore);

      vi.useRealTimers();
    });

    it("ignores stale socket close events", async () => {
      vi.useFakeTimers();

      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-stale",
            expire: 7200,
          },
        },
        {
          url: "/callback/ws/endpoint",
          body: {
            code: 0,
            data: { URL: "wss://lark.example.com/ws" },
          },
        },
      );

      await plugin.start(() => {});

      const staleSocket = MockWebSocket.instances[0];
      staleSocket.emit("open", {});

      const instanceCountBefore = MockWebSocket.instances.length;

      // Stop the plugin (which closes and nulls ws)
      await plugin.stop();

      // Simulate the stale socket firing close event after stop
      staleSocket.emit("close", {});

      vi.advanceTimersByTime(15_000);

      // No new reconnection should happen
      expect(MockWebSocket.instances.length).toBe(instanceCountBefore);

      vi.useRealTimers();
    });
  });

  describe("ping keepalive", () => {
    it("sends ping messages after connection opens", async () => {
      vi.useFakeTimers();

      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-ping",
            expire: 7200,
          },
        },
        {
          url: "/callback/ws/endpoint",
          body: {
            code: 0,
            data: { URL: "wss://lark.example.com/ws" },
          },
        },
      );

      await plugin.start(() => {});

      const ws = MockWebSocket.instances[0];

      // Trigger the open event manually since we're using fake timers
      ws.emit("open", {});

      // Advance past ping interval
      vi.advanceTimersByTime(30_000);

      const pingSent = ws.sentMessages.find((m) => {
        const parsed = JSON.parse(m);
        return parsed.type === "ping";
      });
      expect(pingSent).toBeDefined();

      vi.useRealTimers();
    });
  });

  describe("webhook mode", () => {
    it("rejects webhook mode when verificationToken is missing", async () => {
      const webhookRelay = createMockWebhookRelay();
      plugin = createFridayLarkChannel({ webhookRelay });

      await expect(plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        receiveMode: "webhook",
      })).rejects.toThrow("verificationToken");
    });

    it("starts webhook relay when receiveMode is webhook and handles events", async () => {
      const webhookRelay = createMockWebhookRelay();
      plugin = createFridayLarkChannel({ webhookRelay });

      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        receiveMode: "webhook",
        verificationToken: "verify-token-1",
        encryptKey: "encrypt-key-1",
      });

      fetchMock.responses.push({
        url: "tenant_access_token",
        body: {
          code: 0,
          msg: "ok",
          tenant_access_token: "t-token-webhook",
          expire: 7200,
        },
      });

      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      expect(webhookRelay.isListening()).toBe(true);
      expect(webhookRelay.verificationToken).toBe("verify-token-1");
      expect(webhookRelay.encryptKey).toBe("encrypt-key-1");
      expect(MockWebSocket.instances).toHaveLength(0);

      webhookRelay._handler?.({
        header: {
          event_type: "im.message.receive_v1",
        },
        event: {
          message: {
            message_id: "om_webhook_1",
            chat_id: "oc_webhook",
            chat_type: "group",
            content: "{\"text\":\"Webhook hello\"}",
            create_time: "1708416000000",
          },
          sender: {
            sender_id: {
              open_id: "ou_webhook",
            },
          },
        },
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("om_webhook_1");
      expect(messages[0].text).toBe("Webhook hello");
    });

    it("throws if webhook mode is requested without webhookRelay dependency", async () => {
      plugin = createFridayLarkChannel();
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        receiveMode: "webhook",
        verificationToken: "verify-token-1",
      });
      fetchMock.responses.push({
        url: "tenant_access_token",
        body: {
          code: 0,
          msg: "ok",
          tenant_access_token: "t-token-webhook-no-relay",
          expire: 7200,
        },
      });

      await expect(plugin.start(() => {})).rejects.toThrow("webhookRelay");
    });
  });
});
