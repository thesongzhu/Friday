/**
 * Phase 13.5D supervisor view assembler.
 *
 * Builds the read-only `FridayTaskWorkflowSupervisorOverview` from
 * existing task workflow state: workflow record, supervisor cursor,
 * boundary refs, gate plan, claim matrix, lane records, channel
 * command counts, and the latest closeout receipt. This module:
 *
 *  - Reads only task_workflow_* tables; never `/v1/agent/runs` or raw
 *    channel payload tables.
 *  - Re-uses the gate registry to expose `immutableRequiredGateIds`
 *    derived from gate metadata, so UI surfaces can render required
 *    gates as non-disableable without re-implementing the registry
 *    semantics.
 *  - Compacts the context package into a cardinality summary instead of
 *    echoing the allowed file list (the allowed file list is already on
 *    the workflow record for callers who explicitly fetch it).
 *
 * @module task-workflows/friday-task-workflow-supervisor-view
 */

import { isFridayRequiredGate } from "./friday-task-workflow-gates.js";
import type {
  FridayTaskWorkflowChannelCommandRecord,
  FridayTaskWorkflowChannelCommandSummary,
  FridayTaskWorkflowClaimRecord,
  FridayTaskWorkflowCloseoutReceipt,
  FridayTaskWorkflowContextPackage,
  FridayTaskWorkflowContextPackageSummary,
  FridayTaskWorkflowGatePlanEntry,
  FridayTaskWorkflowLaneRecord,
  FridayTaskWorkflowLaneSummary,
  FridayTaskWorkflowRecord,
  FridayTaskWorkflowSupervisorCursorRecord,
  FridayTaskWorkflowSupervisorOverview,
} from "./friday-task-workflow.types.js";

export interface BuildFridayTaskWorkflowSupervisorOverviewInput {
  readonly workflow: FridayTaskWorkflowRecord;
  readonly supervisorCursor: FridayTaskWorkflowSupervisorCursorRecord | null;
  readonly claims: readonly FridayTaskWorkflowClaimRecord[];
  readonly lanes: readonly FridayTaskWorkflowLaneRecord[];
  readonly channelCommands: readonly FridayTaskWorkflowChannelCommandRecord[];
  readonly closeoutReceipt: FridayTaskWorkflowCloseoutReceipt | null;
}

export function buildFridayTaskWorkflowSupervisorOverview(
  input: BuildFridayTaskWorkflowSupervisorOverviewInput,
): FridayTaskWorkflowSupervisorOverview {
  const contextPackageSummary = summarizeContextPackage(input.workflow.contextPackage);
  const immutableRequiredGateIds = collectImmutableRequiredGateIds(
    input.workflow.gatePlan,
  );
  const counts = countClaims(input.claims);
  const unverifiedClaims = input.claims.filter(
    (claim) => claim.status === "draft" || claim.status === "unverified",
  );
  const blockedClaims = input.claims.filter((claim) => claim.status === "blocked");
  const laneSummary = summarizeLanes(input.lanes);
  const channelCommandSummary = summarizeChannelCommands(input.channelCommands);
  const blockers = collectBlockers({
    cursor: input.supervisorCursor,
    receipt: input.closeoutReceipt,
    blockedClaims,
    unverifiedClaims,
    laneSummary,
  });
  return {
    workflow: input.workflow,
    supervisorCursor: input.supervisorCursor,
    boundaryRefs: input.workflow.boundaryRefs,
    contextPackageSummary,
    gatePlan: input.workflow.gatePlan,
    immutableRequiredGateIds,
    claimMatrix: {
      counts,
      unverifiedClaims,
      blockedClaims,
    },
    laneSummary,
    channelCommandSummary,
    blockers,
    closeoutReceipt: input.closeoutReceipt,
  };
}

function summarizeContextPackage(
  pkg: FridayTaskWorkflowContextPackage,
): FridayTaskWorkflowContextPackageSummary {
  return {
    boundaryIds: pkg.boundaryIds,
    allowedFilesCount: pkg.allowedFiles.length,
    allowedToolsCount: pkg.allowedTools.length,
    allowedApisCount: pkg.allowedApis.length,
  };
}

