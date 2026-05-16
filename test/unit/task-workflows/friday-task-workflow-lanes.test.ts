import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createFridaySqliteLayer } from "#state";

import { FridayDomainError } from "../../../src/errors/friday-domain-error.js";
import {
  computeFridayTaskWorkflowLaneContextSnapshotHash,
  createFridayTaskWorkflowRepository,
  createFridayTaskWorkflowService,
  resolveFridayTaskWorkflowVerifierIndependence,
} from "../../../src/task-workflows/index.js";
import type {
  FridayTaskWorkflowContextPackage,
  FridayTaskWorkflowService,
} from "../../../src/task-workflows/index.js";

let tmpDir: string;
let db: ReturnType<typeof createFridaySqliteLayer>;
let nextId = 0;
let frozenNow = "2026-05-15T00:00:00.000Z";

function makeService(): FridayTaskWorkflowService {
  const repository = createFridayTaskWorkflowRepository();
  return createFridayTaskWorkflowService({
    db,
    repository,
    idGenerator: () => {
      nextId += 1;
      return `id-${nextId.toString(16).padStart(8, "0")}`;
    },
    nowIso: () => frozenNow,
  });
}

function makeContextPackage(
  overrides: Partial<FridayTaskWorkflowContextPackage> = {},
): FridayTaskWorkflowContextPackage {
  return {
    allowedFiles: ["src/agent/runtime/friday-agent-runtime.ts"],
    allowedTools: ["read"],
    allowedApis: [],
    boundaryIds: ["api.task_workflows.core"],
    ...overrides,
  };
}

