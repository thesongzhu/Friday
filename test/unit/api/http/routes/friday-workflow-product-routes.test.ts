import { describe, expect, it, vi } from "vitest";
import type { FridayAuthPrincipal, FridayHttpContext } from "#api";
import { createFridayWorkflowProductRoutes } from "../../../../../src/api/http/routes/friday-workflow-product-routes.js";
import type { FridayWorkflowProductService } from "../../../../../src/workflows/services/friday-workflow-product-service.js";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";

const NOW = "2026-03-07T10:00:00.000Z";

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
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: makePrincipal(),
    ...overrides,
  };
}

function makeService(): FridayWorkflowProductService {
  return {
    deployDraft: vi.fn(async () => ({
      workflowId: "wf-1",
      draftId: "draft-1",
      workflowVersionId: "version-1",
      versionNumber: 2,
      published: true,
      triggerSync: { requested: true, synced: true },
      validation: { valid: true, issues: [], generatedAt: NOW },
      evidence: { traceSummary: "observed" },
    })),
    getOverview: vi.fn(() => ({
      workflow: { id: "wf-1", slug: "wf", name: "Workflow", tags: [], latestVersionNumber: 2, isArchived: false, revision: 1, etag: "wf-etag", createdAt: NOW, updatedAt: NOW },
      drafts: [],
      recentRuns: [],
      latestRunNodeTimeline: [],
      latestEvidenceExports: [],
      versionHistory: [],
    })),
    getVisualization: vi.fn(() => ({
      workflow: { id: "wf-1", slug: "wf", name: "Workflow", tags: [], latestVersionNumber: 2, isArchived: false, revision: 1, etag: "wf-etag", createdAt: NOW, updatedAt: NOW },
      targetKind: "draft",
      spec: { workflowId: "wf-1", name: "Workflow", steps: [], edges: [] },
      visual: { workflowId: "wf-1", viewport: { x: 0, y: 0, zoom: 1 }, panelLayout: { leftOpen: true, rightOpen: true, bottomOpen: false }, nodes: [], edges: [] },
      recentRuns: [],
      nodeTimeline: [],
      latestEvidenceExports: [],
    })),
    materializeGeneratedSession: vi.fn(),
  };
}

describe("createFridayWorkflowProductRoutes", () => {
  it("registers overview, visualization, and deploy routes", () => {
    const routes = createFridayWorkflowProductRoutes({
      service: makeService(),
      allowTestOnlyWorkflowDeployExecution: true,
    });
    expect(routes.map((route) => route.operationId)).toEqual([
      "workflows.overview",
      "workflows.visualization",
      "workflows.deploy",
    ]);
  });

  it("passes query options to overview and visualization", async () => {
    const service = makeService();
    const routes = createFridayWorkflowProductRoutes({
      service,
      allowTestOnlyWorkflowDeployExecution: true,
    });

    await routes[0]!.handler(
      makeCtx({
        params: { workflowId: "wf-1" },
        query: { recentRunLimit: "6" },
      }),
    );
    await routes[1]!.handler(
      makeCtx({
        params: { workflowId: "wf-1" },
        query: { draftId: "draft-1", timelineLimit: "12" },
      }),
    );

    expect(service.getOverview).toHaveBeenCalledWith({ workflowId: "wf-1", recentRunLimit: 6 });
    expect(service.getVisualization).toHaveBeenCalledWith({
      workflowId: "wf-1",
      draftId: "draft-1",
      versionId: undefined,
      timelineLimit: 12,
    });
  });

  it("deploys a draft with the authenticated actor", async () => {
    const service = makeService();
    const routes = createFridayWorkflowProductRoutes({
      service,
      allowTestOnlyWorkflowDeployExecution: true,
    });

    const result = await routes[2]!.handler(
      makeCtx({
        params: { workflowId: "wf-1", draftId: "draft-1" },
        body: { runNow: true, includeExport: true },
      }),
    ) as { deployment: { workflowId: string } };

    expect(service.deployDraft).toHaveBeenCalledWith({
      workflowId: "wf-1",
      draftId: "draft-1",
      actorUserId: "user-1",
      runNow: true,
      resyncTriggers: false,
      includeExport: true,
      changeNote: undefined,
      lockToken: undefined,
      ownerSessionId: undefined,
      lockTtlSec: undefined,
    });
    expect(result.deployment.workflowId).toBe("wf-1");
  });

  it("rejects synthetic public deploy before side effects", async () => {
    const service = makeService();
    const routes = createFridayWorkflowProductRoutes({
      service,
      allowTestOnlyWorkflowDeployExecution: true,
    });

    await expect(
      routes[2]!.handler(
        makeCtx({
          params: { workflowId: "wf-1", draftId: "draft-1" },
          principal: createFridayDefaultPublicHttpPrincipal(),
        }),
      ),
    ).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      httpStatus: 401,
    });
    expect(service.deployDraft).not.toHaveBeenCalled();
  });

  it("passes external review confirmation to deploy when present", async () => {
    const service = makeService();
    const routes = createFridayWorkflowProductRoutes({
      service,
      allowTestOnlyWorkflowDeployExecution: true,
    });

    await routes[2]!.handler(
      makeCtx({
        params: { workflowId: "wf-1", draftId: "draft-1" },
        body: { externalReviewConfirmed: true },
      }),
    );

    expect(service.deployDraft).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "wf-1",
      draftId: "draft-1",
      externalReviewConfirmed: true,
    }));
  });

  it("fail-closes workflow deploy by default before TS service calls", async () => {
    const service = makeService();
    const routes = createFridayWorkflowProductRoutes({ service });

    await expect(
      routes[2]!.handler(
        makeCtx({
          params: { workflowId: "wf-1", draftId: "draft-1" },
          body: { runNow: true },
        }),
      ),
    ).rejects.toMatchObject({
      code: "TS_RUNTIME_WORKFLOW_DEPLOY_RETIRED",
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_deployment_entrypoint_required",
      },
    });
    expect(service.deployDraft).not.toHaveBeenCalled();
  });
});
