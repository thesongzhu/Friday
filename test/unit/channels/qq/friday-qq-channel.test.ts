import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFridayQqChannel } from "#channels";
import type { FridayChannelPlugin, FridayChannelMessage } from "#channels";

// ─── Mock WebSocket ───

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  listeners: Record<string, Array<(event: unknown) => void>> = {};
  sentMessages: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
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
    this.readyState = 3; // CLOSED
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

describe("FridayQqChannel", () => {
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

    plugin = createFridayQqChannel();
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
      await expect(plugin.init({})).rejects.toThrow("QQ channel requires appId and appSecret");
    });

    it("initializes with valid config", async () => {
      await plugin.init({
        appId: "test-app",
        appSecret: "test-secret",
      });
      expect(plugin.kind).toBe("qq");
    });

    it("accepts sandbox mode", async () => {
      await plugin.init({
        appId: "test-app",
        appSecret: "test-secret",
        sandbox: true,
      });
      expect(plugin.kind).toBe("qq");
    });
  });

  describe("message parsing", () => {
    it("parses GROUP_AT_MESSAGE_CREATE events", async () => {
      await plugin.init({ appId: "test-app", appSecret: "test-secret" });

      fetchMock.responses.push(
        {
          url: "getAppAccessToken",
          body: { access_token: "token-123", expires_in: 7200 },
        },
        {
          url: "/gateway",
          body: { url: "wss://gateway.qq.com" },
        },
      );

      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      const ws = MockWebSocket.instances[0];
      expect(ws).toBeDefined();

      // Simulate Hello event
      ws.simulateMessage({
        op: 10,
        d: { heartbeat_interval: 30000 },
      });

      // Simulate GROUP_AT_MESSAGE_CREATE dispatch
      ws.simulateMessage({
        op: 0,
        t: "GROUP_AT_MESSAGE_CREATE",
        s: 1,
        d: {
          id: "msg-001",
          content: "Hello bot!",
          group_openid: "group-abc",
          author: { member_openid: "user-xyz" },
          timestamp: "2026-02-20T09:00:00.000Z",
        },
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-001");
      expect(messages[0].channelKind).toBe("qq");
      expect(messages[0].senderId).toBe("user-xyz");
      expect(messages[0].chatId).toBe("group-abc");
      expect(messages[0].chatType).toBe("group");
      expect(messages[0].text).toBe("Hello bot!");
    });

    it("parses C2C_MESSAGE_CREATE events as direct messages", async () => {
      await plugin.init({ appId: "test-app", appSecret: "test-secret" });

      fetchMock.responses.push(
        {
          url: "getAppAccessToken",
          body: { access_token: "token-123", expires_in: 7200 },
        },
        {
          url: "/gateway",
          body: { url: "wss://gateway.qq.com" },
        },
      );

      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      const ws = MockWebSocket.instances[0];
      ws.simulateMessage({ op: 10, d: { heartbeat_interval: 30000 } });

      ws.simulateMessage({
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        s: 2,
        d: {
          id: "dm-001",
          content: "Hi there!",
          author: { user_openid: "user-abc" },
          timestamp: "2026-02-20T09:00:00.000Z",
        },
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].chatType).toBe("direct");
      expect(messages[0].senderId).toBe("user-abc");
      expect(messages[0].chatId).toBe("user-abc");
    });

    it("ignores unknown event types", async () => {
      await plugin.init({ appId: "test-app", appSecret: "test-secret" });

      fetchMock.responses.push(
        {
          url: "getAppAccessToken",
          body: { access_token: "token-123", expires_in: 7200 },
        },
        {
          url: "/gateway",
          body: { url: "wss://gateway.qq.com" },
        },
      );

      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));

      const ws = MockWebSocket.instances[0];
      ws.simulateMessage({ op: 10, d: { heartbeat_interval: 30000 } });

      ws.simulateMessage({
        op: 0,
        t: "UNKNOWN_EVENT",
        s: 1,
        d: { id: "msg-999" },
      });

      expect(messages).toHaveLength(0);
    });
  });

  describe("heartbeat", () => {
    it("sends identify on Hello and heartbeats periodically", async () => {
      vi.useFakeTimers();

      await plugin.init({ appId: "test-app", appSecret: "test-secret" });

      fetchMock.responses.push(
        {
          url: "getAppAccessToken",
          body: { access_token: "token-123", expires_in: 7200 },
        },
        {
          url: "/gateway",
          body: { url: "wss://gateway.qq.com" },
        },
      );

      await plugin.start(() => {});

      const ws = MockWebSocket.instances[0];

      // Hello event triggers identify
      ws.simulateMessage({
        op: 10,
        d: { heartbeat_interval: 30000 },
      });

      // Identify should have been sent
      expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1);
      const identifyMsg = JSON.parse(ws.sentMessages[0]);
      expect(identifyMsg.op).toBe(2);

      // Advance time for heartbeat
      vi.advanceTimersByTime(30_000);

      const heartbeat = ws.sentMessages.find((m) => {
        const parsed = JSON.parse(m);
        return parsed.op === 1;
      });
      expect(heartbeat).toBeDefined();

      vi.useRealTimers();
    });
  });

  describe("reconnect race prevention", () => {
    it("does not create duplicate connections when op=7 and close fire in same tick", async () => {
      vi.useFakeTimers();

      await plugin.init({ appId: "test-app", appSecret: "test-secret" });

      fetchMock.responses.push(
        {
          url: "getAppAccessToken",
          body: { access_token: "token-123", expires_in: 7200 },
        },
        {
          url: "/gateway",
          body: { url: "wss://gateway.qq.com" },
        },
      );

      await plugin.start(() => {});

      const ws = MockWebSocket.instances[0];
      expect(ws).toBeDefined();

      // Simulate Hello event
      ws.simulateMessage({ op: 10, d: { heartbeat_interval: 30000 } });

      const initialInstanceCount = MockWebSocket.instances.length;

      // Trigger op=7 (reconnect) and close in the same tick
      ws.simulateMessage({ op: 7 });
      ws.emit("close", {});

      // Advance past reconnect timer
      vi.advanceTimersByTime(10_000);

      // Only one new WebSocket should be created, not two
      const newInstances = MockWebSocket.instances.length - initialInstanceCount;
      expect(newInstances).toBeLessThanOrEqual(1);

      vi.useRealTimers();
    });
  });

  describe("send", () => {
    it("sends messages via REST API", async () => {
      await plugin.init({ appId: "test-app", appSecret: "test-secret" });

      fetchMock.responses.push(
        {
          url: "getAppAccessToken",
          body: { access_token: "token-123", expires_in: 7200 },
        },
        {
          url: "/gateway",
          body: { url: "wss://gateway.qq.com" },
        },
        {
          url: "/v2/groups/",
          body: { id: "sent-msg-1" },
        },
      );

      await plugin.start(() => {});

      const result = await plugin.send({
        chatId: "group-abc",
        text: "Hello from bot!",
        replyTo: "msg-001",
      });

      expect(result.messageId).toBe("sent-msg-1");

      // Verify the send fetch was called
      const sendCall = fetchMock.mockFetch.mock.calls.find(
        (c) => String(c[0]).includes("/v2/groups/"),
      );
      expect(sendCall).toBeDefined();

      const body = JSON.parse((sendCall![1] as RequestInit).body as string);
      expect(body.content).toBe("Hello from bot!");
      expect(body.msg_id).toBe("msg-001");
    });
  });
});
