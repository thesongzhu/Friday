import { describe, expect, it, vi } from "vitest";

import { createFridayGuideLensRoutes } from "../../../../../src/api/http/routes/friday-guide-lens-routes.js";
import type { FridayRouteDefinition } from "../../../../../src/api/model/friday-api-common.types.js";
import type { FridayGuideLensService } from "../../../../../src/guide-lens/model/friday-guide-lens.types.js";

function makeService(): FridayGuideLensService {
  return {
    getState: vi.fn().mockReturnValue({ preferences: {}, sessions: [] }),
    updatePreferences: vi.fn().mockReturnValue({ enabled: true }),
    updateAvatar: vi.fn().mockReturnValue({ kind: "default_f", initials: "F", sizePx: 56 }),
    captureSnapshot: vi.fn().mockResolvedValue({ session: { id: "s-1" }, uiMap: { id: "map-1" } }),
    resolveTarget: vi.fn().mockResolvedValue({ status: "resolved" }),
    showOverlay: vi.fn().mockResolvedValue({ id: "overlay-1" }),
    clearOverlay: vi.fn().mockResolvedValue({ cleared: true, clearedAt: "2026-04-28T09:00:00.000Z" }),
    analyzeScreenshot: vi.fn().mockResolvedValue({ intent: "permission" }),
    verify: vi.fn().mockResolvedValue({ status: "passed" }),
    assertReadOnlyAction: vi.fn((action: string) => {
      if (/click|type|scroll/i.test(action)) {
        throw new Error("read-only violation");
      }
    }),
  } as unknown as FridayGuideLensService;
}

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    requestId: "req-001",
    receivedAt: "2026-04-28T09:00:00.000Z",
    params: {},
    query: {},
    body: {},
    headers: {},
    ip: "127.0.0.1",
    userAgent: "vitest",
    principal: {
      principalType: "user",
      principalId: "u-1",
      userId: "u-1",
      role: "admin",
      scopes: ["desktop.read", "desktop.write"],
      tokenId: "t-1",
      tokenKind: "access",
      issuedAt: "2026-04-28T09:00:00.000Z",
    },
    ...overrides,
  } as Parameters<FridayRouteDefinition<unknown, unknown, unknown, unknown>["handler"]>[0];
}

function findRoute(
  routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[],
  operationId: string,
): FridayRouteDefinition<unknown, unknown, unknown, unknown> {
  const route = routes.find((entry) => entry.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route;
}

describe("createFridayGuideLensRoutes", () => {
  it("returns canonical authenticated route definitions", () => {
    const routes = createFridayGuideLensRoutes({ service: makeService() });

    expect(routes.map((route) => route.operationId)).toEqual([
      "guidelens.state.get",
      "guidelens.snapshot.create",
      "guidelens.targets.resolve",
      "guidelens.overlay.show",
      "guidelens.overlay.clear",
      "guidelens.screenshots.analyze",
      "guidelens.verifications.create",
      "guidelens.preferences.update",
      "guidelens.avatar.update",
    ]);
    expect(routes.every((route) => route.path.startsWith("/v1/guide-lens"))).toBe(true);
  });

  it("keeps read-only state available by default", async () => {
    const service = makeService();
    const route = findRoute(createFridayGuideLensRoutes({ service }), "guidelens.state.get");

    await expect(route.handler(makeCtx())).resolves.toEqual({ preferences: {}, sessions: [] });

    expect(service.getState).toHaveBeenCalledOnce();
  });

  it("fails closed for guide-lens action routes by default", async () => {
    const service = makeService();
    const routes = createFridayGuideLensRoutes({ service })
      .filter((route) => route.operationId !== "guidelens.state.get");

    for (const route of routes) {
      await expect(route.handler(makeCtx({
        body: {
          instruction: "Continue",
          message: "Continue",
        },
        query: {
          sessionId: "s-1",
        },
      }))).rejects.toThrow("guide-lens routes are fail-closed");
    }

    expect(service.captureSnapshot).not.toHaveBeenCalled();
    expect(service.resolveTarget).not.toHaveBeenCalled();
    expect(service.showOverlay).not.toHaveBeenCalled();
    expect(service.clearOverlay).not.toHaveBeenCalled();
    expect(service.analyzeScreenshot).not.toHaveBeenCalled();
    expect(service.verify).not.toHaveBeenCalled();
    expect(service.updatePreferences).not.toHaveBeenCalled();
    expect(service.updateAvatar).not.toHaveBeenCalled();
  });

  it("validates target instructions and delegates to the service", async () => {
    const service = makeService();
    const route = findRoute(createFridayGuideLensRoutes({
      service,
      allowTestOnlyGuideLensExecution: true,
    }), "guidelens.targets.resolve");

    await expect(route.handler(makeCtx({ body: {} }))).rejects.toThrow("instruction is required");
    await route.handler(makeCtx({ body: { instruction: "Continue" } }));

    expect(service.resolveTarget).toHaveBeenCalledWith({ instruction: "Continue" });
  });

  it("rejects mutating overlay messages before delegating", async () => {
    const service = makeService();
    const route = findRoute(createFridayGuideLensRoutes({
      service,
      allowTestOnlyGuideLensExecution: true,
    }), "guidelens.overlay.show");

    await expect(route.handler(makeCtx({ body: { message: "click the button" } }))).rejects.toThrow("read-only violation");
    expect(service.showOverlay).not.toHaveBeenCalled();
  });

  it("updates avatar through the avatar route", async () => {
    const service = makeService();
    const route = findRoute(createFridayGuideLensRoutes({
      service,
      allowTestOnlyGuideLensExecution: true,
    }), "guidelens.avatar.update");

    await route.handler(makeCtx({ body: { kind: "local_image", localPath: "/tmp/avatar.png" } }));

    expect(service.updateAvatar).toHaveBeenCalledWith({
      kind: "local_image",
      localPath: "/tmp/avatar.png",
    });
  });
});
