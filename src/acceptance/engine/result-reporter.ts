/**
 * Result Reporter — structured test results with pass/fail/skip/error per assertion.
 *
 * Aggregates individual check results into per-run and per-suite reports.
 * Implements worst-verdict-wins aggregation as defined in the RFC.
 *
 * @module acceptance/engine
 */

import {
  AcceptanceRunState,
} from "../model/friday-acceptance.types.js";

import type {
  FridayAcceptanceArtifactType,
  FridayAcceptanceCheck,
  FridayAcceptanceEvidence,
  FridayAcceptanceRollbackEvent,
  FridayAcceptanceRunResult,
  FridayAcceptanceRunStateTransition,
  FridayAcceptanceSeverity,
  FridayAcceptanceVerdictOutcome,
  FridayExecutedAcceptanceCheck,
  FridaySkippedAcceptanceCheck,
} from "../model/friday-acceptance.types.js";

import {
  FRIDAY_ACCEPTANCE_SEVERITY_PRIORITY,
  FRIDAY_ACCEPTANCE_VERDICT_PRIORITY,
} from "../model/friday-acceptance.types.js";

import type { UUID } from "../../rules/model/friday-rules-engine.types.js";

// ─── Types ───

/**
 * Suite-level report aggregating multiple run results.
 */
export interface AcceptanceSuiteReport {
  /** Whether all runs in the suite passed. */
  passed: boolean;
  /** Overall verdict across all runs (worst-verdict-wins). */
  overallVerdict: FridayAcceptanceVerdictOutcome;
  /** Overall severity across all runs. */
  overallSeverity: FridayAcceptanceSeverity;
  /** Per-run reports. */
  runs: FridayAcceptanceRunResult[];
  /** Aggregate counts. */
  totals: ReportTotals;
  /** Total suite duration in milliseconds. */
  durationMs: number;
  /** When this report was generated (ISO 8601). */
  generatedAt: string;
}

/**
 * Aggregate check counts across an entire suite or run.
 */
export interface ReportTotals {
  /** Total checks across all runs. */
  checksTotal: number;
  /** Total passed checks. */
  checksPassed: number;
  /** Total failed checks. */
  checksFailed: number;
  /** Total warned checks. */
  checksWarned: number;
  /** Total skipped checks. */
  checksSkipped: number;
  /** Total runs. */
  runsTotal: number;
  /** Runs that passed. */
  runsPassed: number;
  /** Runs that failed. */
  runsFailed: number;
  /** Runs that warned. */
  runsWarned: number;
}

/** Optional lifecycle metadata attached to a run result. */
export interface BuildRunResultLifecycleOptions {
  state?: AcceptanceRunState;
  stateTransitions?: FridayAcceptanceRunStateTransition[];
  rollbackEvent?: FridayAcceptanceRollbackEvent;
}

// ─── Verdict Aggregation ───

/**
 * Aggregate multiple verdicts using worst-verdict-wins semantics.
 * Priority: fail > warn > pass.
 *
 * @param verdicts - Array of verdicts to aggregate.
 * @returns The worst (highest priority) verdict. Defaults to "pass" for empty input.
 */
export function aggregateVerdicts(verdicts: FridayAcceptanceVerdictOutcome[]): FridayAcceptanceVerdictOutcome {
  if (verdicts.length === 0) return "pass";

  let worst: FridayAcceptanceVerdictOutcome = "pass";
  let worstIndex = FRIDAY_ACCEPTANCE_VERDICT_PRIORITY.indexOf("pass");

  for (const verdict of verdicts) {
    const index = FRIDAY_ACCEPTANCE_VERDICT_PRIORITY.indexOf(verdict);
    if (index < worstIndex) {
      worst = verdict;
      worstIndex = index;
    }
  }

  return worst;
}

/**
 * Aggregate multiple severities using worst-severity-wins semantics.
 * Priority: critical > major > minor > info.
 *
 * @param severities - Array of severities to aggregate.
 * @returns The worst (highest priority) severity. Defaults to "info" for empty input.
 */
export function aggregateSeverities(severities: FridayAcceptanceSeverity[]): FridayAcceptanceSeverity {
  if (severities.length === 0) return "info";

  let worst: FridayAcceptanceSeverity = "info";
  let worstIndex = FRIDAY_ACCEPTANCE_SEVERITY_PRIORITY.indexOf("info");

  for (const severity of severities) {
    const index = FRIDAY_ACCEPTANCE_SEVERITY_PRIORITY.indexOf(severity);
    if (index < worstIndex) {
      worst = severity;
      worstIndex = index;
    }
  }

  return worst;
}

// ─── Run Result Builder ───

/**
 * Build a {@link FridayAcceptanceRunResult} from individual check results.
 *
 * @param runId - Unique run identifier.
 * @param executionId - Parent NodeRunner execution ID.
 * @param artifactUri - URI of the artifact being tested.
 * @param artifactType - Artifact type.
 * @param checks - Individual check results.
 * @param durationMs - Total run duration in milliseconds.
 * @returns Fully assembled run result with aggregated verdict and counts.
 */
