import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridaySatellitePairingRoutes,
  type FridaySatellitePairingRoutesDeps,
} from "../../../../src/api/http/routes/friday-satellite-pairing-routes.js";
import { FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID } from "../../../../src/api/http/friday-default-public-principal.js";

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
      expect(route.rateLimitPolicyId).toBe("satellite.register");

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

    it("Phase 14.5A trust boundary: registration is public + rate-limited and never auto-approves a satellite", async () => {
      // WP-001 P0 / Phase 14.5A decision #6: public satellite registration is
      // acceptable beyond localhost/LAN only with anti-spam rate limit + a
      // pending status that requires owner approval before any token is issued.
      const routes = createFridaySatellitePairingRoutes(deps);
      const registerRoute = findRoute(routes, "satellites.register");
      expect(registerRoute.auth).toEqual({ public: true });
      expect(registerRoute.rateLimitPolicyId).toBe("satellite.register");

      const result = await registerRoute.handler(makeCtx({
        body: { type: "edge", displayName: "Test", publicKey: "pk-abc" },
        principal: undefined,
      }) as any) as { pairingStatus: string; pairingRequired: boolean };
      // Pending status + pairingRequired=true means even an unauthenticated
      // caller cannot turn a registration into an approved satellite without
      // a separate owner-bound approval call.
      expect(result.pairingStatus).toBe("pending_approval");
      expect(result.pairingRequired).toBe(true);

      // The approve/reject/revoke routes that complete the trust transition
      // refuse the synthetic public principal (covered in dedicated tests
      // below), so the chain is closed.
      const approveRoute = findRoute(routes, "satellites.pairing.approve");
      expect(approveRoute.auth).toEqual({ public: true });
      const revokeRoute = findRoute(routes, "satellites.revoke");
      expect(revokeRoute.auth).toEqual({ public: true });
    });
  });

  // ─── List Pending ───

  describe("satellites.pairing.list", () => {
    it("lists pending pairing requests", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.list");

      expect(route.method).toBe("GET");
      expect(route.path).toBe("/v1/satellites/pairing");
      expect(route.auth).toEqual({ public: true });

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
      expect(route.auth).toEqual({ public: true });

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

    it("Phase 14.5A: refuses approval from the synthetic public principal (no owner binding)", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.approve");

      await expect(route.handler(makeCtx({
        params: { satelliteId: "sat-001" },
        body: {},
        principal: undefined,
      }) as any)).rejects.toMatchObject({ code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED" });

      expect(deps.approvePairing).not.toHaveBeenCalled();
    });

    it("Phase 14.5A: refuses approval from the synthetic default-public admin principal", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.approve");

      await expect(route.handler(makeCtx({
        params: { satelliteId: "sat-001" },
        body: {},
        principal: { principalId: "public:default" },
      }) as any)).rejects.toMatchObject({ code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED" });

      expect(deps.approvePairing).not.toHaveBeenCalled();
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

    it("Phase 14.5A: refuses rejection from the synthetic default-public principal", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.pairing.reject");

      await expect(route.handler(makeCtx({
        params: { satelliteId: "sat-001" },
        body: {},
        principal: { principalId: "public:default" },
      }) as any)).rejects.toMatchObject({ code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED" });

      expect(deps.rejectPairing).not.toHaveBeenCalled();
    });
  });

  // ─── Handshake ───

  describe("satellites.handshake", () => {
    it("completes handshake with valid body", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.handshake");

      expect(route.method).toBe("POST");
      expect(route.path).toBe("/v1/satellites/:satelliteId/handshake");
      expect(route.auth).toEqual({ public: true, allowUnauthenticatedMutation: true });
      expect(route.rateLimitPolicyId).toBe("satellite.handshake");

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
      expect(deps.completeHandshake).not.toHaveBeenCalled();
    });

    it("B0 Slice A5: synthetic default-public principal cannot bypass handshake verifier — bad token/signature is rejected by deps.completeHandshake with no stream issued", async () => {
      const failingHandshake = vi.fn().mockRejectedValue(
        new Error("SATELLITE_HANDSHAKE_INVALID_SIGNATURE"),
      );
      const localDeps = makeDeps({ completeHandshake: failingHandshake });
      const routes = createFridaySatellitePairingRoutes(localDeps);
      const route = findRoute(routes, "satellites.handshake");

      // Carve-out reaches the handler under the synthetic default-public principal,
      // but the handler's verifier (deps.completeHandshake) is the trust boundary.
      // A bad signed challenge must be rejected and no stream/epoch may be returned.
      await expect(route.handler(makeCtx({
        params: { satelliteId: "sat-001" },
        body: {
          token: "forged-token",
          signedChallenge: "forged-signature",
          challengeNonce: "nonce-xyz",
          clientEphemeralPublicKey: "client-pub-key",
        },
        principal: { principalId: FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID },
      }) as any)).rejects.toThrow(/SATELLITE_HANDSHAKE_INVALID_SIGNATURE/);

      expect(failingHandshake).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Revoke ───

  describe("satellites.revoke", () => {
    it("revokes a satellite", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.revoke");

      expect(route.method).toBe("POST");
      expect(route.path).toBe("/v1/satellites/:satelliteId/revoke");
      expect(route.auth).toEqual({ public: true });

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

    it("Phase 14.5A: refuses revocation from the synthetic default-public principal", async () => {
      const routes = createFridaySatellitePairingRoutes(deps);
      const route = findRoute(routes, "satellites.revoke");

      await expect(route.handler(makeCtx({
        params: { satelliteId: "sat-001" },
        body: { reason: "drift" },
        principal: { principalId: "public:default" },
      }) as any)).rejects.toMatchObject({ code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED" });

      expect(deps.revokeSatellite).not.toHaveBeenCalled();
    });
  });
});
