import { describe, it, expect } from "vitest";
import {
  aggregateVerdicts,
  aggregateSeverities,
  buildRunResult,
  buildSuiteReport,
  formatCheckSummary,
  formatRunReport,
} from "../../../../src/acceptance/engine/result-reporter.js";
import type {
  FridayAcceptanceCheck,
  FridayExecutedAcceptanceCheck,
  FridaySkippedAcceptanceCheck,
  FridayAcceptanceRunResult,
} from "../../../../src/acceptance/model/friday-acceptance.types.js";

// ─── Helpers ───

function makeExecutedCheck(
  verdict: "pass" | "fail" | "warn",
  severity: "critical" | "major" | "minor" | "info" = "info",
): FridayExecutedAcceptanceCheck {
  return {
    id: `check-${Math.random().toString(36).slice(2, 8)}`,
    runId: "run-1",
    testId: "test-1",
    checkType: "schema",
    status: "executed",
    verdict,
    severity,
    evidence: [{ checkId: "test-1", checkType: "schema", message: `Check ${verdict}` }],
    durationMs: 5,
    createdAt: "2026-02-24T00:00:00Z",
  };
}

function makeSkippedCheck(): FridaySkippedAcceptanceCheck {
  return {
    id: `check-${Math.random().toString(36).slice(2, 8)}`,
    runId: "run-1",
    testId: "test-1",
    checkType: "schema",
    status: "skipped",
    skipReason: "Short-circuited",
    createdAt: "2026-02-24T00:00:00Z",
  };
}

// ─── aggregateVerdicts ───

describe("aggregateVerdicts", () => {
  it("returns pass for empty input", () => {
    expect(aggregateVerdicts([])).toBe("pass");
  });

  it("returns pass when all pass", () => {
    expect(aggregateVerdicts(["pass", "pass", "pass"])).toBe("pass");
  });

  it("returns warn when worst is warn", () => {
    expect(aggregateVerdicts(["pass", "warn", "pass"])).toBe("warn");
  });

  it("returns fail when any fail", () => {
    expect(aggregateVerdicts(["pass", "warn", "fail"])).toBe("fail");
  });

  it("returns fail for single fail", () => {
    expect(aggregateVerdicts(["fail"])).toBe("fail");
  });
});

// ─── aggregateSeverities ───

describe("aggregateSeverities", () => {
  it("returns info for empty input", () => {
    expect(aggregateSeverities([])).toBe("info");
  });

  it("returns info when all info", () => {
    expect(aggregateSeverities(["info", "info"])).toBe("info");
  });

  it("returns minor when worst is minor", () => {
    expect(aggregateSeverities(["info", "minor"])).toBe("minor");
  });

  it("returns major when worst is major", () => {
    expect(aggregateSeverities(["info", "minor", "major"])).toBe("major");
  });

  it("returns critical when any critical", () => {
    expect(aggregateSeverities(["info", "critical", "minor"])).toBe("critical");
  });
});

// ─── buildRunResult ───

describe("buildRunResult", () => {
  it("builds result with correct counts", () => {
    const checks: FridayAcceptanceCheck[] = [
      makeExecutedCheck("pass"),
      makeExecutedCheck("fail", "major"),
      makeSkippedCheck(),
    ];

    const result = buildRunResult("run-1", "exec-1", "artifact://test", "json", checks, 50);

    expect(result.id).toBe("run-1");
    expect(result.executionId).toBe("exec-1");
    expect(result.artifactUri).toBe("artifact://test");
    expect(result.artifactType).toBe("json");
    expect(result.checksTotal).toBe(3);
    expect(result.checksPassed).toBe(1);
    expect(result.checksFailed).toBe(1);
    expect(result.checksWarned).toBe(0);
    expect(result.checksSkipped).toBe(1);
    expect(result.durationMs).toBe(50);
  });

  it("aggregates to worst verdict", () => {
    const checks: FridayAcceptanceCheck[] = [
      makeExecutedCheck("pass"),
      makeExecutedCheck("warn", "minor"),
    ];

    const result = buildRunResult("run-1", "exec-1", "uri", "json", checks, 10);
    expect(result.overallVerdict).toBe("warn");
  });

  it("aggregates to worst severity", () => {
    const checks: FridayAcceptanceCheck[] = [
      makeExecutedCheck("fail", "minor"),
      makeExecutedCheck("fail", "critical"),
    ];

    const result = buildRunResult("run-1", "exec-1", "uri", "json", checks, 10);
    expect(result.overallSeverity).toBe("critical");
  });

  it("handles empty checks", () => {
    const result = buildRunResult("run-1", "exec-1", "uri", "json", [], 0);
    expect(result.overallVerdict).toBe("pass");
    expect(result.overallSeverity).toBe("info");
    expect(result.checksTotal).toBe(0);
  });
});

