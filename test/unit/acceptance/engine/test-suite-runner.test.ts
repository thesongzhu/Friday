import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AcceptanceTestSuiteRunner,
  InMemoryTestRegistry,
} from "../../../../src/acceptance/engine/test-suite-runner.js";
import {
  registerCustomHandler,
  clearCustomHandlers,
} from "../../../../src/acceptance/engine/assertion-engine.js";
import {
  AcceptanceRunState,
  assertAcceptanceRunStateTransition,
} from "../../../../src/acceptance/model/friday-acceptance.types.js";
import type {
  FridayAcceptancePipelineContext,
  FridayAcceptanceRunResult,
  FridayAcceptanceTest,
} from "../../../../src/acceptance/model/friday-acceptance.types.js";
import type { FridayNodeArtifact } from "../../../../src/node-runner/model/friday-node-runner.types.js";
import type {
  FridayEvaluationResult,
  JsonValue,
} from "../../../../src/rules/model/friday-rules-engine.types.js";

// ─── Helpers ───

function makeTest(overrides: Partial<FridayAcceptanceTest> = {}): FridayAcceptanceTest {
  return {
    id: overrides.id ?? "test-1",
    name: overrides.name ?? "Test One",
    artifactType: overrides.artifactType ?? "json",
    checkConfig: overrides.checkConfig ?? {
      checkType: "schema",
      schema: { type: "object", required: ["name"] },
    },
    priority: overrides.priority ?? 100,
    enabled: overrides.enabled ?? true,
    shortCircuit: overrides.shortCircuit ?? false,
    rulePolicyBundleId: overrides.rulePolicyBundleId,
    tags: overrides.tags ?? [],
    version: 1,
    etag: "etag-1",
    createdAt: "2026-02-24T00:00:00Z",
    updatedAt: "2026-02-24T00:00:00Z",
  };
}

function makeArtifact(content: JsonValue, type: string = "json", uri?: string): FridayNodeArtifact {
  const normalizedContent = content !== null && typeof content === "object" && !Array.isArray(content)
    ? { __acceptanceMetric: 1, ...(content as Record<string, JsonValue>) }
    : content;

  return {
    artifactType: type as FridayNodeArtifact["artifactType"],
    uri: uri ?? `artifact://${type}/${Math.random().toString(36).slice(2, 8)}`,
    metadata: { content: normalizedContent },
  };
}

function makeRuleResult(overrides: Partial<FridayEvaluationResult> = {}): FridayEvaluationResult {
  const decision = overrides.decision ?? "allow";
  return {
    evaluationId: overrides.evaluationId ?? `eval-${Math.random().toString(36).slice(2, 10)}`,
    decision,
    matchedRules: overrides.matchedRules ?? [],
    message: overrides.message,
    durationMs: overrides.durationMs ?? 1,
    allowed: overrides.allowed ?? decision !== "deny",
    evaluatedAt: overrides.evaluatedAt ?? "2026-02-24T00:00:00Z",
    transitionTrace: overrides.transitionTrace,
  };
}

interface RequiredGateSetOptions {
  artifactType?: FridayAcceptanceTest["artifactType"];
  prefix: string;
  schemaTest?: Partial<FridayAcceptanceTest>;
  quantitativeTest?: Partial<FridayAcceptanceTest>;
  qualityTest?: Partial<FridayAcceptanceTest>;
}

function registerRequiredGateSet(registry: InMemoryTestRegistry, options: RequiredGateSetOptions): void {
  const artifactType = options.artifactType ?? "json";

  registry.register(makeTest({
    id: `${options.prefix}-schema`,
    artifactType,
    priority: 10,
    checkConfig: {
      checkType: "schema",
      schema: { type: "object", required: ["name"] },
    },
    ...options.schemaTest,
  }));

  registry.register(makeTest({
    id: `${options.prefix}-quantitative`,
    artifactType,
    priority: 20,
    checkConfig: {
      checkType: "quantitative",
      metricPath: "__acceptanceMetric",
      operator: "gte",
      threshold: 1,
    },
    ...options.quantitativeTest,
  }));

  registry.register(makeTest({
    id: `${options.prefix}-quality`,
    artifactType,
    priority: 30,
    checkConfig: {
      checkType: "quality",
      dimension: "completeness",
      minScore: 50,
    },
    ...options.qualityTest,
  }));
}

