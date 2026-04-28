import { describe, expect, it, vi } from "vitest";

import {
  createFridayChannelEntryAdapter,
  FRIDAY_CHANNEL_AGENT_SCOPE,
  FRIDAY_CHANNEL_CONTROL_ROUTE,
} from "../../../../src/engine/adapters/friday-channel-entry-adapter.js";
import { FRIDAY_SUPPORTED_CHANNEL_KINDS } from "../../../../src/channels/friday-channel-config.js";

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
      resolveDisabledToolNames: () => [],
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
      scopes: [FRIDAY_CHANNEL_AGENT_SCOPE],
      disabledToolNames: [],
      taskAlreadyInHistory: true,
      executionContext: expect.objectContaining({
        surface: "channel",
        interactive: true,
        channelKind: "discord",
        channelControlRoute: FRIDAY_CHANNEL_CONTROL_ROUTE,
      }),
      tenantContext: {
        hubId: "default",
        userId: "user-42",
        channelKind: "discord",
      },
    }));
  });

  it.each([...FRIDAY_SUPPORTED_CHANNEL_KINDS])(
    "routes %s messages through the unified channel engine contract",
    async (channelKind) => {
      const executeRun = vi.fn().mockResolvedValue({
        runId: `run-${channelKind}`,
        status: "completed",
        toolCallCount: 0,
        durationMs: 10,
      });

      const adapter = createFridayChannelEntryAdapter({
        engine: {
          executeRun,
        },
        idGenerator: () => `run-${channelKind}`,
        resolveDisabledToolNames: () => [],
        resolveSessionKey: (message) => `channel:${message.channelKind}:${message.chatId}`,
      });

      await adapter.handleMessage({
        id: `msg-${channelKind}`,
        channelKind,
        senderId: "user-42",
        chatId: "chat-7",
        chatType: "direct",
        text: "A",
        replyToMessageId: `assistant-${channelKind}`,
      });

      expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
        task: "A",
        runId: `run-${channelKind}`,
        sessionKey: `channel:${channelKind}:chat-7`,
        replyToMessageId: `assistant-${channelKind}`,
        taskAlreadyInHistory: true,
        idempotencyPrefix: `channel-${channelKind}`,
        executionContext: expect.objectContaining({
          surface: "channel",
          channelKind,
          channelControlRoute: FRIDAY_CHANNEL_CONTROL_ROUTE,
        }),
        tenantContext: {
          hubId: "default",
          userId: "user-42",
          channelKind,
        },
      }));
    },
  );

  it("keeps chat channels on the full agent route without hub-admin scope", async () => {
    const executeRun = vi.fn().mockResolvedValue({
      runId: "run-2",
      status: "completed",
      toolCallCount: 0,
      durationMs: 10,
    });

    const adapter = createFridayChannelEntryAdapter({
      engine: {
        executeRun,
      },
      idGenerator: () => "run-2",
      resolveDisabledToolNames: (channelKind) => channelKind === "telegram" ? ["dangerous-local-test-tool"] : [],
      resolveSessionKey: (message) => `${message.channelKind}:default:${message.chatId}`,
    });

    await adapter.handleMessage({
      id: "msg-2",
      channelKind: "telegram",
      senderId: "user-99",
      chatId: "chat-9",
      chatType: "direct",
      text: "帮我查资料并整理成 PDF",
    });

    const input = executeRun.mock.calls[0]?.[0];
    expect(input?.executionContext).toEqual(expect.objectContaining({
      surface: "channel",
      channelControlRoute: FRIDAY_CHANNEL_CONTROL_ROUTE,
    }));
    expect(input?.scopes).toEqual([FRIDAY_CHANNEL_AGENT_SCOPE]);
    expect(input?.scopes).not.toContain("hub.admin");
    expect(input?.disabledToolNames).toEqual(["dangerous-local-test-tool"]);
  });

  it("allows image-only channel messages to reach the agent", async () => {
    const executeRun = vi.fn().mockResolvedValue({
      runId: "run-3",
      status: "completed",
      toolCallCount: 0,
      durationMs: 10,
    });

    const adapter = createFridayChannelEntryAdapter({
      engine: {
        executeRun,
      },
      idGenerator: () => "run-3",
      resolveSessionKey: (message) => `${message.channelKind}:default:${message.chatId}`,
    });

    await adapter.handleMessage({
      id: "msg-image",
      channelKind: "feishu",
      senderId: "user-image",
      chatId: "chat-image",
      chatType: "direct",
      text: "",
      images: ["data:image/png;base64,iVBORw=="],
    });

    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      task: "Analyze the attached image.",
      images: ["data:image/png;base64,iVBORw=="],
    }));
  });

  it("passes normalized attachments through the channel task prompt", async () => {
    const executeRun = vi.fn().mockResolvedValue({
      runId: "run-4",
      status: "completed",
      toolCallCount: 0,
      durationMs: 10,
    });

    const adapter = createFridayChannelEntryAdapter({
      engine: {
        executeRun,
      },
      idGenerator: () => "run-4",
      resolveSessionKey: (message) => `${message.channelKind}:default:${message.chatId}`,
    });

    await adapter.handleMessage({
      id: "msg-file",
      channelKind: "feishu",
      senderId: "user-file",
      chatId: "chat-file",
      chatType: "direct",
      text: "",
      attachments: [
        {
          id: "att-1",
          kind: "file",
          filename: "report.pdf",
          contentType: "application/pdf",
          sizeBytes: 3,
          localPath: "/tmp/friday-channel-attachments/report.pdf",
          status: "resolved",
        },
      ],
    });

    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      task: "Analyze the attached media.",
      taskPrompt: expect.stringContaining("/tmp/friday-channel-attachments/report.pdf"),
    }));
  });
});