// ─── buildSuiteReport ───

describe("buildSuiteReport", () => {
  function makeRunResult(verdict: "pass" | "fail" | "warn"): FridayAcceptanceRunResult {
    return {
      id: `run-${Math.random().toString(36).slice(2, 8)}`,
      executionId: "exec-1",
      artifactUri: "uri",
      artifactType: "json",
      overallVerdict: verdict,
      overallSeverity: "info",
      checks: [makeExecutedCheck(verdict)],
      checksTotal: 1,
      checksPassed: verdict === "pass" ? 1 : 0,
      checksFailed: verdict === "fail" ? 1 : 0,
      checksWarned: verdict === "warn" ? 1 : 0,
      checksSkipped: 0,
      durationMs: 10,
      createdAt: "2026-02-24T00:00:00Z",
    };
  }

  it("reports passed when all runs pass", () => {
    const report = buildSuiteReport([makeRunResult("pass"), makeRunResult("pass")], 20);
    expect(report.passed).toBe(true);
    expect(report.overallVerdict).toBe("pass");
  });

  it("reports passed for warn-only (warn does not block)", () => {
    const report = buildSuiteReport([makeRunResult("pass"), makeRunResult("warn")], 20);
    expect(report.passed).toBe(true);
    expect(report.overallVerdict).toBe("warn");
  });

  it("reports not passed when any run fails", () => {
    const report = buildSuiteReport([makeRunResult("pass"), makeRunResult("fail")], 20);
    expect(report.passed).toBe(false);
    expect(report.overallVerdict).toBe("fail");
  });

  it("computes correct totals", () => {
    const report = buildSuiteReport(
      [makeRunResult("pass"), makeRunResult("fail"), makeRunResult("warn")],
      30,
    );

    expect(report.totals.runsTotal).toBe(3);
    expect(report.totals.runsPassed).toBe(1);
    expect(report.totals.runsFailed).toBe(1);
    expect(report.totals.runsWarned).toBe(1);
    expect(report.totals.checksTotal).toBe(3);
  });

  it("handles empty runs", () => {
    const report = buildSuiteReport([], 0);
    expect(report.passed).toBe(true);
    expect(report.overallVerdict).toBe("pass");
    expect(report.totals.runsTotal).toBe(0);
  });
});

// ─── formatCheckSummary ───

describe("formatCheckSummary", () => {
  it("formats executed pass", () => {
    const summary = formatCheckSummary(makeExecutedCheck("pass"));
    expect(summary).toContain("✓");
    expect(summary).toContain("PASS");
  });

  it("formats executed fail", () => {
    const summary = formatCheckSummary(makeExecutedCheck("fail"));
    expect(summary).toContain("✗");
    expect(summary).toContain("FAIL");
  });

  it("formats executed warn", () => {
    const summary = formatCheckSummary(makeExecutedCheck("warn"));
    expect(summary).toContain("⚠");
    expect(summary).toContain("WARN");
  });

  it("formats skipped check", () => {
    const summary = formatCheckSummary(makeSkippedCheck());
    expect(summary).toContain("SKIP");
    expect(summary).toContain("Short-circuited");
  });
});

// ─── formatRunReport ───

describe("formatRunReport", () => {
  it("produces multi-line report", () => {
    const checks: FridayAcceptanceCheck[] = [
      makeExecutedCheck("pass"),
      makeExecutedCheck("fail", "major"),
    ];

    const result = buildRunResult("run-1", "exec-1", "artifact://test", "json", checks, 50);
    const report = formatRunReport(result);

    expect(report).toContain("Acceptance Run: run-1");
    expect(report).toContain("artifact://test");
    expect(report).toContain("FAIL");
    expect(report).toContain("1 passed");
    expect(report).toContain("1 failed");
  });
});
