import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridaySatellitePairingRoutes,
  type FridaySatellitePairingRoutesDeps,
} from "../../../../src/api/http/routes/friday-satellite-pairing-routes.js";

// ─── Helpers ───

function makeDeps(overrides: Partial<FridaySatellitePairingRoutesDeps> = {}): FridaySatellitePairingRoutesDeps {
  return {
    registerSatellite: vi.fn().mockResolvedValue({
      satelliteId: "sat-001",
      pairingStatus: "pending_approval",
      pairingRequired: true,
      pairingRequestId: "req-001",
      pairingCode: "ABCD-1234",
      expiresAt: "2026-02-26T00:00:00Z",
      challengeNonce: "nonce-xyz",
    }),
    listPendingPairings: vi.fn().mockResolvedValue([
      {
        requestId: "req-001",
        satelliteId: "sat-001",
        displayName: "Test Sat",
        type: "edge",
        pairingCode: "ABCD-1234",
        createdAt: "2026-02-25T00:00:00Z",
        expiresAt: "2026-02-26T00:00:00Z",
      },
    ]),
    approvePairing: vi.fn().mockResolvedValue({
      token: "tok-abc",
      tokenId: "tid-001",
      expiresAt: "2026-03-25T00:00:00Z",
      configRevision: 1,
      tokenVersion: 1,
    }),
    rejectPairing: vi.fn().mockResolvedValue({ rejectedAt: "2026-02-25T12:00:00Z" }),
    completeHandshake: vi.fn().mockResolvedValue({
      accepted: true,
      streamId: "stream-001",
      epoch: 1,
      algorithm: "X25519",
      serverEphemeralPublicKey: "server-pub-key",
    }),
    revokeSatellite: vi.fn().mockResolvedValue({ revokedAt: "2026-02-25T14:00:00Z" }),
    getPairingRequest: vi.fn().mockResolvedValue({
      requestId: "req-001",
      satelliteId: "sat-001",
      status: "pending_approval",
      pairingCode: "ABCD-1234",
      createdAt: "2026-02-25T00:00:00Z",
      expiresAt: "2026-02-26T00:00:00Z",
    }),
    ...overrides,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    body: {},
    params: {},
    ip: "127.0.0.1",
    userAgent: "test-agent",
    principal: { principalId: "user-001" },
    ...overrides,
  };
}

