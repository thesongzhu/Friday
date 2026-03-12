import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import { createFridayHttpServer, createFridayHttpRouteRegistry } from "#api";
import type { FridayHttpServer } from "#api";
import type { FridayRealtimeWsGateway } from "#api";
import type { FridayAuthMiddlewareFactory } from "#api";
import type { ServerResponse } from "node:http";

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

describe("FridayHttpServer — SSE _raw response injection", () => {
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

  it("injects _raw into handler context and supports SSE takeover", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.sse",
      method: "GET",
      path: "/v1/test-sse",
      auth: { public: true },
      async handler(ctx) {
        const rawRes = (ctx as unknown as Record<string, unknown>)._raw as ServerResponse | undefined;
        if (!rawRes) {
          return { streaming: false };
        }

        rawRes.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        rawRes.write("data: {\"type\":\"test\",\"value\":1}\n\n");
        rawRes.write("data: {\"type\":\"test\",\"value\":2}\n\n");
        rawRes.end();

        return undefined as unknown as Record<string, unknown>;
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

    const res = await fetch(`${baseUrl}/v1/test-sse`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const body = await res.text();
    expect(body).toContain("data: {\"type\":\"test\",\"value\":1}");
    expect(body).toContain("data: {\"type\":\"test\",\"value\":2}");
  });

  it("does not double-send response when handler takes over", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.sse.takeover",
      method: "GET",
      path: "/v1/test-takeover",
      auth: { public: true },
      async handler(ctx) {
        const rawRes = (ctx as unknown as Record<string, unknown>)._raw as ServerResponse | undefined;
        if (!rawRes) {
          return { ok: true };
        }

        rawRes.writeHead(200, { "Content-Type": "text/plain" });
        rawRes.end("Custom response");

        return undefined as unknown as Record<string, unknown>;
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

    const res = await fetch(`${baseUrl}/v1/test-takeover`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    const body = await res.text();
    expect(body).toBe("Custom response");
  });

  it("handles errors gracefully when headers already sent", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.sse.error",
      method: "GET",
      path: "/v1/test-sse-error",
      auth: { public: true },
      async handler(ctx) {
        const rawRes = (ctx as unknown as Record<string, unknown>)._raw as ServerResponse | undefined;
        if (!rawRes) {
          return { ok: true };
        }

        rawRes.writeHead(200, { "Content-Type": "text/event-stream" });
        rawRes.write("data: start\n\n");

        // Simulate an error after headers sent
        throw new Error("Something went wrong mid-stream");
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

    // The request should still complete without crashing the server
    const res = await fetch(`${baseUrl}/v1/test-sse-error`);
    expect(res.status).toBe(200);

    // Server should still be responsive after the error
    const pingRes = await fetch(`${baseUrl}/v1/test-sse-error`);
    // Server didn't crash — that's the test
    expect(pingRes.status).toBe(200);
  });
});
