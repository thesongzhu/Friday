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
    executeSystemIntentViaRust: vi.fn().mockResolvedValue({
      result: {
        id: "system-intent:api:u-1:k-1",
        action: "snapshot",
        status: "unavailable",
        message: "rust_system_action_dry_run_observed",
        performedAt: "2026-03-06T00:00:00.000Z",
        payload: {
          truthLabel: "b3_system_intent_rust_dark_entrypoint",
          osActuated: false,
          completesEffect: false,
        },
      },
    }),
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
    allowTestOnlySystemIntentExecution: true,
    allowTestOnlySystemApprovalExecution: true,
    allowTestOnlySystemRemoteExecution: true,
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
    // Pre-auth carve-outs require allowUnauthenticatedMutation:true. Slice A
    // (PR #298) carved out the three .verify / sessions.create routes whose
    // handlers consume a one-time WebAuthn challenge or assertion token. B0
    // Slice A4 adds four more: the .options challenge issuance pair (challenge
    // is single-use, server-bound, device-bound, time-limited; downstream
    // .verify is the trust handle), and the sessions.heartbeat / sessions.delete
    // pair (sessionId is a high-entropy server-issued UUID bearer, verified by
    // the underlying remote-session service before any mutation). All other
    // routes remain {public:true} only and rely on the Slice A server-level
    // public-mutation gate; device-management routes intentionally stay
    // default-blocked because their handlers have no in-process verifier.
    const carveOutOps = new Set([
      // Slice A:
      "system.remote.auth.register.verify",
      "system.remote.auth.assert.verify",
      "system.remote.sessions.create",
      // Slice A4:
      "system.remote.auth.register.options",
      "system.remote.auth.assert.options",
      "system.remote.sessions.heartbeat",
      "system.remote.sessions.delete",
    ]);
    for (const route of routes) {
      expect(route.path).toMatch(/^\/v1\/system\//);
      expect(route.method).toMatch(/^(GET|POST|PATCH|DELETE)$/);
      expect(route.auth).toEqual(
        carveOutOps.has(route.operationId)
          ? { public: true, allowUnauthenticatedMutation: true }
          : { public: true },
      );
    }
  });

  it("validates action and idempotencyKey on intent execution", async () => {
    const routes = createFridaySystemRoutes(makeDeps());
    const route = findRoute(routes, "system.intents.execute");

    await expect(route.handler(makeCtx({ body: { idempotencyKey: "k-1" } }))).rejects.toThrow("action is required");
    await expect(route.handler(makeCtx({ body: { action: "snapshot" } }))).rejects.toThrow("idempotencyKey is required");
  });

  it("does not forward client-supplied canonicalApproval on intent execution", async () => {
    const deps = makeDeps();
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.intents.execute");

    await route.handler(makeCtx({
      body: {
        action: "open_url",
        url: "https://example.com",
        idempotencyKey: "k-1",
        canonicalApproval: {
          decision: "approved",
          actionDigest: "forged",
        },
      },
    }));

    expect(deps.intents.execute).toHaveBeenCalledWith({
      action: "open_url",
      url: "https://example.com",
      idempotencyKey: "k-1",
    });
  });

  it("routes intent execution through the Rust courier only when explicitly enabled", async () => {
    const deps = makeDeps({
      allowTestOnlySystemIntentExecution: false,
      systemIntentViaRust: true,
    });
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.intents.execute");

    await route.handler(makeCtx({
      body: {
        action: "snapshot",
        idempotencyKey: "k-1",
        actorId: "client-forged",
        actorKind: "agent",
        canonicalApproval: {
          decision: "approved",
          actionDigest: "forged",
        },
      },
    }));

    expect(deps.intents.execute).not.toHaveBeenCalled();
    expect(deps.executeSystemIntentViaRust).toHaveBeenCalledWith({
      action: "snapshot",
      idempotencyKey: "k-1",
      actorId: "u-1",
      actorKind: "api",
    });
  });

  it("keeps intent execution fail-closed when the Rust courier flag is absent", async () => {
    const deps = makeDeps({
      allowTestOnlySystemIntentExecution: false,
      systemIntentViaRust: false,
    });
    const routes = createFridaySystemRoutes(deps);

    await expect(
      findRoute(routes, "system.intents.execute").handler(
        makeCtx({ body: { action: "snapshot", idempotencyKey: "k-1" } }),
      ),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_SYSTEM_INTENT_RETIRED", httpStatus: 503 });
    expect(deps.executeSystemIntentViaRust).not.toHaveBeenCalled();
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
      socketIp: "127.0.0.1",
      userAgent: "agent-os-ui",
      headers: {
        origin: "http://localhost:3141",
        "x-forwarded-for": "203.0.113.50",
        "x-real-ip": "203.0.113.51",
      },
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
      socketIp: "127.0.0.1",
      userAgent: "agent-os-ui",
      headers: {
        "x-forwarded-for": "203.0.113.60",
        "x-real-ip": "203.0.113.61",
      },
    }));
    await heartbeatRoute.handler(makeCtx({
      params: { sessionId: "remote-session-1" },
      body: { idempotencyKey: "heartbeat-key" },
      ip: "192.168.1.10",
      socketIp: "127.0.0.1",
      userAgent: "agent-os-ui",
      headers: {
        "x-forwarded-for": "203.0.113.62",
        "x-real-ip": "203.0.113.63",
      },
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

  it("falls back to socketIp when the parsed client IP is unavailable", async () => {
    const deps = makeDeps();
    const routes = createFridaySystemRoutes(deps);
    const createRoute = findRoute(routes, "system.remote.sessions.create");

    await createRoute.handler(makeCtx({
      body: { deviceId: "device-1", assertionToken: "assertion-token", idempotencyKey: "create-key" },
      ip: undefined,
      socketIp: "192.168.1.25",
      userAgent: "agent-os-ui",
    }));

    expect(deps.remote.openSession).toHaveBeenCalledWith(
      { deviceId: "device-1", assertionToken: "assertion-token", idempotencyKey: "create-key" },
      { ipAddress: "192.168.1.25", userAgent: "agent-os-ui" },
    );
  });

  // ─── Pre-auth carve-out negative paths ───
  //
  // The three remote-auth/session routes below opt in to
  // allowUnauthenticatedMutation because their handler delegates to a
  // verifier (WebAuthn challenge / assertion / one-time assertionToken) that
  // fails closed when the verifier input is bad or missing. These tests prove
  // that the rejection from the verifier propagates and that no other
  // side-effect dep (passkey persistence on the device list, session list, or
  // sessions.create) is invoked. They satisfy the per-route negative-test bar
  // for opting out of the server-level public-mutation gate.

  it("system.remote.auth.register.verify rejection prevents passkey persistence (no device-list mutation)", async () => {
    const verifyError = Object.assign(new Error("WebAuthn registration challenge invalid"), {
      code: "REMOTE_AUTH_CHALLENGE_INVALID",
      httpStatus: 401,
    });
    const deps = makeDeps({
      remoteAuth: {
        beginRegistration: vi.fn().mockResolvedValue({
          challengeId: "challenge-1",
          deviceId: "device-1",
          rpId: "localhost",
          origin: "http://localhost:3141",
          expiresAt: "2026-03-06T00:05:00.000Z",
          options: { challenge: "challenge-value" },
        }),
        verifyRegistration: vi.fn().mockRejectedValue(verifyError),
        beginAssertion: vi.fn(),
        verifyAssertion: vi.fn(),
      },
    });
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.remote.auth.register.verify");

    await expect(
      route.handler(
        makeCtx({
          body: {
            deviceId: "device-1",
            challengeId: "bogus-challenge",
            response: { id: "cred-1" },
            idempotencyKey: "reg-verify-key",
          },
          headers: { origin: "http://localhost:3141" },
          principal: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "REMOTE_AUTH_CHALLENGE_INVALID" });

    expect(deps.remoteAuth.verifyRegistration).toHaveBeenCalledTimes(1);
    // No downstream device-list/register mutation when verify fails.
    expect(deps.remote.register).not.toHaveBeenCalled();
  });

  it("system.remote.auth.assert.verify rejection prevents assertion-token minting (no session opened)", async () => {
    const verifyError = Object.assign(new Error("WebAuthn assertion verification failed"), {
      code: "REMOTE_AUTH_ASSERTION_INVALID",
      httpStatus: 401,
    });
    const deps = makeDeps({
      remoteAuth: {
        beginRegistration: vi.fn(),
        verifyRegistration: vi.fn(),
        beginAssertion: vi.fn().mockResolvedValue({
          challengeId: "challenge-2",
          deviceId: "device-1",
          rpId: "localhost",
          origin: "http://localhost:3141",
          expiresAt: "2026-03-06T00:05:00.000Z",
          options: { challenge: "challenge-value" },
        }),
        verifyAssertion: vi.fn().mockRejectedValue(verifyError),
      },
    });
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.remote.auth.assert.verify");

    await expect(
      route.handler(
        makeCtx({
          body: {
            deviceId: "device-1",
            challengeId: "bogus-challenge",
            response: { id: "cred-1" },
            idempotencyKey: "assert-verify-key",
          },
          headers: { origin: "http://localhost:3141" },
          principal: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "REMOTE_AUTH_ASSERTION_INVALID" });

    expect(deps.remoteAuth.verifyAssertion).toHaveBeenCalledTimes(1);
    // No downstream session minting when assertion verify fails.
    expect(deps.remote.openSession).not.toHaveBeenCalled();
  });

  it("system.remote.sessions.create rejection on invalid assertionToken prevents session minting", async () => {
    const openError = Object.assign(new Error("Assertion token invalid or expired"), {
      code: "REMOTE_SESSION_ASSERTION_INVALID",
      httpStatus: 401,
    });
    const deps = makeDeps({
      remote: {
        list: vi.fn(),
        register: vi.fn(),
        revoke: vi.fn(),
        clearPasskey: vi.fn(),
        listSessions: vi.fn(),
        openSession: vi.fn().mockRejectedValue(openError),
        heartbeatSession: vi.fn(),
        closeSession: vi.fn(),
      },
    });
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.remote.sessions.create");

    await expect(
      route.handler(
        makeCtx({
          body: {
            deviceId: "device-1",
            assertionToken: "forged-token",
            idempotencyKey: "create-key",
          },
          principal: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "REMOTE_SESSION_ASSERTION_INVALID" });

    expect(deps.remote.openSession).toHaveBeenCalledTimes(1);
    // No downstream heartbeat or close on rejected open.
    expect(deps.remote.heartbeatSession).not.toHaveBeenCalled();
    expect(deps.remote.closeSession).not.toHaveBeenCalled();
  });

  // ─── B0 Slice A4: WebAuthn challenge-issuance + session-bearer carve-outs ───

  it("A4: register.options + assert.options + sessions.heartbeat + sessions.delete declare the carve-out flag; devices.* routes do NOT", () => {
    const routes = createFridaySystemRoutes(makeDeps());
    const flagged = new Map<string, boolean>();
    for (const r of routes) {
      if (typeof r.auth === "object" && r.auth.public === true) {
        flagged.set(
          r.operationId,
          (r.auth as { allowUnauthenticatedMutation?: true }).allowUnauthenticatedMutation === true,
        );
      }
    }

    // A4 carve-outs (this slice):
    expect(flagged.get("system.remote.auth.register.options")).toBe(true);
    expect(flagged.get("system.remote.auth.assert.options")).toBe(true);
    expect(flagged.get("system.remote.sessions.heartbeat")).toBe(true);
    expect(flagged.get("system.remote.sessions.delete")).toBe(true);

    // Already carved out in Slice A (re-verified, not duplicated):
    expect(flagged.get("system.remote.auth.register.verify")).toBe(true);
    expect(flagged.get("system.remote.auth.assert.verify")).toBe(true);
    expect(flagged.get("system.remote.sessions.create")).toBe(true);

    // Default-blocked by Slice A's gate (NO carve-out — device-management requires
    // an authenticated bound principal; no pre-auth use case):
    expect(flagged.get("system.remote.devices.register")).toBe(false);
    expect(flagged.get("system.remote.devices.delete")).toBe(false);
    expect(flagged.get("system.remote.devices.passkey.delete")).toBe(false);
  });

  it("A4 register.options: missing deviceId rejects before challenge issued", async () => {
    const deps = makeDeps();
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.remote.auth.register.options");

    await expect(
      route.handler(
        makeCtx({
          body: { idempotencyKey: "reg-options-1" }, // deviceId omitted
          principal: null, // synthetic-public principal (reaches the handler via carve-out)
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Verifier-side proof: no challenge issued, no other passkey state changed.
    expect(deps.remoteAuth.beginRegistration).not.toHaveBeenCalled();
    expect(deps.remoteAuth.verifyRegistration).not.toHaveBeenCalled();
    expect(deps.remoteAuth.beginAssertion).not.toHaveBeenCalled();
    expect(deps.remoteAuth.verifyAssertion).not.toHaveBeenCalled();
  });

  it("A4 assert.options: missing deviceId rejects before challenge issued", async () => {
    const deps = makeDeps();
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.remote.auth.assert.options");

    await expect(
      route.handler(
        makeCtx({
          body: { idempotencyKey: "assert-options-1" }, // deviceId omitted
          principal: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(deps.remoteAuth.beginAssertion).not.toHaveBeenCalled();
    expect(deps.remoteAuth.verifyAssertion).not.toHaveBeenCalled();
    expect(deps.remoteAuth.beginRegistration).not.toHaveBeenCalled();
    expect(deps.remoteAuth.verifyRegistration).not.toHaveBeenCalled();
  });

  it("A4 sessions.heartbeat: unknown sessionId is verified by deps.remote and does not mutate other sessions", async () => {
    // Simulate the underlying behavior of `systemService.touchRemoteSession`:
    // an unknown sessionId returns null without any write
    // (`src/system/engine/friday-system-service.ts:1746-1755`).
    const deps = makeDeps({
      remote: {
        list: vi.fn(),
        register: vi.fn(),
        revoke: vi.fn(),
        clearPasskey: vi.fn(),
        listSessions: vi.fn(),
        openSession: vi.fn(),
        heartbeatSession: vi.fn().mockResolvedValue({ session: null }),
        closeSession: vi.fn(),
      },
    });
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.remote.sessions.heartbeat");

    const result = await route.handler(
      makeCtx({
        params: { sessionId: "00000000-0000-4000-8000-000000000000" }, // forged but well-formed UUID
        body: { idempotencyKey: "hb-1" },
        principal: null, // synthetic-public reaches handler via carve-out
      }),
    );

    // Handler returns the verifier's null verdict truthfully; no other session
    // is touched, no session is closed, no device is registered.
    expect(result).toEqual({ session: null });
    expect(deps.remote.heartbeatSession).toHaveBeenCalledTimes(1);
    expect(deps.remote.heartbeatSession).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000000",
      expect.objectContaining({ idempotencyKey: "hb-1" }),
      expect.any(Object),
    );
    expect(deps.remote.closeSession).not.toHaveBeenCalled();
    expect(deps.remote.openSession).not.toHaveBeenCalled();
    expect(deps.remote.register).not.toHaveBeenCalled();
    expect(deps.remote.revoke).not.toHaveBeenCalled();
  });

  it("A4 sessions.delete: unknown sessionId yields closed=false without side effect on other sessions", async () => {
    // Underlying `repository.closeRemoteSession` targets the row by id; an
    // unknown id affects 0 rows. The handler returns the truthful boolean.
    const deps = makeDeps({
      remote: {
        list: vi.fn(),
        register: vi.fn(),
        revoke: vi.fn(),
        clearPasskey: vi.fn(),
        listSessions: vi.fn(),
        openSession: vi.fn(),
        heartbeatSession: vi.fn(),
        closeSession: vi.fn().mockResolvedValue({
          closed: false,
          sessionId: "00000000-0000-4000-8000-000000000001",
        }),
      },
    });
    const routes = createFridaySystemRoutes(deps);
    const route = findRoute(routes, "system.remote.sessions.delete");

    const result = await route.handler(
      makeCtx({
        params: { sessionId: "00000000-0000-4000-8000-000000000001" },
        principal: null,
      }),
    );

    expect(result).toEqual({ closed: false, sessionId: "00000000-0000-4000-8000-000000000001" });
    expect(deps.remote.closeSession).toHaveBeenCalledTimes(1);
    expect(deps.remote.heartbeatSession).not.toHaveBeenCalled();
    expect(deps.remote.openSession).not.toHaveBeenCalled();
    expect(deps.remote.register).not.toHaveBeenCalled();
    expect(deps.remote.revoke).not.toHaveBeenCalled();
  });

  it("A4 regression: authenticated principal can still call all 4 system.remote.* routes the slice carved out (register.options + assert.options + sessions.heartbeat + sessions.delete)", async () => {
    // Sanity-check that A4 did not break the authenticated admin flow that was
    // already working under Slice A. The makeCtx default principal is an
    // authenticated admin.
    const deps = makeDeps();
    const routes = createFridaySystemRoutes(deps);

    await findRoute(routes, "system.remote.auth.register.options").handler(
      makeCtx({ body: { deviceId: "device-1", idempotencyKey: "reg-opt-key" } }),
    );
    await findRoute(routes, "system.remote.auth.assert.options").handler(
      makeCtx({ body: { deviceId: "device-1", idempotencyKey: "assert-opt-key" } }),
    );
    await findRoute(routes, "system.remote.sessions.heartbeat").handler(
      makeCtx({
        params: { sessionId: "remote-session-1" },
        body: { idempotencyKey: "hb-key" },
      }),
    );
    await findRoute(routes, "system.remote.sessions.delete").handler(
      makeCtx({ params: { sessionId: "remote-session-1" } }),
    );

    expect(deps.remoteAuth.beginRegistration).toHaveBeenCalledTimes(1);
    expect(deps.remoteAuth.beginAssertion).toHaveBeenCalledTimes(1);
    expect(deps.remote.heartbeatSession).toHaveBeenCalledTimes(1);
    expect(deps.remote.closeSession).toHaveBeenCalledTimes(1);
  });
});

describe("TS runtime retirement — system mutations fail-close by default", () => {
  function failClosedDeps() {
    return makeDeps({
      allowTestOnlySystemIntentExecution: false,
      allowTestOnlySystemApprovalExecution: false,
      allowTestOnlySystemRemoteExecution: false,
    });
  }

  it("intents.execute fail-closes with TS_RUNTIME_SYSTEM_INTENT_RETIRED (503) when the flag is unset", async () => {
    const deps = failClosedDeps();
    const routes = createFridaySystemRoutes(deps);
    await expect(
      findRoute(routes, "system.intents.execute").handler(
        makeCtx({ body: { action: "open_url", target: "https://example.com", idempotencyKey: "k-1" } }),
      ),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_SYSTEM_INTENT_RETIRED", httpStatus: 503 });
    expect(deps.intents.execute).not.toHaveBeenCalled();
  });

  it("approvals.update fail-closes with TS_RUNTIME_SYSTEM_APPROVAL_RETIRED (503) when the flag is unset", async () => {
    const deps = failClosedDeps();
    const routes = createFridaySystemRoutes(deps);
    await expect(
      findRoute(routes, "system.approvals.update").handler(
        makeCtx({ params: { approvalId: "approval-1" }, body: { idempotencyKey: "k-1", decision: "approved" } }),
      ),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_SYSTEM_APPROVAL_RETIRED", httpStatus: 503 });
    expect(deps.approvals.update).not.toHaveBeenCalled();
  });

  it("remote device/session/WebAuthn mutations fail-close with TS_RUNTIME_SYSTEM_REMOTE_RETIRED (503) when the flag is unset", async () => {
    const deps = failClosedDeps();
    const routes = createFridaySystemRoutes(deps);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["system.remote.devices.register", { body: { label: "iPhone", fingerprint: "fp-ios", platform: "ios", idempotencyKey: "k-1" } }],
      ["system.remote.devices.delete", { params: { deviceId: "device-1" } }],
      ["system.remote.devices.passkey.delete", { params: { deviceId: "device-1" } }],
      ["system.remote.auth.register.options", { body: { deviceId: "device-1", idempotencyKey: "reg-options-key" } }],
      ["system.remote.auth.assert.options", { body: { deviceId: "device-1", idempotencyKey: "assert-options-key" } }],
      ["system.remote.sessions.create", { body: { deviceId: "device-1", assertionToken: "assertion-token", idempotencyKey: "create-key" } }],
      ["system.remote.sessions.heartbeat", { params: { sessionId: "remote-session-1" }, body: { idempotencyKey: "hb-key" } }],
      ["system.remote.sessions.delete", { params: { sessionId: "remote-session-1" } }],
    ];
    for (const [op, ctx] of cases) {
      await expect(findRoute(routes, op).handler(makeCtx(ctx))).rejects.toMatchObject({
        code: "TS_RUNTIME_SYSTEM_REMOTE_RETIRED",
        httpStatus: 503,
      });
    }
    // The remote service mutations were never reached.
    expect(deps.remote.register).not.toHaveBeenCalled();
    expect(deps.remoteAuth.beginRegistration).not.toHaveBeenCalled();
    expect(deps.remote.openSession).not.toHaveBeenCalled();
  });

  it("still 400s on invalid input BEFORE the retirement guard (validation precedes the guard)", async () => {
    const routes = createFridaySystemRoutes(failClosedDeps());
    // intents.execute missing action => 400, not 503
    await expect(
      findRoute(routes, "system.intents.execute").handler(makeCtx({ body: { idempotencyKey: "k-1" } })),
    ).rejects.toMatchObject({ httpStatus: 400 });
    // remote.auth.register.options missing deviceId => 400, not 503
    await expect(
      findRoute(routes, "system.remote.auth.register.options").handler(makeCtx({ body: { idempotencyKey: "k-1" } })),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });
});
