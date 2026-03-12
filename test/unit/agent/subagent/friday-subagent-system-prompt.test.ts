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
});
