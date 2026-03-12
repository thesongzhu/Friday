/**
 * A-001 Import Contract Test
 *
 * Validates that package import aliases (#rules, #node-runner, #acceptance,
 * #retry, #playbook) resolve correctly and export stable APIs.
 * Fails if any alias is removed or stops resolving.
 */
import { describe, it, expect } from "vitest";

// ─── Rules ───
import * as rules from "#rules";

// ─── NodeRunner ───
import * as nodeRunner from "#node-runner";

// ─── Acceptance ───
import * as acceptance from "#acceptance";

// ─── Retry ───
import * as retry from "#retry";

// ─── Playbook ───
import * as playbook from "#playbook";

describe("A-001 Import Alias Contract", () => {
  describe("#rules alias", () => {
    it("resolves and exports FridayRuleEngine", () => {
      expect(rules.FridayRuleEngine).toBeDefined();
      expect(typeof rules.FridayRuleEngine).toBe("function");
    });

    it("exports DSL parser", () => {
      expect(rules.parsePolicyBundleDocument).toBeDefined();
      expect(typeof rules.parsePolicyBundleDocument).toBe("function");
    });

    it("exports condition evaluator", () => {
      expect(rules.evaluateCondition).toBeDefined();
      expect(typeof rules.evaluateCondition).toBe("function");
    });

    it("exports policy bundle manager", () => {
      expect(rules.FridayPolicyBundleManager).toBeDefined();
      expect(typeof rules.FridayPolicyBundleManager).toBe("function");
    });

    it("exports API error codes", () => {
      expect(rules.FRIDAY_RULES_ERROR_CODES).toBeDefined();
      expect(typeof rules.FRIDAY_RULES_ERROR_CODES).toBe("object");
    });

    it("exports model constants", () => {
      expect(rules.FRIDAY_RULE_DECISION_PRIORITY).toBeDefined();
    });
  });

  describe("#node-runner alias", () => {
    it("resolves and exports NodeRunnerPipeline", () => {
      expect(nodeRunner.NodeRunnerPipeline).toBeDefined();
      expect(typeof nodeRunner.NodeRunnerPipeline).toBe("function");
    });

    it("exports createNodeRunnerPipeline factory", () => {
      expect(nodeRunner.createNodeRunnerPipeline).toBeDefined();
      expect(typeof nodeRunner.createNodeRunnerPipeline).toBe("function");
    });

    it("exports adapter registry", () => {
      expect(nodeRunner.NodeAdapterRegistry).toBeDefined();
    });

    it("exports state machine", () => {
      expect(nodeRunner.isValidTransition).toBeDefined();
      expect(nodeRunner.isTerminalState).toBeDefined();
      expect(nodeRunner.transition).toBeDefined();
    });

    it("exports API error codes", () => {
      expect(nodeRunner.FRIDAY_NODE_RUNNER_ERROR_CODES).toBeDefined();
    });

    it("exports model constants", () => {
      expect(nodeRunner.FRIDAY_NODE_RUNNER_STEP_ORDER).toBeDefined();
      expect(nodeRunner.FRIDAY_NODE_RUNNER_TRANSITIONS).toBeDefined();
    });
  });

  describe("#acceptance alias", () => {
    it("resolves and exports AcceptanceTestSuiteRunner", () => {
      expect(acceptance.AcceptanceTestSuiteRunner).toBeDefined();
      expect(typeof acceptance.AcceptanceTestSuiteRunner).toBe("function");
    });

    it("exports assertion engine", () => {
      expect(acceptance.evaluateAssertion).toBeDefined();
      expect(acceptance.validateSchema).toBeDefined();
    });

    it("exports fixture manager", () => {
      expect(acceptance.AcceptanceFixtureManager).toBeDefined();
    });

    it("exports snapshot manager", () => {
      expect(acceptance.AcceptanceSnapshotManager).toBeDefined();
    });

    it("exports result reporter", () => {
      expect(acceptance.buildRunResult).toBeDefined();
      expect(acceptance.buildSuiteReport).toBeDefined();
    });

    it("exports API error codes", () => {
      expect(acceptance.FRIDAY_ACCEPTANCE_ERROR_CODES).toBeDefined();
    });

    it("exports model state machine", () => {
      expect(acceptance.AcceptanceRunState).toBeDefined();
      expect(acceptance.canTransitionAcceptanceRunState).toBeDefined();
    });
  });

  describe("#retry alias", () => {
    it("resolves and exports RetryOrchestrator", () => {
      expect(retry.RetryOrchestrator).toBeDefined();
      expect(typeof retry.RetryOrchestrator).toBe("function");
    });

    it("exports createRetryOrchestrator factory", () => {
      expect(retry.createRetryOrchestrator).toBeDefined();
      expect(typeof retry.createRetryOrchestrator).toBe("function");
    });

    it("exports failure classifier", () => {
      expect(retry.createFailureClassifier).toBeDefined();
    });

    it("exports circuit breaker", () => {
      expect(retry.createCircuitBreakerManager).toBeDefined();
    });

    it("exports dead letter queue", () => {
      expect(retry.createDeadLetterQueue).toBeDefined();
    });

    it("exports retry budget", () => {
      expect(retry.createRetryBudget).toBeDefined();
    });

    it("exports API error codes", () => {
      expect(retry.FRIDAY_RETRY_ERROR_CODES).toBeDefined();
    });

    it("exports model constants", () => {
      expect(retry.FRIDAY_FAILURE_CATEGORY_PRIORITY).toBeDefined();
    });
  });

  describe("#playbook alias", () => {
    it("resolves and exports createPlaybookStore", () => {
      expect(playbook.createPlaybookStore).toBeDefined();
      expect(typeof playbook.createPlaybookStore).toBe("function");
    });

    it("exports learning engine", () => {
      expect(playbook.createLearningEngine).toBeDefined();
    });

    it("exports playbook matcher", () => {
      expect(playbook.createPlaybookMatcher).toBeDefined();
      expect(playbook.jaccardSimilarity).toBeDefined();
    });

    it("exports step executor", () => {
      expect(playbook.createStepExecutor).toBeDefined();
    });

    it("exports version manager", () => {
      expect(playbook.createVersionManager).toBeDefined();
    });

    it("exports promoter job runner", () => {
      expect(playbook.createPromoterJobRunner).toBeDefined();
    });

    it("exports API error codes", () => {
      expect(playbook.FRIDAY_PLAYBOOK_ERROR_CODES).toBeDefined();
    });

    it("exports model constants", () => {
      expect(playbook.FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS).toBeDefined();
      expect(playbook.FRIDAY_DEFAULT_PROMOTION_RULES).toBeDefined();
    });
  });
});
