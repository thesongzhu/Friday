import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { precompileRegexPattern } from "../../../rules/engine/condition-evaluator.js";
import type { FridayWorkflowSpecTestCase, FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type {
  FridayWorkflowTestAssertionResult,
  FridayWorkflowTestCaseResult,
  FridayWorkflowTestCaseStatus,
  FridayWorkflowTestRunResult,
} from "../model/friday-workflow-builder-test.types.js";
import type { FridayWorkflowBuilderTestRunRepository } from "../persistence/friday-workflow-builder-test-run-repository.js";

// ─── Interface ───

export interface FridayWorkflowBuilderTestRunnerService {
  runTests(input: {
    spec: FridayWorkflowSpecV1;
    draftId?: string;
    persist?: boolean;
  }): FridayWorkflowTestRunResult;

  runSingleTest(input: {
    spec: FridayWorkflowSpecV1;
    testName: string;
  }): FridayWorkflowTestCaseResult;
}

// ─── Dependencies ───

export interface CreateTestRunnerServiceDeps {
  db: FridaySqliteLayer;
  testRunRepo: FridayWorkflowBuilderTestRunRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Assertion Evaluator ───

function resolveValue(data: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = data;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function evaluateAssertion(
  data: Record<string, unknown>,
  assertion: { path: string; operator: string; expected: unknown },
): FridayWorkflowTestAssertionResult {
  const actual = resolveValue(data, assertion.path);

  let passed = false;
  switch (assertion.operator) {
    case "==":
      passed = actual === assertion.expected;
      break;
    case "!=":
      passed = actual !== assertion.expected;
      break;
    case ">":
      passed = Number(actual) > Number(assertion.expected);
      break;
    case "<":
      passed = Number(actual) < Number(assertion.expected);
      break;
    case "contains":
      if (typeof actual === "string" && typeof assertion.expected === "string") {
        passed = actual.includes(assertion.expected);
      } else if (Array.isArray(actual)) {
        passed = actual.includes(assertion.expected);
      }
      break;
    case "matches":
      if (typeof actual === "string" && typeof assertion.expected === "string") {
        try {
          passed = precompileRegexPattern(assertion.expected).test(actual);
        } catch {
          passed = false;
        }
      }
      break;
  }

  return {
    path: assertion.path,
    operator: assertion.operator as FridayWorkflowTestAssertionResult["operator"],
    expected: assertion.expected,
    actual,
    passed,
    message: passed ? undefined : `Expected ${assertion.path} ${assertion.operator} ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(actual)}`,
  };
}

// ─── Simulate workflow execution ───

// ─── Edge Condition Evaluator ───

function evaluateEdgeCondition(
  edge: { from: string; to: string; when?: string },
  stepOutputs: Record<string, Record<string, unknown>>,
  mocks?: Record<string, { output: Record<string, unknown>; status?: string }>,
): boolean {
  if (!edge.when) return true; // unconditional

  const mock = mocks?.[edge.from];
  const status = mock?.status ?? "completed";
  const output = stepOutputs[edge.from] ?? {};

  switch (edge.when) {
    case "success":
      return status !== "failed";
    case "failure":
      return status === "failed";
    case "true":
      return output.result === true;
    case "false":
      return output.result === false;
    default:
      return true;
  }
}

function simulateWorkflow(
  spec: FridayWorkflowSpecV1,
  testCase: FridayWorkflowSpecTestCase,
): Record<string, unknown> {
  const stepOutputs: Record<string, Record<string, unknown>> = {};

  // Build edge list per source step (preserving edge metadata)
  const edgesFrom = new Map<string, Array<{ to: string; when?: string }>>();
  for (const step of spec.steps) {
    edgesFrom.set(step.id, []);
  }
  for (const edge of spec.edges) {
    const list = edgesFrom.get(edge.from) ?? [];
    list.push({ to: edge.to, when: edge.when });
    edgesFrom.set(edge.from, list);
  }

  // BFS from startStepId with edge-condition evaluation
  const visited = new Set<string>();
  const queue = [spec.startStepId];

  while (queue.length > 0) {
    const stepId = queue.shift()!;
    if (visited.has(stepId)) continue;
    visited.add(stepId);

    // Get mock or generate no-op output
    if (testCase.mocks && testCase.mocks[stepId]) {
      stepOutputs[stepId] = testCase.mocks[stepId].output;
    } else {
      stepOutputs[stepId] = {};
    }

    // Add successors whose edge conditions are satisfied
    for (const edge of edgesFrom.get(stepId) ?? []) {
      if (
        !visited.has(edge.to) &&
        evaluateEdgeCondition(
          { from: stepId, to: edge.to, when: edge.when },
          stepOutputs,
          testCase.mocks,
        )
      ) {
        queue.push(edge.to);
      }
    }
  }

  // Build result context
  return {
    inputs: testCase.inputs,
    steps: Object.fromEntries(
      Object.entries(stepOutputs).map(([id, output]) => [
        id,
        { output, status: testCase.mocks?.[id]?.status ?? "completed" },
      ]),
    ),
    outputs: Object.fromEntries(
      spec.outputs.map((o) => [o.key, resolveValue(stepOutputs[o.fromStep] ?? {}, o.path)]),
    ),
  };
}

// ─── Factory ───

export function createFridayWorkflowBuilderTestRunnerService(
  deps: CreateTestRunnerServiceDeps,
): FridayWorkflowBuilderTestRunnerService {
  function runOneTest(
    spec: FridayWorkflowSpecV1,
    testCase: FridayWorkflowSpecTestCase,
  ): FridayWorkflowTestCaseResult {
    const startTime = Date.now();

    try {
      const context = simulateWorkflow(spec, testCase);
      const assertionResults = testCase.assertions.map((a) =>
        evaluateAssertion(context as Record<string, unknown>, a),
      );

      const allPassed = assertionResults.every((r) => r.passed);
      const status: FridayWorkflowTestCaseStatus = allPassed ? "passed" : "failed";

      return {
        name: testCase.name,
        status,
        durationMs: Date.now() - startTime,
        assertionResults,
      };
    } catch (err) {
      return {
        name: testCase.name,
        status: "failed",
        durationMs: Date.now() - startTime,
        assertionResults: [],
        error: {
          code: "TEST_EXECUTION_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return {
    runTests(input) {
      const startedAt = deps.nowIso();
      const caseResults = input.spec.tests.map((testCase) =>
        runOneTest(input.spec, testCase),
      );
      const finishedAt = deps.nowIso();
      const passed = caseResults.every((r) => r.status === "passed");

      const result: FridayWorkflowTestRunResult = {
        runId: deps.idGenerator(),
        workflowId: input.spec.workflowId,
        draftId: input.draftId,
        startedAt,
        finishedAt,
        passed,
        caseResults,
      };

      if (input.persist) {
        deps.db.withWriteTransaction((db) => {
          deps.testRunRepo.create(db, result);
        });
      }

      return result;
    },

    runSingleTest(input) {
      const testCase = input.spec.tests.find((t) => t.name === input.testName);
      if (!testCase) throw new FridayDomainError("TEST_CASE_NOT_FOUND", "Test case not found", { httpStatus: 404 });
      return runOneTest(input.spec, testCase);
    },
  };
}
