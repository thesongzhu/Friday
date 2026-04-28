import { describe, expect, it, vi } from "vitest";

import { createFridayStudioRoutes } from "../../../../../src/api/http/routes/friday-studio-routes.js";
import type { FridayRouteDefinition } from "../../../../../src/api/model/friday-api-common.types.js";
import type { FridayStudioService } from "../../../../../src/studio/friday-studio-service.js";

function makeService(): FridayStudioService {
  return {
    listProducts: vi.fn().mockReturnValue([{ id: "seo_audit" }]),
    runProduct: vi.fn().mockResolvedValue({ id: "run-1", productId: "seo_audit", status: "completed" }),
    getRun: vi.fn().mockReturnValue({ id: "run-1", productId: "seo_audit", status: "completed" }),
    getArtifact: vi.fn().mockReturnValue({ artifact: { id: "report" }, content: "ok", encoding: "utf-8" }),
    exportRun: vi.fn().mockReturnValue({ fileName: "run.zip", mimeType: "application/zip", base64: "eA==", sizeBytes: 1 }),
    importLocalPack: vi.fn().mockReturnValue({ pack: { id: "pack-1", name: "Pack" }, checks: [] }),
  } as unknown as FridayStudioService;
}

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    requestId: "req-001",
    receivedAt: "2026-04-28T00:00:00.000Z",
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: {
      principalType: "user",
      principalId: "u-1",
      userId: "u-1",
      role: "admin",
      scopes: ["agent.read", "agent.run"],
      tokenId: "t-1",
      tokenKind: "access",
      issuedAt: "2026-04-28T00:00:00.000Z",
    },
    ...overrides,
  } as Parameters<FridayRouteDefinition<unknown, unknown, unknown, unknown>["handler"]>[0];
}

function findRoute(
  routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[],
  operationId: string,
): FridayRouteDefinition<unknown, unknown, unknown, unknown> {
  const route = routes.find((entry) => entry.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route;
}

describe("createFridayStudioRoutes", () => {
  it("registers authenticated Studio routes under /v1/studio", () => {
    const routes = createFridayStudioRoutes({ service: makeService() });

    expect(routes.map((route) => route.operationId)).toEqual([
      "studio.products.list",
      "studio.runs.create",
      "studio.runs.get",
      "studio.artifacts.get",
      "studio.runs.export",
      "studio.imports.create",
    ]);
    for (const route of routes) {
      expect(route.path).toMatch(/^\/v1\/studio/);
      expect((route.auth as { public: boolean }).public).toBe(false);
    }
  });

  it("validates run creation body before delegating", async () => {
    const service = makeService();
    const route = findRoute(createFridayStudioRoutes({ service }), "studio.runs.create");

    await expect(route.handler(makeCtx({ body: {} }))).rejects.toThrow("productId is required");
    await route.handler(makeCtx({ body: { productId: "seo_audit", inputs: { url: "https://example.com" }, locale: "zh" } }));

    expect(service.runProduct).toHaveBeenCalledWith({
      productId: "seo_audit",
      inputs: { url: "https://example.com" },
      locale: "zh",
      deliveryTarget: undefined,
    });
  });

  it("delegates artifact, export, and import requests", async () => {
    const service = makeService();
    const routes = createFridayStudioRoutes({ service });

    await findRoute(routes, "studio.artifacts.get").handler(makeCtx({
      params: { runId: "00000000-0000-4000-8000-000000000001", artifactId: "report" },
    }));
    await findRoute(routes, "studio.runs.export").handler(makeCtx({
      params: { runId: "00000000-0000-4000-8000-000000000001" },
    }));
    await findRoute(routes, "studio.imports.create").handler(makeCtx({
      body: { kind: "directory", files: [{ relativePath: "pack.json", content: "{}" }] },
    }));

    expect(service.getArtifact).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", "report");
    expect(service.exportRun).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    expect(service.importLocalPack).toHaveBeenCalledWith({
      kind: "directory",
      files: [{ relativePath: "pack.json", content: "{}" }],
    });
  });
});
