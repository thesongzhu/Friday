import { describe, expect, it } from "vitest";

import { evaluateFridayAnswerAlignment } from "../../../../src/agent/runtime/friday-agent-answer-alignment.js";

describe("evaluateFridayAnswerAlignment", () => {
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
