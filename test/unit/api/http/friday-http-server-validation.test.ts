import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  type FridayAuthMiddlewareFactory,
  type FridayHttpServer,
  type FridayRealtimeWsGateway,
} from "#api";

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

describe("FridayHttpServer validation", () => {
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

  it("rejects non-JSON request bodies before invoking the handler", async () => {
    const routes = createFridayHttpRouteRegistry();
    let handlerCalls = 0;
    routes.register({
      operationId: "test.validation.contenttype",
      method: "POST",
      path: "/v1/test/content-type",
      auth: { public: true },
      async handler() {
        handlerCalls += 1;
        return { ok: true };
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

    const response = await fetch(`${baseUrl}/v1/test/content-type`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ value: "not accepted without json content type" }),
    });
    const body = await response.json() as { ok: false; error: { code: string } };

    expect(response.status).toBe(415);
    expect(body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(handlerCalls).toBe(0);
  });

  it("fails closed when a handler returns undefined without taking over the response", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.validation.undefinedresponse",
      method: "GET",
      path: "/v1/test/undefined-response",
      auth: { public: true },
      async handler() {
        return undefined;
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

    const response = await fetch(`${baseUrl}/v1/test/undefined-response`);
    const body = await response.json() as { ok: false; error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal Server Error");
  });

  it("fails closed when a handler returns a non-JSON-serializable response", async () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.validation.nonjsonresponse",
      method: "GET",
      path: "/v1/test/non-json-response",
      auth: { public: true },
      async handler() {
        return { value: 1n };
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

    const response = await fetch(`${baseUrl}/v1/test/non-json-response`);
    const body = await response.json() as { ok: false; error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal Server Error");
  });
});
