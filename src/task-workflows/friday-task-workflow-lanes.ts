/**
 * Phase 13.5B executor/verifier lane helpers.
 *
 * Deterministic context snapshot hashing and independence resolution
 * shared by `friday-task-workflow-service` and the closeout gate
 * evaluators. Independence semantics enforce that:
 *
 *  - Provider fallback success is availability only, not verifier proof.
 *  - A verifier lane that shares lane role with the executor lane it
 *    audits is downgraded to `degraded_same_provider` unless both lanes
 *    carry concrete, different provider IDs. Equal providers, a null
 *    provider on either side, or otherwise unproven separation cannot
 *    silently claim independence.
 *  - High-risk workflows reject verifier lanes that do not resolve to
 *    `independent` independence.
 *
 * @module task-workflows/friday-task-workflow-lanes
 */

import { createHash } from "node:crypto";

import type {
  FridayTaskWorkflowContextPackage,
  FridayTaskWorkflowLaneIndependence,
  FridayTaskWorkflowLaneRole,
} from "./friday-task-workflow.types.js";

const LANE_CONTEXT_SNAPSHOT_SCHEMA = "friday.task_workflow.lane.context.v1";

export interface FridayTaskWorkflowLaneContextSnapshotInput {
  readonly contextPackage: FridayTaskWorkflowContextPackage;
  readonly boundaryRefs: readonly string[];
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

/**
 * Deterministically hash the lane's frozen context package + boundary
 * refs. The hash binds the lane to the exact context that was approved
 * at lane open; closeout uses this together with the captured workflow
 * spec_hash to detect drift after revisions.
 */
export function computeFridayTaskWorkflowLaneContextSnapshotHash(
  input: FridayTaskWorkflowLaneContextSnapshotInput,
): string {
  const normalized = {
    schema: LANE_CONTEXT_SNAPSHOT_SCHEMA,
    contextPackage: {
      allowedFiles: [...input.contextPackage.allowedFiles].sort(),
      allowedTools: [...input.contextPackage.allowedTools].sort(),
      allowedApis: [...input.contextPackage.allowedApis].sort(),
      boundaryIds: [...input.contextPackage.boundaryIds].sort(),
    },
    boundaryRefs: [...input.boundaryRefs].sort(),
  };
  return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

export interface FridayTaskWorkflowLaneIndependenceInput {
  readonly verifierLaneRole: FridayTaskWorkflowLaneRole;
  readonly verifierProviderId: string | null;
  readonly parentLaneRole: FridayTaskWorkflowLaneRole;
  readonly parentProviderId: string | null;
  readonly independenceClaim: FridayTaskWorkflowLaneIndependence;
}

/**
 * Resolve the honest independence label for a verifier lane.
 *
 *  - `degraded_unavailable` is accepted verbatim — the caller explicitly
 *    states that no independent verifier surface was available.
 *  - `independent` is preserved only when the verifier lane is a distinct
 *    surface from the executor lane it audits:
 *      - Different `laneRole` (e.g. native verifier auditing a provider
 *        executor) always counts as distinct.
 *      - Same `laneRole` counts as distinct only when both lanes carry
 *        concrete provider IDs and those IDs differ. Equal providers, a
 *        null provider on either side, or otherwise unproven separation
 *        is downgraded to `degraded_same_provider` rather than silently
 *        accepted as independent.
 *  - Any `not_applicable` claim on a verifier lane is rejected by the
 *    service before this helper is reached.
 */
export function resolveFridayTaskWorkflowVerifierIndependence(
  input: FridayTaskWorkflowLaneIndependenceInput,
): FridayTaskWorkflowLaneIndependence {
  if (input.independenceClaim === "degraded_unavailable") {
    return "degraded_unavailable";
  }
  if (input.independenceClaim === "degraded_same_provider") {
    return "degraded_same_provider";
  }
  if (input.independenceClaim === "independent") {
    const sameRole = input.verifierLaneRole === input.parentLaneRole;
    if (sameRole) {
      const distinctProviders =
        input.verifierProviderId !== null &&
        input.parentProviderId !== null &&
        input.verifierProviderId !== input.parentProviderId;
      if (!distinctProviders) {
        return "degraded_same_provider";
      }
    }
    return "independent";
  }
  return input.independenceClaim;
}