function normalizeResult(result: FridayAcceptanceRunResult) {
  return {
    artifactType: result.artifactType,
    overallVerdict: result.overallVerdict,
    overallSeverity: result.overallSeverity,
    state: result.state,
    checksTotal: result.checksTotal,
    checksPassed: result.checksPassed,
    checksFailed: result.checksFailed,
    checksWarned: result.checksWarned,
    checksSkipped: result.checksSkipped,
    checks: result.checks.map((check) => {
      if (check.status === "skipped") {
        return {
          status: check.status,
          testId: check.testId,
          checkType: check.checkType,
          skipReason: check.skipReason,
        };
      }
      return {
        status: check.status,
        testId: check.testId,
        checkType: check.checkType,
        verdict: check.verdict,
        severity: check.severity,
        evidence: check.evidence.map((entry) => ({
          checkId: entry.checkId,
          checkType: entry.checkType,
          message: entry.message,
          expected: entry.expected,
          actual: entry.actual,
          hasRuleEvaluationResult: Boolean(entry.ruleEvaluationResult),
        })),
      };
    }),
  };
}

// ─── InMemoryTestRegistry ───

describe("InMemoryTestRegistry", () => {
  let registry: InMemoryTestRegistry;

  beforeEach(() => {
    registry = new InMemoryTestRegistry();
  });

  it("registers and retrieves a test", () => {
    const test = makeTest();
    registry.register(test);

    expect(registry.getById("test-1")).toEqual(test);
  });

  it("throws on duplicate registration", () => {
    registry.register(makeTest());
    expect(() => registry.register(makeTest())).toThrow("already registered");
  });

  it("returns tests by artifact type in priority order", () => {
    registry.register(makeTest({ id: "t-low", priority: 200 }));
    registry.register(makeTest({ id: "t-high", priority: 10 }));
    registry.register(makeTest({ id: "t-mid", priority: 100 }));

    const tests = registry.getTests("json");
    expect(tests.map((t) => t.id)).toEqual(["t-high", "t-mid", "t-low"]);
  });

  it("filters out disabled tests", () => {
    registry.register(makeTest({ id: "enabled", enabled: true }));
    registry.register(makeTest({ id: "disabled", enabled: false }));

    const tests = registry.getTests("json");
    expect(tests).toHaveLength(1);
    expect(tests[0].id).toBe("enabled");
  });

  it("unregisters a test", () => {
    registry.register(makeTest());
    expect(registry.unregister("test-1")).toBe(true);
    expect(registry.getById("test-1")).toBeUndefined();
    expect(registry.getTests("json")).toHaveLength(0);
  });

  it("returns false for unregistering unknown test", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("returns empty for unknown artifact type", () => {
    expect(registry.getTests("image")).toEqual([]);
  });

  it("lists artifact types with registered tests", () => {
    registry.register(makeTest({ id: "t1", artifactType: "json" }));
    registry.register(makeTest({ id: "t2", artifactType: "text" }));

    expect(registry.listArtifactTypes().sort()).toEqual(["json", "text"]);
  });

  it("cleans up artifact type list after unregister", () => {
    registry.register(makeTest({ id: "t1", artifactType: "json" }));
    registry.unregister("t1");

    expect(registry.listArtifactTypes()).not.toContain("json");
  });
});

// ─── AcceptanceTestSuiteRunner ───

describe("AcceptanceTestSuiteRunner", () => {
  let runner: AcceptanceTestSuiteRunner;

  beforeEach(() => {
    runner = new AcceptanceTestSuiteRunner({
      evaluateRules: async () => makeRuleResult(),
    });
  });

  afterEach(() => {
    clearCustomHandlers();
  });

  it("allows non-rule checks to run when evaluateRules is missing", async () => {
    const noRulesRunner = new AcceptanceTestSuiteRunner();
    registerRequiredGateSet(noRulesRunner.registry as InMemoryTestRegistry, { prefix: "no-rules" });

    const result = await noRulesRunner.runForArtifact("exec-1", makeArtifact({ name: "Alice" }));
    expect(result.overallVerdict).toBe("pass");
  });

  // ─── runForArtifact ───

  describe("runForArtifact", () => {
    it("runs schema check and passes for valid artifact", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, { prefix: "valid-artifact" });

      const artifact = makeArtifact({ name: "Alice" });
      const result = await runner.runForArtifact("exec-1", artifact);

      expect(result.overallVerdict).toBe("pass");
      expect(result.checksPassed).toBe(3);
      expect(result.checksFailed).toBe(0);
      expect(result.state).toBe(AcceptanceRunState.Passed);
    });

    it("runs schema check and fails for invalid artifact", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, { prefix: "invalid-artifact" });

      const artifact = makeArtifact({ age: 30 }); // missing 'name'
      const result = await runner.runForArtifact("exec-1", artifact);

      expect(result.overallVerdict).toBe("fail");
      expect(result.checksFailed).toBe(1);
      expect(result.state).toBe(AcceptanceRunState.RolledBack);
      expect(result.rollbackEvent).toBeDefined();
    });

    it("fails closed when no tests are registered (mandatory gate missing)", async () => {
      const artifact = makeArtifact({ data: 1 });
      const result = await runner.runForArtifact("exec-1", artifact);

      expect(result.overallVerdict).toBe("fail");
      expect(result.checksTotal).toBe(1);
      expect(result.checksFailed).toBe(1);
      expect(result.state).toBe(AcceptanceRunState.RolledBack);
      expect(result.rollbackEvent).toBeDefined();
      expect(result.checks[0].status).toBe("executed");
      if (result.checks[0].status === "executed") {
        expect(result.checks[0].evidence[0].message).toContain("Missing mandatory acceptance gate");
        expect(result.checks[0].evidence[0].metadata?.missingGateClasses).toEqual([
          "schema",
          "quantitative",
          "quality",
        ]);
      }
    });

    it("fails closed when any required gate class is missing", async () => {
      (runner.registry as InMemoryTestRegistry).register(makeTest({
        id: "schema-only",
        checkConfig: {
          checkType: "schema",
          schema: { type: "object", required: ["name"] },
        },
      }));

      const artifact = makeArtifact({ name: "Alice" });
      const result = await runner.runForArtifact("exec-1", artifact);

      expect(result.overallVerdict).toBe("fail");
      expect(result.state).toBe(AcceptanceRunState.RolledBack);
      expect(result.checksTotal).toBe(1);
      expect(result.checks[0].status).toBe("executed");

      if (result.checks[0].status === "executed") {
        expect(result.checks[0].evidence[0].actual).toEqual(["quantitative", "quality"]);
        expect(result.checks[0].evidence[0].metadata?.missingGateClasses).toEqual(["quantitative", "quality"]);
      }
    });

    it("short-circuits after failure when configured", async () => {
      const reg = runner.registry as InMemoryTestRegistry;
      registerRequiredGateSet(reg, {
        prefix: "short-circuit",
        schemaTest: {
          id: "failing-test",
          shortCircuit: true,
          checkConfig: { checkType: "schema", schema: { type: "string" } },
        },
        quantitativeTest: { id: "second-test" },
        qualityTest: { id: "third-test" },
      });

      const artifact = makeArtifact({ name: "Alice" }); // object, not string
      const result = await runner.runForArtifact("exec-1", artifact);

      expect(result.overallVerdict).toBe("fail");
      expect(result.checksFailed).toBe(1);
      expect(result.checksSkipped).toBe(2);

      const skippedChecks = result.checks.filter((check) => check.status === "skipped");
      expect(skippedChecks.map((check) => check.testId).sort()).toEqual(["second-test", "third-test"]);
    });

    it("does not short-circuit when shortCircuit is false", async () => {
      const reg = runner.registry as InMemoryTestRegistry;
      registerRequiredGateSet(reg, {
        prefix: "no-short-circuit",
        schemaTest: {
          id: "failing-test",
          shortCircuit: false,
          checkConfig: { checkType: "schema", schema: { type: "string" } },
        },
        quantitativeTest: { id: "second-test" },
        qualityTest: { id: "third-test" },
      });

      const artifact = makeArtifact({ name: "Alice" });
      const result = await runner.runForArtifact("exec-1", artifact);

      // First check fails (expects string), quantitative and quality pass.
      expect(result.checksFailed).toBe(1);
      expect(result.checksPassed).toBe(2);
      expect(result.checksSkipped).toBe(0);
    });

    it("normalizes content resolution failure with system-fail and skipped checks", async () => {
      const failingRunner = new AcceptanceTestSuiteRunner({
        evaluateRules: async () => makeRuleResult(),
        contentResolver: () => { throw new Error("Content not found"); },
      });

      const reg = failingRunner.registry as InMemoryTestRegistry;
      registerRequiredGateSet(reg, { prefix: "content-resolution-failure" });

      const artifact: FridayNodeArtifact = {
        artifactType: "json",
        uri: "artifact://missing",
      };
      const result = await failingRunner.runForArtifact("exec-1", artifact);

      expect(result.overallVerdict).toBe("fail");
      expect(result.checksFailed).toBe(1);
      expect(result.checksSkipped).toBe(3);
      expect(result.checksTotal).toBe(4);

      const systemFail = result.checks.find((check) => check.status === "executed");
      expect(systemFail).toBeDefined();
      if (systemFail?.status === "executed") {
        expect(systemFail.evidence[0].message).toContain("Content not found");
      }

      const skippedChecks = result.checks.filter((check) => check.status === "skipped");
      expect(skippedChecks.every((check) => check.skipReason?.includes("could not be resolved"))).toBe(true);
    });

    it("records run in coverage tracker", async () => {
      const reg = runner.registry as InMemoryTestRegistry;
      registerRequiredGateSet(reg, { prefix: "coverage" });
      const test = reg.getById("coverage-schema");
      expect(test).toBeDefined();
      runner.coverageTracker.registerTest(test!);

      const artifact = makeArtifact({ name: "Alice" });
      await runner.runForArtifact("exec-1", artifact);

      const coverage = runner.coverageTracker.getTestCoverage("coverage-schema");
      expect(coverage!.executionCount).toBe(1);
    });
  });

  // ─── Rule-linked checks ───

  describe("rule-linked checks", () => {
    it("evaluates rule-linked checks through injected Rules Engine and persists evaluation IDs", async () => {
      const evaluateRules = vi.fn(async () => makeRuleResult({
        evaluationId: "eval-accept-1",
        decision: "allow",
        matchedRules: [{
          ruleId: "rule-1",
          ruleName: "Artifact allow rule",
          policyBundleId: "bundle-1",
          decision: "allow",
          priority: 1,
        }],
      }));

      const ruleRunner = new AcceptanceTestSuiteRunner({ evaluateRules });
      registerRequiredGateSet(ruleRunner.registry as InMemoryTestRegistry, {
        prefix: "rule-linked",
        schemaTest: {
          id: "rule-linked-test",
          rulePolicyBundleId: "bundle-1",
        },
      });

      const artifact = makeArtifact({ name: "Alice" }, "json", "artifact://json/rule-linked");
      const result = await ruleRunner.runForArtifact("exec-1", artifact);

      expect(result.overallVerdict).toBe("pass");
      expect(evaluateRules).toHaveBeenCalledTimes(1);
      expect(evaluateRules.mock.calls[0][0].policyBundleIds).toEqual(["bundle-1"]);

      const executed = result.checks.find((check) => check.status === "executed");
      expect(executed).toBeDefined();
      if (executed?.status === "executed") {
        expect(executed.ruleEvaluationId).toBe("eval-accept-1");
        expect(executed.ruleEvaluationIds).toEqual(["eval-accept-1"]);
        const ruleEvidence = executed.evidence.find((entry) => entry.ruleEvaluationResult);
        expect(ruleEvidence?.ruleEvaluationResult?.evaluationId).toBe("eval-accept-1");
        expect(ruleEvidence?.metadata?.matchedRuleIds).toEqual(["rule-1"]);
      }
    });

    it("fails a rule-linked check when Rules Engine denies", async () => {
      const ruleRunner = new AcceptanceTestSuiteRunner({
        evaluateRules: async () => makeRuleResult({
          evaluationId: "eval-deny-1",
          decision: "deny",
          allowed: false,
          matchedRules: [{
            ruleId: "rule-deny",
            ruleName: "Deny artifact",
            policyBundleId: "bundle-deny",
            decision: "deny",
            priority: 1,
          }],
        }),
      });

      registerRequiredGateSet(ruleRunner.registry as InMemoryTestRegistry, {
        prefix: "deny-linked",
        schemaTest: {
          id: "deny-linked-test",
          rulePolicyBundleId: "bundle-deny",
        },
      });

      const artifact = makeArtifact({ name: "Alice" });
      const result = await ruleRunner.runForArtifact("exec-1", artifact);

      expect(result.overallVerdict).toBe("fail");
      expect(result.state).toBe(AcceptanceRunState.RolledBack);
    });

    it("maps audit decisions to pass and preserves rule evidence", async () => {
      const evaluateRules = vi.fn(async () => makeRuleResult({
        evaluationId: "eval-audit-1",
        decision: "audit",
        matchedRules: [{
          ruleId: "rule-audit",
          ruleName: "Audit artifact",
          policyBundleId: "bundle-audit",
          decision: "audit",
          priority: 1,
        }],
      }));

      const ruleRunner = new AcceptanceTestSuiteRunner({ evaluateRules });
      registerRequiredGateSet(ruleRunner.registry as InMemoryTestRegistry, {
        prefix: "audit-linked",
        schemaTest: {
          id: "audit-linked-test",
          rulePolicyBundleId: "bundle-audit",
        },
      });

      const result = await ruleRunner.runForArtifact("exec-1", makeArtifact({ name: "Alice" }));
      expect(result.overallVerdict).toBe("pass");

      const executed = result.checks.find(
        (check) => check.status === "executed" && check.testId === "audit-linked-test",
      );
      expect(executed).toBeDefined();
      if (executed?.status === "executed") {
        expect(executed.verdict).toBe("pass");
        expect(executed.severity).toBe("info");
        const ruleEvidence = executed.evidence.find((entry) => entry.ruleEvaluationResult);
        expect(ruleEvidence?.ruleEvaluationResult?.decision).toBe("audit");
      }
    });

    it("fails closed when a rule-linked check executes without evaluateRules", async () => {
      const noRulesRunner = new AcceptanceTestSuiteRunner();
      registerRequiredGateSet(noRulesRunner.registry as InMemoryTestRegistry, {
        prefix: "missing-evaluator",
        schemaTest: {
          id: "missing-evaluator-test",
          rulePolicyBundleId: "bundle-required",
        },
      });

      const result = await noRulesRunner.runForArtifact("exec-1", makeArtifact({ name: "Alice" }));
      expect(result.overallVerdict).toBe("fail");
      expect(result.state).toBe(AcceptanceRunState.RolledBack);

      const executed = result.checks.find(
        (check) => check.status === "executed" && check.testId === "missing-evaluator-test",
      );
      expect(executed).toBeDefined();
      if (executed?.status === "executed") {
        expect(executed.verdict).toBe("fail");
        expect(executed.evidence[0].message).toContain("No evaluateRules function configured");
      }
    });
  });

  // ─── runForArtifacts ───

  describe("runForArtifacts", () => {
    it("runs tests against multiple artifacts", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, { prefix: "multiple-artifacts" });

      const artifacts = [
        makeArtifact({ name: "Alice" }),
        makeArtifact({ name: "Bob" }),
      ];

      const results = await runner.runForArtifacts("exec-1", artifacts);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.overallVerdict === "pass")).toBe(true);
    });
  });

  // ─── runPipeline ───

  describe("runPipeline", () => {
    it("runs full pipeline and returns result", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, { prefix: "pipeline-pass" });

      const context: FridayAcceptancePipelineContext = {
        executionId: "exec-1",
        runId: "run-1",
        workflowId: "wf-1",
        nodeId: "node-1",
        validatedOutput: { name: "Alice" },
        artifacts: [makeArtifact({ name: "Alice" })],
      };

      const pipelineResult = await runner.runPipeline(context);
      expect(pipelineResult.passed).toBe(true);
      expect(pipelineResult.runs).toHaveLength(1);
      expect(pipelineResult.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("reports not passed when artifact fails", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, { prefix: "pipeline-fail" });

      const context: FridayAcceptancePipelineContext = {
        executionId: "exec-1",
        runId: "run-1",
        workflowId: "wf-1",
        nodeId: "node-1",
        validatedOutput: {},
        artifacts: [makeArtifact({ age: 30 })], // missing 'name'
      };

      const pipelineResult = await runner.runPipeline(context);
      expect(pipelineResult.passed).toBe(false);
    });
  });

  // ─── buildReport ───

  describe("buildReport", () => {
    it("builds a suite report from run results", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, { prefix: "build-report" });

      const artifact = makeArtifact({ name: "Alice" });
      const result = await runner.runForArtifact("exec-1", artifact);

      const report = runner.buildReport([result], result.durationMs);
      expect(report.passed).toBe(true);
      expect(report.totals.runsTotal).toBe(1);
      expect(report.totals.runsPassed).toBe(1);
    });
  });

  // ─── Run state machine + rollback ───

  describe("run state machine + rollback", () => {
    it("records valid pending -> running -> passed transitions", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, { prefix: "state-pass" });

      const result = await runner.runForArtifact("exec-1", makeArtifact({ name: "Alice" }));
      expect(result.state).toBe(AcceptanceRunState.Passed);
      expect(result.stateTransitions.map((transition) => [transition.from, transition.to])).toEqual([
        [AcceptanceRunState.Pending, AcceptanceRunState.Running],
        [AcceptanceRunState.Running, AcceptanceRunState.Passed],
      ]);
      expect(result.rollbackEvent).toBeUndefined();
    });

    it("records valid pending -> running -> failed -> rolled_back transitions and emits rollback event", async () => {
      const onRollback = vi.fn();
      const rollbackRunner = new AcceptanceTestSuiteRunner({
        evaluateRules: async () => makeRuleResult(),
        onRollback,
      });
      registerRequiredGateSet(rollbackRunner.registry as InMemoryTestRegistry, { prefix: "state-rollback" });

      const result = await rollbackRunner.runForArtifact("exec-1", makeArtifact({ missing: true }));
      expect(result.overallVerdict).toBe("fail");
      expect(result.state).toBe(AcceptanceRunState.RolledBack);
      expect(result.stateTransitions.map((transition) => [transition.from, transition.to])).toEqual([
        [AcceptanceRunState.Pending, AcceptanceRunState.Running],
        [AcceptanceRunState.Running, AcceptanceRunState.Failed],
        [AcceptanceRunState.Failed, AcceptanceRunState.RolledBack],
      ]);
      expect(result.rollbackEvent).toBeDefined();
      expect(onRollback).toHaveBeenCalledTimes(1);
      expect(onRollback.mock.calls[0][0].runId).toBe(result.id);
    });

    it("validates state transitions and rejects invalid transitions", () => {
      expect(() => assertAcceptanceRunStateTransition(AcceptanceRunState.Pending, AcceptanceRunState.Passed))
        .toThrow("Invalid acceptance run state transition");
    });
  });

  // ─── Custom check integration ───

  describe("custom check integration", () => {
    it("runs custom assertion handler through the runner", async () => {
      registerCustomHandler("word-count", (content) => {
        const text = typeof content === "string" ? content : JSON.stringify(content);
        const wordCount = text.split(/\s+/).length;
        return {
          verdict: wordCount >= 5 ? "pass" : "fail",
          severity: "major",
          evidence: [{
            checkId: "custom",
            checkType: "custom",
            message: `Word count: ${wordCount}`,
            actual: wordCount,
          }],
        };
      });

      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, {
        prefix: "text-required",
        artifactType: "text",
      });
      (runner.registry as InMemoryTestRegistry).register(makeTest({
        id: "word-count-test",
        artifactType: "text",
        priority: 40,
        checkConfig: {
          checkType: "custom",
          handlerRef: "word-count",
        },
      }));

      const artifact = makeArtifact({ name: "This is a long enough sentence for custom checks" }, "text");
      const result = await runner.runForArtifact("exec-1", artifact);
      expect(result.overallVerdict).toBe("pass");
    });
  });

  // ─── Quantitative check integration ───

  describe("quantitative check integration", () => {
    it("passes quantitative threshold check", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, { prefix: "quant-pass" });
      (runner.registry as InMemoryTestRegistry).register(makeTest({
        id: "metric-test",
        priority: 40,
        checkConfig: {
          checkType: "quantitative",
          metricPath: "confidence",
          operator: "gte",
          threshold: 0.8,
        },
      }));

      const artifact = makeArtifact({ name: "test", confidence: 0.95 });
      const result = await runner.runForArtifact("exec-1", artifact);
      expect(result.overallVerdict).toBe("pass");
    });

    it("fails quantitative threshold check", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, { prefix: "quant-fail" });
      (runner.registry as InMemoryTestRegistry).register(makeTest({
        id: "metric-test",
        priority: 40,
        checkConfig: {
          checkType: "quantitative",
          metricPath: "confidence",
          operator: "gte",
          threshold: 0.8,
        },
      }));

      const artifact = makeArtifact({ name: "test", confidence: 0.5 });
      const result = await runner.runForArtifact("exec-1", artifact);
      expect(result.overallVerdict).toBe("fail");
    });
  });

  // ─── Quality check integration ───

  describe("quality check integration", () => {
    it("passes quality check for complete object", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, { prefix: "quality-pass" });
      (runner.registry as InMemoryTestRegistry).register(makeTest({
        id: "quality-test",
        priority: 40,
        checkConfig: {
          checkType: "quality",
          dimension: "completeness",
          minScore: 50,
        },
      }));

      const artifact = makeArtifact({ name: "Alice", age: 30, email: "alice@example.com" });
      const result = await runner.runForArtifact("exec-1", artifact);
      expect(result.overallVerdict).toBe("pass");
    });
  });

  // ─── KPI validation ───

  describe("kpi validation", () => {
    it("determinism: same input yields same normalized output across 100 runs", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, {
        prefix: "determinism",
        schemaTest: {
          id: "determinism-test",
          checkConfig: {
            checkType: "schema",
            schema: { type: "object", required: ["name", "confidence"] },
          },
        },
      });

      const artifact = makeArtifact(
        { name: "Deterministic", confidence: 0.99 },
        "json",
        "artifact://json/deterministic",
      );

      const baseline = normalizeResult(await runner.runForArtifact("exec-1", artifact));
      for (let i = 0; i < 99; i++) {
        const current = normalizeResult(await runner.runForArtifact("exec-1", artifact));
        expect(current).toEqual(baseline);
      }
    });

    it("mean latency stays below 200ms", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, {
        prefix: "latency",
        schemaTest: {
          id: "latency-test",
          checkConfig: {
            checkType: "schema",
            schema: { type: "object", required: ["name"] },
          },
        },
      });

      const runs = 100;
      const artifact = makeArtifact({ name: "Latency" }, "json", "artifact://json/latency");
      let totalDurationMs = 0;

      for (let i = 0; i < runs; i++) {
        const result = await runner.runForArtifact("exec-1", artifact);
        totalDurationMs += result.durationMs;
      }

      const meanLatency = totalDurationMs / runs;
      expect(meanLatency).toBeLessThan(200);
    });

    it("escape rate: known-bad artifacts fail acceptance", async () => {
      registerRequiredGateSet(runner.registry as InMemoryTestRegistry, {
        prefix: "escape-rate",
        schemaTest: {
          id: "escape-rate-test",
          checkConfig: {
            checkType: "schema",
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", minLength: 1 },
              },
            },
          },
        },
      });

      const badArtifacts: FridayNodeArtifact[] = [
        makeArtifact({}),
        makeArtifact({ age: 10 }),
        makeArtifact({ title: "missing name" }),
        makeArtifact([]),
        makeArtifact("plain-string"),
        makeArtifact({ name: null }),
      ];

      const results = await runner.runForArtifacts("exec-1", badArtifacts);
      const failed = results.filter((result) => result.overallVerdict === "fail");
      expect(failed).toHaveLength(badArtifacts.length);
    });
  });
});
