import { describe, it, expect, vi } from "vitest";

import { createFridayGeneratedWorkflowValidator } from "#workflows";
import type {
  FridayGeneratedWorkflowValidator,
  FridayWorkflowSpecV1,
  FridayWorkflowVisualGraphV1,
  FridayWorkflowSpecTestCase,
  FridayWorkflowCompiler,
  FridayWorkflowValidator,
} from "#workflows";
import type { FridaySkillRegistry, SkillLifecycleStatus } from "#skills";

// ─── Fixtures ───

function makeSpec(overrides?: Partial<FridayWorkflowSpecV1>): FridayWorkflowSpecV1 {
  return {
    schemaVersion: "1.0",
    workflowId: "test-wf",
    name: "Test Workflow",
    description: "A test workflow",
    startStepId: "step-1",
    trigger: { type: "manual" },
    inputs: [{ key: "name", type: "string", required: true }],
    steps: [
      { id: "step-1", type: "skill_call", ref: "my-skill" },
    ],
    edges: [],
    outputs: [{ key: "result", fromStep: "step-1", path: "output" }],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    ...overrides,
  };
}

function makeVisual(overrides?: Partial<FridayWorkflowVisualGraphV1>): FridayWorkflowVisualGraphV1 {
  return {
    schemaVersion: "1.0",
    workflowId: "test-wf",
    viewport: { x: 0, y: 0, zoom: 1 },
    panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
    nodes: [
      { nodeId: "__trigger__", x: 100, y: 100 },
      { nodeId: "step-1", x: 350, y: 100 },
    ],
    edges: [],
    ...overrides,
  };
}

function makeTests(): FridayWorkflowSpecTestCase[] {
  return [
    {
      name: "happy path",
      inputs: { name: "Alice" },
      assertions: [
        { path: "outputs.result", operator: "==", expected: "done" },
      ],
    },
  ];
}

