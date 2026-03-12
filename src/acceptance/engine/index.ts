/**
 * Acceptance Testing Engine — barrel export.
 *
 * @module acceptance/engine
 */

// ─── Assertion Engine ───

export {
  evaluateAssertion,
  validateSchema,
  scoreQualityDimension,
  deepEqual,
  resolveJsonPath,
  registerCustomHandler,
  unregisterCustomHandler,
  clearCustomHandlers,
} from "./assertion-engine.js";
export type { CustomAssertionHandler } from "./assertion-engine.js";

// ─── Fixture Manager ───

export { AcceptanceFixtureManager } from "./fixture-manager.js";
export type {
  AcceptanceFixture,
  FixtureLoadOptions,
  FixtureManagerStats,
} from "./fixture-manager.js";

// ─── Coverage Tracker ───

export { AcceptanceCoverageTracker } from "./coverage-tracker.js";
export type {
  TestCoverageEntry,
  CoverageSummary,
  ArtifactTypeCoverage,
  CheckTypeCoverage,
  TagCoverage,
} from "./coverage-tracker.js";

// ─── Snapshot Manager ───

export { AcceptanceSnapshotManager, computeDiffs } from "./snapshot-manager.js";
export type {
  Snapshot,
  SnapshotCompareResult,
  SnapshotDiff,
  SnapshotCompareOptions,
} from "./snapshot-manager.js";

// ─── Result Reporter ───

export {
  aggregateVerdicts,
  aggregateSeverities,
  buildRunResult,
  buildSuiteReport,
  formatCheckSummary,
  formatRunReport,
} from "./result-reporter.js";
export type {
  AcceptanceSuiteReport,
  ReportTotals,
} from "./result-reporter.js";

// ─── Test Suite Runner ───

export {
  AcceptanceTestSuiteRunner,
  InMemoryTestRegistry,
  defaultContentResolver,
} from "./test-suite-runner.js";
export type {
  ArtifactContentResolver,
  TestSuiteRunnerOptions,
} from "./test-suite-runner.js";

// ─── Acceptance Gate ───

export {
  createAcceptanceGate,
} from "./acceptance-gate.js";
export type {
  AcceptanceGate,
  AcceptanceGateConfig,
  AcceptanceGateResult,
} from "./acceptance-gate.js";
