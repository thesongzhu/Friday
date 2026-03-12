import { describe, it, expect, beforeEach } from "vitest";
import { AcceptanceCoverageTracker } from "../../../../src/acceptance/engine/coverage-tracker.js";
import type {
  FridayAcceptanceTest,
  FridayAcceptanceRunResult,
} from "../../../../src/acceptance/model/friday-acceptance.types.js";

// ─── Helpers ───

function makeTest(overrides: Partial<FridayAcceptanceTest> = {}): FridayAcceptanceTest {
  return {
    id: overrides.id ?? "test-1",
    name: overrides.name ?? "Test One",
    artifactType: overrides.artifactType ?? "json",
    checkConfig: overrides.checkConfig ?? { checkType: "schema", schema: { type: "object" } },
    priority: overrides.priority ?? 100,
    enabled: overrides.enabled ?? true,
    shortCircuit: overrides.shortCircuit ?? false,
    tags: overrides.tags ?? ["core"],
    version: 1,
    etag: "etag-1",
    createdAt: "2026-02-24T00:00:00Z",
    updatedAt: "2026-02-24T00:00:00Z",
  };
}

function makeRunResult(overrides: Partial<FridayAcceptanceRunResult> = {}): FridayAcceptanceRunResult {
  return {
    id: overrides.id ?? "run-1",
    executionId: overrides.executionId ?? "exec-1",
    artifactUri: overrides.artifactUri ?? "artifact://test",
    artifactType: overrides.artifactType ?? "json",
    overallVerdict: overrides.overallVerdict ?? "pass",
    overallSeverity: overrides.overallSeverity ?? "info",
    checks: overrides.checks ?? [{
      id: "check-1",
      runId: "run-1",
      testId: "test-1",
      checkType: "schema",
      status: "executed",
      verdict: "pass",
      severity: "info",
      evidence: [],
      durationMs: 5,
      createdAt: "2026-02-24T00:00:00Z",
    }],
    checksTotal: overrides.checksTotal ?? 1,
    checksPassed: overrides.checksPassed ?? 1,
    checksFailed: overrides.checksFailed ?? 0,
    checksWarned: overrides.checksWarned ?? 0,
    checksSkipped: overrides.checksSkipped ?? 0,
    durationMs: overrides.durationMs ?? 10,
    createdAt: overrides.createdAt ?? "2026-02-24T00:00:00Z",
  };
}

// ─── Tests ───

