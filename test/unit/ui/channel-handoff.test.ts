import { afterEach, describe, expect, it, vi } from "vitest";

import type { FridaySessionMessageRecord, FridaySessionRecord } from "../../../ui/src/lib/api/types";
import {
  buildChannelChatHandoffPayload,
  buildChannelChatHandoffTaskPrompt,
  clearPendingChannelChatHandoff,
  readPendingChannelChatHandoff,
  writePendingChannelChatHandoff,
} from "../../../ui/src/lib/chat/channel-handoff";

function makeSession(overrides: Partial<FridaySessionRecord> = {}): FridaySessionRecord {
  return {
    id: "session-1",
    key: "channel:discord:123",
    channel: "discord",
    accountId: "default",
    chatId: "123",
    userId: "admin-001",
    chatKind: "dm",
    status: "active",
    metadata: {
      conversationFocus: {
        currentTopicSummary: "需要继续处理 Discord 里的经营交接",
      },
    },
    contextInputTokens: 0,
    contextOutputTokens: 0,
    contextTotalTokens: 0,
    messageCount: 4,
    createdAt: "2026-04-22T23:00:00.000Z",
    updatedAt: "2026-04-22T23:10:00.000Z",
    lastActivityAt: "2026-04-22T23:10:00.000Z",
    ...overrides,
  };
}

function makeMessage(sequence: number, role: FridaySessionMessageRecord["role"], contentText: string): FridaySessionMessageRecord {
  return {
    id: `message-${sequence}`,
    sessionId: "session-1",
    sessionKey: "channel:discord:123",
    sequence,
    role,
    content: contentText,
    contentText,
    tokenCount: 0,
    metadata: {},
    memoryExtractStatus: "pending",
    occurredAt: `2026-04-22T23:1${sequence}:00.000Z`,
    createdAt: `2026-04-22T23:1${sequence}:00.000Z`,
    updatedAt: `2026-04-22T23:1${sequence}:00.000Z`,
  };
}

function installSessionStorageMock() {
  const store = new Map<string, string>();
  const mock = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
  vi.stubGlobal("sessionStorage", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("channel chat handoff helper", () => {
  it("builds a payload with topic summary and recent excerpts", () => {
    const payload = buildChannelChatHandoffPayload({
      session: makeSession(),
      displayName: "admin-001",
      messages: [
        makeMessage(1, "user", "先告诉我这条 Discord 会话里最重要的经营问题"),
        makeMessage(2, "assistant", "目前最重要的问题是客服和图片质量交接没有闭环。"),
        makeMessage(3, "user", "那把下一步动作列出来"),
        makeMessage(4, "assistant", "可以，先做客服归因，再做图片和详情页修订。"),
      ],
      nowIso: () => "2026-04-22T23:20:00.000Z",
    });

    expect(payload.sourceSessionKey).toBe("channel:discord:123");
    expect(payload.sourceDisplayName).toBe("admin-001");
    expect(payload.topicSummary).toContain("经营交接");
    expect(payload.latestUserMessage).toContain("下一步动作");
    expect(payload.latestAssistantMessage).toContain("客服归因");
    expect(payload.excerpts).toHaveLength(4);
  });

  it("builds a task prompt that keeps isolation explicit", () => {
    const payload = buildChannelChatHandoffPayload({
      session: makeSession(),
      displayName: "admin-001",
      messages: [
        makeMessage(1, "user", "请继续这个 Discord 对话"),
        makeMessage(2, "assistant", "好的，我会先整理经营交接摘要。"),
      ],
      nowIso: () => "2026-04-22T23:20:00.000Z",
    });

    const taskPrompt = buildChannelChatHandoffTaskPrompt(payload, "把它整理成主聊天里的行动计划", "zh");

    expect(taskPrompt).toContain("这不是自动合并历史");
    expect(taskPrompt).toContain("来源渠道: discord");
    expect(taskPrompt).not.toContain("Recent anchors");
    expect(taskPrompt).toContain("最近锚点:");
    expect(taskPrompt).toContain("用户在主聊天里的当前请求");
    expect(taskPrompt).toContain("行动计划");
  });

  it("round-trips pending handoff payloads through sessionStorage", () => {
    installSessionStorageMock();

    const payload = buildChannelChatHandoffPayload({
      session: makeSession(),
      displayName: "admin-001",
      messages: [makeMessage(1, "user", "hello"), makeMessage(2, "assistant", "world")],
      nowIso: () => "2026-04-22T23:20:00.000Z",
    });

    const handoffId = writePendingChannelChatHandoff(payload);
    expect(readPendingChannelChatHandoff(handoffId)?.sourceSessionKey).toBe("channel:discord:123");
    clearPendingChannelChatHandoff(handoffId);
    expect(readPendingChannelChatHandoff(handoffId)).toBeNull();
  });
});
