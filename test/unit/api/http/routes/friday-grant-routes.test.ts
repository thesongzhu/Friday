import { describe, expect, it, vi } from "vitest";

import { createFridayGrantRoutes, type FridayGrantRoutesDeps } from "#api";
import type { FridayAuthPrincipal, FridayHttpContext } from "#api";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";

const NOW = "2026-05-22T00:00:00.000Z";

function makePrincipal(overrides: Partial<FridayAuthPrincipal> = {}): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "user-1",
    userId: "user-1",
    role: "admin",
    scopes: ["hub.admin", "security.write"],
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
    params: { grantId: "grant-1" },
    query: {},
    body: {},
    headers: {},
    principal: makePrincipal(),
    ...overrides,
  };
}

function createDeps(): FridayGrantRoutesDeps {
  return {
    listActiveGrants: vi.fn(async () => [
      {
        id: "grant-1",
        principalId: "user-1",
        target: "shell",
        scopes: ["exec"],
        issuedAt: "2026-04-08T00:00:00.000Z",
        toolName: "shell",
      },
    ]),
    revokeGrant: vi.fn(async () => ({ revoked: true })),
  };
}

describe("createFridayGrantRoutes", () => {
  it("returns an array of route definitions", () => {
    const routes = createFridayGrantRoutes(createDeps());
    expect(Array.isArray(routes)).toBe(true);
    expect(routes.length).toBe(2);
  });

  it("routes have correct operationIds", () => {
    const routes = createFridayGrantRoutes(createDeps());
    const operationIds = routes.map((r) => r.operationId);
    expect(operationIds).toEqual(["grants.list", "grants.revoke"]);
  });

  it("routes have correct methods and paths", () => {
    const routes = createFridayGrantRoutes(createDeps());

    const listRoute = routes.find((r) => r.operationId === "grants.list")!;
    expect(listRoute.method).toBe("GET");
    expect(listRoute.path).toBe("/v1/grants");

    const revokeRoute = routes.find((r) => r.operationId === "grants.revoke")!;
    expect(revokeRoute.method).toBe("POST");
    expect(revokeRoute.path).toBe("/v1/grants/:grantId/revoke");
  });

  it("rejects anonymous synthetic public grant revoke before delegating", async () => {
    const deps = createDeps();
    const route = createFridayGrantRoutes(deps).find((r) => r.operationId === "grants.revoke")!;

    await expect(
      route.handler(makeCtx({ principal: createFridayDefaultPublicHttpPrincipal() })),
    ).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      httpStatus: 401,
    });
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });

  it("passes the bound principal into grant revoke for owner/admin checks", async () => {
    const deps = createDeps();
    const route = createFridayGrantRoutes(deps).find((r) => r.operationId === "grants.revoke")!;
    const principal = makePrincipal({ principalId: "owner-1", userId: "owner-1" });

    await expect(
      route.handler(makeCtx({
        principal,
        body: { reason: "operator cleanup" },
      })),
    ).resolves.toEqual({ revoked: true });
    expect(deps.revokeGrant).toHaveBeenCalledWith("grant-1", "operator cleanup", principal);
  });
});
