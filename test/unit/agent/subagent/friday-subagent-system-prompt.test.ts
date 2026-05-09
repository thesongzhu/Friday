import { describe, it, expect } from "vitest";
import { buildFridaySubagentSystemPrompt } from "#agent";

describe("buildFridaySubagentSystemPrompt", () => {
  it("builds prompt with task only", () => {
    const prompt = buildFridaySubagentSystemPrompt({
      task: "Find the weather in Seattle",
      parentSessionKey: "agent:run:parent-1",
      depth: 1,
    });

    expect(prompt).toContain("You are a sub-agent");
    expect(prompt).toContain("## Task");
    expect(prompt).toContain("Find the weather in Seattle");
    expect(prompt).toContain("## Rules");
    expect(prompt).toContain("Stay focused");
    expect(prompt).not.toContain("## Label");
  });

  it("includes label when provided", () => {
    const prompt = buildFridaySubagentSystemPrompt({
      task: "Research API docs",
      label: "API Research",
      parentSessionKey: "agent:run:parent-1",
      depth: 1,
    });

    expect(prompt).toContain("## Label");
    expect(prompt).toContain("API Research");
  });

  it("includes depth in context", () => {
    const prompt = buildFridaySubagentSystemPrompt({
      task: "Some task",
      parentSessionKey: "agent:run:parent-1",
      depth: 2,
    });

    expect(prompt).toContain("depth 2");
  });

  it("includes parent session key", () => {
    const prompt = buildFridaySubagentSystemPrompt({
      task: "Some task",
      parentSessionKey: "agent:run:parent-xyz",
      depth: 1,
    });

    expect(prompt).toContain("agent:run:parent-xyz");
  });

  it("includes profile guidance when provided", () => {
    const prompt = buildFridaySubagentSystemPrompt({
      task: "Review the current diff",
      profileLabel: "Review",
      profileDescription: "Read-only risk review",
      profileInstructions: ["Prioritize regressions first."],
      parentSessionKey: "agent:run:parent-xyz",
      depth: 1,
    });

    expect(prompt).toContain("## Profile");
    expect(prompt).toContain("Review");
    expect(prompt).toContain("Read-only risk review");
    expect(prompt).toContain("Prioritize regressions first.");
  });

  it("includes Friday user project rules as prompt guidance when provided", () => {
    const prompt = buildFridaySubagentSystemPrompt({
      task: "Review generated skill candidate",
      parentSessionKey: "agent:run:parent-xyz",
      depth: 1,
      userRulesContext: "<friday-user-project-rules>Ask before saving skills.</friday-user-project-rules>",
    });

    expect(prompt).toContain("## Friday User Project Rules");
    expect(prompt).toContain("prompt guidance only");
    expect(prompt).toContain("Ask before saving skills.");
  });

  it("does not add user project rules section when not provided", () => {
    const prompt = buildFridaySubagentSystemPrompt({
      task: "Review generated skill candidate",
      parentSessionKey: "agent:run:parent-xyz",
      depth: 1,
    });

    expect(prompt).not.toContain("## Friday User Project Rules");
  });

  it("adds fork-specific context and guardrails when mode=fork", () => {
    const prompt = buildFridaySubagentSystemPrompt({
      task: "Continue the parent investigation",
      parentSessionKey: "agent:run:parent-xyz",
      depth: 1,
      mode: "fork",
      inheritedMessageCount: 6,
      forkedFromMessageId: "msg-42",
    });

    expect(prompt).toContain("Spawn mode: fork");
    expect(prompt).toContain("Inherited context messages: 6");
    expect(prompt).toContain("Forked from message: msg-42");
    expect(prompt).toContain("Do not guess the parent agent's final answer");
    expect(prompt).toContain("Do not treat the delegated hand-off snapshot as the final result");
  });
});
