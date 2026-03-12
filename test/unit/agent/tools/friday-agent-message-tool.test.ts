import { describe, it, expect, vi } from "vitest";
import { createFridayAgentMessageTool } from "#agent";
import type { FridayChannelRegistry } from "../../../../src/channels/friday-channel-registry.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function mockChannelRegistry(
  overrides?: Partial<FridayChannelRegistry>,
): FridayChannelRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn().mockResolvedValue(undefined),
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockReturnValue({
      plugin: {},
      allowlist: {},
      running: true,
    }),
    list: vi.fn().mockReturnValue(["discord", "qq"]),
    send: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
    status: vi.fn().mockResolvedValue({ running: true }),
    ...overrides,
  } as unknown as FridayChannelRegistry;
}

describe("FridayAgentMessageTool", () => {
  // ─── Definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentMessageTool({
      channelRegistry: mockChannelRegistry(),
    });
    expect(tool.name).toBe("message");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.required).toContain("channel");
    expect(tool.parameters.required).toContain("chatId");
    expect(tool.parameters.required).toContain("text");
  });

  // ─── Happy path ───

  it("sends a message successfully", async () => {
    const reg = mockChannelRegistry();
    const tool = createFridayAgentMessageTool({ channelRegistry: reg });

    const result = await tool.execute(
      { channel: "discord", chatId: "general", text: "Hello!" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      sent: true,
      channel: "discord",
      chatId: "general",
      messageId: "msg-123",
    });
    expect(reg.send).toHaveBeenCalledWith("discord", expect.objectContaining({
      chatId: "general",
      text: "Hello!",
    }));
  });

  it("passes images and replyTo", async () => {
    const reg = mockChannelRegistry();
    const tool = createFridayAgentMessageTool({ channelRegistry: reg });

    await tool.execute(
      {
        channel: "discord",
        chatId: "chat-1",
        text: "Check this out",
        images: ["https://example.com/img.png"],
        replyTo: "msg-000",
      },
      signal(),
    );

    expect(reg.send).toHaveBeenCalledWith("discord", expect.objectContaining({
      images: ["https://example.com/img.png"],
      replyTo: "msg-000",
    }));
  });

  // ─── Channel not registered ───

  it("returns error for unregistered channel", async () => {
    const reg = mockChannelRegistry({
      get: vi.fn().mockReturnValue(undefined),
      list: vi.fn().mockReturnValue(["qq"]),
    } as unknown as Partial<FridayChannelRegistry>);
    const tool = createFridayAgentMessageTool({ channelRegistry: reg });

    const result = await tool.execute(
      { channel: "telegram", chatId: "c1", text: "Hi" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not registered");
    expect(result.content).toContain("qq");
  });

  // ─── Channel not running ───

  it("returns error when channel not running", async () => {
    const reg = mockChannelRegistry({
      get: vi.fn().mockReturnValue({
        plugin: {},
        allowlist: {},
        running: false,
      }),
    } as unknown as Partial<FridayChannelRegistry>);
    const tool = createFridayAgentMessageTool({ channelRegistry: reg });

    const result = await tool.execute(
      { channel: "discord", chatId: "c1", text: "Hi" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not running");
  });

  // ─── Parameter validation ───

  it("returns error on missing channel", async () => {
    const tool = createFridayAgentMessageTool({ channelRegistry: mockChannelRegistry() });
    const result = await tool.execute({ chatId: "c1", text: "Hi" }, signal());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("channel is required");
  });

  it("returns error on missing chatId", async () => {
    const tool = createFridayAgentMessageTool({ channelRegistry: mockChannelRegistry() });
    const result = await tool.execute({ channel: "discord", text: "Hi" }, signal());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("chatId is required");
  });

  it("returns error on missing text", async () => {
    const tool = createFridayAgentMessageTool({ channelRegistry: mockChannelRegistry() });
    const result = await tool.execute({ channel: "discord", chatId: "c1" }, signal());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("text is required");
  });

  // ─── Error handling ───

  it("returns error when send throws", async () => {
    const reg = mockChannelRegistry({
      send: vi.fn().mockRejectedValue(new Error("Rate limited")),
    } as unknown as Partial<FridayChannelRegistry>);
    const tool = createFridayAgentMessageTool({ channelRegistry: reg });

    const result = await tool.execute(
      { channel: "discord", chatId: "c1", text: "Hi" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Rate limited");
  });
});
