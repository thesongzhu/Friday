import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import { createFridayHttpServer, createFridayHttpRouteRegistry } from "#api";
import type { FridayHttpServer } from "#api";
import type { FridayRealtimeWsGateway } from "#api";
import type { FridayAuthMiddlewareFactory } from "#api";

// ─── Helpers ───

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
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

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

// ─── Tests ───

describe("FridayHttpServer — Security Headers", () => {
  let server: FridayHttpServer;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
  });

  function createTestServer(handlerOverride?: () => Promise<unknown>) {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.ping",
      method: "GET",
      path: "/v1/ping",
      auth: { public: true },
      async handler() {
        if (handlerOverride) return handlerOverride();
        return { pong: true };
      },
    });
    return createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      corsOrigins: ["*"],
    });
  }

  it("includes security headers on 200 success response", async () => {
    server = createTestServer();
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/ping`);

    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  it("includes security headers on 404 not-found response", async () => {
    server = createTestServer();
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/nonexistent`);

    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  it("includes security headers on 500 error response", async () => {
    server = createTestServer(() => {
      throw new Error("kaboom");
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/ping`);

    expect(res.status).toBe(500);
    expectSecurityHeaders(res);
  });

  it("includes security headers on OPTIONS preflight response", async () => {
    server = createTestServer();
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/ping`, {
      method: "OPTIONS",
      headers: { Origin: "https://example.com" },
    });

    expect(res.status).toBe(204);
    expectSecurityHeaders(res);
  });
});
