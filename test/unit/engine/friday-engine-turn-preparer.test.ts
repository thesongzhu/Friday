import { describe, expect, it, vi } from "vitest";

import { createFridayEngineTurnPreparer } from "../../../src/engine/friday-engine-turn-preparer.js";
import { buildFridayEvidenceBlocks } from "../../../src/agent/runtime/friday-agent-evidence-blocks.js";
import { FRIDAY_SUPPORTED_CHANNEL_KINDS } from "../../../src/channels/friday-channel-config.js";
import { classifyFridayExecution } from "../../../src/sessions/services/friday-execution-classifier.js";
import { prepareFridayConversationTurn } from "../../../src/sessions/services/friday-session-conversation-orchestrator.js";
import type {
  FridayPreparedConversationTurn,
  FridayPrepareConversationTurnInput,
} from "../../../src/engine/friday-engine-turn-preparer.js";
import type {
  FridayConversationBlock,
  FridaySessionConversationFocusState,
  FridaySessionMessageRecord,
} from "../../../src/sessions/model/friday-session.types.js";

function createMessage(
  input: Partial<FridaySessionMessageRecord> & Pick<FridaySessionMessageRecord, "id" | "sequence" | "role" | "contentText">,
): FridaySessionMessageRecord {
  return {
    content: input.contentText,
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    occurredAt: "2026-04-16T00:00:00.000Z",
    metadata: {},
    sessionId: "session-1",
    sessionKey: "channel:discord:123",
    tokenCount: 0,
    memoryExtractStatus: "pending",
    idempotencyKey: undefined,
    ...input,
  };
}

