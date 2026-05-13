import { describe, expect, it, vi } from "vitest";

import type { FridayHttpContext } from "#api";
import {
  createFridaySecretRoutes,
  type FridaySecretRoutesDeps,
} from "#api";

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

function makeDeps(): FridaySecretRoutesDeps {
  return {
    service: {
      listSecrets: vi.fn(() => []),
      getSecret: vi.fn(() => null),
      createSecret: vi.fn(() => ({
        id: "secret-1",
        scope: "provider",
        refKey: "provider:openai:key",
        keyId: "master-v1",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      })),
      updateSecret: vi.fn(() => ({
        id: "secret-1",
        scope: "provider",
        refKey: "provider:openai:key",
        keyId: "master-v1",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:01.000Z",
      })),
      deleteSecret: vi.fn(() => true),
    },
  };
}

describe("FridaySecretRoutes", () => {
  it("registers all secret CRUD routes", () => {
    const routes = createFridaySecretRoutes(makeDeps());
    expect(routes.map((route) => route.operationId)).toEqual([
      "secrets.list",
      "secrets.get",
      "secrets.create",
      "secrets.update",
      "secrets.delete",
    ]);
  });

  it("uses secrets.* scopes while preserving security.* compatibility", () => {
    const routes = createFridaySecretRoutes(makeDeps());
    expect(routes.find((route) => route.operationId === "secrets.list")?.auth).toEqual({ public: true });
    expect(routes.find((route) => route.operationId === "secrets.create")?.auth).toEqual({ public: true });
  });

  it("delegates list filters", async () => {
    const deps = makeDeps();
    const route = createFridaySecretRoutes(deps).find((entry) => entry.operationId === "secrets.list")!;
    await route.handler(makeCtx({ query: { scope: "provider", refKey: "openai", limit: "20" } }));
    expect(deps.service.listSecrets).toHaveBeenCalledWith({
      scope: "provider",
      refKey: "openai",
      limit: 20,
    });
  });

  it("throws when a secret lookup misses", async () => {
    const route = createFridaySecretRoutes(makeDeps()).find((entry) => entry.operationId === "secrets.get")!;
    await expect(
      route.handler(makeCtx({ params: { secretId: "missing" } })), // pragma: allowlist secret
    ).rejects.toThrow("Secret not found");
  });

  it("validates create body", async () => {
    const route = createFridaySecretRoutes(makeDeps()).find((entry) => entry.operationId === "secrets.create")!;
    await expect(route.handler(makeCtx({ body: { scope: "provider", refKey: "", value: "x" } }))).rejects.toThrow(
      "refKey is required",
    );
  });

  it("updates with partial payloads", async () => {
    const deps = makeDeps();
    const route = createFridaySecretRoutes(deps).find((entry) => entry.operationId === "secrets.update")!;
    await route.handler(
      makeCtx({ params: { secretId: "secret-1" }, body: { value: "next-secret" } }), // pragma: allowlist secret
    );
    expect(deps.service.updateSecret).toHaveBeenCalledWith("secret-1", { value: "next-secret" }); // pragma: allowlist secret
  });

  it("returns deleted flag", async () => {
    const deps = makeDeps();
    const route = createFridaySecretRoutes(deps).find((entry) => entry.operationId === "secrets.delete")!;
    const result = await route.handler(makeCtx({ params: { secretId: "secret-1" } })); // pragma: allowlist secret
    expect(result).toEqual({ deleted: true });
    expect(deps.service.deleteSecret).toHaveBeenCalledWith("secret-1"); // pragma: allowlist secret
  });
});
