/**
 * RGG-side mirror of the Phase 06 skill upgrade canonical-approval helper.
 *
 * Mirrors `test/e2e/api/_helpers/friday-skill-upgrade-canonical-approval.helper.ts`
 * so the RGG executor can construct the exact mutating-action request shape
 * each route+service hashes and sign it with the same token secret the hub gate
 * uses. Mirror it exactly when the TypeScript helper changes.
 *
 * Also mirrors `createFridaySkillStageMutatingActionRequest` from
 * `src/skills/converter/services/friday-skill-staging-approval.ts` so the RGG
 * executor can self-stage v1/v2 candidates via `POST /v1/skills/import` with a
 * correctly-shaped canonical approval. Mirror it exactly when the TypeScript
 * staging-approval helper changes.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const AUTONOMY_SURFACE_BY_ACTION = {
  shadow: "api:/v1/autonomy/skills/shadow",
  canary: "api:/v1/autonomy/skills/canary",
  promote: "api:/v1/autonomy/skills/promote",
  rollback: "api:/v1/autonomy/skills/rollback",
};

const SKILL_IMPORT_SURFACE = "api:/v1/skills/import";

function normalizeForStableStringify(value) {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableStringify(item));
  }
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = normalizeForStableStringify(value[key]);
    }
    return out;
  }
  return null;
}

function stableStringify(value) {
  return JSON.stringify(normalizeForStableStringify(value));
}

function hashStableJson(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function deriveRisk(request) {
  if (request.risk) return request.risk;
  if (request.mutating === false) return "read_only";
  return "medium";
}

export function createCanonicalActionDigest(request) {
  const payload = {
    version: 1,
    action: request.action,
    actor: {
      kind: request.actor.kind,
      id: request.actor.id,
      principalId: request.actor.principalId,
    },
    surface: request.surface,
    resource: {
      type: request.resource.type,
      id: request.resource.id,
      digest: request.resource.digest,
      attributes: request.resource.attributes,
    },
    mutating: request.mutating,
    risk: deriveRisk(request),
    parameters: request.parameters,
    planDigest: request.planDigest,
    rollback: request.rollback,
    idempotencyKey: request.idempotencyKey,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function canonicalApprovalSignaturePayload(approval) {
  return {
    version: 1,
    decision: approval.decision,
    approvalId: approval.approvalId,
    decidedByPrincipalId: approval.decidedByPrincipalId,
    actionDigest: approval.actionDigest,
    reason: approval.reason,
    expiresAt: approval.expiresAt,
    childOfLifecycleTicketId: approval.childOfLifecycleTicketId,
  };
}

export function signFridayCanonicalApproval(approval, secret) {
  const signature = createHmac("sha256", secret)
    .update(stableStringify(canonicalApprovalSignaturePayload(approval)))
    .digest("hex");
  return { ...approval, issuer: "friday_canonical_gate", signature };
}

export function verifyFridayCanonicalApprovalSignature(approval, secret) {
  if (approval.issuer !== "friday_canonical_gate" || typeof approval.signature !== "string") {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(stableStringify(canonicalApprovalSignaturePayload(approval)))
    .digest("hex");
  const actualBuffer = Buffer.from(approval.signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function canaryInputDigest(canaryInput) {
  return hashStableJson(canaryInput ?? {});
}

export function buildSkillLifecycleApprovalRequest(input) {
  const surface = AUTONOMY_SURFACE_BY_ACTION[input.action];
  if (!surface) {
    throw new Error(`Unknown skill lifecycle action: ${input.action}`);
  }
  const candidateId = input.candidateId ?? input.shadowVersionId;
  const parameters = {
    skillId: input.skillId,
    candidateId,
    shadowVersionId: candidateId,
    runtimeVersion: input.runtimeVersion,
    providerModel: input.providerModel,
    ...(input.action === "canary" ? { canaryInputDigest: canaryInputDigest(input.canaryInput) } : {}),
  };
  const attributes = {
    skillId: input.skillId,
    candidateId,
    lifecycleAction: input.action,
    ...(input.action === "canary" ? { canaryInputDigest: canaryInputDigest(input.canaryInput) } : {}),
  };
  const rollback = input.action === "rollback"
    ? {
      planned: true,
      planDigest: input.planDigest,
      actions: ["skills.lifecycle.promote"],
    }
    : undefined;
  return {
    action: `skills.lifecycle.${input.action}`,
    actor: input.actor,
    surface,
    resource: {
      type: "external_skill_lifecycle",
      id: input.skillId,
      digest: hashStableJson(parameters),
      attributes,
    },
    mutating: true,
    risk: "high",
    parameters,
    planDigest: input.planDigest,
    rollback,
    idempotencyKey: input.idempotencyKey,
    localClaims: [
      {
        guardId: "external_skill_lifecycle_guard",
        decision: "requires_approval",
        risk: "high",
        reason: `external_skill_${input.action}_requires_canonical_approval`,
      },
    ],
  };
}

export function buildSkillUpgradeDecideApprovalRequest(input) {
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

export function signCanonicalApprovalForRequest({ request, tokenSecret, approvalId, decidedByPrincipalId, expiresAt }) {
  return signFridayCanonicalApproval(
    {
      decision: "approved",
      approvalId,
      decidedByPrincipalId,
      actionDigest: createCanonicalActionDigest(request),
      expiresAt,
    },
    tokenSecret,
  );
}

function normalizeSkillStageSourceForDigest(source) {
  return {
    uri: source.uri,
    contentBase64Digest: source.contentBase64
      ? createHash("sha256").update(source.contentBase64).digest("hex")
      : undefined,
    formatHint: source.formatHint,
  };
}

function resolveSkillStageTargetKind(target) {
  if (typeof target === "string") {
    return target;
  }
  if (target && typeof target === "object") {
    return "custom_path";
  }
  return "candidate_store";
}

export function buildSkillImportStageApprovalRequest(input) {
  const normalizedSource = normalizeSkillStageSourceForDigest(input.source);
  const sourceFingerprint = hashStableJson(normalizedSource);
  return {
    action: "skills.import.stage_candidate",
    actor: input.actor,
    surface: input.surface ?? SKILL_IMPORT_SURFACE,
    resource: {
      type: "external_skill_candidate",
      id: `skill-source:${sourceFingerprint.slice(0, 16)}`,
      digest: hashStableJson({
        source: normalizedSource,
        formatHint: input.formatHint,
        target: input.target,
        replace: input.replace,
        refreshRegistry: input.refreshRegistry,
        options: input.options,
      }),
      attributes: {
        sourceKind: normalizedSource.uri ? "uri" : "contentBase64",
        formatHint: input.formatHint ?? input.source.formatHint ?? "auto",
        targetKind: resolveSkillStageTargetKind(input.target),
      },
    },
    mutating: true,
    risk: "high",
    parameters: {
      source: normalizedSource,
      formatHint: input.formatHint,
      target: input.target,
      replace: input.replace,
      refreshRegistry: input.refreshRegistry,
      options: input.options,
    },
    planDigest: input.planDigest,
    idempotencyKey: input.idempotencyKey,
    localClaims: [
      {
        guardId: "external_skill_lifecycle_guard",
        decision: "requires_approval",
        risk: "high",
        reason: "external_skill_candidate_staging_requires_canonical_approval",
      },
    ],
  };
}
