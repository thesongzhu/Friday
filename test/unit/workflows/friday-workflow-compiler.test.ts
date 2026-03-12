import { describe, it, expect, beforeEach } from "vitest";
import { createFridayWorkflowCompiler } from "#workflows";
import type { FridayWorkflowSpecV1 } from "#workflows";
import { createHash } from "node:crypto";

function computeChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

let idCounter = 0;
function idGenerator(): string {
  return `test-id-${String(++idCounter).padStart(4, "0")}`;
}

function makeMinimalSpec(
  overrides: Partial<FridayWorkflowSpecV1> = {},
): FridayWorkflowSpecV1 {
  return {
    schemaVersion: "1.0",
    workflowId: "wf-1",
    name: "Test Workflow",
    description: "A test workflow",
    startStepId: "step1",
    trigger: { type: "manual" },
    inputs: [],
    steps: [
      { id: "step1", type: "skill_call", ref: "my-skill" },
    ],
    edges: [],
    outputs: [],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    ...overrides,
  };
}

describe("FridayWorkflowCompiler", () => {
  const compiler = createFridayWorkflowCompiler({
    computeChecksum,
    idGenerator,
  });

  beforeEach(() => {
    idCounter = 0;
  });

  it("compiles minimal spec into valid CompiledWorkflowGraphV2", () => {
    const result = compiler.compile(makeMinimalSpec(), "wv-1");
    expect(result.schemaVersion).toBe("2.0");
    expect(result.workflowId).toBe("wf-1");
    expect(result.workflowVersionId).toBe("wv-1");
    expect(result.graph.nodes.length).toBeGreaterThanOrEqual(2); // trigger + step1
    expect(result.checksum).toBeTruthy();
  });

  it("maps step types correctly", () => {
    const spec = makeMinimalSpec({
      startStepId: "s1",
      steps: [
        { id: "s1", type: "skill_call", ref: "skill-a" },
        { id: "s2", type: "tool_call", ref: "tool-b" },
        { id: "s3", type: "condition", condition: "$inputs.x == 1" },
        { id: "s4", type: "transform" },
        { id: "s5", type: "human_approval" },
      ],
      edges: [
        { from: "s1", to: "s2" },
        { from: "s2", to: "s3" },
        { from: "s3", to: "s4", when: "true" },
        { from: "s3", to: "s5", when: "false" },
      ],
    });

    const result = compiler.compile(spec, "wv-1");
    const nodeMap = new Map(result.graph.nodes.map((n) => [n.id, n]));

    expect(nodeMap.get("s1")!.type).toBe("action");
    expect(nodeMap.get("s2")!.type).toBe("action");
    expect(nodeMap.get("s3")!.type).toBe("condition");
    expect(nodeMap.get("s4")!.type).toBe("data");
    expect(nodeMap.get("s5")!.type).toBe("approval");
  });

  it("injects trigger node as entry point", () => {
    const result = compiler.compile(makeMinimalSpec(), "wv-1");
    const triggerNode = result.graph.nodes.find((n) => n.type === "trigger");
    expect(triggerNode).toBeDefined();

    // Should have edge from trigger to startStepId
    const triggerEdge = result.graph.edges.find(
      (e) => e.sourceNodeId === triggerNode!.id && e.targetNodeId === "step1",
    );
    expect(triggerEdge).toBeDefined();
  });

  it("maps edge 'when' to condition expressions", () => {
    const spec = makeMinimalSpec({
      steps: [
        { id: "step1", type: "condition", condition: "$inputs.ok == true" },
        { id: "step2", type: "skill_call", ref: "a" },
        { id: "step3", type: "skill_call", ref: "b" },
      ],
      edges: [
        { from: "step1", to: "step2", when: "true" },
        { from: "step1", to: "step3", when: "false" },
      ],
    });

    const result = compiler.compile(spec, "wv-1");

    const trueEdge = result.graph.edges.find(
      (e) => e.sourceNodeId === "step1" && e.targetNodeId === "step2",
    );
    const falseEdge = result.graph.edges.find(
      (e) => e.sourceNodeId === "step1" && e.targetNodeId === "step3",
    );

    expect(trueEdge?.condition).toContain("result == true");
    expect(falseEdge?.condition).toContain("result == false");
  });

  it("maps retry policy", () => {
    const spec = makeMinimalSpec({
      steps: [
        {
          id: "step1",
          type: "skill_call",
          ref: "my-skill",
          retry: { maxAttempts: 3, backoffMs: 1000 },
        },
      ],
    });

    const result = compiler.compile(spec, "wv-1");
    const node = result.graph.nodes.find((n) => n.id === "step1");
    expect(node?.retryPolicy).toEqual({
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 8000,
      retryOn: ["NODE_EXECUTION_FAILED", "NODE_TIMEOUT"],
    });
  });

  it("maps timeout", () => {
    const spec = makeMinimalSpec({
      steps: [
        { id: "step1", type: "skill_call", ref: "my-skill", timeoutSec: 30 },
      ],
    });

    const result = compiler.compile(spec, "wv-1");
    const node = result.graph.nodes.find((n) => n.id === "step1");
    expect(node?.timeoutMs).toBe(30000);
  });

  it("produces deterministic checksum for same input", () => {
    idCounter = 0;
    const r1 = compiler.compile(makeMinimalSpec(), "wv-1");
    idCounter = 0;
    const r2 = compiler.compile(makeMinimalSpec(), "wv-1");
    expect(r1.checksum).toBe(r2.checksum);
  });

  it("rejects spec that would produce an invalid graph", () => {
    const spec = makeMinimalSpec({
      startStepId: "nonexistent",
      steps: [{ id: "step1", type: "skill_call", ref: "s" }],
    });

    expect(() => compiler.compile(spec, "wv-1")).toThrow();
  });

  it("preserves test cases", () => {
    const spec = makeMinimalSpec({
      tests: [
        {
          name: "test-1",
          description: "A test",
          inputs: { x: 1 },
          assertions: [{ path: "output.x", operator: "==", expected: 1 }],
        },
      ],
    });

    const result = compiler.compile(spec, "wv-1");
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0]!.name).toBe("test-1");
  });

  it("compiles schedule trigger", () => {
    const spec = makeMinimalSpec({
      trigger: { type: "schedule", cron: "0 * * * *", timezone: "UTC" },
    });

    const result = compiler.compile(spec, "wv-1");
    const triggerNode = result.graph.nodes.find((n) => n.type === "trigger");
    expect(triggerNode?.config.triggerType).toBe("schedule");
    expect(triggerNode?.config.cron).toBe("0 * * * *");
    expect(triggerNode?.config.timezone).toBe("UTC");
  });
});
