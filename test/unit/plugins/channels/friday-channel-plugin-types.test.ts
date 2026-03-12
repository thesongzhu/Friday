import { describe, it, expect, vi } from "vitest";
import type {
  FridayChannelPlugin,
  FridayChannelRuntimeContext,
  FridayChannelSendMessageInput,
  FridayInboundChannelMessage,
  FridayChannelDeliveryEvent,
} from "#plugins";

describe("FridayChannelPlugin types", () => {
  function createMockChannel(): FridayChannelPlugin {
    return {
      channelId: "test-channel",
      capabilities: {
        chatKinds: ["dm", "group"],
        supportsTyping: true,
        supportsThreads: false,
      },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({
        messageId: "msg-1",
        deliveredAt: "2026-01-01T00:00:00.000Z",
      })),
    };
  }

  function createMockContext(): FridayChannelRuntimeContext {
    return {
      onInboundMessage: vi.fn(async () => {}),
      onDeliveryEvent: vi.fn(async () => {}),
    };
  }

  it("implements channel plugin with required properties", () => {
    const channel = createMockChannel();
    expect(channel.channelId).toBe("test-channel");
    expect(channel.capabilities.chatKinds).toContain("dm");
    expect(channel.capabilities.supportsTyping).toBe(true);
  });

  it("can start and stop", async () => {
    const channel = createMockChannel();
    const ctx = createMockContext();

    await channel.start(ctx);
    expect(channel.start).toHaveBeenCalledWith(ctx);

    await channel.stop(ctx);
    expect(channel.stop).toHaveBeenCalledWith(ctx);
  });

  it("can send messages", async () => {
    const channel = createMockChannel();
    const input: FridayChannelSendMessageInput = {
      conversationId: "conv-1",
      content: "Hello, world!",
    };

    const result = await channel.sendMessage(input);
    expect(result.messageId).toBe("msg-1");
    expect(result.deliveredAt).toBeDefined();
  });

  it("runtime context receives inbound messages", async () => {
    const ctx = createMockContext();
    const message: FridayInboundChannelMessage = {
      messageId: "in-1",
      channelId: "discord",
      conversationId: "conv-1",
      senderId: "user-1",
      senderName: "Alice",
      content: "Hi there!",
      chatKind: "dm",
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    await ctx.onInboundMessage(message);
    expect(ctx.onInboundMessage).toHaveBeenCalledWith(message);
  });

  it("runtime context receives delivery events", async () => {
    const ctx = createMockContext();
    const event: FridayChannelDeliveryEvent = {
      messageId: "msg-1",
      channelId: "discord",
      conversationId: "conv-1",
      kind: "delivered",
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    await ctx.onDeliveryEvent!(event);
    expect(ctx.onDeliveryEvent).toHaveBeenCalledWith(event);
  });

  it("channel capabilities support all chat kinds", () => {
    const channel: FridayChannelPlugin = {
      channelId: "full-featured",
      capabilities: {
        chatKinds: ["dm", "group", "channel", "thread"],
        supportsTyping: true,
        supportsThreads: true,
        supportsReactions: true,
        supportsEdits: true,
        supportsDeletes: true,
        maxMessageLength: 4096,
      },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({
        messageId: "msg-2",
        deliveredAt: "2026-01-01T00:00:00.000Z",
      })),
    };

    expect(channel.capabilities.chatKinds).toHaveLength(4);
    expect(channel.capabilities.maxMessageLength).toBe(4096);
    expect(channel.capabilities.supportsReactions).toBe(true);
  });

  it("inbound message supports attachments", () => {
    const message: FridayInboundChannelMessage = {
      messageId: "in-2",
      channelId: "telegram",
      conversationId: "conv-2",
      senderId: "user-2",
      content: "Check this out",
      chatKind: "group",
      timestamp: "2026-01-01T00:00:00.000Z",
      attachments: [
        {
          id: "att-1",
          filename: "image.png",
          contentType: "image/png",
          url: "https://cdn.example.com/image.png",
          size: 1024,
        },
      ],
      metadata: { telegramChatType: "supergroup" },
    };

    expect(message.attachments).toHaveLength(1);
    expect(message.attachments![0].contentType).toBe("image/png");
    expect(message.metadata?.telegramChatType).toBe("supergroup");
  });
});
