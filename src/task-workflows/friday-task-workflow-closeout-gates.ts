/**
 * Phase 13.5A closeout gate outcome evaluator (B.2.2).
 *
 * Deterministic per-gate evaluator used by `closeout()` to produce the
 * gate outcomes embedded in the closeout receipt. Required gates always
 * evaluate to `pass` or `block`; they MUST NEVER be silently skipped or
 * reported as `not_applicable`, even when underlying data is missing. The
 * `light` supervisor mode evaluates required gates exactly the same way
 * `standard` and `strict` modes do.
 *
 * The evaluator only reads claims and evidence refs that the workflow
 * already produced. It does not invoke any external services, does not
 * mutate state, and does not consume context-replay output as proof.
 *
 * @module task-workflows/friday-task-workflow-closeout-gates
 */

import { isFridayTaskWorkflowRefSourceCompatible } from "./friday-task-workflow-compatibility.js";
import {
  FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE,
} from "./friday-task-workflow.types.js";
import type {
  FridayTaskWorkflowClaimRecord,
  FridayTaskWorkflowCloseoutGateOutcome,
  FridayTaskWorkflowContextPackage,
  FridayTaskWorkflowEvidenceRefRecord,
  FridayTaskWorkflowGatePlanEntry,
  FridayTaskWorkflowLaneRecord,
  FridayTaskWorkflowOperationRollbackClass,
  FridayTaskWorkflowRisk,
  FridayTaskWorkflowWorkflowRunEvidenceStatus,
} from "./friday-task-workflow.types.js";

export interface FridayTaskWorkflowCloseoutGateInput {
  readonly gatePlan: readonly FridayTaskWorkflowGatePlanEntry[];
  readonly claims: readonly FridayTaskWorkflowClaimRecord[];
  readonly evidenceRefsByClaim: ReadonlyMap<
    string,
    readonly FridayTaskWorkflowEvidenceRefRecord[]
  >;
  readonly contextPackage: FridayTaskWorkflowContextPackage;
  /** Phase 13.5B: lanes opened on the workflow. */
  readonly lanes: readonly FridayTaskWorkflowLaneRecord[];
  /** Phase 13.5B: workflow risk classification (drives independent_verifier_required). */
  readonly risk: FridayTaskWorkflowRisk;
  /** Phase 13.5B: current workflow spec_hash for lane-binding drift detection. */
  readonly workflowSpecHash: string;
  /**
   * Phase 14.5C: per-run evidence persistence status keyed by the workflow
   * run id of every `workflow_run_evidence`-sourced evidence ref attached to
   * verified claims in this workflow. Missing entries (lookup data absent)
   * trigger the required-gate-never-silent fallback so closeout cannot pass
   * silently on degraded or unknown runs.
   */
  readonly workflowRunEvidenceStatusByRunId: ReadonlyMap<
    string,
    FridayTaskWorkflowWorkflowRunEvidenceStatus
  >;
  /**
   * Phase 14.5D module_28d: deterministic rollback disclosure derived
   * from verified/blocked claim evidence refs in the service layer
   * before evaluating the closeout gate plan. Absent (undefined) when
   * the service has no receipt-under-construction context (legacy
   * callers); the new required gate `rollback_class_disclosure_required`
   * then falls back to the required-gate-never-silent block path so
   * closeout cannot pass silently without rollback disclosure.
   */
  readonly rollbackDisclosure?: FridayTaskWorkflowCloseoutRollbackDisclosure;
}

/**
 * Phase 14.5D module_28d: deterministic rollback disclosure projection
 * passed into the closeout gate evaluator. The service produces this
 * by walking every evidence ref attached to a verified or blocked
 * claim, mapping each ref's source through
 * `FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE`, and resolving
 * the worst-case class. Honest disclosure: no overclaim by omission
 * and no overclaim by understatement.
 */
