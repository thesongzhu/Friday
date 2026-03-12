import { describe, it, expect } from "vitest";
import { createFridayWorkflowNodeMachine } from "#workflows";

describe("FridayWorkflowNodeMachine", () => {
  const machine = createFridayWorkflowNodeMachine();

  it("accepts valid transition queued → running", () => {
    expect(machine.canTransition("queued", "running")).toBe(true);
  });

  it("accepts valid transition queued → cancelled", () => {
    expect(machine.canTransition("queued", "cancelled")).toBe(true);
  });

  it("accepts valid transition queued → blocked_offline", () => {
    expect(machine.canTransition("queued", "blocked_offline")).toBe(true);
  });

  it("accepts valid transition running → completed", () => {
    expect(machine.canTransition("running", "completed")).toBe(true);
  });

  it("accepts valid transition running → failed", () => {
    expect(machine.canTransition("running", "failed")).toBe(true);
  });

  it("accepts valid transition running → cancelled", () => {
    expect(machine.canTransition("running", "cancelled")).toBe(true);
  });

  it("accepts valid transition running → blocked_offline", () => {
    expect(machine.canTransition("running", "blocked_offline")).toBe(true);
  });

  it("accepts valid transition failed → retrying", () => {
    expect(machine.canTransition("failed", "retrying")).toBe(true);
  });

  it("accepts valid transition retrying → running", () => {
    expect(machine.canTransition("retrying", "running")).toBe(true);
  });

  it("accepts valid transition blocked_offline → running", () => {
    expect(machine.canTransition("blocked_offline", "running")).toBe(true);
  });

  it("accepts valid transition blocked_offline → failed", () => {
    expect(machine.canTransition("blocked_offline", "failed")).toBe(true);
  });

  it("rejects invalid transition completed → running", () => {
    expect(machine.canTransition("completed", "running")).toBe(false);
  });

  it("rejects invalid transition queued → completed (must go through running)", () => {
    expect(machine.canTransition("queued", "completed")).toBe(false);
  });

  it("assertTransition throws on invalid transition", () => {
    expect(() => machine.assertTransition("completed", "running")).toThrow(
      "INVALID_NODE_TRANSITION",
    );
  });

  it("identifies completed as terminal", () => {
    expect(machine.isTerminal("completed")).toBe(true);
  });

  it("identifies cancelled as terminal", () => {
    expect(machine.isTerminal("cancelled")).toBe(true);
  });

  it("identifies failed as terminal", () => {
    expect(machine.isTerminal("failed")).toBe(true);
  });

  it("identifies running as non-terminal", () => {
    expect(machine.isTerminal("running")).toBe(false);
  });

  it("retry flow: failed → retrying → running → completed", () => {
    expect(machine.canTransition("failed", "retrying")).toBe(true);
    expect(machine.canTransition("retrying", "running")).toBe(true);
    expect(machine.canTransition("running", "completed")).toBe(true);
  });

  it("offline flow: running → blocked_offline → running → completed", () => {
    expect(machine.canTransition("running", "blocked_offline")).toBe(true);
    expect(machine.canTransition("blocked_offline", "running")).toBe(true);
    expect(machine.canTransition("running", "completed")).toBe(true);
  });

  it("offline timeout: blocked_offline → failed", () => {
    expect(machine.canTransition("blocked_offline", "failed")).toBe(true);
  });

  it("approval granted: blocked_offline → completed", () => {
    expect(machine.canTransition("blocked_offline", "completed")).toBe(true);
  });

  it("approval rejected: blocked_offline → failed", () => {
    expect(machine.canTransition("blocked_offline", "failed")).toBe(true);
  });

  it("approval flow: queued → blocked_offline → completed", () => {
    expect(machine.canTransition("queued", "blocked_offline")).toBe(true);
    expect(machine.canTransition("blocked_offline", "completed")).toBe(true);
  });

  it("approval rejection flow: queued → blocked_offline → failed", () => {
    expect(machine.canTransition("queued", "blocked_offline")).toBe(true);
    expect(machine.canTransition("blocked_offline", "failed")).toBe(true);
  });
});
