import { describe, expect, it, vi } from "vitest";

import { createFridaySystemRoutes } from "../../../../../src/api/http/routes/friday-system-routes.js";
import type { FridaySystemRoutesDeps } from "../../../../../src/api/http/routes/friday-system-routes.js";
import type { FridayRouteDefinition } from "../../../../../src/api/model/friday-api-common.types.js";

function makeDeps(overrides?: Partial<FridaySystemRoutesDeps>): FridaySystemRoutesDeps {
  return {
    session: {
      get: vi.fn().mockResolvedValue({ session: { id: "sess-1" } }),
    },
    state: {
      get: vi.fn().mockResolvedValue({ snapshot: { capturedAt: "2026-03-06T00:00:00.000Z" } }),
    },
    intents: {
      execute: vi.fn().mockResolvedValue({ result: { id: "intent-1", status: "completed" } }),
    },
    approvals: {
      list: vi.fn().mockReturnValue({ items: [], nextCursor: undefined }),
      update: vi.fn().mockReturnValue({ approval: { id: "approval-1", decision: "allow" } }),
    },
    events: {
      list: vi.fn().mockReturnValue({
        items: [{ id: "evt-1", seq: 1, event: "system.session.started", emittedAt: "2026-03-06T00:00:00.000Z", payload: {} }],
        nextAfterSeq: 1,
      }),
      subscribe: vi.fn().mockReturnValue(() => {}),
    },
    remote: {
      list: vi.fn().mockReturnValue({ items: [] }),
      register: vi.fn().mockReturnValue({
        device: { id: "device-1", label: "MacBook", platform: "browser" },
      }),
      revoke: vi.fn().mockReturnValue({ revoked: true, deviceId: "device-1" }),
      clearPasskey: vi.fn().mockResolvedValue({
        cleared: true,
        deviceId: "device-1",
        device: { id: "device-1", label: "MacBook", platform: "browser" },
      }),
      listSessions: vi.fn().mockReturnValue({ items: [] }),
      openSession: vi.fn().mockResolvedValue({
        session: { id: "remote-session-1", status: "active", devicePlatform: "browser" },
      }),
      heartbeatSession: vi.fn().mockResolvedValue({
        session: { id: "remote-session-1", status: "active", devicePlatform: "browser" },
      }),
      closeSession: vi.fn().mockResolvedValue({ closed: true, sessionId: "remote-session-1" }),
    },
    remoteAuth: {
      beginRegistration: vi.fn().mockResolvedValue({
        challengeId: "challenge-1",
        deviceId: "device-1",
        rpId: "localhost",
        origin: "http://localhost:3141",
        expiresAt: "2026-03-06T00:05:00.000Z",
        options: { challenge: "challenge-value" },
      }),
      verifyRegistration: vi.fn().mockResolvedValue({
        device: { id: "device-1", label: "MacBook", platform: "browser", credentialId: "cred-1" },
        credentialId: "cred-1",
        verifiedAt: "2026-03-06T00:01:00.000Z",
      }),
      beginAssertion: vi.fn().mockResolvedValue({
        challengeId: "challenge-2",
        deviceId: "device-1",
        rpId: "localhost",
        origin: "http://localhost:3141",
        expiresAt: "2026-03-06T00:05:00.000Z",
        options: { challenge: "challenge-value" },
      }),
      verifyAssertion: vi.fn().mockResolvedValue({
        device: { id: "device-1", label: "MacBook", platform: "browser", credentialId: "cred-1" },
        assertionToken: "assertion-token",
        expiresAt: "2026-03-06T00:03:00.000Z",
        verifiedAt: "2026-03-06T00:01:00.000Z",
      }),
    },
    ...overrides,
  };
}

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    requestId: "req-001",
    receivedAt: "2026-03-06T00:00:00.000Z",
    params: {},
    query: {},
    body: {},
    headers: {},
    ip: "127.0.0.1",
    userAgent: "vitest",
    principal: {
      principalType: "user",
      principalId: "u-1",
      userId: "u-1",
      role: "admin",
      scopes: ["desktop.read", "desktop.write", "desktop.execute"],
      tokenId: "t-1",
      tokenKind: "access",
      issuedAt: "2026-03-06T00:00:00.000Z",
    },
    ...overrides,
  } as Parameters<FridayRouteDefinition<unknown, unknown, unknown, unknown>["handler"]>[0];
}

