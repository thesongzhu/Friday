import { describe, expect, it } from "vitest";

import { createFridayProviderContextCompactor } from "#providers";
import type { FridayProviderContextMessage } from "#providers";

function makeMessage(input: {
  index: number;
  role: FridayProviderContextMessage["role"];
  content: string;
}): FridayProviderContextMessage {
  return {
    messageId: `msg-${String(input.index)}`,
    role: input.role,
    content: input.content,
    createdAt: new Date(Date.UTC(2026, 2, 17, 10, input.index, 0)).toISOString(),
  };
}

describe("friday-provider-context-compactor", () => {
  it("keeps the most relevant earlier block raw instead of only the most recent turns", async () => {
    const compactor = createFridayProviderContextCompactor({
      estimator: {
        estimateTextTokens(text) {
          return Math.ceil(text.length / 4);
        },
        estimateMessagesTokens(messages) {
          return messages.reduce((total, message) => total + Math.ceil(message.content.length / 4) + 8, 0);
        },
        getContextWindow() {
          return 256;
        },
      },
      pruner: {
        prune(messages) {
          return { messages: [...messages], prunedCount: 0 };
        },
      },
    });

    const messages: FridayProviderContextMessage[] = [
      makeMessage({ index: 1, role: "user", content: "Open GitHub in the browser." }),
      makeMessage({ index: 2, role: "assistant", content: "I could not open GitHub because the browser session was not connected." }),
      makeMessage({ index: 3, role: "user", content: "Summarize the rollout plan." }),
      makeMessage({ index: 4, role: "assistant", content: "Reconnect browser, rerun smoke, verify Discord." }),
      makeMessage({ index: 5, role: "user", content: "What about logging?" }),
      makeMessage({ index: 6, role: "assistant", content: "Capture logs before and after reconnecting." }),
      makeMessage({ index: 7, role: "user", content: "Should we collect screenshots?" }),
      makeMessage({ index: 8, role: "assistant", content: "Yes, collect screenshots for the regression report." }),
      makeMessage({ index: 9, role: "user", content: "Anything else?" }),
      makeMessage({ index: 10, role: "assistant", content: "That covers the rollout checklist." }),
    ];

    const result = await compactor.compact({
      systemPrompt: "You are a workflow generator.",
      userPrompt: "Why didn't it connect/open? Explain the earlier failure clearly.",
      messages,
      contextWindowTokens: 80,
      summarize: async () => "{\"summaryText\":\"unused\"}",
    });

    expect(result.compacted).toBe(true);
    expect(result.blocks?.some((block) => block.kind === "tool_failure_block")).toBe(true);
    expect(result.keptMessages.some((message) =>
      message.content.includes("browser session was not connected"))).toBe(true);
    expect(result.keptMessages.some((message) =>
      message.messageId === "compaction-summary")).toBe(true);
  });

  it("emits structured block summaries for summarized blocks", async () => {
    const compactor = createFridayProviderContextCompactor({
      estimator: {
        estimateTextTokens(text) {
          return Math.ceil(text.length / 4);
        },
        estimateMessagesTokens(messages) {
          return messages.reduce((total, message) => total + Math.ceil(message.content.length / 4) + 8, 0);
        },
        getContextWindow() {
          return 256;
        },
      },
      pruner: {
        prune(messages) {
          return { messages: [...messages], prunedCount: 0 };
        },
      },
    });

    const messages: FridayProviderContextMessage[] = [
      makeMessage({ index: 1, role: "user", content: "Please summarize the workflow plan." }),
      makeMessage({ index: 2, role: "assistant", content: "Plan: reconnect browser, rerun smoke, verify Discord." }),
      makeMessage({ index: 3, role: "user", content: "What failed first?" }),
      makeMessage({ index: 4, role: "assistant", content: "The browser session was not connected, so opening GitHub failed." }),
      makeMessage({ index: 5, role: "user", content: "What should we do next?" }),
      makeMessage({ index: 6, role: "assistant", content: "Next, collect logs and screenshots." }),
      makeMessage({ index: 7, role: "user", content: "Any blockers?" }),
      makeMessage({ index: 8, role: "assistant", content: "No blockers beyond the missing browser connection." }),
    ];

    const result = await compactor.compact({
      systemPrompt: "You are a workflow generator.",
      userPrompt: "Build a final summary of the plan and earlier browser failure.",
      messages,
      contextWindowTokens: 70,
      summarize: async () => "{\"summaryText\":\"unused\"}",
    });

    expect(result.compacted).toBe(true);
    expect(result.summary?.summaryText).toContain("[");
    expect(result.blocks?.length).toBeGreaterThanOrEqual(3);
    expect(result.keptMessages[0]?.messageId).toBe("compaction-summary");
    expect(result.keptMessages[0]?.content).toContain("[Conversation Block Summaries]");
  });

  it("emits a structured summary when recent oversized tool results are pruned without dropping blocks", async () => {
    const compactor = createFridayProviderContextCompactor({
      estimator: {
        estimateTextTokens(text) {
          return Math.ceil(text.length / 4);
        },
        estimateMessagesTokens(messages) {
          return messages.reduce((total, message) => total + Math.ceil(message.content.length / 4) + 8, 0);
        },
        getContextWindow() {
          return 256;
        },
      },
      pruner: {
        prune(messages) {
          return {
            messages: messages.map((message) =>
              message.role === "tool-result"
                ? { ...message, content: `${message.content.slice(0, 120)}\n[...pruned recent tool result...]\n${message.content.slice(-80)}` }
                : { ...message }),
            prunedCount: 1,
          };
        },
      },
    });

    const messages: FridayProviderContextMessage[] = [
      makeMessage({ index: 1, role: "user", content: "Read the large runtime artifact and keep the exact path in mind." }),
      makeMessage({ index: 2, role: "assistant", content: "I will inspect the file with the read tool." }),
      makeMessage({
        index: 3,
        role: "tool-result",
        content: `read dist/agent/runtime/friday-agent-runtime.js.map ${"A".repeat(18_000)} ENOENT dist/ui/assets/runtime-missing.js.map`,
      }),
    ];

    const result = await compactor.compact({
      systemPrompt: "You are auditing Friday runtime behavior.",
      userPrompt: "Preserve the key tool output while shrinking the prompt budget.",
      messages,
      contextWindowTokens: 40,
      summarize: async () => "{\"summaryText\":\"unused\"}",
    });

    expect(result.compacted).toBe(true);
    expect(result.droppedMessages).toHaveLength(0);
    expect(result.summary?.summaryText).toContain("dist/agent/runtime/friday-agent-runtime.js.map");
    expect(result.summary?.fileOperations).toContain("dist/agent/runtime/friday-agent-runtime.js.map");
    expect(result.summary?.summaryText.length ?? 0).toBeGreaterThan(0);
  });
});