function makeMockCompiler(): FridayWorkflowCompiler {
  return {
    compile: vi.fn(() => ({
      schemaVersion: "2.0" as const,
      workflowId: "test-wf",
      workflowVersionId: "v-1",
      sourceSpecSchemaVersion: "1.0" as const,
      graph: {
        nodes: [
          { id: "__trigger__", type: "trigger" as const, label: "Trigger", config: {} },
          { id: "step-1", type: "action" as const, label: "step-1", config: { skillId: "my-skill" } },
        ],
        edges: [
          { id: "e-1", sourceNodeId: "__trigger__", targetNodeId: "step-1" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast" as const, notifyUser: false },
      tests: [],
      checksum: "abc123",
    })),
    validateSpec: vi.fn(() => ({ valid: true, errors: [] })),
  };
}

function makeMockWorkflowValidator(): FridayWorkflowValidator {
  return {
    validate: vi.fn(() => ({ valid: true, errors: [] })),
  };
}

function makeMockSkillRegistry(knownIds: string[] = ["my-skill"]): FridaySkillRegistry {
  return {
    list: vi.fn(() => []),
    get: vi.fn((id: string) => {
      if (knownIds.includes(id)) {
        return { manifest: { id, name: id, description: "", inputs: [], outputs: [] } };
      }
      return null;
    }),
    resolveByIntent: vi.fn(() => null),
    validateAll: vi.fn(() => []),
    reload: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    isCompatible: vi.fn(() => ({ compatible: true, reasons: [] })),
    startWatching: vi.fn(async () => undefined),
    stopWatching: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as FridaySkillRegistry;
}

// ─── Tests ───

describe("FridayGeneratedWorkflowValidator", () => {
  let validator: FridayGeneratedWorkflowValidator;
  let mockCompiler: FridayWorkflowCompiler;
  let mockGraphValidator: FridayWorkflowValidator;
  let mockSkillRegistry: FridaySkillRegistry;

  function createValidator(
    knownSkills: string[] = ["my-skill"],
    getSkillLifecycleStatus?: (skillId: string) => SkillLifecycleStatus | null | undefined,
  ) {
    mockCompiler = makeMockCompiler();
    mockGraphValidator = makeMockWorkflowValidator();
    mockSkillRegistry = makeMockSkillRegistry(knownSkills);
    validator = createFridayGeneratedWorkflowValidator({
      compiler: mockCompiler,
      workflowValidator: mockGraphValidator,
      skillRegistry: mockSkillRegistry,
      getSkillLifecycleStatus,
      idGenerator: () => "id-1",
    });
  }

  it("valid artifacts produce no error issues and compiled graph", () => {
    createValidator();
    const result = validator.validate({
      spec: makeSpec(),
      visual: makeVisual(),
      tests: makeTests(),
    });
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
    expect(result.compiledGraph).toBeDefined();
  });

  it("unknown skill ref produces error", () => {
    createValidator([]); // no known skills
    const result = validator.validate({
      spec: makeSpec(),
      visual: makeVisual(),
      tests: makeTests(),
    });
    const skillErrors = result.issues.filter((i) => i.code === "SKILL_REF_NOT_FOUND");
    expect(skillErrors).toHaveLength(1);
    expect(skillErrors[0].severity).toBe("error");
    expect(skillErrors[0].stage).toBe("skill_refs");
  });

  it("unavailable persisted skill ref produces error even when registry knows it", () => {
    createValidator(["my-skill"], (skillId) =>
      skillId === "my-skill" ? "not_installed" : undefined,
    );
    const result = validator.validate({
      spec: makeSpec(),
      visual: makeVisual(),
      tests: makeTests(),
    });
    const skillErrors = result.issues.filter((i) => i.code === "SKILL_REF_NOT_AVAILABLE");
    expect(skillErrors).toHaveLength(1);
    expect(skillErrors[0]).toMatchObject({
      severity: "error",
      stage: "skill_refs",
      stepId: "step-1",
    });
  });

  it("missing step node in visual produces error", () => {
    createValidator();
    const visual = makeVisual({
      nodes: [{ nodeId: "__trigger__", x: 0, y: 0 }], // missing step-1
    });
    const result = validator.validate({
      spec: makeSpec(),
      visual,
      tests: makeTests(),
    });
    const missingNode = result.issues.filter((i) => i.code === "VISUAL_MISSING_NODE");
    expect(missingNode.length).toBeGreaterThanOrEqual(1);
    expect(missingNode[0].severity).toBe("error");
  });

  it("orphan visual node produces warning", () => {
    createValidator();
    const visual = makeVisual({
      nodes: [
        { nodeId: "__trigger__", x: 0, y: 0 },
        { nodeId: "step-1", x: 100, y: 0 },
        { nodeId: "orphan-node", x: 200, y: 0 },
      ],
    });
    const result = validator.validate({
      spec: makeSpec(),
      visual,
      tests: makeTests(),
    });
    const orphan = result.issues.filter((i) => i.code === "VISUAL_ORPHAN_NODE");
    expect(orphan).toHaveLength(1);
    expect(orphan[0].severity).toBe("warning");
  });

  it("invalid test operator produces error", () => {
    createValidator();
    const tests: FridayWorkflowSpecTestCase[] = [
      {
        name: "bad test",
        inputs: {},
        assertions: [
          { path: "outputs.result", operator: "LIKE" as "==", expected: "x" },
        ],
      },
    ];
    const result = validator.validate({
      spec: makeSpec(),
      visual: makeVisual(),
      tests,
    });
    const opErrors = result.issues.filter((i) => i.code === "TEST_INVALID_OPERATOR");
    expect(opErrors).toHaveLength(1);
  });

  it("invalid test path produces error", () => {
    createValidator();
    const tests: FridayWorkflowSpecTestCase[] = [
      {
        name: "bad path test",
        inputs: {},
        assertions: [
          { path: "invalid.path", operator: "==", expected: "x" },
        ],
      },
    ];
    const result = validator.validate({
      spec: makeSpec(),
      visual: makeVisual(),
      tests,
    });
    const pathErrors = result.issues.filter((i) => i.code === "TEST_INVALID_PATH");
    expect(pathErrors).toHaveLength(1);
  });

  it("compile errors map into issues", () => {
    createValidator();
    const mockComp = mockCompiler as { compile: ReturnType<typeof vi.fn> };
    mockComp.compile.mockImplementation(() => {
      throw new Error("WORKFLOW_COMPILATION_ERROR: cycle detected");
    });
    const result = validator.validate({
      spec: makeSpec(),
      visual: makeVisual(),
      tests: makeTests(),
    });
    const compileErrors = result.issues.filter((i) => i.stage === "compile");
    expect(compileErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.compiledGraph).toBeUndefined();
  });

  it("graph validation errors map into issues", () => {
    createValidator();
    const mockGV = mockGraphValidator as { validate: ReturnType<typeof vi.fn> };
    mockGV.validate.mockReturnValue({
      valid: false,
      errors: [
        { code: "WORKFLOW_CYCLE_DETECTED", message: "Graph contains a cycle" },
      ],
    });
    const result = validator.validate({
      spec: makeSpec(),
      visual: makeVisual(),
      tests: makeTests(),
    });
    const graphErrors = result.issues.filter((i) => i.stage === "graph");
    expect(graphErrors).toHaveLength(1);
    expect(graphErrors[0].code).toBe("WORKFLOW_CYCLE_DETECTED");
  });

  it("rejects generated data nodes that have neither mapping nor transform", () => {
    createValidator();
    const mockComp = mockCompiler as { compile: ReturnType<typeof vi.fn> };
    mockComp.compile.mockReturnValue({
      schemaVersion: "2.0" as const,
      workflowId: "test-wf",
      workflowVersionId: "v-1",
      sourceSpecSchemaVersion: "1.0" as const,
      graph: {
        nodes: [
          { id: "__trigger__", type: "trigger" as const, label: "Trigger", config: {} },
          { id: "output_step", type: "data" as const, label: "output_step", config: {} },
        ],
        edges: [
          { id: "e-1", sourceNodeId: "__trigger__", targetNodeId: "output_step" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast" as const, notifyUser: false },
      tests: [],
      checksum: "graph-empty-data",
    });
    const result = validator.validate({
      spec: makeSpec({
        startStepId: "output_step",
        steps: [{ id: "output_step", type: "transform", args: {} }],
        outputs: [{ key: "result", fromStep: "output_step", path: "message" }],
      }),
      visual: makeVisual({
        nodes: [
          { nodeId: "__trigger__", x: 100, y: 100 },
          { nodeId: "output_step", x: 350, y: 100 },
        ],
      }),
      tests: makeTests(),
    });
    expect(result.issues.some((i) => i.code === "GRAPH_DATA_NODE_MISSING_MAPPING")).toBe(true);
  });

  it("spec with missing startStepId produces error", () => {
    createValidator();
    const spec = makeSpec({ startStepId: "nonexistent" });
    const result = validator.validate({
      spec,
      visual: makeVisual(),
      tests: makeTests(),
    });
    const errors = result.issues.filter((i) => i.code === "SPEC_START_STEP_MISSING");
    expect(errors).toHaveLength(1);
  });

  it("test mocks referencing unknown step produce error", () => {
    createValidator();
    const tests: FridayWorkflowSpecTestCase[] = [
      {
        name: "bad mock",
        inputs: {},
        mocks: {
          "nonexistent-step": { output: {}, status: "completed" },
        },
        assertions: [
          { path: "outputs.result", operator: "==", expected: "x" },
        ],
      },
    ];
    const result = validator.validate({
      spec: makeSpec(),
      visual: makeVisual(),
      tests,
    });
    const mockErrors = result.issues.filter((i) => i.code === "TEST_MOCK_UNKNOWN_STEP");
    expect(mockErrors).toHaveLength(1);
  });
});
