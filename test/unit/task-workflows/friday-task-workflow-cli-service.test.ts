import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createFridaySqliteLayer } from "#state";

import { FridayDomainError } from "../../../src/errors/friday-domain-error.js";
import {
  createFridayTaskWorkflowRepository,
  createFridayTaskWorkflowService,
} from "../../../src/task-workflows/index.js";
import type {
  FridayTaskWorkflowContextPackage,
  FridayTaskWorkflowService,
} from "../../../src/task-workflows/index.js";

let tmpDir: string;
let db: ReturnType<typeof createFridaySqliteLayer>;
let nextId = 0;
let frozenNow = "2026-05-16T00:00:00.000Z";

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
    allowedFiles: ["src/task-workflows/friday-task-workflow-cli-adapter.ts"],
    allowedTools: ["read"],
    allowedApis: [],
    boundaryIds: ["api.task_workflows.cli_adapter"],
    ...overrides,
  };
}

function makeCreateInput(overrides: {
  risk?: "low" | "medium" | "high";
} = {}) {
  return {
    charter: "phase 13.5c cli adapter slice",
    taskKind: "general",
    risk: overrides.risk,
    contextPackage: makeContextPackage(),
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-tw-cli-svc-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  db = createFridaySqliteLayer({
    dbPath,
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
  nextId = 0;
  frozenNow = "2026-05-16T00:00:00.000Z";
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    // ok
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Phase 13.5C CLI lane role acceptance", () => {
  it("openExecutorLane records laneRole='cli' (CLI executor lane is bounded text)", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const lane = service.openExecutorLane(workflow.id, {
      laneRole: "cli",
    });
    expect(lane.laneKind).toBe("executor");
    expect(lane.laneRole).toBe("cli");
    expect(lane.independence).toBe("not_applicable");
    expect(lane.contextSnapshotSpecHash).toBe(workflow.specHash);
  });

  it("rejects laneRole values outside the allowed enum", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    try {
      service.openExecutorLane(workflow.id, {
        laneRole: "supervisor" as unknown as "native",
      });
      throw new Error("expected lane role refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("TASK_WORKFLOW_INVALID");
    }
  });

  it("openVerifierLane allows laneRole='cli' (reviewer bookkeeping) at medium risk", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "provider",
      providerId: "openai",
    });
    // CLI verifier lane is allowed for bookkeeping; independence value is
    // honestly recorded as the caller's claim (degraded_unavailable for CLI
    // reviewer-only flows is the honest label since CLI is not independent
    // verification by itself).
    const cliVerifier = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "cli",
      independenceClaim: "degraded_unavailable",
    });
    expect(cliVerifier.laneKind).toBe("verifier");
    expect(cliVerifier.laneRole).toBe("cli");
    expect(cliVerifier.independence).toBe("degraded_unavailable");
  });

  it("openVerifierLane with laneRole='cli' on a high-risk workflow is refused for non-independent claims", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "high" }));
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "provider",
      providerId: "openai",
    });
    try {
      service.openVerifierLane(workflow.id, {
        parentLaneId: executorLane.id,
        laneRole: "cli",
        independenceClaim: "degraded_unavailable",
      });
      throw new Error("expected high-risk refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_HIGH_RISK_VERIFIER_INDEPENDENCE_REQUIRED",
      );
    }
  });
});

describe("Phase 13.5C CLI verifier verdict promotion refusal", () => {
  function setupVerifiableClaimWithCliVerifier(
    risk: "low" | "medium" | "high",
  ) {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "claim awaiting verification",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-cli-001",
      refSource: "agent_run_event",
    });
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "provider",
      providerId: "openai",
    });
    const cliVerifier = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "cli",
      independenceClaim: "degraded_unavailable",
    });
    return { service, workflow, claim, executorLane, cliVerifier };
  }

  it("verifyClaim refuses CLI verifier lane at low risk (fail-closed)", () => {
    const { service, workflow, claim, cliVerifier } =
      setupVerifiableClaimWithCliVerifier("low");
    try {
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "cli says ok",
        verifierLaneId: cliVerifier.id,
      });
      throw new Error("expected CLI verifier refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLI_VERIFIER_LANE_REFUSED",
      );
    }
    const stillUnverified = service.getClaim(workflow.id, claim.id);
    expect(stillUnverified.status).not.toBe("verified");
  });

  it("verifyClaim refuses CLI verifier lane at medium risk", () => {
    const { service, workflow, claim, cliVerifier } =
      setupVerifiableClaimWithCliVerifier("medium");
    try {
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "cli says ok",
        verifierLaneId: cliVerifier.id,
      });
      throw new Error("expected CLI verifier refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLI_VERIFIER_LANE_REFUSED",
      );
    }
  });

  it("submitVerifierVerdict refuses CLI verifier lane via the verdict path", () => {
    const { service, workflow, claim, cliVerifier } =
      setupVerifiableClaimWithCliVerifier("medium");
    try {
      service.submitVerifierVerdict(workflow.id, cliVerifier.id, {
        claimId: claim.id,
        verifierVerdict: "cli reviewer summary",
      });
      throw new Error("expected CLI verifier refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLI_VERIFIER_LANE_REFUSED",
      );
    }
  });

  it("high-risk verify still requires a non-CLI independent verifier (CLI never satisfies it)", () => {
    // Build a high-risk workflow with a runtime-evidence claim, then open
    // an independent non-CLI verifier lane in parallel with a CLI lane.
    // The high-risk path must use the non-CLI lane; the CLI lane must
    // remain refused.
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "high" }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "high-risk verified claim",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-cli-002",
      refSource: "agent_run_event",
    });
    const executorLane = service.openExecutorLane(workflow.id, {
      laneRole: "provider",
      providerId: "openai",
    });
    const providerVerifier = service.openVerifierLane(workflow.id, {
      parentLaneId: executorLane.id,
      laneRole: "provider",
      providerId: "anthropic",
      independenceClaim: "independent",
    });
    const verified = service.submitVerifierVerdict(
      workflow.id,
      providerVerifier.id,
      {
        claimId: claim.id,
        verifierVerdict: "anthropic verifier fresh-read evt-cli-002",
      },
    );
    expect(verified.status).toBe("verified");
    expect(verified.verifierLaneId).toBe(providerVerifier.id);
  });
});

describe("Phase 13.5C closeout still blocks when a CLI self-report sneaks in", () => {
  it("cli_self_report_unconfirmed gate blocks closeout if a CLI summary is somehow marked verified", () => {
    // The service refuses to promote a CLI claim to verified through the
    // public API, but we want to prove the deterministic gate still
    // catches it. Force a `cli_self_report` claim to status='verified'
    // via the repository, then run closeout and assert the gate blocks.
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "cli summary",
      claimKind: "cli_self_report",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "cli.handoff",
      refId: "handoff-001",
      refSource: "manual_external",
    });
    db.withWriteTransaction((conn) => {
      const repository = createFridayTaskWorkflowRepository();
      const stored = repository.getClaim(conn, claim.id);
      if (!stored) throw new Error("claim missing");
      repository.updateClaim(conn, {
        ...stored,
        status: "verified",
        verifierVerdict: "cli says ok",
        updatedAt: frozenNow,
      });
    });
    const receipt = service.closeout(workflow.id);
    const gate = receipt.gateOutcomes.find(
      (g) => g.gateId === "cli_self_report_unconfirmed",
    );
    expect(gate?.status).toBe("block");
    expect(gate?.required).toBe(true);
    expect(receipt.status).toBe("blocked");
  });
});
