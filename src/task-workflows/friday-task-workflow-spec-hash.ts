/**
 * Phase 13.5A deterministic spec-hash computation.
 *
 * The spec hash binds together the charter text, task kind, supervisor
 * mode, risk, context package, gate plan, boundary refs, and any
 * additional user gates. Revised requirements always produce a new spec
 * hash; the prior hash is preserved as `parentSpecHash` for lineage.
 *
 * @module task-workflows/friday-task-workflow-spec-hash
 */

import { createHash } from "node:crypto";

import type {
  FridayTaskWorkflowContextPackage,
  FridayTaskWorkflowGatePlanEntry,
  FridayTaskWorkflowRisk,
  FridayTaskWorkflowSupervisorMode,
} from "./friday-task-workflow.types.js";

const SPEC_HASH_SCHEMA = "friday.task_workflow.spec.v1";

export interface FridayTaskWorkflowSpecHashInput {
  readonly charter: string;
  readonly taskKind: string;
  readonly risk: FridayTaskWorkflowRisk;
  readonly supervisorMode: FridayTaskWorkflowSupervisorMode;
  readonly contextPackage: FridayTaskWorkflowContextPackage;
  readonly gatePlan: readonly FridayTaskWorkflowGatePlanEntry[];
  readonly boundaryRefs: readonly string[];
  readonly parentSpecHash?: string | null;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value ?? null);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function computeFridayTaskWorkflowSpecHash(
  input: FridayTaskWorkflowSpecHashInput,
): string {
  const normalized = {
    schema: SPEC_HASH_SCHEMA,
    charter: input.charter.trim(),
    taskKind: input.taskKind.trim(),
    risk: input.risk,
    supervisorMode: input.supervisorMode,
    contextPackage: {
      allowedFiles: [...input.contextPackage.allowedFiles].sort(),
      allowedTools: [...input.contextPackage.allowedTools].sort(),
      allowedApis: [...input.contextPackage.allowedApis].sort(),
      boundaryIds: [...input.contextPackage.boundaryIds].sort(),
    },
    gatePlan: input.gatePlan
      .map((entry) => ({
        gateId: entry.gateId,
        required: entry.required,
        additiveUser: entry.additiveUser,
      }))
      .sort((a, b) => a.gateId.localeCompare(b.gateId)),
    boundaryRefs: [...input.boundaryRefs].sort(),
    parentSpecHash: input.parentSpecHash ?? null,
  };
  return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}
