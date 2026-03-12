/**
 * Test Suite Runner — execute acceptance test suites against agent/skill outputs.
 *
 * Orchestrates the full acceptance testing workflow:
 * 1. Look up registered tests for each artifact type.
 * 2. Execute tests in priority order via the assertion engine.
 * 3. Handle short-circuit logic on failure.
 * 4. Aggregate verdicts and build structured results.
 * 5. Track coverage and report results.
 *
 * @module acceptance/engine
 */

import {
  AcceptanceRunState,
  assertAcceptanceRunStateTransition,
} from "../model/friday-acceptance.types.js";

import type {
  AcceptanceRunTransitionReason,
  FridayAcceptanceArtifactType,
  FridayAcceptanceCheck,
  FridayAcceptanceCheckType,
  FridayAcceptanceEvidence,
  FridayAcceptancePipelineContext,
  FridayAcceptancePipelineResult,
  FridayAcceptanceRollbackEvent,
  FridayAcceptanceRunResult,
  FridayAcceptanceRunStateTransition,
  FridayAcceptanceTest,
  FridayAcceptanceTestRegistry,
  FridayAcceptanceVerdict,
  FridayExecutedAcceptanceCheck,
  FridaySkippedAcceptanceCheck,
} from "../model/friday-acceptance.types.js";

import type { FridayNodeArtifact } from "../../node-runner/model/friday-node-runner.types.js";
import type {
  FridayEvaluationContext,
  FridayEvaluationResult,
  JsonObject,
  JsonValue,
  UUID,
} from "../../rules/model/friday-rules-engine.types.js";

import { evaluateAssertion } from "./assertion-engine.js";
import {
  type AcceptanceSuiteReport,
  aggregateSeverities,
  aggregateVerdicts,
  buildRunResult,
  buildSuiteReport,
} from "./result-reporter.js";
import { AcceptanceCoverageTracker } from "./coverage-tracker.js";

// ─── UUID Generation ───