function makeCreateInput(overrides: {
  charter?: string;
  taskKind?: string;
  risk?: "low" | "medium" | "high";
  contextPackage?: FridayTaskWorkflowContextPackage;
} = {}) {
  return {
    charter: overrides.charter ?? "lane policy slice",
    taskKind: overrides.taskKind ?? "general",
    risk: overrides.risk,
    contextPackage: overrides.contextPackage ?? makeContextPackage(),
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-tw-lanes-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  db = createFridaySqliteLayer({
    dbPath,
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
  nextId = 0;
  frozenNow = "2026-05-15T00:00:00.000Z";
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    // ok
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Phase 13.5B lane context snapshot hash", () => {
  it("computes a stable sha256 over allowed files / tools / apis / boundary refs", () => {
    const hash = computeFridayTaskWorkflowLaneContextSnapshotHash({
      contextPackage: {
        allowedFiles: ["a.ts", "b.ts"],
        allowedTools: ["read"],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
      boundaryRefs: ["api.task_workflows.core"],
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is order-independent across allowedFiles ordering", () => {
    const a = computeFridayTaskWorkflowLaneContextSnapshotHash({
      contextPackage: {
        allowedFiles: ["a.ts", "b.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: [],
      },
      boundaryRefs: [],
    });
    const b = computeFridayTaskWorkflowLaneContextSnapshotHash({
      contextPackage: {
        allowedFiles: ["b.ts", "a.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: [],
      },
      boundaryRefs: [],
    });
    expect(a).toBe(b);
  });

  it("differs when allowedFiles content differs", () => {
    const a = computeFridayTaskWorkflowLaneContextSnapshotHash({
      contextPackage: {
        allowedFiles: ["a.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: [],
      },
      boundaryRefs: [],
    });
    const b = computeFridayTaskWorkflowLaneContextSnapshotHash({
      contextPackage: {
        allowedFiles: ["b.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: [],
      },
      boundaryRefs: [],
    });
    expect(a).not.toBe(b);
  });
});

describe("Phase 13.5B independence resolution", () => {
  it("preserves degraded_unavailable verbatim", () => {
    expect(
      resolveFridayTaskWorkflowVerifierIndependence({
        verifierLaneRole: "native",
        verifierProviderId: null,
        parentLaneRole: "native",
        parentProviderId: null,
        independenceClaim: "degraded_unavailable",
      }),
    ).toBe("degraded_unavailable");
  });

  it("downgrades 'independent' to degraded_same_provider when role + provider match", () => {
    expect(
      resolveFridayTaskWorkflowVerifierIndependence({
        verifierLaneRole: "provider",
        verifierProviderId: "openai",
        parentLaneRole: "provider",
        parentProviderId: "openai",
        independenceClaim: "independent",
      }),
    ).toBe("degraded_same_provider");
  });

  it("keeps 'independent' when provider differs", () => {
    expect(
      resolveFridayTaskWorkflowVerifierIndependence({
        verifierLaneRole: "provider",
        verifierProviderId: "anthropic",
        parentLaneRole: "provider",
        parentProviderId: "openai",
        independenceClaim: "independent",
      }),
    ).toBe("independent");
  });

  it("keeps 'independent' when lane role differs (native vs provider)", () => {
    expect(
      resolveFridayTaskWorkflowVerifierIndependence({
        verifierLaneRole: "native",
        verifierProviderId: null,
        parentLaneRole: "provider",
        parentProviderId: "openai",
        independenceClaim: "independent",
      }),
    ).toBe("independent");
  });

  it("downgrades 'independent' to degraded_same_provider when same-role lanes both have null providers (no proven separation)", () => {
    expect(
      resolveFridayTaskWorkflowVerifierIndependence({
        verifierLaneRole: "native",
        verifierProviderId: null,
        parentLaneRole: "native",
        parentProviderId: null,
        independenceClaim: "independent",
      }),
    ).toBe("degraded_same_provider");
  });

  it("downgrades 'independent' to degraded_same_provider when same-role verifier provider is missing", () => {
    expect(
      resolveFridayTaskWorkflowVerifierIndependence({
        verifierLaneRole: "provider",
        verifierProviderId: null,
        parentLaneRole: "provider",
        parentProviderId: "openai",
        independenceClaim: "independent",
      }),
    ).toBe("degraded_same_provider");
  });

  it("downgrades 'independent' to degraded_same_provider when same-role executor provider is missing", () => {
    expect(
      resolveFridayTaskWorkflowVerifierIndependence({
        verifierLaneRole: "provider",
        verifierProviderId: "anthropic",
        parentLaneRole: "provider",
        parentProviderId: null,
        independenceClaim: "independent",
      }),
    ).toBe("degraded_same_provider");
  });
});

describe("Phase 13.5B executor lane lifecycle", () => {
  it("openExecutorLane records context snapshot hash and workflow spec_hash", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const lane = service.openExecutorLane(workflow.id, {
      laneRole: "native",
      providerId: "anthropic-claude-3",
    });
    expect(lane.laneKind).toBe("executor");
    expect(lane.laneRole).toBe("native");
    expect(lane.status).toBe("open");
    expect(lane.independence).toBe("not_applicable");
    expect(lane.parentLaneId).toBeNull();
    expect(lane.contextSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lane.contextSnapshotSpecHash).toBe(workflow.specHash);
    expect(lane.providerId).toBe("anthropic-claude-3");
    expect(lane.fallbackAvailability).toBeNull();
  });

  it("completeLane records executor run ref and fallback availability label", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const lane = service.openExecutorLane(workflow.id, {
      laneRole: "native",
    });
    frozenNow = "2026-05-15T00:01:00.000Z";
    const completed = service.completeLane(workflow.id, lane.id, {
      status: "completed",
      executorRunRef: "agent-run-abc",
      routeTraceRef: "trace-001",
      fallbackAvailability: "used_alternate_provider",
    });
    expect(completed.status).toBe("completed");
    expect(completed.executorRunRef).toBe("agent-run-abc");
    expect(completed.routeTraceRef).toBe("trace-001");
    expect(completed.fallbackAvailability).toBe("used_alternate_provider");
  });

  it("completeLane requires a blocker reason when transitioning to blocked", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const lane = service.openExecutorLane(workflow.id, {
      laneRole: "native",
    });
    try {
      service.completeLane(workflow.id, lane.id, {
        status: "blocked",
      });
      throw new Error("expected blocker refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("TASK_WORKFLOW_INVALID");
    }
  });

  it("rejects a second completion attempt", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const lane = service.openExecutorLane(workflow.id, { laneRole: "native" });
    service.completeLane(workflow.id, lane.id, { status: "completed" });
    try {
      service.completeLane(workflow.id, lane.id, { status: "completed" });
      throw new Error("expected closed refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("TASK_WORKFLOW_LANE_CLOSED");
    }
  });
});

describe("Phase 13.5B verifier lane lifecycle and independence", () => {
  function setupExecutorLane(
    risk: "low" | "medium" | "high",
    parentProvider: string | null = "openai",
  ) {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk }));
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "provider",
      providerId: parentProvider ?? undefined,
    });
    return { service, workflow, executorLane };
  }

  it("opens a verifier lane bound to the parent executor lane", () => {
    const { service, workflow, executorLane } = setupExecutorLane("medium", "openai");
    const verifierLane = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "provider",
      providerId: "anthropic",
      independenceClaim: "independent",
    });
    expect(verifierLane.laneKind).toBe("verifier");
    expect(verifierLane.parentLaneId).toBe(executorLane.id);
    expect(verifierLane.independence).toBe("independent");
  });

  it("downgrades independence to degraded_same_provider when verifier shares provider with executor", () => {
    const { service, workflow, executorLane } = setupExecutorLane("medium", "openai");
    const verifierLane = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "provider",
      providerId: "openai",
      independenceClaim: "independent",
    });
    expect(verifierLane.independence).toBe("degraded_same_provider");
  });

  it("refuses high-risk verifier lane when resolved independence is not 'independent'", () => {
    const { service, workflow, executorLane } = setupExecutorLane("high", "openai");
    try {
      service.openVerifierLane(workflow.id, {
        parentLaneId: executorLane.id,
        laneRole: "provider",
        providerId: "openai",
        independenceClaim: "independent",
      });
      throw new Error("expected independence refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_HIGH_RISK_VERIFIER_INDEPENDENCE_REQUIRED",
      );
    }
  });

  it("refuses high-risk degraded_unavailable verifier lane", () => {
    const { service, workflow, executorLane } = setupExecutorLane("high", "openai");
    try {
      service.openVerifierLane(workflow.id, {
        parentLaneId: executorLane.id,
        laneRole: "provider",
        providerId: "anthropic",
        independenceClaim: "degraded_unavailable",
      });
      throw new Error("expected independence refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_HIGH_RISK_VERIFIER_INDEPENDENCE_REQUIRED",
      );
    }
  });

  it("refuses high-risk same-role provider verifier when both providerIds are null (no proven separation)", () => {
    const { service, workflow, executorLane } = setupExecutorLane("high", null);
    try {
      service.openVerifierLane(workflow.id, {
        parentLaneId: executorLane.id,
        laneRole: "provider",
        independenceClaim: "independent",
      });
      throw new Error("expected independence refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_HIGH_RISK_VERIFIER_INDEPENDENCE_REQUIRED",
      );
    }
  });

  it("refuses high-risk same-role native verifier over a same-role native executor with null providers", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "high" }));
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "native",
    });
    try {
      service.openVerifierLane(workflow.id, {
        parentLaneId: executorLane.id,
        laneRole: "native",
        independenceClaim: "independent",
      });
      throw new Error("expected independence refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_HIGH_RISK_VERIFIER_INDEPENDENCE_REQUIRED",
      );
    }
  });

  it("downgrades to degraded_same_provider when medium-risk same-role native lanes share null providers", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "native",
    });
    const verifierLane = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "native",
      independenceClaim: "independent",
    });
    expect(verifierLane.independence).toBe("degraded_same_provider");
  });

  it("refuses high-risk same-role provider verifier when only one side carries a concrete provider id", () => {
    const { service, workflow, executorLane } = setupExecutorLane("high", "openai");
    try {
      service.openVerifierLane(workflow.id, {
        parentLaneId: executorLane.id,
        laneRole: "provider",
        independenceClaim: "independent",
      });
      throw new Error("expected independence refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_HIGH_RISK_VERIFIER_INDEPENDENCE_REQUIRED",
      );
    }
  });

  it("rejects verifier lane whose parentLaneId points at a verifier lane", () => {
    const { service, workflow, executorLane } = setupExecutorLane("medium");
    const v1 = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "native",
      independenceClaim: "independent",
    });
    try {
      service.openVerifierLane(workflow.id, {
        parentLaneId: v1.id,
        laneRole: "native",
        independenceClaim: "independent",
      });
      throw new Error("expected lane kind refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_LANE_KIND_INVALID",
      );
    }
  });
});

