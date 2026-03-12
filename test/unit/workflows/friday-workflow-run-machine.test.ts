import { describe, it, expect } from "vitest";
import { createFridayWorkflowRunMachine } from "#workflows";

describe("FridayWorkflowRunMachine", () => {
  const machine = createFridayWorkflowRunMachine();

  it("accepts valid transition queued → running", () => {
    expect(machine.canTransition("queued", "running")).toBe(true);
  });

  it("accepts valid transition queued → cancelled", () => {
    expect(machine.canTransition("queued", "cancelled")).toBe(true);
  });

  it("accepts valid transition running → pausing", () => {
    expect(machine.canTransition("running", "pausing")).toBe(true);
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

  it("accepts valid transition running → compensating", () => {
    expect(machine.canTransition("running", "compensating")).toBe(true);
  });

  it("accepts valid transition pausing → paused", () => {
    expect(machine.canTransition("pausing", "paused")).toBe(true);
  });

  it("accepts valid transition paused → running (resume)", () => {
    expect(machine.canTransition("paused", "running")).toBe(true);
  });

  it("accepts valid transition compensating → completed", () => {
    expect(machine.canTransition("compensating", "completed")).toBe(true);
  });

  it("accepts valid transition compensating → failed", () => {
    expect(machine.canTransition("compensating", "failed")).toBe(true);
  });

  it("accepts valid transition failed → running (retry)", () => {
    expect(machine.canTransition("failed", "running")).toBe(true);
  });

  it("rejects invalid transition completed → running", () => {
    expect(machine.canTransition("completed", "running")).toBe(false);
  });

  it("rejects invalid transition queued → completed", () => {
    expect(machine.canTransition("queued", "completed")).toBe(false);
  });

  it("rejects invalid transition cancelled → running", () => {
    expect(machine.canTransition("cancelled", "running")).toBe(false);
  });

  it("assertTransition throws on invalid transition", () => {
    expect(() => machine.assertTransition("completed", "running")).toThrow(
      "INVALID_RUN_TRANSITION",
    );
  });

  it("assertTransition succeeds on valid transition", () => {
    expect(() => machine.assertTransition("queued", "running")).not.toThrow();
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

  it("identifies paused as non-terminal", () => {
    expect(machine.isTerminal("paused")).toBe(false);
  });

  it("pause flow: running → pausing → paused → running", () => {
    expect(machine.canTransition("running", "pausing")).toBe(true);
    expect(machine.canTransition("pausing", "paused")).toBe(true);
    expect(machine.canTransition("paused", "running")).toBe(true);
  });

  it("compensation flow: running → compensating → completed/failed", () => {
    expect(machine.canTransition("running", "compensating")).toBe(true);
    expect(machine.canTransition("compensating", "completed")).toBe(true);
    expect(machine.canTransition("compensating", "failed")).toBe(true);
  });
});
