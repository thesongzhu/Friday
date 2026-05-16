import { describe, expect, it } from "vitest";

import { buildFridayTaskWorkflowSupervisorOverview } from "../../../src/task-workflows/index.js";
import type {
  FridayTaskWorkflowChannelCommandRecord,
  FridayTaskWorkflowClaimRecord,
  FridayTaskWorkflowCloseoutReceipt,
  FridayTaskWorkflowLaneRecord,
  FridayTaskWorkflowRecord,
  FridayTaskWorkflowSupervisorCursorRecord,
} from "../../../src/task-workflows/index.js";

function makeWorkflow(
  overrides: Partial<FridayTaskWorkflowRecord> = {},
): FridayTaskWorkflowRecord {
  return {
    id: "wf-1",
    charter: "audit channel command flow",
    specHash: "spec-hash-1",
    parentSpecHash: null,
    taskKind: "general",
    risk: "medium",
    supervisorMode: "standard",
    budget: 4,
    stage: "charter",
    contextPackage: {
      allowedFiles: ["src/a.ts", "src/b.ts"],
      allowedTools: ["read"],
      allowedApis: [],
      boundaryIds: ["api.task_workflows.core"],
    },
    gatePlan: [
      { gateId: "required_gate_evidence_ref_present", required: true, additiveUser: false },
      { gateId: "independent_verifier_required", required: false, additiveUser: false },
      { gateId: "custom.gate", required: false, additiveUser: true },
    ],
    boundaryRefs: ["api.task_workflows.core"],
    metadata: {},
    createdAt: "2026-05-16T00:00:00Z",
    updatedAt: "2026-05-16T00:00:00Z",
    ...overrides,
  };
}

function makeClaim(
  id: string,
  status: FridayTaskWorkflowClaimRecord["status"],
): FridayTaskWorkflowClaimRecord {
  return {
    id,
    workflowId: "wf-1",
    specHash: "spec-hash-1",
    claimText: `claim ${id}`,
    claimKind: "runtime_evidence",
    status,
    reason: status === "blocked" ? "blocked-reason" : null,
    verifierVerdict: status === "verified" ? "ok" : null,
    verifierLaneId: null,
    evidenceRefCount: status === "verified" ? 1 : 0,
    createdAt: "2026-05-16T00:00:00Z",
    updatedAt: "2026-05-16T00:00:00Z",
  };
}

function makeLane(
  id: string,
  laneKind: "executor" | "verifier",
  status: FridayTaskWorkflowLaneRecord["status"] = "open",
  independence: FridayTaskWorkflowLaneRecord["independence"] = "not_applicable",
): FridayTaskWorkflowLaneRecord {
  return {
    id,
    workflowId: "wf-1",
    laneKind,
    laneRole: "native",
    parentLaneId: laneKind === "verifier" ? "exec-1" : null,
    status,
    independence,
    executorRunRef: null,
    providerId: null,
    routeTraceRef: null,
    contextSnapshotHash: "snapshot-hash",
    contextSnapshotSpecHash: "spec-hash-1",
    fallbackAvailability: null,
    blocker: null,
    createdAt: "2026-05-16T00:00:00Z",
    updatedAt: "2026-05-16T00:00:00Z",
  };
}

function makeCommand(
  id: string,
  status: FridayTaskWorkflowChannelCommandRecord["status"],
): FridayTaskWorkflowChannelCommandRecord {
  return {
    id,
    workflowId: "wf-1",
    channelKind: "discord",
    channelChatHash: "chat-hash",
    channelMessageHash: "message-hash",
    senderHash: "sender-hash",
    intentKind: "progress_query",
    confirmationToken: `tok-${id}`,
    status,
    dispatchedAction: status === "dispatched" ? "task.workflows.supervisor.read" : null,
    declinedReason: status === "declined" ? "user_declined" : null,
    issuedAt: "2026-05-16T00:00:00Z",
    confirmedAt:
      status === "dispatched" || status === "confirmed"
        ? "2026-05-16T00:01:00Z"
        : null,
    dispatchedAt: status === "dispatched" ? "2026-05-16T00:01:00Z" : null,
    expiresAt: "2026-05-16T00:10:00Z",
    createdAt: "2026-05-16T00:00:00Z",
  };
}

