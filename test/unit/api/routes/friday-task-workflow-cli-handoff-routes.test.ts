import { describe, expect, it } from "vitest";

import { createFridayTaskWorkflowRoutes } from "../../../../src/api/http/routes/friday-task-workflow-routes.js";
import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import type {
  FridayTaskWorkflowCliHandoffRecord,
  FridayTaskWorkflowService,
} from "../../../../src/task-workflows/index.js";

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
    receivedAt: "2026-05-16T00:00:00Z",
    ...overrides,
  };
}

function makeStubService(
  overrides: Partial<FridayTaskWorkflowService> = {},
): FridayTaskWorkflowService {
  const base: FridayTaskWorkflowService = {
    preview: () => {
      throw new Error("not used");
    },
    create: () => {
      throw new Error("not used");
    },
    get: () => {
      throw new Error("not used");
    },
    list: () => [],
    revise: () => {
      throw new Error("not used");
    },
    listRevisions: () => [],
    draftClaim: () => {
      throw new Error("not used");
    },
    listClaims: () => [],
    getClaim: () => {
      throw new Error("not used");
    },
    attachEvidenceRef: () => {
      throw new Error("not used");
    },
    listEvidenceRefs: () => [],
    verifyClaim: () => {
      throw new Error("not used");
    },
    blockClaim: () => {
      throw new Error("not used");
    },
    closeout: () => {
      throw new Error("not used");
    },
    openExecutorLane: () => {
      throw new Error("not used");
    },
    openVerifierLane: () => {
      throw new Error("not used");
    },
    completeLane: () => {
      throw new Error("not used");
    },
    submitVerifierVerdict: () => {
      throw new Error("not used");
    },
    listLanes: () => [],
    getLane: () => {
      throw new Error("not used");
    },
    recordCliHandoff: async () => {
      throw new Error("not used");
    },
    listCliHandoffsByLane: () => [],
    listCliHandoffsByWorkflow: () => [],
    getSupervisorOverview: () => {
      throw new Error("not used");
    },
    issueChannelCommand: () => {
      throw new Error("not used");
    },
    confirmChannelCommand: () => {
      throw new Error("not used");
    },
    listChannelCommands: () => [],
    queryEvidenceExplorer: () => [],
    getEvidenceRefRawDrilldown: () => {
      throw new Error("not used");
    },
  };
  return { ...base, ...overrides };
}

const FAKE_HANDOFF: FridayTaskWorkflowCliHandoffRecord = {
  id: "handoff-1",
  workflowId: "w-1",
  laneId: "lane-1",
  backendId: "claude-cli",
  status: "handoff_ready",
  summaryDraft: "cli draft summary",
  capabilityLabel: {
    nativeToolProof: false,
    summaryStatus: "draft_unverified",
    verifierPromotionAllowed: false,
    evidenceRefFreshReadRequired: true,
    contextPackageBound: true,
    laneRole: "cli",
    boundaryRefs: ["api.task_workflows.cli_adapter"],
    requiredGateIds: [
      "cli_self_report_unconfirmed",
      "claim_evidence_required",
      "verifier_fresh_read",
      "context_package_scope_limit",
    ],
    disclosure:
      "CLI backend output is bounded text only; it is never native-tool proof and never promotes claims to verified.",
  },
  repairAttempts: 0,
  elapsedMs: 1,
  failureReason: null,
  producedAt: "2026-05-16T00:00:00.000Z",
  createdAt: "2026-05-16T00:00:00.000Z",
};

describe("Phase 13.5C CLI handoff route registration", () => {
  it("registers POST /v1/task-workflows/:workflowId/lanes/:laneId/cli-handoffs", () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubService(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.cli.handoff.record");
    expect(route.method).toBe("POST");
    expect(route.path).toBe(
      "/v1/task-workflows/:workflowId/lanes/:laneId/cli-handoffs",
    );
  });

  it("registers GET /v1/task-workflows/:workflowId/lanes/:laneId/cli-handoffs", () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubService(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.cli.handoffs.list");
    expect(route.method).toBe("GET");
    expect(route.path).toBe(
      "/v1/task-workflows/:workflowId/lanes/:laneId/cli-handoffs",
    );
  });

  it("registers GET /v1/task-workflows/:workflowId/cli-handoffs", () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubService(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.cli.handoffs.list");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/task-workflows/:workflowId/cli-handoffs");
  });
});

