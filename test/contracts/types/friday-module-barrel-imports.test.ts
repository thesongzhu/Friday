/**
 * Module Barrel Import Smoke Tests
 *
 * Verifies that every new #alias resolves at runtime and that each barrel
 * exposes the expected API, model, and engine exports. If an alias or barrel
 * is removed, these tests will fail — preventing silent regressions.
 *
 * Run: npm run test -- --run test/contracts/types/friday-module-barrel-imports.test.ts
 */

import { describe, it, expect } from "vitest";

// ─── Rules ────────────────────────────────────────────────────────────────

describe("#rules barrel", () => {
  it("exports API-layer runtime values", async () => {
    const mod = await import("#rules");
    expect(mod.FRIDAY_RULES_ERROR_CODES).toBeDefined();
    expect(typeof mod.FRIDAY_RULES_ERROR_CODES).toBe("object");
  });

  it("exports model-layer runtime values", async () => {
    const mod = await import("#rules");
    expect(mod.FRIDAY_RULE_DECISION_PRIORITY).toBeDefined();
  });

  it("exports engine-layer constructors", async () => {
    const mod = await import("#rules");
    expect(typeof mod.FridayRuleEngine).toBe("function");
    expect(typeof mod.FridayPolicyBundleManager).toBe("function");
    expect(typeof mod.FridayRuleIndex).toBe("function");
    expect(typeof mod.parsePolicyBundleYaml).toBe("function");
    expect(typeof mod.evaluateCondition).toBe("function");
    expect(typeof mod.redactContext).toBe("function");
  });
});

// ─── Node Runner ──────────────────────────────────────────────────────────

describe("#node-runner barrel", () => {
  it("exports API-layer runtime values", async () => {
    const mod = await import("#node-runner");
    expect(mod.FRIDAY_NODE_RUNNER_ERROR_CODES).toBeDefined();
    expect(typeof mod.FRIDAY_NODE_RUNNER_ERROR_CODES).toBe("object");
  });

  it("exports model-layer runtime values", async () => {
    const mod = await import("#node-runner");
    expect(mod.FRIDAY_NODE_RUNNER_STEP_ORDER).toBeDefined();
    expect(Array.isArray(mod.FRIDAY_NODE_RUNNER_STEP_ORDER)).toBe(true);
    expect(mod.FRIDAY_NODE_RUNNER_TRANSITIONS).toBeDefined();
  });

  it("exports engine-layer constructors", async () => {
    const mod = await import("#node-runner");
    expect(typeof mod.NodeRunnerPipeline).toBe("function");
    expect(typeof mod.createNodeRunnerPipeline).toBe("function");
    expect(typeof mod.NodeAdapterRegistry).toBe("function");
    expect(typeof mod.isValidTransition).toBe("function");
    expect(typeof mod.isTerminalState).toBe("function");
  });
});

// ─── Acceptance ───────────────────────────────────────────────────────────

describe("#acceptance barrel", () => {
  it("exports API-layer runtime values", async () => {
    const mod = await import("#acceptance");
    expect(mod.FRIDAY_ACCEPTANCE_ERROR_CODES).toBeDefined();
    expect(typeof mod.FRIDAY_ACCEPTANCE_ERROR_CODES).toBe("object");
    expect(typeof mod.FRIDAY_ACCEPTANCE_IDEMPOTENCY_TTL_HOURS).toBe("number");
  });

  it("exports model-layer runtime values", async () => {
    const mod = await import("#acceptance");
    expect(mod.FRIDAY_ACCEPTANCE_VERDICT_PRIORITY).toBeDefined();
    expect(mod.FRIDAY_ACCEPTANCE_SEVERITY_PRIORITY).toBeDefined();
    expect(typeof mod.canTransitionAcceptanceRunState).toBe("function");
  });

  it("exports engine-layer constructors", async () => {
    const mod = await import("#acceptance");
    expect(typeof mod.AcceptanceTestSuiteRunner).toBe("function");
    expect(typeof mod.AcceptanceCoverageTracker).toBe("function");
    expect(typeof mod.AcceptanceFixtureManager).toBe("function");
    expect(typeof mod.AcceptanceSnapshotManager).toBe("function");
    expect(typeof mod.evaluateAssertion).toBe("function");
    expect(typeof mod.aggregateVerdicts).toBe("function");
  });
});

// ─── Retry ────────────────────────────────────────────────────────────────

describe("#retry barrel", () => {
  it("exports API-layer runtime values", async () => {
    const mod = await import("#retry");
    expect(mod.FRIDAY_RETRY_ERROR_CODES).toBeDefined();
    expect(typeof mod.FRIDAY_RETRY_ERROR_CODES).toBe("object");
    expect(typeof mod.FRIDAY_RETRY_IDEMPOTENCY_TTL_HOURS).toBe("number");
  });

  it("exports model-layer runtime values", async () => {
    const mod = await import("#retry");
    expect(mod.FRIDAY_FAILURE_CATEGORY_PRIORITY).toBeDefined();
  });

  it("exports engine-layer constructors", async () => {
    const mod = await import("#retry");
    expect(typeof mod.createFailureClassifier).toBe("function");
    expect(typeof mod.createRetryStrategyEngine).toBe("function");
    expect(typeof mod.createCircuitBreakerManager).toBe("function");
    expect(typeof mod.createDeadLetterQueue).toBe("function");
    expect(typeof mod.createRetryBudget).toBe("function");
    expect(typeof mod.RetryOrchestrator).toBe("function");
    expect(typeof mod.createRetryOrchestrator).toBe("function");
  });
});

// ─── Playbook ─────────────────────────────────────────────────────────────

describe("#playbook barrel", () => {
  it("exports API-layer runtime values", async () => {
    const mod = await import("#playbook");
    expect(mod.FRIDAY_PLAYBOOK_ERROR_CODES).toBeDefined();
    expect(typeof mod.FRIDAY_PLAYBOOK_ERROR_CODES).toBe("object");
    expect(typeof mod.FRIDAY_PLAYBOOK_IDEMPOTENCY_TTL_HOURS).toBe("number");
  });

  it("exports model-layer runtime values", async () => {
    const mod = await import("#playbook");
    expect(mod.FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS).toBeDefined();
    expect(typeof mod.FRIDAY_PLAYBOOK_SCORE_DECAY_RATE).toBe("number");
    expect(mod.FRIDAY_PLAYBOOK_COST_NORMALIZATION_WEIGHTS).toBeDefined();
    expect(mod.FRIDAY_DEFAULT_PROMOTION_RULES).toBeDefined();
    expect(mod.FRIDAY_PLAYBOOK_TIE_BREAK_ORDER).toBeDefined();
  });

  it("exports engine-layer constructors", async () => {
    const mod = await import("#playbook");
    expect(typeof mod.createPlaybookStore).toBe("function");
    expect(typeof mod.createLearningEngine).toBe("function");
    expect(typeof mod.createPlaybookMatcher).toBe("function");
    expect(typeof mod.createStepExecutor).toBe("function");
    expect(typeof mod.createScoreCalculator).toBe("function");
    expect(typeof mod.createPromotionEngine).toBe("function");
    expect(typeof mod.createVersionManager).toBe("function");
    expect(typeof mod.createPromoterJobRunner).toBe("function");
  });
});
