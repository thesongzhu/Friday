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

// ─── Tests ───

describe("FridayHttpServer — SEC-009: HSTS header", () => {
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

  function createTestServer() {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.ping",
      method: "GET",
      path: "/v1/ping",
      auth: { public: true },
      async handler() {
        return { pong: true };
      },
    });
    return createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
    });
  }

  it("includes HSTS header by default (unless explicitly disabled)", async () => {
    // Note: FRIDAY_ENABLE_HSTS is evaluated at module load time.
    // Since it's not set in the test environment, HSTS should be present.
    server = createTestServer();
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/ping`);
    expect(res.status).toBe(200);

    // HSTS should be present by default
    expect(res.headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains");

    // Other security headers should still be present
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  // Note: Testing FRIDAY_ENABLE_HSTS=false would require process.env manipulation
  // before module load, which is fragile. We verify the default-on behavior here.
});