export function buildRunResult(
  runId: UUID,
  executionId: UUID,
  artifactUri: string,
  artifactType: FridayAcceptanceArtifactType,
  checks: FridayAcceptanceCheck[],
  durationMs: number,
  lifecycle?: BuildRunResultLifecycleOptions,
): FridayAcceptanceRunResult {
  const executed = checks.filter((c): c is FridayExecutedAcceptanceCheck => c.status === "executed");
  const skipped = checks.filter((c): c is FridaySkippedAcceptanceCheck => c.status === "skipped");

  const passed = executed.filter((c) => c.verdict === "pass").length;
  const failed = executed.filter((c) => c.verdict === "fail").length;
  const warned = executed.filter((c) => c.verdict === "warn").length;

  const verdicts = executed.map((c) => c.verdict);
  const severities = executed.map((c) => c.severity);
  const overallVerdict = aggregateVerdicts(verdicts);
  const overallSeverity = aggregateSeverities(severities);
  const now = new Date().toISOString();
  const defaultState: AcceptanceRunState = overallVerdict === "fail"
    ? AcceptanceRunState.Failed
    : AcceptanceRunState.Passed;
  const defaultTransitions: FridayAcceptanceRunStateTransition[] = [
    {
      from: AcceptanceRunState.Pending,
      to: AcceptanceRunState.Running,
      at: now,
      reason: "started",
    },
    {
      from: AcceptanceRunState.Running,
      to: defaultState,
      at: now,
      reason: defaultState === AcceptanceRunState.Failed ? "checks_failed" : "checks_passed",
    },
  ];

  return {
    id: runId,
    executionId,
    artifactUri,
    artifactType,
    overallVerdict,
    overallSeverity,
    state: lifecycle?.state ?? defaultState,
    stateTransitions: lifecycle?.stateTransitions ?? defaultTransitions,
    rollbackEvent: lifecycle?.rollbackEvent,
    checks,
    checksTotal: checks.length,
    checksPassed: passed,
    checksFailed: failed,
    checksWarned: warned,
    checksSkipped: skipped.length,
    durationMs,
    createdAt: now,
  };
}

// ─── Suite Report Builder ───

/**
 * Build a suite-level report from multiple run results.
 *
 * @param runs - Array of run results.
 * @param durationMs - Total suite duration in milliseconds.
 * @returns Aggregated suite report.
 */
export function buildSuiteReport(
  runs: FridayAcceptanceRunResult[],
  durationMs: number,
): AcceptanceSuiteReport {
  const runVerdicts = runs.map((r) => r.overallVerdict);
  const runSeverities = runs.map((r) => r.overallSeverity);

  const overallVerdict = aggregateVerdicts(runVerdicts);
  const overallSeverity = aggregateSeverities(runSeverities);

  const totals: ReportTotals = {
    checksTotal: 0,
    checksPassed: 0,
    checksFailed: 0,
    checksWarned: 0,
    checksSkipped: 0,
    runsTotal: runs.length,
    runsPassed: 0,
    runsFailed: 0,
    runsWarned: 0,
  };

  for (const run of runs) {
    totals.checksTotal += run.checksTotal;
    totals.checksPassed += run.checksPassed;
    totals.checksFailed += run.checksFailed;
    totals.checksWarned += run.checksWarned;
    totals.checksSkipped += run.checksSkipped;

    if (run.overallVerdict === "pass") totals.runsPassed++;
    else if (run.overallVerdict === "fail") totals.runsFailed++;
    else if (run.overallVerdict === "warn") totals.runsWarned++;
  }

  return {
    passed: overallVerdict === "pass" || overallVerdict === "warn",
    overallVerdict,
    overallSeverity,
    runs,
    totals,
    durationMs,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Formatting Utilities ───

/**
 * Format a check result as a human-readable summary line.
 */
export function formatCheckSummary(check: FridayAcceptanceCheck): string {
  if (check.status === "skipped") {
    return `[SKIP] ${check.checkType} (test: ${check.testId})${check.skipReason ? ` — ${check.skipReason}` : ""}`;
  }

  const icon = check.verdict === "pass" ? "✓" : check.verdict === "fail" ? "✗" : "⚠";
  const evidenceMsg = check.evidence.length > 0 ? ` — ${check.evidence[0].message}` : "";
  return `[${icon} ${check.verdict.toUpperCase()}] ${check.checkType} (test: ${check.testId})${evidenceMsg}`;
}

/**
 * Format a run result as a multi-line human-readable report.
 */
export function formatRunReport(run: FridayAcceptanceRunResult): string {
  const lines: string[] = [
    `Acceptance Run: ${run.id}`,
    `Artifact: ${run.artifactUri} (${run.artifactType})`,
    `Verdict: ${run.overallVerdict.toUpperCase()} | Severity: ${run.overallSeverity}`,
    `Checks: ${run.checksPassed} passed, ${run.checksFailed} failed, ${run.checksWarned} warned, ${run.checksSkipped} skipped (${run.checksTotal} total)`,
    `Duration: ${run.durationMs}ms`,
    "",
  ];

  for (const check of run.checks) {
    lines.push(`  ${formatCheckSummary(check)}`);
  }

  return lines.join("\n");
}
