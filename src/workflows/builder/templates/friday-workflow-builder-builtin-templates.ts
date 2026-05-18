import type { FridayWorkflowTemplateEntity } from "../model/friday-workflow-builder-template.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";
import { createFridayCrossBorderBuiltinWorkflowTemplates } from "./friday-workflow-builder-cross-border-templates.js";

// ─── Helper ───

function makeDefaultVisual(workflowId: string, stepIds: string[]): FridayWorkflowVisualGraphV1 {
  const nodes = [
    { nodeId: "__trigger__", x: 100, y: 100 },
    ...stepIds.map((id, i) => ({ nodeId: id, x: 100 + (i + 1) * 250, y: 100 })),
  ];

  return {
    schemaVersion: "1.0",
    workflowId,
    viewport: { x: 0, y: 0, zoom: 1 },
    panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
    nodes,
    edges: [],
  };
}

// ─── Blank Template ───

function createBlankTemplate(): FridayWorkflowTemplateEntity {
  const spec: FridayWorkflowSpecV1 = {
    schemaVersion: "1.0",
    workflowId: "template-blank",
    name: "Blank Workflow",
    description: "An empty workflow to start from scratch",
    startStepId: "step-1",
    trigger: { type: "manual" },
    inputs: [],
    steps: [
      { id: "step-1", type: "transform", args: {} },
    ],
    edges: [],
    outputs: [],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
  };

  return {
    templateId: "builtin-blank",
    kind: "builtin",
    scope: "global",
    name: "Blank Workflow",
    description: "Start from scratch with an empty workflow",
    tags: ["blank", "starter"],
    spec,
    visual: makeDefaultVisual("template-blank", ["step-1"]),
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

// ─── Simple Action Template ───

function createSimpleActionTemplate(): FridayWorkflowTemplateEntity {
  const spec: FridayWorkflowSpecV1 = {
    schemaVersion: "1.0",
    workflowId: "template-simple-action",
    name: "Simple Action",
    description: "A workflow with a single action step",
    startStepId: "action-1",
    trigger: { type: "manual" },
    inputs: [
      { key: "input_data", type: "string", required: true },
    ],
    steps: [
      { id: "action-1", type: "transform", args: { data: "$inputs.input_data" } },
    ],
    edges: [],
    outputs: [
      { key: "result", fromStep: "action-1", path: "result" },
    ],
    errorPolicy: { onFailure: "fail_fast", notifyUser: true },
    tests: [
      {
        name: "basic test",
        inputs: { input_data: "test" },
        mocks: { "action-1": { output: { result: "ok" } } },
        assertions: [{ path: "steps.action-1.output.result", operator: "==", expected: "ok" }],
      },
    ],
  };

  return {
    templateId: "builtin-simple-action",
    kind: "builtin",
    scope: "global",
    name: "Simple Action",
    description: "A workflow with a single action step",
    tags: ["simple", "action"],
    spec,
    visual: makeDefaultVisual("template-simple-action", ["action-1"]),
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

// ─── Conditional Branch Template ───

function createConditionalTemplate(): FridayWorkflowTemplateEntity {
  const spec: FridayWorkflowSpecV1 = {
    schemaVersion: "1.0",
    workflowId: "template-conditional",
    name: "Conditional Branch",
    description: "A workflow that branches based on a condition",
    startStepId: "check",
    trigger: { type: "manual" },
    inputs: [
      { key: "value", type: "number", required: true },
    ],
    steps: [
      { id: "check", type: "condition", condition: "$inputs.value > 10" },
      { id: "high-path", type: "transform", args: { label: "high" } },
      { id: "low-path", type: "transform", args: { label: "low" } },
    ],
    edges: [
      { from: "check", to: "high-path", when: "true" },
      { from: "check", to: "low-path", when: "false" },
    ],
    outputs: [],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [
      {
        name: "high value",
        inputs: { value: 20 },
        mocks: {
          check: { output: { result: true } },
          "high-path": { output: { label: "high" } },
        },
        assertions: [
          { path: "steps.check.output.result", operator: "==", expected: true },
        ],
      },
    ],
  };

  return {
    templateId: "builtin-conditional",
    kind: "builtin",
    scope: "global",
    name: "Conditional Branch",
    description: "Branch workflow logic based on conditions",
    tags: ["conditional", "branching"],
    spec,
    visual: makeDefaultVisual("template-conditional", ["check", "high-path", "low-path"]),
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

// ─── Export all built-in templates ───

export function getFridayBuiltinWorkflowTemplates(): FridayWorkflowTemplateEntity[] {
  return [
    createBlankTemplate(),
    createSimpleActionTemplate(),
    createConditionalTemplate(),
    ...createFridayCrossBorderBuiltinWorkflowTemplates(),
  ];
}