export interface FridayTaskWorkflowCloseoutRollbackDisclosure {
  readonly rollbackClass: FridayTaskWorkflowOperationRollbackClass;
  readonly compensatingAction: string | null;
  readonly nonReversibleReason: string | null;
  /** Ref sources observed across verified/blocked claims. Used by the
   *  no-overclaim invariant to detect under-disclosure. */
  readonly observedRefSourceClasses: ReadonlyMap<
    string,
    FridayTaskWorkflowOperationRollbackClass
  >;
}

type GateEvaluator = (
  input: FridayTaskWorkflowCloseoutGateInput,
) => { status: "pass" | "block"; reason: string | null };

const REQUIRED_GATE_EVALUATORS: Readonly<Record<string, GateEvaluator>> = {
  claim_evidence_required: (input) => {
    const verifiedClaims = input.claims.filter((c) => c.status === "verified");
    const missing = verifiedClaims.filter((c) => {
      const refs = input.evidenceRefsByClaim.get(c.id) ?? [];
      return refs.length === 0 || c.evidenceRefCount <= 0;
    });
    if (missing.length > 0) {
      return {
        status: "block",
        reason: `verified claim(s) missing evidence ref: ${missing.map((c) => c.id).join(", ")}`,
      };
    }
    return { status: "pass", reason: null };
  },

  verifier_fresh_read: (input) => {
    const verified = input.claims.filter((c) => c.status === "verified");
    const missingVerdict = verified.filter(
      (c) => !c.verifierVerdict || c.verifierVerdict.trim().length === 0,
    );
    if (missingVerdict.length > 0) {
      return {
        status: "block",
        reason: `verified claim(s) missing verifier verdict: ${missingVerdict
          .map((c) => c.id)
          .join(", ")}`,
      };
    }
    return { status: "pass", reason: null };
  },

  docs_intent_not_proof: (input) => {
    const offending: string[] = [];
    for (const claim of input.claims) {
      if (claim.status !== "verified") continue;
      const refs = input.evidenceRefsByClaim.get(claim.id) ?? [];
      for (const ref of refs) {
        if (
          ref.refSource === "docs_intent_reference" &&
          !isFridayTaskWorkflowRefSourceCompatible(claim.claimKind, ref.refSource)
        ) {
          offending.push(`${claim.id}:${ref.id}`);
        }
      }
    }
    if (offending.length > 0) {
      return {
        status: "block",
        reason: `docs/spec/intent ref backing a verified non-intent claim: ${offending.join(", ")}`,
      };
    }
    return { status: "pass", reason: null };
  },

  summary_replay_unconfirmed: (input) => {
    const offending = input.claims.filter(
      (c) => c.status === "verified" && c.claimKind === "summary_replay",
    );
    if (offending.length > 0) {
      return {
        status: "block",
        reason: `summary_replay claim(s) reached verified status: ${offending.map((c) => c.id).join(", ")}`,
      };
    }
    return { status: "pass", reason: null };
  },

  cli_self_report_unconfirmed: (input) => {
    const offending = input.claims.filter(
      (c) => c.status === "verified" && c.claimKind === "cli_self_report",
    );
    if (offending.length > 0) {
      return {
        status: "block",
        reason: `cli_self_report claim(s) reached verified status: ${offending.map((c) => c.id).join(", ")}`,
      };
    }
    return { status: "pass", reason: null };
  },

  provider_fallback_not_audit: (input) => {
    const offending = input.claims.filter(
      (c) => c.status === "verified" && c.claimKind === "provider_fallback",
    );
    if (offending.length > 0) {
      return {
        status: "block",
        reason: `provider_fallback claim(s) reached verified status: ${offending.map((c) => c.id).join(", ")}`,
      };
    }
    return { status: "pass", reason: null };
  },

  context_package_scope_limit: (input) => {
    const allowed = input.contextPackage.allowedFiles;
    if (!Array.isArray(allowed) || allowed.length === 0) {
      return {
        status: "block",
        reason: "context package allowedFiles is empty",
      };
    }
    return { status: "pass", reason: null };
  },

  executor_lane_context_bound: (input) => {
    const executorLanes = input.lanes.filter(
      (lane) => lane.laneKind === "executor",
    );
    const offending: string[] = [];
    for (const lane of executorLanes) {
      if (!lane.contextSnapshotHash || lane.contextSnapshotHash.length === 0) {
        offending.push(`${lane.id} (missing context_snapshot_hash)`);
        continue;
      }
      if (lane.contextSnapshotSpecHash !== input.workflowSpecHash) {
        offending.push(
          `${lane.id} (context_snapshot_spec_hash drift: lane=${lane.contextSnapshotSpecHash.slice(0, 12)}… workflow=${input.workflowSpecHash.slice(0, 12)}…)`,
        );
      }
    }
    if (offending.length > 0) {
      return {
        status: "block",
        reason: `executor lane(s) lack a current context binding: ${offending.join(", ")}`,
      };
    }
    return { status: "pass", reason: null };
  },

  workflow_run_evidence_durable: (input) => {
    const offending: string[] = [];
    const missingLookups: string[] = [];
    for (const claim of input.claims) {
      if (claim.status !== "verified") continue;
      const refs = input.evidenceRefsByClaim.get(claim.id) ?? [];
      for (const ref of refs) {
        if (ref.refSource !== "workflow_run_evidence") continue;
        const runId = ref.refId;
        const status = input.workflowRunEvidenceStatusByRunId.get(runId);
        if (status === undefined) {
          missingLookups.push(`${claim.id}:${ref.id}`);
          continue;
        }
        if (status !== "available") {
          offending.push(`${claim.id}:${ref.id} (run ${runId} ${status})`);
        }
      }
    }
    if (missingLookups.length > 0) {
      return {
        status: "block",
        reason:
          `workflow_run_evidence ref(s) lack a fresh-read run evidence status; required-gate-never-silent fallback applies: ${missingLookups.join(", ")}`,
      };
    }
    if (offending.length > 0) {
      return {
        status: "block",
        reason:
          `verified claim(s) reference workflow run(s) with non-available evidence persistence: ${offending.join(", ")}`,
      };
    }
    return { status: "pass", reason: null };
  },

  rollback_class_disclosure_required: (input) => {
    // Phase 14.5D module_28d: refuse pass when the receipt-under-construction
    // disclosure is missing (required-gate-never-silent), when a
    // non-`reversible_local` rollback class is missing its required
    // disclosure summary (overclaim by omission), or when the receipt
    // claims `reversible_local` while verified/blocked claims reference
    // any non-local source (overclaim by understatement).
    const disclosure = input.rollbackDisclosure;
    if (!disclosure) {
      return {
        status: "block",
        reason:
          "no rollback disclosure projected for the closeout receipt; required-gate-never-silent fallback applies per Phase 14.5D module_28d.",
      };
    }
    const observedClasses = new Set<FridayTaskWorkflowOperationRollbackClass>(
      disclosure.observedRefSourceClasses.values(),
    );
    if (disclosure.rollbackClass === "non_reversible_external") {
      const reason = disclosure.nonReversibleReason;
      if (typeof reason !== "string" || reason.trim().length === 0) {
        return {
          status: "block",
          reason:
            "rollbackClass is 'non_reversible_external' but nonReversibleReason is missing; closeout cannot pass without a disclosed reason per Phase 14.5D module_28d.",
        };
      }
    }
    if (disclosure.rollbackClass === "compensating_action_required") {
      const action = disclosure.compensatingAction;
      if (typeof action !== "string" || action.trim().length === 0) {
        return {
          status: "block",
          reason:
            "rollbackClass is 'compensating_action_required' but compensatingAction is missing; closeout cannot pass without the compensating action summary per Phase 14.5D module_28d.",
        };
      }
    }
    if (disclosure.rollbackClass === "reversible_local") {
      if (
        observedClasses.has("compensating_action_required") ||
        observedClasses.has("non_reversible_external")
      ) {
        const offending: string[] = [];
        for (const [refId, klass] of disclosure.observedRefSourceClasses) {
          if (
            klass === "compensating_action_required" ||
            klass === "non_reversible_external"
          ) {
            offending.push(`${refId}(${klass})`);
          }
        }
        return {
          status: "block",
          reason:
            `rollbackClass claims 'reversible_local' but verified/blocked claim evidence refs include non-local sources: ${offending.join(", ")}.`,
        };
      }
    }
    return { status: "pass", reason: null };
  },

  independent_verifier_required: (input) => {
    if (input.risk !== "high") {
      return { status: "pass", reason: null };
    }
    const verified = input.claims.filter((c) => c.status === "verified");
    if (verified.length === 0) {
      return { status: "pass", reason: null };
    }
    const lanesById = new Map(input.lanes.map((lane) => [lane.id, lane]));
    const offending: string[] = [];
    for (const claim of verified) {
      if (!claim.verifierLaneId) {
        offending.push(`${claim.id} (no verifierLaneId)`);
        continue;
      }
      const lane = lanesById.get(claim.verifierLaneId);
      if (!lane) {
        offending.push(`${claim.id} (verifierLaneId references unknown lane)`);
        continue;
      }
      if (lane.laneKind !== "verifier") {
        offending.push(`${claim.id} (verifierLaneId is not a verifier lane)`);
        continue;
      }
      if (lane.independence !== "independent") {
        offending.push(
          `${claim.id} (verifier lane independence=${lane.independence})`,
        );
      }
    }
    if (offending.length > 0) {
      return {
        status: "block",
        reason: `high-risk verified claim(s) lack an independent verifier lane: ${offending.join(", ")}`,
      };
    }
    return { status: "pass", reason: null };
  },
};

