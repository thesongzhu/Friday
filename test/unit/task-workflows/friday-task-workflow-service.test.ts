import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createFridaySqliteLayer } from "#state";

import { FridayDomainError } from "../../../src/errors/friday-domain-error.js";
import {
  FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES,
  FRIDAY_TASK_WORKFLOW_REQUIRED_GATES,
  computeFridayTaskWorkflowSpecHash,
  createFridayTaskWorkflowRepository,
  createFridayTaskWorkflowService,
  isFridayRequiredGate,
  isFridayTaskWorkflowRefSourceCompatible,
  planFridayTaskWorkflowGates,
  validateFridayTaskWorkflowContextPackage,
} from "../../../src/task-workflows/index.js";
import type {
  FridayTaskWorkflowClaimKind,
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
    allowedTools: ["read", "edit"],
    allowedApis: [],
    boundaryIds: ["api.task_workflows.core"],
    ...overrides,
  };
}

function makeCreateInput(
  overrides: {
    charter?: string;
    taskKind?: string;
    risk?: "low" | "medium" | "high";
    supervisorMode?: "off" | "light" | "standard" | "strict";
    contextPackage?: FridayTaskWorkflowContextPackage;
    additionalGateIds?: readonly string[];
  } = {},
) {
  return {
    charter: overrides.charter ?? "draft a thin task workflow policy slice",
    taskKind: overrides.taskKind ?? "general",
    risk: overrides.risk,
    supervisorMode: overrides.supervisorMode,
    contextPackage: overrides.contextPackage ?? makeContextPackage(),
    additionalGateIds: overrides.additionalGateIds,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-tw-test-"));
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

describe("Phase 13.5A task workflow service", () => {
  describe("preview", () => {
    it("computes a deterministic spec hash and does not persist", () => {
      const service = makeService();
      const preview = service.preview(makeCreateInput());

      expect(preview.specHash).toMatch(/^[0-9a-f]{64}$/);
      expect(preview.gatePlan.map((g) => g.gateId).sort()).toEqual(
        expect.arrayContaining(
          FRIDAY_TASK_WORKFLOW_REQUIRED_GATES.map((g) => g.gateId),
        ),
      );
      // Preview does not persist anywhere.
      expect(service.list()).toHaveLength(0);
      const rows = db.withReadConnection((conn) =>
        conn
          .prepare("SELECT COUNT(*) AS count FROM task_workflows")
          .get() as { count: number },
      );
      expect(rows.count).toBe(0);

      const previewSame = service.preview(makeCreateInput());
      expect(previewSame.specHash).toBe(preview.specHash);
    });

    it("recomputes a different spec hash when charter changes", () => {
      const service = makeService();
      const a = service.preview(makeCreateInput({ charter: "alpha" }));
      const b = service.preview(makeCreateInput({ charter: "beta" }));
      expect(a.specHash).not.toBe(b.specHash);
    });
  });

  describe("create + revise lineage", () => {
    it("persists a workflow with charter, spec hash, and budget defaults", () => {
      const service = makeService();
      const created = service.create(makeCreateInput({ supervisorMode: "standard" }));
      expect(created.specHash).toMatch(/^[0-9a-f]{64}$/);
      expect(created.parentSpecHash).toBeNull();
      expect(created.budget).toBe(4);
      const fetched = service.get(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.specHash).toBe(created.specHash);
    });

    it("revising produces a new spec hash and preserves lineage", () => {
      const service = makeService();
      const created = service.create(makeCreateInput());
      frozenNow = "2026-05-15T01:00:00.000Z";
      const revised = service.revise(created.id, {
        charter: "revised charter for thin workflow policy",
        reason: "scope reconciliation",
      });
      expect(revised.workflow.specHash).not.toBe(created.specHash);
      expect(revised.workflow.parentSpecHash).toBe(created.specHash);
      expect(revised.workflow.stage).toBe("revised");
      const lineage = service.listRevisions(created.id);
      expect(lineage).toHaveLength(1);
      expect(lineage[0].specHash).toBe(revised.workflow.specHash);
      expect(lineage[0].parentSpecHash).toBe(created.specHash);
    });

    it("revision lineage chains parent_spec_hash even when charter is unchanged", () => {
      const service = makeService();
      const created = service.create(makeCreateInput());
      frozenNow = "2026-05-15T01:00:00.000Z";
      const revised = service.revise(created.id, {
        charter: created.charter,
        reason: "metadata-only revision",
      });
      // Even with unchanged charter, the new spec hash differs because the
      // parent_spec_hash component changed (lineage record).
      expect(revised.workflow.specHash).not.toBe(created.specHash);
      expect(revised.workflow.parentSpecHash).toBe(created.specHash);
    });
  });

  describe("required gate enforcement", () => {
    it("refuses any attempt to disable a required gate", () => {
      const service = makeService();
      try {
        service.create(
          makeCreateInput({
            additionalGateIds: ["!claim_evidence_required"],
          }),
        );
        throw new Error("expected required-gate refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        expect((error as FridayDomainError).code).toBe("REQUIRED_GATE_UNDISABLE_REFUSED");
        expect((error as FridayDomainError).httpStatus).toBe(400);
      }
    });

    it("planFridayTaskWorkflowGates always returns every required gate", () => {
      for (const mode of ["off", "light", "standard", "strict"] as const) {
        const plan = planFridayTaskWorkflowGates({
          risk: "low",
          supervisorMode: mode,
        });
        const requiredIds = FRIDAY_TASK_WORKFLOW_REQUIRED_GATES.map((g) => g.gateId);
        for (const id of requiredIds) {
          expect(plan.some((entry) => entry.gateId === id && entry.required)).toBe(true);
        }
      }
    });

    it("isFridayRequiredGate identifies the built-in required gates", () => {
      expect(isFridayRequiredGate("claim_evidence_required")).toBe(true);
      expect(isFridayRequiredGate("verifier_fresh_read")).toBe(true);
      expect(isFridayRequiredGate("independent_verifier_required")).toBe(false);
      expect(isFridayRequiredGate("unknown_gate")).toBe(false);
    });
  });

  describe("context package refuses whole-repo", () => {
    function expectCode(run: () => unknown, code: string): void {
      try {
        run();
        throw new Error(`expected refusal with code ${code}`);
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        expect((error as FridayDomainError).code).toBe(code);
      }
    }

    it("rejects `**` in allowedFiles with CONTEXT_PACKAGE_WHOLE_REPO_REFUSED", () => {
      expectCode(
        () =>
          validateFridayTaskWorkflowContextPackage({
            allowedFiles: ["**"],
            allowedTools: [],
            allowedApis: [],
            boundaryIds: [],
          }),
        "CONTEXT_PACKAGE_WHOLE_REPO_REFUSED",
      );
    });

    it("rejects equivalent sentinels", () => {
      for (const sentinel of ["src/**", "*", "./**", "**/*"]) {
        expectCode(
          () =>
            validateFridayTaskWorkflowContextPackage({
              allowedFiles: [sentinel],
              allowedTools: [],
              allowedApis: [],
              boundaryIds: [],
            }),
          "CONTEXT_PACKAGE_WHOLE_REPO_REFUSED",
        );
      }
    });

    it("requires at least one enumerated allowed file", () => {
      expectCode(
        () =>
          validateFridayTaskWorkflowContextPackage({
            allowedFiles: [],
            allowedTools: [],
            allowedApis: [],
            boundaryIds: [],
          }),
        "CONTEXT_PACKAGE_INVALID",
      );
    });

    it("rejects unknown boundary ids", () => {
      expectCode(
        () =>
          validateFridayTaskWorkflowContextPackage({
            allowedFiles: ["src/agent/runtime/friday-agent-runtime.ts"],
            allowedTools: [],
            allowedApis: [],
            boundaryIds: ["unknown.boundary"],
          }),
        "CONTEXT_PACKAGE_INVALID",
      );
    });
  });

  describe("claim matrix enforcement", () => {
    function setupWithDraftClaim(claimKind: FridayTaskWorkflowClaimKind) {
      const service = makeService();
      const workflow = service.create(makeCreateInput());
      const claim = service.draftClaim(workflow.id, {
        claimText: "the verifier verdict and evidence ref guard works",
        claimKind,
      });
      return { service, workflow, claim };
    }

    function expectDomainError(
      run: () => unknown,
      expectedCode: string,
    ): FridayDomainError {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        const domain = error as FridayDomainError;
        expect(domain.code).toBe(expectedCode);
        return domain;
      }
      throw new Error(`expected FridayDomainError with code ${expectedCode}`);
    }

    it("docs_intent cannot reach verified status", () => {
      const { service, workflow, claim } = setupWithDraftClaim("docs_intent");
      service.attachEvidenceRef(workflow.id, claim.id, {
        refKind: "docs.start_here",
        refId: "START_HERE_PROMPT.md",
        refSource: "docs_intent_reference",
      });
      expectDomainError(
        () =>
          service.verifyClaim(workflow.id, claim.id, {
            verifierVerdict: "fresh-read confirms behavior",
          }),
        "TASK_WORKFLOW_CLAIM_KIND_NOT_VERIFIABLE",
      );
    });

    it("summary_replay cannot reach verified status", () => {
      const { service, workflow, claim } = setupWithDraftClaim("summary_replay");
      service.attachEvidenceRef(workflow.id, claim.id, {
        refKind: "context.replay",
        refId: "replay-001",
        refSource: "context_replay",
      });
      expectDomainError(
        () =>
          service.verifyClaim(workflow.id, claim.id, {
            verifierVerdict: "replay matches",
          }),
        "TASK_WORKFLOW_CLAIM_KIND_NOT_VERIFIABLE",
      );
    });

    it("cli_self_report cannot reach verified status", () => {
      const { service, workflow, claim } = setupWithDraftClaim("cli_self_report");
      service.attachEvidenceRef(workflow.id, claim.id, {
        refKind: "cli.codex",
        refId: "cli-001",
        refSource: "manual_external",
      });
      expectDomainError(
        () =>
          service.verifyClaim(workflow.id, claim.id, {
            verifierVerdict: "cli says ok",
          }),
        "TASK_WORKFLOW_CLAIM_KIND_NOT_VERIFIABLE",
      );
    });

    it("provider_fallback is availability only, not audit", () => {
      const { service, workflow, claim } = setupWithDraftClaim("provider_fallback");
      service.attachEvidenceRef(workflow.id, claim.id, {
        refKind: "provider.trace",
        refId: "trace-001",
        refSource: "provider_route_trace",
      });
      expectDomainError(
        () =>
          service.verifyClaim(workflow.id, claim.id, {
            verifierVerdict: "fallback succeeded",
          }),
        "TASK_WORKFLOW_CLAIM_KIND_NOT_VERIFIABLE",
      );
    });

    it("verified status requires at least one evidence ref", () => {
      const { service, workflow, claim } = setupWithDraftClaim("runtime_evidence");
      expectDomainError(
        () =>
          service.verifyClaim(workflow.id, claim.id, {
            verifierVerdict: "no evidence yet",
          }),
        "TASK_WORKFLOW_CLAIM_EVIDENCE_REQUIRED",
      );
    });

    it("runtime_evidence + evidence ref + verifier verdict reaches verified", () => {
      const { service, workflow, claim } = setupWithDraftClaim("runtime_evidence");
      const { claim: afterAttach } = service.attachEvidenceRef(workflow.id, claim.id, {
        refKind: "agent_run.event",
        refId: "evt-001",
        refSource: "agent_run_event",
        refHash: "sha256:test",
      });
      expect(afterAttach.status).toBe("unverified");
      const verified = service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "verifier fresh-read evt-001",
      });
      expect(verified.status).toBe("verified");
      expect(verified.verifierVerdict).toBe("verifier fresh-read evt-001");
    });

    it("blockClaim sets status=blocked and reason", () => {
      const { service, workflow, claim } = setupWithDraftClaim("runtime_evidence");
      const blocked = service.blockClaim(workflow.id, claim.id, {
        reason: "evidence missing",
      });
      expect(blocked.status).toBe("blocked");
      expect(blocked.reason).toBe("evidence missing");
    });
  });

  describe("closeout receipt", () => {
    it("produces complete when all claims are verified", () => {
      const service = makeService();
      const workflow = service.create(makeCreateInput());
      const claim = service.draftClaim(workflow.id, {
        claimText: "thin slice landed",
        claimKind: "code_evidence",
      });
      service.attachEvidenceRef(workflow.id, claim.id, {
        refKind: "code.commit",
        refId: "abc123",
        refSource: "manual_external",
      });
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "verifier fresh-read code",
      });
      const receipt = service.closeout(workflow.id);
      expect(receipt.status).toBe("complete");
      expect(receipt.claimSummary.verified).toBe(1);
      expect(receipt.blockers).toHaveLength(0);
    });

    it("produces partial when claims remain unverified", () => {
      const service = makeService();
      const workflow = service.create(makeCreateInput());
      service.draftClaim(workflow.id, {
        claimText: "open claim",
        claimKind: "runtime_evidence",
      });
      const receipt = service.closeout(workflow.id);
      expect(receipt.status).toBe("partial");
      expect(receipt.blockers.join(" ")).toMatch(/not verified/);
    });

    it("produces blocked when any claim is blocked", () => {
      const service = makeService();
      const workflow = service.create(makeCreateInput());
      const claim = service.draftClaim(workflow.id, {
        claimText: "open claim",
        claimKind: "runtime_evidence",
      });
      service.blockClaim(workflow.id, claim.id, { reason: "external dep" });
      const receipt = service.closeout(workflow.id);
      expect(receipt.status).toBe("blocked");
    });
  });

  describe("/v1/agent/runs non-pollution", () => {
    it("never inserts into agent_runs / agent_run_events when creating/reading/closing a workflow", () => {
      const service = makeService();
      const workflow = service.create(makeCreateInput());
      const claim = service.draftClaim(workflow.id, {
        claimText: "no pollution",
        claimKind: "runtime_evidence",
      });
      service.attachEvidenceRef(workflow.id, claim.id, {
        refKind: "agent_run.event",
        refId: "evt-001",
        refSource: "agent_run_event",
      });
      service.closeout(workflow.id);

      const rows = db.withReadConnection((conn) => {
        const agentRuns = conn
          .prepare("SELECT COUNT(*) AS count FROM friday_agent_runs")
          .get() as { count: number };
        const agentRunEvents = conn
          .prepare("SELECT COUNT(*) AS count FROM friday_agent_run_events")
          .get() as { count: number };
        return { agentRuns: agentRuns.count, agentRunEvents: agentRunEvents.count };
      });
      expect(rows.agentRuns).toBe(0);
      expect(rows.agentRunEvents).toBe(0);
    });
  });

  describe("spec hash determinism", () => {
    it("is order-independent for allowedFiles", () => {
      const a = computeFridayTaskWorkflowSpecHash({
        charter: "x",
        taskKind: "general",
        risk: "low",
        supervisorMode: "standard",
        contextPackage: {
          allowedFiles: ["a.ts", "b.ts"],
          allowedTools: [],
          allowedApis: [],
          boundaryIds: [],
        },
        gatePlan: [],
        boundaryRefs: [],
      });
      const b = computeFridayTaskWorkflowSpecHash({
        charter: "x",
        taskKind: "general",
        risk: "low",
        supervisorMode: "standard",
        contextPackage: {
          allowedFiles: ["b.ts", "a.ts"],
          allowedTools: [],
          allowedApis: [],
          boundaryIds: [],
        },
        gatePlan: [],
        boundaryRefs: [],
      });
      expect(a).toBe(b);
    });

    it("changes when parentSpecHash changes (lineage)", () => {
      const a = computeFridayTaskWorkflowSpecHash({
        charter: "x",
        taskKind: "general",
        risk: "low",
        supervisorMode: "standard",
        contextPackage: {
          allowedFiles: ["a.ts"],
          allowedTools: [],
          allowedApis: [],
          boundaryIds: [],
        },
        gatePlan: [],
        boundaryRefs: [],
      });
      const b = computeFridayTaskWorkflowSpecHash({
        charter: "x",
        taskKind: "general",
        risk: "low",
        supervisorMode: "standard",
        contextPackage: {
          allowedFiles: ["a.ts"],
          allowedTools: [],
          allowedApis: [],
          boundaryIds: [],
        },
        gatePlan: [],
        boundaryRefs: [],
        parentSpecHash: a,
      });
      expect(a).not.toBe(b);
    });
  });

  describe("docs intent reference is not verifier evidence", () => {
    it("rejects attaching a docs_intent_reference to a runtime_evidence claim", () => {
      const service = makeService();
      const workflow = service.create(makeCreateInput());
      const claim = service.draftClaim(workflow.id, {
        claimText: "docs intent only",
        claimKind: "runtime_evidence",
      });
      try {
        service.attachEvidenceRef(workflow.id, claim.id, {
          refKind: "docs.start_here",
          refId: "START_HERE_PROMPT.md",
          refSource: "docs_intent_reference",
        });
        throw new Error("expected refsource incompatibility refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        const domain = error as FridayDomainError;
        expect(domain.code).toBe("TASK_WORKFLOW_EVIDENCE_REFSOURCE_INCOMPATIBLE");
        expect(domain.httpStatus).toBe(400);
        expect(domain.details.claimKind).toBe("runtime_evidence");
        expect(domain.details.refSource).toBe("docs_intent_reference");
      }
      // The claim remains in draft (no successful attach).
      const after = service.getClaim(workflow.id, claim.id);
      expect(after.status).toBe("draft");
      expect(after.evidenceRefCount).toBe(0);
    });

    it("allows attaching a docs_intent_reference to a docs_intent claim", () => {
      const service = makeService();
      const workflow = service.create(makeCreateInput());
      const claim = service.draftClaim(workflow.id, {
        claimText: "docs intent only",
        claimKind: "docs_intent",
      });
      const { evidenceRef, claim: afterAttach } = service.attachEvidenceRef(
        workflow.id,
        claim.id,
        {
          refKind: "docs.start_here",
          refId: "START_HERE_PROMPT.md",
          refSource: "docs_intent_reference",
        },
      );
      expect(evidenceRef.refSource).toBe("docs_intent_reference");
      expect(afterAttach.status).toBe("unverified");
    });
  });
});

