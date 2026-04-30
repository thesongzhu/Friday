import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAuthRoutes, createFridayAuthService } from "#api";
import type { FridayAuthService } from "#api";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";

describe("FridayAuthRoutes", () => {
  let db: FridaySqliteLayer;
  let authService: FridayAuthService;
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
  const NOW = "2025-06-15T10:00:00.000Z";
  const TOKEN_SECRET = "test-route-secret";
  let idCounter: number;

  function makeCtx(overrides: Partial<FridayHttpContext<any, any, any>> = {}): FridayHttpContext<any, any, any> {
    return {
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {},
      headers: {},
      principal: null,
      ...overrides,
    };
  }

  function findRoute(operationId: string) {
    return routes.find((r) => r.operationId === operationId)!;
  }

  beforeEach(() => {
    db = createTestDb();
    idCounter = 0;
    authService = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
    });
    routes = createFridayAuthRoutes({ authService });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Route registration ───

  it("registers 6 auth routes", () => {
    expect(routes).toHaveLength(6);
  });

  it("has correct operation IDs", () => {
    const opIds = routes.map((r) => r.operationId);
    expect(opIds).toContain("auth.bootstrap.status");
    expect(opIds).toContain("auth.bootstrap.local.passphrase");
    expect(opIds).toContain("auth.login");
    expect(opIds).toContain("auth.refresh");
    expect(opIds).toContain("auth.logout");
    expect(opIds).toContain("auth.me");
  });

  // ─── Bootstrap routes ───

  it("GET /v1/auth/bootstrap/status is public", () => {
    const route = findRoute("auth.bootstrap.status");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/auth/bootstrap/status");
    expect(route.auth).toEqual({ public: true });
  });

  it("POST /v1/auth/bootstrap/local-passphrase is public and rate-limited", () => {
    const route = findRoute("auth.bootstrap.local.passphrase");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/bootstrap/local-passphrase");
    expect(route.auth).toEqual({ public: true });
    expect(route.rateLimitPolicyId).toBe("auth.login");
  });

  it("bootstrap status reports not required when local user already has password", async () => {
    const route = findRoute("auth.bootstrap.status");
    const result = await route.handler(makeCtx()) as {
      bootstrapRequired: boolean;
    };
    expect(result.bootstrapRequired).toBe(false);
  });

  it("bootstrap endpoint initializes passphrase once for localhost", async () => {
    db.writer.prepare("UPDATE users SET password_hash = NULL WHERE id = 'test-user'").run();
    const route = findRoute("auth.bootstrap.local.passphrase");

    const first = await route.handler(
      makeCtx({
        ip: "127.0.0.1",
        body: { passphrase: "super-secret-passphrase" },
      }),
    ) as { initialized: boolean };
    expect(first.initialized).toBe(true);

    await expect(
      route.handler(
        makeCtx({
          ip: "127.0.0.1",
          body: { passphrase: "another-passphrase" },
        }),
      ),
    ).rejects.toThrow("already been completed");
  });

  it("bootstrap endpoint rejects non-localhost callers", async () => {
    db.writer.prepare("UPDATE users SET password_hash = NULL WHERE id = 'test-user'").run();
    const route = findRoute("auth.bootstrap.local.passphrase");
    await expect(
      route.handler(
        makeCtx({
          ip: "10.0.0.2",
          body: { passphrase: "super-secret-passphrase" },
        }),
      ),
    ).rejects.toThrow("only allowed from localhost");
  });

  // ─── Login route ───

  it("POST /v1/auth/login is public", () => {
    const route = findRoute("auth.login");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/login");
    expect(route.auth).toEqual({ public: true });
  });

  it("login handler returns tokens", async () => {
    const route = findRoute("auth.login");
    const ctx = makeCtx({ body: { localPassphrase: "any" } });

    const result = await route.handler(ctx);
    expect(result).toHaveProperty("accessToken");
    expect(result).toHaveProperty("refreshToken");
    expect(result).toHaveProperty("expiresInSec");
    expect(result).toHaveProperty("user");
  });

  it("login has rate limit policy", () => {
    const route = findRoute("auth.login");
    expect(route.rateLimitPolicyId).toBe("auth.login");
  });

  // ─── Refresh route ───

  it("POST /v1/auth/refresh is public", () => {
    const route = findRoute("auth.refresh");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/refresh");
    expect(route.auth).toEqual({ public: true });
  });

  it("refresh handler returns new access token", async () => {
    const loginResult = authService.login({ localPassphrase: "any" });
    const route = findRoute("auth.refresh");
    const ctx = makeCtx({ body: { refreshToken: loginResult.refreshToken } });

    const result = await route.handler(ctx);
    expect(result).toHaveProperty("accessToken");
    expect(result).toHaveProperty("expiresInSec");
  });

  // ─── Logout route ───

  it("POST /v1/auth/logout requires session.write scope", () => {
    const route = findRoute("auth.logout");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/logout");
    expect(route.auth).toEqual({ public: false, anyOfScopes: ["session.write"] });
  });

  it("logout handler revokes session", async () => {
    const loginResult = authService.login({ localPassphrase: "any" });
    const route = findRoute("auth.logout");

    const principal = {
      principalType: "user" as const,
      principalId: "test-user",
      userId: "test-user",
      role: "admin" as const,
      scopes: ["session.write" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
      sessionId: "id-0001",
    };

    const ctx = makeCtx({
      body: { refreshToken: loginResult.refreshToken },
      principal,
    });

    const result = await route.handler(ctx);
    expect(result).toEqual({ ok: true });
  });

  // ─── Me route ───

  it("GET /v1/auth/me requires session.read scope", () => {
    const route = findRoute("auth.me");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/auth/me");
    expect(route.auth).toEqual({ public: false, anyOfScopes: ["session.read"] });
  });

  it("me handler returns user info", async () => {
    authService.login({ localPassphrase: "any" });
    const route = findRoute("auth.me");

    const principal = {
      principalType: "user" as const,
      principalId: "test-user",
      userId: "test-user",
      role: "admin" as const,
      scopes: ["session.read" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
      sessionId: "id-0001",
    };

    const ctx = makeCtx({ principal });
    const result = await route.handler(ctx);
    expect(result).toHaveProperty("user");
    expect((result as { user: { id: string } }).user.id).toBe("test-user");
  });
});