const REQUIRED_GATE_FALLBACK_REASON: Readonly<Record<string, string>> = {
  claim_evidence_required:
    "no required-gate evaluator data; treating as block per Phase 13.5A required-gate-never-silent rule.",
  verifier_fresh_read:
    "no required-gate evaluator data; treating as block per Phase 13.5A required-gate-never-silent rule.",
  docs_intent_not_proof:
    "no required-gate evaluator data; treating as block per Phase 13.5A required-gate-never-silent rule.",
  summary_replay_unconfirmed:
    "no required-gate evaluator data; treating as block per Phase 13.5A required-gate-never-silent rule.",
  cli_self_report_unconfirmed:
    "no required-gate evaluator data; treating as block per Phase 13.5A required-gate-never-silent rule.",
  provider_fallback_not_audit:
    "no required-gate evaluator data; treating as block per Phase 13.5A required-gate-never-silent rule.",
  context_package_scope_limit:
    "no required-gate evaluator data; treating as block per Phase 13.5A required-gate-never-silent rule.",
  executor_lane_context_bound:
    "no required-gate evaluator data; treating as block per Phase 13.5B executor-lane-context-bound rule.",
  workflow_run_evidence_durable:
    "no required-gate evaluator data; treating as block per Phase 14.5C workflow-run-evidence-fail-closed rule.",
  rollback_class_disclosure_required:
    "no required-gate evaluator data; treating as block per Phase 14.5D module_28d rollback-class-disclosure rule.",
};