describe("Phase 13.5A FridayDomainError shape", () => {
  it("REQUIRED_GATE_UNDISABLE_REFUSED carries HTTP 400", () => {
    const service = makeService();
    try {
      service.create(
        makeCreateInput({ additionalGateIds: ["!claim_evidence_required"] }),
      );
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domain = error as FridayDomainError;
      expect(domain.code).toBe("REQUIRED_GATE_UNDISABLE_REFUSED");
      expect(domain.httpStatus).toBe(400);
    }
  });
});

describe("Phase 13.5A B.2.1 claimKind x refSource compatibility", () => {
  function expectIncompat(
    run: () => unknown,
    expectedCode: string,
    expectedClaimKind: string,
    expectedRefSource?: string,
  ): FridayDomainError {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domain = error as FridayDomainError;
      expect(domain.code).toBe(expectedCode);
      expect(domain.httpStatus).toBe(400);
      expect(domain.details.claimKind).toBe(expectedClaimKind);
      if (expectedRefSource !== undefined) {
        expect(domain.details.refSource).toBe(expectedRefSource);
      }
      return domain;
    }
    throw new Error(`expected FridayDomainError with code ${expectedCode}`);
  }

  it("runtime_evidence + docs_intent_reference is rejected at attach", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "runtime claim",
      claimKind: "runtime_evidence",
    });
    expectIncompat(
      () =>
        service.attachEvidenceRef(workflow.id, claim.id, {
          refKind: "docs.start_here",
          refId: "START_HERE_PROMPT.md",
          refSource: "docs_intent_reference",
        }),
      "TASK_WORKFLOW_EVIDENCE_REFSOURCE_INCOMPATIBLE",
      "runtime_evidence",
      "docs_intent_reference",
    );
  });

  it("runtime_evidence + context_replay is rejected at attach", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "runtime claim with replay",
      claimKind: "runtime_evidence",
    });
    expectIncompat(
      () =>
        service.attachEvidenceRef(workflow.id, claim.id, {
          refKind: "context.replay",
          refId: "replay-001",
          refSource: "context_replay",
        }),
      "TASK_WORKFLOW_EVIDENCE_REFSOURCE_INCOMPATIBLE",
      "runtime_evidence",
      "context_replay",
    );
  });

  it("api_evidence + provider_route_trace is rejected at attach", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "api claim",
      claimKind: "api_evidence",
    });
    expectIncompat(
      () =>
        service.attachEvidenceRef(workflow.id, claim.id, {
          refKind: "provider.trace",
          refId: "trace-001",
          refSource: "provider_route_trace",
        }),
      "TASK_WORKFLOW_EVIDENCE_REFSOURCE_INCOMPATIBLE",
      "api_evidence",
      "provider_route_trace",
    );
  });

  it("code_evidence + provider_route_trace is rejected at attach", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "code claim",
      claimKind: "code_evidence",
    });
    expectIncompat(
      () =>
        service.attachEvidenceRef(workflow.id, claim.id, {
          refKind: "provider.trace",
          refId: "trace-002",
          refSource: "provider_route_trace",
        }),
      "TASK_WORKFLOW_EVIDENCE_REFSOURCE_INCOMPATIBLE",
      "code_evidence",
      "provider_route_trace",
    );
  });

  it("runtime_evidence with allowed agent_run_event reaches unverified then verified with verdict", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "real runtime check",
      claimKind: "runtime_evidence",
    });
    const { claim: afterAttach } = service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-allowed",
      refSource: "agent_run_event",
      refHash: "sha256:allowed",
    });
    expect(afterAttach.status).toBe("unverified");
    const verified = service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "fresh-read of agent_run_event evt-allowed",
    });
    expect(verified.status).toBe("verified");
    expect(verified.verifierVerdict).toBe(
      "fresh-read of agent_run_event evt-allowed",
    );
  });

  it("verifyClaim refuses TASK_WORKFLOW_CLAIM_REFSOURCE_INCOMPATIBLE if existing refs are incompatible (direct DB bypass)", () => {
    const repository = createFridayTaskWorkflowRepository();
    const service = createFridayTaskWorkflowService({
      db,
      repository,
      idGenerator: () => {
        nextId += 1;
        return `id-${nextId.toString(16).padStart(8, "0")}`;
      },
      nowIso: () => frozenNow,
    });
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "bypass attempt",
      claimKind: "runtime_evidence",
    });
    // Bypass the service's attach guard and insert an incompatible ref
    // directly via the repository. This mirrors how a docs-intent slip
    // could happen if a future caller skips the service layer.
    db.withWriteTransaction((conn) => {
      repository.insertEvidenceRef(conn, {
        id: "bypass-ref-1",
        workflowId: workflow.id,
        claimId: claim.id,
        refKind: "docs.start_here",
        refId: "START_HERE_PROMPT.md",
        refHash: null,
        refSource: "docs_intent_reference",
        createdAt: frozenNow,
      });
      repository.incrementEvidenceRefCount(conn, claim.id, frozenNow);
    });
    try {
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "trying to verify with incompatible ref",
      });
      throw new Error("expected refsource incompatibility refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domain = error as FridayDomainError;
      expect(domain.code).toBe("TASK_WORKFLOW_CLAIM_REFSOURCE_INCOMPATIBLE");
      expect(domain.httpStatus).toBe(400);
      expect(domain.details.claimKind).toBe("runtime_evidence");
      expect(Array.isArray(domain.details.offendingRefSources)).toBe(true);
      expect((domain.details.offendingRefSources as string[])[0]).toBe(
        "docs_intent_reference",
      );
    }
  });

  it("isFridayTaskWorkflowRefSourceCompatible matches the policy matrix", () => {
    // Evidence kinds reject docs/replay/provider_route_trace
    expect(
      isFridayTaskWorkflowRefSourceCompatible(
        "runtime_evidence",
        "docs_intent_reference",
      ),
    ).toBe(false);
    expect(
      isFridayTaskWorkflowRefSourceCompatible(
        "runtime_evidence",
        "context_replay",
      ),
    ).toBe(false);
    expect(
      isFridayTaskWorkflowRefSourceCompatible(
        "api_evidence",
        "provider_route_trace",
      ),
    ).toBe(false);
    // Evidence kinds accept their natural sources
    expect(
      isFridayTaskWorkflowRefSourceCompatible(
        "runtime_evidence",
        "agent_run_event",
      ),
    ).toBe(true);
    expect(
      isFridayTaskWorkflowRefSourceCompatible(
        "code_evidence",
        "workflow_run_evidence",
      ),
    ).toBe(true);
    // Non-evidence kinds accept their natural ref source
    expect(
      isFridayTaskWorkflowRefSourceCompatible(
        "summary_replay",
        "context_replay",
      ),
    ).toBe(true);
    expect(
      isFridayTaskWorkflowRefSourceCompatible(
        "provider_fallback",
        "provider_route_trace",
      ),
    ).toBe(true);
  });
});

