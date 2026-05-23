import { describe, expect, it, vi } from "vitest";
import { createFridayWorkflowRunRoutes } from "#api";
import type { FridayAuthPrincipal, FridayHttpContext, FridayWorkflowRunRoutesDeps } from "#api";
import type { FridayWorkflowRunEntity } from "#workflows";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";

const stubRun: FridayWorkflowRunEntity = {
  id: "run-1",
  workflowId: "wf-1",
  workflowVersionId: "v-1",
  status: "pending",
  triggerType: "manual",
  startedAt: "2025-01-01T00:00:00Z",
};
const NOW = "2025-01-01T00:00:00Z";

function makePrincipal(overrides: Partial<FridayAuthPrincipal> = {}): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "user-1",
    userId: "user-1",
    role: "operator",
    scopes: ["workflow.write"],
    tokenId: "token-1",
    tokenKind: "access",
    issuedAt: NOW,
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: { runId: "run-1", exportId: "exp-1" },
    query: {},
    body: {},
    headers: {},
    principal: makePrincipal(),
    ...overrides,
  };
}

describe("FridayWorkflowRunRoutes", () => {
  const stubDeps: FridayWorkflowRunRoutesDeps = {
    startRun: async () => ({ run: stubRun }),
    getRun: (_runId, _principal) => ({ run: stubRun }),
    listRunNodes: (_runId, _query, _principal) => ({ items: [] }),
    getRunTimeline: (_runId, _query, _principal) => ({ items: [] }),
    getRunEvidence: () => ({
      run: stubRun,
      exportedAt: "2025-01-01T00:00:00Z",
      query: {},
      summary: {
        totalEvents: 0,
        byModule: {
          rules: 0,
          "node-runner": 0,
          acceptance: 0,
          retry: 0,
          playbook: 0,
        },
        retryTraceCount: 0,
        playbookTraceCount: 0,
        acceptanceDecisions: { passed: 0, warned: 0, failed: 0 },
      },
      events: [],
      playbook: { traces: [] },
      acceptance: { events: [] },
      retry: { events: [], traces: [] },
      correlation: { items: [] },
    }),
    listRunEvidenceExports: () => ({ items: [] }),
    exportRunEvidence: () => ({
      export: {
        exportId: "exp-1",
        runId: "run-1",
        artifactId: "artifact-1",
        uri: "friday://workflow-runs/run-1/evidence-exports/exp-1.json",
        checksum: "checksum",
        createdAt: NOW,
        persisted: true,
        filePersisted: false,
        query: {},
        summary: {
          totalEvents: 0,
          byModule: {
            rules: 0,
            "node-runner": 0,
            acceptance: 0,
            retry: 0,
            playbook: 0,
          },
          retryTraceCount: 0,
          playbookTraceCount: 0,
          acceptanceDecisions: { passed: 0, warned: 0, failed: 0 },
        },
      },
      evidence: {
        run: stubRun,
        exportedAt: NOW,
        query: {},
        summary: {
          totalEvents: 0,
          byModule: {
            rules: 0,
            "node-runner": 0,
            acceptance: 0,
            retry: 0,
            playbook: 0,
          },
          retryTraceCount: 0,
          playbookTraceCount: 0,
          acceptanceDecisions: { passed: 0, warned: 0, failed: 0 },
        },
        events: [],
        playbook: { traces: [] },
        acceptance: { events: [] },
        retry: { events: [], traces: [] },
        correlation: { items: [] },
      },
    }),
    getRunEvidenceExport: () => ({
      export: {
        exportId: "exp-1",
        runId: "run-1",
        artifactId: "artifact-1",
        uri: "friday://workflow-runs/run-1/evidence-exports/exp-1.json",
        checksum: "checksum",
        createdAt: NOW,
        persisted: true,
        filePersisted: false,
        query: {},
        summary: {
          totalEvents: 0,
          byModule: {
            rules: 0,
            "node-runner": 0,
            acceptance: 0,
            retry: 0,
            playbook: 0,
          },
          retryTraceCount: 0,
          playbookTraceCount: 0,
          acceptanceDecisions: { passed: 0, warned: 0, failed: 0 },
        },
      },
      evidence: {
        run: stubRun,
        exportedAt: "2025-01-01T00:00:00Z",
        query: {},
        summary: {
          totalEvents: 0,
          byModule: {
            rules: 0,
            "node-runner": 0,
            acceptance: 0,
            retry: 0,
            playbook: 0,
          },
          retryTraceCount: 0,
          playbookTraceCount: 0,
          acceptanceDecisions: { passed: 0, warned: 0, failed: 0 },
        },
        events: [],
        playbook: { traces: [] },
        acceptance: { events: [] },
        retry: { events: [], traces: [] },
        correlation: { items: [] },
      },
    }),
    downloadRunEvidenceExport: () => ({
      export: {
        exportId: "exp-1",
        runId: "run-1",
        artifactId: "artifact-1",
        uri: "friday://workflow-runs/run-1/evidence-exports/exp-1.json",
        checksum: "checksum",
        createdAt: "2025-01-01T00:00:00Z",
        persisted: true,
        filePersisted: false,
        query: {},
        summary: {
          totalEvents: 0,
          byModule: {
            rules: 0,
            "node-runner": 0,
            acceptance: 0,
            retry: 0,
            playbook: 0,
          },
          retryTraceCount: 0,
          playbookTraceCount: 0,
          acceptanceDecisions: { passed: 0, warned: 0, failed: 0 },
        },
      },
      file: {
        uri: "friday://workflow-runs/run-1/evidence-exports/exp-1.json",
        exists: false,
      },
      content: "{}",
    }),
    cancelRun: async (_runId, _input, _principal) => ({ run: stubRun }),
    retryRun: async (_runId, _input, _principal) => ({ run: stubRun, retriedNodes: [] }),
    resumeRun: async (_runId, _principal) => ({ run: stubRun }),
  };

  const routes = createFridayWorkflowRunRoutes(stubDeps);

  it("registers 12 run routes", () => {
    expect(routes).toHaveLength(12);
  });

  it("POST /v1/workflow-runs requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "runs.start");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: true });
    expect(route!.rateLimitPolicyId).toBe("workflow.start_run");
  });

  it("GET /v1/workflow-runs/:runId requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "runs.get");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: true });
  });

  it("GET /v1/workflow-runs/:runId/evidence requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "runs.evidence");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/workflow-runs/:runId/evidence");
    expect(route!.auth).toEqual({ public: true });
  });

  it("POST /v1/workflow-runs/:runId/evidence/exports requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "runs.evidence.export");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.path).toBe("/v1/workflow-runs/:runId/evidence/exports");
    expect(route!.auth).toEqual({ public: true });
  });

  it("GET /v1/workflow-runs/:runId/evidence/exports/:exportId requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "runs.evidence.exports.get");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/workflow-runs/:runId/evidence/exports/:exportId");
    expect(route!.auth).toEqual({ public: true });
  });

  it("GET /v1/workflow-runs/:runId/evidence/exports/:exportId/download requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "runs.evidence.exports.download");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/workflow-runs/:runId/evidence/exports/:exportId/download");
    expect(route!.auth).toEqual({ public: true });
  });

  it("passes principal through to evidence handlers", async () => {
    const principal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "tenant-1",
      userId: "user-1",
      role: "viewer",
      scopes: ["workflow.read"],
      tokenId: "token-1",
      tokenKind: "access",
      issuedAt: NOW,
    };
    let seen: FridayAuthPrincipal | null = null;
    const localRoutes = createFridayWorkflowRunRoutes({
      ...stubDeps,
      getRunEvidence: (runId, query, p) => {
        seen = p;
        return stubDeps.getRunEvidence(runId, query, p);
      },
    });
    const route = localRoutes.find((r) => r.operationId === "runs.evidence");
    expect(route).toBeDefined();
    await route!.handler({
      params: { runId: "run-1" },
      query: {},
      body: null,
      headers: {},
      principal,
      requestId: "req-1",
      receivedAt: NOW,
    } as never);
    expect(seen).toEqual(principal);
  });

  it("passes principal through to run read and control handlers", async () => {
    const principal = makePrincipal({ principalId: "tenant-1" });
    const seen: Array<{ op: string; principal: FridayAuthPrincipal | null }> = [];
    const localRoutes = createFridayWorkflowRunRoutes({
      ...stubDeps,
      getRun: (_runId, p) => {
        seen.push({ op: "runs.get", principal: p });
        return { run: stubRun };
      },
      cancelRun: async (_runId, _input, p) => {
        seen.push({ op: "runs.cancel", principal: p });
        return { run: stubRun };
      },
    });

    const getRoute = localRoutes.find((r) => r.operationId === "runs.get");
    const cancelRoute = localRoutes.find((r) => r.operationId === "runs.cancel");
    expect(getRoute).toBeDefined();
    expect(cancelRoute).toBeDefined();

    await getRoute!.handler({
      params: { runId: "run-1" },
      query: {},
      body: null,
      headers: {},
      principal,
      requestId: "req-get",
      receivedAt: "2025-01-01T00:00:00Z",
    } as never);

    await cancelRoute!.handler({
      params: { runId: "run-1" },
      query: {},
      body: { reason: "test" },
      headers: {},
      principal,
      requestId: "req-cancel",
      receivedAt: "2025-01-01T00:00:00Z",
    } as never);

    expect(seen).toEqual([
      { op: "runs.get", principal },
      { op: "runs.cancel", principal },
    ]);
  });

  it.each([
    ["runs.start", { params: {}, body: { workflowId: "wf-1" } }],
    ["runs.evidence.export", { body: {} }],
    ["runs.cancel", { body: { reason: "test" } }],
    ["runs.retry", { body: {} }],
    ["workflows.runs.resume", {}],
  ])("%s rejects the synthetic public principal", async (operationId, ctxOverrides) => {
    const route = routes.find((r) => r.operationId === operationId)!;
    await expect(
      route.handler(makeCtx({
        ...ctxOverrides,
        principal: createFridayDefaultPublicHttpPrincipal(),
      })),
    ).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      httpStatus: 401,
    });
  });

  it.each([
    ["runs.start", { params: {}, body: { workflowId: "wf-1" } }],
    ["runs.evidence.export", { body: {} }],
    ["runs.cancel", { body: { reason: "test" } }],
    ["runs.retry", { body: {} }],
    ["workflows.runs.resume", {}],
  ])("%s rejects a bound principal without workflow write authority", async (operationId, ctxOverrides) => {
    const route = routes.find((r) => r.operationId === operationId)!;
    await expect(
      route.handler(makeCtx({
        ...ctxOverrides,
        principal: makePrincipal({ role: "viewer", scopes: ["workflow.read"] }),
      })),
    ).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_AUTHORITY_REQUIRED",
      httpStatus: 403,
    });
  });

  it("allows a bound workflow writer to start a run", async () => {
    const startRun = vi.fn(async () => ({ run: stubRun }));
    const localRoutes = createFridayWorkflowRunRoutes({
      ...stubDeps,
      startRun,
    });
    const route = localRoutes.find((r) => r.operationId === "runs.start")!;
    await expect(
      route.handler(makeCtx({ params: {}, body: { workflowId: "wf-1" } })),
    ).resolves.toEqual({ run: stubRun });
    expect(startRun).toHaveBeenCalledWith(
      { workflowId: "wf-1" },
      expect.objectContaining({ principalId: "user-1" }),
    );
  });

  it("POST /v1/workflow-runs/:runId/cancel requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "runs.cancel");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
  });

  it("POST /v1/workflow-runs/:runId/resume requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "workflows.runs.resume");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.path).toBe("/v1/workflow-runs/:runId/resume");
    expect(route!.auth).toEqual({ public: true });
  });
});
