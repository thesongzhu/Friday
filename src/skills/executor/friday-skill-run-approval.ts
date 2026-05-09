import { createHash } from "node:crypto";

import type {
  FridayMutatingActionActor,
  FridayMutatingActionRequest,
} from "../../security/friday-mutating-action-gate.js";

export interface FridaySkillRunApprovalRequestInput {
  skillId: string;
  input?: Record<string, unknown>;
  timeoutMs?: number;
  channel?: string;
  sessionId?: string;
  actor: FridayMutatingActionActor;
  surface: string;
  idempotencyKey?: string;
}

export function createFridaySkillRunMutatingActionRequest(
  input: FridaySkillRunApprovalRequestInput,
): FridayMutatingActionRequest {
  return {
    action: "skills.run",
    actor: input.actor,
    surface: input.surface,
    resource: {
      type: "external_skill_runtime",
      id: input.skillId,
      digest: hashStableJson({
        skillId: input.skillId,
        input: input.input ?? {},
        timeoutMs: input.timeoutMs,
        channel: input.channel,
        sessionId: input.sessionId,
      }),
      attributes: {
        skillId: input.skillId,
      },
    },
    mutating: true,
    risk: "high",
    parameters: {
      skillId: input.skillId,
      inputDigest: hashStableJson(input.input ?? {}),
      timeoutMs: input.timeoutMs,
      channel: input.channel,
      sessionId: input.sessionId,
    },
    idempotencyKey: input.idempotencyKey,
    localClaims: [
      {
        guardId: "external_skill_runtime_guard",
        decision: "requires_approval",
        risk: "high",
        reason: "external_skill_run_requires_canonical_approval",
      },
    ],
  };
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
