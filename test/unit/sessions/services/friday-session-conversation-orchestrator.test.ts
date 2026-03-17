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
  metadata?: Record<string, unknown>;
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
    metadata: input.metadata ?? {},
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
    expect(prepared.selectedBlocks.length).toBeGreaterThan(0);
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

  it("classifies short follow-ups against the latest assistant answer", () => {
    const prepared = prepareFridayConversationTurn({
      task: "为什么没有connect",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "看一下我桌面上的codex app给我的回复是什么",
        assistantAnchorSummary: "The desktop companion is not connected.",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "看一下我桌面上的codex app给我的回复是什么" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "I cannot inspect it because the desktop companion is not connected." }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.selectedBlocks.some((block) => block.source === "assistant_anchor")).toBe(true);
    expect(prepared.taskPrompt).toContain("Referenced assistant fact:");
    expect(prepared.taskPrompt).toContain("desktop companion is not connected");
    expect(prepared.taskPrompt).toContain("Do not claim a new action");
  });

  it("keeps a short why-question on the same topic even when the latest assistant anchor uses different wording", () => {
    const prepared = prepareFridayConversationTurn({
      task: "为什么没有connect",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "看一下我桌面上的codex app给我的回复是什么",
        assistantAnchorSummary: "当前桌面上的 Codex 应用程序无法列出通知，状态为不可用。",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "看一下我桌面上的codex app给我的回复是什么" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "当前桌面上的 Codex 应用程序无法列出通知，状态为不可用。" }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.taskPrompt).toContain("Referenced assistant fact:");
    expect(prepared.taskPrompt).toContain("Codex 应用程序无法列出通知");
  });

  it("stores assistant-anchor summaries as assistant facts instead of full user-assistant windows", () => {
    const prepared = prepareFridayConversationTurn({
      task: "这里",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "看一下我桌面上的codex app给我的回复是什么",
        assistantAnchorSummary: "The desktop companion is not connected.",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "看一下我桌面上的codex app给我的回复是什么" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "The desktop companion is not connected." }),
      ],
    });

    const assistantAnchor = prepared.selectedBlocks.find((block) => block.source === "assistant_anchor");
    expect(assistantAnchor?.summary).toBe("The desktop companion is not connected.");
    expect(prepared.taskPrompt).toContain("Referenced assistant fact: The desktop companion is not connected.");
  });

  it("resolves reply anchors from platform source message ids", () => {
    const prepared = prepareFridayConversationTurn({
      task: "这里",
      focusState: baseFocusState,
      currentUserSequence: 5,
      replyToMessageId: "discord-msg-2",
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "Open GitHub" }),
        makeMessage({
          sequence: 2,
          role: "assistant",
          contentText: "I could not open it because the browser was not connected.",
          metadata: { sourceMessageId: "discord-msg-2" },
        }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.replyAnchorMessageId).toBe("msg-2");
    expect(prepared.selectedBlocks[0]?.source).toBe("reply_anchor");
  });

  it("builds an anchored follow-up prompt even without persisted focus state", () => {
    const prepared = prepareFridayConversationTurn({
      task: "why didn't it connect/open?",
      currentUserSequence: 5,
      replyToMessageId: "discord-msg-2",
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "open github" }),
        makeMessage({
          sequence: 2,
          role: "assistant",
          contentText: "I could not open GitHub because the browser session was not connected.",
          metadata: { sourceMessageId: "discord-msg-2" },
        }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.taskPrompt).toContain("following up on the latest assistant-stated fact");
    expect(prepared.taskPrompt).toContain("Referenced assistant fact: I could not open GitHub because the browser session was not connected.");
    expect(prepared.taskPrompt).toContain("Relevant anchors");
    expect(prepared.taskPrompt).toContain("Do not claim a new action, a new success state, or a new result");
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

  it("does not treat workflow requirements containing release status as a status check", () => {
    const prepared = prepareFridayConversationTurn({
      task: "Generate a workflow that runs every Friday, collects workspace release status, posts the summary to Slack, keeps the execution read-only, and reports blockers before deployment.",
      focusState: undefined,
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "What is the capital of France?" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "Paris is the capital of France." }),
      ],
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.taskPrompt).toContain("Generate a workflow that runs every Friday");
    expect(prepared.taskPrompt).not.toContain("asking for a status update");
  });

  it("keeps recent cross-topic history for recap-style follow ups", () => {
    const prepared = prepareFridayConversationTurn({
      task: "Summarize your recommendations",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "What test runner do you recommend?",
        currentTopicStartSequence: 3,
      },
      currentUserSequence: 6,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "What language do you prefer?" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "I like TypeScript." }),
        makeMessage({ sequence: 3, role: "user", contentText: "What test runner do you recommend?" }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "Vitest is my recommended test runner." }),
        makeMessage({ sequence: 5, role: "user", contentText: "Thanks." }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.historyMessages).toHaveLength(5);
  });

  it("rehydrates relevant earlier history blocks for long follow-up conversations", () => {
    const historyRecords: FridaySessionMessageRecord[] = [
      makeMessage({ sequence: 1, role: "user", contentText: "Open GitHub in the browser." }),
      makeMessage({ sequence: 2, role: "assistant", contentText: "I could not open GitHub because the browser session was not connected." }),
      makeMessage({ sequence: 3, role: "user", contentText: "What does the error imply?" }),
      makeMessage({ sequence: 4, role: "assistant", contentText: "It implies the browser bridge was unavailable." }),
      makeMessage({ sequence: 5, role: "user", contentText: "How should we test the fix?" }),
      makeMessage({ sequence: 6, role: "assistant", contentText: "Run a smoke test after reconnecting the browser session." }),
      makeMessage({ sequence: 7, role: "user", contentText: "Should we also check Discord?" }),
      makeMessage({ sequence: 8, role: "assistant", contentText: "Yes, verify Discord notifications after the browser smoke test." }),
      makeMessage({ sequence: 9, role: "user", contentText: "What about logging?" }),
      makeMessage({ sequence: 10, role: "assistant", contentText: "Capture logs before and after reconnecting." }),
      makeMessage({ sequence: 11, role: "user", contentText: "Summarize the rollout order." }),
      makeMessage({ sequence: 12, role: "assistant", contentText: "Reconnect browser, rerun smoke, verify Discord, then inspect logs." }),
      makeMessage({ sequence: 13, role: "user", contentText: "Do we need screenshots?" }),
      makeMessage({ sequence: 14, role: "assistant", contentText: "Yes, collect screenshots for the regression report." }),
      makeMessage({ sequence: 15, role: "user", contentText: "Anything else?" }),
      makeMessage({ sequence: 16, role: "assistant", contentText: "That covers the rollout checklist." }),
    ];

    const prepared = prepareFridayConversationTurn({
      task: "why didn't it connect/open?",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Open GitHub in the browser and understand why it failed to connect.",
        currentTopicStartSequence: 1,
        assistantAnchorSummary: "That covers the rollout checklist.",
      },
      currentUserSequence: 17,
      historyRecords,
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.selectedBlocks.some((block) => block.source === "tool_failure_block")).toBe(true);
    expect(prepared.historyMessages.some((message) =>
      message.role === "assistant"
      && typeof message.content === "string"
      && message.content.includes("browser session was not connected"))).toBe(true);
    expect(prepared.taskPrompt).toContain("tool_failure_block");
  });

  it("does not let compacted older blocks pollute a new topic", () => {
    const historyRecords: FridaySessionMessageRecord[] = Array.from({ length: 16 }, (_, index) => {
      const sequence = index + 1;
      return makeMessage({
        sequence,
        role: sequence % 2 === 1 ? "user" : "assistant",
        contentText: sequence % 2 === 1
          ? `Discuss browser rollout step ${String(sequence)}`
          : `Assistant rollout answer ${String(sequence)} about reconnecting the browser.`,
      });
    });

    const prepared = prepareFridayConversationTurn({
      task: "How do I bake sourdough bread?",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Open GitHub in the browser and understand why it failed to connect.",
        currentTopicStartSequence: 1,
      },
      currentUserSequence: 17,
      historyRecords,
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.historyMessages).toEqual([]);
    expect(prepared.taskPrompt).toContain("Current question: How do I bake sourdough bread?");
    expect(prepared.taskPrompt).toContain("Previous topic");
  });

  it("does not treat a new topic as follow-up when the only overlap is a weak assistant token", () => {
    const prepared = prepareFridayConversationTurn({
      task: "How do I bake sourdough bread? Answer in one sentence.",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Say exactly this sentence and nothing else: GitHub did not open because the browser session was not connected.",
        currentTopicStartSequence: 1,
        assistantAnchorSummary: "GitHub did not open because the browser session was not connected.",
      },
      currentUserSequence: 19,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "Say exactly this sentence and nothing else: GitHub did not open because the browser session was not connected." }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "GitHub did open successfully and returned an HTTP 200 OK status." }),
        makeMessage({ sequence: 3, role: "user", contentText: "For that same browser-session problem, in one short sentence, summarize the smoke test." }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "I do not have deeper root-cause evidence beyond that, so I won't speculate." }),
      ],
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.historyMessages).toEqual([]);
    expect(prepared.taskPrompt).toContain("Current question: How do I bake sourdough bread?");
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
    expect(focus.assistantAnchorSummary).toBe("Use a starter and let the dough ferment overnight.");
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

  it("clears pending plan state when finalize receives an explicit null plan reference", () => {
    const focus = finalizeFridayConversationFocus({
      task: "approve",
      responseText: "Plan approved and execution resumed.",
      runId: "run-3",
      turnKind: "clarification",
      focusState: {
        ...baseFocusState,
        pendingPlanRunId: "run-plan-1",
      },
      currentUserSequence: 11,
      pendingPlanRunId: null,
      nowIso: "2026-03-15T11:05:00.000Z",
    });

    expect(focus.pendingPlanRunId).toBeUndefined();
  });
});
