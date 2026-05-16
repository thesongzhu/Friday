/**
 * Focused canonical approval helper for the live HTTP skill upgrade lifecycle proof.
 *
 * Phase 14 release-proof catch-up for Phase 06: the prior local proof was
 * blocked by `canonical_approval_digest_mismatch`. This helper reproduces the
 * exact mutating-action request shape that each route/service hashes, then
 * signs the approval with the same token secret the runtime gate uses. It does
 * not relax the gate or change approval semantics — it only produces a
 * correctly-shaped approval for tests and RGG scenarios.
 */

import { createHash } from "node:crypto";
import {
  createFridayMutatingActionDigest,
  signFridayCanonicalApproval,
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
  type FridayMutatingActionRequest,
  type FridayMutatingActionRollbackScope,
} from "../../../../src/security/friday-mutating-action-gate.js";
import {
  createFridaySkillLifecycleCanaryInputDigest,
  createFridaySkillLifecycleMutatingActionRequest,
} from "../../../../src/autonomy/services/friday-skill-upgrade-lifecycle-service.js";

export type FridaySkillLifecycleAction = "shadow" | "canary" | "promote" | "rollback";

interface CommonInputs {
  skillId: string;
  candidateId: string;
  runtimeVersion: string;
  providerModel?: string;
  actor: FridayMutatingActionActor;
  planDigest?: string;
  idempotencyKey?: string;
}

const AUTONOMY_SURFACE_BY_ACTION: Record<FridaySkillLifecycleAction, string> = {
  shadow: "api:/v1/autonomy/skills/shadow",
  canary: "api:/v1/autonomy/skills/canary",
  promote: "api:/v1/autonomy/skills/promote",
  rollback: "api:/v1/autonomy/skills/rollback",
};

export function buildSkillLifecycleApprovalRequest(input: CommonInputs & {
  action: FridaySkillLifecycleAction;
  canaryInput?: Record<string, unknown>;
}): FridayMutatingActionRequest {
  const surface = AUTONOMY_SURFACE_BY_ACTION[input.action];
  const rollback: FridayMutatingActionRollbackScope | undefined = input.action === "rollback"
    ? {
      planned: true,
      planDigest: input.planDigest,
      actions: ["skills.lifecycle.promote"],
    }
    : undefined;
  const canaryInputDigest = input.action === "canary"
    ? createFridaySkillLifecycleCanaryInputDigest(input.canaryInput)
    : undefined;
  return createFridaySkillLifecycleMutatingActionRequest({
    action: input.action,
    skillId: input.skillId,
    candidateId: input.candidateId,
    shadowVersionId: input.candidateId,
    runtimeVersion: input.runtimeVersion,
    providerModel: input.providerModel,
    actor: input.actor,
    surface,
    planDigest: input.planDigest,
    rollback,
    idempotencyKey: input.idempotencyKey,
    canaryInputDigest,
  });
}

export interface SkillUpgradeDecideRequestInput {
  skillId: string;
  candidateId: string;
  decision: "replace" | "keep";
  analysisDigest: string;
  recommendation: "replace" | "keep" | "review_required";
  regressionVerdict: "pass" | "fail" | "no_affected_workflows";
  actor: FridayMutatingActionActor;
  idempotencyKey?: string;
}

/**
 * Exact mirror of the resource/parameters shape the
 * `/v1/skills/:skillId/upgrade/decide` route hashes via `assertCanonicalApproval`.
 * Keep in lock-step with `src/api/http/routes/friday-skill-routes.ts`.
 */
export function buildSkillUpgradeDecideApprovalRequest(
  input: SkillUpgradeDecideRequestInput,
): FridayMutatingActionRequest {
  const decisionDigest = hashStableJson({
    skillId: input.skillId,
    candidateId: input.candidateId,
    decision: input.decision,
    analysisDigest: input.analysisDigest,
    recommendation: input.recommendation,
    regressionVerdict: input.regressionVerdict,
  });
  return {
    action: "skills.upgrade.decide",
    actor: input.actor,
    surface: "api:/v1/skills/:skillId/upgrade/decide",
    resource: {
      type: "skill_upgrade",
      id: input.skillId,
      digest: decisionDigest,
      attributes: {
        skillId: input.skillId,
        candidateId: input.candidateId,
        analysisDigest: input.analysisDigest,
      },
    },
    mutating: true,
    risk: "high",
    parameters: {
      skillId: input.skillId,
      candidateId: input.candidateId,
      decision: input.decision,
      analysisDigest: input.analysisDigest,
      recommendation: input.recommendation,
      regressionVerdict: input.regressionVerdict,
    },
    idempotencyKey: input.idempotencyKey,
    localClaims: [
      {
        guardId: "skill_upgrade_decision_guard",
        decision: "requires_approval",
        risk: "high",
        reason: "skill_upgrade_decision_requires_canonical_approval",
      },
    ],
  };
}

export interface SignCanonicalApprovalInput {
  request: FridayMutatingActionRequest;
  tokenSecret: string;
  approvalId: string;
  decidedByPrincipalId: string;
  expiresAt: string;
  childOfLifecycleTicketId?: string;
}

export function signCanonicalApproval(
  input: SignCanonicalApprovalInput,
): FridayCanonicalApprovalResolution {
  return signFridayCanonicalApproval(
    {
      decision: "approved",
      approvalId: input.approvalId,
      decidedByPrincipalId: input.decidedByPrincipalId,
      actionDigest: createFridayMutatingActionDigest(input.request),
      expiresAt: input.expiresAt,
      childOfLifecycleTicketId: input.childOfLifecycleTicketId,
    },
    input.tokenSecret,
  );
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableStringify(value));
}

function normalizeForStableStringify(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableStringify(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, normalizeForStableStringify(record[key])]),
    );
  }
  return null;
}

export {
  createFridaySkillLifecycleMutatingActionRequest,
  createFridayMutatingActionDigest,
};
