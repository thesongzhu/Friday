/**
 * Acceptance Gate — mandatory backend gate for node execution output.
 *
 * Integrates the AcceptanceTestSuiteRunner with the workflow execution
 * pipeline as a mandatory post-execution validation step. When enabled,
 * node outputs must pass all registered acceptance tests before being
 * accepted.
 *
 * Fail-closed: if the acceptance runner cannot be reached or errors out,
 * the gate rejects the output.
 *
 * @module acceptance/engine
 */

import type {
  FridayAcceptancePipelineContext,
  FridayAcceptancePipelineResult,
  FridayAcceptanceTestRegistry,
} from "../model/friday-acceptance.types.js";

import { AcceptanceTestSuiteRunner } from "./test-suite-runner.js";
import type { TestSuiteRunnerOptions } from "./test-suite-runner.js";

// ─── Gate Configuration ───

export interface AcceptanceGateConfig {
  /** Whether the gate is enabled. When false, all outputs pass. */
  enabled: boolean;
  /** Test suite runner options. */
  runnerOptions?: TestSuiteRunnerOptions;
  /** Optional pre-configured runner instance (overrides runnerOptions). */
  runner?: AcceptanceTestSuiteRunner;
}

// ─── Gate Result ───

export interface AcceptanceGateResult {
  /** Whether the output passed all acceptance tests. */
  passed: boolean;
  /** Full pipeline result (null if gate is disabled). */
  pipelineResult: FridayAcceptancePipelineResult | null;
  /** Error message if the gate rejected the output. */
  errorMessage?: string;
}

// ─── Gate Interface ───

export interface AcceptanceGate {
  /**
   * Evaluate the acceptance gate for a node execution output.
   *
   * @param context - The pipeline context with execution ID, artifacts, etc.
   * @returns Gate result indicating pass/fail.
   */
  evaluate(context: FridayAcceptancePipelineContext): Promise<AcceptanceGateResult>;

  /** Access the underlying test registry for test registration. */
  readonly registry: FridayAcceptanceTestRegistry;

  /** Access the underlying runner for direct use. */
  readonly runner: AcceptanceTestSuiteRunner;
}

// ─── Factory ───

/**
 * Create an acceptance gate that enforces acceptance tests as mandatory
 * backend validation.
 *
 * When enabled, the gate runs all registered acceptance tests against the
 * node execution output. If any test fails, the gate rejects the output.
 *
 * When disabled, the gate always passes (bypass mode).
 */
export function createAcceptanceGate(config: AcceptanceGateConfig): AcceptanceGate {
  const runner = config.runner ?? new AcceptanceTestSuiteRunner(config.runnerOptions);

  return {
    registry: runner.registry,
    runner,

    async evaluate(context: FridayAcceptancePipelineContext): Promise<AcceptanceGateResult> {
      if (!config.enabled) {
        return { passed: true, pipelineResult: null };
      }

      try {
        const pipelineResult = await runner.runPipeline(context);

        if (!pipelineResult.passed) {
          const failedRuns = pipelineResult.runs.filter((r) => r.overallVerdict === "fail");
          const failureMessages = failedRuns
            .map((r) => `${r.artifactType}: ${r.checks.filter((c) => c.status === "executed" && c.verdict === "fail").length} check(s) failed`)
            .join("; ");

          return {
            passed: false,
            pipelineResult,
            errorMessage: `Acceptance gate failed: ${failureMessages || "one or more checks did not pass"}`,
          };
        }

        return { passed: true, pipelineResult };
      } catch (error) {
        // Fail-closed: any error in acceptance testing rejects the output
        const message = error instanceof Error ? error.message : String(error);
        return {
          passed: false,
          pipelineResult: null,
          errorMessage: `Acceptance gate error (fail-closed): ${message}`,
        };
      }
    },
  };
}
