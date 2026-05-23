import { describe, expect, it, vi } from "vitest";

import type { FridayHttpContext } from "#api";
import {
  createFridayRuntimeAdminRoutes,
  type FridayRuntimeAdminRoutesDeps,
} from "#api";
import type { FridayAuthPrincipal } from "#api";

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-1",
    receivedAt: "2026-03-08T00:00:00.000Z",
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: null,
    ...overrides,
  };
}

function makeAdminPrincipal(
  overrides: Partial<FridayAuthPrincipal> = {},
): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "user-1",
    userId: "user-1",
    role: "admin",
    scopes: ["hub.admin"],
    tokenId: "token-1",
    tokenKind: "access",
    issuedAt: "2026-03-08T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(): FridayRuntimeAdminRoutesDeps {
  return {
    version: {
      get: vi.fn(() => ({ version: "1.2.3", apiVersion: "v1" as const })),
    },
    config: {
      get: vi.fn(() => ({
        revision: 3,
        settings: { "feature.flag": true },
        currentConfig: {
          channels: {},
        } as never,
      })),
      update: vi.fn(() => ({
        revision: 4,
        changedKeys: ["feature.flag"],
        validation: { valid: true as const, errors: [] as [] },
      })),
      listRevisions: vi.fn(() => ({ items: [] })),
      revert: vi.fn(() => ({
        revision: 5,
        changedKeys: ["feature.flag"],
        revertedFrom: 4,
      })),
    },
    auditLogs: {
      list: vi.fn(() => ({ items: [], total: 0 })),
    },
  };
}

describe("FridayRuntimeAdminRoutes", () => {
  it("registers runtime admin routes", () => {
    const routes = createFridayRuntimeAdminRoutes(makeDeps());
    expect(routes.map((route) => route.operationId)).toEqual([
      "version.get",
      "config.get",
      "config.update",
      "config.revisions.list",
      "config.revisions.revert",
      "audit.logs.list",
    ]);
  });

  it("version route is public", async () => {
    const deps = makeDeps();
    const route = createFridayRuntimeAdminRoutes(deps)[0]!;
    expect(route.auth).toEqual({ public: true });
    const result = await route.handler(makeCtx());
    expect(result).toEqual({ version: "1.2.3", apiVersion: "v1" });
    expect(deps.version.get).toHaveBeenCalledTimes(1);
  });

  it("config.get parses comma-separated keys", async () => {
    const deps = makeDeps();
    const route = createFridayRuntimeAdminRoutes(deps).find((entry) => entry.operationId === "config.get")!;
    await route.handler(makeCtx({ query: { keys: "feature.flag,feature.beta" } }));
    expect(deps.config!.get).toHaveBeenCalledWith({
      keys: ["feature.flag", "feature.beta"],
    });
  });

  it("config.update validates expectedRevision and patch", async () => {
    const deps = makeDeps();
    const route = createFridayRuntimeAdminRoutes(deps).find((entry) => entry.operationId === "config.update")!;
    await route.handler(makeCtx({
      principal: makeAdminPrincipal(),
      body: {
        expectedRevision: 3,
        patch: { "feature.flag": false },
        reason: "Disable flag",
      },
    }));
    expect(deps.config!.update).toHaveBeenCalledWith({
      expectedRevision: 3,
      patch: { "feature.flag": false },
      reason: "Disable flag",
    });
  });

  it("config.update refuses the synthetic public principal before mutation", async () => {
    const deps = makeDeps();
    const route = createFridayRuntimeAdminRoutes(deps).find((entry) => entry.operationId === "config.update")!;
    let thrown: unknown;
    try {
      await route.handler(makeCtx({
        principal: { principalId: "public:default" } as never,
        body: {
          expectedRevision: 3,
          patch: { "feature.flag": false },
        },
      }));
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");
    expect(deps.config!.update).not.toHaveBeenCalled();
  });

  it("config.revisions.revert requires a bound admin principal", async () => {
    const deps = makeDeps();
    const route = createFridayRuntimeAdminRoutes(deps).find((entry) => entry.operationId === "config.revisions.revert")!;
    await route.handler(makeCtx({
      principal: makeAdminPrincipal(),
      body: { toRevision: 3 },
    }));
    expect(deps.config!.revert).toHaveBeenCalledWith({ toRevision: 3 });
  });

  it("config.revisions.revert refuses a bound principal without admin authority", async () => {
    const deps = makeDeps();
    const route = createFridayRuntimeAdminRoutes(deps).find((entry) => entry.operationId === "config.revisions.revert")!;
    let thrown: unknown;
    try {
      await route.handler(makeCtx({
        principal: makeAdminPrincipal({ role: "viewer", scopes: ["workflow.read"] }),
        body: { toRevision: 3 },
      }));
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe("OWNER_SESSION_CHANNEL_AUTHORITY_REQUIRED");
    expect(deps.config!.revert).not.toHaveBeenCalled();
  });

  it("config.revisions.revert requires positive revision", async () => {
    const route = createFridayRuntimeAdminRoutes(makeDeps()).find((entry) => entry.operationId === "config.revisions.revert")!;
    await expect(route.handler(makeCtx({
      principal: makeAdminPrincipal(),
      body: { toRevision: 0 },
    }))).rejects.toThrow(
      "toRevision must be a positive integer",
    );
  });

  it("audit.logs.list delegates query", async () => {
    const deps = makeDeps();
    const route = createFridayRuntimeAdminRoutes(deps).find((entry) => entry.operationId === "audit.logs.list")!;
    await route.handler(makeCtx({ query: { module: "learning", outcome: "failure" } }));
    expect(deps.auditLogs!.list).toHaveBeenCalledWith({ module: "learning", outcome: "failure" });
  });
});
