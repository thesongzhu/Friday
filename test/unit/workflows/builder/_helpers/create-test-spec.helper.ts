import type { FridayWorkflowSpecV1 } from "#workflows";
import type { FridayWorkflowVisualGraphV1 } from "#workflows";

/**
 * Creates a minimal valid FridayWorkflowSpecV1 for testing.
 */
export function createTestSpec(overrides?: Partial<FridayWorkflowSpecV1>): FridayWorkflowSpecV1 {
  return {
    schemaVersion: "1.0",
    workflowId: "wf-test",
    name: "Test Workflow",
    description: "A test workflow",
    startStepId: "step-1",
    trigger: { type: "manual" },
    inputs: [],
    steps: [
      { id: "step-1", type: "skill_call", ref: "test-skill" },
    ],
    edges: [],
    outputs: [],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    ...overrides,
  };
}

/**
 * Creates a minimal valid FridayWorkflowVisualGraphV1 for testing.
 */
export function createTestVisual(workflowId = "wf-test"): FridayWorkflowVisualGraphV1 {
  return {
    schemaVersion: "1.0",
    workflowId,
    viewport: { x: 0, y: 0, zoom: 1 },
    panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
    nodes: [
      { nodeId: "__trigger__", x: 0, y: 0 },
      { nodeId: "step-1", x: 250, y: 0 },
    ],
    edges: [],
  };
}

/**
 * Creates a spec with two steps and an edge for testing.
 */
export function createTestSpecWithEdge(overrides?: Partial<FridayWorkflowSpecV1>): FridayWorkflowSpecV1 {
  return {
    schemaVersion: "1.0",
    workflowId: "wf-test",
    name: "Test Workflow With Edge",
    description: "A test workflow with two steps",
    startStepId: "step-1",
    trigger: { type: "manual" },
    inputs: [
      { key: "data", type: "string", required: true },
    ],
    steps: [
      { id: "step-1", type: "skill_call", ref: "skill-a" },
      { id: "step-2", type: "skill_call", ref: "skill-b" },
    ],
    edges: [
      { from: "step-1", to: "step-2" },
    ],
    outputs: [
      { key: "result", fromStep: "step-2", path: "output" },
    ],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [
      {
        name: "basic test",
        inputs: { data: "hello" },
        mocks: {
          "step-1": { output: { value: "processed" } },
          "step-2": { output: { output: "done" } },
        },
        assertions: [
          { path: "steps.step-2.output.output", operator: "==", expected: "done" },
        ],
      },
    ],
    ...overrides,
  };
}
