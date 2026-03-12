import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowBuilderTestRunnerService } from "#workflows";
import { createFridayWorkflowBuilderTestRunRepository } from "#workflows";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";
import { createTestSpec, createTestSpecWithEdge } from "./_helpers/create-test-spec.helper.js";

describe("FridayWorkflowBuilderTestRunnerService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    const idGen = createTestIdGenerator();
    return createFridayWorkflowBuilderTestRunnerService({
      db,
      testRunRepo: createFridayWorkflowBuilderTestRunRepository(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  }

  it("runs all tests and returns results", () => {
    const service = createService();
    const spec = createTestSpecWithEdge();

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
    expect(result.caseResults).toHaveLength(1);
    expect(result.caseResults[0]!.status).toBe("passed");
  });

  it("reports failed assertion", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "failing test",
          inputs: {},
          mocks: { "step-1": { output: { value: "wrong" } } },
          assertions: [
            { path: "steps.step-1.output.value", operator: "==", expected: "correct" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(false);
    expect(result.caseResults[0]!.status).toBe("failed");
    expect(result.caseResults[0]!.assertionResults[0]!.passed).toBe(false);
    expect(result.caseResults[0]!.assertionResults[0]!.actual).toBe("wrong");
    expect(result.caseResults[0]!.assertionResults[0]!.expected).toBe("correct");
  });

  it("handles != operator", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "not equal test",
          inputs: {},
          mocks: { "step-1": { output: { value: "a" } } },
          assertions: [
            { path: "steps.step-1.output.value", operator: "!=", expected: "b" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("handles > operator", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "greater than test",
          inputs: {},
          mocks: { "step-1": { output: { count: 10 } } },
          assertions: [
            { path: "steps.step-1.output.count", operator: ">", expected: 5 },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("handles < operator", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "less than test",
          inputs: {},
          mocks: { "step-1": { output: { count: 3 } } },
          assertions: [
            { path: "steps.step-1.output.count", operator: "<", expected: 5 },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("handles contains operator for strings", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "contains test",
          inputs: {},
          mocks: { "step-1": { output: { message: "hello world" } } },
          assertions: [
            { path: "steps.step-1.output.message", operator: "contains", expected: "world" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("handles matches operator", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "matches test",
          inputs: {},
          mocks: { "step-1": { output: { code: "ERR-123" } } },
          assertions: [
            { path: "steps.step-1.output.code", operator: "matches", expected: "^ERR-\\d+$" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("unmocked steps return empty output", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "unmocked test",
          inputs: {},
          assertions: [
            { path: "steps.step-1.status", operator: "==", expected: "completed" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("persists test results when requested", () => {
    const service = createService();
    const testRunRepo = createFridayWorkflowBuilderTestRunRepository();
    const spec = createTestSpecWithEdge();

    const result = service.runTests({ spec, draftId: "draft-1", persist: true });

    const stored = db.withReadConnection((readerDb) =>
      testRunRepo.getById(readerDb, result.runId),
    );
    expect(stored).not.toBeNull();
    expect(stored!.passed).toBe(result.passed);
  });

  it("does not persist when not requested", () => {
    const service = createService();
    const testRunRepo = createFridayWorkflowBuilderTestRunRepository();
    const spec = createTestSpecWithEdge();

    const result = service.runTests({ spec });

    const stored = db.withReadConnection((readerDb) =>
      testRunRepo.getById(readerDb, result.runId),
    );
    expect(stored).toBeNull();
  });

  it("runSingleTest runs only the named test", () => {
    const service = createService();
    const spec = createTestSpecWithEdge({
      tests: [
        {
          name: "test-a",
          inputs: { data: "a" },
          mocks: { "step-1": { output: {} }, "step-2": { output: { output: "a" } } },
          assertions: [{ path: "steps.step-2.output.output", operator: "==", expected: "a" }],
        },
        {
          name: "test-b",
          inputs: { data: "b" },
          mocks: { "step-1": { output: {} }, "step-2": { output: { output: "b" } } },
          assertions: [{ path: "steps.step-2.output.output", operator: "==", expected: "b" }],
        },
      ],
    });

    const result = service.runSingleTest({ spec, testName: "test-b" });
    expect(result.name).toBe("test-b");
    expect(result.status).toBe("passed");
  });

  it("runSingleTest throws for unknown test name", () => {
    const service = createService();
    const spec = createTestSpec();

    expect(() =>
      service.runSingleTest({ spec, testName: "nonexistent" }),
    ).toThrow("Test case not found");
  });

  it("records duration for each test case", () => {
    const service = createService();
    const spec = createTestSpecWithEdge();

    const result = service.runTests({ spec });
    expect(result.caseResults[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ─── Edge condition evaluation tests ───

  it("follows success edge when step succeeds", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "a" },
        { id: "step-success", type: "skill_call", ref: "b" },
        { id: "step-failure", type: "skill_call", ref: "c" },
      ],
      edges: [
        { from: "step-1", to: "step-success", when: "success" },
        { from: "step-1", to: "step-failure", when: "failure" },
      ],
      tests: [
        {
          name: "success path",
          inputs: {},
          mocks: {
            "step-1": { output: { value: "ok" }, status: "completed" },
            "step-success": { output: { reached: true } },
            "step-failure": { output: { reached: true } },
          },
          assertions: [
            { path: "steps.step-success.output.reached", operator: "==", expected: true },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
    // step-failure should NOT have been visited
    expect(result.caseResults[0]!.assertionResults[0]!.passed).toBe(true);
  });

  it("follows failure edge when step fails", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "a" },
        { id: "step-success", type: "skill_call", ref: "b" },
        { id: "step-failure", type: "skill_call", ref: "c" },
      ],
      edges: [
        { from: "step-1", to: "step-success", when: "success" },
        { from: "step-1", to: "step-failure", when: "failure" },
      ],
      tests: [
        {
          name: "failure path",
          inputs: {},
          mocks: {
            "step-1": { output: { value: "bad" }, status: "failed" },
            "step-success": { output: { reached: true } },
            "step-failure": { output: { error: "oops" } },
          },
          assertions: [
            { path: "steps.step-failure.output.error", operator: "==", expected: "oops" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("skips success edge when step fails", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "a" },
        { id: "step-success", type: "skill_call", ref: "b" },
      ],
      edges: [
        { from: "step-1", to: "step-success", when: "success" },
      ],
      tests: [
        {
          name: "skip success when failed",
          inputs: {},
          mocks: {
            "step-1": { output: {}, status: "failed" },
            "step-success": { output: { val: "should not see" } },
          },
          assertions: [
            // step-success should NOT be visited, so its output should be undefined
            { path: "steps.step-success.output.val", operator: "==", expected: undefined },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("follows true edge when condition evaluates to true", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "condition", ref: "cond" },
        { id: "step-true", type: "skill_call", ref: "a" },
        { id: "step-false", type: "skill_call", ref: "b" },
      ],
      edges: [
        { from: "step-1", to: "step-true", when: "true" },
        { from: "step-1", to: "step-false", when: "false" },
      ],
      tests: [
        {
          name: "true branch",
          inputs: {},
          mocks: {
            "step-1": { output: { result: true } },
            "step-true": { output: { taken: "yes" } },
            "step-false": { output: { taken: "no" } },
          },
          assertions: [
            { path: "steps.step-true.output.taken", operator: "==", expected: "yes" },
            // step-false should not be visited
            { path: "steps.step-false.output.taken", operator: "==", expected: undefined },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("follows false edge when condition evaluates to false", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "condition", ref: "cond" },
        { id: "step-true", type: "skill_call", ref: "a" },
        { id: "step-false", type: "skill_call", ref: "b" },
      ],
      edges: [
        { from: "step-1", to: "step-true", when: "true" },
        { from: "step-1", to: "step-false", when: "false" },
      ],
      tests: [
        {
          name: "false branch",
          inputs: {},
          mocks: {
            "step-1": { output: { result: false } },
            "step-true": { output: { taken: "yes" } },
            "step-false": { output: { taken: "no" } },
          },
          assertions: [
            { path: "steps.step-false.output.taken", operator: "==", expected: "no" },
            // step-true should not be visited
            { path: "steps.step-true.output.taken", operator: "==", expected: undefined },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });
});