/**
 * Phase 14.5D module_28d: deterministically project the worst-case
 * rollback class across every verified/blocked-claim evidence ref using
 * the read-only ref-source → rollback-class registry. The result is
 * what the closeout receipt persists and what the
 * `rollback_class_disclosure_required` gate evaluates. The function is
 * pure; same inputs → same outputs across N invocations.
 */
export function computeFridayTaskWorkflowCloseoutRollbackDisclosure(input: {
  readonly claims: readonly FridayTaskWorkflowClaimRecord[];
  readonly evidenceRefsByClaim: ReadonlyMap<
    string,
    readonly FridayTaskWorkflowEvidenceRefRecord[]
  >;
}): FridayTaskWorkflowCloseoutRollbackDisclosure {
  const consideredClaims = input.claims.filter(
    (claim) => claim.status === "verified" || claim.status === "blocked",
  );
  const observed = new Map<string, FridayTaskWorkflowOperationRollbackClass>();
  const sourceCountsByClass = new Map<
    FridayTaskWorkflowOperationRollbackClass,
    Map<string, number>
  >();
  for (const claim of consideredClaims) {
    const refs = input.evidenceRefsByClaim.get(claim.id) ?? [];
    for (const ref of refs) {
      const klass = FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE[ref.refSource];
      observed.set(ref.id, klass);
      const counts =
        sourceCountsByClass.get(klass) ??
        (() => {
          const fresh = new Map<string, number>();
          sourceCountsByClass.set(klass, fresh);
          return fresh;
        })();
      counts.set(ref.refSource, (counts.get(ref.refSource) ?? 0) + 1);
    }
  }
  const worst = worstCaseRollbackClass([...observed.values()]);
  let compensatingAction: string | null = null;
  let nonReversibleReason: string | null = null;
  if (worst === "compensating_action_required") {
    const sources = sortedSourcesByCount(
      sourceCountsByClass.get("compensating_action_required") ?? new Map(),
    );
    compensatingAction = `compensating action required for ref source(s): ${sources.join(", ")}.`;
  } else if (worst === "non_reversible_external") {
    const sources = sortedSourcesByCount(
      sourceCountsByClass.get("non_reversible_external") ?? new Map(),
    );
    nonReversibleReason = `non-reversible external side effect via ref source(s): ${sources.join(", ")}.`;
  }
  return {
    rollbackClass: worst,
    compensatingAction,
    nonReversibleReason,
    observedRefSourceClasses: observed,
  };
}

