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

describe("FridayHttpServer idempotency", () => {
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

  it("replays matching non-GET requests and rejects key reuse with a different payload", async () => {
    const routes = createFridayHttpRouteRegistry();
    let createCount = 0;
    routes.register({
      operationId: "test.idempotency.create",
      method: "POST",
      path: "/v1/test/idempotency",
      // Test focus: idempotency replay/conflict semantics. Orthogonal to the
      // public-mutation gate; opt out so the test isolates idempotency
      // behavior.
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx) {
        createCount += 1;
        return { count: createCount, body: ctx.body };
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

    const first = await fetch(`${baseUrl}/v1/test/idempotency`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "idem-1" },
      body: JSON.stringify({ value: "one" }),
    });
    const firstBody = await first.json() as { ok: true; data: { count: number; body: unknown } };

    const replay = await fetch(`${baseUrl}/v1/test/idempotency`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "idem-1" },
      body: JSON.stringify({ value: "one" }),
    });
    const replayBody = await replay.json() as { ok: true; data: { count: number; body: unknown } };

    const conflict = await fetch(`${baseUrl}/v1/test/idempotency`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "idem-1" },
      body: JSON.stringify({ value: "two" }),
    });
    const conflictBody = await conflict.json() as { ok: false; error: { code: string } };

    expect(first.status).toBe(200);
    expect(firstBody.data.count).toBe(1);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(replayBody.data).toEqual(firstBody.data);
    expect(conflict.status).toBe(409);
    expect(conflictBody.error.code).toBe("SECURITY_IDEMPOTENCY_KEY_CONFLICT");
    expect(createCount).toBe(1);
  });

  it("rejects a concurrent duplicate (same key) instead of running the handler twice", async () => {
    const routes = createFridayHttpRouteRegistry();
    let createCount = 0;
    routes.register({
      operationId: "test.idempotency.create.slow",
      method: "POST",
      path: "/v1/test/idempotency-slow",
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx) {
        createCount += 1;
        const id = createCount;
        // Hold the request open so a concurrent same-key request overlaps the in-flight window.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { id, body: ctx.body };
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

    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "race-1" },
      body: JSON.stringify({ value: "one" }),
    };

    // Fire two identical same-key requests concurrently. The reservation is set synchronously
    // (no await between the store .get and the in-flight .set), so exactly one runs the handler
    // and the other is rejected in-progress. Without the reservation both miss the store and
    // both execute (createCount === 2).
    const [a, b] = await Promise.all([
      fetch(`${baseUrl}/v1/test/idempotency-slow`, init),
      fetch(`${baseUrl}/v1/test/idempotency-slow`, init),
    ]);

    expect(createCount).toBe(1);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
    const conflict = a.status === 409 ? a : b;
    const conflictBody = await conflict.json() as { ok: false; error: { code: string } };
    expect(conflictBody.error.code).toBe("SECURITY_IDEMPOTENCY_IN_PROGRESS");
  });
});
