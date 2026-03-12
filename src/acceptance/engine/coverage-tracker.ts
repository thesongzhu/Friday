/**
 * Coverage Tracker — track which rules, paths, and conditions have been tested.
 *
 * Maintains a running tally of acceptance test coverage across:
 * - Artifact types tested
 * - Check types exercised
 * - Verdict outcomes observed (pass/fail/warn)
 * - Individual test coverage (which tests have been run)
 * - Tag coverage (which tags have been exercised)
 *
 * Designed for deterministic, in-memory tracking with no external dependencies.
 *
 * @module acceptance/engine
 */

import type {
  FridayAcceptanceArtifactType,
  FridayAcceptanceCheckType,
  FridayAcceptanceRunResult,
  FridayAcceptanceTest,
  FridayAcceptanceVerdictOutcome,
} from "../model/friday-acceptance.types.js";

// ─── Types ───

/**
 * Coverage entry for a single acceptance test.
 */
export interface TestCoverageEntry {
  /** Test ID. */
  testId: string;
  /** Test name. */
  testName: string;
  /** Artifact type targeted. */
  artifactType: FridayAcceptanceArtifactType;
  /** Check type of the test. */
  checkType: FridayAcceptanceCheckType;
  /** Number of times this test has been executed. */
  executionCount: number;
  /** Number of times this test produced each verdict. */
  verdictCounts: Record<FridayAcceptanceVerdictOutcome, number>;
  /** Number of times this test was skipped. */
  skipCount: number;
  /** Tags associated with this test. */
  tags: string[];
}

/**
 * Aggregate coverage summary.
 */
export interface CoverageSummary {
  /** Total registered tests. */
  totalTests: number;
  /** Tests that have been executed at least once. */
  coveredTests: number;
  /** Tests that have never been executed. */
  uncoveredTests: number;
  /** Coverage percentage (0–100). */
  coveragePercent: number;
  /** Coverage per artifact type. */
  byArtifactType: Record<string, ArtifactTypeCoverage>;
  /** Coverage per check type. */
  byCheckType: Record<string, CheckTypeCoverage>;
  /** Coverage per tag. */
  byTag: Record<string, TagCoverage>;
  /** Total acceptance runs recorded. */
  totalRuns: number;
  /** Aggregate verdict counts across all runs. */
  verdictTotals: Record<FridayAcceptanceVerdictOutcome, number>;
}

/**
 * Coverage breakdown for a single artifact type.
 */
export interface ArtifactTypeCoverage {
  /** Number of tests for this artifact type. */
  totalTests: number;
  /** Tests executed at least once. */
  coveredTests: number;
  /** Total executions for this artifact type. */
  totalExecutions: number;
}

/**
 * Coverage breakdown for a single check type.
 */
export interface CheckTypeCoverage {
  /** Number of tests using this check type. */
  totalTests: number;
  /** Tests executed at least once. */
  coveredTests: number;
  /** Total executions for this check type. */
  totalExecutions: number;
}

/**
 * Coverage breakdown for a tag.
 */
export interface TagCoverage {
  /** Number of tests with this tag. */
  totalTests: number;
  /** Tests with this tag that have been executed at least once. */
  coveredTests: number;
}

// ─── Coverage Tracker ───

/**
 * In-memory acceptance test coverage tracker.
 *
 * Usage:
 * 1. Register tests as they are added to the registry.
 * 2. Record run results as acceptance runs complete.
 * 3. Query coverage summary at any time.
 */
export class AcceptanceCoverageTracker {
  /** testId → coverage entry */
  private readonly entries = new Map<string, TestCoverageEntry>();
  private totalRuns = 0;
  private readonly verdictTotals: Record<FridayAcceptanceVerdictOutcome, number> = {
    pass: 0,
    fail: 0,
    warn: 0,
  };

  /**
   * Register a test for coverage tracking.
   * Must be called before recording results for this test.
   *
   * @param test - Acceptance test definition.
   */
  registerTest(test: FridayAcceptanceTest): void {
    if (this.entries.has(test.id)) return;

    this.entries.set(test.id, {
      testId: test.id,
      testName: test.name,
      artifactType: test.artifactType,
      checkType: test.checkConfig.checkType,
      executionCount: 0,
      verdictCounts: { pass: 0, fail: 0, warn: 0 },
      skipCount: 0,
      tags: [...test.tags],
    });
  }

