import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

function createRoutesWithHealth() {
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
  return routes;
}

// ─── Tests ───

describe("FridayHttpServer — CORS", () => {
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

  it("returns 204 with CORS headers on OPTIONS preflight when origin is allowed", async () => {
    server = createFridayHttpServer({
      routes: createRoutesWithHealth(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      corsOrigins: ["*"],
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/ping`, {
      method: "OPTIONS",
      headers: { Origin: "https://example.com" },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  it("includes CORS headers on normal GET responses when origin matches", async () => {
    server = createFridayHttpServer({
      routes: createRoutesWithHealth(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      corsOrigins: ["https://myapp.com"],
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/ping`, {
      headers: { Origin: "https://myapp.com" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://myapp.com");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("does not include CORS headers when origin is not in allowlist", async () => {
    server = createFridayHttpServer({
      routes: createRoutesWithHealth(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      corsOrigins: ["https://allowed.com"],
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/ping`, {
      headers: { Origin: "https://evil.com" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not include CORS headers when corsOrigins is empty (disabled)", async () => {
    server = createFridayHttpServer({
      routes: createRoutesWithHealth(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      corsOrigins: [],
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/ping`, {
      headers: { Origin: "https://example.com" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not include CORS headers when no Origin header is sent", async () => {
    server = createFridayHttpServer({
      routes: createRoutesWithHealth(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      corsOrigins: ["*"],
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/ping`);

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("includes CORS headers on 404 responses", async () => {
    server = createFridayHttpServer({
      routes: createRoutesWithHealth(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      corsOrigins: ["*"],
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/nonexistent`, {
      headers: { Origin: "https://example.com" },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("FridayHttpServer — Request Logging", () => {
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

  it("logs requests in [FRIDAY] format when enabled", async () => {
    const logs: string[] = [];
    server = createFridayHttpServer({
      routes: createRoutesWithHealth(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      logRequests: true,
      logger: (line) => logs.push(line),
    });
    await server.listen();

    await fetch(`${baseUrl}/v1/ping`);

    // Wait for the finish event
    await new Promise((r) => setTimeout(r, 50));

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[FRIDAY\] GET \/v1\/ping 200 \d+ms$/);
  });

  it("does not log when logRequests is false", async () => {
    const logs: string[] = [];
    server = createFridayHttpServer({
      routes: createRoutesWithHealth(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      logRequests: false,
      logger: (line) => logs.push(line),
    });
    await server.listen();

    await fetch(`${baseUrl}/v1/ping`);

    await new Promise((r) => setTimeout(r, 50));

    expect(logs).toHaveLength(0);
  });

  it("logs 404 responses", async () => {
    const logs: string[] = [];
    server = createFridayHttpServer({
      routes: createRoutesWithHealth(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      logRequests: true,
      logger: (line) => logs.push(line),
    });
    await server.listen();

    await fetch(`${baseUrl}/v1/missing`);

    await new Promise((r) => setTimeout(r, 50));

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[FRIDAY\] GET \/v1\/missing 404 \d+ms$/);
  });

  it("includes timing information in ms", async () => {
    const logs: string[] = [];
    server = createFridayHttpServer({
      routes: createRoutesWithHealth(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      logRequests: true,
      logger: (line) => logs.push(line),
    });
    await server.listen();

    await fetch(`${baseUrl}/v1/ping`);

    await new Promise((r) => setTimeout(r, 50));

    const match = logs[0]?.match(/(\d+)ms$/);
    expect(match).not.toBeNull();
    const ms = parseInt(match![1]!, 10);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(5000); // sanity check
  });
});