function findRoute(
  routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[],
  operationId: string,
): FridayRouteDefinition<unknown, unknown, unknown, unknown> {
  const route = routes.find((entry) => entry.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route;
}

describe("createFridaySystemRoutes", () => {
  it("returns authenticated system route definitions", () => {
    const routes = createFridaySystemRoutes(makeDeps());
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.path).toMatch(/^\/v1\/system\//);
      expect(route.method).toMatch(/^(GET|POST|PATCH|DELETE)$/);
      expect((route.auth as { public: boolean }).public).toBe(false);
    }
  });

  it("validates action and idempotencyKey on intent execution", async () => {
    const routes = createFridaySystemRoutes(makeDeps());
    const route = findRoute(routes, "system.intents.execute");

    await expect(route.handler(makeCtx({ body: { idempotencyKey: "k-1" } }))).rejects.toThrow("action is required");
    await expect(route.handler(makeCtx({ body: { action: "snapshot" } }))).rejects.toThrow("idempotencyKey is required");
  });

  it("parses approval list limit before delegating", async () => {
    const deps = makeDeps();
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.approvals.list");

    await route.handler(makeCtx({ query: { action: "clipboard_read", limit: "25" } }));

    expect(deps.approvals.list).toHaveBeenCalledWith({
      action: "clipboard_read",
      limit: 25,
    });
  });

  it("validates trusted-device platform on remote registration", async () => {
    const routes = createFridaySystemRoutes(makeDeps());
    const route = findRoute(routes, "system.remote.devices.register");

    await expect(
      route.handler(
        makeCtx({
          body: {
            label: "iPhone",
            fingerprint: "fp-ios",
            platform: "tablet",
            idempotencyKey: "k-1",
          },
        }),
      ),
    ).rejects.toThrow("platform must be one of: browser, ios, android");
  });

  it("returns JSON event listing when SSE response is unavailable", async () => {
    const deps = makeDeps();
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.events.stream");

    const result = await route.handler(makeCtx({ query: { afterSeq: "1", limit: "10", stream: "false" } }));

    expect(deps.events.list).toHaveBeenCalledWith({
      afterSeq: 1,
      limit: 10,
      stream: "false",
    });
    expect(result).toHaveProperty("items");
  });

  it("streams events over SSE and unsubscribes on close", async () => {
    const unsubscribe = vi.fn();
    const deps = makeDeps({
      events: {
        list: vi.fn().mockReturnValue({
          items: [{ id: "evt-1", seq: 1, event: "system.session.started", emittedAt: "2026-03-06T00:00:00.000Z", payload: {} }],
          nextAfterSeq: 1,
        }),
        subscribe: vi.fn().mockReturnValue(unsubscribe),
      },
    });
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.events.stream");
    const chunks: string[] = [];
    let closeHandler: (() => void) | undefined;
    const raw = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
      end: vi.fn(),
      on: vi.fn((event: "close", listener: () => void) => {
        if (event === "close") {
          closeHandler = listener;
        }
      }),
    };

    const result = await route.handler(makeCtx({
      query: { afterSeq: "0" },
      _raw: raw,
    }));

    expect(result).toBeUndefined();
    expect(raw.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream",
    }));
    expect(chunks.some((chunk) => chunk.includes("\"seq\":1"))).toBe(true);
    expect(deps.events.subscribe).toHaveBeenCalled();

    closeHandler?.();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("validates remote registration inputs", async () => {
    const routes = createFridaySystemRoutes(makeDeps());
    const route = findRoute(routes, "system.remote.devices.register");

    await expect(route.handler(makeCtx({ body: { label: "MacBook", idempotencyKey: "k-1" } }))).rejects.toThrow("fingerprint is required");
    await expect(route.handler(makeCtx({ body: { label: "MacBook", fingerprint: "fp-1" } }))).rejects.toThrow("idempotencyKey is required");
  });

  it("routes remote passkey clearing through the remote dependency", async () => {
    const deps = makeDeps();
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.remote.devices.passkey.delete");

    const result = await route.handler(makeCtx({
      params: { deviceId: "device-1" },
    }));

    expect(deps.remote.clearPasskey).toHaveBeenCalledWith("device-1");
    expect(result).toMatchObject({
      cleared: true,
      deviceId: "device-1",
    });
  });

  it("parses remote session list filters before delegating", async () => {
    const deps = makeDeps();
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.remote.sessions.list");

    await route.handler(makeCtx({ query: { status: "active", limit: "12" } }));

    expect(deps.remote.listSessions).toHaveBeenCalledWith({
      status: "active",
      limit: 12,
    });
  });

  it("routes passkey registration and assertion requests with origin metadata", async () => {
    const deps = makeDeps();
    const routes = createFridaySystemRoutes(deps);
    const registerOptionsRoute = findRoute(routes, "system.remote.auth.register.options");
    const registerVerifyRoute = findRoute(routes, "system.remote.auth.register.verify");
    const assertOptionsRoute = findRoute(routes, "system.remote.auth.assert.options");
    const assertVerifyRoute = findRoute(routes, "system.remote.auth.assert.verify");

    await registerOptionsRoute.handler(makeCtx({
      body: { deviceId: "device-1", idempotencyKey: "reg-options-key" },
      headers: { origin: "http://localhost:3141" },
    }));
    await registerVerifyRoute.handler(makeCtx({
      body: {
        deviceId: "device-1",
        challengeId: "challenge-1",
        response: { id: "cred-1" },
        idempotencyKey: "reg-verify-key",
      },
      headers: { origin: "http://localhost:3141" },
    }));
    await assertOptionsRoute.handler(makeCtx({
      body: { deviceId: "device-1", idempotencyKey: "assert-options-key" },
      headers: { origin: "http://localhost:3141" },
    }));
    await assertVerifyRoute.handler(makeCtx({
      body: {
        deviceId: "device-1",
        challengeId: "challenge-2",
        response: { id: "cred-1" },
        idempotencyKey: "assert-verify-key",
      },
      ip: "192.168.1.10",
      userAgent: "agent-os-ui",
      headers: { origin: "http://localhost:3141" },
    }));

    expect(deps.remoteAuth.beginRegistration).toHaveBeenCalledWith(
      { deviceId: "device-1", idempotencyKey: "reg-options-key" },
      { origin: "http://localhost:3141" },
    );
    expect(deps.remoteAuth.verifyRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "device-1",
        challengeId: "challenge-1",
      }),
      { origin: "http://localhost:3141" },
    );
    expect(deps.remoteAuth.beginAssertion).toHaveBeenCalledWith(
      { deviceId: "device-1", idempotencyKey: "assert-options-key" },
      { origin: "http://localhost:3141" },
    );
    expect(deps.remoteAuth.verifyAssertion).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "device-1",
        challengeId: "challenge-2",
      }),
      { origin: "http://localhost:3141", ipAddress: "192.168.1.10", userAgent: "agent-os-ui" },
    );
  });

  it("passes client metadata into remote session open and heartbeat routes", async () => {
    const deps = makeDeps();
    const routes = createFridaySystemRoutes(deps);
    const createRoute = findRoute(routes, "system.remote.sessions.create");
    const heartbeatRoute = findRoute(routes, "system.remote.sessions.heartbeat");

    await createRoute.handler(makeCtx({
      body: { deviceId: "device-1", assertionToken: "assertion-token", idempotencyKey: "create-key" },
      ip: "192.168.1.10",
      userAgent: "agent-os-ui",
    }));
    await heartbeatRoute.handler(makeCtx({
      params: { sessionId: "remote-session-1" },
      body: { idempotencyKey: "heartbeat-key" },
      ip: "192.168.1.10",
      userAgent: "agent-os-ui",
    }));

    expect(deps.remote.openSession).toHaveBeenCalledWith(
      { deviceId: "device-1", assertionToken: "assertion-token", idempotencyKey: "create-key" },
      { ipAddress: "192.168.1.10", userAgent: "agent-os-ui" },
    );
    expect(deps.remote.heartbeatSession).toHaveBeenCalledWith(
      "remote-session-1",
      { idempotencyKey: "heartbeat-key" },
      { ipAddress: "192.168.1.10", userAgent: "agent-os-ui" },
    );
  });
});
