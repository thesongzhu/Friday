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
    openExecutorLane: () => {
      throw new Error("not used in this test");
    },
    openVerifierLane: () => {
      throw new Error("not used in this test");
    },
    completeLane: () => {
      throw new Error("not used in this test");
    },
    submitVerifierVerdict: () => {
      throw new Error("not used in this test");
    },
    listLanes: () => [],
    getLane: () => {
      throw new Error("not used in this test");
    },
    recordCliHandoff: async () => {
      throw new Error("not used in this test");
    },
    listCliHandoffsByLane: () => [],
    listCliHandoffsByWorkflow: () => [],
    getSupervisorOverview: () => {
      throw new Error("not used in this test");
    },
    issueChannelCommand: () => {
      throw new Error("not used in this test");
    },
    confirmChannelCommand: () => {
      throw new Error("not used in this test");
    },
    listChannelCommands: () => [],
    queryEvidenceExplorer: () => [],
    getEvidenceRefRawDrilldown: () => {
      throw new Error("not used in this test");
    },
  };
}

describe("Phase 13.5A task workflow route registration", () => {
  it("registers preview, create, read, list, revise, claim, evidence, verify, block, closeout, boundaries, gates, and Phase 13.5B lanes", () => {
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
      "task.workflows.lanes.executor.open",
      "task.workflows.lanes.verifier.open",
      "task.workflows.lanes.complete",
      "task.workflows.lanes.verdict",
      "task.workflows.lanes.list",
      "task.workflows.lanes.get",
      "task.workflows.supervisor.read",
      "task.workflows.channel.command.issue",
      "task.workflows.channel.command.list",
      "task.workflows.channel.command.confirm",
      "task.workflows.evidence.explorer.query",
      "task.workflows.evidence.explorer.raw",
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

describe("Phase 13.5D supervisor + channel + evidence-explorer routes", () => {
  it("supervisor read route is GET-only and returns the assembled overview", async () => {
    const stub = makeStubService();
    let invokedWorkflow: string | undefined;
    const routes = createFridayTaskWorkflowRoutes({
      service: {
        ...stub,
        getSupervisorOverview: (workflowId) => {
          invokedWorkflow = workflowId;
          return {
            workflow: {
              id: workflowId,
              charter: "c",
              specHash: "sh",
              parentSpecHash: null,
              taskKind: "general",
              risk: "medium",
              supervisorMode: "standard",
              budget: 4,
              stage: "charter",
              contextPackage: {
                allowedFiles: ["a"],
                allowedTools: [],
                allowedApis: [],
                boundaryIds: [],
              },
              gatePlan: [],
              boundaryRefs: [],
              metadata: {},
              createdAt: "2026-05-16T00:00:00Z",
              updatedAt: "2026-05-16T00:00:00Z",
            },
            supervisorCursor: null,
            boundaryRefs: [],
            contextPackageSummary: {
              boundaryIds: [],
              allowedFilesCount: 1,
              allowedToolsCount: 0,
              allowedApisCount: 0,
            },
            gatePlan: [],
            immutableRequiredGateIds: [],
            claimMatrix: {
              counts: { draft: 0, unverified: 0, verified: 0, blocked: 0 },
              unverifiedClaims: [],
              blockedClaims: [],
            },
            laneSummary: {
              executor: { count: 0, open: 0, completed: 0, blocked: 0 },
              verifier: {
                count: 0,
                open: 0,
                completed: 0,
                blocked: 0,
                independent: 0,
                degraded: 0,
              },
            },
            channelCommandSummary: {
              total: 0,
              issued: 0,
              confirmed: 0,
              dispatched: 0,
              declined: 0,
              expired: 0,
            },
            blockers: [],
            closeoutReceipt: null,
          };
        },
      },
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.supervisor.read");
    expect(route.method).toBe("GET");
    const response = (await route.handler(
      makeCtx({ params: { workflowId: "wf-x" } }) as never,
    )) as { overview: { workflow: { id: string } } };
    expect(invokedWorkflow).toBe("wf-x");
    expect(response.overview.workflow.id).toBe("wf-x");
  });

  it("evidence explorer raw drilldown requires gateConfirmed=true and surfaces 403 otherwise", async () => {
    const stub = makeStubService();
    const routes = createFridayTaskWorkflowRoutes({
      service: {
        ...stub,
        getEvidenceRefRawDrilldown: (evidenceRefId, gateConfirmed) => {
          if (gateConfirmed !== true) {
            throw new FridayDomainError(
              "TASK_WORKFLOW_EVIDENCE_RAW_GATE_REQUIRED",
              "raw evidence drilldown requires an explicit gate confirmation.",
              { httpStatus: 403 },
            );
          }
          return {
            evidenceRefId,
            workflowId: "wf-1",
            claimId: "claim-1",
            refKind: "agent.run",
            refSource: "agent_run_event",
            refIdRedacted: "raw",
            refHash: null,
            redactionApplied: false,
            createdAt: "2026-05-16T00:00:00Z",
          };
        },
      },
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.evidence.explorer.raw");
    expect(route.method).toBe("GET");
    // Without gateConfirmed=true the route must refuse with 403.
    try {
      await route.handler(
        makeCtx({
          params: { evidenceRefId: "ref-1" },
          query: {},
        }) as never,
      );
      throw new Error("expected gate refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domain = error as FridayDomainError;
      expect(domain.code).toBe("TASK_WORKFLOW_EVIDENCE_RAW_GATE_REQUIRED");
      expect(domain.httpStatus).toBe(403);
    }
    // With gateConfirmed=true the route returns the redacted payload.
    const success = (await route.handler(
      makeCtx({
        params: { evidenceRefId: "ref-1" },
        query: { gateConfirmed: "true" },
      }) as never,
    )) as { drilldown: Record<string, unknown> };
    expect(success.drilldown.redactionApplied).toBe(false);
    // The route-level response must not carry the unredacted raw refId
    // alongside the redacted form (module_26d Global Evidence Explorer v1
    // gated raw drilldown remains server-redacted only).
    expect(success.drilldown.refId).toBeUndefined();
    expect("refId" in success.drilldown).toBe(false);
  });

  it("channel command issue route refuses unknown intentKind values", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubService(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.channel.command.issue");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "wf-1" },
          body: {
            channelKind: "discord",
            channelChatId: "chat",
            channelMessageId: "msg",
            senderId: "sender",
            intentKind: "not_an_intent",
          },
        }) as never,
      );
      throw new Error("expected validation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domain = error as FridayDomainError;
      expect(domain.code).toBe("VALIDATION_ERROR");
      expect(domain.httpStatus).toBe(400);
    }
  });
});

describe("Phase 14.5A WP-001: task-workflow public mutating routes require bound principal", () => {
  function syntheticPublic() {
    return {
      principalType: "user" as const,
      principalId: "public:default",
      tokenId: "00000000-0000-0000-0000-000000000002",
      userId: "00000000-0000-0000-0000-000000000001",
      role: "admin" as const,
      scopes: [],
      tokenKind: "access" as const,
      issuedAt: "2026-05-16T00:00:00Z",
    };
  }

  const BOUND_OPS: ReadonlyArray<{ operationId: string; params: Record<string, string>; body?: Record<string, unknown> }> = [
    {
      operationId: "task.workflows.create",
      params: {},
      body: { charter: "x", taskKind: "general", contextPackage: {} },
    },
    {
      operationId: "task.workflows.revise",
      params: { workflowId: "w-1" },
      body: { charter: "x", reason: "update" },
    },
    {
      operationId: "task.workflows.claims.create",
      params: { workflowId: "w-1" },
      body: { claimText: "x", claimKind: "runtime_evidence" },
    },
    {
      operationId: "task.workflows.claims.evidence.attach",
      params: { workflowId: "w-1", claimId: "c-1" },
      body: { refKind: "agent_run_event", refId: "ev-1", refSource: "agent_run_event" },
    },
    { operationId: "task.workflows.claims.verify", params: { workflowId: "w-1", claimId: "c-1" }, body: { verifierVerdict: "x", evidenceRefIds: ["ev-1"] } },
    { operationId: "task.workflows.claims.block", params: { workflowId: "w-1", claimId: "c-1" }, body: { reason: "x" } },
    { operationId: "task.workflows.closeout", params: { workflowId: "w-1" } },
    {
      operationId: "task.workflows.lanes.executor.open",
      params: { workflowId: "w-1" },
      body: { laneRole: "native" },
    },
    {
      operationId: "task.workflows.lanes.verifier.open",
      params: { workflowId: "w-1" },
      body: {
        parentLaneId: "lane-1",
        laneRole: "provider",
        independenceClaim: "independent",
      },
    },
    {
      operationId: "task.workflows.lanes.complete",
      params: { workflowId: "w-1", laneId: "lane-1" },
      body: { status: "completed" },
    },
    {
      operationId: "task.workflows.lanes.verdict",
      params: { workflowId: "w-1", laneId: "lane-1" },
      body: { claimId: "c-1", verifierVerdict: "ok" },
    },
    {
      operationId: "task.workflows.lanes.cli.handoff.record",
      params: { workflowId: "w-1", laneId: "lane-1" },
      body: {
        backendId: "claude-cli",
        systemPrompt: "system",
        conversation: "summarize",
      },
    },
    {
      operationId: "task.workflows.channel.command.issue",
      params: { workflowId: "w-1" },
      body: {
        channelKind: "discord",
        channelChatId: "chat",
        channelMessageId: "msg",
        senderId: "sender",
        intentKind: "progress_query",
      },
    },
    {
      operationId: "task.workflows.channel.command.confirm",
      params: { workflowId: "w-1" },
      body: { confirmationToken: "confirm-token" },
    },
  ];

  for (const { operationId, params, body } of BOUND_OPS) {
    it(`${operationId} refuses the synthetic public principal`, async () => {
      const routes = createFridayTaskWorkflowRoutes({
        service: makeStubService(),
        disabledReason: null,
      });
      const route = findRoute(routes, operationId);
      let thrown: unknown;
      try {
        await route.handler(makeCtx({
          params,
          body: body ?? {},
          principal: syntheticPublic(),
        }) as never);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(FridayDomainError);
      expect((thrown as FridayDomainError).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");
      expect((thrown as FridayDomainError).httpStatus).toBe(401);
    });

    it(`${operationId} refuses a null principal`, async () => {
      const routes = createFridayTaskWorkflowRoutes({
        service: makeStubService(),
        disabledReason: null,
      });
      const route = findRoute(routes, operationId);
      let thrown: unknown;
      try {
        await route.handler(makeCtx({
          params,
          body: body ?? {},
          principal: null,
        }) as never);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(FridayDomainError);
      expect((thrown as FridayDomainError).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");
    });
  }

  it("keeps preview as a non-mutating public route", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubService(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.preview");
    const response = (await route.handler(makeCtx({
      body: { charter: "x", taskKind: "general", contextPackage: {} },
      principal: syntheticPublic(),
    }) as never)) as { preview: { specHash: string } };
    expect(response.preview.specHash).toBe("stub-hash");
  });
});
