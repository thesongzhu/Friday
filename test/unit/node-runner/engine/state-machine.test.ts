import { describe, it, expect } from "vitest";

import {
  isValidTransition,
  isTerminalState,
  transition,
  getValidTargets,
  stepToActiveStatus,
} from "../../../../src/node-runner/engine/state-machine.js";

import type { FridayNodeExecutionStatus } from "../../../../src/node-runner/model/friday-node-runner.types.js";

import { FRIDAY_NODE_RUNNER_TRANSITIONS } from "../../../../src/node-runner/model/friday-node-runner.types.js";

describe("State Machine", () => {
  describe("isValidTransition", () => {
    it("accepts all transitions defined in the types file", () => {
      for (const { from, to } of FRIDAY_NODE_RUNNER_TRANSITIONS) {
        expect(isValidTransition(from, to)).toBe(true);
      }
    });

    it("rejects backward transitions", () => {
      expect(isValidTransition("validating", "loading")).toBe(false);
      expect(isValidTransition("executing", "validating")).toBe(false);
      expect(isValidTransition("completed", "loading")).toBe(false);
    });

    it("rejects self-transitions", () => {
      expect(isValidTransition("loading", "loading")).toBe(false);
      expect(isValidTransition("executing", "executing")).toBe(false);
    });

    it("rejects transitions from terminal states", () => {
      const terminals: FridayNodeExecutionStatus[] = ["completed", "failed", "timed-out", "cancelled"];
      for (const terminal of terminals) {
        expect(isValidTransition(terminal, "loading")).toBe(false);
        expect(isValidTransition(terminal, "executing")).toBe(false);
      }
    });
  });

  describe("isTerminalState", () => {
    it("identifies terminal states", () => {
      expect(isTerminalState("completed")).toBe(true);
      expect(isTerminalState("failed")).toBe(true);
      expect(isTerminalState("timed-out")).toBe(true);
      expect(isTerminalState("cancelled")).toBe(true);
    });

    it("identifies non-terminal states", () => {
      expect(isTerminalState("loading")).toBe(false);
      expect(isTerminalState("validating")).toBe(false);
      expect(isTerminalState("checking-rules")).toBe(false);
      expect(isTerminalState("executing")).toBe(false);
      expect(isTerminalState("post-validating")).toBe(false);
      expect(isTerminalState("post-rules")).toBe(false);
    });
  });

  describe("transition", () => {
    it("returns the target state on valid transition", () => {
      expect(transition("loading", "validating")).toBe("validating");
      expect(transition("validating", "checking-rules")).toBe("checking-rules");
      expect(transition("checking-rules", "executing")).toBe("executing");
      expect(transition("executing", "post-validating")).toBe("post-validating");
      expect(transition("post-validating", "post-rules")).toBe("post-rules");
      expect(transition("post-rules", "completed")).toBe("completed");
    });

    it("throws on invalid transition", () => {
      expect(() => transition("loading", "executing")).toThrow("Invalid state transition");
    });

    it("error message includes valid targets", () => {
      expect(() => transition("loading", "completed")).toThrow("validating");
    });
  });

  describe("getValidTargets", () => {
    it("returns valid targets from loading", () => {
      const targets = getValidTargets("loading");
      expect(targets).toContain("validating");
      expect(targets).toContain("failed");
      expect(targets).toContain("timed-out");
      expect(targets).toContain("cancelled");
    });

    it("validating and post-validating can transition to timeout/cancelled", () => {
      const validatingTargets = getValidTargets("validating");
      const postValidatingTargets = getValidTargets("post-validating");
      expect(validatingTargets).toContain("timed-out");
      expect(validatingTargets).toContain("cancelled");
      expect(postValidatingTargets).toContain("timed-out");
      expect(postValidatingTargets).toContain("cancelled");
    });

    it("returns empty array for terminal states", () => {
      expect(getValidTargets("completed")).toEqual([]);
      expect(getValidTargets("failed")).toEqual([]);
    });

    it("executing can go to post-validating, failed, timed-out, or cancelled", () => {
      const targets = getValidTargets("executing");
      expect(targets).toContain("post-validating");
      expect(targets).toContain("failed");
      expect(targets).toContain("timed-out");
      expect(targets).toContain("cancelled");
    });
  });

  describe("stepToActiveStatus", () => {
    it("maps each step to the correct active status", () => {
      expect(stepToActiveStatus("load")).toBe("loading");
      expect(stepToActiveStatus("pre-validate")).toBe("validating");
      expect(stepToActiveStatus("pre-rules")).toBe("checking-rules");
      expect(stepToActiveStatus("execute")).toBe("executing");
      expect(stepToActiveStatus("post-validate")).toBe("post-validating");
      expect(stepToActiveStatus("post-rules")).toBe("post-rules");
    });
  });
});
