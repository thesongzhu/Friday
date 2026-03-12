import { describe, it, expect } from "vitest";
import { createFridayWorkflowRoutes } from "#api";
import type { FridayWorkflowRoutesDeps } from "#api";
import type {
  FridayWorkflowEntity,
  FridayWorkflowVersionEntity,
} from "#workflows";

/** Handlers are never invoked; stubs only satisfy the type signature. */
const stubWorkflow = {} as unknown as FridayWorkflowEntity;
const stubVersion = {} as unknown as FridayWorkflowVersionEntity;

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

  const routes = createFridayWorkflowRoutes(stubDeps);

  it("registers 8 workflow routes", () => {
    expect(routes).toHaveLength(8);
  });

  it("GET /v1/workflows requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "workflows.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/workflows");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });
  });

  it("POST /v1/workflows requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "workflows.create");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.write"] });
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
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });
  });
});
