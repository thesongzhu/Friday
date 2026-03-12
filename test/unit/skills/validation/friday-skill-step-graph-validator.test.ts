import { describe, it, expect } from "vitest";
import { validateFridaySkillStepGraph } from "#skills";

describe("validateFridaySkillStepGraph", () => {
  it("returns no issues for null flow", () => {
    expect(validateFridaySkillStepGraph(null)).toEqual([]);
  });

  it("returns no issues for valid flow with terminal step", () => {
    const issues = validateFridaySkillStepGraph({
      startStep: "ask",
      steps: [
        {
          id: "ask",
          type: "ask",
          completion: {},
          transitions: { onSuccess: "act" },
        },
        {
          id: "act",
          type: "act",
          completion: {},
          transitions: { onSuccess: null },
        },
      ],
    });
    expect(issues).toEqual([]);
  });

  it("detects missing startStep", () => {
    const issues = validateFridaySkillStepGraph({
      startStep: "nonexistent",
      steps: [
        {
          id: "ask",
          type: "ask",
          completion: {},
          transitions: { onSuccess: null },
        },
      ],
    });
    const startIssue = issues.find((i) => i.code === "STEP_GRAPH_MISSING_START");
    expect(startIssue).toBeDefined();
  });

  it("detects bad transition targets", () => {
    const issues = validateFridaySkillStepGraph({
      startStep: "ask",
      steps: [
        {
          id: "ask",
          type: "ask",
          completion: {},
          transitions: { onSuccess: "nonexistent", onFailure: "also-missing" },
        },
      ],
    });
    const badTransitions = issues.filter((i) => i.code === "STEP_GRAPH_BAD_TRANSITION");
    expect(badTransitions).toHaveLength(2);
  });

  it("detects unreachable steps", () => {
    const issues = validateFridaySkillStepGraph({
      startStep: "ask",
      steps: [
        {
          id: "ask",
          type: "ask",
          completion: {},
          transitions: { onSuccess: null },
        },
        {
          id: "orphan",
          type: "act",
          completion: {},
          transitions: { onSuccess: null },
        },
      ],
    });
    const unreachable = issues.find((i) => i.code === "STEP_GRAPH_UNREACHABLE");
    expect(unreachable).toBeDefined();
    expect(unreachable!.message).toContain("orphan");
  });

  it("detects no terminal path (all steps have onSuccess transitions)", () => {
    const issues = validateFridaySkillStepGraph({
      startStep: "a",
      steps: [
        {
          id: "a",
          type: "ask",
          completion: {},
          transitions: { onSuccess: "b" },
        },
        {
          id: "b",
          type: "act",
          completion: {},
          transitions: { onSuccess: "a" }, // circular, no terminal
        },
      ],
    });
    const noTerminal = issues.find((i) => i.code === "STEP_GRAPH_NO_TERMINAL");
    expect(noTerminal).toBeDefined();
  });
});