describe("Phase 13.5A B.2.1 hardBoundaries reflect proof limits", () => {
  it("core API surface advertises the docs/replay/provider hard boundaries", () => {
    const core = FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES.find(
      (b) => b.boundaryId === "api.task_workflows.core",
    );
    expect(core).toBeDefined();
    expect(core!.hardBoundaries).toContain(
      "no_runtime_evidence_with_docs_intent_reference",
    );
    expect(core!.hardBoundaries).toContain(
      "no_runtime_evidence_with_context_replay",
    );
    expect(core!.hardBoundaries).toContain(
      "no_api_evidence_with_provider_route_trace",
    );
    expect(core!.hardBoundaries).toContain(
      "no_code_evidence_with_provider_route_trace",
    );
    expect(core!.hardBoundaries).toContain(
      "no_artifact_evidence_with_provider_route_trace",
    );
  });

  it("provider_route_trace boundary advertises the provider-not-audit hard boundaries", () => {
    const boundary = FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES.find(
      (b) => b.boundaryId === "evidence.refs.provider_route_trace",
    );
    expect(boundary).toBeDefined();
    expect(boundary!.hardBoundaries).toContain(
      "no_api_evidence_with_provider_route_trace",
    );
    expect(boundary!.hardBoundaries).toContain(
      "no_code_evidence_with_provider_route_trace",
    );
  });

  it("context_replay boundary advertises no_evidence_claim_with_context_replay", () => {
    const boundary = FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES.find(
      (b) => b.boundaryId === "evidence.refs.context_replay",
    );
    expect(boundary).toBeDefined();
    expect(boundary!.hardBoundaries).toContain(
      "no_evidence_claim_with_context_replay",
    );
  });

  it("docs_intent boundary exposes no_evidence_claim_with_docs_intent_reference", () => {
    const boundary = FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES.find(
      (b) => b.boundaryId === "evidence.refs.docs_intent",
    );
    expect(boundary).toBeDefined();
    expect(boundary!.hardBoundaries).toContain("no_docs_intent_as_proof");
    expect(boundary!.hardBoundaries).toContain(
      "no_evidence_claim_with_docs_intent_reference",
    );
  });
});

