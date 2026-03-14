import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFridayChannelInboundDebouncer } from "#channels";
import type { FridayChannelMessage } from "#channels";

function makeMsg(overrides: Partial<FridayChannelMessage> = {}): FridayChannelMessage {
  return {
    id: "msg-1",
    channelKind: "discord",
    senderId: "user-1",
    senderName: "TestUser",
    chatId: "chat-1",
    chatType: "group",
    text: "Hello",
    timestamp: Date.now(),
    raw: {},
    ...overrides,
  };
}

describe("FridayChannelInboundDebouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through immediately when windowMs is 0", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 0,
    });

    const msg = makeMsg();
    debouncer.submit(msg);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  it("buffers messages and delivers after window expires", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
    });

    debouncer.submit(makeMsg({ id: "m1", text: "Hello" }));
    debouncer.submit(makeMsg({ id: "m2", text: "World" }));

    expect(handler).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(500);

    expect(handler).toHaveBeenCalledTimes(1);
    const combined = handler.mock.calls[0][0] as FridayChannelMessage;
    expect(combined.text).toBe("Hello\nWorld");
  });

  it("resets timer on each new message", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
    });

    debouncer.submit(makeMsg({ id: "m1", text: "A" }));
    vi.advanceTimersByTime(300);
    debouncer.submit(makeMsg({ id: "m2", text: "B" }));
    vi.advanceTimersByTime(300);
    // 600ms total, but only 300ms since last message
    expect(handler).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const combined = handler.mock.calls[0][0] as FridayChannelMessage;
    expect(combined.text).toBe("A\nB");
  });

  it("uses separate buffers for different senders", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
    });

    debouncer.submit(makeMsg({ id: "m1", senderId: "alice", text: "Hi from Alice" }));
    debouncer.submit(makeMsg({ id: "m2", senderId: "bob", text: "Hi from Bob" }));

    vi.advanceTimersByTime(500);

    expect(handler).toHaveBeenCalledTimes(2);
    const texts = handler.mock.calls.map((c: unknown[]) => (c[0] as FridayChannelMessage).text);
    expect(texts).toContain("Hi from Alice");
    expect(texts).toContain("Hi from Bob");
  });

  it("uses separate buffers for different chatIds", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
    });

    debouncer.submit(makeMsg({ id: "m1", chatId: "ch-1", text: "In channel 1" }));
    debouncer.submit(makeMsg({ id: "m2", chatId: "ch-2", text: "In channel 2" }));

    vi.advanceTimersByTime(500);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("bypasses debounce for messages with images", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
    });

    debouncer.submit(makeMsg({ id: "m1", text: "Before image" }));
    expect(handler).toHaveBeenCalledTimes(0);

    // Image message should flush pending + forward immediately
    debouncer.submit(makeMsg({ id: "m2", text: "With image", images: ["https://example.com/pic.png"] }));
    expect(handler).toHaveBeenCalledTimes(2);
    expect((handler.mock.calls[0][0] as FridayChannelMessage).text).toBe("Before image");
    expect((handler.mock.calls[1][0] as FridayChannelMessage).text).toBe("With image");
  });

  it("bypasses debounce for command messages", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
    });

    debouncer.submit(makeMsg({ id: "m1", text: "Buffered text" }));
    debouncer.submit(makeMsg({ id: "m2", text: "/help" }));

    // /help should flush pending + forward immediately
    expect(handler).toHaveBeenCalledTimes(2);
    expect((handler.mock.calls[0][0] as FridayChannelMessage).text).toBe("Buffered text");
    expect((handler.mock.calls[1][0] as FridayChannelMessage).text).toBe("/help");
  });

  it("respects bypassForAttachments = false", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
      bypassForAttachments: false,
    });

    debouncer.submit(makeMsg({ id: "m1", text: "With image", images: ["https://example.com/pic.png"] }));
    expect(handler).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(500);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("respects bypassForCommands = false", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
      bypassForCommands: false,
    });

    debouncer.submit(makeMsg({ id: "m1", text: "/help" }));
    expect(handler).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(500);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("flush delivers all pending messages immediately", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
    });

    debouncer.submit(makeMsg({ id: "m1", senderId: "a", text: "A msg" }));
    debouncer.submit(makeMsg({ id: "m2", senderId: "b", text: "B msg" }));

    expect(handler).toHaveBeenCalledTimes(0);

    debouncer.flush();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("destroy cancels all pending timers", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
    });

    debouncer.submit(makeMsg({ text: "Will be dropped" }));
    debouncer.destroy();

    vi.advanceTimersByTime(1000);
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it("merges images from multiple messages", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
      bypassForAttachments: false,
    });

    debouncer.submit(makeMsg({ id: "m1", text: "First", images: ["img1.png"] }));
    debouncer.submit(makeMsg({ id: "m2", text: "Second", images: ["img2.png"] }));

    vi.advanceTimersByTime(500);

    const combined = handler.mock.calls[0][0] as FridayChannelMessage;
    expect(combined.text).toBe("First\nSecond");
    expect(combined.images).toEqual(["img1.png", "img2.png"]);
  });

  it("preserves the most recent non-empty timezone across buffered messages", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
    });

    debouncer.submit(makeMsg({ id: "m1", text: "First", timezone: "America/Los_Angeles" }));
    debouncer.submit(makeMsg({ id: "m2", text: "Second" }));

    vi.advanceTimersByTime(500);

    const combined = handler.mock.calls[0][0] as FridayChannelMessage;
    expect(combined.text).toBe("First\nSecond");
    expect(combined.timezone).toBe("America/Los_Angeles");
  });

  it("returns single message unchanged when only one in buffer", () => {
    const handler = vi.fn();
    const debouncer = createFridayChannelInboundDebouncer({
      handler,
      windowMs: 500,
    });

    const msg = makeMsg({ id: "m1", text: "Solo" });
    debouncer.submit(msg);

    vi.advanceTimersByTime(500);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(msg); // same reference
  });
});