  /**
   * Unregister a test from coverage tracking.
   *
   * @param testId - Test ID to remove.
   * @returns `true` if the test was tracked and removed.
   */
  unregisterTest(testId: string): boolean {
    return this.entries.delete(testId);
  }

  /**
   * Record results from an acceptance run.
   * Updates coverage counts for each check in the run.
   *
   * @param result - Acceptance run result.
   */
  recordRun(result: FridayAcceptanceRunResult): void {
    this.totalRuns++;
    this.verdictTotals[result.overallVerdict]++;

    for (const check of result.checks) {
      const entry = this.entries.get(check.testId);
      if (!entry) continue;

      if (check.status === "executed") {
        entry.executionCount++;
        entry.verdictCounts[check.verdict]++;
      } else {
        entry.skipCount++;
      }
    }
  }

  /**
   * Get coverage data for a single test.
   *
   * @param testId - Test ID.
   * @returns Coverage entry, or `undefined` if not tracked.
   */
  getTestCoverage(testId: string): TestCoverageEntry | undefined {
    return this.entries.get(testId);
  }

  /**
   * Get the full coverage summary.
   */
  getSummary(): CoverageSummary {
    const totalTests = this.entries.size;
    let coveredTests = 0;

    const byArtifactType: Record<string, ArtifactTypeCoverage> = {};
    const byCheckType: Record<string, CheckTypeCoverage> = {};
    const byTag: Record<string, TagCoverage> = {};

    for (const entry of this.entries.values()) {
      const isCovered = entry.executionCount > 0;
      if (isCovered) coveredTests++;

      // Artifact type coverage.
      if (!byArtifactType[entry.artifactType]) {
        byArtifactType[entry.artifactType] = { totalTests: 0, coveredTests: 0, totalExecutions: 0 };
      }
      byArtifactType[entry.artifactType].totalTests++;
      if (isCovered) byArtifactType[entry.artifactType].coveredTests++;
      byArtifactType[entry.artifactType].totalExecutions += entry.executionCount;

      // Check type coverage.
      if (!byCheckType[entry.checkType]) {
        byCheckType[entry.checkType] = { totalTests: 0, coveredTests: 0, totalExecutions: 0 };
      }
      byCheckType[entry.checkType].totalTests++;
      if (isCovered) byCheckType[entry.checkType].coveredTests++;
      byCheckType[entry.checkType].totalExecutions += entry.executionCount;

      // Tag coverage.
      for (const tag of entry.tags) {
        if (!byTag[tag]) {
          byTag[tag] = { totalTests: 0, coveredTests: 0 };
        }
        byTag[tag].totalTests++;
        if (isCovered) byTag[tag].coveredTests++;
      }
    }

    return {
      totalTests,
      coveredTests,
      uncoveredTests: totalTests - coveredTests,
      coveragePercent: totalTests > 0 ? Math.round((coveredTests / totalTests) * 10000) / 100 : 100,
      byArtifactType,
      byCheckType,
      byTag,
      totalRuns: this.totalRuns,
      verdictTotals: { ...this.verdictTotals },
    };
  }

  /**
   * List all uncovered test IDs (never executed).
   */
  getUncoveredTestIds(): string[] {
    const ids: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.executionCount === 0) {
        ids.push(entry.testId);
      }
    }
    return ids;
  }

  /**
   * Reset all coverage data while keeping test registrations.
   */
  resetCounts(): void {
    this.totalRuns = 0;
    this.verdictTotals.pass = 0;
    this.verdictTotals.fail = 0;
    this.verdictTotals.warn = 0;

    for (const entry of this.entries.values()) {
      entry.executionCount = 0;
      entry.verdictCounts.pass = 0;
      entry.verdictCounts.fail = 0;
      entry.verdictCounts.warn = 0;
      entry.skipCount = 0;
    }
  }

  /**
   * Clear all tracking data including test registrations.
   */
  clear(): void {
    this.entries.clear();
    this.totalRuns = 0;
    this.verdictTotals.pass = 0;
    this.verdictTotals.fail = 0;
    this.verdictTotals.warn = 0;
  }
}
