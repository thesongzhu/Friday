import { describe, expect, it } from "vitest";

import { createFridayTaskWorkflowRoutes } from "../../../../src/api/http/routes/friday-task-workflow-routes.js";
import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
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

function makeStubServiceWithLanes(
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
  };
  return { ...base, ...overrides };
}

describe("Phase 13.5B lane route registration", () => {
  it("exposes executor/verifier open, complete, verdict, list, get under /v1/task-workflows/:workflowId/lanes", () => {
    const routes = makeDisabledRoutes();
    const expectedPaths: Record<string, { method: string; path: string }> = {
      "task.workflows.lanes.executor.open": {
        method: "POST",
        path: "/v1/task-workflows/:workflowId/lanes/executor",
      },
      "task.workflows.lanes.verifier.open": {
        method: "POST",
        path: "/v1/task-workflows/:workflowId/lanes/verifier",
      },
      "task.workflows.lanes.complete": {
        method: "POST",
        path: "/v1/task-workflows/:workflowId/lanes/:laneId/complete",
      },
      "task.workflows.lanes.verdict": {
        method: "POST",
        path: "/v1/task-workflows/:workflowId/lanes/:laneId/verdict",
      },
      "task.workflows.lanes.list": {
        method: "GET",
        path: "/v1/task-workflows/:workflowId/lanes",
      },
      "task.workflows.lanes.get": {
        method: "GET",
        path: "/v1/task-workflows/:workflowId/lanes/:laneId",
      },
    };
    for (const [operationId, expected] of Object.entries(expectedPaths)) {
      const route = findRoute(routes, operationId);
      expect(route.method).toBe(expected.method);
      expect(route.path).toBe(expected.path);
    }
  });

  for (const operationId of [
    "task.workflows.lanes.executor.open",
    "task.workflows.lanes.verifier.open",
    "task.workflows.lanes.complete",
    "task.workflows.lanes.verdict",
    "task.workflows.lanes.list",
    "task.workflows.lanes.get",
  ]) {
    it(`returns 503 TASK_WORKFLOWS_DISABLED when service is null for ${operationId}`, async () => {
      const routes = makeDisabledRoutes();
      const route = findRoute(routes, operationId);
      try {
        await route.handler(
          makeCtx({
            params: { workflowId: "w-1", laneId: "l-1" },
            body: {
              laneRole: "native",
              parentLaneId: "l-1",
              independenceClaim: "independent",
              claimId: "c-1",
              verifierVerdict: "x",
              status: "completed",
            },
          }) as never,
        );
        throw new Error("expected disabled refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        expect((error as FridayDomainError).code).toBe("TASK_WORKFLOWS_DISABLED");
        expect((error as FridayDomainError).httpStatus).toBe(503);
      }
    });
  }
});

describe("Phase 13.5B lane route body validation", () => {
  it("openExecutorLane refuses missing laneRole", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubServiceWithLanes(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.executor.open");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "w-1" },
          body: {},
        }) as never,
      );
      throw new Error("expected validation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("VALIDATION_ERROR");
      expect((error as FridayDomainError).httpStatus).toBe(400);
    }
  });

  it("openVerifierLane refuses missing parentLaneId", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubServiceWithLanes(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.verifier.open");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "w-1" },
          body: {
            laneRole: "provider",
            independenceClaim: "independent",
          },
        }) as never,
      );
      throw new Error("expected validation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("openVerifierLane refuses invalid independenceClaim", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubServiceWithLanes(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.verifier.open");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "w-1" },
          body: {
            parentLaneId: "lane-x",
            laneRole: "provider",
            independenceClaim: "not_applicable",
          },
        }) as never,
      );
      throw new Error("expected validation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("completeLane refuses unknown status", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubServiceWithLanes(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.complete");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "w-1", laneId: "l-1" },
          body: { status: "open" },
        }) as never,
      );
      throw new Error("expected validation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("submitVerifierVerdict refuses missing claimId", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubServiceWithLanes(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.verdict");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "w-1", laneId: "l-1" },
          body: { verifierVerdict: "ok" },
        }) as never,
      );
      throw new Error("expected validation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("Phase 13.5B lane route delegation to service", () => {
  it("openExecutorLane handler returns { lane } from service", async () => {
    const fakeLane = {
      id: "lane-1",
      workflowId: "w-1",
      laneKind: "executor" as const,
      laneRole: "native" as const,
      parentLaneId: null,
      status: "open" as const,
      independence: "not_applicable" as const,
      executorRunRef: null,
      providerId: null,
      routeTraceRef: null,
      contextSnapshotHash: "0".repeat(64),
      contextSnapshotSpecHash: "1".repeat(64),
      fallbackAvailability: null,
      blocker: null,
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
    };
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubServiceWithLanes({
        openExecutorLane: () => fakeLane,
      }),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.executor.open");
    const response = (await route.handler(
      makeCtx({
        params: { workflowId: "w-1" },
        body: { laneRole: "native" },
      }) as never,
    )) as { lane: typeof fakeLane };
    expect(response.lane.id).toBe(fakeLane.id);
    expect(response.lane.laneKind).toBe("executor");
  });

  it("lanes.list handler returns { items } from service.listLanes", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubServiceWithLanes({
        listLanes: () => [],
      }),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.list");
    const response = (await route.handler(
      makeCtx({ params: { workflowId: "w-1" } }) as never,
    )) as { items: unknown[] };
    expect(Array.isArray(response.items)).toBe(true);
  });
});