describe("Phase 13.5C CLI handoff record route behavior", () => {
  it("delegates valid body to service.recordCliHandoff and returns { handoff }", async () => {
    let received:
      | { workflowId: string; laneId: string; backendId: string }
      | null = null;
    const routes = createFridayTaskWorkflowRoutes({
      allowTestOnlyTaskWorkflowExecution: true,
      service: makeStubService({
        recordCliHandoff: async (workflowId, laneId, input) => {
          received = {
            workflowId,
            laneId,
            backendId: input.backendId,
          };
          return FAKE_HANDOFF;
        },
      }),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.cli.handoff.record");
    const response = (await route.handler(
      makeCtx({
        params: { workflowId: "w-1", laneId: "lane-1" },
        body: {
          backendId: "claude-cli",
          systemPrompt: "system",
          conversation: "summarize",
        },
      }) as never,
    )) as { handoff: FridayTaskWorkflowCliHandoffRecord };
    expect(received).toEqual({
      workflowId: "w-1",
      laneId: "lane-1",
      backendId: "claude-cli",
    });
    expect(response.handoff.id).toBe(FAKE_HANDOFF.id);
    expect(response.handoff.capabilityLabel.nativeToolProof).toBe(false);
    expect(response.handoff.capabilityLabel.verifierPromotionAllowed).toBe(false);
  });

  it("rejects an unknown backendId at the route layer (validation)", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubService(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.cli.handoff.record");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "w-1", laneId: "lane-1" },
          body: {
            backendId: "openai-cli",
            systemPrompt: "system",
            conversation: "summarize",
          },
        }) as never,
      );
      throw new Error("expected validation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("VALIDATION_ERROR");
      expect((error as FridayDomainError).message).toMatch(
        /backendId must be one of codex-cli, claude-cli/i,
      );
    }
  });

  it("rejects a missing systemPrompt at the route layer (validation)", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubService(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.cli.handoff.record");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "w-1", laneId: "lane-1" },
          body: {
            backendId: "claude-cli",
            conversation: "summarize",
          },
        }) as never,
      );
      throw new Error("expected validation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects a non-positive timeoutMs at the route layer (validation)", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubService(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.cli.handoff.record");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "w-1", laneId: "lane-1" },
          body: {
            backendId: "claude-cli",
            systemPrompt: "sys",
            conversation: "msg",
            timeoutMs: 0,
          },
        }) as never,
      );
      throw new Error("expected timeoutMs validation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("VALIDATION_ERROR");
      expect((error as FridayDomainError).message).toMatch(/timeoutMs/);
    }
  });

  it("returns 503 TASK_WORKFLOWS_DISABLED when service slot is null", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: null,
      disabledReason: "test disabled reason",
    });
    const route = findRoute(routes, "task.workflows.lanes.cli.handoff.record");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "w-1", laneId: "lane-1" },
          body: {
            backendId: "claude-cli",
            systemPrompt: "sys",
            conversation: "msg",
          },
        }) as never,
      );
      throw new Error("expected disabled refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("TASK_WORKFLOWS_DISABLED");
    }
  });
});

describe("Phase 13.5C CLI handoff list routes return service results", () => {
  it("lanes.cli.handoffs.list returns { items } from listCliHandoffsByLane", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubService({
        listCliHandoffsByLane: (workflowId, laneId) => {
          expect(workflowId).toBe("w-1");
          expect(laneId).toBe("lane-1");
          return [FAKE_HANDOFF];
        },
      }),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.cli.handoffs.list");
    const response = (await route.handler(
      makeCtx({
        params: { workflowId: "w-1", laneId: "lane-1" },
      }) as never,
    )) as { items: FridayTaskWorkflowCliHandoffRecord[] };
    expect(response.items).toHaveLength(1);
    expect(response.items[0]!.id).toBe(FAKE_HANDOFF.id);
  });

  it("cli.handoffs.list returns { items } from listCliHandoffsByWorkflow", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubService({
        listCliHandoffsByWorkflow: (workflowId) => {
          expect(workflowId).toBe("w-1");
          return [FAKE_HANDOFF];
        },
      }),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.cli.handoffs.list");
    const response = (await route.handler(
      makeCtx({ params: { workflowId: "w-1" } }) as never,
    )) as { items: FridayTaskWorkflowCliHandoffRecord[] };
    expect(response.items).toHaveLength(1);
  });
});