describe("Phase 13.5A B.2.2 closeout gate outcomes", () => {
  function setupServiceWithRepository() {
    const repository = createFridayTaskWorkflowRepository();
    const service = createFridayTaskWorkflowService({
      db,
      repository,
      idGenerator: () => {
        nextId += 1;
        return `id-${nextId.toString(16).padStart(8, "0")}`;
      },
      nowIso: () => frozenNow,
    });
    return { repository, service };
  }

  it("closeout emits per-gate outcomes for every required gate", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "verified slice",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-200",
      refSource: "agent_run_event",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "verifier fresh-read evt-200",
    });
    const receipt = service.closeout(workflow.id);
    const requiredIds = FRIDAY_TASK_WORKFLOW_REQUIRED_GATES.map((g) => g.gateId);
    const seenIds = receipt.gateOutcomes.map((g) => g.gateId);
    for (const id of requiredIds) {
      expect(seenIds).toContain(id);
    }
    const requiredOutcomes = receipt.gateOutcomes.filter((g) => g.required);
    expect(requiredOutcomes.length).toBeGreaterThan(0);
    for (const outcome of requiredOutcomes) {
      expect(outcome.status === "pass" || outcome.status === "block").toBe(true);
      expect(outcome.status).not.toBe("not_applicable");
    }
  });

  it("all required gates pass when a runtime_evidence claim is verified with allowed ref", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "all required gates path",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-300",
      refSource: "agent_run_event",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "fresh-read evt-300",
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.status).toBe("complete");
    const blockingRequired = receipt.gateOutcomes.filter(
      (g) => g.required && g.status === "block",
    );
    expect(blockingRequired).toHaveLength(0);
  });

  it("closeout blocks when a verified claim is missing its verifier verdict (direct DB bypass)", () => {
    const { repository, service } = setupServiceWithRepository();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "verdict missing slip",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-400",
      refSource: "agent_run_event",
    });
    // Bypass service.verifyClaim guard to force a verified claim with no verdict.
    db.withWriteTransaction((conn) => {
      const fetched = repository.getClaim(conn, claim.id);
      if (!fetched) throw new Error("claim not found");
      repository.updateClaim(conn, {
        ...fetched,
        status: "verified",
        verifierVerdict: null,
        updatedAt: frozenNow,
      });
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.status).toBe("blocked");
    const verifierGate = receipt.gateOutcomes.find(
      (g) => g.gateId === "verifier_fresh_read",
    );
    expect(verifierGate?.status).toBe("block");
    expect(verifierGate?.reason ?? "").toMatch(/missing verifier verdict/i);
  });

  it("closeout blocks via docs-intent slip guard when a verified claim has a docs_intent_reference ref", () => {
    const { repository, service } = setupServiceWithRepository();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "docs-intent slip via repo bypass",
      claimKind: "runtime_evidence",
    });
    // Insert a compatible ref so verifyClaim can succeed via service:
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-clean",
      refSource: "agent_run_event",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "verified by service",
    });
    // Then sneak in an incompatible docs_intent_reference ref via the
    // repository. Closeout must see this and block on docs_intent_not_proof.
    db.withWriteTransaction((conn) => {
      repository.insertEvidenceRef(conn, {
        id: "slip-ref-1",
        workflowId: workflow.id,
        claimId: claim.id,
        refKind: "docs.start_here",
        refId: "START_HERE_PROMPT.md",
        refHash: null,
        refSource: "docs_intent_reference",
        createdAt: frozenNow,
      });
      repository.incrementEvidenceRefCount(conn, claim.id, frozenNow);
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.status).toBe("blocked");
    const docsGate = receipt.gateOutcomes.find(
      (g) => g.gateId === "docs_intent_not_proof",
    );
    expect(docsGate?.status).toBe("block");
    expect(docsGate?.required).toBe(true);
  });

  it("Light mode evaluates required gates the same way Standard does", () => {
    const service = makeService();
    const workflow = service.create(
      makeCreateInput({ supervisorMode: "light" }),
    );
    const claim = service.draftClaim(workflow.id, {
      claimText: "light mode required gate evaluation",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-light",
      refSource: "agent_run_event",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "light-mode verifier fresh-read",
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.status).toBe("complete");
    const requiredIds = FRIDAY_TASK_WORKFLOW_REQUIRED_GATES.map((g) => g.gateId);
    for (const id of requiredIds) {
      const outcome = receipt.gateOutcomes.find((g) => g.gateId === id);
      expect(outcome).toBeDefined();
      expect(outcome!.required).toBe(true);
      expect(outcome!.status === "pass" || outcome!.status === "block").toBe(true);
      expect(outcome!.status).not.toBe("not_applicable");
    }
  });

  it("Light mode required-gate outcomes still block on bypassed evidence (no silent skip)", () => {
    const { repository, service } = setupServiceWithRepository();
    const workflow = service.create(
      makeCreateInput({ supervisorMode: "light" }),
    );
    const claim = service.draftClaim(workflow.id, {
      claimText: "light slip via repo bypass",
      claimKind: "runtime_evidence",
    });
    // Force a verified claim with evidence_ref_count=0 — claim_evidence_required
    // gate must block, even in Light mode.
    db.withWriteTransaction((conn) => {
      const fetched = repository.getClaim(conn, claim.id);
      if (!fetched) throw new Error("claim not found");
      repository.updateClaim(conn, {
        ...fetched,
        status: "verified",
        verifierVerdict: "no refs but verified",
        evidenceRefCount: 0,
        updatedAt: frozenNow,
      });
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.status).toBe("blocked");
    const gate = receipt.gateOutcomes.find(
      (g) => g.gateId === "claim_evidence_required",
    );
    expect(gate?.status).toBe("block");
    expect(gate?.required).toBe(true);
  });

  it("persists gate_outcomes_json and reads it back via getLatestCloseoutReceipt", () => {
    const { repository, service } = setupServiceWithRepository();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "persisted gate outcomes",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-persist",
      refSource: "agent_run_event",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "fresh-read persist",
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.gateOutcomes.length).toBeGreaterThan(0);
    const reloaded = db.withReadConnection((conn) =>
      repository.getLatestCloseoutReceipt(conn, workflow.id),
    );
    expect(reloaded).not.toBeNull();
    expect(reloaded!.gateOutcomes.length).toBe(receipt.gateOutcomes.length);
    // Same gateIds round-trip via SQLite JSON column.
    const persistedIds = reloaded!.gateOutcomes.map((g) => g.gateId).sort();
    const expectedIds = receipt.gateOutcomes.map((g) => g.gateId).sort();
    expect(persistedIds).toEqual(expectedIds);
  });
});

