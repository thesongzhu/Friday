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

  describe("DARK Rust catalog-mutation route bridge (routeWorkflowsViaRust)", () => {
    /** A scripted-stub bridge that records the mutate call + returns a fixed refs-only receipt. */
    function makeStubBridge() {
      const calls: unknown[] = [];
      return {
        calls,
        mutateCatalog: vi.fn(async (input: unknown) => {
          calls.push(input);
          return {
            truthLabel: "rust_wired_dev" as const,
            proofOnly: true as const,
            op: (input as { op: string }).op,
            workflowId: (input as { workflowId: string }).workflowId,
            slugSha256: "00",
            slugLen: 2,
            nameSha256: "11",
            nameLen: 3,
            descriptionSha256: null,
            descriptionLen: null,
            tagsJsonSha256: "22",
            tagsJsonLen: 2,
            isArchived: false,
            revision: 2,
            etag: "e".repeat(64),
            deployedVersion: null,
            createdAtMs: 100,
            updatedAtMs: 200,
          };
        }),
      };
    }

    function flagOnRoutes(bridge: ReturnType<typeof makeStubBridge>) {
      return createFridayWorkflowRoutes({
        ...stubDeps,
        // The test-oracle stays OFF: the Rust branch must be a SEPARATE path, not the oracle.
        routeWorkflowsViaRust: true,
        rustWorkflowCatalogBridge: bridge,
      });
    }

    it("flag-OFF is byte-identical to today's retirement 503 (bridge never consulted)", async () => {
      const bridge = makeStubBridge();
      // Flag unset entirely → today's path: retirement 503 BEFORE any bridge call.
      const routes = createFridayWorkflowRoutes({
        ...stubDeps,
        rustWorkflowCatalogBridge: bridge, // present but must NOT be consulted
      });
      for (const op of ["workflows.update", "workflows.archive", "workflows.publish"]) {
        const route = routes.find((r) => r.operationId === op)!;
        await expect(
          route.handler(makeCtx({ params: { workflowId: "wf-1" }, body: { expectedRevision: 1, versionNumber: 1 } })),
        ).rejects.toMatchObject({
          code: "TS_RUNTIME_WORKFLOW_CATALOG_MUTATION_RETIRED",
          httpStatus: 503,
        });
      }
      expect(bridge.mutateCatalog).not.toHaveBeenCalled();
    });

    it("flag-ON still enforces auth BEFORE routing to the bridge", async () => {
      const bridge = makeStubBridge();
      const route = flagOnRoutes(bridge).find((r) => r.operationId === "workflows.update")!;
      await expect(
        route.handler(makeCtx({
          principal: makePrincipal({ role: "viewer", scopes: ["workflow.read"] }),
          params: { workflowId: "wf-1" },
          body: { expectedRevision: 1 },
        })),
      ).rejects.toMatchObject({ httpStatus: 403 });
      // Auth rejected → the bridge was NEVER consulted.
      expect(bridge.mutateCatalog).not.toHaveBeenCalled();
    });

    it("flag-ON update routes an authorized request to the bridge (refs-only response)", async () => {
      const bridge = makeStubBridge();
      const route = flagOnRoutes(bridge).find((r) => r.operationId === "workflows.update")!;
      const res = await route.handler(makeCtx({
        params: { workflowId: "wf-1" },
        body: { expectedRevision: 1, name: "Renamed", tags: ["a", "b"] },
      }));
      expect(res).toMatchObject({ routedVia: "rust_hub_workflow_catalog" });
      expect(bridge.mutateCatalog).toHaveBeenCalledTimes(1);
      expect(bridge.calls[0]).toMatchObject({
        op: "update",
        workflowId: "wf-1",
        expectedRevision: 1,
        name: "Renamed",
        tagsJson: JSON.stringify(["a", "b"]),
      });
    });

    it("flag-ON update REJECTS a graph (definition) change (fail-closed divergence)", async () => {
      const bridge = makeStubBridge();
      const route = flagOnRoutes(bridge).find((r) => r.operationId === "workflows.update")!;
      await expect(
        route.handler(makeCtx({
          params: { workflowId: "wf-1" },
          body: { expectedRevision: 1, graph: { nodes: [], edges: [] } },
        })),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 });
      expect(bridge.mutateCatalog).not.toHaveBeenCalled();
    });

    it("flag-ON archive REQUIRES expectedRevision in the body (fail-closed contract)", async () => {
      const bridge = makeStubBridge();
      const route = flagOnRoutes(bridge).find((r) => r.operationId === "workflows.archive")!;
      await expect(
        route.handler(makeCtx({ params: { workflowId: "wf-1" }, body: {} })),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 });
      expect(bridge.mutateCatalog).not.toHaveBeenCalled();
      // With expectedRevision present it routes through.
      const res = await route.handler(makeCtx({ params: { workflowId: "wf-1" }, body: { expectedRevision: 3 } }));
      expect(res).toMatchObject({ routedVia: "rust_hub_workflow_catalog" });
      expect(bridge.calls.at(-1)).toMatchObject({ op: "archive", workflowId: "wf-1", expectedRevision: 3 });
    });

    it("flag-ON publish REQUIRES versionNumber in the body (fail-closed contract)", async () => {
      const bridge = makeStubBridge();
      const route = flagOnRoutes(bridge).find((r) => r.operationId === "workflows.publish")!;
      await expect(
        route.handler(makeCtx({ params: { workflowId: "wf-1" }, body: {} })),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 });
      expect(bridge.mutateCatalog).not.toHaveBeenCalled();
      const res = await route.handler(makeCtx({ params: { workflowId: "wf-1" }, body: { versionNumber: 2 } }));
      expect(res).toMatchObject({ routedVia: "rust_hub_workflow_catalog" });
      expect(bridge.calls.at(-1)).toMatchObject({ op: "publish", workflowId: "wf-1", version: 2 });
    });

    it("flag-ON with NO bridge configured fails closed (503)", async () => {
      const routes = createFridayWorkflowRoutes({ ...stubDeps, routeWorkflowsViaRust: true });
      const route = routes.find((r) => r.operationId === "workflows.publish")!;
      await expect(
        route.handler(makeCtx({ params: { workflowId: "wf-1" }, body: { versionNumber: 1 } })),
      ).rejects.toMatchObject({
        code: "TS_RUNTIME_WORKFLOW_CATALOG_RUST_BRIDGE_UNAVAILABLE",
        httpStatus: 503,
      });
    });

    it("flag-ON create routes an authorized request to the bridge (refs-only response)", async () => {
      const bridge = makeStubBridge();
      const route = flagOnRoutes(bridge).find((r) => r.operationId === "workflows.create")!;
      const graph = { nodes: [{ id: "trigger1", type: "trigger" }], edges: [] };
      const res = await route.handler(makeCtx({
        body: {
          slug: "wf",
          name: "Workflow",
          description: "Closure workflow",
          tags: ["closure", "rust"],
          graph,
        },
      }));
      expect(res).toMatchObject({ routedVia: "rust_hub_workflow_catalog" });
      expect(bridge.mutateCatalog).toHaveBeenCalledTimes(1);
      expect(bridge.calls[0]).toMatchObject({
        op: "create",
        workflowId: expect.any(String),
        slug: "wf",
        name: "Workflow",
        description: "Closure workflow",
        tagsJson: JSON.stringify(["closure", "rust"]),
      });
      const createInput = bridge.calls[0] as { defJson?: string };
      expect(createInput.defJson).toBeDefined();
      const rustDefinition = JSON.parse(createInput.defJson!);
      expect(rustDefinition).toMatchObject({
        schema_version: 1,
        name: "Workflow",
        steps: [
          expect.objectContaining({
            id: "trigger1",
            action: "read_file",
            params: [["path", "README.md"]],
            force_checkpoint: false,
            evidence_required: false,
          }),
        ],
      });
      expect(rustDefinition).not.toHaveProperty("schemaVersion");
      expect(rustDefinition).not.toHaveProperty("graph");
    });
  });
});
