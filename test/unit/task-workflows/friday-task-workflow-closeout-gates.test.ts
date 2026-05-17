import { describe, expect, it } from "vitest";

import { evaluateFridayTaskWorkflowCloseoutGates } from "../../../src/task-workflows/index.js";
import type {
  FridayTaskWorkflowClaimRecord,
  FridayTaskWorkflowEvidenceRefRecord,
  FridayTaskWorkflowGatePlanEntry,
} from "../../../src/task-workflows/index.js";
import type { FridayTaskWorkflowWorkflowRunEvidenceStatus } from "../../../src/task-workflows/friday-task-workflow.types.js";

const ALL_REQUIRED_GATES: readonly FridayTaskWorkflowGatePlanEntry[] = [
  { gateId: "claim_evidence_required", required: true, additiveUser: false },
  { gateId: "verifier_fresh_read", required: true, additiveUser: false },
  { gateId: "docs_intent_not_proof", required: true, additiveUser: false },
  { gateId: "summary_replay_unconfirmed", required: true, additiveUser: false },
  { gateId: "cli_self_report_unconfirmed", required: true, additiveUser: false },
  { gateId: "provider_fallback_not_audit", required: true, additiveUser: false },
  { gateId: "context_package_scope_limit", required: true, additiveUser: false },
  { gateId: "executor_lane_context_bound", required: true, additiveUser: false },
  { gateId: "workflow_run_evidence_durable", required: true, additiveUser: false },
];

function makeVerifiedClaim(overrides: Partial<FridayTaskWorkflowClaimRecord> = {}): FridayTaskWorkflowClaimRecord {
  return {
    id: "claim-1",
    workflowId: "wf-1",
    specHash: "x".repeat(64),
    claimText: "verified runtime claim",
    claimKind: "runtime_evidence",
    status: "verified",
    reason: null,
    verifierVerdict: "verifier verdict",
    verifierLaneId: null,
    evidenceRefCount: 1,
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

function makeRef(overrides: Partial<FridayTaskWorkflowEvidenceRefRecord> = {}): FridayTaskWorkflowEvidenceRefRecord {
  return {
    id: "ref-1",
    workflowId: "wf-1",
    claimId: "claim-1",
    refKind: "workflow_run_evidence",
    refId: "run-1",
    refHash: null,
    refSource: "workflow_run_evidence",
    createdAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

function gateInput(
  options: {
    refsByClaim: ReadonlyMap<string, readonly FridayTaskWorkflowEvidenceRefRecord[]>;
    statusByRunId: ReadonlyMap<string, FridayTaskWorkflowWorkflowRunEvidenceStatus>;
    claims?: readonly FridayTaskWorkflowClaimRecord[];
  },
) {
  return {
    gatePlan: ALL_REQUIRED_GATES,
    claims: options.claims ?? [makeVerifiedClaim()],
    evidenceRefsByClaim: options.refsByClaim,
    contextPackage: {
      allowedFiles: ["src/x.ts"],
      allowedTools: [],
      allowedApis: [],
      boundaryIds: [],
    },
    lanes: [],
    risk: "medium" as const,
    workflowSpecHash: "y".repeat(64),
    workflowRunEvidenceStatusByRunId: options.statusByRunId,
  };
}

describe("Phase 14.5C module_28c — workflow_run_evidence_durable closeout gate", () => {
  it("blocks closeout when source run evidence is degraded", () => {
    const ref = makeRef({ refId: "run-degraded" });
    const refsByClaim = new Map<
      string,
      readonly FridayTaskWorkflowEvidenceRefRecord[]
    >([[ref.claimId, [ref]]]);
    const statusByRunId = new Map<
      string,
      FridayTaskWorkflowWorkflowRunEvidenceStatus
    >([["run-degraded", "degraded"]]);

    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({ refsByClaim, statusByRunId }),
    );
    const gate = outcomes.find((g) => g.gateId === "workflow_run_evidence_durable");
    expect(gate?.status).toBe("block");
    expect(gate?.reason).toContain("degraded");
  });

  it("blocks closeout when source run evidence is unavailable", () => {
    const ref = makeRef({ refId: "run-unavailable" });
    const refsByClaim = new Map<
      string,
      readonly FridayTaskWorkflowEvidenceRefRecord[]
    >([[ref.claimId, [ref]]]);
    const statusByRunId = new Map<
      string,
      FridayTaskWorkflowWorkflowRunEvidenceStatus
    >([["run-unavailable", "unavailable"]]);

    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({ refsByClaim, statusByRunId }),
    );
    const gate = outcomes.find((g) => g.gateId === "workflow_run_evidence_durable");
    expect(gate?.status).toBe("block");
    expect(gate?.reason).toContain("unavailable");
  });

  it("passes closeout when every source run reports available", () => {
    const ref = makeRef({ refId: "run-ok" });
    const refsByClaim = new Map<
      string,
      readonly FridayTaskWorkflowEvidenceRefRecord[]
    >([[ref.claimId, [ref]]]);
    const statusByRunId = new Map<
      string,
      FridayTaskWorkflowWorkflowRunEvidenceStatus
    >([["run-ok", "available"]]);

    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({ refsByClaim, statusByRunId }),
    );
    const gate = outcomes.find((g) => g.gateId === "workflow_run_evidence_durable");
    expect(gate?.status).toBe("pass");
  });

  it("required-gate-never-silent fallback applies when lookup data is missing", () => {
    const ref = makeRef({ refId: "run-unknown" });
    const refsByClaim = new Map<
      string,
      readonly FridayTaskWorkflowEvidenceRefRecord[]
    >([[ref.claimId, [ref]]]);
    const statusByRunId = new Map<
      string,
      FridayTaskWorkflowWorkflowRunEvidenceStatus
    >();

    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({ refsByClaim, statusByRunId }),
    );
    const gate = outcomes.find((g) => g.gateId === "workflow_run_evidence_durable");
    expect(gate?.status).toBe("block");
    expect(gate?.reason).toMatch(/required-gate-never-silent/i);
  });

  it("passes when no verified claim references workflow_run_evidence refs", () => {
    const refsByClaim = new Map<
      string,
      readonly FridayTaskWorkflowEvidenceRefRecord[]
    >();
    const statusByRunId = new Map<
      string,
      FridayTaskWorkflowWorkflowRunEvidenceStatus
    >();

    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({ refsByClaim, statusByRunId, claims: [] }),
    );
    const gate = outcomes.find((g) => g.gateId === "workflow_run_evidence_durable");
    expect(gate?.status).toBe("pass");
  });
});