describe("Phase 13.5B verifier verdict path", () => {
  function setupVerifiableClaim(risk: "low" | "medium" | "high") {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "lane-based verification",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-lane-001",
      refSource: "agent_run_event",
    });
    return { service, workflow, claim };
  }

  it("verifyClaim without verifierLaneId still works for medium risk (backward compat)", () => {
    const { service, workflow, claim } = setupVerifiableClaim("medium");
    const verified = service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "fresh-read evt-lane-001",
    });
    expect(verified.status).toBe("verified");
    expect(verified.verifierLaneId).toBeNull();
  });

  it("verifyClaim refuses high-risk verification without verifierLaneId", () => {
    const { service, workflow, claim } = setupVerifiableClaim("high");
    try {
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "fresh-read without lane",
      });
      throw new Error("expected high-risk refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_HIGH_RISK_VERIFIER_LANE_REQUIRED",
      );
    }
  });

  it("submitVerifierVerdict records verifierLaneId on the claim", () => {
    const { service, workflow, claim } = setupVerifiableClaim("high");
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "provider",
      providerId: "openai",
    });
    const verifierLane = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "provider",
      providerId: "anthropic",
      independenceClaim: "independent",
    });
    const verified = service.submitVerifierVerdict(workflow.id, verifierLane.id, {
      claimId: claim.id,
      verifierVerdict: "anthropic verifier fresh-read evt-lane-001",
    });
    expect(verified.status).toBe("verified");
    expect(verified.verifierLaneId).toBe(verifierLane.id);
  });

  it("verifyClaim refuses verifierLaneId that points at an executor lane", () => {
    const { service, workflow, claim } = setupVerifiableClaim("medium");
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "native",
    });
    try {
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "executor lane masquerading as verifier",
        verifierLaneId: executorLane.id,
      });
      throw new Error("expected lane kind refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_LANE_KIND_INVALID",
      );
    }
  });

  it("verifyClaim refuses verifierLaneId from a different workflow", () => {
    const { service, workflow, claim } = setupVerifiableClaim("medium");
    const otherWorkflow = service.create(makeCreateInput({ charter: "other" }));
    const otherExecutor = service.openExecutorLane(otherWorkflow.id, {
      laneRole: "native",
    });
    const otherVerifier = service.openVerifierLane(otherWorkflow.id, {
      parentLaneId: otherExecutor.id,
      laneRole: "native",
      independenceClaim: "independent",
    });
    try {
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "cross-workflow lane attempt",
        verifierLaneId: otherVerifier.id,
      });
      throw new Error("expected cross-workflow refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_LANE_NOT_FOUND",
      );
    }
  });

  it("submitVerifierVerdict still refuses non-evidence claim kinds (docs_intent stays unverifiable)", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "high" }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "docs intent only",
      claimKind: "docs_intent",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "docs.start_here",
      refId: "START_HERE_PROMPT.md",
      refSource: "docs_intent_reference",
    });
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "provider",
      providerId: "openai",
    });
    const verifierLane = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "provider",
      providerId: "anthropic",
      independenceClaim: "independent",
    });
    try {
      service.submitVerifierVerdict(workflow.id, verifierLane.id, {
        claimId: claim.id,
        verifierVerdict: "lane-bearing fresh-read",
      });
      throw new Error("expected non-evidence kind refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLAIM_KIND_NOT_VERIFIABLE",
      );
    }
  });

  it("provider_fallback claim stays unverifiable even with an independent verifier lane", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "high" }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "fallback succeeded",
      claimKind: "provider_fallback",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "provider.trace",
      refId: "trace-fb-001",
      refSource: "provider_route_trace",
    });
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "provider",
      providerId: "openai",
    });
    const verifierLane = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "provider",
      providerId: "anthropic",
      independenceClaim: "independent",
    });
    try {
      service.submitVerifierVerdict(workflow.id, verifierLane.id, {
        claimId: claim.id,
        verifierVerdict: "independent lane says fallback worked",
      });
      throw new Error("expected fallback claim kind refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLAIM_KIND_NOT_VERIFIABLE",
      );
    }
  });
});

