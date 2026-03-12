/**
 * A-004 Workflow Acceptance Gate Tests
 *
 * Validates acceptance gate as mandatory check before run completion.
 * Tests pass/warn/fail policy, severity blocking, and result structure.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createFridayWorkflowAcceptanceGate,
  type AcceptanceCheckOutcome,
  type AcceptanceGateDeps,
} from "../../../../src/workflows/engine/friday-workflow-acceptance-gate.js";

function makeOutcome(overrides: Partial<AcceptanceCheckOutcome> = {}): AcceptanceCheckOutcome {
  return {
    checkId: "chk-1",
    checkName: "Schema check",
    verdict: "pass",
    severity: "critical",
    ...overrides,
  };
}

function makeGate(outcomes: AcceptanceCheckOutcome[] = []) {
  const runAcceptanceChecks = vi.fn().mockResolvedValue(outcomes);
  const gate = createFridayWorkflowAcceptanceGate({
    runAcceptanceChecks,
    nowIso: () => "2026-01-01T00:00:00Z",
  });
  return { gate, runAcceptanceChecks };
}

describe("A-004 FridayWorkflowAcceptanceGate", () => {
  describe("pass scenarios", () => {
    it("returns pass when all checks pass", async () => {
      const { gate } = makeGate([
        makeOutcome({ checkId: "c1", verdict: "pass" }),
        makeOutcome({ checkId: "c2", verdict: "pass" }),
      ]);

      const result = await gate.evaluate({
        runId: "run-1", workflowId: "wf-1",
        artifactType: "workflow_run", artifactData: {},
      });

      expect(result.decision).toBe("pass");
      expect(result.blocksCompletion).toBe(false);
      expect(result.checksPassed).toBe(2);
      expect(result.checksWarned).toBe(0);
      expect(result.checksFailed).toBe(0);
    });

    it("returns pass with zero checks", async () => {
      const { gate } = makeGate([]);
      const result = await gate.evaluate({
        runId: "run-1", workflowId: "wf-1",
        artifactType: "workflow_run", artifactData: {},
      });

      expect(result.decision).toBe("pass");
      expect(result.checksRun).toBe(0);
    });
  });

  describe("warn scenarios", () => {
    it("returns warn when non-error failures exist", async () => {
      const { gate } = makeGate([
        makeOutcome({ checkId: "c1", verdict: "pass" }),
        makeOutcome({ checkId: "c2", verdict: "fail", severity: "minor", message: "Missing optional field" }),
      ]);

      const result = await gate.evaluate({
        runId: "run-1", workflowId: "wf-1",
        artifactType: "workflow_run", artifactData: {},
      });

      expect(result.decision).toBe("warn");
      expect(result.blocksCompletion).toBe(false);
      expect(result.checksWarned).toBe(1);
    });
  });

  describe("fail scenarios", () => {
    it("returns fail and blocks completion on error-severity failure", async () => {
      const { gate } = makeGate([
        makeOutcome({ checkId: "c1", verdict: "pass" }),
        makeOutcome({ checkId: "c2", verdict: "fail", severity: "critical", message: "Schema mismatch" }),
      ]);

      const result = await gate.evaluate({
        runId: "run-1", workflowId: "wf-1",
        artifactType: "workflow_run", artifactData: {},
      });

      expect(result.decision).toBe("fail");
      expect(result.blocksCompletion).toBe(true);
      expect(result.checksFailed).toBe(1);
    });

    it("multiple failures accumulate", async () => {
      const { gate } = makeGate([
        makeOutcome({ checkId: "c1", verdict: "fail", severity: "critical" }),
        makeOutcome({ checkId: "c2", verdict: "fail", severity: "critical" }),
        makeOutcome({ checkId: "c3", verdict: "fail", severity: "minor" }),
      ]);

      const result = await gate.evaluate({
        runId: "run-1", workflowId: "wf-1",
        artifactType: "workflow_run", artifactData: {},
      });

      expect(result.decision).toBe("fail");
      expect(result.checksFailed).toBe(2);
      expect(result.checksWarned).toBe(1);
    });
  });

  describe("policy overrides", () => {
    it("allows completion on error when errorBlocksCompletion=false", async () => {
      const { gate } = makeGate([
        makeOutcome({ checkId: "c1", verdict: "fail", severity: "critical" }),
      ]);

      const result = await gate.evaluate({
        runId: "run-1", workflowId: "wf-1",
        artifactType: "workflow_run", artifactData: {},
        policy: { errorBlocksCompletion: false },
      });

      expect(result.decision).toBe("fail");
      expect(result.blocksCompletion).toBe(false);
    });

    it("blocks completion on warn when warnAllowsCompletion=false", async () => {
      const { gate } = makeGate([
        makeOutcome({ checkId: "c1", verdict: "fail", severity: "minor" }),
      ]);

      const result = await gate.evaluate({
        runId: "run-1", workflowId: "wf-1",
        artifactType: "workflow_run", artifactData: {},
        policy: { warnAllowsCompletion: false },
      });

      expect(result.decision).toBe("warn");
      expect(result.blocksCompletion).toBe(true);
    });
  });

  describe("result structure", () => {
    it("includes all verdicts with details", async () => {
      const { gate } = makeGate([
        makeOutcome({ checkId: "c1", checkName: "Schema", verdict: "pass", severity: "critical" }),
        makeOutcome({ checkId: "c2", checkName: "Quality", verdict: "fail", severity: "minor", message: "Low score" }),
      ]);

      const result = await gate.evaluate({
        runId: "run-1", workflowId: "wf-1",
        artifactType: "workflow_run", artifactData: {},
      });

      expect(result.verdicts).toHaveLength(2);
      expect(result.verdicts[0]).toEqual({
        checkId: "c1", checkName: "Schema", verdict: "pass", severity: "critical", message: undefined,
      });
      expect(result.verdicts[1]).toEqual({
        checkId: "c2", checkName: "Quality", verdict: "fail", severity: "minor", message: "Low score",
      });
    });

    it("includes run/workflow IDs and timestamp", async () => {
      const { gate } = makeGate([]);
      const result = await gate.evaluate({
        runId: "r-42", workflowId: "wf-7",
        artifactType: "workflow_run", artifactData: {},
      });

      expect(result.runId).toBe("r-42");
      expect(result.workflowId).toBe("wf-7");
      expect(result.evaluatedAt).toBe("2026-01-01T00:00:00Z");
    });
  });

  describe("acceptance checks invocation", () => {
    it("passes artifact data and context to checks runner", async () => {
      const { gate, runAcceptanceChecks } = makeGate([]);
      await gate.evaluate({
        runId: "run-1", workflowId: "wf-1",
        artifactType: "output_json",
        artifactData: { key: "value" },
        context: { env: "staging" },
      });

      expect(runAcceptanceChecks).toHaveBeenCalledWith({
        runId: "run-1",
        artifactType: "output_json",
        artifactData: { key: "value" },
        context: { env: "staging" },
      });
    });
  });

  describe("regression matrix (pass/warn/fail)", () => {
    const cases: Array<{
      name: string;
      outcomes: AcceptanceCheckOutcome[];
      expected: { decision: string; blocksCompletion: boolean };
    }> = [
      {
        name: "all pass → pass, no block",
        outcomes: [makeOutcome({ verdict: "pass" })],
        expected: { decision: "pass", blocksCompletion: false },
      },
      {
        name: "warn only → warn, no block",
        outcomes: [makeOutcome({ verdict: "fail", severity: "minor" })],
        expected: { decision: "warn", blocksCompletion: false },
      },
      {
        name: "error fail → fail, blocks",
        outcomes: [makeOutcome({ verdict: "fail", severity: "critical" })],
        expected: { decision: "fail", blocksCompletion: true },
      },
      {
        name: "mixed pass+warn → warn, no block",
        outcomes: [
          makeOutcome({ checkId: "a", verdict: "pass" }),
          makeOutcome({ checkId: "b", verdict: "fail", severity: "minor" }),
        ],
        expected: { decision: "warn", blocksCompletion: false },
      },
      {
        name: "mixed pass+error → fail, blocks",
        outcomes: [
          makeOutcome({ checkId: "a", verdict: "pass" }),
          makeOutcome({ checkId: "b", verdict: "fail", severity: "critical" }),
        ],
        expected: { decision: "fail", blocksCompletion: true },
      },
      {
        name: "mixed warn+error → fail, blocks",
        outcomes: [
          makeOutcome({ checkId: "a", verdict: "fail", severity: "minor" }),
          makeOutcome({ checkId: "b", verdict: "fail", severity: "critical" }),
        ],
        expected: { decision: "fail", blocksCompletion: true },
      },
    ];

    for (const tc of cases) {
      it(tc.name, async () => {
        const { gate } = makeGate(tc.outcomes);
        const result = await gate.evaluate({
          runId: "run-1", workflowId: "wf-1",
          artifactType: "workflow_run", artifactData: {},
        });
        expect(result.decision).toBe(tc.expected.decision);
        expect(result.blocksCompletion).toBe(tc.expected.blocksCompletion);
      });
    }
  });
});
