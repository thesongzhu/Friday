import { describe, expect, it } from "vitest";

import {
  computeFridayTaskWorkflowCloseoutRollbackDisclosure,
  evaluateFridayTaskWorkflowCloseoutGates,
  FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE,
} from "../../../src/task-workflows/index.js";
import type {
  FridayTaskWorkflowClaimRecord,
  FridayTaskWorkflowCloseoutRollbackDisclosure,
  FridayTaskWorkflowEvidenceRefRecord,
  FridayTaskWorkflowEvidenceSource,
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
    gatePlan?: readonly FridayTaskWorkflowGatePlanEntry[];
    rollbackDisclosure?: FridayTaskWorkflowCloseoutRollbackDisclosure;
  },
) {
  return {
    gatePlan: options.gatePlan ?? ALL_REQUIRED_GATES,
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
    rollbackDisclosure: options.rollbackDisclosure,
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

describe("Phase 14.5D module_28d — rollback class registry", () => {
  it("registry covers every FridayTaskWorkflowEvidenceSource exactly once", () => {
    const expectedSources: FridayTaskWorkflowEvidenceSource[] = [
      "agent_run_event",
      "workflow_run_evidence",
      "provider_route_trace",
      "context_replay",
      "self_heal_event",
      "channel_event",
      "session_event",
      "observability_audit",
      "manual_external",
      "docs_intent_reference",
    ];
    const registryKeys = Object.keys(
      FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE,
    ).sort();
    expect(registryKeys).toEqual([...expectedSources].sort());
    for (const source of expectedSources) {
      expect(
        FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE[source],
      ).toMatch(
        /^(reversible_local|compensating_action_required|non_reversible_external|not_applicable)$/,
      );
    }
  });

  it("maps each ref source to the expected rollback class per Stage 2 matrix", () => {
    expect(FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.agent_run_event).toBe(
      "reversible_local",
    );
    expect(
      FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.workflow_run_evidence,
    ).toBe("compensating_action_required");
    expect(
      FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.provider_route_trace,
    ).toBe("non_reversible_external");
    expect(FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.context_replay).toBe(
      "not_applicable",
    );
    expect(FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.self_heal_event).toBe(
      "reversible_local",
    );
    expect(FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.channel_event).toBe(
      "non_reversible_external",
    );
    expect(FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.session_event).toBe(
      "reversible_local",
    );
    expect(
      FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.observability_audit,
    ).toBe("not_applicable");
    expect(FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.manual_external).toBe(
      "non_reversible_external",
    );
    expect(
      FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.docs_intent_reference,
    ).toBe("not_applicable");
  });

  it("every rollback class is represented by at least one ref source", () => {
    const seen = new Set<string>(
      Object.values(FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE),
    );
    expect(seen.has("reversible_local")).toBe(true);
    expect(seen.has("compensating_action_required")).toBe(true);
    expect(seen.has("non_reversible_external")).toBe(true);
    expect(seen.has("not_applicable")).toBe(true);
  });
});

describe("Phase 14.5D module_28d — computeFridayTaskWorkflowCloseoutRollbackDisclosure", () => {
  it("returns not_applicable with null disclosure when no verified or blocked claims exist", () => {
    const disclosure = computeFridayTaskWorkflowCloseoutRollbackDisclosure({
      claims: [],
      evidenceRefsByClaim: new Map(),
    });
    expect(disclosure.rollbackClass).toBe("not_applicable");
    expect(disclosure.compensatingAction).toBeNull();
    expect(disclosure.nonReversibleReason).toBeNull();
    expect(disclosure.observedRefSourceClasses.size).toBe(0);
  });

  it("ignores draft and unverified claims when projecting disclosure", () => {
    const draft = makeVerifiedClaim({ id: "c-draft", status: "draft" });
    const unverified = makeVerifiedClaim({
      id: "c-unver",
      status: "unverified",
    });
    const refs = new Map<string, readonly FridayTaskWorkflowEvidenceRefRecord[]>([
      [draft.id, [makeRef({ id: "r-1", claimId: draft.id, refSource: "channel_event" })]],
      [unverified.id, [makeRef({ id: "r-2", claimId: unverified.id, refSource: "manual_external" })]],
    ]);
    const disclosure = computeFridayTaskWorkflowCloseoutRollbackDisclosure({
      claims: [draft, unverified],
      evidenceRefsByClaim: refs,
    });
    expect(disclosure.rollbackClass).toBe("not_applicable");
    expect(disclosure.observedRefSourceClasses.size).toBe(0);
  });

  it("produces reversible_local for verified claims backed by only local sources", () => {
    const claim = makeVerifiedClaim({ id: "c-local" });
    const refs = new Map<string, readonly FridayTaskWorkflowEvidenceRefRecord[]>([
      [
        claim.id,
        [
          makeRef({ id: "r-agent", claimId: claim.id, refSource: "agent_run_event" }),
          makeRef({ id: "r-self", claimId: claim.id, refSource: "self_heal_event" }),
          makeRef({ id: "r-docs", claimId: claim.id, refSource: "docs_intent_reference" }),
        ],
      ],
    ]);
    const disclosure = computeFridayTaskWorkflowCloseoutRollbackDisclosure({
      claims: [claim],
      evidenceRefsByClaim: refs,
    });
    expect(disclosure.rollbackClass).toBe("reversible_local");
    expect(disclosure.compensatingAction).toBeNull();
    expect(disclosure.nonReversibleReason).toBeNull();
  });

  it("produces compensating_action_required for workflow_run_evidence refs and populates a non-empty action", () => {
    const claim = makeVerifiedClaim({ id: "c-wfe" });
    const refs = new Map<string, readonly FridayTaskWorkflowEvidenceRefRecord[]>([
      [
        claim.id,
        [
          makeRef({ id: "r-wfe", claimId: claim.id, refSource: "workflow_run_evidence" }),
          makeRef({ id: "r-agent", claimId: claim.id, refSource: "agent_run_event" }),
        ],
      ],
    ]);
    const disclosure = computeFridayTaskWorkflowCloseoutRollbackDisclosure({
      claims: [claim],
      evidenceRefsByClaim: refs,
    });
    expect(disclosure.rollbackClass).toBe("compensating_action_required");
    expect(disclosure.compensatingAction).toMatch(/workflow_run_evidence/);
    expect(disclosure.nonReversibleReason).toBeNull();
  });

  it("produces non_reversible_external for channel/provider/manual_external refs with a non-empty reason", () => {
    const claim = makeVerifiedClaim({ id: "c-ext" });
    const refs = new Map<string, readonly FridayTaskWorkflowEvidenceRefRecord[]>([
      [
        claim.id,
        [
          makeRef({ id: "r-ch", claimId: claim.id, refSource: "channel_event" }),
          makeRef({ id: "r-pr", claimId: claim.id, refSource: "provider_route_trace" }),
          makeRef({ id: "r-wfe", claimId: claim.id, refSource: "workflow_run_evidence" }),
        ],
      ],
    ]);
    const disclosure = computeFridayTaskWorkflowCloseoutRollbackDisclosure({
      claims: [claim],
      evidenceRefsByClaim: refs,
    });
    expect(disclosure.rollbackClass).toBe("non_reversible_external");
    expect(disclosure.nonReversibleReason).toMatch(/channel_event|provider_route_trace/);
    expect(disclosure.compensatingAction).toBeNull();
  });

  it("is deterministic across repeated invocations on the same input", () => {
    const claim = makeVerifiedClaim({ id: "c-det" });
    const refs = new Map<string, readonly FridayTaskWorkflowEvidenceRefRecord[]>([
      [
        claim.id,
        [
          makeRef({ id: "r-1", claimId: claim.id, refSource: "channel_event" }),
          makeRef({ id: "r-2", claimId: claim.id, refSource: "manual_external" }),
          makeRef({ id: "r-3", claimId: claim.id, refSource: "manual_external" }),
        ],
      ],
    ]);
    const first = computeFridayTaskWorkflowCloseoutRollbackDisclosure({
      claims: [claim],
      evidenceRefsByClaim: refs,
    });
    for (let i = 0; i < 5; i += 1) {
      const next = computeFridayTaskWorkflowCloseoutRollbackDisclosure({
        claims: [claim],
        evidenceRefsByClaim: refs,
      });
      expect(next.rollbackClass).toBe(first.rollbackClass);
      expect(next.compensatingAction).toBe(first.compensatingAction);
      expect(next.nonReversibleReason).toBe(first.nonReversibleReason);
    }
  });

  it("considers blocked claims alongside verified claims in disclosure", () => {
    const blocked = makeVerifiedClaim({
      id: "c-blocked",
      status: "blocked",
      reason: "blocked by reviewer",
    });
    const refs = new Map<string, readonly FridayTaskWorkflowEvidenceRefRecord[]>([
      [
        blocked.id,
        [makeRef({ id: "r-b", claimId: blocked.id, refSource: "manual_external" })],
      ],
    ]);
    const disclosure = computeFridayTaskWorkflowCloseoutRollbackDisclosure({
      claims: [blocked],
      evidenceRefsByClaim: refs,
    });
    expect(disclosure.rollbackClass).toBe("non_reversible_external");
  });
});

describe("Phase 14.5D module_28d — rollback_class_disclosure_required closeout gate", () => {
  const ROLLBACK_GATE_PLAN: readonly FridayTaskWorkflowGatePlanEntry[] = [
    { gateId: "rollback_class_disclosure_required", required: true, additiveUser: false },
  ];

  it("falls back to block when receipt-under-construction disclosure is missing", () => {
    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({
        refsByClaim: new Map(),
        statusByRunId: new Map(),
        claims: [],
        gatePlan: ROLLBACK_GATE_PLAN,
        rollbackDisclosure: undefined,
      }),
    );
    const gate = outcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("block");
    expect(gate?.reason).toMatch(/required-gate-never-silent|no rollback disclosure/);
  });

  it("passes when rollbackClass is not_applicable and no external refs exist", () => {
    const disclosure: FridayTaskWorkflowCloseoutRollbackDisclosure = {
      rollbackClass: "not_applicable",
      compensatingAction: null,
      nonReversibleReason: null,
      observedRefSourceClasses: new Map(),
    };
    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({
        refsByClaim: new Map(),
        statusByRunId: new Map(),
        claims: [],
        gatePlan: ROLLBACK_GATE_PLAN,
        rollbackDisclosure: disclosure,
      }),
    );
    const gate = outcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("pass");
  });

  it("passes when rollbackClass is reversible_local and every observed source is local/audit", () => {
    const disclosure: FridayTaskWorkflowCloseoutRollbackDisclosure = {
      rollbackClass: "reversible_local",
      compensatingAction: null,
      nonReversibleReason: null,
      observedRefSourceClasses: new Map([
        ["r-a", "reversible_local"],
        ["r-b", "not_applicable"],
      ]),
    };
    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({
        refsByClaim: new Map(),
        statusByRunId: new Map(),
        claims: [],
        gatePlan: ROLLBACK_GATE_PLAN,
        rollbackDisclosure: disclosure,
      }),
    );
    const gate = outcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("pass");
  });

  it("blocks overclaim by understatement: reversible_local with non-local refs", () => {
    const disclosure: FridayTaskWorkflowCloseoutRollbackDisclosure = {
      rollbackClass: "reversible_local",
      compensatingAction: null,
      nonReversibleReason: null,
      observedRefSourceClasses: new Map([
        ["r-a", "reversible_local"],
        ["r-ext", "non_reversible_external"],
      ]),
    };
    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({
        refsByClaim: new Map(),
        statusByRunId: new Map(),
        claims: [],
        gatePlan: ROLLBACK_GATE_PLAN,
        rollbackDisclosure: disclosure,
      }),
    );
    const gate = outcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("block");
    expect(gate?.reason).toMatch(/reversible_local/);
    expect(gate?.reason).toMatch(/non_reversible_external/);
  });

  it("blocks overclaim by omission: non_reversible_external with null reason", () => {
    const disclosure: FridayTaskWorkflowCloseoutRollbackDisclosure = {
      rollbackClass: "non_reversible_external",
      compensatingAction: null,
      nonReversibleReason: null,
      observedRefSourceClasses: new Map([["r-ch", "non_reversible_external"]]),
    };
    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({
        refsByClaim: new Map(),
        statusByRunId: new Map(),
        claims: [],
        gatePlan: ROLLBACK_GATE_PLAN,
        rollbackDisclosure: disclosure,
      }),
    );
    const gate = outcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("block");
    expect(gate?.reason).toMatch(/non_reversible_external/);
    expect(gate?.reason).toMatch(/nonReversibleReason/);
  });

  it("blocks overclaim by omission: non_reversible_external with whitespace-only reason", () => {
    const disclosure: FridayTaskWorkflowCloseoutRollbackDisclosure = {
      rollbackClass: "non_reversible_external",
      compensatingAction: null,
      nonReversibleReason: "   ",
      observedRefSourceClasses: new Map([["r-ch", "non_reversible_external"]]),
    };
    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({
        refsByClaim: new Map(),
        statusByRunId: new Map(),
        claims: [],
        gatePlan: ROLLBACK_GATE_PLAN,
        rollbackDisclosure: disclosure,
      }),
    );
    const gate = outcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("block");
  });

  it("passes when non_reversible_external is paired with a real reason", () => {
    const disclosure: FridayTaskWorkflowCloseoutRollbackDisclosure = {
      rollbackClass: "non_reversible_external",
      compensatingAction: null,
      nonReversibleReason: "channel_event sent to external chat",
      observedRefSourceClasses: new Map([["r-ch", "non_reversible_external"]]),
    };
    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({
        refsByClaim: new Map(),
        statusByRunId: new Map(),
        claims: [],
        gatePlan: ROLLBACK_GATE_PLAN,
        rollbackDisclosure: disclosure,
      }),
    );
    const gate = outcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("pass");
  });

  it("blocks compensating_action_required when compensatingAction is null", () => {
    const disclosure: FridayTaskWorkflowCloseoutRollbackDisclosure = {
      rollbackClass: "compensating_action_required",
      compensatingAction: null,
      nonReversibleReason: null,
      observedRefSourceClasses: new Map([
        ["r-wfe", "compensating_action_required"],
      ]),
    };
    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({
        refsByClaim: new Map(),
        statusByRunId: new Map(),
        claims: [],
        gatePlan: ROLLBACK_GATE_PLAN,
        rollbackDisclosure: disclosure,
      }),
    );
    const gate = outcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("block");
    expect(gate?.reason).toMatch(/compensatingAction/);
  });

  it("passes compensating_action_required when compensatingAction is non-empty", () => {
    const disclosure: FridayTaskWorkflowCloseoutRollbackDisclosure = {
      rollbackClass: "compensating_action_required",
      compensatingAction: "compensating action required for: workflow_run_evidence",
      nonReversibleReason: null,
      observedRefSourceClasses: new Map([
        ["r-wfe", "compensating_action_required"],
      ]),
    };
    const outcomes = evaluateFridayTaskWorkflowCloseoutGates(
      gateInput({
        refsByClaim: new Map(),
        statusByRunId: new Map(),
        claims: [],
        gatePlan: ROLLBACK_GATE_PLAN,
        rollbackDisclosure: disclosure,
      }),
    );
    const gate = outcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("pass");
  });
});