describe("Phase 13.5B closeout gate evaluators", () => {
  it("executor_lane_context_bound blocks when an executor lane's spec_hash drifts (revision after lane open)", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    service.openExecutorLane(workflow.id, { laneRole: "native" });
    frozenNow = "2026-05-15T01:00:00.000Z";
    service.revise(workflow.id, {
      charter: "revised charter forces new spec hash",
      reason: "scope reconciliation",
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.status).toBe("blocked");
    const laneGate = receipt.gateOutcomes.find(
      (g) => g.gateId === "executor_lane_context_bound",
    );
    expect(laneGate?.status).toBe("block");
    expect(laneGate?.required).toBe(true);
    expect(laneGate?.reason ?? "").toMatch(/drift|missing/i);
  });

  it("executor_lane_context_bound passes vacuously when no lanes exist (early-stage closeout)", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const receipt = service.closeout(workflow.id);
    const laneGate = receipt.gateOutcomes.find(
      (g) => g.gateId === "executor_lane_context_bound",
    );
    expect(laneGate?.status).toBe("pass");
  });

  it("independent_verifier_required blocks high-risk verified claims missing an independent lane (closeout sees defensive evaluator)", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "high" }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "high-risk slip",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-hr-001",
      refSource: "agent_run_event",
    });
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "provider",
      providerId: "openai",
    });
    const verifierLane = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "provider",
      providerId: "anthropic",
      independenceClaim: "independent",
    });
    service.submitVerifierVerdict(workflow.id, verifierLane.id, {
      claimId: claim.id,
      verifierVerdict: "anthropic fresh-read evt-hr-001",
    });
    // Force a same-provider downgrade after the fact via repository update,
    // simulating a slip into degraded independence at closeout time.
    db.withWriteTransaction((conn) => {
      const repository = createFridayTaskWorkflowRepository();
      const lane = repository.getLane(conn, verifierLane.id);
      if (!lane) throw new Error("lane missing");
      repository.updateLane(conn, {
        ...lane,
        independence: "degraded_same_provider",
        updatedAt: frozenNow,
      });
    });
    const receipt = service.closeout(workflow.id);
    const independenceGate = receipt.gateOutcomes.find(
      (g) => g.gateId === "independent_verifier_required",
    );
    expect(independenceGate?.status).toBe("block");
    expect(independenceGate?.required).toBe(false);
    expect(independenceGate?.reason ?? "").toMatch(/independence/i);
    expect(receipt.status).toBe("blocked");
    const matchingBlocker = receipt.blockers.find(
      (b) =>
        b.includes("independent_verifier_required") &&
        /independence/i.test(b),
    );
    expect(matchingBlocker).toBeDefined();
    expect(matchingBlocker).toMatch(/risk-mandatory gate/);
  });

  it("low/medium-risk closeouts do not require an independent verifier lane", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "low" }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "low-risk verified",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-low-001",
      refSource: "agent_run_event",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "single-lane fresh-read",
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.status).toBe("complete");
    const independenceGate = receipt.gateOutcomes.find(
      (g) => g.gateId === "independent_verifier_required",
    );
    // Optional gate is only in the plan for high-risk; for low-risk it is
    // not in the plan and therefore not in the outcomes.
    expect(independenceGate).toBeUndefined();
  });

});

