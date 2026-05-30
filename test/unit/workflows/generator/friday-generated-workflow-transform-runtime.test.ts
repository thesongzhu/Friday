import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createFridayExpressionEvaluator,
  createFridayWorkflowCompiler,
  createFridayWorkflowNodeExecutor,
} from "#workflows";
import type {
  FridayExpressionContext,
  FridayWorkflowNode,
  FridayWorkflowSpecV1,
} from "#workflows";

/**
 * Frozen corpus, deterministic (no live generation), output-VALUE oracles.
 *
 * Replays the data-node transform shapes the DeepSeek workflow generator emits
 * through the REAL compiler + node executor and asserts the produced output
 * value — not merely run-to-completion. This isolates the deterministic
 * runtime-correctness property (mergeable) from generation reliability (live,
 * nondeterministic, out of scope here). It also pins the current capability
 * BOUNDARY: arithmetic / function-call transforms still fail-closed at run, which
 * is the documented product-direction follow-up (richer evaluator vs constrained
 * generator) — NOT silently passed.
 */

let idCounter = 0;
const idGenerator = () => `id-${++idCounter}`;
const computeChecksum = (content: string) =>
  createHash("sha256").update(content).digest("hex");

const compiler = createFridayWorkflowCompiler({ computeChecksum, idGenerator });
const expressionEvaluator = createFridayExpressionEvaluator();
const nodeExecutor = createFridayWorkflowNodeExecutor({
  expressionEvaluator,
  resolveSkill: () => ({ manifest: {} }),
  invokeSkill: async (_id, _runId, _nodeId, payload) => payload,
  nowIso: () => "2026-01-01T00:00:00.000Z",
});

function specWithTransform(args: Record<string, unknown>): FridayWorkflowSpecV1 {
  return {
    schemaVersion: "1.0",
    workflowId: "wf-corpus",
    name: "Transform Corpus Workflow",
    description: "Single transform step",
    startStepId: "t1",
    trigger: { type: "manual" },
    inputs: [],
    steps: [{ id: "t1", type: "transform", args } as never],
    edges: [],
    outputs: [],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
  };
}

async function compileAndRunTransform(
  args: Record<string, unknown>,
  ctx: FridayExpressionContext,
): Promise<unknown> {
  const graph = compiler.compile(specWithTransform(args), "wv-corpus");
  const dataNode = graph.graph.nodes.find((node) => node.type === "data");
  if (!dataNode) {
    throw new Error("compiler did not emit a data node for the transform step");
  }
  const node: FridayWorkflowNode = {
    id: dataNode.id,
    type: "data",
    label: dataNode.label ?? "Data",
    config: dataNode.config as Record<string, never>,
  };
  const result = await nodeExecutor.executeNode({
    runId: "run-corpus",
    nodeId: node.id,
    attemptId: "att-1",
    node,
    inputData: {},
    expressionContext: ctx,
  });
  return result.output;
}

const EMPTY_CTX: FridayExpressionContext = { inputs: {}, steps: {} };

describe("generated-workflow transform runtime corpus (compile + execute, output oracles)", () => {
  it("object-literal STRING transform (constant) → exact object value", async () => {
    const out = await compileAndRunTransform(
      { transform: '{ "text": "hello world" }' },
      EMPTY_CTX,
    );
    expect(out).toEqual({ text: "hello world" });
  });

  it("object-literal STRING transform with $-ref → ref resolved (anti-constant proof)", async () => {
    const out = await compileAndRunTransform(
      { transform: '{"greeting": "$inputs.name", "kind": "card"}' },
      { inputs: { name: "Ada" }, steps: {} },
    );
    expect(out).toEqual({ greeting: "Ada", kind: "card" });
  });

  it("object-literal STRING transform mixing step-ref + literal → correct value", async () => {
    const out = await compileAndRunTransform(
      { transform: '{"total": "$steps.calc.output.sum", "label": "report"}' },
      { inputs: {}, steps: { calc: { output: { sum: 7 } } } },
    );
    expect(out).toEqual({ total: 7, label: "report" });
  });

  it("plain ref-expression STRING transform → preserved (evaluator path)", async () => {
    const out = await compileAndRunTransform(
      { transform: "$inputs.value" },
      { inputs: { value: 99 }, steps: {} },
    );
    expect(out).toBe(99);
  });

  it("BOUNDARY: arithmetic transform still fails-closed at run (documented follow-up)", async () => {
    await expect(
      compileAndRunTransform(
        { transform: "$inputs.a + $inputs.b" },
        { inputs: { a: 1, b: 2 }, steps: {} },
      ),
    ).rejects.toThrow(/EXPRESSION_PARSE_ERROR/);
  });

  it("BOUNDARY: function-call transform still fails-closed at run (documented follow-up)", async () => {
    await expect(
      compileAndRunTransform(
        { transform: "sum($inputs.a, $inputs.b)" },
        { inputs: { a: 1, b: 2 }, steps: {} },
      ),
    ).rejects.toThrow(/EXPRESSION_PARSE_ERROR/);
  });
});
