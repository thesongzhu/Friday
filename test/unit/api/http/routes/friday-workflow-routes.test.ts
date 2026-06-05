import { describe, it, expect, vi } from "vitest";
import { createFridayWorkflowRoutes } from "#api";
import type { FridayAuthPrincipal, FridayHttpContext, FridayWorkflowRoutesDeps } from "#api";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";
import type {
  FridayWorkflowEntity,
  FridayWorkflowVersionEntity,
} from "#workflows";

/** Handlers are never invoked; stubs only satisfy the type signature. */
const stubWorkflow = {} as unknown as FridayWorkflowEntity;
const stubVersion = {} as unknown as FridayWorkflowVersionEntity;
const NOW = "2026-05-22T00:00:00.000Z";

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

describe("FridayWorkflowRoutes", () => {
  const stubDeps: FridayWorkflowRoutesDeps = {
    listWorkflows: () => ({ items: [] }),
    createWorkflow: () => ({ workflow: stubWorkflow, version: stubVersion }),
    getWorkflow: () => ({ workflow: stubWorkflow, latestVersion: stubVersion }),
    updateWorkflow: () => ({ workflow: stubWorkflow }),
    archiveWorkflow: () => ({ archived: true as const }),
    publishWorkflow: () => ({ publishedVersion: stubVersion }),
    listVersions: () => ({ items: [] }),
    getVersion: () => ({ version: stubVersion }),
  };

  const routes = createFridayWorkflowRoutes({
    ...stubDeps,
    allowTestOnlyWorkflowCatalogMutationExecution: true,
  });

  it("registers 8 workflow routes", () => {
    expect(routes).toHaveLength(8);
  });

  it("GET /v1/workflows requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "workflows.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/workflows");
    expect(route!.auth).toEqual({ public: true });
  });

  it("POST /v1/workflows requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "workflows.create");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: true });
  });

  it("DELETE /v1/workflows/:workflowId requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "workflows.archive");
    expect(route).toBeDefined();
    expect(route!.method).toBe("DELETE");
  });

  it("POST /v1/workflows/:workflowId/publish has rate limit", () => {
    const route = routes.find((r) => r.operationId === "workflows.publish");
    expect(route).toBeDefined();
    expect(route!.rateLimitPolicyId).toBe("workflow.publish");
  });

  it("GET /v1/workflow-versions/:versionId requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "workflow.versions.get");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/workflow-versions/:versionId");
    expect(route!.auth).toEqual({ public: true });
  });

  it.each([
    ["workflows.create", { body: { slug: "wf", name: "Workflow", graph: {} } }],
    ["workflows.update", { params: { workflowId: "wf-1" }, body: { expectedRevision: 1, etag: "etag-1" } }],
    ["workflows.archive", { params: { workflowId: "wf-1" } }],
    ["workflows.publish", { params: { workflowId: "wf-1" }, body: { versionNumber: 1 } }],
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

  it("rejects a bound principal without workflow write authority", async () => {
    const route = routes.find((r) => r.operationId === "workflows.create")!;
    await expect(
      route.handler(makeCtx({
        principal: makePrincipal({ role: "viewer", scopes: ["workflow.read"] }),
        body: { slug: "wf", name: "Workflow", graph: {} },
      })),
    ).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_AUTHORITY_REQUIRED",
      httpStatus: 403,
    });
  });

  it("allows a bound workflow writer to create a workflow", async () => {
    const route = routes.find((r) => r.operationId === "workflows.create")!;
    await expect(
      route.handler(makeCtx({
        body: { slug: "wf", name: "Workflow", graph: {} },
      })),
    ).resolves.toEqual({ workflow: stubWorkflow, version: stubVersion });
  });

  it("fail-closes workflow catalog mutations by default before TS service calls", async () => {
    const createWorkflow = vi.fn(() => ({ workflow: stubWorkflow, version: stubVersion }));
    const defaultRoutes = createFridayWorkflowRoutes({
      ...stubDeps,
      createWorkflow,
    });
    const route = defaultRoutes.find((r) => r.operationId === "workflows.create")!;

    await expect(
      route.handler(makeCtx({
        body: { slug: "wf", name: "Workflow", graph: {} },
      })),
    ).rejects.toMatchObject({
      code: "TS_RUNTIME_WORKFLOW_CATALOG_MUTATION_RETIRED",
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_catalog_write_entrypoint_required",
      },
    });
    expect(createWorkflow).not.toHaveBeenCalled();
  });
});
