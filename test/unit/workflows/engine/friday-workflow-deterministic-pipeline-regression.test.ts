/**
 * A-009 Deterministic Full-Stack Pipeline Regression Suite
 *
 * End-to-end regression tests spanning the complete deterministic pipeline:
 * intake → playbook selection → node-runner → rules → retry → acceptance → completion.
 *
 * All tests use seeded data, deterministic clocks, and fixed IDs
 * to ensure reproducible results across runs.
 *
 * Failure-class scenarios:
 * 1. Happy path (all pass)
 * 2. Acceptance gate blocks completion
 * 3. Retry exhaustion → DLQ
 * 4. Schema error → non-retryable → immediate DLQ
 * 5. Circuit breaker opens
 * 6. Playbook selection miss
 * 7. Budget exhaustion
 * 8. Mixed: retry + acceptance warn
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createWorkflowUnifiedRetryBridge } from "../../../../src/workflows/engine/friday-workflow-unified-retry-bridge.js";
import { createFridayWorkflowAcceptanceGate, type AcceptanceCheckOutcome } from "../../../../src/workflows/engine/friday-workflow-acceptance-gate.js";
import { createWorkflowPlaybookBridge } from "../../../../src/workflows/engine/friday-workflow-playbook-bridge.js";
import { createPipelineEventEmitter } from "../../../../src/workflows/engine/friday-workflow-pipeline-event-taxonomy.js";
import { createFridayWorkflowNodeRunnerFacade } from "../../../../src/workflows/engine/friday-workflow-node-runner-facade.js";
import type { FridayNodeExecutionResult, FridayNodeExecutionStatus } from "../../../../src/node-runner/model/friday-node-runner.types.js";

// ─── Seeded Deterministic Helpers ───

const FIXED_CLOCK = "2026-01-15T12:00:00.000Z";
let idSeq = 0;
function seededId() { return `det-${++idSeq}`; }
function resetSeeds() { idSeq = 0; }

function hashSnapshot(...values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16);
}

// ─── Reusable Pipeline Factory ───

interface PipelineScenario {
  name: string;
  nodeResult: Partial<FridayNodeExecutionResult>;
  acceptanceOutcomes: AcceptanceCheckOutcome[];
  errorCode?: string;
  playbookMatch: boolean;
  retryAttempt?: number;
}

function buildPipeline(scenario: PipelineScenario) {
  resetSeeds();

  // Node Runner Facade
  const mockPipeline = {
    execute: vi.fn().mockResolvedValue({
      executionId: seededId(),
      status: (scenario.nodeResult.status ?? "completed") as FridayNodeExecutionStatus,
      stepResults: [],
      output: scenario.nodeResult.output ?? { result: "ok" },
      artifacts: [],
      startedAt: FIXED_CLOCK,
      completedAt: FIXED_CLOCK,
      durationMs: 500,
      ...scenario.nodeResult,
    } as FridayNodeExecutionResult),
  };
  const legacyExecutor = { executeNode: vi.fn() };
  const facade = createFridayWorkflowNodeRunnerFacade({
    pipeline: mockPipeline as any,
    legacyExecutor,
    config: { useNodeRunner: true },
    nowIso: () => FIXED_CLOCK,
  });

  // Retry Bridge
  const onDlqEscalation = vi.fn();
  const retryBridge = createWorkflowUnifiedRetryBridge({
    maxAttempts: 3,
    baseDelayMs: 100,
    retryBudgetMax: 5,
    circuitBreakerThreshold: 3,
    onRetryTrace: vi.fn(),
    onDlqEscalation,
    nowIso: () => FIXED_CLOCK,
  });

  // Acceptance Gate
  const acceptanceGate = createFridayWorkflowAcceptanceGate({
    runAcceptanceChecks: vi.fn().mockResolvedValue(scenario.acceptanceOutcomes),
    nowIso: () => FIXED_CLOCK,
  });

  // Playbook Bridge
  const playbookSelector = {
    select: vi.fn().mockResolvedValue({
      id: seededId(),
      runId: "run-det",
      workflowId: "wf-det",
      playbookId: scenario.playbookMatch ? "pb-det" : null,
      versionNumber: scenario.playbookMatch ? 1 : null,
      matchScore: scenario.playbookMatch ? 0.85 : null,
      similarity: scenario.playbookMatch ? 0.90 : null,
      reason: scenario.playbookMatch ? "matched" : "no_match",
      context: {
        workflowType: "test-pipeline",
        workflowId: "wf-det",
        runId: "run-det",
        nodeSequence: [{ nodeType: "action" }],
        tags: ["test"],
      },
      selectedAt: FIXED_CLOCK,
    }),
  };
  const playbookLearner = {
    processCompletedRun: vi.fn().mockResolvedValue(null),
  };
  const playbookBridge = createWorkflowPlaybookBridge({
    selector: playbookSelector,
    learner: playbookLearner,
    nowIso: () => FIXED_CLOCK,
  });

  // Event Emitter
  const eventPublish = vi.fn();
  const eventEmitter = createPipelineEventEmitter({
    publish: eventPublish,
    generateId: seededId,
    nowIso: () => FIXED_CLOCK,
  });

  return {
    facade,
    retryBridge,
    acceptanceGate,
    playbookBridge,
    eventEmitter,
    onDlqEscalation,
    eventPublish,
    mockPipeline,
  };
}

// ─── Regression Tests ───

describe("A-009 Deterministic Full-Stack Pipeline Regression", () => {
  describe("Scenario 1: Happy path — all modules pass", () => {
    it("completes full pipeline without errors", async () => {
      const pipeline = buildPipeline({
        name: "happy-path",
        nodeResult: { status: "completed", output: { answer: 42 } },
        acceptanceOutcomes: [
          { checkId: "chk-1", checkName: "Schema", verdict: "pass", severity: "critical" },
          { checkId: "chk-2", checkName: "Quality", verdict: "pass", severity: "major" },
        ],
        playbookMatch: true,
      });

      // Step 1: Playbook selection on intake
      const intakeResult = await pipeline.playbookBridge.selectOnIntake({
        runId: "run-det", workflowId: "wf-det",
        workflowType: "test-pipeline", tags: ["test"],
        nodeSequence: [{ nodeType: "action" }],
      });
      expect(intakeResult.decision).toBe("matched");
      expect(intakeResult.playbookId).toBe("pb-det");

      // Step 2: Execute node via facade
      const nodeResult = await pipeline.facade.executeNode({
        runId: "run-det", nodeId: "n-1", attemptId: "att-1",
        node: { id: "n-1", type: "action", name: "Test", config: { skillId: "s-1" }, position: { x: 0, y: 0 } },
        inputData: {},
        expressionContext: { inputs: {}, outputs: {}, variables: {} },
      });
      expect(nodeResult.output).toEqual({ answer: 42 });

      // Step 3: Acceptance gate
      const gateResult = await pipeline.acceptanceGate.evaluate({
        runId: "run-det", workflowId: "wf-det",
        artifactType: "workflow_output", artifactData: nodeResult.output,
      });
      expect(gateResult.decision).toBe("pass");
      expect(gateResult.blocksCompletion).toBe(false);

      // Step 4: Emit completion events
      pipeline.eventEmitter.emit(
        "pipeline.node.execution.completed",
        { status: "completed", durationMs: 500, stepCount: 6, artifactCount: 0 },
        { runId: "run-det", workflowId: "wf-det", nodeId: "n-1" },
      );
      pipeline.eventEmitter.emit(
        "pipeline.acceptance.passed",
        { checksRun: 2, checksPassed: 2 },
        { runId: "run-det", workflowId: "wf-det" },
      );

      expect(pipeline.eventEmitter.getEvents("run-det")).toHaveLength(2);
    });

    it("produces deterministic hash across runs", async () => {
      const p1 = buildPipeline({
        name: "hash-1",
        nodeResult: { status: "completed", output: { x: 1 } },
        acceptanceOutcomes: [{ checkId: "c-1", checkName: "Check", verdict: "pass", severity: "critical" }],
        playbookMatch: true,
      });
      const p2 = buildPipeline({
        name: "hash-2",
        nodeResult: { status: "completed", output: { x: 1 } },
        acceptanceOutcomes: [{ checkId: "c-1", checkName: "Check", verdict: "pass", severity: "critical" }],
        playbookMatch: true,
      });

      const gate1 = await p1.acceptanceGate.evaluate({
        runId: "r", workflowId: "w", artifactType: "t", artifactData: {},
      });
      const gate2 = await p2.acceptanceGate.evaluate({
        runId: "r", workflowId: "w", artifactType: "t", artifactData: {},
      });

      const hash1 = hashSnapshot(gate1.decision, gate1.checksRun, gate1.evaluatedAt);
      const hash2 = hashSnapshot(gate2.decision, gate2.checksRun, gate2.evaluatedAt);
      expect(hash1).toBe(hash2);
    });
  });

  describe("Scenario 2: Acceptance gate blocks completion", () => {
    it("blocks on critical severity failure", async () => {
      const pipeline = buildPipeline({
        name: "acceptance-block",
        nodeResult: { status: "completed", output: { result: "bad schema" } },
        acceptanceOutcomes: [
          { checkId: "chk-1", checkName: "Schema", verdict: "fail", severity: "critical", message: "Schema mismatch" },
        ],
        playbookMatch: true,
      });

      const gateResult = await pipeline.acceptanceGate.evaluate({
        runId: "run-det", workflowId: "wf-det",
        artifactType: "workflow_output", artifactData: {},
      });

      expect(gateResult.decision).toBe("fail");
      expect(gateResult.blocksCompletion).toBe(true);
      expect(gateResult.checksFailed).toBe(1);
    });
  });

  describe("Scenario 3: Retry exhaustion → DLQ", () => {
    it("escalates to DLQ after max attempts", () => {
      const pipeline = buildPipeline({
        name: "retry-exhaustion",
        nodeResult: { status: "failed", errorCode: "TIMEOUT" },
        acceptanceOutcomes: [],
        playbookMatch: true,
      });

      // Simulate 3 attempts
      const d1 = pipeline.retryBridge.evaluateRetry({
        runId: "run-det", nodeId: "n-1", attempt: 1, errorCode: "TIMEOUT",
      });
      expect(d1.shouldRetry).toBe(true);
      expect(d1.category).toBe("timeout");

      const d2 = pipeline.retryBridge.evaluateRetry({
        runId: "run-det", nodeId: "n-1", attempt: 2, errorCode: "TIMEOUT",
      });
      expect(d2.shouldRetry).toBe(true);

      const d3 = pipeline.retryBridge.evaluateRetry({
        runId: "run-det", nodeId: "n-1", attempt: 3, errorCode: "TIMEOUT",
      });
      expect(d3.shouldRetry).toBe(false);
      expect(d3.escalateToDlq).toBe(true);
      expect(pipeline.onDlqEscalation).toHaveBeenCalledOnce();
    });
  });

  describe("Scenario 4: Schema error → immediate DLQ (non-retryable)", () => {
    it("does not retry logic errors", () => {
      const pipeline = buildPipeline({
        name: "schema-error",
        nodeResult: { status: "failed", errorCode: "SCHEMA_VALIDATION_FAILED" },
        acceptanceOutcomes: [],
        playbookMatch: true,
      });

      const decision = pipeline.retryBridge.evaluateRetry({
        runId: "run-det", nodeId: "n-1", attempt: 1, errorCode: "SCHEMA_VALIDATION_FAILED",
      });

      expect(decision.shouldRetry).toBe(false);
      expect(decision.category).toBe("logic");
      expect(decision.escalateToDlq).toBe(true);
      expect(pipeline.onDlqEscalation).toHaveBeenCalledOnce();
    });
  });

  describe("Scenario 5: Circuit breaker opens", () => {
    it("opens circuit after consecutive failures and blocks retry", () => {
      const pipeline = buildPipeline({
        name: "circuit-breaker",
        nodeResult: { status: "failed", errorCode: "CONNECTION_REFUSED" },
        acceptanceOutcomes: [],
        playbookMatch: true,
      });

      // Record 3 consecutive failures on same node
      pipeline.retryBridge.recordAttempt({ runId: "run-det", nodeId: "n-1", attempt: 1, category: "transient", success: false });
      pipeline.retryBridge.recordAttempt({ runId: "run-det", nodeId: "n-1", attempt: 2, category: "transient", success: false });
      pipeline.retryBridge.recordAttempt({ runId: "run-det", nodeId: "n-1", attempt: 3, category: "transient", success: false });

      expect(pipeline.retryBridge.isCircuitOpen("n-1")).toBe(true);

      const decision = pipeline.retryBridge.evaluateRetry({
        runId: "run-det", nodeId: "n-1", attempt: 1, errorCode: "TOOL_EXECUTION_FAILED",
      });
      expect(decision.shouldRetry).toBe(false);
      expect(decision.circuitOpen).toBe(true);
    });
  });

  describe("Scenario 6: Playbook selection miss", () => {
    it("continues without playbook when no match found", async () => {
      const pipeline = buildPipeline({
        name: "playbook-miss",
        nodeResult: { status: "completed", output: { result: "ok" } },
        acceptanceOutcomes: [
          { checkId: "chk-1", checkName: "Check", verdict: "pass", severity: "critical" },
        ],
        playbookMatch: false,
      });

      const intakeResult = await pipeline.playbookBridge.selectOnIntake({
        runId: "run-det", workflowId: "wf-det",
        workflowType: "unknown-type", tags: [],
        nodeSequence: [],
      });

      expect(intakeResult.decision).toBe("no_match");
      expect(intakeResult.playbookId).toBeNull();

      // Pipeline continues — execution still succeeds
      const nodeResult = await pipeline.facade.executeNode({
        runId: "run-det", nodeId: "n-1", attemptId: "att-1",
        node: { id: "n-1", type: "action", name: "Act", config: { skillId: "s-1" }, position: { x: 0, y: 0 } },
        inputData: {},
        expressionContext: { inputs: {}, outputs: {}, variables: {} },
      });
      expect(nodeResult.output).toEqual({ result: "ok" });

      const gateResult = await pipeline.acceptanceGate.evaluate({
        runId: "run-det", workflowId: "wf-det",
        artifactType: "workflow_output", artifactData: {},
      });
      expect(gateResult.decision).toBe("pass");
    });
  });

  describe("Scenario 7: Budget exhaustion", () => {
    it("stops retries when budget is consumed", () => {
      const pipeline = buildPipeline({
        name: "budget-exhaustion",
        nodeResult: { status: "failed", errorCode: "TIMEOUT" },
        acceptanceOutcomes: [],
        playbookMatch: true,
      });

      // Consume entire retry budget (5)
      for (let i = 0; i < 5; i++) {
        pipeline.retryBridge.evaluateRetry({
          runId: "run-det", nodeId: `n-${i}`, attempt: 1, errorCode: "TIMEOUT",
        });
      }

      expect(pipeline.retryBridge.getRetryBudgetRemaining("run-det")).toBe(0);

      const decision = pipeline.retryBridge.evaluateRetry({
        runId: "run-det", nodeId: "n-extra", attempt: 1, errorCode: "TIMEOUT",
      });
      expect(decision.shouldRetry).toBe(false);
      expect(decision.budgetExhausted).toBe(true);
    });
  });

  describe("Scenario 8: Mixed — retry succeeds + acceptance warns", () => {
    it("allows completion with warning after retry success", async () => {
      const pipeline = buildPipeline({
        name: "mixed-retry-warn",
        nodeResult: { status: "completed", output: { result: "recovered" } },
        acceptanceOutcomes: [
          { checkId: "chk-1", checkName: "Quality", verdict: "fail", severity: "minor", message: "Low score" },
          { checkId: "chk-2", checkName: "Schema", verdict: "pass", severity: "critical" },
        ],
        playbookMatch: true,
      });

      // First attempt fails
      const d1 = pipeline.retryBridge.evaluateRetry({
        runId: "run-det", nodeId: "n-1", attempt: 1, errorCode: "TIMEOUT",
      });
      expect(d1.shouldRetry).toBe(true);

      // Second attempt succeeds — execute node
      const nodeResult = await pipeline.facade.executeNode({
        runId: "run-det", nodeId: "n-1", attemptId: "att-2",
        node: { id: "n-1", type: "action", name: "Act", config: { skillId: "s-1" }, position: { x: 0, y: 0 } },
        inputData: {},
        expressionContext: { inputs: {}, outputs: {}, variables: {} },
      });
      expect(nodeResult.output).toEqual({ result: "recovered" });

      // Acceptance gate — warns but allows completion
      const gateResult = await pipeline.acceptanceGate.evaluate({
        runId: "run-det", workflowId: "wf-det",
        artifactType: "workflow_output", artifactData: nodeResult.output,
      });
      expect(gateResult.decision).toBe("warn");
      expect(gateResult.blocksCompletion).toBe(false);
      expect(gateResult.checksWarned).toBe(1);
    });
  });

  describe("Cross-module event correlation", () => {
    it("all events share the same runId across modules", async () => {
      const pipeline = buildPipeline({
        name: "correlation",
        nodeResult: { status: "completed", output: {} },
        acceptanceOutcomes: [],
        playbookMatch: true,
      });

      const runId = "run-corr";
      const correlation = { runId, workflowId: "wf-corr", nodeId: "n-1" };

      pipeline.eventEmitter.emit("pipeline.playbook.selected",
        { playbookId: "pb-1", versionNumber: 1, matchScore: 0.9 }, correlation);
      pipeline.eventEmitter.emit("pipeline.node.step.started",
        { stepName: "load", stepIndex: 0 }, correlation);
      pipeline.eventEmitter.emit("pipeline.node.step.completed",
        { stepName: "load", stepIndex: 0, durationMs: 10 }, correlation);
      pipeline.eventEmitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 3, outcome: "allow", durationMs: 5 }, correlation);
      pipeline.eventEmitter.emit("pipeline.acceptance.passed",
        { checksRun: 1, checksPassed: 1 }, correlation);

      const events = pipeline.eventEmitter.getEvents(runId);
      expect(events).toHaveLength(5);

      // All events share runId
      for (const e of events) {
        expect(e.correlation.runId).toBe(runId);
      }

      // Events cover all 5 modules
      const modules = new Set(events.map((e) => e.module));
      expect(modules.size).toBe(4); // playbook, node-runner, rules, acceptance
    });
  });

  describe("Reproducibility hash assertions", () => {
    it("same inputs produce identical acceptance gate hashes", async () => {
      const outcomes: AcceptanceCheckOutcome[] = [
        { checkId: "c-1", checkName: "Schema", verdict: "pass", severity: "critical" },
        { checkId: "c-2", checkName: "Quality", verdict: "fail", severity: "minor", message: "Low" },
      ];

      const runs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const pipeline = buildPipeline({
          name: `repro-${i}`,
          nodeResult: { status: "completed" },
          acceptanceOutcomes: outcomes,
          playbookMatch: true,
        });

        const result = await pipeline.acceptanceGate.evaluate({
          runId: "r", workflowId: "w", artifactType: "t", artifactData: {},
        });

        runs.push(hashSnapshot(result.decision, result.checksRun, result.checksPassed, result.checksWarned, result.checksFailed, result.evaluatedAt));
      }

      // All runs produce identical hash
      expect(runs[0]).toBe(runs[1]);
      expect(runs[1]).toBe(runs[2]);
    });

    it("same inputs produce identical retry decision hashes", () => {
      const runs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const pipeline = buildPipeline({
          name: `repro-retry-${i}`,
          nodeResult: { status: "failed" },
          acceptanceOutcomes: [],
          playbookMatch: true,
        });

        const d = pipeline.retryBridge.evaluateRetry({
          runId: "r", nodeId: "n", attempt: 1, errorCode: "TIMEOUT",
        });

        runs.push(hashSnapshot(d.shouldRetry, d.category, d.delayMs, d.reason));
      }

      expect(runs[0]).toBe(runs[1]);
      expect(runs[1]).toBe(runs[2]);
    });
  });

  describe("Flaky budget / quarantine guard", () => {
    it("all scenarios complete within bounded time", async () => {
      const startMs = Date.now();

      const pipeline = buildPipeline({
        name: "timing-guard",
        nodeResult: { status: "completed", output: {} },
        acceptanceOutcomes: [
          { checkId: "c-1", checkName: "Check", verdict: "pass", severity: "critical" },
        ],
        playbookMatch: true,
      });

      await pipeline.playbookBridge.selectOnIntake({
        runId: "r", workflowId: "w", workflowType: "t", tags: [], nodeSequence: [],
      });
      await pipeline.facade.executeNode({
        runId: "r", nodeId: "n", attemptId: "a",
        node: { id: "n", type: "action", name: "A", config: {}, position: { x: 0, y: 0 } },
        inputData: {},
        expressionContext: { inputs: {}, outputs: {}, variables: {} },
      });
      await pipeline.acceptanceGate.evaluate({
        runId: "r", workflowId: "w", artifactType: "t", artifactData: {},
      });

      const elapsedMs = Date.now() - startMs;
      // Entire pipeline should complete in under 500ms (no I/O)
      expect(elapsedMs).toBeLessThan(500);
    });
  });
});
