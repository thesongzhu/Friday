import { describe, expect, it, vi } from "vitest";

import { createFridayEngineTurnPreparer } from "../../../src/engine/friday-engine-turn-preparer.js";
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
