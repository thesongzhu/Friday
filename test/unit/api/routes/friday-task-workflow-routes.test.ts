import { describe, expect, it } from "vitest";

import { createFridayTaskWorkflowRoutes } from "../../../../src/api/http/routes/friday-task-workflow-routes.js";
import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES,
  FRIDAY_TASK_WORKFLOW_BUILTIN_GATES,
} from "../../../../src/task-workflows/index.js";
import type { FridayTaskWorkflowService } from "../../../../src/task-workflows/index.js";

function findRoute(
  routes: ReturnType<typeof createFridayTaskWorkflowRoutes>,
  operationId: string,
) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route not found: ${operationId}`);
  return route;
}

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: { principalId: "user-001" },
    requestId: "req-001",
    receivedAt: "2026-05-15T00:00:00Z",
    ...overrides,
  };
}

function makeDisabledRoutes() {
  return createFridayTaskWorkflowRoutes({
    service: null,
    disabledReason: "task workflow deps not provided",
  });
}

function makeStubService(): FridayTaskWorkflowService {
  return {
    preview: () => ({
      specHash: "stub-hash",
      risk: "medium",
      supervisorMode: "standard",
      budget: 4,
      contextPackage: {
        allowedFiles: ["x.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: [],
      },
      gatePlan: [],
      boundaryRefs: [],
    }),
    create: () => {
      throw new Error("not used in this test");
    },
    get: () => {
      throw new Error("not used in this test");
    },
    list: () => [],
    revise: () => {
      throw new Error("not used in this test");
    },
    listRevisions: () => [],
    draftClaim: () => {
      throw new Error("not used in this test");
    },
    listClaims: () => [],
    getClaim: () => {
      throw new Error("not used in this test");
    },
    attachEvidenceRef: () => {
      throw new Error("not used in this test");
    },
    listEvidenceRefs: () => [],
    verifyClaim: () => {
      throw new Error("not used in this test");
    },
    blockClaim: () => {
      throw new Error("not used in this test");
    },
    closeout: () => {
      throw new Error("not used in this test");
    },
  };
}

describe("Phase 13.5A task workflow route registration", () => {
  it("registers preview, create, read, list, revise, claim, evidence, verify, block, closeout, boundaries, gates", () => {
    const routes = makeDisabledRoutes();
    const expected = [
      "task.workflows.preview",
      "task.workflows.create",
      "task.workflows.get",
      "task.workflows.list",
      "task.workflows.revise",
      "task.workflows.revisions.list",
      "task.workflows.claims.create",
      "task.workflows.claims.list",
      "task.workflows.claims.get",
      "task.workflows.claims.evidence.attach",
      "task.workflows.claims.evidence.list",
      "task.workflows.claims.verify",
      "task.workflows.claims.block",
      "task.workflows.closeout",
      "task.workflows.boundaries.list",
      "task.workflows.gates.list",
    ];
    for (const operationId of expected) {
      expect(routes.find((r) => r.operationId === operationId)).toBeDefined();
    }
  });

  it("does NOT register any /v1/agent/runs route — the surface is separate", () => {
    const routes = makeDisabledRoutes();
    for (const route of routes) {
      expect(route.path).not.toContain("/v1/agent/runs");
    }
  });

  it("never declares a write surface for boundary or gate CRUD", () => {
    const routes = makeDisabledRoutes();
    const catalogPaths = [
      "/v1/task-workflows/boundaries",
      "/v1/task-workflows/gates",
    ];
    for (const path of catalogPaths) {
      const catalogRoutes = routes.filter((r) => r.path === path);
      for (const route of catalogRoutes) {
        // Only GET methods are accepted for the read-only catalog.
        expect(route.method).toBe("GET");
      }
    }
  });
});

describe("Phase 13.5A task workflow route — disabled deployment", () => {
  it("returns 503 TASK_WORKFLOWS_DISABLED instead of 404 when service is null", async () => {
    const routes = makeDisabledRoutes();
    const route = findRoute(routes, "task.workflows.create");
    try {
      await route.handler(makeCtx({ body: { charter: "x", taskKind: "general" } }) as never);
      throw new Error("expected disabled refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domain = error as FridayDomainError;
      expect(domain.code).toBe("TASK_WORKFLOWS_DISABLED");
      expect(domain.httpStatus).toBe(503);
    }
  });

  it("returns 503 from preview when service is null", async () => {
    const routes = makeDisabledRoutes();
    const route = findRoute(routes, "task.workflows.preview");
    try {
      await route.handler(makeCtx({ body: { charter: "x", taskKind: "general" } }) as never);
      throw new Error("expected disabled refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domain = error as FridayDomainError;
      expect(domain.code).toBe("TASK_WORKFLOWS_DISABLED");
      expect(domain.httpStatus).toBe(503);
    }
  });
});

describe("Phase 13.5A read-only catalogs", () => {
  it("GET /v1/task-workflows/boundaries returns the built-in boundary catalog without a service slot", async () => {
    const routes = makeDisabledRoutes();
    const route = findRoute(routes, "task.workflows.boundaries.list");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/task-workflows/boundaries");
    const response = (await route.handler(makeCtx() as never)) as {
      items: typeof FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES;
    };
    expect(response.items.length).toBe(FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES.length);
    expect(response.items.map((b) => b.boundaryId)).toContain("api.task_workflows.core");
  });

  it("GET /v1/task-workflows/gates returns required + optional gates without a service slot", async () => {
    const routes = makeDisabledRoutes();
    const route = findRoute(routes, "task.workflows.gates.list");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/task-workflows/gates");
    const response = (await route.handler(makeCtx() as never)) as {
      items: typeof FRIDAY_TASK_WORKFLOW_BUILTIN_GATES;
    };
    expect(response.items.length).toBe(FRIDAY_TASK_WORKFLOW_BUILTIN_GATES.length);
    const requiredIds = response.items.filter((g) => g.required).map((g) => g.gateId);
    expect(requiredIds).toContain("claim_evidence_required");
    expect(requiredIds).toContain("verifier_fresh_read");
    expect(requiredIds).toContain("docs_intent_not_proof");
  });

  it("preview route does not call list() or persist when handler runs", async () => {
    let listCount = 0;
    const stub = makeStubService();
    const observable: FridayTaskWorkflowService = {
      ...stub,
      list: () => {
        listCount += 1;
        return [];
      },
    };
    const routes = createFridayTaskWorkflowRoutes({
      service: observable,
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.preview");
    const response = (await route.handler(
      makeCtx({ body: { charter: "x", taskKind: "general", contextPackage: {} } }) as never,
    )) as { preview: { specHash: string } };
    expect(response.preview.specHash).toBe("stub-hash");
    expect(listCount).toBe(0);
  });
});

describe("Phase 13.5A built-in gate catalog truth", () => {
  it("the docs_intent_not_proof + summary_replay_unconfirmed + cli_self_report_unconfirmed + provider_fallback_not_audit gates are required", () => {
    const requiredIds = FRIDAY_TASK_WORKFLOW_BUILTIN_GATES
      .filter((g) => g.required)
      .map((g) => g.gateId);
    expect(requiredIds).toContain("docs_intent_not_proof");
    expect(requiredIds).toContain("summary_replay_unconfirmed");
    expect(requiredIds).toContain("cli_self_report_unconfirmed");
    expect(requiredIds).toContain("provider_fallback_not_audit");
    expect(requiredIds).toContain("context_package_scope_limit");
  });
});

describe("Phase 13.5A B.2.1 route surface — refSource incompatibility error shape", () => {
  function makeServiceForCompatRoute(): FridayTaskWorkflowService {
    const stub = makeStubService();
    return {
      ...stub,
      attachEvidenceRef: () => {
        throw new FridayDomainError(
          "TASK_WORKFLOW_EVIDENCE_REFSOURCE_INCOMPATIBLE",
          "incompatible refSource",
          {
            httpStatus: 400,
            details: {
              claimKind: "runtime_evidence",
              refSource: "docs_intent_reference",
              allowedRefSources: ["agent_run_event"],
            },
          },
        );
      },
    };
  }

  it("attach route surfaces TASK_WORKFLOW_EVIDENCE_REFSOURCE_INCOMPATIBLE as HTTP 400 with details", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeServiceForCompatRoute(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.claims.evidence.attach");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "w-1", claimId: "c-1" },
          body: {
            refKind: "docs.start_here",
            refId: "START_HERE_PROMPT.md",
            refSource: "docs_intent_reference",
          },
        }) as never,
      );
      throw new Error("expected refsource incompatibility refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domain = error as FridayDomainError;
      expect(domain.code).toBe("TASK_WORKFLOW_EVIDENCE_REFSOURCE_INCOMPATIBLE");
      expect(domain.httpStatus).toBe(400);
      expect(domain.details.claimKind).toBe("runtime_evidence");
      expect(domain.details.refSource).toBe("docs_intent_reference");
    }
  });
});
