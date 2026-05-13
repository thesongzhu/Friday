import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  type FridayAuthMiddlewareFactory,
  type FridayHttpServer,
  type FridayRealtimeWsGateway,
} from "#api";
import {
  FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID,
  FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID,
  FRIDAY_DEFAULT_PUBLIC_HTTP_TENANT_ID,
} from "../../../../src/api/http/friday-default-public-principal.js";

/**
 * Auth-boundary product invariant tests.
 *
 * Every Friday HTTP route is public (no Authorization header required). Many
 * handlers still read `ctx.principal.userId` / `tenantId` / `principalId` /
 * `scopes`. The HTTP server must inject a synthetic default principal for public
 * routes so those reads do not crash and continue to record actor/tenant
 * context.
 *
 * These tests go through the REAL HTTP server with NO Authorization header AND
 * NO injected test principal — replicating production no-login conditions.
 */

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const port = addr.port;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function makeStubWsGateway(): FridayRealtimeWsGateway {
  return {
    handleClientFrame: () => ({ handled: false }),
    addConnection: () => {},
    removeConnection: () => {},
    broadcastEvent: () => {},
  } as unknown as FridayRealtimeWsGateway;
}

function makeStubMiddleware(): FridayAuthMiddlewareFactory {
  return {
    requireAuth: () => ({ passed: true as const }),
    requireAnyScope: () => ({ passed: true as const }),
    requireAnyRole: () => ({ passed: true as const }),
    enforceRateLimit: () => ({ passed: true as const }),
  };
}

/** Mirror of the actual `requireUserId` helper used by many route files. */
function requireUserId(principal: { userId?: string } | null): string {
  if (!principal?.userId) {
    throw new Error("UNAUTHENTICATED: userId required");
  }
  return principal.userId;
}