function generateUuid(): UUID {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── In-Memory Test Registry ───

/**
 * In-memory implementation of {@link FridayAcceptanceTestRegistry}.
 *
 * Maps artifact types to ordered lists of acceptance tests.
 * Backed by a type-safe Map for O(1) lookups.
 */
export class InMemoryTestRegistry implements FridayAcceptanceTestRegistry {
  private readonly byArtifactType = new Map<FridayAcceptanceArtifactType, FridayAcceptanceTest[]>();
  private readonly byId = new Map<UUID, FridayAcceptanceTest>();

  register(test: FridayAcceptanceTest): void {
    if (this.byId.has(test.id)) {
      throw new Error(`Acceptance test with ID "${test.id}" is already registered`);
    }

    this.byId.set(test.id, test);

    let tests = this.byArtifactType.get(test.artifactType);
    if (!tests) {
      tests = [];
      this.byArtifactType.set(test.artifactType, tests);
    }

    tests.push(test);
    tests.sort((a, b) => a.priority - b.priority);
  }

  unregister(testId: UUID): boolean {
    const test = this.byId.get(testId);
    if (!test) return false;

    this.byId.delete(testId);

    const tests = this.byArtifactType.get(test.artifactType);
    if (tests) {
      const index = tests.findIndex((t) => t.id === testId);
      if (index !== -1) tests.splice(index, 1);
      if (tests.length === 0) this.byArtifactType.delete(test.artifactType);
    }

    return true;
  }

  getTests(artifactType: FridayAcceptanceArtifactType): FridayAcceptanceTest[] {
    const tests = this.byArtifactType.get(artifactType);
    if (!tests) return [];
    return tests.filter((t) => t.enabled);
  }

  getById(testId: UUID): FridayAcceptanceTest | undefined {
    return this.byId.get(testId);
  }

  listArtifactTypes(): FridayAcceptanceArtifactType[] {
    return Array.from(this.byArtifactType.keys());
  }
}

// ─── Artifact Content Resolver ───

/**
 * Callback to resolve artifact content from a URI.
 * Returns the parsed content as a JsonValue, or throws on failure.
 */
export type ArtifactContentResolver = (artifact: FridayNodeArtifact) => JsonValue;

/**
 * Rules evaluator callback (NodeRunner DI style, fail-closed).
 */
export type EvaluateRulesFn = (
  context: FridayEvaluationContext,
  signal?: AbortSignal,
) => Promise<FridayEvaluationResult>;

type RequiredGateClass = "schema" | "quantitative" | "quality";

const REQUIRED_GATE_CLASSES: readonly RequiredGateClass[] = ["schema", "quantitative", "quality"] as const;

function isRequiredGateClass(checkType: FridayAcceptanceCheckType): checkType is RequiredGateClass {
  return checkType === "schema" || checkType === "quantitative" || checkType === "quality";
}

/**
 * Default content resolver that uses artifact metadata's `content` field.
 * Falls back to null if no content is available.
 */
export const defaultContentResolver: ArtifactContentResolver = (artifact) => {
  if (artifact.metadata && "content" in artifact.metadata) {
    return artifact.metadata["content"] as JsonValue;
  }
  return null;
};

// ─── Test Suite Runner ───

/**
 * Options for the test suite runner.
 */
export interface TestSuiteRunnerOptions {
  /** Test registry to use. If not provided, creates a new in-memory registry. */
  registry?: FridayAcceptanceTestRegistry;
  /** Coverage tracker to use. If not provided, creates a new one. */
  coverageTracker?: AcceptanceCoverageTracker;
  /** Content resolver for artifacts. Defaults to metadata-based resolution. */
  contentResolver?: ArtifactContentResolver;
  /** Rules engine evaluator (optional; required only for rule-linked checks). */
  evaluateRules?: EvaluateRulesFn;
  /** Optional callback when rollback is emitted for a failed run. */
  onRollback?: (event: FridayAcceptanceRollbackEvent) => void;
}

interface RuleLinkedCheckInput {
  executionId: UUID;
  artifact: FridayNodeArtifact;
  content: JsonValue;
  test: FridayAcceptanceTest;
  pipelineContext?: FridayAcceptancePipelineContext;
}

interface RollbackEmissionInput {
  runId: UUID;
  executionId: UUID;
  artifact: FridayNodeArtifact;
  checks: FridayAcceptanceCheck[];
  reason: string;
}

interface SystemFailureCheckInput {
  runId: UUID;
  testId: UUID;
  message: string;
  expected?: JsonValue;
  actual?: JsonValue;
  metadata?: JsonObject;
}

interface FinalizeRunInput {
  runId: UUID;
  executionId: UUID;
  artifact: FridayNodeArtifact;
  checks: FridayAcceptanceCheck[];
  startTime: number;
  state: AcceptanceRunState;
  stateTransitions: FridayAcceptanceRunStateTransition[];
  rollbackEvent?: FridayAcceptanceRollbackEvent;
}

/**
 * Acceptance Test Suite Runner.
 *
 * Central orchestrator for running acceptance tests against artifacts.
 * Integrates the assertion engine, coverage tracker, and result reporter.
 */
export class AcceptanceTestSuiteRunner {
  readonly registry: FridayAcceptanceTestRegistry;
  readonly coverageTracker: AcceptanceCoverageTracker;
  private readonly contentResolver: ArtifactContentResolver;
  private readonly evaluateRules?: EvaluateRulesFn;
  private readonly onRollback?: (event: FridayAcceptanceRollbackEvent) => void;

  constructor(options?: TestSuiteRunnerOptions) {
    this.registry = options?.registry ?? new InMemoryTestRegistry();
    this.coverageTracker = options?.coverageTracker ?? new AcceptanceCoverageTracker();
    this.contentResolver = options?.contentResolver ?? defaultContentResolver;
    this.evaluateRules = options?.evaluateRules;
    this.onRollback = options?.onRollback;
  }

  /**
   * Run all registered acceptance tests against a single artifact.
   *
   * @param executionId - Parent execution ID.
   * @param artifact - The artifact to test.
   * @param pipelineContext - Optional pipeline context for rule-linked checks.
   * @returns Run result with all check outcomes.
   */
  async runForArtifact(
    executionId: UUID,
    artifact: FridayNodeArtifact,
    pipelineContext?: FridayAcceptancePipelineContext,
  ): Promise<FridayAcceptanceRunResult> {
    const runId = generateUuid();
    const startTime = performance.now();

    const tests = this.registry.getTests(artifact.artifactType as FridayAcceptanceArtifactType);
    const checks: FridayAcceptanceCheck[] = [];
    const stateTransitions: FridayAcceptanceRunStateTransition[] = [];
    let state = AcceptanceRunState.Pending;

    const transitionState = (
      to: AcceptanceRunState,
      reason?: AcceptanceRunTransitionReason,
    ): void => {
      assertAcceptanceRunStateTransition(state, to);
      stateTransitions.push({
        from: state,
        to,
        at: new Date().toISOString(),
        reason,
      });
      state = to;
    };

    transitionState(AcceptanceRunState.Running, "started");

    // P0: mandatory gate fail-closed if required gate classes are missing.
    const observedGateClasses = new Set<RequiredGateClass>();
    for (const test of tests) {
      if (isRequiredGateClass(test.checkConfig.checkType)) {
        observedGateClasses.add(test.checkConfig.checkType);
      }
    }
    const missingGateClasses = REQUIRED_GATE_CLASSES.filter((gateClass) => !observedGateClasses.has(gateClass));

    if (missingGateClasses.length > 0) {
      const registeredGateClasses = REQUIRED_GATE_CLASSES
        .filter((gateClass) => observedGateClasses.has(gateClass));

      checks.push(this.createSystemFailureCheck({
        runId,
        testId: `system:missing-gate:${artifact.artifactType}`,
        message: `Missing mandatory acceptance gate class(es) for artifact type "${artifact.artifactType}": ${missingGateClasses.join(", ")}`,
        expected: [...REQUIRED_GATE_CLASSES],
        actual: missingGateClasses,
        metadata: {
          artifactType: artifact.artifactType,
          requiredGateClasses: [...REQUIRED_GATE_CLASSES],
          registeredGateClasses,
          missingGateClasses,
        },
      }));

      transitionState(AcceptanceRunState.Failed, "mandatory_gate_missing");
      const rollbackEvent = this.emitRollbackEvent({
        runId,
        executionId,
        artifact,
        checks,
        reason: `Mandatory acceptance gate class(es) missing for artifact type "${artifact.artifactType}": ${missingGateClasses.join(", ")}`,
      });
      transitionState(AcceptanceRunState.RolledBack, "rollback_emitted");

      return this.finalizeRun({
        runId,
        executionId,
        artifact,
        checks,
        startTime,
        state,
        stateTransitions,
        rollbackEvent,
      });
    }

    // Resolve artifact content.
    let content: JsonValue;
    try {
      content = this.contentResolver(artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // P2: include explicit system-fail plus per-check skipped accounting.
      checks.push(this.createSystemFailureCheck({
        runId,
        testId: `system:content-resolution:${artifact.artifactType}`,
        message: `Failed to resolve artifact content: ${message}`,
      }));

      for (const test of tests) {
        checks.push(this.createSkippedCheck(runId, test, "Skipped because artifact content could not be resolved"));
      }

      transitionState(AcceptanceRunState.Failed, "content_resolution_failed");
      const rollbackEvent = this.emitRollbackEvent({
        runId,
        executionId,
        artifact,
        checks,
        reason: `Artifact content resolution failed: ${message}`,
      });
      transitionState(AcceptanceRunState.RolledBack, "rollback_emitted");

      return this.finalizeRun({
        runId,
        executionId,
        artifact,
        checks,
        startTime,
        state,
        stateTransitions,
        rollbackEvent,
      });
    }

    // Execute tests in priority order.
    let shortCircuited = false;

    for (const test of tests) {
      if (shortCircuited) {
        checks.push(this.createSkippedCheck(runId, test, "Short-circuited by prior failure"));
        continue;
      }

      const checkStartTime = performance.now();
      let verdict: FridayAcceptanceVerdict;

      try {
        verdict = test.rulePolicyBundleId
          ? await this.evaluateRuleLinkedCheck({
            executionId,
            artifact,
            content,
            test,
            pipelineContext,
          })
          : evaluateAssertion(test.id, content, test.checkConfig);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        verdict = {
          verdict: "fail",
          severity: "critical",
          evidence: [{
            checkId: test.id,
            checkType: test.checkConfig.checkType,
            message: `Check threw an uncaught exception: ${message}`,
            metadata: { error: message },
          }],
        };
      }

      const checkDurationMs = Math.round(performance.now() - checkStartTime);
      const ruleEvaluationIds = this.extractRuleEvaluationIds(verdict.evidence);

      const executedCheck: FridayExecutedAcceptanceCheck = {
        id: generateUuid(),
        runId,
        testId: test.id,
        checkType: test.checkConfig.checkType,
        status: "executed",
        verdict: verdict.verdict,
        severity: verdict.severity,
        evidence: verdict.evidence,
        ruleEvaluationId: ruleEvaluationIds[0],
        ruleEvaluationIds: ruleEvaluationIds.length > 0 ? ruleEvaluationIds : undefined,
        durationMs: checkDurationMs,
        createdAt: new Date().toISOString(),
      };

      checks.push(executedCheck);

      // Short-circuit on failure if configured.
      if (verdict.verdict === "fail" && test.shortCircuit) {
        shortCircuited = true;
      }
    }

    const executedVerdicts = checks
      .filter((check): check is FridayExecutedAcceptanceCheck => check.status === "executed")
      .map((check) => check.verdict);
    const overallVerdict = aggregateVerdicts(executedVerdicts);

    let rollbackEvent: FridayAcceptanceRollbackEvent | undefined;
    if (overallVerdict === "fail") {
      transitionState(AcceptanceRunState.Failed, "checks_failed");
      rollbackEvent = this.emitRollbackEvent({
        runId,
        executionId,
        artifact,
        checks,
        reason: "One or more acceptance checks failed",
      });
      transitionState(AcceptanceRunState.RolledBack, "rollback_emitted");
    } else {
      transitionState(AcceptanceRunState.Passed, "checks_passed");
    }

    return this.finalizeRun({
      runId,
      executionId,
      artifact,
      checks,
      startTime,
      state,
      stateTransitions,
      rollbackEvent,
    });
  }

  /**
   * Run acceptance tests against multiple artifacts.
   *
   * @param executionId - Parent execution ID.
   * @param artifacts - Artifacts to test.
   * @param pipelineContext - Optional parent pipeline context.
   * @returns Array of run results, one per artifact.
   */
  async runForArtifacts(
    executionId: UUID,
    artifacts: FridayNodeArtifact[],
    pipelineContext?: FridayAcceptancePipelineContext,
  ): Promise<FridayAcceptanceRunResult[]> {
    const runs: FridayAcceptanceRunResult[] = [];
    for (const artifact of artifacts) {
      runs.push(await this.runForArtifact(executionId, artifact, pipelineContext));
    }
    return runs;
  }

  /**
   * Run the full acceptance pipeline as a post-validate sub-step.
   *
   * @param context - Pipeline context from the NodeRunner.
   * @returns Pipeline result indicating overall pass/fail.
   */
  async runPipeline(context: FridayAcceptancePipelineContext): Promise<FridayAcceptancePipelineResult> {
    const startTime = performance.now();
    const runs = await this.runForArtifacts(context.executionId, context.artifacts, context);
    const durationMs = Math.round(performance.now() - startTime);

    const report = buildSuiteReport(runs, durationMs);

    return {
      passed: report.passed,
      runs,
      durationMs,
    };
  }

  /**
   * Generate a suite report from a set of run results.
   *
   * @param runs - Run results to include in the report.
   * @param durationMs - Total suite duration.
   */
  buildReport(runs: FridayAcceptanceRunResult[], durationMs: number): AcceptanceSuiteReport {
    return buildSuiteReport(runs, durationMs);
  }

  private async evaluateRuleLinkedCheck(input: RuleLinkedCheckInput): Promise<FridayAcceptanceVerdict> {
    const assertionVerdict = evaluateAssertion(input.test.id, input.content, input.test.checkConfig);
    const evalContext = this.buildRuleEvaluationContext(input);
    const ruleEvaluation = await this.evaluateRulesSafe(evalContext, input.pipelineContext?.signal);
    const ruleVerdict = this.mapRuleDecision(ruleEvaluation);

    const ruleEvidence: FridayAcceptanceEvidence = {
      checkId: input.test.id,
      checkType: input.test.checkConfig.checkType,
      message: `Rule-linked evaluation decision: ${ruleEvaluation.decision}`,
      expected: input.test.rulePolicyBundleId ?? null,
      actual: ruleEvaluation.decision,
      ruleEvaluationResult: ruleEvaluation,
      metadata: {
        policyBundleId: input.test.rulePolicyBundleId ?? null,
        matchedRuleIds: ruleEvaluation.matchedRules.map((rule) => rule.ruleId),
        matchedPolicyBundleIds: ruleEvaluation.matchedRules.map((rule) => rule.policyBundleId),
      },
    };

    return {
      verdict: aggregateVerdicts([assertionVerdict.verdict, ruleVerdict.verdict]),
      severity: aggregateSeverities([assertionVerdict.severity, ruleVerdict.severity]),
      evidence: [...assertionVerdict.evidence, ruleEvidence],
    };
  }

  private buildRuleEvaluationContext(input: RuleLinkedCheckInput): FridayEvaluationContext {
    const args: JsonObject = {
      executionId: input.executionId,
      artifactUri: input.artifact.uri,
      artifactType: input.artifact.artifactType,
      testId: input.test.id,
      checkType: input.test.checkConfig.checkType,
      content: input.content,
    };

    const evalContext: FridayEvaluationContext = {
      resource: "artifact",
      action: "accept",
      args,
      source: input.pipelineContext ? "workflow" : "system",
      policyBundleIds: input.test.rulePolicyBundleId ? [input.test.rulePolicyBundleId] : undefined,
    };

    if (input.pipelineContext) {
      evalContext.runId = input.pipelineContext.runId;
      evalContext.workflowId = input.pipelineContext.workflowId;
      evalContext.workflowRunId = input.pipelineContext.runId;
      evalContext.nodeId = input.pipelineContext.nodeId;
    }

    return evalContext;
  }

  private mapRuleDecision(
    result: FridayEvaluationResult,
  ): Pick<FridayAcceptanceVerdict, "verdict" | "severity"> {
    switch (result.decision) {
      case "deny":
        return { verdict: "fail", severity: "critical" };
      case "warn":
        return { verdict: "warn", severity: "major" };
      case "audit":
        return { verdict: "pass", severity: "info" };
      case "allow":
        return { verdict: "pass", severity: "info" };
    }
  }

  private async evaluateRulesSafe(
    evalContext: FridayEvaluationContext,
    signal?: AbortSignal,
  ): Promise<FridayEvaluationResult> {
    if (!this.evaluateRules) {
      throw new RuleEvaluationError("No evaluateRules function configured for rule-linked acceptance checks");
    }

    try {
      return await this.evaluateRules(evalContext, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RuleEvaluationError(message);
    }
  }

  private extractRuleEvaluationIds(evidence: FridayAcceptanceEvidence[]): UUID[] {
    const ids = evidence
      .map((entry) => entry.ruleEvaluationResult?.evaluationId)
      .filter((id): id is UUID => Boolean(id));
    return Array.from(new Set(ids));
  }

  private createSystemFailureCheck(input: SystemFailureCheckInput): FridayExecutedAcceptanceCheck {
    const evidence: FridayAcceptanceEvidence = {
      checkId: input.testId,
      checkType: "custom",
      message: input.message,
    };
    if (input.expected !== undefined) {
      evidence.expected = input.expected;
    }
    if (input.actual !== undefined) {
      evidence.actual = input.actual;
    }
    if (input.metadata !== undefined) {
      evidence.metadata = input.metadata;
    }

    return {
      id: generateUuid(),
      runId: input.runId,
      testId: input.testId,
      checkType: "custom",
      status: "executed",
      verdict: "fail",
      severity: "critical",
      evidence: [evidence],
      durationMs: 0,
      createdAt: new Date().toISOString(),
    };
  }

  private createSkippedCheck(
    runId: UUID,
    test: FridayAcceptanceTest,
    skipReason: string,
  ): FridaySkippedAcceptanceCheck {
    return {
      id: generateUuid(),
      runId,
      testId: test.id,
      checkType: test.checkConfig.checkType,
      status: "skipped",
      skipReason,
      createdAt: new Date().toISOString(),
    };
  }

  private emitRollbackEvent(input: RollbackEmissionInput): FridayAcceptanceRollbackEvent {
    const failedCheckIds = input.checks
      .filter((check): check is FridayExecutedAcceptanceCheck => check.status === "executed")
      .filter((check) => check.verdict === "fail")
      .map((check) => check.id as UUID);

    const event: FridayAcceptanceRollbackEvent = {
      eventId: generateUuid(),
      runId: input.runId,
      executionId: input.executionId,
      artifactUri: input.artifact.uri,
      artifactType: input.artifact.artifactType as FridayAcceptanceArtifactType,
      reason: input.reason,
      failedCheckIds,
      emittedAt: new Date().toISOString(),
    };

    if (this.onRollback) {
      try {
        this.onRollback(event);
      } catch {
        // Rollback emission should not break deterministic run completion.
      }
    }

    return event;
  }

  private finalizeRun(input: FinalizeRunInput): FridayAcceptanceRunResult {
    const totalDurationMs = Math.round(performance.now() - input.startTime);
    const result = buildRunResult(
      input.runId,
      input.executionId,
      input.artifact.uri,
      input.artifact.artifactType as FridayAcceptanceArtifactType,
      input.checks,
      totalDurationMs,
      {
        state: input.state,
        stateTransitions: input.stateTransitions,
        rollbackEvent: input.rollbackEvent,
      },
    );

    this.coverageTracker.recordRun(result);
    return result;
  }
}

class RuleEvaluationError extends Error {
  constructor(message: string) {
    super(`Rules evaluation failed: ${message}`);
    this.name = "RuleEvaluationError";
  }
}
