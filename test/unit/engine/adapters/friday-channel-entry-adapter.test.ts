import { describe, expect, it, vi } from "vitest";

import { createFridayChannelEntryAdapter } from "../../../../src/engine/adapters/friday-channel-entry-adapter.js";

describe("FridayChannelEntryAdapter", () => {
  it("derives tenantContext from inbound channel messages", async () => {
    const executeRun = vi.fn().mockResolvedValue({
      runId: "run-1",
      status: "completed",
      toolCallCount: 0,
      durationMs: 10,
    });

    const adapter = createFridayChannelEntryAdapter({
      engine: {
        executeRun,
      },
      idGenerator: () => "run-1",
      resolveSessionKey: (message) => `${message.channelKind}:default:${message.chatId}`,
    });

    await adapter.handleMessage({
      id: "msg-1",
      channelKind: "discord",
      senderId: "user-42",
      chatId: "chat-7",
      chatType: "direct",
      text: "hello",
    });

    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      principalId: "user-42",
      taskAlreadyInHistory: true,
      executionContext: {
        surface: "channel",
        interactive: true,
      },
      tenantContext: {
        hubId: "default",
        userId: "user-42",
        channelKind: "discord",
      },
    }));
  });
});
