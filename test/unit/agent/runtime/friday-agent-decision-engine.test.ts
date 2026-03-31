import { describe, it, expect } from "vitest";
import { createDefaultFridayDecisionEngine } from "#agent";
import type { FridayDecisionContext } from "#agent";

describe("createDefaultFridayDecisionEngine", () => {
  const engine = createDefaultFridayDecisionEngine();

  function makeCtx(task: string, turnIndex = 0): FridayDecisionContext {
    return {
      task,
      turnIndex,
      history: [],
      availableTools: ["read", "write", "edit"],
    };
  }

  // ─── Greeting patterns ──────────────────────────────────────

  it.each(["hello", "Hi", "Hey!", "你好", "good morning", "Good Evening"])
  ("recognizes greeting: %s", (input) => {
    expect(engine.canDecideLocally(makeCtx(input))).toBe(true);
  });

  it("responds to greeting with helpful message", async () => {
    const decision = await engine.decideLocally(makeCtx("hello"));
    expect(decision.action).toBe("respond");
    expect(decision.confidence).toBeGreaterThanOrEqual(0.9);
    expect(decision.response).toContain("Friday");
    expect(decision.reason).toContain("greeting");
  });

  // ─── Status patterns ────────────────────────────────────────

  it.each(["status", "health", "运行情况", "状态", "how are you", "are you running?"])
  ("recognizes status query: %s", (input) => {
    expect(engine.canDecideLocally(makeCtx(input))).toBe(true);
  });

  it("responds to status with system overview", async () => {
    const decision = await engine.decideLocally(makeCtx("status"));
    expect(decision.action).toBe("respond");
    expect(decision.response).toContain("Online");
  });

  // ─── Help patterns ──────────────────────────────────────────

  it.each(["help", "帮助", "what can you do", "你能做什么", "features"])
  ("recognizes help request: %s", (input) => {
    expect(engine.canDecideLocally(makeCtx(input))).toBe(true);
  });

  it("responds to help with feature list", async () => {
    const decision = await engine.decideLocally(makeCtx("help"));
    expect(decision.action).toBe("respond");
    expect(decision.response).toContain("Automation");
    expect(decision.response).toContain("Monitoring");
  });

  // ─── Cancel patterns ────────────────────────────────────────

  it.each(["stop", "cancel", "取消", "算了", "算了吧", "nevermind"])
  ("recognizes cancel: %s", (input) => {
    expect(engine.canDecideLocally(makeCtx(input))).toBe(true);
  });

  it("responds to cancel with confirmation", async () => {
    const decision = await engine.decideLocally(makeCtx("cancel"));
    expect(decision.action).toBe("respond");
    expect(decision.response).toContain("stopped");
  });

  // ─── Non-matching intents ───────────────────────────────────

  it("defers complex tasks to LLM", () => {
    expect(engine.canDecideLocally(makeCtx("write a test for the auth module"))).toBe(false);
  });

  it("defers long messages to LLM", () => {
    const longTask = "I need you to create a comprehensive workflow that monitors my server, " +
      "checks CPU usage every 5 minutes, and sends me an alert via Slack when it exceeds 80%";
    expect(engine.canDecideLocally(makeCtx(longTask))).toBe(false);
  });

  it("defers when turnIndex > 0 (mid-conversation)", () => {
    expect(engine.canDecideLocally(makeCtx("hello", 1))).toBe(false);
  });

  it("decideLocally falls back to defer_to_llm if no match", async () => {
    const decision = await engine.decideLocally(makeCtx("build my project"));
    expect(decision.action).toBe("defer_to_llm");
    expect(decision.confidence).toBe(0);
  });

  // ─── rankTools ──────────────────────────────────────────────

  it("rankTools returns tools unchanged", () => {
    const tools = [
      { name: "read", description: "Read a file", parameters: {}, execute: async () => ({}) },
      { name: "write", description: "Write a file", parameters: {}, execute: async () => ({}) },
    ] as any[];

    const ranked = engine.rankTools(makeCtx("test"), tools);
    expect(ranked).toBe(tools);
    expect(ranked).toHaveLength(2);
  });

  it("does not have predictOutcome by default", () => {
    expect(engine.predictOutcome).toBeUndefined();
  });
});
