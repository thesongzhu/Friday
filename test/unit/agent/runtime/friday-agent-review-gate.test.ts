import { describe, it, expect } from "vitest";
import { createFridayAgentReviewGate } from "#agent";

describe("FridayAgentReviewGate", () => {
  const NOW = "2026-02-20T10:00:00.000Z";
  const plan = { task: "Build a hello world", stepCount: 3, description: "Build and test hello world" };

  it("mode=off auto-approves silently", () => {
    const gate = createFridayAgentReviewGate("off");
    const decision = gate.review(plan, NOW);

    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe("off");
    expect(decision.reviewedAt).toBe(NOW);
  });

  it("mode=auto-approve approves with reason", () => {
    const gate = createFridayAgentReviewGate("auto-approve");
    const decision = gate.review(plan, NOW);

    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe("auto-approve");
    expect(decision.reason).toContain("3 step(s)");
    expect(decision.reviewedAt).toBe(NOW);
  });

  it("mode=auto-reject rejects with reason", () => {
    const gate = createFridayAgentReviewGate("auto-reject");
    const decision = gate.review(plan, NOW);

    expect(decision.approved).toBe(false);
    expect(decision.mode).toBe("auto-reject");
    expect(decision.reason).toContain(plan.description);
    expect(decision.reviewedAt).toBe(NOW);
  });

  it("defaults to off mode when no mode specified", () => {
    const gate = createFridayAgentReviewGate();
    expect(gate.mode).toBe("off");
    const decision = gate.review(plan, NOW);
    expect(decision.approved).toBe(true);
  });
});