describe("FridayHttpServer default-public principal (auth-boundary)", () => {
  let server: FridayHttpServer | null = null;
  let port = 0;
  let baseUrl = "";

  beforeEach(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("auth-me-equivalent: handler reading ctx.principal! returns the default-public principal", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.auth.me",
      method: "GET",
      path: "/v1/test/auth/me",
      auth: { public: true },
      async handler(ctx) {
        // Mirrors friday-auth-routes.ts logout/me which call ctx.principal!
        const principal = ctx.principal!;
        return {
          principalId: principal.principalId,
          userId: principal.userId,
          tenantId: principal.tenantId,
          role: principal.role,
        };
      },
    });

    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
    });
    await server.listen();

    const response = await fetch(`${baseUrl}/v1/test/auth/me`);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: true; data: { principalId: string; userId: string; tenantId: string; role: string } };
    expect(body.ok).toBe(true);
    expect(body.data.principalId).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);
    expect(body.data.userId).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID);
    expect(body.data.tenantId).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_TENANT_ID);
    expect(body.data.role).toBe("admin");
  });

  it("memory-style: handler calling memoryGuardFactory.forPrincipal-style with ctx.principal succeeds without auth header", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.memory.list",
      method: "GET",
      path: "/v1/test/memory/list",
      auth: { public: true },
      async handler(ctx) {
        // Mirrors friday-memory-routes.ts:231 — memoryGuardFactory.forPrincipal(ctx.principal)
        // which previously rejected null principals.
        if (!ctx.principal) {
          throw new Error("UNAUTHENTICATED: principal required");
        }
        const guard = { principalId: ctx.principal.principalId, tenantId: ctx.principal.tenantId };
        return { guard };
      },
    });

    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
    });
    await server.listen();

    const response = await fetch(`${baseUrl}/v1/test/memory/list`);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: true; data: { guard: { principalId: string; tenantId: string } } };
    expect(body.data.guard.principalId).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);
    expect(body.data.guard.tenantId).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_TENANT_ID);
  });

  it("user-scoped: handler using requireUserId(ctx.principal) returns the default userId without auth header", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.userscoped.run",
      method: "POST",
      path: "/v1/test/userscoped/run",
      auth: { public: true },
      async handler(ctx) {
        // Mirrors the requireUserId helper used in cross-border-pack, auto-fix,
        // diagnosis, agent-loop, reflex, skill-generator, uix, autonomy routes.
        const userId = requireUserId(ctx.principal);
        return { userId };
      },
    });

    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
    });
    await server.listen();

    const response = await fetch(`${baseUrl}/v1/test/userscoped/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: true; data: { userId: string } };
    expect(body.data.userId).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID);
  });

  it("realtime-style: handler using ctx.principal!.principalId for stream authorization works without auth header", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.realtime.subscribe",
      method: "POST",
      path: "/v1/test/realtime/subscribe",
      auth: { public: true },
      async handler(ctx) {
        // Mirrors friday-realtime-routes.ts:43/144 — ctx.principal!.principalId
        // used as the subscription key.
        const subscriberId = ctx.principal!.principalId;
        return { subscriberId };
      },
    });

    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
    });
    await server.listen();

    const response = await fetch(`${baseUrl}/v1/test/realtime/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: true; data: { subscriberId: string } };
    expect(body.data.subscriberId).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);
  });

  it("provider/skill/workflow actor-tenant: handler recording principalId + tenantId for audit succeeds without auth header", async () => {
    const routes = createFridayHttpRouteRegistry();
    const auditLog: { actor: string; tenant: string | null | undefined }[] = [];
    routes.register({
      operationId: "test.provider.create",
      method: "POST",
      path: "/v1/test/provider/create",
      auth: { public: true },
      async handler(ctx) {
        // Mirrors provider/skill/workflow routes that stamp the actor + tenant
        // on a created/mutated resource for audit.
        const actor = ctx.principal?.principalId;
        const tenant = ctx.principal?.tenantId;
        if (!actor) {
          throw new Error("UNAUTHENTICATED: principal required");
        }
        auditLog.push({ actor, tenant });
        return { actor, tenant };
      },
    });

    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
    });
    await server.listen();

    const response = await fetch(`${baseUrl}/v1/test/provider/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: true; data: { actor: string; tenant: string | null } };
    expect(body.data.actor).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);
    expect(body.data.tenant).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_TENANT_ID);
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]).toEqual({
      actor: FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID,
      tenant: FRIDAY_DEFAULT_PUBLIC_HTTP_TENANT_ID,
    });
  });

  it("idempotency-key still uses principal.principalId for the public-route key (not 'anonymous')", async () => {
    const routes = createFridayHttpRouteRegistry();
    let handlerCalls = 0;
    routes.register({
      operationId: "test.idempotency.create",
      method: "POST",
      path: "/v1/test/idempotency/create",
      auth: { public: true },
      async handler(ctx) {
        handlerCalls += 1;
        return { principalId: ctx.principal!.principalId, callCount: handlerCalls };
      },
    });

    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
    });
    await server.listen();

    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "same-key",
    };
    const body = JSON.stringify({ payload: "x" });

    const r1 = await fetch(`${baseUrl}/v1/test/idempotency/create`, { method: "POST", headers, body });
    expect(r1.status).toBe(200);
    const r1body = await r1.json() as { ok: true; data: { principalId: string; callCount: number } };
    expect(r1body.data.principalId).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);

    const r2 = await fetch(`${baseUrl}/v1/test/idempotency/create`, { method: "POST", headers, body });
    expect(r2.status).toBe(200);
    // Idempotency cache returns the first response — handler not called twice.
    expect(handlerCalls).toBe(1);
  });

  // ─── Bearer hydration (Stage 3 fix for PR #221 Stage 7 CI failures) ───

  /**
   * Stub middleware that mimics the real `requireAuth`:
   *   - no Authorization header  → 401 rejection
   *   - `Authorization: Bearer <known-token>` → set ctx.principal to the mapped principal, pass
   *   - any other Authorization shape → 401 rejection
   */
  function makeBearerStubMiddleware(
    validTokens: Record<string, { principalId: string; userId: string; tenantId: string; role: string; scopes: string[] }>,
  ): FridayAuthMiddlewareFactory {
    return {
      requireAuth: (ctx) => {
        if (ctx.principal) return { passed: true as const };
        const auth = ctx.headers["authorization"] ?? ctx.headers["Authorization"];
        if (!auth) return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "missing token" };
        const parts = auth.split(" ");
        if (parts.length !== 2 || parts[0] !== "Bearer") {
          return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "malformed header" };
        }
        const principal = validTokens[parts[1]];
        if (!principal) {
          return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "invalid token" };
        }
        (ctx as { principal: unknown }).principal = principal;
        return { passed: true as const };
      },
      requireAnyScope: () => ({ passed: true as const }),
      requireAnyRole: () => ({ passed: true as const }),
      enforceRateLimit: () => ({ passed: true as const }),
    };
  }

  it("bearer-hydration: valid Bearer token preserves the real principal (not public:default)", async () => {
    const realPrincipal = {
      principalId: "user:alice",
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      role: "viewer",
      scopes: ["session.read"],
    };
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.auth.me",
      method: "GET",
      path: "/v1/test/auth/me",
      auth: { public: true },
      async handler(ctx) {
        const p = ctx.principal!;
        return {
          principalId: p.principalId,
          userId: p.userId,
          tenantId: p.tenantId,
          role: p.role,
        };
      },
    });

    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeBearerStubMiddleware({ "real-token-abc": realPrincipal }),
      port,
      host: "127.0.0.1",
    });
    await server.listen();

    const response = await fetch(`${baseUrl}/v1/test/auth/me`, {
      headers: { Authorization: "Bearer real-token-abc" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: true; data: { principalId: string; userId: string; tenantId: string; role: string } };
    expect(body.data.principalId).toBe("user:alice");
    expect(body.data.principalId).not.toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);
    expect(body.data.userId).toBe("11111111-1111-1111-1111-111111111111");
    expect(body.data.tenantId).toBe("22222222-2222-2222-2222-222222222222");
    expect(body.data.role).toBe("viewer");
  });

  it("bearer-hydration: malformed Authorization (Basic scheme) falls back to public:default and does NOT 401", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.auth.me",
      method: "GET",
      path: "/v1/test/auth/me",
      auth: { public: true },
      async handler(ctx) {
        return { principalId: ctx.principal!.principalId };
      },
    });

    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeBearerStubMiddleware({ "real-token-abc": { principalId: "x", userId: "x", tenantId: "x", role: "x", scopes: [] } }),
      port,
      host: "127.0.0.1",
    });
    await server.listen();

    const response = await fetch(`${baseUrl}/v1/test/auth/me`, {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: true; data: { principalId: string } };
    expect(body.data.principalId).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);
  });

  it("bearer-hydration: lowercase 'bearer' scheme falls back to public:default", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.auth.me",
      method: "GET",
      path: "/v1/test/auth/me",
      auth: { public: true },
      async handler(ctx) {
        return { principalId: ctx.principal!.principalId };
      },
    });

    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeBearerStubMiddleware({ "real-token-abc": { principalId: "x", userId: "x", tenantId: "x", role: "x", scopes: [] } }),
      port,
      host: "127.0.0.1",
    });
    await server.listen();

    const response = await fetch(`${baseUrl}/v1/test/auth/me`, {
      headers: { Authorization: "bearer real-token-abc" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: true; data: { principalId: string } };
    expect(body.data.principalId).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);
  });

  it("bearer-hydration: Bearer with unknown token value falls back to public:default", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.auth.me",
      method: "GET",
      path: "/v1/test/auth/me",
      auth: { public: true },
      async handler(ctx) {
        return { principalId: ctx.principal!.principalId };
      },
    });

    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeBearerStubMiddleware({}),
      port,
      host: "127.0.0.1",
    });
    await server.listen();

    const response = await fetch(`${baseUrl}/v1/test/auth/me`, {
      headers: { Authorization: "Bearer nope.nope.nope" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: true; data: { principalId: string } };
    expect(body.data.principalId).toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);
  });
});