describe("createFridayEngineTurnPreparer", () => {
  it.each([...FRIDAY_SUPPORTED_CHANNEL_KINDS])(
    "keeps short option replies anchored through the shared turn preparer for %s",
    async (channelKind) => {
      const sessionKey = `channel:${channelKind}:chat-123`;
      const messages: FridaySessionMessageRecord[] = [
        createMessage({
          id: `${channelKind}-m-1`,
          sequence: 1,
          role: "user",
          contentText: "要我直接写这个 skill 吗？",
          sessionKey,
        }),
        createMessage({
          id: `${channelKind}-m-2`,
          sequence: 2,
          role: "assistant",
          contentText: "方案 A：用 skill_generate 工具走完整生成流程。方案 B：直接写 skill 文件。你偏好哪个？方便我立即继续。",
          sessionKey,
        }),
        createMessage({
          id: `${channelKind}-m-3`,
          sequence: 3,
          role: "user",
          contentText: "A",
          sessionKey,
        }),
      ];
      const focusState: FridaySessionConversationFocusState = {
        currentTopicSummary: "Create a reusable session summarizer skill for Friday.",
        currentTopicStartSequence: 1,
        lastAssistantAskedQuestion: false,
        updatedAt: "2026-04-16T00:00:00.000Z",
      };
      const setConversationFocus = vi.fn();

      const preparer = createFridayEngineTurnPreparer({
        sessionDeps: {
          async getMessages(key) {
            expect(key).toBe(sessionKey);
            return messages;
          },
          async addMessage() {
            throw new Error("channel messages are already mirrored before engine preparation");
          },
          async getConversationFocus(key) {
            expect(key).toBe(sessionKey);
            return focusState;
          },
          setConversationFocus,
        },
        historyLimit: 24,
        nowIso: () => "2026-04-16T00:00:05.000Z",
        prepareTurn: prepareFridayConversationTurn,
        buildEvidenceBlocks: buildFridayEvidenceBlocks,
        classifyExecution: classifyFridayExecution,
      });

      const prepared = await preparer.prepare({
        task: "A",
        runId: `run-${channelKind}`,
        sessionKey,
        persistTaskMessage: false,
        taskAlreadyInHistory: true,
        idempotencyPrefix: `channel-${channelKind}`,
      });

      expect(prepared.conversationContext?.turnKind).toBe("clarification");
      expect(prepared.conversationContext?.turnFrame?.intent).toBe("clarification_reply");
      expect(prepared.executionClassification).toEqual({ category: "agent_exception_path" });
      expect(prepared.taskPrompt).toContain("replying to your clarification request");
      expect(prepared.taskPrompt).toContain("方案 A");
      expect(prepared.taskPrompt).not.toContain("A previous topic exists");
      expect(prepared.historyMessages?.some((message) =>
        message.role === "assistant"
        && typeof message.content === "string"
        && message.content.includes("你偏好哪个"))).toBe(true);
      expect(setConversationFocus).not.toHaveBeenCalled();
    },
  );

  it.each([...FRIDAY_SUPPORTED_CHANNEL_KINDS])(
    "classifies cancelled-request follow-ups as deterministic status checks for %s",
    async (channelKind) => {
      const sessionKey = `channel:${channelKind}:chat-456`;
      const messages: FridaySessionMessageRecord[] = [
        createMessage({
          id: `${channelKind}-cancel-m-1`,
          sequence: 1,
          role: "user",
          contentText: "帮我做 Friday 的社交媒体推广方案",
          sessionKey,
        }),
        createMessage({
          id: `${channelKind}-cancel-m-2`,
          sequence: 2,
          role: "assistant",
          contentText: "Still working on your request after 30s. Phase: executing",
          sessionKey,
        }),
        createMessage({
          id: `${channelKind}-cancel-m-3`,
          sequence: 3,
          role: "user",
          contentText: "为什么 Request was cancelled before completion?",
          sessionKey,
        }),
      ];
      const focusState: FridaySessionConversationFocusState = {
        currentTopicSummary: "Generate a social media promotion plan for Friday.",
        currentTopicStartSequence: 1,
        lastRunId: `run-${channelKind}-cancelled`,
        updatedAt: "2026-04-16T00:00:00.000Z",
      };
      const setConversationFocus = vi.fn();

      const preparer = createFridayEngineTurnPreparer({
        sessionDeps: {
          async getMessages(key) {
            expect(key).toBe(sessionKey);
            return messages;
          },
          async addMessage() {
            throw new Error("channel messages are already mirrored before engine preparation");
          },
          async getConversationFocus(key) {
            expect(key).toBe(sessionKey);
            return focusState;
          },
          setConversationFocus,
        },
        historyLimit: 24,
        nowIso: () => "2026-04-16T00:00:05.000Z",
        prepareTurn: prepareFridayConversationTurn,
        buildEvidenceBlocks: buildFridayEvidenceBlocks,
        classifyExecution: classifyFridayExecution,
        taskStatusSnapshotGetter: async () => ({
          readOnly: false,
          trackedRunId: `run-${channelKind}-cancelled`,
          runStatus: "cancelled",
          activeSubagents: [],
          blockers: [],
          terminalOutcome: {
            status: "cancelled",
            summary: "Cancelled via API",
            responseText: "Cancelled via API",
          },
        }),
      });

      const prepared = await preparer.prepare({
        task: "为什么 Request was cancelled before completion?",
        runId: `status-${channelKind}`,
        sessionKey,
        persistTaskMessage: false,
        taskAlreadyInHistory: true,
        idempotencyPrefix: `channel-${channelKind}`,
      });

      expect(prepared.conversationContext?.turnKind).toBe("status_check");
      expect(prepared.conversationContext?.turnFrame?.intent).toBe("status_check");
      expect(prepared.executionClassification).toEqual({
        category: "sync_immediate",
        handler: "task_status",
      });
      expect(prepared.evidenceBlocks.some((block) =>
        block.source === "task_status_block"
        && block.summary.includes("Cancelled via API"))).toBe(true);
      expect(prepared.taskPrompt).toContain("asking for a status update");
      expect(prepared.taskPrompt).toContain("Use the task_status tool before answering.");
      expect(prepared.taskPrompt).not.toContain("A previous topic exists");
      expect(setConversationFocus).not.toHaveBeenCalled();
    },
  );

  it("keeps runtime config questions out of stale task history through the engine preparer", async () => {
    const sessionKey = "channel:lark:chat-config";
    const messages: FridaySessionMessageRecord[] = [
      createMessage({
        id: "cfg-m-1",
        sequence: 1,
        role: "user",
        contentText: "把 SampleBoard 做成一个 Friday skill",
        sessionKey,
      }),
      createMessage({
        id: "cfg-m-2",
        sequence: 2,
        role: "assistant",
        contentText: "我查看了 SampleBoard，并准备生成 skill。",
        sessionKey,
      }),
      createMessage({
        id: "cfg-m-3",
        sequence: 3,
        role: "user",
        contentText: "去示例目录网站上找5550100199这个号码相关信息",
        sessionKey,
      }),
      createMessage({
        id: "cfg-m-4",
        sequence: 4,
        role: "assistant",
        contentText: "Agent run timed out",
        sessionKey,
      }),
      createMessage({
        id: "cfg-m-5",
        sequence: 5,
        role: "user",
        contentText: "刚刚找到了什么？",
        sessionKey,
      }),
      createMessage({
        id: "cfg-m-6",
        sequence: 6,
        role: "assistant",
        contentText: "我找到了以下关于 555-010-0199 的信息",
        sessionKey,
      }),
    ];
    const focusState: FridaySessionConversationFocusState = {
      currentTopicSummary: "刚刚找到了什么？",
      currentTopicStartSequence: 5,
      assistantAnchorSummary: "我找到了以下关于 555-010-0199 的信息",
      lastAssistantAskedQuestion: true,
      lastRunId: "run-phone",
      updatedAt: "2026-04-16T00:00:00.000Z",
    };

    const preparer = createFridayEngineTurnPreparer({
      sessionDeps: {
        async getMessages(key) {
          expect(key).toBe(sessionKey);
          return messages;
        },
        async addMessage(_key, message) {
          return createMessage({
            id: "cfg-m-7",
            sequence: 7,
            role: message.role,
            contentText: message.contentText,
            sessionKey,
            idempotencyKey: message.idempotencyKey,
            metadata: message.metadata ?? {},
          });
        },
        async getConversationFocus(key) {
          expect(key).toBe(sessionKey);
          return focusState;
        },
        async setConversationFocus() {
          return undefined;
        },
      },
      historyLimit: 24,
      nowIso: () => "2026-04-16T00:00:05.000Z",
      prepareTurn: prepareFridayConversationTurn,
      buildEvidenceBlocks: buildFridayEvidenceBlocks,
      classifyExecution: classifyFridayExecution,
    });

    const prepared = await preparer.prepare({
      task: "agent run的设定的是多少",
      runId: "run-config",
      sessionKey,
    });

    expect(prepared.conversationContext?.turnKind).toBe("new_topic");
    expect(prepared.conversationContext?.turnFrame?.intent).toBe("config_question");
    expect(prepared.conversationContext?.selectedBlocks).toEqual([]);
    expect(prepared.historyMessages).toEqual([]);
    expect(prepared.taskPrompt).toContain("configuration value");
    expect(prepared.taskPrompt).not.toContain("626");
    expect(prepared.taskPrompt).not.toContain("SampleBoard");
  });

  it("persists compaction evidence when the selected context is a compacted topic block", async () => {
    const messages: FridaySessionMessageRecord[] = [
      createMessage({ id: "m-1", sequence: 1, role: "assistant", contentText: "Earlier debugging thread." }),
    ];
    const focusState: FridaySessionConversationFocusState = {
      currentTopicSummary: "GitHub browser session debugging",
      updatedAt: "2026-04-16T00:00:00.000Z",
    };
    const persistCompactionEvidence = vi.fn();

    const preparer = createFridayEngineTurnPreparer({
      sessionDeps: {
        async getMessages() {
          return messages;
        },
        async addMessage(_key, message) {
          const record = createMessage({
            id: "m-user",
            sequence: 2,
            role: message.role,
            contentText: message.contentText,
            idempotencyKey: message.idempotencyKey,
            metadata: message.metadata ?? {},
          });
          messages.push(record);
          return record;
        },
        async getConversationFocus() {
          return focusState;
        },
        async setConversationFocus() {
          return undefined;
        },
      },
      historyLimit: 24,
      nowIso: () => "2026-04-16T00:00:05.000Z",
      prepareTurn(_input: FridayPrepareConversationTurnInput): FridayPreparedConversationTurn {
        const selectedBlocks: FridayConversationBlock[] = [
          {
            id: "topic-window:1",
            source: "focus_topic",
            summary: "Earlier GitHub browser debugging context stayed relevant.",
            score: 91,
            reason: "Current turn is still inside the persisted topic window; the long topic window is now represented as a compacted summary block.",
          },
          {
            id: "history:2",
            source: "tool_failure_block",
            summary: "tool_failure_block: Browser launch failed | toolFailures=Browser session unavailable | fileOperations=src/hub/friday-hub-bootstrap.ts",
            score: 72,
            reason: "Compacted tool failure kept as a recency-weighted history block.",
            messageIds: ["m-1"],
          },
        ];
        return {
          turnKind: "follow_up",
          historyMessages: [],
          taskPrompt: "Current question: continue debugging",
          previousTopicSummary: "GitHub browser session debugging",
          currentTopicSummary: "GitHub browser session debugging",
          selectedBlocks,
          selectionReasons: selectedBlocks.map((block) => block.reason),
        };
      },
      buildEvidenceBlocks: () => [],
      classifyExecution: () => ({ category: "agent_exception_path" }),
      persistCompactionEvidence,
    });

    await preparer.prepare({
      task: "continue debugging",
      runId: "run-1",
      sessionKey: "channel:discord:123",
    });

    expect(persistCompactionEvidence).toHaveBeenCalledTimes(1);
    expect(persistCompactionEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "channel:discord:123",
        runId: "run-1",
        turnKind: "follow_up",
        summary: expect.objectContaining({
          summaryText: expect.stringContaining("[topic_block] Earlier GitHub browser debugging context stayed relevant."),
          toolFailures: ["Browser session unavailable"],
          fileOperations: ["src/hub/friday-hub-bootstrap.ts"],
        }),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            id: "topic-window:1",
            kind: "topic_block",
          }),
          expect.objectContaining({
            id: "history:2",
            kind: "tool_failure_block",
          }),
        ]),
      }),
    );
  });

  it("does not persist compaction evidence for a pure reply-anchor selection", async () => {
    const persistCompactionEvidence = vi.fn();

    const preparer = createFridayEngineTurnPreparer({
      sessionDeps: {
        async getMessages() {
          return [];
        },
        async addMessage(_key, message) {
          return createMessage({
            id: "m-user",
            sequence: 1,
            role: message.role,
            contentText: message.contentText,
            idempotencyKey: message.idempotencyKey,
            metadata: message.metadata ?? {},
          });
        },
        async getConversationFocus() {
          return null;
        },
        async setConversationFocus() {
          return undefined;
        },
      },
      historyLimit: 24,
      nowIso: () => "2026-04-16T00:00:05.000Z",
      prepareTurn(): FridayPreparedConversationTurn {
        return {
          turnKind: "follow_up",
          historyMessages: [],
          taskPrompt: "Use the reply anchor only",
          currentTopicSummary: "anchor",
          selectedBlocks: [
            {
              id: "reply-1",
              source: "reply_anchor",
              summary: "Referenced assistant fact: browser not connected.",
              score: 99,
              reason: "This turn explicitly replied to an older assistant message.",
            },
          ],
          selectionReasons: ["reply anchor only"],
          replyAnchorMessageId: "discord-msg-1",
          replyAnchorSequence: 2,
        };
      },
      buildEvidenceBlocks: () => [],
      classifyExecution: () => ({ category: "agent_exception_path" }),
      persistCompactionEvidence,
    });

    await preparer.prepare({
      task: "that one",
      runId: "run-2",
      sessionKey: "channel:discord:123",
    });

    expect(persistCompactionEvidence).not.toHaveBeenCalled();
  });
});
