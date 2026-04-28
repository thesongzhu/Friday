import { describe, expect, it } from "vitest";

import { evaluateFridayAnswerAlignment } from "../../../../src/agent/runtime/friday-agent-answer-alignment.js";

describe("evaluateFridayAnswerAlignment", () => {
  it("requests a retry when a Chinese user message receives an English prose answer", () => {
    const decision = evaluateFridayAnswerAlignment({
      task: "你现在进度怎么样？",
      responseText: "The task is still running and I will send the result when it finishes.",
      historyMessages: [],
      conversationContext: {
        turnKind: "status_check",
      },
    });

    expect(decision.retryPrompt).toContain("latest user message is in Chinese");
  });

  it("allows English answers when the Chinese task explicitly asks for English", () => {
    const decision = evaluateFridayAnswerAlignment({
      task: "请用英文回答：现在进度怎么样？",
      responseText: "The task is still running.",
      historyMessages: [],
      conversationContext: {
        turnKind: "status_check",
      },
    });

    expect(decision.retryPrompt).toBeUndefined();
  });

  it("requests a retry when a pure deictic follow-up is echoed as a standalone issue", () => {
    const decision = evaluateFridayAnswerAlignment({
      task: "这里",
      responseText:
        "目前桌面快照显示Codex应用程序正在运行，但其具体回复内容无法查看。关于您提到的“这里”问题，具体原因当前未知。",
      historyMessages: [],
      conversationContext: {
        turnKind: "follow_up",
        selectedBlocks: [
          {
            source: "assistant_anchor",
            summary:
              "当前桌面快照显示Codex应用程序正在运行，但其具体回复内容无法查看。这是因为系统处于安全模式。",
            score: 28,
          },
        ],
      },
    });

    expect(decision.retryPrompt).toContain("pure deictic follow-up");
  });

  it("does not request a retry when a pure deictic follow-up stays anchored to the prior fact", () => {
    const decision = evaluateFridayAnswerAlignment({
      task: "这里",
      responseText:
        "目前桌面快照显示Codex应用程序正在运行，但其具体回复内容无法查看。这是因为系统处于安全模式；更深层原因当前未知。",
      historyMessages: [],
      conversationContext: {
        turnKind: "follow_up",
        selectedBlocks: [
          {
            source: "assistant_anchor",
            summary:
              "当前桌面快照显示Codex应用程序正在运行，但其具体回复内容无法查看。这是因为系统处于安全模式。",
            score: 28,
          },
        ],
      },
    });

    expect(decision.retryPrompt).toBeUndefined();
  });

  it("requests a retry when the response contradicts deterministic capability facts", () => {
    const decision = evaluateFridayAnswerAlignment({
      task: "discord enabled? mcp enabled? is provider mutation blocked by readOnly?",
      responseText:
        "Discord is enabled, MCP is not enabled, and provider mutation is not blocked by readOnly.",
      historyMessages: [],
      conversationContext: {
        previousTopicSummary: "",
        selectedBlocks: [
          {
            source: "capabilities_block",
            summary:
              "messaging enabled (discord); MCP disabled; provider mutations blocked by readOnly; browser headless (Playwright Chromium); system enabled; desktop disconnected; desktop companion connected",
            score: 120,
          },
        ],
      },
    });

    expect(decision.retryPrompt).toContain("contradicted deterministic runtime capability facts");
  });

  it("does not request a retry when the response matches deterministic capability facts", () => {
    const decision = evaluateFridayAnswerAlignment({
      task: "discord enabled? mcp enabled? is provider mutation blocked by readOnly?",
      responseText:
        "Discord is enabled, MCP is not enabled, and provider mutation is blocked by readOnly.",
      historyMessages: [],
      conversationContext: {
        previousTopicSummary: "",
        selectedBlocks: [
          {
            source: "capabilities_block",
            summary:
              "messaging enabled (discord); MCP disabled; provider mutations blocked by readOnly; browser headless (Playwright Chromium); system enabled; desktop disconnected; desktop companion connected",
            score: 120,
          },
        ],
      },
    });

    expect(decision.retryPrompt).toBeUndefined();
  });
});
