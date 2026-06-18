/**
 * B-008 Packaging Routes — Contract Tests
 *
 * Validates route registration, auth scopes, request validation,
 * and handler delegation for packages, installs, lifecycle events,
 * and trusted key management.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createFridayPackagingRoutes,
  type FridayPackagingRoutesDeps,
} from "../../../../../src/api/http/routes/friday-packaging-routes.js";
import type {
  FridayRouteDefinition,
  FridayHttpContext,
} from "../../../../../src/api/model/friday-api-common.types.js";
import type {
  FridayMutatingActionGate,
  FridayMutatingActionGateResult,
} from "../../../../../src/security/friday-mutating-action-gate.js";

// ─── Helpers ───

function makeCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-test-1",
    receivedAt: "2026-01-01T00:00:00Z",
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: null,
    ...overrides,
  };
}

function findRoute(routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[], operationId: string) {
  return routes.find((r) => r.operationId === operationId)!;
}

function makeAllowGate(): FridayMutatingActionGate {
  const allowResult = {
    decision: "allow",
    reason: "test_gate_allow",
    risk: "critical",
    actionDigest: "digest-test",
    approvalRequired: true,
    localClaims: [],
    evidenceRecord: {},
  } as FridayMutatingActionGateResult;
  return {
    evaluate: vi.fn().mockReturnValue(allowResult),
  };
}

function makeDeps(options: {
  readonly allowTestOnlyPackagingMutationExecution?: boolean;
  readonly packagingMutationGate?: FridayMutatingActionGate;
} = {}): FridayPackagingRoutesDeps {
  return {
    packages: {
      publish: vi.fn().mockReturnValue({ package: {}, verification: {} }),
      list: vi.fn().mockReturnValue({ items: [], total: 0, limit: 20, offset: 0 }),
      get: vi.fn().mockReturnValue({ package: {}, signature: {}, versionCount: 1 }),
      listVersions: vi.fn().mockReturnValue({ items: [], total: 0, limit: 20, offset: 0 }),
      verify: vi.fn().mockReturnValue({ verification: {}, package: {} }),
      checkDependencies: vi.fn().mockReturnValue({ success: true, resolved: [], conflicts: [] }),
    },
    installs: {
      install: vi.fn().mockReturnValue({ install: {}, dependencies: [], verification: {} }),
      upgrade: vi.fn().mockReturnValue({ install: {}, previousVersion: "0.9.0", dependencies: [], verification: {} }),
      rollback: vi.fn().mockReturnValue({ rollback: {}, install: {} }),
      uninstall: vi.fn().mockReturnValue({ install: {} }),
      list: vi.fn().mockReturnValue({ items: [], total: 0, limit: 20, offset: 0 }),
      get: vi.fn().mockReturnValue({ install: {}, package: {}, rollbacks: [] }),
    },
    lifecycle: {
      list: vi.fn().mockReturnValue({ items: [], total: 0, limit: 20, offset: 0 }),
    },
    keys: {
      list: vi.fn().mockReturnValue({ items: [], total: 0, limit: 20, offset: 0 }),
      add: vi.fn().mockReturnValue({ key: {} }),
      revoke: vi.fn().mockReturnValue({ key: {}, affectedInstalls: 0 }),
      rotate: vi.fn().mockReturnValue({ newKey: {}, oldKey: {}, gracePeriodEndsAt: "2026-04-01T00:00:00Z" }),
    },
    allowTestOnlyPackagingMutationExecution: options.allowTestOnlyPackagingMutationExecution ?? true,
    packagingMutationGate: options.packagingMutationGate,
  };
}

// ─── Tests ───

describe("B-008 FridayPackagingRoutes", () => {
  describe("route registration", () => {
    it("registers all 17 routes", () => {
      const routes = createFridayPackagingRoutes(makeDeps());
      expect(routes.length).toBe(17);
    });

    it("has unique operationIds", () => {
      const routes = createFridayPackagingRoutes(makeDeps());
      const ids = routes.map((r) => r.operationId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("all routes require authentication", () => {
      const routes = createFridayPackagingRoutes(makeDeps());
      for (const route of routes) {
        expect(route.auth).toEqual({ public: true });
      }
    });

    it("all operationIds start with packaging.", () => {
      const routes = createFridayPackagingRoutes(makeDeps());
      for (const route of routes) {
        expect(route.operationId).toMatch(/^packaging\./);
      }
    });

    it("returns CAPABILITY_DISABLED when packaging surface is absent", async () => {
      const routes = createFridayPackagingRoutes(undefined);
      const route = findRoute(routes, "packaging.packages.publish");

      await expect(route.handler(makeCtx({
        body: { archive: "base64data", idempotencyKey: "key-1" },
      }))).rejects.toMatchObject({
        code: "CAPABILITY_DISABLED",
        httpStatus: 501,
        details: {
          capability: "packaging",
          surface: "/v1/packages",
        },
      });
    });

    it("fails closed before mutating when packaging deps have no governance gate", async () => {
      const deps = makeDeps({ allowTestOnlyPackagingMutationExecution: false });
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.installs.install");

      await expect(route.handler(makeCtx({
        params: { packageName: "@friday/test" },
        body: { tenantId: "tenant-1", idempotencyKey: "key-1" },
      }))).rejects.toMatchObject({
        code: "PACKAGING_MUTATION_GOVERNANCE_REQUIRED",
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          operationId: "packaging.installs.install",
        },
      });
      expect(deps.installs.install).not.toHaveBeenCalled();
    });

    it("runs canonical governance before mutating packaging services", async () => {
      const gate = makeAllowGate();
      const deps = makeDeps({
        allowTestOnlyPackagingMutationExecution: false,
        packagingMutationGate: gate,
      });
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.installs.uninstall");

      await route.handler(makeCtx({
        principal: { principalId: "operator-1", kind: "operator" },
        params: { packageName: "@friday/test" },
        body: { etag: "etag-1", idempotencyKey: "key-1" },
      }));

      expect(gate.evaluate).toHaveBeenCalledWith(expect.objectContaining({
        action: "packaging.installs.uninstall",
        surface: "packaging",
        mutating: true,
        risk: "critical",
        idempotencyKey: "key-1",
        actor: expect.objectContaining({
          kind: "operator",
          id: "operator-1",
          principalId: "operator-1",
        }),
      }));
      expect(deps.installs.uninstall).toHaveBeenCalledWith("@friday/test", { etag: "etag-1", idempotencyKey: "key-1" });
    });
  });

  describe("package routes", () => {
    it("POST /v1/packages publishes with validation", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.packages.publish");

      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: true });

      // Missing archive
      await expect(route.handler(makeCtx({
        body: { idempotencyKey: "key-1" },
      }))).rejects.toThrow("archive is required");

      // Missing idempotency key
      await expect(route.handler(makeCtx({
        body: { archive: "base64data" },
      }))).rejects.toThrow("idempotencyKey is required");

      // Valid
      await route.handler(makeCtx({
        body: { archive: "base64data", idempotencyKey: "key-1" },
      }));
      expect(deps.packages.publish).toHaveBeenCalled();
    });

    it("GET /v1/packages lists packages", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.packages.list");

      expect(route.method).toBe("GET");
      await route.handler(makeCtx({ query: { name: "@friday" } }));
      expect(deps.packages.list).toHaveBeenCalledWith({ name: "@friday" });
    });

    it("GET /v1/packages/:packageId gets package detail", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.packages.get");

      await route.handler(makeCtx({ params: { packageId: "pkg-1" } }));
      expect(deps.packages.get).toHaveBeenCalledWith("pkg-1");
    });

    it("GET /v1/packages/:packageName/versions lists versions", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.packages.versions.list");

      await route.handler(makeCtx({
        params: { packageName: "@friday/test" },
        query: { tenantId: "tenant-1", includeDeprecated: true },
      }));
      expect(deps.packages.listVersions).toHaveBeenCalledWith("@friday/test", { tenantId: "tenant-1", includeDeprecated: true });
    });

    it("POST /v1/packages/:packageId/verify requires idempotency key", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.packages.verify");

      await expect(route.handler(makeCtx({
        params: { packageId: "pkg-1" },
        body: {},
      }))).rejects.toThrow("idempotencyKey is required");
    });

    it("POST /v1/packages/:packageName/check-dependencies requires tenantId", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.packages.dependencies.check");

      await expect(route.handler(makeCtx({
        params: { packageName: "@friday/test" },
        body: {},
      }))).rejects.toThrow("tenantId is required");
    });
  });

  describe("install lifecycle routes", () => {
    it("POST /v1/packages/:packageName/install validates tenantId + idempotency", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.installs.install");

      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: true });

      await expect(route.handler(makeCtx({
        params: { packageName: "@friday/test" },
        body: { idempotencyKey: "key-1" },
      }))).rejects.toThrow("tenantId is required");

      await route.handler(makeCtx({
        params: { packageName: "@friday/test" },
        body: { tenantId: "t-1", idempotencyKey: "key-1" },
      }));
      expect(deps.installs.install).toHaveBeenCalledWith("@friday/test", { tenantId: "t-1", idempotencyKey: "key-1" });
    });

    it("POST /v1/packages/:packageName/upgrade requires etag + idempotency", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.installs.upgrade");

      await expect(route.handler(makeCtx({
        params: { packageName: "@friday/test" },
        body: { idempotencyKey: "key-1" },
      }))).rejects.toThrow("etag is required");
    });

    it("POST /v1/packages/:packageName/rollback requires etag + targetVersion + reason", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.installs.rollback");

      await expect(route.handler(makeCtx({
        params: { packageName: "@friday/test" },
        body: { etag: "e-1", reason: "bad", idempotencyKey: "key-1" },
      }))).rejects.toThrow("targetVersion is required");

      await expect(route.handler(makeCtx({
        params: { packageName: "@friday/test" },
        body: { etag: "e-1", targetVersion: "0.9.0", idempotencyKey: "key-1" },
      }))).rejects.toThrow("reason is required");
    });

    it("POST /v1/packages/:packageName/uninstall requires etag + idempotency", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.installs.uninstall");

      await expect(route.handler(makeCtx({
        params: { packageName: "@friday/test" },
        body: { idempotencyKey: "key-1" },
      }))).rejects.toThrow("etag is required");
    });

    it("GET /v1/packages/installs lists installs", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.installs.list");

      expect(route.method).toBe("GET");
      await route.handler(makeCtx({ query: { state: "active" } }));
      expect(deps.installs.list).toHaveBeenCalledWith({ state: "active" });
    });

    it("GET /v1/packages/installs/:installId gets install detail", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.installs.get");

      await route.handler(makeCtx({ params: { installId: "inst-1" } }));
      expect(deps.installs.get).toHaveBeenCalledWith("inst-1");
    });
  });

  describe("lifecycle event routes", () => {
    it("GET /v1/packages/lifecycle lists events", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.lifecycle.list");

      expect(route.method).toBe("GET");
      expect(route.auth).toEqual({ public: true });
      await route.handler(makeCtx({ query: { packageName: "@friday/test" } }));
      expect(deps.lifecycle.list).toHaveBeenCalledWith({ packageName: "@friday/test" });
    });
  });

  describe("trusted key routes", () => {
    it("GET /v1/packages/keys lists keys", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.keys.list");

      expect(route.method).toBe("GET");
      expect(route.auth).toEqual({ public: true });
      await route.handler(makeCtx({ query: { includeRevoked: true } }));
      expect(deps.keys.list).toHaveBeenCalledWith({ includeRevoked: true });
    });

    it("POST /v1/packages/keys validates keyId + publicKey + owner", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.keys.add");

      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: true });

      await expect(route.handler(makeCtx({
        body: { publicKey: "pk", owner: "admin", idempotencyKey: "key-1" },
      }))).rejects.toThrow("keyId is required");

      await route.handler(makeCtx({
        body: { keyId: "k-1", publicKey: "pk", algorithm: "Ed25519", owner: "admin", idempotencyKey: "key-1" },
      }));
      expect(deps.keys.add).toHaveBeenCalled();
    });

    it("POST /v1/packages/keys/:keyId/revoke requires reason + idempotency", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.keys.revoke");

      expect(route.auth).toEqual({ public: true });

      await expect(route.handler(makeCtx({
        params: { keyId: "k-1" },
        body: { idempotencyKey: "key-1" },
      }))).rejects.toThrow("reason is required");

      await route.handler(makeCtx({
        params: { keyId: "k-1" },
        body: { reason: "compromised", idempotencyKey: "key-1" },
      }));
      expect(deps.keys.revoke).toHaveBeenCalledWith("k-1", { reason: "compromised", idempotencyKey: "key-1" });
    });

    it("POST /v1/packages/keys/:keyId/rotate validates new key fields", async () => {
      const deps = makeDeps();
      const routes = createFridayPackagingRoutes(deps);
      const route = findRoute(routes, "packaging.keys.rotate");

      await expect(route.handler(makeCtx({
        params: { keyId: "k-1" },
        body: { newPublicKey: "pk2", owner: "admin", idempotencyKey: "key-1" },
      }))).rejects.toThrow("newKeyId is required");

      await route.handler(makeCtx({
        params: { keyId: "k-1" },
        body: { newKeyId: "k-2", newPublicKey: "pk2", owner: "admin", idempotencyKey: "key-1" },
      }));
      expect(deps.keys.rotate).toHaveBeenCalledWith("k-1", expect.objectContaining({ newKeyId: "k-2" }));
    });
  });

  describe("route count snapshot (post auth-boundary)", () => {
    const routes = createFridayPackagingRoutes(makeDeps());

    it("every route declares public auth (auth-boundary product invariant)", () => {
      for (const route of routes) {
        expect(route.auth).toEqual({ public: true });
      }
    });

    it("expected route counts by HTTP method", () => {
      expect(routes.filter((r) => r.method === "GET").length).toBe(7);
      expect(routes.filter((r) => r.method === "POST").length).toBe(10);
      expect(routes.length).toBe(17);
    });

    it("expected lifecycle operationId coverage", () => {
      const opIds = new Set(routes.map((r) => r.operationId));
      // Install / upgrade / rollback / uninstall surface still present
      expect(opIds.has("packaging.packages.publish")).toBe(true);
      expect(opIds.has("packaging.installs.install")).toBe(true);
      expect(opIds.has("packaging.installs.upgrade")).toBe(true);
      expect(opIds.has("packaging.installs.rollback")).toBe(true);
      expect(opIds.has("packaging.installs.uninstall")).toBe(true);
      expect(opIds.has("packaging.packages.verify")).toBe(true);
    });
  });
});
