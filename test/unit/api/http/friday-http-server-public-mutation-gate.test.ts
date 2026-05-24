import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  type FridayAuthMiddlewareFactory,
  type FridayHttpServer,
  type FridayRealtimeWsGateway,
} from "#api";
import { FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID } from "../../../../src/api/http/friday-default-public-principal.js";
import { ERROR_CODE_BOUND_PRINCIPAL_REQUIRED } from "../../../../src/security/friday-owner-session-channel-capability.js";

/**
 * Public-mutation safety-floor gate tests.
 *
 * The server-level gate (friday-http-server) rejects POST/PUT/PATCH/DELETE on
 * `auth:{public:true}` routes when the request resolves to the synthetic
 * default-public principal (no/invalid Authorization header), unless the route
 * declares `allowUnauthenticatedMutation: true`. These tests cover the four
 * security_reviewer.md axes: positive, negative, bypass, regression.
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

/**
 * Mirrors the real bearer-token middleware shape used in production: a missing
 * or invalid Authorization header leaves `ctx.principal` untouched (so the
 * server falls back to the synthetic public principal); a valid bearer mutates
 * `ctx.principal` to the real bound principal.
 */
function makeBearerStubMiddleware(
  validTokens: Record<string, { principalId: string; userId: string; tenantId: string; role: string; scopes: string[]; tokenId: string }>,
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

describe("FridayHttpServer public-mutation safety-floor gate", () => {
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

  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    it(`negative: ${method} on auth:{public:true} without Authorization → 401 OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED before handler runs`, async () => {
      let handlerCalls = 0;
      const routes = createFridayHttpRouteRegistry();
      routes.register({
        operationId: `test.gate.${method.toLowerCase()}`,
        method,
        path: `/v1/test/gate/${method.toLowerCase()}`,
        auth: { public: true },
        async handler() {
          handlerCalls += 1;
          return { handlerRan: true };
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

      const response = await fetch(`${baseUrl}/v1/test/gate/${method.toLowerCase()}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify({}),
      });
      expect(response.status).toBe(401);
      const body = await response.json() as { ok: false; error: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
      expect(body.error.message).toMatch(/synthetic public principal cannot approve mutating operations/);
      expect(body.error.message).toMatch(new RegExp(`test\\.gate\\.${method.toLowerCase()}`));
      // Critical: handler must NOT run when the gate rejects.
      expect(handlerCalls).toBe(0);
    });
  }

  it("regression: GET on auth:{public:true} without Authorization → 200 (read path unaffected)", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.gate.get.unaffected",
      method: "GET",
      path: "/v1/test/gate/get",
      auth: { public: true },
      async handler() {
        return { ok: true as const };
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

    const response = await fetch(`${baseUrl}/v1/test/gate/get`);
    expect(response.status).toBe(200);
  });

  it("positive: POST on auth:{public:true} WITH valid Bearer → 200 (real principal binds, gate passes)", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.gate.post.authenticated",
      method: "POST",
      path: "/v1/test/gate/post-authed",
      auth: { public: true },
      async handler(ctx) {
        return { principalId: ctx.principal!.principalId };
      },
    });

    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeBearerStubMiddleware({
        "real-token-abc": {
          principalId: "user:alice",
          userId: "11111111-1111-1111-1111-111111111111",
          tenantId: "22222222-2222-2222-2222-222222222222",
          role: "viewer",
          scopes: ["session.read"],
          tokenId: "33333333-3333-3333-3333-333333333333",
        },
      }),
      port,
      host: "127.0.0.1",
    });
    await server.listen();

    const response = await fetch(`${baseUrl}/v1/test/gate/post-authed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer real-token-abc" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: true; data: { principalId: string } };
    expect(body.data.principalId).toBe("user:alice");
    expect(body.data.principalId).not.toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);
  });

  it("carve-out: POST on auth:{public:true, allowUnauthenticatedMutation:true} without Authorization → reaches handler (200)", async () => {
    let handlerCalls = 0;
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.gate.carveout",
      method: "POST",
      path: "/v1/test/gate/carveout",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler() {
        handlerCalls += 1;
        return { ok: true as const };
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

    const response = await fetch(`${baseUrl}/v1/test/gate/carveout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    expect(handlerCalls).toBe(1);
  });

  it("bypass: malformed Authorization header (Basic scheme) still resolves to synthetic principal and the gate denies the mutation", async () => {
    let handlerCalls = 0;
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.gate.bypass.malformedauth",
      method: "POST",
      path: "/v1/test/gate/bypass",
      auth: { public: true },
      async handler() {
        handlerCalls += 1;
        return { ok: true as const };
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

    const response = await fetch(`${baseUrl}/v1/test/gate/bypass`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic dXNlcjpwYXNz" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
    const body = await response.json() as { ok: false; error: { code: string } };
    expect(body.error.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    expect(handlerCalls).toBe(0);
  });
});
