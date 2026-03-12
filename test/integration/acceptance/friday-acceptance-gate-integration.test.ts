/**
 * Integration tests for the acceptance gate — verifying that acceptance
 * tests are enforced as mandatory backend gates in the execution pipeline.
 *
 * Tests verify:
 * - Acceptance gate blocks output when tests fail
 * - Acceptance gate passes output when tests succeed
 * - Fail-closed behavior on runner errors
 * - Gate can be disabled (bypass mode)
 * - Integration with the NodeRunner facade
 */

import { describe, it, expect, vi } from "vitest";
import {
  createAcceptanceGate,
  AcceptanceTestSuiteRunner,
  InMemoryTestRegistry,
} from "#acceptance";
import type {
  FridayAcceptancePipelineContext,
  FridayAcceptanceTest,
  FridayAcceptanceArtifactType,
} from "../../../src/acceptance/model/friday-acceptance.types.js";
import type { UUID } from "../../../src/rules/model/friday-rules-engine.types.js";
import type { FridayNodeArtifact } from "../../../src/node-runner/model/friday-node-runner.types.js";

// ─── Test Helpers ───

function makeArtifact(type: string = "json"): FridayNodeArtifact {
  return {
    artifactType: type as FridayNodeArtifact["artifactType"],
    uri: `artifact://${type}/test-output`,
    metadata: { content: { data: "test-data", score: 85 } },
  };
}

function makePipelineContext(overrides: Partial<FridayAcceptancePipelineContext> = {}): FridayAcceptancePipelineContext {
  return {
    executionId: "exec-1" as UUID,
    runId: "run-1" as UUID,
    workflowId: "wf-1" as UUID,
    nodeId: "node-1",
    validatedOutput: { data: "test-data", score: 85 },
    artifacts: [makeArtifact("json")],
    ...overrides,
  };
}

function makeAcceptanceTest(overrides: Partial<FridayAcceptanceTest> = {}): FridayAcceptanceTest {
  return {
    id: `test-${Math.random().toString(36).slice(2, 8)}` as UUID,
    name: "Test Check",
    artifactType: "json" as FridayAcceptanceArtifactType,
    checkConfig: {
      checkType: "quantitative",
      metricPath: "score",
      operator: "gte",
      threshold: 50,
    },
    priority: 1,
    enabled: true,
    shortCircuit: false,
    tags: [],
    version: 1,
    etag: "test-etag",
    createdAt: "2026-02-25T00:00:00.000Z",
    updatedAt: "2026-02-25T00:00:00.000Z",
    ...overrides,
  } as FridayAcceptanceTest;
}

// ─── Tests ───

describe("Acceptance Gate Integration", () => {
  describe("Gate enabled — enforcement mode", () => {
    it("passes when no tests are registered (no artifacts to test)", async () => {
      const gate = createAcceptanceGate({ enabled: true });
      const context = makePipelineContext({ artifacts: [] });

      const result = await gate.evaluate(context);

      expect(result.passed).toBe(true);
    });

    it("fails when registered acceptance test fails", async () => {
      const registry = new InMemoryTestRegistry();
      // Register a schema test that requires a field that doesn't exist
      registry.register(makeAcceptanceTest({
        name: "Score Threshold",
        checkConfig: {
          checkType: "quantitative",
          metricPath: "score",
          operator: "gte",
          threshold: 100, // Will fail since score is 85
        },
      }));
      // Add mandatory schema gate to satisfy fail-closed gate requirement
      registry.register(makeAcceptanceTest({
        id: "schema-gate" as UUID,
        name: "Schema Gate",
        priority: 0,
        checkConfig: {
          checkType: "schema",
          schema: { type: "object" },
        },
      }));
      // Add mandatory quality gate
      registry.register(makeAcceptanceTest({
        id: "quality-gate" as UUID,
        name: "Quality Gate",
        priority: 0,
        checkConfig: {
          checkType: "quality",
          dimension: "completeness",
          minScore: 0,
        },
      }));

      const runner = new AcceptanceTestSuiteRunner({ registry });
      const gate = createAcceptanceGate({ enabled: true, runner });
      const context = makePipelineContext();

      const result = await gate.evaluate(context);

      expect(result.passed).toBe(false);
      expect(result.errorMessage).toContain("Acceptance gate failed");
    });

    it("passes when all registered acceptance tests pass", async () => {
      const registry = new InMemoryTestRegistry();
      // Register all three mandatory gate classes with passing thresholds
      registry.register(makeAcceptanceTest({
        id: "schema-gate" as UUID,
        name: "Schema Gate",
        priority: 0,
        checkConfig: {
          checkType: "schema",
          schema: { type: "object" },
        },
      }));
      registry.register(makeAcceptanceTest({
        id: "quant-gate" as UUID,
        name: "Quant Gate",
        priority: 1,
        checkConfig: {
          checkType: "quantitative",
          metricPath: "score",
          operator: "gte",
          threshold: 50,
        },
      }));
      registry.register(makeAcceptanceTest({
        id: "quality-gate" as UUID,
        name: "Quality Gate",
        priority: 2,
        checkConfig: {
          checkType: "quality",
          dimension: "completeness",
          minScore: 0,
        },
      }));

      const runner = new AcceptanceTestSuiteRunner({ registry });
      const gate = createAcceptanceGate({ enabled: true, runner });
      const context = makePipelineContext();

      const result = await gate.evaluate(context);

      expect(result.passed).toBe(true);
      expect(result.pipelineResult).not.toBeNull();
    });
  });

  describe("Gate disabled — bypass mode", () => {
    it("always passes when disabled", async () => {
      const gate = createAcceptanceGate({ enabled: false });
      const context = makePipelineContext();

      const result = await gate.evaluate(context);

      expect(result.passed).toBe(true);
      expect(result.pipelineResult).toBeNull();
    });
  });

  describe("Fail-closed behavior", () => {
    it("rejects output when runner throws an error", async () => {
      const runner = new AcceptanceTestSuiteRunner();
      // Mock runPipeline to throw
      vi.spyOn(runner, "runPipeline").mockRejectedValue(new Error("Runner crashed"));

      const gate = createAcceptanceGate({ enabled: true, runner });
      const context = makePipelineContext();

      const result = await gate.evaluate(context);

      expect(result.passed).toBe(false);
      expect(result.errorMessage).toContain("fail-closed");
      expect(result.errorMessage).toContain("Runner crashed");
    });
  });

  describe("Registry access", () => {
    it("exposes test registry for dynamic test registration", () => {
      const gate = createAcceptanceGate({ enabled: true });
      expect(gate.registry).toBeDefined();
      expect(typeof gate.registry.register).toBe("function");
    });

    it("exposes runner for direct access", () => {
      const gate = createAcceptanceGate({ enabled: true });
      expect(gate.runner).toBeDefined();
      expect(gate.runner).toBeInstanceOf(AcceptanceTestSuiteRunner);
    });
  });
});