function collectImmutableRequiredGateIds(
  gatePlan: readonly FridayTaskWorkflowGatePlanEntry[],
): readonly string[] {
  const ids = new Set<string>();
  for (const entry of gatePlan) {
    if (entry.required || isFridayRequiredGate(entry.gateId)) {
      ids.add(entry.gateId);
    }
  }
  return [...ids];
}

function countClaims(claims: readonly FridayTaskWorkflowClaimRecord[]) {
  return {
    draft: claims.filter((c) => c.status === "draft").length,
    unverified: claims.filter((c) => c.status === "unverified").length,
    verified: claims.filter((c) => c.status === "verified").length,
    blocked: claims.filter((c) => c.status === "blocked").length,
  } as const;
}

function summarizeLanes(
  lanes: readonly FridayTaskWorkflowLaneRecord[],
): FridayTaskWorkflowLaneSummary {
  const executor = lanes.filter((l) => l.laneKind === "executor");
  const verifier = lanes.filter((l) => l.laneKind === "verifier");
  return {
    executor: {
      count: executor.length,
      open: executor.filter((l) => l.status === "open" || l.status === "in_progress")
        .length,
      completed: executor.filter((l) => l.status === "completed").length,
      blocked: executor.filter((l) => l.status === "blocked").length,
    },
    verifier: {
      count: verifier.length,
      open: verifier.filter((l) => l.status === "open" || l.status === "in_progress")
        .length,
      completed: verifier.filter((l) => l.status === "completed").length,
      blocked: verifier.filter((l) => l.status === "blocked").length,
      independent: verifier.filter((l) => l.independence === "independent").length,
      degraded: verifier.filter(
        (l) =>
          l.independence === "degraded_unavailable" ||
          l.independence === "degraded_same_provider",
      ).length,
    },
  };
}

function summarizeChannelCommands(
  commands: readonly FridayTaskWorkflowChannelCommandRecord[],
): FridayTaskWorkflowChannelCommandSummary {
  return {
    total: commands.length,
    issued: commands.filter((c) => c.status === "issued").length,
    confirmed: commands.filter((c) => c.status === "confirmed").length,
    dispatched: commands.filter((c) => c.status === "dispatched").length,
    declined: commands.filter((c) => c.status === "declined").length,
    expired: commands.filter((c) => c.status === "expired").length,
  };
}

function collectBlockers(input: {
  readonly cursor: FridayTaskWorkflowSupervisorCursorRecord | null;
  readonly receipt: FridayTaskWorkflowCloseoutReceipt | null;
  readonly blockedClaims: readonly FridayTaskWorkflowClaimRecord[];
  readonly unverifiedClaims: readonly FridayTaskWorkflowClaimRecord[];
  readonly laneSummary: FridayTaskWorkflowLaneSummary;
}): readonly string[] {
  const blockers: string[] = [];
  if (input.cursor) {
    for (const blocker of input.cursor.blockers) {
      if (typeof blocker === "string" && blocker.trim().length > 0) {
        blockers.push(blocker.trim());
      }
    }
  }
  if (input.receipt) {
    for (const blocker of input.receipt.blockers) {
      if (typeof blocker === "string" && blocker.trim().length > 0) {
        blockers.push(blocker.trim());
      }
    }
  }
  if (input.blockedClaims.length > 0) {
    blockers.push(`${input.blockedClaims.length} claim(s) blocked`);
  }
  if (input.unverifiedClaims.length > 0) {
    blockers.push(`${input.unverifiedClaims.length} claim(s) not yet verified`);
  }
  if (input.laneSummary.executor.blocked > 0) {
    blockers.push(
      `${input.laneSummary.executor.blocked} executor lane(s) blocked`,
    );
  }
  if (input.laneSummary.verifier.blocked > 0) {
    blockers.push(
      `${input.laneSummary.verifier.blocked} verifier lane(s) blocked`,
    );
  }
  return dedupe(blockers);
}

function dedupe(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}
