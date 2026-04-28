import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  const responses: Array<{
    url: string;
    body: unknown;
    status?: number;
    headers?: Record<string, string>;
  }> = [];

  const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    const match = responses.find((r) => urlStr.includes(r.url));
    if (!match) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: { get: () => "text/plain" },
        json: async () => ({}),
        text: async () => "Not Found",
        arrayBuffer: async () => new TextEncoder().encode("Not Found").buffer,
      };
    }
    const bodyToArrayBuffer = (): ArrayBuffer => {
      if (match.body instanceof ArrayBuffer) return match.body;
      if (ArrayBuffer.isView(match.body)) {
        return match.body.buffer.slice(match.body.byteOffset, match.body.byteOffset + match.body.byteLength);
      }
      if (typeof match.body === "string") {
        return new TextEncoder().encode(match.body).buffer;
      }
      return new TextEncoder().encode(JSON.stringify(match.body)).buffer;
    };
    return {
      ok: (match.status ?? 200) < 400,
      status: match.status ?? 200,
      statusText: "OK",
      headers: {
        get: (name: string) => {
          const normalized = name.toLowerCase();
          const entry = Object.entries(match.headers ?? {}).find(([key]) => key.toLowerCase() === normalized);
          return entry?.[1] ?? null;
        },
      },
      json: async () => match.body,
      text: async () => typeof match.body === "string" ? match.body : JSON.stringify(match.body),
      arrayBuffer: async () => bodyToArrayBuffer(),
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
  let originalAttachmentDir: string | undefined;
  let plugin: FridayChannelPlugin;
  let fetchMock: ReturnType<typeof createMockFetch>;
  let attachmentDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebSocket = globalThis.WebSocket;
    originalAttachmentDir = process.env.FRIDAY_CHANNEL_ATTACHMENT_DIR;
    attachmentDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-lark-attachments-"));
    process.env.FRIDAY_CHANNEL_ATTACHMENT_DIR = attachmentDir;

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
    if (originalAttachmentDir === undefined) {
      delete process.env.FRIDAY_CHANNEL_ATTACHMENT_DIR;
    } else {
      process.env.FRIDAY_CHANNEL_ATTACHMENT_DIR = originalAttachmentDir;
    }
    fs.rmSync(attachmentDir, { recursive: true, force: true });
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
      const webhookRelay = createMockWebhookRelay();
      plugin = createFridayLarkChannel({ webhookRelay });
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        useFeishu: true,
        receiveMode: "webhook",
        verificationToken: "verify-token-1",
      });

      fetchMock.responses.push({
        url: "tenant_access_token",
        body: {
          code: 0,
          msg: "ok",
          tenant_access_token: "t-token-123",
          expire: 7200,
        },
      });

      await plugin.start(() => {});

      const tokenCall = fetchMock.mockFetch.mock.calls.find(
        (c) => String(c[0]).includes("tenant_access_token"),
      );
      expect(tokenCall).toBeDefined();
      expect(String(tokenCall![0])).toContain("open.feishu.cn");
      expect(MockWebSocket.instances).toHaveLength(0);
    });

    it("uses international Lark API base when useFeishu is false", async () => {
      const webhookRelay = createMockWebhookRelay();
      plugin = createFridayLarkChannel({ webhookRelay });
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        useFeishu: false,
        receiveMode: "webhook",
        verificationToken: "verify-token-1",
      });

      fetchMock.responses.push({
        url: "tenant_access_token",
        body: {
          code: 0,
          msg: "ok",
          tenant_access_token: "t-token-456",
          expire: 7200,
        },
      });

      await plugin.start(() => {});

      const tokenCall = fetchMock.mockFetch.mock.calls.find(
        (c) => String(c[0]).includes("tenant_access_token"),
      );
      expect(tokenCall).toBeDefined();
      expect(String(tokenCall![0])).toContain("open.larksuite.com");
      expect(MockWebSocket.instances).toHaveLength(0);
    });
  });

  describe("message parsing", () => {
    async function startWebhookMessageTest(options: { useFeishu?: boolean; token?: string } = {}) {
      const webhookRelay = createMockWebhookRelay();
      plugin = createFridayLarkChannel({ webhookRelay });
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        useFeishu: options.useFeishu ?? false,
        receiveMode: "webhook",
        verificationToken: "verify-token-1",
      });
      fetchMock.responses.push({
        url: "tenant_access_token",
        body: {
          code: 0,
          msg: "ok",
          tenant_access_token: options.token ?? "t-token-webhook-test",
          expire: 7200,
        },
      });
      const messages: FridayChannelMessage[] = [];
      await plugin.start((msg) => messages.push(msg));
      return { webhookRelay, messages };
    }

    it("parses im.message.receive_v1 events", async () => {
      const { webhookRelay, messages } = await startWebhookMessageTest();

      webhookRelay._handler?.({
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
      const { webhookRelay, messages } = await startWebhookMessageTest();

      webhookRelay._handler?.({
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
      const { webhookRelay, messages } = await startWebhookMessageTest();

      webhookRelay._handler?.({
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

    it("downloads Feishu image resources before forwarding to Friday", async () => {
      const { webhookRelay, messages } = await startWebhookMessageTest({
        useFeishu: true,
        token: "t-token-image",
      });
      fetchMock.responses.push({
        url: "/open-apis/im/v1/messages/om_image/resources/img_v3_test",
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        headers: { "content-type": "image/png" },
      });

      webhookRelay._handler?.({
        header: { event_type: "im.message.receive_v1" },
        event: {
          message: {
            message_id: "om_image",
            chat_id: "oc_image",
            chat_type: "p2p",
            content: '{"image_key":"img_v3_test"}',
            create_time: "1708416000000",
          },
          sender: {
            sender_id: { open_id: "ou_image_user" },
          },
        },
      });

      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(messages[0].channelKind).toBe("feishu");
      expect(messages[0].text).toBe("");
      expect(messages[0].images).toHaveLength(1);
      expect(messages[0].images?.[0]).toContain(attachmentDir);
      expect(fs.readFileSync(messages[0].images![0]!)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(messages[0].attachments?.[0]).toEqual(expect.objectContaining({
        kind: "image",
        status: "resolved",
        contentType: "image/png",
        sizeBytes: 4,
      }));
    });

    it("keeps image download failures explainable instead of forwarding an empty message", async () => {
      const { webhookRelay, messages } = await startWebhookMessageTest({
        useFeishu: true,
        token: "t-token-image-failed",
      });
      fetchMock.responses.push({
        url: "/open-apis/im/v1/messages/om_image_failed/resources/img_v3_failed",
        status: 403,
        body: { code: 99991663, msg: "permission denied" },
        headers: { "content-type": "application/json" },
      });

      webhookRelay._handler?.({
        header: { event_type: "im.message.receive_v1" },
        event: {
          message: {
            message_id: "om_image_failed",
            chat_id: "oc_image",
            chat_type: "p2p",
            content: '{"image_key":"img_v3_failed"}',
            create_time: "1708416000000",
          },
          sender: {
            sender_id: { open_id: "ou_image_user" },
          },
        },
      });

      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(messages[0].images).toBeUndefined();
      expect(messages[0].text).toContain("could not download the resource bytes");
      expect(messages[0].attachments?.[0]).toEqual(expect.objectContaining({
        kind: "image",
        status: "failed",
      }));
    });

    it("downloads Feishu file, audio, video, and post image resources as normalized attachments", async () => {
      const { webhookRelay, messages } = await startWebhookMessageTest({
        useFeishu: true,
        token: "t-token-media",
      });
      fetchMock.responses.push(
        {
          url: "/open-apis/im/v1/messages/om_file/resources/file_key_1",
          body: Buffer.from("pdf"),
          headers: { "content-type": "application/pdf" },
        },
        {
          url: "/open-apis/im/v1/messages/om_audio/resources/audio_key_1",
          body: Buffer.from("audio"),
          headers: { "content-type": "audio/mpeg" },
        },
        {
          url: "/open-apis/im/v1/messages/om_video/resources/video_key_1",
          body: Buffer.from("video"),
          headers: { "content-type": "video/mp4" },
        },
        {
          url: "/open-apis/im/v1/messages/om_post/resources/post_img_1",
          body: Buffer.from([1, 2, 3]),
          headers: { "content-type": "image/png" },
        },
      );

      const baseEvent = {
        header: { event_type: "im.message.receive_v1" },
        event: {
          message: {
            chat_id: "oc_media",
            chat_type: "p2p",
            create_time: "1708416000000",
          },
          sender: {
            sender_id: { open_id: "ou_media_user" },
          },
        },
      };
      webhookRelay._handler?.({
        ...baseEvent,
        event: {
          ...baseEvent.event,
          message: {
            ...baseEvent.event.message,
            message_id: "om_file",
            message_type: "file",
            content: "{\"file_key\":\"file_key_1\",\"file_name\":\"report.pdf\"}",
          },
        },
      });
      webhookRelay._handler?.({
        ...baseEvent,
        event: {
          ...baseEvent.event,
          message: {
            ...baseEvent.event.message,
            message_id: "om_audio",
            message_type: "audio",
            content: "{\"file_key\":\"audio_key_1\",\"file_name\":\"voice.mp3\"}",
          },
        },
      });
      webhookRelay._handler?.({
        ...baseEvent,
        event: {
          ...baseEvent.event,
          message: {
            ...baseEvent.event.message,
            message_id: "om_video",
            message_type: "video",
            content: "{\"file_key\":\"video_key_1\",\"file_name\":\"clip.mp4\"}",
          },
        },
      });
      webhookRelay._handler?.({
        ...baseEvent,
        event: {
          ...baseEvent.event,
          message: {
            ...baseEvent.event.message,
            message_id: "om_post",
            message_type: "post",
            content: JSON.stringify({
              post: {
                zh_cn: {
                  title: "Post title",
                  content: [[{ tag: "text", text: "caption" }, { tag: "img", image_key: "post_img_1" }]],
                },
              },
            }),
          },
        },
      });

      await vi.waitFor(() => expect(messages).toHaveLength(4));
      expect(messages.map((message) => message.attachments?.[0]?.kind).sort()).toEqual(["audio", "file", "image", "video"]);
      expect(messages.every((message) => message.attachments?.[0]?.status === "resolved")).toBe(true);
      const postMessage = messages.find((message) => message.text.includes("caption"));
      expect(postMessage?.images).toHaveLength(1);
    });

    it("normalizes Feishu approval card button clicks into approval commands", async () => {
      const { webhookRelay, messages } = await startWebhookMessageTest({
        useFeishu: true,
        token: "t-token-card-action",
      });

      webhookRelay._handler?.({
        header: { event_type: "card.action.trigger" },
        event: {
          context: {
            open_message_id: "om_approval_card",
            open_chat_id: "oc_approval",
          },
          operator: {
            open_id: "ou_approver",
            name: "Approver",
          },
          action: {
            tag: "button",
            value: {
              friday_action: "tool_approval",
              decision: "approve",
              short_id: "ABC123",
              chat_type: "direct",
            },
          },
        },
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(expect.objectContaining({
        channelKind: "feishu",
        senderId: "ou_approver",
        senderName: "Approver",
        chatId: "oc_approval",
        chatType: "direct",
        text: "批准 ABC123",
        replyTo: "om_approval_card",
      }));
    });

    it("ignores non-message events", async () => {
      const { webhookRelay, messages } = await startWebhookMessageTest();

      webhookRelay._handler?.({
        header: { event_type: "im.chat.member.bot.added_v1" },
        event: { chat_id: "oc_x" },
      });

      expect(messages).toHaveLength(0);
    });
  });

  describe("send", () => {
    it("sends text messages via REST API", async () => {
      const webhookRelay = createMockWebhookRelay();
      plugin = createFridayLarkChannel({ webhookRelay });
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        receiveMode: "webhook",
        verificationToken: "verify-token-1",
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

      const sendCall = fetchMock.mockFetch.mock.calls.find(
        (c) => String(c[0]).includes("/im/v1/messages"),
      );
      expect(sendCall).toBeDefined();

      const body = JSON.parse((sendCall![1] as RequestInit).body as string);
      expect(body.receive_id).toBe("oc_target");
      expect(body.msg_type).toBe("text");
      expect(JSON.parse(body.content)).toEqual({ text: "Response from bot" });
    });

    it("sends approval requests as Feishu interactive cards with text fallback", async () => {
      const webhookRelay = createMockWebhookRelay();
      plugin = createFridayLarkChannel({ webhookRelay });
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        useFeishu: true,
        receiveMode: "webhook",
        verificationToken: "verify-token-1",
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-approval-send",
            expire: 7200,
          },
        },
        {
          url: "/im/v1/messages",
          body: {
            code: 0,
            data: { message_id: "om_approval_sent" },
          },
        },
      );

      await plugin.start(() => {});

      const result = await plugin.send({
        chatId: "oc_target",
        text: "需要确认敏感操作 ABC123\n回复「批准 ABC123」继续。",
        approval: {
          shortId: "ABC123",
          toolName: "filesystem.write",
          reason: "Writes a file",
          expiresAt: "2026-04-27T12:00:00.000Z",
          paramsPreview: "path: /tmp/example.txt",
          chatType: "direct",
        },
      });

      expect(result.messageId).toBe("om_approval_sent");

      const sendCall = fetchMock.mockFetch.mock.calls.find(
        (c) => String(c[0]).includes("/im/v1/messages"),
      );
      expect(sendCall).toBeDefined();

      const body = JSON.parse((sendCall![1] as RequestInit).body as string);
      expect(body.receive_id).toBe("oc_target");
      expect(body.msg_type).toBe("interactive");
      const card = JSON.parse(body.content);
      expect(card.header.title.content).toContain("ABC123");
      expect(JSON.stringify(card)).toContain("filesystem.write");
      expect(JSON.stringify(card)).toContain("批准 ABC123");
      expect(card.elements[1].actions[0].value).toEqual(expect.objectContaining({
        friday_action: "tool_approval",
        decision: "approve",
        short_id: "ABC123",
        chat_type: "direct",
      }));
    });

    it("updates a sent Feishu message via REST API", async () => {
      const webhookRelay = createMockWebhookRelay();
      plugin = createFridayLarkChannel({ webhookRelay });
      await plugin.init({
        appId: "cli-test",
        appSecret: "secret-test",
        useFeishu: true,
        receiveMode: "webhook",
        verificationToken: "verify-token-1",
      });

      fetchMock.responses.push(
        {
          url: "tenant_access_token",
          body: {
            code: 0,
            msg: "ok",
            tenant_access_token: "t-token-update",
            expire: 7200,
          },
        },
        {
          url: "/im/v1/messages/om_progress_1",
          body: {
            code: 0,
            data: { message_id: "om_progress_1" },
          },
        },
      );

      await plugin.start(() => {});

      const result = await plugin.adapters!.outbound!.update!("om_progress_1", {
        chatId: "oc_target",
        text: "最终回复",
      });

      expect(result.messageId).toBe("om_progress_1");

      const updateCall = fetchMock.mockFetch.mock.calls.find(
        (c) => String(c[0]).includes("/im/v1/messages/om_progress_1"),
      );
      expect(updateCall).toBeDefined();
      expect((updateCall![1] as RequestInit).method).toBe("PUT");

      const body = JSON.parse((updateCall![1] as RequestInit).body as string);
      expect(body.msg_type).toBe("text");
      expect(JSON.parse(body.content)).toEqual({ text: "最终回复" });
    });
  });

  describe("lifecycle", () => {
    it("stops the webhook relay without creating SDK websocket instances", async () => {
      const webhookRelay = createMockWebhookRelay();
      plugin = createFridayLarkChannel({ webhookRelay });
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
          tenant_access_token: "t-token-stop",
          expire: 7200,
        },
      });

      await plugin.start(() => {});
      expect(webhookRelay.isListening()).toBe(true);
      expect(MockWebSocket.instances).toHaveLength(0);

      await plugin.stop();
      expect(webhookRelay.isListening()).toBe(false);
      expect(MockWebSocket.instances).toHaveLength(0);
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