function worstCaseRollbackClass(
  classes: readonly FridayTaskWorkflowOperationRollbackClass[],
): FridayTaskWorkflowOperationRollbackClass {
  let worst: FridayTaskWorkflowOperationRollbackClass = "not_applicable";
  for (const klass of classes) {
    if (klass === "non_reversible_external") return "non_reversible_external";
    if (klass === "compensating_action_required") {
      worst = "compensating_action_required";
      continue;
    }
    if (klass === "reversible_local" && worst === "not_applicable") {
      worst = "reversible_local";
    }
  }
  return worst;
}

function sortedSourcesByCount(
  counts: ReadonlyMap<string, number>,
): readonly string[] {
  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .map(([source]) => source);
}

/**
 * Deterministically evaluate every gate in the workflow gate plan.
 *
 * Required gates always evaluate to `pass` or `block`. Optional gates
 * without a built-in evaluator are reported `not_applicable` so consumers
 * still see them in the receipt; required gates may NEVER be silently
 * skipped, so an unknown required gate evaluates to `block`.
 */
export function evaluateFridayTaskWorkflowCloseoutGates(
  input: FridayTaskWorkflowCloseoutGateInput,
): readonly FridayTaskWorkflowCloseoutGateOutcome[] {
  const outcomes: FridayTaskWorkflowCloseoutGateOutcome[] = [];
  for (const entry of input.gatePlan) {
    const evaluator = REQUIRED_GATE_EVALUATORS[entry.gateId];
    if (evaluator) {
      const result = evaluator(input);
      outcomes.push({
        gateId: entry.gateId,
        required: entry.required,
        status: result.status,
        reason: result.reason,
      });
      continue;
    }
    if (entry.required) {
      outcomes.push({
        gateId: entry.gateId,
        required: true,
        status: "block",
        reason:
          REQUIRED_GATE_FALLBACK_REASON[entry.gateId] ??
          "required gate has no built-in evaluator; treating as block per Phase 13.5A required-gate-never-silent rule.",
      });
      continue;
    }
    outcomes.push({
      gateId: entry.gateId,
      required: false,
      status: "not_applicable",
      reason: null,
    });
  }
  return outcomes;
}
