/**
 * A-004 Workflow Acceptance Gate — enforces acceptance tests as mandatory
 * gates before workflow run completion.
 *
 * Integrates AcceptanceTestSuiteRunner into the workflow completion path.
 * Severity-driven policy: error-level failures block completion, warnings
 * are recorded but allowed through.
 *
 * @module workflows/engine
 */

import type {
  FridayAcceptanceRunResult,
  FridayAcceptanceSeverity,
  FridayAcceptanceTest,
  FridayAcceptanceTestRegistry,
  FridayAcceptanceVerdictOutcome,
} from "../../acceptance/model/friday-acceptance.types.js";
import type { UUID } from "../model/friday-workflow.types.js";

// ─── Gate Result ───

export type AcceptanceGateDecision = "pass" | "warn" | "fail";

export interface AcceptanceGateResult {
  decision: AcceptanceGateDecision;
  runId: UUID;
  workflowId: UUID;
  checksRun: number;
  checksPassed: number;
  checksWarned: number;
  checksFailed: number;
  blocksCompletion: boolean;
  verdicts: AcceptanceGateVerdict[];
  evaluatedAt: string;
}

export interface AcceptanceGateVerdict {
  checkId: string;
  checkName: string;
  verdict: FridayAcceptanceVerdictOutcome;
  severity: FridayAcceptanceSeverity;
  message?: string;
}

// ─── Gate Policy ───

export interface AcceptanceGatePolicy {
  /** When true, critical/major-severity failures block run completion. Default: true. */
  errorBlocksCompletion: boolean;
  /** When true, minor-severity results are recorded but do not block. Default: true. */
  warnAllowsCompletion: boolean;
  /** Artifact types that must have at least one acceptance test registered. */
  requiredArtifactTypes?: string[];
}

const DEFAULT_GATE_POLICY: AcceptanceGatePolicy = {
  errorBlocksCompletion: true,
  warnAllowsCompletion: true,
};

// ─── Dependencies ───

export interface AcceptanceGateDeps {
  /** Run acceptance checks for a given artifact/context. */
  runAcceptanceChecks: (params: {
    runId: UUID;
    artifactType: string;
    artifactData: unknown;
    context?: Record<string, unknown>;
  }) => Promise<AcceptanceCheckOutcome[]>;
  /** Clock function. */
  nowIso?: () => string;
}

export interface AcceptanceCheckOutcome {
  checkId: string;
  checkName: string;
  verdict: FridayAcceptanceVerdictOutcome;
  severity: FridayAcceptanceSeverity;
  message?: string;
}

// ─── Interface ───

export interface FridayWorkflowAcceptanceGate {
  evaluate(params: {
    runId: UUID;
    workflowId: UUID;
    artifactType: string;
    artifactData: unknown;
    policy?: Partial<AcceptanceGatePolicy>;
    context?: Record<string, unknown>;
  }): Promise<AcceptanceGateResult>;
}

// ─── Factory ───

export function createFridayWorkflowAcceptanceGate(
  deps: AcceptanceGateDeps,
): FridayWorkflowAcceptanceGate {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  return {
    async evaluate(params) {
      const policy: AcceptanceGatePolicy = { ...DEFAULT_GATE_POLICY, ...params.policy };

      // Run all acceptance checks
      const outcomes = await deps.runAcceptanceChecks({
        runId: params.runId,
        artifactType: params.artifactType,
        artifactData: params.artifactData,
        context: params.context,
      });

      // Classify results
      let passed = 0;
      let warned = 0;
      let failed = 0;
      const verdicts: AcceptanceGateVerdict[] = [];

      for (const outcome of outcomes) {
        verdicts.push({
          checkId: outcome.checkId,
          checkName: outcome.checkName,
          verdict: outcome.verdict,
          severity: outcome.severity,
          message: outcome.message,
        });

        if (outcome.verdict === "pass") {
          passed++;
        } else if (outcome.severity === "critical" || outcome.severity === "major") {
          failed++;
        } else {
          warned++;
        }
      }

      // Determine gate decision
      let decision: AcceptanceGateDecision;
      let blocksCompletion: boolean;

      if (failed > 0) {
        decision = "fail";
        blocksCompletion = policy.errorBlocksCompletion;
      } else if (warned > 0) {
        decision = "warn";
        blocksCompletion = !policy.warnAllowsCompletion;
      } else {
        decision = "pass";
        blocksCompletion = false;
      }

      return {
        decision,
        runId: params.runId,
        workflowId: params.workflowId,
        checksRun: outcomes.length,
        checksPassed: passed,
        checksWarned: warned,
        checksFailed: failed,
        blocksCompletion,
        verdicts,
        evaluatedAt: nowIso(),
      };
    },
  };
}