describe("AcceptanceCoverageTracker", () => {
  let tracker: AcceptanceCoverageTracker;

  beforeEach(() => {
    tracker = new AcceptanceCoverageTracker();
  });

  // ─── registerTest ───

  describe("registerTest", () => {
    it("registers a test for tracking", () => {
      const test = makeTest();
      tracker.registerTest(test);

      const entry = tracker.getTestCoverage("test-1");
      expect(entry).toBeDefined();
      expect(entry!.testId).toBe("test-1");
      expect(entry!.executionCount).toBe(0);
    });

    it("does not duplicate on re-registration", () => {
      const test = makeTest();
      tracker.registerTest(test);
      tracker.registerTest(test); // should be a no-op

      const summary = tracker.getSummary();
      expect(summary.totalTests).toBe(1);
    });
  });

  // ─── unregisterTest ───

  describe("unregisterTest", () => {
    it("removes a tracked test", () => {
      tracker.registerTest(makeTest());
      expect(tracker.unregisterTest("test-1")).toBe(true);
      expect(tracker.getTestCoverage("test-1")).toBeUndefined();
    });

    it("returns false for unknown test", () => {
      expect(tracker.unregisterTest("nonexistent")).toBe(false);
    });
  });

  // ─── recordRun ───

  describe("recordRun", () => {
    it("increments execution count for executed checks", () => {
      tracker.registerTest(makeTest());

      tracker.recordRun(makeRunResult());

      const entry = tracker.getTestCoverage("test-1");
      expect(entry!.executionCount).toBe(1);
      expect(entry!.verdictCounts.pass).toBe(1);
    });

    it("increments skip count for skipped checks", () => {
      tracker.registerTest(makeTest());

      tracker.recordRun(makeRunResult({
        checks: [{
          id: "check-1",
          runId: "run-1",
          testId: "test-1",
          checkType: "schema",
          status: "skipped",
          skipReason: "Short-circuited",
          createdAt: "2026-02-24T00:00:00Z",
        }],
      }));

      const entry = tracker.getTestCoverage("test-1");
      expect(entry!.skipCount).toBe(1);
      expect(entry!.executionCount).toBe(0);
    });

    it("tracks verdict totals across runs", () => {
      tracker.registerTest(makeTest());

      tracker.recordRun(makeRunResult({ overallVerdict: "pass" }));
      tracker.recordRun(makeRunResult({ id: "run-2", overallVerdict: "fail" }));
      tracker.recordRun(makeRunResult({ id: "run-3", overallVerdict: "warn" }));

      const summary = tracker.getSummary();
      expect(summary.totalRuns).toBe(3);
      expect(summary.verdictTotals.pass).toBe(1);
      expect(summary.verdictTotals.fail).toBe(1);
      expect(summary.verdictTotals.warn).toBe(1);
    });

    it("ignores checks for unregistered tests", () => {
      // Don't register any test — the check's testId won't match.
      tracker.recordRun(makeRunResult());

      const summary = tracker.getSummary();
      expect(summary.totalRuns).toBe(1);
      expect(summary.totalTests).toBe(0);
    });
  });

  // ─── getSummary ───

  describe("getSummary", () => {
    it("computes coverage percentage", () => {
      tracker.registerTest(makeTest({ id: "t1" }));
      tracker.registerTest(makeTest({ id: "t2" }));

      // Only execute t1.
      tracker.recordRun(makeRunResult({
        checks: [{
          id: "c1",
          runId: "run-1",
          testId: "t1",
          checkType: "schema",
          status: "executed",
          verdict: "pass",
          severity: "info",
          evidence: [],
          durationMs: 1,
          createdAt: "2026-02-24T00:00:00Z",
        }],
      }));

      const summary = tracker.getSummary();
      expect(summary.totalTests).toBe(2);
      expect(summary.coveredTests).toBe(1);
      expect(summary.uncoveredTests).toBe(1);
      expect(summary.coveragePercent).toBe(50);
    });

    it("returns 100% coverage for empty tracker", () => {
      expect(tracker.getSummary().coveragePercent).toBe(100);
    });

    it("breaks down by artifact type", () => {
      tracker.registerTest(makeTest({ id: "t1", artifactType: "json" }));
      tracker.registerTest(makeTest({ id: "t2", artifactType: "text" }));

      const summary = tracker.getSummary();
      expect(summary.byArtifactType["json"]?.totalTests).toBe(1);
      expect(summary.byArtifactType["text"]?.totalTests).toBe(1);
    });

    it("breaks down by check type", () => {
      tracker.registerTest(makeTest({
        id: "t1",
        checkConfig: { checkType: "schema", schema: {} },
      }));
      tracker.registerTest(makeTest({
        id: "t2",
        checkConfig: { checkType: "quality", dimension: "completeness", minScore: 50 },
      }));

      const summary = tracker.getSummary();
      expect(summary.byCheckType["schema"]?.totalTests).toBe(1);
      expect(summary.byCheckType["quality"]?.totalTests).toBe(1);
    });

    it("breaks down by tag", () => {
      tracker.registerTest(makeTest({ id: "t1", tags: ["core", "v1"] }));
      tracker.registerTest(makeTest({ id: "t2", tags: ["core"] }));

      const summary = tracker.getSummary();
      expect(summary.byTag["core"]?.totalTests).toBe(2);
      expect(summary.byTag["v1"]?.totalTests).toBe(1);
    });
  });

  // ─── getUncoveredTestIds ───

  describe("getUncoveredTestIds", () => {
    it("returns IDs of tests never executed", () => {
      tracker.registerTest(makeTest({ id: "t1" }));
      tracker.registerTest(makeTest({ id: "t2" }));

      tracker.recordRun(makeRunResult({
        checks: [{
          id: "c1",
          runId: "run-1",
          testId: "t1",
          checkType: "schema",
          status: "executed",
          verdict: "pass",
          severity: "info",
          evidence: [],
          durationMs: 1,
          createdAt: "2026-02-24T00:00:00Z",
        }],
      }));

      expect(tracker.getUncoveredTestIds()).toEqual(["t2"]);
    });
  });

  // ─── resetCounts / clear ───

  describe("resetCounts and clear", () => {
    it("resetCounts preserves registrations but resets counters", () => {
      tracker.registerTest(makeTest());
      tracker.recordRun(makeRunResult());

      tracker.resetCounts();

      const entry = tracker.getTestCoverage("test-1");
      expect(entry).toBeDefined();
      expect(entry!.executionCount).toBe(0);
      expect(tracker.getSummary().totalRuns).toBe(0);
    });

    it("clear removes everything", () => {
      tracker.registerTest(makeTest());
      tracker.recordRun(makeRunResult());

      tracker.clear();

      expect(tracker.getTestCoverage("test-1")).toBeUndefined();
      expect(tracker.getSummary().totalTests).toBe(0);
    });
  });
});