describe("buildFridayTaskWorkflowSupervisorOverview", () => {
  it("composes a read-only overview with summarized context package, claim matrix, lanes, and channel commands", () => {
    const workflow = makeWorkflow();
    const cursor: FridayTaskWorkflowSupervisorCursorRecord = {
      workflowId: "wf-1",
      currentStage: "verify",
      blockers: ["awaiting independent verifier"],
      lastEventRef: null,
      updatedAt: "2026-05-16T00:05:00Z",
    };
    const claims = [
      makeClaim("c-1", "draft"),
      makeClaim("c-2", "unverified"),
      makeClaim("c-3", "verified"),
      makeClaim("c-4", "blocked"),
    ];
    const lanes = [
      makeLane("exec-1", "executor", "completed"),
      makeLane("exec-2", "executor", "blocked"),
      makeLane("ver-1", "verifier", "completed", "independent"),
      makeLane("ver-2", "verifier", "open", "degraded_unavailable"),
    ];
    const commands = [
      makeCommand("cmd-1", "issued"),
      makeCommand("cmd-2", "dispatched"),
      makeCommand("cmd-3", "expired"),
    ];
    const receipt: FridayTaskWorkflowCloseoutReceipt = {
      id: "rcpt-1",
      workflowId: "wf-1",
      specHash: "spec-hash-1",
      status: "partial",
      claimSummary: { draft: 1, unverified: 1, verified: 1, blocked: 1 },
      blockers: ["1 claim(s) blocked"],
      gateOutcomes: [],
      createdAt: "2026-05-16T00:09:00Z",
    };
    const overview = buildFridayTaskWorkflowSupervisorOverview({
      workflow,
      supervisorCursor: cursor,
      claims,
      lanes,
      channelCommands: commands,
      closeoutReceipt: receipt,
    });
    expect(overview.workflow.id).toBe("wf-1");
    expect(overview.supervisorCursor?.currentStage).toBe("verify");
    expect(overview.contextPackageSummary).toEqual({
      boundaryIds: ["api.task_workflows.core"],
      allowedFilesCount: 2,
      allowedToolsCount: 1,
      allowedApisCount: 0,
    });
    expect(overview.boundaryRefs).toEqual(["api.task_workflows.core"]);
    expect(overview.gatePlan).toHaveLength(3);
    // Required deterministic gates are immutable in the view.
    expect(overview.immutableRequiredGateIds).toContain("required_gate_evidence_ref_present");
    // additive user gate is NOT immutable.
    expect(overview.immutableRequiredGateIds).not.toContain("custom.gate");
    expect(overview.claimMatrix.counts).toEqual({
      draft: 1,
      unverified: 1,
      verified: 1,
      blocked: 1,
    });
    expect(overview.claimMatrix.unverifiedClaims.map((c) => c.id)).toEqual([
      "c-1",
      "c-2",
    ]);
    expect(overview.claimMatrix.blockedClaims.map((c) => c.id)).toEqual(["c-4"]);
    expect(overview.laneSummary.executor.count).toBe(2);
    expect(overview.laneSummary.executor.blocked).toBe(1);
    expect(overview.laneSummary.verifier.count).toBe(2);
    expect(overview.laneSummary.verifier.independent).toBe(1);
    expect(overview.laneSummary.verifier.degraded).toBe(1);
    expect(overview.channelCommandSummary.total).toBe(3);
    expect(overview.channelCommandSummary.dispatched).toBe(1);
    expect(overview.channelCommandSummary.expired).toBe(1);
    expect(overview.blockers).toContain("awaiting independent verifier");
    expect(overview.blockers).toContain("1 claim(s) blocked");
    expect(overview.blockers).toContain("2 claim(s) not yet verified");
    expect(overview.closeoutReceipt?.id).toBe("rcpt-1");
  });

  it("does not leak allowed file list into the summary surface", () => {
    const workflow = makeWorkflow({
      contextPackage: {
        allowedFiles: ["src/should-not-appear-in-summary.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: [],
      },
    });
    const overview = buildFridayTaskWorkflowSupervisorOverview({
      workflow,
      supervisorCursor: null,
      claims: [],
      lanes: [],
      channelCommands: [],
      closeoutReceipt: null,
    });
    expect(overview.contextPackageSummary.allowedFilesCount).toBe(1);
    expect(JSON.stringify(overview.contextPackageSummary)).not.toContain(
      "src/should-not-appear-in-summary.ts",
    );
  });
});
