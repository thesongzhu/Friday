import { describe, expect, it } from "vitest";

import {
  classifyFridayConversationTurn,
  finalizeFridayConversationFocus,
  prepareFridayConversationTurn,
} from "#sessions";
import type {
  FridaySessionConversationFocusState,
  FridaySessionMessageRecord,
} from "#sessions";

function makeMessage(input: {
  sequence: number;
  role: "user" | "assistant";
  contentText: string;
}): FridaySessionMessageRecord {
  return {
    id: `msg-${String(input.sequence)}`,
    sessionId: "session-1",
    sessionKey: "discord:default:test",
    sequence: input.sequence,
    role: input.role,
    content: input.contentText,
    contentText: input.contentText,
    tokenCount: 0,
    metadata: {},
    memoryExtractStatus: "skipped",
    occurredAt: "2026-03-15T10:00:00.000Z",
    createdAt: "2026-03-15T10:00:00.000Z",
    updatedAt: "2026-03-15T10:00:00.000Z",
  };
}

describe("friday-session-conversation-orchestrator", () => {
  const baseFocusState: FridaySessionConversationFocusState = {
    currentTopicFingerprint: "topic-1",
    currentTopicSummary: "Explain the capital of France and related geography.",
    currentTopicStartSequence: 1,
    lastAnsweredQuestion: "What is the capital of France?",
    lastAssistantAskedQuestion: false,
    lastRunId: "run-1",
    updatedAt: "2026-03-15T10:00:00.000Z",
  };

  it("classifies an unrelated question as a new topic", () => {
    expect(classifyFridayConversationTurn({
      task: "How do I bake sourdough bread?",
      focusState: baseFocusState,
    })).toBe("new_topic");
  });

  it("keeps only the active topic window for follow-up turns", () => {
    const prepared = prepareFridayConversationTurn({
      task: "What country is that city in?",
      focusState: baseFocusState,
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "What is the capital of France?" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "Paris is the capital of France." }),
        makeMessage({ sequence: 3, role: "user", contentText: "Explain it briefly." }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "Paris is in north-central France." }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.historyMessages).toHaveLength(4);
    expect(prepared.taskPrompt).toContain("Continue the current topic");
  });

  it("drops prior content history for a new topic", () => {
    const prepared = prepareFridayConversationTurn({
      task: "How do I bake sourdough bread?",
      focusState: baseFocusState,
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "What is the capital of France?" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "Paris is the capital of France." }),
        makeMessage({ sequence: 3, role: "user", contentText: "Explain it briefly." }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "Paris is in north-central France." }),
      ],
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.historyMessages).toEqual([]);
    expect(prepared.taskPrompt).toContain("Current question: How do I bake sourdough bread?");
  });

  it("treats explicit progress checks as status_check and avoids prior answer history", () => {
    const prepared = prepareFridayConversationTurn({
      task: "刚才那个任务现在进度怎么样？",
      focusState: baseFocusState,
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "Open Facebook and sign up." }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "I delegated the task to a browser worker." }),
      ],
    });

    expect(prepared.turnKind).toBe("status_check");
    expect(prepared.historyMessages).toHaveLength(2);
    expect(prepared.taskPrompt).toContain("asking for a status update");
    expect(prepared.taskPrompt).toContain("Use the task_status tool before answering.");
  });

  it("persists new-topic focus state with the current sequence", () => {
    const focus = finalizeFridayConversationFocus({
      task: "How do I bake sourdough bread?",
      responseText: "Use a starter and let the dough ferment overnight.",
      runId: "run-2",
      turnKind: "new_topic",
      focusState: baseFocusState,
      currentUserSequence: 9,
      nowIso: "2026-03-15T11:00:00.000Z",
    });

    expect(focus.currentTopicSummary).toBe("How do I bake sourdough bread?");
    expect(focus.currentTopicStartSequence).toBe(9);
    expect(focus.lastRunId).toBe("run-2");
    expect(focus.lastTurnKind).toBe("new_topic");
  });

  it("preserves another active run when a status-check turn finishes", () => {
    const focus = finalizeFridayConversationFocus({
      task: "刚才那个任务现在怎么样？",
      responseText: "It is still running in a delegated subagent.",
      runId: "run-status-check",
      turnKind: "status_check",
      focusState: {
        ...baseFocusState,
        activeRunId: "run-long-task",
        activeSubagentIds: ["sub-1"],
      },
      currentUserSequence: 10,
      nowIso: "2026-03-15T11:00:00.000Z",
    });

    expect(focus.activeRunId).toBe("run-long-task");
    expect(focus.activeSubagentIds).toEqual(["sub-1"]);
  });
});
