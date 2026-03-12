import { describe, it, expect, vi } from "vitest";

import { NodeRunnerPipeline, createNodeRunnerPipeline } from "../../../../src/node-runner/engine/node-runner-pipeline.js";
import { NodeAdapterRegistry } from "../../../../src/node-runner/engine/adapter-registry.js";

import type {
  FridayNodeAdapter,
  FridayNodeAdapterRegistry,
  FridayNodeExecutionContext,
  FridayNodeRunnerPipelineConfig,
  FridayValidationResult,
} from "../../../../src/node-runner/model/friday-node-runner.types.js";

import type { FridayEvaluationResult } from "../../../../src/rules/model/friday-rules-engine.types.js";

import type { FridayWorkflowNode } from "../../../../src/workflows/model/friday-workflow-graph.types.js";

// ─── Test Helpers ───

function createTestNode(overrides?: Partial<FridayWorkflowNode>): FridayWorkflowNode {
  return {
    id: "node-1",
    type: "action",
    label: "Test Node",
    config: { actionType: "tool" },
    ...overrides,
  };
}

function createTestContext(overrides?: Partial<FridayNodeExecutionContext>): FridayNodeExecutionContext {
  return {
    executionId: "exec-1",
    runId: "run-1",
    workflowId: "wf-1",
    nodeId: "node-1",
    attemptNumber: 1,
    node: createTestNode(),
    inputData: { url: "https://example.com" },
    startedAt: "2026-02-24T00:00:00.000Z",
    metadata: {},
    timeoutMs: 5000,
    ...overrides,
  };
}

function createAllowResult(): FridayEvaluationResult {
  return {
    evaluationId: "eval-1",
    decision: "allow",
    matchedRules: [],
    durationMs: 1,
    allowed: true,
    evaluatedAt: "2026-02-24T00:00:00.000Z",
  };
}

function createDenyResult(message = "Denied by policy"): FridayEvaluationResult {
  return {
    evaluationId: "eval-deny",
    decision: "deny",
    matchedRules: [{
      ruleId: "rule-1",
      ruleName: "deny-rule",
      policyBundleId: "bundle-1",
      decision: "deny",
      message,
      priority: 1,
    }],
    message,
    durationMs: 1,
    allowed: false,
    evaluatedAt: "2026-02-24T00:00:00.000Z",
  };
}

function createMockAdapter(overrides?: Partial<FridayNodeAdapter>): FridayNodeAdapter {
  return {
    nodeType: "action:tool",
    load: vi.fn().mockResolvedValue({ resolved: true }),
    validateInput: vi.fn().mockReturnValue({ valid: true, errors: [] }),
    execute: vi.fn().mockResolvedValue({ result: "success" }),
    validateOutput: vi.fn().mockReturnValue({ valid: true, errors: [] }),
    ...overrides,
  };
}

