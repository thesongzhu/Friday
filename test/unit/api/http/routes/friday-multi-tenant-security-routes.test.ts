/**
 * B-002 Multi-Tenant Security Routes — Contract Tests
 *
 * Validates route registration, auth scopes, request validation,
 * idempotency / etag enforcement, and handler delegation for all
 * 36 multi-tenant security endpoints.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createFridayMultiTenantSecurityRoutes,
  type FridayMultiTenantSecurityRoutesDeps,
} from "../../../../../src/api/http/routes/friday-multi-tenant-security-routes.js";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";
import type {
  FridayRouteDefinition,
  FridayHttpContext,
} from "../../../../../src/api/model/friday-api-common.types.js";
import { ERROR_CODE_BOUND_PRINCIPAL_REQUIRED } from "../../../../../src/security/friday-owner-session-channel-capability.js";

// ─── Helpers ───

function makeCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-test-1",
    receivedAt: "2026-01-01T00:00:00Z",
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: {
      principalType: "user",
      principalId: "security-admin-1",
      tenantId: "t-1",
      userId: "user-1",
      role: "admin",
      scopes: ["security.read", "security.write"],
      tokenId: "token-1",
      tokenKind: "access",
      issuedAt: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

function findRoute(routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[], operationId: string) {
  return routes.find((r) => r.operationId === operationId)!;
}

function makeDeps(): FridayMultiTenantSecurityRoutesDeps {
  return {
    tenants: {
      create: vi.fn().mockReturnValue({ tenant: { id: "t-1" } }),
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
      get: vi.fn().mockReturnValue({ tenant: { id: "t-1" }, workspaceCount: 0, memberCount: 0 }),
      update: vi.fn().mockReturnValue({ tenant: { id: "t-1" } }),
      delete: vi.fn().mockReturnValue({ tenant: { id: "t-1" } }),
    },
    workspaces: {
      create: vi.fn().mockReturnValue({ workspace: { id: "ws-1" } }),
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
      get: vi.fn().mockReturnValue({ workspace: { id: "ws-1" }, memberCount: 0 }),
      update: vi.fn().mockReturnValue({ workspace: { id: "ws-1" } }),
      delete: vi.fn().mockReturnValue({ workspace: { id: "ws-1" } }),
    },
    members: {
      add: vi.fn().mockReturnValue({ membership: { id: "m-1" } }),
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
      revoke: vi.fn().mockReturnValue({ membership: { id: "m-1" } }),
    },
    roles: {
      create: vi.fn().mockReturnValue({ role: { id: "r-1" } }),
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
      get: vi.fn().mockReturnValue({ role: { id: "r-1" }, assignmentCount: 0 }),
      update: vi.fn().mockReturnValue({ role: { id: "r-1" } }),
      delete: vi.fn().mockReturnValue({ role: { id: "r-1" } }),
    },
    assignments: {
      grant: vi.fn().mockReturnValue({ assignment: { id: "a-1" } }),
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
      revoke: vi.fn().mockReturnValue({ assignment: { id: "a-1" } }),
    },
    secrets: {
      create: vi.fn().mockReturnValue({ secret: { id: "s-1" } }),
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
      get: vi.fn().mockReturnValue({ secret: { id: "s-1" }, rotationHistory: [] }),
      update: vi.fn().mockReturnValue({ secret: { id: "s-1" } }),
      delete: vi.fn().mockReturnValue({ secret: { id: "s-1" } }),
      rotate: vi.fn().mockReturnValue({ secret: { id: "s-1" }, rotation: { id: "rot-1" } }),
      listAccessLog: vi.fn().mockReturnValue({ items: [], total: 0 }),
    },
    policies: {
      create: vi.fn().mockReturnValue({ policy: { id: "p-1" } }),
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
      get: vi.fn().mockReturnValue({ policy: { id: "p-1" } }),
      update: vi.fn().mockReturnValue({ policy: { id: "p-1" } }),
      delete: vi.fn().mockReturnValue({ policy: { id: "p-1" } }),
      evaluate: vi.fn().mockReturnValue({ evaluation: { decision: "allow" } }),
    },
    audit: {
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
    },
    violations: {
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
      resolve: vi.fn().mockReturnValue({ violation: { id: "v-1" } }),
    },
    scopedResources: {
      register: vi.fn().mockReturnValue({ record: { id: "sr-1" } }),
      list: vi.fn().mockReturnValue({ items: [] }),
      get: vi.fn().mockReturnValue({ record: { id: "sr-1" } }),
      unregister: vi.fn().mockReturnValue({ record: { id: "sr-1" } }),
      status: vi.fn().mockReturnValue({
        tenantId: "t-1",
        totals: { session: 0, skill: 0, workflow: 0, provider: 0, memory: 0, rule: 0 },
        activeTotal: 0,
        supportedKinds: ["session", "skill", "workflow", "provider", "memory", "rule"],
      }),
    },
  };
}

// ─── Tests ───

describe("B-002 FridayMultiTenantSecurityRoutes", () => {
  describe("route registration", () => {
    it("registers all 42 routes", () => {
      const routes = createFridayMultiTenantSecurityRoutes(makeDeps());
      expect(routes.length).toBe(42);
    });

    it("has unique operationIds", () => {
      const routes = createFridayMultiTenantSecurityRoutes(makeDeps());
      const ids = routes.map((r) => r.operationId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("all routes require authentication", () => {
      const routes = createFridayMultiTenantSecurityRoutes(makeDeps());
      for (const route of routes) {
        expect(route.auth).toEqual({ public: true });
      }
    });

    it("all handlers reject unbound public principals before service access", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const serviceFns = Object.values(deps)
        .flatMap((group) => Object.values(group))
        .filter((fn): fn is ReturnType<typeof vi.fn> => vi.isMockFunction(fn));

      for (const route of routes) {
        for (const principal of [null, createFridayDefaultPublicHttpPrincipal()]) {
          try {
            await route.handler(makeCtx({ principal }));
            throw new Error(`expected bound-principal refusal for ${route.operationId}`);
          } catch (error) {
            expect(error).toMatchObject({
              code: ERROR_CODE_BOUND_PRINCIPAL_REQUIRED,
              httpStatus: 401,
            });
          }
        }
      }
      for (const fn of serviceFns) {
        expect(fn).not.toHaveBeenCalled();
      }
    });

    it("all operationIds start with security.", () => {
      const routes = createFridayMultiTenantSecurityRoutes(makeDeps());
      for (const route of routes) {
        expect(route.operationId).toMatch(/^security\./);
      }
    });
  });

  describe("tenant routes", () => {
    it("POST /v1/security/tenants validates name and slug", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.tenants.create");

      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: true });

      await expect(route.handler(makeCtx({ body: { slug: "s", idempotencyKey: "k" } }))).rejects.toThrow("name is required");
      await expect(route.handler(makeCtx({ body: { name: "n", idempotencyKey: "k" } }))).rejects.toThrow("slug is required");
    });

    it("POST /v1/security/tenants delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.tenants.create");

      await route.handler(makeCtx({ body: { name: "Acme", slug: "acme", idempotencyKey: "k-1" } }));
      expect(deps.tenants.create).toHaveBeenCalledWith({ name: "Acme", slug: "acme", idempotencyKey: "k-1" });
    });

    it("GET /v1/security/tenants delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.tenants.list");

      expect(route.method).toBe("GET");
      expect(route.auth).toEqual({ public: true });
      await route.handler(makeCtx({ query: { status: "active" } }));
      expect(deps.tenants.list).toHaveBeenCalledWith({ status: "active" });
    });

    it("GET /v1/security/tenants/:tenantId delegates to get", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.tenants.get");

      await route.handler(makeCtx({ params: { tenantId: "t-42" } }));
      expect(deps.tenants.get).toHaveBeenCalledWith("t-42");
    });

    it("PATCH /v1/security/tenants/:tenantId requires etag and idempotencyKey", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.tenants.update");

      expect(route.method).toBe("PATCH");
      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { idempotencyKey: "k" },
      }))).rejects.toThrow("etag is required");
    });

    it("DELETE /v1/security/tenants/:tenantId requires etag and idempotencyKey", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.tenants.delete");

      expect(route.method).toBe("DELETE");
      expect(route.auth).toEqual({ public: true });
      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { etag: "e" },
      }))).rejects.toThrow("idempotencyKey is required");
    });
  });

  describe("workspace routes", () => {
    it("POST /v1/security/tenants/:tenantId/workspaces validates name+slug", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.workspaces.create");

      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: true });
      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { slug: "s", idempotencyKey: "k" },
      }))).rejects.toThrow("name is required");
    });

    it("POST /v1/security/tenants/:tenantId/workspaces delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.workspaces.create");

      await route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { name: "Dev", slug: "dev", idempotencyKey: "k" },
      }));
      expect(deps.workspaces.create).toHaveBeenCalledWith("t-1", { name: "Dev", slug: "dev", idempotencyKey: "k" });
    });

    it("GET workspaces delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.workspaces.list");

      await route.handler(makeCtx({ params: { tenantId: "t-1" }, query: { status: "active" } }));
      expect(deps.workspaces.list).toHaveBeenCalledWith("t-1", { status: "active" });
    });

    it("GET workspace by ID delegates", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.workspaces.get");

      await route.handler(makeCtx({ params: { tenantId: "t-1", workspaceId: "ws-2" } }));
      expect(deps.workspaces.get).toHaveBeenCalledWith("t-1", "ws-2");
    });

    it("PATCH workspace requires etag", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.workspaces.update");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", workspaceId: "ws-1" },
        body: { idempotencyKey: "k" },
      }))).rejects.toThrow("etag is required");
    });

    it("DELETE workspace requires etag+idempotencyKey", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.workspaces.delete");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", workspaceId: "ws-1" },
        body: { etag: "e" },
      }))).rejects.toThrow("idempotencyKey is required");
    });
  });

  describe("member routes", () => {
    it("POST members validates principalId+roleId", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.members.add");

      expect(route.auth).toEqual({ public: true });
      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", workspaceId: "ws-1" },
        body: { roleId: "r-1", idempotencyKey: "k" },
      }))).rejects.toThrow("principalId is required");
    });

    it("POST members delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.members.add");

      await route.handler(makeCtx({
        params: { tenantId: "t-1", workspaceId: "ws-1" },
        body: { principalId: "u-1", roleId: "r-1", idempotencyKey: "k" },
      }));
      expect(deps.members.add).toHaveBeenCalledWith("t-1", "ws-1", { principalId: "u-1", roleId: "r-1", idempotencyKey: "k" });
    });

    it("GET members delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.members.list");

      await route.handler(makeCtx({ params: { tenantId: "t-1", workspaceId: "ws-1" } }));
      expect(deps.members.list).toHaveBeenCalledWith("t-1", "ws-1", {});
    });

    it("DELETE member revokes membership", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.members.revoke");

      await route.handler(makeCtx({
        params: { tenantId: "t-1", workspaceId: "ws-1", membershipId: "m-1" },
        body: { idempotencyKey: "k" },
      }));
      expect(deps.members.revoke).toHaveBeenCalledWith("t-1", "ws-1", "m-1", { idempotencyKey: "k" });
    });
  });

  describe("role routes", () => {
    it("POST roles validates role.name", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.roles.create");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { role: {}, idempotencyKey: "k" },
      }))).rejects.toThrow("role.name is required");
    });

    it("POST roles delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.roles.create");

      const body = { role: { name: "editor", scopeType: "workspace", permissionIds: [] }, idempotencyKey: "k" };
      await route.handler(makeCtx({ params: { tenantId: "t-1" }, body }));
      expect(deps.roles.create).toHaveBeenCalledWith("t-1", body);
    });

    it("GET roles delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.roles.list");

      await route.handler(makeCtx({ params: { tenantId: "t-1" }, query: { scopeType: "tenant" } }));
      expect(deps.roles.list).toHaveBeenCalledWith("t-1", { scopeType: "tenant" });
    });

    it("GET role by ID delegates", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.roles.get");

      await route.handler(makeCtx({ params: { tenantId: "t-1", roleId: "r-5" } }));
      expect(deps.roles.get).toHaveBeenCalledWith("t-1", "r-5");
    });

    it("PATCH role requires etag", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.roles.update");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", roleId: "r-1" },
        body: { role: { name: "x" }, idempotencyKey: "k" },
      }))).rejects.toThrow("etag is required");
    });

    it("DELETE role requires etag+idempotencyKey", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.roles.delete");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", roleId: "r-1" },
        body: { etag: "e" },
      }))).rejects.toThrow("idempotencyKey is required");
    });
  });

  describe("role assignment routes", () => {
    it("POST grant validates principalId+roleId", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.assignments.grant");

      expect(route.auth).toEqual({ public: true });
      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { roleId: "r-1", scope: { scopeType: "tenant" }, idempotencyKey: "k" },
      }))).rejects.toThrow("principalId is required");
    });

    it("POST grant delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.assignments.grant");

      const body = { principalId: "u-1", roleId: "r-1", scope: { scopeType: "tenant" as const }, idempotencyKey: "k" };
      await route.handler(makeCtx({ params: { tenantId: "t-1" }, body }));
      expect(deps.assignments.grant).toHaveBeenCalledWith("t-1", body);
    });

    it("GET assignments delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.assignments.list");

      await route.handler(makeCtx({ params: { tenantId: "t-1" } }));
      expect(deps.assignments.list).toHaveBeenCalledWith("t-1", {});
    });

    it("DELETE assignment requires idempotencyKey", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.assignments.revoke");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", assignmentId: "a-1" },
        body: {},
      }))).rejects.toThrow("idempotencyKey is required");
    });
  });

  describe("secret routes", () => {
    it("POST secret validates secret.name and secret.value", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.secrets.create");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { secret: { value: "v" }, idempotencyKey: "k" },
      }))).rejects.toThrow("secret.name is required");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { secret: { name: "n" }, idempotencyKey: "k" },
      }))).rejects.toThrow("secret.value is required");
    });

    it("POST secret delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.secrets.create");

      const body = {
        secret: { name: "API_KEY", value: "abc123", scope: { scopeType: "tenant" as const } },
        idempotencyKey: "k",
      };
      await route.handler(makeCtx({ params: { tenantId: "t-1" }, body }));
      expect(deps.secrets.create).toHaveBeenCalledWith("t-1", body);
    });

    it("GET secrets delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.secrets.list");

      await route.handler(makeCtx({ params: { tenantId: "t-1" }, query: { scopeType: "workspace" } }));
      expect(deps.secrets.list).toHaveBeenCalledWith("t-1", { scopeType: "workspace" });
    });

    it("GET secret by ID delegates", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.secrets.get");

      await route.handler(makeCtx({ params: { tenantId: "t-1", secretId: "s-7" } }));
      expect(deps.secrets.get).toHaveBeenCalledWith("t-1", "s-7");
    });

    it("PATCH secret requires etag+idempotencyKey", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.secrets.update");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", secretId: "s-1" },
        body: { idempotencyKey: "k" },
      }))).rejects.toThrow("etag is required");
    });

    it("DELETE secret requires etag+idempotencyKey", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.secrets.delete");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", secretId: "s-1" },
        body: { etag: "e" },
      }))).rejects.toThrow("idempotencyKey is required");
    });

    it("POST rotate validates newValue+etag", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.secrets.rotate");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", secretId: "s-1" },
        body: { etag: "e", idempotencyKey: "k" },
      }))).rejects.toThrow("newValue is required");
    });

    it("POST rotate delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.secrets.rotate");

      await route.handler(makeCtx({
        params: { tenantId: "t-1", secretId: "s-1" },
        body: { newValue: "new-secret", etag: "e", idempotencyKey: "k" },
      }));
      expect(deps.secrets.rotate).toHaveBeenCalledWith("t-1", "s-1", { newValue: "new-secret", etag: "e", idempotencyKey: "k" });
    });

    it("GET access-log delegates", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.secrets.access.log");

      await route.handler(makeCtx({ params: { tenantId: "t-1", secretId: "s-1" }, query: { granted: true } }));
      expect(deps.secrets.listAccessLog).toHaveBeenCalledWith("t-1", "s-1", { granted: true });
    });
  });

  describe("policy routes", () => {
    it("POST policy validates name", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.policies.create");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { rules: [], idempotencyKey: "k" },
      }))).rejects.toThrow("name is required");
    });

    it("POST policy delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.policies.create");

      const body = { name: "My Policy", rules: [], idempotencyKey: "k" };
      await route.handler(makeCtx({ params: { tenantId: "t-1" }, body }));
      expect(deps.policies.create).toHaveBeenCalledWith("t-1", body);
    });

    it("GET policies delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.policies.list");

      await route.handler(makeCtx({ params: { tenantId: "t-1" }, query: { enabled: true } }));
      expect(deps.policies.list).toHaveBeenCalledWith("t-1", { enabled: true });
    });

    it("GET policy by ID delegates", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.policies.get");

      await route.handler(makeCtx({ params: { tenantId: "t-1", policyId: "p-3" } }));
      expect(deps.policies.get).toHaveBeenCalledWith("t-1", "p-3");
    });

    it("PATCH policy requires etag", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.policies.update");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", policyId: "p-1" },
        body: { idempotencyKey: "k" },
      }))).rejects.toThrow("etag is required");
    });

    it("DELETE policy requires etag+idempotencyKey", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.policies.delete");

      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", policyId: "p-1" },
        body: { etag: "e" },
      }))).rejects.toThrow("idempotencyKey is required");
    });

    it("POST evaluate validates principalId+resource+action", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.policies.evaluate");

      expect(route.auth).toEqual({ public: true });
      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { resource: "secret", action: "read", idempotencyKey: "k" },
      }))).rejects.toThrow("principalId is required");
    });

    it("POST evaluate delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.policies.evaluate");

      const body = { principalId: "u-1", resource: "secret", action: "read", idempotencyKey: "k" };
      await route.handler(makeCtx({ params: { tenantId: "t-1" }, body }));
      expect(deps.policies.evaluate).toHaveBeenCalledWith("t-1", body);
    });
  });

  describe("audit log routes", () => {
    it("GET audit-log delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.audit.list");

      expect(route.method).toBe("GET");
      expect(route.auth).toEqual({ public: true });
      await route.handler(makeCtx({ params: { tenantId: "t-1" }, query: { decision: "deny" } }));
      expect(deps.audit.list).toHaveBeenCalledWith("t-1", { decision: "deny" });
    });
  });

  describe("violation routes", () => {
    it("GET violations delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.violations.list");

      expect(route.method).toBe("GET");
      await route.handler(makeCtx({ params: { tenantId: "t-1" }, query: { severity: "critical" } }));
      expect(deps.violations.list).toHaveBeenCalledWith("t-1", { severity: "critical" });
    });

    it("POST resolve requires idempotencyKey", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.violations.resolve");

      expect(route.auth).toEqual({ public: true });
      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1", violationId: "v-1" },
        body: {},
      }))).rejects.toThrow("idempotencyKey is required");
    });

    it("POST resolve delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.violations.resolve");

      await route.handler(makeCtx({
        params: { tenantId: "t-1", violationId: "v-99" },
        body: { idempotencyKey: "k" },
      }));
      expect(deps.violations.resolve).toHaveBeenCalledWith("t-1", "v-99", { idempotencyKey: "k" });
    });
  });

  describe("scoped-resources routes (Phase 11 Module 18)", () => {
    it("POST register validates resourceKind+resourceId+idempotencyKey", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.scopedresources.register");

      expect(route.method).toBe("POST");
      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { resourceId: "r-1", idempotencyKey: "k" },
      }))).rejects.toThrow("resourceKind is required");
      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { resourceKind: "skill", idempotencyKey: "k" },
      }))).rejects.toThrow("resourceId is required");
      await expect(route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: { resourceKind: "skill", resourceId: "r-1" },
      }))).rejects.toThrow("idempotencyKey is required");
    });

    it("POST register delegates with a valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.scopedresources.register");

      await route.handler(makeCtx({
        params: { tenantId: "t-1" },
        body: {
          resourceKind: "skill",
          resourceId: "sk-1",
          resourceLabel: "label",
          idempotencyKey: "k-1",
        },
      }));
      expect(deps.scopedResources.register).toHaveBeenCalledWith("t-1", expect.objectContaining({
        resourceKind: "skill",
        resourceId: "sk-1",
        resourceLabel: "label",
      }));
    });

    it("GET list delegates with optional resourceKind filter", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.scopedresources.list");

      expect(route.method).toBe("GET");
      await route.handler(makeCtx({ params: { tenantId: "t-2" }, query: { resourceKind: "workflow" } }));
      expect(deps.scopedResources.list).toHaveBeenCalledWith("t-2", { resourceKind: "workflow" });
    });

    it("GET status returns the totals envelope", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.scopedresources.status");

      expect(route.method).toBe("GET");
      const result = await route.handler(makeCtx({ params: { tenantId: "t-3" } }));
      expect(deps.scopedResources.status).toHaveBeenCalledWith("t-3");
      expect((result as { supportedKinds: string[] }).supportedKinds).toEqual([
        "session", "skill", "workflow", "provider", "memory", "rule",
      ]);
    });

    it("GET resourceKind/resourceId delegates to get", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.scopedresources.get");

      expect(route.method).toBe("GET");
      await route.handler(makeCtx({
        params: { tenantId: "t-4", resourceKind: "memory", resourceId: "mem-1" },
      }));
      expect(deps.scopedResources.get).toHaveBeenCalledWith("t-4", "memory", "mem-1");
    });

    it("DELETE requires idempotencyKey and delegates to unregister", async () => {
      const deps = makeDeps();
      const routes = createFridayMultiTenantSecurityRoutes(deps);
      const route = findRoute(routes, "security.scopedresources.unregister");

      expect(route.method).toBe("DELETE");
      await expect(route.handler(makeCtx({
        params: { tenantId: "t-5", resourceKind: "rule", resourceId: "rule-1" },
        body: null,
      }))).rejects.toThrow("idempotencyKey is required");

      await route.handler(makeCtx({
        params: { tenantId: "t-5", resourceKind: "rule", resourceId: "rule-1" },
        body: { idempotencyKey: "k" },
      }));
      expect(deps.scopedResources.unregister).toHaveBeenCalledWith("t-5", "rule", "rule-1");
    });
  });

  describe("route count snapshot (post auth-boundary)", () => {
    const routes = createFridayMultiTenantSecurityRoutes(makeDeps());

    it("every route declares public auth (auth-boundary product invariant)", () => {
      for (const route of routes) {
        expect(route.auth).toEqual({ public: true });
      }
    });

    it("tenant lifecycle routes match the expected operationId family", () => {
      const tenantLifecycle = routes.filter((r) => /^security\.tenants\.(create|update|delete)$/.test(r.operationId));
      expect(tenantLifecycle.length).toBe(3);
    });

    it("expected route counts by HTTP method", () => {
      expect(routes.filter((r) => r.method === "GET").length).toBe(18);
      expect(routes.filter((r) => r.method === "POST").length).toBe(11);
      expect(routes.filter((r) => r.method === "PATCH").length).toBe(5);
      expect(routes.filter((r) => r.method === "DELETE").length).toBe(8);
      expect(routes.length).toBe(42);
    });
  });
});
