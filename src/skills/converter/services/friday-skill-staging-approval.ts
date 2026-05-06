import { createHash } from "node:crypto";

import type {
  FridayCanonicalApprovalResolution,
  FridayMutatingActionActor,
  FridayMutatingActionRequest,
} from "../../../security/friday-mutating-action-gate.js";
import type {
  FridaySkillConversionSource,
  FridaySkillSourceFormat,
} from "../model/friday-skill-converter.types.js";
import type { FridaySkillImportInput } from "./friday-skill-converter-service.types.js";

export interface FridaySkillStageApprovalInput {
  source: FridaySkillConversionSource;
  formatHint?: FridaySkillSourceFormat | "auto";
  target?: FridaySkillImportInput["target"];
  replace?: boolean;
  refreshRegistry?: boolean;
  options?: FridaySkillImportInput["options"];
  actor: FridayMutatingActionActor;
  surface: string;
  idempotencyKey?: string;
  planDigest?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export function createFridaySkillStageMutatingActionRequest(
  input: FridaySkillStageApprovalInput,
): FridayMutatingActionRequest {
  const normalizedSource = normalizeSkillStageSourceForDigest(input.source);
  const sourceFingerprint = hashStableJson(normalizedSource);

  return {
    action: "skills.import.stage_candidate",
    actor: input.actor,
    surface: input.surface,
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
        targetKind: resolveTargetKind(input.target),
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
    canonicalApproval: input.canonicalApproval,
  };
}

function normalizeSkillStageSourceForDigest(
  source: FridaySkillConversionSource,
): {
  uri?: string;
  contentBase64Digest?: string;
  formatHint?: FridaySkillSourceFormat | "auto";
} {
  return {
    uri: source.uri,
    contentBase64Digest: source.contentBase64 ? hashString(source.contentBase64) : undefined,
    formatHint: source.formatHint,
  };
}

function resolveTargetKind(target: FridaySkillImportInput["target"]): string {
  if (typeof target === "string") {
    return target;
  }
  if (target && typeof target === "object") {
    return "custom_path";
  }
  return "candidate_store";
}

function hashStableJson(value: unknown): string {
  return hashString(stableStringify(value));
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined && typeof item !== "function" && typeof item !== "symbol") {
        normalized[key] = normalizeForStableStringify(item);
      }
    }
    return normalized;
  }
  return null;
}
