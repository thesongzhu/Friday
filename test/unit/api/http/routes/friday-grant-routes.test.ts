import { describe, expect, it, vi } from "vitest";

import { createFridayGrantRoutes, type FridayGrantRoutesDeps } from "#api";

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
});
