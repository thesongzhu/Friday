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

describe("Phase 13.5C CLI-shaped evidence ref refusal on evidence-bearing claims", () => {
  function setupDraftEvidenceClaim(
    claimKind:
      | "runtime_evidence"
      | "code_evidence"
      | "api_evidence"
      | "artifact_evidence",
  ) {
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const claim = service.draftClaim(workflow.id, {
      claimText: `claim of kind ${claimKind}`,
      claimKind,
    });
    return { service, workflow, claim };
  }

  it("attachEvidenceRef refuses cli.handoff refKind on a runtime_evidence claim (fail-closed)", () => {
    const { service, workflow, claim } = setupDraftEvidenceClaim("runtime_evidence");
    try {
      service.attachEvidenceRef(workflow.id, claim.id, {
        refKind: "cli.handoff",
        refId: "handoff-bypass-001",
        refSource: "manual_external",
      });
      throw new Error("expected CLI-shaped refKind refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLI_EVIDENCE_REF_REFUSED",
      );
    }
    // The claim must remain in `draft` with no evidence refs persisted —
    // no partial mutation when the guard fires.
    const stillDraft = service.getClaim(workflow.id, claim.id);
    expect(stillDraft.status).toBe("draft");
    expect(stillDraft.evidenceRefCount).toBe(0);
  });

  it("attachEvidenceRef refuses cli.codex refKind on a code_evidence claim", () => {
    const { service, workflow, claim } = setupDraftEvidenceClaim("code_evidence");
    try {
      service.attachEvidenceRef(workflow.id, claim.id, {
        refKind: "cli.codex",
        refId: "handoff-bypass-002",
        refSource: "manual_external",
      });
      throw new Error("expected CLI-shaped refKind refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLI_EVIDENCE_REF_REFUSED",
      );
    }
  });

  it("attachEvidenceRef refuses bare cli refKind on an api_evidence claim (case-insensitive)", () => {
    const { service, workflow, claim } = setupDraftEvidenceClaim("api_evidence");
    try {
      service.attachEvidenceRef(workflow.id, claim.id, {
        refKind: "CLI",
        refId: "handoff-bypass-003",
        refSource: "manual_external",
      });
      throw new Error("expected CLI-shaped refKind refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLI_EVIDENCE_REF_REFUSED",
      );
    }
  });

  it("attachEvidenceRef refuses cli.handoff refKind on an artifact_evidence claim", () => {
    const { service, workflow, claim } = setupDraftEvidenceClaim("artifact_evidence");
    try {
      service.attachEvidenceRef(workflow.id, claim.id, {
        refKind: "cli.handoff",
        refId: "handoff-bypass-004",
        refSource: "manual_external",
      });
      throw new Error("expected CLI-shaped refKind refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLI_EVIDENCE_REF_REFUSED",
      );
    }
  });

  it("verifyClaim refuses a runtime_evidence claim whose persisted ref is CLI-shaped (defense in depth)", () => {
    // Mirror the existing refSource defense-in-depth pattern: bypass the
    // attachEvidenceRef guard by writing a CLI-shaped evidence ref
    // directly through the repository, then prove verifyClaim still
    // refuses it.
    const { service, workflow, claim } = setupDraftEvidenceClaim("runtime_evidence");
    const repository = createFridayTaskWorkflowRepository();
    db.withWriteTransaction((conn) => {
      repository.insertEvidenceRef(conn, {
        id: "ref-cli-bypass-001",
        workflowId: workflow.id,
        claimId: claim.id,
        refKind: "cli.handoff",
        refId: "handoff-bypass-005",
        refHash: null,
        refSource: "manual_external",
        createdAt: frozenNow,
      });
      const stored = repository.getClaim(conn, claim.id);
      if (!stored) throw new Error("claim missing");
      repository.updateClaim(conn, {
        ...stored,
        status: "unverified",
        evidenceRefCount: stored.evidenceRefCount + 1,
        updatedAt: frozenNow,
      });
    });
    try {
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "cli says runtime evidence is fine",
      });
      throw new Error("expected CLI-shaped refKind refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLI_EVIDENCE_REF_REFUSED",
      );
    }
    const stillUnverified = service.getClaim(workflow.id, claim.id);
    expect(stillUnverified.status).not.toBe("verified");
  });

  it("submitVerifierVerdict refuses a CLI-shaped persisted ref via the verdict path", () => {
    // The Phase 13.5B verifier-verdict path also routes through
    // verifyClaim; the defense-in-depth guard must fire there too.
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "runtime evidence claim with smuggled cli ref",
      claimKind: "runtime_evidence",
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
    const repository = createFridayTaskWorkflowRepository();
    db.withWriteTransaction((conn) => {
      repository.insertEvidenceRef(conn, {
        id: "ref-cli-bypass-002",
        workflowId: workflow.id,
        claimId: claim.id,
        refKind: "cli.handoff",
        refId: "handoff-bypass-006",
        refHash: null,
        refSource: "manual_external",
        createdAt: frozenNow,
      });
      const stored = repository.getClaim(conn, claim.id);
      if (!stored) throw new Error("claim missing");
      repository.updateClaim(conn, {
        ...stored,
        status: "unverified",
        evidenceRefCount: stored.evidenceRefCount + 1,
        updatedAt: frozenNow,
      });
    });
    try {
      service.submitVerifierVerdict(workflow.id, providerVerifier.id, {
        claimId: claim.id,
        verifierVerdict: "anthropic fresh-read",
      });
      throw new Error("expected CLI-shaped refKind refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLI_EVIDENCE_REF_REFUSED",
      );
    }
  });

  it("preserves the natural cli_self_report ↔ cli.handoff pairing (still attaches; still non-verifiable by claim kind)", () => {
    // Sanity check that the new guard does NOT regress the legitimate
    // pairing where a CLI handoff trail is attached to a cli_self_report
    // claim. The claim continues to refuse verified via the existing
    // CLAIM_KIND_NOT_VERIFIABLE path, not the new refKind guard.
    const service = makeService();
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const claim = service.draftClaim(workflow.id, {
      claimText: "cli observed test pass",
      claimKind: "cli_self_report",
    });
    const { evidenceRef } = service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "cli.handoff",
      refId: "handoff-natural-001",
      refSource: "manual_external",
    });
    expect(evidenceRef.refKind).toBe("cli.handoff");
    const afterAttach = service.getClaim(workflow.id, claim.id);
    expect(afterAttach.status).toBe("unverified");
    try {
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "cli says ok",
      });
      throw new Error("expected non-verifiable claim kind refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLAIM_KIND_NOT_VERIFIABLE",
      );
    }
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
