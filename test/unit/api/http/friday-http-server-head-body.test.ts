/**
 * Tests for HEAD request body suppression fix.
 * Verifies that HEAD requests to all response paths return headers but no body.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as http from "node:http";
import { createFridayHttpServer, createFridayHttpRouteRegistry } from "#api";
import type { FridayHttpServer } from "#api";
import type { FridayRealtimeWsGateway } from "#api";
import type { FridayAuthMiddlewareFactory } from "#api";
import { FridayDomainError } from "#errors";
import { createFridayHttpRawTextResponse } from "../../../../src/api/http/friday-http-raw-response.js";

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

/**
 * Raw HTTP HEAD request using node:http (fetch drops body for HEAD automatically,
 * so this gives us more control to verify the server's actual behavior).
 */
function rawHead(url: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "HEAD" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("FridayHttpServer — HEAD body suppression", () => {
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

  function createTestServer(opts?: {
    handlerFn?: () => Promise<unknown>;
    middleware?: FridayAuthMiddlewareFactory;
  }) {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.head",
      method: "GET",
      path: "/v1/head-test",
      auth: { public: true },
      async handler() {
        if (opts?.handlerFn) return opts.handlerFn();
        return { ok: true };
      },
    });
    return createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: opts?.middleware ?? makeStubMiddleware(),
      port,
      host: "127.0.0.1",
    });
  }

  it("HEAD on success route returns headers but empty body", async () => {
    server = createTestServer();
    await server.listen();

    const res = await rawHead(`${baseUrl}/v1/head-test`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
    expect(res.body).toBe("");
  });

  it("HEAD on 404 route returns headers but empty body", async () => {
    server = createTestServer();
    await server.listen();

    const res = await rawHead(`${baseUrl}/v1/nonexistent`);
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toBe("");
  });

  it("HEAD on error route returns headers but empty body", async () => {
    server = createTestServer({
      handlerFn: async () => {
        throw new FridayDomainError("TEST_ERROR", "test error", { httpStatus: 500 });
      },
    });
    await server.listen();

    const res = await rawHead(`${baseUrl}/v1/head-test`);
    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toBe("");
  });

  it("GET raw text response bypasses JSON envelope", async () => {
    server = createTestServer({
      handlerFn: async () => createFridayHttpRawTextResponse("challenge-plain", {
        contentType: "text/plain; charset=utf-8",
      }),
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/head-test`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("challenge-plain");
  });
});