function createPipelineConfig(overrides?: Partial<FridayNodeRunnerPipelineConfig>): FridayNodeRunnerPipelineConfig {
  const registry = new NodeAdapterRegistry();
  const adapter = createMockAdapter();
  registry.register(adapter);

  return {
    adapterRegistry: registry,
    defaultTimeoutMs: 5000,
    evaluateRules: vi.fn().mockResolvedValue(createAllowResult()),
    generateId: () => "generated-id",
    nowIso: () => "2026-02-24T00:00:01.000Z",
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tests ───

describe("NodeRunnerPipeline", () => {
  describe("constructor", () => {
    it("throws without adapterRegistry", () => {
      expect(
        () => new NodeRunnerPipeline({
          adapterRegistry: undefined as unknown as FridayNodeAdapterRegistry,
          defaultTimeoutMs: 5000,
          evaluateRules: vi.fn(),
          generateId: () => "id",
          nowIso: () => "now",
        }),
      ).toThrow("adapterRegistry");
    });

    it("throws without evaluateRules (fail-closed)", () => {
      expect(
        () => new NodeRunnerPipeline({
          adapterRegistry: new NodeAdapterRegistry(),
          defaultTimeoutMs: 5000,
          evaluateRules: undefined as unknown as FridayNodeRunnerPipelineConfig["evaluateRules"],
          generateId: () => "id",
          nowIso: () => "now",
        }),
      ).toThrow("evaluateRules");
    });
  });

  describe("happy path — all 6 steps succeed", () => {
    it("returns completed status with output", async () => {
      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const context = createTestContext();

      const result = await pipeline.execute(context);

      expect(result.status).toBe("completed");
      expect(result.executionId).toBe("exec-1");
      expect(result.output).toEqual({ result: "success" });
      expect(result.errorCode).toBeUndefined();
      expect(result.errorMessage).toBeUndefined();
    });

    it("produces 6 step results, all successful", async () => {
      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const result = await pipeline.execute(createTestContext());

      expect(result.stepResults).toHaveLength(6);
      const outcomes = result.stepResults.map((r) => r.outcome);
      expect(outcomes).toEqual(["success", "success", "success", "success", "success", "success"]);
    });

    it("step names are in correct order", async () => {
      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const result = await pipeline.execute(createTestContext());

      const steps = result.stepResults.map((r) => r.step);
      expect(steps).toEqual(["load", "pre-validate", "pre-rules", "execute", "post-validate", "post-rules"]);
    });

    it("sets timestamps and duration", async () => {
      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const result = await pipeline.execute(createTestContext());

      expect(result.startedAt).toBe("2026-02-24T00:00:00.000Z");
      expect(result.completedAt).toBe("2026-02-24T00:00:01.000Z");
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("calls evaluateRules twice (pre and post)", async () => {
      const evaluateRules = vi.fn().mockResolvedValue(createAllowResult());
      const config = createPipelineConfig({ evaluateRules });
      const pipeline = new NodeRunnerPipeline(config);
      await pipeline.execute(createTestContext());

      expect(evaluateRules).toHaveBeenCalledTimes(2);
    });
  });

  describe("Step 1: Load — adapter not found", () => {
    it("fails with NODE_LOAD_FAILED when no adapter matches", async () => {
      const registry = new NodeAdapterRegistry({ registerBuiltIns: false });
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);
      const context = createTestContext();

      const result = await pipeline.execute(context);

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("NODE_LOAD_FAILED");
      expect(result.errorMessage).toContain("No adapter found");
    });

    it("marks remaining steps as skipped", async () => {
      const registry = new NodeAdapterRegistry({ registerBuiltIns: false });
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);
      const result = await pipeline.execute(createTestContext());

      expect(result.stepResults[0].outcome).toBe("failure");
      const skippedSteps = result.stepResults.filter((r) => r.outcome === "skipped");
      expect(skippedSteps).toHaveLength(5);
    });
  });

  describe("Step 1: Load — adapter.load throws", () => {
    it("fails with NODE_LOAD_FAILED", async () => {
      const adapter = createMockAdapter({
        load: vi.fn().mockRejectedValue(new Error("config resolution failed")),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);

      const result = await pipeline.execute(createTestContext());

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("NODE_LOAD_FAILED");
      expect(result.errorMessage).toContain("config resolution failed");
    });
  });

  describe("Step 2: Pre-Validate — input validation fails", () => {
    it("fails with VALIDATION_FAILED", async () => {
      const adapter = createMockAdapter({
        validateInput: vi.fn().mockReturnValue({
          valid: false,
          errors: [{ field: "url", constraint: "required", message: "url is required" }],
        } satisfies FridayValidationResult),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);

      const result = await pipeline.execute(createTestContext());

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("VALIDATION_FAILED");
      expect(result.stepResults[1].validationErrors).toHaveLength(1);
      expect(result.stepResults[1].validationErrors![0].field).toBe("url");
    });

    it("skips steps 3-6", async () => {
      const adapter = createMockAdapter({
        validateInput: vi.fn().mockReturnValue({ valid: false, errors: [{ field: "x", constraint: "type", message: "bad" }] }),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);
      const result = await pipeline.execute(createTestContext());

      expect(result.stepResults[0].outcome).toBe("success"); // load
      expect(result.stepResults[1].outcome).toBe("failure"); // pre-validate
      const skippedCount = result.stepResults.filter((r) => r.outcome === "skipped").length;
      expect(skippedCount).toBe(4);
    });
  });

  describe("Step 3: Pre-Rules — rules deny", () => {
    it("fails with PRE_RULES_DENIED", async () => {
      const evaluateRules = vi.fn().mockResolvedValue(createDenyResult("Blocked by safety policy"));
      const config = createPipelineConfig({ evaluateRules });
      const pipeline = new NodeRunnerPipeline(config);

      const result = await pipeline.execute(createTestContext());

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("PRE_RULES_DENIED");
      expect(result.errorMessage).toContain("Blocked by safety policy");
    });

    it("records rules result on the step", async () => {
      const evaluateRules = vi.fn().mockResolvedValue(createDenyResult());
      const config = createPipelineConfig({ evaluateRules });
      const pipeline = new NodeRunnerPipeline(config);
      const result = await pipeline.execute(createTestContext());

      const preRulesStep = result.stepResults.find((r) => r.step === "pre-rules")!;
      expect(preRulesStep.rulesResult).toBeDefined();
      expect(preRulesStep.rulesResult!.decision).toBe("deny");
    });

    it("does not call adapter.execute when pre-rules deny", async () => {
      const adapter = createMockAdapter();
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const evaluateRules = vi.fn().mockResolvedValue(createDenyResult());
      const config = createPipelineConfig({ adapterRegistry: registry, evaluateRules });
      const pipeline = new NodeRunnerPipeline(config);
      await pipeline.execute(createTestContext());

      expect(adapter.execute).not.toHaveBeenCalled();
    });
  });

  describe("Step 3: Pre-Rules — rules engine throws (fail-closed)", () => {
    it("fails with RULE_EVALUATION_FAILED", async () => {
      const evaluateRules = vi.fn().mockRejectedValue(new Error("engine unavailable"));
      const config = createPipelineConfig({ evaluateRules });
      const pipeline = new NodeRunnerPipeline(config);

      const result = await pipeline.execute(createTestContext());

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("RULE_EVALUATION_FAILED");
      expect(result.errorMessage).toContain("Rules evaluation failed");
    });

    it("fails closed when node type has no rules resource mapping", async () => {
      const registry = new NodeAdapterRegistry();
      registry.register(createMockAdapter({ nodeType: "custom-unmapped" }));
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);
      const unknownNode = {
        ...createTestNode(),
        config: {},
        type: "custom-unmapped",
      } as unknown as FridayWorkflowNode;

      const execution = pipeline.execute(createTestContext({ node: unknownNode }));
      await expect(execution).resolves.toMatchObject({
        status: "failed",
        errorCode: "RULE_EVALUATION_FAILED",
      });
    });
  });

  describe("Step 3: Pre-Rules — warn/audit decisions proceed", () => {
    it("continues execution when decision is warn", async () => {
      const warnResult: FridayEvaluationResult = {
        ...createAllowResult(),
        decision: "warn",
        allowed: true,
      };
      const evaluateRules = vi.fn().mockResolvedValue(warnResult);
      const config = createPipelineConfig({ evaluateRules });
      const pipeline = new NodeRunnerPipeline(config);
      const result = await pipeline.execute(createTestContext());

      expect(result.status).toBe("completed");
    });
  });

  describe("Step 4: Execute — adapter.execute throws", () => {
    it("fails with NODE_EXECUTION_FAILED", async () => {
      const adapter = createMockAdapter({
        execute: vi.fn().mockRejectedValue(new Error("tool invocation error")),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);

      const result = await pipeline.execute(createTestContext());

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("NODE_EXECUTION_FAILED");
      expect(result.errorMessage).toContain("tool invocation error");
    });

    it("has 3 success steps before the failure", async () => {
      const adapter = createMockAdapter({
        execute: vi.fn().mockRejectedValue(new Error("fail")),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);
      const result = await pipeline.execute(createTestContext());

      const successCount = result.stepResults.filter((r) => r.outcome === "success").length;
      const failCount = result.stepResults.filter((r) => r.outcome === "failure").length;
      const skipCount = result.stepResults.filter((r) => r.outcome === "skipped").length;
      expect(successCount).toBe(3);
      expect(failCount).toBe(1);
      expect(skipCount).toBe(2);
    });
  });

  describe("Step 5: Post-Validate — output validation fails", () => {
    it("fails with VALIDATION_FAILED", async () => {
      const adapter = createMockAdapter({
        validateOutput: vi.fn().mockReturnValue({
          valid: false,
          errors: [{ field: "result", constraint: "type", message: "expected string" }],
        }),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);

      const result = await pipeline.execute(createTestContext());

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("VALIDATION_FAILED");
      expect(result.output).toBeUndefined();
    });
  });

  describe("Step 6: Post-Rules — rules deny", () => {
    it("fails with POST_RULES_DENIED and discards output", async () => {
      let callCount = 0;
      const evaluateRules = vi.fn().mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? createAllowResult() : createDenyResult("Output blocked");
      });
      const config = createPipelineConfig({ evaluateRules });
      const pipeline = new NodeRunnerPipeline(config);

      const result = await pipeline.execute(createTestContext());

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("POST_RULES_DENIED");
      expect(result.output).toBeUndefined();
    });
  });

  describe("context enrichment through pipeline", () => {
    it("populates resolvedConfig after load", async () => {
      const adapter = createMockAdapter({
        load: vi.fn().mockResolvedValue({ skill: "http-client", version: 2 }),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);
      const context = createTestContext();

      await pipeline.execute(context);

      expect(context.resolvedConfig).toEqual({ skill: "http-client", version: 2 });
    });

    it("populates validatedInput after pre-validate", async () => {
      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const context = createTestContext({ inputData: { key: "value" } });

      await pipeline.execute(context);

      expect(context.validatedInput).toEqual({ key: "value" });
    });

    it("populates preRulesResult after pre-rules", async () => {
      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const context = createTestContext();

      await pipeline.execute(context);

      expect(context.preRulesResult).toBeDefined();
      expect(context.preRulesResult!.decision).toBe("allow");
    });

    it("populates output after execute", async () => {
      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const context = createTestContext();

      await pipeline.execute(context);

      expect(context.output).toEqual({ result: "success" });
    });

    it("populates validatedOutput after post-validate", async () => {
      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const context = createTestContext();

      await pipeline.execute(context);

      expect(context.validatedOutput).toEqual({ result: "success" });
    });

    it("populates postRulesResult after post-rules", async () => {
      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const context = createTestContext();

      await pipeline.execute(context);

      expect(context.postRulesResult).toBeDefined();
      expect(context.postRulesResult!.decision).toBe("allow");
    });
  });

  describe("abort and timeout handling", () => {
    it("returns cancelled for a pre-aborted signal and never throws", async () => {
      const controller = new AbortController();
      controller.abort(new Error("pre-aborted"));

      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const execution = pipeline.execute(createTestContext({ signal: controller.signal }));

      await expect(execution).resolves.toMatchObject({
        status: "cancelled",
        errorCode: "NODE_CANCELLED",
      });
    });

    it("classifies pre-aborted external DOMException TimeoutError as timeout", async () => {
      const controller = new AbortController();
      controller.abort(new DOMException("external timeout", "TimeoutError"));

      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const execution = pipeline.execute(
        createTestContext({ signal: controller.signal, timeoutMs: 10_000 }),
      );

      await expect(execution).resolves.toMatchObject({
        status: "timed-out",
        errorCode: "NODE_TIMEOUT",
      });
    });

    it("classifies pre-aborted external error named TimeoutError as timeout", async () => {
      const controller = new AbortController();
      const timeoutError = new Error("external timeout");
      timeoutError.name = "TimeoutError";
      controller.abort(timeoutError);

      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const execution = pipeline.execute(
        createTestContext({ signal: controller.signal, timeoutMs: 10_000 }),
      );

      await expect(execution).resolves.toMatchObject({
        status: "timed-out",
        errorCode: "NODE_TIMEOUT",
      });
    });

    it("classifies pre-aborted external signal with timeout marker as timeout", async () => {
      const controller = new AbortController();
      controller.abort({ timeout: true, reason: "external timeout marker" });

      const config = createPipelineConfig();
      const pipeline = new NodeRunnerPipeline(config);
      const execution = pipeline.execute(
        createTestContext({ signal: controller.signal, timeoutMs: 10_000 }),
      );

      await expect(execution).resolves.toMatchObject({
        status: "timed-out",
        errorCode: "NODE_TIMEOUT",
      });
    });

    it("times out during load and never throws", async () => {
      const adapter = createMockAdapter({
        load: vi.fn().mockImplementation(async () => {
          await delay(30);
          return { resolved: true };
        }),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const pipeline = new NodeRunnerPipeline(createPipelineConfig({ adapterRegistry: registry }));
      const execution = pipeline.execute(createTestContext({ timeoutMs: 5 }));

      await expect(execution).resolves.toMatchObject({
        status: "timed-out",
        errorCode: "NODE_TIMEOUT",
      });
    });

    it("times out during pre-validate and never throws", async () => {
      const adapter = createMockAdapter({
        validateInput: vi.fn().mockImplementation(async () => {
          await delay(30);
          return { valid: true, errors: [] };
        }),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const pipeline = new NodeRunnerPipeline(createPipelineConfig({ adapterRegistry: registry }));
      const execution = pipeline.execute(createTestContext({ timeoutMs: 5 }));

      await expect(execution).resolves.toMatchObject({
        status: "timed-out",
        errorCode: "NODE_TIMEOUT",
      });
    });

    it("times out during pre-rules and never throws", async () => {
      const evaluateRules = vi.fn().mockImplementation(async () => {
        await delay(30);
        return createAllowResult();
      });
      const pipeline = new NodeRunnerPipeline(createPipelineConfig({ evaluateRules }));
      const execution = pipeline.execute(createTestContext({ timeoutMs: 5 }));

      await expect(execution).resolves.toMatchObject({
        status: "timed-out",
        errorCode: "NODE_TIMEOUT",
      });
    });

    it("times out when execute exceeds timeout", async () => {
      const adapter = createMockAdapter({
        execute: vi.fn().mockImplementation(async (_ctx, _cfg, _input, signal?: AbortSignal) => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ result: "late" }), 10_000);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        }),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);
      const context = createTestContext({ timeoutMs: 50 });

      const execution = pipeline.execute(context);
      await expect(execution).resolves.toMatchObject({
        status: "timed-out",
        errorCode: "NODE_TIMEOUT",
      });
    }, 10_000);

    it("times out during post-validate and never throws", async () => {
      const adapter = createMockAdapter({
        validateOutput: vi.fn().mockImplementation(async () => {
          await delay(30);
          return { valid: true, errors: [] };
        }),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const pipeline = new NodeRunnerPipeline(createPipelineConfig({ adapterRegistry: registry }));
      const execution = pipeline.execute(createTestContext({ timeoutMs: 10 }));

      await expect(execution).resolves.toMatchObject({
        status: "timed-out",
        errorCode: "NODE_TIMEOUT",
      });
    });

    it("times out during post-rules and never throws", async () => {
      let callCount = 0;
      const evaluateRules = vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          return createAllowResult();
        }
        await delay(30);
        return createAllowResult();
      });
      const pipeline = new NodeRunnerPipeline(createPipelineConfig({ evaluateRules }));
      const execution = pipeline.execute(createTestContext({ timeoutMs: 10 }));

      await expect(execution).resolves.toMatchObject({
        status: "timed-out",
        errorCode: "NODE_TIMEOUT",
      });
    });

    it("cancels deterministically when external signal is aborted", async () => {
      const controller = new AbortController();
      const adapter = createMockAdapter({
        execute: vi.fn().mockImplementation(async (_ctx, _cfg, _input, signal?: AbortSignal) => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ result: "done" }), 10_000);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("cancelled", "AbortError"));
            });
          });
        }),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);
      const execution = pipeline.execute(
        createTestContext({ signal: controller.signal, timeoutMs: 10_000 }),
      );

      setTimeout(() => controller.abort(new Error("cancelled by user")), 30);

      await expect(execution).resolves.toMatchObject({
        status: "cancelled",
        errorCode: "NODE_CANCELLED",
      });
    }, 10_000);
  });

  describe("createNodeRunnerPipeline factory", () => {
    it("creates a working pipeline via factory function", async () => {
      const config = createPipelineConfig();
      const pipeline = createNodeRunnerPipeline(config);
      const result = await pipeline.execute(createTestContext());

      expect(result.status).toBe("completed");
    });
  });

  describe("never throws — errors captured in result", () => {
    it("returns failure result even when adapter load throws sync error", async () => {
      const adapter = createMockAdapter({
        load: vi.fn().mockImplementation(() => { throw new Error("sync boom"); }),
      });
      const registry = new NodeAdapterRegistry();
      registry.register(adapter);
      const config = createPipelineConfig({ adapterRegistry: registry });
      const pipeline = new NodeRunnerPipeline(config);

      const result = await pipeline.execute(createTestContext());

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("sync boom");
    });
  });
});