describe("Phase 14.5C module_28c — workflow evidence fail-closed", () => {
  function makeServiceWithEvidenceStatus(
    statusByRunId: Map<string, "available" | "degraded" | "unavailable">,
  ): FridayTaskWorkflowService {
    const repository = createFridayTaskWorkflowRepository();
    return createFridayTaskWorkflowService({
      db,
      repository,
      idGenerator: () => {
        nextId += 1;
        return `id-${nextId.toString(16).padStart(8, "0")}`;
      },
      nowIso: () => frozenNow,
      getWorkflowRunEvidenceStatus: (runId) => statusByRunId.get(runId) ?? null,
    });
  }

  it("verifyClaim refuses workflow_run_evidence-sourced ref from degraded run", () => {
    const statusByRunId = new Map<string, "available" | "degraded" | "unavailable">([
      ["run-degraded", "degraded"],
    ]);
    const service = makeServiceWithEvidenceStatus(statusByRunId);
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "workflow run evidence from degraded run",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "workflow_run_evidence",
      refId: "run-degraded",
      refSource: "workflow_run_evidence",
    });
    expect(() =>
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "should refuse",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_EVIDENCE_UNAVAILABLE",
        httpStatus: 409,
      }) as unknown as Error,
    );
  });

  it("verifyClaim refuses workflow_run_evidence-sourced ref from unavailable run", () => {
    const statusByRunId = new Map<string, "available" | "degraded" | "unavailable">([
      ["run-unavail", "unavailable"],
    ]);
    const service = makeServiceWithEvidenceStatus(statusByRunId);
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "workflow run evidence from unavailable run",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "workflow_run_evidence",
      refId: "run-unavail",
      refSource: "workflow_run_evidence",
    });
    expect(() =>
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "should refuse",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_EVIDENCE_UNAVAILABLE",
      }) as unknown as Error,
    );
  });

  it("verifyClaim refuses workflow_run_evidence ref when no evidence-status lookup is wired", () => {
    const repository = createFridayTaskWorkflowRepository();
    const service = createFridayTaskWorkflowService({
      db,
      repository,
      idGenerator: () => {
        nextId += 1;
        return `id-${nextId.toString(16).padStart(8, "0")}`;
      },
      nowIso: () => frozenNow,
      // Intentionally omit getWorkflowRunEvidenceStatus.
    });
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "workflow run evidence ref without lookup",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "workflow_run_evidence",
      refId: "run-anything",
      refSource: "workflow_run_evidence",
    });
    expect(() =>
      service.verifyClaim(workflow.id, claim.id, {
        verifierVerdict: "should refuse",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_EVIDENCE_UNAVAILABLE",
      }) as unknown as Error,
    );
  });

  it("verifyClaim allows workflow_run_evidence ref when source run reports available", () => {
    const statusByRunId = new Map<string, "available" | "degraded" | "unavailable">([
      ["run-ok", "available"],
    ]);
    const service = makeServiceWithEvidenceStatus(statusByRunId);
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "workflow run evidence from healthy run",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "workflow_run_evidence",
      refId: "run-ok",
      refSource: "workflow_run_evidence",
    });
    const verified = service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "fresh-read verified",
    });
    expect(verified.status).toBe("verified");
  });

  it("closeout receipt: evidenceDurability=available and proofClaimable=true on a clean run", () => {
    const statusByRunId = new Map<string, "available" | "degraded" | "unavailable">([
      ["run-ok", "available"],
    ]);
    const service = makeServiceWithEvidenceStatus(statusByRunId);
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "happy path",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "workflow_run_evidence",
      refId: "run-ok",
      refSource: "workflow_run_evidence",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "fresh-read happy",
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.evidenceDurability).toBe("available");
    expect(receipt.proofClaimable).toBe(true);
    expect(receipt.status).toBe("complete");
  });

  it("closeout receipt: evidenceDurability degrades and gate blocks when source run degrades after verify", () => {
    // Models the live-runtime case where a verified workflow_run_evidence
    // ref's source run later observes an evidence-store degrade. verifyClaim
    // had access to a healthy run; closeout must honestly fail-closed.
    const statusByRunId = new Map<string, "available" | "degraded" | "unavailable">([
      ["run-late-deg", "available"],
    ]);
    const service = makeServiceWithEvidenceStatus(statusByRunId);
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "verified runtime claim backed by initially-healthy run",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "workflow_run_evidence",
      refId: "run-late-deg",
      refSource: "workflow_run_evidence",
    });
    const verified = service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "fresh-read at verify time",
    });
    expect(verified.status).toBe("verified");

    // Source run degrades after the verify already passed.
    statusByRunId.set("run-late-deg", "degraded");

    const receipt = service.closeout(workflow.id);
    expect(receipt.evidenceDurability).toBe("degraded");
    expect(receipt.proofClaimable).toBe(false);
    expect(receipt.status).toBe("blocked");
    const gate = receipt.gateOutcomes.find((g) => g.gateId === "workflow_run_evidence_durable");
    expect(gate?.status).toBe("block");
  });

  it("closeout receipt: evidenceDurability becomes unavailable on the worst-case path", () => {
    const statusByRunId = new Map<string, "available" | "degraded" | "unavailable">([
      ["run-late-unav", "available"],
    ]);
    const service = makeServiceWithEvidenceStatus(statusByRunId);
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "verified runtime claim backed by run that goes unavailable",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "workflow_run_evidence",
      refId: "run-late-unav",
      refSource: "workflow_run_evidence",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "fresh-read at verify time",
    });
    statusByRunId.set("run-late-unav", "unavailable");

    const receipt = service.closeout(workflow.id);
    expect(receipt.evidenceDurability).toBe("unavailable");
    expect(receipt.proofClaimable).toBe(false);
    expect(receipt.status).toBe("blocked");
  });
});

