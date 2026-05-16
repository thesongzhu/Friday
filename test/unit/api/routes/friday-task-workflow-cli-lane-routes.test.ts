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
    receivedAt: "2026-05-16T00:00:00Z",
    ...overrides,
  };
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
    recordCliHandoff: async () => {
      throw new Error("not used");
    },
    listCliHandoffsByLane: () => [],
    listCliHandoffsByWorkflow: () => [],
  };
  return { ...base, ...overrides };
}

describe("Phase 13.5C laneRole='cli' route validation", () => {
  it("openExecutorLane accepts laneRole='cli' and delegates to the service", async () => {
    const fakeLane = {
      id: "lane-cli-1",
      workflowId: "w-1",
      laneKind: "executor" as const,
      laneRole: "cli" as const,
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
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    };
    let received: { laneRole?: string } = {};
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubServiceWithLanes({
        openExecutorLane: (_workflowId, input) => {
          received = { laneRole: input.laneRole };
          return fakeLane;
        },
      }),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.executor.open");
    const response = (await route.handler(
      makeCtx({
        params: { workflowId: "w-1" },
        body: { laneRole: "cli" },
      }) as never,
    )) as { lane: typeof fakeLane };
    expect(received.laneRole).toBe("cli");
    expect(response.lane.id).toBe(fakeLane.id);
    expect(response.lane.laneRole).toBe("cli");
  });

  it("openExecutorLane rejects an unknown laneRole value", async () => {
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubServiceWithLanes(),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.executor.open");
    try {
      await route.handler(
        makeCtx({
          params: { workflowId: "w-1" },
          body: { laneRole: "supervisor" },
        }) as never,
      );
      throw new Error("expected validation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("VALIDATION_ERROR");
      expect((error as FridayDomainError).message).toMatch(
        /laneRole must be one of native, provider, cli/i,
      );
    }
  });

  it("openVerifierLane accepts laneRole='cli' (reviewer bookkeeping) at the route layer", async () => {
    const fakeLane = {
      id: "lane-cli-v-1",
      workflowId: "w-1",
      laneKind: "verifier" as const,
      laneRole: "cli" as const,
      parentLaneId: "executor-1",
      status: "open" as const,
      independence: "degraded_unavailable" as const,
      executorRunRef: null,
      providerId: null,
      routeTraceRef: null,
      contextSnapshotHash: "0".repeat(64),
      contextSnapshotSpecHash: "1".repeat(64),
      fallbackAvailability: null,
      blocker: null,
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    };
    const routes = createFridayTaskWorkflowRoutes({
      service: makeStubServiceWithLanes({
        openVerifierLane: () => fakeLane,
      }),
      disabledReason: null,
    });
    const route = findRoute(routes, "task.workflows.lanes.verifier.open");
    const response = (await route.handler(
      makeCtx({
        params: { workflowId: "w-1" },
        body: {
          parentLaneId: "executor-1",
          laneRole: "cli",
          independenceClaim: "degraded_unavailable",
        },
      }) as never,
    )) as { lane: typeof fakeLane };
    expect(response.lane.laneRole).toBe("cli");
    expect(response.lane.independence).toBe("degraded_unavailable");
  });
});
