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
import type {
  FridayTaskWorkflowClaimRecord,
  FridayTaskWorkflowCloseoutGateOutcome,
  FridayTaskWorkflowContextPackage,
  FridayTaskWorkflowEvidenceRefRecord,
  FridayTaskWorkflowGatePlanEntry,
} from "./friday-task-workflow.types.js";

export interface FridayTaskWorkflowCloseoutGateInput {
  readonly gatePlan: readonly FridayTaskWorkflowGatePlanEntry[];
  readonly claims: readonly FridayTaskWorkflowClaimRecord[];
  readonly evidenceRefsByClaim: ReadonlyMap<
    string,
    readonly FridayTaskWorkflowEvidenceRefRecord[]
  >;
  readonly contextPackage: FridayTaskWorkflowContextPackage;
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
};

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
