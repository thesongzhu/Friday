import { describe, it, expect } from "vitest";
import { createDefaultFridayDecisionEngine } from "#agent";
import type { FridayDecisionContext } from "#agent";

describe("createDefaultFridayDecisionEngine", () => {
  const engine = createDefaultFridayDecisionEngine();

  const ctx: FridayDecisionContext = {
    task: "write a test",
    turnIndex: 0,
    history: [],
    availableTools: ["read", "write", "edit"],
  };

  it("canDecideLocally always returns false", () => {
    expect(engine.canDecideLocally(ctx)).toBe(false);
  });

  it("decideLocally returns defer_to_llm with zero confidence", async () => {
    const decision = await engine.decideLocally(ctx);
    expect(decision.action).toBe("defer_to_llm");
    expect(decision.confidence).toBe(0);
    expect(decision.reason).toBeDefined();
  });

  it("rankTools returns tools unchanged", () => {
    const tools = [
      { name: "read", description: "Read a file", parameters: {}, execute: async () => ({}) },
      { name: "write", description: "Write a file", parameters: {}, execute: async () => ({}) },
    ] as any[];

    const ranked = engine.rankTools(ctx, tools);
    expect(ranked).toBe(tools); // same reference — no modification
    expect(ranked).toHaveLength(2);
  });

  it("does not have predictOutcome by default", () => {
    expect(engine.predictOutcome).toBeUndefined();
  });
});