function findRoute(routes: ReturnType<typeof createFridaySatellitePairingRoutes>, operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route not found: ${operationId}`);
  return route;
}

// ─── Tests ───

describe("createFridaySatellitePairingRoutes", () => {
  let deps: FridaySatellitePairingRoutesDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("returns 7 route definitions", () => {
    const routes = createFridaySatellitePairingRoutes(deps);
    expect(routes).toHaveLength(7);
  });

  // ─── Registration ───

  describe("satellites.register", () => {
    it("registers a satellite with valid body", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.register");

      expect(route.method).toBe("POST");
      expect(route.path).toBe("/v1/satellites/register");
      expect(route.auth).toEqual({ public: true });

      const result = await route.handler(makeCtx({
        body: { type: "edge", displayName: "Test", publicKey: "pk-abc" },
      }) as any);

      expect(result).toEqual(expect.objectContaining({ satelliteId: "sat-001" }));
      expect(deps.registerSatellite).toHaveBeenCalledWith(expect.objectContaining({
        type: "edge",
        displayName: "Test",
        publicKey: "pk-abc",
        runtime: {
          platform: "unknown",
          arch: "unknown",
          appVersion: "unknown",
          nodeVersion: "unknown",
        },
        transport: "ws",
        requestedByIp: "127.0.0.1",
        requestedByUserAgent: "test-agent",
      }));
    });

    it("returns validation error when required fields are missing", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.register");

      const result = await route.handler(makeCtx({ body: { type: "edge" } }) as any);
      expect(result).toEqual({
        error: expect.objectContaining({ code: "VALIDATION_FAILED" }),
      });
    });

    it("passes optional runtime and transport fields", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.register");

      await route.handler(makeCtx({
        body: {
          type: "edge",
          displayName: "Test",
          publicKey: "pk-abc",
          runtime: { platform: "darwin", arch: "arm64", appVersion: "1.2.3", nodeVersion: "22.0.0" },
          transport: "mixed",
        },
      }) as any);

      expect(deps.registerSatellite).toHaveBeenCalledWith(expect.objectContaining({
        runtime: {
          platform: "darwin",
          arch: "arm64",
          appVersion: "1.2.3",
          nodeVersion: "22.0.0",
        },
        transport: "mixed",
      }));
    });
  });

  // ─── List Pending ───

  describe("satellites.pairing.list", () => {
    it("lists pending pairing requests", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.list");

      expect(route.method).toBe("GET");
      expect(route.path).toBe("/v1/satellites/pairing");
      expect(route.auth).toEqual({ public: false, anyOfScopes: ["satellite.read"] });

      const result = await route.handler(makeCtx() as any);
      expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: "req-001" })]));
    });
  });

  // ─── Get Pairing Status ───

  describe("satellites.pairing.get", () => {
    it("returns pairing request for a satellite", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.get");

      expect(route.method).toBe("GET");
      expect(route.path).toBe("/v1/satellites/:satelliteId/pairing");

      const result = await route.handler(makeCtx({ params: { satelliteId: "sat-001" } }) as any);
      expect(result).toEqual(expect.objectContaining({ requestId: "req-001" }));
    });

    it("returns NOT_FOUND when no pairing request exists", async () => {
      deps = makeDeps({ getPairingRequest: vi.fn().mockResolvedValue(null) });
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.get");

      await expect(route.handler(makeCtx({ params: { satelliteId: "sat-999" } }) as any)).rejects.toThrow("No pairing request found");
    });
  });

  // ─── Approve ───

  describe("satellites.pairing.approve", () => {
    it("approves a pending pairing request", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.approve");

      expect(route.method).toBe("POST");
      expect(route.path).toBe("/v1/satellites/:satelliteId/pairing/approve");
      expect(route.auth).toEqual({ public: false, anyOfScopes: ["satellite.write"] });

      const result = await route.handler(makeCtx({
        params: { satelliteId: "sat-001" },
        body: { scopes: ["read"], tokenTtlMs: 3600000 },
      }) as any);

      expect(result).toEqual(expect.objectContaining({ token: "tok-abc" }));
      expect(deps.approvePairing).toHaveBeenCalledWith(expect.objectContaining({
        satelliteId: "sat-001",
        requestId: "req-001",
        resolverUserId: "user-001",
        scopes: ["read"],
        tokenTtlMs: 3600000,
      }));
    });

    it("returns NOT_FOUND when no pending pairing exists", async () => {
      deps = makeDeps({ getPairingRequest: vi.fn().mockResolvedValue(null) });
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.approve");

      await expect(route.handler(makeCtx({ params: { satelliteId: "sat-001" }, body: {} }) as any)).rejects.toThrow("No pending pairing request");
    });

    it("falls back to 'system' when no principal is present", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.approve");

      await route.handler(makeCtx({
        params: { satelliteId: "sat-001" },
        body: {},
        principal: undefined,
      }) as any);

      expect(deps.approvePairing).toHaveBeenCalledWith(expect.objectContaining({
        resolverUserId: "system",
      }));
    });
  });

  // ─── Reject ───

  describe("satellites.pairing.reject", () => {
    it("rejects a pending pairing request", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.reject");

      expect(route.method).toBe("POST");
      expect(route.path).toBe("/v1/satellites/:satelliteId/pairing/reject");

      const result = await route.handler(makeCtx({
        params: { satelliteId: "sat-001" },
        body: { reason: "not authorized" },
      }) as any);

      expect(result).toEqual({ rejectedAt: "2026-02-25T12:00:00Z" });
      expect(deps.rejectPairing).toHaveBeenCalledWith(expect.objectContaining({
        reason: "not authorized",
      }));
    });

    it("returns NOT_FOUND when no pending pairing exists", async () => {
      deps = makeDeps({ getPairingRequest: vi.fn().mockResolvedValue(null) });
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.reject");

      await expect(route.handler(makeCtx({ params: { satelliteId: "sat-001" }, body: {} }) as any)).rejects.toThrow("No pending pairing request");
    });
  });

  // ─── Handshake ───

  describe("satellites.handshake", () => {
    it("completes handshake with valid body", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.handshake");

      expect(route.method).toBe("POST");
      expect(route.path).toBe("/v1/satellites/:satelliteId/handshake");
      expect(route.auth).toEqual({ public: true });

      const result = await route.handler(makeCtx({
        params: { satelliteId: "sat-001" },
        body: {
          token: "tok-abc",
          signedChallenge: "sig-123",
          challengeNonce: "nonce-xyz",
          clientEphemeralPublicKey: "client-pub-key",
          supportedAlgorithms: ["X25519"],
        },
      }) as any);

      expect(result).toEqual(expect.objectContaining({ accepted: true, streamId: "stream-001" }));
    });

    it("returns validation error when required handshake fields are missing", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.handshake");

      const result = await route.handler(makeCtx({
        params: { satelliteId: "sat-001" },
        body: { token: "tok-abc" },
      }) as any);

      expect(result).toEqual({ error: expect.objectContaining({ code: "VALIDATION_FAILED" }) });
    });
  });

  // ─── Revoke ───

  describe("satellites.revoke", () => {
    it("revokes a satellite", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.revoke");

      expect(route.method).toBe("POST");
      expect(route.path).toBe("/v1/satellites/:satelliteId/revoke");
      expect(route.auth).toEqual({ public: false, anyOfScopes: ["security.write"] });

      const result = await route.handler(makeCtx({
        params: { satelliteId: "sat-001" },
        body: { reason: "compromised" },
      }) as any);

      expect(result).toEqual({ revokedAt: "2026-02-25T14:00:00Z" });
      expect(deps.revokeSatellite).toHaveBeenCalledWith(expect.objectContaining({
        satelliteId: "sat-001",
        resolverUserId: "user-001",
        reason: "compromised",
      }));
    });
  });
});
