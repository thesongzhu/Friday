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
});