describe("Phase 13.5B verifier independence rechecked at verdict time", () => {
  it("verifyClaim refuses high-risk verification when a previously-opened verifier lane is tampered to degraded_same_provider before verdict", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "high" }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "high-risk verdict guard",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-hr-guard-001",
      refSource: "agent_run_event",
    });
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "provider",
      providerId: "openai",
    });
    const verifierLane = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "provider",
      providerId: "anthropic",
      independenceClaim: "independent",
    });
    db.withWriteTransaction((conn) => {
      const repository = createFridayTaskWorkflowRepository();
      const lane = repository.getLane(conn, verifierLane.id);
      if (!lane) throw new Error("lane missing");
      repository.updateLane(conn, {
        ...lane,
        independence: "degraded_same_provider",
        updatedAt: frozenNow,
      });
    });
    try {
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "tampered lane attempt",
        verifierLaneId: verifierLane.id,
      });
      throw new Error("expected independence refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_HIGH_RISK_VERIFIER_INDEPENDENCE_REQUIRED",
      );
    }
    const stillUnverified = service.getClaim(workflow.id, claim.id);
    expect(stillUnverified.status).not.toBe("verified");
  });

  it("submitVerifierVerdict refuses high-risk verdict when the lane independence drifted to degraded_unavailable after open", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "high" }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "high-risk verdict-time guard",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-hr-guard-002",
      refSource: "agent_run_event",
    });
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "provider",
      providerId: "openai",
    });
    const verifierLane = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "provider",
      providerId: "anthropic",
      independenceClaim: "independent",
    });
    db.withWriteTransaction((conn) => {
      const repository = createFridayTaskWorkflowRepository();
      const lane = repository.getLane(conn, verifierLane.id);
      if (!lane) throw new Error("lane missing");
      repository.updateLane(conn, {
        ...lane,
        independence: "degraded_unavailable",
        updatedAt: frozenNow,
      });
    });
    try {
      service.submitVerifierVerdict(workflow.id, verifierLane.id, {
        claimId: claim.id,
        verifierVerdict: "lane unavailable but submitted anyway",
      });
      throw new Error("expected independence refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_HIGH_RISK_VERIFIER_INDEPENDENCE_REQUIRED",
      );
    }
    const stillUnverified = service.getClaim(workflow.id, claim.id);
    expect(stillUnverified.status).not.toBe("verified");
  });
});