describe("Phase 14.5D module_28d — closeout receipt rollback disclosure", () => {
  function setupServiceWithRepository(): {
    repository: ReturnType<typeof createFridayTaskWorkflowRepository>;
    service: FridayTaskWorkflowService;
  } {
    const repository = createFridayTaskWorkflowRepository();
    const service = createFridayTaskWorkflowService({
      db,
      repository,
      idGenerator: () => {
        nextId += 1;
        return `id-${nextId.toString(16).padStart(8, "0")}`;
      },
      nowIso: () => frozenNow,
    });
    return { repository, service };
  }

  it("populates rollbackClass=reversible_local for an agent_run_event-backed verified claim", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "agent run evidence",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-local-1",
      refSource: "agent_run_event",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "fresh-read",
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.rollbackClass).toBe("reversible_local");
    expect(receipt.compensatingAction).toBeNull();
    expect(receipt.nonReversibleReason).toBeNull();
    const gate = receipt.gateOutcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("pass");
  });

  it("rollbackClass not_applicable when only docs_intent_reference refs exist (intent compatibility)", () => {
    const service = makeService();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "intent claim only",
      claimKind: "docs_intent",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "docs.start_here",
      refId: "START_HERE_PROMPT.md",
      refSource: "docs_intent_reference",
    });
    // docs_intent claims cannot reach verified; ensure closeout still works.
    const receipt = service.closeout(workflow.id);
    expect(receipt.rollbackClass).toBe("not_applicable");
    expect(receipt.compensatingAction).toBeNull();
    expect(receipt.nonReversibleReason).toBeNull();
  });

  it("rollbackClass compensating_action_required when a workflow_run_evidence ref is verified", () => {
    const statusByRunId = new Map<string, "available" | "degraded" | "unavailable">([
      ["run-comp", "available"],
    ]);
    const repository = createFridayTaskWorkflowRepository();
    const service = createFridayTaskWorkflowService({
      db,
      repository,
      idGenerator: () => {
        nextId += 1;
        return `id-${nextId.toString(16).padStart(8, "0")}`;
      },
      nowIso: () => frozenNow,
      getWorkflowRunEvidenceStatus: (runId) => statusByRunId.get(runId) ?? null,
    });
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "workflow run evidence",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "workflow_run_evidence",
      refId: "run-comp",
      refSource: "workflow_run_evidence",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "fresh-read available run",
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.rollbackClass).toBe("compensating_action_required");
    expect(receipt.compensatingAction).toMatch(/workflow_run_evidence/);
    expect(receipt.nonReversibleReason).toBeNull();
    const gate = receipt.gateOutcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("pass");
  });

  it("rollbackClass non_reversible_external when verified claim references manual_external", () => {
    const { repository, service } = setupServiceWithRepository();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "external action claim",
      claimKind: "runtime_evidence",
    });
    // Plant a manual_external ref directly via the repository so we can keep
    // the verifyClaim path simple (manual_external is not in
    // getAllowedRefSources for runtime_evidence; the test models the
    // closeout-time disclosure surface, not the verify-time gate).
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-pre",
      refSource: "agent_run_event",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "verified before plant",
    });
    db.withWriteTransaction((conn) => {
      repository.insertEvidenceRef(conn, {
        id: "plant-ext-1",
        workflowId: workflow.id,
        claimId: claim.id,
        refKind: "external.message",
        refId: "ext-msg-1",
        refHash: null,
        refSource: "manual_external",
        createdAt: frozenNow,
      });
      repository.incrementEvidenceRefCount(conn, claim.id, frozenNow);
    });
    const receipt = service.closeout(workflow.id);
    expect(receipt.rollbackClass).toBe("non_reversible_external");
    expect(receipt.nonReversibleReason).toMatch(/manual_external/);
    expect(receipt.compensatingAction).toBeNull();
    // The rollback gate must pass because a real reason is recorded; the
    // receipt status itself may still be "complete" if other gates are fine.
    const gate = receipt.gateOutcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    expect(gate?.status).toBe("pass");
  });

  it("persists rollback fields and rehydrates them via getLatestCloseoutReceipt", () => {
    const { repository, service } = setupServiceWithRepository();
    const workflow = service.create(makeCreateInput());
    const claim = service.draftClaim(workflow.id, {
      claimText: "agent run roundtrip",
      claimKind: "runtime_evidence",
    });
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "agent_run.event",
      refId: "evt-roundtrip",
      refSource: "agent_run_event",
    });
    service.verifyClaim(workflow.id, claim.id, {
      verifierVerdict: "fresh-read roundtrip",
    });
    const written = service.closeout(workflow.id);
    const reloaded = db.withReadConnection((conn) =>
      repository.getLatestCloseoutReceipt(conn, workflow.id),
    );
    expect(reloaded).not.toBeNull();
    expect(reloaded!.rollbackClass).toBe(written.rollbackClass);
    expect(reloaded!.compensatingAction).toBe(written.compensatingAction);
    expect(reloaded!.nonReversibleReason).toBe(written.nonReversibleReason);
  });

  it("legacy closeout rows (null columns) rehydrate as not_applicable/null", () => {
    const repository = createFridayTaskWorkflowRepository();
    const service = createFridayTaskWorkflowService({
      db,
      repository,
      idGenerator: () => {
        nextId += 1;
        return `id-${nextId.toString(16).padStart(8, "0")}`;
      },
      nowIso: () => frozenNow,
    });
    const workflow = service.create(makeCreateInput());
    // Insert a closeout row directly with the new columns set to NULL to
    // model a pre-v087 row that survived the additive migration.
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO task_workflow_closeout_receipts (
           id, workflow_id, spec_hash, status,
           claim_summary_json, blockers_json, gate_outcomes_json, created_at,
           evidence_durability, proof_claimable,
           rollback_class, compensating_action, non_reversible_reason
         ) VALUES (
           @id, @workflowId, @specHash, @status,
           @claimSummaryJson, @blockersJson, @gateOutcomesJson, @createdAt,
           @evidenceDurability, @proofClaimable,
           NULL, NULL, NULL
         )`,
      ).run({
        id: "legacy-receipt-1",
        workflowId: workflow.id,
        specHash: workflow.specHash,
        status: "complete",
        claimSummaryJson: JSON.stringify({ draft: 0, unverified: 0, verified: 1, blocked: 0 }),
        blockersJson: JSON.stringify([]),
        gateOutcomesJson: JSON.stringify([]),
        createdAt: frozenNow,
        evidenceDurability: "available",
        proofClaimable: 1,
      });
    });
    const reloaded = db.withReadConnection((conn) =>
      repository.getLatestCloseoutReceipt(conn, workflow.id),
    );
    expect(reloaded).not.toBeNull();
    expect(reloaded!.rollbackClass).toBe("not_applicable");
    expect(reloaded!.compensatingAction).toBeNull();
    expect(reloaded!.nonReversibleReason).toBeNull();
  });
});
